import { describe, expect, it } from "vitest";
import { effectiveMight } from "../src/engine/effective-might.js";
import { makeState, makeUnit } from "./fixtures.js";

describe("effectiveMight: combatRole asymmetry", () => {
  it("outgoing only ever adds Assault-while-attacking, never Shield", () => {
    const state = makeState();
    const attacker = makeUnit({ might: 3, keywords: { Assault: 2, Shield: 9 } });
    const defender = makeUnit({ might: 3, keywords: { Shield: 3 } });

    expect(
      effectiveMight(state, attacker, 0, { isCombat: true, isAttackingSide: true, combatRole: "outgoing" }),
    ).toBe(5); // 3 + Assault 2
    expect(
      effectiveMight(state, defender, 1, { isCombat: true, isAttackingSide: false, combatRole: "outgoing" }),
    ).toBe(3); // Shield never boosts outgoing
  });

  it("remaining adds Assault-while-attacking OR Shield-while-defending", () => {
    const state = makeState();
    const attacker = makeUnit({ might: 3, keywords: { Assault: 2 } });
    const defender = makeUnit({ might: 3, keywords: { Shield: 3 } });

    expect(
      effectiveMight(state, attacker, 0, { isCombat: true, isAttackingSide: true, combatRole: "remaining" }),
    ).toBe(5);
    expect(
      effectiveMight(state, defender, 1, { isCombat: true, isAttackingSide: false, combatRole: "remaining" }),
    ).toBe(6);
  });

  it("outside combat, neither keyword applies", () => {
    const state = makeState();
    const unit = makeUnit({ might: 3, keywords: { Assault: 2, Shield: 3 } });
    expect(effectiveMight(state, unit, 0, { isCombat: false })).toBe(3);
  });
});

describe("effectiveMight: Garen-Commander (OGS-013) positional aura", () => {
  it("gives +1 Might to other friendlies at his own base location", () => {
    const garen = makeUnit({ defId: "OGS-013", might: 5 });
    const ally = makeUnit({ might: 3 });
    const state = makeState();
    state.players[0]!.baseUnits = [garen, ally];

    expect(effectiveMight(state, ally, 0, { isCombat: false })).toBe(4);
  });

  it("does not buff itself", () => {
    const garen = makeUnit({ defId: "OGS-013", might: 5 });
    const state = makeState();
    state.players[0]!.baseUnits = [garen];

    expect(effectiveMight(state, garen, 0, { isCombat: false })).toBe(5);
  });

  it("does not buff friendlies at a different location", () => {
    const garen = makeUnit({ defId: "OGS-013", might: 5 });
    const allyAtBattlefield = makeUnit({ might: 3 });
    const state = makeState();
    state.players[0]!.baseUnits = [garen];
    state.battlefields[0]!.units = { p1: [allyAtBattlefield] };

    expect(effectiveMight(state, allyAtBattlefield, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(3);
  });

  it("does not buff the opponent's units", () => {
    const garen = makeUnit({ defId: "OGS-013", might: 5 });
    const enemy = makeUnit({ might: 3 });
    const state = makeState();
    state.players[0]!.baseUnits = [garen];
    state.players[1]!.baseUnits = [enemy];

    expect(effectiveMight(state, enemy, 1, { isCombat: false })).toBe(3);
  });
});

describe("effectiveMight: Master Yi-Meditative (OGS-004) rune-count self-buff", () => {
  it("gains +4 Might while its controller has 8+ runes channeled", () => {
    const yi = makeUnit({ defId: "OGS-004", might: 2 });
    const state = makeState();
    state.players[0]!.baseUnits = [yi];
    state.players[0]!.channeled = Array.from({ length: 8 }, (_, i) => ({
      id: `rune-${i}`,
      domain: "Order" as const,
      state: "Ready" as const,
    }));

    expect(effectiveMight(state, yi, 0, { isCombat: false })).toBe(6);
  });

  it("stays unbuffed below the 8-rune threshold", () => {
    const yi = makeUnit({ defId: "OGS-004", might: 2 });
    const state = makeState();
    state.players[0]!.baseUnits = [yi];
    state.players[0]!.channeled = Array.from({ length: 7 }, (_, i) => ({
      id: `rune-${i}`,
      domain: "Order" as const,
      state: "Ready" as const,
    }));

    expect(effectiveMight(state, yi, 0, { isCombat: false })).toBe(2);
  });

  it("does not buff other units even at 8+ runes", () => {
    const yi = makeUnit({ defId: "OGS-004", might: 2 });
    const ally = makeUnit({ might: 3 });
    const state = makeState();
    state.players[0]!.baseUnits = [yi, ally];
    state.players[0]!.channeled = Array.from({ length: 8 }, (_, i) => ({
      id: `rune-${i}`,
      domain: "Order" as const,
      state: "Ready" as const,
    }));

    expect(effectiveMight(state, ally, 0, { isCombat: false })).toBe(3);
  });
});

describe("effectiveMight: Wielder of Water (OGN-055) alone-in-combat self-buff", () => {
  it("gains +2 Might while alone in combat at its battlefield", () => {
    const wielder = makeUnit({ defId: "OGN-055", might: 3 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [wielder] };

    expect(effectiveMight(state, wielder, 0, { isCombat: true, battlefieldId: "bf1" })).toBe(5);
  });

  it("does not buff when another friendly unit shares the battlefield", () => {
    const wielder = makeUnit({ defId: "OGN-055", might: 3 });
    const ally = makeUnit({ might: 2 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [wielder, ally] };

    expect(effectiveMight(state, wielder, 0, { isCombat: true, battlefieldId: "bf1" })).toBe(3);
  });

  it("does not buff outside combat", () => {
    const wielder = makeUnit({ defId: "OGN-055", might: 3 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [wielder] };

    expect(effectiveMight(state, wielder, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(3);
  });
});
