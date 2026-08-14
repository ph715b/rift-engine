import type { GameState, PendingDeath, PlayerState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import type { Domain } from "../model/domain.js";
import type { Keyword } from "../model/keyword.js";
import { effectiveMight } from "./effective-might.js";
import { anyDamageIsLethalTo, modifiedDamageAmount, takesNoDamage } from "./damage-modifiers.js";
import { matchesPowerDomain } from "./rune-payment.js";
import {
  ZHONYAS_HOURGLASS,
  freeDeathReplacement,
  isDeathWarded,
  offerPaidDeathWard,
  reviveToBase,
  reviveWithDeathWard,
} from "./death-ward.js";
import { dispatchEvent, holdEventTrigger, holdSelfTrigger, holdUnitDied, killGear } from "./triggers.js";
import { holdBattlefieldTrigger } from "./battlefield-abilities.js";
import type { UnitZone } from "./target-lookup.js";
// legend-abilities imports drawCards from here, so this is a cycle — the same
// safe shape as the triggers.ts one above: the binding is only read inside
// stunUnits, long after both modules have initialised.
import { offerDeathReplacement } from "./legend-abilities.js";
import { parkDecision } from "./decisions.js";
import { findUnitAnywhere, findUnitOnBattlefield } from "./target-lookup.js";
// granted-keywords reaches back here through equipment.ts, so this is a cycle —
// the same safe shape as the triggers.ts and legend-abilities.ts ones above: the
// binding is only read inside withMightTransitions, long after both modules have
// initialised.
import { isMighty } from "./granted-keywords.js";
import { mergeGrantedKeyword } from "./keyword-stacking.js";
import { applyContested } from "./cleanup.js";
import { mayReadyPermanent, unitMayBeReadied } from "./board-restrictions.js";
import { unitMayMoveToBase } from "./battlefield-continuous.js";
import { detachAllFrom } from "./equipment.js";
import { mayGainPoints } from "./board-restrictions.js";

function updatePlayer(state: GameState, index: 0 | 1, update: (p: PlayerState) => PlayerState): GameState {
  const players = [...state.players] as [PlayerState, PlayerState];
  players[index] = update(players[index]);
  return { ...state, players };
}

/**
 * Applies `change` to one unit wherever it is in play — base or battlefield.
 * The single place base-vs-battlefield branching lives: five helpers below
 * (damage, buff, ready, destroy, return-to-hand) all act on "a unit," and
 * Riftbound's text only sometimes restricts that to a battlefield, so each of
 * them would otherwise carry its own copy of this fork. No-ops if the unit
 * isn't in play at all, same convention as every other "target vanished" path.
 */
function updateUnitAnywhere(state: GameState, targetInstanceId: string, change: (unit: UnitInstance) => UnitInstance): GameState {
  const location = findUnitAnywhere(state, targetInstanceId);
  if (!location) return state;
  const { ownerId, ownerIndex, zone } = location;
  const replace = (u: UnitInstance) => (u.instanceId === targetInstanceId ? change(u) : u);

  if (zone === "base") {
    return updatePlayer(state, ownerIndex, (p) => ({ ...p, baseUnits: p.baseUnits.map(replace) }));
  }
  const bf = state.battlefields[zone.battlefieldIndex]!;
  const battlefields = [...state.battlefields];
  battlefields[zone.battlefieldIndex] = { ...bf, units: { ...bf.units, [ownerId]: bf.units[ownerId]!.map(replace) } };
  return { ...state, battlefields };
}

/** Removes a unit from play (base or battlefield) WITHOUT deciding where it
 *  goes next — callers add it to trash/hand/base themselves, since that
 *  differs per effect (a kill trashes, Gust returns to hand, a death ward
 *  recalls). Counterpart to updateUnitAnywhere above.
 *
 *  Exported since Portal Rescue: a BLINK takes a unit off the board and puts a
 *  fresh copy back through the play path, which is neither a kill, a bounce nor
 *  a relocation and so fits none of the helpers built on this one. */
export function removeUnitAnywhere(state: GameState, targetInstanceId: string): GameState {
  const location = findUnitAnywhere(state, targetInstanceId);
  if (!location) return state;
  const { ownerId, ownerIndex, zone } = location;

  if (zone === "base") {
    return updatePlayer(state, ownerIndex, (p) => ({
      ...p,
      baseUnits: p.baseUnits.filter((u) => u.instanceId !== targetInstanceId),
    }));
  }
  const bf = state.battlefields[zone.battlefieldIndex]!;
  const battlefields = [...state.battlefields];
  battlefields[zone.battlefieldIndex] = {
    ...bf,
    units: { ...bf.units, [ownerId]: bf.units[ownerId]!.filter((u) => u.instanceId !== targetInstanceId) },
  };
  return { ...state, battlefields };
}

/**
 * The single place a unit dies.
 *
 * There were three: dealDamage's lethal branch, destroyUnit, and combat.ts's
 * processDefeated, each re-checking the death ward independently. Deathknell is
 * why that had to become one — rule 808 fires on ANY death, so three sites means
 * three chances to forget, and a forgotten one is invisible (the unit still dies,
 * its ability just never happens).
 *
 * `unit` must ALREADY be removed from wherever it was; `death` carries the
 * location and attributes it had at that moment, which rule 808.1.d.3 requires
 * be captured before the card reaches the trash.
 *
 * Order, and why:
 *  1. Death ward first. A warded death is *replaced*, not a death — so the
 *     Deathknell must not fire, which rule 808.1.d.1 states outright. Returning
 *     early here is that rule, not an optimisation.
 *  2. The Buff comes off (rule 705, "if a Unit leaves play, remove all Buffs
 *     from it") before the card lands in the trash, so a returned-from-trash copy
 *     can't smuggle a buff back into play.
 *  3. Trash, then triggers — the trigger has to see a board where the unit is
 *     already gone, or "all units at my battlefield" would include the corpse.
 */
export function killUnit(
  state: GameState,
  unit: UnitInstance,
  ownerIndex: 0 | 1,
  battlefieldId?: string,
  /** Who did it, when anyone did — see DeathContext.killerIndex. */
  killerIndex?: 0 | 1,
  /** Only `combat.processDefeated` passes this — see DeathContext.diedInCombat. */
  diedInCombat?: true,
): GameState {
  // A unit leaving play DETACHES its Equipment rather than destroying it (SFD).
  // Two cards presuppose exactly that — The Zero Drive's "Use only if
  // unattached" and Spinning Axe's "if this is unattached, kill it" — so a gear
  // outliving its wearer is the printed behaviour, not a convenience.
  //
  // Done FIRST, before any death ward or replacement can send the unit
  // somewhere else, so no path out of this function can leave a gear pointing
  // at a unit that is no longer where it was. A dangling attachment reads in
  // play as a Might bonus from an Equipment attached to nothing.
  //
  // Read BEFORE the detach and carried on the death, because after this line
  // nothing can answer "what was it wearing" — see PendingDeath.wornEquipment.
  // Both sides' gear, matching `detachAllFrom`'s own walk: nothing says an
  // Equipment and its wearer share a controller.
  const wornEquipment = state.players.flatMap((p) => p.activeGear.filter((g) => g.attachedToInstanceId === unit.instanceId));
  state = detachAllFrom(state, unit.instanceId);
  if (isDeathWarded(state, unit.instanceId)) {
    return reviveWithDeathWard(state, unit, ownerIndex);
  }

  // UNL-007 Smite — "if it would die this turn, banish it instead."
  //
  // **Below the ward deliberately, and 372 is why rather than a simplification.**
  // "If more than one Replacement Effect applies to the same event being
  // executed, then the controller of the object being acted on determines the
  // order" — and the object here is the dying unit, whose controller would
  // always choose the ward that saves it over a banish that does not. So
  // ward-first IS the controller's choice, not a coin flip this file resolved.
  //
  // **A banish is NOT a death** (808.1.d.1, the same rule the offers below cite),
  // so this returns before `completeDeath` and nothing downstream of it happens:
  // no `[Deathknell]`, no death-watch, no `unitsLostThisTurn`, and the card goes
  // to `banished` rather than to the trash. A version that trashed it and then
  // moved it would fire all of that on the way past.
  //
  // The Equipment detach at the top of this function has already run, which is
  // correct for a banish as much as for a death: the wearer has left the board
  // either way.
  if (state.banishOnDeathUnitInstanceIds.includes(unit.instanceId)) {
    return updatePlayer(state, ownerIndex, (p) => ({
      ...p,
      banished: fileIntoNonBoardZone(p.banished, unit),
    }));
  }

  // Zhonya's Hourglass: "If a friendly unit would die, kill this instead. Heal
  // that unit, exhaust it, and recall it."
  //
  // MANDATORY — no "you may" anywhere in the text — so unlike Sett's it asks
  // nothing and simply happens. That is also why it is checked here rather than
  // through offerDeathReplacement, which exists for the optional kind.
  //
  // **Simplification, named:** with BOTH an Hourglass and a ready Sett, the
  // rules would let the controller pick which replacement applies. The Hourglass
  // wins here because it is not a choice at all, so there is no question to
  // fold the other into. Recorded in docs/rules-conformance.md.
  // Guardian Angel's and Soraka - Wanderer's free saves, asked beside the
  // Hourglass and for the same reason: all three are MANDATORY, so none of them
  // is a question and none can be folded into `offerDeathReplacement` below.
  // Their order relative to each other is stated inside that one function.
  const freeSave = freeDeathReplacement(state, unit, ownerIndex, battlefieldId, wornEquipment);
  if (freeSave) return freeSave;

  const hourglass = state.players[ownerIndex].activeGear.find((g) => g.defId === ZHONYAS_HOURGLASS);
  if (hourglass) {
    // killGear, not a quiet removal: the Hourglass is KILLED, so it goes to the
    // trash through the funnel that fires a gear's own killed-trigger.
    return reviveToBase(killGear(state, hourglass, ownerIndex), unit, ownerIndex);
  }

  const death: PendingDeath = {
    unit,
    ownerIndex,
    ...(battlefieldId !== undefined ? { battlefieldId } : {}),
    ...(killerIndex !== undefined ? { killerIndex } : {}),
    ...(diedInCombat === true ? { diedInCombat } : {}),
    ...(wornEquipment.length > 0 ? { wornEquipment } : {}),
  };

  // A replacement that has to be OFFERED, not one armed in advance. Asked before
  // the trash step for the same reason the ward is checked before it: 808.1.d.1
  // makes a replaced death not a death, so the card must not reach the trash and
  // the Deathknell must not fire while the answer is outstanding.
  // Unlicensed Armory's armed ward, asked BEFORE Sett's: it is the one the
  // controller paid a card and a discard to set up in advance, and offering the
  // legend's free-standing save first would let the cheaper answer consume a
  // death the armed one was bought for. Both are optional, so unlike the
  // Hourglass above neither can be preferred on "it isn't a choice" grounds —
  // recorded in docs/rules-conformance.md as a simplification of the rules'
  // let-the-controller-order-them.
  const wardOffer = offerPaidDeathWard(state, death);
  if (wardOffer) return wardOffer;

  const offer = offerDeathReplacement(state, death);
  if (offer) return offer;

  return completeDeath(state, death);
}

/**
 * The ordinary end of a death — trash, then triggers.
 *
 * Split out of killUnit so a DECLINED replacement offer can resume exactly here,
 * rather than re-entering killUnit and being offered the same replacement again
 * forever.
 */
/**
 * Files a permanent that has just LEFT THE BOARD into a non-board zone —
 * dropping it entirely if it is a token.
 *
 * **Rule 186: "Tokens are Created on the board or the Chain and CANNOT EXIST
 * ELSEWHERE." Rule 186.1: "If a token is put into any Non-Board Zone besides the
 * chain, it CEASES TO EXIST immediately after moving to its new zone."**
 *
 * (These were cited as 714/715 until 2026-08-10, with the sentences quoted
 * correctly — 714/715 are Bonus Damage. The prose being right is exactly why it
 * survived: nothing reads wrong until you look the number up.)
 *
 * So a killed token does not sit in a trash, a bounced token does not sit in a
 * hand, and a recycled token does not go to the bottom of a deck. Every one of
 * those happened before this existed: `isToken` was carried on the instance and
 * read by exactly two cards, while every zone transition treated a token as a
 * card. A Sand Soldier bounced by Charm became a permanent 0-cost card in hand.
 *
 * "IMMEDIATELY AFTER moving to its new zone" is why this drops the token from
 * the ZONE rather than short-circuiting the move: the token really does arrive,
 * so everything that watches the arrival still fires — a token's [Deathknell]
 * triggers, `unitsLostThisTurn` counts it, and a death-watch sees a unit die. It
 * is only the resting place that never holds it.
 *
 * One helper rather than an `isToken` check at each site, because there are six
 * and the next zone transition added would be the seventh to remember.
 */
export function fileIntoNonBoardZone<T extends { isToken?: boolean }>(zone: readonly T[], arriving: T): T[] {
  return arriving.isToken === true ? [...zone] : [...zone, arriving];
}

export function completeDeath(state: GameState, death: PendingDeath): GameState {
  const { unit, ownerIndex } = death;
  // "When you kill a unit WITH A SPELL" — the one event about HOW a death
  // happened. Held before the trash step below for the same reason every other
  // trigger here is held after it is decided: the fact is about the kill, and the
  // response window belongs to the chain.
  const bySpell = state.spellResolvingForIndex !== null && death.killerIndex === state.spellResolvingForIndex;
  const trashed: UnitInstance = unit.buffed ? { ...unit, buffed: false } : unit;
  // The per-turn tally is bumped HERE rather than in killUnit, so a death that
  // was replaced (Sett) or warded (Highlander) does not count — neither of those
  // is a unit dying, and Spoils of War prices itself off units that actually did.
  const inTrash = updatePlayer(state, ownerIndex, (p) => ({
    ...p,
    trash: fileIntoNonBoardZone(p.trash, trashed),
    unitsLostThisTurn: p.unitsLostThisTurn + 1,
    // Shadow Watcher reads deaths in the OWNER's own Beginning Phase, so both
    // halves are checked: the phase, and that the dying unit's controller is the
    // active player. A unit of yours dying in the opponent's Beginning Phase is
    // not what the card describes.
    unitsLostInBeginningPhaseThisTurn:
      state.phase === "Beginning" && state.activePlayerIndex === ownerIndex
        ? p.unitsLostInBeginningPhaseThisTurn + 1
        : p.unitsLostInBeginningPhaseThisTurn,
  }));
  // HELD (383): the [Deathknell] and every death-watch listener are placed
  // together at the moment of the death, and resolve a chain-pop later.
  const withDeaths = holdUnitDied(inTrash, death);
  // HELD, like every other converted event, and fired AFTER the death funnel so a
  // listener sees a board the unit has already left.
  return bySpell && death.killerIndex !== undefined
    ? holdEventTrigger(withDeaths, { kind: "unitKilledBySpell", killerIndex: death.killerIndex, unitInstanceId: unit.instanceId })
    : withDeaths;
}

/**
 * Deals direct (non-combat) damage to a unit at a battlefield and removes it
 * to its owner's trash if lethal. `casterIndex` feeds damage-modifiers.ts's
 * modifiedDamageAmount (Annie - Fiery's +1-to-all-damage) — the single
 * choke point every damage-dealing card/trigger routes through, so no call
 * site has to remember to apply it itself. Lethal threshold routes through
 * effectiveMight with isCombat:false, so continuous auras (Garen - Commander,
 * Master Yi - Meditative) still apply, but [Shield]/[Assault] do NOT —
 * unlike combat.ts's remainingMight, which applies [Shield] because that
 * keyword's real text is "+X Might while DEFENDING" (a Showdown-only
 * bonus). Direct spell damage isn't combat, so Shield doesn't apply here;
 * a Shielded unit dies to lethal direct damage the same as an unshielded one.
 */
export function dealDamage(state: GameState, casterIndex: 0 | 1, targetInstanceId: string, amount: number): GameState {
  const location = findUnitAnywhere(state, targetInstanceId);
  if (!location) return state;
  const { ownerIndex, zone, unit } = location;
  // Unyielding Spirit — "prevent ALL spell and ability damage this turn." Every
  // caller of this function is a spell or an ability; combat damage never comes
  // through here (combat.ts does its own Might arithmetic), which is what makes
  // the card's own distinction hold without a flag saying which kind this is.
  //
  // Prevention is measured against the DAMAGED unit's controller, not the
  // caster: "prevent all damage this turn" protects the player who cast it.
  if (state.players[ownerIndex].preventsSpellDamageThisTurn) return state;
  // Kayn - Unleashed after his second move. Checked before the amount is
  // modified rather than after: a prevented 0 is still prevented, and Annie's
  // bonus damage has nothing to add to.
  if (takesNoDamage(unit)) return state;
  // Counter Strike — "the NEXT time that unit would be dealt damage this turn,
  // prevent it."
  //
  // Checked beside the two preventions above and SPENT here, which is the whole
  // difference from them: Unyielding Spirit is per-player and unlimited, this is
  // one instance on one unit. Removing exactly ONE id rather than filtering them
  // all out is what lets two Counter Strikes on one unit prevent two instances —
  // each is its own "next time".
  //
  // Spent even when the amount would have been 0, for the reason `takesNoDamage`
  // sits before the modifiers: this is a "would be dealt damage" replacement, and
  // the instance happened whatever its size.
  const preventionIndex = state.damagePreventedOnceInstanceIds.indexOf(targetInstanceId);
  if (preventionIndex !== -1) {
    return {
      ...state,
      damagePreventedOnceInstanceIds: state.damagePreventedOnceInstanceIds.filter((_, i) => i !== preventionIndex),
    };
  }

  // The DAMAGED unit's battlefield, for Void Gate — the first damage modifier
  // that is about where the target stands rather than about the caster.
  const targetBattlefieldId = zone === "base" ? undefined : state.battlefields[zone.battlefieldIndex]!.id;
  const modifiedAmount = modifiedDamageAmount(state, casterIndex, amount, targetBattlefieldId);

  const damagedUnit: UnitInstance = { ...unit, damage: unit.damage + modifiedAmount };
  // A base unit has no battlefield id — continuous auras keyed on location
  // (Garen - Commander) resolve it as "base" from the omitted field.
  const mightCtx = zone === "base" ? { isCombat: false } : { isCombat: false, battlefieldId: state.battlefields[zone.battlefieldIndex]!.id };
  // Imperial Decree ("when ANY unit takes damage this turn, kill it") and Noxian
  // Guillotine ("kill it the next time it takes damage this turn") are the same
  // shape — a delayed kill that fires on the NEXT damage rather than on lethal
  // arithmetic — so both are asked here, where damage is actually dealt.
  //
  // Asked AFTER the amount is modified and BEFORE the lethal test, which is the
  // only order that works: a unit that dies to the damage anyway must die by the
  // ordinary path (so the killer is attributed and the Deathknell reads the right
  // damage), and one that survives must still be killed.
  const sentenced =
    state.killDamagedUnitsThisTurn || state.markedForDeathOnDamageInstanceIds.includes(targetInstanceId);
  // Elder Dragon — "any amount of your damage is enough to kill enemy units"
  // (142.4.c, which names the card). A LETHAL-DAMAGE override, so it sits in the
  // lethal test rather than in `modifiedDamageAmount` above: the Dragon does not
  // turn a 1 into a 5, it makes 1 enough.
  //
  // Both halves are checked. `casterIndex !== ownerIndex` is "ENEMY units",
  // measured from the Dragon's seat — his controller's own units are unaffected,
  // which also stops a Dragon making his side's damage lethal to itself. And
  // `modifiedAmount > 0` is "any AMOUNT": a prevented or zeroed hit marks
  // nothing, and 142.4.b's own floor is "a non-zero amount".
  const dragonKills =
    modifiedAmount > 0 && casterIndex !== ownerIndex && anyDamageIsLethalTo(state, ownerIndex);
  const isLethal =
    sentenced || dragonKills || effectiveMight(state, unit, ownerIndex, mightCtx) - damagedUnit.damage <= 0;

  if (isLethal) {
    const stateAfterRemoval = removeUnitAnywhere(state, targetInstanceId);
    // The damaged copy, not `unit` — a Deathknell reading "my" attributes
    // (rule 808.1.d.3) must see the state the unit died in.
    return killUnit(
      stateAfterRemoval,
      damagedUnit,
      ownerIndex,
      zone === "base" ? undefined : state.battlefields[zone.battlefieldIndex]!.id,
      // Damage that kills is a kill BY whoever dealt it — the one place a killer
      // was already known and simply had nowhere to go.
      casterIndex,
    );
  }

  return updateUnitAnywhere(state, targetInstanceId, () => damagedUnit);
}

/** Unconditionally removes a unit at a battlefield to its owner's trash —
 *  no damage/lethal math at all, unlike dealDamage — but still a "death,"
 *  so still honors Highlander's ward the same way dealDamage does.
 *
 *  `killerIndex` is optional rather than required because this funnel serves
 *  both a Kill Instruction with someone behind it (Blast of Power, Hidden Blade)
 *  and a death with nobody (a `[Temporary]` unit expiring at end of turn). */
export function destroyUnit(state: GameState, targetInstanceId: string, killerIndex?: 0 | 1): GameState {
  const location = findUnitAnywhere(state, targetInstanceId);
  if (!location) return state;
  const { unit, ownerIndex, zone } = location;

  const stateAfterRemoval = removeUnitAnywhere(state, targetInstanceId);
  return killUnit(
    stateAfterRemoval,
    unit,
    ownerIndex,
    zone === "base" ? undefined : state.battlefields[zone.battlefieldIndex]!.id,
    killerIndex,
  );
}

/**
 * Removes all marked damage from every unit in play — both players, base and
 * every battlefield.
 *
 * The rules heal at TWO moments and both are global: combat cleanup
 * (rule 466.1.a.1, "immediately after the combat damage has been dealt") and
 * the end of a player's turn. Crucially, combat cleanup "clears all marked
 * damage from every unit on the board, including units that were not involved
 * in the combat" (RiftJudge FAQ 7750/8993) — so a unit softened by a Spell at
 * some OTHER battlefield, or sitting in base, heals when an unrelated fight
 * finishes. Healing does NOT happen after a non-combat (uncontested) showdown
 * (FAQ 9016), which is why combat.ts only reaches this after a real exchange.
 *
 * Shared by turn-manager.ts's runEnd and combat.ts's cleanup so the two can't
 * drift on what "heal" covers.
 */
export function healAllUnits(state: GameState): GameState {
  const clear = (u: UnitInstance): UnitInstance => (u.damage === 0 ? u : { ...u, damage: 0 });

  const players = state.players.map((p) => ({ ...p, baseUnits: p.baseUnits.map(clear) })) as [PlayerState, PlayerState];
  const battlefields = state.battlefields.map((bf) => {
    const units: typeof bf.units = {};
    for (const [playerId, list] of Object.entries(bf.units)) units[playerId] = list.map(clear);
    return { ...bf, units };
  });
  return { ...state, players, battlefields };
}

/**
 * "Give friendly units +N Might this turn" (Grand Strategem, Decisive Strike) —
 * every unit the caster controls, base and every battlefield.
 *
 * A this-turn modifier, expiring for free via turn-manager.ts's runEnd, which
 * resets `.mightThisTurn` to 0 every End of Turn for every unit, both players,
 * unconditionally. This is NOT buffing: see addBuff below for the game object
 * that persists.
 */
export function giveMightThisTurnToAllFriendlies(state: GameState, casterIndex: 0 | 1, amount: number): GameState {
  const caster = state.players[casterIndex];
  const grant = (u: UnitInstance): UnitInstance => ({ ...u, mightThisTurn: u.mightThisTurn + amount });

  const players = [...state.players] as [PlayerState, PlayerState];
  players[casterIndex] = { ...caster, baseUnits: caster.baseUnits.map(grant) };

  const battlefields = state.battlefields.map((bf) => {
    const units = bf.units[caster.id];
    if (!units) return bf;
    return { ...bf, units: { ...bf.units, [caster.id]: units.map(grant) } };
  });

  // Fiora - Grand Duelist's "when ONE OF YOUR UNITS becomes [Mighty]" — singular,
  // so a mass pump that pushes three units over the line is three separate
  // triggers, one per unit, not one for the instruction. Each is its own Pending
  // Item an opponent may answer.
  return withMightTransitions(state, { ...state, players, battlefields }, [
    ...caster.baseUnits.map((u) => u.instanceId),
    ...state.battlefields.flatMap((bf) => (bf.units[caster.id] ?? []).map((u) => u.instanceId)),
  ]);
}

/**
 * "Give a unit +N Might this turn" — negative `amount` is a debuff (Smoke
 * Screen, Orb of Regret). Works on a unit anywhere in play: En Garde and Stupefy
 * say "a unit," not "a unit at a battlefield". No-ops if the target isn't in
 * play.
 *
 * `floor` implements the "to a minimum of 1 Might" clause several debuffs carry.
 * It is applied against the unit's printed Might plus its accumulated this-turn
 * modifier, so a second -4 on an already-floored unit takes nothing further off
 * rather than digging a hole that a later buff would have to climb out of. Buffs
 * and continuous auras are deliberately NOT counted: they can appear and vanish
 * after this resolves, and the floor is fixed at resolution time.
 */
/**
 * Fires `unitBecameMighty` for every named unit that was NOT `[Mighty]` in
 * `before` and IS in `after` (rule 708: 5+ Might).
 *
 * A before/after COMPARISON rather than a hook on a write, because Might has no
 * stored total — `effectiveMight` derives it from printed Might, buffs,
 * this-turn modifiers, continuous auras and Equipment every time it is asked. So
 * "became Mighty" has no single moment; the nearest thing is the boundary of an
 * operation that changed one of those inputs.
 *
 * Wrapped around the RAISE helpers rather than called by each card, so a new
 * pump gets the event by construction instead of by remembering. `attachEquipment`
 * is bracketed too — the "+N Might" badge is part of current Might, so an
 * [Equip] can be the crossing.
 *
 * **Recorded partial (docs/rules-conformance.md): an aura arriving is not seen.**
 * A unit that crosses 5 because a Garen - Commander walked in never changed, and
 * nothing about the unit is written — so no comparison here brackets it. Closing
 * that needs the layer-snapshotting this engine does not have. ENTERING COMBAT is
 * the same shape and joined that list with the higher-of-two ruling (2026-08-08):
 * a `[Shield]` defender becomes Mighty when the Showdown opens, and the Showdown
 * writes nothing about the unit.
 */
export function withMightTransitions(
  before: GameState,
  after: GameState,
  unitInstanceIds: readonly string[],
): GameState {
  let next = after;
  for (const id of unitInstanceIds) {
    const was = findUnitAnywhere(before, id);
    const now = findUnitAnywhere(next, id);
    if (!was || !now) continue;
    // Asked through `granted-keywords.isMighty` rather than spelled out here, and
    // that consolidation is the point: this file used to run its own
    // `effectiveMight(...) >= MIGHTY_THRESHOLD`, so the "becomes Mighty" event and
    // every "while I'm Mighty" conditional could answer differently about the same
    // unit — which they did, twice. `isMighty` carries the location lookup (709's
    // positional auras) and the combat higher-of-two ruling, and both belong to
    // BOTH questions.
    //
    // Read per STATE rather than once, because `before` and `after` are different
    // boards and an effect that moved the unit — or opened a combat over it —
    // would otherwise be scored against the wrong context.
    if (isMighty(before, was.unit, was.ownerIndex) || !isMighty(next, now.unit, now.ownerIndex)) continue;
    next = holdEventTrigger(next, { kind: "unitBecameMighty", ownerIndex: now.ownerIndex, unitInstanceId: id });
  }
  return next;
}

export function giveMightThisTurn(
  state: GameState,
  targetInstanceId: string,
  amount: number,
  floor?: number,
): GameState {
  const raised = updateUnitAnywhere(state, targetInstanceId, (u) => {
    if (floor === undefined) return { ...u, mightThisTurn: u.mightThisTurn + amount };
    const lowest = floor - u.might;
    return { ...u, mightThisTurn: Math.max(lowest, u.mightThisTurn + amount) };
  });
  // Fiora - Grand Duelist. A DEBUFF passes through here too (a negative
  // `amount`), and `withMightTransitions` only fires on a crossing UPWARD, so
  // nothing has to branch on the sign.
  return withMightTransitions(state, raised, [targetInstanceId]);
}

/**
 * Grants `[Temporary]` (rule 816) to a unit at a battlefield or to a gear —
 * Fading Memories' "give a unit at a battlefield **or a gear** [Temporary]".
 *
 * One helper over both because the card makes one choice across both kinds, and
 * the caller should not have to know which it got. Multiple instances are
 * redundant — **816.2, the keyword's own rule**, not the "817.1.a" this used to
 * cite; that is Vision's "It is present on Permanents" and no general redundancy
 * rule exists. So re-granting is a harmless no-op.
 *
 * No-ops when the id names nothing in play — the usual "target vanished"
 * convention.
 */
export function grantTemporary(state: GameState, permanentInstanceId: string): GameState {
  const asUnit = findUnitAnywhere(state, permanentInstanceId);
  if (asUnit) {
    return updateUnitAnywhere(state, permanentInstanceId, (u) => ({
      ...u,
      keywords: { ...u.keywords, Temporary: 1 },
    }));
  }

  const players = [...state.players] as [PlayerState, PlayerState];
  let touched = false;
  for (const index of [0, 1] as const) {
    const owner = players[index];
    if (!owner.activeGear.some((g) => g.instanceId === permanentInstanceId)) continue;
    players[index] = {
      ...owner,
      activeGear: owner.activeGear.map((g) =>
        g.instanceId === permanentInstanceId ? { ...g, keywords: { ...g.keywords, Temporary: 1 } } : g,
      ),
    };
    touched = true;
  }
  return touched ? { ...state, players } : state;
}

/** Does this unit carry a Buff? The read half of rule 702.3's one-buff-at-a-time
 *  rule, and what "While I'm buffed" / "Other buffed friendly units" ask. */
export function isBuffed(unit: UnitInstance): boolean {
  return unit.buffed;
}

/**
 * `[Legion]` — "Get the effect if you've played **another** card this turn."
 *
 * `countingSelf` is not a convenience, it is the whole correctness of this
 * predicate, and getting it wrong is invisible: the effect simply happens a turn
 * too eagerly. `execute-play-card` increments `cardsPlayedThisTurn` as part of
 * the same update that puts the card into play, BEFORE `dispatchOnPlayUnit`
 * runs — so by the time a Legion on-play trigger asks, the count already
 * includes the card asking.
 *
 *  - **Cost time** (`countingSelf: false`) — the card has not been played yet,
 *    so one other card is one card: `>= 1`.
 *  - **Trigger time** (`countingSelf: true`) — this card is already counted, so
 *    "another" needs `>= 2`.
 *
 * Darius - Hand of Noxus reads "if you've played **a** card this turn" rather
 * than "another", because a Legend ability is not a card being played and
 * increments nothing; his check is the cost-time one and lives with his ability.
 */
export function legionActive(state: GameState, playerIndex: 0 | 1, countingSelf: boolean): boolean {
  return state.players[playerIndex].cardsPlayedThisTurn >= (countingSelf ? 2 : 1);
}

/**
 * "Give enemy units -N Might this turn" (Thousand-Tailed Watcher) — every unit
 * the OPPONENT of `casterIndex` controls, base and every battlefield.
 *
 * The mirror of `giveMightThisTurnToAllFriendlies` above, and separate from it
 * rather than a parameterised version, because the two differ in more than the
 * sign: this one carries a `floor` (every enemy-side debuff in this pool states
 * "to a minimum of 1"), and routing through `giveMightThisTurn` per unit is what
 * applies that floor per unit rather than to the group.
 */
export function giveMightThisTurnToAllEnemies(
  state: GameState,
  casterIndex: 0 | 1,
  amount: number,
  floor?: number,
): GameState {
  const enemyIndex: 0 | 1 = casterIndex === 0 ? 1 : 0;
  const enemy = state.players[enemyIndex];
  const targets = [
    ...enemy.baseUnits.map((u) => u.instanceId),
    ...state.battlefields.flatMap((bf) => (bf.units[enemy.id] ?? []).map((u) => u.instanceId)),
  ];
  return targets.reduce((next, id) => giveMightThisTurn(next, id, amount, floor), state);
}

/**
 * Pays `count` Power of `domain` out of channeled runes, for the costs that are
 * NOT part of a PlayCardAction — Flame Chompers' "you may pay [Fury] to play me"
 * and Mistfall's "you may pay [Body] and exhaust this".
 *
 * Returns undefined when it cannot be paid, the same contract `spendBuff` and
 * `recycleFromTrash` use (416.3's "the action must be able to be completed for
 * the cost to be paid"), so the option is simply never offered rather than
 * handing over the payoff for free.
 *
 * Paying Power RECYCLES the rune — 416's "puts it on the bottom of the
 * corresponding deck", not an exhaust — and a rune that was still Ready when it
 * went had Energy-paying potential that recycling wastes, so it banks 1 floating
 * Energy. Both halves mirror executeFloatRune's Power mode exactly; they are the
 * same act, and two versions of it would drift.
 */
export function payPowerFromChanneled(
  state: GameState,
  playerIndex: 0 | 1,
  /** `null` is RAINBOW — any domain pays, rule 811's pip and Sett - The Boss's.
   *  Asked through `matchesPowerDomain`, which already means exactly that, so
   *  rainbow needed no new cost machinery here either. */
  domain: Domain | null,
  count: number,
): GameState | undefined {
  const actor = state.players[playerIndex];

  // **FLOATING POWER PAYS FIRST, and that is a fix rather than a preference.**
  //
  // Reported from playtesting against Draven - Vanquisher's "you may pay [Fury]":
  // *"I want to be able to pay manually as I may have Seals or Treasures I want
  // to use instead of recycling."* A Seal's whole text is "[Exhaust]: Add 1
  // <domain> Power", which lands in `floatingPower` — and this helper read only
  // the CHANNELED pool, so that Power was not merely hard to spend here, it was
  // unreachable. `rules-conformance.md` carries it as the "Ornn's rainbow Power
  // paying a gear ABILITY's cost" row: "the two cost pipelines simply do not
  // meet."
  //
  // Three things make floating-first correct rather than one of two defensible
  // orders, so no choice has to be offered:
  //
  //  - **A card's Power cost already spends floating first** (`powerAfterFloat`,
  //    via `computeEffectiveCost`). An ABILITY's ignoring it was an asymmetry
  //    between two paths for the same resource, not a rule.
  //  - **Floating Power expires** — `runEnd` clears it — while a rune recycled
  //    here goes to the bottom of the deck and comes back. Spending the
  //    perishable resource first is strictly better for the payer, every time.
  //  - It is the order this engine states everywhere else: fungible before
  //    restricted, floating before the pool that survives.
  //
  // Still NOT reached: `restrictedSpellPower` / `restrictedGearPower`. Those
  // carry a card-KIND gate ("Spells only", "gear or gear abilities") and this
  // helper is not told the kind, so Ornn's own row stays open — narrower now
  // than it was, and named.
  let owed = count;
  const floatingSpend = new Map<Domain, number>();
  // A `null` domain is RAINBOW, so any floating domain pays it; a named domain
  // takes only its own, which is what `matchesPowerDomain` means for the runes
  // below.
  for (const [held, available] of Object.entries(actor.floatingPower) as [Domain, number | undefined][]) {
    if (owed === 0) break;
    if (domain !== null && held !== domain) continue;
    const take = Math.min(available ?? 0, owed);
    if (take > 0) {
      floatingSpend.set(held, take);
      owed -= take;
    }
  }
  // Malzahar - Fanatic's rainbow, which is unrestricted by card kind and so is
  // safe to spend here where the two restricted pools above are not.
  const fromRainbow = Math.min(actor.floatingRainbowPower, owed);
  owed -= fromRainbow;

  const spend = actor.channeled.filter((r) => matchesPowerDomain(r, domain)).slice(0, owed);
  if (spend.length < owed) return undefined;

  const spentIds = new Set(spend.map((r) => r.id));
  const readyCredit = spend.filter((r) => r.state === "Ready").length;
  // Sivir - Battle Mistress. A Power payment RECYCLES its runes (416), which is
  // exactly what she reads. Fired here rather than at each caller, because this
  // helper is the shared cost path several of them go through.
  //
  // Speculative calls are harmless: `options` builders call this to ASK whether a
  // cost is payable and throw the result away, so the held trigger goes with it.
  return holdRunesRecycled(updatePlayer(state, playerIndex, (p) => ({
    ...p,
    channeled: p.channeled.filter((r) => !spentIds.has(r.id)),
    runeDeck: [...p.runeDeck, ...spend.map((r) => ({ ...r, state: "Ready" as const }))],
    floatingEnergy: p.floatingEnergy + readyCredit,
    // Sivir - Mercenary's "if you've spent at least [rainbow][rainbow] this
    // turn". Counted HERE because this is the single funnel every Power payment
    // in the engine goes through — a card cost, an ability cost, an [Equip], a
    // [Deflect] surcharge — so a per-site tally would miss whichever one nobody
    // remembered.
    //
    // PIPS, not rainbow pips: her text means two Power of any domains.
    //
    // **Speculative calls do NOT inflate it**, and that is load-bearing rather
    // than lucky: this helper is called all over the codebase purely to ASK
    // whether a cost is payable, with the resulting state thrown away. The tally
    // rides that discarded state exactly as the held `cardsRecycled` trigger
    // below already does.
    // The floating pools this payment drew on, spent before any rune was
    // touched. Subtracted rather than zeroed: a partial payment leaves the rest.
    floatingPower: Object.fromEntries(
      Object.entries(p.floatingPower).map(([held, n]) => [held, (n ?? 0) - (floatingSpend.get(held as Domain) ?? 0)]),
    ),
    floatingRainbowPower: p.floatingRainbowPower - fromRainbow,
    // PIPS, and the FULL cost — floating Power spent is Power spent, so this
    // counts `count` rather than only the runes recycled. Reading `spend.length`
    // here would quietly stop paying Sivir out the moment a Seal covered the
    // cost, which is the shape of bug this tally exists to prevent.
    powerSpentThisTurn: p.powerSpentThisTurn + count,
  })), playerIndex, spend.length);
}

/**
 * Buffs a unit — rule 702.2.a, "a player chooses a Unit and then places a buff
 * on it".
 *
 * Rule 702.3.a makes this idempotent rather than cumulative: "If a Buff is added, or
 * instructed to be added, on a Unit that already has a Buff, it is not placed
 * instead." That is exactly why several cards read "buff me. (If I don't have a
 * buff, I get a +1 Might buff.)" — the reminder text is describing the no-op.
 * Returns the state unchanged when the unit is already buffed or isn't in play.
 */
/** Units whose printed text overrides rule 702.3.a's one-buff cap. Lee Sin - Ascetic
 *  is the pool's only one, and naming him here keeps `addBuff`'s contract
 *  unchanged for every other caller. */
const STACKING_BUFF_DEF_IDS = new Set(["OGN-078"]); // Lee Sin - Ascetic

export function addBuff(state: GameState, targetInstanceId: string): GameState {
  const location = findUnitAnywhere(state, targetInstanceId);
  // "When you BUFF a friendly unit" (Mistfall) is about a buff actually being
  // placed. 702.3.a makes a second one on an already-buffed unit a no-op, and the
  // event has to agree — otherwise re-buffing a buffed unit would offer the
  // ready-me trigger over and over for nothing. Checked before the update, since
  // updateUnitAnywhere rebuilds the state either way.
  // 702.3.a makes a second buff on an already-buffed unit a no-op — EXCEPT for a unit
  // whose own text says otherwise. Lee Sin - Ascetic's "I can have any number of
  // buffs" is the only such card, so the exception is a named set rather than a
  // flag every caller has to pass.
  if (location?.unit.buffed && STACKING_BUFF_DEF_IDS.has(location.unit.defId)) {
    const stacked = withMightTransitions(
      state,
      updateUnitAnywhere(state, targetInstanceId, (u) => ({ ...u, extraBuffs: (u.extraBuffs ?? 0) + 1 })),
      [targetInstanceId],
    );
    return holdEventTrigger(stacked, { kind: "unitBuffed", ownerIndex: location.ownerIndex, unitInstanceId: targetInstanceId });
  }
  if (!location || location.unit.buffed) return updateUnitAnywhere(state, targetInstanceId, (u) => u);

  const placed = updateUnitAnywhere(state, targetInstanceId, (u) => ({ ...u, buffed: true }));
  // A Buff is worth +1 Might (703), so placing one can cross 5 — Fiora's
  // trigger has to see it, and the buff's own `unitBuffed` event below is a
  // different question.
  const buffed = withMightTransitions(state, placed, [targetInstanceId]);
  // HELD as a Chain Pending Item rather than resolved here — the first of the 14
  // dispatch sites to be converted (808.1.d.3: a trigger goes on the Chain so the
  // opponent may respond before it resolves). The buff itself is applied
  // immediately; only the "when you buff a friendly unit" TRIGGER waits.
  //
  // This site went first because it is the least entangled: one listener in the
  // whole pool (Mistfall), tail position so no caller reads state after it, it
  // already fires only when a buff was really placed (702.3.a, the guard above), and
  // Mistfall's resolution parks a question rather than moving the board — so the
  // observable change is WHEN the question is asked, not what the board looks like.
  return holdEventTrigger(buffed, {
    kind: "unitBuffed",
    ownerIndex: location.ownerIndex,
    unitInstanceId: targetInstanceId,
  });
}

/**
 * Moves a unit to a battlefield because an EFFECT said so — Charm's "Move an
 * enemy unit."
 *
 * Deliberately not `executeMoveUnit`, and the difference is a rule rather than
 * convenience. **414.3.a**: "a unit's Standard Move exhausts the unit **as a
 * cost**" — the exhaust belongs to the Standard Move action, not to the act of
 * moving, and **316.7.b** lists a move as possibly "the result of a Standard Move
 * Intrinsic Ability, a **Spell**, or other Game Effect". So a unit charmed across
 * the board arrives READY. Reusing the move executor would have exhausted it,
 * silently making Charm a removal-and-tap rather than a reposition.
 *
 * Contested still applies, and applies for the MOVED unit's controller —
 * **450**: "the Destination becomes Contested if it is an Uncontested Battlefield
 * not controlled by the controller of the Unit or Units that moved". Charming an
 * enemy onto neutral ground therefore contests it for THEM, which is the card's
 * real use and not something a caster-indexed call would have got right.
 *
 * On-move triggers deliberately do NOT fire: they read "when I move" on cards
 * whose controller chose to move them, and no card in this pool has one that
 * could be reached this way. Named here rather than left to be discovered.
 */
/** The battlefield id a unit was standing at, or "base". `unitMoved.from` names
 *  a base at one end already, so this is symmetric with it. */
function originIdOf(state: GameState, location: { zone: UnitZone }): string {
  return location.zone === "base" ? "base" : state.battlefields[location.zone.battlefieldIndex]!.id;
}

/**
 * The events an effect-driven Move owes — held in ONE place so the two force-move
 * helpers cannot come to different answers about what a move is.
 *
 * Held rather than dispatched (383), exactly as `execute-move-unit` holds them,
 * so they resolve on the chain this resolution produces rather than re-entering
 * mid-effect.
 *
 * `movesThisTurn` IS incremented, by the callers, before the unit is placed —
 * which is why this takes the already-incremented unit and simply reports its
 * count. It briefly was not, on the reasoning that re-finding the unit afterwards
 * would be awkward; incrementing at PLACEMENT instead makes it one line, because
 * the unit object is in hand at that moment.
 */
function holdMoveEvents(
  state: GameState,
  unit: UnitInstance,
  ownerIndex: 0 | 1,
  from: string,
  to: string,
  causedByIndex?: 0 | 1,
): GameState {
  // Nothing moved, nothing fired.
  //
  // **UNREACHABLE from both current callers, and labelled rather than left
  // looking tested**: `forceMoveToBattlefield` returns early when the unit is
  // already at the destination, and `forceMoveToBase` finds its subject with
  // `findUnitOnBattlefield`, so its `from` is always a battlefield and its `to`
  // is always "base". Deleting this line breaks no test — I checked by deleting
  // it — which is exactly why it says so here instead of implying otherwise.
  //
  // Kept because it guards the NEXT caller: a phantom move event would fire 17
  // cards for a relocation that did not happen.
  if (from === to) return state;
  const next = holdEventTrigger(state, {
    kind: "unitMoved",
    moverIndex: ownerIndex,
    unitInstanceId: unit.instanceId,
    from,
    to,
    movesThisTurn: unit.movesThisTurn,
    ...(causedByIndex !== undefined ? { causedByIndex } : {}),
  });
  // "When a unit moves FROM here" — Back-Alley Bar. Fires for the battlefield
  // left; a unit leaving BASE matches no battlefield and so fires nothing.
  return holdBattlefieldTrigger(next, "unitMovedFrom", from, ownerIndex, unit.instanceId);
}

/**
 * **446.1 and 449 make this a MOVE, and it now says so.**
 *
 * 449: "Spells, Abilities, or other effects may cause a Move to occur." 446.1:
 * any permanent changing position from one space on the Board to another is a
 * Move. Until 2026-08-09 this helper and `forceMoveToBase` rewrote the zones in
 * silence, so `unitMoved` had exactly TWO emitters — both player actions — and
 * every card-driven relocation fired nothing.
 *
 * Seventeen implemented cards watch a move. The asymmetry became glaring the day
 * a player walking a unit home started firing them while a spell moving that same
 * unit still did not.
 *
 * `causedByIndex` is optional and additive: absent means "the mover caused it",
 * which is what every existing listener already assumed. Passing it is what lets
 * "when YOU move an ENEMY unit" be written at all.
 */
export function forceMoveToBattlefield(
  state: GameState,
  targetInstanceId: string,
  destinationBattlefieldId: string,
  causedByIndex?: 0 | 1,
): GameState {
  const location = findUnitAnywhere(state, targetInstanceId);
  if (!location) return state;
  const { unit, ownerId, ownerIndex } = location;
  const destinationIndex = state.battlefields.findIndex((bf) => bf.id === destinationBattlefieldId);
  if (destinationIndex < 0) return state;
  // Already there: nothing moved, so nothing is contested by it either.
  if (location.zone !== "base" && state.battlefields[location.zone.battlefieldIndex]!.id === destinationBattlefieldId) {
    return state;
  }

  const removed = removeUnitAnywhere(state, targetInstanceId);
  const battlefields = [...removed.battlefields];
  const destination = battlefields[destinationIndex]!;
  // **Counted BEFORE it is placed.** `movesThisTurn` is a fact about the unit and
  // a card-driven move is a move (446.1/449), so the same increment the Move
  // action makes belongs here. Incrementing at placement rather than after is
  // what makes it one line: the unit object is in hand right now, and re-finding
  // it afterwards would mean searching every zone these helpers can leave it in.
  const arrived = { ...unit, movesThisTurn: unit.movesThisTurn + 1 };
  battlefields[destinationIndex] = {
    ...destination,
    units: { ...destination.units, [ownerId]: [...(destination.units[ownerId] ?? []), arrived] },
  };

  const moved = applyContested({ ...removed, battlefields }, destinationBattlefieldId, ownerIndex);
  return holdMoveEvents(moved, arrived, ownerIndex, originIdOf(state, location), destinationBattlefieldId, causedByIndex);
}

/**
 * Moves a unit to BASE because an effect said so — the other half of
 * `forceMoveToBattlefield`, and the reason a spell's "move a unit" can finally
 * reach every Location the rules allow.
 *
 * **355.4.a**: "A valid Location for a Move Effect is one other than the Unit's
 * current Location where they are allowed to be present", and **198.1/107.1.b**
 * make each Base a Location. The PDF then works this exact case BY NAME at
 * **359.3.e**: *"A player plays Ride the Wind choosing to move their unit at
 * Vilemaw's Lair to base. Base is a legal move destination for Ride the Wind…"*
 *
 * **Whose base needs no argument.** 107.1.c — "Permanents and Runes controlled by
 * a player reside in that player's Base" — so a unit can only ever go to its own
 * controller's, which is what `ownerIndex` already says.
 *
 * # It does NOT exhaust, and that is the same rule `forceMoveToBattlefield` cites
 *
 * **144.2** makes exhausting the cost of the STANDARD MOVE ACTION, and 414.3.a
 * puts Exhaust costs on activated abilities and discretionary actions. A spell's
 * move is neither, so a unit sent home by Charm arrives READY — exactly as one
 * sent across the board by Charm already did.
 *
 * This deliberately does not reuse `recallUnitToBase`, which force-exhausts. That
 * helper's own comment files the exhaust as an open question, and
 * `relocateToBaseUnchanged` (Reaver's Row's "move a friendly unit here to base")
 * already answers it the other way for a card that says MOVE. Rather than add a
 * third answer, this takes the one the rules give and leaves the existing three
 * cards alone — see docs/rules-conformance.md, where that is now a NAMED
 * follow-up rather than an open question.
 *
 * # The Lair still stops it, and the SPELL still resolves
 *
 * `mayMoveToBaseFrom` is the one door every way-home comes through, and 359.3.e's
 * example is precisely a blocked one: the move instruction "will be ignored
 * because Vilemaw's restriction makes the instruction impossible" — the
 * instruction, not the spell. Returning the state unchanged is 055's "do as much
 * as you can", which is what every other blocked move here already does.
 */
export function forceMoveToBase(state: GameState, targetInstanceId: string, causedByIndex?: 0 | 1): GameState {
  const location = findUnitOnBattlefield(state, targetInstanceId);
  // Not at a battlefield: either it is already in base — 355.4.a excludes the
  // Unit's current Location, so there is no move to make — or it is not on the
  // board at all.
  if (!location) return state;
  const { unit, ownerId, ownerIndex, battlefieldIndex } = location;
  const bf = state.battlefields[battlefieldIndex]!;
  if (!unitMayMoveToBase(state, unit, bf.id)) return state;

  const battlefields = [...state.battlefields];
  battlefields[battlefieldIndex] = {
    ...bf,
    units: { ...bf.units, [ownerId]: (bf.units[ownerId] ?? []).filter((u) => u.instanceId !== targetInstanceId) },
  };
  const players = [...state.players] as [PlayerState, PlayerState];
  // Counted here for the same reason as the battlefield half above.
  const arrived = { ...unit, movesThisTurn: unit.movesThisTurn + 1 };
  players[ownerIndex] = { ...players[ownerIndex], baseUnits: [...players[ownerIndex].baseUnits, arrived] };
  return holdMoveEvents({ ...state, battlefields, players }, arrived, ownerIndex, bf.id, "base", causedByIndex);
}

/**
 * Where a move-target spell is sending its unit — the ONE function all seven of
 * them call, so "move" means the same thing on every card that prints it.
 *
 * A dispatcher rather than each resolver branching, for the reason this codebase
 * keeps rediscovering: seven copies of a two-way branch is seven chances to get
 * the second way wrong, and the second way is the one nobody exercises.
 */
export function forceMoveToDestination(
  state: GameState,
  targetInstanceId: string,
  /** The resolve event, read for whichever of the two destination fields it
   *  carries. Taking the EVENT rather than a pre-read destination is what keeps
   *  the seven call sites from each having to remember there are two fields —
   *  and forgetting the second one is the whole failure this change is about. */
  event: { readonly destinationBattlefieldId?: string; readonly destinationIsBase?: true },
  /** Who CAUSED this move — the caster, not the moved unit's controller. Passed
   *  through so "when YOU move an ENEMY unit" can be answered; see the field's
   *  doc on `unitMoved`. Optional, so a caller that has no caster in hand is
   *  unchanged. */
  causedByIndex?: 0 | 1,
): GameState {
  if (event.destinationIsBase === true) return forceMoveToBase(state, targetInstanceId, causedByIndex);
  if (event.destinationBattlefieldId === undefined) return state;
  return forceMoveToBattlefield(state, targetInstanceId, event.destinationBattlefieldId, causedByIndex);
}

/**
 * Grants a keyword to a unit for the rest of the turn — Udyr's "Give me
 * [Ganking] this turn".
 *
 * Lands on `keywordsThisTurn` rather than `keywords`, so it expires at runEnd
 * with the rest of this turn's state and cannot be smuggled into a later turn by
 * a card that reads the printed set.
 */
/**
 * Grants `triggerKey` to a unit for the rest of the turn — Relentless Pursuit's
 * "This turn, that unit has 'When I conquer, you may move me to my base.'"
 *
 * The key is an event-trigger registry key, so the granted ability is written
 * exactly where a printed one is; `triggers.triggerKeysOn` is what makes the
 * listener walk find it, and `runEnd` sweeps it.
 *
 * Idempotent, and that is a HOUSE READING rather than a cited rule. It used to
 * claim "817.1.a's reasoning applied one level out"; 817.1.a says nothing about
 * redundancy, and what the rules do say about duplicated abilities points the
 * other way (808.2: each instance of Deathknell triggers separately). The
 * justification is only that granting the same ability twice would place it on
 * the chain twice for one moment, which no card in this pool asks for and the
 * second Relentless Pursuit on one unit would silently do.
 *
 * A unit that has left the board is a silent no-op — the target-vanished
 * convention every helper here follows.
 */
export function grantTriggerThisTurn(state: GameState, targetInstanceId: string, triggerKey: string): GameState {
  return updateUnitAnywhere(state, targetInstanceId, (u) =>
    (u.grantedTriggersThisTurn ?? []).includes(triggerKey)
      ? u
      : { ...u, grantedTriggersThisTurn: [...(u.grantedTriggersThisTurn ?? []), triggerKey] },
  );
}

export function grantKeywordThisTurn(
  state: GameState,
  targetInstanceId: string,
  keyword: Keyword,
  /**
   * The keyword's VALUE, for the numbered ones — Cleave grants `[Assault 3]`,
   * not `[Assault]`. Defaults to 1, which is right for every unnumbered keyword
   * (`[Ganking]`, `[Tank]`) and was the hardcoded behaviour before a numbered
   * grant existed.
   *
   * Merged against what is already there by `mergeGrantedKeyword`, which is where
   * the per-keyword rule lives: a second `[Assault 3]` this turn is a second
   * SOURCE and sums to 6 (807.2), while a second `[Ganking]` is redundant
   * (810.2). This used to be a flat `Math.max` justified by "817.1.a", which is
   * Vision's "It is present on Permanents" and states no such rule.
   */
  value = 1,
): GameState {
  return updateUnitAnywhere(state, targetInstanceId, (u) => {
    const keywordsThisTurn = { ...u.keywordsThisTurn };
    mergeGrantedKeyword(keywordsThisTurn, keyword, value);
    return { ...u, keywordsThisTurn };
  });
}

/**
 * Exhausts every unit `playerIndex` controls, base and battlefields — Unchecked
 * Power's "Exhaust all friendly units, then deal 12 to ALL units at
 * battlefields".
 *
 * The exhaust is the card's price rather than part of the damage, which is why
 * it hits units in BASE too while the damage does not: one clause says "all
 * friendly units", the other says "at battlefields", and the difference is
 * printed.
 */
export function exhaustAllFriendlyUnits(state: GameState, playerIndex: 0 | 1): GameState {
  const exhaust = (u: UnitInstance): UnitInstance => (u.exhausted ? u : { ...u, exhausted: true });
  const actor = state.players[playerIndex];
  const players = [...state.players] as [PlayerState, PlayerState];
  players[playerIndex] = { ...actor, baseUnits: actor.baseUnits.map(exhaust) };
  const battlefields = state.battlefields.map((bf) => {
    const mine = bf.units[actor.id];
    return mine ? { ...bf, units: { ...bf.units, [actor.id]: mine.map(exhaust) } } : bf;
  });
  return { ...state, players, battlefields };
}

/** Every unit `playerIndex` controls, base and battlefields — the walk half a
 *  dozen "all friendly units" effects each re-derived by hand. */
export function ownUnitsEverywhere(state: GameState, playerIndex: 0 | 1): UnitInstance[] {
  const actor = state.players[playerIndex];
  return [...actor.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[actor.id] ?? [])];
}

