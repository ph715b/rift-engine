import { describe, expect, it } from "vitest";
import { effectForCard, cardModeOf } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import type { UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, spellInstance } from "./fixtures.js";

/**
 * Smoke Screen (OGN-093, Mind) and Grand Strategem (OGN-233, Order).
 *
 * Everything here goes through `effectForCard`, never the resolver directly:
 * a card that is implemented but not reachable through the composed registry
 * is indistinguishable in play from one that was never written (which is
 * exactly how Cannon Barrage stayed inert), and calling the resolver by hand
 * would pass in both worlds.
 */
function resolve(
  defId: string,
  casterIndex: 0 | 1,
  state: GameState,
  event: Parameters<NonNullable<ReturnType<typeof cardModeOf>>["resolve"]>[2] = {},
): GameState {
  const effect = cardModeOf(spellInstance(defId), undefined)!;
  return effect.resolve(state, contextFor(casterIndex), event);
}

/** Might as the rest of the engine sees it — never the raw `mightThisTurn`
 *  field, which is only half of the answer (a Buff and the continuous auras
 *  live outside it) and which clamping means can disagree with the number
 *  combat actually uses. */
function mightOf(state: GameState, unit: UnitInstance, ownerIndex: 0 | 1, battlefieldId?: string): number {
  const at = findUnit(state, unit.instanceId, ownerIndex);
  return effectiveMight(state, at, ownerIndex, { isCombat: false, ...(battlefieldId ? { battlefieldId } : {}) });
}

function findUnit(state: GameState, instanceId: string, ownerIndex: 0 | 1): UnitInstance {
  const owner = state.players[ownerIndex]!;
  const found =
    owner.baseUnits.find((u) => u.instanceId === instanceId) ??
    state.battlefields.flatMap((bf) => bf.units[owner.id] ?? []).find((u) => u.instanceId === instanceId);
  if (!found) throw new Error(`unit ${instanceId} is not in play for player ${ownerIndex}`);
  return found;
}

describe("Smoke Screen (OGN-093): -4 Might this turn to a unit, minimum 1", () => {
  it("takes 4 off a unit at a battlefield", () => {
    const target = makeUnit({ might: 6 });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [target] };

    state = resolve("OGN-093", 0, state, { targetUnitInstanceId: target.instanceId });

    expect(mightOf(state, target, 1, "bf1")).toBe(2);
  });

  it("floors a small unit at 1 Might rather than driving it negative", () => {
    // A 2-Might unit does not become -2 (nor 0, which is what an unfloored
    // modifier would clamp to and would make the unit dead to any damage).
    const target = makeUnit({ might: 2 });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [target] };

    state = resolve("OGN-093", 0, state, { targetUnitInstanceId: target.instanceId });

    expect(mightOf(state, target, 1, "bf1")).toBe(1);
  });

  it("a second cast cannot dig BELOW the floor, so a later pump starts from 1", () => {
    // The floor caps the stored modifier, not just the displayed Might. Without
    // that, two Smoke Screens on a 5-Might unit would bank -8 and the +2 from
    // Discipline would leave it at 0 instead of 3 — the hole the helper's
    // `floor` argument exists to prevent.
    const target = makeUnit({ might: 5 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [target] };

    state = resolve("OGN-093", 1, state, { targetUnitInstanceId: target.instanceId });
    state = resolve("OGN-093", 1, state, { targetUnitInstanceId: target.instanceId });
    expect(mightOf(state, target, 0, "bf1")).toBe(1);

    state = resolve("OGN-058", 0, state, { targetUnitInstanceId: target.instanceId }); // Discipline, +2
    expect(mightOf(state, target, 0, "bf1")).toBe(3);
  });

  it("reaches a unit standing in a base, either player's", () => {
    // "A unit", not "a unit at a battlefield" — rule 355.9.b puts Bases in the
    // public zones a target may be chosen from, so base is not a safe parking
    // spot from this card. The eight precon cards that got this wrong is why
    // the scope is asserted here as well as exercised.
    const enemyAtHome = makeUnit({ might: 6 });
    const ownAtHome = makeUnit({ might: 6 });
    let state = makeState();
    state.players[1]!.baseUnits = [enemyAtHome];
    state.players[0]!.baseUnits = [ownAtHome];

    expect(cardModeOf(spellInstance("OGN-093"), undefined)!.targeting).toEqual({ kind: "unit", scope: "anywhere" });

    state = resolve("OGN-093", 0, state, { targetUnitInstanceId: enemyAtHome.instanceId });
    expect(mightOf(state, enemyAtHome, 1)).toBe(2);
    expect(mightOf(state, ownAtHome, 0)).toBe(6); // untouched: one unit, not a sweep

    state = resolve("OGN-093", 0, state, { targetUnitInstanceId: ownAtHome.instanceId });
    expect(mightOf(state, ownAtHome, 0)).toBe(2); // no owner restriction is printed
  });

  it("no-ops when the chosen unit has already left play", () => {
    // Reaction speed means this can be sitting on the chain when its target
    // dies; resolving must not throw.
    const gone = makeUnit({ might: 6 });
    const state = makeState();

    expect(() => resolve("OGN-093", 0, state, { targetUnitInstanceId: gone.instanceId })).not.toThrow();
  });
});

