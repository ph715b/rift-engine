import { describe, expect, it } from "vitest";
import { modifiedEnergyCost, scaledPowerDiscount, optionalCostDiscount } from "../src/engine/cost-modifiers.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { effectiveKeywords } from "../src/engine/granted-keywords.js";
import { payPowerFromChanneled } from "../src/engine/effect-helpers.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, realUnitInstance } from "./fixtures.js";

/**
 * Phase 5 — the three per-turn counters, and the four cards that read them.
 *
 * Each counter is bumped at ONE site and cleared in `runEnd`, and the tests
 * below check both ends. A counter that is bumped but never cleared reads as a
 * card that gets permanently better, which no test of the card alone would
 * catch — so the reset is asserted separately for each.
 */

const registry = defaultCardRegistry();

const NEEDLESSLY_LARGE_YORDLE = "SFD-055";
const SIVIR_MERCENARY = "SFD-143";
const RALLY_THE_TROOPS = "SFD-166";
const EZREAL_PRODIGY = "SFD-149";

const runes = (n: number, domain: RuneCard["domain"] = "Chaos"): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, domain, state: "Ready" as const }));

function unitDef(defId: string) {
  const def = registry.get(defId);
  if (def.type !== "Unit") throw new Error(`${defId} is not a Unit`);
  return def;
}

describe("Needlessly Large Yordle (SFD-055): cheaper per point scored FROM HOLDING", () => {
  const board = (heldPoints: number): GameState => {
    const state = makeState({ phase: "Action" });
    state.players[0]!.pointsFromHoldingThisTurn = heldPoints;
    return state;
  };

  const printed = () => unitDef(NEEDLESSLY_LARGE_YORDLE);

  it("costs full price having scored nothing", () => {
    const def = printed();
    expect(modifiedEnergyCost(board(0), 0, "Unit", def.energyCost, def.id)).toBe(def.energyCost);
    expect(scaledPowerDiscount(board(0), 0, def.id)).toBe(0);
  });

  /** BOTH axes — [2] Energy and [Calm] Power per point — which is why the Power
   *  half is its own function rather than living inside `modifiedEnergyCost`. */
  it("takes [2] Energy AND 1 Power off per point held", () => {
    const def = printed();
    expect(modifiedEnergyCost(board(2), 0, "Unit", def.energyCost, def.id), "the Energy half is wrong").toBe(
      def.energyCost - 4,
    );
    expect(scaledPowerDiscount(board(2), 0, def.id), "the Power half is wrong").toBe(2);
  });

  it("floors at zero rather than going negative", () => {
    const def = printed();
    expect(modifiedEnergyCost(board(99), 0, "Unit", def.energyCost, def.id)).toBe(0);
  });

  /** "From HOLDING" is the method — a point from conquering is a different
   *  sentence, and the counter deliberately does not see one. */
  it("ignores points that did not come from holding", () => {
    const state = board(0);
    state.players[0]!.points = 5; // conquered, not held
    const def = printed();

    expect(modifiedEnergyCost(state, 0, "Unit", def.energyCost, def.id), "it read the raw score").toBe(def.energyCost);
  });

  it("is claimed by a module", () => {
    expect(isCardImplemented(registry.get(NEEDLESSLY_LARGE_YORDLE))).toBe(true);
  });
});

