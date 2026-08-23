/**
 * **Does any battlefield ability actually FIRE in a real game?**
 *
 *     npm run build --workspace=@rift-engine/engine
 *     node packages/engine/probes/battlefield-reach.ts
 *
 * # The gap this exists for
 *
 * Measured 2026-08-22, after all 64 battlefields were implemented: **eight of
 * them are ever in play in any instrument here, and all eight are OGN.**
 * `reachability`, `walkout` and `chain-depth` pin `legacyBattlefields()` — three
 * of them — deliberately, so their recorded figures stay comparable;
 * `ai-health` and `passive-human` roll from the PRESET decks, which between them
 * name eight. SFD's 15, UNL's 15 and VEN's 10 never appear at all.
 *
 * **And `reachability` cannot report that.** Its `everyUnexercisedExplained`
 * gate is about CARDS, and `card-loader`'s `shouldSkip` keeps Battlefield-type
 * cards out of the registry entirely — so `needsImplementation` never counts one
 * and `isCardImplemented` is never asked about one. A battlefield ability that is
 * correct, tested, hard-gated and completely unreachable in play looks identical
 * to one that fires every game. That is the same shape as the recorded "a
 * mechanic can be correct and the board has nothing to click", one level down.
 *
 * # What this probe does differently, and what it deliberately does NOT touch
 *
 * It rolls battlefields from the WHOLE POOL rather than from decks or the legacy
 * three, cycling so every one of the 64 gets play time.
 *
 * **It is a NEW probe rather than a change to the pinned ones**, and that is the
 * whole design. Making `walkout` roll real battlefields would move 190/113/29 and
 * making `reachability` do it would move every per-set figure — pin-moving
 * changes that CLAUDE.md says must be decomposed by control. This adds a
 * measurement without disturbing one.
 *
 * # What "fired" can and cannot mean here
 *
 * The 64 split across SIX implementation sources and only some are observable
 * from the outside:
 *
 *  - **TRIGGERED** ones place a Chain Pending Item with `source: "battlefield"`
 *    carrying their own defId. Those are observed directly, and `firedDefIds`
 *    is the honest answer for them.
 *  - **CONTINUOUS**, **beginning-phase**, the granted activated abilities, the
 *    death replacement and the two cost discounts have no event to watch. For
 *    those the probe reports IN PLAY — the battlefield was on the board with the
 *    game running — which is the precondition for the ability mattering and is
 *    all an outside observer can say.
 *
 * So a triggered battlefield that is in play and never fires is a FINDING; a
 * continuous one that is in play is as far as this instrument goes. Both numbers
 * are reported separately rather than summed into a single misleading total.
 *
 * # What it found on its first run, and the figures to expect
 *
 * At the default depth: **132 games, all 64 in play, 35 of the 38 triggered ones
 * fire, 0 invalid.** Per set, fired/triggered: OGN 14/16, SFD 10/10, UNL 9/9,
 * VEN 2/3.
 *
 * The three that stay silent are all genuinely CONDITIONAL rather than broken,
 * and they are named here so that a FOURTH one appearing is visible:
 *
 *  - **VEN-162 Protective Sands** - "when you conquer here, if you control 4 or
 *    fewer runes". Conquering tends to happen late, by which point the rune
 *    count has passed four. Pinned by six tests including a positive control.
 *  - **OGN-292 The Dreaming Tree** - a spell must choose the chooser's OWN unit,
 *    standing here. The AI's spells overwhelmingly name enemy units.
 *  - **OGN-293 The Grand Plaza** - "if you have 7+ units here" is part of the
 *    Trigger Condition (383.2.a.1), so below seven the ability does not trigger
 *    at all, and no self-play game here ever stacks seven units at one
 *    battlefield. Pinned by four tests in `test/battlefield-hold.test.ts`.
 *
 * **The Plaza joined the list on 2026-08-23 and that is this probe telling the
 * truth about itself.** Until then the count was asked only at RESOLUTION, so a
 * Pending Item was placed at every hold and did nothing - and placing a chain
 * item is the only thing this probe can see, so it reported the card as firing.
 * Decomposed by control: `applies` forced true gives 36/2/1012 chain items, the
 * rule's reading gives 35/3/995, and the 17-item delta is entirely the Plaza's.
 * **"Fired" here means "reached the chain", not "did something"** - which is the
 * same blind spot, one level down, that this probe exists to cover.
 *
 * **The Tree is why this probe was worth writing.** It had been implemented,
 * registered and hard-gated for the life of the engine with NO behavioural test
 * at all - its only appearance in `test/` was a remark inside someone else's
 * comment - and nothing could see that, because `battlefield-coverage` asks
 * whether an entry exists and the entry does. Silent-in-play plus
 * pinned-by-nothing is the pair that matters; either half alone is fine.
 * `test/dreaming-tree.test.ts` closes it.
 *
 * # Two things this probe got wrong about ITSELF first
 *
 * Its first run reported **22 invalid actions in 22 games** and it was the LOOP,
 * not the engine: `legalActions` keeps enumerating after a winner exists while
 * `game-engine` refuses everything with "Game is already over", so a loop that
 * only watches for an empty action list spends its last step on an action that
 * cannot be taken. `walkout` breaks on the `GameOver` result and reports 0. Run
 * with `WHY=1` to print the board and the refused action, which settled this in
 * one command.
 *
 * And a battlefield trigger does NOT stay in `pendingTriggers`: a completed play
 * promotes it onto the `spellChain` (383.3). Both are read here for that reason,
 * and a test that watched only the first failed against wiring that was correct.
 */
