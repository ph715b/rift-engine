import { describe, expect, it } from "vitest";
import { loadCardDefinitions } from "../src/cards/card-loader.js";

/**
 * **A keyword a card PARSES but does not have.**
 *
 * `parseKeywords` reads brackets out of printed text, and printed text is full of
 * brackets that belong to something else: a neighbour a card grants to, a value
 * only the board can supply, or — the shape this file was written for — a TOKEN
 * the card makes, whose abilities are quoted in a parenthetical.
 *
 * `card-loader.GRANTED_ONLY_KEYWORDS` strips them, and its own note records that
 * the table was built by scanning the pool once: "four cards match and exactly
 * two are false positives." **That scan was run before Vendetta landed, and
 * nothing re-ran it when 178 cards arrived.** Two of them were wrong, and it took
 * a playtest report to find out — "Zed, Without a Sound is somehow beating my
 * 3-Might Poro defending alone instead of trading", which is a 5-Might body
 * swinging at 9.
 *
 * So the scan is a GATE now rather than a memory. It runs over the whole pool and
 * fails on anything new, which is the only version of this that survives the next
 * set.
 *
 * # What it flags, and the two benign families
 *
 * A keyword is suspicious when EVERY mention of it in the card's own text sits
 * inside parentheses — i.e. inside reminder text, which by definition describes
 * how something works rather than asserting the card has it. Two families are
 * legitimately in that shape and are allowlisted BY REASON rather than by defId
 * where possible.
 */

const defs = loadCardDefinitions();

/** Every keyword mention that sits inside parentheses. */
function mentionsAreAllParenthetical(text: string, keyword: string): boolean {
  const all = [...text.matchAll(new RegExp("\\[" + keyword + "[^\\]]*\\]", "g"))];
  if (all.length === 0) return false;
  return all.every((m) => {
    const before = text.slice(0, m.index ?? 0);
    return (before.match(/\(/g) ?? []).length > (before.match(/\)/g) ?? []).length;
  });
}

/**
 * `[Equip]` on a UNIT, which every `[Weaponmaster]` card parses.
 *
 * `[Weaponmaster]`'s reminder is "(When you play me, you may **[Equip]** one of
 * your Equipment to me...)" — so the bracket is real, and it describes the
 * KEYWORD's own rule rather than a property of the unit.
 *
 * **Measured INERT** rather than assumed: nothing reads `keywords.Equip` off a
 * unit. `equipment.ts` takes an Equipment's attach cost from the card data, and
 * the unit side of the transaction never asks. Left in the data with this note
 * rather than stripped, because a strip nothing can observe is a change no test
 * can prove — and the table above exists to fix keywords that ACT.
 */
const EQUIP_FROM_WEAPONMASTER_REMINDER = "Equip";

/**
 * `[Quick]`, which three OGN/OGS cards and three later ones carry without
 * printing it at all.
 *
 * Not a parse at all: `QUICK_TEXT_OVERRIDES` in the loader ADDS it deliberately,
 * because those cards print "I enter ready" as prose and that is mechanically
 * identical. A deliberate addition is the opposite of a mis-parse, which is why
 * this family is excluded by name rather than argued about.
 */
const DELIBERATE_ADDITION = "Quick";

describe("no card carries a keyword that belongs to something else", () => {
  it("every parenthetical-only keyword is stripped, deliberate, or measured inert", () => {
    const suspects: string[] = [];

    for (const def of defs) {
      if (!("keywords" in def) || def.keywords === undefined) continue;
      const text = "text" in def && typeof def.text === "string" ? def.text : "";
      for (const keyword of Object.keys(def.keywords)) {
        if (keyword === DELIBERATE_ADDITION) continue;
        if (keyword === EQUIP_FROM_WEAPONMASTER_REMINDER) continue;
        if (!mentionsAreAllParenthetical(text, keyword)) continue;
        suspects.push(`${def.id} ${def.name} [${keyword}]`);
      }
    }

    // **Exactly empty.** Not a ceiling — a keyword in this shape either belongs
    // to the card (in which case it is printed outside a parenthetical somewhere)
    // or does not (in which case the loader must strip it). A new entry here is a
    // card swinging with something it does not have, which is what this file was
    // written after.
    expect(suspects, "a card parses a keyword whose every mention is reminder text").toEqual([]);
  });

  it("...and the scan can still SEE one — the control", () => {
    // The load-bearing negative. A scan that matched nothing would pass the
    // assertion above forever, including on the two Zeds it was written for.
    // This feeds it the exact text that caused the bug.
    const zedsClone =
      'When I conquer, play a 0 Might Shadow Clone unit token to your base. ' +
      '(It has "When I attack, you may banish a unit from your trash. If you do, give me [Assault 4] this turn.")';

    expect(mentionsAreAllParenthetical(zedsClone, "Assault"), "the scan cannot see the bug it exists for").toBe(true);
    // ...and a card that really prints one is NOT flagged.
    expect(mentionsAreAllParenthetical("[Assault 2] (+2 Might while I'm an attacker.)", "Assault")).toBe(false);
  });

  it("both Zeds are stripped, which is what playtesting reported", () => {
    // Pinned by name as well as by the scan: the scan proves the class is closed,
    // this proves the two cards that were wrong are right. A 5-Might Zed swinging
    // at 9 is the report, and the Shadow Clone is who the [Assault 4] belongs to.
    for (const id of ["VEN-023", "VEN-112"]) {
      const zed = defs.find((d) => d.id === id)!;
      expect("keywords" in zed && zed.keywords, `${id} still carries the token's keyword`).toEqual({});
    }
  });
});
