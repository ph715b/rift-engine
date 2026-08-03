import { describe, expect, it } from "vitest";
import {
  hiddenKeywordFalsePositiveDefIds,
  isGenuinelyHidden,
  loadBattlefieldDefinitions,
  loadCardDefinitions,
} from "../src/cards/card-loader.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { extractCardItems } from "../src/cards/raw-card-schema.js";
import { DOMAINS, isDomain, lowestOrdinalDomain } from "../src/model/domain.js";
import { allPresetDecks } from "../src/decks/deck-presets.js";
import ognRaw from "../src/cards/ogn.json" with { type: "json" };
import ogsRaw from "../src/cards/ogs.json" with { type: "json" };

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

/**
 * `shouldSkip` decides which raw entries never become playable cards, and two
 * of the four markers it reads are FREE STRINGS.
 *
 * `classification.type` is a closed zod enum, so a card type an unseen set
 * invents fails loudly at parse — that half is safe by construction.
 * `supertype` and `rarity` are `z.string()`, so a new variant marker (a rarity
 * beside "Showcase", a supertype beside "Token") sails straight through.
 *
 * **A variant does NOT arrive as a duplicate defId** — measured, because that
 * was the obvious guess and it is wrong. Every Showcase and alternate-art entry
 * in this data carries its OWN card number: un-skipping all 54 Showcase entries
 * adds 54 definitions with 54 distinct ids and zero collisions. So the
 * detector cannot be "no two cards share an id"; it has to be the markers
 * themselves. Hence a census, which forces a decision on a new value.
 *
 * The defId sweep below is kept anyway as its own invariant: `CardRegistry`
 * indexes with `byId.set`, so a pair that DID collide would not error — the
 * later one silently wins, and the count barely moves.
 */
describe("shouldSkip: the markers a new set could quietly step outside", () => {
  const raw = [...extractCardItems(ognRaw), ...extractCardItems(ogsRaw)];
  const census = (pick: (c: (typeof raw)[number]) => string | null) =>
    [...new Set(raw.map(pick))].sort((a, b) => String(a).localeCompare(String(b)));

  it("finds the raw entries at all", () => {
    // Without this the three censuses below would all pass on an empty list.
    expect(raw.length).toBeGreaterThan(300);
  });

  it("every supertype in the data is one shouldSkip has an answer for", () => {
    // "Token" is skipped; the rest are real cards. A sixth value here is a new
    // kind of entry, and the question it forces is whether it is playable.
    expect(census((c) => c.classification.supertype)).toEqual(["Basic", "Champion", null, "Signature", "Token"]);
  });

  it("every rarity in the data is one shouldSkip has an answer for", () => {
    // "Showcase" is the variant-print marker and is skipped. A new one — a
    // serialised or foil treatment filed under its own rarity — would import a
    // second, deckbuildable entry for a card already in the pool, under its own
    // defId, which is indistinguishable from a genuinely new card.
    expect(census((c) => c.classification.rarity)).toEqual(["Common", "Epic", "Rare", "Showcase", "Uncommon"]);
  });

  it("loads no two definitions sharing a defId", () => {
    // A separate registry invariant, asked of the loader's OUTPUT because the
    // registry's Map is what would swallow it: `byId.set` keeps whichever came
    // last, with no error and almost no change in the count.
    const ids = loadCardDefinitions().map((def) => def.id);
    const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    expect(duplicates, "two definitions share a defId — the registry keeps whichever came last").toEqual([]);
    expect(new Set(ids).size).toBe(defaultCardRegistry().all().length);
  });
});

/**
 * `DOMAINS` is a closed 7-value union, and the two things that could go wrong
 * with a new set's domain point in opposite directions.
 *
 * A domain the union does not contain fails LOUDLY: `parseDomains` throws
 * "Unknown domain in card data" at load, so the whole pool refuses rather than
 * defaulting. That is the right behaviour and needs no guard.
 *
 * The ORDER is the quiet one. `lowestOrdinalDomain` picks every multi-domain
 * card's `powerDomain` from it, and `sortByDomainOrdinal` decides which of a
 * legend's two domains a deck's rune split calls "A" — so inserting a domain
 * anywhere but the end silently re-points existing cards' Power costs and
 * existing decks' rune decks. Pinned so that insertion is a visible decision.
 */
