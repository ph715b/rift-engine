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

/**
 * Zhonya's Hourglass: "If a friendly unit would die, kill this instead. Heal
 * that unit, exhaust it, and recall it."
 *
 * A MANDATORY replacement sourced from a Gear sitting in play, which is why it
 * cannot live in any card registry: nothing dispatches on "a unit would die"
 * except `killUnit` itself, and by then the card is not a listener anywhere —
 * it is a condition on the board. Declared here, where the other death
 * replacement lives, and consumed by killUnit.
 */
export const ZHONYAS_HOURGLASS = "OGN-077";

/** For coverage.ts — the cards this module's rules implement. Highlander's ward
 *  is registered by the card that grants it; the Hourglass has no other home. */
export function deathReplacementDefIds(): string[] {
  return [ZHONYAS_HOURGLASS];
}

/**
 * "Heal it, exhaust it, and recall it" — the payoff every death replacement in
 * this pool spells out identically (Highlander, Sett - The Boss, Zhonya's
 * Hourglass all print the same three words).
 *
 * `unit` should already be removed from wherever it died; this only adds it to
 * baseUnits. A recall, not a move (454), so no vacancy or contest checks.
 *
 * Shared so the three cannot drift on what "recall" resets. It deliberately does
 * NOT clear the Buff: the unit never left play, and 709 only strips buffs on
 * leaving.
 */
export function reviveToBase(state: GameState, unit: UnitInstance, ownerIndex: 0 | 1): GameState {
  const revived: UnitInstance = { ...unit, damage: 0, exhausted: true };
  const players = [...state.players] as [PlayerState, PlayerState];
  players[ownerIndex] = { ...players[ownerIndex], baseUnits: [...players[ownerIndex].baseUnits, revived] };
  return { ...state, players };
}

/** Consumes a unit's ward: revives it as above, and clears the ward so the next
 *  death is a real one ("the NEXT time it would die this turn"). */
export function reviveWithDeathWard(state: GameState, unit: UnitInstance, ownerIndex: 0 | 1): GameState {
  return {
    ...reviveToBase(state, unit, ownerIndex),
    deathWardedUnitInstanceIds: state.deathWardedUnitInstanceIds.filter((id) => id !== unit.instanceId),
  };
}
