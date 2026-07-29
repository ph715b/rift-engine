import { describe, expect, it } from "vitest";
import { modifiedDamageAmount } from "../src/engine/damage-modifiers.js";
import { dealDamage } from "../src/engine/effect-helpers.js";
import { makeState, makeUnit } from "./fixtures.js";

describe("modifiedDamageAmount: Annie-Fiery (OGS-001)", () => {
  it("adds +1 to a caster's damage when Annie-Fiery is in their base", () => {
    const state = makeState();
    state.players[0]!.baseUnits = [makeUnit({ defId: "OGS-001" })];
    expect(modifiedDamageAmount(state, 0, 2)).toBe(3);
  });

  it("adds +1 when Annie-Fiery is at a battlefield instead", () => {
    const state = makeState();
    state.battlefields[0]!.units = { p1: [makeUnit({ defId: "OGS-001" })] };
    expect(modifiedDamageAmount(state, 0, 2)).toBe(3);
  });

  it("leaves damage unmodified without Annie-Fiery", () => {
    const state = makeState();
    expect(modifiedDamageAmount(state, 0, 2)).toBe(2);
  });

  it("does not boost the opponent's damage from the caster's own Annie-Fiery", () => {
    const state = makeState();
    state.players[0]!.baseUnits = [makeUnit({ defId: "OGS-001" })];
    expect(modifiedDamageAmount(state, 1, 2)).toBe(2);
  });
});

describe("dealDamage applies the modifier at its own choke point", () => {
  it("Annie-Fiery boosts a caster's dealDamage call by 1", () => {
    const target = makeUnit({ might: 5 });
    let state = makeState();
    state.players[0]!.baseUnits = [makeUnit({ defId: "OGS-001" })];
    state.battlefields[0]!.units = { p2: [target] };

    state = dealDamage(state, 0, target.instanceId, 2);

    expect(state.battlefields[0]!.units["p2"]![0]!.damage).toBe(3);
  });
});
