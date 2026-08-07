import { describe, expect, it } from "vitest";
import { holdEventTrigger } from "../src/engine/triggers.js";
import { optionsFor, pendingDecision, answerDecision } from "../src/engine/decisions.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState } from "./fixtures.js";

/**
 * Rek'sai - Void Burrower (SFD-187) — "When you conquer, you may exhaust me to
 * reveal the top 2 cards of your Main Deck. You may banish one, then play it.
 * Recycle the rest."
 *
 * Void Rush (SFD-188) already did reveal-2 / banish-one / play-it, and this
 * borrows that shape. The two printed DIFFERENCES are what these tests are
 * pointed at, because they are exactly what a copy of Void Rush would get wrong:
 *
 *  - Void Rush **draws** what it did not banish; this **recycles** it, to the
 *    bottom of the deck (416).
 *  - Void Rush plays its card for **2 Energy less**; this says only "play it", so
 *    the card is paid for **in full**.
 */

const registry = defaultCardRegistry();
const REKSAI = "SFD-187";
/** A cheap unit and an expensive one, so "affordable" is a real distinction. */
const CHEAP = "OGN-001";
const card = (defId: string) => createCardInstance(registry.get(defId));

function board(energy: number): GameState {
  const state = makeState({
    phase: "Action",
    players: [makePlayer("p1", { deck: [card(CHEAP), card(CHEAP), card(CHEAP)] }), makePlayer("p2")],
  });
  state.players[0]!.legend = { ...state.players[0]!.legend, defId: REKSAI };
  state.players[0]!.floatingEnergy = energy;
  return state;
}

/** Fires a conquest and drains the pen onto the chain, stopping at the question. */
function conquer(state: GameState): GameState {
  let current = runCleanup(holdEventTrigger(state, { kind: "battlefieldConquered", conquerorIndex: 0, battlefieldId: "bf1" }));
  for (let guard = 0; guard < 8 && current.spellChain.length > 0; guard += 1) {
    if (pendingDecision(current)) break;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) break;
    current = submit(current, pass).state;
  }
  return current;
}

const answer = (state: GameState, optionId: string) => answerDecision(state, pendingDecision(state)!.id, optionId)!;

describe("Rek'sai asks for the exhaust BEFORE showing anything", () => {
  it("offers the reveal on a conquest", () => {
    const after = conquer(board(9));
    expect(pendingDecision(after)?.kind).toBe("SFD-187-look");
  });

  /** Two questions, not one: the exhaust is committed before the cards are seen,
   *  which is what stops a player choosing to reveal after being shown. */
  it("only shows the cards once the exhaust is paid", () => {
    const looked = answer(conquer(board(9)), "look");
    expect(looked.players[0]!.legend.exhausted, "she was not exhausted as the cost").toBe(true);
    expect(pendingDecision(looked)?.kind).toBe("SFD-187-banish");
  });

  it("declining costs nothing and asks nothing further", () => {
    const declined = answer(conquer(board(9)), "decline");
    expect(declined.players[0]!.legend.exhausted).toBe(false);
    expect(pendingDecision(declined), "a second question was asked after declining").toBeUndefined();
  });

  /** An exhausted Rek'sai cannot pay, so she is not asked at all. */
  it("is not offered while already exhausted", () => {
    const state = board(9);
    state.players[0]!.legend = { ...state.players[0]!.legend, exhausted: true };
    expect(pendingDecision(conquer(state))).toBeUndefined();
  });
});

describe("banish one and play it; RECYCLE the rest", () => {
  it("plays the named card and sends the other to the BOTTOM of the deck", () => {
    const start = board(9);
    const [first, second, third] = start.players[0]!.deck;
    const offered = answer(conquer(start), "look");
    const after = answer(offered, first!.instanceId);

    // Played, not drawn — and it counts as a card you played.
    expect(after.players[0]!.baseUnits.map((u) => u.defId), "the banished card was not played").toContain(CHEAP);
    expect(after.players[0]!.cardsPlayedThisTurn).toBe(1);
    // "RECYCLE the rest" — bottom of the deck, NOT the hand and NOT the trash.
    // This is the assertion a copy of Void Rush fails: it would draw it.
    expect(after.players[0]!.hand, "the un-banished card was DRAWN, not recycled").toHaveLength(0);
    expect(after.players[0]!.trash).toHaveLength(0);
    expect(after.players[0]!.deck.map((c) => c.instanceId)).toEqual([third!.instanceId, second!.instanceId]);
  });

  it("declining the banish recycles BOTH and plays nothing", () => {
    const start = board(9);
    const [first, second, third] = start.players[0]!.deck;
    const after = answer(answer(conquer(start), "look"), "decline");

    expect(after.players[0]!.baseUnits).toHaveLength(0);
    expect(after.players[0]!.hand).toHaveLength(0);
    expect(after.players[0]!.deck.map((c) => c.instanceId)).toEqual([
      third!.instanceId,
      first!.instanceId,
      second!.instanceId,
    ]);
  });

  /**
   * **Full price, not Void Rush's discount.** With no Energy at all, nothing is
   * affordable, so nothing is offered and the whole reveal recycles — 416.3's
   * "the action must be able to be completed for the cost to be paid".
   */
  it("offers nothing it cannot pay for IN FULL", () => {
    const start = board(0);
    const [first, second, third] = start.players[0]!.deck;
    const broke = answer(conquer(start), "look");

    // With nothing affordable only "decline" remains, and a ONE-option decision
    // is AUTO-RESOLVED rather than prompted — so there is deliberately no
    // decision left to inspect, and looking for one is how this test was wrong
    // the first time. The outcome is the assertion: nothing played, both
    // recycled, and the exhaust still spent (she did reveal).
    expect(pendingDecision(broke), "a question with one answer should not be asked").toBeUndefined();
    expect(broke.players[0]!.baseUnits, "an unaffordable card was played").toHaveLength(0);
    expect(broke.players[0]!.floatingEnergy).toBe(0);
    expect(broke.players[0]!.deck.map((c) => c.instanceId)).toEqual([
      third!.instanceId,
      first!.instanceId,
      second!.instanceId,
    ]);
  });

  /** The positive control for the test above — with Energy, it IS offered. */
  it("and does offer it once the Energy is there", () => {
    const rich = answer(conquer(board(9)), "look");
    const decision = pendingDecision(rich)!;

    expect(optionsFor(rich, decision).length, "an affordable card was not offered").toBeGreaterThan(1);
  });

  it("spends the Energy it charged", () => {
    const start = board(9);
    const first = start.players[0]!.deck[0]!;
    const after = answer(answer(conquer(start), "look"), first.instanceId);

    expect(after.players[0]!.floatingEnergy, "the card was played for free").toBeLessThan(9);
  });
});
