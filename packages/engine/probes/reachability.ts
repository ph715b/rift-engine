/**
 * **Of the whole card pool, how much has EVER been observed doing something in a
 * game?** One run, one number, every set.
 *
 *     npm run build --workspace=@rift-engine/engine
 *     node packages/engine/probes/reachability.ts
 *
 * # Why this exists beside `exercised.ts`
 *
 * `exercised.ts` measures ONE deck set per invocation, and the loop only ever ran
 * two of its four modes. So the pool-wide question had no answer anybody could
 * read, and the answer it did report was misleading in a specific direction:
 *
 *  - All seven preset decks are OGN/OGS, so the default run reports **SFD 0%** and
 *    always will. 198 cards shipped in one month had never been in a game unless
 *    somebody typed `DECKS=sfd`.
 *  - `DECKS=ogn` and `DECKS=ogs` both worked and neither was in the loop.
 *  - Nothing reported the UNION, and the union is the actual question. A card
 *    exercised by the OGS covering run is exercised, whatever the SFD run saw.
 *
 * Measured the day this was written: the four runs together exercise far more
 * than any one of them, and what is LEFT is the list this probe exists to print.
 * A count is not actionable, so every card is named — the same rule every gate in
 * this repo already follows.
 *
 * # The reasons a card is on that list are not interchangeable
 *
 * | bucket | meaning | is it a defect? |
 * |---|---|---|
 * | `offeredNeverTaken` | the engine offered it, the AI declined every time | **usually not** — a 1-ply evaluator cannot price a deferred or informational effect |
 * | `drawnNeverOffered` | it reached a hand and `legalActions` never enumerated it | **the real leads** |
 * | `startsInPlayNeverActed` | a Legend or champion: on the board from turn 1, never drawn, never offered | only its trigger/activation can show it — read the card |
 * | `seatedNeverDrawn` | in a deck, never reached a hand in these games | no — sampling |
 * | `neverSeated` | no run could put it in front of a player at all | a deck/pool problem, not an engine one |
 *
 * **The middle three used to be one bucket, and it hid the only actionable one.**
 * A game draws about 10 of a 39-card deck, so a card that never reached a hand
 * could not possibly have been offered — OGS-011 Flash sat in a deck for 10 games,
 * was never drawn once, and read convincingly as an enumeration bug. The README
 * has carried that warning for months as something a reader had to remember;
 * `log.drawn` measures it instead.
 *
 * # What is gated, and what deliberately is not
 *
 * Not gated: any coverage percentage. Any threshold would be a number picked to
 * pass, and this figure is supposed to RISE as the never-exercised list is worked
 * down.
 *
 * Gated:
 *  - **`invalid: 0` in every run** — the offered-then-refused detector.
 *  - Every per-run instrument control (`exercise-run.runControls`).
 *  - **The union is strictly larger than the biggest single run.** The positive
 *    control on the merge itself: if this probe accidentally reported one run's
 *    log as the union, every other number here would still look reasonable.
 *  - **Something is still unexercised** — the negative control, without which an
 *    observer that simply marked every card would report a triumphant 494/494.
 *  - **The union has not gone DOWN** (`PINNED_UNION`), which is the regression
 *    this whole instrument is for.
 *  - **No stale allowlist entry**, i.e. nothing excused that is now exercised.
 *  - **Every set with cards needing code has a run that can reach it.** This is
 *    the SFD-0% failure, generalised: a set arrives, no mode reaches it, and the
 *    report stays cheerfully green about a set nobody has ever played.
 */
import { COMPLETE_SETS, defaultCardRegistry, setCodeOf } from "@rift-engine/engine";
import { report } from "./harness.ts";
import { poolFacts } from "./pool-facts.ts";
import { PRESETS, runControls, runExercise, type ExerciseRun } from "./exercise-run.ts";
import { UNEXERCISED_ALLOWLIST } from "./unexercised-allowlist.ts";

/**
 * **250, not 40, and the difference is the whole point of this instrument.**
 *
 * Measured 2026-08-07, union of cards needing code ever exercised:
 *
 * | games/mode | exercised | never | `drawnNeverOffered` | wall clock |
 * |---|---|---|---|---|
 * | 40 | 367 | 101 | 8 | 10s |
 * | 100 | 417 | 51 | 4 | 25s |
 * | **250** | **429** | **39** | **1** | **60s** |
 * | 500 | 435 | 33 | 0 | 120s |
 *
 * At 40 games the never-exercised list is dominated by SAMPLING, not by defects:
 * 7 of its 8 "the engine never offered this" leads were offered freely once the
 * games were deep enough (Punch First 59 times, Blood Money 71). A gate that
 * names 101 cards of which ~60 are noise manufactures exactly the fake backlog of
 * broken-cards-that-are-not-broken this probe's own header warns about.
 *
 * 250 buys the honest list for a minute. Use `GAMES=40` for a quick regression
 * check and `GAMES=500` when working the list down — but do not read the buckets
 * from a shallow run.
 */
