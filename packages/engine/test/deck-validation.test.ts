import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardLegalForLegend, isEligibleChampion } from "../src/decks/deck-validation.js";
import type { LegendDefinition, UnitDefinition } from "../src/model/card-definition.js";

describe("isEligibleChampion", () => {
  const registry = defaultCardRegistry();
  const garenLegend = registry.get("OGS-023") as LegendDefinition;
  const garenChampion = registry.get("OGS-007") as UnitDefinition;
  const luxLegend = registry.get("OGS-021") as LegendDefinition;

  it("accepts a champion whose name/domains match the legend", () => {
    expect(isEligibleChampion(garenChampion, garenLegend.name, garenLegend.domains)).toBe(true);
  });

  it("rejects a champion belonging to a different character", () => {
    expect(isEligibleChampion(garenChampion, luxLegend.name, luxLegend.domains)).toBe(false);
  });
});

describe("isCardLegalForLegend", () => {
  const registry = defaultCardRegistry();
  const garenLegend = registry.get("OGS-023") as LegendDefinition;

  it("rejects any Legend-typed card regardless of domain overlap", () => {
    expect(isCardLegalForLegend(garenLegend, garenLegend.domains)).toBe(false);
  });

  it("accepts a non-Legend card sharing a domain with the legend", () => {
    const garenChampion = registry.get("OGS-007");
    expect(isCardLegalForLegend(garenChampion, garenLegend.domains)).toBe(true);
  });

  it("rejects a card with zero domain overlap", () => {
    const disjointDomain = registry.all().find((c) => c.type !== "Legend" && c.domains.every((d) => !garenLegend.domains.includes(d)));
    expect(disjointDomain).toBeDefined();
    expect(isCardLegalForLegend(disjointDomain!, garenLegend.domains)).toBe(false);
  });
});
