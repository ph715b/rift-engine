import { describe, expect, it } from "vitest";
import { scoreHolds, recordConquest } from "../src/engine/scoring.js";
import { runBeginning } from "../src/engine/turn-manager.js";
import { makeState, makeUnit } from "./fixtures.js";

/**
 * Scoring, verified against the Core Rules (docs/, ignored — cite numbers):
 *
 *  - A player Scores two ways: HOLD ("maintains Control of a Battlefield they
 *    did not yet Score this turn, during their Beginning Phase", 471.1.a) and
 *    CONQUER ("gains Control of a Battlefield they did not yet Score this
 *    turn", 471.1).
 *  - "A player may only Score, from either method, once per Battlefield per
 *    turn." (471.1.b)
 *  - Final point: gaining a point through a Conquer while 1 short of the
 *    Victory Score only awards it if they have SCORED every battlefield this
 *    turn — otherwise they draw a card instead (rule 474).
 *
 * The engine previously tracked conquests only, so a hold didn't count toward
 * the sweep and the winning point was wrongly withheld.
 */
describe("holds record what they scored", () => {
  it("scoring a hold marks the battlefield as scored this turn", () => {
    const state = makeState();
    state.battlefields[0]!.units = { p1: [makeUnit()] };

    const result = scoreHolds(state, 0);

    expect(result.players[0]!.points).toBe(1);
    expect(result.players[0]!.scoredBattlefieldsThisTurn).toEqual(["bf1"]);
  });

  it("does not score the same battlefield twice in a turn", () => {
    const state = makeState();
    state.battlefields[0]!.units = { p1: [makeUnit()] };
    state.players[0]!.scoredBattlefieldsThisTurn = ["bf1"];

    const result = scoreHolds(state, 0);

    expect(result.players[0]!.points).toBe(0);
    expect(result).toBe(state); // nothing to do — same reference
  });
});

describe("the final point counts SCORED battlefields, holds included", () => {
  it("a hold + a conquest completes the sweep and awards the winning point", () => {
    // THE BUG: bf1 was held during the Beginning Phase, bf2 is conquered
    // later the same turn. Every battlefield has been scored, so rule 474
    // grants the final point — the engine used to withhold it because a hold
    // wasn't recorded as a conquest.
    let state = makeState(); // the fixture is a 2-battlefield match
    state.players[0]!.points = 6;
    state.battlefields[0]!.units = { p1: [makeUnit()] }; // held

    state = scoreHolds(state, 0); // 7 points, bf1 scored
    expect(state.players[0]!.points).toBe(7);

    state = recordConquest(state, 0, "bf2"); // the sweep's last piece

    expect(state.players[0]!.points).toBe(8);
    expect(state.players[0]!.hand).toHaveLength(0); // awarded, not a consolation draw
  });

  it("still withholds when a battlefield went unscored", () => {
    let state = makeState();
    state.players[0]!.points = 7;
    state.players[0]!.deck = [makeUnit()];

    state = recordConquest(state, 0, "bf1"); // bf2 never scored

    expect(state.players[0]!.points).toBe(7);
    expect(state.players[0]!.hand).toHaveLength(1);
  });
});

describe("one score per battlefield per turn (rule 471.1.b)", () => {
  it("re-conquering a battlefield already scored this turn gains no second point", () => {
    // Take it, lose it, take it again in one turn — the second capture is a
    // real conquest (triggers fire) but scores nothing.
    let state = makeState();
    state.players[0]!.points = 2;

    state = recordConquest(state, 0, "bf1");
    expect(state.players[0]!.points).toBe(3);

    state = recordConquest(state, 0, "bf1");
    expect(state.players[0]!.points).toBe(3); // unchanged
    expect(state.players[0]!.scoredBattlefieldsThisTurn).toEqual(["bf1"]); // recorded once
  });

  it("a conquest after holding the SAME battlefield scores nothing more", () => {
    let state = makeState();
    state.battlefields[0]!.units = { p1: [makeUnit()] };

    state = scoreHolds(state, 0); // scores bf1 as a hold
    const afterHold = state.players[0]!.points;

    state = recordConquest(state, 0, "bf1");

    expect(state.players[0]!.points).toBe(afterHold);
  });
});

describe("the Beginning Phase scores holds through the turn loop", () => {
  it("runBeginning records the scored battlefields, not just the points", () => {
    let state = makeState();
    state.phase = "Beginning";
    state.battlefields[0]!.units = { p1: [makeUnit()] };
    state.battlefields[1]!.units = { p1: [makeUnit()] };

    state = runBeginning(state);

    expect(state.players[0]!.points).toBe(2);
    expect(state.players[0]!.scoredBattlefieldsThisTurn.sort()).toEqual(["bf1", "bf2"]);
  });
});
