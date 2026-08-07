import type { GameState, PlayerState } from "../model/game-state.js";
import { mayPlaceWithoutPresence, targetingForAnyCard, unitTriggerHasVisionChoice } from "../engine/unit-triggers.js";
import {
  findUnitAnywhere,
  eligibleTargets,
  unchooseableAmong,
  findUnitInScope,
  findUnitOnBattlefield,
  hasAnyLegalEffectChoice,
  scopeDescription,
  shareABattlefield,
  unitListChoiceError,
  gearTargets,
  unitOrGearTargets,
  unitSatisfiesAttackingOnly,
  unitWithinMaxMight,
} from "../engine/target-lookup.js";
import type { TargetScope, UnitSlotRole } from "../engine/card-effects.js";
import type { UnitInstance } from "../model/card.js";
import { computeEffectiveCost, matchesPowerDomain, restrictedPowerFor } from "../engine/rune-payment.js";
import { secondTargetIsAtDestination } from "../engine/legal-actions.js";
import { chosenUnitsOfPlay, chosenUnitsOfRepeat, deflectSurchargeForTargets } from "../engine/granted-keywords.js";
import { modifiedEnergyCost, modifiedRepeatEnergy, optionalCostDiscount, targetChoiceDiscount, scaledPowerDiscount } from "../engine/cost-modifiers.js";
import {
  cardModesOf,
  cardMovesTarget,
  cardPlacesTokens,
  moveDestinationAllowed,
  discardChoiceOf,
  hasXRainbowCost,
  optionalPowerCostOf,
  optionalUnitCostOf,
  grantedRepeatCostOf,
  repeatCostOf,
  slotScope,
  costNamesGear,
  type OptionalUnitCost,
} from "../engine/card-effects.js";
import type { PlayCardAction } from "./player-action.js";
import { fail, ok, type ValidationResult } from "./validation-result.js";
import {
  ACCELERATE_ENERGY,
  ACCELERATE_POWER,
  acceleratePowerDomain,
  hasAccelerate,
  mayPlayUnitToBase,
  mayPlayUnitToBattlefield,
  timingRejection,
} from "../engine/timing.js";
import { hiddenCardAt, hiddenCardIsPlayable } from "../engine/hidden.js";
import { mayPlayUnitAt } from "../engine/battlefield-continuous.js";
import { counterFilter, counterableSpells } from "../engine/counter-spell.js";

/**
 * Validates a PlayCard action for a Unit/Spell/Gear, with a rune payment
 * sized to the floating-reduced (effective) cost — no Accelerate or other
 * additional costs. Mirrors the relevant slice of ActionValidator.java's
 * PlayCard checks and ActionExecutor.java's `isValidPayment`
 * (engine/ActionExecutor.java:1492-1513) plus energyAfterFloat/
 * powerAfterFloat for the floating-resource reduction.
 *
 * Not yet implemented: Legend plays, Accelerate/additional costs, trash-play.
 *
 * Timing (which states each card may be played in) is delegated wholesale to
 * engine/timing.ts, which reads the printed [Action]/[Reaction] keywords —
 * mirroring ActionValidator.validateShowdownOpen alongside the plain path
 * rather than, as before, rejecting every Showdown and closed-chain play
 * outright.
 *
 * Targeting is validated for registered card-effects.ts effects whose
 * TargetingSpec.kind is "unit" — every such card in this slice restricts
 * to "a unit at a battlefield," so the check is just findUnitOnBattlefield
 * returning something. Cards with no registered effect, or a "none"-kind
 * one, skip this entirely.
 */
/**
 * The checks that only apply to a card played FROM facedown (rule 811).
 *
 * Origin is the first of them and it replaces the ordinary hand/Champion-Zone
 * check entirely: the card is at a battlefield, not in either of those zones, so
 * the normal origin test below would reject every from-hidden play.
 */
function hiddenPlayRejection(state: GameState, action: PlayCardAction): string | null {
  const hidden = hiddenCardAt(state, action.fromHiddenBattlefieldId!, action.playerIndex);
  if (!hidden || hidden.card.instanceId !== action.card.instanceId) {
    return `${action.card.name} is not hidden at that battlefield`;
  }
  // "Beginning on the NEXT turn" — 811. Hiding and playing in one turn would
  // make the keyword a pure discount rather than a commitment.
  if (!hiddenCardIsPlayable(state, hidden, action.fromHiddenBattlefieldId!)) {
    return `${action.card.name} cannot be played from hidden here — it was hidden this turn, or an enemy Noxus Saboteur is at that battlefield`;
  }
  // Every target must come from that battlefield, PER TARGET (811). Checked
  // against the same predicate legal-actions enumerates from, so a from-hidden
  // play can never be offered and then refused.
  for (const targetId of [action.targetUnitInstanceId, action.secondTargetUnitInstanceId, ...(action.targetUnitInstanceIds ?? [])]) {
    if (targetId === undefined) continue;
    if (!isAtBattlefield(state, targetId, action.fromHiddenBattlefieldId!)) {
      return `${action.card.name} was played from hidden, so its targets must be at that battlefield`;
    }
  }
  if (action.targetBattlefieldId !== undefined && action.targetBattlefieldId !== action.fromHiddenBattlefieldId) {
    return `${action.card.name} was played from hidden, so it must target that battlefield`;
  }
  return null;
}

/** Is this unit standing at that specific battlefield? */
function isAtBattlefield(state: GameState, unitInstanceId: string, battlefieldId: string): boolean {
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  return Object.values(bf?.units ?? {}).some((list) => list.some((u) => u.instanceId === unitInstanceId));
}

/** Why this unit cannot pay an additional cost of `kind`, or null when it can.
 *
 *  Extracted so the single-unit and the REPEATABLE branches ask exactly the same
 *  three questions — ownership, then the eligibility that differs per kind. Two
 *  copies is how a repeatable Kraken Hunter would come to accept an unbuffed
 *  unit that the single-unit path already rejects. */
