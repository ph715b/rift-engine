import { describe, expect, it } from "vitest";
import { EFFECT_SOURCES, domainMightModifierSources } from "../src/engine/effects/index.js";
import { effectiveMight, effectiveMightDefIds } from "../src/engine/effective-might.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { makeState, realUnitInstance } from "./fixtures.js";

/**
 * A domain file can contribute a CONTINUOUS Might modifier.
 *
 * `effective-might.ts` had no registry a domain file could reach: every
 * conditional or scaling Might card had to be hand-added to `continuousAuraBonus`
 * AND to `effectiveMightDefIds()`, in a shared file the card fan-out rule
 * deliberately keeps parallel agents out of. So the cards were refused — UNL-004
 * in wave 1, UNL-094 and UNL-098 in wave 2, by two agents who reached the same
 * conclusion independently.
 *
 * # The workaround they refused, and why refusing was right
 *
 * A one-shot pump at play time is wrong in BOTH directions. 824.1.b.1 makes
 * `[Level N]` "functionally short for 'While you have [N] or more XP, this card
 * gains [Text]'", and 824.1.d makes the ability Inactive again "as soon as the
 * controlling player has less than [N] XP". A latched bonus is wrong below the
 * threshold and wrong after the XP is spent — so the tests below assert BOTH
 * edges, not just that the bonus can appear.
 *
 * # Proved on real cards, unlike the activated-ability seam
 *
 * That seam shipped proved only on a synthetic defId, and the first wave to use it
 * had to discover for itself whether it worked. This one carries two real cards
 * from the day it lands.
 */

const registry = defaultCardRegistry();
const GEMHAND_HUNTER = "UNL-094"; // [Level 6] → +1, printed Might 2
const TARGONIAN_VISIONARY = "UNL-098"; // [Level 11] → +4, printed Might 6

/** The unit in its owner's base, with `xp` on the owner. Base rather than a
 *  battlefield because these bonuses print no location and must not depend on
 *  one — a positional aura would read `ctx.battlefieldId`. */
function withXp(defId: string, xp: number) {
  const state = makeState({ phase: "Action" });
  const unit = realUnitInstance(defId);
  state.players[0]!.baseUnits = [unit];
  state.players[0]!.xp = xp;
  return { state, unit };
}

const mightAt = (defId: string, xp: number) => {
  const { state, unit } = withXp(defId, xp);
  return effectiveMight(state, unit, 0, { isCombat: false });
};

describe("a [Level N] Might bonus is continuous, not latched", () => {
  it("Gemhand Hunter is 2 below the threshold and 3 at it", () => {
    expect(mightAt(GEMHAND_HUNTER, 5), "the bonus applied below 6 XP").toBe(2);
    expect(mightAt(GEMHAND_HUNTER, 6), "the bonus did not apply at exactly 6 XP").toBe(3);
  });

  it("and goes BACK to 2 when the XP is spent — 824.1.d, the half a one-shot pump gets wrong", () => {
    // The assertion that makes this a seam rather than an on-play trigger. A
    // latched bonus passes the test above and fails this one.
    const { state, unit } = withXp(GEMHAND_HUNTER, 6);
    expect(effectiveMight(state, unit, 0, { isCombat: false })).toBe(3);

    const spent = { ...state, players: [{ ...state.players[0]!, xp: 2 }, state.players[1]!] } as typeof state;
    expect(effectiveMight(spent, unit, 0, { isCombat: false }), "the bonus survived the XP being spent").toBe(2);
  });

  it("the threshold is >=, not > — 824.1.b.1's 'N or more'", () => {
    // The off-by-one that would be invisible in play and is the likeliest way to
    // write this wrong.
    expect(mightAt(TARGONIAN_VISIONARY, 10)).toBe(6);
    expect(mightAt(TARGONIAN_VISIONARY, 11)).toBe(10);
  });

  it("reads the OWNER's XP, not the asking player's", () => {
    // `effectiveMight` is called by both sides. "While YOU have 6+ XP" is the
    // controller's counter, so an opponent sitting on XP must not inflate it.
    const { state, unit } = withXp(GEMHAND_HUNTER, 0);
    state.players[1]!.xp = 20;
    expect(effectiveMight(state, unit, 0, { isCombat: false }), "the OPPONENT's XP paid the bonus").toBe(2);
  });

  it("does not leak onto a different unit", () => {
    // The seam asks EVERY registered modifier about every unit, so a modifier that
    // forgot its `unit.defId` test would buff the whole board. That is the failure
    // this shape makes easy, hence the control.
    const { state } = withXp(GEMHAND_HUNTER, 20);
    const bystander = realUnitInstance("OGN-002");
    state.players[0]!.baseUnits.push(bystander);
    // Against the INSTANCE's printed Might: a `CardDefinition` has no `might`
    // field (it lives under `attributes`), and reading the instance is what the
    // engine itself does.
    expect(effectiveMight(state, bystander, 0, { isCombat: false })).toBe(bystander.might);
  });
});

describe("the seam is wired to everything that reads it", () => {
  it("reports its cards to COVERAGE, so a registered card is never counted inert", () => {
    // `effectiveMightDefIds` is what stops `coverage.ts` reporting these as
    // unwritten. A seam wired to the math but not to this would make a working
    // card look unimplemented — and `deck-generator` filters on that, so it would
    // also keep it out of every generated deck.
    expect(effectiveMightDefIds()).toContain(GEMHAND_HUNTER);
    expect(effectiveMightDefIds()).toContain(TARGONIAN_VISIONARY);
    expect(isCardImplemented(registry.get(GEMHAND_HUNTER))).toBe(true);
    expect(isCardImplemented(registry.get(TARGONIAN_VISIONARY))).toBe(true);
  });

  it("offers one registry slot per domain file, with none forgotten", () => {
    // Derived from EFFECT_SOURCES rather than the number 7, so a new domain file
    // cannot be left without a Might registry.
    expect(domainMightModifierSources()).toHaveLength(EFFECT_SOURCES.length);
    for (const source of EFFECT_SOURCES) {
      expect(source.module.mightModifiers, `${source.domain ?? "signature"} has no mightModifiers export`).toBeDefined();
    }
  });
});
