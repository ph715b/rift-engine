import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { optionalXpCostOf, optionalXpEnergyDiscountOf } from "../src/engine/card-effects.js";
import { isCardImplemented, implementingModules, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance } from "./fixtures.js";

/**
 * **UNL-178 Poppy - Defender of the Meek — "You may spend 3 XP as an additional
 * cost to play me. If you do, I cost [3] less."**
 *
 * The pool's second optional XP cost and the first whose payout is a PRICE.
 * UNL-164 Safety Inspector's XP buys an exemption from his own kill, read at
 * resolution, so a flag on the action expressed it and the enumerator could
 * reuse the plain payment unchanged. Poppy's is read at PRICING time and
 * therefore has to reach all three cost sites.
 *
 * # What these tests are built to catch
 *
 * **The discount is what makes her paid variant AFFORDABLE.** 6 Energy printed,
 * 3 with the XP paid — so a caster holding 4 runes can afford only the paid
 * variant, and an enumerator that bails on her printed price first makes exactly
 * the variant the card exists for unreachable. `legal-actions` has recorded
 * making that mistake three times (Brazen Buccaneer's discard, Call to Glory's
 * ignore, and the replaced costs); the unaffordable-plainly test below is the
 * one that would catch a fourth.
 *
 * **The third cost site.** `execute-play-card` re-prices from the raw cost to
 * decide how much FLOATING Energy to burn. A discount applied only in the
 * enumerator and the validator burns three Energy the play no longer owes —
 * docs/rules-conformance.md records that shape against Irelia - Graceful.
 *
 * **Her XP variant must reach a BATTLEFIELD, not just base.** This is where she
 * uncovered a pre-existing gap rather than only needing new code: the XP variant
 * used to be a lone `actions.push({ ...play, optionalXpPaid: true })` and `play`
 * is the base-play candidate, so a Unit's paid variant was offered into base and
 * nowhere else. Safety Inspector has been in that state since he shipped, and
 * nothing noticed because his XP moves no price. Poppy prints `[Ambush]`, whose
 * entire purpose is playing her to a battlefield.
 */

const registry = defaultCardRegistry();

/** Poppy: 6 Energy, 1 Order, 5 Might, [Ambush][Tank]. 3 XP buys [3] off. */
const POPPY = "UNL-178";
const POPPY_PRINTED_ENERGY = 6;
const POPPY_XP = 3;
const POPPY_DISCOUNT = 3;
/** Safety Inspector — the OTHER optional XP cost, whose payout is not a price. */
const SAFETY_INSPECTOR = "UNL-164";

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

const priceOf = (a: PlayCardAction): { energy: number; power: number } => ({
  energy: a.payment.energyRunes.length,
  power: a.payment.powerRunes.length,
});

const paidVariants = (plays: PlayCardAction[]): PlayCardAction[] => plays.filter((a) => a.optionalXpPaid === true);
const plainVariants = (plays: PlayCardAction[]): PlayCardAction[] => plays.filter((a) => a.optionalXpPaid === undefined);

/** Poppy in hand with `xp` banked and `runes` Order runes channeled. Order,
 *  because her Power pip is Order and the discount must not touch it. */
function board(xp: number, runeCount: number): { state: GameState; poppy: UnitInstance } {
  const poppy = realUnitInstance(POPPY);
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.hand = [poppy];
  state.players[0]!.xp = xp;
  state.players[0]!.channeled = Array.from({ length: runeCount }, (_, i) => rune(`o${i}`, "Order"));
  return { state, poppy };
}