function additionalCostRejection(
  state: GameState,
  action: PlayCardAction,
  cardName: string,
  kind: OptionalUnitCost,
  id: string,
): string | null {
  const actor = state.players[action.playerIndex]!;
  const inBase = actor.baseUnits.find((u) => u.instanceId === id);
  const atBattlefield = inBase ? undefined : findUnitOnBattlefield(state, id);
  const owned = inBase !== undefined || (atBattlefield !== undefined && atBattlefield.ownerIndex === action.playerIndex);
  const unit = inBase ?? atBattlefield?.unit;
  if (!unit || !owned) return `${cardName}'s additional cost requires a friendly unit you control`;
  if (kind === "exhaustReadyFriendly" && unit.exhausted) return `${cardName}'s additional cost requires a READY friendly unit`;
  if (kind === "spendBuffFriendly" && !unit.buffed) return `${cardName}'s additional cost requires a BUFFED friendly unit (rule 705)`;
  return null;
}

/**
 * One execution's worth of chosen targets — everything the targeting checks
 * below read. `PlayCardAction` satisfies it structurally, and so does a
 * `[Repeat]`'s second choice set.
 */
interface TargetChoices {
  targetUnitInstanceId?: string;
  secondTargetUnitInstanceId?: string;
  targetUnitInstanceIds?: readonly string[];
  targetBattlefieldId?: string;
  targetPermanentInstanceId?: string;
  trashCardInstanceId?: string;
  targetChainCardInstanceId?: string;
  destinationBattlefieldId?: string;
}

/**
 * Why this choice set is not a legal set of targets for `targeting`, or null.
 *
 * Extracted from the body of `validatePlayCard` so that `[Repeat]`'s SECOND
 * execution is checked by the very same code as the first (820.1.d: "choices
 * must be made at the usual time during the Make Relevant Choices step" — the
 * same choices, so the same rules). A second copy of these checks is precisely
 * how a repeat would come to accept a target the first execution rejects, which
 * is the drift `slotScope`'s own comment records this file having suffered.
 */
