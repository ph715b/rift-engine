import { describe, expect, it } from "vitest";
import { dispatchOnPlayUnit, targetingForUnitTrigger, unitTriggerHasVisionChoice } from "../src/engine/unit-triggers.js";
import { makeState, makeUnit, playUnitTrigger, realUnitInstance } from "./fixtures.js";

describe("Vision (Mystic Poro, Sai Scout): look at top card, optionally recycle", () => {
  it("recycle=true moves the top card to the bottom of the deck", () => {
    const mysticPoro = realUnitInstance("OGN-171");
    const top = realUnitInstance("OGN-210");
    const rest = realUnitInstance("OGN-215");
    let state = makeState();
    state.players[0]!.deck = [top, rest];

    state = playUnitTrigger(state, mysticPoro, 0, "base", { visionRecycle: true });

    expect(state.players[0]!.deck.map((c) => c.instanceId)).toEqual([rest.instanceId, top.instanceId]);
  });

  it("recycle=false leaves the deck order unchanged", () => {
    const saiScout = realUnitInstance("OGN-174");
    let state = makeState();
    state.players[0]!.deck = [realUnitInstance("OGN-210"), realUnitInstance("OGN-215")];
    const before = state.players[0]!.deck.map((c) => c.instanceId);

    state = playUnitTrigger(state, saiScout, 0, "base", { visionRecycle: false });

    expect(state.players[0]!.deck.map((c) => c.instanceId)).toEqual(before);
  });

  it("no-ops on an empty deck rather than crashing", () => {
    const mysticPoro = realUnitInstance("OGN-171");
    const state = makeState();
    expect(dispatchOnPlayUnit(state, mysticPoro, 0, "base", { visionRecycle: true })).toBe(state);
  });

  it("both cards are flagged as having a Vision choice", () => {
    // Asked of the BOARD now, not of a hardcoded set of two defIds: [Vision] is a
    // keyword and Gemcraft Seer grants it, so the question is "will this card have
    // Vision as it enters" rather than "is it one of the two that print it". An
    // empty board is the control — these two still answer yes on their own text.
    const empty = makeState();
    expect(unitTriggerHasVisionChoice(empty, 0, "OGN-171")).toBe(true);
    expect(unitTriggerHasVisionChoice(empty, 0, "OGN-174")).toBe(true);
    expect(unitTriggerHasVisionChoice(empty, 0, "OGN-210")).toBe(false); // Daring Poro — no Vision
  });
});

describe("Tibbers: deal 3 to all units at battlefields, both owners", () => {
  it("damages every battlefield unit, friendly and enemy, not base units", () => {
    const tibbers = realUnitInstance("OGS-018");
    const friendlyBf = makeUnit({ might: 5 });
    const enemyBf = makeUnit({ might: 5 });
    const friendlyBase = makeUnit({ might: 5 });

    let state = makeState();
    state.battlefields[0]!.units = { p1: [friendlyBf], p2: [enemyBf] };
    state.players[0]!.baseUnits = [friendlyBase];

    state = playUnitTrigger(state, tibbers, 0, "base");

    expect(state.battlefields[0]!.units["p1"]![0]!.damage).toBe(3);
    expect(state.battlefields[0]!.units["p2"]![0]!.damage).toBe(3);
    expect(state.players[0]!.baseUnits[0]!.damage).toBe(0); // base units untouched
  });
});

describe("First Mate: ready another unit", () => {
  it("readies the targeted (exhausted) unit", () => {
    const firstMate = realUnitInstance("OGN-132");
    const target = makeUnit({ exhausted: true });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [target] };

    state = playUnitTrigger(state, firstMate, 0, "base", { targetUnitInstanceId: target.instanceId });

    expect(state.battlefields[0]!.units["p1"]![0]!.exhausted).toBe(false);
  });

  it("requires a unit-kind target", () => {
    // "Ready another unit" names no battlefield, so base units are in scope.
    expect(targetingForUnitTrigger("OGN-132")).toEqual({ kind: "unit", scope: "anywhere" });
  });
});

describe("Faithful Manufactor: play a 1-Might Recruit token at its own destination", () => {
  it("places a token in base when played to base", () => {
    const manufactor = realUnitInstance("OGN-211");
    let state = makeState();

    state = playUnitTrigger(state, manufactor, 0, "base");

    expect(state.players[0]!.baseUnits).toHaveLength(1);
    expect(state.players[0]!.baseUnits[0]!.isToken).toBe(true);
  });

  it("places a token at the battlefield it was played to", () => {
    const manufactor = realUnitInstance("OGN-211");
    let state = makeState();

    state = playUnitTrigger(state, manufactor, 0, { battlefieldId: "bf1" });

    expect(state.battlefields[0]!.units["p1"]).toHaveLength(1);
    expect(state.battlefields[0]!.units["p1"]![0]!.isToken).toBe(true);
  });
});

describe("Maddened Marauder: move a unit from a battlefield to its own base (either owner)", () => {
  it("moves a friendly unit to the caster's base", () => {
    const marauder = realUnitInstance("OGN-191");
    const friendly = makeUnit();
    let state = makeState();
    state.battlefields[0]!.units = { p1: [friendly] };

    state = playUnitTrigger(state, marauder, 0, "base", { targetUnitInstanceId: friendly.instanceId });

    expect(state.battlefields[0]!.units["p1"]).toHaveLength(0);
    expect(state.players[0]!.baseUnits).toHaveLength(1);
    expect(state.players[0]!.baseUnits[0]!.exhausted).toBe(true);
  });

  it("moves an ENEMY unit to the enemy's own base, not the caster's", () => {
    const marauder = realUnitInstance("OGN-191");
    const enemy = makeUnit();
    let state = makeState();
    state.battlefields[0]!.units = { p2: [enemy] };

    state = playUnitTrigger(state, marauder, 0, "base", { targetUnitInstanceId: enemy.instanceId });

    expect(state.battlefields[0]!.units["p2"]).toHaveLength(0);
    expect(state.players[1]!.baseUnits).toHaveLength(1); // p2's own base, not p1's
    expect(state.players[0]!.baseUnits).toHaveLength(0);
  });
});

describe("dispatchOnPlayUnit: no-op for a Unit with no registered trigger", () => {
  it("returns the same state unchanged", () => {
    const daringPoro = realUnitInstance("OGN-210"); // [Assault] only, no on-play trigger
    const state = makeState();
    expect(dispatchOnPlayUnit(state, daringPoro, 0, "base")).toBe(state);
  });
});
