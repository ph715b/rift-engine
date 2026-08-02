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

/**
 * Sett - Kingpin (OGN-240): "I get +1 Might for each buffed friendly unit at my
 * battlefield."
 *
 * Self-scaling off the BOARD rather than a zone — it moves as neighbours are
 * buffed, arrive, leave or spend their buffs, which is why it is recomputed on
 * read rather than written into state.
 *
 * The self-inclusion case is the one worth pinning: his text omits the "other"
 * that Garen - Commander, Darius - Executioner and Lee Sin - Centered all print,
 * so a buffed Sett counts himself. In the deck he is actually played in — which
 * runs Cithria, Showstopper and Call to Glory to buff things — that is a real
 * point of Might, not a technicality.
 */
describe("effectiveMight: Sett - Kingpin (OGN-240) counts buffed neighbours", () => {
  const SETT_KINGPIN = "OGN-240";

  /** Sett plus `others` standing together at bf1. */
  function atBattlefield(sett: ReturnType<typeof makeUnit>, others: ReturnType<typeof makeUnit>[]) {
    const state = makeState();
    state.battlefields[0]!.units = { p1: [sett, ...others] };
    return state;
  }

  it("adds +1 per buffed friendly unit standing with him", () => {
    const sett = makeUnit({ defId: SETT_KINGPIN, might: 4 });
    const state = atBattlefield(sett, [makeUnit({ buffed: true }), makeUnit({ buffed: true })]);

    expect(effectiveMight(state, sett, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(6);
  });

  it("ignores UNBUFFED friendlies — a body alone is worth nothing to him", () => {
    const sett = makeUnit({ defId: SETT_KINGPIN, might: 4 });
    const state = atBattlefield(sett, [makeUnit({ buffed: false }), makeUnit({ buffed: false })]);

    expect(effectiveMight(state, sett, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(4);
  });

  it("counts HIMSELF when buffed — his text omits the 'other' the other auras print", () => {
    const sett = makeUnit({ defId: SETT_KINGPIN, might: 4, buffed: true });
    const state = atBattlefield(sett, []);

    // 4 printed, +1 for the Buff itself (710), +1 for counting himself.
    expect(effectiveMight(state, sett, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(6);
  });

  it("ignores the ENEMY's buffed units at the same battlefield", () => {
    const sett = makeUnit({ defId: SETT_KINGPIN, might: 4 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [sett], p2: [makeUnit({ buffed: true }), makeUnit({ buffed: true })] };

    expect(effectiveMight(state, sett, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(4);
  });

  it("is worth nothing in base — 'at my battlefield' is positional", () => {
    const sett = makeUnit({ defId: SETT_KINGPIN, might: 4 });
    const state = makeState();
    state.players[0]!.baseUnits = [sett, makeUnit({ buffed: true })];

    expect(effectiveMight(state, sett, 0, { isCombat: false })).toBe(4);
  });

  it("does not reach a buffed friendly at a DIFFERENT battlefield", () => {
    const sett = makeUnit({ defId: SETT_KINGPIN, might: 4 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [sett] };
    state.battlefields[1]!.units = { p1: [makeUnit({ buffed: true })] };

    expect(effectiveMight(state, sett, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(4);
  });
});

/**
 * Draven - Showboat (OGN-028): "My Might is increased by your points."
 *
 * The first aura here that scales off a PLAYER COUNTER rather than off a zone or
 * the board — Dr. Mundo counts a trash, Sett - Kingpin counts neighbours, Draven
 * counts the score. Recomputed on read like the rest, so he grows the instant a
 * point is scored and shrinks if a point is ever taken away.
 *
 * Two things worth pinning, because both are readings of the printed text rather
 * than of the mechanism: it is the OWNER's points ("your"), not the asker's, and
 * it is NOT positional — his text names no battlefield, so unlike Sett - Kingpin
 * and Lee Sin he carries it in base as well.
 */
describe("effectiveMight: Draven - Showboat (OGN-028) rides his controller's score", () => {
  const DRAVEN_SHOWBOAT = "OGN-028";

  it("adds the owner's points to his printed Might", () => {
    const draven = makeUnit({ defId: DRAVEN_SHOWBOAT, might: 3 });
    const state = makeState();
    state.players[0]!.baseUnits = [draven];
    state.players[0]!.points = 4;

    expect(effectiveMight(state, draven, 0, { isCombat: false })).toBe(7);
  });

  it("is his printed Might at zero points — the aura is not a flat bonus", () => {
    const draven = makeUnit({ defId: DRAVEN_SHOWBOAT, might: 3 });
    const state = makeState();
    state.players[0]!.baseUnits = [draven];

    expect(effectiveMight(state, draven, 0, { isCombat: false })).toBe(3);
  });

  it("reads the OWNER's points, not the opponent's", () => {
    // The distinction Dr. Mundo's "your trash" already draws. An enemy Draven
    // must not grow off the score of whoever is asking about his Might.
    const draven = makeUnit({ defId: DRAVEN_SHOWBOAT, might: 3 });
    const state = makeState();
    state.players[1]!.baseUnits = [draven];
    state.players[0]!.points = 5;
    state.players[1]!.points = 1;

    expect(effectiveMight(state, draven, 1, { isCombat: false })).toBe(4);
  });

  it("carries it at a battlefield too — his text names no location", () => {
    const draven = makeUnit({ defId: DRAVEN_SHOWBOAT, might: 3 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [draven] };
    state.players[0]!.points = 2;

    expect(effectiveMight(state, draven, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(5);
  });

  it("reaches no other unit — it is a self-aura, not a board one", () => {
    const draven = makeUnit({ defId: DRAVEN_SHOWBOAT, might: 3 });
    const ally = makeUnit({ might: 3 });
    const state = makeState();
    state.players[0]!.baseUnits = [draven, ally];
    state.players[0]!.points = 4;

    expect(effectiveMight(state, ally, 0, { isCombat: false })).toBe(3);
  });
});
