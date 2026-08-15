import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validateMoveUnit } from "../src/actions/validate-move-unit.js";
import { moveSurchargeFor } from "../src/engine/move-surcharge.js";
import { groupedMoveTruncated } from "../src/engine/legal-actions.js";
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
 * an omission, `executeMoveUnit` only exhausted, and `legalActions` emitted only
 * single-unit moves — and it named the rule: **144.2**, "exhausting the Unit is
 * the Cost for this action", which is why the move path had no price to add to.
 * All four are closed.
 *
 * # A cost, and the rules say which kind
 *
 * **204.4 names this card as its own worked example of an Applied Cost**, which
 * settles the one thing the two refusals disagreed about. Wave 7 called refusing
 * an unpaid move "the tempting wrong implementation... strictly stronger than
 * printed"; 204.4.c says "if a player can't pay or chooses not to pay the Applied
 * Cost, they cannot perform the associated Game Action."
 *
 * What wave 7 was right about is WHICH thing is barred. 144.3 makes a
 * simultaneous multi-unit move ONE action, so moving the same units one at a time
 * is a different action and stays free — the line between expensive and
 * impossible, asserted below because it is the whole card.
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

describe("the fourth site: the enumerator offers the group move his tax is about", () => {
  it("fans out every subset, and prices the ones he guards", () => {
    // Wave 7's fourth blocker, closed on 2026-08-14 — `legalActions` emitted one
    // action per unit, so the AI never declared a 144.3 group move and this card
    // was reachable only through a human client. It now fans out every non-empty
    // SUBSET of the units that can reach a destination.
    const state = board({ movers: 3, runes: 5 });
    const moves = legalActions(state).filter((a): a is MoveUnitAction => a.type === "MoveUnit");
    // 3 units -> 7 subsets, times 2 battlefields.
    expect(moves.length, "the subset enumeration changed shape — recount it").toBe(14);

    const guarded = moves.filter((m) => m.destinationBattlefieldId === "bf1");
    const free = moves.filter((m) => m.destinationBattlefieldId === "bf2");
    expect(
      guarded.every((m) => (m.payment?.rainbowRunes ?? []).length === m.unitInstanceIds.length - 1),
      "a group move onto his battlefield was mispriced",
    ).toBe(true);
    expect(free.every((m) => m.payment === undefined), "a move he does not guard was charged").toBe(true);
  });

  it("drops the groups the mover cannot afford — 204.4.c, in the enumerator", () => {
    // With one rune only the two-unit groups are payable, so the three-unit one is
    // not offered at all. The engine's usual rule is "never offer what the
    // validator refuses"; here it is also the printed rule.
    const state = board({ movers: 3, runes: 1 });
    const guarded = legalActions(state)
      .filter((a): a is MoveUnitAction => a.type === "MoveUnit")
      .filter((m) => m.destinationBattlefieldId === "bf1");

    expect(guarded.map((m) => m.unitInstanceIds.length).sort(), "the unaffordable group was still offered").toEqual([
      1, 1, 1, 2, 2, 2,
    ]);
  });

  it("every enumerated move VALIDATES — including a Ganking unit's", () => {
    // The enumerate/validate agreement rule, applied to a path that had no reason
    // to need it while every move was one unit from base. It does now: a
    // `[Ganking]` unit can leave a battlefield, and the fan-out has to exclude the
    // battlefield it is standing on or the validator refuses what was offered.
    //
    // Mutation-found. Dropping that exclusion left the whole engine suite green,
    // because nothing else puts a Ganking unit on a board and reads the move list.
    const state = board({ movers: 1, runes: 5 });
    state.battlefields[0]!.units = {
      ...state.battlefields[0]!.units,
      p1: [makeUnit({ instanceId: "ganker", keywords: { Ganking: 1 } })],
    };

    const moves = legalActions(state).filter((a): a is MoveUnitAction => a.type === "MoveUnit");
    const gankerMoves = moves.filter((m) => m.unitInstanceIds.includes("ganker"));
    expect(gankerMoves.length, "the Ganking unit was offered no move — this asserts nothing").toBeGreaterThan(0);
    expect(
      gankerMoves.every((m) => m.destinationBattlefieldId !== "bf1"),
      "a unit was offered a move to the battlefield it already stands on",
    ).toBe(true);

    for (const m of moves) {
      const verdict = validateMoveUnit(state, m);
      expect(verdict.ok, verdict.ok ? "" : `offered but refused: ${verdict.error}`).toBe(true);
    }
  });

  it("BOUNDS the fan-out above 4 movers, and says so rather than truncating silently", () => {
    // 2^n is honest and unbounded, and the AI evaluates every action it is handed
    // — so one large board would become a hang. Above the line only the singletons
    // and the all-in group are emitted. Asserted from BOTH sides of the boundary,
    // because a bound nobody measures is the silent truncation it was meant not
    // to be.
    //
    // **The bound was 8 for about an hour and is 4 because it was MEASURED.** At 8
    // (255 groups per battlefield) `reachability` went from ~120s to over ten
    // minutes and `GAMES=1000` stopped finishing at all — the probe is the whole
    // verification loop's long pole, and a rules-complete enumeration nobody can
    // afford to run is not an improvement. 4 still covers every group size the tax
    // is about; the truncation is stated rather than hidden, which is the part
    // that matters.
    expect(groupedMoveTruncated(4), "the bound moved down").toBe(false);
    expect(groupedMoveTruncated(5), "the bound moved up").toBe(true);

    const wide = board({ movers: 5, guarded: false });
    const toBf2 = legalActions(wide)
      .filter((a): a is MoveUnitAction => a.type === "MoveUnit")
      .filter((m) => m.destinationBattlefieldId === "bf2");

    // 5 singletons plus the all-in group, NOT 31.
    expect(toBf2.length, "the bound is not being applied").toBe(6);
    expect(toBf2.some((m) => m.unitInstanceIds.length === 5), "the all-in group was dropped").toBe(true);
  });
});

describe("coverage", () => {
  it("reports the card finished", () => {
    const def = registry.get(INVESTIGATOR);
    expect(isCardImplemented(def), "it still reports unfinished").toBe(true);
    expect(partialImplementationNote(def), "it carries a partial note").toBeUndefined();
  });
});
