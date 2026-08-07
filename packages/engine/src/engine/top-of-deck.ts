import type { CardInstance } from "../model/card.js";
import type { GameState, PlayerState } from "../model/game-state.js";
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

/**
 * Undertitan's "**As I'm revealed from your deck**, [Add] [2] Energy".
 *
 * Nocturne's neighbour and deliberately NOT folded into him: his clause is "as
 * you look at **or reveal** me" and this one is REVEAL only. A card looked at
 * under Reinforce or Stacked Deck has not been revealed to anybody, so folding
 * the two would pay Undertitan out on six looks it never appears in.
 *
 * That distinction is the whole reason `revealedFromDeck` below exists as a
 * second funnel rather than a flag on the first.
 */
export const UNDERTITAN = "SFD-175";
const UNDERTITAN_ENERGY = 2;

/**
 * Every card REVEALED from a deck goes through here.
 *
 * `deckOwnerIndex` is whose deck the cards came off, which is not always who
 * caused the reveal — Blind Fury reveals the top of the OPPONENT's deck. Both
 * clauses this funnel serves are written from the card's own point of view
 * ("from **your** deck"), so both are owed to the deck's owner rather than to
 * the player who did the revealing.
 *
 * Nocturne's offer is raised through the existing look funnel rather than
 * duplicated, since a reveal is also a look ("as you look at or reveal me"), and
 * it goes FIRST for the FIFO reason `offerTopOfDeckBanish` records: a caller
 * that goes on to ask its own question wants his answered before it.
 *
 * **[Add] adds to the FLOATING pool** (`floatingEnergy`), the same shape every
 * other `[Add] N Energy` in the pool takes — it is Energy handed over now, not a
 * rune readied.
 */
export function revealedFromDeck(
  state: GameState,
  deckOwnerIndex: 0 | 1,
  revealed: readonly CardInstance[],
): GameState {
  const withNocturne = offerTopOfDeckBanish(state, deckOwnerIndex, revealed);
  // Per COPY revealed, not once per reveal: two Undertitans turned over together
  // are two separate "as I'm revealed" clauses.
  const titans = revealed.filter((card) => card.defId === UNDERTITAN).length;
  if (titans === 0) return withNocturne;
  const players = [...withNocturne.players] as [PlayerState, PlayerState];
  const owner = players[deckOwnerIndex]!;
  players[deckOwnerIndex] = { ...owner, floatingEnergy: owner.floatingEnergy + titans * UNDERTITAN_ENERGY };
  return { ...withNocturne, players };
}

/** For coverage.ts — the cards this module's rules implement. Nocturne is
 *  registered HERE as well as by his decision, because a decision registration
 *  is a continuation and never a whole implementation: what makes him reachable
 *  is this funnel being called by every look and reveal in the pool. Undertitan
 *  is registered here for his reveal clause only; his on-play pump lives in an
 *  effect registry, and a card claimed by two modules is normal. */
export function topOfDeckDefIds(): string[] {
  return [NOCTURNE_HORRIFYING, UNDERTITAN];
}
