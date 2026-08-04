import type { GameState } from "../model/game-state.js";
import type { HideCardAction } from "./player-action.js";
import { RAINBOW, hideCostFor, isHiddenCard, mayHideWithEnergy } from "../engine/hidden.js";
import { matchesPowerDomain } from "../engine/rune-payment.js";
import { hiddenCardLimitAt } from "../engine/battlefield-continuous.js";
import { defaultCardRegistry } from "../cards/card-registry.js";
import { fail, ok, type ValidationResult } from "./validation-result.js";

/**
 * Validates a Hide — rule 811's Discretionary Action.
 *
 * "While this card is in your hand or in your Champion Zone **on your turn
 * during an Open State**, you may pay [rainbow Power] to hide this facedown at a
 * battlefield **you control** that **doesn't already have a facedown card
 * hidden there**."
 *
 * Every clause of that sentence is a check below, and none of them is the card's
 * own cost or timing keyword: hiding is not a play, so `[Action]`/`[Reaction]`
 * are irrelevant here and engine/timing.ts is deliberately not consulted.
 */
export function validateHideCard(state: GameState, action: HideCardAction): ValidationResult {
  if (state.phase !== "Action") {
    return fail(`Cards can only be hidden during the Action phase, currently: ${state.phase}`);
  }

  // "On your turn, during an Open State." A Discretionary Action needs Priority
  // (312.1), and outside a Neutral Open state Priority isn't simply the turn
  // player's — so both halves are checked rather than just the turn.
  if (state.activePlayerIndex !== action.playerIndex) {
    return fail("You can only hide a card on your own turn");
  }
  if (!state.chainOpen || state.turnState !== "Neutral") {
    return fail("You can only hide a card in an Open State with no Showdown running");
  }

  const actor = state.players[action.playerIndex];
  if (!actor) return fail(`No player at index ${action.playerIndex}`);

  // Hand OR Champion Zone, per 811 — the same two origins validate-play-card
  // accepts, for the same reason.
  const inHand = actor.hand.some((c) => c.instanceId === action.card.instanceId);
  const isChampion = actor.championZone?.instanceId === action.card.instanceId;
  if (!inHand && !isChampion) {
    return fail(`${action.card.name} is not in ${actor.name}'s hand or Champion Zone`);
  }

  if (!isHiddenCard(defaultCardRegistry().tryGet(action.card.defId))) {
    return fail(`${action.card.name} does not have [Hidden]`);
  }

  const bf = state.battlefields.find((b) => b.id === action.battlefieldId);
  if (!bf) return fail(`No battlefield with id ${action.battlefieldId}`);
  if (bf.controllerId !== actor.id) {
    return fail(`You can only hide a card at a battlefield you control`);
  }
  // "…that doesn't already have a facedown card hidden there" — one per
  // battlefield, unless the battlefield itself says otherwise. Bandle Tree's
  // "you may hide an ADDITIONAL card here" raises the limit rather than removing
  // it, and `legal-actions` asks the same function so the two cannot disagree.
  const limit = hiddenCardLimitAt(state, bf.id);
  if (bf.hiddenCards.length >= limit) {
    return fail(`${bf.name} already has ${limit === 1 ? "a facedown card" : `${limit} facedown cards`} hidden there`);
  }

  // The cost is a flat 1 Power in ANY domain — the card's own printed cost is
  // not paid at all, which is the whole appeal of hiding an expensive card.
  if (action.payment.energyRunes.length > 0) {
    return fail("Hiding costs Power only, never Energy");
  }
  const cost = hideCostFor(state, action.playerIndex);
  // Teemo - Swift Scout's alternative — the same-sized price paid in Energy. An
  // Energy payment carries no domain, so the rainbow check below is skipped
  // rather than satisfied: the runes are exhausted, not recycled.
  if (mayHideWithEnergy(state, action.playerIndex) && action.payment.powerRunes.length === 0) {
    return action.payment.energyRunes.length === cost ? ok() : fail(`Hiding costs exactly ${cost} Energy for Teemo - Swift Scout`);
  }
  if (action.payment.powerRunes.length !== cost) {
    return fail(`Hiding costs exactly ${cost} Power`);
  }
  for (const runeId of action.payment.powerRunes) {
    const rune = actor.channeled.find((r) => r.id === runeId);
    if (!rune) return fail(`Rune ${runeId} is not in your pool`);
    // RAINBOW is null, which matchesPowerDomain already treats as "any domain".
    if (!matchesPowerDomain(rune, RAINBOW)) return fail(`Rune ${runeId} cannot pay this cost`);
  }

  return ok();
}
