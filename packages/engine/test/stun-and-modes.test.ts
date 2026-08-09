import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { executeActivateAbility } from "../src/actions/execute-activate-ability.js";
import { validateActivateAbility } from "../src/actions/validate-activate-ability.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { addBuff, stunUnit } from "../src/engine/effect-helpers.js";
import { hasKeyword } from "../src/engine/granted-keywords.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit } from "./fixtures.js";

/**
 * Stun (rule 423's Stun section) and Udyr - Wildman, the modal ability it exists
 * for.
 *
 * Stun's two halves pull in opposite directions and are tested separately on
 * purpose: a stunned unit contributes nothing to combat damage, and is no easier
 * to kill. Implementing only the first half would be a plausible reading that
 * makes stunning strictly better than it is.
 */

const registry = defaultCardRegistry();
const UDYR = "OGN-157";
const unit = (defId: string) => createCardInstance(registry.get(defId)) as UnitInstance;

/** Attacker and defender facing each other at bf1, mid-Combat-Showdown. */
function fight(attackerMight: number, defenderMight: number): { state: GameState; attacker: UnitInstance; defender: UnitInstance } {
  const attacker = makeUnit({ name: "Attacker", might: attackerMight });
  const defender = makeUnit({ name: "Defender", might: defenderMight });
  const state = makeState({
    turnState: "Showdown",
    showdownBattlefieldId: "bf1",
    showdownKind: "Combat",
    activePlayerIndex: 0,
  });
  state.battlefields[0]!.units = { p1: [attacker], p2: [defender] };
  return { state, attacker, defender };
}

const survivorsAt = (state: GameState, playerId: string) => state.battlefields[0]!.units[playerId] ?? [];

describe("Stun (rule 423)", () => {
  it("stops the unit contributing its Might to combat damage", () => {
    // A 5-Might attacker would kill a 4-Might defender outright; stunned, it
    // deals nothing and the defender walks away.
    const { state, attacker, defender } = fight(5, 4);
    const stunned = stunUnit(state, attacker.instanceId);

    const after = resolveShowdown(stunned, "bf1", 0);

    expect(survivorsAt(after, "p2").map((u) => u.name)).toEqual(["Defender"]);
    expect(survivorsAt(after, "p2")[0]!.damage).toBe(0);
    void defender;
  });

  it("does NOT make it easier to kill — it still absorbs its full Might", () => {
    // The other half of the same rule: "must still have damage applied to it
    // equal to, or greater than, its full might value to be killed". A stunned
    // 5-Might unit facing 4 damage lives.
    const { state, attacker } = fight(5, 4);

    const after = resolveShowdown(stunUnit(state, attacker.instanceId), "bf1", 0);

    // Checked in BASE, not at the battlefield: Combat step 3d recalls surviving
    // attackers, so "still at bf1" would be false even for a unit that won.
    expect(after.players[0]!.baseUnits.map((u) => u.name)).toEqual(["Attacker"]);
    expect(after.players[0]!.trash).toHaveLength(0);
  });

  it("is binary — a stunned unit cannot be stunned again", () => {
    // "A Stunned Unit can not be Stunned again", and the rules' own example is a
    // card that triggers on stunning and must NOT trigger on the second attempt.
    // Returning the state unchanged is what will make that card correct.
    const { state, attacker } = fight(3, 3);
    const once = stunUnit(state, attacker.instanceId);

    expect(stunUnit(once, attacker.instanceId)).toBe(once);
  });

  it("wears off at end of turn (cleanup step 3d)", () => {
    const { state, attacker } = fight(3, 3);
    const stunned = stunUnit({ ...state, turnState: "Neutral", showdownBattlefieldId: null, showdownKind: null }, attacker.instanceId);
    expect(stunned.battlefields[0]!.units["p1"]![0]!.stunned).toBe(true);

    const after = runEnd(stunned);

    expect(after.battlefields[0]!.units["p1"]![0]!.stunned).toBe(false);
  });

  it("no-ops on a unit that isn't in play", () => {
    const { state } = fight(3, 3);
    expect(stunUnit(state, "nowhere")).toBe(state);
  });
});

