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

/** Ravenborn Tome: "Exhaust: The next spell you play this turn deals 1 Bonus
 *  Damage." Unlike Annie's standing aura this is a CHARGE — armed by the
 *  ability, read here, and cleared when a Spell finishes resolving, which is
 *  where "the next spell" ends. Listed for coverage.ts, which would otherwise
 *  report the gear inert: its ability arms a field this module reads. */
const RAVENBORN_TOME = "OGN-032";

/** The cards this module implements — see effective-might.ts's
 *  effectiveMightDefIds for why coverage.ts needs to be told. */
export function damageModifierDefIds(): string[] {
  return [ANNIE_FIERY, RAVENBORN_TOME];
}

export function modifiedDamageAmount(state: GameState, casterIndex: 0 | 1, baseAmount: number): number {
  const caster = state.players[casterIndex];
  const hasAnnieFiery =
    caster.baseUnits.some((u) => u.defId === ANNIE_FIERY) ||
    state.battlefields.some((bf) => (bf.units[caster.id] ?? []).some((u) => u.defId === ANNIE_FIERY));
  // Ravenborn Tome's armed charge STACKS with Annie's aura rather than replacing
  // it: two effects each saying "1 Bonus Damage" are two separate +1s.
  return baseAmount + (hasAnnieFiery ? 1 : 0) + caster.nextSpellBonusDamage;
}
