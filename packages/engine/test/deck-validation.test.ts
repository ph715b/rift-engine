import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardLegalForLegend, isEligibleChampion, validateDeckList } from "../src/decks/deck-validation.js";
import { allPresetDecks, presetDeckList } from "../src/decks/deck-presets.js";
import { LEGACY_BATTLEFIELDS } from "../src/decks/deck-list.js";
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

/** Every preset must be a legal deck, checked through the real validator rather
 *  than trusted — the two Origins starter decks were transcribed from pasted
 *  lists, and a preset that fails validation would only surface as a broken
 *  lobby entry. */
describe("preset decks are all valid", () => {
  const registry = defaultCardRegistry();

  for (const preset of allPresetDecks()) {
    it(`${preset.name} validates, has 40 cards and 3 battlefields`, () => {
      const list = presetDeckList(preset);
      expect(validateDeckList(list, registry)).toEqual({ ok: true });
      expect(list.cardIds).toHaveLength(40);
      expect(list.battlefieldNames).toHaveLength(3);
      // The set-aside champion copy has to be IN the 40 (player-setup pulls it
      // out before shuffling), or the deck plays a card short.
      expect(list.cardIds).toContain(preset.championId);
    });
  }

  it("includes all three Origins starter decks, not just the Proving Grounds four", () => {
    const names = allPresetDecks().map((p) => p.name);
    expect(names).toContain("Jinx: Fury + Chaos");
    expect(names).toContain("Lee Sin: Calm + Body");
    expect(names).toContain("Viktor: Mind + Order");
    expect(allPresetDecks()).toHaveLength(7);
  });

  it("gives the starter decks their own battlefields rather than the legacy trio", () => {
    const jinx = presetDeckList(allPresetDecks().find((p) => p.name.startsWith("Jinx"))!);
    expect(jinx.battlefieldNames).toEqual(["Reaver's Row", "Targon's Peak", "Zaun Warrens"]);
    // ...while a Proving Grounds precon still falls back to it.
    const annie = presetDeckList(allPresetDecks().find((p) => p.name.startsWith("Annie"))!);
    expect(annie.battlefieldNames).toEqual(LEGACY_BATTLEFIELDS);
  });
});