const GAMES = Number(process.env.GAMES ?? 250);

/**
 * The recorded union, as `walkout` pins 191/107/32.
 *
 * It is a FLOOR, not an equality: the whole point of Phase 1b is to raise it, and
 * a gate that failed on an improvement would just get edited away. Going UP prints
 * a line asking for the pin to be bumped; going DOWN is red.
 *
 * Measured 2026-08-07 at the DEFAULT 250 games per mode, battlefields pinned.
 * It is only comparable at that depth — the table above is the whole reason — so
 * a `GAMES=40` run is expected to sit below it and does not gate.
 */
/**
 * **429 → 430 on 2026-08-07**, and the card is worth naming: **SFD-129
 * Temptation**, whose printed text is "move an enemy unit to a LOCATION where
 * there's a unit with the same controller".
 *
 * It was offered and never taken for as long as this probe has run, because the
 * only Locations the engine could name were battlefields. Making a BASE a legal
 * move destination (355.4.a / 359.3.e) gave it the destination it prints, and the
 * AI took it in self-play the same day. A rise here is exactly what a rules fix
 * to a reachable card should look like, which is why the pin is a floor.
 */
/**
 * **430 → 444 on 2026-08-08, when Unleashed landed.** A different kind of rise
 * from the one above: not a rules fix making one card reachable, but 226 new
 * cards needing code of which the runs immediately exercised **14**, entirely
 * through generic machinery — keywords, the generated `[Equip]` ability, and the
 * covering UNL run the mode list derived for itself the moment the set had
 * Legends.
 *
 * 6% for UNL against 90-94% for the three finished sets is exactly the shape to
 * expect from a set whose cards are not written yet, and it is the number to
 * watch: this pin should climb steeply as UNL is implemented, and a FLAT figure
 * across a session of card work means the cards are not reachable in play,
 * whatever coverage says.
 */
/**
 * **444 → 441 on 2026-08-08, and THE FALL IS THE FIX** — the second time this
 * has happened and both times for the identical reason, one set apart.
 *
 * Reading UNL's five Equipment card images found that four carry an ability
 * printed only on the art, three of which are unwritten. Those three had been
 * reporting `isCardImplemented = true`, because `text.plain` holds only the
 * `[Equip]` line and the generated equip ability registers the defId. Naming
 * them in `PARTIALLY_IMPLEMENTED` is what dropped this number, and the route is
 * worth stating because it is not obvious: `deck-generator` builds each covering
 * deck from `needsImplementation && isCardImplemented`, so a card that stops
 * reporting implemented stops being SEATED, and a card that is never seated can
 * never be exercised.
 *
 * So the three cards left this count by ceasing to be a lie, not by regressing.
 * Bisected rather than assumed: reverting only the `PARTIALLY_IMPLEMENTED`
 * entries restores 444 exactly, and reverting only the Might badges does not
 * move it at all.
 *
 * **A drop still has to be explained before it is accepted, every time.** The
 * previous fall (2026-08-06) was SFD's version of this same art-only trap.
 */
/**
 * **441 → 466 on 2026-08-08**, and this is the rise the note above asked for
 * rather than another reclassification: the first wave of Unleashed card work
 * (30 cards across six domain files, written by six agents in parallel) took UNL
 * from 11/225 to **36/225**, 5% to 16%.
 *
 * Worth stating because it is the control on that whole exercise. 30 cards
 * registered and 30 unit tests passing says the code runs; only this says the AI
 * can actually reach them in a game, and 25 of the 30 are now observed acting in
 * self-play. The 5 that are not are the expected tail — cards needing a board
 * state 250 games did not produce.
 *
 * **473 → 499 on 2026-08-09, wave 2** — another six agents over the same six
 * domain files, ~36 cards. UNL went 43/225 to **68/225** (19% to 30%); the three
 * hard-gated sets did not move, which is what the union rising by exactly UNL's
 * gain says and is the check that no finished set regressed to pay for it.
 *
 * **499 → 516 on 2026-08-09, wave 3** — six agents again, ~24 cards landed plus
 * two new contribution seams (`mightModifiers`, and the activated-ability one
 * from wave 2 now carrying five cards). UNL went 68/225 to **85/225** (30% to
 * 38%); the three hard-gated sets did not move, which is the check that no
 * finished set regressed to pay for it.
 *
 * Per set at this depth: OGN 224/248, OGS 20/22, SFD 187/198, UNL 85/225.
 * (SFD 186 → 187 is not a wave-2 card: it is the `[Deflect]`-surcharge fix in
 * `legal-actions.ts`, which stopped an activation crashing the run and so let a
 * card that had been dying mid-game finish being observed.)
 */
