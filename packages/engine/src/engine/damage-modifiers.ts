import type { GameState } from "../model/game-state.js";

/**
 * Cross-cutting damage modifiers — checked at dealDamage's own choke point
 * (effect-helpers.ts), not registered per-card, since these apply to EVERY
 * instance of damage a player's spells/abilities deal, not to one card's
 * own resolution. Deliberately narrow (one confirmed card) rather than a
 * general modifier-stacking system — add the next one here the same way,
 * not preemptively.
 */
export function modifiedDamageAmount(state: GameState, casterIndex: 0 | 1, baseAmount: number): number {
  const caster = state.players[casterIndex];
  const hasAnnieFiery =
    caster.baseUnits.some((u) => u.defId === "OGS-001") ||
    state.battlefields.some((bf) => (bf.units[caster.id] ?? []).some((u) => u.defId === "OGS-001"));
  // Annie - Fiery: "Your spells and abilities deal 1 Bonus Damage."
  return hasAnnieFiery ? baseAmount + 1 : baseAmount;
}
