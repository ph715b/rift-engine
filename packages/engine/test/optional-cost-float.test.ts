import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { makeState, makeUnit, spellInstance } from "./fixtures.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";

/**
 * **A PIN ON A LIVE BUG.** These tests assert the WRONG answer on purpose, so
 * that fixing it fails loudly rather than silently changing behaviour nobody is
 * watching. The row is in `docs/rules-conformance.md`.
 *
 * # What is wrong
 *
 * An OPTIONAL ADDITIONAL COST's Energy is never taken from FLOATING Energy.
 *
 * `validate-play-card` prices the printed base PLUS every optional additional
 * cost through `discountedOptionalCosts` and then `computeEffectiveCost`, so the
 * float reduces the whole bundle and the RUNES only cover what is left. But
 * `execute-play-card` re-derives its own figure from the RAW printed cost, and
 * `modifiedEnergy` there consults `acceleratePaid`, `repeatPaid` and
 * `optionalPowerPaid` nowhere at all. So a caster with banked Energy is charged
 * runes for nothing and float for the base alone: the additional cost is FREE.
 *
 * # Found on 2026-08-14, and it predates every multi-instance `[Repeat]` change
 *
 * Found while asserting Curtain Call's three prices, which read as identical.
 * Measured on a single-instance card untouched by that work — Feral Strength,
 * SFD-034, 2 Energy with `[Repeat] [2]` — so the pin cannot be mistaken for a
 * consequence of it.
 *
 * # Why nothing else catches it
 *
 * Every optional-cost test in this repo measures either the RUNE counts of the
 * enumerated payment or the validator's verdict, and neither moves when the
 * executor's float arithmetic is wrong. That is the third time this exact
 * third-site shape has shipped here — `docs/rules-conformance.md` records it
 * against Irelia - Graceful and against `variantCostDiscount`, both times with
 * the executor as the site that was missed.
 */

const FERAL_STRENGTH = "SFD-034"; // 2 Energy; [Repeat] [2]

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

describe("PINNED WRONG: an optional additional cost is free when paid from float", () => {
  /**
   * The card costs 2 and its `[Repeat]` costs 2 more, so a play that pays the
   * Repeat should take 4 out of a 10-Energy bank. It takes 2.
   */
  it("a [Repeat] paid from banked Energy costs nothing", () => {
    const { state, spellId } = caster(10);
    const plays = playsOf(state, spellId);
    const plain = plays.find((p) => !p.repeatPaid && p.targetUnitInstanceId === "ally0");
    const repeat = plays.find((p) => p.repeatPaid && p.targetUnitInstanceId === "ally0");
    expect(plain, "no plain play was offered — the pin measures nothing").toBeDefined();
    expect(repeat, "no repeat-paying play was offered — the pin measures nothing").toBeDefined();

    expect(spend(state, plain!), "the printed cost came out of the bank").toBe(2);
    // **THE WRONG ANSWER.** It should be 4 — the printed 2 plus the [Repeat]'s 2.
    expect(
      spend(state, repeat!),
      "the [Repeat]'s Energy is being paid now — retire this pin and its rules-conformance row",
    ).toBe(2);
  });

  /**
   * The control that says this is the EXECUTOR and not the price: with no float
   * at all the repeat really is charged its 2 extra Energy, in runes, and the
   * validator agrees. So the two halves of the pipeline disagree only where the
   * float covers the difference.
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
   * The boundary, which is what makes the bug a REACHABLE one rather than an
   * arithmetic curiosity: 2 banked Energy is enough for the base and not for the
   * Repeat, so the runes should cover 2 and cover 0.
   */
  it("partial float pays the base and the runes cover only what is left — which is nothing", () => {
    const { state, spellId } = caster(4);
    state.players[0]!.channeled = Array.from({ length: 6 }, (_, i) => ({
      id: `C${i}`,
      domain: "Calm" as const,
      state: "Ready" as const,
    }));
    const repeat = playsOf(state, spellId).find((p) => p.repeatPaid && p.targetUnitInstanceId === "ally0")!;

    // The validator prices 2 + 2 against 4 banked, so no rune is owed — correct.
    expect(repeat.payment.energyRunes.length).toBe(0);
    // **THE WRONG ANSWER.** The bank should be emptied; only the base comes out.
    expect(spend(state, repeat), "the executor now spends the whole bundle — retire this pin").toBe(2);
  });
});
