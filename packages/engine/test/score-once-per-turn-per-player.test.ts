import { describe, expect, it } from "vitest";
import { runAwaken, runEnd, runBeginning } from "../src/engine/turn-manager.js";
import { recordConquest } from "../src/engine/scoring.js";
import { makeState, makeUnit, realUnitInstance } from "./fixtures.js";
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

/**
 * **PINNED DIVERGENCE — Conquer triggers fire on a conquest that does not SCORE,
 * and 471.2 says they should not.** Found 2026-08-23 by the unverified-row sweep,
 * recorded in `docs/rules-conformance.md`, and deliberately NOT fixed here.
 *
 * The engine's premise is stated three times in `scoring.recordConquest`: *"'when
 * you conquer' is about taking the battlefield, not about scoring, so this stays
 * before the withheld-point branch"*. The rules file these triggers the other
 * way round — under Scoring, as one of the two things Scoring DOES:
 *
 *   **471.** "When a player Scores, two things occur:"
 *   **471.1.** "The player Gains up to one Point…"
 *   **471.2.** "**Trigger Score abilities at the Battlefield that Scored.**"
 *   **471.2.a.** "Conquer abilities trigger at a Battlefield that was Conquered."
 *   **471.2.c.** "These will only trigger **when the Battlefield is Scored**; I.E.
 *   These **cannot be triggered more than once per turn for a player**."
 *
 * With **470** ("a player may only Score, from either method, once per Battlefield
 * per turn") the I.E. follows: scoring is the gate, and it opens once a turn.
 *
 * **The engine already reads it that way on the HOLD side.** `scoreHolds` filters
 * out a battlefield where `mayScoreAt` is false BEFORE calling `recordHold`, so a
 * blocked hold fires nothing. Only the conquer path disagrees — an internal
 * inconsistency about one rule, which is what makes this worth pinning rather
 * than leaving in a note.
 *
 * **Why not fixed in the same change.** It is a behaviour change to every conquer
 * trigger in the pool, not to one card, and it would move `reachability` and
 * `battlefield-reach` together. It wants its own scoped pass with its own
 * controls — the same call `recallUnitToBase`'s exhaust divergence already has.
 *
 * These tests assert the WRONG answer on purpose. **When the divergence is
 * closed, INVERT them** (see the `fix-a-premise-pin` skill) rather than deleting
 * them: a conquer trigger that silently stops firing just makes cards quietly
 * weaker, and nothing else here would notice.
 */
describe("471.2.c: conquer triggers should be gated on SCORING (divergent, pinned)", () => {
  /** Forgotten Monument (SFD-209) — "players can't score here until their third
   *  turn". It blocks the SCORING rather than the POINT, which is exactly 471.2's
   *  gate, and it is the most reachable way to reach this branch. */
  const FORGOTTEN_MONUMENT = "SFD-209";
  /** Sett - Brawler — "when I conquer, buff me", the plainest conquer trigger in
   *  the pool and the one this pin uses as its subject. */
  const SETT_BRAWLER = "OGN-164";

  const monumentAt = (): GameState => {
    const state = makeState({ phase: "Action", activePlayerIndex: 0, turnNumber: 1 });
    state.battlefields[0] = { ...state.battlefields[0]!, defId: FORGOTTEN_MONUMENT };
    return state;
  };

  it("a conquest whose SCORING is blocked still holds the conquer triggers — 471.2 says it should not", () => {
    // Forgotten Monument prints no conquer ability of its own, so the subject is
    // a UNIT standing there: Sett - Brawler's "when I conquer, buff me", held by
    // `holdEventTrigger` from the same call.
    const state = monumentAt();
    state.battlefields[0] = { ...state.battlefields[0]!, units: { p1: [realUnitInstance(SETT_BRAWLER)] } };
    const conquered = recordConquest(state, 0, "bf1");
    expect(conquered.players[0]!.scoredBattlefieldsThisTurn, "the fixture did not block scoring").toEqual([]);
    expect(conquered.players[0]!.points, "the fixture scored after all").toBe(0);
    expect(
      conquered.pendingTriggers.map((e) => e.listenerDefId),
      "DIVERGENCE CLOSED — a blocked conquest no longer triggers; invert this pin",
    ).toEqual([SETT_BRAWLER]);
  });

  it("...and the HOLD path already gates the same rule correctly — the contrast", () => {
    // `scoreHolds` filters on `mayScoreAt` before recording, so nothing fires.
    // This is the half that agrees with 471.2, and it is why the conquer half
    // reads as an inconsistency rather than a considered choice.
    const state = monumentAt();
    state.phase = "Beginning";
    state.battlefields[0] = { ...state.battlefields[0]!, units: { p1: [makeUnit()] }, controllerId: "p1" };
    const held = runBeginning(state);
    expect(held.players[0]!.points, "the Monument let a blocked hold score").toBe(0);
    expect(held.pendingTriggers.filter((e) => e.source === "battlefield")).toHaveLength(0);
  });

  it("a SECOND conquest of one battlefield in a turn triggers again — 471.2.c forbids it", () => {
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0] = { ...state.battlefields[0]!, defId: "OGN-298" }; // Zaun Warrens
    const once = recordConquest(state, 0, "bf1");
    expect(once.players[0]!.scoredBattlefieldsThisTurn, "the first conquest did not score").toEqual(["bf1"]);
    const twice = recordConquest({ ...once, pendingTriggers: [] }, 0, "bf1");
    expect(
      twice.pendingTriggers.filter((e) => e.source === "battlefield"),
      "DIVERGENCE CLOSED — the second conquest no longer triggers; invert this pin",
    ).toHaveLength(1);
  });
});
