import type { CardInstance } from "../model/card.js";
import type { GameState } from "../model/game-state.js";
import { parkDecision } from "./decisions.js";

/**
 * Nocturne - Horrifying's "**As you look at or reveal me** from the top of your
 * deck, you may banish me. If you do, you may play me for [rainbow]."
 *
 * The only card in the pool that triggers on a player SEEING a card rather than
 * on anything happening to it, and it needed its own funnel for the same reason
 * `unitMoved` did: the looking is spread across six unrelated card
 * implementations, each of which slices its own top-N, and a per-card table
 * keyed by the looking card could never see him.
 *
 * Every caller passes the cards it actually looked at, NOT a count. Two reasons,
 * and the second is the load-bearing one:
 *
 *  - "The top 5" stops being the top 5 the moment the looking effect recycles
 *    them, and half these callers do that before anything can be asked. The
 *    decision therefore names the card instance, and banishes it from wherever
 *    in the deck it has since ended up.
 *  - Some callers reveal a variable number of cards ("reveal until you reveal a
 *    unit"), so there is no count to pass.
 */
export const NOCTURNE_HORRIFYING = "OGN-194";

/**
 * Raises Nocturne's offer for every copy of him among the cards just looked at.
 *
 * Callers that go on to ask a question about the same cards should call this
 * FIRST: the queue is FIFO, so his offer is answered before theirs, which is the
 * order "as you look at" reads in. Callers that consume the cards immediately
 * call it after, and the decision copes — see above.
 */
export function offerTopOfDeckBanish(state: GameState, playerIndex: 0 | 1, looked: readonly CardInstance[]): GameState {
  return looked
    .filter((card) => card.defId === NOCTURNE_HORRIFYING)
    .reduce(
      (next, card) =>
        parkDecision(next, { kind: "OGN-194-banish", playerIndex, cardInstanceId: card.instanceId }),
      state,
    );
}

/** For coverage.ts — the card this module's rule implements. Nocturne is
 *  registered HERE as well as by his decision, because a decision registration
 *  is a continuation and never a whole implementation: what makes him reachable
 *  is this funnel being called by every look and reveal in the pool. */
export function topOfDeckDefIds(): string[] {
  return [NOCTURNE_HORRIFYING];
}
