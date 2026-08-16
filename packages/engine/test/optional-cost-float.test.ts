import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { ACCELERATE_ENERGY } from "../src/engine/timing.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type UnitInstance } from "../src/model/card.js";
import { makeState, makeUnit, spellInstance } from "./fixtures.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";

/**
 * An OPTIONAL ADDITIONAL COST is paid out of FLOATING resources, exactly as the
 * printed cost is.
 *
 * # This file was a PIN ON A LIVE BUG until 2026-08-16
 *
 * It asserted the WRONG answer on purpose so that fixing the bug would fail
 * loudly. It has now done that job and is INVERTED rather than deleted: the
 * arithmetic it measures is silent in the direction nobody tests, so the
 * assertion is still worth having, pointed the other way.
 *
 * # What was wrong, and why it stayed wrong for four sets
 *
 * `validate-play-card` priced the printed base PLUS every optional additional
 * cost and let the float eat the whole bundle, so the RUNES only covered what
 * was left. `execute-play-card` then re-derived its own figure from the RAW
 * printed cost and consulted `acceleratePaid`, `repeatPaid` and
 * `optionalPowerPaid` nowhere at all — it deducted the float against the BASE
 * ALONE. So the two halves disagreed in the payer's favour whenever the float
 * covered the difference, and a caster with enough banked Energy got every
 * `[Repeat]`, `[Accelerate]` and optional-Power cost FREE.
 *
 * **Nothing else could see it.** Every other optional-cost test in this repo
 * measures either the RUNE counts of the enumerated payment or the validator's
 * verdict, and neither moves when the executor's float arithmetic is wrong —
 * which is why the second test below, the one that was already passing, is kept
 * exactly as it was. It is the control that localises the bug to the executor.
 *
 * That was the THIRD time the missed cost site was `execute-play-card`;
 * `docs/rules-conformance.md` records the same shape against Irelia - Graceful
 * and against `variantCostDiscount`. The fix is not a fourth careful copy — both
 * halves now call `optionalAdditionalCostsFor`, so there is one list of optional
 * costs and no site that can forget a term.
 */

const FERAL_STRENGTH = "SFD-034"; // 2 Energy; [Repeat] [2]
const JINX_DEMOLITIONIST = "OGN-030"; // [Accelerate] 1 Energy + 1 Fury

const registry = defaultCardRegistry();

function caster(floatingEnergy: number): { state: GameState; spellId: string } {
  const spell = spellInstance(FERAL_STRENGTH);
  const state = makeState({ phase: "Action" });
  state.players[0]!.hand = [spell];
  state.players[0]!.floatingEnergy = floatingEnergy;
  state.players[0]!.baseUnits = [makeUnit({ instanceId: "ally0", might: 3 })];
  return { state, spellId: spell.instanceId };
}

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

function spend(state: GameState, action: PlayCardAction): number {
  const { state: after, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return state.players[0]!.floatingEnergy - after.players[0]!.floatingEnergy;
}

describe("an optional additional cost is paid from floating Energy", () => {
  /**
   * The card costs 2 and its `[Repeat]` costs 2 more, so a play that pays the
   * Repeat takes 4 out of a 10-Energy bank. It used to take 2.
   */
  it("a [Repeat] paid from banked Energy costs its full price", () => {
    const { state, spellId } = caster(10);
    const plays = playsOf(state, spellId);
    const plain = plays.find((p) => !p.repeatPaid && p.targetUnitInstanceId === "ally0");
    const repeat = plays.find((p) => p.repeatPaid && p.targetUnitInstanceId === "ally0");
    expect(plain, "no plain play was offered — the assertion measures nothing").toBeDefined();
    expect(repeat, "no repeat-paying play was offered — the assertion measures nothing").toBeDefined();

    expect(spend(state, plain!), "the printed cost came out of the bank").toBe(2);
    expect(spend(state, repeat!), "the printed 2 plus the [Repeat]'s 2").toBe(4);
  });

  /**
   * The control that localises this to the EXECUTOR rather than to the price,
   * and the reason the bug was invisible: with no float at all the repeat was
   * always charged its 2 extra Energy in runes, and the validator always agreed.
   * Unchanged from when this file pinned the bug — it passed then and passes now.
   */
  it("...and with NO float the same play is charged its full price in runes", () => {
    const { state, spellId } = caster(0);
    state.players[0]!.channeled = Array.from({ length: 6 }, (_, i) => ({
      id: `C${i}`,
      domain: "Calm" as const,
      state: "Ready" as const,
    }));
    const plays = playsOf(state, spellId);
    const plain = plays.find((p) => !p.repeatPaid && p.targetUnitInstanceId === "ally0")!;
    const repeat = plays.find((p) => p.repeatPaid && p.targetUnitInstanceId === "ally0")!;

    expect(plain.payment.energyRunes.length).toBe(2);
    expect(repeat.payment.energyRunes.length, "the repeat is priced at 4 when runes must pay it").toBe(4);
    expect(validatePlayCard(state, repeat)).toMatchObject({ ok: true });
  });

  /**
   * The boundary, which is what made the bug REACHABLE rather than an arithmetic
   * curiosity: 4 banked Energy covers base + Repeat exactly, so the validator
   * owes no rune and the whole bank is spent. It used to spend 2 and keep 2.
   */
  it("partial float pays the whole bundle and the runes cover only what is left", () => {
    const { state, spellId } = caster(4);
    state.players[0]!.channeled = Array.from({ length: 6 }, (_, i) => ({
      id: `C${i}`,
      domain: "Calm" as const,
      state: "Ready" as const,
    }));
    const repeat = playsOf(state, spellId).find((p) => p.repeatPaid && p.targetUnitInstanceId === "ally0")!;

    // The validator prices 2 + 2 against 4 banked, so no rune is owed.
    expect(repeat.payment.energyRunes.length).toBe(0);
    expect(spend(state, repeat), "the bank is emptied — base AND additional").toBe(4);
  });

  /**
   * **`[Repeat]` is not the only cost this reached**, and this case is here so
   * the repair cannot be mistaken for a one-keyword patch. The bug was in the
   * term the executor never added, so it reached `[Accelerate]` and every
   * `OPTIONAL_POWER_COSTS` card identically. Jinx - Demolitionist's
   * `[Accelerate]` is 1 Energy + 1 Fury, so paying it costs exactly
   * `ACCELERATE_ENERGY` more out of the bank than declining it.
   *
   * Asserted as a DELTA against the same card's declined play rather than as an
   * absolute, so it measures the additional cost alone and cannot be rewritten by
   * a change to what Jinx costs.
   */
  it("an [Accelerate] paid from banked Energy costs its full price too", () => {
    const jinx = createCardInstance(registry.get(JINX_DEMOLITIONIST)) as UnitInstance;
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [jinx];
    state.players[0]!.floatingEnergy = 10;
    state.players[0]!.floatingPower = { Fury: 3 };

    const plays = playsOf(state, jinx.instanceId);
    const plain = plays.find((p) => !p.acceleratePaid);
    const fast = plays.find((p) => p.acceleratePaid && p.destinationBattlefieldId === plain?.destinationBattlefieldId);
    expect(plain, "no declined play was offered — the assertion measures nothing").toBeDefined();
    expect(fast, "no [Accelerate] play was offered — the assertion measures nothing").toBeDefined();

    expect(spend(state, fast!) - spend(state, plain!), "[Accelerate]'s Energy comes out of the bank").toBe(
      ACCELERATE_ENERGY,
    );
  });
});