/**
 * Stuns a unit — rule 423's Stun section. The PRIMITIVE: it changes the flag and
 * fires nothing.
 *
 * A no-op on an already-stunned unit, because "a Stunned Unit can not be Stunned
 * again" — and that is a real distinction, not tidiness: the rules' own example
 * is Eclipse Herald, which triggers "when you stun an enemy unit" and does NOT
 * trigger when the chosen unit was already stunned. Returning the state
 * unchanged is what makes that card correct.
 *
 * **A card implementation must call `stunUnits` below, not this.** This one is
 * for tests that need a stunned unit as a fixture, where there is no stunner and
 * inventing one would be a lie. Every real stun has a player behind it, and
 * Eclipse Herald / Leona - Radiant Dawn are watching for exactly that.
 */
export function stunUnit(state: GameState, targetInstanceId: string): GameState {
  const location = findUnitAnywhere(state, targetInstanceId);
  if (!location || location.unit.stunned) return state;
  return updateUnitAnywhere(state, targetInstanceId, (u) => ({ ...u, stunned: true }));
}

/**
 * "`stunnerIndex` stuns these units" — the funnel every card's stun goes
 * through, and the only thing that fires the `unitsStunned` event.
 *
 * **One event for the whole instruction, not one per unit**, and the card text
 * forces it: Leona - Radiant Dawn reads "When you stun **one or more** enemy
 * units, buff a friendly unit" — one buff however many were stunned — while
 * Eclipse Herald reads "When you stun **an** enemy unit" and wants one trigger
 * each. A per-unit event would silently make Leona fire twice for Facebreaker;
 * a batch payload lets each listener read it its own way.
 *
 * Only units that ACTUALLY became stunned are reported. Rule 423's "a Stunned
 * Unit can not be Stunned again" means re-stunning is not a stunning, so it must
 * not offer Eclipse Herald its ready-me trigger over and over for nothing —
 * exactly the reasoning `addBuff` uses for `unitBuffed` under rule 708. A stun
 * that changed nothing at all fires no event and returns the state untouched.
 *
 * The Legend is dispatched separately because `allListeningPermanents` walks
 * base units, battlefield units and gear — a Legend is not on the board and no
 * listener walk can reach it. Board listeners resolve first, then each player's
 * Legend in turn order.
 */
