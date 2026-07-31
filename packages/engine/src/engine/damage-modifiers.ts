import type { GameState } from "../model/game-state.js";

/**
 * Cross-cutting damage modifiers — checked at dealDamage's own choke point
 * (effect-helpers.ts), not registered per-card, since these apply to EVERY
 * instance of damage a player's spells/abilities deal, not to one card's
 * own resolution. Deliberately narrow (one confirmed card) rather than a
 * general modifier-stacking system — add the next one here the same way,
 * not preemptively.
 */
/** Annie - Fiery: "Your spells and abilities deal 1 Bonus Damage." */
const ANNIE_FIERY = "OGS-001";

/** The cards this module implements — see effective-might.ts's
 *  effectiveMightDefIds for why coverage.ts needs to be told. */
export function damageModifierDefIds(): string[] {
  return [ANNIE_FIERY];
}

export function modifiedDamageAmount(state: GameState, casterIndex: 0 | 1, baseAmount: number): number {
  const caster = state.players[casterIndex];
  const hasAnnieFiery =
    caster.baseUnits.some((u) => u.defId === ANNIE_FIERY) ||
    state.battlefields.some((bf) => (bf.units[caster.id] ?? []).some((u) => u.defId === ANNIE_FIERY));
  return hasAnnieFiery ? baseAmount + 1 : baseAmount;
}
