import { describe, expect, it } from "vitest";
import { holdEventTrigger } from "../src/engine/triggers.js";
import { pendingDecision, answerDecision } from "../src/engine/decisions.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { executeActivateAbility } from "../src/actions/execute-activate-ability.js";
import { createGearToken, GOLD_TOKEN, GOLD_TOKEN_DEF_ID } from "../src/engine/token.js";
import { victoryScore } from "../src/engine/constants.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState } from "./fixtures.js";

/**
 * Renata Glasc - Chem-Baroness (SFD-201) — "When you or an ally hold, you may
 * exhaust me to play a Gold gear token exhausted. While your score is within 3
 * points of the Victory Score, your Gold [Add] an additional [1]."
 *
 * Two clauses of DIFFERENT KINDS, which is what makes her worth testing after
 * Irelia: one is a triggered ability, the other a continuous modifier that lives
 * where the Gold's own ability resolves.
 *
 * The three ways the second clause goes wrong, all asserted below:
 *  - reading the OPPONENT's score (`opponentNearVictory` exists and rewards being
 *    BEHIND — using it here would invert the card);
 *  - adding POWER instead of ENERGY (the Gold's printed pip is rainbow Power, and
 *    `floatingRainbowPower` is a different pool from `floatingEnergy`);
 *  - baking the bonus into the token when it is minted, which would stop paying
 *    when the score moved.
 */

const RENATA = "SFD-201";

function board(points = 0, opponentPoints = 0): GameState {
  const state = makeState({ phase: "Action", players: [makePlayer("p1"), makePlayer("p2")] });
  state.players[0]!.legend = { ...state.players[0]!.legend, defId: RENATA };
  state.players[0]!.points = points;
  state.players[1]!.points = opponentPoints;
  return state;
}

function hold(state: GameState): GameState {
  let current = runCleanup(holdEventTrigger(state, { kind: "battlefieldHeld", holderIndex: 0, battlefieldId: "bf1" }));
  for (let guard = 0; guard < 8 && current.spellChain.length > 0; guard += 1) {
    if (pendingDecision(current)) break;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) break;
    current = submit(current, pass).state;
  }
  return current;
}

/**
 * Spends a Gold through the REAL activation path — `executeActivateAbility`,
 * which validates first. Going straight to the ability's `resolve` would skip
 * the cost (the Gold kills itself to pay) and would not prove the bonus survives
 * the path a player actually takes.
 */
function spendGold(state: GameState): GameState {
  const gold = state.players[0]!.activeGear.find((g) => g.defId === GOLD_TOKEN_DEF_ID)!;
  return executeActivateAbility(state, {
    type: "ActivateAbility",
    playerIndex: 0,
    permanentInstanceId: gold.instanceId,
  });
}

describe("Renata's hold clause", () => {
  it("offers a Gold when you hold a battlefield", () => {
    expect(pendingDecision(hold(board()))?.kind).toBe("SFD-201-gold");
  });

  it("mints the Gold EXHAUSTED and exhausts her", () => {
    const offered = hold(board());
    const after = answerDecision(offered, pendingDecision(offered)!.id, "gold")!;

    const gold = after.players[0]!.activeGear.find((g) => g.defId === GOLD_TOKEN_DEF_ID);
    expect(gold, "no Gold was played").toBeDefined();
    expect(gold!.exhausted, "the Gold entered ready — the card prints exhausted").toBe(true);
    expect(after.players[0]!.legend.exhausted, "she was not exhausted as the cost").toBe(true);
  });

  it("declining costs nothing", () => {
    const offered = hold(board());
    const after = answerDecision(offered, pendingDecision(offered)!.id, "decline")!;

    expect(after.players[0]!.activeGear).toHaveLength(0);
    expect(after.players[0]!.legend.exhausted).toBe(false);
  });

  /** The negative for the trigger's own condition: an OPPONENT holding is not
   *  "you or an ally" in a two-seat game. */
  it("does not fire when the OPPONENT holds", () => {
    const state = board();
    const after = runCleanup(holdEventTrigger(state, { kind: "battlefieldHeld", holderIndex: 1, battlefieldId: "bf1" }));
    expect(pendingDecision(after), "she fired on the opponent's hold").toBeUndefined();
  });

  it("is not offered while she is already exhausted", () => {
    const state = board();
    state.players[0]!.legend = { ...state.players[0]!.legend, exhausted: true };
    expect(pendingDecision(hold(state)), "an unpayable offer was made").toBeUndefined();
  });
});

describe("Renata's score clause on each Gold", () => {
  function withGold(points: number, opponentPoints = 0): GameState {
    const state = board(points, opponentPoints);
    state.players[0]!.activeGear = [createGearToken(GOLD_TOKEN, false)];
    return state;
  }

  it("adds ONE ENERGY on top of the Gold's printed rainbow Power", () => {
    const near = victoryScore(board()) - 1;
    const after = spendGold(withGold(near));

    // The printed pip is rainbow POWER and is unchanged...
    expect(after.players[0]!.floatingRainbowPower, "the printed rainbow Power was lost").toBe(1);
    // ...and her clause adds ENERGY, a different pool.
    expect(after.players[0]!.floatingEnergy, "the bonus Energy was not added").toBe(1);
  });

  /** The negative: far from the Victory Score, only the printed pip. */
  it("adds nothing while your score is far from the Victory Score", () => {
    const after = spendGold(withGold(0));

    expect(after.players[0]!.floatingRainbowPower).toBe(1);
    expect(after.players[0]!.floatingEnergy, "the bonus paid while far behind").toBe(0);
  });

  /**
   * **Reads YOUR score, not the opponent's.** `opponentNearVictory` already
   * exists and rewards being BEHIND; using it here would invert the card. With
   * the OPPONENT near victory and Renata's owner on nothing, nothing is owed.
   */
  it("reads YOUR score — an opponent near victory pays nothing", () => {
    const after = spendGold(withGold(0, victoryScore(board()) - 1));

    expect(after.players[0]!.floatingEnergy, "the bonus read the OPPONENT's score").toBe(0);
  });

  /**
   * The condition is running, not minted-in: the same token pays or does not pay
   * depending on the score when it is SPENT. Baking the bonus into the token at
   * creation would pass every test above and fail this one.
   */
  it("is decided when the Gold is SPENT, not when it was made", () => {
    const near = victoryScore(board()) - 1;
    const behind = withGold(0);
    // Same token, same board — only the score differs at spend time.
    const ahead: GameState = {
      ...behind,
      players: [{ ...behind.players[0]!, points: near }, behind.players[1]!],
    };

    expect(spendGold(behind).players[0]!.floatingEnergy).toBe(0);
    expect(spendGold(ahead).players[0]!.floatingEnergy).toBe(1);
  });

  /** And a Gold with no Renata in play pays only its printed pip. */
  it("pays nothing extra without her — the control for the whole clause", () => {
    const state = withGold(victoryScore(board()) - 1);
    state.players[0]!.legend = { ...state.players[0]!.legend, defId: "SOME-OTHER-LEGEND" };

    expect(spendGold(state).players[0]!.floatingEnergy, "a Gold paid a bonus with no Renata").toBe(0);
  });
});
