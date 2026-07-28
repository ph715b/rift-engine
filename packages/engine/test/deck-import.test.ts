import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { allPresetDecks, presetDeckList } from "../src/decks/deck-presets.js";
import { validateDeckList } from "../src/decks/deck-validation.js";
import { parseDeckFile, serializeDeckFile } from "../src/decks/deck-file-parser.js";
import { buildPlayerFromDeckList } from "../src/decks/player-setup.js";
import { mulberry32 } from "../src/util/rng.js";
import type { DeckList } from "../src/decks/deck-list.js";

const REAL_DECKS_DIR = "C:\\Users\\patri\\.riftbound\\decks";

describe("deck source 1: Proving Grounds presets", () => {
  it("all 4 presets pass validation", () => {
    const registry = defaultCardRegistry();
    for (const preset of allPresetDecks()) {
      const result = validateDeckList(presetDeckList(preset), registry);
      expect(result, `${preset.name}: ${result.ok ? "" : result.error}`).toEqual({ ok: true });
    }
  });

  it("builds a real PlayerState from a preset (champion pulled out, deck shuffled, rune deck split 6/6)", () => {
    const registry = defaultCardRegistry();
    const garen = presetDeckList(allPresetDecks().find((d) => d.name.startsWith("Garen"))!);
    const player = buildPlayerFromDeckList("p1", "Alice", garen, registry, mulberry32(42));

    expect(player.championZone).not.toBeNull();
    expect(player.championZone!.defId).toBe(garen.championId);
    expect(player.deck).toHaveLength(39); // 40 - the one pulled champion copy

    // Garen's preset deck runs 2 copies of its champion (OGS-007) — only ONE
    // copy is pulled out to championZone (matches CardRegistry.buildPlayerWithChampion,
    // registry/CardRegistry.java:235-238, which also stops after the first match);
    // any additional copies stay in the shuffled draw deck.
    const championCopiesInDeckList = garen.cardIds.filter((id) => id === garen.championId).length;
    const championCopiesRemainingInDeck = player.deck.filter((c) => c.defId === garen.championId).length;
    expect(championCopiesRemainingInDeck).toBe(championCopiesInDeckList - 1);

    expect(player.runeDeck).toHaveLength(12);
    expect(player.runeDeck.filter((r) => r.domain === "Body")).toHaveLength(6);
    expect(player.runeDeck.filter((r) => r.domain === "Order")).toHaveLength(6);
  });

  it("shuffles the rune deck — not a predictable all-of-domain-A-then-domain-B block", () => {
    // Mirrors CardRegistry.buildRuneDeck's `Collections.shuffle(runes)`
    // (registry/CardRegistry.java:214) — a real gap in an earlier version of
    // this port, which built the rune deck but never shuffled it, so every
    // game predictably drew one whole domain's runes before the other.
    const registry = defaultCardRegistry();
    const garen = presetDeckList(allPresetDecks().find((d) => d.name.startsWith("Garen"))!);
    const player = buildPlayerFromDeckList("p1", "Alice", garen, registry, mulberry32(7));

    const domainSequence = player.runeDeck.map((r) => r.domain);
    const firstHalf = new Set(domainSequence.slice(0, 6));
    // Unshuffled, the first 6 entries would all be the same single domain
    // (whichever was built first) — shuffled, the two domains should mix.
    expect(firstHalf.size).toBeGreaterThan(1);
  });
});