export function stunUnits(state: GameState, stunnerIndex: 0 | 1, targetInstanceIds: readonly string[]): GameState {
  const stunned: { unitInstanceId: string; ownerIndex: 0 | 1 }[] = [];
  let next = state;
  for (const id of targetInstanceIds) {
    const location = findUnitAnywhere(next, id);
    if (!location || location.unit.stunned) continue;
    next = stunUnit(next, id);
    stunned.push({ unitInstanceId: id, ownerIndex: location.ownerIndex });
  }
  if (stunned.length === 0) return state;

  // HELD (383), not dispatched — and the Legend rides the same call now rather
  // than a second dispatch beside it, because `allListeningPermanents` walks the
  // Legend zone. Leona - Radiant Dawn's "buff a friendly unit" therefore parks
  // its question a chain-pop after the stun, with a response window in between.
  return holdEventTrigger(next, { kind: "unitsStunned", stunnerIndex, stunned });
}

/**
 * Spends a unit's Buff — rule 702.2.b, "Spending a Buff removes a single Buff
 * counter from a Unit".
 *
 * Returns undefined rather than an unchanged state when the spend is illegal, so
 * callers can't silently get the effect without paying: rule 702.2.b.1 forbids spending
 * from an unbuffed unit and 702.2.b.2 restricts it to units you control, and both are
 * costs for cards that give you something in return (Wildclaw Shaman, Udyr -
 * Wildman). A no-op state would hand over the payoff for free.
 */
