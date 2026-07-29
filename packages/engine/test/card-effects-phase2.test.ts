import { describe, expect, it } from "vitest";
import { effectForCard } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { makeState, makeUnit, spellInstance } from "./fixtures.js";

function resolve(defId: string, casterIndex: 0 | 1, state: ReturnType<typeof makeState>, event: Parameters<NonNullable<ReturnType<typeof effectForCard>>["resolve"]>[2] = {}) {
  const effect = effectForCard(spellInstance(defId))!;
  return effect.resolve(state, contextFor(casterIndex), event);
}

describe("Disintegrate: Deal 3 to a unit at a battlefield; draw 1 if lethal", () => {
  it("draws a card when the damage is lethal", () => {
    const target = makeUnit({ might: 3 });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [target] };
    state.players[0]!.deck = [makeUnit()];

    state = resolve("OGN-005", 0, state, { targetUnitInstanceId: target.instanceId });

    expect(state.battlefields[0]!.units["p2"]).toHaveLength(0);
    expect(state.players[0]!.hand).toHaveLength(1); // drew the card
  });

  it("does NOT draw when the damage isn't lethal", () => {
    const target = makeUnit({ might: 10 });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [target] };
    state.players[0]!.deck = [makeUnit()];

    state = resolve("OGN-005", 0, state, { targetUnitInstanceId: target.instanceId });

    expect(state.battlefields[0]!.units["p2"]![0]!.damage).toBe(3);
    expect(state.players[0]!.hand).toHaveLength(0);
  });
});

describe("Firestorm: Deal 3 to all enemy units at a battlefield", () => {
  it("damages only the caster's enemies at that battlefield, not friendlies or other battlefields", () => {
    const enemyHere = makeUnit({ might: 5 });
    const friendlyHere = makeUnit({ might: 5 });
    const enemyElsewhere = makeUnit({ might: 5 });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [enemyHere], p1: [friendlyHere] };
    state.battlefields[1]!.units = { p2: [enemyElsewhere] };

    state = resolve("OGS-002", 0, state, { targetBattlefieldId: "bf1" });

    expect(state.battlefields[0]!.units["p2"]![0]!.damage).toBe(3);
    expect(state.battlefields[0]!.units["p1"]![0]!.damage).toBe(0);
    expect(state.battlefields[1]!.units["p2"]![0]!.damage).toBe(0);
  });
});

describe("Confront: units played this turn enter ready; draw 1", () => {
  it("sets the flag and draws", () => {
    let state = makeState();
    state.players[0]!.deck = [makeUnit()];

    state = resolve("OGN-129", 0, state);

    expect(state.players[0]!.unitsEnterReadyThisTurn).toBe(true);
    expect(state.players[0]!.hand).toHaveLength(1);
  });
});

describe("Back to Back: +2 Might each to two CHOSEN friendly units", () => {
  it("buffs exactly the two the caster picked, ignoring a third", () => {
    // Used to auto-pick the first two friendly units found; which two get the
    // buff is a real decision, so it's the player's now.
    const a = makeUnit({ might: 3 });
    const b = makeUnit({ might: 3 });
    const c = makeUnit({ might: 3 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [a, b] };
    state.battlefields[1]!.units = { p1: [c] };

    state = resolve("OGN-206", 0, state, {
      targetUnitInstanceId: a.instanceId,
      secondTargetUnitInstanceId: c.instanceId, // the far one, not the adjacent b
    });

    expect(state.battlefields[0]!.units["p1"]![0]!.bonus).toBe(2); // a
    expect(state.battlefields[0]!.units["p1"]![1]!.bonus).toBe(0); // b NOT chosen
    expect(state.battlefields[1]!.units["p1"]![0]!.bonus).toBe(2); // c
  });

  it("buffs just one when that's all the caster picked", () => {
    const only = makeUnit({ might: 3 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [only] };

    state = resolve("OGN-206", 0, state, { targetUnitInstanceId: only.instanceId });

    expect(state.battlefields[0]!.units["p1"]![0]!.bonus).toBe(2);
  });
});

describe("Stupefy: -1 Might (min 1) to a unit; draw 1 regardless", () => {
  it("debuffs a unit above 1 effective Might", () => {
    const target = makeUnit({ might: 3 });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [target] };
    state.players[0]!.deck = [makeUnit()];

    state = resolve("OGN-095", 0, state, { targetUnitInstanceId: target.instanceId });

    expect(state.battlefields[0]!.units["p2"]![0]!.bonus).toBe(-1);
    expect(state.players[0]!.hand).toHaveLength(1);
  });

  it("does not debuff a unit already at 1 effective Might, but still draws", () => {
    const target = makeUnit({ might: 1 });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [target] };
    state.players[0]!.deck = [makeUnit()];

    state = resolve("OGN-095", 0, state, { targetUnitInstanceId: target.instanceId });

    expect(state.battlefields[0]!.units["p2"]![0]!.bonus).toBe(0);
    expect(state.players[0]!.hand).toHaveLength(1);
  });
});

