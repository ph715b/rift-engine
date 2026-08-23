import { describe, expect, it } from "vitest";
import { minimumTargetsFor, singleTargetIsOptional } from "../src/target-optionality.js";

/**
 * **A card whose target is optional must be declinable through the board.**
 *
 * Reported from play against Tideturner (OGN-199), whose on-play trigger reads
 * "you MAY choose a unit you control at another location": *"I am unable to play
 * Tideturner regularly if I control a battlefield. Only options are to pass,
 * cancel the cast or hide."*
 *
 * `GameBoard.pendingMinTargets` returned a flat 1 for every `unit`-kind card, and
 * `canFinishTargeting` compares the chosen count against that minimum — so with
 * nothing chosen the "Choose no targets" button never rendered and the play could
 * not be completed. The engine was correct throughout: it enumerates the
 * no-target variant, which is what "may" means there.
 *
 * **The battlefield in the report is the diagnosis.** Controlling one means a
 * garrison is standing there, which is an eligible swap target, which is what
 * opens the target step at all. With no eligible unit anywhere the step was
 * skipped and the card played fine — so the bug appeared only on the boards where
 * the card is worth casting.
 *
 * **The other half of this lives in the engine**, in
 * `test/tideturner-playable.test.ts`: that the engine really does enumerate an
 * untargeted Tideturner play on the reported board. It is asserted there rather
 * than here because that is where the board fixtures live, and standing up a
 * whole game inside a web test to re-derive one engine fact would be a second
 * harness to keep in step. This file owns the PREDICATE; that one owns the fact
 * the predicate reads.
 *
 * # One mutant SURVIVES this file, knowingly
 *
 * Replacing GameBoard.pendingMinTargets s body with a flat return-1 — the exact
 * bug being fixed — passes everything here, because what is left in the
 * component is a single delegation and nothing in this workspace can reach it.
 * That is not an oversight to be tidied away with a presence assertion:
 * hidden-defender-trigger.test.tsx records that GameBoard takes a MatchConfig
 * and builds its own game, so a board cannot be driven to a mid-play targeting
 * step from a test, and "the two render tests this file first tried were
 * measuring nothing."
 *
 * What the extraction buys is that the delegation is ALL that is left unpinned:
 * the rule, the predicate and the printed-minimum branch are each killed by a
 * mutant here. Closing the last one needs a GameBoard that can be handed a
 * prepared state — worth doing, and much larger than this fix.
 */

describe("the predicate reads what the engine offers", () => {
  it("says OPTIONAL when a no-target variant exists", () => {
    expect(singleTargetIsOptional([{ targetUnitInstanceId: "u1" }, {}]), "a no-target variant was not recognised").toBe(
      true,
    );
  });

  it("says MANDATORY when every variant names a unit", () => {
    expect(
      singleTargetIsOptional([{ targetUnitInstanceId: "u1" }, { targetUnitInstanceId: "u2" }]),
      "a mandatory target was reported optional",
    ).toBe(false);
  });

  it("says MANDATORY for an empty candidate list", () => {
    // Nothing is playable, so there is no decline to offer. Answering true would
    // put a button on a step with no legal action behind it.
    expect(singleTargetIsOptional([]), "an unplayable card offered a decline").toBe(false);
  });
});

describe("the minimum the Done button is compared against", () => {
  const targeted = [{ targetUnitInstanceId: "u1" }];
  const withDecline = [{ targetUnitInstanceId: "u1" }, {}];

  it("requires ONE for a mandatory single target", () => {
    // Riposte's unit is mandatory — 355.8 makes the card uncastable without one.
    expect(minimumTargetsFor({ kind: "unit" }, targeted), "a mandatory target stopped being required").toBe(1);
  });

  it("requires NONE when the engine offers a play with no target", () => {
    // The Tideturner case, and the whole point of this module.
    expect(minimumTargetsFor({ kind: "unit" }, withDecline), "an optional target was still required").toBe(0);
  });

  it("treats chainSpellAndUnit the same way", () => {
    expect(minimumTargetsFor({ kind: "chainSpellAndUnit" }, targeted)).toBe(1);
    expect(minimumTargetsFor({ kind: "chainSpellAndUnit" }, withDecline)).toBe(0);
  });

  it("uses the PRINTED minimum for a list or slots card", () => {
    // These carry their own "up to N" and must not be re-derived from the
    // candidates: an "up to 3" card legitimately offers a one-target variant,
    // and reading that as "minimum 0" would be right by accident here and wrong
    // for a `min: 2` card like Switcheroo.
    expect(minimumTargetsFor({ kind: "unitList", min: 0 }, withDecline)).toBe(0);
    expect(minimumTargetsFor({ kind: "unitSlots", min: 2 }, withDecline), "a min-2 card was let off early").toBe(2);
  });

  it("requires none for a card that chooses no unit at all", () => {
    expect(minimumTargetsFor({ kind: "battlefield" }, [])).toBe(0);
  });
});