export function spendBuff(state: GameState, playerIndex: 0 | 1, targetInstanceId: string): GameState | undefined {
  const owner = state.players[playerIndex];
  const ownsIt =
    owner.baseUnits.some((u) => u.instanceId === targetInstanceId) ||
    state.battlefields.some((bf) => (bf.units[owner.id] ?? []).some((u) => u.instanceId === targetInstanceId));
  if (!ownsIt) return undefined;

  const location = findUnitAnywhere(state, targetInstanceId);
  if (!location?.unit.buffed) return undefined;
  // "Any number of buffs" (Lee Sin - Ascetic): spending takes an EXTRA first and
  // leaves the unit buffed, so a stack of three survives two spends. Only when
  // the last one goes does `buffed` clear — which is what keeps every other
  // reader of that boolean correct.
  // Fae Dragon — HELD here rather than at the eight call sites, for the reason
  // this function returns `undefined` on an illegal spend: this is the only
  // place a spend is known to have happened. A stacked buff spent down to two is
  // still a spend, so both branches below fire it.
  const spent = holdEventTrigger(state, { kind: "buffSpent", spenderIndex: playerIndex, unitInstanceId: targetInstanceId });

  if ((location.unit.extraBuffs ?? 0) > 0) {
    return updateUnitAnywhere(spent, targetInstanceId, (u) => ({ ...u, extraBuffs: (u.extraBuffs ?? 0) - 1 }));
  }

  return updateUnitAnywhere(spent, targetInstanceId, (u) => ({ ...u, buffed: false }));
}

