/**
 * Shared setup for the engine probes.
 *
 * # Why these are TypeScript, and why that is the whole point
 *
 * Every probe here used to be an untyped `.mjs` file living in a session-local
 * scratchpad and importing the engine from a hardcoded `file:///A:/...` path. Two
 * consequences, both of which actually happened:
 *
 *  1. **They drifted silently.** A probe that hand-builds `GameState` as an object
 *     literal keeps compiling forever as the real type grows. `ai-health` omitted
 *     `firstPlayerIndex`, so `turn-manager`'s `nextIndex === state.firstPlayerIndex`
 *     was never true, `turnNumber` never incremented, and the probe reported
 *     `turns: {min:1, median:1, max:1}` for weeks — a constant, plausible lie
 *     sitting beside numbers that were real. It also meant `[Hidden]` (gated on
 *     `turnNumber > hiddenOnTurn`) was never exercised in ANY self-play run.
 *  2. **They were unrunnable anywhere else.** The absolute path pinned them to one
 *     machine and one drive letter.
 *
 * Both are fixed structurally rather than by care: the state is built HERE, once,
 * typed as `GameState`, and `packages/engine/tsconfig.typecheck.json` includes this
 * directory. Add a required field to `GameState` and `npm run typecheck` fails
 * immediately, naming this file. That is the protection the object literals never
 * had — and it is why the builder is shared rather than copied into each probe.
 *
 * Run them with plain `node` (Node 22.18+/24 strips types natively):
 *     npm run build --workspace=@rift-engine/engine   # they import the built dist
 *     node packages/engine/probes/ai-health.ts
 */
import {
  allPresetDecks,
  buildPlayerFromDeckList,
  chooseMatchBattlefields,
  defaultCardRegistry,
  LEGACY_BATTLEFIELDS,
  mulberry32,
  presetDeckList,
  startGame,
} from "@rift-engine/engine";
import type { BattlefieldState, GameState } from "@rift-engine/engine";

export type DeckList = ReturnType<typeof presetDeckList>;

/** The preset decks, as deck lists. Preset self-play can no longer exercise NEW
 *  card work — every remaining inert card is by construction outside these — but
 *  it is still the right basis for termination and stability gates. */
export const PRESET_DECKS: readonly DeckList[] = allPresetDecks().map(presetDeckList);

/** Indexes a readonly array under `noUncheckedIndexedAccess` without littering
 *  every call site with `!`. Throws rather than returning undefined, so a bad
 *  index is loud instead of becoming a plausible-looking zero somewhere later. */
export function at<T>(items: readonly T[], index: number): T {
  const item = items[((index % items.length) + items.length) % items.length];
  if (item === undefined) throw new Error(`no element at ${index} of ${items.length}`);
  return item;
}

/** The fixed three-battlefield set, as a `BattlefieldState[]`. Some probes pin
 *  this instead of rolling battlefields so that a RECORDED measurement stays
 *  reproducible — `walkout`'s "0 → 95 points per 200 games" is only comparable
 *  against the same games. */
export function legacyBattlefields(): BattlefieldState[] {
  return LEGACY_BATTLEFIELDS.map((name, i) => ({
    id: `bf-${i}`,
    name,
    controllerId: null,
    units: {},
    contestedByIndex: null,
    hiddenCards: [],
  }));
}

export interface GameOptions {
  firstPlayerIndex?: 0 | 1;
  /** Defaults to rolling per match, like a real game. Pin it with
   *  `legacyBattlefields()` when a probe's numbers are being compared to a
   *  previously recorded run. */
  battlefields?: BattlefieldState[];
}

/**
 * A fresh, fully-formed opening state.
 *
 * Deliberately typed `GameState` and handed straight to the engine's own
 * `startGame`, rather than assembled loosely. The point is that the compiler, not
 * the author, is responsible for the field list — and that there is exactly ONE
 * such literal across all the probes, so a new required field breaks one place.
 */
export function newGameState(a: DeckList, b: DeckList, seed: number, opts: GameOptions = {}): GameState {
  const registry = defaultCardRegistry();
  const firstPlayerIndex = opts.firstPlayerIndex ?? 0;
  const state: GameState = {
    players: [
      buildPlayerFromDeckList("p1", "A", a, registry, mulberry32(seed)),
      buildPlayerFromDeckList("p2", "B", b, registry, mulberry32(seed + 1)),
    ],
    battlefields: opts.battlefields ?? chooseMatchBattlefields(a, b, mulberry32(seed + 2)),
    activePlayerIndex: firstPlayerIndex,
    firstPlayerIndex,
    turnNumber: 1,
    phase: "Awaken",
    turnState: "Neutral",
    focusHolder: firstPlayerIndex,
    showdownBattlefieldId: null,
    showdownKind: null,
    consecutiveFocusPasses: 0,
    chainOpen: true,
    chainPriority: firstPlayerIndex,
    chainPasses: 0,
    spellChain: [],
    pendingTriggers: [],
    killDamagedUnitsThisTurn: false,
    spellResolvingForIndex: null,
    markedForDeathOnDamageInstanceIds: [],
    extraTurns: 0,
    extraTurnsForIndex: 0,
    chainOpenedByTrigger: false,
    deathWardedUnitInstanceIds: [],
    paidDeathWardUnitInstanceIds: [],
    unitsAwaitingDeathReplacement: [],
    pendingDecisions: [],
  };
  return state;
}

/** A started game — dealt hands and the first turn begun, which is what the real
 *  app does. */
export function startedGame(a: DeckList, b: DeckList, seed: number, opts: GameOptions = {}): GameState {
  return startGame(newGameState(a, b, seed, opts)).state;
}

export function stats(values: readonly number[]): { min: number; median: number; max: number } {
  const sorted = [...values].sort((x, y) => x - y);
  return { min: Math.min(...values), median: at(sorted, values.length >> 1), max: Math.max(...values) };
}

/** Reports a gate result and exits with the right code. Every probe ends here so
 *  a failure is a non-zero exit, not a line of text someone has to read. */
export function report(name: string, payload: unknown, ok: boolean): never {
  console.log(JSON.stringify(payload, null, 1));
  console.log(ok ? `${name}: OK` : `${name}: GATE FAILED`);
  process.exit(ok ? 0 : 1);
}
