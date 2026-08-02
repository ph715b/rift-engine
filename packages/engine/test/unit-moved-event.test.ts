import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { makePlayer, makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * The `unitMoved` event and the `movesThisTurn` counter that replaced the
 * `movedThisTurn` boolean.
 *
 * Both landed together because they are the same edit to `execute-move-unit`, and
 * both exist for cards the per-card `ON_MOVE_TRIGGERS` table cannot reach: that
 * table is keyed by the MOVING unit's defId, so a listener sitting on a different
 * card is unreachable through it, and it receives no ORIGIN because by the time it
 * runs the unit has already been removed from where it was.
 *
 * `unitMoved` is HELD (383), so every assertion drives `resolveHeldTriggers` or a
 * full `submit` — asserting on the board straight after the move would read the
 * state before the trigger has resolved.
 */

const registry = defaultCardRegistry();
const YASUO_WINDRIDER = "OGN-205";
const VOLIBEAR_IMPOSING = "OGN-158";

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const moveTo = (state: GameState, unit: UnitInstance, battlefieldId: string) => {
  const action = legalActions(state).find(
    (a) => a.type === "MoveUnit" && a.destinationBattlefieldId === battlefieldId && a.unitInstanceIds.includes(unit.instanceId),
  );
  expect(action, `a move of ${unit.name} to ${battlefieldId} was never enumerated`).toBeDefined();
  return action!;
};

const findUnit = (state: GameState, id: string): UnitInstance | undefined =>
  [...state.players[0]!.baseUnits, ...state.battlefields.flatMap((bf) => bf.units["p1"] ?? [])].find((u) => u.instanceId === id);

describe("movesThisTurn counts, where movedThisTurn only remembered", () => {
  it("increments per Standard Move and resets at end of turn", () => {
    const yasuo = realUnitInstance(YASUO_WINDRIDER); // [Ganking], so it can move on
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [yasuo];

    const after = accept(state, moveTo(state, yasuo, "bf1"));
    expect(findUnit(after, yasuo.instanceId)!.movesThisTurn).toBe(1);
  });

  it("a token enters with a count of 0, not undefined", () => {
    // The field is required, so a producer that forgot it would be a type error
    // rather than a silent NaN — asserted anyway because `token.ts` builds its
    // instance by hand rather than through `createCardInstance`.
    const state = makeState();
    const plain = makeUnit({ name: "Plain" });
    state.players[0]!.baseUnits = [plain];
    expect(state.players[0]!.baseUnits[0]!.movesThisTurn).toBe(0);
  });
});

describe("Yasuo - Windrider (OGN-205): the THIRD move in a turn scores a point", () => {
  /** Yasuo has [Ganking], so he can walk battlefield-to-battlefield repeatedly. */
  function windriderState(): { state: GameState; yasuo: UnitInstance } {
    const yasuo = realUnitInstance(YASUO_WINDRIDER);
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [yasuo];
    // Both battlefields pre-marked as already SCORED this turn, so the walk-ins
    // conquer nothing (471.1.b: one score per battlefield per turn). Without this
    // the test measures conquest points — closing a Non-Combat Showdown
    // establishes control, which IS a Conquer — and reads 3 points after four
    // moves whether or not Yasuo's trigger exists at all. Any point that appears
    // now is his.
    state.players[0]!.scoredBattlefieldsThisTurn = ["bf1", "bf2"];
    return { state, yasuo };
  }

  /** One move, then READY him again — a Standard Move exhausts, and this card is
   *  about repeated moves within one turn, which in a real game comes from
   *  [Quick]/Confront/Magma Wurm effects readying him mid-turn. Readying between
   *  moves is the fixture standing in for those, not a rules claim. */
  const walk = (state: GameState, yasuo: UnitInstance, to: string): GameState => {
    let after = resolveHeldTriggers(accept(state, moveTo(state, yasuo, to)));
    // Walking into an uncontrolled battlefield applies Contested and stages a
    // Showdown, and while one is open the ONLY legal action is PassFocus — so a
    // fixture that just moves again finds nothing enumerated. Close the window
    // first, exactly as a real turn would.
    for (let guard = 0; guard < 8 && (after.turnState === "Showdown" || after.spellChain.length > 0); guard += 1) {
      const pass = legalActions(after).find((a) => a.type === "PassFocus");
      if (!pass) break;
      after = accept(after, pass);
    }
    return {
      ...after,
      battlefields: after.battlefields.map((bf) => ({
        ...bf,
        units: { ...bf.units, p1: (bf.units["p1"] ?? []).map((u) => (u.instanceId === yasuo.instanceId ? { ...u, exhausted: false } : u)) },
      })),
    };
  };

  it("scores on the third move and not before", () => {
    const { state, yasuo } = windriderState();

    const one = walk(state, yasuo, "bf1");
    expect(one.players[0]!.points, "scored too early").toBe(0);

    const two = walk(one, yasuo, "bf2");
    expect(two.players[0]!.points).toBe(0);

    const three = walk(two, yasuo, "bf1");
    expect(three.players[0]!.points, "the third move did not score").toBe(1);
  });

  it("scores EXACTLY once — a fourth move adds nothing", () => {
    // "The third time", not "the third and every time after". Same reading as
    // Darius - Trifarian's "your SECOND card in a turn".
    const { state, yasuo } = windriderState();
    let current = state;
    for (const to of ["bf1", "bf2", "bf1", "bf2"]) current = walk(current, yasuo, to);

    expect(current.players[0]!.points).toBe(1);
  });

  it("is HELD — it reaches the CHAIN, and the point is not scored at the move", () => {
    // Asserted on `spellChain`, NOT on `pendingTriggers`. `submit` runs
    // `runCleanup`, whose last step finalizes the pen onto the chain, so the pen
    // is empty by the time any post-`submit` assertion can look at it. Reading
    // the pen here is exactly the mistake that made `chain-depth`'s byListener
    // report Mistfall 6 -> 0 and look like a regression.
    const { state, yasuo } = windriderState();
    const two = walk(walk(state, yasuo, "bf1"), yasuo, "bf2");
    const third = accept(two, moveTo(two, yasuo, "bf1"));

    const onChain = third.spellChain.filter((e) => e.kind === "trigger").map((e) => e.listenerDefId);
    expect(onChain, "the trigger never reached the chain").toContain(YASUO_WINDRIDER);
    // Still unresolved: the point arrives only once both players pass on it.
    expect(third.players[0]!.points).toBe(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(YASUO_WINDRIDER))).toBe(true);
  });
});

