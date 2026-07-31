import type { GameState, PlayerState } from "../model/game-state.js";
import { mayPlaceOnOpenBattlefield, targetingForAnyCard, unitTriggerHasVisionChoice } from "../engine/unit-triggers.js";
import {
  findUnitAnywhere,
  findUnitOnBattlefield,
  hasAnyLegalEffectChoice,
  unitOrGearTargets,
  unitWithinMaxMight,
} from "../engine/target-lookup.js";
import type { TargetScope, UnitSlotRole } from "../engine/card-effects.js";
import type { UnitInstance } from "../model/card.js";
import { computeEffectiveCost, matchesPowerDomain } from "../engine/rune-payment.js";
import { modifiedEnergyCost } from "../engine/cost-modifiers.js";
import { cardPlacesTokens, discardChoiceOf, optionalUnitCostOf } from "../engine/card-effects.js";
import type { PlayCardAction } from "./player-action.js";
import { fail, ok, type ValidationResult } from "./validation-result.js";
import {
  ACCELERATE_ENERGY,
  ACCELERATE_POWER,
  acceleratePowerDomain,
  hasAccelerate,
  mayPlayUnitToBattlefield,
  timingRejection,
} from "../engine/timing.js";
import { hiddenCardAt, hiddenCardIsPlayable } from "../engine/hidden.js";

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
/** Resolves a target under the spec's own scope, so validation looks in
 *  exactly the places legal-actions.ts enumerated from. Returns the fields
 *  both callers need (owner + the unit itself), flattening the two location
 *  shapes. */
function findUnitInScope(
  state: GameState,
  instanceId: string,
  scope: TargetScope | undefined,
): { unit: UnitInstance; ownerIndex: 0 | 1 } | undefined {
  return scope === "anywhere" ? findUnitAnywhere(state, instanceId) : findUnitOnBattlefield(state, instanceId);
}

