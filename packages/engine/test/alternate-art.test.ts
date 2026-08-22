import { describe, expect, it } from "vitest";
import { loadAlternateArt, loadCardDefinitions } from "../src/cards/card-loader.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";

/**
 * **Alternate-art printings are real cards the registry deliberately cannot
 * see**, and this is the lookup that lets a player choose one.
 *
 * `shouldSkip` drops every `alternate_art` entry from `loadCardDefinitions`, and
 * that is correct: an alternate art is the SAME card, so a pool holding both
 * would double each of them in deckbuilding, in `coverageBySet`, and in every
 * reachability figure. But "not deckbuildable" is not "not real" — the argument
 * `loadBattlefieldDefinitions` and `loadTokenDefinitions` are both built on.
 *
 * Reported from playtesting: there is no way to pick a card's alternate art.
 *
 * # The join is by ID, and this file is why that was chosen
 *
 * The obvious join is the NAME: every alternate is `"<base> (Alternate Art)"`, so
 * strip and match. That join is a trap here. `printingBaseName`'s own note
 * records that Vendetta prints `Character, Title` where the earlier four sets
 * print `Character - Title`, so a name lookup needs a normalisation step — and
 * getting that step wrong is what left twelve printings with no implementation
 * at all, twice.
 *
 * An alternate's collector number is its base's with a letter appended
 * (`ogn-007a-298` against `ogn-007-298`), so dropping the trailing letter IS the
 * base id, with nothing to normalise. The first test asserts that holds for the
 * WHOLE pool rather than for the examples I happened to look at.
 */

const registry = defaultCardRegistry();

describe("alternate-art printings resolve to the card they are a printing of", () => {
  it("every alternate in the pool finds its base card", () => {
    // The measurement the design rests on. If a set ever prints an alternate
    // whose number is not its base's plus a letter, this is where that shows up —
    // as a card that silently gets no picker, which is otherwise invisible.
    const alternates = loadAlternateArt();
    expect(alternates.size, "no alternate art loaded at all — the scan is measuring nothing").toBeGreaterThan(0);

    const known = new Set(loadCardDefinitions().map((d) => d.id));
    // Runes are the documented exception: they are not CardDefinitions at all
    // (`loadRuneArt` serves them, keyed by domain), so their base ids are not in
    // this set and they are excluded by name rather than silently tolerated.
    const unresolved = [...alternates.entries()].filter(
      ([baseId, prints]) => !known.has(baseId) && !prints.some((p) => /\bRune\b/.test(p.name)),
    );
    expect(unresolved.map(([id, p]) => `${id} (${p[0]!.name})`), "an alternate printing resolved to no card").toEqual([]);
  });

  it("names the SIX runes it cannot serve, rather than quietly dropping them", () => {
    // The honest half. A rune's art comes from `loadRuneArt` keyed by DOMAIN, so
    // nothing in the card-art path can reach it — and saying so here is what
    // stops the next reader treating six missing pickers as a bug.
    const runes = [...loadAlternateArt().entries()].filter(([, prints]) => prints.some((p) => /\bRune\b/.test(p.name)));
    expect(runes.length, "the rune alternates have changed in number — the web note names six").toBe(6);
    for (const [baseId] of runes) {
      expect(registry.tryGet(baseId), "a rune became a real CardDefinition — the exclusion above is now wrong").toBeUndefined();
    }
  });

  it("never returns a printing whose id equals the base — that would be a fake choice", () => {
    // A picker offering "default" and "default" is worse than no picker: it looks
    // like a control and does nothing. The loader drops any entry whose id does
    // not actually shorten.
    for (const [baseId, prints] of loadAlternateArt()) {
      for (const p of prints) {
        expect(p.id, `${baseId} listed itself as its own alternate`).not.toBe(baseId);
        expect(p.imageUrl, `${p.name} has no art, so there is nothing to choose`).toBeTruthy();
      }
    }
  });

  it("every alternate's id ends in a letter — the PRECONDITION the self-guard rests on", () => {
    // **Recorded rather than tidied away.** `loadAlternateArt` guards with
    // `if (baseId === id) continue;`, and mutation-testing shows that guard is
    // UNREACHABLE against today's data: all 99 alternates end in a letter, so
    // `baseId` always shortens and removing the guard changes nothing. Deleting
    // it on the strength of a green run would be deleting the only thing standing
    // between a future set and a picker that offers a card as its own alternate.
    //
    // So the guard stays and this asserts what makes it unnecessary. If a set
    // ever prints an alternate with a base-shaped id, THIS fails — and the
    // failure says the guard has started to matter, which is the useful message.
    for (const prints of loadAlternateArt().values()) {
      for (const p of prints) {
        expect(p.id, `${p.name} has a base-shaped id — the self-guard is now load-bearing`).toMatch(/[a-z]$/);
      }
    }
  });

  it("keeps the alternates OUT of the deckbuildable pool", () => {
    // The property the whole exclusion exists for, asserted here because this is
    // the change that made the alternates loadable at all. A regression that let
    // them into `loadCardDefinitions` would double 99 cards in the builder and
    // move every coverage figure in the repo.
    const ids = new Set(loadCardDefinitions().map((d) => d.id));
    for (const prints of loadAlternateArt().values()) {
      for (const p of prints) {
        expect(ids.has(p.id), `${p.name} leaked into the playable pool`).toBe(false);
      }
    }
  });

  it("is stable across calls — the picker reads it on every render", () => {
    const a = loadAlternateArt();
    const b = loadAlternateArt();
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
  });
});
