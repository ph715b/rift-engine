import type { GameState, PlayerState } from "../model/game-state.js";
import { scoreHolds } from "./scoring.js";

/**
 * The turn/phase loop, ported from engine/TurnManager.java. Each function is
 * a pure `(state) -> state` step rather than a mutation on a shared
 * TurnManager instance — Java's `startingPlayerIndex`/`secondPlayerBonusGranted`
 * instance fields (TurnManager.java:178-180) are replaced by deriving the
 * same "does the second player get a 3rd Channel rune this game" condition
 * straight from `turnNumber`/`activePlayerIndex` (see runChannel below),
 * since our GameState always starts at `activePlayerIndex: 0` (there's no
 * separate "who went first" concept to capture).
 *
 * Only the general-purpose steps are ported — the long tail of per-card
 * triggers TurnManager.java's runBeginning/runEnd fire (temporary-unit kills,
 * ~40 "this turn" field resets, legend/unit/battlefield ability hooks) isn't
 * modeled yet, since none of those cards/mechanics are implemented. Add them
 * here alongside each mechanic, the same deferral discipline as everywhere
 * else in this port.
 */

function updatePlayer(state: GameState, index: 0 | 1, update: (p: PlayerState) => PlayerState): GameState {
  const players = [...state.players] as [PlayerState, PlayerState];
  players[index] = update(players[index]);
  return { ...state, players };
}

/** Ready all exhausted cards for the active player; ready exhausted runes in
 *  their pool; reset their per-turn conquest tracking. Mirrors
 *  TurnManager.runAwaken (engine/TurnManager.java:65-84) plus
 *  ScoringSystem.onTurnStart (engine/ScoringSystem.java:30-32, called from
 *  runAwaken), minus UnitAbilities.cannotBeReadied (no card grants that yet). */
export function runAwaken(state: GameState): GameState {
  if (state.phase !== "Awaken") {
    throw new Error(`runAwaken requires Awaken phase, currently: ${state.phase}`);
  }
  const active = state.activePlayerIndex;

  const battlefields = state.battlefields.map((bf) => ({
    ...bf,
    units: {
      ...bf.units,
      [state.players[active].id]: (bf.units[state.players[active].id] ?? []).map((u) => ({ ...u, exhausted: false })),
    },
  }));

  const next = updatePlayer({ ...state, battlefields }, active, (p) => ({
    ...p,
    baseUnits: p.baseUnits.map((u) => ({ ...u, exhausted: false })),
    activeGear: p.activeGear.map((g) => ({ ...g, exhausted: false })),
    legend: { ...p.legend, exhausted: false },
    channeled: p.channeled.map((r) => (r.state === "Exhausted" ? { ...r, state: "Ready" as const } : r)),
    conqueredBattlefieldsThisTurn: [],
  }));

  return { ...next, phase: "Beginning" };
}

/** Scores holds for the active player. Mirrors TurnManager.runBeginning
 *  (engine/TurnManager.java:86-98), minus killTemporaryUnits (no card
 *  grants [Temporary] yet) and every Beginning-Phase ability hook (no
 *  cards with onBeginningPhase effects modeled). */
export function runBeginning(state: GameState): GameState {
  if (state.phase !== "Beginning") {
    throw new Error(`runBeginning requires Beginning phase, currently: ${state.phase}`);
  }
  return { ...scoreHolds(state, state.activePlayerIndex), phase: "Channel" };
}

/**
 * Reveals runes from the rune deck into the channeled pool: 2 normally, 3 on
 * the second-acting player's very first turn (core rules' going-second
 * compensation). Mirrors TurnManager.runChannel (engine/TurnManager.java:182-201).
 * "Second player's first turn" == `turnNumber === 1 && activePlayerIndex === 1`,
 * since turnNumber only advances when play wraps back to player 0
 * (see runEnd) and this engine always starts at `activePlayerIndex: 0`.
 */
export function runChannel(state: GameState): GameState {
  if (state.phase !== "Channel") {
    throw new Error(`runChannel requires Channel phase, currently: ${state.phase}`);
  }
  const active = state.activePlayerIndex;
  const toChannel = state.turnNumber === 1 && active === 1 ? 3 : 2;

  const next = updatePlayer(state, active, (p) => {
    const runeDeck = [...p.runeDeck];
    const drawn = runeDeck.splice(0, Math.min(toChannel, runeDeck.length)).map((r) => ({ ...r, state: "Ready" as const }));
    return { ...p, runeDeck, channeled: [...p.channeled, ...drawn] };
  });

  return { ...next, phase: "Draw" };
}

