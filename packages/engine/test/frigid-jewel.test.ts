import { describe, expect, it } from "vitest";
import { drawCards } from "../src/engine/effect-helpers.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { isCardImplemented, implementingModules, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { answerDecisions, makeState, makeUnit, realGearInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * **UNL-074 Frigid Jewel — "When you draw your SECOND card each turn, give a
 * friendly unit +2 [Might] this turn."**
 *
 * # The ordinal is the card
 *
 * She fires on the second draw and on no other, so the `cardDrawn` event carries
 * `nthThisTurn` rather than leaving a listener to re-read the counter. That is
 * not a style choice and the difference is testable: the trigger is HELD (383),
 * so by the time it resolves the count has moved on — a listener reading
 * `PlayerState.cardsDrawnThisTurn` would see the same final number for every held
 * instance, and a single "draw 3" would fire three times or none. The
 * draw-three test below is what catches that.
 *
 * # What is asserted, and why each has a partner
 *
 *  - The SECOND draw pumps; the first and third do not. A trigger firing on
 *    every draw passes a test of the second alone.
 *  - "EACH turn" — the ordinal restarts at `runEnd`, so she fires again next
 *    turn. Without that reset she fires once per game.
 *  - "FRIENDLY" — the option list is friendly-only, unlike Rengar -
 *    Pridestalker's otherwise identical question, which prints "a unit" and
 *    offers both sides.
 *  - A draw that moved NO card (empty deck, empty trash, so Burn Out cannot
 *    refill) must not advance the ordinal, or she fires on a boundary no card
 *    ever crossed.
 */

const registry = defaultCardRegistry();

const FRIGID_JEWEL = "UNL-074";
const JEWEL_NTH = 2;
const JEWEL_MIGHT = 2;

/** A deck of `count` throwaway cards to draw. */
const deckOf = (count: number) =>
  Array.from({ length: count }, () => createCardInstance(registry.get("OGN-052")));

/**
 * The Jewel in her controller's `activeGear`, a friendly unit to pump, and a
 * deck to draw from. An ENEMY unit stands beside it so "friendly" is a real
 * filter rather than a description of a one-sided board.
 */
function board(deckSize = 6): { state: GameState; friendly: UnitInstance; enemy: UnitInstance } {
  const friendly = makeUnit({ instanceId: "friendly", name: "Friendly" });
  const enemy = makeUnit({ instanceId: "enemy", name: "Enemy" });
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.activeGear = [realGearInstance(FRIGID_JEWEL)];
  state.players[0]!.baseUnits = [friendly];
  state.players[0]!.deck = deckOf(deckSize);
  state.players[1]!.baseUnits = [enemy];
  return { state, friendly, enemy };
}

const findUnit = (state: GameState, instanceId: string): UnitInstance | undefined =>
  [
    ...state.players.flatMap((p) => p.baseUnits),
    ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
  ].find((u) => u.instanceId === instanceId);

/** Draw `n` cards one at a time and settle every held trigger and question. */
const drawAndSettle = (state: GameState, n: number, playerIndex: 0 | 1 = 0): GameState => {
  let current = state;
  for (let i = 0; i < n; i += 1) {
    current = answerDecisions(resolveHeldTriggers(drawCards(current, playerIndex, 1)));
  }
  return current;
};

describe("the ordinal — she fires on the SECOND draw and no other", () => {
  it("does not fire on the first", () => {
    const { state, friendly } = board();
    const after = drawAndSettle(state, 1);

    expect(after.players[0]!.cardsDrawnThisTurn, "the counter did not move").toBe(1);
    expect(findUnit(after, friendly.instanceId)!.mightThisTurn, "she fired on the first draw").toBe(0);
  });

  it("fires on the second", () => {
    const { state, friendly } = board();
    const after = drawAndSettle(state, 2);

    expect(findUnit(after, friendly.instanceId)!.mightThisTurn, "she did not fire on the second draw").toBe(
      JEWEL_MIGHT,
    );
  });

  it("does not fire AGAIN on the third", () => {
    // The half a test of the second draw alone cannot make: a trigger with no
    // ordinal check fires on every draw and passes that one.
    const { state, friendly } = board();
    const after = drawAndSettle(state, 3);

    expect(after.players[0]!.cardsDrawnThisTurn).toBe(3);
    expect(findUnit(after, friendly.instanceId)!.mightThisTurn, "she fired more than once").toBe(JEWEL_MIGHT);
  });

  it("fires exactly ONCE on a single draw-three", () => {
    // **The test that catches a listener re-reading the counter instead of the
    // event.** These triggers are HELD, so all three are raised before any
    // resolves; one that asked `PlayerState.cardsDrawnThisTurn` at resolution
    // time would see 3 for every instance — firing three times or none, never
    // once.
    const { state, friendly } = board();
    const after = answerDecisions(resolveHeldTriggers(drawCards(state, 0, 3)));

    expect(after.players[0]!.cardsDrawnThisTurn, "three cards were not drawn").toBe(3);
    expect(findUnit(after, friendly.instanceId)!.mightThisTurn, "the batch draw did not pump exactly once").toBe(
      JEWEL_MIGHT,
    );
  });
});

