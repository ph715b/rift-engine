import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { isCardImplemented, implementingModule } from "../src/engine/coverage.js";
import { optionalXpCostOf } from "../src/engine/card-effects.js";
import { allListeningPermanents, listeningTrashCards } from "../src/engine/triggers.js";
import { trashChoiceDiscount } from "../src/engine/cost-modifiers.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { MoveUnitAction, PlayCardAction, PlayerAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import type { UnitInstance } from "../src/model/card.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * Wave 7's Unleashed Order cards — **three looked at, three REFUSED, no card
 * registered.** Every one of them needs an edit to a file this wave does not own,
 * and in each case the half that COULD be written from `effects/order.ts` alone
 * would be stronger or emptier than the printed card.
 *
 * This file is therefore all pins and one measurement:
 *
 *   - **UNL-163 Mageseeker Investigator** taxes an opponent's MOVE, and a Standard
 *     Move (144.2 — "Exhausting the Unit is the Cost for this action") has no
 *     payment anywhere in this engine. `MoveUnitAction` carries no payment field,
 *     `validateMoveUnit` checks none and `executeMoveUnit` spends none.
 *   - **UNL-178 Poppy - Defender of the Meek** prints an optional XP cost that BUYS
 *     A DISCOUNT. `OPTIONAL_XP_COSTS` expresses the cost; nothing expresses the
 *     discount, and the enumerator's paid variant is literally `{...play, flag}` —
 *     the same runes as the unpaid one. Listing her without the other half would
 *     sell 3 XP for nothing, which is the direction this engine never errs in.
 *   - **UNL-169 Ashe - Focused** was refused in wave 3 and all three of that
 *     refusal's blockers still hold. Her coverage is NOT re-asserted here —
 *     `unl-order-wave3.test.ts` owns that pin, and a second copy is how the
 *     premise-flip class starts over. What IS asserted here is the one blocker
 *     that is a fact about a shared mechanism rather than about her: a card that
 *     has left the board is reachable by no listener walk.
 *
 * A refusal recorded only in prose goes stale silently; each pin below fails the
 * moment the card is implemented, which is what a pin is for.
 *
 * The last block is not about these three cards at all. It is a **live cost bug in
 * `execute-play-card.ts`**, found while writing Poppy's spec and reachable today on
 * UNL-168 Undying Loyalty — and it is the reason Poppy's spec has four sites in it
 * rather than three. It is worth reading for its own sake: the FIRST fixture built
 * for it measured no loss at all, because 164.2's Ready-rune recycling credit
 * exactly cancelled the over-spend. A believable "no bug here" from an instrument
 * that had not been set up to see one.
 */

const registry = defaultCardRegistry();

const MAGESEEKER = "UNL-163";
const ASHE_FOCUSED = "UNL-169";
const POPPY = "UNL-178";
const SAFETY_INSPECTOR = "UNL-164";
const UNDYING_LOYALTY = "UNL-168";

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });
const orderRunes = (count: number): RuneCard[] => Array.from({ length: count }, (_, i) => rune(`ord-${i}`, "Order"));

function accept(state: GameState, action: PlayerAction | undefined, what: string): GameState {
  expect(action, `${what} was never enumerated`).toBeDefined();
  const { state: next, result } = submit(state, action!);
  expect(result, `${what} was refused: ${JSON.stringify(result)}`).toEqual({ type: "Ok" });
  return next;
}

/** Every enumerated way to play one card instance. */
const castsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

const unitsAt = (state: GameState, battlefieldId: string, playerIndex: 0 | 1): UnitInstance[] =>
  state.battlefields.find((bf) => bf.id === battlefieldId)!.units[state.players[playerIndex].id] ?? [];

/**
 * Everything a player could still put toward a rainbow Power debt.
 *
 * Counts CHANNELED runes whatever their state, not just Ready ones: a Power cost
 * is paid by RECYCLING (416), and an already-exhausted rune recycles just as well
 * — which is why an exhausted rune is still something the Mageseeker's tax could
 * have taken. Plus the two floating pools that can cover a rainbow debt.
 */
const payableTowardRainbow = (state: GameState, playerIndex: 0 | 1): number => {
  const p = state.players[playerIndex];
  return (
    p.channeled.length + p.floatingRainbowPower + Object.values(p.floatingPower).reduce((a, b) => a + (b ?? 0), 0)
  );
};

