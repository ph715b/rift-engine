import { describe, expect, it } from "vitest";
import { parseDecklistText } from "../src/decks/decklist-text-parser.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { RUNE_DECK_SIZE } from "../src/decks/deck-list.js";

/**
 * **An unrecognised section header used to empty itself into whichever section
 * was open before it.**
 *
 * Reported from playtesting, as the message the importer showed:
 *
 * > *Couldn't find these in the card pool — pick something else for them: Rune
 * > Pool:, Fury Rune, Fury Rune, Fury Rune, Fury Rune, Fury Rune, Fury Rune,
 * > Body Rune, Body Rune, Body Rune, Body Rune, Body Rune, Body Rune*
 *
 * Two bugs, stacked:
 *
 * 1. **`Rune Pool:` was not a header this parser knew.** The rune section never
 *    opened, so the deck imported with the 6/6 DEFAULT split rather than the one
 *    the list named — silently, because a default that sums to `RUNE_DECK_SIZE`
 *    is a legal-shaped deck.
 * 2. **`current` was never cleared**, so the unrecognised header line and every
 *    line under it fell through into the still-open BATTLEFIELDS section. That is
 *    where the thirteen names in the message came from.
 *
 * The alias table fixes the first. **A line ending in a colon now closes the open
 * section**, recognised or not, which fixes the class: a section this parser does
 * not know is skipped cleanly instead of being poured into its neighbour. No card
 * in this pool has a name ending in a colon, so nothing legitimate is lost.
 *
 * The second half only became VISIBLE because battlefield names started being
 * resolved and reported the day before. Before that it produced the same wrong
 * deck with no message at all.
 */

const registry = defaultCardRegistry();

const listWith = (runeHeader: string, fury: number, body: number, extra = "") =>
  [
    "Legend:",
    "1 Rengar, Pridestalker",
    "",
    "MainDeck:",
    "3 Rengar, Trophy Hunter",
    "",
    "Battlefields:",
    "1 The Arena's Greatest",
    "1 Emperor's Dais",
    "1 Seat of Power",
    extra,
    "",
    runeHeader,
    `${fury} Fury Rune`,
    `${body} Body Rune`,
    "",
  ].join("\n");

const parse = (text: string) => {
  const result = parseDecklistText(text, registry);
  expect(result, "the list did not parse at all").not.toBeNull();
  return result!;
};

describe("what a rune section can be called", () => {
  // 8/4 rather than 6/6 ON PURPOSE: `RUNE_DECK_SIZE / 2` is the fallback when no
  // rune section is read, so a 6/6 assertion passes just as well against a parser
  // that ignored the section entirely. That is exactly how the reported bug hid.
  for (const header of ["Runes:", "Rune Pool:", "Rune Deck:", "Rune:"]) {
    it(`reads "${header}"`, () => {
      const { deckList } = parse(listWith(header, 8, 4));
      expect(deckList.runeDomainACount).toBe(8);
      expect(deckList.runeDomainBCount).toBe(4);
    });
  }

  it("an uneven split is not the fallback — the control", () => {
    // Proves the assertions above measure parsing rather than a coincidence.
    expect(RUNE_DECK_SIZE / 2).not.toBe(8);
  });

  it("the fallback still fires when there is genuinely no rune section", () => {
    // Removing it must leave a legal-shaped deck rather than 0/0, which
    // `validateDeckList` would reject with no clue why.
    const withoutRunes = [
      "Legend:",
      "1 Rengar, Pridestalker",
      "",
      "MainDeck:",
      "3 Rengar, Trophy Hunter",
    ].join("\n");
    const { deckList } = parse(withoutRunes);
    expect(deckList.runeDomainACount + deckList.runeDomainBCount).toBe(RUNE_DECK_SIZE);
  });
});

describe("an unrecognised header closes the section instead of leaking", () => {
  it("does not pour itself or its lines into the previous section", () => {
    // The reported message, reproduced: an unknown header sitting between the
    // battlefields and the runes. Before the fix this yielded thirteen
    // unresolved names — the header line plus every rune line under it.
    const { deckList, unresolvedNames } = parse(
      listWith("Rune Pool:", 6, 6, "\nNotes From The Author:\nbuilt for the Tuesday pod"),
    );

    expect(unresolvedNames, "the unknown section leaked into its neighbour").toEqual([]);
    expect(deckList.battlefieldNames, "rune lines were taken as battlefields").toEqual([
      "The Arena's Greatest",
      "Emperor's Dais",
      "Seat of Power",
    ]);
  });

  it("...and the section AFTER it still parses", () => {
    // Closing the section must not swallow the rest of the file. `Rune Pool:`
    // comes after the unknown header here, so if the parser had stopped reading
    // this would fall back to 6/6.
    const { deckList } = parse(listWith("Rune Pool:", 8, 4, "\nNotes:\nsome prose"));
    expect(deckList.runeDomainACount).toBe(8);
    expect(deckList.runeDomainBCount).toBe(4);
  });

  it("prose with no colon under an unknown header is still ignored", () => {
    // It falls to the `!current` guard rather than to a section. Without the
    // colon rule above it would have been a bare battlefield name.
    const { unresolvedNames } = parse(listWith("Rune Pool:", 6, 6, "\nNotes:\nbuilt for the Tuesday pod"));
    expect(unresolvedNames).toEqual([]);
  });
});