/**
 * Draws 1 card for the active player. Mirrors TurnManager.runDraw
 * (engine/TurnManager.java:203-222), minus the >2-player "player 0 skips
 * their turn-1 draw" exception (out of scope — this engine is 2-player
 * only) and Burn Out (drawing from an empty deck should recycle the trash
 * and award the opponent 1 point, core rules §431-433) — not implemented
 * yet (no ScoringSystem); an empty deck silently no-ops here for now, a
 * documented, weaker-than-real-rules gap rather than a crash.
 */
export function runDraw(state: GameState): GameState {
  if (state.phase !== "Draw") {
    throw new Error(`runDraw requires Draw phase, currently: ${state.phase}`);
  }
  const next = updatePlayer(state, state.activePlayerIndex, (p) => {
    if (p.deck.length === 0) return p; // TODO: Burn Out (see doc comment)
    const [drawn, ...rest] = p.deck;
    return { ...p, deck: rest, hand: [...p.hand, drawn!] };
  });
  return { ...next, phase: "Action" };
}

/** Runs Awaken -> Beginning -> Channel -> Draw, landing in Action phase.
 *  Mirrors TurnManager.runStartOfTurn (engine/TurnManager.java:18-27), minus
 *  the Blue Sentinel rainbow-choice queue (no card grants that yet). */
export function runStartOfTurn(state: GameState): GameState {
  return runDraw(runChannel(runBeginning(runAwaken(state))));
}

/**
 * Ends the active player's turn: clears turn-scoped bonuses, empties floating
 * Energy/Power, resets cardsPlayedThisTurn, and rotates to the next player
 * (incrementing turnNumber when play wraps back to player 0). Mirrors the
 * general-purpose parts of TurnManager.runEnd (engine/TurnManager.java:224-360)
 * — the ~40 per-card "this turn" field resets there have no equivalent yet
 * since none of those fields exist on our GameState/PlayerState (see this
 * file's own top doc comment).
 *
 * DELIBERATE DIVERGENCE from the Java oracle: damage is NOT healed here.
 * TurnManager.java:277-286 clears `damage` alongside `bonus` for every unit
 * on both sides at end of turn, which makes any damage dealt outside combat
 * (a Spell, an on-play trigger) evaporate before it can ever matter — soften
 * a blocker on your turn and it's whole again before your opponent attacks.
 * Per the real rules, marked damage is removed when a SHOWDOWN ends, not when
 * a turn does; combat.ts's own `heal` (applied to the survivors of a resolved
 * Showdown) is the only place that clears it. `bonus` still expires here —
 * that one genuinely is an "until end of turn" effect.
 */
export function runEnd(state: GameState): GameState {
  if (state.phase !== "Action") {
    throw new Error(`runEnd requires Action phase, currently: ${state.phase}`);
  }

  const expireBonuses = <T extends { damage: number; bonus: number }>(u: T): T => ({ ...u, bonus: 0 });

  const players = state.players.map((p) => ({
    ...p,
    baseUnits: p.baseUnits.map(expireBonuses),
    floatingEnergy: 0,
    floatingPower: {},
    cardsPlayedThisTurn: 0,
    unitsEnterReadyThisTurn: false,
    restrictedSpellEnergy: 0,
  })) as [PlayerState, PlayerState];

  const battlefields = state.battlefields.map((bf) => {
    const units: typeof bf.units = {};
    for (const [playerId, list] of Object.entries(bf.units)) {
      units[playerId] = list.map(expireBonuses);
    }
    return { ...bf, units };
  });

  const nextIndex = ((state.activePlayerIndex + 1) % 2) as 0 | 1;
  const turnNumber = nextIndex === 0 ? state.turnNumber + 1 : state.turnNumber;

  return {
    ...state,
    players,
    battlefields,
    activePlayerIndex: nextIndex,
    turnNumber,
    phase: "Awaken",
    // Highlander's ward only lasts "this turn" — cleared here same as every
    // other "this turn" field above (TurnManager.java:335's own reset).
    deathWardedUnitInstanceIds: [],
  };
}