describe("En Garde: +1 Might a friendly unit, +1 more if it's the caster's only unit there", () => {
  it("gives only +1 when the caster has other units at that battlefield", () => {
    const target = makeUnit({ might: 3 });
    const other = makeUnit({ might: 3 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [target, other] };

    state = resolve("OGN-046", 0, state, { targetUnitInstanceId: target.instanceId });

    expect(state.battlefields[0]!.units["p1"]![0]!.bonus).toBe(1);
  });

  it("gives +2 total when the target is the caster's only unit there", () => {
    const target = makeUnit({ might: 3 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [target] };

    state = resolve("OGN-046", 0, state, { targetUnitInstanceId: target.instanceId });

    expect(state.battlefields[0]!.units["p1"]![0]!.bonus).toBe(2);
  });
});

describe("Singularity: Deal 6 to each of up to two CHOSEN units", () => {
  it("damages exactly the two picked, and MAY be pointed at your own units", () => {
    // "Deal 6 to each of up to two units" names no owner, so your own units
    // are legal targets — sometimes the right play (killing your own unit to
    // deny a hold, say). What the card must never do is pick them FOR you.
    const myChosen = makeUnit({ might: 10 });
    const theirChosen = makeUnit({ might: 10 });
    const myUnchosen = makeUnit({ might: 10 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [myUnchosen], p2: [theirChosen] };
    state.battlefields[1]!.units = { p1: [myChosen] };

    state = resolve("OGN-105", 0, state, {
      targetUnitInstanceId: theirChosen.instanceId,
      secondTargetUnitInstanceId: myChosen.instanceId,
    });

    expect(state.battlefields[0]!.units["p2"]![0]!.damage).toBe(6); // theirs, chosen
    expect(state.battlefields[1]!.units["p1"]![0]!.damage).toBe(6); // MINE, chosen
    expect(state.battlefields[0]!.units["p1"]![0]!.damage).toBe(0); // mine, not chosen
  });

  it("REGRESSION: does not hit the caster's own units unless chosen", () => {
    // The auto-select built its list from players[0].baseUnits first — the
    // caster's own — so casting this with units at home nuked your own board.
    const ownA = makeUnit({ might: 10 });
    const ownB = makeUnit({ might: 10 });
    const enemy = makeUnit({ might: 10 });
    let state = makeState();
    state.players[0]!.baseUnits = [ownA, ownB];
    state.battlefields[0]!.units = { p2: [enemy] };

    state = resolve("OGN-105", 0, state, { targetUnitInstanceId: enemy.instanceId });

    expect(state.players[0]!.baseUnits.every((u) => u.damage === 0)).toBe(true);
    expect(state.battlefields[0]!.units["p2"]![0]!.damage).toBe(6);
  });

  it("is legal with no targets at all ('up to two')", () => {
    const untouched = makeUnit({ might: 10 });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [untouched] };

    state = resolve("OGN-105", 0, state, {});

    expect(state.battlefields[0]!.units["p2"]![0]!.damage).toBe(0);
  });
});

describe("Flash: Move up to 2 CHOSEN friendly units to base", () => {
  it("recalls exactly the ones picked, exhausted, leaving the rest in place", () => {
    const a = makeUnit();
    const b = makeUnit();
    const enemy = makeUnit();
    let state = makeState();
    state.battlefields[0]!.units = { p1: [a, b], p2: [enemy] };

    state = resolve("OGS-011", 0, state, { targetUnitInstanceId: a.instanceId });

    expect(state.battlefields[0]!.units["p1"]!.map((u) => u.instanceId)).toEqual([b.instanceId]);
    expect(state.battlefields[0]!.units["p2"]).toHaveLength(1); // enemy untouched
    expect(state.players[0]!.baseUnits).toHaveLength(1);
    expect(state.players[0]!.baseUnits[0]!.exhausted).toBe(true);
  });

  it("recalls both when both are picked", () => {
    const a = makeUnit();
    const b = makeUnit();
    let state = makeState();
    state.battlefields[0]!.units = { p1: [a, b] };

    state = resolve("OGS-011", 0, state, {
      targetUnitInstanceId: a.instanceId,
      secondTargetUnitInstanceId: b.instanceId,
    });

    expect(state.battlefields[0]!.units["p1"]).toHaveLength(0);
    expect(state.players[0]!.baseUnits).toHaveLength(2);
  });
});

describe("Gust: Return a unit at a battlefield with 3 Might or less to its owner's hand", () => {
  it("returns the unit to its owner's hand, reset", () => {
    const target = makeUnit({ might: 3, damage: 1, bonus: 1, exhausted: true });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [target] };

    state = resolve("OGN-169", 0, state, { targetUnitInstanceId: target.instanceId });

    expect(state.battlefields[0]!.units["p2"]).toHaveLength(0);
    expect(state.players[1]!.hand).toHaveLength(1);
    const returned = state.players[1]!.hand[0]!;
    expect(returned.kind === "Unit" && returned.damage).toBe(0);
    expect(returned.kind === "Unit" && returned.bonus).toBe(0);
    expect(returned.exhausted).toBe(false);
  });
});

describe("Mobilize: channel 1 rune exhausted; draw 1 if the rune deck is empty", () => {
  it("channels 1 rune, forced Exhausted, when the rune deck has one", () => {
    let state = makeState();
    state.players[0]!.runeDeck = [{ id: "r1", domain: "Order", state: "Ready" }];

    state = resolve("OGN-134", 0, state);

    expect(state.players[0]!.channeled).toHaveLength(1);
    expect(state.players[0]!.channeled[0]!.state).toBe("Exhausted");
    expect(state.players[0]!.runeDeck).toHaveLength(0);
  });

  it("draws 1 instead when the rune deck is empty", () => {
    let state = makeState();
    state.players[0]!.deck = [makeUnit()];

    state = resolve("OGN-134", 0, state);

    expect(state.players[0]!.channeled).toHaveLength(0);
    expect(state.players[0]!.hand).toHaveLength(1);
  });
});

describe("targeting validation: owner filter (En Garde must target a friendly unit)", () => {
  it("rejects targeting an enemy unit", () => {
    const enGarde = spellInstance("OGN-046");
    const enemyTarget = makeUnit();
    const state = makeState();
    state.players[0]!.hand = [enGarde];
    state.players[0]!.channeled = [{ id: "r1", domain: "Order", state: "Ready" }];
    state.battlefields[0]!.units = { p2: [enemyTarget] };

    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: enGarde,
      payment: { energyRunes: ["r1"], powerRunes: [] },
      targetUnitInstanceId: enemyTarget.instanceId,
    };
    expect(validatePlayCard(state, action).ok).toBe(false);
  });

  it("accepts targeting a friendly unit", () => {
    const enGarde = spellInstance("OGN-046");
    const friendlyTarget = makeUnit();
    const state = makeState();
    state.players[0]!.hand = [enGarde];
    state.players[0]!.channeled = [{ id: "r1", domain: "Order", state: "Ready" }];
    state.battlefields[0]!.units = { p1: [friendlyTarget] };

    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: enGarde,
      payment: { energyRunes: ["r1"], powerRunes: [] },
      targetUnitInstanceId: friendlyTarget.instanceId,
    };
    expect(validatePlayCard(state, action)).toEqual({ ok: true });
  });
});