/**
 * Discards cards from `playerIndex`'s hand to their trash.
 *
 * Nine cards in the presets discard, and they split into two shapes that this
 * one function has to serve:
 *
 *  - **Already decided**, when the choice rode in on the submitted action (Get
 *    Excited!, Brazen Buccaneer). Pass `chosenInstanceIds`.
 *  - **Not yet decided**, which is every [Deathknell] and every on-move trigger,
 *    because a trigger has no action to carry a choice on. Omit
 *    `chosenInstanceIds` and this STOPS AND ASKS (engine/decisions.ts).
 *
 * Asking replaces a documented front-of-hand simplification: the rules give the
 * discarding player the choice in both cases, and the engine simply had no way
 * to ask until pending decisions existed. Discarding fewer than `count` when the
 * hand is short is correct, not a shortcut — "discard 2" with one card in hand
 * discards that one (055), and a hand no bigger than `count` is not a choice at
 * all, so it goes without a prompt.
 */
export function discardCards(
  state: GameState,
  playerIndex: 0 | 1,
  count: number,
  chosenInstanceIds?: readonly string[],
  /**
   * Suppresses the `cardsDiscarded` event. Set ONLY by the `discard` decision as
   * it takes one card at a time: a "discard 2" the player chooses for arrives
   * here twice, and Jinx - Rebel's "one or more cards" must pay out once for the
   * instruction, not once per answer. The decision fires the event itself when
   * the last card is gone.
   */
  options?: { suppressEvent?: boolean },
): GameState {
  if (count <= 0) return state;
  const actor = state.players[playerIndex];

  // Nobody named a card, and there is more than one to choose from — so ask.
  // This used to take the front of hand and say so apologetically; the rules
  // give the discarding player the choice, and now the engine can stop to ask
  // (engine/decisions.ts).
  //
  // Only when there is a real choice: "discard 2" holding exactly two cards is
  // not a decision, and opening a prompt to confirm it would be theatre. The
  // fall-through below still takes the whole hand in that case, which is also
  // what makes "discard 2" with one card in hand discard that one (422).
  if (chosenInstanceIds === undefined && actor.hand.length > count) {
    return parkDecision(state, { kind: "discard", playerIndex, count });
  }

  const chosen =
    chosenInstanceIds === undefined
      ? actor.hand.slice(0, count)
      : actor.hand.filter((c) => chosenInstanceIds.includes(c.instanceId)).slice(0, count);
  if (chosen.length === 0) return state;

  const discardedIds = new Set(chosen.map((c) => c.instanceId));
  const moved = updatePlayer(state, playerIndex, (p) => ({
    ...p,
    hand: p.hand.filter((c) => !discardedIds.has(c.instanceId)),
    trash: [...p.trash, ...chosen],
    // Raging Soul asks whether you have discarded THIS TURN, so the fact has to
    // outlive the discard itself. Set here rather than at each call site, since
    // this is the one funnel every discard goes through.
    discardedThisTurn: true,
  }));

  // A card can trigger on being discarded (Scrapheap), and at that moment it is
  // in the trash rather than in play — so it is dispatched by its own defId, not
  // found by walking the board. Fired after the move, so the trigger sees the
  // finished zones.
  // HELD (383), one entry per discarded card — a card that pays out on being
  // discarded is in HAND at that moment and in the trash immediately after, so
  // the entry carries it rather than looking it up.
  const selfTriggered = chosen.reduce((next, c) => holdSelfTrigger(next, "discarded", c, playerIndex), moved);

  // Then the board event, ONCE for the whole instruction (Jinx - Rebel's "one or
  // more cards"). After the per-card self-triggers, so a card that plays itself
  // out of the trash on being discarded has already done so.
  if (options?.suppressEvent) return selfTriggered;
  return holdEventTrigger(selfTriggered, { kind: "cardsDiscarded", discarderIndex: playerIndex });
}

/**
 * "Discard N, **then** draw M" — Undercover Agent's Deathknell and Traveling
 * Merchant's on-move trigger.
 *
 * Its own function because the "then" is load-bearing and became fragile the
 * moment discarding could stop to ask. Written the obvious way,
 * `drawCards(discardCards(state, i, 2), i, 2)`, the draw now happens while the
 * discard is still a pending question — so the cards just drawn join the hand
 * the player is about to choose discards from, and "a card just drawn can never
 * be one of the cards discarded" silently inverts.
 *
 * The draw is therefore queued BEHIND the questions. It needs no special
 * machinery to do that: a draw is a decision with exactly one option, so
 * `parkDecision` executes it immediately when nothing is being asked and lines
 * it up after the questions when something is.
 */
export function discardThenDraw(state: GameState, playerIndex: 0 | 1, discardCount: number, drawCount: number): GameState {
  return parkDecision(discardCards(state, playerIndex, discardCount), { kind: "draw", playerIndex, count: drawCount });
}

/**
 * Recycles `count` cards from `playerIndex`'s own trash — rule 416: "takes one
 * or more cards from a specific zone and then puts it on the **bottom** of the
 * corresponding deck", and "each player Recycles cards to their own Main Deck
 * … regardless of which player is instructed to perform the Recycle action".
 *
 * Returns `undefined` when the trash holds fewer than `count`, because rule 416.3
 * makes this a payability question, not a do-as-much-as-you-can one: "When
 * Recycling is listed as a Cost, the action must be able to be completed for the
 * cost to be paid." Same contract as `spendBuff` — an unpayable cost must not
 * hand over the payoff, and a no-op state would.
 *
 * Which cards go back is not offered as a choice: taking the front of the trash
 * (the oldest cards) matches `discardCards`' convention, and the alternative —
 * fanning out every subset of a trash that can hold forty cards — is not
 * bounded. Recorded in docs/rules-conformance.md rather than hidden.
 */
export function recycleFromTrash(state: GameState, playerIndex: 0 | 1, count: number): GameState | undefined {
  if (count <= 0) return state;
  const actor = state.players[playerIndex];
  if (actor.trash.length < count) return undefined;

  const recycled = actor.trash.slice(0, count);
  return holdCardsRecycled(
    updatePlayer(state, playerIndex, (p) => ({
      ...p,
      trash: p.trash.slice(count),
      deck: [...p.deck, ...recycled], // bottom of the deck, per 416
    })),
    playerIndex,
    recycled.length,
  );
}

/**
 * Recycle `count` UNITS from a player's own trash — Assembly Rig's "Recycle a
 * unit from your trash".
 *
 * A sibling of `recycleFromTrash` above rather than a parameter on it, because
 * the two differ in what can PAY them and therefore in whether the ability is
 * offered at all. Everything else is identical and deliberately so: `undefined`
 * when the cost cannot be completed in full (416.3, "when Recycling is listed as
 * a Cost, the action must be able to be completed for the cost to be paid"), the
 * OLDEST matching cards go, they land on the bottom of the deck (416), and
 * Karma - Channeler sees it.
 */
export function recycleUnitsFromTrash(state: GameState, playerIndex: 0 | 1, count: number): GameState | undefined {
  if (count <= 0) return state;
  const actor = state.players[playerIndex];
  const units = actor.trash.filter((c) => c.kind === "Unit");
  if (units.length < count) return undefined;

  const recycled = units.slice(0, count);
  const going = new Set(recycled.map((c) => c.instanceId));
  return holdCardsRecycled(
    updatePlayer(state, playerIndex, (p) => ({
      ...p,
      // Filtered by identity rather than by slicing, because the units being
      // taken are not necessarily at the front of a mixed trash.
      trash: p.trash.filter((c) => !going.has(c.instanceId)),
      deck: [...p.deck, ...recycled],
    })),
    playerIndex,
    recycled.length,
  );
}

/**
 * Holds Karma - Channeler's "when you recycle one or more cards to your Main
 * Deck" — one event per instruction, and none at all when nothing moved.
 *
 * A helper rather than an inline `holdEventTrigger` at each site, because there
 * are nine places in this engine that recycle cards and the guard ("did anything
 * actually move?") is the same at all of them. RUNES are deliberately not a
 * caller: the card's own reminder text says so.
 */
export function holdCardsRecycled(state: GameState, ownerIndex: 0 | 1, count: number): GameState {
  if (count <= 0) return state;
  return holdEventTrigger(state, { kind: "cardsRecycled", ownerIndex, count });
}

/**
 * Holds Sivir - Battle Mistress's "when you recycle a rune" — the RUNE twin of
 * `holdCardsRecycled` above, with the same "did anything actually move?" guard.
 *
 * A helper rather than an inline `holdEventTrigger`, because SEVEN places in this
 * engine send a rune to the bottom of the rune deck: paying a card's Power cost,
 * paying an ability's, `payPowerFromChanneled`, floating a rune for Power, the
 * Hide cost, a battlefield ability and one card. The guard is the same at all of
 * them, and a helper is how the eighth gets it for free.
 */
export function holdRunesRecycled(state: GameState, ownerIndex: 0 | 1, count: number): GameState {
  if (count <= 0) return state;
  return holdEventTrigger(state, { kind: "runesRecycled", ownerIndex, count });
}

/**
 * Recycles one named card out of a player's HAND — rule 416's "puts it on the
 * bottom of the corresponding deck", applied to a card that was never in the
 * trash (Sabotage).
 *
 * Distinct from `recycleFromTrash` above rather than a parameterised version of
 * it, and the difference is not the zone: that one is a COST and returns
 * undefined when it cannot be paid in full, while this is an effect on a card
 * someone else chose, so a card that has since left the hand is simply a no-op.
 */
export function recycleCardFromHand(state: GameState, playerIndex: 0 | 1, cardInstanceId: string): GameState {
  const actor = state.players[playerIndex];
  const card = actor.hand.find((c) => c.instanceId === cardInstanceId);
  if (!card) return state;
  return holdCardsRecycled(
    updatePlayer(state, playerIndex, (p) => ({
      ...p,
      hand: p.hand.filter((c) => c.instanceId !== cardInstanceId),
      deck: [...p.deck, card], // bottom, per 416
    })),
    playerIndex,
    1,
  );
}

