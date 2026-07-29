import { describe, expect, it } from "vitest";
import { hasActivatableAbility, validateActivateAbility } from "../src/actions/validate-activate-ability.js";
import { executeActivateAbility } from "../src/actions/execute-activate-ability.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { computeEffectiveCost } from "../src/engine/rune-payment.js";
import { makeState, makeUnit, realUnitInstance } from "./fixtures.js";

describe("hasActivatableAbility", () => {
  it("is true only for Lux-Crownguard (OGS-014)", () => {
    expect(hasActivatableAbility("OGS-014")).toBe(true);
    expect(hasActivatableAbility("OGN-084")).toBe(false);
  });
});

describe("validateActivateAbility", () => {
  it("rejects a unit with no activated ability", () => {
    const unit = makeUnit();
    const state = makeState();
    state.players[0]!.baseUnits = [unit];
    expect(validateActivateAbility(state, { type: "ActivateAbility", playerIndex: 0, unitInstanceId: unit.instanceId }).ok).toBe(false);
  });

  it("rejects an exhausted Lux-Crownguard", () => {
    const lux = { ...realUnitInstance("OGS-014"), exhausted: true };
    const state = makeState();
    state.players[0]!.baseUnits = [lux];
    expect(validateActivateAbility(state, { type: "ActivateAbility", playerIndex: 0, unitInstanceId: lux.instanceId }).ok).toBe(false);
  });

  it("accepts a Ready Lux-Crownguard, base or battlefield", () => {
    const luxAtBase = realUnitInstance("OGS-014");
    const state = makeState();
    state.players[0]!.baseUnits = [luxAtBase];
    expect(validateActivateAbility(state, { type: "ActivateAbility", playerIndex: 0, unitInstanceId: luxAtBase.instanceId }).ok).toBe(true);

    const luxAtBattlefield = realUnitInstance("OGS-014");
    const state2 = makeState();
    state2.battlefields[0]!.units = { p1: [luxAtBattlefield] };
    expect(
      validateActivateAbility(state2, { type: "ActivateAbility", playerIndex: 0, unitInstanceId: luxAtBattlefield.instanceId }).ok,
    ).toBe(true);
  });
});

describe("executeActivateAbility", () => {
  it("exhausts Lux-Crownguard and grants 2 restrictedSpellEnergy", () => {
    const lux = realUnitInstance("OGS-014");
    let state = makeState();
    state.players[0]!.baseUnits = [lux];

    state = executeActivateAbility(state, { type: "ActivateAbility", playerIndex: 0, unitInstanceId: lux.instanceId });

    expect(state.players[0]!.baseUnits[0]!.exhausted).toBe(true);
    expect(state.players[0]!.restrictedSpellEnergy).toBe(2);
  });
});

describe("legalActions includes an ActivateAbility candidate for a Ready Lux-Crownguard", () => {
  it("fans out one ActivateAbility action", () => {
    const lux = realUnitInstance("OGS-014");
    const state = makeState();
    state.players[0]!.baseUnits = [lux];

    const actions = legalActions(state);
    const matching = actions.filter((a) => a.type === "ActivateAbility");
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({ playerIndex: 0, unitInstanceId: lux.instanceId });
  });

  it("does not offer it once exhausted", () => {
    const lux = { ...realUnitInstance("OGS-014"), exhausted: true };
    const state = makeState();
    state.players[0]!.baseUnits = [lux];

    const actions = legalActions(state);
    expect(actions.filter((a) => a.type === "ActivateAbility")).toHaveLength(0);
  });
});

describe("restrictedSpellEnergy is drained AFTER floating Energy, Spells only", () => {
  it("computeEffectiveCost applies floating first, then restricted, for the combined reduction", () => {
    // cost 5, floating 2, restricted 2 -> 5 - 2 - 2 = 1, regardless of order
    expect(computeEffectiveCost(2, {}, 5, 0, null, undefined, 2).energyCost).toBe(1);
  });

  it("restrictedSpellEnergy is ignored for non-Spell costs (callers pass 0)", () => {
    expect(computeEffectiveCost(0, {}, 5, 0, null, undefined, 0).energyCost).toBe(5);
  });
});
