/**
 * Exercised coverage: of the cards this engine has IMPLEMENTED, how many has any
 * automated run ever actually played?
 *
 * `coverage.ts` answers "is it registered". This answers "has it run". See
 * `exercise-log.ts` for what the three signals mean and for the one blind spot.
 *
 * # Read the three numbers together or not at all
 *
 * The report gives `inPool`, `inDecks` and `exercised` per set, and the middle one
 * is the point. `exercised` alone invites the same misreading `make-buffdeck.mjs`
 * once invited: a low number looks like an engine problem when it is usually a
 * DECK problem — a card no preset deck contains cannot be played, no matter how
 * many games run. `inDecks` is the ceiling this run could possibly have reached,
 * so `exercised / inDecks` measures the engine and the AI, while `inDecks / inPool`
 * measures the decks. They fail for different reasons and are fixed by different
 * work.
 *
 *     GAMES=40 node packages/engine/probes/exercised.ts
 *
 * The gate here is on INSTRUMENT HEALTH, not on a coverage threshold. Any
 * threshold would be a number picked to pass. What is gated is that all three
 * signals fired, that no activation went unresolved, and that something in the pool
 * is still unexercised — that last one is the negative control, and without it an
 * observer that simply marked every card would report a triumphant 270/270.
 *
 * # A card can be in the deck and still never be SEEN
 *
 * Measured, because it changes how every number here should be read: a game in this
 * engine lasts 5–8 turns and only about **10 distinct cards of a 39-card deck ever
 * reach a hand** — roughly a quarter. So a single copy of a card is unlikely to
 * appear in any given game, and `inDecks` badly overstates what one run can reach.
 *
 * Worse, the games are less independent than the count suggests. This probe pairs
 * `at(PRESET_DECKS, seed)` with `at(PRESET_DECKS, seed + 1)` and shuffles them with
 * `mulberry32(seed)` and `mulberry32(seed + 1)` — so deck X shuffled with seed `s`
 * turns up BOTH as player A at seed `s` and as player B at seed `s - 1`. Across 40
 * games each deck sees only about **five distinct shuffles**, not forty.
 *
 * That combination produced a false lead worth remembering: OGS-011 Flash sat in
 * Annie's deck for 10 games and reached a hand in none of them, which read as an
 * enumeration bug and was pure sampling. **Before calling a never-offered card a
 * defect, check it was ever drawn.** To actually reach a card, put it in at the
 * 3-copy maximum and vary the seed — more games alone buys less than it looks like.
 *
 * # It counts from the state stream, and it has to
 *
 * README.md's standing rule: *count from the state stream, never from inside the
 * engine*, because the heuristic AI's lookahead applies every candidate action
 * through the real executors to score it — a probe that wrapped a resolver once
 * reported a card "played 259 times" when the true answer was zero. The same trap
 * is wide open here and is avoided the same way: `record` reads the action that was
 * actually SUBMITTED, and `scanChain` reads only the state `submit` returned.
 * Nothing observes a resolver. Instrumenting `card-effects.ts` would have been the
 * obvious implementation and would have counted the AI thinking as the AI acting.
 */
import { chooseAction, defaultCardRegistry, needsImplementation, setCodeOf, submit } from "@rift-engine/engine";
import { at, legacyBattlefields, PRESET_DECKS, report, startedGame } from "./harness.ts";
import { ExerciseLog, topCounts } from "./exercise-log.ts";

const GAMES = Number(process.env.GAMES ?? 40);
const ACTION_CAP = 3000;

const registry = defaultCardRegistry();
const log = new ExerciseLog();

/** Every defId the decks in this run could put in front of a player. Legend and
 *  champion included: they never appear in `cardIds` but are absolutely in play. */
const inDecks = new Set<string>();
const decksUsed = new Set<string>();

let invalid = 0;
let gamesRun = 0;

for (let seed = 1; seed <= GAMES; seed++) {
  const deckA = at(PRESET_DECKS, seed);
  const deckB = at(PRESET_DECKS, seed + 1);
  for (const deck of [deckA, deckB]) {
    decksUsed.add(deck.name);
    inDecks.add(deck.legendId);
    inDecks.add(deck.championId);
    for (const id of deck.cardIds) inDecks.add(id);
    for (const id of deck.sideboardCardIds) inDecks.add(id);
  }

  // Battlefields PINNED, per README.md: these numbers get quoted, and rolling them
  // per match makes successive runs incomparable — `walkout` once reported 236
  // instead of the recorded 154 from that alone.
  let state = startedGame(deckA, deckB, seed, { battlefields: legacyBattlefields() });
  gamesRun++;

  for (let taken = 0; taken < ACTION_CAP; taken++) {
    const action = chooseAction(state);
    const before = state;
    const res = submit(state, action);
    if (res.result.type === "Invalid") {
      invalid++;
      break;
    }
    log.scanOffers(before);
    log.record(before, action);
    state = res.state;
    log.scanChain(state);
    if (res.result.type === "GameOver") break;
  }
}

const exercised = log.exercised();
const defs = registry.all();
const pool = defs.map((d) => d.id);

/** The subset with rules text that had to be WRITTEN. The whole-registry count is
 *  288; `needsImplementation` is 270, and that 270 is the denominator every other
 *  doc and gate in this repo quotes. Both are reported, because an instrument
 *  quietly using a different denominator from the rest of the project is how a
 *  figure ends up argued about instead of trusted. A vanilla card being unexercised
 *  costs nothing — there is no code behind it to be wrong. */