const PINNED_UNION = 516;
const PINNED_AT_GAMES = 250;

const registry = defaultCardRegistry();
const facts = poolFacts(registry);

/**
 * Every mode, derived from the registry rather than listed.
 *
 * A hardcoded `["OGN", "OGS", "SFD"]` would be correct today and silently wrong
 * the day `unl.json` lands — which is the exact scenario this probe was built
 * for, one set earlier. A set with no Legend cannot have a covering run built,
 * and that is reported as a finding below rather than skipped.
 */
const MODES: readonly (string | undefined)[] = [undefined, ...facts.setCodesWithLegend];

const runs: ExerciseRun[] = [];
for (const mode of MODES) {
  console.error(`reachability: running ${mode?.toUpperCase() ?? PRESETS} (${GAMES} games)…`);
  runs.push(runExercise(mode, GAMES, registry));
}

const unionExercised = new Set<string>();
const unionOffered = new Set<string>();
const unionSeated = new Set<string>();
const unionDrawn = new Set<string>();
const unionStartsInPlay = new Set<string>();
for (const run of runs) {
  for (const id of run.log.exercised()) unionExercised.add(id);
  for (const id of run.log.offered) unionOffered.add(id);
  for (const id of run.inDecks) unionSeated.add(id);
  for (const id of run.log.drawn) unionDrawn.add(id);
  for (const id of run.startsInPlay) unionStartsInPlay.add(id);
}

const needsCode = facts.needsCode;
const isNeeded = (id: string): boolean => needsCode.has(id);
const exercisedNeedingCode = [...unionExercised].filter(isNeeded);

/** Per-run, so a mode that contributes nothing is visible rather than averaged
 *  away. `newlyExercised` is what this run added to the union that no earlier run
 *  had — the honest measure of whether a mode is worth its runtime. */
const seenSoFar = new Set<string>();
const perRun = runs.map((run) => {
  const exercised = run.log.exercised();
  const newly = [...exercised].filter((id) => !seenSoFar.has(id));
  for (const id of exercised) seenSoFar.add(id);
  return {
    mode: run.mode,
    decks: run.decksUsed.size,
    seated: run.inDecks.size,
    seatedNeedingCode: [...run.inDecks].filter(isNeeded).length,
    exercised: exercised.size,
    exercisedNeedingCode: [...exercised].filter(isNeeded).length,
    newlyExercised: newly.length,
    invalid: run.invalid,
    ...(run.generated ? { generated: run.generated } : {}),
    controls: runControls(run),
  };
});

