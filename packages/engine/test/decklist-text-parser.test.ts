import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { validateDeckList } from "../src/decks/deck-validation.js";
import { parseDecklistText } from "../src/decks/decklist-text-parser.js";

// Verbatim from a real piltoverarchive.com-style export the user pasted in.
// Deliberately references several cards outside this engine's Origins-only
// (OGN+OGS) card pool (Master Yi's "Tempered" champion variant, Rengar
// entirely, Fiora's "Peerless" variant, and a handful of later-set units/
// spells) — this is the realistic common case, not a contrived edge case.
const MASTER_YI_TEXT = `
Legend:
1 Master Yi, Wuju Bladesman

Champion:
1 Master Yi, Tempered

MainDeck:
3 Charm
3 Defy
3 Discipline
3 Pit Rookie
3 Sabotage
3 Lonely Poro
3 Punch First
3 Scuttle Crab
2 En Garde
2 Zhonya's Hourglass
2 First Mate
2 Ruin Runner
1 Challenge
1 Primal Strength
3 Rengar, Trophy Hunter
2 Fiora, Peerless

Battlefields:
1 The Arena's Greatest
1 Emperor's Dais
1 Seat of Power

Runes:
7 Body Rune
5 Calm Rune

Sideboard:
3 Disarming Rake
2 Alpha Strike
1 Challenge
1 Ruin Runner
1 Fiora, Peerless
`;

describe("parseDecklistText: real community-export fixture (heavy resolution gaps)", () => {
  const registry = defaultCardRegistry();
  const result = parseDecklistText(MASTER_YI_TEXT, registry);

  it("parses (legend resolves) despite champion/several cards being out of scope", () => {
    expect(result).not.toBeNull();
  });

  it("resolves the legend via comma->dash name normalization", () => {
    const legendDef = registry.get(result!.deckList.legendId);
    expect(legendDef.name).toBe("Master Yi - Wuju Bladesman");
  });

  it("leaves championId empty and flags it unresolved — no 'Tempered' variant exists in our data", () => {
    expect(result!.deckList.championId).toBe("");
    expect(result!.unresolvedNames).toContain("Master Yi, Tempered");
  });

  it("resolves the MainDeck cards that exist and flags the ones that don't (no champion appended since none resolved)", () => {
    // Charm+Defy+Discipline+Pit Rookie+Sabotage (3 each) + En Garde+Zhonya's+First Mate (2 each) + Challenge+Primal Strength (1 each)
    expect(result!.deckList.cardIds).toHaveLength(3 * 5 + 2 * 3 + 1 * 2);
    for (const name of ["Lonely Poro", "Punch First", "Scuttle Crab", "Ruin Runner", "Rengar, Trophy Hunter", "Fiora, Peerless"]) {
      expect(result!.unresolvedNames).toContain(name);
    }
  });

  it("dedupes a name that fails to resolve in both MainDeck and Sideboard (Fiora, Peerless)", () => {
    expect(result!.unresolvedNames.filter((n) => n === "Fiora, Peerless")).toHaveLength(1);
  });

  it("passes battlefield names through verbatim, no resolution attempted", () => {
    expect(result!.deckList.battlefieldNames).toEqual(["The Arena's Greatest", "Emperor's Dais", "Seat of Power"]);
  });

  it("maps rune counts to the legend's real domains via sortByDomainOrdinal (Calm=A, Body=B)", () => {
    expect(result!.deckList.runeDomainACount).toBe(5); // Calm
    expect(result!.deckList.runeDomainBCount).toBe(7); // Body
  });

  it("leaves the sideboard empty (all-or-nothing): Disarming Rake/Alpha Strike/Ruin Runner/Fiora, Peerless don't resolve", () => {
    expect(result!.deckList.sideboardCardIds).toEqual([]);
    expect(result!.unresolvedNames).toContain("Disarming Rake");
    expect(result!.unresolvedNames).toContain("Alpha Strike");
  });
});

