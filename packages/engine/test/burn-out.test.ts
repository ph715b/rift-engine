import { describe, expect, it } from "vitest";
import { drawCards } from "../src/engine/effect-helpers.js";
import { runDraw } from "../src/engine/turn-manager.js";
import { makeState, makeUnit } from "./fixtures.js";

/**
 * Burn Out — rule 431.
 *
 * Drawing from an empty deck used to silently do nothing, recorded as a gap
 * "weaker than the real rules, but not a crash". It was a LIVELOCK: with both
 * decks empty, neither player developing and no battlefield held, self-play ran
 * to turn 538 passing back and forth, because Burn Out is the only rule that can
 * break that position. These tests exist so it cannot go quiet again.
 */

const cards = (...names: string[]) => names.map((n) => makeUnit({ name: n }));

describe("Burn Out (431): an empty deck recycles the trash and pays the opponent", () => {
  it("recycles the trash into the deck, gives the OPPONENT a point, and completes the draw", () => {
    const state = makeState();
    state.players[0]!.deck = [];
    state.players[0]!.trash = cards("t1", "t2");

    const after = drawCards(state, 0, 1);

    expect(after.players[1]!.points).toBe(1); // the opponent's point
    expect(after.players[0]!.trash).toHaveLength(0);
    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["t1"]); // draw completed
    expect(after.players[0]!.deck.map((c) => c.name)).toEqual(["t2"]);
  });

  it("does NOT fire while the deck can cover the draw", () => {
    const state = makeState();
    state.players[0]!.deck = cards("d1", "d2");
    state.players[0]!.trash = cards("t1");

    const after = drawCards(state, 0, 2);

    expect(after.players[1]!.points).toBe(0);
    expect(after.players[0]!.trash.map((c) => c.name)).toEqual(["t1"]);
    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["d1", "d2"]);
  });

  it("fires MID-draw, when the deck runs out partway through", () => {
    // "Draw 4" with one card left: take it, burn out, then finish from the
    // recycled trash. The point is owed once, not once per missing card.
    const state = makeState();
    state.players[0]!.deck = cards("d1");
    state.players[0]!.trash = cards("t1", "t2", "t3");

    const after = drawCards(state, 0, 4);

    expect(after.players[1]!.points).toBe(1);
    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["d1", "t1", "t2", "t3"]);
    expect(after.players[0]!.deck).toHaveLength(0);
  });

  it("pays a SECOND point if the recycled deck runs out again", () => {
    // A deck that keeps running out keeps feeding the opponent, which is what
    // eventually ends a game two empty decks would otherwise stall forever.
    const state = makeState();
    state.players[0]!.deck = [];
    state.players[0]!.trash = cards("only");

    // Draw 1 (burn out, draw "only"), then the trash is empty again — but the
    // card just drawn is in hand, not the trash, so there is nothing to recycle.
    const once = drawCards(state, 0, 1);
    expect(once.players[1]!.points).toBe(1);

    // Put it back in the trash and draw again: a second Burn Out, a second point.
    const refilled = {
      ...once,
      players: [{ ...once.players[0]!, hand: [], trash: cards("again") }, once.players[1]!] as typeof once.players,
    };
    expect(drawCards(refilled, 0, 1).players[1]!.points).toBe(2);
  });

  it("STOPS when the deck and the trash are both empty — no infinite Burn Out", () => {
    // The guard that keeps the fix from trading one livelock for another: with
    // nothing in either zone there is no card to draw and none to make, so the
    // draw simply ends. No point is owed for a Burn Out that cannot happen.
    const state = makeState();
    state.players[0]!.deck = [];
    state.players[0]!.trash = [];

    const after = drawCards(state, 0, 3);

    expect(after.players[0]!.hand).toHaveLength(0);
    expect(after.players[1]!.points).toBe(0);
  });

  it("the TURN's own draw burns out too — one funnel, not two", () => {
    // runDraw used to have its own empty-deck no-op. It now goes through
    // drawCards, so a turn draw and a spell draw cannot disagree.
    const state = makeState({ phase: "Draw" });
    state.players[0]!.deck = [];
    state.players[0]!.trash = cards("t1");

    const after = runDraw(state);

    expect(after.phase).toBe("Action");
    expect(after.players[1]!.points).toBe(1);
    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["t1"]);
  });

  it("pays the point to the right seat when the OTHER player burns out", () => {
    const state = makeState();
    state.players[1]!.deck = [];
    state.players[1]!.trash = cards("theirs");

    const after = drawCards(state, 1, 1);

    expect(after.players[0]!.points).toBe(1);
    expect(after.players[1]!.points).toBe(0);
  });
});
