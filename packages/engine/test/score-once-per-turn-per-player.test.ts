import { describe, expect, it } from "vitest";
import { runAwaken, runEnd, runBeginning } from "../src/engine/turn-manager.js";
import { recordConquest } from "../src/engine/scoring.js";
import { makeState, makeUnit } from "./fixtures.js";
import type { GameState } from "../src/model/game-state.js";

/**
 * **470 is once per battlefield per TURN, and a turn ending lifts it for BOTH
 * players.**
 *
 * Reported from play 2026-08-22: "opponent used Charm to bring my Kai'Sa to a
 * battlefield on their turn. I got the draw from Kai'Sa but did not score a
 * point from conquer."
 *
 * Kai'Sa - Survivor (OGN-039) prints "When I conquer, draw 1", so the report is
 * internally inconsistent in a way that names the bug precisely: the conquer
 * TRIGGER fired, which means `recordConquest` ran, and 471 says scoring awards
 * the point. A conquest that fires its triggers and pays nothing is the
 * `alreadyScored` branch — the one Forgotten Monument and Tianna Crownguard are
 * written for — reached by a player who had not, on this turn, scored anything.
 *
 * # The cause
 *
 * `scoredBattlefieldsThisTurn` was cleared in `runAwaken`, for the ACTIVE PLAYER
 * ONLY. Its sibling `conqueredBattlefieldsThisTurn` is reset for both players in
 * the end-of-turn cleanup beside every other per-turn tally. So a battlefield
 * scored on my turn stayed flagged for me through my opponent's entire turn, and
 * anything that handed me control during it — Charm, a Showdown they lost, a
 * unit of mine arriving — conquered without scoring.
 *
 * 469.1 is "a player gains Control of a Battlefield they did not yet Score this
 * turn", and 470 is "only Score, from either method, once per Battlefield per
 * turn". Neither says "your turn"; a turn is a turn, and the opponent's is a
 * different one from mine.
 *
 * **This is why the report matters more than it looks.** Scoring on the
 * opponent's turn is not an edge case — it is how a defender is rewarded for
 * winning a Showdown they did not start.
 */

/** A board where `scorer` already scored bf1 earlier in the game, mid-turn of
 *  whoever `active` is. */
function board(active: 0 | 1, scorer: 0 | 1, scored: string[]): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: active });
  state.players[scorer]!.scoredBattlefieldsThisTurn = [...scored];
  return state;
}

const pointsOf = (state: GameState, i: 0 | 1) => state.players[i]!.points;

describe("the per-turn scoring flag is cleared for BOTH players", () => {
  it("a turn ending clears the non-active player's list too", () => {
    // The unit of the bug. Player 0 scored bf1 on their own turn; player 1's turn
    // is about to begin, and player 0's restriction must lift with the turn.
    const midTurn = board(0, 0, ["bf1"]);
    const after = runEnd(midTurn);
    expect(
      after.players[0]!.scoredBattlefieldsThisTurn,
      "the ending turn left the scorer still flagged, so they cannot score on the opponent's turn",
    ).toEqual([]);
  });

  it("...and the active player's, which already worked — the control", () => {
    // Without this, the assertion above could pass on an implementation that
    // cleared the wrong player.
    const after = runEnd(board(0, 1, ["bf1"]));
    expect(after.players[1]!.scoredBattlefieldsThisTurn, "the other player's list survived the turn").toEqual([]);
  });

  it("does not clear it MID-turn — the restriction is real within a turn", () => {
    // The other direction, and the one that stops this becoming "scoring is
    // never blocked": inside a single turn 470 still holds.
    const state = board(0, 0, ["bf1"]);
    expect(state.players[0]!.scoredBattlefieldsThisTurn, "the fixture is not set up").toEqual(["bf1"]);
    const conquered = recordConquest(state, 0, "bf1");
    expect(
      pointsOf(conquered, 0),
      "a second score of the same battlefield in ONE turn paid a point — 470 is broken the other way",
    ).toBe(pointsOf(state, 0));
  });
});

describe("the reported game: conquering on the OPPONENT's turn", () => {
  it("pays a point for a battlefield scored on the player's own previous turn", () => {
    // End to end over the turn boundary, which is the shape the report describes.
    let state = board(0, 0, ["bf1"]);
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      units: { p1: [makeUnit({ instanceId: "kaisa", name: "Kai'Sa - Survivor" })] },
    };
    // Player 0's turn ends; player 1's begins. `runEnd` leaves the phase at
    // Awaken, so the Awaken runs before the Beginning Phase — the order the real
    // turn takes, and getting it backwards is a fixture error this repo has
    // recorded before.
    state = runBeginning(runAwaken(runEnd(state)));
    expect(state.activePlayerIndex, "the turn did not pass").toBe(1);

    const before = pointsOf(state, 0);
    const after = recordConquest(state, 0, "bf1");
    expect(
      pointsOf(after, 0),
      "conquering on the opponent's turn fired the triggers and paid no point — the reported bug",
    ).toBe(before + 1);
  });

  it("still refuses a SECOND score of that battlefield within the opponent's turn", () => {
    // The restriction re-arms for the new turn rather than being removed.
    let state = board(0, 0, ["bf1"]);
    state = runBeginning(runAwaken(runEnd(state)));
    const once = recordConquest(state, 0, "bf1");
    const twice = recordConquest(once, 0, "bf1");
    expect(pointsOf(twice, 0), "the same battlefield scored twice in one turn").toBe(pointsOf(once, 0));
  });
});
