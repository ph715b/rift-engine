import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { validateDeckList } from "../src/decks/deck-validation.js";
import { foldCardName, parseDecklistText } from "../src/decks/decklist-text-parser.js";

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

describe("parseDecklistText: real community-export fixture (now fully resolvable)", () => {
  const registry = defaultCardRegistry();
  const result = parseDecklistText(MASTER_YI_TEXT, registry);

  it("parses (legend resolves) despite champion/several cards being out of scope", () => {
    expect(result).not.toBeNull();
  });

  it("resolves the legend via comma->dash name normalization", () => {
    const legendDef = registry.get(result!.deckList.legendId);
    expect(legendDef.name).toBe("Master Yi - Wuju Bladesman");
  });

  it("resolves the champion — 'Master Yi, Tempered' is UNL-113 now that Unleashed is loaded", () => {
    // This asserted the OPPOSITE until 2026-08-08, and the flip is the fixture
    // doing its job: a real export names cards from sets the engine acquires
    // over time, so its resolution profile is a MEASUREMENT of pool coverage,
    // not a fixed expectation. The property that "an unresolvable champion
    // leaves championId empty" moved to a synthetic name below, where no set can
    // take it away.
    expect(result!.deckList.championId).toBe("UNL-113");
    expect(registry.get(result!.deckList.championId).name).toBe("Master Yi - Tempered");
    expect(result!.unresolvedNames).not.toContain("Master Yi, Tempered");
  });

  it("still leaves championId empty for a champion no set ships", () => {
    // The half the flip above would otherwise have deleted. Synthetic subject on
    // purpose — this is the third time a real name in this file has been
    // resolved out from under a test by a set landing.
    const text = MASTER_YI_TEXT.replace("1 Master Yi, Tempered", "1 Zzyzx, The Unprintable");
    const unresolvable = parseDecklistText(text, registry)!;
    expect(unresolvable.deckList.championId).toBe("");
    expect(unresolvable.unresolvedNames).toContain("Zzyzx, The Unprintable");
  });

  it("resolves EVERY name in the export now that all four sets are loaded", () => {
    // **The fixture has now moved twice, and this is where it lands.** It was
    // 23 resolvable cards on OGN+OGS, 33 when Spiritforged landed on 2026-08-04
    // (Lonely Poro, Punch First, Ruin Runner and Fiora, Peerless), and with
    // Unleashed on 2026-08-08 the last three names resolve too — Scuttle Crab,
    // Rengar, Trophy Hunter, and the Tempered champion.
    //
    // So the fixture's job has changed rather than ended: a verbatim community
    // export, referencing four sets, now round-trips completely. That is a
    // stronger statement than any of its partial-resolution versions, and it is
    // the one thing none of the synthetic fixtures in this file can make.
    //
    // 39 MainDeck copies + the champion's single appended copy.
    expect(result!.deckList.cardIds).toHaveLength(3 * 9 + 2 * 5 + 1 * 2 + 1);
    expect(result!.unresolvedNames, "a real export no longer has gaps to resolve").toEqual([]);
  });

  it("still flags a MainDeck name no set ships, and appends no champion when the champion is one", () => {
    // The flagging half, kept on a synthetic subject. Both properties at once
    // because they interact: an unresolved champion means no appended copy, so
    // the count drops by exactly one.
    const text = MASTER_YI_TEXT.replace("1 Master Yi, Tempered", "1 Zzyzx, The Unprintable").replace(
      "3 Scuttle Crab",
      "3 Qwrtz, Also Unprintable",
    );
    const gappy = parseDecklistText(text, registry)!;
    expect(gappy.unresolvedNames.sort()).toEqual(["Qwrtz, Also Unprintable", "Zzyzx, The Unprintable"]);
    expect(gappy.deckList.championId).toBe("");
    // 39 - 3 dropped copies, and no champion appended.
    expect(gappy.deckList.cardIds).toHaveLength(3 * 9 + 2 * 5 + 1 * 2 - 3);
  });

  it("dedupes a name that fails to resolve in both MainDeck and Sideboard", () => {
    // The property: a name listed in both sections is reported ONCE, not twice.
    //
    // Its subject used to be "Fiora, Peerless" from the fixture above, and SFD
    // resolved it — leaving no name in that export that fails in both sections,
    // so the assertion became vacuously true against an empty array. A control
    // whose subject the pool absorbed proves nothing, and the real export is
    // worth keeping verbatim, so the property gets its own minimal fixture with
    // a name no set can ever ship.
    const text = MASTER_YI_TEXT.replace("3 Rengar, Trophy Hunter", "3 Zzyzx, The Unprintable").replace(
      "1 Fiora, Peerless\n",
      "1 Zzyzx, The Unprintable\n",
    );
    const bothSections = parseDecklistText(text, registry)!;
    expect(bothSections.unresolvedNames.filter((n) => n === "Zzyzx, The Unprintable")).toHaveLength(1);
  });

  it("passes battlefield names through verbatim, no resolution attempted", () => {
    expect(result!.deckList.battlefieldNames).toEqual(["The Arena's Greatest", "Emperor's Dais", "Seat of Power"]);
  });

  it("maps rune counts to the legend's real domains via sortByDomainOrdinal (Calm=A, Body=B)", () => {
    expect(result!.deckList.runeDomainACount).toBe(5); // Calm
    expect(result!.deckList.runeDomainBCount).toBe(7); // Body
  });

  it("fills the sideboard now that its last holdout resolves", () => {
    // Alpha Strike was the one name keeping this sideboard empty — it is UNL-192
    // — so all five names resolve and the all-or-nothing rule now falls the
    // other way. 3 + 2 + 1 + 1 + 1.
    expect(result!.deckList.sideboardCardIds).toHaveLength(8);
    expect(result!.unresolvedNames).not.toContain("Alpha Strike");
  });

  it("empties the WHOLE sideboard when any single name is unresolved (all-or-nothing)", () => {
    // The rule itself, which the fixture can no longer demonstrate on its own.
    // Proved by breaking exactly ONE of the five names: the other four still
    // resolve, so an empty sideboard can only be the all-or-nothing rule and not
    // a sideboard that failed to parse.
    const text = MASTER_YI_TEXT.replace("2 Alpha Strike", "2 Zzyzx, The Unprintable");
    const broken = parseDecklistText(text, registry)!;
    expect(broken.deckList.sideboardCardIds, "one bad name did not empty the sideboard").toEqual([]);
    expect(broken.unresolvedNames).toContain("Zzyzx, The Unprintable");
    expect(broken.unresolvedNames, "the other four names should still resolve").not.toContain("Disarming Rake");
  });
});