describe("Sivir - Mercenary (SFD-143): +2 Might and [Ganking] once you've spent [rainbow][rainbow]", () => {
  function board(spent: number): { state: GameState; sivir: ReturnType<typeof realUnitInstance> } {
    const sivir = { ...realUnitInstance(SIVIR_MERCENARY), instanceId: "sivir" };
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [sivir];
    state.players[0]!.powerSpentThisTurn = spent;
    return { state, sivir };
  }

  const mightOf = (state: GameState) =>
    effectiveMight(state, state.players[0]!.baseUnits[0]!, 0, { isCombat: false });

  it("is plain below the threshold", () => {
    const { state } = board(1);
    expect(mightOf(state), "she grew below the threshold").toBe(unitDef(SIVIR_MERCENARY).might);
    expect(effectiveKeywords(state, state.players[0]!.baseUnits[0]!, 0)["Ganking"]).toBeUndefined();
  });

  /** ONE sentence, two halves — both must flip together, which is why they share
   *  a predicate rather than each testing the counter. */
  it("gains BOTH halves at exactly two Power spent", () => {
    const { state } = board(2);
    expect(mightOf(state), "the Might half did not apply").toBe(unitDef(SIVIR_MERCENARY).might + 2);
    expect(effectiveKeywords(state, state.players[0]!.baseUnits[0]!, 0)["Ganking"], "the keyword half did not apply").toBe(
      1,
    );
  });

  it("stays on above the threshold", () => {
    const { state } = board(7);
    expect(mightOf(state)).toBe(unitDef(SIVIR_MERCENARY).might + 2);
  });

  /** The tally is bumped at `payPowerFromChanneled`, the single funnel every
   *  Power payment goes through — counted in PIPS, of any domain. */
  it("counts Power actually spent through the shared payment helper", () => {
    const state = makeState({ phase: "Action" });
    state.players[0]!.channeled = runes(3, "Fury");

    const after = payPowerFromChanneled(state, 0, "Fury", 2)!;

    expect(after.players[0]!.powerSpentThisTurn, "the funnel did not tally").toBe(2);
  });

  it("is claimed by a module", () => {
    expect(isCardImplemented(registry.get(SIVIR_MERCENARY))).toBe(true);
  });
});

describe("Ezreal - Prodigy (SFD-149): optional additional costs cost [1] or [rainbow] less", () => {
  function board(withEzreal: boolean): GameState {
    const state = makeState({ phase: "Action" });
    if (withEzreal) state.players[0]!.baseUnits = [{ ...realUnitInstance(EZREAL_PRODIGY), instanceId: "ezreal" }];
    return state;
  }

  it("discounts one pip on the chosen axis while he is in play", () => {
    expect(optionalCostDiscount(board(true), 0, "energy")).toEqual({ energy: 1, power: 0 });
    expect(optionalCostDiscount(board(true), 0, "power")).toEqual({ energy: 0, power: 1 });
  });

  it("does nothing while he is not in play", () => {
    expect(optionalCostDiscount(board(false), 0, "energy")).toEqual({ energy: 0, power: 0 });
  });

  it("does nothing when no axis is named", () => {
    expect(optionalCostDiscount(board(true), 0, undefined)).toEqual({ energy: 0, power: 0 });
  });

  /** His clause names no battlefield, so a base Ezreal counts — the same
   *  unpositioned reading Herald of Scales' discount takes. */
  it("applies from base", () => {
    expect(optionalCostDiscount(board(true), 0, "energy").energy).toBe(1);
  });

  /** He is claimed by cost-modifiers for the discount; his on-play half must be
   *  written too, or he reports finished while doing half his text. */
  it("is claimed and carries no partial note", () => {
    expect(isCardImplemented(registry.get(EZREAL_PRODIGY))).toBe(true);
    expect(partialImplementationNote(registry.get(EZREAL_PRODIGY))).toBeUndefined();
  });
});

describe("Rally the Troops (SFD-166): the delayed buff is armed on a counter", () => {
  it("is claimed and no longer carries a partial note", () => {
    expect(isCardImplemented(registry.get(RALLY_THE_TROOPS))).toBe(true);
    // The note said the clause "needs a delayed-trigger flag on PlayerState read
    // at the play site". It has one, so the entry is DELETED rather than
    // reworded — this list's own convention.
    expect(partialImplementationNote(registry.get(RALLY_THE_TROOPS))).toBeUndefined();
  });
});

/**
 * A counter that is bumped but never cleared reads as a card that gets
 * permanently better — invisible in any test of the card alone.
 */
describe("all three counters clear at end of turn", () => {
  it("runEnd resets them", () => {
    const state = makeState({ phase: "Action" });
    state.players[0]!.pointsFromHoldingThisTurn = 3;
    state.players[0]!.powerSpentThisTurn = 5;
    state.players[0]!.buffUnitsPlayedThisTurn = 2;
    state.players[1]!.powerSpentThisTurn = 4;

    const after = runEnd(state);

    for (const index of [0, 1] as const) {
      expect(after.players[index]!.pointsFromHoldingThisTurn, `p${index} held points survived`).toBe(0);
      expect(after.players[index]!.powerSpentThisTurn, `p${index} power spent survived`).toBe(0);
      expect(after.players[index]!.buffUnitsPlayedThisTurn, `p${index} rally charges survived`).toBe(0);
    }
  });
});
