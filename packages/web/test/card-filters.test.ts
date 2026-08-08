import { describe, expect, it } from "vitest";
import {
  COMPLETE_SETS,
  defaultCardRegistry,
  isCardImplemented,
  isCardLegalForLegend,
  setCodeOf,
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

  it("'implemented only' PARTITIONS the pool — everything kept is implemented, everything dropped is not", () => {
    // **This test's premise has now flipped TWICE, and this version is written
    // so it cannot flip a third time.**
    //
    // It first asserted the filter removed NOTHING, which was true and a real
    // control while OGN+OGS were the whole pool and both were finished. SFD
    // landed 2026-08-04 with ~200 cards unwritten, so it was rewritten to assert
    // the filter dropped SOMETHING. SFD finished on 2026-08-07 and that
    // assertion went red — the pool is complete again, so there is nothing to
    // hide, and the count-based check was measuring the state of the card pool
    // rather than the behaviour of the filter.
    //
    // What is true in EVERY pool state is the partition: the filter keeps
    // exactly the implemented cards and drops exactly the rest, and the two
    // halves account for all of it. That is what the flag is for, and it is
    // asserted here. Whether the filter has anything to DO is a fact about the
    // pool, and it is proved on a synthetic card in the next test instead —
    // the same technique `set-coverage.test.ts` and `coverage-drift.test.ts`
    // already use, and for the same reason: a check that depends on a real set
    // being unfinished stops working the day it is finished.
    const shown = run({ implementedOnly: true });
    const hidden = ALL.filter((c) => !shown.includes(c));

    expect(shown.length + hidden.length, "the two halves do not account for the pool").toBe(ALL.length);
    expect(shown.every((c) => isCardImplemented(c))).toBe(true);
    expect(hidden.every((c) => !isCardImplemented(c))).toBe(true);

    // A card from a set declared complete must never be hidden — that is a
    // REGRESSION, where an unimplemented card from a set under construction is
    // simply not written yet. Read from `COMPLETE_SETS` rather than hardcoding
    // the set codes, so this starts protecting the next set on the day it is
    // declared instead of the day someone remembers to widen it. It covers all
    // three today; it covered two when it named them by hand.
    expect(
      hidden.filter((c) => COMPLETE_SETS.includes(setCodeOf(c.id))).map((c) => `${c.id} (${c.name})`),
      "a card from a declared-complete set is being hidden as unimplemented",
    ).toEqual([]);
  });

  it("'implemented only' really does hide an unimplemented card", () => {
    // The half the partition above cannot prove on a finished pool: a filter
    // that returned its input unchanged would satisfy every assertion there,
    // because every real card is implemented.
    //
    // Proved on a SYNTHETIC card that cannot be implemented out from under it —
    // it has real rules text and no registration anywhere, so
    // `isCardImplemented` is false for it by construction rather than by the
    // pool happening to be unfinished.
    const unwritten = {
      ...ALL.find((c) => c.type === "Spell")!,
      id: "ZZZ-001",
      name: "Unwritten Card In No Set",
      text: "Do something no module has ever registered.",
    } as CardDefinition;
    expect(isCardImplemented(unwritten), "the synthetic card is not unimplemented — this test proves nothing").toBe(
      false,
    );

    const withUnwritten = [...ALL, unwritten];
    const shown = run({ implementedOnly: true }, withUnwritten);
    expect(shown.length, "the filter kept a card with no implementation").toBe(withUnwritten.length - 1);
    expect(shown.some((c) => c.id === "ZZZ-001")).toBe(false);
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