describe("parseDecklistText: a resolvable champion appends exactly one copy", () => {
  it("reaches 40 cards when the champion resolves", () => {
    const registry = defaultCardRegistry();
    const text = MASTER_YI_TEXT.replace("1 Master Yi, Tempered", "1 Master Yi, Meditative");
    const result = parseDecklistText(text, registry)!;
    expect(result.deckList.championId).not.toBe("");
    expect(result.deckList.cardIds).toHaveLength(3 * 5 + 2 * 3 + 1 * 2 + 1);
  });
});

describe("parseDecklistText: comma->dash normalization applies outside Legend/Champion too", () => {
  it("resolves a champion name used as an extra MainDeck copy", () => {
    const registry = defaultCardRegistry();
    const text = `Legend:\n1 Master Yi, Wuju Bladesman\n\nChampion:\n1 Master Yi, Meditative\n\nMainDeck:\n2 Fiora, Victorious\n`;
    const result = parseDecklistText(text, registry)!;
    const fioraId = registry.all().find((c) => c.name === "Fiora - Victorious")!.id;
    expect(result.deckList.cardIds.filter((id) => id === fioraId)).toHaveLength(2);
    expect(result.unresolvedNames).not.toContain("Fiora, Victorious");
  });
});

describe("parseDecklistText: fully-resolvable synthetic list", () => {
  const registry = defaultCardRegistry();
  const text = `
Legend:
1 Master Yi, Wuju Bladesman

Champion:
1 Master Yi, Meditative

MainDeck:
3 Charm
3 Defy
3 Discipline
3 Pit Rookie
3 Sabotage
2 En Garde
2 Zhonya's Hourglass
2 First Mate
1 Challenge
1 Primal Strength
1 Clockwork Keeper
1 Find Your Center
1 Meditation
1 Playful Phantom
1 Rune Prison
1 Solari Shieldbearer
1 Stalwart Poro
1 Stand United
1 Sunlit Guardian
1 Wielder of Water
1 Adaptatron
1 Block
1 Eclipse Herald
1 Mask of Foresight
1 Poro Herder
1 Reinforce

Battlefields:
1 The Arena's Greatest
1 Emperor's Dais
1 Seat of Power

Runes:
7 Body Rune
5 Calm Rune

Sideboard:
1 Spirit's Refuge
1 Wind Wall
1 Wizened Elder
1 Last Stand
1 Mageseeker Warden
1 Party Favors
1 Solari Shrine
1 Mystic Reversal
`;
  const result = parseDecklistText(text, registry);

  it("resolves everything with no gaps", () => {
    expect(result!.unresolvedNames).toEqual([]);
  });

  it("produces a deck that passes full validation", () => {
    expect(result!.deckList.cardIds).toHaveLength(40);
    expect(result!.deckList.sideboardCardIds).toHaveLength(8);
    const validation = validateDeckList(result!.deckList, registry);
    expect(validation, validation.ok ? "" : validation.error).toEqual({ ok: true });
  });
});

describe("parseDecklistText: malformed input", () => {
  const registry = defaultCardRegistry();

  it("returns null for text with no recognizable section headers", () => {
    expect(parseDecklistText("just some random text\nwith no structure at all", registry)).toBeNull();
  });

  it("returns null when the Legend name doesn't resolve to anything", () => {
    expect(parseDecklistText("Legend:\n1 Totally Not A Real Legend\n", registry)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseDecklistText("", registry)).toBeNull();
  });
});

describe("parseDecklistText: header tolerance", () => {
  const registry = defaultCardRegistry();

  it("tolerates 'Main Deck:' and 'Side Board:' spacing variants, and case-insensitivity", () => {
    const text = `
LEGEND:
1 Master Yi, Wuju Bladesman

Champion:
1 Master Yi, Meditative

Main Deck:
3 Charm

Side Board:
`;
    const result = parseDecklistText(text, registry);
    expect(result).not.toBeNull();
    expect(result!.deckList.cardIds.length).toBeGreaterThanOrEqual(3);
  });
});
