import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validateMoveUnit } from "../src/actions/validate-move-unit.js";
import { moveSurchargeFor } from "../src/engine/move-surcharge.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { MoveUnitAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance } from "./fixtures.js";

/**
 * **UNL-163 Mageseeker Investigator — "Opponents must pay [rainbow] for each
 * unit beyond the first to move multiple units to my battlefield at the same
 * time."**
 *
 * Refused in waves 6 and 7, and wave 7's refusal is one of the most precisely
 * written in the repo. It named all four sites — `MoveUnitAction` had no
 * `payment`, `validateMoveUnit` listed this very surcharge in its own header as
 * an omission, `executeMoveUnit` only exhausted, and `legalActions` emits only
 * single-unit moves — and it named the rule: **144.2**, "exhausting the Unit is
 * the Cost for this action", which is why the move path had no price to add to.
 *
 * Three of the four are closed here. The fourth is not, and that is deliberate:
 * see `the enumerator still offers only single-unit moves` below.
 *
 * # The wrong implementation this does NOT do
 *
 * Wave 7 also named the tempting error, and it was right to: refusing the move
 * when the opponent cannot pay is strictly STRONGER than printed. The card makes
 * a group move expensive, not impossible. So an unpayable move is refused as
 * THAT action, and moving the same units one at a time still costs nothing —
 * asserted below, because the difference is the whole card.
 */

const registry = defaultCardRegistry();
const INVESTIGATOR = "UNL-163";

const rainbow = (n: number): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, domain: "Order" as const, state: "Ready" as const }));

/**
 * Player 0 has `movers` units in base; the Investigator is player 1's and stands
 * at bf1 unless `guarded` says otherwise. Player 0 holds `runes` rune cards.
 */
function board(opts: { movers?: number; guarded?: boolean; runes?: number } = {}): GameState {
  const { movers = 3, guarded = true, runes = 5 } = opts;
  const state = makeState({ phase: "Action", activePlayerIndex: 0, turnState: "Neutral", chainOpen: true });
  state.players[0]!.baseUnits = Array.from({ length: movers }, (_, i) => makeUnit({ instanceId: `m${i}` }));
  state.players[0]!.channeled = rainbow(runes);
  if (guarded) state.battlefields[0]!.units = { p2: [realUnitInstance(INVESTIGATOR)] };
  return state;
}

/** A multi-unit move of the first `count` movers to bf1, paying `pay` runes. */
function move(state: GameState, count: number, pay: number, battlefieldId = "bf1"): MoveUnitAction {
  return {
    type: "MoveUnit",
    playerIndex: 0,
    unitInstanceIds: Array.from({ length: count }, (_, i) => `m${i}`),
    destinationBattlefieldId: battlefieldId,
    ...(pay > 0 ? { payment: { energyRunes: [], powerRunes: [], rainbowRunes: rainbow(pay).map((r) => r.id) } } : {}),
  };
}

const readyRunes = (state: GameState) => state.players[0]!.channeled.filter((r) => r.state === "Ready").length;
const unitsAtBf1 = (state: GameState) => (state.battlefields[0]!.units.p1 ?? []).length;

describe("what is owed — one rainbow per unit BEYOND the first", () => {
  it("charges nothing for a single-unit move, 1 for two, 2 for three", () => {
    const state = board();
    expect(moveSurchargeFor(state, 0, "bf1", 1), "a single-unit move was taxed").toBe(0);
    expect(moveSurchargeFor(state, 0, "bf1", 2)).toBe(1);
    expect(moveSurchargeFor(state, 0, "bf1", 3)).toBe(2);
  });

  it("charges nothing at a battlefield the Investigator is not standing at", () => {
    // "MY battlefield" — he taxes where he stands, not the board.
    expect(moveSurchargeFor(board(), 0, "bf2", 3), "he taxed a battlefield he is not at").toBe(0);
  });

  it("charges nothing when the Investigator is the MOVER's own", () => {
    // "OPPONENTS must pay". A player is not their own opponent, and an
    // implementation that read "any Investigator here" would tax its controller.
    const state = board({ guarded: false });
    state.battlefields[0]!.units = { p1: [realUnitInstance(INVESTIGATOR)] };

    expect(moveSurchargeFor(state, 0, "bf1", 3), "he taxed his own controller").toBe(0);
  });

  it("does not STACK — two Investigators charge what one does", () => {
    // The card says opponents must pay, not that each of them charges. Two copies
    // impose the same requirement rather than additive ones, the reading a
    // repeated `[Deflect]` value already takes.
    const state = board();
    state.battlefields[0]!.units = { p2: [realUnitInstance(INVESTIGATOR), realUnitInstance(INVESTIGATOR)] };

    expect(moveSurchargeFor(state, 0, "bf1", 3), "the second copy charged again").toBe(2);
  });
});

