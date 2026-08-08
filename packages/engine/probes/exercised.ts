/**
 * Exercised coverage for ONE deck set: of the cards this engine has IMPLEMENTED,
 * how many did this run actually play?
 *
 * `coverage.ts` answers "is it registered". This answers "has it run". See
 * `exercise-log.ts` for what the three signals mean and for the one blind spot,
 * and `exercise-run.ts` for the run loop itself — which lives there because
 * `reachability.ts` runs the same loop over every deck set and a second copy
 * would drift.
 *
 * **For the pool-wide number, run `reachability.ts` instead.** This probe reports
 * one mode; the union across all of them is a different question and used to have
 * no answer at all.
 *
 *     GAMES=40 node packages/engine/probes/exercised.ts
 *     DECKS=sfd node packages/engine/probes/exercised.ts
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
 * Worse, the games are less independent than the count suggests. The run pairs
 * `at(DECKS, seed)` with `at(DECKS, seed + 1)` and shuffles them with
 * `mulberry32(seed)` and `mulberry32(seed + 1)` — so deck X shuffled with seed `s`
 * turns up BOTH as player A at seed `s` and as player B at seed `s - 1`. Across 40
 * games each deck sees only about **five distinct shuffles**, not forty.
 *
 * That combination produced a false lead worth remembering: OGS-011 Flash sat in
 * Annie's deck for 10 games and reached a hand in none of them, which read as an
 * enumeration bug and was pure sampling. **Before calling a never-offered card a
 * defect, check it was ever drawn.** To actually reach a card, put it in at the
 * 3-copy maximum and vary the seed — more games alone buys less than it looks like.
 */
import { defaultCardRegistry, setCodeOf } from "@rift-engine/engine";
import { report } from "./harness.ts";
import { poolFacts } from "./pool-facts.ts";
import { runControls, runExercise } from "./exercise-run.ts";
import { topCounts } from "./exercise-log.ts";

const GAMES = Number(process.env.GAMES ?? 40);

const registry = defaultCardRegistry();
const facts = poolFacts(registry);

/**
 * `DECKS=sfd` swaps the seven pinned presets for one GENERATED deck per SFD
 * Legend, every implemented SFD card deliberately seated.
 *
 * The reason this mode exists at all: SFD reached 60 implemented cards while
 * this probe reported 0 of them exercised, because a card no deck contains
 * cannot be played however many games run. That is a DECK problem, and it is
 * fixed by decks.
 */
const run = runExercise(process.env.DECKS, GAMES, registry);
if (run.generated) {
  // Loud, because a covering run that silently covers nothing is the exact
  // shape `make-buffdeck.mjs` failed in: reporting its input as its output.
  console.error(
    `DECKS=${run.mode}: ${run.generated.decks} generated decks, ` +
      `${run.generated.covered} subjects seated, ${run.generated.orphans.length} orphans`,
  );
  for (const orphan of run.generated.orphans) console.error(`  ORPHAN (no Legend can hold it): ${orphan}`);
}

const log = run.log;
const inDecks = run.inDecks;
const exercised = log.exercised();
const needsCode = facts.needsCode;

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
for (const defId of facts.pool) {
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

/** In a deck, drawable, and still never did anything. Named, because a bare defId
 *  is not a lead anyone will follow. */
const inDeckButNeverExercised = [...inDecks].filter((id) => !exercised.has(id)).sort().map(facts.label);

/** **The engine offered it and the AI declined — every time.** Split out because
 *  it is a completely different fact from "never reachable", and lumping the two
 *  together turns a documented AI limitation into a fake backlog of broken cards.
 *  Expect the resource-banking permanents here permanently: `abilityBanksResource`
 *  drops them from the AI's candidate pool on purpose. */
const offeredButNeverTaken = [...log.offered].filter((id) => !exercised.has(id)).sort().map(facts.label);

/** In a deck and NEVER even offered. These are the real leads — nothing about AI
 *  taste explains them, so it is reachability, a cost the AI can never meet, or a
 *  gap in enumeration. */
const inDeckButNeverOffered = [...inDecks]
  .filter((id) => !log.offered.has(id) && !exercised.has(id))
  .sort()
  .map(facts.label);

/** Exercised but in no deck list — expected to be tokens, which are created rather
 *  than played. Anything else here means this observer resolved a defId wrongly. */
const exercisedOutsideDecks = [...exercised].filter((id) => !inDecks.has(id)).sort();

/** `activatableInDecks` is a COUNT and is reported under `signals`, not here:
 *  `every(Boolean)` over the controls would read a legitimate 0 as a failure. */
const { activatableInDecks, ...runHealth } = runControls(run);

const controls = {
  ...runHealth,
  /** The negative control. If everything in the pool reports exercised, the
   *  observer is marking rather than measuring. */
  somethingUnexercised: exercised.size < facts.pool.length,
};

report(
  "exercised",
  {
    games: GAMES,
    mode: run.mode,
    decksUsed: [...run.decksUsed].sort(),
    invalid: run.invalid,
    pool: facts.pool.length,
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
      /** Cards in these decks with an ability the AI would ever take. Reported
       *  because `controls.activatedSeen` passes vacuously when this is 0, and
       *  a bare `true` cannot be told from "activations really happened" — the
       *  reporting flaw `inDeckButNeverOffered` vs `offeredButNeverTaken` was
       *  split apart to fix. A DECKS=SFD run reads 0 here, and should. */
      activatableInDecks,
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
