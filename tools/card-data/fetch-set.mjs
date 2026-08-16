/**
 * Fetch a set from the Riftcodex API and write the card file the engine loads.
 *
 *   node tools/card-data/fetch-set.mjs VEN packages/engine/src/cards/ven.json
 *
 * # Why a generator and not a downloaded file
 *
 * The four earlier sets were copied byte-for-byte out of the frozen Java oracle,
 * which has no Vendetta. This set comes off the API directly, and the API
 * paginates over DOCUMENTS rather than cards — VEN returns 358 documents for 227
 * distinct `riftbound_id`s, because an older scrape and a newer reconciled one
 * are both live. So there is no single URL whose body is the file; assembling it
 * is a procedure, and a procedure belongs in a script rather than in a paragraph
 * somebody re-does by hand.
 *
 * The output is a bare array sorted by `riftbound_id`, so re-running it produces
 * a byte-identical file and a real refresh shows up as a reviewable diff.
 *
 * # What it EXCLUDES, and why that is not a hand-edit
 *
 * `set-audit.mjs` is the gate and explains the problem in full; this is the half
 * that acts on it. A record is written only when its PRINTING STATUS is
 * determinable from the data:
 *
 *   - every reconciled record (`tcgplayer_id` present) — upstream has set its
 *     `alternate_art` / `overnumbered` flags, so the loader can trust them;
 *   - every unreconciled record inside the MAIN-SET band (collector <= set
 *     size), where "not an alternate printing" is true by construction.
 *
 * Everything else is dropped: an unreconciled record above the main-set band
 * cannot be told from a genuine additional card (that band interleaves both, and
 * only the flag separates them), and an unreconciled variant-lettered id would
 * enter the pool as a duplicate playable card because its `alternate_art` reads
 * false.
 *
 * **That is a data-derived filter, not a judgement about any card.** Nothing here
 * decides what a dropped record IS — it drops exactly the records the data
 * declines to classify, and every dropped id is printed and pinned so the
 * omission cannot be mistaken for a complete set. When upstream finishes
 * reconciling, the filter stops excluding anything and the file grows on its own.
 */

const API = "https://api.riftcodex.com";
const PAGE_SIZE = 100;

async function getPage(setId, page) {
  // No `sort` — sorting on a non-unique column makes pagination unstable, so
  // rows shift between pages and you get duplicates plus silent omissions.
  const url = `${API}/cards?set_id=${encodeURIComponent(setId)}&size=${PAGE_SIZE}&page=${page}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function fetchSet(setId) {
  const first = await getPage(setId, 1);
  const items = [...first.items];
  for (let page = 2; page <= first.pages; page++) items.push(...(await getPage(setId, page)).items);
  if (items.length !== first.total) {
    throw new Error(`fetched ${items.length} of ${first.total} — pagination is not stable`);
  }
  return items;
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

/** `ven-084a-166` -> {collector: 84, variant: "a", setSize: 166}; null for `ven-sp2-006`. */
function parseId(riftboundId) {
  const m = /^[a-z]+-(\d+)([a-z]?)-(\d+)$/.exec(riftboundId);
  return m ? { collector: Number(m[1]), variant: m[2], setSize: Number(m[3]) } : null;
}

const isReconciled = (card) => card.tcgplayer_id != null;

const setId = (process.argv[2] ?? "VEN").toUpperCase();
const outPath = process.argv[3];
if (!outPath) throw new Error("usage: fetch-set.mjs <SET_ID> <output-path>");

const raw = await fetchSet(setId);
const cards = dedupe(raw);
const setSize = cards.map((c) => parseId(c.riftbound_id)?.setSize).find((s) => s != null);

const kept = [];
const dropped = [];
for (const card of cards) {
  const id = parseId(card.riftbound_id);
  const inMainSet = id !== null && id.variant === "" && id.collector <= setSize;
  if (isReconciled(card) || inMainSet) kept.push(card);
  else dropped.push(card);
}
kept.sort((a, b) => a.riftbound_id.localeCompare(b.riftbound_id));

const { writeFile } = await import("node:fs/promises");
// Two-space JSON with a trailing newline — a text file that diffs per card
// rather than one 400KB line.
await writeFile(outPath, `${JSON.stringify(kept, null, 2)}\n`, "utf8");

console.log(`\n=== ${setId} -> ${outPath} ===`);
console.log(`  raw documents      ${raw.length}`);
console.log(`  distinct cards     ${cards.length}`);
console.log(`  WRITTEN            ${kept.length}`);
console.log(`  dropped            ${dropped.length}   (printing status not determinable)`);
for (const card of dropped.sort((a, b) => a.riftbound_id.localeCompare(b.riftbound_id))) {
  console.log(`     ${card.riftbound_id.padEnd(16)} ${card.classification.type.padEnd(11)} ${JSON.stringify(card.name)}`);
}
console.log(`\n  Re-run when \`set-audit.mjs ${setId}\` reports CLEAR; the dropped list empties on its own.`);
