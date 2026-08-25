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

  it("BURNS OUT with an empty trash too, and pays the point — 431.3", () => {
    /**
     * **Inverted 2026-08-25.** This used to read "STOPS when the deck and the
     * trash are both empty — no infinite Burn Out", asserting that no point was
     * owed for "a Burn Out that cannot happen".
     *
     * **431.3 says it happens**: *"A player's Main Deck may remain empty as they
     * Burn Out, USUALLY BECAUSE THEIR TRASH IS ALSO EMPTY. When they attempt to
     * perform the original action again, it will cause another Burn Out."* And
     * **431.3.a** is why it matters: *"this will result in them burning out
     * repeatedly, giving 1 point to an opponent each time, until an opponent
     * passes the Victory Score and wins the game."*
     *
     * The point IS the terminator. Suppressing it livelocked exactly the games it
     * was meant to protect — `passive-human` stalled on 2 of 64 seeds at turn ~986
     * with both boards empty and neither player able to score, and the 16-seed
     * default passed by luck of which seeds it draws. It is 64 of 64 now.
     */
    const state = makeState();
    state.players[0]!.deck = [];
    state.players[0]!.trash = [];

    const after = drawCards(state, 0, 3);

    expect(after.players[0]!.hand, "a card was drawn from nothing").toHaveLength(0);
    expect(after.players[1]!.points, "the Burn Out paid no point").toBe(1);
  });

  it("...and pays it ONCE per draw ACTION, not once per card", () => {
    // The finiteness guard, and the half that keeps this from trading one
    // livelock for another. A single "draw 3" is ONE action; 431.3 repeats on the
    // next ATTEMPT, not within one — the same reading `burn`'s own note takes for
    // a Burn 7 that has run out. The next turn's Draw Phase (315.4.b) is the next
    // attempt, which is what makes the points accrue a turn at a time.
    const state = makeState();
    state.players[0]!.deck = [];
    state.players[0]!.trash = [];

    expect(drawCards(state, 0, 1).players[1]!.points).toBe(1);
    expect(drawCards(state, 0, 7).players[1]!.points, "a draw 7 paid seven points").toBe(1);
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
