import { describe, expect, it } from "vitest";
import { parseDecklistText } from "../src/decks/decklist-text-parser.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { loadBattlefieldDefinitions } from "../src/cards/card-loader.js";
import { LEGACY_BATTLEFIELDS } from "../src/decks/deck-list.js";

/**
 * **Every header and quantity shape a pasted battlefield section arrives in.**
 *
 * Reported from playtesting: *"parser for deck import is not getting the
 * battlefields"*. Four shapes fell through — a singular `Battlefield:` header, a
 * `Battlefields (3):` header, bare names with no quantity, and an `Nx` prefix —
 * and **all four failed the same silent way**: the section never opened (or its
 * lines never matched), `parsedBattlefieldNames` came out empty, the
 * `LEGACY_BATTLEFIELDS` fallback fired, and the deck imported with three
 * battlefields the player never chose and no warning anywhere.
 *
 * The silence is the part worth pinning. A parser that mis-reads a section and
 * SAYS SO is a small bug; one that substitutes a plausible default is a player
 * losing a game to a board they did not build.
 *
 * # The pool is real now, so names are resolved
 *
 * The parser's own note used to say `LEGACY_BATTLEFIELDS` "is the only known
 * battlefield-name pool anywhere in the engine yet". That stopped being true when
 * the last of the 64 landed. Names now resolve against
 * `loadBattlefieldDefinitions()` and an unresolved one is reported in
 * `unresolvedNames`, exactly as an unknown CARD is — which is what that field is
 * for.
 */

const registry = defaultCardRegistry();

/** A minimal legal-shaped list with the battlefield section swapped in. */
const listWith = (battlefieldSection: string) =>
  [
    "Legend:",
    "1 Rengar, Pridestalker",
    "",
    "MainDeck:",
    "3 Rengar, Trophy Hunter",
    "",
    battlefieldSection,
    "",
    "Runes:",
    "7 Body Rune",
    "5 Fury Rune",
    "",
  ].join("\n");

const THREE = ["The Arena's Greatest", "Emperor's Dais", "Seat of Power"];

const parse = (section: string) => {
  const result = parseDecklistText(listWith(section), registry);
  expect(result, "the list did not parse at all — the fixture is broken").not.toBeNull();
  return result!;
};

describe("the header shapes a battlefield section arrives in", () => {
  // Each of these produced LEGACY_BATTLEFIELDS silently before 2026-08-26.
  const headers: Record<string, string> = {
    "Battlefields:": "Battlefields:",
    "Battlefield: (singular)": "Battlefield:",
    "Battlefields (3):": "Battlefields (3):",
    "Battlefields (3) — no colon": "Battlefields (3)",
    "no colon at all": "Battlefields",
    "BATTLEFIELDS shouting": "BATTLEFIELDS:",
  };

  for (const [label, header] of Object.entries(headers)) {
    it(`reads "${label}"`, () => {
      const { deckList } = parse([header, ...THREE.map((n) => `1 ${n}`)].join("\n"));
      expect(deckList.battlefieldNames).toEqual(THREE);
    });
  }
});

describe("the quantity shapes a battlefield line arrives in", () => {
  const lines: Record<string, (name: string) => string> = {
    "1 Name": (n) => `1 ${n}`,
    "1x Name": (n) => `1x ${n}`,
    "1 x Name": (n) => `1 x ${n}`,
    "bare Name": (n) => n,
  };

  for (const [label, render] of Object.entries(lines)) {
    it(`reads "${label}"`, () => {
      const { deckList } = parse(["Battlefields:", ...THREE.map(render)].join("\n"));
      expect(deckList.battlefieldNames).toEqual(THREE);
    });
  }

  it("a bare name is accepted ONLY in the battlefields section", () => {
    // The restriction is principled: a battlefield list is always three
    // battlefields, one each, so a quantity carries no information. A main-deck
    // line without one is ambiguous, and guessing 1 there would turn a site
    // footer into a card name — which would then show up as an unresolved name
    // the player is told to go fix.
    const withFooter = [
      "Legend:",
      "1 Rengar, Pridestalker",
      "",
      "MainDeck:",
      "3 Rengar, Trophy Hunter",
      "Exported from SomeDeckSite",
      "",
      "Battlefields:",
      ...THREE,
      "",
      "Runes:",
      "7 Body Rune",
      "5 Fury Rune",
    ].join("\n");

    const result = parseDecklistText(withFooter, registry)!;
    expect(result.unresolvedNames, "a bare main-deck line was taken as a card").not.toContain(
      "Exported from SomeDeckSite",
    );
    expect(result.deckList.battlefieldNames, "the bare battlefield names were not read").toEqual(THREE);
  });
});

describe("names are RESOLVED against the real 64, not trusted", () => {
  it("normalises casing and curly quotes to the pool's own spelling", () => {
    const { deckList } = parse(
      ["Battlefields:", "1 the arena’s greatest", "1 EMPEROR'S DAIS", "1 Seat of Power"].join("\n"),
    );
    expect(deckList.battlefieldNames, "a pasted list must name what the engine knows").toEqual(THREE);
  });

  it("REPORTS a name that does not resolve, instead of silently swapping it", () => {
    // The heart of the reported bug. The fallback still fires — DeckBuilder has
    // no battlefield picker, so an import that produced an invalid deck would be
    // worse than one that produced a playable default — but it is no longer mute.
    const { deckList, unresolvedNames } = parse(
      ["Battlefields:", "1 The Arenas Greatest", "1 Emperor's Dais", "1 Seat of Power"].join("\n"),
    );

    expect(unresolvedNames, "an unknown battlefield vanished without a word").toContain("The Arenas Greatest");
    expect(deckList.battlefieldNames, "the fallback stopped firing").toEqual(LEGACY_BATTLEFIELDS);
  });

  it("reads battlefields from the newer sets, not just OGN", () => {
    // The old note claimed LEGACY_BATTLEFIELDS was the only known pool. All 64
    // are loadable, and a list naming UNL's or VEN's must import.
    const newer = ["Star Spring", "Protective Sands", "The Dreaming Tree"];
    const { deckList, unresolvedNames } = parse(["Battlefields:", ...newer.map((n) => `1 ${n}`)].join("\n"));

    expect(unresolvedNames).toEqual([]);
    expect(deckList.battlefieldNames).toEqual(newer);
  });

  it("the fixture names are really in the pool — the control", () => {
    // Without this, every assertion above could pass against a parser that
    // resolved nothing and a fixture that named nothing real.
    const pool = new Set(loadBattlefieldDefinitions().map((d) => d.name));
    for (const name of [...THREE, "Star Spring", "Protective Sands", "The Dreaming Tree"]) {
      expect(pool.has(name), `${name} is not a battlefield in this build`).toBe(true);
    }
    expect(pool.size).toBe(64);
  });
});