/**
 * "Look at the top N of your Main Deck. Put 1 into your hand and recycle the
 * rest." (Stacked Deck) — takes `keptInstanceId` from among the top `count` and
 * sends the others to the bottom.
 *
 * Only ever touches the top `count`, so a card named from deeper in the deck
 * cannot be smuggled into hand by a forged answer. Recycling the rest preserves
 * their relative order, which matters because the next Stacked Deck will look at
 * whatever is on top now.
 */
export function takeOneFromTopAndRecycleRest(
  state: GameState,
  playerIndex: 0 | 1,
  count: number,
  keptInstanceId: string,
): GameState {
  const actor = state.players[playerIndex];
  const looked = actor.deck.slice(0, count);
  const kept = looked.find((c) => c.instanceId === keptInstanceId);
  if (!kept) return state;
  return holdCardsRecycled(
    updatePlayer(state, playerIndex, (p) => ({
      ...p,
      deck: [...p.deck.slice(looked.length), ...looked.filter((c) => c.instanceId !== keptInstanceId)],
      hand: [...p.hand, kept],
    })),
    playerIndex,
    looked.length - 1,
  );
}

/**
 * "Recycle me" paid with a unit already in play — Ekko - Recurrent. The unit
 * leaves the board for the BOTTOM of its owner's Main Deck (rule 416).
 *
 * Deliberately NOT a death and deliberately not routed through `killUnit`: a
 * Recycle is a zone change, so no `[Deathknell]` fires, no death-watch sees it,
 * and it never reaches the trash. Its damage and this-turn state are cleared for
 * the same reason `returnUnitToHand` clears them — the card may be drawn and
 * played again fresh.
 */
export function recycleUnitFromPlayToDeck(state: GameState, playerIndex: 0 | 1, unitInstanceId: string): GameState {
  const location = findUnitAnywhere(state, unitInstanceId);
  if (!location || location.ownerIndex !== playerIndex) return state;
  const clean: UnitInstance = {
    ...location.unit,
    damage: 0,
    mightThisTurn: 0,
    buffed: false,
    stunned: false,
    exhausted: false,
    keywordsThisTurn: {},
    abilityModesUsedThisTurn: [],
    movesThisTurn: 0,
  };
  const removed = removeUnitAnywhere(state, unitInstanceId);
  return holdCardsRecycled(
    updatePlayer(removed, playerIndex, (p) => ({ ...p, deck: fileIntoNonBoardZone(p.deck, clean) })),
    playerIndex,
    1,
  );
}

/**
 * Draws `count` cards, running **Burn Out** (rule 431) whenever the deck cannot
 * cover the draw: recycle that player's trash into their deck, an opponent gains
 * 1 point, then finish the draw.
 *
 * **This used to silently no-op on an empty deck**, described as a documented
 * gap "weaker than the real rules, but not a crash". It was worse than that: it
 * was a LIVELOCK. With both decks empty, neither player able to develop and no
 * battlefield held, self-play ran to turn 538 passing back and forth, because
 * the only rule that can break that position is the one that was missing. The
 * conformance doc had recorded Burn Out as "a genuine gap, just not a
 * demonstrated liveness bug" — it is demonstrated now, and this is the fix.
 *
 * The point is what actually ends such a game: a deck that keeps running out
 * keeps feeding the opponent points until someone reaches the Victory Score.
 *
 * **Simplification, named:** the recycled trash goes back in trash order rather
 * than shuffled. Rule 431 randomises it, but `drawCards` has no RNG to hand and
 * determinism is a stated project NFR (every shuffle here takes an explicit
 * seeded `Rng`). Same convention, and the same reason, as `recycleFromTrash`
 * taking the front of the trash. Recorded in docs/rules-conformance.md.
 */
/**
 * Records that `chooserIndex` has chosen these permanents — Ezreal - Prodigal
 * Explorer's "you've chosen enemy units and/or gear twice this turn with spells
 * or unit abilities".
 *
 * Counts one per CHOICE, not one per card: a spell naming two enemy units gets
 * Ezreal there on its own. That is `holdUnitsChosen`'s reading of 355 too, and
 * its comment says so — "a card counting choices must count both".
 *
 * **Three narrowings, each of them a way to be wrong.**
 *  - ENEMY only. Choosing your own units is choosing, but not this card's clause.
 *  - GEAR as well as units, which is why this takes permanent ids rather than the
 *    unit list `holdUnitsChosen` takes. An enemy gear named by Rocket Barrage
 *    counts, and a version reading only the unit fields would silently never see
 *    the "and/or gear" half.
 *  - The CALLER decides whether the source qualifies ("spells or unit
 *    abilities"), because only the caller knows what the source was — a Legend's
 *    ability chooses units every time Jax is used, and does not count.
 *
 * An id naming nothing enemy is simply not counted: a friendly target, a
 * facedown card, an id that has left play. No throw, the same
 * target-vanished convention every helper here follows.
 */
export function recordEnemyChoices(state: GameState, chooserIndex: 0 | 1, chosenIds: readonly string[]): GameState {
  const opponentIndex: 0 | 1 = chooserIndex === 0 ? 1 : 0;
  const opponent = state.players[opponentIndex];
  const enemy = chosenIds.filter((id) => {
    if (opponent.activeGear.some((g) => g.instanceId === id)) return true;
    return findUnitAnywhere(state, id)?.ownerIndex === opponentIndex;
  });
  if (enemy.length === 0) return state;

  const players = [...state.players] as [PlayerState, PlayerState];
  const chooser = players[chooserIndex];
  players[chooserIndex] = { ...chooser, enemyChoicesThisTurn: chooser.enemyChoicesThisTurn + enemy.length };
  return { ...state, players };
}

export function drawCards(state: GameState, playerIndex: 0 | 1, count: number): GameState {
  if (count <= 0) return state;
  let next = state;
  for (let drawn = 0; drawn < count; drawn += 1) {
    const player = next.players[playerIndex];
    if (player.deck.length === 0) {
      // Nothing in either zone: there is no card to draw and no trash to make
      // one from, so Burn Out cannot repeat. Stopping here is what keeps this
      // loop finite rather than trading one livelock for another.
      if (player.trash.length === 0) return next;
      next = burnOut(next, playerIndex);
    }
    // **The ordinal is incremented in the same update that moves the card**, and
    // needs no "did anything happen" guard after it — one was written and DELETED
    // as unreachable when mutation testing showed removing it changed nothing.
    //
    // By this line the deck cannot be empty: the block above either returned
    // (deck AND trash empty, so there is no card and no way to make one) or ran
    // `burnOut`, which moves a non-empty trash into the deck. So `top` is always
    // defined here, and the `: p` fallback is a type narrowing rather than a live
    // branch. That is also what makes the "impossible draw does not count" case
    // hold — the early return does it, not anything here.
    next = updatePlayer(next, playerIndex, (p) => {
      const [top, ...rest] = p.deck;
      return top ? { ...p, deck: rest, hand: [...p.hand, top], cardsDrawnThisTurn: p.cardsDrawnThisTurn + 1 } : p;
    });
    // HELD like every other event (383). Raised per CARD, so "draw 3" crosses the
    // second-card boundary exactly once, and carrying the ordinal is what lets a
    // listener that resolves LATER still know which draw it was.
    next = holdEventTrigger(next, {
      kind: "cardDrawn",
      ownerIndex: playerIndex,
      nthThisTurn: next.players[playerIndex].cardsDrawnThisTurn,
    });
  }
  return next;
}

/**
 * Rule 431's Burn Out: the drawing player's trash becomes their deck, and an
 * opponent gains 1 point.
 *
 * The point goes to the OPPONENT of whoever burned out — running out of cards is
 * the losing condition this game has instead of decking out, so it hands the win
 * to the other player over time rather than ending immediately.
 */
function burnOut(state: GameState, playerIndex: 0 | 1): GameState {
  const opponentIndex: 0 | 1 = playerIndex === 0 ? 1 : 0;
  const players = [...state.players] as [PlayerState, PlayerState];
  players[playerIndex] = { ...players[playerIndex], deck: [...players[playerIndex].trash], trash: [] };
  // Through `gainPoints`, so Tianna blocks Burn Out's point like any other.
  players[opponentIndex] = gainPoints({ ...state, players }, opponentIndex, 1).players[opponentIndex];
  return { ...state, players };
}

/**
 * Channels `count` runes from a player's rune deck into their channeled pool
 * **exhausted** — Stormclaw Ursine's "channel 1 rune exhausted".
 *
 * Distinct from `turn-manager.runChannel`, which is the Channel *Phase* and
 * always reveals runes Ready. An exhausted rune still counts for Power (a Power
 * cost recycles the rune regardless of its state, see execute-play-card) but
 * cannot pay Energy until it readies at the next Awaken — which is exactly what
 * makes "channel 1 exhausted" weaker than a free rune rather than equivalent.
 *
 * An empty rune deck channels as many as it can and no more, matching
 * runChannel's own "as many as possible if fewer remain" behaviour (rule
 * 315.4.b) rather than throwing.
 */
export function channelRunesExhausted(state: GameState, playerIndex: 0 | 1, count: number): GameState {
  return updatePlayer(state, playerIndex, (p) => {
    if (count <= 0 || p.runeDeck.length === 0) return p;
    const taken = p.runeDeck.slice(0, count).map((r) => ({ ...r, state: "Exhausted" as const }));
    return { ...p, runeDeck: p.runeDeck.slice(taken.length), channeled: [...p.channeled, ...taken] };
  });
}

/**
 * Readies up to `max` exhausted runes in `ownerIndex`'s channeled pool, in pool
 * order.
 *
 * Which specific runes are readied is deliberately not offered as a choice:
 * readying is strictly beneficial and never wrong, so maxing it out IS the
 * faithful implementation of "up to N" rather than a shortcut around a real
 * decision — the Java oracle makes exactly this call and says so
 * (LegendAbilities.java:30-32).
 *
 * Lived in legend-abilities.ts as a module-private helper while
 * Annie - Dark Child's "ready up to 2 runes" was the only card that wanted it.
 * Sona - Harmonious reads "ready up to 4 friendly runes" off a permanent rather
 * than a Legend, so it moved here rather than being copied — a second copy is
 * how the two would come to disagree about what "up to" means.
 */
export function readyRunes(state: GameState, ownerIndex: 0 | 1, max: number): GameState {
  const owner = state.players[ownerIndex];
  let readied = 0;
  const channeled = owner.channeled.map((rune) => {
    if (readied >= max || rune.state !== "Exhausted") return rune;
    readied += 1;
    return { ...rune, state: "Ready" as const };
  });
  if (readied === 0) return state;
  return updatePlayer(state, ownerIndex, (p) => ({ ...p, channeled }));
}

/**
 * Pays `amount` Energy from a player's pool mid-resolution — floating Energy
 * first, then Ready runes exhausted — or undefined when it cannot be paid.
 *
 * The counterpart to `payPowerFromChanneled` for the Energy half of a
 * decision-time cost (Immortal Phoenix's "you may pay [1 Energy][1 Fury] to play
 * me from your trash", Vayne - Hunter's "you may pay [1 Energy]").
 *
 * **WHICH runes go is not offered as a choice**, and unlike `readyRunes`' version
 * of that call this one is a genuine simplification rather than a non-decision:
 * Energy is domain-free, so any Ready rune pays it equally — but which one goes
 * decides which DOMAINS remain for a later Power cost, and a player might care.
 * Taking them in pool order is deterministic and is recorded Unverified in
 * docs/rules-conformance.md. `DecisionOption.payment` — the field that would let
 * a player choose — has zero producers and zero consumers to this day.
 *
 * Floating first, exactly as `computeEffectiveCost` prices a card, so an
 * activation and a play agree about what a player can afford.
 */
/**
 * Awards points, subject to every restriction on GAINING them.
 *
 * **The single choke point, and it had to become one.** Points were written at
 * nine separate sites — two in `scoring.ts`, Burn Out here, a battlefield, and
 * five cards doing a plain `points + 1` inline — and Tianna Crownguard
 * ("opponents can't gain points") cannot be expressed as a check bolted onto
 * any one of them. `scoring.ts`'s own doc comment already named her as a known
 * omission.
 *
 * **Blocking a point does NOT unrecord the scoring.** Project-owner ruling,
 * 2026-08-06: the scoring EVENT still happened, it just paid nothing, so
 * 470's once-per-battlefield-per-turn lockout still fires and the opponent
 * cannot retry that battlefield this turn. Which is why this function awards
 * points and nothing else — `scoredBattlefieldsThisTurn` is written by
 * `recordConquest` and `scoreHolds` regardless of what this returns.
 */
export function gainPoints(state: GameState, playerIndex: 0 | 1, amount: number): GameState {
  if (amount <= 0 || !mayGainPoints(state, playerIndex)) return state;
  return updatePlayer(state, playerIndex, (p) => ({ ...p, points: p.points + amount }));
}

/**
 * Gains XP (see `PlayerState.xp`).
 *
 * **No `mayGainXp` counterpart, and that asymmetry with `gainPoints` is the
 * point of writing it as a choke point anyway.** Tianna Crownguard is why points
 * needed one; nothing in the 280-card Unleashed pool says "opponents can't gain
 * XP", measured over unl.json rather than assumed. If a later set prints it,
 * this is the one line that has to learn about it instead of the 35 cards that
 * gain XP each doing `xp + n` inline — which is precisely the nine-site mess
 * `gainPoints` was extracted from after the fact.
 *
 * No cap, per the rules section cited on `PlayerState.xp`, so nothing clamps.
 */
export function gainXp(state: GameState, playerIndex: 0 | 1, amount: number): GameState {
  if (amount <= 0) return state;
  // `xpGainedThisTurn` is set HERE because this is the single writer of `xp` —
  // the same reason `powerSpentThisTurn` is bumped inside `payPowerFromChanneled`
  // rather than at its callers. A per-site tally would miss whichever call
  // nobody remembered, and XP is gained from keywords, triggers and abilities
  // alike.
  //
  // Guarded by the `amount <= 0` early return above, so "gained 0" does not
  // count as having gained — which matters, since `[Hunt 0]` and a scaled gain
  // that resolves to nothing both reach here.
  return updatePlayer(state, playerIndex, (p) => ({ ...p, xp: p.xp + amount, xpGainedThisTurn: true }));
}

/** Can this player pay `amount` XP right now? The question the play enumerator
 *  and the activation offer both have to ask BEFORE offering the option, so that
 *  `spendXp` failing is a bug rather than an ordinary outcome. */
export function canSpendXp(state: GameState, playerIndex: 0 | 1, amount: number): boolean {
  return state.players[playerIndex].xp >= amount;
}