interface SetRow {
  inPool: number;
  needsCode: number;
  seated: number;
  exercised: number;
  /** Of the cards needing code in this set, how many any run has ever exercised.
   *  THE number this probe exists to report. */
  exercisedOfNeedsCode: string;
}
const bySet: Record<string, SetRow> = {};
for (const defId of facts.pool) {
  const row = (bySet[setCodeOf(defId)] ??= {
    inPool: 0,
    needsCode: 0,
    seated: 0,
    exercised: 0,
    exercisedOfNeedsCode: "",
  });
  row.inPool++;
  if (!isNeeded(defId)) continue;
  row.needsCode++;
  if (unionSeated.has(defId)) row.seated++;
  if (unionExercised.has(defId)) row.exercised++;
}
const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`);
for (const row of Object.values(bySet)) row.exercisedOfNeedsCode = pct(row.exercised, row.needsCode);

/**
 * Implemented, needs code, and no run has ever seen it act — partitioned FOUR
 * ways, because each one takes completely different work and lumping them
 * together turns a documented AI limitation into a fake backlog of broken cards.
 *
 * The split that matters most is the last two. "Seated and never offered" used to
 * be one bucket, and it silently mixed the only real lead here with pure
 * sampling: a game draws about 10 of a 39-card deck, so a card that never reached
 * a hand could not possibly have been offered. OGS-011 Flash cost a session that
 * way. `log.drawn` measures it now instead of asking the reader to remember.
 */
const never = [...needsCode].filter((id) => !unionExercised.has(id)).sort();
const offeredNeverTaken = never.filter((id) => unionOffered.has(id));
const unoffered = never.filter((id) => !unionOffered.has(id));
/** Begins the game on the board, so it is never drawn and never offered by
 *  construction — its only signals are an activated ability or a trigger. Neither
 *  of the two buckets below applies, and reading it as either is a false lead. */
const startsInPlayNeverActed = unoffered.filter((id) => unionStartsInPlay.has(id));
const rest = unoffered.filter((id) => !unionStartsInPlay.has(id));
/** **Reached a hand, and `legalActions` never enumerated it.** The real leads:
 *  nothing about sampling or AI taste explains these, so it is a cost the AI can
 *  never meet, a gate that is wrong, or a gap in enumeration. */
const drawnNeverOffered = rest.filter((id) => unionDrawn.has(id));
/** Seated but never drawn in any of these games. Sampling, not a defect — and it
 *  is fixed by seeds and copies, not by engine work. */
const seatedNeverDrawn = rest.filter((id) => unionDrawn.has(id) === false && unionSeated.has(id));
const neverSeated = rest.filter((id) => !unionSeated.has(id));

/** An excused card that turns up exercised, or one that is not in the registry at
 *  all. Both mean the allowlist is describing an engine that no longer exists —
 *  the failure mode this repo has recorded against `PARTIALLY_IMPLEMENTED`, the
 *  Divergent table and the verification loop itself. */
const inPool = new Set(facts.pool);
const staleAllowlist = Object.keys(UNEXERCISED_ALLOWLIST)
  .filter((id) => unionExercised.has(id) || !inPool.has(id))
  .sort()
  .map((id) => (inPool.has(id) ? `${facts.label(id)} — EXERCISED, excuse is stale` : `${id} — not in the registry`));
/**
 * Never exercised, never even OFFERED, and with no written reason — the only
 * cards that are genuinely unaccounted for.
 *
 * A card in `offeredNeverTaken` is deliberately NOT counted here: the enumerator
 * emitted it, so its reachability — the entire question this probe exists to ask
 * — is proven by measurement, every run, and does not need a hand-written excuse
 * restating it. Writing 33 entries asserting a fact the instrument already checks
 * would be a rubber stamp, and a rubber stamp is what the allowlist's own header
 * forbids. What it declines to prove is that the card's EFFECT is correct, which
 * is a unit test's job and never was self-play's.
 */
const unaccounted = never.filter((id) => !unionOffered.has(id) && UNEXERCISED_ALLOWLIST[id] === undefined);
/**
 * Split by whether the card's set is HARD-GATED, because the two mean opposite
 * things and only one of them is a finding.
 *
 * A card in a set named in `COMPLETE_SETS` that no run offered and nobody has
 * excused is genuinely unaccounted for — that is this gate's whole subject, and
 * it stays at zero.
 *
 * A card in a set still being BUILT is not unaccounted for; it is unwritten, and
 * `coverage.ts` already names it. Unleashed landed on 2026-08-08 with 212 such
 * cards, and gating on them would have turned this probe red on the day the JSON
 * arrived and kept it red for the whole set — a wall of noise arriving at the one
 * moment the instruments most need to be readable, which is the same reasoning
 * `COMPLETE_SETS` itself was introduced with.
 *
 * They are still COUNTED and still printed, so "unwritten" can never quietly
 * become "invisible".
 */
const unexplained = unaccounted.filter((id) => COMPLETE_SETS.includes(id.split("-")[0]!));
const unwrittenSetInProgress = unaccounted.filter((id) => !COMPLETE_SETS.includes(id.split("-")[0]!));

/**
 * A set with cards needing code that no run seated a single one of.
 *
 * Read off the MEASUREMENT (`bySet.seated`, the union of what the runs actually
 * dealt) rather than off `setCodesWithLegend`, which is the same input `MODES` is
 * derived from — a control computed from a mode list can only ever agree with it.
 * This form goes red whichever way the reach is lost: no Legend to build a
 * covering deck from, a mode that stopped being run, or a generator that seated
 * nothing.
 */
const setsWithoutRun = facts.setCodes.filter(
  (code) => (bySet[code]?.needsCode ?? 0) > 0 && (bySet[code]?.seated ?? 0) === 0,
);
/** Reported beside it as the usual CAUSE: no Legend, so no covering deck. */
const setsWithoutLegend = facts.setCodes.filter(
  (code) => (bySet[code]?.needsCode ?? 0) > 0 && !facts.setCodesWithLegend.includes(code),
);

const biggestSingleRun = Math.max(...runs.map((r) => r.log.exercised().size));
/** The pinned figure and the allowlist are both statements about a 250-game run.
 *  Asserting them against any other depth compares two different measurements. */
const atPinnedDepth = GAMES === PINNED_AT_GAMES;

const controls = {
  /** Every per-run instrument control, including `invalid: 0`. */
  everyRunHealthy: perRun.every((r) => Object.values(r.controls).every((v) => v !== false)),
  /** The positive control on the MERGE. One run's log reported as the union would
   *  leave every other figure here looking perfectly reasonable. */
  unionExceedsEveryRun: unionExercised.size > biggestSingleRun,
  /** The negative control: an observer that marks rather than measures reports
   *  everything exercised. */
  somethingUnexercised: unionExercised.size < facts.pool.length,
  /**
   * The regression gate. A rise is fine and asks for the pin to be bumped.
   *
   * Both this and `allowlistCurrent` are asserted ONLY at the pinned depth. A
   * shallower run legitimately exercises less, and a deeper one legitimately
   * exercises more — so at any other `GAMES` these would fail for the sampling
   * reason rather than a real one, and a gate that goes red for a reason the
   * operator already knows is a gate people learn to ignore. They still REPORT
   * at every depth; only the assertion is conditioned.
   */
  unionNotBelowPin: !atPinnedDepth || exercisedNeedingCode.length >= PINNED_UNION,
  allowlistCurrent: !atPinnedDepth || staleAllowlist.length === 0,
  /**
   * **Phase 4's gate, enforced.** Every implemented card that no run has seen act
   * is either proven reachable by the enumerator offering it, or carries a
   * written reason. "We did not get to it" is not one, and a new card that falls
   * into neither turns this red by name.
   */
  everyUnexercisedExplained: !atPinnedDepth || unexplained.length === 0,
  everySetReachable: setsWithoutRun.length === 0,
  /** The five buckets PARTITION the never-exercised list — every card lands in
   *  exactly one. Cheap, and it is the check that would have caught the overlap
   *  when `seatedNeverOffered` was split three ways: a card silently in two
   *  buckets, or in none, makes every count above it wrong. */
  bucketsPartition:
    offeredNeverTaken.length +
      drawnNeverOffered.length +
      startsInPlayNeverActed.length +
      seatedNeverDrawn.length +
      neverSeated.length ===
    never.length,
};

if (atPinnedDepth && exercisedNeedingCode.length > PINNED_UNION) {
  console.error(
    `reachability: union is ${exercisedNeedingCode.length}, above the pinned ${PINNED_UNION} — ` +
      `bump PINNED_UNION in probes/reachability.ts and the figure in CLAUDE.md.`,
  );
}

report(
  "reachability",
  {
    gamesPerMode: GAMES,
    modes: runs.map((r) => r.mode),
    pool: facts.pool.length,
    poolNeedingCode: needsCode.size,
    union: {
      seated: unionSeated.size,
      seatedNeedingCode: [...unionSeated].filter(isNeeded).length,
      /** Ever reached a hand. The ceiling on what could have been OFFERED, and
       *  the denominator that makes "never offered" mean anything. */
      drawn: unionDrawn.size,
      exercised: unionExercised.size,
      /** **The headline.** Of the cards that had code written for them, how many
       *  have ever been observed acting in a game. */
      exercisedNeedingCode: exercisedNeedingCode.length,
      neverExercisedNeedingCode: never.length,
      pinned: PINNED_UNION,
      pinnedAtGames: PINNED_AT_GAMES,
      /** False means the pin and the allowlist are reported but NOT asserted. */
      atPinnedDepth,
    },
    bySet,
    perRun,
    neverExercised: {
      total: never.length,
      /** Neither offered nor excused, in a HARD-GATED set. The actionable
       *  number, and the one `everyUnexercisedExplained` asserts on. */
      unexplained: unexplained.map(facts.label),
      /** The same condition in a set still being built — not a finding, but
       *  counted so it cannot become invisible. Named rather than listed: at 212
       *  cards the list would bury every other figure in this report, and
       *  `coverage.coverageBySet` is where the names belong. */
      unwrittenInSetUnderConstruction: unwrittenSetInProgress.length,
      provenReachableByOffer: offeredNeverTaken.length,
      allowlisted: never.filter((id) => UNEXERCISED_ALLOWLIST[id] !== undefined).length,
      offeredNeverTaken: offeredNeverTaken.map(facts.label),
      drawnNeverOffered: drawnNeverOffered.map(facts.label),
      startsInPlayNeverActed: startsInPlayNeverActed.map(facts.label),
      seatedNeverDrawn: seatedNeverDrawn.map(facts.label),
      neverSeated: neverSeated.map(facts.label),
    },
    staleAllowlist,
    setsWithoutRun,
    setsWithoutLegend,
    controls,
  },
  Object.values(controls).every(Boolean),
);
