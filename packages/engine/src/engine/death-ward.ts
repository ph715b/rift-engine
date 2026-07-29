import type { GameState, PlayerState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";

/**
 * Highlander's death ward — "the next time it would die this turn, heal
 * it, exhaust it, and recall it instead." Consumed at every point a unit
 * would actually die (dealDamage's lethal branch in effect-helpers.ts,
 * combat.ts's Showdown resolution), instead of the usual trash step.
 */
export function isDeathWarded(state: GameState, unitInstanceId: string): boolean {
  return state.deathWardedUnitInstanceIds.includes(unitInstanceId);
}

/** Consumes a unit's ward: heals it, exhausts it, and sends it to its
 *  owner's base (a recall, not a move — no vacancy/contest checks) instead
 *  of trashing it. `unit` should already be removed from wherever it died
 *  (its battlefield's unit list) — this only adds it to baseUnits and
 *  clears the ward, it doesn't remove it from anywhere. */
export function reviveWithDeathWard(state: GameState, unit: UnitInstance, ownerIndex: 0 | 1): GameState {
  const revived: UnitInstance = { ...unit, damage: 0, exhausted: true };
  const players = [...state.players] as [PlayerState, PlayerState];
  players[ownerIndex] = { ...players[ownerIndex], baseUnits: [...players[ownerIndex].baseUnits, revived] };
  return {
    ...state,
    players,
    deathWardedUnitInstanceIds: state.deathWardedUnitInstanceIds.filter((id) => id !== unit.instanceId),
  };
}