import { battlefieldAbilityDefIds, loadBattlefieldDefinitions } from "@rift-engine/engine";
import type { BattlefieldState, GameState } from "@rift-engine/engine";
import { chooseAction } from "@rift-engine/engine";
import { legalActions, submit } from "@rift-engine/engine";
import { at, PRESET_DECKS, report, startedGame } from "./harness.ts";

/** Games per battlefield TRIPLE. The pool is 64, so a triple count of 22 covers
 *  every one of them twice over. */
const GAMES_PER_SET = Number(process.env.GAMES ?? 6);
/** Same cap `walkout` uses — a game that has not ended by here is stuck, and the
 *  probe says so rather than hanging. */
const ACTION_CAP = 400;

const defs = loadBattlefieldDefinitions();
// **Through the package index, not `../src/`.** Probes resolve from `dist`; a
// src-relative import dies on module resolution, which this repo has recorded
// before and which cost this file its first run.
const triggered = new Set(battlefieldAbilityDefIds());

/** Three battlefields as a `BattlefieldState[]`, stamped with their defIds
 *  exactly as `battlefieldPair` stamps a real game's — without the stamp the
 *  board has no printed ability and this probe would measure nothing. */
function board(names: { id: string; name: string }[]): BattlefieldState[] {
  return names.map((def, i) => ({
    id: `bf-${i}`,
    name: def.name,
    defId: def.id,
    controllerId: null,
    units: {},
    contestedByIndex: null,
    hiddenCards: [],
  }));
}

const inPlay = new Set<string>();
const fired = new Set<string>();
let games = 0;
let finished = 0;
let unfinished = 0;
let invalid = 0;
let chainItemsSeen = 0;