describe("targeting validation: maxMight filter (Gust requires 3 Might or less)", () => {
  it("rejects a unit with more than 3 effective Might", () => {
    const gust = spellInstance("OGN-169");
    const target = makeUnit({ might: 4 });
    const state = makeState();
    state.players[0]!.hand = [gust];
    state.players[0]!.channeled = [{ id: "r1", domain: "Order", state: "Ready" }];
    state.battlefields[0]!.units = { p2: [target] };

    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: gust,
      payment: { energyRunes: ["r1"], powerRunes: [] },
      targetUnitInstanceId: target.instanceId,
    };
    expect(validatePlayCard(state, action).ok).toBe(false);
  });

  it("accepts a unit with exactly 3 effective Might", () => {
    const gust = spellInstance("OGN-169");
    const target = makeUnit({ might: 2, bonus: 1 }); // effective 3
    const state = makeState();
    state.players[0]!.hand = [gust];
    state.players[0]!.channeled = [{ id: "r1", domain: "Order", state: "Ready" }];
    state.battlefields[0]!.units = { p2: [target] };

    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: gust,
      payment: { energyRunes: ["r1"], powerRunes: [] },
      targetUnitInstanceId: target.instanceId,
    };
    expect(validatePlayCard(state, action)).toEqual({ ok: true });
  });
});
