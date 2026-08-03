import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "@rift-engine/engine";
import { CURVE_MAX, deckCurve, deckRows } from "../src/deck-rows.js";

/**
 * The deck panel's grouping, ordering and curve.
 *
 * Pure and tested away from the component for the reason `target-hint.ts` gives:
 * a predicate inside a 600-line screen is where a wrong answer survives. What
 * these assert is the panel's whole value — the browser already shows the cards,
 * so if the ORDER and the COUNTS are not right the panel is just a second grid.
 */

const registry = defaultCardRegistry();

const LECTURING_YORDLE = "OGN-087"; // Unit, 2 Energy
const HEXTECH_RAY = "OGN-009"; // Spell, 1 Energy 1 Power
const ENERGY_CONDUIT = "OGN-098"; // Gear
const TIME_WARP = "OGN-122"; // Spell, 10 Energy — the pool's most expensive, so the curve's top bucket

describe("deckRows", () => {
  it("collapses copies into one row with a count", () => {
    const rows = deckRows([LECTURING_YORDLE, LECTURING_YORDLE, LECTURING_YORDLE], registry);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(3);
  });

  it("orders units, then spells, then gear", () => {
    const rows = deckRows([ENERGY_CONDUIT, HEXTECH_RAY, LECTURING_YORDLE], registry);
    expect(rows.map((r) => r.type)).toEqual(["Unit", "Spell", "Gear"]);
  });

  it("orders by Energy cost within a type, cheapest first", () => {
    const rows = deckRows([TIME_WARP, HEXTECH_RAY], registry);
    expect(rows.map((r) => r.energyCost)).toEqual([1, 10]);
  });

  it("keeps a card the pool does not have, rather than dropping it silently", () => {
    // A hand-edited .deck file can name anything. Dropping the row would leave
    // the player reconciling a count against a list that does not add up.
    const rows = deckRows(["NOT-A-CARD", "NOT-A-CARD"], registry);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(2);
    expect(rows[0]!.isInert).toBe(true);
  });

  it("marks nothing inert while the pool is fully implemented", () => {
    // The control, and it is a real one now: every card reports implemented, so
    // an `isInert` that was true here would mean the flag is reading something
    // else entirely.
    const rows = deckRows([LECTURING_YORDLE, HEXTECH_RAY, ENERGY_CONDUIT], registry);
    expect(rows.every((r) => !r.isInert)).toBe(true);
  });
});

describe("deckCurve", () => {
  it("counts COPIES per Energy cost, not distinct cards", () => {
    const curve = deckCurve(deckRows([HEXTECH_RAY, HEXTECH_RAY, HEXTECH_RAY], registry));
    expect(curve[1]).toBe(3);
  });

  it("puts everything at or above the cap in the last bucket", () => {
    // Time Warp is 10 Energy; without the clamp it would index off the end and
    // the bar would vanish rather than pile up where a player expects it.
    const curve = deckCurve(deckRows([TIME_WARP], registry));
    expect(curve).toHaveLength(CURVE_MAX + 1);
    expect(curve[CURVE_MAX]).toBe(1);
  });

  it("is all zeroes for an empty deck", () => {
    expect(deckCurve([]).every((n) => n === 0)).toBe(true);
  });
});
