import { describe, expect, it } from "vitest";
import { addBuff, giveMightThisTurn, giveMightThisTurnToAllFriendlies } from "../src/engine/effect-helpers.js";
import { pendingDecision, answerDecision } from "../src/engine/decisions.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit } from "./fixtures.js";

/**
 * Fiora - Grand Duelist (SFD-205) — "When one of your units becomes [Mighty],
 * you may exhaust me to channel 1 rune exhausted."
 *
 * The hard part is not hers: **"becomes" is a TRANSITION across 5 Might (711) on
 * a value this engine recomputes on every read.** There is no stored total whose
 * write could be the moment, so `withMightTransitions` brackets the raise helpers
 * and compares before with after.
 *
 * That shape has three ways to be wrong, and each has a test:
 *  - firing on a unit that was ALREADY Mighty (a raise is not a crossing);
 *  - firing on a raise that does not reach 5;
 *  - firing on a DEBUFF, which passes through the same helper with a negative
 *    amount.
 */

const FIORA = "SFD-205";

/** `might` is the unit's printed Might, so a test can start it just under 5. */
function board(might: number): GameState {
  const state = makeState({
    phase: "Action",
    players: [
      makePlayer("p1", {
        baseUnits: [makeUnit({ name: "Duelist", instanceId: "duelist", might })],
        // A rune deck to channel FROM — `channelRunesExhausted` draws from it, so
        // an empty one makes the payoff a silent no-op.
        runeDeck: Array.from({ length: 4 }, (_, i) => ({ id: `rd${i}`, domain: "Fury" as const, state: "Ready" as const })),
      }),
      makePlayer("p2", { baseUnits: [makeUnit({ name: "Foe", instanceId: "foe", might })] }),
    ],
  });
  state.players[0]!.legend = { ...state.players[0]!.legend, defId: FIORA };
  return state;
}

/** Drains the pen onto the chain and resolves until the question appears. */
function settle(state: GameState): GameState {
  let current = runCleanup(state);
  for (let guard = 0; guard < 8 && current.spellChain.length > 0; guard += 1) {
    if (pendingDecision(current)) break;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) break;
    current = submit(current, pass).state;
  }
  return current;
}

describe("Fiora fires when a unit CROSSES into [Mighty]", () => {
  it("offers the channel when a pump takes a unit to 5", () => {
    const after = settle(giveMightThisTurn(board(4), "duelist", 1));
    expect(pendingDecision(after)?.kind, "no offer on crossing into Mighty").toBe("SFD-205-channel");
  });

  it("a BUFF can cross the line too — a buff is +1 Might (710)", () => {
    const after = settle(addBuff(board(4), "duelist"));
    expect(pendingDecision(after)?.kind).toBe("SFD-205-channel");
  });

  /** A raise that does not reach 5 is not a crossing. */
  it("does NOT fire on a pump that stays under 5", () => {
    const after = settle(giveMightThisTurn(board(2), "duelist", 1));
    expect(pendingDecision(after), "fired without reaching Mighty").toBeUndefined();
  });

  /** Already Mighty — a raise is not a CROSSING, and firing again would pay out
   *  every time an already-large unit grew. */
  it("does NOT fire on a unit that was already Mighty", () => {
    const after = settle(giveMightThisTurn(board(6), "duelist", 1));
    expect(pendingDecision(after), "fired on a unit that was already Mighty").toBeUndefined();
  });

  /** A debuff runs through the same helper with a negative amount. */
  it("does NOT fire on a DEBUFF", () => {
    const after = settle(giveMightThisTurn(board(6), "duelist", -3));
    expect(pendingDecision(after), "fired on a debuff").toBeUndefined();
  });

  /** "One of YOUR units" — an enemy crossing is not hers. */
  it("does NOT fire when an ENEMY unit becomes Mighty", () => {
    const after = settle(giveMightThisTurn(board(4), "foe", 1));
    expect(pendingDecision(after), "fired on the opponent's unit").toBeUndefined();
  });

  /**
   * Singular — "one of your units" — so a mass pump that pushes two units over
   * the line is TWO triggers, each answerable on its own.
   */
  it("fires once PER unit on a mass pump", () => {
    const state = board(4);
    state.players[0]!.baseUnits = [
      makeUnit({ name: "A", instanceId: "a", might: 4 }),
      makeUnit({ name: "B", instanceId: "b", might: 4 }),
    ];
    const after = runCleanup(giveMightThisTurnToAllFriendlies(state, 0, 1));

    const held = after.spellChain.filter((e) => "listenerDefId" in e && e.listenerDefId === FIORA);
    expect(held, "a mass pump should place one Pending Item per crossing unit").toHaveLength(2);
  });
});

describe("Fiora's cost", () => {
  it("channels an EXHAUSTED rune and exhausts her", () => {
    const offered = settle(giveMightThisTurn(board(4), "duelist", 1));
    const before = offered.players[0]!.channeled.length;
    const after = answerDecision(offered, pendingDecision(offered)!.id, "channel")!;

    expect(after.players[0]!.legend.exhausted, "she was not exhausted").toBe(true);
    expect(after.players[0]!.channeled.length, "no rune was channeled").toBe(before + 1);
    // "Channel 1 rune EXHAUSTED" — it pays Power this turn but no Energy until
    // the next Awaken.
    expect(after.players[0]!.channeled.at(-1)!.state).toBe("Exhausted");
  });

  it("declining costs nothing", () => {
    const offered = settle(giveMightThisTurn(board(4), "duelist", 1));
    const before = offered.players[0]!.channeled.length;
    const after = answerDecision(offered, pendingDecision(offered)!.id, "decline")!;

    expect(after.players[0]!.legend.exhausted).toBe(false);
    expect(after.players[0]!.channeled).toHaveLength(before);
  });

  it("is not offered while she is already exhausted", () => {
    const state = board(4);
    state.players[0]!.legend = { ...state.players[0]!.legend, exhausted: true };
    const after = settle(giveMightThisTurn(state, "duelist", 1));

    expect(pendingDecision(after), "an unpayable offer was made").toBeUndefined();
  });
});