describe("parseDecklistText: a resolvable champion appends exactly one copy", () => {
  it("appends exactly one copy when the champion resolves", () => {
    const registry = defaultCardRegistry();
    const text = MASTER_YI_TEXT.replace("1 Master Yi, Tempered", "1 Master Yi, Meditative");
    const result = parseDecklistText(text, registry)!;
    expect(result.deckList.championId).not.toBe("");
    // 39 resolvable main-deck copies (see the fixture's own test above, which
    // rose from 23 to 33 when SFD landed and to 39 when UNL did) plus the
    // champion's single appended copy. Swapping WHICH champion resolves must not
    // change the count — that is the "exactly one copy" this test is named for.
    expect(result.deckList.cardIds).toHaveLength(3 * 9 + 2 * 5 + 1 * 2 + 1);
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

  /**
   * CARD NAMES resolve case-insensitively too, not just section headers.
   *
   * Found by importing a real community Yasuo list: it asked for "Ride the
   * Wind" while the registry prints "Ride The Wind" (OGN-173, capital T). Exact
   * keying dropped a card that exists straight into `unresolvedNames` — and
   * because a miss there is non-fatal by design, the deck imported "cleanly"
   * one card short. That field is meant to say "this name is outside the
   * Origins-only pool"; a casing difference answering that question wrongly
   * makes it a liar rather than a warning.
   */
  describe("card names resolve regardless of casing and spacing", () => {
    const withMain = (line: string) =>
      parseDecklistText(`Legend:\n1 Yasuo, Unforgiven\n\nChampion:\n1 Yasuo, Remorseful\n\nMainDeck:\n${line}\n`, registry);

    it("matches a name whose casing differs from the printed card", () => {
      const result = withMain("1 Ride the Wind"); // registry prints "Ride The Wind"
      expect(result!.unresolvedNames).toEqual([]);
      expect(result!.deckList.cardIds).toContain("OGN-173");
    });

    it("still resolves the exact printed casing", () => {
      // The fix must not have traded one exact match for another.
      expect(withMain("1 Ride The Wind")!.deckList.cardIds).toContain("OGN-173");
    });

    it("folds casing and the comma/dash swap together", () => {
      // Community lists write "Character, Title"; the registry prints
      // "Character - Title". Both variations at once is the realistic case.
      const result = withMain("1 lee sin, centered");
      expect(result!.unresolvedNames).toEqual([]);
      expect(result!.deckList.cardIds.some((id) => registry.get(id).name === "Lee Sin - Centered")).toBe(true);
    });

    it("still reports a name genuinely outside this pool", () => {
      // The guard must not have become "everything resolves" — the field has to
      // keep earning its keep for real out-of-set cards.
      const result = withMain("1 Definitely Not A Riftbound Card");
      expect(result!.unresolvedNames).toEqual(["Definitely Not A Riftbound Card"]);
    });

    it("has no two cards whose names collide once folded", () => {
      // The assumption the fold rests on. If the pool ever gained two cards
      // differing only by case or spacing, folding would silently pick one —
      // and a human pasting a list could not have told them apart either.
      //
      // Asks the PARSER's own `foldCardName`. This test used to carry a
      // hand-written copy of it, and the copy had already drifted: it omitted
      // the curly-quote normalisation, so two cards differing only by a curly
      // versus straight apostrophe would have collided in the parser and passed
      // here. A pool with Kai'Sa, Kog'Maw, Zhonya's Hourglass and Spirit's
      // Refuge in it is not the pool to check that on a copy.
      const seen = new Map<string, string>();
      const collisions: string[] = [];
      for (const def of registry.all()) {
        const key = foldCardName(def.name);
        if (seen.has(key)) collisions.push(`${seen.get(key)} vs ${def.name}`);
        seen.set(key, def.name);
      }
      expect(collisions).toEqual([]);
    });

    it("the fold really does normalise a curly apostrophe", () => {
      // The positive control for the drift above: without it, the sweep is the
      // same check it was before, silently.
      expect(foldCardName("Kai’Sa - Survivor")).toBe(foldCardName("Kai'Sa - Survivor"));
      expect(foldCardName("  Ride  The   Wind ")).toBe("ride the wind");
    });

    it("every card that shares a comma/dash retry key with another IS that other card", () => {
      // **RETIRED AND REPLACED 2026-08-16, because the old assertion was
      // measuring the wrong thing** — and its own comment had predicted the day
      // it would go off: "a later set printing a name with a comma where an
      // existing card has a dash would make one of them unreachable by that
      // spelling." Vendetta did exactly that, ten times.
      //
      // It asserted the retry key was globally unique. That is now false and
      // HARMLESSLY so: `resolve` tries the exact folded name FIRST and only then
      // the swap, and the exact map is injective (the sweep above proves it), so
      // every card is still reachable by its own printed name. Nothing is
      // shadowed; the retry simply has a second card it could have reached.
      //
      // What actually matters is that a shared retry key means the two really are
      // the SAME CARD, so whichever one the fallback lands on plays identically.
      // Vendetta reprints ten earlier cards under its new comma convention —
      // `Vi - Destructive` (OGN-036) reprinted as `Vi, Destructive` (VEN-167) —
      // and a genuine clash between two DIFFERENT cards is the thing worth
      // failing on. That is what this now checks, and it cannot go vacuous: the
      // groups are asserted non-empty first.
      const groups = new Map<string, typeof registry.all>();
      const byKey = new Map<string, ReturnType<typeof registry.all>>();
      for (const def of registry.all()) {
        const key = foldCardName(def.name).replace(", ", " - ");
        byKey.set(key, [...(byKey.get(key) ?? []), def]);
      }
      void groups;
      const shared = [...byKey.values()].filter((defs) => defs.length > 1);
      expect(shared.length, "no card shares a retry key — this sweep is checking nothing").toBeGreaterThan(0);

      const mismatched = shared
        .filter((defs) => {
          const shape = (d: (typeof defs)[number]) =>
            JSON.stringify([
              d.type,
              "energyCost" in d ? d.energyCost : null,
              "powerCost" in d ? d.powerCost : null,
              "might" in d ? d.might : null,
            ]);
          return defs.some((d) => shape(d) !== shape(defs[0]!));
        })
        .map((defs) => defs.map((d) => `${d.id} ${d.name}`).join(" vs "));
      expect(mismatched, "two DIFFERENT cards share a comma/dash retry key — one shadows the other").toEqual([]);
    });
  });
});