describe("Grand Strategem (OGN-233): friendly units get +5 Might this turn", () => {
  it("reaches friendly units in base AND at every battlefield", () => {
    const atHome = makeUnit({ might: 1 });
    const here = makeUnit({ might: 2 });
    const overThere = makeUnit({ might: 3 });
    let state = makeState();
    state.players[0]!.baseUnits = [atHome];
    state.battlefields[0]!.units = { p1: [here] };
    state.battlefields[1]!.units = { p1: [overThere] };

    expect(cardModeOf(spellInstance("OGN-233"), undefined)!.targeting).toEqual({ kind: "none" });

    state = resolve("OGN-233", 0, state);

    expect(mightOf(state, atHome, 0)).toBe(6);
    expect(mightOf(state, here, 0, "bf1")).toBe(7);
    expect(mightOf(state, overThere, 0, "bf2")).toBe(8);
  });

  it("does not touch the opponent's units, even ones sharing a battlefield", () => {
    const friendly = makeUnit({ might: 4 });
    const enemyHere = makeUnit({ might: 4 });
    const enemyAtHome = makeUnit({ might: 4 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [friendly], p2: [enemyHere] };
    state.players[1]!.baseUnits = [enemyAtHome];

    state = resolve("OGN-233", 0, state);

    expect(mightOf(state, friendly, 0, "bf1")).toBe(9);
    expect(mightOf(state, enemyHere, 1, "bf1")).toBe(4);
    expect(mightOf(state, enemyAtHome, 1)).toBe(4);
  });

  it("is friendly to the CASTER, not to player 0", () => {
    // casterIndex, not a hardcoded side: player 2 casting it must pump player
    // 2's board.
    const p1Unit = makeUnit({ might: 4 });
    const p2Unit = makeUnit({ might: 4 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [p1Unit], p2: [p2Unit] };

    state = resolve("OGN-233", 1, state);

    expect(mightOf(state, p2Unit, 1, "bf1")).toBe(9);
    expect(mightOf(state, p1Unit, 0, "bf1")).toBe(4);
  });

  it("stacks with a this-turn debuff instead of replacing it", () => {
    // Two separate this-turn modifiers on the same unit: Smoke Screen's -4
    // (floored at 1) and then +5. A Buff would cap at one per unit; these do
    // not, which is the distinction the two helpers encode.
    const unit = makeUnit({ might: 5 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [unit] };

    state = resolve("OGN-093", 1, state, { targetUnitInstanceId: unit.instanceId }); // 5 -> 1
    state = resolve("OGN-233", 0, state); // +5 on top of the -4

    expect(mightOf(state, unit, 0, "bf1")).toBe(6);
  });
});
