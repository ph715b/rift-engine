import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { bareKeywordNotHeld, proseKeywordDefIds } from "../src/cards/card-loader.js";
import { KEYWORDS, type Keyword } from "../src/model/keyword.js";
import { implementableText, needsImplementation } from "../src/engine/coverage.js";

/**
 * A keyword printed WITHOUT its brackets — the one direction the bracket sweep
 * cannot see.
 *
 * `coverage-drift`'s sweep asks whether a bracketed token is a keyword the
 * engine knows. This asks the mirror question: is a keyword's own NAME sitting
 * in a card's text with no brackets around it? There is no bracket there to be
 * unknown, so that sweep passes on it, and every other measurement in the repo
 * passes on it too.
 *
 * It is worth its own file because BOTH halves go wrong at once, in opposite
 * directions:
 *
 *   - `parseKeywords` reads only `[Bracketed]` tokens, so the unit does not HAVE
 *     the keyword. SFD-096 Laurent Bladekeeper could not move battlefield to
 *     battlefield and SFD-138 Windsinger was not hidden — silently, with nothing
 *     to see, which is the most expensive shape of gap this pool can have.
 *   - `implementableText` strips only BRACKETED keywords, so the bare word
 *     survives as residue and the card reports as needing an implementation.
 *     That sends an implementer to write "Ganking" as a card effect, duplicating
 *     a keyword the rules engine already has.
 *
 * The loader brackets the word once, per defId, so everything downstream sees an
 * ordinary card. These tests pin that both halves came out right.
 *
 * **Unleashed added a THIRD case, and it is the one this sweep used to get
 * wrong.** The failure message said "add its defId to PROSE_KEYWORD_DEF_IDS",
 * which brackets the word and therefore GRANTS the keyword — correct for both
 * SFD cards, and wrong for a card whose text merely contains the word. UNL
 * brings two of those (a stray upstream `ambush` on Gemhand Hunter, and the
 * English verb "Repeat" on Sprite Fountain), so the sweep now has two answers
 * and `BARE_KEYWORD_NOT_HELD` is the one it cannot infer from the text.
 */
