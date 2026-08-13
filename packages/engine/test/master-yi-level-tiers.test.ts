import { describe, expect, it } from "vitest";
import { modifiedEnergyCost, scaledPowerDiscount } from "../src/engine/cost-modifiers.js";
import { isCardImplemented, partialImplementationNote, implementingModules } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState } from "./fixtures.js";

/**
 * **Master Yi - Unstoppable (UNL-059): three `[Level]` cost tiers that REPLACE
 * one another.**
 *
 * "[Level 3] I cost [2][Calm] less. [Level 6] I cost [4][Calm][Calm] less
 * INSTEAD. [Level 11] I cost [6][Calm][Calm][Calm] less INSTEAD."
 *
 * 824 makes each `[Level]` clause active while its XP threshold is met, so
 * without the printed "instead" a player at 11 XP would have all three active and
 * pay 12 less. The tiers are therefore a highest-first lookup, not three
 * independent discounts — the same reading Concentrate (UNL-091) already uses.
 *
 * # What is new here, and what these tests are really pointed at
 *
 * Concentrate discounts Energy only, so one number in one function sufficed.
 * Yi's tiers move Energy AND Power together, and those are computed by two
 * different functions: `modifiedEnergyCost` and `scaledPowerDiscount`. Two
 * independent `find`s over the same table would look completely correct and
 * would drift at exactly one place — a player who crosses a threshold between
 * the two calls, or a table edited on one side only, paying -6 Energy but
 * -2 Power.
 *
 * So the boundary is tested on BOTH halves at every threshold, and the pairing is
 * asserted directly: whatever tier the Energy took, the Power came from the same
 * one.
 *
 * # His fourth clause is not tested here
 *
 * `[Level 16]`'s "I can't be chosen by enemy spells and abilities" is a
 * `UNCHOOSEABLE_BY_ENEMIES` row in target-lookup.ts and has its own coverage in
 * `conditional-unchooseable.test.ts`. It is the clause that was already written
 * when the other three were not, which is why he sat in `PARTIALLY_IMPLEMENTED`.
 */

const registry = defaultCardRegistry();
const YI = "UNL-059";
const PRINTED_ENERGY = 12;
const PRINTED_POWER = 3;

/** Every tier boundary, and the printed discounts at it. */
const TIERS = [
  { xp: 0, energy: 0, power: 0 },
  { xp: 2, energy: 0, power: 0 },
  { xp: 3, energy: 2, power: 1 },
  { xp: 5, energy: 2, power: 1 },
  { xp: 6, energy: 4, power: 2 },
  { xp: 10, energy: 4, power: 2 },
  { xp: 11, energy: 6, power: 3 },
  { xp: 40, energy: 6, power: 3 },
];

function atXp(xp: number, seat: 0 | 1 = 0): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: seat });
  state.players[seat]!.xp = xp;
  return state;
}

const energyOf = (state: GameState, seat: 0 | 1 = 0): number =>
  modifiedEnergyCost(state, seat, "Unit", PRINTED_ENERGY, YI);

