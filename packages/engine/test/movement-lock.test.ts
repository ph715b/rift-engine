import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { unitMayMoveToBase, unitMayMoveThisTurn } from "../src/engine/battlefield-continuous.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { makeState, makeUnit, realUnitInstance } from "./fixtures.js";

/**
 * **The per-unit movement restrictions — two cards, one seam.**
 *
 * Everything that could stop a unit moving was about the BOARD: Vilemaw's Lair
 * blocks a battlefield, Minotaur Reckoner blocks everybody. Two cards need it to
 * be about ONE unit, and both had been refused for waves:
 *
 *   - **Determined Sentry (UNL-111)** — "I can't move to base." His whole
 *     printed text. A fact about him, so `mayMoveToBaseFrom` could not hold it.
 *   - **Vex - Apathetic (UNL-150)** — "[Stun] an enemy unit. They can't move it
 *     this turn." A lock on one body for one turn, and
 *     `UnitInstance.movesThisTurn` is a COUNT rather than a lock.
 *
 * # 456.3 is why combat is untouched
 *
 * A corrective Recall is not a Move, so "can't MOVE to base" does not reach the
 * Combat Cleanup's step-3d. That path goes through `relocateToBaseUnchanged`,
 * which calls neither predicate — asserted below rather than assumed, because it
 * is the one place a movement restriction would strand a losing side's survivors.
 */

const registry = defaultCardRegistry();
const DETERMINED_SENTRY = "UNL-111";

/** `units` on player 0's side of bf1, in their Action phase. */
function atBf1(units: UnitInstance[]): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.battlefields[0] = { ...state.battlefields[0]!, units: { p1: units } };
  return state;
}

const recallsOf = (state: GameState, instanceId: string) =>
  legalActions(state).filter((a) => a.type === "RecallUnit" && a.unitInstanceIds.includes(instanceId));

describe("Determined Sentry (UNL-111): 'I can't move to base'", () => {
  it("is offered no recall, while the unit beside him is", () => {
    // Both halves off ONE board: a bystander at the same battlefield proves the
    // fixture can produce a recall at all, so "none offered" is about the Sentry
    // and not about an unrecallable position.
    const sentry = realUnitInstance(DETERMINED_SENTRY);
    const bystander = makeUnit({ instanceId: "bystander", name: "Bystander", might: 3 });
    const state = atBf1([sentry, bystander]);

    expect(recallsOf(state, "bystander").length, "nothing was recallable — the fixture proves nothing").toBeGreaterThan(0);
    expect(recallsOf(state, sentry.instanceId), "the Sentry was offered a way home").toEqual([]);
  });

  it("the validator refuses a hand-built recall too", () => {
    // The enumerate/execute split. A restriction in the enumerator alone lets a
    // hand-built or stale action walk him home.
    const sentry = realUnitInstance(DETERMINED_SENTRY);
    const state = atBf1([sentry]);

    const { result } = submit(state, {
      type: "RecallUnit",
      playerIndex: 0,
      unitInstanceIds: [sentry.instanceId],
    });
    expect(result, "a hand-built recall walked him home").toMatchObject({ type: "Invalid" });
  });

  it("the predicate is his alone", () => {
    const state = atBf1([]);
    const sentry = realUnitInstance(DETERMINED_SENTRY);
    const other = makeUnit({ name: "Other", might: 3 });

    expect(unitMayMoveToBase(state, sentry, "bf1"), "the Sentry may go home").toBe(false);
    expect(unitMayMoveToBase(state, other, "bf1"), "the restriction leaked onto every unit").toBe(true);
  });
});

describe("Vex - Apathetic (UNL-150): 'they can't move it this turn'", () => {
  /** A board where `locked` is under the lock and `free` is not. */
  function locked(): { state: GameState; lockedId: string; freeId: string } {
    const lockedUnit = makeUnit({ instanceId: "locked", name: "Locked", might: 3 });
    const free = makeUnit({ instanceId: "free", name: "Free", might: 3 });
    const state = atBf1([lockedUnit, free]);
    state.movementLockedUnitInstanceIds = ["locked"];
    // A second battlefield to move TO, and [Ganking] so the move is otherwise
    // legal — the lock must be the only thing stopping it.
    state.battlefields[1] = { ...state.battlefields[1]!, units: { p1: [] } };
    return { state, lockedId: "locked", freeId: "free" };
  }

  it("is offered no recall, while an unlocked unit beside it is", () => {
    const { state, lockedId, freeId } = locked();
    expect(recallsOf(state, freeId).length, "nothing was recallable — the fixture proves nothing").toBeGreaterThan(0);
    expect(recallsOf(state, lockedId), "a locked unit was offered a move").toEqual([]);
  });

  it("the validator refuses a hand-built move too", () => {
    const { state, lockedId } = locked();
    const { result } = submit(state, {
      type: "RecallUnit",
      playerIndex: 0,
      unitInstanceIds: [lockedId],
    });
    expect(result, "a hand-built move ignored the lock").toMatchObject({ type: "Invalid" });
  });

  it("locks the BODY, not the card — an untouched copy still moves", () => {
    // Instance ids, not defIds. Two copies of one card must not share a lock.
    const { state } = locked();
    expect(unitMayMoveThisTurn(state, "locked"), "the lock did not take").toBe(false);
    expect(unitMayMoveThisTurn(state, "free"), "the lock reached a unit Vex never pointed at").toBe(true);
  });

  it("expires with the turn", () => {
    // The sweep. A unit still frozen on a board its jailer never saw is the bug
    // every other this-turn field in `runEnd` exists to prevent.
    const { state } = locked();
    // `runEnd` runs FROM the Action phase — it is what ends the turn, not a
    // step inside an Ending phase that already exists.
    const ended = runEnd(state);
    expect(ended.movementLockedUnitInstanceIds, "the lock outlived the turn").toEqual([]);
  });

  it("is NOT the same as exhaustion — a readied unit stays locked", () => {
    // The case that made `exhausted` an insufficient stand-in, and the whole
    // reason the lock is its own field.
    const { state, lockedId } = locked();
    const readied: GameState = {
      ...state,
      battlefields: state.battlefields.map((bf, i) =>
        i === 0
          ? { ...bf, units: { p1: (bf.units["p1"] ?? []).map((u) => ({ ...u, exhausted: false })) } }
          : bf,
      ) as GameState["battlefields"],
    };
    expect(unitMayMoveThisTurn(readied, lockedId), "readying the unit cleared the lock").toBe(false);
  });
});

describe("coverage", () => {
  it("both cards are whole, with no partial note left", () => {
    for (const id of [DETERMINED_SENTRY, "UNL-150"]) {
      expect(isCardImplemented(registry.get(id)), `${id} is greyed`).toBe(true);
      expect(partialImplementationNote(registry.get(id)), `${id} still names a missing half`).toBeUndefined();
    }
  });
});
