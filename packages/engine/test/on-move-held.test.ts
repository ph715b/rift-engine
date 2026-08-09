import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { pendingDecision } from "../src/engine/decisions.js";
import { holdMoveTrigger } from "../src/engine/unit-triggers.js";
import { destroyUnit } from "../src/engine/effect-helpers.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { answerDecisions, makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * On-move triggers as Chain Pending Items (383).
 *
 * Structurally the on-PLAY conversion again, and it reuses that machinery rather
 * than inventing a second shape: these are keyed by the MOVING unit's defId, so
 * the listener IS the unit that acted, and the entry needs a `source`
 * discriminant to say which registry resolves it. `"unitOnMove"` is the third.
 *
 * **What had to be CARRIED, and why this family was blocked on it.** The plan
 * listed on-move as needing "action-time choices that are destroyed by the time
 * this runs", and `isFirstMoveThisTurn` is the whole of it — Miss Fortune -
 * Captain's "the FIRST time I move each turn". The executor computes it from
 * `unit.movesThisTurn` BEFORE incrementing, so by the time a held trigger
 * resolves the unit already shows one move and re-deriving the answer gives
 * FALSE. A held on-move trigger that read the board would therefore never fire
 * for her at all, which is the sharpest test in this file.
 *
 * **The unit is NOT required to still be in play**, exactly as for on-play:
 * 809.1.b makes an ability on the Chain independent of the card that made it.
 * That is the opposite of an event-registry listener, which is a bystander and
 * must still be there to act.
 */