describe("the discount is offered, priced, and optional", () => {
  it("offers BOTH prices with the XP banked", () => {
    // "You MAY spend" — the unpaid variant has to survive, and not because it is
    // ever cheaper in runes. XP is a resource a player may want to keep.
    const { state, poppy } = board(POPPY_XP, 12);
    const plays = playsOf(state, poppy.instanceId);

    expect(plainVariants(plays).length, "the printed price stopped being offered").toBeGreaterThan(0);
    expect(priceOf(plainVariants(plays)[0]!), "her printed price moved").toEqual({
      energy: POPPY_PRINTED_ENERGY,
      power: 1,
    });
    expect(paidVariants(plays).length, "the XP variant was never offered").toBeGreaterThan(0);
    expect(priceOf(paidVariants(plays)[0]!), "the discount did not come off the Energy").toEqual({
      energy: POPPY_PRINTED_ENERGY - POPPY_DISCOUNT,
      power: 1,
    });
  });

  it("takes NOTHING off the Power pip — she says [3], which is Energy", () => {
    // The assertion a discount applied to both axes would fail, and which the
    // pair above cannot make on its own.
    const { state, poppy } = board(POPPY_XP, 12);
    expect(priceOf(paidVariants(playsOf(state, poppy.instanceId))[0]!).power, "the discount ate her Order pip").toBe(1);
  });

  it("offers no paid variant without the XP", () => {
    const { state, poppy } = board(POPPY_XP - 1, 12);
    const plays = playsOf(state, poppy.instanceId);

    expect(plainVariants(plays).length, "she became uncastable — fixture is wrong").toBeGreaterThan(0);
    expect(paidVariants(plays), "a caster short of XP was offered the paid variant").toEqual([]);
  });

  it("offers no paid variant without the XP for a card whose XP buys NO discount", () => {
    // **Safety Inspector, and this is the case that actually tests the gate.**
    //
    // Mutation testing showed the Poppy version above cannot: for a DISCOUNT
    // card the affordability check is enforced twice over — once directly, and
    // once because an unaffordable XP leaves `xpDiscountedPayment` null — so
    // deleting either one alone changes nothing. Safety Inspector has no
    // discounted payment to be null, so `canPayOptionalXp`'s own check is the
    // only thing standing between him and a variant the validator would refuse.
    const inspector = realUnitInstance(SAFETY_INSPECTOR);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.hand = [inspector];
    state.players[0]!.xp = POPPY_XP - 1;
    state.players[0]!.channeled = Array.from({ length: 12 }, (_, i) => rune(`o${i}`, "Order"));

    const plays = playsOf(state, inspector.instanceId);
    expect(plainVariants(plays).length, "he became uncastable — fixture is wrong").toBeGreaterThan(0);
    expect(paidVariants(plays), "a caster short of XP was offered his paid variant").toEqual([]);
  });
});

describe("the paid variant is reachable when the printed one is NOT affordable", () => {
  it("is offered at 4 runes, where her printed 6-Energy price is unpayable", () => {
    // **The whole point of pricing it above the affordability bail.** 4 Order
    // runes cannot cover 6 Energy + 1 Power; they can cover 3 + 1. Bailing on the
    // printed price first would drop the card entirely and offer nothing.
    const { state, poppy } = board(POPPY_XP, 4);
    const plays = playsOf(state, poppy.instanceId);

    expect(plainVariants(plays), "her unaffordable printed price was offered anyway").toEqual([]);
    expect(paidVariants(plays).length, "the affordable paid variant was never offered").toBeGreaterThan(0);
    expect(priceOf(paidVariants(plays)[0]!)).toEqual({ energy: POPPY_PRINTED_ENERGY - POPPY_DISCOUNT, power: 1 });
  });
});

describe("the XP variant reaches a BATTLEFIELD, not only base", () => {
  it("offers the paid play to a battlefield where the caster has units", () => {
    // The pre-existing gap this card uncovered. `play` is the base-play
    // candidate, so a lone `actions.push({ ...play, optionalXpPaid })` reached
    // base and nowhere else — and Poppy prints [Ambush] precisely to arrive at a
    // battlefield.
    const { state, poppy } = board(POPPY_XP, 12);
    state.battlefields[0]!.units = { [state.players[0]!.id]: [makeUnit({ instanceId: "friend" })] };
    const plays = playsOf(state, poppy.instanceId);

    const paidAtBattlefield = paidVariants(plays).filter((a) => a.destinationBattlefieldId !== undefined);
    const plainAtBattlefield = plainVariants(plays).filter((a) => a.destinationBattlefieldId !== undefined);

    expect(plainAtBattlefield.length, "no reinforce was offered at all — this asserts nothing").toBeGreaterThan(0);
    expect(paidAtBattlefield.length, "the XP variant was base-only").toBeGreaterThan(0);
    expect(priceOf(paidAtBattlefield[0]!), "the reinforce paid variant lost its discount").toEqual({
      energy: POPPY_PRINTED_ENERGY - POPPY_DISCOUNT,
      power: 1,
    });
  });

  it("fixes the same gap for Safety Inspector, whose XP moves no price", () => {
    // He has been base-only with his XP paid since he shipped, and no assertion
    // about COST could see it because his XP buys a resolution-time exemption.
    // Riding the variant dimension fixes both cards at once, which is the reason
    // to do it there rather than special-casing Poppy.
    const inspector = realUnitInstance(SAFETY_INSPECTOR);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.hand = [inspector];
    state.players[0]!.xp = POPPY_XP;
    state.players[0]!.channeled = Array.from({ length: 12 }, (_, i) => rune(`o${i}`, "Order"));
    state.battlefields[0]!.units = { [state.players[0]!.id]: [makeUnit({ instanceId: "friend" })] };

    const paidAtBattlefield = paidVariants(playsOf(state, inspector.instanceId)).filter(
      (a) => a.destinationBattlefieldId !== undefined,
    );
    expect(paidAtBattlefield.length, "Safety Inspector's XP variant is still base-only").toBeGreaterThan(0);
  });
});