/**
 * Spends XP, or `undefined` if the player cannot afford it.
 *
 * `undefined`-on-failure rather than a silent floor at zero, matching
 * `payEnergyFromPool` directly above: a cost that quietly underpays is the shape
 * where a card's "if you paid the additional cost" half reads as paid. Callers
 * that want the question without the payment ask `canSpendXp`.
 */
export function spendXp(state: GameState, playerIndex: 0 | 1, amount: number): GameState | undefined {
  if (amount <= 0) return state;
  if (!canSpendXp(state, playerIndex, amount)) return undefined;
  return updatePlayer(state, playerIndex, (p) => ({ ...p, xp: p.xp - amount }));
}

export function payEnergyFromPool(state: GameState, playerIndex: 0 | 1, amount: number): GameState | undefined {
  if (amount <= 0) return state;
  const actor = state.players[playerIndex];
  const fromFloating = Math.min(actor.floatingEnergy, amount);
  let owed = amount - fromFloating;

  const channeled = actor.channeled.map((rune) => {
    if (owed <= 0 || rune.state !== "Ready") return rune;
    owed -= 1;
    return { ...rune, state: "Exhausted" as const };
  });
  if (owed > 0) return undefined; // not enough Ready runes, even after floating

  return updatePlayer(state, playerIndex, (p) => ({ ...p, floatingEnergy: p.floatingEnergy - fromFloating, channeled }));
}

/**
 * Returns a unit, a GEAR or a FACEDOWN card to its owner's hand — Pack of
 * Wonders' one instruction across three kinds of thing.
 *
 * Dispatches on where the id is actually found rather than being told, because
 * the card does not distinguish them either: "another friendly gear, unit, or
 * facedown card" is one choice over three zones.
 *
 * A unit routes through `returnUnitToHand`, which strips its Buff (705) and
 * resets damage — leaving play is leaving play. A gear and a facedown card carry
 * no such state, so they simply move.
 */
export function returnPermanentToHand(state: GameState, instanceId: string): GameState {
  if (findUnitAnywhere(state, instanceId)) return returnUnitToHand(state, instanceId);

  for (const index of [0, 1] as const) {
    const owner = state.players[index];
    const gear = owner.activeGear.find((g) => g.instanceId === instanceId);
    if (gear) {
      return updatePlayer(state, index, (p) => ({
        ...p,
        activeGear: p.activeGear.filter((g) => g.instanceId !== instanceId),
        hand: fileIntoNonBoardZone(p.hand, gear),
      }));
    }
  }

  // A facedown card lives on the BATTLEFIELD, not in a player's zones, so it is
  // the one case that touches `battlefields`. Its owner takes it back — that is
  // whose card it is, however contested the battlefield.
  for (const [bfIndex, bf] of state.battlefields.entries()) {
    const hidden = bf.hiddenCards.find((h) => h.card.instanceId === instanceId);
    if (!hidden) continue;
    const battlefields = [...state.battlefields];
    battlefields[bfIndex] = { ...bf, hiddenCards: bf.hiddenCards.filter((h) => h.card.instanceId !== instanceId) };
    return updatePlayer({ ...state, battlefields }, hidden.ownerIndex, (p) => ({ ...p, hand: [...p.hand, hidden.card] }));
  }
  return state;
}

/** Removes a unit from its battlefield and adds it to its OWNER's hand
 *  (not necessarily the caster's) — resets damage/this-turn Might/exhausted
 *  and removes any Buff (rule 705, "if a Unit leaves play, remove all Buffs
 *  from it") since
 *  it's leaving play entirely and may be replayed fresh, unlike
 *  recallUnitToBase (which keeps a unit "in play," just relocated). */
export function returnUnitToHand(state: GameState, targetInstanceId: string): GameState {
  const location = findUnitAnywhere(state, targetInstanceId);
  if (!location) return state;
  const { unit, ownerIndex } = location;

  const returned: UnitInstance = { ...unit, damage: 0, mightThisTurn: 0, buffed: false, exhausted: false };
  const removed = removeUnitAnywhere(state, targetInstanceId);
  return updatePlayer(removed, ownerIndex, (p) => ({ ...p, hand: fileIntoNonBoardZone(p.hand, returned) }));
}

/**
 * A true Recall in the rules' sense: relocate a unit to its owner's base
 * WITHOUT touching its state. "A Recall is when a Permanent is relocated from
 * anywhere to its Base without it being a Move... Damage and statuses of a
 * permanent will all remain unaffected by a Recall" (rule 458.1).
 *
 * Two things this deliberately does NOT do, both load-bearing:
 *   - It does not exhaust. Highlander reads "heal it, exhaust it, and recall
 *     it" precisely because a bare recall leaves readiness alone; the exhaust
 *     comes from the card, not from the recall.
 *   - It fires no move triggers. Recalls are explicitly not Moves (456), so
 *     Traveling Merchant's "when I move, discard 1, then draw 1" and Noxian
 *     Drummer's token must not fire. Do not add a dispatchOnMove call here.
 *
 * Used by combat cleanup step 3d. Distinct from recallUnitToBase below, which
 * force-exhausts for the player-initiated retreat.
 */
export function relocateToBaseUnchanged(state: GameState, targetInstanceId: string): GameState {
  const location = findUnitAnywhere(state, targetInstanceId);
  if (!location) return state;
  const { unit, ownerIndex } = location;
  const removed = removeUnitAnywhere(state, targetInstanceId);
  return updatePlayer(removed, ownerIndex, (p) => ({ ...p, baseUnits: [...p.baseUnits, unit] }));
}

/**
 * Puts a card into its owner's BANISHED zone — `PlayerState.banished`'s first
 * real writer.
 *
 * Distinct from the transient banish-and-play the pool is otherwise full of
 * (Baited Hook, Portal Rescue, Dazzling Aurora), where a card is banished and
 * replayed in ONE instruction and nothing can observe the intermediate zone —
 * those go straight to play and never come through here. This is for a card that
 * genuinely stays banished: Time Warp's "Banish this", which is what stops the
 * spell being recurred out of a trash for a second extra turn.
 *
 * Removes from wherever the card currently is — hand, trash, ACTIVE GEAR, or the
 * chain's already-trashed copy — so a caller does not have to know which. A card
 * that is in none of them is left alone rather than duplicated into the zone.
 *
 * **`activeGear` was added for The Zero Drive's "Banish this:" cost**, and it is
 * the first time this function has had to reach a permanent IN PLAY. It carries
 * the instance across rather than re-creating it, which is what preserves that
 * gear's `banishedInstanceIds` for the effect the cost is paying for. Deliberately
 * a plain move and not `killGear`: banishing is not killing, so no self-trigger
 * fires — see `ActivationCost.banishSelf`.
 */
export function banishCard(state: GameState, playerIndex: 0 | 1, cardInstanceId: string): GameState {
  const owner = state.players[playerIndex];
  const card =
    owner.hand.find((c) => c.instanceId === cardInstanceId) ??
    owner.trash.find((c) => c.instanceId === cardInstanceId) ??
    owner.activeGear.find((c) => c.instanceId === cardInstanceId) ??
    owner.banished.find((c) => c.instanceId === cardInstanceId);
  if (!card || owner.banished.some((c) => c.instanceId === cardInstanceId)) return state;

  return updatePlayer(state, playerIndex, (p) => ({
    ...p,
    hand: p.hand.filter((c) => c.instanceId !== cardInstanceId),
    trash: p.trash.filter((c) => c.instanceId !== cardInstanceId),
    activeGear: p.activeGear.filter((c) => c.instanceId !== cardInstanceId),
    banished: fileIntoNonBoardZone(p.banished, card),
  }));
}

/**
 * Moves a unit into `newControllerIndex`'s BASE and makes it theirs —
 * Possession's "take control of it and recall it".
 *
 * The pool's first change of a UNIT's controller, and the reason it is one
 * operation rather than a move plus a flag: control in this engine is WHICH
 * PLAYER'S LIST the unit sits in, so taking control IS relocating it, and doing
 * the two separately would leave a state where it is in nobody's.
 *
 * Note what that model implies and what the card gets away with: it takes
 * control permanently, and the unit stays the taker's for the rest of the game.
 * The rules' more general "gain control until end of turn" would need a real
 * controller field and a way back; this card says neither, so nothing here has to
 * express it.
 *
 * Recalled to base rather than left where it stood, which is the printed order —
 * and it matters, because leaving it at the battlefield would hand the taker a
 * body already contesting a fight it was defending an instant ago.
 */
/**
 * Takes control of a unit and LEAVES IT STANDING WHERE IT IS — Hostile
 * Takeover's "Take control of an enemy unit at a battlefield. Ready it. (Start a
 * combat if other enemies are there. Otherwise, conquer.)"
 *
 * The opposite half of `takeControlOfUnit` below, which recalls to base, and the
 * two must stay apart: the recall is what makes Possession safe, and the
 * PARENTHETICAL here is the whole card. A unit that changes hands at a
 * battlefield "otherwise becomes present" for its new controller (190.3.a), so
 * Contested is applied for them — which starts a combat when enemies are still
 * standing there and takes the battlefield when they are not.
 *
 * **Borrowed, not taken.** `returnControlAtEndOfTurnToIndex` records the original
 * owner so `runEnd` can hand it back; that field is the only thing this engine's
 * control model was missing, and see its own note for why.
 *
 * A unit in a BASE is refused rather than stolen in place, and that is the card
 * ("an enemy unit AT A BATTLEFIELD") rather than a limitation here: standing a
 * borrowed unit in the thief's base would contest nothing and score nothing.
 */
export function borrowUnitInPlace(state: GameState, targetInstanceId: string, newControllerIndex: 0 | 1): GameState {
  const location = findUnitOnBattlefield(state, targetInstanceId);
  if (!location || location.ownerIndex === newControllerIndex) return state;
  const { unit, ownerId, ownerIndex, battlefieldIndex } = location;
  const bf = state.battlefields[battlefieldIndex]!;
  const takerId = state.players[newControllerIndex].id;
  const battlefields = [...state.battlefields];
  battlefields[battlefieldIndex] = {
    ...bf,
    units: {
      ...bf.units,
      [ownerId]: (bf.units[ownerId] ?? []).filter((u) => u.instanceId !== targetInstanceId),
      // Buffs and damage survive, exactly as they do in `takeControlOfUnit`: the
      // unit changes hands, it is not reprinted (705 removes a Buff only on
      // LEAVING PLAY, and this never does).
      [takerId]: [...(bf.units[takerId] ?? []), { ...unit, returnControlAtEndOfTurnToIndex: ownerIndex }],
    },
  };
  // 190.3.a's "Moves **or otherwise becomes present**". Changing hands is the
  // second, which is the same reading `placeToken` takes for a token appearing at
  // a battlefield its controller does not control.
  return applyContested({ ...state, battlefields }, bf.id, newControllerIndex);
}

/**
 * Hands every borrowed unit back to its owner and recalls it — the second half
 * of Hostile Takeover, run by `runEnd`.
 *
 * "(Send it to base. This isn't a move.)" is the card's own parenthetical and it
 * is load-bearing twice over: it goes to the OWNER's base rather than the
 * thief's, and it is not a move, so it is `relocateToBaseUnchanged` rather than
 * `recallUnitToBase` — no move trigger fires, and Vilemaw's Lair's "units can't
 * move from here to base" does not stop it.
 *
 * Walks both players because a Hostile Takeover can be cast by either, and the
 * turn ending is not necessarily the caster's: the card is `[Hidden]`, so it is
 * cast as a Reaction on someone else's turn as often as not.
 */
export function returnBorrowedUnits(state: GameState): GameState {
  const borrowed = state.battlefields.flatMap((bf) =>
    state.players.flatMap((p) => (bf.units[p.id] ?? []).filter((u) => u.returnControlAtEndOfTurnToIndex !== undefined)),
  );
  return borrowed.reduce((next, unit) => {
    const ownerIndex = unit.returnControlAtEndOfTurnToIndex!;
    const removed = removeUnitAnywhere(next, unit.instanceId);
    // The obligation is cleared as it is discharged, so a unit stolen twice in
    // one game is not handed to the wrong player on the second turn.
    const { returnControlAtEndOfTurnToIndex: _returned, ...rest } = unit;
    return updatePlayer(removed, ownerIndex, (p) => ({ ...p, baseUnits: [...p.baseUnits, rest] }));
  }, state);
}

export function takeControlOfUnit(state: GameState, targetInstanceId: string, newControllerIndex: 0 | 1): GameState {
  const location = findUnitAnywhere(state, targetInstanceId);
  if (!location || location.ownerIndex === newControllerIndex) return state;
  const removed = removeUnitAnywhere(state, targetInstanceId);
  // Buffs survive (705 removes them only on LEAVING PLAY, and this never does),
  // and so does damage — the unit changes hands, it is not reprinted.
  return updatePlayer(removed, newControllerIndex, (p) => ({ ...p, baseUnits: [...p.baseUnits, location.unit] }));
}

/** Moves a unit from its battlefield to its OWNER's base, exhausted —
 *  "retreating costs your readiness," the same rule execute-recall-unit.ts
 *  already applies for the player-initiated RecallUnit action. Unlike that
 *  action (self-only, validated against the acting player), this works on
 *  either owner's units, since some card effects (Flash: friendly-only:
 *  Maddened Marauder: either owner) need to move a unit that isn't
 *  necessarily the caster's own.
 *
 *  NOTE: whether those two card effects should exhaust at all is an open
 *  question — rule 458.1 says a Recall leaves statuses untouched, and both cards
 *  say "move"/"to its base" without mentioning exhaustion. Filed as Unverified
 *  in docs/rules-conformance.md rather than changed on a guess. */
export function recallUnitToBase(state: GameState, targetInstanceId: string): GameState {
  const location = findUnitOnBattlefield(state, targetInstanceId);
  if (!location) return state;
  const { unit, ownerId, ownerIndex, battlefieldIndex } = location;

  const bf = state.battlefields[battlefieldIndex]!;
  // Vilemaw's Lair — "units can't move from here to base". Both cards that reach
  // this helper say MOVE (Flash: "move up to 2 friendly units to base"; Maddened
  // Marauder: "move a unit from a battlefield to its base"), which is exactly
  // what the Lair forbids. Doing as much as it can and no more is 055; the spell
  // still resolves. Combat's own step-3d recall goes through
  // `relocateToBaseUnchanged` and is deliberately NOT blocked — that is a step of
  // the Combat Cleanup rather than a move a player makes.
  if (!unitMayMoveToBase(state, unit, bf.id)) return state;
  const battlefields = [...state.battlefields];
  battlefields[battlefieldIndex] = {
    ...bf,
    units: { ...bf.units, [ownerId]: bf.units[ownerId]!.filter((u) => u.instanceId !== targetInstanceId) },
  };

  const players = [...state.players] as [PlayerState, PlayerState];
  players[ownerIndex] = { ...players[ownerIndex], baseUnits: [...players[ownerIndex].baseUnits, { ...unit, exhausted: true }] };
  return { ...state, battlefields, players };
}

