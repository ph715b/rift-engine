import { describe, expect, it } from "vitest";
import { SIDEBOARD_SIZE } from "../src/decks/deck-list.js";
import { parseDeckFile, serializeDeckFile } from "../src/decks/deck-file-parser.js";

/**
 * **The sideboard is a CAP of ten, not an exact count.**
 *
 * Changed 2026-08-23, from eight. Two decisions are pinned here and the second
 * matters more than the first:
 *
 *  - **Ten, not eight.** A format number, not a rules-text one — the core
 *    rulebook does not mention sideboards at all.
 *  - **At most ten, not exactly ten.** Every check used to read "empty or
 *    exactly SIDEBOARD_SIZE", so raising the number would have invalidated every
 *    deck built under the old one — six of the eight decks in the app's own
 *    store, including archived Regional Qualifier lists that were legal when
 *    built. A card limit going up does not retroactively unmake decks under it.
 *
 * The asserted invariant is the RELATIONSHIP (a legal sideboard is anything from
 * empty up to the cap), not the literal 10, so the next format change is one
 * line in `deck-list.ts` and does not turn this file red. The literal is checked
 * exactly once, below, where it is the thing under test.
 */

/** A minimal legal deck body, with `n` sideboard lines appended. */
function deckText(n: number): string {
  const lines = [
    "NAME=Cap Test",
    "LEGEND=OGN-001",
    "CHAMPION=OGN-002",
    ...Array.from({ length: 40 }, () => "CARD=OGN-164"),
    "RUNE_A=6",
    "RUNE_B=6",
    "BATTLEFIELD=Zaun Warrens",
    "BATTLEFIELD=Targon's Peak",
    "BATTLEFIELD=Reaver's Row",
    ...Array.from({ length: n }, () => "SIDEBOARD=OGN-164"),
  ];
  return lines.join("\n");
}

const sideboardOf = (n: number) => parseDeckFile(deckText(n))?.sideboardCardIds.length;

describe("the number itself", () => {
  it("is ten", () => {
    expect(SIDEBOARD_SIZE, "the sideboard size changed without this being updated").toBe(10);
  });
});

describe("the parser treats it as a maximum", () => {
  it("accepts an EMPTY sideboard", () => {
    expect(sideboardOf(0), "a deck with no sideboard was rejected").toBe(0);
  });

  it("accepts a FULL sideboard", () => {
    expect(sideboardOf(SIDEBOARD_SIZE), "a full sideboard was rejected").toBe(SIDEBOARD_SIZE);
  });

  it("accepts a PARTIAL sideboard — the decks built under the old cap", () => {
    // The assertion this change exists for. Eight is the old exact size and the
    // one six saved decks actually carry; under a ten-card cap it is simply a
    // legal short sideboard.
    expect(sideboardOf(SIDEBOARD_SIZE - 2), "a sideboard under the cap was rejected").toBe(SIDEBOARD_SIZE - 2);
  });

  it("accepts every size from empty to the cap", () => {
    // The RELATIONSHIP rather than three sampled points, so a parser that
    // happened to allow 0, 8 and 10 and nothing else could not pass.
    for (let n = 0; n <= SIDEBOARD_SIZE; n += 1) {
      expect(sideboardOf(n), `a ${n}-card sideboard was rejected`).toBe(n);
    }
  });

  it("REJECTS one card over the cap", () => {
    // The other direction, and the half that makes the cap real rather than
    // removed. Without it "at most ten" would be indistinguishable from "any
    // number", which is what dropping the check entirely would look like.
    expect(sideboardOf(SIDEBOARD_SIZE + 1), "a sideboard over the cap was accepted").toBeUndefined();
  });
});

describe("round-tripping keeps the sideboard", () => {
  it("survives serialize then parse at a partial size", () => {
    // A short sideboard silently dropped on the way through is the failure mode
    // that loses a player's cards without an error.
    const parsed = parseDeckFile(deckText(SIDEBOARD_SIZE - 2));
    expect(parsed, "the fixture did not parse").toBeDefined();
    const round = parseDeckFile(serializeDeckFile(parsed!));
    expect(round?.sideboardCardIds, "the sideboard did not survive the round trip").toHaveLength(SIDEBOARD_SIZE - 2);
  });
});
