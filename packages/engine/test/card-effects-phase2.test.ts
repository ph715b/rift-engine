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

describe("Back to Back: auto-selects up to 2 friendly battlefield units, +2 Might each", () => {
  it("buffs the first 2 friendly units found, not a 3rd or the opponent's", () => {
    const a = makeUnit({ might: 3 });
    const b = makeUnit({ might: 3 });
    const c = makeUnit({ might: 3 });
    const enemy = makeUnit({ might: 3 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [a, b], p2: [enemy] };
    state.battlefields[1]!.units = { p1: [c] };

    state = resolve("OGN-206", 0, state);

    expect(state.battlefields[0]!.units["p1"]![0]!.bonus).toBe(2);
    expect(state.battlefields[0]!.units["p1"]![1]!.bonus).toBe(2);
    expect(state.battlefields[1]!.units["p1"]![0]!.bonus).toBe(0); // 3rd unit not reached
    expect(state.battlefields[0]!.units["p2"]![0]!.bonus).toBe(0); // opponent untouched
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

describe("Singularity: Deal 6 to each of up to two units (auto-selected, either owner)", () => {
  it("damages the first 2 battlefield units found, not a 3rd", () => {
    const a = makeUnit({ might: 10 });
    const b = makeUnit({ might: 10 });
    const c = makeUnit({ might: 10 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [a], p2: [b] };
    state.battlefields[1]!.units = { p1: [c] };

    state = resolve("OGN-105", 0, state);

    expect(state.battlefields[0]!.units["p1"]![0]!.damage).toBe(6);
    expect(state.battlefields[0]!.units["p2"]![0]!.damage).toBe(6);
    expect(state.battlefields[1]!.units["p1"]![0]!.damage).toBe(0);
  });
});

describe("Flash: Move up to 2 friendly units to base (auto-selected)", () => {
  it("recalls the first 2 friendly battlefield units, exhausted, not the opponent's", () => {
    const a = makeUnit();
    const b = makeUnit();
    const enemy = makeUnit();
    let state = makeState();
    state.battlefields[0]!.units = { p1: [a, b], p2: [enemy] };

    state = resolve("OGS-011", 0, state);

    expect(state.battlefields[0]!.units["p1"]).toHaveLength(0);
    expect(state.battlefields[0]!.units["p2"]).toHaveLength(1); // enemy untouched
    expect(state.players[0]!.baseUnits).toHaveLength(2);
    expect(state.players[0]!.baseUnits.every((u) => u.exhausted)).toBe(true);
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
