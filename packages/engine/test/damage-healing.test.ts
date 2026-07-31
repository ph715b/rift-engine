import { describe, expect, it } from "vitest";
import { runEnd } from "../src/engine/turn-manager.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { dealDamage } from "../src/engine/effect-helpers.js";
import { makeState, makeUnit } from "./fixtures.js";

/**
 * Damage healing, per the official rules:
 *
 *  - Units heal at the end of every COMBAT showdown (combat cleanup, rule
 *    461.1.a) and at the end of a player's turn.
 *  - Both are GLOBAL: cleanup "clears all marked damage from every unit on
 *    the board, including units that were not involved in the combat"
 *    (RiftJudge FAQ 7750/8993). A unit softened at another battlefield, or
 *    standing in base, heals too.
 *  - A non-combat (uncontested) showdown performs no cleanup and heals
 *    nothing (FAQ 9016).
 *
 * An earlier round removed end-of-turn healing on the reading that damage
 * should survive until a showdown; that was wrong on both counts — end of turn
 * heals, and combat cleanup is wider than the units that fought.
 */
describe("end of turn heals every unit, both sides", () => {
  it("clears spell damage at the end of the turn", () => {
    const target = makeUnit({ might: 9 });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [target] };

    state = dealDamage(state, 0, target.instanceId, 3);
    expect(state.battlefields[0]!.units["p2"]![0]!.damage).toBe(3);

    state = runEnd(state);
    expect(state.battlefields[0]!.units["p2"]![0]!.damage).toBe(0);
  });

  it("clears damage on units in BASE too, both players", () => {
    const mine = makeUnit({ might: 5, damage: 2 });
    const theirs = makeUnit({ might: 5, damage: 4 });
    let state = makeState();
    state.players[0]!.baseUnits = [mine];
    state.players[1]!.baseUnits = [theirs];

    state = runEnd(state);

    expect(state.players[0]!.baseUnits[0]!.damage).toBe(0);
    expect(state.players[1]!.baseUnits[0]!.damage).toBe(0);
  });

  it("still expires 'this turn' bonuses at the same moment", () => {
    const buffed = makeUnit({ might: 3, mightThisTurn: 2, damage: 1 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [buffed] };

    state = runEnd(state);
    const after = state.battlefields[0]!.units["p1"]![0]!;
    expect(after.mightThisTurn).toBe(0);
    expect(after.damage).toBe(0);
  });

  it("so damage does NOT accumulate across turns", () => {
    const target = makeUnit({ might: 4 });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [target] };

    state = dealDamage(state, 0, target.instanceId, 3);
    state = runEnd(state);
    // A 1-damage follow-up next turn starts from zero, so it survives.
    state = dealDamage(state, 0, target.instanceId, 1);

    expect(state.battlefields[0]!.units["p2"]).toHaveLength(1);
    expect(state.battlefields[0]!.units["p2"]![0]!.damage).toBe(1);
  });
});

describe("combat cleanup heals GLOBALLY, not just the units that fought", () => {
  it("survivors of the fight come out clean", () => {
    const attacker = makeUnit({ might: 2, keywords: { Assault: 2 } });
    const defender = makeUnit({ might: 3, keywords: { Shield: 2 } });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [attacker], p2: [defender] };

    state = resolveShowdown(state, "bf1", 0);

    expect(state.battlefields[0]!.units["p2"]).toHaveLength(1);
    expect(state.battlefields[0]!.units["p2"]![0]!.damage).toBe(0);
  });

  it("a unit at ANOTHER battlefield heals from an unrelated fight", () => {
    const attacker = makeUnit({ might: 5 });
    const defender = makeUnit({ might: 1 });
    const bystander = makeUnit({ might: 9, damage: 4 }); // softened by a Spell earlier
    let state = makeState();
    state.battlefields[0]!.units = { p1: [attacker], p2: [defender] };
    state.battlefields[1]!.units = { p2: [bystander] };

    state = resolveShowdown(state, "bf1", 0);

    expect(state.battlefields[1]!.units["p2"]![0]!.damage).toBe(0);
  });

  it("a unit in BASE heals from a fight it wasn't in", () => {
    const attacker = makeUnit({ might: 5 });
    const defender = makeUnit({ might: 1 });
    const atHome = makeUnit({ might: 9, damage: 6 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [attacker], p2: [defender] };
    state.players[1]!.baseUnits = [atHome];

    state = resolveShowdown(state, "bf1", 0);

    expect(state.players[1]!.baseUnits[0]!.damage).toBe(0);
  });

  it("pre-existing damage still counts DURING the fight it's carried into", () => {
    // Healing is cleanup, after damage is dealt — so a 4-damage 4-Might
    // defender is still finished off by a 2-Might attacker.
    const attacker = makeUnit({ might: 2 });
    const defender = makeUnit({ might: 4, damage: 3 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [attacker], p2: [defender] };

    state = resolveShowdown(state, "bf1", 0);

    expect(state.battlefields[0]!.units["p2"] ?? []).toHaveLength(0);
  });

  it("an UNCONTESTED showdown heals nothing — no combat, no cleanup", () => {
    const lone = makeUnit({ might: 5 });
    const damagedElsewhere = makeUnit({ might: 9, damage: 3 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [lone] }; // only one side present
    state.battlefields[1]!.units = { p2: [damagedElsewhere] };

    const result = resolveShowdown(state, "bf1", 0);

    expect(result).toBe(state); // same reference — genuinely a no-op
    expect(result.battlefields[1]!.units["p2"]![0]!.damage).toBe(3);
  });
});
