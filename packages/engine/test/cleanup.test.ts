import { describe, expect, it } from "vitest";
import { runCleanup } from "../src/engine/cleanup.js";
import { submit } from "../src/engine/game-engine.js";
import type { BattlefieldState, GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit } from "./fixtures.js";

/** Two battlefields, with whichever units/controller each case needs. */
function withBattlefields(
  bfs: { id: string; controllerId: string | null; units?: Record<string, ReturnType<typeof makeUnit>[]> }[],
  overrides: Partial<GameState> = {},
): GameState {
  const battlefields: BattlefieldState[] = bfs.map((b) => ({
    id: b.id,
    name: b.id,
    controllerId: b.controllerId,
    units: b.units ?? {},
    contestedByIndex: null,
    hiddenCards: [],
  }));
  return makeState({ battlefields, ...overrides });
}

/**
 * Cleanup step 4 — rule 323.11: "Players lose control of any controlled
 * Battlefields without their Units occupying them if the turn is in an Open State
 * and there is no Showdown or Combat ongoing there." Same statement from the
 * Control side in rule 190.6.
 *
 * Before this, control was only lost via combat's mutual-wipe branch, so a player
 * who moved or recalled their last unit away kept control of an empty
 * battlefield — an illegal state, and a scoring dead end that froze games (see
 * the integration test at the bottom).
 */
describe("cleanup: unoccupied control lapses (rule 323.11 step 4 / 190.6)", () => {
  it("lapses control when the controller has no units there", () => {
    const state = withBattlefields([{ id: "bf-0", controllerId: "p1" }]);
    expect(runCleanup(state).battlefields[0]!.controllerId).toBeNull();
  });

  it("keeps control while the controller still has a unit there", () => {
    const state = withBattlefields([{ id: "bf-0", controllerId: "p1", units: { p1: [makeUnit()] } }]);
    expect(runCleanup(state).battlefields[0]!.controllerId).toBe("p1");
  });

  it("ignores battlefields that are already Uncontrolled", () => {
    const state = withBattlefields([{ id: "bf-0", controllerId: null }]);
    expect(runCleanup(state)).toBe(state); // same object — nothing to change
  });

  it("does NOT lapse while the turn is in a Closed State (a Spell is on the chain)", () => {
    // Rule 310: "If a Chain exists, the turn is in a Closed State" — and step 4
    // only applies in an Open State. It'll lapse once the chain resolves.
    const state = withBattlefields([{ id: "bf-0", controllerId: "p1" }], { chainOpen: false });
    expect(runCleanup(state).battlefields[0]!.controllerId).toBe("p1");
  });

  it("does NOT lapse at a battlefield with an ongoing Showdown", () => {
    // Rule 190.6: "While a Combat or Showdown is ongoing at a Battlefield,
    // Control of that Battlefield cannot change until instructed by steps of the
    // Combat or Showdown."
    const state = withBattlefields([{ id: "bf-0", controllerId: "p1" }], {
      turnState: "Showdown",
      showdownBattlefieldId: "bf-0",
    });
    expect(runCleanup(state).battlefields[0]!.controllerId).toBe("p1");
  });

  it("still lapses OTHER battlefields while a Showdown runs somewhere else", () => {
    // "unless there is a Combat or Showdown ongoing THERE" — the exception is
    // per-battlefield, not a blanket freeze. This is the real case of moving your
    // last unit off bf-0 into a contested bf-1.
    const state = withBattlefields(
      [
        { id: "bf-0", controllerId: "p1" },
        { id: "bf-1", controllerId: "p1", units: { p1: [makeUnit()] } },
      ],
      { turnState: "Showdown", showdownBattlefieldId: "bf-1" },
    );
    const next = runCleanup(state);
    expect(next.battlefields[0]!.controllerId).toBeNull();
    expect(next.battlefields[1]!.controllerId).toBe("p1");
  });

  it("lapses only the unoccupied controller, not a battlefield the opponent occupies", () => {
    // p1 controls bf-0 but only p2 has units there (a contested leftover). p1 has
    // no units there, so p1's control lapses — the battlefield becomes
    // Uncontrolled rather than silently flipping to p2, since establishing
    // control is combat's job (rule 466.7), not the cleanup's.
    const state = withBattlefields([{ id: "bf-0", controllerId: "p1", units: { p2: [makeUnit()] } }]);
    expect(runCleanup(state).battlefields[0]!.controllerId).toBeNull();
  });
});

