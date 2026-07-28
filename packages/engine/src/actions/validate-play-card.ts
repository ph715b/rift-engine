import type { GameState, PlayerState } from "../model/game-state.js";
import { effectForCard, requiresTarget } from "../engine/card-effects.js";
import { findUnitOnBattlefield } from "../engine/target-lookup.js";
import type { PlayCardAction } from "./player-action.js";
import { fail, ok, type ValidationResult } from "./validation-result.js";

/**
 * Validates a PlayCard action for a Unit/Spell/Gear, with a plain rune
 * payment (no float, no Accelerate, no additional cost, no destination
 * battlefield). Mirrors the relevant slice of ActionValidator.java's
 * PlayCard checks and ActionExecutor.java's `isValidPayment`
 * (engine/ActionExecutor.java:1492-1513) for the energy-only case.
 *
 * Not yet implemented: Legend plays, destination battlefields,
 * Accelerate/additional costs, floating Energy/Power, trash-play, and
 * reaction-speed plays (the chain only ever OPENS via a normal cast —
 * nothing can be played onto an already-closed chain yet, see the
 * chainOpen check below — matches ActionValidator's Neutral/chain-open
 * branch, engine/ActionValidator.java:77-103). `isAction`/`isReaction` on
 * SpellDefinition deliberately aren't consulted here — they only gate
 * Showdown/reaction-speed timing (ActionValidator.validateShowdownOpen),
 * which is out of scope; a normal-turn cast is legal for ANY Spell
 * regardless of those tags, matching Java's actual plain validatePlayCard
 * path. The turnState check below rejects this during an open Showdown
 * entirely (no card is castable there yet).
 *
 * Targeting is validated for the small set of registered card-effects.ts
 * effects that need one (DealDamage/DestroyUnit) — every such card in this
 * slice restricts to "a unit at a battlefield," so the check is just
 * findUnitOnBattlefield returning something. Cards with no registered
 * effect, or an untargeted one (BuffAllFriendlies), skip this entirely.
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

  if (requiresTarget(effectForCard(card))) {
    if (!action.targetUnitInstanceId) {
      return fail(`${card.name} requires a target unit`);
    }
    if (!findUnitOnBattlefield(state, action.targetUnitInstanceId)) {
      return fail(`No unit with id ${action.targetUnitInstanceId} found at a battlefield`);
    }
  }

  if (payment.energyRunes.length !== card.energyCost) {
    return fail(`${card.name} costs ${card.energyCost} energy, payment supplied ${payment.energyRunes.length}`);
  }
  if (payment.powerRunes.length !== card.powerCost) {
    return fail(`${card.name} costs ${card.powerCost} power, payment supplied ${payment.powerRunes.length}`);
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
    // case this loop never runs).
    if (card.powerDomain !== null && rune.domain !== card.powerDomain) {
      return fail(`Rune ${id} is ${rune.domain}, but ${card.name}'s Power cost requires ${card.powerDomain}`);
    }
  }

  return ok();
}
