import { describe, expect, it } from "vitest";
import { drawCards } from "../src/engine/effect-helpers.js";
import { makeState, makeUnit } from "./fixtures.js";
import type { GameState } from "../src/model/game-state.js";

/**
 * **Burn Out is how a game that nobody can close ENDS — 431.3.a.**
 *
 * > *"Unless some effect intervenes, this will result in them burning out
 * > repeatedly, giving 1 point to an opponent each time, **until an opponent
 * > passes the Victory Score and wins the game**."*
 *
 * The engine used to return early when a player's deck AND trash were both empty,
 * on the reasoning that "Burn Out cannot repeat" and stopping "keeps this loop
 * finite rather than trading one livelock for another". **431.3 says the opposite
 * in as many words**: *"A player's Main Deck may remain empty as they Burn Out,
 * usually because their trash is also empty. When they attempt to perform the
 * original action again, it will cause another Burn Out."*
 *
 * So the point is not decoration on a recycle — it is the terminator, and
 * withholding it removed the only thing that could end such a game.
 *
 * # What it actually cost
 *
 * `passive-human` stalled on **2 of 64 seeds** at turn ~986, with both boards
 * empty and neither player able to score. **The 16-seed default passed by luck of
 * which seeds it draws** — the two failures were seeds 56 and 59. It is 64 of 64
 * now.
 *
 * That is the finding worth keeping: a green gate at its default depth was not
 * evidence, and the bug had been sitting behind it. It surfaced only because an
 * unrelated change (moving `[Vision]` off the action and onto a parked decision)
 * shifted trajectories enough to pull one instance into the first 16 seeds.
 *
 * This file pins the arithmetic directly, so the class cannot come back quietly
 * the way it went in. `burn-out.test.ts` covers the ordinary recycle-and-pay case.
 */

/** A player with nothing in deck or trash — the state the old guard bailed on. */
function exhausted(): GameState {
  const state = makeState();
  state.players[0]!.deck = [];
  state.players[0]!.trash = [];
  return state;
}

describe("a player who cannot draw still pays the point", () => {
  it("pays exactly one point, and draws nothing", () => {
    const after = drawCards(exhausted(), 0, 1);
    expect(after.players[1]!.points, "the Burn Out paid no point — the game cannot end").toBe(1);
    expect(after.players[0]!.hand, "a card was drawn from nothing").toHaveLength(0);
  });

  it("pays it once per draw ACTION, however many cards it asked for", () => {
    // The finiteness half. A single "draw N" is ONE action; 431.3 repeats on the
    // next ATTEMPT, which the next turn's Draw Phase (315.4.b) supplies. Without
    // this, closing the livelock would have opened a scoring one.
    for (const count of [1, 2, 7, 40]) {
      expect(drawCards(exhausted(), 0, count).players[1]!.points, `a draw ${count} paid the wrong number`).toBe(1);
    }
  });

  it("the point goes to the OPPONENT of whoever ran out", () => {
    // Which is what makes it a terminator rather than a stalemate: the player who
    // cannot act is the one feeding the win.
    const after = drawCards(exhausted(), 0, 1);
    expect(after.players[0]!.points, "the burned-out player scored off their own empty deck").toBe(0);
    expect(after.players[1]!.points).toBe(1);
  });

  it("repeated attempts keep paying — the accrual 431.3.a describes", () => {
    // Each call is a fresh "attempt to perform the original action again". Four
    // turns of an empty deck is four points, which is what walks a stalled game to
    // a Victory Score instead of leaving it at turn 986.
    let state = exhausted();
    for (let turn = 0; turn < 4; turn += 1) state = drawCards(state, 0, 1);
    expect(state.players[1]!.points, "the points did not accrue across attempts").toBe(4);
  });
});

describe("the ordinary case is untouched", () => {
  it("a non-empty trash still recycles instead of paying for nothing", () => {
    // The scope control. The change widens Burn Out to the empty-trash case; it
    // must not alter the case that already worked, where the trash becomes the
    // deck and the draw succeeds.
    const state = makeState();
    state.players[0]!.deck = [];
    state.players[0]!.trash = [makeUnit({ instanceId: "recycled", name: "Recycled" })];

    const after = drawCards(state, 0, 1);
    expect(after.players[1]!.points, "the recycle stopped paying its point").toBe(1);
    expect(
      after.players[0]!.hand.map((c) => c.instanceId),
      "the recycled card was not drawn",
    ).toEqual(["recycled"]);
    expect(after.players[0]!.trash, "the trash was not emptied into the deck").toHaveLength(0);
  });
});
