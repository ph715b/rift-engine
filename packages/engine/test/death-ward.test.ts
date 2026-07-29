import { describe, expect, it } from "vitest";
import { isDeathWarded, reviveWithDeathWard } from "../src/engine/death-ward.js";
import { dealDamage, destroyUnit } from "../src/engine/effect-helpers.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { makeState, makeUnit } from "./fixtures.js";

describe("death-ward.ts: isDeathWarded / reviveWithDeathWard", () => {
  it("isDeathWarded is true only for a listed instanceId", () => {
    const state = makeState({ deathWardedUnitInstanceIds: ["u1"] });
    expect(isDeathWarded(state, "u1")).toBe(true);
    expect(isDeathWarded(state, "u2")).toBe(false);
  });

  it("reviveWithDeathWard heals, exhausts, sends to base, and clears the ward", () => {
    const unit = makeUnit({ damage: 5, exhausted: false });
    const state = makeState({ deathWardedUnitInstanceIds: [unit.instanceId] });

    const result = reviveWithDeathWard(state, unit, 0);

    expect(result.players[0]!.baseUnits).toHaveLength(1);
    expect(result.players[0]!.baseUnits[0]!.damage).toBe(0);
    expect(result.players[0]!.baseUnits[0]!.exhausted).toBe(true);
    expect(result.deathWardedUnitInstanceIds).not.toContain(unit.instanceId);
  });
});

describe("dealDamage honors a death ward instead of trashing", () => {
  it("revives a lethally-damaged warded unit to base instead of trashing it", () => {
    const target = makeUnit({ might: 3 });
    let state = makeState({ deathWardedUnitInstanceIds: [target.instanceId] });
    state.battlefields[0]!.units = { p2: [target] };

    state = dealDamage(state, 0, target.instanceId, 5);

    expect(state.battlefields[0]!.units["p2"]).toHaveLength(0);
    expect(state.players[1]!.trash).toHaveLength(0);
    expect(state.players[1]!.baseUnits).toHaveLength(1);
    expect(state.players[1]!.baseUnits[0]!.damage).toBe(0);
    expect(state.deathWardedUnitInstanceIds).toHaveLength(0);
  });

  it("an un-warded unit still trashes normally", () => {
    const target = makeUnit({ might: 3 });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [target] };

    state = dealDamage(state, 0, target.instanceId, 5);

    expect(state.players[1]!.trash).toHaveLength(1);
    expect(state.players[1]!.baseUnits).toHaveLength(0);
  });
});

describe("destroyUnit honors a death ward instead of trashing", () => {
  it("revives a warded unit instead of trashing it", () => {
    const target = makeUnit({ might: 20 });
    let state = makeState({ deathWardedUnitInstanceIds: [target.instanceId] });
    state.battlefields[0]!.units = { p2: [target] };

    state = destroyUnit(state, target.instanceId);

    expect(state.players[1]!.trash).toHaveLength(0);
    expect(state.players[1]!.baseUnits).toHaveLength(1);
  });
});

describe("combat.ts's resolveShowdown honors a death ward on a defeated unit", () => {
  it("revives a warded defeated attacker to base instead of trashing it", () => {
    const attacker = makeUnit({ might: 1 });
    const defender = makeUnit({ might: 10 });
    let state = makeState({ deathWardedUnitInstanceIds: [attacker.instanceId] });
    state.battlefields[0]!.units = { p1: [attacker], p2: [defender] };

    state = resolveShowdown(state, "bf1", 0);

    expect(state.battlefields[0]!.units["p1"]).toHaveLength(0);
    expect(state.players[0]!.trash).toHaveLength(0);
    expect(state.players[0]!.baseUnits).toHaveLength(1);
    expect(state.players[0]!.baseUnits[0]!.damage).toBe(0);
    expect(state.deathWardedUnitInstanceIds).toHaveLength(0);
  });

  it("an un-warded defeated defender still trashes normally", () => {
    const attacker = makeUnit({ might: 10 });
    const defender = makeUnit({ might: 1 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [attacker], p2: [defender] };

    state = resolveShowdown(state, "bf1", 0);

    expect(state.players[1]!.trash).toHaveLength(1);
    expect(state.players[1]!.baseUnits).toHaveLength(0);
  });
});

describe("runEnd clears deathWardedUnitInstanceIds ('this turn' lifetime)", () => {
  it("resets the list to empty", () => {
    const state = makeState({ phase: "Action", deathWardedUnitInstanceIds: ["u1", "u2"] });
    const result = runEnd(state);
    expect(result.deathWardedUnitInstanceIds).toEqual([]);
  });
});