function scopeDescription(scope: TargetScope | undefined): string {
  return scope === "anywhere" ? "in play" : "at a battlefield";
}

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
  if (!hiddenCardIsPlayable(state, hidden)) {
    return `${action.card.name} was hidden this turn and can only be played from the next turn onward`;
  }
  // Every target must come from that battlefield, PER TARGET (811). Checked
  // against the same predicate legal-actions enumerates from, so a from-hidden
  // play can never be offered and then refused.
  for (const targetId of [action.targetUnitInstanceId, action.secondTargetUnitInstanceId]) {
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
  if (
    card.kind === "Unit" &&
    action.destinationBattlefieldId !== undefined &&
    !mayPlayUnitToBattlefield(state, action.playerIndex, action.destinationBattlefieldId)
  ) {
    return fail(`${card.name} can only be played to your base or a battlefield you control while a Showdown is open`);
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

  const targeting = targetingForAnyCard(card);

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
    action.trashCardInstanceId === undefined;

  if (omitted) {
    // fall through to the cost/destination checks below
  } else if (targeting.kind === "unit") {
    if (!action.targetUnitInstanceId) {
      return fail(`${card.name} requires a target unit`);
    }
    // Which lookup depends on the card's own text: "a unit" reaches base,
    // "a unit at a battlefield" does not. Must match legal-actions.ts's
    // enumeration exactly, or the UI offers clicks this then rejects.
    const location = findUnitInScope(state, action.targetUnitInstanceId, targeting.scope);
    if (!location) {
      return fail(`No unit with id ${action.targetUnitInstanceId} found ${scopeDescription(targeting.scope)}`);
    }
    if (targeting.owner === "friendly" && location.ownerIndex !== action.playerIndex) {
      return fail(`${card.name} can only target a friendly unit`);
    }
    if (targeting.owner === "enemy" && location.ownerIndex === action.playerIndex) {
      return fail(`${card.name} can only target an enemy unit`);
    }
    if (!unitWithinMaxMight(state, location.unit, targeting.maxMight)) {
      return fail(`${card.name} can only target a unit with ${targeting.maxMight} Might or less`);
    }
  } else if (targeting.kind === "battlefield") {
    if (!action.targetBattlefieldId) {
      return fail(`${card.name} requires a target battlefield`);
    }
    if (!state.battlefields.some((bf) => bf.id === action.targetBattlefieldId)) {
      return fail(`No battlefield with id ${action.targetBattlefieldId}`);
    }
  } else if (targeting.kind === "unitOrGear") {
    if (!action.targetPermanentInstanceId) {
      return fail(`${card.name} requires a target unit or gear`);
    }
    if (!unitOrGearTargets(state).some((t) => t.instanceId === action.targetPermanentInstanceId)) {
      return fail(`${action.targetPermanentInstanceId} is not a unit at a battlefield or a gear in play`);
    }
  } else if (targeting.kind === "ownTrashCard") {
    if (!action.trashCardInstanceId) {
      return fail(`${card.name} requires a card from your trash`);
    }
    const trashCard = actor.trash.find((c) => c.instanceId === action.trashCardInstanceId);
    if (!trashCard) {
      return fail(`No card with id ${action.trashCardInstanceId} found in ${actor.name}'s trash`);
    }
    if (targeting.cardKind !== undefined && trashCard.kind !== targeting.cardKind) {
      return fail(`${card.name} can only return a ${targeting.cardKind} from your trash, not a ${trashCard.kind}`);
    }
  } else if (targeting.kind === "unitSlots") {
    const chosen = [action.targetUnitInstanceId, action.secondTargetUnitInstanceId];
    const filled = chosen.filter((id): id is string => id !== undefined);

    if (filled.length < targeting.min) {
      return fail(`${card.name} requires ${targeting.min} target unit${targeting.min === 1 ? "" : "s"}`);
    }
    // Slots fill in order, so a second target with no first would leave the
    // slot-0 role unchecked — and legal-actions never enumerates that shape.
    if (action.targetUnitInstanceId === undefined && action.secondTargetUnitInstanceId !== undefined) {
      return fail(`${card.name}'s second target requires a first target`);
    }
    if (filled.length === 2 && filled[0] === filled[1]) {
      return fail(`${card.name} requires two different units`);
    }

    const roleHolds = (ownerIndex: 0 | 1, role: UnitSlotRole) =>
      role === "any" ? true : role === "friendly" ? ownerIndex === action.playerIndex : ownerIndex !== action.playerIndex;

    for (const [slot, id] of chosen.entries()) {
      if (id === undefined) continue;
      const location = findUnitInScope(state, id, targeting.scope);
      if (!location) return fail(`No unit with id ${id} found ${scopeDescription(targeting.scope)}`);
      const role = targeting.slots[slot]!;
      if (!roleHolds(location.ownerIndex, role)) {
        return fail(`${card.name}'s ${slot === 0 ? "first" : "second"} target must be ${role}`);
      }
    }
  }

  if (card.kind === "Unit" && unitTriggerHasVisionChoice(card.defId) && action.visionRecycle === undefined) {
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
  if (optionalCost?.mandatory && action.additionalCostUnitInstanceId === undefined) {
    return fail(`${card.name} requires a friendly unit as an additional cost`);
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
  // hardcoded exception for cards whose text explicitly grants open-
  // battlefield placement (canPlayToOpenBattlefield: Sneaky Deckhand, Sai
  // Scout), mirroring ActionValidator's own small named-card exception
  // list (ActionValidator.java:1306-1319).
  if (card.kind === "Unit" && action.destinationBattlefieldId !== undefined) {
    const destination = state.battlefields.find((bf) => bf.id === action.destinationBattlefieldId);
    if (!destination) return fail(`No battlefield with id ${action.destinationBattlefieldId}`);
    const hasPresence = (destination.units[actor.id]?.length ?? 0) > 0;
    if (!hasPresence && !mayPlaceOnOpenBattlefield(card.defId, destination)) {
      return fail(`You can only play a unit directly to a battlefield where you already have units`);
    }
  }

  // A Spell carrying a destination is deploying tokens there (Recruit the
  // Vanguard). "Battlefields you CONTROL" — deliberately stricter than the
  // Unit rule above, which accepts mere presence even at a contested
  // battlefield; the card says control and the oracle treats that as a real
  // difference rather than a copy-paste (ActionValidator.java:1487-1504).
  if (card.kind === "Spell" && action.destinationBattlefieldId !== undefined) {
    if (!cardPlacesTokens(card.defId)) {
      return fail(`${card.name} cannot be played directly to a battlefield`);
    }
    const destination = state.battlefields.find((bf) => bf.id === action.destinationBattlefieldId);
    if (!destination) return fail(`No battlefield with id ${action.destinationBattlefieldId}`);
    if (destination.controllerId !== actor.id) {
      return fail(`${card.name} can only place tokens at a battlefield you control`);
    }
  }

  // Floating Energy/Power (banked from earlier recycled runes this turn)
  // reduce the printed cost before rune selection — Energy unconditionally,
  // Power only for the matching domain. Mirrors ActionExecutor's
  // energyAfterFloat/powerAfterFloat, the same functions legal-actions.ts
  // uses to build its auto-payment candidates, so the two can't drift.
  // Rule 811: a card played from Hidden is played "ignoring its base cost" — not
  // discounted, IGNORED. Floating resources, cost modifiers and the printed cost
  // all drop out, so the payment must be empty rather than merely small.
  if (action.acceleratePaid && !hasAccelerate(card)) {
    return fail(`${card.name} does not have [Accelerate]`);
  }
  // A discard choice: legal only for a card that asks for one, only naming a
  // card actually in hand, and never the card being played (by the time it
  // resolves it has already left hand). A MANDATORY one must be present.
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

  const accelerateEnergy = action.acceleratePaid ? ACCELERATE_ENERGY : 0;
  const acceleratePower = action.acceleratePaid ? ACCELERATE_POWER : 0;

  const effectiveCost = fromHidden
    ? { energyCost: 0, powerCost: 0 }
    : computeEffectiveCost(
        actor.floatingEnergy,
        actor.floatingPower,
        Math.max(0, modifiedEnergyCost(state, action.playerIndex, card.kind, card.energyCost, card.defId) - discardDiscount) +
          accelerateEnergy,
        card.powerCost + acceleratePower,
        action.acceleratePaid ? acceleratePowerDomain(card) : card.powerDomain,
        card.powerDomainAlt,
        card.kind === "Spell" ? actor.restrictedSpellEnergy : 0,
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

  return ok();
}
