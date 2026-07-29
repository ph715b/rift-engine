import { describe, expect, it } from "vitest";
import { modifiedEnergyCost } from "../src/engine/cost-modifiers.js";
import { makeState, makeUnit } from "./fixtures.js";

describe("modifiedEnergyCost: Eager Apprentice (OGN-084)", () => {
  it("reduces a Spell's Energy cost by 1 while at a battlefield", () => {
    const state = makeState();
    state.battlefields[0]!.units = { p1: [makeUnit({ defId: "OGN-084" })] };
    expect(modifiedEnergyCost(state, 0, "Spell", 3)).toBe(2);
  });

  it("floors at 1, never reduces to 0", () => {
    const state = makeState();
    state.battlefields[0]!.units = { p1: [makeUnit({ defId: "OGN-084" })] };
    expect(modifiedEnergyCost(state, 0, "Spell", 1)).toBe(1);
  });

  it("does not apply while Eager Apprentice sits in base, only at a battlefield", () => {
    const state = makeState();
    state.players[0]!.baseUnits = [makeUnit({ defId: "OGN-084" })];
    expect(modifiedEnergyCost(state, 0, "Spell", 3)).toBe(3);
  });

  it("does not apply to Unit/Gear costs, only Spells", () => {
    const state = makeState();
    state.battlefields[0]!.units = { p1: [makeUnit({ defId: "OGN-084" })] };
    expect(modifiedEnergyCost(state, 0, "Unit", 3)).toBe(3);
    expect(modifiedEnergyCost(state, 0, "Gear", 3)).toBe(3);
  });

  it("does not apply to the opponent's spells", () => {
    const state = makeState();
    state.battlefields[0]!.units = { p1: [makeUnit({ defId: "OGN-084" })] };
    expect(modifiedEnergyCost(state, 1, "Spell", 3)).toBe(3);
  });

  it("leaves cost unmodified without Eager Apprentice in play", () => {
    const state = makeState();
    expect(modifiedEnergyCost(state, 0, "Spell", 3)).toBe(3);
  });
});
