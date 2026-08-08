import { describe, expect, it } from "vitest";
import {
  createCardInstance,
  defaultCardRegistry,
  targetingChoosesUnit,
  targetingChoosesPermanent,
  permanentChoiceIsOptional,
  targetingForAnyCard,
  type CardInstance,
  type TargetingSpec,
} from "@rift-engine/engine";
import { matchesPendingEquipment } from "../src/pending-match.js";
import type { PlayCardAction } from "@rift-engine/engine";

/**
 * Relentless Pursuit (SFD-184) armed, took a destination, and then did nothing.
 *
 * Reported from playtesting: *"I choose a destination to move a unit then
 * nothing happens."*
 *
 * # The cause, and why it is the same bug as Charm's
 *
 * `GameBoard.pendingStep` decided whether a card needs a unit click with a
 * HAND-WRITTEN union — `kind === "unit" || "unitSlots" || "chainSpellAndUnit"` —
 * which is a partial copy of the engine's `TargetingSpec` union living in this
 * workspace. `unitAndEquipment` was added to the engine for this card and nothing
 * told the UI, so the unit step never came up, targeting looked complete with the
 * field empty, and the final match then failed against EVERY candidate, because
 * every candidate the enumerator emits for this card names a unit.
 *
 * Charm was the same shape ("I can select a unit I want to move but cannot choose
 * where to move it") and was fixed by extracting `cardMovesTarget` into a tested
 * predicate. These predicates are that, for the other axis — and they are
 * EXHAUSTIVE over the union with no `default`, so the next kind added breaks
 * compilation rather than silently answering "no unit needed".
 *
 * # What is deliberately NOT covered
 *
 * `unitOrGear` (Fading Memories) and `{kind:"gear"}` (Detonate) also fill
 * `targetPermanentInstanceId`, and the UI still takes whichever candidate comes
 * first for them — an arbitrary pick, but a working one. The last block below
 * pins that they are untouched, because comparing the field unconditionally
 * would have inflicted this very bug on two more cards.
 */

const registry = defaultCardRegistry();
const card = (defId: string): CardInstance => createCardInstance(registry.get(defId));
const spec = (defId: string): TargetingSpec => targetingForAnyCard(card(defId));

const RELENTLESS_PURSUIT = "SFD-184";
const CHARM = "OGN-043"; // plain `unit`
const FALLING_STAR = "OGN-029"; // `unitList`
const DETONATE = "SFD-005"; // `gear` — the pool's gear-only spec
const FADING_MEMORIES = "OGN-180"; // `unitOrGear`

describe("the engine says which specs need which click", () => {
  it("Relentless Pursuit needs a UNIT click — the regression", () => {
    // The single assertion that would have caught the playtest report.
    expect(spec(RELENTLESS_PURSUIT).kind).toBe("unitAndEquipment");
    expect(targetingChoosesUnit(spec(RELENTLESS_PURSUIT))).toBe(true);
  });

  it("and a GEAR click, in a different field", () => {
    expect(targetingChoosesPermanent(spec(RELENTLESS_PURSUIT))).toBe(true);
  });

  it("whose gear half is declinable — the card says 'you MAY attach'", () => {
    expect(permanentChoiceIsOptional(spec(RELENTLESS_PURSUIT))).toBe(true);
  });

  it("still says yes to the kinds that always did", () => {
    // The control the hand-written union got right; a predicate that answered
    // false here would break every targeted spell in the pool.
    expect(targetingChoosesUnit(spec(CHARM))).toBe(true);
    expect(targetingChoosesUnit(spec(FALLING_STAR))).toBe(true);
  });

  it("and no to the kinds that choose no unit", () => {
    expect(targetingChoosesUnit({ kind: "none" })).toBe(false);
    expect(targetingChoosesUnit({ kind: "battlefield" })).toBe(false);
    expect(targetingChoosesUnit({ kind: "gear" })).toBe(false);
    expect(targetingChoosesUnit({ kind: "chainSpell" })).toBe(false);
  });

  it("separates the two axes — a gear-only spec needs no unit click", () => {
    // The reason these are two predicates and not one: `unitAndEquipment` is the
    // only kind that answers TRUE to both, and folding them would make a gear
    // spec ask for a unit.
    expect(targetingChoosesUnit({ kind: "gear" })).toBe(false);
    expect(targetingChoosesPermanent({ kind: "gear" })).toBe(true);
    expect(targetingChoosesUnit(spec(CHARM))).toBe(true);
    expect(targetingChoosesPermanent(spec(CHARM))).toBe(false);
  });
});

describe("a declined attach is not the same as an unmade choice", () => {
  const attach = { targetPermanentInstanceId: "sword" } as PlayCardAction;
  const decline = {} as PlayCardAction;

  it("matches everything while the step is still open", () => {
    // Before the player answers, both variants must stay live or the step has
    // nothing to offer.
    expect(matchesPendingEquipment(attach, {})).toBe(true);
    expect(matchesPendingEquipment(decline, {})).toBe(true);
  });

  it("takes ONLY the declining variant once declined", () => {
    // The bug this flag prevents: without it, a declined attach still matches
    // the attaching candidate and the player silently gets an attach they
    // refused. Same ambiguity `additionalCostResolved` resolves for Meditation.
    const declined = { equipmentChoiceResolved: true };
    expect(matchesPendingEquipment(decline, declined)).toBe(true);
    expect(matchesPendingEquipment(attach, declined)).toBe(false);
  });

  it("takes ONLY the chosen Equipment once chosen", () => {
    const chosen = { equipmentChoiceResolved: true, targetPermanentInstanceId: "sword" };
    expect(matchesPendingEquipment(attach, chosen)).toBe(true);
    expect(matchesPendingEquipment(decline, chosen)).toBe(false);
    expect(matchesPendingEquipment({ targetPermanentInstanceId: "other" } as PlayCardAction, chosen)).toBe(false);
  });
});

describe("the cards that already worked are untouched", () => {
  it("a gear-targeting spell is still matched without the flag", () => {
    // Detonate and Fading Memories fill the same field and have no step.
    // Comparing unconditionally would make every one of their candidates fail to
    // match — the exact silent no-op being fixed, inflicted on two more cards.
    const anyGear = { targetPermanentInstanceId: "some-gear" } as PlayCardAction;
    expect(matchesPendingEquipment(anyGear, {})).toBe(true);
    expect(matchesPendingEquipment(anyGear, { xAmount: 2 })).toBe(true);
  });

  it("their specs still report as choosing a permanent but not a unit", () => {
    expect(targetingChoosesPermanent(spec(DETONATE))).toBe(true);
    expect(targetingChoosesUnit(spec(DETONATE))).toBe(false);
    expect(targetingChoosesPermanent(spec(FADING_MEMORIES))).toBe(true);
  });
});
