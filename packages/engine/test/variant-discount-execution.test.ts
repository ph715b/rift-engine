import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * **A choice-keyed discount has to reach the EXECUTOR, not just the enumerator
 * and the validator.**
 *
 * `variantCostDiscount` was added for Atakhan (UNL-170) and Undying Loyalty
 * (UNL-168) and wired into `legal-actions` and `validate-play-card` — the two
 * sites this repo's enumerate/execute rule names. There is a THIRD:
 * `execute-play-card` re-prices the card from the raw cost to decide how much
 * FLOATING Energy to burn, and it applied only `targetChoiceDiscount`.
 *
 * So a discounted play was offered at the right price, validated at the right
 * price, and then charged banked Energy it no longer owed. Found by a wave-7
 * agent reading the third site, not by any test — both cards' own suites measure
 * the enumerated payment's rune counts and the validator's verdict, and neither
 * of those moves when the executor is wrong.
 *
 * `docs/rules-conformance.md` already records this exact shape against
 * Irelia - Graceful: "a discount applied only in the validator burns floating
 * resources the play no longer owes". `variantCostDiscount` reached two sites of
 * three and reproduced it.
 *
 * # Measured as a DIFFERENCE, because of 164.2
 *
 * Recycling a READY rune to pay Power credits 1 floating Energy back. That credit
 * is real and correct, and it makes an absolute float figure a poor assertion —
 * the first draft of this file got its own controls wrong by exactly that much.
 *
 * So each case compares the discounted variant against the undiscounted one **on
 * the same board**, with both arms paying the SAME Power, which makes the credit
 * identical on both sides and cancels. What is left is the Energy discount, which
 * is the thing under test.
 */

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

const LOYALTY = "UNL-168";
const ATAKHAN = "UNL-170";

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

/** Plays `action` and reports the caster's floating Energy afterwards. */
function floatAfter(state: GameState, action: PlayCardAction): number {
  const { state: after, result } = submit(state, action);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return after.players[0]!.floatingEnergy;
}

describe("Undying Loyalty's -[2] reaches the float math", () => {
  /** 2 Energy + 1 rainbow printed, and a trash unit whose tags decide the
   *  discount. Both arms pay the same single Power pip. */
  function board(tags: string[]): { state: GameState; spellId: string } {
    const spell = spellInstance(LOYALTY);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.hand = [spell];
    state.players[0]!.trash = [makeUnit({ instanceId: "meal", name: "Meal", tags, energyCost: 1, powerCost: 0 })];
    state.players[0]!.floatingEnergy = 2;
    state.players[0]!.channeled = [rune("o0", "Order")];
    return { state, spellId: spell.instanceId };
  }

  const playFor = (tags: string[]) => {
    const { state, spellId } = board(tags);
    const action = playsOf(state, spellId).find((a) => a.trashCardInstanceId === "meal")!;
    expect(action, "the trash unit was not offered as a target").toBeDefined();
    return { state, action };
  };

  it("keeps 2 more banked Energy when the choice earns the discount", () => {
    const discounted = playFor(["Poro"]);
    const printed = playFor(["Demacia"]);

    expect(discounted.action.payment.energyRunes, "the enumerator did not price the discount").toHaveLength(0);
    const saved = floatAfter(discounted.state, discounted.action) - floatAfter(printed.state, printed.action);
    expect(saved, "the -[2] discount did not reach the executor's float math").toBe(2);
  });

  it("the undiscounted play still spends its printed Energy", () => {
    // The positive control on the instrument: if the executor stopped charging
    // Energy at all, the difference above would also be right.
    const printed = playFor(["Demacia"]);
    const before = printed.state.players[0]!.floatingEnergy;

    expect(floatAfter(printed.state, printed.action), "an undiscounted play stopped charging Energy").toBeLessThan(
      before,
    );
  });
});

describe("Atakhan's sacrifice discount, the same way", () => {
  /**
   * 10 Energy + 3 Order printed. The sacrifice is Determined Sentry (UNL-111),
   * 1 Energy and ZERO Power — deliberately, so the Power discount is 0 and both
   * arms recycle the same three runes. Only the Energy axis moves.
   */
  function board(): { state: GameState; atakhanId: string; sacrificeId: string } {
    const atakhan = realUnitInstance(ATAKHAN);
    const sentry = realUnitInstance("UNL-111");
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.hand = [atakhan];
    state.players[0]!.baseUnits = [sentry];
    state.players[0]!.floatingEnergy = 10;
    state.players[0]!.channeled = Array.from({ length: 6 }, (_, i) => rune(`o${i}`, "Order"));
    return { state, atakhanId: atakhan.instanceId, sacrificeId: sentry.instanceId };
  }

  it("keeps 1 more banked Energy when a 1-Energy unit is sacrificed", () => {
    const a = board();
    const b = board();
    const paid = playsOf(a.state, a.atakhanId).find((x) => x.additionalCostUnitInstanceId === a.sacrificeId)!;
    const declined = playsOf(b.state, b.atakhanId).find((x) => x.additionalCostUnitInstanceId === undefined)!;

    const saved = floatAfter(a.state, paid) - floatAfter(b.state, declined);
    expect(saved, "the sacrifice discount did not reach the executor's float math").toBe(1);
  });

  it("the declined variant still spends its printed Energy", () => {
    const b = board();
    const declined = playsOf(b.state, b.atakhanId).find((x) => x.additionalCostUnitInstanceId === undefined)!;

    expect(floatAfter(b.state, declined), "declining stopped charging the printed 10 Energy").toBeLessThan(10);
  });
});