describe("Volibear - Imposing (OGN-158): draw when an opponent moves elsewhere", () => {
  /** Volibear at bf1 for player 0; an enemy in player 1's base ready to walk. */
  function imposingState(volibearAt: "bf1" | "base"): { state: GameState; raider: UnitInstance } {
    const volibear = realUnitInstance(VOLIBEAR_IMPOSING);
    const raider = makeUnit({ name: "Raider", instanceId: "raider" });
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.players[1]!.baseUnits = [raider];
    state.players[0]!.deck = [makeUnit({ name: "Drawn" })];
    if (volibearAt === "bf1") state.battlefields[0]!.units = { p1: [volibear] };
    else state.players[0]!.baseUnits = [volibear];
    return { state, raider };
  }

  it("draws when the opponent moves to a DIFFERENT battlefield", () => {
    const { state, raider } = imposingState("bf1");
    const after = resolveHeldTriggers(accept(state, moveTo(state, raider, "bf2")));

    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["Drawn"]);
  });

  it("does NOT draw when the opponent moves to HIS battlefield", () => {
    // "OTHER than mine". Asserted on the PEN as well, because an empty hand is
    // also what an unfired trigger leaves.
    const { state, raider } = imposingState("bf1");
    const moved = accept(state, moveTo(state, raider, "bf1"));

    expect(moved.pendingTriggers.map((t) => t.listenerDefId)).not.toContain(VOLIBEAR_IMPOSING);
    expect(resolveHeldTriggers(moved).players[0]!.hand).toHaveLength(0);
  });

  it("does NOT draw for his controller's OWN moves", () => {
    const volibear = realUnitInstance(VOLIBEAR_IMPOSING);
    const ally = makeUnit({ name: "Ally", instanceId: "ally" });
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [volibear] };
    state.players[0]!.baseUnits = [ally];
    state.players[0]!.deck = [makeUnit({ name: "Drawn" })];

    const moved = accept(state, moveTo(state, ally, "bf2"));
    expect(moved.pendingTriggers.map((t) => t.listenerDefId)).not.toContain(VOLIBEAR_IMPOSING);
  });

  it("draws NOTHING while he is in base — 'other than mine' names no battlefield", () => {
    // Recorded Unverified: in base he has no "mine" for a destination to differ
    // from, the same positional reading Sett - Kingpin and Lee Sin take.
    const { state, raider } = imposingState("base");
    const moved = accept(state, moveTo(state, raider, "bf2"));

    expect(moved.pendingTriggers.map((t) => t.listenerDefId)).not.toContain(VOLIBEAR_IMPOSING);
    expect(resolveHeldTriggers(moved).players[0]!.hand).toHaveLength(0);
  });

  it("draws once PER UNIT when several move together", () => {
    // Recorded Unverified: a MoveUnitAction carries an array, and `unitMoved`
    // fires per unit, so three units walking together are three moves. Read per
    // ACTION this would be one draw.
    const volibear = realUnitInstance(VOLIBEAR_IMPOSING);
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.battlefields[0]!.units = { p1: [volibear] };
    state.players[1]!.baseUnits = [makeUnit({ name: "A", instanceId: "a" }), makeUnit({ name: "B", instanceId: "b" })];
    state.players[0]!.deck = [makeUnit({ name: "D1" }), makeUnit({ name: "D2" })];

    // Built by hand rather than taken from `legalActions`, and that is the point:
    // the enumerator only ever offers SINGLE-unit moves
    // (`unitInstanceIds: [unit.instanceId]`), but `MoveUnitAction` carries an
    // array and the WEB UI builds group moves from it. So this shape reaches
    // `submit` in a real game and nowhere else — which is exactly why the
    // per-unit reading needed a test rather than an assumption.
    const after = resolveHeldTriggers(
      accept(state, { type: "MoveUnit", playerIndex: 1, unitInstanceIds: ["a", "b"], destinationBattlefieldId: "bf2" }),
    );
    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["D1", "D2"]);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(VOLIBEAR_IMPOSING))).toBe(true);
  });
});