describe("Mageseeker Investigator (UNL-163): REFUSED — a Standard Move has no cost to add to", () => {
  /**
   * "Opponents must pay :rainbow: for each unit beyond the first to move multiple
   * units to my battlefield at the same time."
   *
   * The rule it taxes is **144.3**: "Players may perform multiple Units' standard
   * move simultaneously. This is treated as one game action performed on multiple
   * Units." That action's whole cost is **144.2** — "Exhausting the Unit is the
   * Cost for this action" — and this engine implements exactly that and nothing
   * else. There is no rune payment on the move path at ANY of its four sites:
   *
   *   - `MoveUnitAction` (actions/player-action.ts) is `{type, playerIndex,
   *     unitInstanceIds, destinationBattlefieldId}` and has no `payment`;
   *   - `validateMoveUnit` checks turn, phase, Showdown, chain, duplicates,
   *     exhaustion and `[Ganking]`, and names this card's surcharge in its own
   *     header as one of the omissions;
   *   - `executeMoveUnit` exhausts, holds three triggers and applies Contested;
   *   - `legalActions` only ever emits SINGLE-unit moves, so the AI cannot make
   *     the multi-unit move this taxes in the first place.
   *
   * All four are shared files. Nothing in `effects/order.ts` is reachable from a
   * move at all — the only per-card hooks there are `unitTriggers`/`eventTriggers`,
   * which fire AFTER the move has already happened for free.
   *
   * **The tempting wrong implementation is a PROHIBITION** — refusing the move
   * when the opponent cannot pay. That is strictly stronger than printed: the card
   * makes a group move expensive, not impossible.
   */
  it("is reported unimplemented, with nothing registered for it", () => {
    expect(isCardImplemented(registry.get(MAGESEEKER)), "someone implemented him — delete this block").toBe(false);
    expect(implementingModule(MAGESEEKER), "an effect is registered now — delete this block").toBeUndefined();
    // The instrument control, once for the whole file: both of the above answer
    // the OTHER way for a card that IS written, so `false`/`undefined` are facts
    // about this card rather than about a lookup that never resolves. (Verified by
    // mutation too — registering a stub for UNL-163 and UNL-178 in effects/order.ts
    // turns exactly this assertion and Poppy's twin red, and nothing else.)
    expect(isCardImplemented(registry.get(SAFETY_INSPECTOR)), "the coverage instrument stopped discriminating").toBe(
      true,
    );
    expect(implementingModule(SAFETY_INSPECTOR), "the module lookup stopped discriminating").toBeDefined();
  });

  it("the rune instrument reads all three pools it claims to", () => {
    // `payableTowardRainbow` is the only thing standing between "nothing was
    // charged" and "nothing was measured". Asserted against a hand-built pool
    // rather than trusted.
    const state = makeState({ phase: "Action" });
    state.players[1]!.channeled = [...orderRunes(2), { id: "used", domain: "Fury", state: "Exhausted" }];
    state.players[1]!.floatingRainbowPower = 2;
    state.players[1]!.floatingPower = { Order: 1 };
    expect(payableTowardRainbow(state, 1)).toBe(6);
  });

  /**
   * Two ready base units for the opponent and a Mageseeker standing at bf1 for
   * the controller.
   *
   * `runes` is the whole instrument. At 1 the mover can pay the printed tax
   * exactly, so "was it charged?" is a question with a visible answer — an
   * always-zero measurement would read as "nothing was charged" whatever the
   * engine did, which is this repo's `0/0 looks like a pass` failure. At 0 the tax
   * is unpayable and the move should not be declarable at all.
   */
  function taxBoard(withMageseeker: boolean, runes = 1): { state: GameState; move: MoveUnitAction } {
    const state = makeState({ phase: "Action", activePlayerIndex: 1, turnState: "Neutral", chainOpen: true });
    state.players[1]!.baseUnits = [
      makeUnit({ instanceId: "mover-a", name: "Mover A" }),
      makeUnit({ instanceId: "mover-b", name: "Mover B" }),
    ];
    state.players[1]!.channeled = orderRunes(runes);
    if (withMageseeker) {
      state.battlefields[0]!.units = { p1: [realUnitInstance(MAGESEEKER)] };
    }
    return {
      state,
      move: {
        type: "MoveUnit",
        playerIndex: 1,
        unitInstanceIds: ["mover-a", "mover-b"],
        destinationBattlefieldId: "bf1",
      },
    };
  }

  it("charges an opponent NOTHING to walk two units onto his battlefield at once", () => {
    const { state, move } = taxBoard(true);
    // The measurement is live: there IS one rune to take, so `toBe(1)` below is a
    // claim about the engine rather than about an empty pool.
    expect(payableTowardRainbow(state, 1), "the fixture left the mover nothing to be taxed").toBe(1);

    const after = accept(state, move, "a two-unit move onto the Mageseeker's battlefield");

    // Printed: 2 units, "for each unit beyond the first", so 1 rainbow is owed and
    // the mover's single rune should be recycled for it.
    expect(unitsAt(after, "bf1", 1).map((u) => u.name), "the taxed move did not complete").toEqual([
      "Mover A",
      "Mover B",
    ]);
    expect(payableTowardRainbow(after, 1), "something WAS charged — the refusal is stale").toBe(1);
  });

  it("does not even refuse the move when the tax would be unpayable", () => {
    // The sharper half. With an EMPTY rune pool the printed card makes this group
    // move undeclarable — there is no way to pay the 1 rainbow it costs. It goes
    // through untouched.
    const { state, move } = taxBoard(true, 0);
    expect(payableTowardRainbow(state, 1)).toBe(0);
    const after = accept(state, move, "an unpayable two-unit move onto the Mageseeker's battlefield");
    expect(unitsAt(after, "bf1", 1), "the unpayable move was refused after all").toHaveLength(2);
  });

  it("does exactly the same thing when he is not on the board — the negative control", () => {
    // The point of the pair: with and without him the board ends identical, which
    // is what "inert" means. The first test alone would pass just as well against
    // a Mageseeker that taxed the WRONG player, or that only taxed single moves.
    const withHim = taxBoard(true);
    const withoutHim = taxBoard(false);

    const a = accept(withHim.state, withHim.move, "the move with the Mageseeker present");
    const b = accept(withoutHim.state, withoutHim.move, "the move with no Mageseeker");

    expect(unitsAt(a, "bf1", 1).map((u) => u.instanceId)).toEqual(unitsAt(b, "bf1", 1).map((u) => u.instanceId));
    expect(payableTowardRainbow(a, 1)).toBe(payableTowardRainbow(b, 1));
    expect(a.players[1]!.baseUnits, "the movers left base in one case and not the other").toHaveLength(
      b.players[1]!.baseUnits.length,
    );
  });

  it("is not even enumerable: every offered MoveUnit moves exactly one unit", () => {
    // The second half of the refusal, and the reason implementing the tax in the
    // validator alone would still leave it unexercised: `legalActions` fans out
    // one action per unit per destination, so the AI never declares a 144.3 group
    // move. The human UI does (GameBoard hand-builds the multi-unit action), so
    // the tax would be reachable in play and invisible to every probe.
    const state = makeState({ phase: "Action", activePlayerIndex: 0, turnState: "Neutral", chainOpen: true });
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "a" }), makeUnit({ instanceId: "b" })];

    const moves = legalActions(state).filter((a): a is MoveUnitAction => a.type === "MoveUnit");
    expect(moves.length, "no moves were offered at all — the fixture is wrong").toBeGreaterThan(0);
    expect(
      moves.every((m) => m.unitInstanceIds.length === 1),
      "the enumerator now offers group moves — Mageseeker's tax has become AI-reachable",
    ).toBe(true);
  });
});