describe("deck source 2: the user's real .deck files", () => {
  const fileNames = readdirSync(REAL_DECKS_DIR).filter((f) => f.endsWith(".deck"));

  it("finds the expected 8 real deck files", () => {
    expect(fileNames.length).toBe(8);
  });

  it("parses every real .deck file into a structurally valid DeckList", () => {
    for (const fileName of fileNames) {
      const contents = readFileSync(`${REAL_DECKS_DIR}\\${fileName}`, "utf8");
      const deckList = parseDeckFile(contents);
      expect(deckList, `${fileName} failed to parse`).not.toBeNull();
      expect(deckList!.cardIds).toHaveLength(40);
      expect(deckList!.battlefieldNames).toHaveLength(3);
    }
  });

  it("validates the real decks built entirely from in-scope (Origins/Proving Grounds) cards", () => {
    const registry = defaultCardRegistry();
    const inScopeDeckNames = [
      "Annie_-_Dark_Child_Custom_Deck.deck",
      "Kai_Sa_-_Daughter_of_the_Void_Custom_Deck.deck",
      "Miss_Fortune_-_Bounty_Hunter_Custom_Deck.deck",
      "Yasuo_-_Unforgiven_Custom_Deck.deck",
    ];
    for (const fileName of inScopeDeckNames) {
      const contents = readFileSync(`${REAL_DECKS_DIR}\\${fileName}`, "utf8");
      const deckList = parseDeckFile(contents)!;
      const result = validateDeckList(deckList, registry);
      expect(result, `${fileName}: ${result.ok ? "" : result.error}`).toEqual({ ok: true });
    }
  });

  it("rejects real decks that reference cards outside the Origins-only scope, with a clear error", () => {
    const registry = defaultCardRegistry();
    // References SFD-185 (a Spiritforged legend) — out of scope per PRD's resolved card-scope decision.
    const contents = readFileSync(
      `${REAL_DECKS_DIR}\\_Hartford__Best-of_Draven_-_TCG_SogeKing.deck`,
      "utf8",
    );
    const deckList = parseDeckFile(contents)!;
    const result = validateDeckList(deckList, registry);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("SFD-185");
  });
});

describe("deck source 3: an arbitrary user-built deck (not from any file)", () => {
  it("validates a hand-built DeckList the same way as the other two sources", () => {
    const registry = defaultCardRegistry();
    // Built entirely in-memory — no preset, no .deck file — demonstrating FR2c:
    // the user can construct/edit a decklist for a card they don't own a file for yet.
    const garenPreset = presetDeckList(allPresetDecks().find((d) => d.name.startsWith("Garen"))!);
    const customDeck: DeckList = {
      ...garenPreset,
      name: "My hypothetical Garen build",
    };

    expect(validateDeckList(customDeck, registry)).toEqual({ ok: true });
  });

  it("rejects an arbitrary deck that breaks the max-3-copies rule", () => {
    const registry = defaultCardRegistry();
    const garenPreset = presetDeckList(allPresetDecks().find((d) => d.name.startsWith("Garen"))!);
    const tooManyCopies: DeckList = {
      ...garenPreset,
      cardIds: [...garenPreset.cardIds.slice(0, 36), "OGN-210", "OGN-210", "OGN-210", "OGN-210"],
    };

    const result = validateDeckList(tooManyCopies, registry);
    expect(result.ok).toBe(false);
  });
});

describe("serializeDeckFile / parseDeckFile round-trip", () => {
  it("every preset round-trips through serialize -> parse unchanged", () => {
    for (const preset of allPresetDecks()) {
      const deckList = presetDeckList(preset);
      const roundTripped = parseDeckFile(serializeDeckFile(deckList));
      expect(roundTripped).toEqual(deckList);
    }
  });

  it("round-trips a deck with an empty sideboard", () => {
    const garenPreset = presetDeckList(allPresetDecks().find((d) => d.name.startsWith("Garen"))!);
    expect(garenPreset.sideboardCardIds).toEqual([]);
    const roundTripped = parseDeckFile(serializeDeckFile(garenPreset));
    expect(roundTripped).toEqual(garenPreset);
  });

  it("round-trips a deck with a real 8-card sideboard", () => {
    const garenPreset = presetDeckList(allPresetDecks().find((d) => d.name.startsWith("Garen"))!);
    const withSideboard: DeckList = {
      ...garenPreset,
      sideboardCardIds: garenPreset.cardIds.slice(0, 8),
    };
    const roundTripped = parseDeckFile(serializeDeckFile(withSideboard));
    expect(roundTripped).toEqual(withSideboard);
  });
});
