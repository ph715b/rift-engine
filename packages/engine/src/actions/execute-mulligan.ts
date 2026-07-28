import type { GameState, PlayerState } from "../model/game-state.js";
import type { MulliganAction } from "./mulligan-action.js";
import { validateMulligan } from "./validate-mulligan.js";

/**
 * Resolves a validated Mulligan action. Mirrors GameEngine.mulligan's own
 * mutation order exactly (engine/GameEngine.java:98-121):
 *   1. Remove the set-aside cards from hand.
 *   2. Draw one replacement per set-aside card off the FRONT of the deck —
 *      `Math.min(setAside.length, deck.length)` replacements, gracefully
 *      handling a near-empty deck rather than erroring (mirrors Java's
 *      `!player.deck.isEmpty()` loop guard).
 *   3. ONLY THEN append the set-aside cards to the END of the deck (bottom),
 *      in their original relative hand order. Doing the draw before the
 *      append is what guarantees a mulligan can never redraw one of its own
 *      just-recycled cards — Java achieves the same guarantee via two
 *      separate loops in this same order.
 * Net effect: hand size and deck size are both unchanged overall.
 */
export function executeMulligan(state: GameState, action: MulliganAction): GameState {
  const validation = validateMulligan(state, action);
  if (!validation.ok) throw new Error(validation.error);

  const actor = state.players[action.playerIndex];
  const setAsideIds = new Set(action.setAsideInstanceIds);
  const setAsideCards = actor.hand.filter((c) => setAsideIds.has(c.instanceId));
  const keptHand = actor.hand.filter((c) => !setAsideIds.has(c.instanceId));

  const replacementCount = Math.min(setAsideCards.length, actor.deck.length);
  const replacements = actor.deck.slice(0, replacementCount);
  const remainingDeck = actor.deck.slice(replacementCount);

  const updatedActor: PlayerState = {
    ...actor,
    hand: [...keptHand, ...replacements],
    deck: [...remainingDeck, ...setAsideCards],
  };

  const players = [...state.players] as [PlayerState, PlayerState];
  players[action.playerIndex] = updatedActor;

  return { ...state, players };
}
