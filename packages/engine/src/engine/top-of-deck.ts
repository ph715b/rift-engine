import type { CardInstance } from "../model/card.js";
import type { GameState, PlayerState } from "../model/game-state.js";
import { parkDecision, type DecisionOption, type DecisionSeed } from "./decisions.js";
import { holdCardsRecycled } from "./effect-helpers.js";

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

/**
 * Void Hatchling — "If you would reveal cards from a deck, look at the top card
 * first. You may recycle it. Then reveal those cards."
 *
 * # It REPLACES a step, and the engine cannot pause mid-resolution
 *
 * Every other clause in this pool acts before or after something; this one acts
 * INSIDE it. A reveal site must ask "recycle the top card?" and then perform its
 * own reveal with the answer already in hand — and `parkDecision` returns to a
 * caller that has already run.
 *
 * So each reveal site becomes a decision CONTINUATION: its body is extracted into
 * a named function, `voidHatchlingGate` below either runs that function straight
 * away or parks the question, and the site's own decision resolver runs the very
 * same function once the answer arrives. The continuation is a REGISTERED KIND
 * rather than a closure, which is what decisions.ts requires — "the resume is
 * DATA, not a closure", because states are immutable snapshots the AI clones.
 *
 * **A naive implementation is worse than none.** Parking the question and letting
 * the reveal proceed anyway makes the card a silent no-op: recycling AFTER the
 * reveal changes nothing about what was revealed.
 *
 * # Reveal only
 *
 * Six further sites in this pool LOOK without revealing (Reinforce, Stacked Deck,
 * Called Shot, Baited Hook, Ornn - Blacksmith, the both-players look) and are
 * deliberately untouched — the Hatchling's clause is reveal-only, exactly as
 * Undertitan's is, which is why `revealedFromDeck` exists as a second funnel
 * rather than a flag on the look one.
 */
export const VOID_HATCHLING = "SFD-018";

/** Does `revealerIndex` control a Void Hatchling? "If YOU would reveal" — the
 *  clause is about the player DOING the revealing, which is not always the deck's
 *  owner: Blind Fury reveals the top of the opponent's deck, and it is the
 *  caster's Hatchling that looks. */
function voidHatchlingWatching(state: GameState, revealerIndex: 0 | 1): boolean {
  const owner = state.players[revealerIndex];
  return [...owner.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[owner.id] ?? [])].some(
    (u) => u.defId === VOID_HATCHLING,
  );
}

/**
 * The two answers to the Hatchling's question, for a site whose reveal comes off
 * `deckOwnerIndex`'s deck.
 *
 * **"Decline" is always present, and that is load-bearing rather than polite.**
 * `advanceDecisions` DROPS a question with no options, and dropping this one
 * would drop the reveal with it — the site's whole body is the continuation. An
 * empty deck therefore yields exactly one option, which resolves itself without
 * ever being shown and runs the reveal.
 */
export function voidHatchlingOptions(state: GameState, deckOwnerIndex: 0 | 1): DecisionOption[] {
  const top = state.players[deckOwnerIndex].deck[0];
  const options: DecisionOption[] = [{ id: "decline", label: "Leave the top card" }];
  if (top) options.push({ id: "recycle", label: `Recycle ${top.name}`, instanceId: top.instanceId });
  return options;
}

/**
 * Applies the answer: recycles the top card of `deckOwnerIndex`'s deck, or not.
 *
 * "Recycle" is 416/425 — the BOTTOM of the same deck it came off, not the trash —
 * and it goes through `holdCardsRecycled` so Karma - Channeler sees it, like
 * every other recycle in this engine.
 */
export function voidHatchlingAnswer(state: GameState, deckOwnerIndex: 0 | 1, optionId: string): GameState {
  if (optionId !== "recycle") return state;
  const owner = state.players[deckOwnerIndex];
  const [top, ...rest] = owner.deck;
  if (!top) return state;
  const players = [...state.players] as [PlayerState, PlayerState];
  players[deckOwnerIndex] = { ...owner, deck: [...rest, top] };
  return holdCardsRecycled({ ...state, players }, deckOwnerIndex, 1);
}

/**
 * The gate every reveal site passes through — either the reveal happens now, or
 * the Hatchling's question is parked and the reveal happens when it is answered.
 *
 * `reveal` is a closure HERE and only here: this is the inline path, which runs
 * in the same call. The parked path names `resume`, a registered decision kind
 * whose own resolver calls the very same extracted function — which is what keeps
 * the continuation data rather than a closure.
 *
 * **The look is a LOOK**, so Nocturne - Horrifying's "as you look at or reveal me"
 * is owed on it and is offered before the question. FIFO puts his answer first,
 * which is the order the two read in; and if he banishes himself out of the deck,
 * the Hatchling's options are rebuilt from live state and simply describe
 * whatever is on top now.
 *
 * Asked ONCE however many Hatchlings are in play. It is a replacement of one
 * step, and two copies replace the same step with the same question.
 */
export function voidHatchlingGate(
  state: GameState,
  revealerIndex: 0 | 1,
  deckOwnerIndex: 0 | 1,
  resume: DecisionSeed,
  reveal: (state: GameState) => GameState,
): GameState {
  if (!voidHatchlingWatching(state, revealerIndex)) return reveal(state);
  const top = state.players[deckOwnerIndex].deck[0];
  const looked = top ? offerTopOfDeckBanish(state, revealerIndex, [top]) : state;
  return parkDecision(looked, resume);
}

/** For coverage.ts — the cards this module's rules implement. Nocturne is
 *  registered HERE as well as by his decision, because a decision registration
 *  is a continuation and never a whole implementation: what makes him reachable
 *  is this funnel being called by every look and reveal in the pool. Undertitan
 *  is registered here for his reveal clause only; his on-play pump lives in an
 *  effect registry, and a card claimed by two modules is normal. */
export function topOfDeckDefIds(): string[] {
  // Void Hatchling is claimed HERE for the same reason Nocturne is: what makes
  // him reachable is this module's gate being called by every reveal site in the
  // pool, not any one card's table. His five continuations are registered under
  // the SITES' defIds, which are other cards' — so without this line the whole of
  // his text would be implemented and nothing would say so.
  return [NOCTURNE_HORRIFYING, UNDERTITAN, VOID_HATCHLING];
}
