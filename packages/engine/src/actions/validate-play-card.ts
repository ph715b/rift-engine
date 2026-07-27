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
 * Not yet implemented (validated M1, alongside the turn/priority skeleton):
 * phase/priority legality, Spell/Gear/Legend plays, destination
 * battlefields, Accelerate/additional costs, floating Energy/Power,
 * domain-restricted Power payment.
 */
export function validatePlayCard(state: GameState, action: PlayCardAction): ValidationResult {
  const actor: PlayerState | undefined = state.players[action.playerIndex];
  if (!actor) return fail(`No player at index ${action.playerIndex}`);

  const { card, payment } = action;

  if (!actor.hand.some((c) => c.instanceId === card.instanceId)) {
    return fail(`${card.name} is not in ${actor.name}'s hand`);
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
    if (!channeledById.has(id)) return fail(`Rune ${id} is not in ${actor.name}'s channeled pool`);
  }

  return ok();
}
