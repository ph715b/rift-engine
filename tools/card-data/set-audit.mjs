/**
 * Is a set's upstream card data good enough to land?
 *
 *   node tools/card-data/set-audit.mjs VEN
 *
 * Exit 0 = the gate is CLEAR, exit 1 = it is not, and the reason is printed.
 *
 * # Why this exists
 *
 * For four sets, Phase 0 was a byte-for-byte copy out of the frozen Java oracle
 * (A:\Projects\riftbound-engine\src\main\resources\cards\) and there was nothing
 * to audit. The oracle holds ogn/ogs/sfd/unl and stops there, so Vendetta is the
 * first set that has to come off the Riftcodex API directly — and the API turned
 * out to be serving TWO ingests of it at once.
 *
 * That is not a thing anyone would look for, it is invisible in a `wc -l`, and
 * it breaks the loader in a way that reports as ordinary unimplemented cards.
 * So it gets an instrument rather than a paragraph, and the instrument is
 * re-runnable: the upstream reconciliation is still in progress, and the whole
 * question "can Vendetta be landed yet" is one command.
 *
 * # What it measures, and why each check is here
 *
 * **Duplicate ingests.** `/cards?set_id=X` paginates over raw documents, not
 * over cards. VEN returns 358 documents for 227 distinct `riftbound_id`s: an
 * older scrape and a newer reconciled one, both live. Deduping keeps the newest
 * `metadata.updated_on` per `riftbound_id`.
 *
 * **The reconciled/unreconciled split.** The reconciliation populates
 * `tcgplayer_id`, `metadata.clean_name` and `text.flavour` — and, load-bearing
 * here, it sets `metadata.alternate_art` and `metadata.overnumbered`. An
 * unreconciled record reports **every printing flag as false**. Measured on the
 * 131 VEN cards that have both halves, the old half disagreed with the new one
 * 27 times and always in that direction.
 *
 * **Main-set completeness.** `riftbound_id` is `set-collector-setsize`, so the
 * set's own size is in every id and the main set is collector <= setsize. That
 * band is checked for gaps, duplicate numbers and duplicate names.
 *
 * **The unrecoverable printings.** Above the main-set band, genuine additional
 * cards and alternate printings of main-set cards are INTERLEAVED — VEN has 12
 * flagged printings and 5 genuine cards between 167 and 197. Only the flag
 * separates them. An unreconciled record in that band therefore cannot be
 * classified from any field, and guessing is what this file exists to prevent:
 * guess "printing" and the card plays as a different card, guess "genuine" and
 * a phantom card inflates every figure this repo pins.
 *
 * Note the two tempting derivations that do NOT work, both tested against the
 * reconciled records where the answer is known:
 *
 *   *collector > setsize means printing* — false, 5 counterexamples in VEN.
 *   *a duplicate name means printing*    — false for Legends. The old ingest
 *     drops the champion prefix, so `Jayce - Defender of Tomorrow`'s printing
 *     is named `Defender of Tomorrow` and matches nothing.
 */

const API = "https://api.riftcodex.com";
const PAGE_SIZE = 100; // the API's documented maximum

/** Every raw document the API holds for a set, across all pages. */
async function fetchSet(setId) {
  const first = await getPage(setId, 1);
  const items = [...first.items];
  for (let page = 2; page <= first.pages; page++) {
    items.push(...(await getPage(setId, page)).items);
  }
  // Do NOT pass `sort` here. Sorting by a non-unique column (collector_number)
  // makes pagination unstable: rows shift between pages and the same document
  // arrives twice while another is never seen. That produced a 358-row fetch
  // holding only 227 distinct documents, which looks exactly like the genuine
  // duplicate-ingest problem below and is not it.
  if (items.length !== first.total) {
    throw new Error(`fetched ${items.length} of ${first.total} — pagination is not stable`);
  }
  return items;
}

