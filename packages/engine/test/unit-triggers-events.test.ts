import { describe, expect, it } from "vitest";
import { dispatchOnAttack, dispatchOnMove, dispatchOnSpellCast } from "../src/engine/unit-triggers.js";
import { makeState, makeUnit, realUnitInstance } from "./fixtures.js";

describe("Crackshot Corsair: on-attack, deal 1 to an enemy unit here (auto-selected)", () => {
  it("damages an enemy unit at the same battlefield the attacker landed on", () => {
    const corsair = realUnitInstance("OGN-130");
    const enemy = makeUnit({ might: 5 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [corsair], p2: [enemy] };

    state = dispatchOnAttack(state, corsair, 0, "bf1");

    expect(state.battlefields[0]!.units["p2"]![0]!.damage).toBe(1);
  });

  it("no-ops when there's no enemy unit at that battlefield", () => {
    const corsair = realUnitInstance("OGN-130");
    let state = makeState();
    state.battlefields[0]!.units = { p1: [corsair] };
    expect(dispatchOnAttack(state, corsair, 0, "bf1")).toBe(state);
  });
});

describe("Dune Drake: on-attack, +2 Might this turn if a ready enemy unit is here", () => {
  it("buffs itself when a ready enemy unit is present", () => {
    const drake = realUnitInstance("OGN-131");
    const readyEnemy = makeUnit({ exhausted: false });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [drake], p2: [readyEnemy] };

    state = dispatchOnAttack(state, drake, 0, "bf1");

    expect(state.battlefields[0]!.units["p1"]![0]!.mightThisTurn).toBe(2);
  });

  it("does not buff when the only enemy unit here is exhausted", () => {
    const drake = realUnitInstance("OGN-131");
    const exhaustedEnemy = makeUnit({ exhausted: true });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [drake], p2: [exhaustedEnemy] };

    state = dispatchOnAttack(state, drake, 0, "bf1");

    expect(state.battlefields[0]!.units["p1"]![0]!.mightThisTurn).toBe(0);
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

describe("dispatchOnMove/dispatchOnAttack: no-op for units with no registered trigger", () => {
  it("returns state unchanged", () => {
    const daringPoro = realUnitInstance("OGN-210");
    const state = makeState();
    expect(dispatchOnMove(state, daringPoro, 0, "bf1")).toBe(state);
    expect(dispatchOnAttack(state, daringPoro, 0, "bf1")).toBe(state);
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