describe("the three [Level] tiers are a REPLACEMENT ladder, not three discounts", () => {
  it.each(TIERS)("at $xp XP: -$energy Energy and -$power Power", ({ xp, energy, power }) => {
    const state = atXp(xp);

    expect(energyOf(state), `wrong Energy discount at ${xp} XP`).toBe(PRINTED_ENERGY - energy);
    expect(scaledPowerDiscount(state, 0, YI), `wrong Power discount at ${xp} XP`).toBe(power);
  });

  it("never stacks — at 11 XP he is 6 cheaper, not 12", () => {
    // The assertion the word "instead" exists for, stated on its own so a
    // stacking implementation fails with an obvious message rather than as one
    // row of a table.
    const state = atXp(11);
    const stacked = 2 + 4 + 6;

    expect(energyOf(state), "the tiers stacked").not.toBe(PRINTED_ENERGY - stacked);
    expect(energyOf(state)).toBe(PRINTED_ENERGY - 6);
    expect(scaledPowerDiscount(state, 0, YI), "the Power tiers stacked").toBe(3);
  });

  it("the Energy and Power halves always come from the SAME tier", () => {
    // The failure two independent lookups produce, and the one no single-number
    // assertion above can see. Checked across the whole range rather than at the
    // thresholds only, since a drift could be introduced anywhere.
    for (let xp = 0; xp <= 20; xp += 1) {
      const state = atXp(xp);
      const energySaved = PRINTED_ENERGY - energyOf(state);
      const powerSaved = scaledPowerDiscount(state, 0, YI);
      const match = TIERS.find((t) => t.energy === energySaved && t.power === powerSaved);

      expect(match, `at ${xp} XP the halves disagree: -${energySaved} Energy but -${powerSaved} Power`).toBeDefined();
    }
  });
});

describe("whose XP it is", () => {
  it("reads the CONTROLLER's XP, not the other player's", () => {
    // "While YOU have 3+ XP". Every fixture above seats him at player 0, so a
    // hardcoded `players[0]` would pass all of them.
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.players[0]!.xp = 40;
    state.players[1]!.xp = 0;

    expect(energyOf(state, 1), "the opponent's XP discounted him").toBe(PRINTED_ENERGY);
    expect(scaledPowerDiscount(state, 1, YI), "the opponent's XP discounted his Power").toBe(0);
  });

  it("...and the mirror, so the test above cannot pass by reading neither", () => {
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.players[0]!.xp = 0;
    state.players[1]!.xp = 11;

    expect(energyOf(state, 1), "his own XP did not reach him").toBe(PRINTED_ENERGY - 6);
    expect(scaledPowerDiscount(state, 1, YI), "his own XP did not reach his Power").toBe(3);
  });
});

describe("it is HIS discount and nobody else's", () => {
  it("does not discount another card at the same XP", () => {
    // Every cost modifier is asked about every card, so a missing defId check
    // makes the whole deck cheaper.
    const state = atXp(11);
    const other = "OGN-011"; // Magma Wurm, 8 Energy

    expect(modifiedEnergyCost(state, 0, "Unit", 8, other), "a bystander card was discounted").toBe(8);
    expect(scaledPowerDiscount(state, 0, other), "a bystander card's Power was discounted").toBe(0);
  });

  it("leaves Needlessly Large Yordle's Power discount alone", () => {
    // `scaledPowerDiscount` was a single-card function before this change and is
    // now a two-branch one. The card it used to be about must still work.
    const state = atXp(11);
    state.players[0]!.pointsFromHoldingThisTurn = 2;

    expect(scaledPowerDiscount(state, 0, "SFD-055"), "the Yordle's Power discount broke").toBe(2);
  });
});

describe("coverage", () => {
  it("is whole, claimed by both modules, and no longer half-written", () => {
    expect(isCardImplemented(registry.get(YI)), "Master Yi is greyed").toBe(true);
    expect(partialImplementationNote(registry.get(YI)), "he still names a missing half").toBeUndefined();

    const modules = implementingModules(YI);
    expect(modules, "the cost tiers are not registered").toContain("cost-modifiers");
    expect(modules, "the [Level 16] clause stopped being claimed").toContain("choose restrictions");
  });

  it("his printed cost and thresholds still match the table", () => {
    // If a printing changes, the numbers above are wrong and every test here
    // would keep passing against the old card.
    const def = registry.get(YI) as { energyCost: number; powerCost: number; text?: string };
    expect(def.energyCost, "his printed Energy changed").toBe(PRINTED_ENERGY);
    expect(def.powerCost, "his printed Power changed").toBe(PRINTED_POWER);
    for (const level of [3, 6, 11]) {
      expect(def.text ?? "", `he stopped printing [Level ${level}]`).toContain(`Level ${level}`);
    }
  });
});