describe("Poppy - Defender of the Meek (UNL-178): LANDED 2026-08-13", () => {
  /**
   * **This block was five refusal tests, and its diagnosis was exactly right —
   * which is why the implementation looks the way it does.**
   *
   * It predicted the trap in one sentence: adding `"UNL-178": 3` to
   * `OPTIONAL_XP_COSTS` "would compile and would report the card DONE. It would
   * also be a strictly WORSE card than printed, because the enumerator's paid
   * variant is `actions.push({ ...play, optionalXpPaid: true })` — the plain play
   * plus a flag, with the plain play's payment. The caster would pay 3 XP and 6
   * Energy for a 6-Energy unit."
   *
   * So the table entry grew an `energyDiscount`, the three cost sites read it,
   * and the paid variant became a real second PAYMENT rather than a flag on the
   * first. Her coverage is `test/poppy-xp-discount.test.ts`.
   *
   * **Its "PROVES the flag cannot carry a discount" measurement is kept below**,
   * inverted. It was made on Safety Inspector precisely because Poppy was not in
   * the table, and it is still the sharpest statement of the difference between
   * the two cards — his XP buys a resolution-time exemption and moves no price,
   * hers buys the price. Now it asserts that his payments still match, which is
   * what says the discount did not leak onto the card that does not print one.
   */
  it("Safety Inspector's paid variant still pays IDENTICAL runes — the discount did not leak", () => {
    // Unchanged from the refusal except in what it means. Then: proof a flag
    // could not carry a discount, so Poppy was unwritable. Now: proof that
    // teaching the flag to carry one for Poppy left the card whose XP buys
    // something else alone.
    const inspector = realUnitInstance(SAFETY_INSPECTOR);
    const state = makeState({ phase: "Action", activePlayerIndex: 0, turnState: "Neutral", chainOpen: true });
    state.players[0]!.hand = [inspector];
    state.players[0]!.xp = 5;
    state.players[0]!.channeled = orderRunes(12);

    const casts = castsOf(state, inspector.instanceId);
    const paid = casts.filter((a) => a.optionalXpPaid === true);
    const unpaid = casts.filter((a) => a.optionalXpPaid === undefined);
    expect(paid.length, "the XP variant stopped being enumerated — this measurement is dead").toBeGreaterThan(0);
    expect(unpaid.length, "the plain variant stopped being enumerated").toBeGreaterThan(0);

    // Same destination on both sides, so the comparison is about the cost and not
    // about where he is going.
    const toBase = (a: PlayCardAction) => a.destinationBattlefieldId === undefined;
    expect(paid.find(toBase)!.payment, "the XP discount leaked onto Safety Inspector").toEqual(
      unpaid.find(toBase)!.payment,
    );
  });

  it("but her printed KEYWORDS are live — [Ambush] gives her Reaction timing into a battlefield she has units at", () => {
    // The other half of a precise refusal: `[Ambush]` (822.1.b) and `[Tank]`
    // (465.2.c's assignment order) are both real here, so the ONLY unwritten thing
    // on this card is the XP clause. Asserting it means the report can say which
    // half is missing rather than "the card does nothing".
    //
    // A Showdown is open, so ordinary Action-speed plays are gone; anything still
    // offered is offered at Reaction speed.
    const poppy = realUnitInstance(POPPY);
    const state = makeState({
      phase: "Action",
      activePlayerIndex: 0,
      turnState: "Showdown",
      showdownBattlefieldId: "bf2",
      showdownKind: "Combat",
      focusHolder: 0,
      chainOpen: true,
    });
    state.players[0]!.hand = [poppy];
    state.players[0]!.channeled = orderRunes(12);
    state.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "anchor" })] };

    const casts = castsOf(state, poppy.instanceId);
    expect(
      casts.map((a) => a.destinationBattlefieldId),
      "[Ambush] is not granting Reaction timing — she should be playable to bf1 only",
    ).toEqual(["bf1"]);
    expect(poppy.keywords.Tank, "she stopped printing [Tank]").toBe(1);

    // The negative control on that: **822.1.b** grants the timing only "to a
    // battlefield where you control Units", so taking the anchor away must take
    // the whole play away — not merely narrow it. Without this, the assertion
    // above would pass just as well against an Ambush that granted Reaction
    // timing unconditionally and let the reinforce rule pick the destination.
    const anchorless = { ...state, battlefields: state.battlefields.map((bf) => ({ ...bf, units: {} })) };
    expect(
      castsOf(anchorless, poppy.instanceId),
      "she is playable at Reaction speed with no units anywhere — [Ambush] is unconditional",
    ).toHaveLength(0);

    // And the second control: the Showdown really is what narrowed the list. In a
    // Neutral state the ordinary Action-speed play to BASE is there too, so
    // `["bf1"]` above is Ambush's doing and not just the reinforce rule's.
    const neutral: GameState = { ...state, turnState: "Neutral", showdownBattlefieldId: null, showdownKind: null };
    expect(
      castsOf(neutral, poppy.instanceId).map((a) => a.destinationBattlefieldId),
      "she was not playable to base at Action speed — the Showdown was not the thing narrowing her",
    ).toEqual([undefined, "bf1"]);
  });
});

