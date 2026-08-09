import { describe, expect, it } from "vitest";
import { resolveShowdown } from "../src/engine/combat.js";
import { makeState, makeUnit, realUnitInstance } from "./fixtures.js";

/**
 * Combat Cleanup and post-combat control, per the Core Rules:
 *
 *  - Step 3c: "Heal all Units" — global (covered in damage-healing.test.ts).
 *  - Step 3d: "Recall Attackers present at the Battlefield if Defenders are
 *    still present." Ordered AFTER 3c, so recalled attackers arrive healed.
 *  - Rule 458.1: a Recall is not a Move and leaves statuses untouched — no move
 *    triggers, no exhaust.
 *  - Rule 466.5: whoever still has units here Establishes Control if they
 *    didn't already; nobody left → Uncontrolled; establishing control is a
 *    Conquer if that battlefield wasn't already scored this turn.
 */
/** A defender that survives almost anything but barely hits back: [Shield]
 *  boosts toughness while defending and never outgoing damage, so this soaks
 *  10 while dealing only 1 — the shape that produces "both sides survive",
 *  which is the only case step 3d applies to. A big plain Might wall would
 *  simply kill the attackers instead. */
function shieldWall() {
  return makeUnit({ might: 1, keywords: { Shield: 9 } });
}

describe("step 3d: attackers go home if defenders survive", () => {
  it("recalls every surviving attacker, leaving the defenders in place", () => {
    const a1 = makeUnit({ might: 3 });
    const a2 = makeUnit({ might: 3 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [a1, a2], p2: [shieldWall()] };
    state.battlefields[0]!.controllerId = "p2";

    state = resolveShowdown(state, "bf1", 0);

    expect(state.battlefields[0]!.units["p1"] ?? []).toHaveLength(0);
    expect(state.players[0]!.baseUnits.map((u) => u.instanceId).sort()).toEqual([a1.instanceId, a2.instanceId].sort());
    expect(state.battlefields[0]!.units["p2"]).toHaveLength(1);
  });

  it("a recall does not exhaust — the unit keeps the readiness it had", () => {
    // Rule 454: "Damage and statuses of a permanent will all remain unaffected
    // by a Recall." Highlander exhausts only because its own text says to.
    const ready = makeUnit({ might: 3, exhausted: false });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [ready], p2: [shieldWall()] };

    state = resolveShowdown(state, "bf1", 0);

    expect(state.players[0]!.baseUnits).toHaveLength(1);
    expect(state.players[0]!.baseUnits[0]!.exhausted).toBe(false);
  });

  it("recalled attackers arrive healed — 3c runs before 3d", () => {
    const attacker = makeUnit({ might: 3 }); // survives the wall's 1 damage
    let state = makeState();
    state.battlefields[0]!.units = { p1: [attacker], p2: [shieldWall()] };

    state = resolveShowdown(state, "bf1", 0);

    expect(state.players[0]!.baseUnits[0]!.damage).toBe(0);
  });

  it("fires NO move triggers — a Recall is not a Move", () => {
    // Traveling Merchant (OGN-185, 2 Might): "When I move, discard 1, then
    // draw 1." Being sent home by cleanup must not trigger it.
    const merchant = realUnitInstance("OGN-185");
    let state = makeState();
    state.battlefields[0]!.units = { p1: [merchant], p2: [shieldWall()] };
    state.players[0]!.hand = [makeUnit(), makeUnit()];
    state.players[0]!.deck = [makeUnit()];

    state = resolveShowdown(state, "bf1", 0);

    expect(state.players[0]!.baseUnits.map((u) => u.defId)).toContain("OGN-185"); // it did come home
    expect(state.players[0]!.hand).toHaveLength(2); // no discard, no draw
    expect(state.players[0]!.trash).toHaveLength(0);
  });

  it("does not recall when the attacker cleared the battlefield", () => {
    const attacker = makeUnit({ might: 9 });
    const chaff = makeUnit({ might: 1 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [attacker], p2: [chaff] };

    state = resolveShowdown(state, "bf1", 0);

    expect(state.battlefields[0]!.units["p1"]).toHaveLength(1); // stayed and took the field
    expect(state.players[0]!.baseUnits).toHaveLength(0);
  });
});

describe("rule 466.5: control follows whoever remains", () => {
  it("attacker alone takes control, scoring a conquest", () => {
    const attacker = makeUnit({ might: 9 });
    const chaff = makeUnit({ might: 1 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [attacker], p2: [chaff] };
    state.battlefields[0]!.controllerId = "p2";

    state = resolveShowdown(state, "bf1", 0);

    expect(state.battlefields[0]!.controllerId).toBe("p1");
    expect(state.players[0]!.points).toBe(1);
    expect(state.players[0]!.scoredBattlefieldsThisTurn).toContain("bf1");
  });

  it("...but not a second time if it was already scored this turn", () => {
    const attacker = makeUnit({ might: 9 });
    const chaff = makeUnit({ might: 1 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [attacker], p2: [chaff] };
    state.battlefields[0]!.controllerId = "p2";
    state.players[0]!.scoredBattlefieldsThisTurn = ["bf1"]; // held or taken earlier this turn

    state = resolveShowdown(state, "bf1", 0);

    expect(state.battlefields[0]!.controllerId).toBe("p1");
    expect(state.players[0]!.points).toBe(0);
  });

  it("mutual wipe leaves the battlefield Uncontrolled", () => {
    const attacker = makeUnit({ might: 3 });
    const defender = makeUnit({ might: 3 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [attacker], p2: [defender] };
    state.battlefields[0]!.controllerId = "p2";

    state = resolveShowdown(state, "bf1", 0);

    expect(state.battlefields[0]!.controllerId).toBeNull();
    expect(state.players[0]!.points).toBe(0);
    expect(state.players[1]!.points).toBe(0);
  });

  it("defender wiping the attacker keeps control, with no conquest", () => {
    const attacker = makeUnit({ might: 1 });
    const defender = makeUnit({ might: 9 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [attacker], p2: [defender] };
    state.battlefields[0]!.controllerId = "p2";

    state = resolveShowdown(state, "bf1", 0);

    expect(state.battlefields[0]!.controllerId).toBe("p2");
    expect(state.players[1]!.points).toBe(0); // already theirs — nothing established
  });

  it("a defender who did NOT already control it establishes control", () => {
    // Rule 466.5's "if they didn't already control this Battlefield", and
    // "This does not have to be the player that applied Contested."
    const attacker = makeUnit({ might: 1 });
    const defender = makeUnit({ might: 9 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [attacker], p2: [defender] };
    state.battlefields[0]!.controllerId = null;

    state = resolveShowdown(state, "bf1", 0);

    expect(state.battlefields[0]!.controllerId).toBe("p2");
    expect(state.players[1]!.points).toBe(1); // establishing control is a Conquer
  });
});
