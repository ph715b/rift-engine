import { describe, expect, it } from "vitest";
import {
  defaultCardRegistry,
  isCardImplemented,
  isCardLegalForLegend,
  type CardDefinition,
  type Domain,
} from "@rift-engine/engine";
import { EMPTY_FILTERS, costBucket, filterAndSortCards, hasActiveFilters, type CardFilters } from "../src/card-filters.js";

/**
 * The card browser's filter and sort model.
 *
 * These are the assertions that make the filter row trustworthy: an AND across
 * dimensions and an OR within one is what every filter UI is expected to do, and
 * getting it backwards produces a browser that shows nothing and looks broken.
 */

const registry = defaultCardRegistry();
const ALL = registry.all().filter((c) => c.type === "Unit" || c.type === "Spell" || c.type === "Gear");

const withFilters = (patch: Partial<CardFilters>): CardFilters => ({ ...EMPTY_FILTERS, ...patch });
const run = (patch: Partial<CardFilters>, cards: readonly CardDefinition[] = ALL) => filterAndSortCards(cards, withFilters(patch));

describe("filtering", () => {
  it("returns everything when nothing is set", () => {
    expect(run({})).toHaveLength(ALL.length);
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
  });

  it("ORs within a dimension — Unit + Spell shows both", () => {
    const units = run({ types: new Set(["Unit"]) }).length;
    const spells = run({ types: new Set(["Spell"]) }).length;
    expect(units).toBeGreaterThan(0);
    expect(spells).toBeGreaterThan(0);
    expect(run({ types: new Set(["Unit", "Spell"]) })).toHaveLength(units + spells);
  });

  it("ANDs across dimensions — Unit + cost 3 means 3-cost units", () => {
    const result = run({ types: new Set(["Unit"]), costs: new Set([3]) });
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((c) => c.type === "Unit" && costBucket(c) === 3)).toBe(true);
  });

  it("buckets everything expensive into 7+", () => {
    const top = run({ costs: new Set([7]) });
    expect(top.length).toBeGreaterThan(0);
    expect(top.every((c) => ("energyCost" in c ? c.energyCost : 0) >= 7)).toBe(true);
    // Time Warp is the pool's 10-drop; without the clamp it would fall out of
    // every bucket and be unreachable by cost filtering entirely.
    expect(top.some((c) => c.id === "OGN-122")).toBe(true);
  });

  it("searches rules TEXT as well as the name", () => {
    // The point of searching text: you look for an effect long before you can
    // name the card that has it.
    const byText = run({ search: "deal 3" });
    expect(byText.length).toBeGreaterThan(0);
    expect(byText.some((c) => !c.name.toLowerCase().includes("deal 3"))).toBe(true);
  });

  it("filters by domain, matching a card with EITHER of its domains", () => {
    const fury = run({ domains: new Set<Domain>(["Fury"]) });
    expect(fury.length).toBeGreaterThan(0);
    expect(fury.every((c) => c.domains.includes("Fury"))).toBe(true);
  });

  it("'implemented only' hides the unimplemented cards and keeps the rest", () => {
    // This used to assert the filter removed NOTHING, which was true and a real
    // control while OGN+OGS were the whole pool and both were finished. SFD
    // landed on 2026-08-04 with ~200 cards unwritten, so the filter now has
    // something to do — and asserting "hides nothing" would have meant either
    // deleting the check or, worse, keeping a green test whose premise was that
    // the deck builder has no unimplemented cards to hide.
    //
    // Pinned in both directions instead, which is what the flag is actually
    // for: everything it keeps is implemented, everything it drops is not, and
    // it drops something. The finished sets are checked separately, because a
    // card disappearing from OGN or OGS is a regression while an SFD one is
    // simply not written yet.
    const shown = run({ implementedOnly: true });
    expect(shown.length, "the filter hides nothing — SFD should have unimplemented cards").toBeLessThan(ALL.length);
    expect(shown.every((c) => isCardImplemented(c))).toBe(true);
    const hidden = ALL.filter((c) => !shown.includes(c));
    expect(hidden.every((c) => !isCardImplemented(c))).toBe(true);
    expect(
      hidden.filter((c) => c.id.startsWith("OGN-") || c.id.startsWith("OGS-")),
      "a card from a declared-complete set is being hidden as unimplemented",
    ).toEqual([]);
  });

  it("reports an active filter so the Clear affordance can appear", () => {
    expect(hasActiveFilters(withFilters({ costs: new Set([1]) }))).toBe(true);
    expect(hasActiveFilters(withFilters({ search: "  " })), "whitespace is not a filter").toBe(false);
  });
});

describe("sorting", () => {
  const legend = registry.all().find((c) => c.type === "Legend")!;
  const legal = registry.all().filter((c) => isCardLegalForLegend(c, legend.domains));

  it("curve order is Energy, then Power, then name", () => {
    const sorted = run({ sort: "curve" }, legal);
    for (let i = 1; i < sorted.length; i += 1) {
      const a = sorted[i - 1]!;
      const b = sorted[i]!;
      const ae = "energyCost" in a ? a.energyCost : 0;
      const be = "energyCost" in b ? b.energyCost : 0;
      expect(ae, `${a.name} before ${b.name}`).toBeLessThanOrEqual(be);
    }
  });

  it("name order is alphabetical", () => {
    const sorted = run({ sort: "name" }, legal);
    const names = sorted.map((c) => c.name);
    expect(names).toEqual([...names].sort((x, y) => x.localeCompare(y)));
  });

  it("cost-desc puts the most expensive first", () => {
    const sorted = run({ sort: "cost-desc" }, legal);
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const energy = (c: CardDefinition) => ("energyCost" in c ? c.energyCost : 0);
    expect(energy(first)).toBeGreaterThanOrEqual(energy(last));
  });

  it("does not change WHICH cards are shown", () => {
    // A sort that filtered would be a silently narrowed pool.
    const ids = (s: CardFilters["sort"]) => new Set(run({ sort: s }, legal).map((c) => c.id));
    expect(ids("name")).toEqual(ids("curve"));
    expect(ids("cost-desc")).toEqual(ids("curve"));
  });
});
