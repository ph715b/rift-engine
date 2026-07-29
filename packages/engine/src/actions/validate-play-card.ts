import type { GameState, PlayerState } from "../model/game-state.js";
import { canPlayToOpenBattlefield, targetingForAnyCard, unitTriggerHasVisionChoice } from "../engine/unit-triggers.js";
import { findUnitOnBattlefield, hasAnyLegalEffectChoice } from "../engine/target-lookup.js";
import { computeEffectiveCost, matchesPowerDomain } from "../engine/rune-payment.js";
import { modifiedEnergyCost } from "../engine/cost-modifiers.js";
import { cardHasOptionalExhaustCost } from "../engine/card-effects.js";
import type { PlayCardAction } from "./player-action.js";
import { fail, ok, type ValidationResult } from "./validation-result.js";

/**
 * Validates a PlayCard action for a Unit/Spell/Gear, with a rune payment
 * sized to the floating-reduced (effective) cost — no Accelerate or other
 * additional costs. Mirrors the relevant slice of ActionValidator.java's
 * PlayCard checks and ActionExecutor.java's `isValidPayment`
 * (engine/ActionExecutor.java:1492-1513) plus energyAfterFloat/
 * powerAfterFloat for the floating-resource reduction.
 *
 * Not yet implemented: Legend plays, Accelerate/additional costs,
 * trash-play, and reaction-speed plays (the chain only ever OPENS via a
 * normal cast — nothing can be played onto an already-closed chain yet, see
 * the chainOpen check below — matches ActionValidator's Neutral/chain-open
 * branch, engine/ActionValidator.java:77-103). `isAction`/`isReaction` on
 * SpellDefinition deliberately aren't consulted here — they only gate
 * Showdown/reaction-speed timing (ActionValidator.validateShowdownOpen),
 * which is out of scope; a normal-turn cast is legal for ANY Spell
 * regardless of those tags, matching Java's actual plain validatePlayCard
 * path. The turnState check below rejects this during an open Showdown
 * entirely (no card is castable there yet).
 *
 * Targeting is validated for registered card-effects.ts effects whose
 * TargetingSpec.kind is "unit" — every such card in this slice restricts
 * to "a unit at a battlefield," so the check is just findUnitOnBattlefield
 * returning something. Cards with no registered effect, or a "none"-kind
 * one, skip this entirely.
 */
export function validatePlayCard(state: GameState, action: PlayCardAction): ValidationResult {
  if (action.playerIndex !== state.activePlayerIndex) {
    return fail(`It is not player ${action.playerIndex}'s turn`);
  }
  if (state.phase !== "Action") {
    return fail(`Cards can only be played during the Action phase, currently: ${state.phase}`);
  }
  if (state.turnState !== "Neutral") {
    return fail("Cannot play cards while a Showdown is open — the fight is already engaged");
  }
  if (!state.chainOpen) {
    return fail("Cannot play cards while a spell is pending resolution — no reaction-speed cards are supported yet");
  }

  const actor: PlayerState | undefined = state.players[action.playerIndex];
  if (!actor) return fail(`No player at index ${action.playerIndex}`);

  const { card, payment } = action;

  // A card is playable from hand OR from the Champion Zone (the one
  // champion copy set aside at deck-build time) — mirrors
  // ActionValidator.validatePlayCard's `inHand || isChampion` origin check
  // (engine/ActionValidator.java:1126-1138). Without this, a deck's
  // champion could never actually enter play at all. `isChampion` is
  // structurally always false for a Spell/Gear instance — championZone is
  // typed UnitInstance | null, so a Spell/Gear instanceId can never match it.
  const inHand = actor.hand.some((c) => c.instanceId === card.instanceId);
  const isChampion = actor.championZone?.instanceId === card.instanceId;
  if (!inHand && !isChampion) {
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
    const location = findUnitOnBattlefield(state, action.targetUnitInstanceId);
    if (!location) {
      return fail(`No unit with id ${action.targetUnitInstanceId} found at a battlefield`);
    }
    if (targeting.owner === "friendly" && location.ownerIndex !== action.playerIndex) {
      return fail(`${card.name} can only target a friendly unit`);
    }
    if (targeting.owner === "enemy" && location.ownerIndex === action.playerIndex) {
      return fail(`${card.name} can only target an enemy unit`);
    }
    if (targeting.maxMight !== undefined && location.unit.might + location.unit.bonus > targeting.maxMight) {
      return fail(`${card.name} can only target a unit with ${targeting.maxMight} Might or less`);
    }
  } else if (targeting.kind === "battlefield") {
    if (!action.targetBattlefieldId) {
      return fail(`${card.name} requires a target battlefield`);
    }
    if (!state.battlefields.some((bf) => bf.id === action.targetBattlefieldId)) {
      return fail(`No battlefield with id ${action.targetBattlefieldId}`);
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
  } else if (targeting.kind === "unitPair") {
    if (!action.targetUnitInstanceId || !action.secondTargetUnitInstanceId) {
      return fail(`${card.name} requires two target units`);
    }
    const first = findUnitOnBattlefield(state, action.targetUnitInstanceId);
    const second = findUnitOnBattlefield(state, action.secondTargetUnitInstanceId);
    if (!first) return fail(`No unit with id ${action.targetUnitInstanceId} found at a battlefield`);
    if (!second) return fail(`No unit with id ${action.secondTargetUnitInstanceId} found at a battlefield`);
    const isFriendly = (ownerIndex: 0 | 1, owner: "friendly" | "enemy") =>
      owner === "friendly" ? ownerIndex === action.playerIndex : ownerIndex !== action.playerIndex;
    if (!isFriendly(first.ownerIndex, targeting.firstOwner)) {
      return fail(`${card.name}'s first target must be ${targeting.firstOwner}`);
    }
    if (!isFriendly(second.ownerIndex, targeting.secondOwner)) {
      return fail(`${card.name}'s second target must be ${targeting.secondOwner}`);
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
  if (card.kind === "Spell" && cardHasOptionalExhaustCost(card.defId) && action.additionalCostUnitInstanceId !== undefined) {
    const id = action.additionalCostUnitInstanceId;
    const inBase = actor.baseUnits.find((u) => u.instanceId === id);
    const atBattlefield = inBase ? undefined : findUnitOnBattlefield(state, id);
    const owned = inBase !== undefined || (atBattlefield !== undefined && atBattlefield.ownerIndex === action.playerIndex);
    const unit = inBase ?? atBattlefield?.unit;
    if (!unit || !owned) {
      return fail(`${card.name}'s additional cost requires a friendly unit you control`);
    }
    if (unit.exhausted) {
      return fail(`${card.name}'s additional cost requires a READY friendly unit`);
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
    if (!hasPresence && !canPlayToOpenBattlefield(card.defId)) {
      return fail(`You can only play a unit directly to a battlefield where you already have units`);
    }
  }

  // Floating Energy/Power (banked from earlier recycled runes this turn)
  // reduce the printed cost before rune selection — Energy unconditionally,
  // Power only for the matching domain. Mirrors ActionExecutor's
  // energyAfterFloat/powerAfterFloat, the same functions legal-actions.ts
  // uses to build its auto-payment candidates, so the two can't drift.
  const effectiveCost = computeEffectiveCost(
    actor.floatingEnergy,
    actor.floatingPower,
    modifiedEnergyCost(state, action.playerIndex, card.kind, card.energyCost),
    card.powerCost,
    card.powerDomain,
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
