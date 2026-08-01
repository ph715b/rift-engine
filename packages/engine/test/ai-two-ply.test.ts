import { describe, expect, it } from "vitest";
import { BASELINE_WEIGHTS, chooseAction } from "../src/ai/heuristic-ai.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type UnitInstance } from "../src/model/card.js";
import type { Domain } from "../src/model/domain.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit } from "./fixtures.js";

/**
 * The opponent answers back.
 *
 * Every candidate the AI scores is driven to a settled state first, and until
 * now that settle assumed the opponent would simply pass — an optimistic
 * assumption rather than the only legal outcome, since [Action]/[Reaction]
 * casting exists. So the AI attacked and cast into replies it could have
 * anticipated.
 *
 * These pin the two properties that make the fix a fix rather than a slowdown:
 * the reply is actually consulted, and the search that consults it terminates.
 */

const registry = defaultCardRegistry();
const GUST = "OGN-169"; // [Reaction] return a unit at a battlefield with 3 Might or less to hand
const runes = (domain: Domain, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

const TWO_PLY = { ...BASELINE_WEIGHTS, twoPly: true };
const ONE_PLY = { ...BASELINE_WEIGHTS, twoPly: false };

describe("the opponent model is consulted", () => {
  /**
   * Player 0 can attack an undefended battlefield. Player 1 holds a Reaction
   * that undoes it — Gust returns the attacker to hand — and the runes to cast.
   *
   * A 1-ply AI sees only "I take the battlefield". A 2-ply one sees the reply.
   */
  function attackIntoAReply(opponentCanRespond: boolean): { state: GameState; attacker: UnitInstance } {
    // 3 Might, not more: Gust only reaches "a unit with 3 Might or less", so a
    // bigger attacker would make the opponent unable to reply and prove nothing.
    const attacker = makeUnit({ name: "Attacker", might: 3 });
    const state = makeState({
      phase: "Action",
      activePlayerIndex: 0,
      players: [
        makePlayer("p1", { channeled: runes("Fury", 6) }),
        makePlayer("p2", {
          hand: opponentCanRespond ? [createCardInstance(registry.get(GUST))] : [],
          channeled: opponentCanRespond ? runes("Calm", 6) : [],
        }),
      ],
    });
    state.players[0]!.baseUnits = [attacker];
    return { state, attacker };
  }

  it("still finds the attack when the opponent cannot answer", () => {
    // The control case. Without it, "the AI declined" proves nothing — it might
    // simply never attack.
    const { state } = attackIntoAReply(false);
    const action = chooseAction(state, TWO_PLY);
    expect(action.type).toBe("MoveUnit");
  });

  it("scores that same attack differently once the opponent CAN answer", () => {
    // The property under test is that the reply is consulted at all. Asserting a
    // specific chosen action would be asserting the evaluator's taste, which is
    // tuned by win rate rather than by opinion — so this asks only that the two
    // depths reach different conclusions about the same board.
    const { state } = attackIntoAReply(true);

    const onePly = chooseAction(state, ONE_PLY);
    const twoPly = chooseAction(state, TWO_PLY);

    expect(legalActions(state).length).toBeGreaterThan(1); // there IS a choice to differ on
    expect(JSON.stringify(twoPly)).not.toBe(JSON.stringify(onePly));
  });
});

describe("the search terminates", () => {
  /** A busy board: both sides hold Reactions and runes, at two battlefields. */
  function busyBoard(): GameState {
    const state = makeState({
      phase: "Action",
      activePlayerIndex: 0,
      players: [
        makePlayer("p1", { hand: [createCardInstance(registry.get(GUST))], channeled: runes("Fury", 10) }),
        makePlayer("p2", { hand: [createCardInstance(registry.get(GUST))], channeled: runes("Calm", 10) }),
      ],
    });
    state.players[0]!.baseUnits = [makeUnit({ name: "A1", might: 4 }), makeUnit({ name: "A2", might: 3 })];
    state.players[1]!.baseUnits = [makeUnit({ name: "B1", might: 4 })];
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "A3", might: 2 })], p2: [makeUnit({ name: "B2", might: 2 })] };
    return state;
  }

  it("returns an action rather than recursing forever", () => {
    // The depth guard, stated as the only thing that can be observed from
    // outside: the opponent's reply is settled with the model turned OFF, so the
    // two sides cannot model each other without end. If that guard were removed
    // this would not fail an assertion — it would never return at all, which is
    // why the test is a timeout rather than an equality.
    const action = chooseAction(busyBoard(), TWO_PLY);
    expect(action).toBeDefined();
  }, 5000);

  it("costs a bounded multiple of the one-ply search", () => {
    // Two plies is affordable BECAUSE the opponent only gets to reply where they
    // actually hold priority — not on every candidate. If that ever stops being
    // true this is the test that notices, before a self-play probe times out.
    const state = busyBoard();
    const t0 = Date.now();
    chooseAction(state, ONE_PLY);
    const one = Math.max(1, Date.now() - t0);
    const t1 = Date.now();
    chooseAction(state, TWO_PLY);
    const two = Date.now() - t1;

    expect(two).toBeLessThan(one * 50);
  }, 20000);
});

describe("the baseline is still the baseline", () => {
  it("defaults to the tuning in BASELINE_WEIGHTS", () => {
    // chooseAction's default argument and BASELINE_WEIGHTS must not drift apart,
    // or the A/B harness would be comparing a candidate against something other
    // than what actually ships.
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.baseUnits = [makeUnit({ name: "Solo", might: 3 })];

    expect(JSON.stringify(chooseAction(state))).toBe(JSON.stringify(chooseAction(state, BASELINE_WEIGHTS)));
  });
});