describe("a keyword printed without its brackets", () => {
  const registry = defaultCardRegistry();

  /** Every card printing a keyword's bare name with no bracketed form anywhere
   *  in its text. Deliberately computed from `KEYWORDS` rather than a fixed
   *  list, so a keyword added later is swept automatically. */
  function proseKeywordCards(): { id: string; name: string; keyword: Keyword }[] {
    const found: { id: string; name: string; keyword: Keyword }[] = [];
    for (const def of registry.all()) {
      const text = "text" in def && typeof def.text === "string" ? def.text : "";
      for (const keyword of KEYWORDS) {
        const bare = new RegExp(`(^|[^\\[\\w])${keyword}\\b`, "i");
        const bracketed = new RegExp(`\\[${keyword}`, "i");
        if (bare.test(text) && !bracketed.test(text)) found.push({ id: def.id, name: def.name, keyword });
      }
    }
    return found;
  }

  it("no card in the pool prints a bare keyword name — the loader has bracketed them", () => {
    // The gate. A new set printing "Ganking (...)" instead of "[Ganking] (...)"
    // fails here, NAMING the card and the keyword, rather than shipping a unit
    // that quietly does not have it.
    const known = new Set(bareKeywordNotHeld().map((e) => `${e.id}:${e.keyword}`));
    const bare = proseKeywordCards()
      .filter((c) => !known.has(`${c.id}:${c.keyword}`))
      .map((c) => `${c.id} (${c.name}) prints a bare "${c.keyword}"`);
    expect(
      bare,
      "a card names a keyword with no brackets. Decide WHICH it is: the data lost the brackets and the card really " +
        "has it (add to PROSE_KEYWORD_DEF_IDS, which brackets it), or the word is prose/noise and it does not " +
        "(add to BARE_KEYWORD_NOT_HELD, which changes nothing but records the decision)",
    ).toEqual([]);
  });

  it("the cards that merely CONTAIN a keyword's name do not get the keyword", () => {
    // The positive control for the second answer, and the half that would go
    // wrong silently: the whole risk of BARE_KEYWORD_NOT_HELD is that it is used
    // to quiet the sweep for a card that really did lose its brackets. So each
    // entry asserts the card DOESN'T carry the keyword — which is only
    // meaningful because `bracketProseKeywords` would have given it one.
    for (const { id, keyword } of bareKeywordNotHeld()) {
      const def = registry.tryGet(id);
      expect(def, `${id} is in BARE_KEYWORD_NOT_HELD but is not a card in the pool`).toBeDefined();
      const keywords = "keywords" in def! ? (def as { keywords: Partial<Record<Keyword, number>> }).keywords : {};
      expect(keywords[keyword], `${id} was granted [${keyword}] — it is supposed to only MENTION the word`).toBeUndefined();
      // And the word really is there, so an entry cannot outlive the data that
      // justified it — the same rule every allow-list in this repo follows.
      expect(def!.text.toLowerCase(), `${id} no longer prints a bare "${keyword}"`).toContain(keyword.toLowerCase());
      expect(def!.text).not.toContain(`[${keyword}]`);
    }
  });

  it("the two known cards really do carry the keyword now", () => {
    // The positive control, and the half that matters in play. Without it the
    // sweep above is an empty-list claim that would pass with the whole
    // mechanism deleted, because deleting it changes the TEXT back too.
    const laurent = registry.get("SFD-096");
    expect(laurent.name).toBe("Laurent Bladekeeper");
    expect(laurent.type).toBe("Unit");
    if (laurent.type !== "Unit") throw new Error("unreachable");
    expect(laurent.keywords.Ganking, "Laurent Bladekeeper cannot move without this").toBe(1);

    const windsinger = registry.get("SFD-138");
    expect(windsinger.name).toBe("Windsinger");
    expect(windsinger.type).toBe("Unit");
    if (windsinger.type !== "Unit") throw new Error("unreachable");
    expect(windsinger.keywords.Hidden, "Windsinger is not hidden without this").toBe(1);
  });

  it("stops the bare word being reported as text that still needs writing", () => {
    // The other half. Laurent's ENTIRE printed text is the keyword and its
    // reminder, so once bracketed there is nothing left to implement — he must
    // report as finished rather than as a card somebody still owes code for.
    const laurent = registry.get("SFD-096");
    expect(implementableText(laurent)).toBe("");
    expect(needsImplementation(laurent)).toBe(false);

    // Windsinger has a real second ability, so he still needs code — but the
    // residue must be that ability alone, with no stray "Hidden" in it.
    const windsinger = registry.get("SFD-138");
    expect(needsImplementation(windsinger)).toBe(true);
    expect(implementableText(windsinger)).toContain("return another unit");
    expect(implementableText(windsinger).toLowerCase()).not.toContain("hidden");
  });

  it("keeps the table explicit — every entry is a card that really needed it", () => {
    // An entry matching nothing is an entry nobody has had to justify, and it
    // would also mean the loader is rewriting text for no reason.
    for (const id of proseKeywordDefIds()) {
      const def = registry.tryGet(id);
      expect(def, `${id} is in PROSE_KEYWORD_DEF_IDS but is not a card in the pool`).toBeDefined();
      expect(def!.text, `${id} has no bracketed keyword, so the rewrite did not apply`).toMatch(/\[/);
    }
  });

  it("does NOT rewrite a card that merely MENTIONS a keyword", () => {
    // The rewrite is per defId precisely so it cannot touch these. Ember Monk
    // says "When you play a card from [Hidden]" — it already carries brackets,
    // and a blanket "bracket every keyword word you see" would have mangled the
    // prose of every card that talks about a keyword without having one.
    //
    // Note what this canNOT assert: Ember Monk's `keywords.Hidden` IS 1, because
    // `parseKeywords` reads the bracket it prints. Not having the keyword is a
    // separate mechanism — `HIDDEN_KEYWORD_FALSE_POSITIVE_DEF_IDS` gates the
    // `hidden` FIELD, which is what play reads. Asserting the keyword map here
    // was the first version of this test and it failed, correctly.
    const emberMonk = registry.get("OGN-167");
    expect(emberMonk.type).toBe("Unit");
    if (emberMonk.type !== "Unit") throw new Error("unreachable");
    expect(emberMonk.hidden, "Ember Monk mentions [Hidden]; it does not have it").toBe(false);
    // The text is untouched: exactly one "[Hidden]", the one it printed.
    expect(emberMonk.text.match(/\[Hidden\]/g)).toHaveLength(1);
    expect(proseKeywordDefIds()).not.toContain("OGN-167");
  });
});