describe("Ashe - Focused (UNL-169): still refused, and the blocker that is a shared mechanism", () => {
  /**
   * Wave 3 refused her and named three blockers. **All three still hold**, and its
   * pin in `unl-order-wave3.test.ts` is NOT duplicated here — one file owns that
   * coverage claim. What this block adds is the third blocker measured directly,
   * because it is a fact about `triggers.ts` rather than about her:
   *
   *   1. a DELAYED trigger armed by a resolved ability — still no general
   *      mechanism; both delayed effects in the engine are a field on state read
   *      by their firing site (`killDamagedUnitsThisTurn`,
   *      `buffUnitsPlayedThisTurn`), and `GameState`/`PlayerState` have gained no
   *      generic queue;
   *   2. PER-INSTANCE memory of WHICH card was banished — the only such memory in
   *      the model is `GearInstance.banishedInstanceIds` (The Zero Drive), which is
   *      on the wrong instance type and in model/card.ts;
   *   3. "**even if I'm no longer on the board**" — asserted below.
   *
   * "When they hold" is **469.2** ("Hold: A player maintains Control of a
   * Battlefield they did not yet Score this turn during their Beginning Phase"),
   * which this engine raises as `battlefieldHeld` — so the EVENT she needs already
   * exists. It is the listener, not the moment, that is missing.
   */
  it("cannot listen from anywhere she can go: a dead Ashe is in no listener walk", () => {
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    const ashe = realUnitInstance(ASHE_FOCUSED);
    // Both places "no longer on the board" can put her.
    state.players[0]!.trash = [ashe];
    state.players[0]!.banished = [{ ...ashe, instanceId: "ashe-banished" }];

    // `listeningTrashCards` is a NAMED two-card set, and she is not in it.
    expect(
      listeningTrashCards(state, 0),
      "she can listen from the trash now — blocker 3 has moved, re-check the wave-3 refusal",
    ).toHaveLength(0);

    // And nothing walks the banished zone at all.
    const reachable = allListeningPermanents(state).map((l) => l.card.instanceId);
    expect(reachable, "the banished zone is being walked now").not.toContain("ashe-banished");
    expect(reachable, "the trash is being walked wholesale now").not.toContain(ashe.instanceId);
  });

  it("the control: a unit ON the board IS in the walk", () => {
    // Without this the assertion above passes just as well against a walk that
    // returns nothing at all.
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    const ashe = realUnitInstance(ASHE_FOCUSED);
    state.battlefields[0]!.units = { p1: [ashe] };

    expect(allListeningPermanents(state).map((l) => l.card.instanceId)).toContain(ashe.instanceId);
  });
});