async function getPage(setId, page) {
  const url = `${API}/cards?set_id=${encodeURIComponent(setId)}&size=${PAGE_SIZE}&page=${page}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

/** One record per real card: the newest ingest of each `riftbound_id`. */
function dedupe(items) {
  const byId = new Map();
  for (const item of items) {
    const seen = byId.get(item.riftbound_id);
    if (!seen || item.metadata.updated_on > seen.metadata.updated_on) byId.set(item.riftbound_id, item);
  }
  return [...byId.values()];
}

/** `ven-084a-166` -> {collector: 84, variant: "a", setSize: 166}; null for `ven-sp2-006`/`ven-r01`. */
function parseId(riftboundId) {
  const m = /^[a-z]+-(\d+)([a-z]?)-(\d+)$/.exec(riftboundId);
  if (!m) return null;
  return { collector: Number(m[1]), variant: m[2], setSize: Number(m[3]) };
}

/**
 * Has this record been through the upstream reconciliation?
 *
 * Read off `tcgplayer_id` rather than the `new` flag. Both separate the two
 * ingests identically on VEN today, but `new` is a release-status field whose
 * meaning is upstream's to change, whereas a populated `tcgplayer_id` is
 * positive evidence that this exact document was matched against a printed
 * product — which is the property the printing flags depend on.
 */
const isReconciled = (card) => card.tcgplayer_id != null;

function audit(setId, raw) {
  const cards = dedupe(raw);
  const reconciled = cards.filter(isReconciled);
  const unreconciled = cards.filter((c) => !isReconciled(c));

  const setSize = cards.map((c) => parseId(c.riftbound_id)?.setSize).find((s) => s != null);
  const inMainSet = (c) => {
    const id = parseId(c.riftbound_id);
    return id !== null && id.variant === "" && id.collector <= setSize;
  };
  const main = cards.filter(inMainSet);

  const numbers = new Set(main.map((c) => parseId(c.riftbound_id).collector));
  const missing = [];
  for (let n = 1; n <= setSize; n++) if (!numbers.has(n)) missing.push(n);
  const dupNumbers = main.length - numbers.size;
  const names = main.map((c) => c.name);
  const dupNames = names.filter((n, i) => names.indexOf(n) !== i);

  // Above the main-set band, "printing of a main-set card" and "genuine extra
  // card" are distinguished ONLY by metadata.overnumbered, so an unreconciled
  // record there is unclassifiable. Variant-lettered ids ("084a") are alternate
  // art in every reconciled case and `shouldSkip` drops them either way, so they
  // are reported but do not block.
  const ambiguous = unreconciled.filter((c) => {
    const id = parseId(c.riftbound_id);
    return id !== null && id.variant === "" && id.collector > setSize;
  });

  return { cards, reconciled, unreconciled, setSize, main, missing, dupNumbers, dupNames, ambiguous };
}

function report(setId, raw, a) {
  const pct = ((a.reconciled.length / a.cards.length) * 100).toFixed(0);
  console.log(`\n=== ${setId} — upstream card data audit ===\n`);
  console.log(`  raw documents           ${raw.length}`);
  console.log(`  distinct cards          ${a.cards.length}   (deduped by riftbound_id, newest ingest wins)`);
  console.log(`  reconciled              ${a.reconciled.length}  (${pct}%)`);
  console.log(`  UNRECONCILED            ${a.unreconciled.length}   <- every printing flag reads false on these`);
  console.log(`  set size (from ids)     ${a.setSize}`);

  console.log(`\n  -- main set (collector 1..${a.setSize}) --`);
  console.log(`  present                 ${a.main.length}`);
  console.log(`  missing numbers         ${a.missing.length ? a.missing.join(", ") : "none"}`);
  console.log(`  duplicate numbers       ${a.dupNumbers}`);
  console.log(`  duplicate names         ${a.dupNames.length ? a.dupNames.join(", ") : "none"}`);
  const staleMain = a.main.filter((c) => !isReconciled(c)).length;
  const staleLegends = a.main.filter((c) => !isReconciled(c) && c.classification.type === "Legend").length;
  console.log(`  unreconciled in band    ${staleMain}   (of which Legends: ${staleLegends})`);

  if (a.ambiguous.length) {
    console.log(`\n  -- unclassifiable printings (above the main-set band, unreconciled) --`);
    for (const c of a.ambiguous.sort((x, y) => x.riftbound_id.localeCompare(y.riftbound_id))) {
      console.log(`     ${c.riftbound_id.padEnd(16)} ${c.classification.type.padEnd(10)} ${JSON.stringify(c.name)}`);
    }
  }
  return verdict(a, staleLegends);
}

/**
 * The gate. Two things block, and they block for different reasons.
 *
 * A hole in the main-set band means the set is not all there. An unclassifiable
 * printing means it is all there but the pool cannot be assembled without
 * asserting something the data does not say — and a hand-asserted pool is a
 * source of truth nothing can re-derive, which would make coverage, the trigger
 * census and `reachability` all measure a fiction.
 *
 * An unreconciled MAIN-SET record does not block. Its rules text, cost, type and
 * domains are all present, its printing flags are false and false is correct for
 * a main-set card, and what reconciliation would add (flavour, tcgplayer_id) is
 * read by nothing in this engine. The one exception is a Legend, whose champion
 * prefix the old ingest drops — `championTag` is the first word of the name, so
 * an unreconciled Legend would load tagged DEFENDER instead of JAYCE.
 */
function verdict(a, staleLegends) {
  const blockers = [];
  if (a.missing.length) blockers.push(`${a.missing.length} main-set numbers missing`);
  if (a.dupNumbers) blockers.push(`${a.dupNumbers} duplicate main-set collector numbers`);
  if (a.dupNames.length) blockers.push(`${a.dupNames.length} duplicate main-set names`);
  if (staleLegends) blockers.push(`${staleLegends} unreconciled main-set Legends (champion prefix is dropped)`);
  if (a.ambiguous.length) blockers.push(`${a.ambiguous.length} printings whose status no field carries`);

  console.log("");
  if (blockers.length === 0) {
    console.log("  VERDICT: CLEAR — the pool can be assembled from the data alone.");
    return 0;
  }
  console.log("  VERDICT: BLOCKED");
  for (const b of blockers) console.log(`    - ${b}`);
  console.log("\n  Do not close this by hand. Re-run when upstream reconciliation advances;");
  console.log("  the gate opens by itself when the unreconciled count reaches zero.");
  return 1;
}

const setId = (process.argv[2] ?? "VEN").toUpperCase();
const raw = await fetchSet(setId);
process.exit(report(setId, raw, audit(setId, raw)));
