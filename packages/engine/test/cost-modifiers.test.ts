import { describe, expect, it } from "vitest";
import { modifiedEnergyCost } from "../src/engine/cost-modifiers.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { makePlayer, makeState, makeUnit } from "./fixtures.js";

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

/**
 * Rhasa the Sunderer: "I cost 1 Energy less for each card in your trash."
 *
 * Unlike Eager Apprentice this scales off the card being played rather than off
 * the board, which is why modifiedEnergyCost needs the defId at all. Every call
 * site now passes it; the parameter is optional only so that a caller holding a
 * cost with no card behind it still compiles.
 */
describe("modifiedEnergyCost: Rhasa the Sunderer (OGN-195)", () => {
  const RHASA = "OGN-195";
  const trashOf = (n: number) =>
    makeState({
      players: [
        makePlayer("p1", { trash: Array.from({ length: n }, () => createCardInstance(defaultCardRegistry().get("OGN-002"))) }),
        makePlayer("p2"),
      ],
    });

  it("costs full price with an empty trash", () => {
    expect(modifiedEnergyCost(trashOf(0), 0, "Unit", 7, RHASA)).toBe(7);
  });

  it("drops 1 per card in your trash", () => {
    expect(modifiedEnergyCost(trashOf(3), 0, "Unit", 7, RHASA)).toBe(4);
  });

  it("floors at 0, not at 1 — the card states no minimum", () => {
    expect(modifiedEnergyCost(trashOf(20), 0, "Unit", 7, RHASA)).toBe(0);
  });

  it("counts YOUR trash, not the opponent's", () => {
    const state = trashOf(3);
    expect(modifiedEnergyCost(state, 1, "Unit", 7, RHASA)).toBe(7);
  });

  it("counts every card in the trash, not only units", () => {
    // "For each card" is unqualified, so spells and gear count too — which is why
    // this reads trash.length rather than filtering.
    const state = makeState({
      players: [
        makePlayer("p1", { trash: [createCardInstance(defaultCardRegistry().get("OGS-003"))] }), // Incinerate, a Spell
        makePlayer("p2"),
      ],
    });
    expect(modifiedEnergyCost(state, 0, "Unit", 7, RHASA)).toBe(6);
  });

  it("leaves every OTHER card's cost alone", () => {
    expect(modifiedEnergyCost(trashOf(3), 0, "Unit", 7, "OGN-002")).toBe(7);
    expect(modifiedEnergyCost(trashOf(3), 0, "Unit", 7)).toBe(7);
  });

  it("is counted as implemented by coverage", () => {
    expect(isCardImplemented(defaultCardRegistry().get(RHASA))).toBe(true);
  });
});

/**
 * Herald of Scales (OGN-140): "Your Dragons' Energy costs are reduced by 2, to a
 * minimum of 1."
 *
 * The first modifier keyed off a card's TYPE LINE rather than its id — Dragon-ness
 * comes from `CardDefinition.tags`, which 8 cards in this pool carry. Blazing
 * Scorcher (OGN-001, 5 Energy) is the subject throughout; Mindsplitter (OGN-192,
 * 7 Energy) is the second Dragon, used where a different printed cost matters.
 */
describe("modifiedEnergyCost: Herald of Scales (OGN-140)", () => {
  const HERALD = "OGN-140";
  const BLAZING_SCORCHER = "OGN-001"; // Dragon, 5 Energy
  const NOT_A_DRAGON = "OGN-002";

  const withHeralds = (count: number, inBase = false) => {
    const state = makeState();
    const heralds = Array.from({ length: count }, (_, i) => makeUnit({ defId: HERALD, instanceId: `herald-${i}` }));
    if (inBase) state.players[0]!.baseUnits = heralds;
    else state.battlefields[0]!.units = { p1: heralds };
    return state;
  };

  it("takes 2 Energy off a Dragon's cost", () => {
    expect(modifiedEnergyCost(withHeralds(1), 0, "Unit", 5, BLAZING_SCORCHER)).toBe(3);
  });

  it("applies from BASE as well as from a battlefield", () => {
    // The difference from Eager Apprentice above, and it is printed: that card
    // says "while I'm at a battlefield", this one names no location at all.
    expect(modifiedEnergyCost(withHeralds(1, true), 0, "Unit", 5, BLAZING_SCORCHER)).toBe(3);
  });

  it("stacks — two Heralds are -4", () => {
    // Continuous abilities are not keywords, so 817.1.a's redundancy rule does
    // not reach them. Same precedent as Garen - Commander + Darius - Executioner
    // both applying in effective-might.
    expect(modifiedEnergyCost(withHeralds(2), 0, "Unit", 7, "OGN-192")).toBe(3);
  });

  it("floors at 1, never at 0", () => {
    // Unreachable with today's pool — every Dragon costs 5+ — so this is pinned
    // on a raw cost rather than on a real card's, which is the honest way to
    // exercise a printed clause the card pool cannot currently reach.
    expect(modifiedEnergyCost(withHeralds(2), 0, "Unit", 2, BLAZING_SCORCHER)).toBe(1);
  });

  it("leaves a non-Dragon alone", () => {
    expect(modifiedEnergyCost(withHeralds(1), 0, "Unit", 5, NOT_A_DRAGON)).toBe(5);
  });

  it("does nothing without a Herald on the board", () => {
    expect(modifiedEnergyCost(makeState(), 0, "Unit", 5, BLAZING_SCORCHER)).toBe(5);
  });

  it("is YOUR Dragons — an enemy Herald does not discount them", () => {
    const state = makeState();
    state.battlefields[0]!.units = { p2: [makeUnit({ defId: HERALD })] };
    expect(modifiedEnergyCost(state, 0, "Unit", 5, BLAZING_SCORCHER)).toBe(5);
  });

  it("is counted as implemented by coverage", () => {
    expect(isCardImplemented(defaultCardRegistry().get(HERALD))).toBe(true);
  });
});
