import type { CardInstance, PlayerAction } from "@rift-engine/engine";

/**
 * The cards in a player's trash that they may play RIGHT NOW.
 *
 * # Why this exists as its own function
 *
 * It was inline in `GameBoard`, and before that it did not exist at all — which
 * is the bug. `human.hand.map` was the only place a card ever received an
 * `onClick`, and the trash browser renders `<CardView inPile />` with no handler,
 * so **no card could be played from the trash in the app by any route**:
 *
 *   `[Flow]` (829) — 15 Vendetta spells, engine-complete on the day this was found
 *   `UNL-025 Undying Legion`'s printed "you may play me from your trash" — TWO SETS
 *   a granted trash charge (`trashUnitPlaysThisTurn`)
 *
 * Undying Legion's whole trash clause had therefore been unreachable by a human
 * since it shipped. **Nothing in the repo could see it**: every instrument drives
 * `submit` directly, so `reachability` reports such a card exercised because the
 * AI takes an enumerated action straight to the executor and never needs an
 * affordance.
 *
 * # Read off the ACTIONS, never off the card
 *
 * The three routes above are three different mechanisms — a printed replaced
 * cost, a parsed `[Flow]` cost, and a per-turn charge — and a card property test
 * would have to know all three and would fall behind the fourth. `legal` already
 * answers the question for every one of them, so this filters that instead.
 */
export function trashPlayableCards(trash: readonly CardInstance[], legal: readonly PlayerAction[]): CardInstance[] {
  const playable = new Set(
    legal.filter((a) => a.type === "PlayCard").map((a) => (a as { card: CardInstance }).card.instanceId),
  );
  return trash.filter((card) => playable.has(card.instanceId));
}