// ---------------------------------------------------------------------------
// **The execute-play-card float bug this file discovered was FIXED on
// 2026-08-12, and this block was deleted rather than relaxed — which is exactly
// what its own header asked for.**
//
// It found a live defect in a shared file while specifying Poppy: the
// choice-keyed discounts (`variantCostDiscount`, for Atakhan UNL-170 and Undying
// Loyalty UNL-168) were wired into `legal-actions` and `validate-play-card` and
// NOT into `execute-play-card`, which re-prices from the raw cost to decide how
// much FLOATING Energy to burn. Both cards were offered at the right price,
// validated at the right price, and then charged banked Energy they no longer
// owed.
//
// Two things about the find are worth keeping:
//   - **Neither card's own suite could see it.** Both measure the enumerated
//     payment's rune counts and the validator's verdict, and neither moves when
//     the executor is wrong. This repo's rule says "enumerate and validate must
//     agree"; there are THREE sites.
//   - **A full Ready rune pool HIDES it**, because 164.2 credits 1 floating
//     Energy back when a Ready rune is recycled for Power. The fixture here paid
//     with an already-Exhausted rune precisely to remove that credit and said so
//     — and the first regression test written against the fix got its own
//     controls wrong by exactly that much before adopting the same trick.
//
// The permanent pin lives in `test/variant-discount-execution.test.ts`, which
// asserts the DIFFERENCE between the discounted and undiscounted variants so the
// 164.2 credit cancels. Recorded in docs/rules-conformance.md on the row that
// already described this class (Irelia - Graceful).
// ---------------------------------------------------------------------------
describe("the subjects exist", () => {
  it("all three wave-7 cards are real registry entries", () => {
    for (const id of [MAGESEEKER, ASHE_FOCUSED, POPPY]) {
      const def = registry.get(id);
      expect(def, `${id} is not in the registry`).toBeDefined();
      expect(def.type, `${id} stopped being a Unit`).toBe("Unit");
    }
    expect(createCardInstance(registry.get(POPPY)).kind).toBe("Unit");
  });
});
