import { describe, expect, it } from "vitest";
import { cheapestFlooredOrder, modifiedEnergyCost } from "../src/engine/cost-modifiers.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { makeState, makeUnit, realUnitInstance } from "./fixtures.js";
import type { GameState } from "../src/model/game-state.js";

/**
 * **356.4's discount ordering, and the one property `applyFlooredDiscounts`
 * rests on.**
 *
 * 356.4.c.1 and 356.4.d.1 make the order of discounts the PLAYER's choice, and
 * 356.4.e makes that choice change the price. The engine does not ask — nobody
 * ever wants to pay more, and the rules sever the amount actually paid from
 * anything that reads a cost (356.4.f.1) — so it must compute the CHEAPEST legal
 * order instead. That reduces to one claim:
 *
 *   **Applying floored discounts highest-floor-first minimises the final cost.**
 *
 * That claim was derived by brute force before it was implemented, and this file
 * is where the derivation lives so it cannot rot. A future card with a new
 * discount shape — a floor that scales, a discount that raises a floor — is
 * exactly the thing that would break it, and nothing else in the suite would
 * notice, because every per-card test asserts one number on one board.
 */

/** The engine's model of one floored discount: `cost = max(min(cost, floor), cost - amount)`.
 *  Never raises a cost already below the floor. */
interface Discount {
  amount: number;
  floor: number;
}

const applyOne = (cost: number, d: Discount) => Math.max(Math.min(cost, d.floor), cost - d.amount);
/** One SPECIFIC order, applied literally — the reference the engine is measured
 *  against. Deliberately not the engine's function, which picks its own order. */
const applyInOrder = (cost: number, ds: readonly Discount[]) => ds.reduce(applyOne, cost);

function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [[...xs]];
  return xs.flatMap((x, i) =>
    permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]),
  );
}

/**
 * The ENGINE's own choice of order, called directly.
 *
 * **This is the only way this branch can be pinned.** Every printed minimum in
 * the pool today is 1, and equal floors commute, so the sort inside
 * `cheapestFlooredOrder` is unreachable through `modifiedEnergyCost` — a mutant
 * reversing the comparator survives the whole suite when driven through a board.
 * Measured, then pinned here. See that function's own note.
 */
const engineAnswer = (cost: number, ds: readonly Discount[]) => cheapestFlooredOrder(cost, ds);

describe("356.4.c.1/d.1: highest-floor-first is the cheapest legal order", () => {
  it("beats or matches EVERY other ordering, exhaustively", () => {
    // The grid is small on purpose and covers the shapes in the pool: amounts up
    // to 6 (Sky Splitter reaches 8 but is unfloored), floors up to 3 (every
    // printed minimum in the pool today is 1), costs across the whole printed
    // range. Two and three discounts, because that is what can co-occur.
    const grid: Discount[] = [];
    for (let amount = 0; amount <= 6; amount += 1) {
      for (let floor = 0; floor <= 3; floor += 1) grid.push({ amount, floor });
    }

    let checked = 0;
    const counterexamples: string[] = [];
    for (const size of [2, 3]) {
      const indices = Array<number>(size).fill(0);
      for (;;) {
        const ds = indices.map((i) => grid[i]!);
        for (let cost = 0; cost <= 10; cost += 1) {
          const best = Math.min(...permutations(ds).map((p) => applyInOrder(cost, p)));
          const got = engineAnswer(cost, ds);
          checked += 1;
          if (got !== best && counterexamples.length < 5) {
            counterexamples.push(`cost=${cost} ${JSON.stringify(ds)} best=${best} engine=${got}`);
          }
        }
        let k = size - 1;
        while (k >= 0 && (indices[k]! += 1) >= grid.length) {
          indices[k] = 0;
          k -= 1;
        }
        if (k < 0) break;
      }
    }

    // The positive control: without it, a bug that made `permutations` return
    // nothing would leave `best` as Infinity and this test would pass vacuously.
    expect(checked, "the sweep examined nothing").toBeGreaterThan(200_000);
    expect(counterexamples).toEqual([]);
  });

  it("the ordering genuinely MATTERS — some pair is cheaper one way round", () => {
    // The negative control the test above needs. If every ordering always gave
    // the same answer, "highest floor first is optimal" would be true and empty.
    // This is 356.4.e's own example in miniature: 8 Energy, a floored -1 and an
    // unfloored -7.
    const ds: Discount[] = [
      { amount: 1, floor: 1 },
      { amount: 7, floor: 0 },
    ];
    expect(applyInOrder(8, ds), "floored first should reach 0").toBe(0);
    expect(applyInOrder(8, [ds[1]!, ds[0]!]), "unfloored first should stop at 1").toBe(1);
    // ...and the engine picks the cheap one when handed them the wrong way round.
    expect(engineAnswer(8, [ds[1]!, ds[0]!]), "the engine took the order it was given").toBe(0);
  });
});

describe("the real pipeline takes that order", () => {
  const EAGER_APPRENTICE = "OGN-084";
  const HERALD_OF_SCALES = "OGN-140";
  const SKY_SPLITTER = "OGN-014";

  const withUnits = (defIds: string[], extra = [makeUnit({ might: 7, name: "Big" })]): GameState => {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [...defIds.map((id) => realUnitInstance(id)), ...extra] };
    return state;
  };

  it("prices 356.4.e's worked example at 0", () => {
    expect(modifiedEnergyCost(withUnits([EAGER_APPRENTICE]), 0, "Spell", 8, SKY_SPLITTER)).toBe(0);
  });

  it("never raises a cost already below a floor", () => {
    // The Apprentice alone, on a printed-0 spell. Before 2026-08-23 this was 1.
    const state = withUnits([EAGER_APPRENTICE], []);
    expect(modifiedEnergyCost(state, 0, "Spell", 0, "OGN-999")).toBe(0);
  });

  it("two Heralds each take 2 off a Dragon, each bounded by its own floor (356.4.e)", () => {
    // Herald of Scales prints "cost reduced by [2], to a minimum of [1]" and has
    // always counted its copies — the card that settled the Stargazer row. Two of
    // them off a 6-cost Dragon is 6 -> 4 -> 2, not 6 -> 4 with one floor between.
    const state = withUnits([HERALD_OF_SCALES, HERALD_OF_SCALES], []);
    const dragon = dragonDefId();
    expect(dragon, "no Dragon in the pool to price").toBeDefined();
    const printed = 6;
    expect(modifiedEnergyCost(state, 0, "Unit", printed, dragon!)).toBe(2);
  });
});

/** Any Dragon in the pool, found by TAG rather than named — the same narrowing
 *  `cost-modifiers.isDragon` makes, and for its reason: `tags` is absent on a
 *  LegendDefinition, so reading it straight off the union throws at runtime. */
function dragonDefId(): string | undefined {
  return defaultCardRegistry()
    .all()
    .find((def) => "tags" in def && def.tags.includes("Dragon"))?.id;
}
