import { describe, expect, it } from "vitest";
import { runEnd } from "../src/engine/turn-manager.js";
import { recordConquest } from "../src/engine/scoring.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { holdEventTrigger } from "../src/engine/triggers.js";
import { makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";
import type { GameState } from "../src/model/game-state.js";

/**
 * The four Proving Grounds Legends. Every deck has exactly one in play from
 * turn 1, so before this each side was playing with a blank card.
 *
 * **Annie's and Garen's abilities are Chain Pending Items (2026-08-03)**, so the
 * action that fires them only PLACES them and the effect lands a chain-pop later
 * — hence the `resolveHeldTriggers` around `runEnd` and `recordConquest`. These
 * tests are about WHAT each Legend does; `test/legend-triggers-held.test.ts` is
 * where the waiting itself is pinned, and it deliberately does not settle.
 *
 * Lux's is held too now, on the `spellCast` event — there is no dispatcher left
 * to call, so `castSpell` below places it and settles.
 */
function withLegend(state: GameState, playerIndex: 0 | 1, defId: string): GameState {
  const players = [...state.players] as GameState["players"];
  players[playerIndex] = { ...players[playerIndex], legend: { ...players[playerIndex].legend, defId } };
  return { ...state, players };
}

/** A resolved Spell of `casterIndex`'s, held and settled. */
const castSpell = (state: GameState, casterIndex: 0 | 1, totalCost: number) =>
  resolveHeldTriggers(holdEventTrigger(state, { kind: "spellCast", casterIndex, totalCost }));

function runes(specs: ("R" | "E")[]) {
  return specs.map((s, i) => ({ id: `r${i}`, domain: "Fury" as const, state: s === "R" ? ("Ready" as const) : ("Exhausted" as const) }));
}

describe("Annie - Dark Child (OGS-017): at end of your turn, ready up to 2 runes", () => {
  it("readies exactly 2 of the exhausted runes", () => {
    let state = withLegend(makeState(), 0, "OGS-017");
    state.players[0]!.channeled = runes(["E", "E", "E", "R"]);

    state = resolveHeldTriggers(runEnd(state));

    const readied = state.players[0]!.channeled.filter((r) => r.state === "Ready");
    expect(readied).toHaveLength(3); // the 2 it readied + the 1 already ready
    expect(state.players[0]!.channeled.filter((r) => r.state === "Exhausted")).toHaveLength(1);
  });

  it("readies fewer than 2 when fewer are exhausted, and never un-readies", () => {
    let state = withLegend(makeState(), 0, "OGS-017");
    state.players[0]!.channeled = runes(["R", "E"]);

    state = resolveHeldTriggers(runEnd(state));

    expect(state.players[0]!.channeled.every((r) => r.state === "Ready")).toBe(true);
  });

  it("fires only for the player whose turn is ENDING", () => {
    let state = withLegend(withLegend(makeState(), 0, "OGS-017"), 1, "OGS-017");
    state.players[0]!.channeled = runes(["E", "E"]);
    state.players[1]!.channeled = runes(["E", "E"]);
    state.activePlayerIndex = 0;

    state = resolveHeldTriggers(runEnd(state));

    expect(state.players[0]!.channeled.every((r) => r.state === "Ready")).toBe(true);
    expect(state.players[1]!.channeled.every((r) => r.state === "Exhausted")).toBe(true);
  });

  it("does nothing for a different Legend", () => {
    let state = withLegend(makeState(), 0, "OGS-021");
    state.players[0]!.channeled = runes(["E", "E"]);

    state = resolveHeldTriggers(runEnd(state));

    expect(state.players[0]!.channeled.every((r) => r.state === "Exhausted")).toBe(true);
  });
});

describe("Lux - Lady of Luminosity (OGS-021): play a spell costing 5+, draw 1", () => {
  it("draws on a 5-total-cost spell", () => {
    const state = withLegend(makeState(), 0, "OGS-021");
    state.players[0]!.deck = [makeUnit(), makeUnit()];

    const next = castSpell(state, 0, 5);
    expect(next.players[0]!.hand).toHaveLength(1);
  });

  it("counts Energy PLUS Power, so 4E+1P triggers it", () => {
    const state = withLegend(makeState(), 0, "OGS-021");
    state.players[0]!.deck = [makeUnit()];

    // 4 + 1 — the case that a naive energy-only check would miss.
    expect(castSpell(state, 0, 4 + 1).players[0]!.hand).toHaveLength(1);
  });

  it("does not draw below 5", () => {
    const state = withLegend(makeState(), 0, "OGS-021");
    state.players[0]!.deck = [makeUnit()];

    expect(castSpell(state, 0, 4).players[0]!.hand).toHaveLength(0);
  });
});

describe("Garen - Might of Demacia (OGS-023): conquer with 4+ units there, draw 2", () => {
  it("draws 2 when the conquering player has 4 units at that battlefield", () => {
    const state = withLegend(makeState(), 0, "OGS-023");
    state.players[0]!.deck = [makeUnit(), makeUnit(), makeUnit()];
    state.battlefields[0]!.units = { p1: [makeUnit(), makeUnit(), makeUnit(), makeUnit()] };

    const next = resolveHeldTriggers(recordConquest(state, 0, "bf1"));

    expect(next.players[0]!.hand).toHaveLength(2);
    expect(next.players[0]!.points).toBe(1);
  });

  it("draws nothing with only 3 units there", () => {
    const state = withLegend(makeState(), 0, "OGS-023");
    state.players[0]!.deck = [makeUnit(), makeUnit()];
    state.battlefields[0]!.units = { p1: [makeUnit(), makeUnit(), makeUnit()] };

    expect(resolveHeldTriggers(recordConquest(state, 0, "bf1")).players[0]!.hand).toHaveLength(0);
  });

  it("still fires when the conquest POINT is withheld by the final-point rule", () => {
    // "When you conquer" is about taking the battlefield, not about scoring —
    // so an early return on the withheld-point path must not skip it.
    const state = withLegend(makeState(), 0, "OGS-023");
    state.players[0]!.points = 7; // one short of the 1v1 threshold
    state.players[0]!.deck = [makeUnit(), makeUnit(), makeUnit()];
    state.battlefields[0]!.units = { p1: [makeUnit(), makeUnit(), makeUnit(), makeUnit()] };

    const next = resolveHeldTriggers(recordConquest(state, 0, "bf1"));

    expect(next.players[0]!.points).toBe(7); // withheld, as before
    expect(next.players[0]!.hand.length).toBeGreaterThanOrEqual(2); // but Garen still drew
  });
});

describe("Master Yi - Wuju Bladesman (OGS-019): a friendly unit defending ALONE gets +2", () => {
  const defending = { isCombat: true, isAttackingSide: false, battlefieldId: "bf1" };

  it("grants +2 to a lone defender", () => {
    const lone = makeUnit({ might: 3 });
    const state = withLegend(makeState(), 0, "OGS-019");
    state.battlefields[0]!.units = { p1: [lone] };

    expect(effectiveMight(state, lone, 0, defending)).toBe(5);
  });

  it("grants nothing when the defender has company", () => {
    const one = makeUnit({ might: 3 });
    const state = withLegend(makeState(), 0, "OGS-019");
    state.battlefields[0]!.units = { p1: [one, makeUnit()] };

    expect(effectiveMight(state, one, 0, defending)).toBe(3);
  });

  it("grants nothing while ATTACKING alone — defend-only, per the oracle's own audit", () => {
    const lone = makeUnit({ might: 3 });
    const state = withLegend(makeState(), 0, "OGS-019");
    state.battlefields[0]!.units = { p1: [lone] };

    expect(effectiveMight(state, lone, 0, { isCombat: true, isAttackingSide: true, battlefieldId: "bf1" })).toBe(3);
  });

  it("grants nothing outside combat", () => {
    const lone = makeUnit({ might: 3 });
    const state = withLegend(makeState(), 0, "OGS-019");
    state.battlefields[0]!.units = { p1: [lone] };

    expect(effectiveMight(state, lone, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(3);
  });

  it("is not persisted onto the unit — it can't leak into a later fight", () => {
    const lone = makeUnit({ might: 3 });
    const state = withLegend(makeState(), 0, "OGS-019");
    state.battlefields[0]!.units = { p1: [lone] };

    effectiveMight(state, lone, 0, defending);
    expect(state.battlefields[0]!.units["p1"]![0]!.mightThisTurn).toBe(0);
  });
});
