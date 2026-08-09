import { describe, expect, it } from "vitest";
import { EFFECT_SOURCES, mergeRegistries } from "../src/engine/effects/index.js";
import { cardEffectDefIds, effectForCard, cardModeOf } from "../src/engine/card-effects.js";
import { dispatchOnPlayUnit, unitTriggerDefIds } from "../src/engine/unit-triggers.js";
import { coverageBySet, implementableText, isCardImplemented, needsImplementation } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type UnitInstance } from "../src/model/card.js";
import { makeState, makeUnit, playUnitTrigger } from "./fixtures.js";

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
    // `activatedAbilities` is here for the same reason the other two are: it is a
    // per-domain registry, so the ownership rule has to reach it or the newest
    // seam is the one place a Fury card can be filed under Calm. Listing the
    // registries by hand is the known failure mode this repo has hit four times
    // — the guard below counts them, so a fourth registry cannot be forgotten.
    const defIds = [
      ...Object.keys(source.module.cardEffects),
      ...Object.keys(source.module.unitTriggers),
      ...Object.keys(source.module.activatedAbilities),
    ];

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
    expect(cardModeOf(cannonBarrage, undefined)).toBeDefined();
    expect(cardEffectDefIds()).toContain("OGN-127");
  });

  it("still exposes the inline registrations alongside them", () => {
    expect(cardEffectDefIds()).toContain("OGS-003"); // Incinerate, inline
    expect(unitTriggerDefIds()).toContain("OGN-087"); // Lecturing Yordle, inline
  });

  it("FIRES a Unit trigger registered in a domain file, not merely reports it", () => {
    // Being listed in the registry and actually running are two different things,
    // and they came apart: dispatchOnPlayUnit read the inline UNIT_TRIGGERS table
    // directly instead of the composed one, so a Unit registered in a per-domain
    // file passed validation, cost its runes, deployed — and its ability never
    // ran. No test caught it because Pit Rookie was the first Unit any domain file
    // had registered, which is precisely when a parallel per-card pass would have
    // walked into it and blamed their own card.
    const pitRookie = createCardInstance(registry.get("OGN-136")) as UnitInstance;
    const ally = makeUnit({ might: 2 });
    const state = makeState();
    state.players[0]!.baseUnits = [ally, pitRookie];

    const after = playUnitTrigger(state, pitRookie, 0, "base", { targetUnitInstanceId: ally.instanceId });

    expect(after.players[0]!.baseUnits[0]!.buffed).toBe(true);
    expect(after).not.toBe(state); // an unregistered defId returns the state unchanged
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

  it("treats leftover punctuation between two keywords as no text at all", () => {
    // Garen - Rugged is "[Assault 2], [Shield 2] (+2 Might while I'm an attacker
    // or defender.)" — every ability a keyword, all of them working through the
    // keyword machinery. Stripping the brackets and the reminder left a bare ","
    // behind, which counted as text needing implementation and greyed the card
    // out in the deck builder.
    const garenRugged = registry.get("OGS-007");
    expect(implementableText(garenRugged)).toBe("");
    expect(needsImplementation(garenRugged)).toBe(false);
    expect(isCardImplemented(garenRugged)).toBe(true);
  });

  it("still sees text that happens to contain punctuation", () => {
    // The guard asks whether anything alphanumeric survives, so an ability
    // ending in a full stop is not mistaken for a leftover separator.
    const voidSeeker = registry.get("OGN-024"); // "Deal 4 to a unit at a battlefield. Draw 1."
    expect(implementableText(voidSeeker)).toContain("Draw 1.");
    expect(needsImplementation(voidSeeker)).toBe(true);
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
    // **The pool reached zero unimplemented cards**, which is the moment this
    // test's own note said to retire it — it used to pick "whichever card
    // currently fits" and there is no longer one. Retiring it outright would
    // delete the invariant, so the subject is now a SYNTHETIC definition: a real
    // card shape with text that needs implementing and a defId no registry
    // claims. That is exactly the pairing being pinned, and unlike a real card
    // it cannot be implemented out from under the test.
    const invented = {
      ...registry.get("OGN-024"),
      id: "OGN-999",
      name: "Invented Card",
      text: "Deal 4 to a unit at a battlefield. Draw 1.",
    };
    expect(needsImplementation(invented)).toBe(true);
    expect(isCardImplemented(invented), "an unregistered defId reported as implemented").toBe(false);
  });

  it("...and every real card in a FINISHED set is implemented", () => {
    // The other half of what the check above used to assert, stated directly
    // rather than as a side effect of picking a victim. It fails the day a card
    // is added to a finished set without an implementation, which is when it
    // should.
    //
    // Scoped to COMPLETE_SETS rather than the whole pool. Asserting over the
    // pool was correct exactly while the pool was finished, and would have gone
    // red the day a new set's JSON landed and stayed red for weeks — a gate
    // expected to be red reports nothing when it is. A set under construction
    // reports progress in test/set-coverage.test.ts instead.
    //
    // The assertion itself is unchanged: it still NAMES the cards. Only the
    // scope moved.
    const declared = coverageBySet(registry.all()).filter((set) => set.declaredComplete);
    expect(declared.length, "no set is declared complete — this gate is checking nothing").toBeGreaterThan(0);
    for (const set of declared) {
      expect(set.needing, `${set.set} gates 0 cards, which reads exactly like a pass`).toBeGreaterThan(0);
      expect(set.unimplemented, `${set.set} is declared finished in COMPLETE_SETS`).toEqual([]);
    }
  });

  it("counts a Legend ability as an implementation", () => {
    expect(isCardImplemented(registry.get("OGS-017"))).toBe(true); // Annie - Dark Child
  });
});
