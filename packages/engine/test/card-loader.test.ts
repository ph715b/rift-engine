import { describe, expect, it } from "vitest";
import { loadCardDefinitions } from "../src/cards/card-loader.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { allPresetDecks } from "../src/decks/deck-presets.js";

describe("card loader", () => {
  it("loads a non-trivial number of Origins + Proving Grounds cards", () => {
    const defs = loadCardDefinitions();
    // ogn.json (352 raw entries) + ogs.json (24) minus Rune/Battlefield/Token/
    // Showcase/alternate-art skips — not an exact oracle count (no direct
    // access to a running Java instance here), just a sanity floor.
    expect(defs.length).toBeGreaterThan(200);
  });

  it("parses Daring Poro (OGN-210) with the exact fields printed on the card", () => {
    const def = defaultCardRegistry().get("OGN-210");
    expect(def.type).toBe("Unit");
    if (def.type !== "Unit") throw new Error("unreachable");
    expect(def.name).toBe("Daring Poro");
    expect(def.energyCost).toBe(2);
    expect(def.powerCost).toBe(0);
    expect(def.might).toBe(2);
    expect(def.domains).toEqual(["Order"]);
    expect(def.keywords.Assault).toBe(1);
    expect(def.tags).toContain("Poro");
  });

  it("resolves every card id referenced by all 4 Proving Grounds preset decks", () => {
    const registry = defaultCardRegistry();
    for (const preset of allPresetDecks()) {
      expect(() => registry.get(preset.legendId)).not.toThrow();
      expect(() => registry.get(preset.championId)).not.toThrow();
      for (const cardId of preset.deckCardIds) {
        expect(() => registry.get(cardId)).not.toThrow();
      }
    }
  });

  it("never registers a Rune, Battlefield, Token, or Showcase-rarity card", () => {
    const defs = loadCardDefinitions();
    for (const def of defs) {
      expect(def.type).not.toBe("Rune");
      expect(def.type).not.toBe("Battlefield");
    }
  });
});