/**
 * Readies a unit wherever it stands — First Mate's "ready another unit," which
 * names no battlefield and so reaches a unit in base too (this comment used to
 * say base units "aren't a target here... widen the search the day one does" —
 * this is that day).
 *
 * Readying an ALREADY-READY unit is now a no-op rather than a redundant rewrite,
 * and that is rule 415 rather than an optimisation: "A Unit that is already Ready
 * cannot be Readied again. If a Unit is instructed to be Readied while it is
 * already Ready, nothing additional happens." It is what makes the `unitReadied`
 * event below honest — Pirate's Haven must not pay out for a ready that the rules
 * say never happened, the same guard `addBuff` (702.3.a) and `stunUnits` (423) carry.
 */
export function readyUnit(state: GameState, targetInstanceId: string): GameState {
  const location = findUnitAnywhere(state, targetInstanceId);
  if (!location || !location.unit.exhausted) return state;
  // Mageseeker Warden — "spells and abilities can't ready enemy units and gear."
  // Read here rather than at each of the thirteen call sites, and that is exactly
  // what makes the exemption structural: `runAwaken` readies by its own inline
  // map and combat never calls this, so everything that DOES reach here is a
  // spell, an ability or a trigger. The survey said this needed source
  // attribution across the call sites; measured, it does not.
  if (!mayReadyPermanent(state, location.ownerIndex)) return state;
  // Maduli the Gatekeeper — "I can't be readied." The 415.3.b half; `runAwaken`
  // asks the same predicate for 415.3.a. Per-UNIT, so it is asked of the unit
  // rather than of its controller like the Warden's lock above.
  if (!unitMayBeReadied(location.unit)) return state;
  const readied = updateUnitAnywhere(state, targetInstanceId, (u) => ({ ...u, exhausted: false }));
  return holdEventTrigger(readied, { kind: "unitReadied", ownerIndex: location.ownerIndex, unitInstanceId: targetInstanceId });
}

/**
 * Readies ANY permanent a player controls — a unit in either zone, a Gear, or
 * the Legend.
 *
 * `readyUnit` above deliberately only knows about units, because every card that
 * says "ready a unit" means one. Miss Fortune - Captain says "something else
 * that's exhausted", naming no type at all, so she needs the wider reach — and
 * the Legend zone is not on the board, which is exactly the gap that made Legend
 * abilities unreachable before `findActivatable` learned about it.
 *
 * A UNIT readied through here routes to `readyUnit` rather than being handled by
 * the map below, so it fires `unitReadied` exactly as any other ready does.
 * Without that, Pirate's Haven would pay out for twelve of the pool's thirteen
 * ready effects and silently skip Miss Fortune's — the kind of gap that is
 * invisible in play because the card still resolves and nothing errors.
 */
export function readyPermanent(state: GameState, playerIndex: 0 | 1, instanceId: string): GameState {
  const asUnit = findUnitAnywhere(state, instanceId);
  if (asUnit && asUnit.ownerIndex === playerIndex) return readyUnit(state, instanceId);
  // The GEAR and Legend half of the Warden's lock — "enemy units AND GEAR".
  // Units come through `readyUnit` above, which asks the same question.
  if (!mayReadyPermanent(state, playerIndex)) return state;

  const ready = <T extends { instanceId: string; exhausted: boolean }>(c: T): T =>
    c.instanceId === instanceId ? { ...c, exhausted: false } : c;

  const players = [...state.players] as [PlayerState, PlayerState];
  const actor = players[playerIndex];
  players[playerIndex] = {
    ...actor,
    activeGear: actor.activeGear.map(ready),
    legend: ready(actor.legend),
  };
  return { ...state, players };
}

/**
 * Swaps two of a player's own units between wherever each of them is —
 * Tideturner's "Move me to its location and it to my original location".
 *
 * One operation rather than two moves, and that is required rather than tidy:
 * done as two `forceMoveToBattlefield` calls the first would vacate the square
 * the second needs to read, and a unit swapping with one in BASE has no
 * battlefield to be moved to at all.
 *
 * No-ops when either unit is missing, when they are the same unit, or when both
 * are already in the same place — "ANOTHER location" is printed, and a swap
 * within one location is not a move.
 *
 * Contested is applied for each unit that lands on a battlefield, for the same
 * reason `forceMoveToBattlefield` does it (458): arriving somewhere the
 * controller does not hold contests it.
 */
export function swapUnitLocations(
  state: GameState,
  playerIndex: 0 | 1,
  firstInstanceId: string,
  secondInstanceId: string,
): GameState {
  if (firstInstanceId === secondInstanceId) return state;
  const first = findUnitAnywhere(state, firstInstanceId);
  const second = findUnitAnywhere(state, secondInstanceId);
  if (!first || !second) return state;
  if (first.ownerIndex !== playerIndex || second.ownerIndex !== playerIndex) return state;

  const placeOf = (zone: typeof first.zone) => (zone === "base" ? "base" : state.battlefields[zone.battlefieldIndex]!.id);
  const firstPlace = placeOf(first.zone);
  const secondPlace = placeOf(second.zone);
  if (firstPlace === secondPlace) return state; // "another location"

  const removed = removeUnitAnywhere(removeUnitAnywhere(state, firstInstanceId), secondInstanceId);
  const put = (s: GameState, unit: UnitInstance, place: string): GameState => {
    if (place === "base") {
      return updatePlayer(s, playerIndex, (p) => ({ ...p, baseUnits: [...p.baseUnits, unit] }));
    }
    const index = s.battlefields.findIndex((bf) => bf.id === place);
    const bf = s.battlefields[index]!;
    const battlefields = [...s.battlefields];
    const ownerId = s.players[playerIndex].id;
    battlefields[index] = { ...bf, units: { ...bf.units, [ownerId]: [...(bf.units[ownerId] ?? []), unit] } };
    return { ...s, battlefields };
  };

  // Each ends up where the other was.
  let next = put(put(removed, first.unit, secondPlace), second.unit, firstPlace);
  for (const place of [firstPlace, secondPlace]) {
    if (place !== "base") next = applyContested(next, place, playerIndex);
  }
  return next;
}

/** Deals `amount` damage to every enemy (relative to `casterIndex`) unit at
 *  one battlefield — Firestorm's "all enemy units at a battlefield." Reads
 *  the unit list ONCE up front so units killed by an earlier iteration
 *  don't shrink the list mid-loop (dealDamage is safe to call on an
 *  already-removed id — it just no-ops via findUnitOnBattlefield). */
export function dealDamageToEnemyUnitsAtBattlefield(
  state: GameState,
  casterIndex: 0 | 1,
  battlefieldId: string,
  amount: number,
): GameState {
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  if (!bf) return state;
  const casterId = state.players[casterIndex].id;
  const targetIds = Object.entries(bf.units)
    .filter(([ownerId]) => ownerId !== casterId)
    .flatMap(([, units]) => units.map((u) => u.instanceId));

  let next = state;
  for (const id of targetIds) next = dealDamage(next, casterIndex, id, amount);
  return next;
}

/** Deals `amount` damage to every unit at every battlefield, both owners —
 *  Tibbers' "deal 3 to all units at battlefields." Same up-front-snapshot
 *  reasoning as dealDamageToEnemyUnitsAtBattlefield. */
export function dealDamageToAllUnitsAtAllBattlefields(state: GameState, casterIndex: 0 | 1, amount: number): GameState {
  const targetIds = state.battlefields.flatMap((bf) => Object.values(bf.units).flatMap((units) => units.map((u) => u.instanceId)));
  let next = state;
  for (const id of targetIds) next = dealDamage(next, casterIndex, id, amount);
  return next;
}

/** Moves a card from `playerIndex`'s own trash to their own hand — Morbid
 *  Return ("a unit from your trash") and Annie-Stubborn's on-play trigger
 *  ("a spell from your trash"). Resets a returned Unit's damage / this-turn
 *  Might / Buff / exhausted (same "leaving play, may be replayed fresh"
 *  reasoning as returnUnitToHand) — a Spell has no such fields to reset.
 *  No-ops if the card isn't in that player's trash. */
export function returnCardFromTrash(state: GameState, playerIndex: 0 | 1, cardInstanceId: string): GameState {
  const actor = state.players[playerIndex];
  const card = actor.trash.find((c) => c.instanceId === cardInstanceId);
  if (!card) return state;

  const returned = card.kind === "Unit" ? { ...card, damage: 0, mightThisTurn: 0, buffed: false, exhausted: false } : card;
  const players = [...state.players] as [PlayerState, PlayerState];
  players[playerIndex] = {
    ...actor,
    trash: actor.trash.filter((c) => c.instanceId !== cardInstanceId),
    hand: [...actor.hand, returned],
  };
  return { ...state, players };
}

/** "Give ME +N Might this turn" for a unit that might be in base OR at a
 *  battlefield — the shape self-buffing listeners need (Ravenbloom Student,
 *  Lux - Illuminated, Dune Drake), which can legitimately sit in either zone.
 *  The only thing this adds over giveMightThisTurn is the ownership check: it
 *  refuses to move an opponent's unit, since every caller's printed text says
 *  "me" or "a friendly unit". */
export function giveMightThisTurnToOwnUnit(state: GameState, playerIndex: 0 | 1, unitInstanceId: string, amount: number): GameState {
  const actor = state.players[playerIndex];
  const owned =
    actor.baseUnits.some((u) => u.instanceId === unitInstanceId) ||
    state.battlefields.some((bf) => (bf.units[actor.id] ?? []).some((u) => u.instanceId === unitInstanceId));
  return owned ? giveMightThisTurn(state, unitInstanceId, amount) : state;
}

/**
 * Exhausts a Gear its owner controls — the exhaust that is a TRIGGER's cost
 * rather than an activated ability's ("you may exhaust this to draw 1", Solari
 * Shrine).
 *
 * Distinct from `activated-abilities.exhaustActivated`, which is reached through
 * an ActivateAbility action and covers all three zones a source can sit in. A
 * trigger has no action, so it cannot go through that path at all; this is the
 * gear-only counterpart. No-ops if the gear is not in play or is already
 * exhausted, so a caller cannot pay the cost twice.
 */
export function exhaustGear(state: GameState, playerIndex: 0 | 1, gearInstanceId: string): GameState {
  const owner = state.players[playerIndex];
  if (!owner.activeGear.some((g) => g.instanceId === gearInstanceId && !g.exhausted)) return state;
  return updatePlayer(state, playerIndex, (p) => ({
    ...p,
    activeGear: p.activeGear.map((g) => (g.instanceId === gearInstanceId ? { ...g, exhausted: true } : g)),
  }));
}

/** Exhausts a unit `playerIndex` owns, wherever it is (base or a
 *  battlefield) — Meditation's optional additional cost ("exhaust a
 *  friendly unit"), which unlike most targeted effects in this codebase
 *  isn't restricted to battlefield-only. No-ops if not found in either of
 *  that player's own zones. */
export function exhaustOwnUnitAnywhere(state: GameState, playerIndex: 0 | 1, unitInstanceId: string): GameState {
  const actor = state.players[playerIndex];
  const inBase = actor.baseUnits.some((u) => u.instanceId === unitInstanceId);
  if (inBase) {
    const players = [...state.players] as [PlayerState, PlayerState];
    players[playerIndex] = {
      ...actor,
      baseUnits: actor.baseUnits.map((u) => (u.instanceId === unitInstanceId ? { ...u, exhausted: true } : u)),
    };
    return { ...state, players };
  }
  const location = findUnitOnBattlefield(state, unitInstanceId);
  if (!location || location.ownerIndex !== playerIndex) return state;
  const { ownerId, battlefieldIndex } = location;
  const bf = state.battlefields[battlefieldIndex]!;
  const battlefields = [...state.battlefields];
  battlefields[battlefieldIndex] = {
    ...bf,
    units: { ...bf.units, [ownerId]: bf.units[ownerId]!.map((u) => (u.instanceId === unitInstanceId ? { ...u, exhausted: true } : u)) },
  };
  return { ...state, battlefields };
}

/**
 * Records that `modeId` has been used by the source at `instanceId`, so "one you
 * haven't chosen this turn" holds.
 *
 * **Here rather than in `activated-abilities.ts`, and that is load-bearing.**
 * Two callers need it and they cannot both reach that module: Aphelios -
 * Exalted asks it from `effects/calm.ts`, and a domain effects file importing
 * activated-abilities closes an import cycle. The symptom was not a stack trace
 * — it was `[GOLD_TOKEN_DEF_ID]` reading as `undefined` while that table's
 * object literal was built, so the Gold token's printed ability registered
 * under the key "undefined" and the token silently had no ability at all.
 * A leaf both callers already import is the same answer `MIGHTY_THRESHOLD` and
 * `isMechDef` took to the same problem.
 *
 * The record lives on the UNIT instance and `turn-manager`'s runEnd clears it
 * for every unit on both sides, so a trigger-reached mode needs no reset of its
 * own.
 */
export function recordModeUsed(state: GameState, playerIndex: 0 | 1, instanceId: string, modeId: string): GameState {
  const remember = <T extends { instanceId: string; abilityModesUsedThisTurn?: string[] }>(c: T): T =>
    c.instanceId === instanceId ? { ...c, abilityModesUsedThisTurn: [...(c.abilityModesUsedThisTurn ?? []), modeId] } : c;

  const players = [...state.players] as [PlayerState, PlayerState];
  const actor = players[playerIndex];
  players[playerIndex] = { ...actor, baseUnits: actor.baseUnits.map(remember) };
  const battlefields = state.battlefields.map((bf) => {
    const mine = bf.units[actor.id];
    return mine ? { ...bf, units: { ...bf.units, [actor.id]: mine.map(remember) } } : bf;
  });
  return { ...state, players, battlefields };
}