describe("executing the paid variant", () => {
  it("spends the XP and only the discounted runes, and she arrives", () => {
    const { state, poppy } = board(POPPY_XP, 12);
    const play = paidVariants(playsOf(state, poppy.instanceId))[0]!;
    const { state: after, result } = submit(state, play);

    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
    expect(after.players[0]!.xp, "the XP was not spent").toBe(0);
    expect(after.players[0]!.baseUnits.some((u) => u.instanceId === poppy.instanceId), "she never arrived").toBe(true);
  });

  it("does NOT burn floating Energy against her undiscounted price", () => {
    // **The third cost site**, measured as the DIFFERENCE between the two
    // variants rather than as an absolute.
    //
    // An absolute is wrong here and the first version of this test got it wrong
    // in exactly the documented way: **164.2** gives every Basic Rune BOTH
    // abilities — 164.2.a "[Exhaust]: Add [1]" and 164.2.b "Recycle this: Add
    // [Power]" — so a READY rune recycled for the Power pip has already paid
    // Energy on the way, and the engine credits 1 floating Energy back. Six
    // floating minus a 3-Energy play therefore leaves FOUR, not three, and an
    // absolute assertion reads that as a bug in the discount.
    //
    // The difference cancels the credit, because both variants owe the same
    // single Power pip and get the same rebate. It is exactly the discount.
    const { state, poppy } = board(POPPY_XP, 12);
    state.players[0]!.floatingEnergy = POPPY_PRINTED_ENERGY;

    const plays = playsOf(state, poppy.instanceId);
    const paid = paidVariants(plays)[0]!;
    const plain = plainVariants(plays)[0]!;
    expect(priceOf(paid).energy, "floating Energy did not absorb the discounted cost").toBe(0);

    const afterPaid = submit(state, paid);
    const afterPlain = submit(state, plain);
    expect(afterPaid.result, `paid refused: ${JSON.stringify(afterPaid.result)}`).toMatchObject({ type: "Ok" });
    expect(afterPlain.result, `plain refused: ${JSON.stringify(afterPlain.result)}`).toMatchObject({ type: "Ok" });

    const kept = afterPaid.state.players[0]!.floatingEnergy - afterPlain.state.players[0]!.floatingEnergy;
    expect(kept, "the executor burnt floating Energy against the UNDISCOUNTED cost").toBe(POPPY_DISCOUNT);
  });
});

describe("the enumerator and the validator agree", () => {
  it("every enumerated play of Poppy validates", () => {
    const { state, poppy } = board(POPPY_XP, 12);
    state.battlefields[0]!.units = { [state.players[0]!.id]: [makeUnit({ instanceId: "friend" })] };

    const plays = playsOf(state, poppy.instanceId);
    expect(plays.length, "nothing was enumerated, so this asserts nothing").toBeGreaterThan(2);
    for (const play of plays) {
      const verdict = validatePlayCard(state, play);
      expect(verdict.ok, `enumerated but refused: ${JSON.stringify(verdict)}`).toBe(true);
    }
  });

  it("REFUSES a forged discount claimed without the XP", () => {
    // The direction only a forged action reaches: the flag must not buy the
    // discount when the board cannot pay for it.
    const { state, poppy } = board(0, 12);
    const plain = plainVariants(playsOf(state, poppy.instanceId))[0]!;
    const forged: PlayCardAction = { ...plain, optionalXpPaid: true };

    expect(validatePlayCard(state, forged).ok, "a forged XP claim was accepted").toBe(false);
  });

  it("REFUSES a paid action that supplied the UNDISCOUNTED payment", () => {
    // The other direction: claiming the XP does not let a player over-pay in
    // runes and keep the difference floating. The validator prices the paid
    // variant at 3, so a 6-rune payment must not validate.
    const { state, poppy } = board(POPPY_XP, 12);
    const plain = plainVariants(playsOf(state, poppy.instanceId))[0]!;
    const forged: PlayCardAction = { ...plain, optionalXpPaid: true };

    expect(validatePlayCard(state, forged).ok, "the validator did not apply the discount").toBe(false);
  });
});

describe("the table", () => {
  it("keeps Safety Inspector's XP free of a discount", () => {
    // The negative half of the table change: adding `energyDiscount` must not
    // have given the card that was already there one.
    expect(optionalXpCostOf(SAFETY_INSPECTOR), "his XP amount moved").toBe(3);
    expect(optionalXpEnergyDiscountOf(SAFETY_INSPECTOR), "he gained a discount he does not print").toBe(0);
    expect(optionalXpCostOf(POPPY)).toBe(POPPY_XP);
    expect(optionalXpEnergyDiscountOf(POPPY)).toBe(POPPY_DISCOUNT);
  });

  it("reports Poppy implemented, from the source that holds her whole text", () => {
    const def = registry.get(POPPY);
    expect(isCardImplemented(def), "Poppy still reports unfinished").toBe(true);
    expect(partialImplementationNote(def), "she carries a partial note").toBeUndefined();
    expect(implementingModules(POPPY), "the XP cost is not claimed").toContain("optional XP costs");
  });
});