describe("DOMAINS: a closed union whose ORDER is load-bearing", () => {
  it("keeps its ordinal order — inserting a domain mid-list re-points existing cards", () => {
    expect([...DOMAINS]).toEqual(["Fury", "Calm", "Mind", "Body", "Chaos", "Order", "Colorless"]);
  });

  it("refuses a domain it does not model, rather than defaulting", () => {
    // The loud half, proved rather than assumed: this is what makes a new set's
    // domain a compiler-and-loader-guided change instead of a silent one.
    expect(isDomain("Spirit")).toBe(false);
    expect(lowestOrdinalDomain(["Order", "Fury"])).toBe("Fury");
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

  it("every card printing 'I enter ready' is accounted for, one way or the other", () => {
    // The way to NOTICE that a new set needs its own entry.
    //
    // `QUICK_TEXT_OVERRIDES` is a hand-maintained per-defId list, and a card it
    // misses is not an error — it is a unit that quietly enters exhausted while
    // its text says otherwise. Expect SFD to print more of these.
    //
    // Scoped to "I enter ready" rather than /enters? ready/, which matches 18
    // cards: nine are `[Accelerate]` reminder text (the keyword handles it) and
    // four grant readiness to OTHER units, so a wider sweep would need a
    // 15-entry allow-list and would be noise. The narrow form is exactly five
    // cards, and every one of them is a real decision.
    const CONDITIONAL = new Map([
      // Not overrides, and must not become them — the condition is inside the
      // sentence, which is the `CONDITIONAL_KEYWORD_DEF_IDS` shape. Both are
      // implemented in engine/deploy.ts, where the condition can be read.
      ["OGN-035", "Vayne - Hunter — only if an opponent controls a battlefield"],
      ["OGN-079", "Leona - Zealot — only within 3 points of the Victory Score"],
    ]);
    const printing = defaultCardRegistry()
      .all()
      .filter((def) => /I enter ready/.test(def.text ?? ""));
    expect(printing.length, "the scan matches nothing — it can no longer see the cards it guards").toBe(5);
    const unaccounted = printing
      .filter((def) => !CONDITIONAL.has(def.id))
      .filter((def) => !(def.type === "Unit" && def.keywords.Quick === 1))
      .map((def) => `${def.id} (${def.name})`);
    expect(
      unaccounted,
      "this card says it enters ready and does not — add it to QUICK_TEXT_OVERRIDES, " +
        "or to the CONDITIONAL list here if its readiness is conditional",
    ).toEqual([]);
  });
});

/**
 * `POWER_DOMAIN_ALT_OVERRIDES` corrects a card whose printed Power pip is
 * VISUALLY split between two domains — data no parser can reach, because it is
 * in the art. Every uncorrected multi-domain card silently takes
 * `lowestOrdinalDomain`, and a wrong Power domain reads in play as a cost that
 * cannot be paid off runes that should cover it.
 *
 * There is no way to DERIVE the answer, so this is a census of the candidates
 * rather than a claim about them: which cards could need an entry. Ten of the
 * twelve are OGN's dual-domain Signature spells and one is Tibbers, which has
 * the only entry. The list is asserted so a new set's arrivals show up as a
 * failure with the cards named, and someone looks at the art.
 */
describe("POWER_DOMAIN_ALT_OVERRIDES: a census, since the answer is in the art", () => {
  it("names every card that could need a split-pip entry", () => {
    const candidates = defaultCardRegistry()
      .all()
      .filter((def) => def.domains.length > 1 && "powerCost" in def && def.powerCost > 0)
      .map((def) => `${def.id} ${def.powerDomainAlt ?? "-"}`)
      .sort();
    expect(
      candidates,
      "a multi-domain card with a Power cost — check whether its printed pip is a SPLIT one, " +
        "then add it to POWER_DOMAIN_ALT_OVERRIDES or extend this list to record that it is not",
    ).toEqual([
      "OGN-248 -", // Icathian Rain
      "OGN-250 -", // Stormbringer
      "OGN-252 -", // Super Mega Death Rocket!
      "OGN-254 -", // Noxian Guillotine
      "OGN-258 -", // Dragon's Rage
      "OGN-260 -", // Last Breath
      "OGN-262 -", // Zenith Blade
      "OGN-264 -", // Guerilla Warfare
      "OGN-266 -", // Siphon Power
      "OGN-270 -", // Showstopper
      "OGS-018 Chaos", // Tibbers — the one confirmed split pip
      "OGS-024 -", // Decisive Strike — confirmed NOT hybrid by inspection
    ]);
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
