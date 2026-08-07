import { describe, expect, it } from "vitest";
import {
  banishCard,
  completeDeath,
  destroyUnit,
  recycleUnitFromPlayToDeck,
  returnUnitToHand,
} from "../src/engine/effect-helpers.js";
import { killGear } from "../src/engine/triggers.js";
import { createToken, createGearToken, GOLD_TOKEN, SAND_SOLDIER_TOKEN } from "../src/engine/token.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit } from "./fixtures.js";

/**
 * **A token is not a card, and cannot rest anywhere a card rests.**
 *
 * Rule 714: "Tokens are Created on the board or the Chain and CANNOT EXIST
 * ELSEWHERE." Rule 715: "If a token is put into any Non-Board Zone besides the
 * chain, it CEASES TO EXIST immediately after moving to its new zone."
 *
 * Reported from play: a token could be bounced to hand or left sitting in a
 * trash. `isToken` was on every token instance and read by exactly two cards,
 * while every zone transition treated a token as a card — so a Sand Soldier
 * bounced by Charm became a permanent 0-cost card in hand, and every token that
 * ever died padded its owner's trash (which Rhasa the Sunderer prices himself
 * off, and which `recycleFromTrash` can draw back).
 *
 * The token still ARRIVES — 715 says it ceases to exist "immediately AFTER
 * moving to its new zone" — so everything watching the arrival still fires. The
 * death half of that is asserted here, because dropping the token earlier would
 * silently cost a token's [Deathknell] and every death-watch trigger.
 */

function board(): { state: GameState; token: ReturnType<typeof createToken> } {
  const token = createToken(SAND_SOLDIER_TOKEN);
  const state = makeState({
    phase: "Action",
    players: [makePlayer("p1", { baseUnits: [token] }), makePlayer("p2")],
  });
  return { state, token };
}

describe("a token that leaves the board ceases to exist (rules 714/715)", () => {
  it("does NOT rest in the trash when it dies", () => {
    const { state, token } = board();
    const after = destroyUnit(state, token.instanceId, 0);

    expect(after.players[0]!.baseUnits, "the token is still on the board").toHaveLength(0);
    expect(after.players[0]!.trash.map((c) => c.instanceId), "the token went to the trash").not.toContain(
      token.instanceId,
    );
  });

  /**
   * The other half of 715, and the reason the token is dropped from the ZONE
   * rather than short-circuited out of the move: it really does die, so the
   * death is still counted and every death trigger still gets its moment.
   * Dropping it earlier would silently delete a token's [Deathknell].
   */
  it("still DIES on the way — the death is counted, only the resting place is denied", () => {
    const { state, token } = board();
    const after = completeDeath(state, { unit: token, ownerIndex: 0, killerIndex: 1 });

    expect(after.players[0]!.unitsLostThisTurn, "the death was not counted").toBe(1);
    expect(after.players[0]!.trash).toHaveLength(0);
  });

  it("does NOT go to hand when bounced", () => {
    const { state, token } = board();
    const after = returnUnitToHand(state, token.instanceId);

    expect(after.players[0]!.baseUnits).toHaveLength(0);
    expect(after.players[0]!.hand.map((c) => c.instanceId), "the token was bounced INTO HAND").not.toContain(
      token.instanceId,
    );
  });

  it("does NOT go to the deck when recycled", () => {
    const { state, token } = board();
    const after = recycleUnitFromPlayToDeck(state, 0, token.instanceId);

    expect(after.players[0]!.baseUnits).toHaveLength(0);
    expect(after.players[0]!.deck.map((c) => c.instanceId), "the token was shuffled into the deck").not.toContain(
      token.instanceId,
    );
  });

  it("does NOT rest in banishment", () => {
    const { state, token } = board();
    // 2353 says the same thing for banishment specifically: a replaced token
    // "will stop existing once it begins its occupancy in Banishment".
    const withToken: GameState = {
      ...state,
      players: [{ ...state.players[0]!, trash: [token], baseUnits: [] }, state.players[1]!],
    };
    const after = banishCard(withToken, 0, token.instanceId);

    expect(after.players[0]!.banished.map((c) => c.instanceId)).not.toContain(token.instanceId);
  });

  it("applies to GEAR tokens too — the Gold tokens", () => {
    const gold = createGearToken(GOLD_TOKEN, false);
    const state = makeState({
      phase: "Action",
      players: [makePlayer("p1", { activeGear: [gold] }), makePlayer("p2")],
    });
    const after = killGear(state, gold, 0);

    expect(after.players[0]!.activeGear).toHaveLength(0);
    expect(after.players[0]!.trash.map((c) => c.instanceId), "a Gold token rested in the trash").not.toContain(
      gold.instanceId,
    );
  });
});

/**
 * The positive controls. Every assertion above is a NON-containment, and a
 * non-containment passes just as happily against a helper that dropped
 * everything — which is exactly how a filter comes to delete real cards.
 */
describe("a real CARD is unaffected — the control that keeps the filter honest", () => {
  function realCard() {
    const unit = makeUnit({ name: "Real", instanceId: "real" });
    expect(unit.isToken, "the fixture must not be a token, or this proves nothing").toBeFalsy();
    const state = makeState({
      phase: "Action",
      players: [makePlayer("p1", { baseUnits: [unit] }), makePlayer("p2")],
    });
    return { state, unit };
  }

  it("still goes to the trash when it dies", () => {
    const { state, unit } = realCard();
    const after = destroyUnit(state, unit.instanceId, 0);
    expect(after.players[0]!.trash.map((c) => c.instanceId)).toContain("real");
  });

  it("still goes to hand when bounced", () => {
    const { state, unit } = realCard();
    const after = returnUnitToHand(state, unit.instanceId);
    expect(after.players[0]!.hand.map((c) => c.instanceId)).toContain("real");
  });

  it("still goes to the deck when recycled", () => {
    const { state, unit } = realCard();
    const after = recycleUnitFromPlayToDeck(state, 0, unit.instanceId);
    expect(after.players[0]!.deck.map((c) => c.instanceId)).toContain("real");
  });
});
