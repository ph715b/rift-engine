import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { answerDecision, optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { costExhaustsLegend } from "../src/engine/card-effects.js";
import { isOpenBattlefield } from "../src/engine/unit-triggers.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { Domain } from "../src/model/domain.js";
import type { RuneCard } from "../src/model/rune.js";
import { makePlayer, makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * Bard - Mercurial (SFD-079) — "You may exhaust your legend as an additional cost
 * to play me. When you play me, if you paid the additional cost, move any number
 * of your units to an open battlefield."
 *
 * # The cost is a BOOLEAN, not a pick
 *
 * A player has one Legend, so there is nothing to choose — which makes this
 * `OPTIONAL_POWER_COSTS`' shape (two variants, one flag the trigger reads) rather
 * than `OPTIONAL_UNIT_COSTS`', whose whole job is to fan out per eligible
 * permanent and carry the chosen id. The handoff called for "an `exhaustLegend`
 * kind [that] needs no id field"; a kind with no id in a table built to carry one
 * is a worse fit than the boolean table one row down.
 *
 * # "An OPEN battlefield" is 170.11.c
 *
 * "Unoccupied AND uncontrolled", and `isOpenBattlefield` was already that
 * predicate — written for Sai Scout's placement grant. Both halves are load
 * bearing and both are asserted below, because a version that checked only
 * `controllerId === null` would offer a battlefield with an enemy standing on it,
 * which is the opposite of what the card is for.
 */

const registry = defaultCardRegistry();
const BARD = "SFD-079";

const runes = (domain: Domain, n: number): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

/** p1 holds Bard, can pay him (4 Energy + 1 Mind Power), and has two units at
 *  home. bf1 and bf2 both start open. */
function board(): { state: GameState; bardId: string } {
  const bard = realUnitInstance(BARD);
  const state = makeState({
    phase: "Action",
    players: [
      makePlayer("p1", {
        hand: [bard],
        channeled: runes("Mind", 8),
        baseUnits: [makeUnit({ instanceId: "a", name: "Alpha" }), makeUnit({ instanceId: "b", name: "Beta" })],
      }),
      makePlayer("p2"),
    ],
  });
  return { state, bardId: bard.instanceId };
}

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

/** Plays Bard to BASE, paying or declining the Legend exhaust. */
function play(state: GameState, bardId: string, paid: boolean): GameState {
  const candidate = playsOf(state, bardId).find(
    (p) => (p.exhaustLegendPaid ?? false) === paid && p.destinationBattlefieldId === undefined,
  );
  expect(candidate, `no ${paid ? "paid" : "unpaid"} Bard was offered`).toBeDefined();
  return resolveHeldTriggers(executePlayCard(state, candidate!));
}

const at = (state: GameState, bfIndex: number) =>
  (state.battlefields[bfIndex]!.units[state.players[0]!.id] ?? []).map((u) => u.instanceId);

describe("Bard - Mercurial: the additional cost", () => {
  it("is registered as a Legend exhaust", () => {
    expect(costExhaustsLegend(BARD)).toBe(true);
  });

  it("offers both a paid and a declined variant", () => {
    const { state, bardId } = board();
    const variants = playsOf(state, bardId);
    expect(variants.some((p) => p.exhaustLegendPaid === true)).toBe(true);
    expect(variants.some((p) => p.exhaustLegendPaid === undefined)).toBe(true);
  });

  it("exhausts the legend when paid", () => {
    const { state, bardId } = board();
    expect(play(state, bardId, true).players[0]!.legend.exhausted).toBe(true);
  });

  it("leaves the legend alone when declined", () => {
    const { state, bardId } = board();
    expect(play(state, bardId, false).players[0]!.legend.exhausted).toBe(false);
  });

  it("is NOT offered while the legend is already exhausted", () => {
    // 416.3 — a cost that cannot be completed is not one you may choose to pay,
    // so the paid variant simply disappears rather than being offered and refused.
    const { state, bardId } = board();
    state.players[0]!.legend = { ...state.players[0]!.legend, exhausted: true };
    const variants = playsOf(state, bardId);
    expect(variants.length, "Bard went unplayable with an exhausted legend").toBeGreaterThan(0);
    expect(variants.some((p) => p.exhaustLegendPaid === true)).toBe(false);
  });

  it("the validator refuses a hand-built claim against an exhausted legend", () => {
    const { state, bardId } = board();
    const paid = playsOf(state, bardId).find((p) => p.exhaustLegendPaid === true)!;
    const spent = { ...state, players: [{ ...state.players[0]!, legend: { ...state.players[0]!.legend, exhausted: true } }, state.players[1]!] as GameState["players"] };
    expect(validatePlayCard(spent, paid).ok).toBe(false);
  });

  it("the validator accepts every variant the enumerator offers", () => {
    const { state, bardId } = board();
    for (const candidate of playsOf(state, bardId)) {
      const result = validatePlayCard(state, candidate);
      expect(result.ok, result.ok ? "" : result.error).toBe(true);
    }
  });
});

describe("Bard - Mercurial: the move", () => {
  it("asks nothing at all when the cost was declined", () => {
    const { state, bardId } = board();
    expect(pendingDecision(play(state, bardId, false))).toBeUndefined();
  });

  it("moves any number of your units to the open battlefield", () => {
    // Both battlefields start open, so the WHERE question is real; then both
    // units, then stop.
    const { state, bardId } = board();
    let current = play(state, bardId, true);
    expect(pendingDecision(current)?.kind).toBe("SFD-079-where");
    current = answerDecision(current, pendingDecision(current)!.id, "bf1")!;
    for (const pick of ["a", "b"]) {
      current = answerDecision(current, pendingDecision(current)!.id, pick)!;
    }
    expect(at(current, 0)).toEqual(["a", "b"]);
    expect(current.players[0]!.baseUnits.map((u) => u.instanceId)).toEqual([bardId]);
  });

  it("stops on demand — 'any number' includes zero", () => {
    const { state, bardId } = board();
    let current = play(state, bardId, true);
    current = answerDecision(current, pendingDecision(current)!.id, "bf1")!;
    current = answerDecision(current, pendingDecision(current)!.id, "stop")!;
    expect(pendingDecision(current)).toBeUndefined();
    expect(at(current, 0)).toEqual([]);
  });

  it("offers only OPEN battlefields — occupied is not open", () => {
    // 170.11.c's first half. An enemy standing at bf1 takes it off the list even
    // though nobody controls it.
    const { state, bardId } = board();
    state.battlefields[0]!.units = { p2: [makeUnit({ name: "Squatter" })] };
    expect(isOpenBattlefield(state.battlefields[0]!)).toBe(false);
    const after = play(state, bardId, true);
    // One open battlefield left, so the WHERE question resolves itself and the
    // WHICH question is what remains.
    expect(pendingDecision(after)?.kind).toBe("SFD-079-move");
    expect(pendingDecision(after)?.battlefieldId).toBe("bf2");
  });

  it("counts a CONTROLLED battlefield as not open either", () => {
    // The second half of 170.11.c, and the one a version checking occupancy alone
    // would miss. Asserted against the predicate rather than end to end, because
    // a battlefield that is controlled and EMPTY cannot survive to the question:
    // 323.11 lapses that control in the very Cleanup the play runs. The
    // predicate is what the decision consults, so this is the reachable half.
    const { state } = board();
    state.battlefields[0]!.controllerId = state.players[0]!.id;
    expect(isOpenBattlefield(state.battlefields[0]!)).toBe(false);
  });

  it("asks nothing when no battlefield is open", () => {
    // Garrisoned by both sides, so neither can lapse back to open — which is
    // also the ordinary mid-game board this card is cast into.
    const { state, bardId } = board();
    state.battlefields[0]!.controllerId = state.players[0]!.id;
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Garrison" })] };
    state.battlefields[1]!.controllerId = state.players[1]!.id;
    state.battlefields[1]!.units = { p2: [makeUnit({ name: "Theirs" })] };
    expect(pendingDecision(play(state, bardId, true))).toBeUndefined();
  });

  it("keeps the destination once chosen, even though arriving closes it", () => {
    // The reason the battlefield is captured on the decision rather than
    // re-derived: the first unit to land makes it occupied, so a question that
    // re-asked "which open battlefield" would offer nothing after one move.
    const { state, bardId } = board();
    let current = play(state, bardId, true);
    current = answerDecision(current, pendingDecision(current)!.id, "bf1")!;
    current = answerDecision(current, pendingDecision(current)!.id, "a")!;
    expect(isOpenBattlefield(current.battlefields[0]!), "bf1 is still open after a unit arrived").toBe(false);
    const options = optionsFor(current, pendingDecision(current)!).map((o) => o.id);
    expect(options, "the second unit was not still offered").toContain("b");
  });

  it("offers every unit you control, not only tokens", () => {
    // The one difference from Azir - Sovereign's `movableTokensFor`, and the
    // mutation that separates the two helpers.
    const { state, bardId } = board();
    let current = play(state, bardId, true);
    current = answerDecision(current, pendingDecision(current)!.id, "bf1")!;
    const options = optionsFor(current, pendingDecision(current)!).map((o) => o.id).sort();
    expect(options).toEqual([bardId, "a", "b", "stop"].sort());
  });
});

describe("Bard - Mercurial: coverage", () => {
  it("reports as implemented", () => {
    expect(isCardImplemented(registry.get(BARD))).toBe(true);
  });
});