function targetingRejection(
  state: GameState,
  playerIndex: 0 | 1,
  cardName: string,
  targeting: ReturnType<typeof targetingForAnyCard>,
  choices: TargetChoices,
): string | null {
  if (targeting.kind === "unit") {
    if (!choices.targetUnitInstanceId) {
      return `${cardName} requires a target unit`;
    }
    // Which lookup depends on the card's own text: "a unit" reaches base,
    // "a unit at a battlefield" does not. Must match legal-actions.ts's
    // enumeration exactly, or the UI offers clicks this then rejects.
    const location = findUnitInScope(state, choices.targetUnitInstanceId, targeting.scope);
    if (!location) {
      return `No unit with id ${choices.targetUnitInstanceId} found ${scopeDescription(targeting.scope)}`;
    }
    if (targeting.owner === "friendly" && location.ownerIndex !== playerIndex) {
      return `${cardName} can only target a friendly unit`;
    }
    if (targeting.owner === "enemy" && location.ownerIndex === playerIndex) {
      return `${cardName} can only target an enemy unit`;
    }
    if (!unitWithinMaxMight(state, location.unit, targeting.maxMight)) {
      return `${cardName} can only target a unit with ${targeting.maxMight} Might or less`;
    }
    if (!unitSatisfiesAttackingOnly(state, location.unit, targeting.attackingOnly)) {
      return `${cardName} can only target an ATTACKING unit`;
    }
  } else if (targeting.kind === "battlefield") {
    if (!choices.targetBattlefieldId) {
      return `${cardName} requires a target battlefield`;
    }
    if (!state.battlefields.some((bf) => bf.id === choices.targetBattlefieldId)) {
      return `No battlefield with id ${choices.targetBattlefieldId}`;
    }
  } else if (targeting.kind === "unitOrGear") {
    if (!choices.targetPermanentInstanceId) {
      return `${cardName} requires a target unit or gear`;
    }
    if (!unitOrGearTargets(state).some((t) => t.instanceId === choices.targetPermanentInstanceId)) {
      return `${choices.targetPermanentInstanceId} is not a unit at a battlefield or a gear in play`;
    }
  } else if (targeting.kind === "gear") {
    if (!choices.targetPermanentInstanceId) {
      return `${cardName} requires a target gear`;
    }
    if (!gearTargets(state).some((t) => t.instanceId === choices.targetPermanentInstanceId)) {
      return `${choices.targetPermanentInstanceId} is not a gear in play`;
    }
  } else if (targeting.kind === "ownTrashCard") {
    if (!choices.trashCardInstanceId) {
      return `${cardName} requires a card from your trash`;
    }
    const actor = state.players[playerIndex]!;
    const trashCard = actor.trash.find((c) => c.instanceId === choices.trashCardInstanceId);
    if (!trashCard) {
      return `No card with id ${choices.trashCardInstanceId} found in ${actor.name}'s trash`;
    }
    if (targeting.cardKind !== undefined && trashCard.kind !== targeting.cardKind) {
      return `${cardName} can only return a ${targeting.cardKind} from your trash, not a ${trashCard.kind}`;
    }
  } else if (targeting.kind === "chainSpell") {
    if (!choices.targetChainCardInstanceId) {
      return `${cardName} requires a spell on the chain to target`;
    }
    // Asked through the same predicate the enumerator fans out from, so a cost
    // filter can never offer a target it then refuses. The cost is the target's
    // PRINTED one — see counterableSpells.
    const counterable = counterableSpells(state, targeting.maxPrintedEnergy, targeting.maxPrintedPower, counterFilter(targeting, playerIndex));
    if (!counterable.some(({ entry }) => entry.card.instanceId === choices.targetChainCardInstanceId)) {
      return `${cardName} cannot target that spell`;
    }
  } else if (targeting.kind === "chainSpellAndUnit") {
    // Both halves are mandatory — Riposte names two targets in one sentence, and
    // a play carrying only one of them is not a legal announcement.
    if (!choices.targetChainCardInstanceId) {
      return `${cardName} requires a spell on the chain to target`;
    }
    if (!choices.targetUnitInstanceId) {
      return `${cardName} requires a target unit`;
    }
    const counterable = counterableSpells(state, targeting.maxPrintedEnergy, targeting.maxPrintedPower);
    if (!counterable.some(({ entry }) => entry.card.instanceId === choices.targetChainCardInstanceId)) {
      return `${cardName} cannot target that spell`;
    }
    // Asked through `eligibleTargets` rather than this file's own
    // `findUnitInScope` + owner checks, because that is the helper the
    // ENUMERATOR uses for this kind. Two spellings of the same rule is exactly
    // how the two gates have drifted apart here before.
    if (
      !eligibleTargets(state, playerIndex, targeting.owner, targeting.scope).some(
        (u) => u.instanceId === choices.targetUnitInstanceId,
      )
    ) {
      return `${cardName} cannot target that unit`;
    }
  } else if (targeting.kind === "unitList") {
    // Accepts ANY legal set, not only the ones `legal-actions` sampled — that
    // asymmetry is the point of the announce-time design: the enumeration is
    // bounded for the AI's sake, and a human clicking a combination the sampler
    // never emitted must still be able to cast the card.
    const chosen = choices.targetUnitInstanceIds ?? [];
    const error = unitListChoiceError(state, playerIndex, targeting, chosen);
    if (error) return `${cardName} ${error}`;
  } else if (targeting.kind === "unitSlots") {
    const chosen = [choices.targetUnitInstanceId, choices.secondTargetUnitInstanceId];
    const filled = chosen.filter((id): id is string => id !== undefined);

    if (filled.length < targeting.min) {
      return `${cardName} requires ${targeting.min} target unit${targeting.min === 1 ? "" : "s"}`;
    }
    // Slots fill in order, so a second target with no first would leave the
    // slot-0 role unchecked — and legal-actions never enumerates that shape.
    if (choices.targetUnitInstanceId === undefined && choices.secondTargetUnitInstanceId !== undefined) {
      return `${cardName}'s second target requires a first target`;
    }
    if (filled.length === 2 && filled[0] === filled[1]) {
      return `${cardName} requires two different units`;
    }

    const roleHolds = (ownerIndex: 0 | 1, role: UnitSlotRole) =>
      role === "any" ? true : role === "friendly" ? ownerIndex === playerIndex : ownerIndex !== playerIndex;

    for (const [slot, id] of chosen.entries()) {
      if (id === undefined) continue;
      // Per SLOT, not per spec: Zenith Blade's first target is "at a
      // battlefield" and its second is not. Reading the spec-wide scope for both
      // would refuse the friendly-in-base target legal-actions offered.
      const scope = slotScope(targeting, slot as 0 | 1);
      const location = findUnitInScope(state, id, scope);
      if (!location) return `No unit with id ${id} found ${scopeDescription(scope)}`;
      const role = targeting.slots[slot]!;
      if (!roleHolds(location.ownerIndex, role)) {
        return `${cardName}'s ${slot === 0 ? "first" : "second"} target must be ${role}`;
      }
    }

    // Facebreaker's "at the same battlefield" — a relation between the two
    // targets, so it cannot be checked slot by slot above. Asked through the
    // same helper legal-actions' fan-out uses, so "offered" and "legal" cannot
    // drift apart.
    if (targeting.sameBattlefield && filled.length === 2 && !shareABattlefield(state, filled[0]!, filled[1]!)) {
      return `${cardName} requires two units at the same battlefield`;
    }
    // Dragon's Rage — the second target must stand where the first is GOING, not
    // where it is now. Asked through the same predicate the enumerator filters
    // with, so the pair cannot drift.
    if (!secondTargetIsAtDestination(state, targeting, choices)) {
      return `${cardName} requires its second target at the first one's destination`;
    }
  }
  return null;
}

