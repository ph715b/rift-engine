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
 * # The three reasons a card is on that list are not interchangeable
 *
 * | bucket | meaning | is it a defect? |
 * |---|---|---|
 * | `offeredNeverTaken` | the engine offered it, the AI declined every time | **usually not** — a 1-ply evaluator cannot price a deferred or informational effect |
 * | `seatedNeverOffered` | in a deck, and `legalActions` never enumerated it | maybe — but check it was ever DRAWN first |
 * | `neverSeated` | no run could put it in front of a player at all | a deck/pool problem, not an engine one |
 *
 * `exercised.ts`'s header has the sampling caveat that governs the middle row: a
 * game draws about **10 of a 39-card deck**, so one copy very likely never
 * appears, and OGS-011 Flash once read convincingly as an enumeration bug purely
 * from that.
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
import { defaultCardRegistry, setCodeOf } from "@rift-engine/engine";
import { report } from "./harness.ts";
import { poolFacts } from "./pool-facts.ts";
import { PRESETS, runControls, runExercise, type ExerciseRun } from "./exercise-run.ts";
import { UNEXERCISED_ALLOWLIST } from "./unexercised-allowlist.ts";

const GAMES = Number(process.env.GAMES ?? 40);

/**
 * The recorded union, as `walkout` pins 191/107/32.
 *
 * It is a FLOOR, not an equality: the whole point of Phase 1b is to raise it, and
 * a gate that failed on an improvement would just get edited away. Going UP prints
 * a line asking for the pin to be bumped; going DOWN is red.
 *
 * Measured 2026-08-07 at 40 games per mode, battlefields pinned. Re-measure
 * before changing it, and if it moves without a deliberate cause, that is the
 * finding.
 */
const PINNED_UNION = 367;

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
for (const run of runs) {
  for (const id of run.log.exercised()) unionExercised.add(id);
  for (const id of run.log.offered) unionOffered.add(id);
  for (const id of run.inDecks) unionSeated.add(id);
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

/** Implemented, needs code, and no run has ever seen it act. Partitioned by the
 *  three reasons, because they take completely different work — and lumping them
 *  together turns a documented AI limitation into a fake backlog of broken cards. */
const never = [...needsCode].filter((id) => !unionExercised.has(id)).sort();
const neverSeated = never.filter((id) => !unionSeated.has(id));
const seatedNeverOffered = never.filter((id) => unionSeated.has(id) && !unionOffered.has(id));
const offeredNeverTaken = never.filter((id) => unionOffered.has(id));

/** An excused card that turns up exercised, or one that is not in the registry at
 *  all. Both mean the allowlist is describing an engine that no longer exists —
 *  the failure mode this repo has recorded against `PARTIALLY_IMPLEMENTED`, the
 *  Divergent table and the verification loop itself. */
const inPool = new Set(facts.pool);
const staleAllowlist = Object.keys(UNEXERCISED_ALLOWLIST)
  .filter((id) => unionExercised.has(id) || !inPool.has(id))
  .sort()
  .map((id) => (inPool.has(id) ? `${facts.label(id)} — EXERCISED, excuse is stale` : `${id} — not in the registry`));
const unexplained = never.filter((id) => UNEXERCISED_ALLOWLIST[id] === undefined);

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

const controls = {
  /** Every per-run instrument control, including `invalid: 0`. */
  everyRunHealthy: perRun.every((r) => Object.values(r.controls).every((v) => v !== false)),
  /** The positive control on the MERGE. One run's log reported as the union would
   *  leave every other figure here looking perfectly reasonable. */
  unionExceedsEveryRun: unionExercised.size > biggestSingleRun,
  /** The negative control: an observer that marks rather than measures reports
   *  everything exercised. */
  somethingUnexercised: unionExercised.size < facts.pool.length,
  /** The regression gate. A rise is fine and asks for the pin to be bumped. */
  unionNotBelowPin: exercisedNeedingCode.length >= PINNED_UNION,
  allowlistCurrent: staleAllowlist.length === 0,
  everySetReachable: setsWithoutRun.length === 0,
};

if (exercisedNeedingCode.length > PINNED_UNION) {
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
      exercised: unionExercised.size,
      /** **The headline.** Of the cards that had code written for them, how many
       *  have ever been observed acting in a game. */
      exercisedNeedingCode: exercisedNeedingCode.length,
      neverExercisedNeedingCode: never.length,
      pinned: PINNED_UNION,
    },
    bySet,
    perRun,
    neverExercised: {
      total: never.length,
      unexplained: unexplained.length,
      allowlisted: never.length - unexplained.length,
      offeredNeverTaken: offeredNeverTaken.map(facts.label),
      seatedNeverOffered: seatedNeverOffered.map(facts.label),
      neverSeated: neverSeated.map(facts.label),
    },
    staleAllowlist,
    setsWithoutRun,
    setsWithoutLegend,
    controls,
  },
  Object.values(controls).every(Boolean),
);