describe("cleanup step 6: staging Showdowns at Contested battlefields (323 / 341)", () => {
  it("opens a Non-Combat Showdown when only one player's units are there (317.1)", () => {
    const state = withBattlefields([{ id: "bf-0", controllerId: null, units: { p1: [makeUnit()] } }]);
    const contested: GameState = {
      ...state,
      battlefields: [{ ...state.battlefields[0]!, contestedByIndex: 0 as const }],
    };
    const next = runCleanup(contested);
    expect(next.turnState).toBe("Showdown");
    expect(next.showdownKind).toBe("NonCombat");
    expect(next.showdownBattlefieldId).toBe("bf-0");
    expect(next.focusHolder).toBe(0); // whoever applied Contested (345)
  });

  it("opens a COMBAT Showdown when units of different players are there (341)", () => {
    const state = withBattlefields([{ id: "bf-0", controllerId: "p2", units: { p1: [makeUnit()], p2: [makeUnit()] } }]);
    const contested: GameState = {
      ...state,
      battlefields: [{ ...state.battlefields[0]!, contestedByIndex: 0 as const }],
    };
    expect(runCleanup(contested).showdownKind).toBe("Combat");
  });

  it("stages nothing while the chain is closed or another Showdown runs (341's Neutral Open State)", () => {
    const base = withBattlefields([{ id: "bf-0", controllerId: null, units: { p1: [makeUnit()] } }]);
    const contested = { ...base, battlefields: [{ ...base.battlefields[0]!, contestedByIndex: 0 as const }] };

    expect(runCleanup({ ...contested, chainOpen: false }).turnState).toBe("Neutral");
    // Already in a Showdown elsewhere: the battlefield stays Contested for a
    // later Cleanup rather than opening a second simultaneous window.
    const during: GameState = { ...contested, turnState: "Showdown", showdownBattlefieldId: "bf-1", showdownKind: "NonCombat" };
    expect(runCleanup(during).showdownBattlefieldId).toBe("bf-1");
    expect(runCleanup(during).battlefields[0]!.contestedByIndex).toBe(0);
  });

  it("promotes a Non-Combat Showdown to Combat once another player's units arrive (317.2)", () => {
    // Reachable now that an opponent holding Focus can cast a token-making Spell
    // into someone else's window at Action speed.
    const state = withBattlefields([{ id: "bf-0", controllerId: null, units: { p1: [makeUnit()], p2: [makeUnit()] } }]);
    const open: GameState = {
      ...state,
      turnState: "Showdown",
      showdownBattlefieldId: "bf-0",
      showdownKind: "NonCombat",
    };
    expect(runCleanup(open).showdownKind).toBe("Combat");
  });

  it("leaves a Non-Combat Showdown alone while only its own units are there", () => {
    const state = withBattlefields([{ id: "bf-0", controllerId: null, units: { p1: [makeUnit()] } }]);
    const open: GameState = {
      ...state,
      turnState: "Showdown",
      showdownBattlefieldId: "bf-0",
      showdownKind: "NonCombat",
    };
    expect(runCleanup(open).showdownKind).toBe("NonCombat");
  });
});

describe("cleanup runs after every action, so the frozen-board state can't happen", () => {
  /** Walking a ready base unit onto `bf-0`, whatever that battlefield's control
   *  currently says. The ONLY difference between the two cases below. */
  function walkIntoBf0(controllerId: string | null) {
    const unit = makeUnit({ name: "Returning Hero" });
    const state: GameState = withBattlefields([{ id: "bf-0", controllerId }], {
      players: [makePlayer("p1", { baseUnits: [unit] }), makePlayer("p2")],
      phase: "Action",
    });
    return submit(state, { type: "MoveUnit", playerIndex: 0, unitInstanceIds: [unit.instanceId], destinationBattlefieldId: "bf-0" });
  }

  /** Walks in, then closes the Non-Combat Showdown the walk-in now opens — since
   *  rule 352.1 moved control establishment to the window's close, "did walking
   *  back in reclaim it" can only be asked after the passes. */
  function walkInAndSettle(controllerId: string | null) {
    let { state } = walkIntoBf0(controllerId);
    state = submit(state, { type: "PassFocus", playerIndex: 0 }).state;
    state = submit(state, { type: "PassFocus", playerIndex: 1 }).state;
    return state;
  }

  it("re-occupying a battlefield whose control has lapsed is a Conquer worth a point", () => {
    // The state the cleanup guarantees after you vacate: Uncontrolled. So walking
    // back in is a genuine control change — established when the Non-Combat
    // Showdown closes (352.1) rather than on the spot.
    const state = walkInAndSettle(null);
    expect(state.battlefields[0]!.controllerId).toBe("p1");
    expect(state.players[0]!.points).toBe(1);
  });

  it("...whereas re-occupying one you still 'control' scores nothing — the dead end this fixes", () => {
    // The illegal state that used to persist: controlled but unoccupied. Walking
    // back in changes no control, so there's no Conquer — and Hold can't score it
    // either, because scoring.isHeldBy requires units present at the Beginning
    // Phase and the board only reaches this shape once the units have left. Two
    // battlefields stuck like this with empty rune decks is the freeze.
    //
    // It also opens no window at all: 458 only contests a destination you don't
    // already control, so there are no passes to make here.
    const { state } = walkIntoBf0("p1");
    expect(state.turnState).toBe("Neutral");
    expect(state.battlefields[0]!.controllerId).toBe("p1");
    expect(state.players[0]!.points).toBe(0);
  });

  it("a RecallUnit that empties a controlled battlefield lapses it too", () => {
    const unit = makeUnit({ name: "Homebody" });
    const state: GameState = withBattlefields([{ id: "bf-0", controllerId: "p1", units: { p1: [unit] } }], {
      players: [makePlayer("p1"), makePlayer("p2")],
      phase: "Action",
    });

    const recalled = submit(state, { type: "RecallUnit", playerIndex: 0, unitInstanceIds: [unit.instanceId] });
    expect(recalled.result.type).toBe("Ok");
    expect(recalled.state.battlefields[0]!.controllerId).toBeNull();
    expect(recalled.state.players[0]!.baseUnits).toHaveLength(1);
  });
});