const registry = defaultCardRegistry();
const TRAVELING_MERCHANT = "OGN-185";
const NOXIAN_DRUMMER = "OGN-222";
const MISS_FORTUNE_CAPTAIN = "OGN-162";

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `action was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** Move `unit` from base to `battlefieldId` through the real action path. */
function move(state: GameState, unit: UnitInstance, battlefieldId = "bf1"): GameState {
  const action = legalActions(state).find(
    (a) =>
      a.type === "MoveUnit" &&
      (a as { destinationBattlefieldId?: string }).destinationBattlefieldId === battlefieldId &&
      ((a as { unitInstanceIds?: string[] }).unitInstanceIds ?? []).includes(unit.instanceId),
  );
  expect(action, `a move of ${unit.name} to ${battlefieldId} was never enumerated`).toBeDefined();
  return accept(state, action);
}

const heldNames = (state: GameState): string[] =>
  state.spellChain.filter((e) => "kind" in e && e.kind === "trigger").map((e) => (e as { listenerName: string }).listenerName);

/** `unit` in p1's base, with an uncontested empty battlefield to walk into — so
 *  the move opens no combat and nothing but the on-move trigger is in play. */
function moverState(unit: UnitInstance): GameState {
  const state = makeState({ phase: "Action" });
  state.players[0]!.baseUnits = [unit];
  return state;
}

describe("Traveling Merchant (OGN-185): when I move, discard 1 then draw 1", () => {
  function merchantState(): { state: GameState; merchant: UnitInstance } {
    const merchant = realUnitInstance(TRAVELING_MERCHANT);
    const state = moverState(merchant);
    state.players[0]!.hand = [makeUnit({ name: "Discarded" })];
    state.players[0]!.deck = [makeUnit({ name: "Drawn" })];
    return { state, merchant };
  }

  it("does not resolve inside the move — it waits on the chain", () => {
    const { state, merchant } = merchantState();

    const moved = move(state, merchant);

    expect(moved.players[0]!.trash, "the trigger resolved inside the move").toHaveLength(0);
    expect(heldNames(moved)).toContain(registry.get(TRAVELING_MERCHANT).name);
  });

  it("discards then draws when the chain pops it", () => {
    const { state, merchant } = merchantState();

    const settled = resolveHeldTriggers(move(state, merchant));

    expect(settled.players[0]!.trash.map((c) => c.name)).toEqual(["Discarded"]);
    expect(settled.players[0]!.hand.map((c) => c.name)).toEqual(["Drawn"]);
  });
});

describe("Noxian Drummer (OGN-222): when I move to a battlefield, play a Recruit token here", () => {
  it("places the token only once the chain pops it, and at the battlefield it moved to", () => {
    const drummer = realUnitInstance(NOXIAN_DRUMMER);
    const state = moverState(drummer);

    const moved = move(state, drummer, "bf2");
    expect((moved.battlefields[1]!.units["p1"] ?? []).filter((u) => u.isToken), "the token arrived inside the move").toHaveLength(0);

    const settled = resolveHeldTriggers(moved);

    // "HERE" is where it moved, carried on the entry rather than re-derived —
    // by resolution the Drummer could have been moved again or killed.
    expect((settled.battlefields[1]!.units["p1"] ?? []).filter((u) => u.isToken)).toHaveLength(1);
    expect((settled.battlefields[0]!.units["p1"] ?? []).filter((u) => u.isToken)).toHaveLength(0);
  });

  it("still places it when the Drummer dies in the response window (809.1.b)", () => {
    // An ability on the Chain is independent of the card that made it. The
    // opposite of an event-registry listener, which bails when it has gone.
    const drummer = realUnitInstance(NOXIAN_DRUMMER);
    const state = moverState(drummer);

    const moved = move(state, drummer, "bf2");
    const settled = resolveHeldTriggers(destroyUnit(moved, drummer.instanceId, 1));

    expect((settled.battlefields[1]!.units["p1"] ?? []).filter((u) => u.isToken)).toHaveLength(1);
  });
});

describe("Miss Fortune - Captain (OGN-162): the FIRST time I move each turn", () => {
  function captainState(): { state: GameState; captain: UnitInstance; ally: UnitInstance } {
    const captain = realUnitInstance(MISS_FORTUNE_CAPTAIN);
    const ally = makeUnit({ name: "Ally", ...({ exhausted: true } as Partial<UnitInstance>) });
    const state = moverState(captain);
    state.players[0]!.baseUnits = [captain, ally];
    return { state, captain, ally };
  }

  it("asks nothing during the move, and asks when the chain pops it", () => {
    const { state, captain } = captainState();

    const moved = move(state, captain);
    expect(moved.pendingDecisions, "the trigger resolved inside the move").toHaveLength(0);
    expect(heldNames(moved)).toContain(registry.get(MISS_FORTUNE_CAPTAIN).name);

    const settled = resolveHeldTriggers(moved);

    // THE test for the carried payload. `isFirstMoveThisTurn` is computed from
    // `movesThisTurn` BEFORE the executor increments it, so at this point the
    // Captain shows one move — a resolver that re-derived the answer from the
    // board would find "not the first" and never ask at all.
    expect(pendingDecision(settled)?.kind).toBe("OGN-162-ready");
  });

  it("readies the chosen permanent once answered", () => {
    const { state, captain, ally } = captainState();

    const settled = answerDecisions(resolveHeldTriggers(move(state, captain)), (options) =>
      options.find((o) => o.instanceId === ally.instanceId)!.id,
    );

    expect(settled.players[0]!.baseUnits.find((u) => u.instanceId === ally.instanceId)!.exhausted).toBe(false);
  });

  it("is not PLACED on a later move in the same turn", () => {
    // Asserted on the PEN, and that is the whole assertion: "the first time each
    // turn" is a requirement besides moving, so 383.4 settles it when the move
    // happens and a later move must place NOTHING. A Pending Item that closes the
    // chain, costs both players a PassFocus and then resolves to nothing is an
    // ability that never triggered pretending it did — and a board-level check
    // ("no question was asked") cannot tell those two apart.
    //
    // Driven at the hold rather than through a second `MoveUnit`, because a
    // Standard Move exhausts as a cost (414.3.a): a second real move needs her
    // readied first, which drags an unrelated mechanism into a test about one
    // predicate. `holdMoveTrigger` is the engine's own entry point.
    const { state, captain } = captainState();

    const later = holdMoveTrigger(state, captain, 0, { battlefieldId: "bf1", isFirstMoveThisTurn: false });

    expect(later.pendingTriggers).toHaveLength(0);
    // ...and the control: the SAME call with the same board does place one when
    // it really is her first move, so the empty pen above is the predicate rather
    // than the fixture.
    expect(holdMoveTrigger(state, captain, 0, { battlefieldId: "bf1", isFirstMoveThisTurn: true }).pendingTriggers).toHaveLength(1);
  });
});
