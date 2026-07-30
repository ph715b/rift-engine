import { describe, expect, it } from "vitest";
import { EFFECT_SOURCES, mergeRegistries } from "../src/engine/effects/index.js";
import { cardEffectDefIds, effectForCard } from "../src/engine/card-effects.js";
import { unitTriggerDefIds } from "../src/engine/unit-triggers.js";
import { implementableText, isCardImplemented, needsImplementation } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";

const registry = defaultCardRegistry();

/**
 * The per-domain effect files exist so the remaining card pool can be worked on
 * in parallel without two editors touching the same file. That only holds if
 * "which file owns this card" has exactly one answer — so the rule is enforced
 * here rather than written down and hoped for.
 */
describe("effect file ownership is machine-checked, not a convention", () => {
  for (const source of EFFECT_SOURCES) {
    const label = source.domain ?? "signature (dual-domain)";
    const defIds = [...Object.keys(source.module.cardEffects), ...Object.keys(source.module.unitTriggers)];

    it(`every card in ${label} belongs there`, () => {
      for (const defId of defIds) {
        const def = registry.tryGet(defId);
        expect(def, `${defId} is registered in ${label} but is not a real card`).toBeDefined();
        const domains = def!.domains ?? [];
        if (source.domain === null) {
          // signature.ts owns the dual-domain cards precisely because per-domain
          // ownership would be ambiguous for them.
          expect(domains.length, `${defId} (${def!.name}) has ${domains.length} domain(s); signature.ts is for dual-domain cards`).toBe(2);
        } else {
          expect(domains.length, `${defId} (${def!.name}) has ${domains.length} domains; dual-domain cards go in signature.ts`).toBe(1);
          expect(domains[0], `${defId} (${def!.name}) is ${domains[0]}, not ${source.domain}`).toBe(source.domain);
        }
      }
    });
  }

  it("rejects the same card being registered in two files", () => {
    // The realistic parallel-work failure: two owners both claim a card. A silent
    // last-write-wins merge would pick one implementation arbitrarily and the
    // loser would look like it had never been written.
    expect(() =>
      mergeRegistries("card effect", [
        { name: "effects/fury.ts", entries: { "OGN-001": {} as never } },
        { name: "effects/chaos.ts", entries: { "OGN-001": {} as never } },
      ]),
    ).toThrow(/Duplicate card effect for OGN-001.*fury.*chaos/);
  });

  it("merges disjoint files without complaint", () => {
    const merged = mergeRegistries("card effect", [
      { name: "a", entries: { "OGN-001": 1 as never } },
      { name: "b", entries: { "OGN-002": 2 as never } },
    ]);
    expect(Object.keys(merged).sort()).toEqual(["OGN-001", "OGN-002"]);
  });
});

describe("cards registered in a domain file are actually reachable", () => {
  it("Cannon Barrage resolves through the composed registry", () => {
    // Proves the composition wiring end to end: this card lives only in
    // effects/body.ts, so if composition were broken it would read as unregistered
    // exactly like it did before — which is how it stayed unimplemented while
    // card-effects.ts carried a comment explaining why.
    const cannonBarrage = createCardInstance(registry.get("OGN-127"));
    expect(effectForCard(cannonBarrage)).toBeDefined();
    expect(cardEffectDefIds()).toContain("OGN-127");
  });

  it("still exposes the inline registrations alongside them", () => {
    expect(cardEffectDefIds()).toContain("OGS-003"); // Incinerate, inline
    expect(unitTriggerDefIds()).toContain("OGN-087"); // Lecturing Yordle, inline
  });
});

/**
 * The coverage query behind the deck-builder badge. Its whole value is being
 * trustworthy, so the cases that previously produced WRONG audit numbers are
 * pinned here.
 */
describe("coverage: telling implemented cards from silently-inert ones", () => {
  it("treats keyword-only text as needing no implementation", () => {
    // "[Assault] (+1 Might while I'm an attacker.)" is entirely keyword and
    // reminder text. An earlier ad-hoc audit counted cards like this as broken
    // and reported 5 inert precon cards, 3 of which were fine.
    const daringPoro = registry.get("OGN-210"); // [Assault] only
    expect(implementableText(daringPoro)).toBe("");
    expect(needsImplementation(daringPoro)).toBe(false);
    expect(isCardImplemented(daringPoro)).toBe(true);
  });

  it("sees real text alongside a keyword", () => {
    // "[Tank] (...) When you play me, draw 1." — the keyword is stripped, the
    // sentence is not.
    const lecturingYordle = registry.get("OGN-087");
    expect(implementableText(lecturingYordle)).toBe("When you play me, draw 1.");
    expect(needsImplementation(lecturingYordle)).toBe(true);
    expect(isCardImplemented(lecturingYordle)).toBe(true); // now registered
  });

  it("reports a card with real text and no registration as unimplemented", () => {
    // Scrapheap is in the Jinx starter deck and does nothing yet.
    const scrapheap = registry.get("OGN-182");
    expect(needsImplementation(scrapheap)).toBe(true);
    expect(isCardImplemented(scrapheap)).toBe(false);
  });

  it("counts a Legend ability as an implementation", () => {
    expect(isCardImplemented(registry.get("OGS-017"))).toBe(true); // Annie - Dark Child
  });
});
