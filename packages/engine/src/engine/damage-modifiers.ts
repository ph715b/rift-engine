import type { GameState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import { battlefieldBonusDamageAt } from "./battlefield-continuous.js";

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

/**
 * Elder Dragon — "Any amount of your damage is enough to kill enemy units."
 *
 * **Rule 142.4.c names this card by hand**, which is why the reading needs no
 * interpretation: "Some effects may alter this amount. These effects will refer
 * to the amount of damage needed to kill a unit. Example: Elder Dragon's passive
 * ability reads 'Any amount of your damage is enough to kill enemy units.' This
 * alters the Lethal Damage value for enemy units that have damage marked by
 * you."
 *
 * So it changes LETHAL DAMAGE (142.4.a — "the amount of marked Damage that will
 * cause a unit to die"), not the damage dealt. That distinction is what keeps it
 * out of `modifiedDamageAmount` below: a Dragon does not make a 1 into a 5, it
 * makes 1 enough.
 */
const ELDER_DRAGON = "UNL-118";

export function damageModifierDefIds(): string[] {
  return [ANNIE_FIERY, RAVENBORN_TOME, KAYN_UNLEASHED, RABADONS_DEATHCROWN, ELDER_DRAGON, AMBESSA_THE_WOLF];
}

/**
 * Is ANY amount of damage lethal to this unit — i.e. does the player opposing
 * its owner control an Elder Dragon?
 *
 * `ownerIndex` is whose unit is being asked about, so the Dragon is looked for on
 * the OTHER side: "enemy units" is measured from the Dragon's seat.
 *
 * # Why this needs no per-marker damage attribution
 *
 * 142.4.c qualifies it as "enemy units that have damage marked BY YOU", and the
 * refusal that stood on this card read that as needing `UnitInstance.damage` —
 * one unattributed number — to remember who marked each point. Measured, both
 * sites that ask already know:
 *
 *  - `dealDamage` is handed the `casterIndex` dealing it, and kills at the moment
 *    of marking, so "marked by you" is the call itself.
 *  - Combat damage to one side comes from the other by construction, so
 *    `remainingMight(state, unit, ownerIndex, ...)` asking about the opposing
 *    seat IS the attribution.
 *
 * **The one case that does need memory is unreachable here and is recorded as a
 * divergence**: a Dragon arriving AFTER its controller had already marked damage
 * should make that unit die at the next cleanup (142.4.a). This engine kills at
 * damage time rather than sweeping in a cleanup — a pre-existing property of the
 * damage model, not of this card — so there is no sweep for it to happen in.
 */
/**
 * Is damage to this unit DOUBLED — UNL-013 Lotus Trap's "double all damage that
 * would be dealt to it this turn"?
 *
 * A replacement effect (369.1's "would"), which is why it is asked at the two
 * places damage is applied rather than registered as a listener. **465.2.c.5
 * works this card by name** and makes the two places behave differently: out of
 * combat the amount doubles as it is dealt, and IN combat "replacement effects
 * that would apply to the resulting damage are considered to apply to the
 * assignment instead", so the assignment halves and the doubling restores it.
 */
export function damageIsDoubledFor(state: GameState, unitInstanceId: string): boolean {
  return state.damageDoubledUnitInstanceIds.includes(unitInstanceId);
}

export function anyDamageIsLethalTo(state: GameState, ownerIndex: 0 | 1): boolean {
  const enemyIndex: 0 | 1 = ownerIndex === 0 ? 1 : 0;
  const enemy = state.players[enemyIndex];
  return (
    enemy.baseUnits.some((u) => u.defId === ELDER_DRAGON) ||
    state.battlefields.some((bf) => (bf.units[enemy.id] ?? []).some((u) => u.defId === ELDER_DRAGON))
  );
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
export function takesNoDamage(state: GameState, unit: UnitInstance): boolean {
  if (unit.defId === KAYN_UNLEASHED && (unit.movesThisTurn ?? 0) >= KAYN_MOVES_REQUIRED) return true;
  return ambessaIsProtected(state, unit);
}

/**
 * Ambessa, The Wolf — "[Empowered][>] I have +3 Might and can't be dealt damage
 * unless I'm in combat."
 *
 * The second unit in the pool that can stop taking damage at all, after Kayn -
 * Unleashed, and the reason `takesNoDamage` grew a `state` parameter: Kayn's
 * condition is a counter ON the unit, while hers is a question about the BOARD.
 *
 * **"In combat" is a STATE question, not the combat-designation event**, and Vex
 * - Cheerless's note settles it for the identical phrase: `isFightingAt` takes a
 * GameEvent and asks whether a listener was designated by THAT event, which is
 * unanswerable when damage is being dealt with no event in hand. The state that
 * survives the whole fight is the open Combat Showdown, so "I'm in combat" is "I
 * am standing at the battlefield the open Combat Showdown is at".
 *
 * `designatedInstanceIds` is the rejected sharper alternative, on the reason
 * Sudden Storm and Vex both record: it is written only by a Cleanup, so a unit
 * that walked in and started this very fight would read as not being in it.
 *
 * The protection is INVERTED relative to Kayn's — his condition grants immunity,
 * hers REMOVES it — so an Ambessa in the thick of a fight is the vulnerable one,
 * which is the card: 3 Energy and a Body pip buys a body that can only be
 * answered by fighting it.
 *
 * The +3 Might half is NOT here. `parseEmpoweredGrant` refuses her clause whole
 * because of this second sentence, so her Might rides `effective-might`'s
 * `ambessaMightBonus` beside the other Empowered auras.
 */
const AMBESSA_THE_WOLF = "VEN-084";

function ambessaIsProtected(state: GameState, unit: UnitInstance): boolean {
  if (unit.defId !== AMBESSA_THE_WOLF || unit.empowered !== true) return false;
  // 828.1.c: the dependent ability is active only while she holds the status, so
  // a Disempowered Ambessa takes damage like anything else.
  if (state.showdownKind === "Combat" && state.showdownBattlefieldId !== null) {
    const bf = state.battlefields.find((b) => b.id === state.showdownBattlefieldId);
    const inThisFight = bf !== undefined && Object.values(bf.units).some((side) => (side ?? []).some((u) => u.instanceId === unit.instanceId));
    if (inThisFight) return false; // "unless I'm in combat" — she is, so she can be damaged
  }
  return true;
}

/**
 * `targetBattlefieldId` is where the DAMAGED unit stands, or undefined in base —
 * Void Gate's "spells and abilities deal 1 Bonus Damage to units HERE" is the
 * first modifier in this module that is about the target rather than the caster.
 */
/** Rabadon's Deathcrown — art-only, see `modifiedDamageAmount`. */
const RABADONS_DEATHCROWN = "SFD-191";
const DEATHCROWN_BONUS_DAMAGE = 3;

export function modifiedDamageAmount(
  state: GameState,
  casterIndex: 0 | 1,
  baseAmount: number,
  targetBattlefieldId?: string,
): number {
  const caster = state.players[casterIndex];
  const hasAnnieFiery =
    caster.baseUnits.some((u) => u.defId === ANNIE_FIERY) ||
    state.battlefields.some((bf) => (bf.units[caster.id] ?? []).some((u) => u.defId === ANNIE_FIERY));
  // Ravenborn Tome's armed charge STACKS with Annie's aura rather than replacing
  // it: two effects each saying "1 Bonus Damage" are two separate +1s.
  // The battlefield's own bonus STACKS with both, for the reason those two
  // already stack with each other: two effects each saying "1 Bonus Damage" are
  // two separate +1s.
  // Rabadon's Deathcrown — "Your spells and abilities deal 3 Bonus Damage while
  // this is ATTACHED."
  //
  // **ART-ONLY ABILITY**, transcribed from the card image; see
  // docs/sfd-equipment-abilities.md. `text.plain` holds its `[Equip]` line and
  // nothing else, which is why it reported IMPLEMENTED while doing none of it.
  //
  // Gated on ATTACHMENT, not on the gear merely being in play: an unattached
  // Deathcrown sitting in `activeGear` grants nothing, which is what "while this
  // is attached" says and is the whole reason it is not simply an aura keyed to
  // the card being present.
  //
  // Stacks with the three sources above, for the reason they already stack with
  // each other: several effects each saying "N Bonus Damage" are several
  // separate additions.
  //
  // "YOUR spells and abilities" — the caster's, so it reads the CASTER's gear
  // rather than the target's owner's.
  const deathcrowns = caster.activeGear.filter(
    (g) => g.defId === RABADONS_DEATHCROWN && g.attachedToInstanceId != null,
  ).length;
  return (
    baseAmount +
    (hasAnnieFiery ? 1 : 0) +
    caster.nextSpellBonusDamage +
    deathcrowns * DEATHCROWN_BONUS_DAMAGE +
    battlefieldBonusDamageAt(state, targetBattlefieldId)
  );
}
