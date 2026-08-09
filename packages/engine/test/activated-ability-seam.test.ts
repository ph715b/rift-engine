import { describe, expect, it } from "vitest";
/**
 * **`effects/index.js` MUST be imported before any domain file, and this is not
 * a style preference.** It composes `domainCardEffects` eagerly at module scope,
 * so any module graph that reaches `fury.ts` before `index.ts` has finished sees
 * `s.module.cardEffects === undefined` and dies in `Object.entries` with
 * "Cannot convert undefined or null to object".
 *
 * Measured, not guessed: a two-line file importing only `effects/fury.js` fails
 * this way on `master` with none of this seam's changes present. The fragility is
 * pre-existing and latent — real code always enters through `index.ts`, so
 * nothing has ever tripped it. It is recorded here because a test that imports a
 * domain file directly is exactly the thing that will, and the error names
 * neither the cycle nor the file.
 */
import { EFFECT_SOURCES, domainActivatedAbilities } from "../src/engine/effects/index.js";
import * as fury from "../src/engine/effects/fury.js";
import { activatedAbilityFor, activatedAbilityDefIds, hasActivatableAbility } from "../src/engine/activated-abilities.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";

/**
 * A domain file can register an ACTIVATED ability.
 *
 * `ACTIVATED_ABILITIES` was module-private in `activated-abilities.ts`, so it
 * could not — the only way to give a card a printed "[cost]: do something" was to
 * edit that one shared file. That is exactly the file the fan-out rule keeps
 * parallel agents out of, so the mechanism and the working method were in direct
 * conflict, and the agents did the right thing and refused.
 *
 * # Why this is worth a seam rather than six careful edits
 *
 * Measured 2026-08-08 over the 187 unimplemented UNL cards: **34 of them print an
 * activated ability.** The wave-1 note put the figure at two, which was the count
 * of cards refused in that wave rather than the count in the pool — and both of
 * those two have since been written straight into the shared file, which is how
 * a bottleneck stays invisible. Thirty-four cards funnelling through one file is
 * the thing that cannot be parallelised.
 *
 * # What is asserted, and the ORDER it has to be asserted in
 *
 * The merged table is memoised on first use, so a test that registers into a
 * domain file AFTER something has already asked a question would silently see the
 * old table and pass for the wrong reason. The registration below therefore
 * happens at module scope, before any `it` runs — and the first assertion is that
 * the synthetic entry is actually visible, so if the memo ever beats it, this
 * fails rather than quietly proving nothing.
 */

/** A card that does not exist. Deliberately: a real defId could be implemented
 *  out from under this test by any wave, at which point it would be asserting
 *  that the built-in table works — the thing this seam is NOT about. */
const SYNTHETIC = "ZZZ-999";

(fury.activatedAbilities as Record<string, unknown>)[SYNTHETIC] = {
  kind: "Unit",
  cost: { exhaust: true },
  targeting: { kind: "none" },
  resolve: (state: unknown) => state,
};

describe("a domain file can register an activated ability", () => {
  it("and every reader of the table can see it", () => {
    // Three separate readers, because they used to index the private table
    // independently — routing one and leaving the others is how a seam ends up
    // existing without working. `activatedAbilityDefIds` is what the ENUMERATOR
    // walks, so an ability missing there is unreachable in play no matter what
    // the other two say.
    expect(hasActivatableAbility(SYNTHETIC), "the seam is not wired to `hasActivatableAbility`").toBe(true);
    expect(activatedAbilityFor(SYNTHETIC), "the seam is not wired to `activatedAbilityFor`").toBeDefined();
    expect(activatedAbilityDefIds(), "the seam is not wired to the enumerator's list").toContain(SYNTHETIC);
  });

  it("without hiding the built-in table", () => {
    // The load-bearing negative: a merge that replaced rather than combined would
    // pass every assertion above and silently delete ~90 working abilities.
    const ids = activatedAbilityDefIds();
    expect(ids.length, "the built-in abilities vanished into the merge").toBeGreaterThan(50);
    expect(hasActivatableAbility("UNL-026"), "Xerath - Freed lost his ability").toBe(true);
  });

  it("offers one registry slot per domain file, with none forgotten", () => {
    // Derived from EFFECT_SOURCES rather than the number 7, so adding a domain
    // file cannot leave activated abilities behind — the same reason the
    // ownership test walks EFFECT_SOURCES instead of re-listing it.
    expect(domainActivatedAbilities()).toHaveLength(EFFECT_SOURCES.length);
    for (const source of EFFECT_SOURCES) {
      expect(source.module.activatedAbilities, `${source.domain ?? "signature"} has no activatedAbilities export`).toBeDefined();
    }
  });
});

describe("what the seam is for", () => {
  it("counts the UNL cards that print an activated ability", () => {
    // Not a target and not a gate — a REASON, kept next to the mechanism so the
    // next session does not re-derive it, and so it moves as the set is written.
    // A drop is progress; a rise means the sweep below found more.
    const registry = defaultCardRegistry();
    const printsActivation = registry
      .all()
      .filter((d) => d.id.startsWith("UNL-"))
      .filter((d) => /(:rb_exhaust:|:rb_rune_\w+:|Kill me|Recycle)[^.]{0,40}:\s/.test(d.text ?? ""));
    expect(printsActivation.length, "the sweep found nothing — the pattern has drifted from the card text").toBeGreaterThan(20);
  });
});
