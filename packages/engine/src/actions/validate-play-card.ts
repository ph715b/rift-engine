import type { GameState, PlayerState } from "../model/game-state.js";
import type { PlayCardAction } from "./player-action.js";
import { fail, ok, type ValidationResult } from "./validation-result.js";

/**
 * Validates a PlayCard action for a Unit going to base, with a plain rune
 * payment (no float, no Accelerate, no additional cost, no destination
 * battlefield). Mirrors the relevant slice of ActionValidator.java's
 * PlayCard checks and ActionExecutor.java's `isValidPayment`
 * (engine/ActionExecutor.java:1492-1513) for the energy-only case.
 *
 * Not yet implemented: Spell/Gear/Legend plays, destination battlefields,
 * Accelerate/additional costs, floating Energy/Power, trash-play,
 * reaction-speed plays (chain/Showdown aren't modeled, so only the active
 * player, during their own Action phase, may act — matches
 * ActionValidator's `validateClosedChain` branch, the "no open chain, no
 * Showdown" case; engine/ActionValidator.java:74-90).
 */
export function validatePlayCard(state: GameState, action: PlayCardAction): ValidationResult {
  if (action.playerIndex !== state.activePlayerIndex) {
    return fail(`It is not player ${action.playerIndex}'s turn`);
  }
  if (state.phase !== "Action") {
    return fail(`Cards can only be played during the Action phase, currently: ${state.phase}`);
  }

  const actor: PlayerState | undefined = state.players[action.playerIndex];
  if (!actor) return fail(`No player at index ${action.playerIndex}`);

  const { card, payment } = action;

  // A card is playable from hand OR from the Champion Zone (the one
  // champion copy set aside at deck-build time) — mirrors
  // ActionValidator.validatePlayCard's `inHand || isChampion` origin check
  // (engine/ActionValidator.java:1126-1138). Without this, a deck's
  // champion could never actually enter play at all.
  const inHand = actor.hand.some((c) => c.instanceId === card.instanceId);
  const isChampion = actor.championZone?.instanceId === card.instanceId;
  if (!inHand && !isChampion) {
    return fail(`${card.name} is not in ${actor.name}'s hand or Champion Zone`);
  }

  if (card.kind !== "Unit") {
    return fail(`PlayCard is only implemented for Unit cards so far (got ${card.kind})`);
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