const needsCode = new Set(defs.filter(needsImplementation).map((d) => d.id));
const nameOf = new Map(defs.map((d) => [d.id, d.name]));

interface SetRow {
  inPool: number;
  needsCode: number;
  inDecks: number;
  exercised: number;
  /** Of what these decks could possibly reach, how much did. Measures the engine
   *  and the AI. */
  reachedOfReachable: string;
  /** Of the whole set, how much these decks can reach at all. Measures the DECKS,
   *  and is the number that is actually low. */
  reachableOfPool: string;
}

const sets: Record<string, SetRow> = {};
for (const defId of pool) {
  const code = setCodeOf(defId);
  const row = (sets[code] ??= {
    inPool: 0,
    needsCode: 0,
    inDecks: 0,
    exercised: 0,
    reachedOfReachable: "",
    reachableOfPool: "",
  });
  row.inPool++;
  if (needsCode.has(defId)) row.needsCode++;
  if (inDecks.has(defId)) row.inDecks++;
  if (exercised.has(defId)) row.exercised++;
}
const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`);
for (const row of Object.values(sets)) {
  row.reachedOfReachable = pct(row.exercised, row.inDecks);
  row.reachableOfPool = pct(row.inDecks, row.inPool);
}

const typeOf = new Map(defs.map((d) => [d.id, d.type]));
/** A Legend can never be OFFERED: it starts in play and is never played, so its
 *  only signals are an activated ability or a trigger. Marked rather than filtered,
 *  because "a Legend that never fired" is still worth seeing — just not as evidence
 *  of an enumeration gap. */
const label = (id: string): string =>
  `${id} ${nameOf.get(id) ?? "?"}` +
  (typeOf.get(id) === "Legend" ? " [Legend — never offerable]" : "") +
  (needsCode.has(id) ? "" : " (vanilla)");

/** In a deck, drawable, and still never did anything. Named, because a bare defId
 *  is not a lead anyone will follow. */
const inDeckButNeverExercised = [...inDecks].filter((id) => !exercised.has(id)).sort().map(label);

/** **The engine offered it and the AI declined — every time.** Split out because
 *  it is a completely different fact from "never reachable", and lumping the two
 *  together turns a documented AI limitation into a fake backlog of broken cards.
 *  Expect the resource-banking permanents here permanently: `abilityBanksResource`
 *  drops them from the AI's candidate pool on purpose. */
const offeredButNeverTaken = [...log.offered].filter((id) => !exercised.has(id)).sort().map(label);

/** In a deck and NEVER even offered. These are the real leads — nothing about AI
 *  taste explains them, so it is reachability, a cost the AI can never meet, or a
 *  gap in enumeration. */
const inDeckButNeverOffered = [...inDecks]
  .filter((id) => !log.offered.has(id) && !exercised.has(id))
  .sort()
  .map(label);

/** Exercised but in no deck list — expected to be tokens, which are created rather
 *  than played. Anything else here means this observer resolved a defId wrongly. */
const exercisedOutsideDecks = [...exercised].filter((id) => !inDecks.has(id)).sort();

const controls = {
  /** All three signals fired. A zero in any of them means that whole detection
   *  path is broken, which no coverage percentage would reveal. */
  playedSeen: log.played.size > 0,
  activatedSeen: log.activated.size > 0,
  triggeredSeen: log.triggered.size > 0,
  /** The negative control. If everything in the pool reports exercised, the
   *  observer is marking rather than measuring. */
  somethingUnexercised: exercised.size < pool.length,
  /** Every ActivateAbility resolved to a permanent this observer could find. */
  activationsResolve: log.activationsUnresolved === 0,
  /** Games actually played out rather than dying on the first action. */
  gamesRan: gamesRun === GAMES,
  /** **Everything the AI played was something `legalActions` offered.** The one
   *  real invariant this probe can assert rather than merely report — and the
   *  failure it catches is the offered-then-refused family that has now bitten
   *  this repo three times (most recently Get Excited! at a `[Deflect]` unit,
   *  which threw out of `chooseAction` mid-game). Restricted to the two action
   *  kinds `offered` tracks. */
  takenWasOffered: [...log.played.keys(), ...log.activated.keys()].every((id) => log.offered.has(id)),
};

report(
  "exercised",
  {
    games: GAMES,
    decksUsed: [...decksUsed].sort(),
    invalid,
    pool: pool.length,
    poolNeedingCode: needsCode.size,
    inDecks: inDecks.size,
    exercised: exercised.size,
    exercisedNeedingCode: [...exercised].filter((id) => needsCode.has(id)).length,
    neverExercisedNeedingCode: [...needsCode].filter((id) => !exercised.has(id)).length,
    bySet: sets,
    signals: {
      played: log.played.size,
      activated: log.activated.size,
      triggered: log.triggered.size,
      activationsUnresolved: log.activationsUnresolved,
    },
    offered: log.offered.size,
    inDeckButNeverOffered,
    offeredButNeverTaken,
    inDeckButNeverExercised,
    exercisedOutsideDecks,
    mostPlayed: topCounts(log.played, 10),
    mostActivated: topCounts(log.activated, 10),
    controls,
  },
  Object.values(controls).every(Boolean),
);
