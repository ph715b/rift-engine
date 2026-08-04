import { describe, expect, it } from "vitest";
import { dispatchOnMove, dispatchOnSpellCast } from "../src/engine/unit-triggers.js";
import { beginCombatAt, makeState, makeUnit, realUnitInstance } from "./fixtures.js";

/**
 * These used to call `dispatchOnAttack` directly. There is no such dispatcher any
 * more: an Attack Trigger fires when its unit gains the Attacker designation
 * (383.4.f), which happens as the Combat Showdown opens, so the way to drive one
 * is to open a combat — `beginCombatAt`, which contests the battlefield and lets
 * the real Cleanup do the rest.
 *
 * That is not a cosmetic swap. The old calls handed the dispatcher a unit and an
 * attacker index, so they proved nothing about WHICH units fire; going through the
 * Cleanup means a card that fired for the defending side fails here.
 */

describe("Crackshot Corsair: on-attack, deal 1 to an enemy unit here (auto-selected)", () => {
  it("damages an enemy unit at the battlefield he is attacking", () => {
    const corsair = realUnitInstance("OGN-130");
    const enemy = makeUnit({ might: 5 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [corsair], p2: [enemy] };

    const after = beginCombatAt(state, "bf1", 0);

    expect(after.battlefields[0]!.units["p2"]![0]!.damage).toBe(1);
  });

  it("does not fire when he is DEFENDING the battlefield instead", () => {
    // The old dispatcher could not be asked this: it fired for whichever unit it
    // was handed. Now the side is the board's answer, not the caller's.
    const corsair = realUnitInstance("OGN-130");
    const enemy = makeUnit({ might: 5 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [corsair], p2: [enemy] };

    const after = beginCombatAt(state, "bf1", 1);

    expect(after.battlefields[0]!.units["p2"]![0]!.damage).toBe(0);
  });

  it("never fires at a battlefield with no enemy units — that is a Non-Combat Showdown", () => {
    // The replacement for "no-ops when there's no enemy unit here". The card's
    // own no-op is no longer the reason nothing happens: with nobody to fight,
    // 341 opens a Non-Combat Showdown, and no Attacker designation is handed out
    // for an Attack Trigger to wait on.
    const corsair = realUnitInstance("OGN-130");
    const state = makeState();
    state.battlefields[0]!.units = { p1: [corsair] };

    const after = beginCombatAt(state, "bf1", 0);

    expect(after.showdownKind).toBe("NonCombat");
    expect(after.spellChain).toHaveLength(0);
  });
});

describe("Dune Drake: on-attack, +2 Might this turn if a ready enemy unit is here", () => {
  it("buffs itself when a ready enemy unit is present", () => {
    const drake = realUnitInstance("OGN-131");
    const readyEnemy = makeUnit({ exhausted: false });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [drake], p2: [readyEnemy] };

    const after = beginCombatAt(state, "bf1", 0);

    expect(after.battlefields[0]!.units["p1"]![0]!.mightThisTurn).toBe(2);
  });

  it("does not buff when the only enemy unit here is exhausted", () => {
    const drake = realUnitInstance("OGN-131");
    const exhaustedEnemy = makeUnit({ exhausted: true });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [drake], p2: [exhaustedEnemy] };

    const after = beginCombatAt(state, "bf1", 0);

    expect(after.battlefields[0]!.units["p1"]![0]!.mightThisTurn).toBe(0);
  });
});

describe("Traveling Merchant: on-move, discard 1 then draw 1", () => {
  it("discards the first hand card and draws a new one", () => {
    const merchant = realUnitInstance("OGN-185");
    const discardMe = makeUnit();
    const drawMe = makeUnit();
    let state = makeState();
    state.players[0]!.hand = [discardMe];
    state.players[0]!.deck = [drawMe];

    state = dispatchOnMove(state, merchant, 0, "bf1");

    expect(state.players[0]!.trash.map((c) => c.instanceId)).toContain(discardMe.instanceId);
    expect(state.players[0]!.hand.map((c) => c.instanceId)).toContain(drawMe.instanceId);
    expect(state.players[0]!.hand).toHaveLength(1);
  });

  it("still draws even with an empty hand to discard from", () => {
    const merchant = realUnitInstance("OGN-185");
    const drawMe = makeUnit();
    let state = makeState();
    state.players[0]!.deck = [drawMe];

    state = dispatchOnMove(state, merchant, 0, "bf1");

    expect(state.players[0]!.hand).toHaveLength(1);
  });
});