describe("'EACH turn' — the ordinal restarts", () => {
  it("fires again on the second draw of the next turn", () => {
    const { state, friendly } = board(12);
    const firstTurn = drawAndSettle(state, 2);
    expect(findUnit(firstTurn, friendly.instanceId)!.mightThisTurn, "she never fired at all").toBe(JEWEL_MIGHT);

    // `runEnd` clears the ordinal AND `mightThisTurn`, so the next turn starts
    // clean on both axes — which is what makes the second pump visible.
    const nextTurn = runEnd({ ...firstTurn, phase: "Action" });
    expect(nextTurn.players[0]!.cardsDrawnThisTurn, "the ordinal outlived the turn").toBe(0);

    const after = drawAndSettle(nextTurn, 2);
    expect(findUnit(after, friendly.instanceId)!.mightThisTurn, "she fired only once in the game").toBe(JEWEL_MIGHT);
  });
});

describe("'a FRIENDLY unit'", () => {
  it("pumps the friendly unit and never the enemy", () => {
    // With one friendly unit the question has a single answer and resolves
    // without a prompt. The enemy standing beside it is what makes that
    // meaningful: a friendly-only option list is the only reason the pump cannot
    // land on them.
    const { state, friendly, enemy } = board();
    const after = drawAndSettle(state, 2);

    expect(findUnit(after, friendly.instanceId)!.mightThisTurn).toBe(JEWEL_MIGHT);
    expect(findUnit(after, enemy.instanceId)!.mightThisTurn, "the pump reached an enemy unit").toBe(0);
  });

  it("does nothing when the controller has no units at all", () => {
    // The option list is empty, so `decisions.ts` drops the question. Asserted so
    // an empty board is a no-op rather than a crash or a stray pump.
    const { state, enemy } = board();
    state.players[0]!.baseUnits = [];
    const after = drawAndSettle(state, 2);

    expect(findUnit(after, enemy.instanceId)!.mightThisTurn, "it pumped the only unit on the board — an enemy").toBe(0);
  });
});

describe("'when YOU draw'", () => {
  it("an opponent's draws do not fire her", () => {
    const { state, friendly } = board();
    state.players[1]!.deck = deckOf(6);
    const after = drawAndSettle(state, 3, 1);

    expect(after.players[1]!.cardsDrawnThisTurn, "the opponent never drew — fixture is wrong").toBe(3);
    expect(findUnit(after, friendly.instanceId)!.mightThisTurn, "an opponent's draw fired her").toBe(0);
  });
});

describe("a draw that moves no card", () => {
  it("does not advance the ordinal when deck and trash are both empty", () => {
    // Burn Out cannot refill an empty deck from an empty trash, so `drawCards`
    // RETURNS EARLY having moved nothing. An ordinal advanced there would drift
    // past the boundary without a card ever arriving, and the next real draw
    // would fire her on what is actually the first card.
    //
    // **The early return is what protects this, and nothing else does.** A guard
    // after the draw was written for it and deleted as unreachable: by that point
    // the deck is non-empty either way, so the guard never ran. Mutation testing
    // is what said so — removing it left this test green.
    const { state } = board(0);
    state.players[0]!.trash = [];

    const after = drawCards(state, 0, 2);
    expect(after.players[0]!.cardsDrawnThisTurn, "an impossible draw counted").toBe(0);
    expect(after.players[0]!.hand, "a card appeared from nowhere").toHaveLength(0);
  });

  it("POSITIVE CONTROL: the same fixture with a deck does advance it", () => {
    const { state } = board(2);
    expect(drawCards(state, 0, 2).players[0]!.cardsDrawnThisTurn, "the counter never moves at all").toBe(2);
  });
});

describe("coverage", () => {
  it("reports her finished, claimed by both registries she uses", () => {
    const def = registry.get(FRIGID_JEWEL);
    expect(isCardImplemented(def), "she still reports unfinished").toBe(true);
    expect(partialImplementationNote(def), "she carries a partial note").toBeUndefined();
    expect(implementingModules(FRIGID_JEWEL)).toContain("event triggers");
    expect(implementingModules(FRIGID_JEWEL), "the question is not claimed").toContain("pending decisions");
  });

  it("the ordinal she watches is the printed one", () => {
    expect(JEWEL_NTH, "the card says SECOND").toBe(2);
  });
});
