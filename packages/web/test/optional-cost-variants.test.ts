import { describe, expect, it } from "vitest";
import { createCardInstance, defaultCardRegistry } from "@rift-engine/engine";
import type { PlayCardAction } from "@rift-engine/engine";
import {
  OPTIONAL_COST_FLAGS,
  matchesPendingCostFilter,
  sameOptionalCosts,
  type PendingOptionalCosts,
} from "../src/pending-match.js";

/**
 * A play's optional-cost variants differ ONLY by which additional costs are paid.
 *
 * **Reported from playtesting**: Ezreal - Prodigy's discount "doing nothing" when
 * casting a `[Repeat]` spell. The engine priced it correctly; the BOARD had no
 * concept of `[Repeat]` at all. `acceleratePaid` was the only one of the four
 * flags `matchesPending` compared, so a repeat-paid candidate and a plain one
 * looked identical and `.find` took whichever came first — always the plain,
 * undiscounted play. **A human could not pay a `[Repeat]` in the UI, free or
 * otherwise.**
 *
 * The seventh dropped-field incident in this project and the same shape every
 * time: a field that exists on the action, is enumerated, and is validated, but
 * gets lost on one hop. The difference here is that the fix is a LIST, so the
 * next optional cost the game prints is covered without anyone remembering.
 */

const registry = defaultCardRegistry();
/** Desert's Call — a real Spell that prints `[Repeat]`, so the shapes below are
 *  not invented ones. */
const DESERTS_CALL = "OGN-207";

function action(flags: Partial<PlayCardAction>): PlayCardAction {
  return {
    type: "PlayCard",
    playerIndex: 0,
    card: createCardInstance(registry.get(DESERTS_CALL)),
    payment: { energyRunes: [], powerRunes: [] },
    ...flags,
  } as PlayCardAction;
}

describe("every optional-cost flag is compared, not just [Accelerate]", () => {
  it("covers all four flags — the list is what stops the next one being forgotten", () => {
    expect(OPTIONAL_COST_FLAGS.map((f) => f.key).sort()).toEqual([
      "acceleratePaid",
      "grantedRepeatPaid",
      "optionalPowerPaid",
      "repeatPaid",
    ]);
  });

  it.each(OPTIONAL_COST_FLAGS.map((f) => f.key))("tells a %s variant from a plain one", (key) => {
    // The regression, one flag at a time. Before the fix this passed for
    // `acceleratePaid` alone and failed for the other three — which is exactly
    // why it is a loop over the list rather than four hand-written cases.
    const paid = action({ [key]: true });
    const plain = action({});

    expect(sameOptionalCosts(paid, { [key]: true } as PendingOptionalCosts)).toBe(true);
    expect(sameOptionalCosts(plain, { [key]: true } as PendingOptionalCosts)).toBe(false);
    expect(sameOptionalCosts(paid, {})).toBe(false);
  });

  it("distinguishes a printed [Repeat] from a granted one, and from both", () => {
    // 820.1.c.2 makes these two separate instances paid separately, so a card under a
    // Temporal Portal has three live variants beyond the plain play. Folding
    // them into one flag would make two of the three unreachable.
    const printed = action({ repeatPaid: true });
    const granted = action({ grantedRepeatPaid: true });
    const both = action({ repeatPaid: true, grantedRepeatPaid: true });

    expect(sameOptionalCosts(printed, { repeatPaid: true })).toBe(true);
    expect(sameOptionalCosts(granted, { repeatPaid: true })).toBe(false);
    expect(sameOptionalCosts(both, { repeatPaid: true })).toBe(false);
    expect(sameOptionalCosts(both, { repeatPaid: true, grantedRepeatPaid: true })).toBe(true);
  });

  it("matches the discount AXIS exactly, because the validator refuses a wrong one", () => {
    // Ezreal - Prodigy and Irelia - Graceful share `targetDiscountAxis`, and a
    // play claiming an axis that buys nothing is REFUSED. So an unmatched axis
    // is not a cosmetic difference — it is an action the board would offer and
    // `submit` would reject, which is this repo's most-repeated bug shape.
    const energy = action({ repeatPaid: true, targetDiscountAxis: "energy" });
    const power = action({ repeatPaid: true, targetDiscountAxis: "power" });
    const none = action({ repeatPaid: true });

    expect(sameOptionalCosts(energy, { repeatPaid: true, targetDiscountAxis: "energy" })).toBe(true);
    expect(sameOptionalCosts(power, { repeatPaid: true, targetDiscountAxis: "energy" })).toBe(false);
    expect(sameOptionalCosts(none, { repeatPaid: true, targetDiscountAxis: "energy" })).toBe(false);
    expect(sameOptionalCosts(energy, { repeatPaid: true })).toBe(false);
  });
});

/**
 * The narrowing half, which is a DIFFERENT question and the reason there are two
 * functions.
 *
 * While the player is still choosing, an unset flag must not exclude anything —
 * both variants are live until one is picked. Treating `undefined` as `false`
 * here would silently drop every paid variant the instant a card was armed,
 * which is the same bug wearing the opposite mask.
 */
describe("an unmade choice narrows nothing", () => {
  it("keeps BOTH variants live before the player has chosen", () => {
    const paid = action({ repeatPaid: true });
    const plain = action({});

    expect(matchesPendingCostFilter(paid, {})).toBe(true);
    expect(matchesPendingCostFilter(plain, {})).toBe(true);
  });

  it("narrows to one the moment it IS chosen", () => {
    const paid = action({ repeatPaid: true });
    const plain = action({});

    expect(matchesPendingCostFilter(paid, { repeatPaid: true })).toBe(true);
    expect(matchesPendingCostFilter(plain, { repeatPaid: true })).toBe(false);

    // And explicitly declining narrows the other way — `false` is a real answer,
    // not an absent one.
    expect(matchesPendingCostFilter(paid, { repeatPaid: false })).toBe(false);
    expect(matchesPendingCostFilter(plain, { repeatPaid: false })).toBe(true);
  });

  it("leaves an unset axis alone while narrowing a set one", () => {
    const energy = action({ targetDiscountAxis: "energy" });
    expect(matchesPendingCostFilter(energy, {})).toBe(true);
    expect(matchesPendingCostFilter(energy, { targetDiscountAxis: "energy" })).toBe(true);
    expect(matchesPendingCostFilter(energy, { targetDiscountAxis: "power" })).toBe(false);
  });
});
