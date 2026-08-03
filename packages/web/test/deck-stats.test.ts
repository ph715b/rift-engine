import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "@rift-engine/engine";
import { deckRows } from "../src/deck-rows.js";
import { OPENING_HAND_SIZE, deckStats, sampleHand } from "../src/deck-stats.js";

const registry = defaultCardRegistry();
const YORDLE = "OGN-087"; // Unit, 3 Energy, no Power
const RAY = "OGN-009"; // Spell, 1 Energy, 1 Fury Power
const CONDUIT = "OGN-098"; // Gear

describe("deckStats", () => {
  it("averages Energy across COPIES, not distinct cards", () => {
    // Three 3-drops and one 1-drop averages 2.5. A per-card average would say
    // 2.0 — it would weigh the singleton as heavily as the three-of, which is
    // the wrong shape of the deck and the whole reason this counts copies.
    const stats = deckStats(deckRows([YORDLE, YORDLE, YORDLE, RAY], registry), registry);
    expect(stats.total).toBe(4);
    expect(stats.averageEnergy).toBe(2.5); // (3+3+3+1)/4
  });

  it("counts how many copies need POWER", () => {
    // Invisible in a list sorted by Energy, and it is what decides whether a
    // rune split is wrong.
    const stats = deckStats(deckRows([RAY, RAY, YORDLE], registry), registry);
    expect(stats.powerCards).toBe(2);
  });

  it("counts a dual-domain card for BOTH domains", () => {
    // Deliberate: the domain totals do not sum to the deck size, because "how
    // much Fury is in here" is a question about pips rather than slices.
    const dual = registry.all().find((c) => c.domains.length === 2 && c.type !== "Legend");
    expect(dual, "the pool has no dual-domain card to test with").toBeDefined();
    const stats = deckStats(deckRows([dual!.id], registry), registry);
    expect(stats.total).toBe(1);
    expect(stats.byDomain.reduce((sum, d) => sum + d.count, 0)).toBe(2);
  });

  it("groups by type in Unit, Spell, Gear order", () => {
    const stats = deckStats(deckRows([CONDUIT, RAY, YORDLE], registry), registry);
    expect(stats.byType.map((t) => t.type)).toEqual(["Unit", "Spell", "Gear"]);
  });

  it("is all zeroes for an empty deck, without dividing by it", () => {
    const stats = deckStats([], registry);
    expect(stats.total).toBe(0);
    expect(stats.averageEnergy).toBe(0);
  });
});

describe("sampleHand", () => {
  const deck = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? YORDLE : RAY));

  it("draws the opening hand size", () => {
    expect(sampleHand(deck, registry, 1)).toHaveLength(OPENING_HAND_SIZE);
  });

  it("is REPRODUCIBLE for a seed, and different across seeds", () => {
    // A sample hand you cannot reproduce is one you cannot show anyone or
    // assert on — the same reason every shuffle in this project takes a seed.
    const a = sampleHand(deck, registry, 7).map((c) => c.id);
    const b = sampleHand(deck, registry, 7).map((c) => c.id);
    expect(a).toEqual(b);

    const seeds = new Set(Array.from({ length: 12 }, (_, i) => sampleHand(deck, registry, i + 1).map((c) => c.id).join()));
    expect(seeds.size, "every seed dealt the same hand").toBeGreaterThan(1);
  });

  it("never deals more copies than the deck holds", () => {
    // Sampling WITH replacement would happily deal four of a card you own one
    // of, which is the one thing a sample hand must not do.
    const singleton = [YORDLE, RAY, CONDUIT, RAY, CONDUIT];
    for (let seed = 1; seed <= 20; seed += 1) {
      const hand = sampleHand(singleton, registry, seed);
      const yordles = hand.filter((c) => c.id === YORDLE).length;
      expect(yordles).toBeLessThanOrEqual(1);
    }
  });

  it("copes with a deck smaller than a hand", () => {
    expect(sampleHand([YORDLE, RAY], registry, 3)).toHaveLength(2);
    expect(sampleHand([], registry, 3)).toHaveLength(0);
  });
});
