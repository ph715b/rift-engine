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

  /**
   * The match is a NAME PREFIX — `"Garen - "` cut from the legend at its first
   * `" - "`. That is the one rule here a new set can break without breaking a
   * card, so it is exercised on synthetic pairs rather than only on the pool's
   * own legends, where every name already has the shape.
   *
   * Not speculative: a new set's champion for an EXISTING legend is the common
   * case and works, but the format itself is load-bearing in three separate
   * ways, and each fails silently — an ineligible champion is not an error, it
   * is a champion missing from the deck builder's picker.
   */
  describe("the name-prefix rule, on names the pool does not yet contain", () => {
    const champion = (name: string, domains: readonly string[]): UnitDefinition =>
      ({ ...garenChampion, name, domains }) as UnitDefinition;

    it("accepts a NEW champion for an existing legend", () => {
      // The common case when a set lands, and the one that needs no thought.
      expect(isEligibleChampion(champion("Garen - Spiritforged", ["Order"]), garenLegend.name, garenLegend.domains)).toBe(
        true,
      );
    });

    it("rejects a champion whose separator is not ' - '", () => {
      // Community lists write "Character, Title" and decklist-text-parser.ts
      // folds that form on input. This rule does NOT — a card whose printed name
      // used a comma would be eligible for nothing, with no error anywhere.
      expect(isEligibleChampion(champion("Garen, Spiritforged", ["Order"]), garenLegend.name, garenLegend.domains)).toBe(
        false,
      );
      expect(isEligibleChampion(champion("Garen — Spiritforged", ["Order"]), garenLegend.name, garenLegend.domains)).toBe(
        false,
      );
    });

    it("rejects a champion for a legend whose OWN name carries no ' - '", () => {
      // The legend side of the same assumption. With no separator the whole
      // legend name becomes the character, so "Garen" would need a champion
      // named "Garen - …" — which is right, and worth pinning, because a
      // one-word legend is a shape this pool has never had.
      expect(isEligibleChampion(champion("Garen - Spiritforged", ["Order"]), "Garen", garenLegend.domains)).toBe(true);
      expect(isEligibleChampion(champion("Garen Spiritforged", ["Order"]), "Garen", garenLegend.domains)).toBe(false);
    });

    it("still enforces the domain subset, not just the name", () => {
      // The prefix is only half the rule. A champion carrying a domain the
      // legend does not have is ineligible however well its name matches — and
      // a new set's domain, if one ever comes, arrives through exactly here.
      const offDomain = champion("Garen - Spiritforged", [...garenLegend.domains, "Chaos"]);
      expect(isEligibleChampion(offDomain, garenLegend.name, garenLegend.domains)).toBe(false);
    });

    it("every legend in the pool has an eligible champion", () => {
      // The sweep that makes a name-format mismatch visible rather than silent.
      // `validateDeckList` requires the deck's designated champion to be
      // eligible, so a legend with none cannot build a legal deck at all — and
      // nothing says so: it just shows an empty champion picker.
      //
      // Stated this way round on purpose. The first version asked the mirror —
      // "every champion is eligible for some legend" — and reported 24
      // failures, all of them correct: OGN prints 56 champions against 16
      // legends, and a champion whose character has no legend HERE is still a
      // perfectly legal main-deck card through `isCardLegalForLegend`. It is
      // being the DESIGNATED champion that needs the pairing.
      const legends = registry.all().filter((d): d is LegendDefinition => d.type === "Legend");
      const champions = registry.all().filter((d): d is UnitDefinition => d.type === "Unit" && d.isChampion);
      expect(legends.length, "no legends loaded — this sweep is checking nothing").toBeGreaterThan(0);
      const unbuildable = legends
        .filter((l) => !champions.some((c) => isEligibleChampion(c, l.name, l.domains)))
        .map((l) => `${l.id} (${l.name})`);
      expect(unbuildable, "these legends have no eligible champion, so no legal deck can be built for them").toEqual([]);
    });

    it("a champion whose character HAS a legend here is accepted by it", () => {
      // The other half, scoped to the pairs that must exist. This is where a
      // set printing "Ashe – Frost Archer" with an en dash, or a legend named
      // without a title, would land: the champion and its own legend are both
      // present and the prefix rule fails to connect them.
      const legends = registry.all().filter((d): d is LegendDefinition => d.type === "Legend");
      const character = (name: string) => (name.includes(" - ") ? name.slice(0, name.indexOf(" - ")) : name);
      const disconnected = registry
        .all()
        .filter((d): d is UnitDefinition => d.type === "Unit" && d.isChampion)
        .filter((c) => {
          const own = legends.filter((l) => character(l.name) === character(c.name));
          return own.length > 0 && !own.some((l) => isEligibleChampion(c, l.name, l.domains));
        })
        .map((c) => `${c.id} (${c.name})`);
      expect(disconnected, "these champions share a character with a legend here but are not eligible for it").toEqual([]);
    });
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