describe("Noxian Drummer: on-move to a battlefield, play a token here", () => {
  it("places a Recruit token at the destination battlefield", () => {
    const drummer = realUnitInstance("OGN-222");
    let state = makeState();

    state = dispatchOnMove(state, drummer, 0, "bf1");

    expect(state.battlefields[0]!.units["p1"]).toHaveLength(1);
    expect(state.battlefields[0]!.units["p1"]![0]!.isToken).toBe(true);
  });
});

describe("a unit with no registered trigger fires nothing", () => {
  it("dispatchOnMove returns state unchanged", () => {
    const daringPoro = realUnitInstance("OGN-210");
    const state = makeState();
    expect(dispatchOnMove(state, daringPoro, 0, "bf1")).toBe(state);
  });

  it("and a combat it attacks in puts nothing on the chain", () => {
    // Asserted on the CHAIN rather than on state identity: `combatBegan` is held,
    // so "nothing triggered" and "something triggered and did nothing" are finally
    // different boards, and only the chain tells them apart. A Cleanup that stages
    // a Showdown always returns a fresh state, so identity proves nothing here.
    const daringPoro = realUnitInstance("OGN-210");
    const state = makeState();
    state.battlefields[0]!.units = { p1: [daringPoro], p2: [makeUnit({ might: 5 })] };

    const after = beginCombatAt(state, "bf1", 0);

    expect(after.showdownKind).toBe("Combat");
    expect(after.spellChain).toHaveLength(0);
  });
});

describe("Ravenbloom Student: on-spell-cast, +1 Might this turn (own spells only)", () => {
  it("buffs itself when its OWN controller casts a spell", () => {
    const student = realUnitInstance("OGN-103");
    let state = makeState();
    state.battlefields[0]!.units = { p1: [student] };

    state = dispatchOnSpellCast(state, 0, 3);

    expect(state.battlefields[0]!.units["p1"]![0]!.mightThisTurn).toBe(1);
  });

  it("does NOT buff when the OPPONENT casts a spell", () => {
    const student = realUnitInstance("OGN-103");
    let state = makeState();
    state.battlefields[0]!.units = { p1: [student] };

    state = dispatchOnSpellCast(state, 1, 3); // opponent (index 1) casts

    expect(state.battlefields[0]!.units["p1"]![0]!.mightThisTurn).toBe(0);
  });

  it("works for a listener sitting in base too", () => {
    const student = realUnitInstance("OGN-103");
    let state = makeState();
    state.players[0]!.baseUnits = [student];

    state = dispatchOnSpellCast(state, 0, 3);

    expect(state.players[0]!.baseUnits[0]!.mightThisTurn).toBe(1);
  });
});

describe("Lux - Illuminated: on-spell-cast, +3 Might if the spell costs 5+ Energy", () => {
  it("buffs when the cast spell's Energy cost is 5 or more", () => {
    const lux = realUnitInstance("OGS-006");
    let state = makeState();
    state.battlefields[0]!.units = { p1: [lux] };

    state = dispatchOnSpellCast(state, 0, 5);

    expect(state.battlefields[0]!.units["p1"]![0]!.mightThisTurn).toBe(3);
  });

  it("does not buff for a cheaper spell", () => {
    const lux = realUnitInstance("OGS-006");
    let state = makeState();
    state.battlefields[0]!.units = { p1: [lux] };

    state = dispatchOnSpellCast(state, 0, 4);

    expect(state.battlefields[0]!.units["p1"]![0]!.mightThisTurn).toBe(0);
  });
});
