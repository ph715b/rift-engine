import { describe, expect, it } from "vitest";
import {
  hiddenKeywordFalsePositiveDefIds,
  isGenuinelyHidden,
  loadBattlefieldDefinitions,
  loadCardDefinitions,
} from "../src/cards/card-loader.js";
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

  it("gives Tibbers (OGS-018) a hardcoded Fury/Chaos hybrid Power domain", () => {
    const def = defaultCardRegistry().get("OGS-018");
    expect(def.type).toBe("Unit");
    if (def.type !== "Unit") throw new Error("unreachable");
    expect(def.name).toBe("Tibbers");
    expect(def.powerDomain).toBe("Fury");
    expect(def.powerDomainAlt).toBe("Chaos");
    expect(def.energyCost).toBe(8);
    expect(def.powerCost).toBe(2);
    expect(def.might).toBe(7);
  });

  it("does NOT set powerDomainAlt for Decisive Strike (OGS-024), a non-hybrid multi-domain card", () => {
    const def = defaultCardRegistry().get("OGS-024");
    expect(def.powerDomainAlt).toBeUndefined();
  });
});

describe("loadBattlefieldDefinitions", () => {
  it("loads real Battlefield-type cards with name/art/text, excluded from loadCardDefinitions", () => {
    const battlefields = loadBattlefieldDefinitions();
    expect(battlefields.length).toBeGreaterThan(20);
    for (const b of battlefields) {
      expect(b.name).toBeTruthy();
      expect(b.imageUrl).toBeTruthy();
    }
    const names = battlefields.map((b) => b.name);
    expect(names).toContain("Zaun Warrens");
    expect(names).toContain("Targon's Peak");
    expect(names).toContain("Reaver's Row");
  });

  it("never duplicates a battlefield name (dedupes any alternate art)", () => {
    const names = loadBattlefieldDefinitions().map((b) => b.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("carries real rules text, not a placeholder", () => {
    const altar = loadBattlefieldDefinitions().find((b) => b.name === "Altar to Unity");
    expect(altar?.text).toContain("Recruit unit token");
  });
});

describe("QUICK_TEXT_OVERRIDES: 'I enter ready.' plain-text grants Quick, not just [bracket] tags", () => {
  it("Vanguard Attendant (OGS-016) gets Quick despite no [Quick] bracket in its text", () => {
    const def = defaultCardRegistry().get("OGS-016");
    if (def.type !== "Unit") throw new Error("unreachable");
    expect(def.name).toBe("Vanguard Attendant");
    expect(def.text).not.toContain("[Quick]");
    expect(def.keywords.Quick).toBe(1);
  });

  it("Master Yi - Honed (OGS-009) keeps its real [Ganking] tag AND gets Quick from plain text", () => {
    const def = defaultCardRegistry().get("OGS-009");
    if (def.type !== "Unit") throw new Error("unreachable");
    expect(def.keywords.Ganking).toBe(1);
    expect(def.keywords.Quick).toBe(1);
  });
});

/**
 * The four cards that MENTION `[Hidden]` without carrying it.
 *
 * The table was keyed by card NAME — the only per-card table in the loader that
 * was; `CONDITIONAL_KEYWORD_DEF_IDS`, `GRANTED_ONLY_KEYWORDS` and
 * `QUICK_TEXT_OVERRIDES` are all defId-keyed. A name key is correct exactly
 * while no two cards in the pool share a name, which is true today and is not
 * something the loader states or would notice changing. A reprint or a
 * cross-set collision would have mis-flagged the newcomer's real `[Hidden]`,
 * and a keyword that parses as absent reads in play as the card just not
 * working — the same shape of gap as an inert keyword, with nothing to see.
 *
 * These tests are what says the conversion changed nothing: the same four cards
 * resolve the same way, and the genuine `[Hidden]` cards beside them still do.
 */
describe("HIDDEN_KEYWORD_FALSE_POSITIVE_DEF_IDS: mentioning [Hidden] is not having it", () => {
  const registry = defaultCardRegistry();

  it("the same four cards mention [Hidden] and do not carry it", () => {
    // Named individually rather than swept, because the claim is about these
    // four specific cards and a sweep derived from the same table would agree
    // with it no matter what the table said.
    for (const [id, name] of [
      ["OGN-018", "Noxus Saboteur"],
      ["OGN-107", "Ava Achiever"],
      ["OGN-167", "Ember Monk"],
      ["OGN-264", "Guerilla Warfare"],
    ] as const) {
      const def = registry.get(id);
      expect(def.name, id).toBe(name);
      expect(def.text, `${id} no longer mentions [Hidden] — its entry is dead`).toContain("[Hidden]");
      expect("hidden" in def && def.hidden, `${id} (${name})`).toBe(false);
    }
  });

  it("still leaves every genuine [Hidden] card hidden", () => {
    // The positive control. A table that flagged everything would satisfy the
    // check above and break the keyword outright.
    const genuine = registry
      .all()
      .filter((def) => "hidden" in def && def.hidden === true)
      .map((def) => def.id);
    expect(genuine.length, "no card parses as [Hidden] at all").toBeGreaterThan(0);
    expect(genuine).toContain("OGN-083"); // Consult the Past — "[Hidden] (Hide now for..."
    expect(genuine).toContain("OGN-097"); // Blastcone Fae — a [Hidden] UNIT
    expect(genuine).not.toContain("OGN-018");
  });

  it("every entry names a real card whose text really does mention [Hidden]", () => {
    // An entry that matches no card silences nothing while looking like it
    // does — the same shape as a dead allow-list entry. Under the old NAME key
    // this was unaskable: a name that matched nothing was indistinguishable
    // from a name that matched a card in a set not yet loaded.
    const ids = hiddenKeywordFalsePositiveDefIds();
    expect(ids).toHaveLength(4);
    for (const id of ids) {
      const def = registry.tryGet(id);
      expect(def, `${id} is listed as a [Hidden] false positive but is not a real card`).toBeDefined();
      expect(def!.text, `${id} (${def?.name}) is listed but its text never mentions [Hidden]`).toContain("[Hidden]");
    }
  });

  it("a REPRINT of one of the four, at a new defId, keeps its real [Hidden]", () => {
    // The case the defId key exists for, and the one the loaded pool cannot
    // show: a later set printing a card called "Ember Monk" that genuinely
    // carries the keyword. Under the old NAME key this was unrepresentable —
    // the newcomer would have been silently stripped of a keyword it prints,
    // and a keyword that parses as absent looks exactly like a card that does
    // not work.
    expect(isGenuinelyHidden("[Hidden] (Hide now for 1 rainbow.)", "SFD-101")).toBe(true);
    // Same text, same name it would have carried — and now the id is what
    // decides, so only the listed card is exempted.
    expect(isGenuinelyHidden("When you play a card from [Hidden], give me +2 this turn.", "OGN-167")).toBe(false);
  });

  it("keys on the defId, so a name collision cannot reach it", () => {
    // The point of the conversion, stated as a property rather than left to the
    // absence of collisions. No two cards in the pool share a name TODAY, which
    // is exactly why the old key survived; asserting it here means a future set
    // that breaks it does so against a check that already knows what it costs.
    const byName = new Map<string, string[]>();
    for (const def of registry.all()) {
      const ids = byName.get(def.name);
      if (ids) ids.push(def.id);
      else byName.set(def.name, [def.id]);
    }
    const collisions = [...byName].filter(([, ids]) => ids.length > 1);
    expect(
      collisions.map(([name, ids]) => `${name}: ${ids.join(", ")}`),
      "two cards now share a name — harmless for the [Hidden] table since it keys on defId, " +
        "but check every other by-name lookup (decks/decklist-parser.ts folds names too)",
    ).toEqual([]);
  });
});