// Every battlefield gets play time: walk the pool three at a time, wrapping, so
// each appears in at least one triple however the pool grows.
for (let start = 0; start < defs.length; start += 3) {
  const triple = [0, 1, 2].map((k) => defs[(start + k) % defs.length]!);
  for (let g = 0; g < GAMES_PER_SET; g += 1) {
    games += 1;
    const seed = 9000 + start * 131 + g * 17;
    let state: GameState = startedGame(at(PRESET_DECKS, g), at(PRESET_DECKS, g + 1), seed, {
      battlefields: board(triple),
    });
    for (const def of triple) inPlay.add(def.id);

    let gameOver = false;
    for (let i = 0; i < ACTION_CAP; i += 1) {
      if (legalActions(state).length === 0) break;
      // Chosen ONCE and reused by the diagnostic — calling `chooseAction` again
      // to report what failed would re-run the whole evaluation.
      const action = chooseAction(state);
      const res = submit(state, action);
      if (res.result.type === "Invalid") {
        invalid += 1;
        // `WHY=1` names the board and the refused action. That is what turned
        // this probe's first run — 22 invalid of 22 games — from "the engine is
        // broken on these battlefields" into "my loop kept playing after
        // someone had won", in one command.
        if (process.env.WHY) {
          console.error(`INVALID @ ${triple.map((d) => d.id).join("/")} :: ${action.type} :: ${res.result.error}`);
        }
        break;
      }
      state = res.state;
      // **Stop when the game is WON.** `legalActions` still enumerates after a
      // winner exists, while `game-engine` refuses everything with "Game is
      // already over" — so a loop that only watches for an empty action list
      // spends its last step submitting an action that cannot be taken and
      // records a false `invalid`. The first run of this probe reported 22 of 22
      // games invalid for exactly that reason and nothing was wrong with the
      // engine. `walkout` breaks on this same result and reports 0.
      if (res.result.type === "GameOver") {
        finished += 1;
        gameOver = true;
        break;
      }
      // A battlefield ability on the chain names its own battlefield's defId —
      // see `holdBattlefieldTrigger`, which carries `listenerDefId` for exactly
      // this kind of reading.
      for (const entry of [...state.pendingTriggers, ...state.spellChain]) {
        if ("source" in entry && entry.source === "battlefield" && "listenerDefId" in entry) {
          chainItemsSeen += 1;
          fired.add(entry.listenerDefId);
        }
      }
      if (legalActions(state).length === 0) break;
    }
    // Counted ONCE: a game that ran out of actions or hit the cap without a
    // winner is not "finished" in the sense the control means.
    if (!gameOver) unfinished += 1;
  }
}

const setOf = (id: string) => id.split("-")[0]!;
const triggeredDefs = defs.filter((d) => triggered.has(d.id));
const silentTriggered = triggeredDefs.filter((d) => !fired.has(d.id));
const neverInPlay = defs.filter((d) => !inPlay.has(d.id));

const bySet = new Map<string, { total: number; triggered: number; fired: number }>();
for (const d of defs) {
  const row = bySet.get(setOf(d.id)) ?? { total: 0, triggered: 0, fired: 0 };
  row.total += 1;
  if (triggered.has(d.id)) row.triggered += 1;
  if (fired.has(d.id)) row.fired += 1;
  bySet.set(setOf(d.id), row);
}

const controls = {
  /** The probe ran at all. A zero-game run reports nothing fired and reads
   *  exactly like every battlefield being inert — the `[Deflect]` failure mode. */
  playedGames: games > 0 && finished > 0,
  /** Every battlefield really was put on a board. This is the half the pinned
   *  probes cannot say, and the reason this file exists. */
  everyBattlefieldInPlay: neverInPlay.length === 0,
  /** Something fired. A zero here means the observation itself is broken, not
   *  that 64 cards are inert. */
  someAbilityFired: fired.size > 0,
  /** No enumerated action was refused — the offered-then-refused check, run here
   *  over boards the other probes never visit. */
  noInvalidActions: invalid === 0,
};

report(
  "battlefield-reach",
  {
    gamesPerTriple: GAMES_PER_SET,
    games,
    finished,
    unfinished,
    invalid,
    pool: defs.length,
    inPlay: inPlay.size,
    triggeredInPool: triggeredDefs.length,
    firedAtLeastOnce: fired.size,
    chainItemsSeen,
    bySet: Object.fromEntries([...bySet].sort()),
    /** Triggered battlefields that were on the board and never placed a Pending
     *  Item. Not automatically a bug — several are conditional on a board state
     *  these games may not reach — but it is the actionable list. */
    triggeredButSilent: silentTriggered.map((d) => `${d.id} ${d.name}`),
    neverInPlay: neverInPlay.map((d) => `${d.id} ${d.name}`),
    controls,
  },
  Object.values(controls).every(Boolean),
);
