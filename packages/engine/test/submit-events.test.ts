import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { makeState, makeUnit, realUnitInstance } from "./fixtures.js";
import type { GameState } from "../src/model/game-state.js";

/**
 * **`submit` reports what happened, not just that something did.**
 *
 * It returned `{ state, result }` and the result was `{ type: "Ok" }`. The engine
 * computed a rich event stream on the way — 29 kinds, all through one funnel —
 * and discarded every one, so a caller had to recover causation by DIFFING
 * snapshots. `packages/web` has two independent differs built for exactly that,
 * and neither can tell "died in combat" from "killed by a spell" from "recalled
 * and then discarded": all three look like a battlefield with one fewer card.
 *
 * The events are the engine's own answer to that question, and it already knew it.
 *
 * # The two properties that make `events` mean anything
 *
 * **Per ACTION, not cumulative.** `submit` clears the list before running, so the
 * events belong to the action just submitted. Without that a caller reading it
 * after ten actions would narrate the whole game every time.
 *
 * **Empty for a refusal, and the state comes back identical.** "A refused action
 * must leave the state alone" is a contract two other tests assert; clearing the
 * list on the way in creates a fresh object, so `submit` hands the ORIGINAL back
 * when the result is Invalid. Nothing happened, so nothing is reported.
 */

const runes = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `r${i}`,
    domain: (["Fury", "Chaos", "Calm", "Body", "Mind", "Order"] as const)[i % 6]!,
    state: "Ready" as const,
  }));

/** A board where the human can move a unit — the simplest action that raises a
 *  real, nameable event. */
function movable(): { state: GameState } {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.channeled = runes(8);
  state.players[0]!.baseUnits = [makeUnit({ instanceId: "walker", name: "Walker" })];
  return { state };
}

describe("events describe the action just submitted", () => {
  it("a MOVE reports that a unit moved", () => {
    const { state } = movable();
    const move = legalActions(state).find((a) => a.type === "MoveUnit");
    expect(move, "the fixture offers no move — nothing to report on").toBeDefined();

    const { events } = submit(state, move!);
    expect(
      events.map((e) => e.kind),
      "a move raised no events at all — the funnel is not recording",
    ).toContain("unitMoved");
  });

  it("...and the report is not empty for an ordinary action — the control", () => {
    // Without this, every assertion here would pass against a `submit` that
    // returned `events: []` unconditionally.
    const { state } = movable();
    const move = legalActions(state).find((a) => a.type === "MoveUnit")!;
    expect(submit(state, move).events.length).toBeGreaterThan(0);
  });

  it("is PER ACTION, not cumulative across a game", () => {
    // The property that makes it usable. A caller reading this after ten actions
    // must see the tenth action's events, not all ten actions'.
    const { state } = movable();
    const move = legalActions(state).find((a) => a.type === "MoveUnit")!;
    const afterFirst = submit(state, move);

    const pass = legalActions(afterFirst.state).find((a) => a.type === "Pass" || a.type === "PassFocus");
    if (!pass) return;
    const afterSecond = submit(afterFirst.state, pass);

    expect(
      afterSecond.events.some((e) => e.kind === "unitMoved"),
      "the second action reported the first action's move",
    ).toBe(false);
  });
});

describe("a refused action reports nothing and changes nothing", () => {
  it("returns no events", () => {
    const { state } = movable();
    // A Pass from the player whose turn it is NOT — refused by the validator.
    const { events } = submit(state, { type: "Pass", playerIndex: 1 });
    expect(events, "a refusal narrated something").toEqual([]);
  });

  it("...and hands back the IDENTICAL state", () => {
    // Clearing the list on the way in makes a fresh object, so this is a real
    // guard rather than a tautology — `submit` restores the caller's own state
    // when the result is Invalid. Two other tests assert the same contract from
    // the other side.
    const { state } = movable();
    const outcome = submit(state, { type: "Pass", playerIndex: 1 });
    expect(outcome.result.type, "the fixture's illegal action was accepted").toBe("Invalid");
    expect(outcome.state, "a refused action did not leave the state alone").toBe(state);
  });
});

describe("the list is bounded", () => {
  it("never exceeds the cap, however long the action", () => {
    // `submit` clears per action so real play never approaches it, but the AI's
    // lookahead calls the executors directly and would otherwise grow the list
    // across a whole rollout — appending to a growing array copies it, so an
    // unbounded list is quadratic work nothing ever reads.
    const { state } = movable();
    const move = legalActions(state).find((a) => a.type === "MoveUnit")!;
    const { state: after } = submit(state, move);
    expect((after.recentEvents ?? []).length).toBeLessThanOrEqual(64);
  });
});
