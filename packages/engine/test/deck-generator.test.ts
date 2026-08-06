import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { generateDeckForLegend, generateDecksForSet, championsFor } from "../src/decks/deck-generator.js";
import { validateDeckList } from "../src/decks/deck-validation.js";
import { DECK_SIZE, MAX_COPIES, RUNE_DECK_SIZE } from "../src/decks/deck-list.js";
import { isCardImplemented, needsImplementation } from "../src/engine/coverage.js";

/**
 * The deck generator, which exists because `exercised` is bounded by something
 * neither the engine nor the AI controls: a card no deck contains cannot be
 * played. SFD reached 60 implemented cards with `exercised` reporting 0 of them.
 *
 * **Every deck it produces goes through the REAL `validateDeckList` here**, not
 * a private idea of legality. A generator that can produce an illegal deck is a
 * generator whose output you have to check by hand, and the whole point is to
 * stop doing that.
 */
describe("the deck generator", () => {
  const registry = defaultCardRegistry();
  const SFD_LEGENDS = registry.all().filter((c) => c.type === "Legend" && c.id.startsWith("SFD-"));

  it("finds SFD's Legends at all", () => {
    // Without this every assertion below could pass over an empty list.
    expect(SFD_LEGENDS.length).toBe(12);
  });

  it("builds a deck for EVERY SFD Legend, and the real validator accepts each", () => {
    for (const legend of SFD_LEGENDS) {
      const { deck } = generateDeckForLegend(legend.id, registry);
      const result = validateDeckList(deck, registry);
      expect(result, `${legend.id} ${legend.name}: ${result.ok ? "" : result.error}`).toEqual({ ok: true });
      expect(deck.cardIds).toHaveLength(DECK_SIZE);
      expect(deck.runeDomainACount + deck.runeDomainBCount).toBe(RUNE_DECK_SIZE);
      expect(deck.battlefieldNames).toHaveLength(3);
    }
  });

  it("seats every priority card, at the copies asked for", () => {
    // The property `make-buffdeck.mjs` got wrong: it reported its INPUT as its
    // output while its fill loop had silently dropped cards.
    const legend = SFD_LEGENDS[0]!;
    const wanted = registry
      .all()
      .filter((c) => c.id.startsWith("SFD-") && c.domains.some((d) => legend.domains.includes(d)))
      .filter((c) => needsImplementation(c) && isCardImplemented(c))
      .slice(0, 4)
      .map((c) => c.id);
    expect(wanted.length, "no implemented SFD card is legal for this legend").toBeGreaterThan(0);

    const { deck, seated } = generateDeckForLegend(legend.id, registry, { priority: wanted, copies: 3 });
    for (const id of wanted) {
      expect(seated.get(id), `${id} was not seated`).toBeGreaterThan(0);
      expect(deck.cardIds.filter((c) => c === id).length, `${id} copies`).toBe(seated.get(id));
    }
    expect(validateDeckList(deck, registry)).toEqual({ ok: true });
  });

  it("THROWS naming a priority card that shares no domain with the legend", () => {
    // The failure mode that matters: a silent drop here is how a coverage run
    // reports it reached a card it never contained.
    const legend = SFD_LEGENDS.find((l) => !l.domains.includes("Fury"))!;
    const wrongDomain = registry
      .all()
      .find((c) => c.domains.length === 1 && c.domains[0] === "Fury" && c.type !== "Legend")!;

    expect(() => generateDeckForLegend(legend.id, registry, { priority: [wrongDomain.id] })).toThrow(
      new RegExp(`${wrongDomain.id}.*shares no domain`),
    );
  });

  it("THROWS naming a priority card that does not exist", () => {
    expect(() => generateDeckForLegend(SFD_LEGENDS[0]!.id, registry, { priority: ["ZZZ-999"] })).toThrow(
      /ZZZ-999.*no such card/,
    );
  });

  it("THROWS for a Legend with no eligible champion, rather than returning a deck", () => {
    // Rek'sai really had this: her Legend is cased `Rek'sai` and both her
    // champions `Rek'Sai`, so a literal prefix match found none and NO legal
    // deck existed for her. It is fixed, so this is proved on a synthetic
    // legend instead — the real one can no longer demonstrate it.
    const orphan = { ...SFD_LEGENDS[0]!, id: "ZZZ-500", name: "Nobody - Unled" };
    const fake = {
      ...registry,
      tryGet: (id: string) => (id === "ZZZ-500" ? orphan : registry.tryGet(id)),
      all: () => [...registry.all(), orphan],
    } as typeof registry;

    expect(championsFor(orphan, fake)).toHaveLength(0);
    expect(() => generateDeckForLegend("ZZZ-500", fake)).toThrow(/no eligible champion/);
  });

  it("never exceeds the copy cap, and respects [Unique]'s cap of 1", () => {
    for (const legend of SFD_LEGENDS) {
      const { deck } = generateDeckForLegend(legend.id, registry);
      const counts = new Map<string, number>();
      for (const id of deck.cardIds) counts.set(id, (counts.get(id) ?? 0) + 1);
      for (const [id, n] of counts) {
        const def = registry.get(id);
        const cap = /\[Unique\]/i.test(def.text ?? "") ? 1 : MAX_COPIES;
        expect(n, `${id} ${def.name} in ${legend.name}'s deck`).toBeLessThanOrEqual(cap);
      }
    }
  });

  it("puts real SFD subjects in the decks — the whole reason it exists", () => {
    // The negative control on the generator's usefulness. A deck full of legal
    // OGN filler would validate perfectly and exercise nothing new.
    const { decks, unbuildable } = generateDecksForSet("SFD", registry);
    expect(unbuildable, "a Legend could not be built at all").toEqual([]);
    expect(decks).toHaveLength(12);

    const sfdSubjects = new Set(decks.flatMap((d) => d.subjects).filter((id) => id.startsWith("SFD-")));
    expect(sfdSubjects.size, "the decks reach no implemented SFD card").toBeGreaterThan(20);
  });

  it("is deterministic — the same legend gives the same deck twice", () => {
    // Reproducibility is a stated NFR, and a probe figure measured against a
    // deck that changes run to run is not comparable with anything.
    const first = generateDeckForLegend(SFD_LEGENDS[0]!.id, registry).deck;
    const second = generateDeckForLegend(SFD_LEGENDS[0]!.id, registry).deck;
    expect(first.cardIds).toEqual(second.cardIds);
    expect(first.championId).toBe(second.championId);
  });
});
