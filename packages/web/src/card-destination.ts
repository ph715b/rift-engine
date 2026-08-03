import { cardMovesTarget, cardPlacesTokens, type CardInstance } from "@rift-engine/engine";

/**
 * Does playing this card involve naming a BATTLEFIELD on the action?
 *
 * The gate on the board's whole placement step, and it had two clauses where it
 * needed three. A playtest found the missing one against Charm: "I can select a
 * unit I want to move but cannot choose where to move it."
 *
 * The three kinds, and they are genuinely different questions the player is being
 * asked, which is why this cannot be a single engine flag:
 *  - **A Unit** names where IT enters play.
 *  - **A token-placing Spell** names where its TOKEN goes.
 *  - **A Spell that moves its target** names where the TARGET ends up — Charm,
 *    Showstopper, Ride The Wind, Stormbringer, Dragon's Rage. Five cards, so this
 *    was never one card's problem; it was a whole archetype that could be armed
 *    and then not played, because several candidates differ only by destination
 *    and nothing could auto-resolve between them.
 *
 * Its own module rather than a private function in GameBoard for the same reason
 * `target-hint.ts` is: an untested predicate inside a 2400-line component is
 * exactly where a missing clause survives.
 */
export function cardHasDestination(card: CardInstance): boolean {
  if (card.kind === "Unit") return true;
  if (card.kind !== "Spell") return false;
  return cardPlacesTokens(card.defId) || cardMovesTarget(card.defId);
}