export function validatePlayCard(state: GameState, action: PlayCardAction): ValidationResult {
  if (state.phase !== "Action") {
    return fail(`Cards can only be played during the Action phase, currently: ${state.phase}`);
  }
  // Three separate hard gates used to live here — "must be the active player",
  // "turnState must be Neutral" and "chain must be open" — which together barred
  // every Showdown and reaction-speed play. All three are really one question,
  // asked per card because the answer depends on its printed timing: see
  // engine/timing.ts for the tiers and the rules behind them.
  const fromHidden = action.fromHiddenBattlefieldId !== undefined;
  const rejection = timingRejection(state, action.playerIndex, action.card, fromHidden);
  if (rejection !== null) return fail(rejection);

  if (fromHidden) {
    const hiddenRejection = hiddenPlayRejection(state, action);
    if (hiddenRejection !== null) return fail(hiddenRejection);
  }

  const actor: PlayerState | undefined = state.players[action.playerIndex];
  if (!actor) return fail(`No player at index ${action.playerIndex}`);

  const { card, payment } = action;

  // Rule 813's destination restriction for a Unit played outside a Neutral Open
  // state — shared with legal-actions so enumeration can't offer a destination
  // this then refuses (see mayPlayUnitToBattlefield).
  // 811 exempts a from-hidden unit from 813 — see the enumerator, which applies
  // the same exemption, and the placement check further down for the rest of it.
  if (
    card.kind === "Unit" &&
    action.fromHiddenBattlefieldId === undefined &&
    action.destinationBattlefieldId !== undefined &&
    !mayPlayUnitToBattlefield(state, action.playerIndex, action.destinationBattlefieldId, card.defId)
  ) {
    return fail(`${card.name} can only be played to your base or a battlefield you control while a Showdown is open`);
  }
  // Perched Grimwyrm's "(You can't play me anywhere else.)" — the parenthetical
  // makes the narrowing TOTAL, so BASE is refused as well. A separate check from
  // the destination gate above, which only ever sees a named battlefield: a base
  // play carries no `destinationBattlefieldId` at all.
  if (card.kind === "Unit" && action.destinationBattlefieldId === undefined && !mayPlayUnitToBase(card.defId)) {
    return fail(`${card.name} can only be played to a battlefield you conquered this turn`);
  }

  // A card is playable from hand OR from the Champion Zone (the one
  // champion copy set aside at deck-build time) — mirrors
  // ActionValidator.validatePlayCard's `inHand || isChampion` origin check
  // (engine/ActionValidator.java:1126-1138). Without this, a deck's
  // champion could never actually enter play at all. `isChampion` is
  // structurally always false for a Spell/Gear instance — championZone is
  // typed UnitInstance | null, so a Spell/Gear instanceId can never match it.
  const inHand = actor.hand.some((c) => c.instanceId === card.instanceId);
  const isChampion = actor.championZone?.instanceId === card.instanceId;
  // A from-hidden card is in neither zone — it's facedown at a battlefield, and
  // hiddenPlayRejection above has already confirmed it's really there.
  if (!fromHidden && !inHand && !isChampion) {
    return fail(`${card.name} is not in ${actor.name}'s hand or Champion Zone`);
  }

  if (card.kind === "Legend") {
    return fail("PlayCard is not implemented for Legend cards");
  }

  // A MODAL card's targeting belongs to the chosen mode — Rocket Barrage's two
  // modes name a unit and a gear respectively, so there is no single spec that
  // describes the card. Resolve the mode BEFORE anything reads a targeting spec.
  const modes = card.kind === "Unit" ? [] : cardModesOf(card);
  if (modes.length > 1) {
    if (action.modeId === undefined) return fail(`${card.name} requires a mode to be chosen`);
    if (!modes.some((m) => m.id === action.modeId)) return fail(`${card.name} has no mode "${action.modeId}"`);
  } else if (action.modeId !== undefined) {
    // Naming a mode on a card that has none would be silently ignored at
    // resolution — the dropped-field shape this pipeline keeps producing.
    return fail(`${card.name} is not modal`);
  }
  const targeting = targetingForAnyCard(card, action.modeId);

  // A Unit's targeting belongs to its on-play TRIGGER, which does as much as
  // it can and no more: with nothing legal to point at, the unit is still
  // played and the trigger simply doesn't fire (Annie-Stubborn with an empty
  // trash, First Mate as your first unit, Maddened Marauder on an empty
  // board). Only ever permitted when the board really offers no choice —
  // otherwise a caster could dodge a mandatory trigger by omitting the field.
  // A Spell's targeting is its whole effect, so this never applies there.
  const targetOmissionAllowed = card.kind === "Unit" && !hasAnyLegalEffectChoice(state, action.playerIndex, targeting);
  // Nothing was chosen AND nothing could have been — skip the targeting
  // checks only (never the payment/destination/Vision ones below).
  const omitted =
    targetOmissionAllowed &&
    action.targetUnitInstanceId === undefined &&
    action.secondTargetUnitInstanceId === undefined &&
    // A `unitList` play that named targets is NOT an omission, even an empty one:
    // "any number" chooses zero deliberately, and treating that as "nothing was
    // chosen" would skip the group checks below entirely.
    action.targetUnitInstanceIds === undefined &&
    action.trashCardInstanceId === undefined;

  // Both `[Repeat]` executions are checked by ONE function, so the second can
  // never accept a target the first rejects — see targetingRejection.
  if (!omitted) {
    const targetError = targetingRejection(state, action.playerIndex, card.name, targeting, action);
    if (targetError !== null) return fail(targetError);
  }

  // `[Repeat]` (820.1). Three separate questions, and they fail differently.
  const repeatCost = repeatCostOf(card.defId);
  // Temporal Portal's GRANTED instance, priced from the card's PRINTED cost.
  // Re-derived from state rather than trusted from the action: a client could
  // otherwise claim a grant it never armed and buy a second execution for the
  // repeat's price alone.
  const grantedRepeatCost = grantedRepeatCostOf(card, actor.nextSpellRepeatGrants);
  if (action.grantedRepeatPaid && grantedRepeatCost === undefined) {
    return fail(`${card.name} has no granted [Repeat] to pay for`);
  }
  if (action.repeatPaid && repeatCost === undefined) {
    return fail(`${card.name} does not have [Repeat]`);
  }
  // Choices for a repeat that was never paid for are not a smaller mistake than
  // paying without choosing — they would be silently ignored at resolution,
  // which is exactly the class of dropped-field bug this pipeline has shipped.
  if (action.repeatChoices !== undefined && !action.repeatPaid) {
    return fail(`${card.name} named [Repeat] choices without paying its [Repeat] cost`);
  }
  // 820.1.d's second execution names its OWN targets, checked by the same
  // function as the first. `undefined` is legal and means "the same choices
  // again" — see RepeatChoices.
  if (action.repeatPaid && action.repeatChoices !== undefined) {
    // **The repeat may switch MODES**, and if it does its targets are checked
    // against THAT mode's spec — 820.1.d works the example on Rocket Barrage:
    // "they may choose the same mode or a different one". Validating a
    // mode-switched repeat against the first mode's targeting would refuse a
    // legal play (a gear named where the first mode wanted a unit) and accept an
    // illegal one.
    const repeatModeId = action.repeatChoices.modeId;
    if (repeatModeId !== undefined) {
      if (modes.length <= 1) return fail(`${card.name} is not modal, so its [Repeat] cannot choose a mode`);
      if (!modes.some((m) => m.id === repeatModeId)) return fail(`${card.name} has no mode "${repeatModeId}"`);
    }
    const repeatTargeting = targetingForAnyCard(card, repeatModeId ?? action.modeId);
    const repeatError = targetingRejection(state, action.playerIndex, card.name, repeatTargeting, action.repeatChoices);
    if (repeatError !== null) return fail(`${card.name}'s [Repeat] execution: ${repeatError}`);
  }

  // Board-aware, and it must stay the SAME question `legal-actions` asks: a
  // Gemcraft Seer in play makes every other unit's play need a recycle choice,
  // and an enumerator and a validator disagreeing about that is the
  // offered-then-refused shape this codebase has shipped three times.
  if (card.kind === "Unit" && unitTriggerHasVisionChoice(state, action.playerIndex, card.defId) && action.visionRecycle === undefined) {
    return fail(`${card.name}'s [Vision] requires a recycle choice (true or false)`);
  }

  // Meditation's optional additional cost: absent means the caster
  // declined it (still legal — "otherwise draw 1"); if present, must be a
  // READY unit the caster actually controls, base or battlefield (unlike
  // most "unit" targeting above, not battlefield-only — see
  // exhaustOwnUnitAnywhere's own doc comment).
  // Units as well as Spells — see card-effects.ts's OPTIONAL_UNIT_COSTS for why
  // the `card.kind === "Spell"` gate that used to be here was wrong.
  const optionalCost = optionalUnitCostOf(card.defId);
  // A MANDATORY additional cost has to be named. Rule 355.11 keeps it a cost
  // rather than a target, but unlike an optional one there is no declining it —
  // Cruel Patron with nothing of yours to kill is simply unplayable.
  // A GEAR-valued cost rides its own field, so "was it paid" is a different
  // question — asked through `costNamesGear` rather than by each site guessing.
  const costWantsGear = optionalCost !== undefined && costNamesGear(optionalCost.kind);
  if (optionalCost?.mandatory && costWantsGear && action.additionalCostPermanentInstanceId === undefined) {
    return fail(`${card.name} requires a friendly gear as an additional cost`);
  }
  if (optionalCost?.mandatory && !costWantsGear && action.additionalCostUnitInstanceId === undefined) {
    return fail(`${card.name} requires a friendly unit as an additional cost`);
  }
  // The named gear has to be one the caster actually controls. "Friendly" is the
  // whole eligibility test for both cards — neither asks it to be ready, or
  // attached, or anything else.
  if (costWantsGear && action.additionalCostPermanentInstanceId !== undefined) {
    const owned = actor.activeGear.some((g) => g.instanceId === action.additionalCostPermanentInstanceId);
    if (!owned) return fail(`${card.name}'s additional cost requires a friendly gear you control`);
  }
  // A REPEATABLE cost names a SET, and every member has to be separately
  // eligible — the same three checks the single-unit branch below makes, applied
  // per unit rather than once. Accepts any legal set, not only the ones
  // `legal-actions` sampled: the sampler picks weakest-first, and a player
  // deliberately killing a big body must not be refused for it.
  if (optionalCost?.repeatable && action.additionalCostUnitInstanceIds !== undefined) {
    const chosen = action.additionalCostUnitInstanceIds;
    if (new Set(chosen).size !== chosen.length) {
      return fail(`${card.name} cannot spend the same unit twice`);
    }
    for (const id of chosen) {
      const rejection = additionalCostRejection(state, action, card.name, optionalCost.kind, id);
      if (rejection !== null) return fail(rejection);
    }
    // "Reduce my cost by [1 Power] for each" cannot take a cost below zero, so
    // spending past the printed Power buys nothing — and offering it would be
    // offering a strictly worse play the enumerator never emits.
    if (chosen.length > card.powerCost) {
      return fail(`${card.name} can only be discounted down to zero Power (${card.powerCost})`);
    }
  }
  if (optionalCost !== undefined && action.additionalCostUnitInstanceId !== undefined) {
    const id = action.additionalCostUnitInstanceId;
    const inBase = actor.baseUnits.find((u) => u.instanceId === id);
    const atBattlefield = inBase ? undefined : findUnitOnBattlefield(state, id);
    const owned = inBase !== undefined || (atBattlefield !== undefined && atBattlefield.ownerIndex === action.playerIndex);
    const unit = inBase ?? atBattlefield?.unit;
    // Ownership is common to both cost shapes — rule 705.1 for spending a buff,
    // and you can't exhaust someone else's unit either.
    if (!unit || !owned) {
      return fail(`${card.name}'s additional cost requires a friendly unit you control`);
    }
    // What makes the unit ELIGIBLE differs, and conflating the two was a real
    // bug waiting: this check was exhaust-only, so a buff-spend cost would have
    // rejected an exhausted-but-buffed unit that the rules allow perfectly well.
    if (optionalCost.kind === "exhaustReadyFriendly" && unit.exhausted) {
      return fail(`${card.name}'s additional cost requires a READY friendly unit`);
    }
    if (optionalCost.kind === "spendBuffFriendly" && !unit.buffed) {
      return fail(`${card.name}'s additional cost requires a BUFFED friendly unit (rule 705)`);
    }
  }

  // A Unit may be played directly to a battlefield only if the acting
  // player already has a unit of their own there — a pure "reinforce"
  // action. Mirrors ActionValidator.validateUnitDirectToBattlefield's
  // universal rule (Battlefield.hasUnitsFor(actor)) — minus the small,
  // hardcoded exception for cards whose text names a destination of their own
  // (mayPlaceWithoutPresence: Sneaky Deckhand and Sai Scout to an OPEN
  // battlefield, Deadbloom Predator to an OCCUPIED ENEMY one), mirroring
  // ActionValidator's own small named-card exception list
  // (ActionValidator.java:1306-1319).
  // Rule 811 again, from the other side: a hidden PERMANENT must be played at
  // the battlefield it was hidden at — not into base, and not somewhere else —
  // and that requirement replaces the presence rule rather than joining it.
  if (card.kind === "Unit" && action.fromHiddenBattlefieldId !== undefined) {
    if (action.destinationBattlefieldId !== action.fromHiddenBattlefieldId) {
      return fail(`${card.name} was hidden at ${action.fromHiddenBattlefieldId} and must be played there`);
    }
  } else if (card.kind === "Unit" && action.destinationBattlefieldId !== undefined) {
    const destination = state.battlefields.find((bf) => bf.id === action.destinationBattlefieldId);
    if (!destination) return fail(`No battlefield with id ${action.destinationBattlefieldId}`);
    const hasPresence = (destination.units[actor.id]?.length ?? 0) > 0;
    if (!hasPresence && !mayPlaceWithoutPresence(state, action.playerIndex, card.defId, destination)) {
      return fail(`You can only play a unit directly to a battlefield where you already have units`);
    }
  }

  // A Spell carrying a destination means one of two different things, and they
  // carry different restrictions — so the check asks WHICH rather than assuming.
  if (card.kind === "Spell" && action.destinationBattlefieldId !== undefined) {
    const destination = state.battlefields.find((bf) => bf.id === action.destinationBattlefieldId);
    if (!destination) return fail(`No battlefield with id ${action.destinationBattlefieldId}`);

    if (cardPlacesTokens(card.defId)) {
      // Deploying tokens there (Recruit the Vanguard). "Battlefields you
      // CONTROL" — deliberately stricter than the Unit rule above, which accepts
      // mere presence even at a contested battlefield; the card says control and
      // the oracle treats that as a real difference rather than a copy-paste
      // (ActionValidator.java:1487-1504).
      if (destination.controllerId !== actor.id) {
        return fail(`${card.name} can only place tokens at a battlefield you control`);
      }
      // Rockfall Path — re-derived from the same predicate the enumerator filters
      // with, so a token destination can never be offered and then refused.
      if (!mayPlayUnitAt(state, destination.id)) {
        return fail(`${card.name} cannot play a unit at ${destination.name}`);
      }
    } else if (!cardMovesTarget(card.defId)) {
      return fail(`${card.name} cannot be played directly to a battlefield`);
    }
    // A move-target spell (Charm) is deliberately unrestricted: "Move an enemy
    // unit" names no destination requirement, and the unit being moved is not
    // yours, so "a battlefield you control" would be the wrong test entirely —
    // the whole point is putting them somewhere they did not choose.
  }

  // Floating Energy/Power (banked from earlier recycled runes this turn)
  // reduce the printed cost before rune selection — Energy unconditionally,
  // Power only for the matching domain. Mirrors ActionExecutor's
  // energyAfterFloat/powerAfterFloat, the same functions legal-actions.ts
  // uses to build its auto-payment candidates, so the two can't drift.
  // Rule 811: a card played from Hidden is played "ignoring its base cost" — not
  // discounted, IGNORED. Floating resources, cost modifiers and the printed cost
  // all drop out, so the payment must be empty rather than merely small.
  if (action.acceleratePaid && !hasAccelerate(card, state, action.playerIndex, inHand)) {
    return fail(`${card.name} does not have [Accelerate]`);
  }
  // A discard choice: legal only for a card that asks for one, only naming a
  // card actually in hand, and never the card being played (by the time it
  // resolves it has already left hand). A MANDATORY one must be present.
  // "Move an enemy unit" without saying where is not a legal action — the
  // destination is part of the instruction, not an optional extra like a
  // token-placing spell's (which defaults to base).
  if (cardMovesTarget(card.defId) && action.destinationBattlefieldId === undefined) {
    return fail(`${card.name} must name a battlefield to move the unit to`);
  }
  // Temptation's restricted destination. Re-derived here from the same predicate
  // the enumerator filtered with, never trusted from the action.
  if (
    cardMovesTarget(card.defId) &&
    action.destinationBattlefieldId !== undefined &&
    !moveDestinationAllowed(state, card.defId, action.targetUnitInstanceId, action.destinationBattlefieldId)
  ) {
    return fail(`${card.name} can only move a unit to a location where its controller already has one`);
  }

  const discardChoice = discardChoiceOf(card.defId);
  if (action.discardCardInstanceId !== undefined) {
    if (!discardChoice) return fail(`${card.name} does not discard a card`);
    if (action.discardCardInstanceId === card.instanceId) {
      return fail(`${card.name} cannot discard itself`);
    }
    if (!actor.hand.some((c) => c.instanceId === action.discardCardInstanceId)) {
      return fail(`${action.discardCardInstanceId} is not in your hand to discard`);
    }
  } else if (discardChoice && !discardChoice.optional) {
    return fail(`${card.name} requires a card from your hand to discard`);
  }
  // The discount is bought BY the discard, so it applies only when one was made.
  const discardDiscount = action.discardCardInstanceId !== undefined ? (discardChoice?.energyDiscount ?? 0) : 0;

  // Irelia - Graceful's target-keyed discount, through the SAME helper the
  // executor deducts float with — the executor re-derives from the raw cost, so
  // a discount applied in only one of the two overspends floating resources.
  const targetDiscount = targetChoiceDiscount(state, action.playerIndex, chosenUnitsOfPlay(action), action.targetDiscountAxis);
  // Ezreal - Prodigy. Applies only when an optional additional cost is actually
  // being paid — "costs you PAY", so declining pays nothing and discounts
  // nothing.
  const payingOptional = action.optionalPowerPaid === true || action.acceleratePaid === true;
  const optionalDiscount = payingOptional
    ? optionalCostDiscount(state, action.playerIndex, action.targetDiscountAxis)
    : { energy: 0, power: 0 };
  // An axis named on a play that is not actually discounted is refused rather
  // than ignored: silently dropping it would let a client quote itself a price
  // the board does not support, and a payment one pip short would then fail
  // with a message about runes instead of about the claim.
  if (action.targetDiscountAxis !== undefined && targetDiscount.energy + targetDiscount.power === 0) {
    return fail(`${card.name} does not choose a unit that discounts it`);
  }

  const accelerateEnergy = action.acceleratePaid ? ACCELERATE_ENERGY : 0;
  const acceleratePower = action.acceleratePaid ? ACCELERATE_POWER : 0;

  // Call to Glory's "if you do, ignore this spell's cost" — the same zeroing
  // rule 811 gives a from-hidden play, and gated on the additional cost having
  // ACTUALLY been named, since declining leaves the printed cost standing.
  const costIgnored = optionalCost?.ignoresCostWhenPaid === true && action.additionalCostUnitInstanceId !== undefined;
  // A REPEATABLE cost takes 1 Power off per unit spent, floored at 0 — re-derived
  // here from the SAME action the enumerator priced, so the two cannot disagree
  // about what the play costs.
  const repeatableDiscount = optionalCost?.repeatable ? (action.additionalCostUnitInstanceIds?.length ?? 0) : 0;
  const optionalPower = optionalPowerCostOf(card.defId);
  // Bullet Time — the X the action names has to be exactly the rainbow runes it
  // supplies. Checked here rather than trusting the enumerator, since a hand-built
  // action could claim a large X and pay nothing.
  if (hasXRainbowCost(card.defId)) {
    const x = action.xAmount ?? 0;
    if (x < 0) return fail(`${card.name} cannot pay a negative amount`);
    if ((action.payment.rainbowRunes ?? []).length !== x) {
      return fail(`${card.name} was played for X=${x} but supplied ${(action.payment.rainbowRunes ?? []).length} rainbow Power`);
    }
  }

  // `[Repeat]`'s additional cost (820.1.c.1, "an Additional Cost to be paid
  // during the steps of playing"). Re-derived from the same action and the same
  // table the enumerator priced from, so the two cannot disagree about what the
  // play costs — the invariant every other optional cost here is built around.
  //
  // The Power half rides the card's OWN power bucket rather than a third one,
  // which is sound only because the Repeat domain and the printed domain agree
  // for all fourteen cards; `repeat-cost-table.test.ts` asserts that card by
  // card rather than trusting this comment.
  // Marai Spire's "while you control this battlefield, friendly [Repeat] costs
  // cost [1] less" — applied through the shared modifier so the enumerator
  // cannot price it differently.
  const repeatEnergy = action.repeatPaid
    ? modifiedRepeatEnergy(state, action.playerIndex, repeatCost?.energy ?? 0)
    : 0;
  const repeatPower = action.repeatPaid ? repeatCost?.power ?? 0 : 0;
  const repeatRainbow = action.repeatPaid ? repeatCost?.rainbowPower ?? 0 : 0;
  // The granted instance is a SECOND additional cost and adds on top of the
  // printed one — 3509 makes them independently payable, so a spell can owe
  // both. `modifiedRepeatEnergy` applies to it too: Marai Spire's discount is
  // about [Repeat] costs, and a granted instance is one.
  const grantedEnergy = action.grantedRepeatPaid
    ? modifiedRepeatEnergy(state, action.playerIndex, grantedRepeatCost?.energy ?? 0)
    : 0;
  const grantedPower = action.grantedRepeatPaid ? grantedRepeatCost?.power ?? 0 : 0;

  const effectiveCost = fromHidden || costIgnored
    ? { energyCost: 0, powerCost: 0 }
    : computeEffectiveCost(
        actor.floatingEnergy,
        actor.floatingPower,
        Math.max(0, modifiedEnergyCost(state, action.playerIndex, card.kind, card.energyCost, card.defId, inHand) - discardDiscount - targetDiscount.energy) +
          accelerateEnergy +
          repeatEnergy +
          grantedEnergy +
          // The optional cost's ENERGY half — Sea Monkey pays only Energy and
          // Blast Corps Cadet pays one of each, so the Power line below is not
          // the whole price. Re-derived from the same table the enumerator
          // priced against, which is what keeps the two from disagreeing.
          // Ezreal - Prodigy discounts the ADDITIONAL cost, so the reduction is
          // applied to this term and floored here rather than against the card's
          // own price.
          Math.max(0, (action.optionalPowerPaid ? optionalPower?.energy ?? 0 : 0) + accelerateEnergy - optionalDiscount.energy) -
            accelerateEnergy,
        // The optional Power cost is ADDED, unlike the repeatable discount above
        // which is subtracted — re-derived from the same action the enumerator
        // priced, so the two cannot disagree about what the play costs.
        Math.max(0, card.powerCost - repeatableDiscount - targetDiscount.power - scaledPowerDiscount(state, action.playerIndex, card.defId)) +
          acceleratePower +
          repeatPower +
          grantedPower +
          Math.max(0, (action.optionalPowerPaid ? optionalPower?.count ?? 0 : 0) + acceleratePower - optionalDiscount.power) -
            acceleratePower,
        // The optional cost's own domain wins when it was paid, for the reason
        // `OPTIONAL_POWER_COSTS` records: the card may print no Power at all, so
        // `card.powerDomain` is null and would accept any rune.
        // The optional cost's own domain wins ONLY when it names one — Sea
        // Monkey's is pure Energy, so the card's own printed domain must stay in
        // force or its Power pip would accept any rune.
        action.optionalPowerPaid && optionalPower?.domain
          ? optionalPower.domain
          : action.acceleratePaid
            ? acceleratePowerDomain(card)
            : card.powerDomain,
        card.powerDomainAlt,
        card.kind === "Spell" ? actor.restrictedSpellEnergy : 0,
        restrictedPowerFor(actor, card.kind),
        actor.floatingRainbowPower,
      );

  if (payment.energyRunes.length !== effectiveCost.energyCost) {
    return fail(`${card.name} costs ${effectiveCost.energyCost} energy after floating Energy, payment supplied ${payment.energyRunes.length}`);
  }
  if (payment.powerRunes.length !== effectiveCost.powerCost) {
    return fail(`${card.name} costs ${effectiveCost.powerCost} power after floating Power, payment supplied ${payment.powerRunes.length}`);
  }
  if (new Set(payment.energyRunes).size !== payment.energyRunes.length) {
    return fail("Payment may not reuse the same energy rune twice");
  }
  if (new Set(payment.powerRunes).size !== payment.powerRunes.length) {
    return fail("Payment may not reuse the same power rune twice");
  }

  const channeledById = new Map(actor.channeled.map((r) => [r.id, r]));
  for (const id of payment.energyRunes) {
    const rune = channeledById.get(id);
    if (!rune) return fail(`Rune ${id} is not in ${actor.name}'s channeled pool`);
    if (rune.state !== "Ready") return fail(`Rune ${id} is already exhausted and cannot pay an Energy cost`);
  }
  for (const id of payment.powerRunes) {
    const rune = channeledById.get(id);
    if (!rune) return fail(`Rune ${id} is not in ${actor.name}'s channeled pool`);
    // Mirrors ActionExecutor.matchesPowerDomain (engine/ActionExecutor.java:1841-1843):
    // a Power cost must be paid with runes of the exact domain it requires
    // (card.powerDomain is only ever null when powerCost is 0, in which
    // case this loop never runs) — or, for a confirmed handful of genuinely
    // hybrid-pip cards (card.powerDomainAlt), runes of that second domain too.
    if (!matchesPowerDomain(rune, card.powerDomain, card.powerDomainAlt)) {
      const required = card.powerDomainAlt !== undefined ? `${card.powerDomain} or ${card.powerDomainAlt}` : `${card.powerDomain}`;
      return fail(`Rune ${id} is ${rune.domain}, but ${card.name}'s Power cost requires ${required}`);
    }
  }

  // **[Deflect]** — re-derived here rather than trusted from the action, exactly
  // as the card's own cost is. The surcharge depends on WHICH units this play
  // chooses, so it is the first price in this engine that a client could
  // understate by sending a different target than it was quoted for.
  //
  // No domain check on this bucket: rainbow means any domain, which is precisely
  // why it is a separate bucket from `powerRunes` above rather than more entries
  // in it.
  //
  // **BOTH `[Repeat]` executions are taxed, and the same unit chosen twice owes
  // twice** — project-owner ruling, 2026-08-06. 820.1.d puts the additional
  // execution's choices at the same Make Relevant Choices step, so they are
  // choices, and 355 makes each choice a target in its own right. It is the same
  // reading `chosenUnitsOfPlay` already applied WITHIN one execution, so no
  // dedup: a repeat that names the same Deflect unit again pays again.
  //
  // The enumerator prices its repeat variant through these same two helpers
  // rather than doubling `deflected` by hand — this figure is the one the
  // offered-then-refused split lives in, and two spellings of it is exactly how
  // that split has been shipped three times.
  // Ruin Runner's absolute prohibition, asked of the SAME two lists and
  // immediately before the surcharge — the two are the same question about a
  // chosen unit ('may I, and at what price'), and asking them anywhere apart
  // is how one of them comes to miss a field the other covers.
  //
  // Refused rather than priced: no amount of Power makes this play legal.
  const unchooseable = unchooseableAmong(state, action.playerIndex, [
    ...chosenUnitsOfPlay(action),
    ...chosenUnitsOfRepeat(action),
  ]);
  if (unchooseable !== undefined) {
    return fail(`${unchooseable} can't be chosen by enemy spells and abilities`);
  }
  const deflected = deflectSurchargeForTargets(state, action.playerIndex, [
    ...chosenUnitsOfPlay(action),
    ...chosenUnitsOfRepeat(action),
  ]);
  const rainbow = payment.rainbowRunes ?? [];
  // Danger Zone's Repeat is `[1][rainbow]`, and a rainbow pip is not
  // domain-checked — so it rides this bucket beside the Deflect tax rather than
  // `powerRunes`. Owed ON TOP of any surcharge: they are two different debts
  // that happen to be payable with the same kind of rune.
  if (rainbow.length < deflected + repeatRainbow) {
    // The [Repeat] half is named only when it is actually owed. Every card in the
    // pool but Danger Zone owes zero, and a breakdown reading "0 for [Repeat]" on
    // the other 300 was noise — it also silently rewrote the sentence the web
    // package asserts on, which is how this message came to be tested by a suite
    // the engine's own verification loop does not run.
    const owed = deflected + repeatRainbow;
    const why =
      repeatRainbow > 0
        ? `(${deflected} for [Deflect], ${repeatRainbow} for [Repeat])`
        : `for [Deflect] on its target${deflected === 1 ? "" : "s"}`;
    return fail(`${card.name} must pay ${owed} rainbow Power ${why}, but named ${rainbow.length}`);
  }
  const alreadySpent = new Set([...payment.energyRunes, ...payment.powerRunes]);
  for (const id of rainbow) {
    if (!channeledById.has(id)) return fail(`Rune ${id} is not in ${actor.name}'s channeled pool`);
    // One rune cannot pay both the card's own cost and an opponent's Deflect tax.
    // The Ready-rune double duty (164.2) lets a rune make Energy AND Power for
    // ITS OWNER's cost; it does not make two Powers.
    if (alreadySpent.has(id)) {
      return fail(`Rune ${id} is already spent on ${card.name}'s own cost and cannot also pay its [Deflect] surcharge`);
    }
  }

  return ok();
}
