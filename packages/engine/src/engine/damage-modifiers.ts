import type { GameState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";

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
/** Kayn - Unleashed: "[Ganking] If I have moved TWICE this turn, I don't take
 *  damage." The pool's only unit that can stop taking damage at all, and the
 *  only reader of `movesThisTurn` as a threshold rather than a first-time flag. */
const KAYN_UNLEASHED = "OGN-189";
const KAYN_MOVES_REQUIRED = 2;

export function damageModifierDefIds(): string[] {
  return [ANNIE_FIERY, RAVENBORN_TOME, KAYN_UNLEASHED];
}

/**
 * Does this unit take no damage at all right now?
 *
 * Asked of the UNIT rather than registered as a listener, because it is a
 * continuous property of the unit's own state — how many times it has moved this
 * turn — and it has to be asked at two unrelated choke points: `dealDamage` for
 * spells and abilities, and combat's `applyDamage` for the Might exchange.
 *
 * **DIVERGENCE, and the rules do not settle it.** Combat damage is still
 * ASSIGNED to him (465.2's lethal-first order is unchanged) and then simply not
 * taken, so he absorbs a full lethal allocation and shields the units behind
 * him. The alternative reading — the pool flows past him to the next unit — is a
 * materially different card, and 465.2's assignment rules and damage prevention
 * are not reconciled in the PDF. This reading is the stronger one and the one
 * that needs no new assignment concept; recorded Unverified in
 * docs/rules-conformance.md.
 */
export function takesNoDamage(unit: UnitInstance): boolean {
  return unit.defId === KAYN_UNLEASHED && (unit.movesThisTurn ?? 0) >= KAYN_MOVES_REQUIRED;
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