describe("Udyr - Wildman: spend my buff, choose one you've not chosen this turn", () => {
  /** Udyr at a battlefield, buffed as many times as asked. */
  function udyrState(buffs = 1): { state: GameState; udyr: UnitInstance } {
    const udyr = unit(UDYR);
    udyr.exhausted = true; // so the "Ready me" mode has something to do
    let state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [udyr], p2: [makeUnit({ name: "Enemy", might: 4 })] };
    for (let i = 0; i < buffs; i += 1) state = addBuff(state, udyr.instanceId);
    return { state, udyr };
  }

  const udyrActions = (state: GameState) =>
    legalActions(state).filter((a) => a.type === "ActivateAbility" && a.permanentInstanceId === state.battlefields[0]!.units["p1"]![0]!.instanceId);

  const modesOffered = (state: GameState) =>
    new Set(udyrActions(state).map((a) => (a.type === "ActivateAbility" ? a.modeId : undefined)));

  it("does NOT have [Ganking] printed — he has to spend a buff for it", () => {
    // Found by writing this negative first, and it was real: the loader sees the
    // brackets in the MODE text and had been giving him the keyword permanently,
    // so he could move battlefield-to-battlefield all game without paying the
    // buff his card charges for it. Same shape as Raging Soul and Bilgewater
    // Bully, one level deeper inside the text.
    const { state } = udyrState(1);
    expect(unit(UDYR).keywords).toEqual({});
    expect(hasKeyword(state, state.battlefields[0]!.units["p1"]![0]!, 0, "Ganking")).toBe(false);
  });

  it("offers all four modes while buffed", () => {
    const { state } = udyrState();
    expect(modesOffered(state)).toEqual(new Set(["damage", "stun", "ready", "ganking"]));
  });

  it("offers nothing at all unbuffed — the cost is the buff (702.2.b.1)", () => {
    const { state } = udyrState(0);
    expect(udyrActions(state)).toHaveLength(0);
  });

  it("spends the buff and does NOT exhaust him — there is no exhaust in the cost", () => {
    // The same reading Vi - Destructive needed: assuming an exhaust would cap a
    // four-mode card at one use and make three of its modes unreachable.
    const { state } = udyrState();
    const ready = udyrActions(state).find((a) => a.type === "ActivateAbility" && a.modeId === "ready")!;

    const after = executeActivateAbility(state, ready as never);
    const udyrNow = after.battlefields[0]!.units["p1"]![0]!;

    expect(udyrNow.buffed).toBe(false);
    expect(udyrNow.exhausted).toBe(false); // the "Ready me" mode's own doing
  });

  it("will not offer the same mode twice in one turn", () => {
    const { state } = udyrState(1);
    const stun = udyrActions(state).find((a) => a.type === "ActivateAbility" && a.modeId === "stun")!;

    const after = addBuff(executeActivateAbility(state, stun as never), state.battlefields[0]!.units["p1"]![0]!.instanceId);

    expect(modesOffered(after).has("stun")).toBe(false);
    expect(modesOffered(after).has("damage")).toBe(true); // the others are untouched
  });

  it("refuses a mode already spent, even if the action is forged", () => {
    const { state } = udyrState(1);
    const stun = udyrActions(state).find((a) => a.type === "ActivateAbility" && a.modeId === "stun")!;
    const after = addBuff(executeActivateAbility(state, stun as never), state.battlefields[0]!.units["p1"]![0]!.instanceId);

    expect(validateActivateAbility(after, stun as never).ok).toBe(false);
  });

  it("gets all four back next turn", () => {
    const { state } = udyrState(1);
    const stun = udyrActions(state).find((a) => a.type === "ActivateAbility" && a.modeId === "stun")!;
    const spent = executeActivateAbility(state, stun as never);

    const nextTurn = addBuff(runEnd(spent), state.battlefields[0]!.units["p1"]![0]!.instanceId);

    expect(modesOffered({ ...nextTurn, phase: "Action", activePlayerIndex: 0 }).has("stun")).toBe(true);
  });

  it("the damage mode really deals 2, and the stun mode really stuns", () => {
    const { state } = udyrState(1);
    const enemyId = state.battlefields[0]!.units["p2"]![0]!.instanceId;

    const damage = udyrActions(state).find(
      (a) => a.type === "ActivateAbility" && a.modeId === "damage" && a.targetUnitInstanceId === enemyId,
    )!;
    expect(executeActivateAbility(state, damage as never).battlefields[0]!.units["p2"]![0]!.damage).toBe(2);

    const stun = udyrActions(state).find(
      (a) => a.type === "ActivateAbility" && a.modeId === "stun" && a.targetUnitInstanceId === enemyId,
    )!;
    expect(executeActivateAbility(state, stun as never).battlefields[0]!.units["p2"]![0]!.stunned).toBe(true);
  });

  it("the [Ganking] mode grants it for THIS turn only", () => {
    const { state } = udyrState(1);
    const ganking = udyrActions(state).find((a) => a.type === "ActivateAbility" && a.modeId === "ganking")!;

    const after = executeActivateAbility(state, ganking as never);
    const udyrNow = after.battlefields[0]!.units["p1"]![0]!;
    expect(hasKeyword(after, udyrNow, 0, "Ganking")).toBe(true);

    const nextTurn = runEnd(after);
    expect(hasKeyword(nextTurn, nextTurn.battlefields[0]!.units["p1"]![0]!, 0, "Ganking")).toBe(false);
  });

  it("spends the choice even when the mode's own effect does nothing", () => {
    // Stunning an already-stunned unit is a no-op (423), but the choice was
    // still made — so it cannot be chosen again this turn.
    const { state } = udyrState(1);
    const enemyId = state.battlefields[0]!.units["p2"]![0]!.instanceId;
    const alreadyStunned = stunUnit(state, enemyId);
    const stun = udyrActions(alreadyStunned).find(
      (a) => a.type === "ActivateAbility" && a.modeId === "stun" && a.targetUnitInstanceId === enemyId,
    )!;

    const after = addBuff(executeActivateAbility(alreadyStunned, stun as never), state.battlefields[0]!.units["p1"]![0]!.instanceId);

    expect(modesOffered(after).has("stun")).toBe(false);
  });
});

describe("coverage counts Udyr", () => {
  it("reports him as implemented", () => {
    expect(isCardImplemented(registry.get(UDYR))).toBe(true);
  });
});