describe("the validator: a COST, never a prohibition", () => {
  it("accepts a paid multi-unit move", () => {
    const state = board();
    const verdict = validateMoveUnit(state, move(state, 3, 2));
    expect(verdict.ok, verdict.ok ? "" : verdict.error).toBe(true);
  });

  it("REFUSES an underpaid one", () => {
    const state = board();
    expect(validateMoveUnit(state, move(state, 3, 1)).ok, "two units moved for one rune").toBe(false);
    expect(validateMoveUnit(state, move(state, 3, 0)).ok, "three units moved for nothing").toBe(false);
  });

  it("REFUSES runes the mover does not hold — naming an id is not holding it", () => {
    const state = board({ runes: 0 });
    expect(validateMoveUnit(state, move(state, 3, 2)).ok, "a forged rune list paid the tax").toBe(false);
  });

  it("and the SAME units still move one at a time for FREE", () => {
    // **The half that separates a cost from a prohibition**, and the error wave 7
    // named. A player who cannot pay is not stopped — they are slowed.
    const state = board({ runes: 0 });
    const single: MoveUnitAction = {
      type: "MoveUnit",
      playerIndex: 0,
      unitInstanceIds: ["m0"],
      destinationBattlefieldId: "bf1",
    };

    const verdict = validateMoveUnit(state, single);
    expect(verdict.ok, verdict.ok ? "" : `a single-unit move was blocked: ${verdict.error}`).toBe(true);
  });

  it("leaves an UNGUARDED multi-unit move free", () => {
    const state = board({ guarded: false });
    const verdict = validateMoveUnit(state, move(state, 3, 0));
    expect(verdict.ok, verdict.ok ? "" : `an untaxed move was charged: ${verdict.error}`).toBe(true);
  });
});

describe("executing it", () => {
  it("recycles exactly the runes owed and moves every unit", () => {
    const state = board();
    const before = readyRunes(state);

    const { state: after, result } = submit(state, move(state, 3, 2));
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });

    expect(before - readyRunes(after), "the surcharge was not charged, or was over-charged").toBe(2);
    expect(unitsAtBf1(after), "the units did not arrive").toBe(3);
  });

  it("recycles NOTHING for an unguarded move of the same size", () => {
    // Measured as a difference against the taxed case above, which is what makes
    // the 2 there attributable to the Investigator rather than to moving at all.
    const state = board({ guarded: false });
    const before = readyRunes(state);

    const { state: after, result } = submit(state, move(state, 3, 0));
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });

    expect(before - readyRunes(after), "an untaxed move spent runes").toBe(0);
    expect(unitsAtBf1(after), "the units did not arrive").toBe(3);
  });

  it("recycles the runes to the DECK — a tax refunds no Energy (164.2)", () => {
    // The distinction `execute-play-card` draws for a [Deflect] surcharge: a rune
    // recycled for your OWN Power banks 1 floating Energy, and one handed to an
    // opponent as a tax banks nothing.
    const state = board();
    const { state: after } = submit(state, move(state, 3, 2));

    expect(after.players[0]!.floatingEnergy, "the tax refunded Energy").toBe(0);
    expect(after.players[0]!.runeDeck.length, "the runes were not recycled to the deck").toBe(2);
  });
});

describe("the fourth site, still open and deliberately so", () => {
  it("the enumerator still offers only single-unit moves", () => {
    // **Wave 7's fourth blocker, unchanged**, and it is why the AI never pays this
    // tax: `legalActions` emits one action per unit. Enumerating every SUBSET of a
    // player's units per battlefield is a power set, and nothing in the pool but
    // this card would read it.
    //
    // The card is not inert for it — a human client builds multi-unit moves
    // directly (`GameBoard.tsx` does exactly that), which is the path everything
    // above drives. Recorded as a divergence in docs/rules-conformance.md, and
    // pinned here so widening the enumerator fails loudly rather than silently
    // changing what the AI can do.
    const state = board();
    const moves = legalActions(state).filter((a): a is MoveUnitAction => a.type === "MoveUnit");

    expect(moves.length, "no move was enumerated — this pin measures nothing").toBeGreaterThan(0);
    expect(moves.every((m) => m.unitInstanceIds.length === 1), "the enumerator learned multi-unit moves").toBe(true);
    expect(moves.every((m) => m.payment === undefined), "a single-unit move was given a payment").toBe(true);
  });
});

describe("coverage", () => {
  it("reports the card finished", () => {
    const def = registry.get(INVESTIGATOR);
    expect(isCardImplemented(def), "it still reports unfinished").toBe(true);
    expect(partialImplementationNote(def), "it carries a partial note").toBeUndefined();
  });
});
