import { describe, expect, it } from "vitest";
import { runEnd } from "../src/engine/turn-manager.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { dealDamage } from "../src/engine/effect-helpers.js";
import { makeState, makeUnit } from "./fixtures.js";

/**
 * Marked damage is removed when a SHOWDOWN ends — not when a turn does.
 *
 * This is a deliberate divergence from the Java oracle, which heals every
 * unit on both sides during end-of-turn cleanup (TurnManager.java:277-286).
 * That made damage dealt outside combat meaningless: soften a blocker with a
 * Spell on your turn and it was whole again before your opponent could ever
 * be punished for it — the very thing spending a card on it was meant to buy.
 * `bonus` still expires at end of turn; that one really is "until end of turn".
 */
describe("damage persists past end of turn", () => {
  it("a unit damaged by a spell keeps that damage through runEnd", () => {
    const target = makeUnit({ might: 5 });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [target] };

    state = dealDamage(state, 0, target.instanceId, 3);
    expect(state.battlefields[0]!.units["p2"]![0]!.damage).toBe(3);

    state = runEnd(state);
    expect(state.battlefields[0]!.units["p2"]![0]!.damage).toBe(3);
  });

  it("a damaged unit in BASE keeps its damage too", () => {
    const target = makeUnit({ might: 4, damage: 2 });
    let state = makeState();
    state.players[1]!.baseUnits = [target];

    state = runEnd(state);
    expect(state.players[1]!.baseUnits[0]!.damage).toBe(2);
  });

  it("'this turn' bonuses still expire at end of turn", () => {
    const buffed = makeUnit({ might: 3, bonus: 2, damage: 1 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [buffed] };

    state = runEnd(state);
    const after = state.battlefields[0]!.units["p1"]![0]!;
    expect(after.bonus).toBe(0);
    expect(after.damage).toBe(1); // ...but the damage stays
  });

  it("damage accumulates across turns and can finish a unit off later", () => {
    const target = makeUnit({ might: 4 });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [target] };

    state = dealDamage(state, 0, target.instanceId, 3);
    state = runEnd(state);
    expect(state.battlefields[0]!.units["p2"]).toHaveLength(1);

    // A 1-damage follow-up next turn reaches 4 total and kills it — under
    // end-of-turn healing this second hit would have started from zero.
    state = dealDamage(state, 0, target.instanceId, 1);
    expect(state.battlefields[0]!.units["p2"] ?? []).toHaveLength(0);
    expect(state.players[1]!.trash.map((c) => c.instanceId)).toContain(target.instanceId);
  });

  it("a resolved Showdown is what clears it — survivors come out clean", () => {
    const attacker = makeUnit({ might: 2, keywords: { Assault: 2 } });
    const defender = makeUnit({ might: 3, keywords: { Shield: 2 } });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [attacker], p2: [defender] };

    state = resolveShowdown(state, "bf1", 0);

    expect(state.battlefields[0]!.units["p2"]).toHaveLength(1);
    expect(state.battlefields[0]!.units["p2"]![0]!.damage).toBe(0);
  });

  it("pre-existing damage carries INTO a showdown and helps kill", () => {
    // 4 Might defender already down 3: a 2-damage attacker now finishes it,
    // which is exactly the play end-of-turn healing used to erase.
    const attacker = makeUnit({ might: 2 });
    const defender = makeUnit({ might: 4, damage: 3 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [attacker], p2: [defender] };

    state = resolveShowdown(state, "bf1", 0);

    expect(state.battlefields[0]!.units["p2"] ?? []).toHaveLength(0);
  });
});
