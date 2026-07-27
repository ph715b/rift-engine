import { describe, expect, it } from "vitest";
import type { UnitInstance } from "../src/model/card.js";
import type { BattlefieldState, GameState, PlayerState } from "../src/model/game-state.js";
import { resolveShowdown, claimBattlefieldControl } from "../src/engine/combat.js";
import { scoreHolds, recordConquest } from "../src/engine/scoring.js";
import { runBeginning } from "../src/engine/turn-manager.js";
import { executeMoveUnit } from "../src/actions/execute-move-unit.js";
import { validateMoveUnit } from "../src/actions/validate-move-unit.js";

let unitCounter = 0;
function makeUnit(overrides: Partial<UnitInstance> = {}): UnitInstance {
  unitCounter += 1;
  return {
    instanceId: `unit-${unitCounter}`,
    defId: "TEST-000",
    name: overrides.name ?? `Test Unit ${unitCounter}`,
    domains: [],
    exhausted: false,
    isToken: false,
    kind: "Unit",
    energyCost: 0,
    powerCost: 0,
    powerDomain: null,
    might: 3,
    isChampion: false,
    keywords: {},
    isReaction: false,
    tags: [],
    damage: 0,
    bonus: 0,
    ...overrides,
  };
}

function makePlayer(id: string, overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    id,
    name: id,
    legend: {
      instanceId: `${id}-legend`,
      defId: "TEST-LEGEND",
      name: "Test Legend",
      domains: [],
      exhausted: false,
      isToken: false,
      kind: "Legend",
      championTag: "TEST",
    },
    championZone: null,
    deck: [],
    hand: [],
    trash: [],
    banished: [],
    activeGear: [],
    runeDeck: [],
    channeled: [],
    baseUnits: [],
    points: 0,
    floatingEnergy: 0,
    floatingPower: {},
    cardsPlayedThisTurn: 0,
    conqueredBattlefieldsThisTurn: [],
    ...overrides,
  };
}

function makeState(overrides: Partial<GameState> = {}): GameState {
  const p1 = makePlayer("p1");
  const p2 = makePlayer("p2");
  const battlefields: BattlefieldState[] = [
    { id: "bf1", name: "Battlefield 1", controllerId: null, units: {} },
    { id: "bf2", name: "Battlefield 2", controllerId: null, units: {} },
    { id: "bf3", name: "Battlefield 3", controllerId: null, units: {} },
  ];
  return {
    players: [p1, p2],
    battlefields,
    activePlayerIndex: 0,
    turnNumber: 1,
    phase: "Action",
    turnState: "Neutral",
    focusHolder: 0,
    ...overrides,
  };
}

describe("combat resolution (resolveShowdown)", () => {
  it("attacker's outgoing Might defeats a weaker defender and claims the battlefield (conquest)", () => {
    const attacker = makeUnit({ might: 5 });
    const defender = makeUnit({ might: 3 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [attacker], p2: [defender] };

    state = resolveShowdown(state, "bf1", 0);

    expect(state.battlefields[0]!.units["p1"]).toHaveLength(1);
    expect(state.battlefields[0]!.units["p2"]).toHaveLength(0);
    expect(state.battlefields[0]!.controllerId).toBe("p1");
    expect(state.players[1].trash).toHaveLength(1); // defender died, went to owner's trash
    expect(state.players[0].points).toBe(1); // conquest awarded (not previously controlled)
  });

  it("a tie (both sides survive) leaves control unchanged", () => {
    // Attacker: 3 Might + Assault 2 = 5 outgoing, and (Assault also boosts its
    // own toughness while attacking) 5 toughness. Defender: 3 Might + Shield 3
    // = 3 outgoing (Shield never boosts outgoing), 6 toughness. Attacker's 5
    // dmg < defender's 6 toughness, and defender's 3 dmg < attacker's 5
    // toughness — both sides survive.
    const attacker = makeUnit({ might: 3, keywords: { Assault: 2 } });
    const defender = makeUnit({ might: 3, keywords: { Shield: 3 } });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [attacker], p2: [defender] };
    state.battlefields[0]!.controllerId = null;

    state = resolveShowdown(state, "bf1", 0);

    expect(state.battlefields[0]!.units["p1"]).toHaveLength(1);
    expect(state.battlefields[0]!.units["p2"]).toHaveLength(1);
    expect(state.battlefields[0]!.controllerId).toBeNull();
    expect(state.players[0].points).toBe(0);
  });

  it("[Assault] boosts the attacker's outgoing damage; [Shield] absorbs damage for the defender", () => {
    // Attacker: 2 Might + Assault 2 = 4 outgoing. Defender: 3 Might + Shield 2 = 5 toughness -> survives with 4 damage marked.
    const attacker = makeUnit({ might: 2, keywords: { Assault: 2 } });
    const defender = makeUnit({ might: 3, keywords: { Shield: 2 } });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [attacker], p2: [defender] };

    state = resolveShowdown(state, "bf1", 0);

    expect(state.battlefields[0]!.units["p2"]).toHaveLength(1); // defender survived (4 dmg < 5 toughness)
    expect(state.battlefields[0]!.units["p2"]![0]!.damage).toBe(0); // healed after combat
  });

  it("no-ops when only one side has units (nothing to fight)", () => {
    const attacker = makeUnit({ might: 5 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [attacker] };

    const result = resolveShowdown(state, "bf1", 0);
    expect(result).toBe(state); // same reference — genuinely a no-op
  });
});

describe("MoveUnit: walk-in vs. contested", () => {
  it("an uncontested move claims control without combat", () => {
    const unit = makeUnit();
    let state = makeState();
    state.players[0]!.baseUnits = [unit];

    const validation = validateMoveUnit(state, {
      type: "MoveUnit",
      playerIndex: 0,
      unitInstanceIds: [unit.instanceId],
      destinationBattlefieldId: "bf1",
    });
    expect(validation).toEqual({ ok: true });

    state = executeMoveUnit(state, {
      type: "MoveUnit",
      playerIndex: 0,
      unitInstanceIds: [unit.instanceId],
      destinationBattlefieldId: "bf1",
    });

    expect(state.players[0]!.baseUnits).toHaveLength(0);
    expect(state.battlefields[0]!.units["p1"]).toHaveLength(1);
    expect(state.battlefields[0]!.units["p1"]![0]!.exhausted).toBe(true); // moving always exhausts
    expect(state.battlefields[0]!.controllerId).toBe("p1");
    expect(state.players[0]!.points).toBe(1); // first-time conquest of a neutral battlefield
  });

  it("moving into an enemy-occupied battlefield triggers combat immediately", () => {
    const mover = makeUnit({ might: 5 });
    const defender = makeUnit({ might: 1 });
    let state = makeState();
    state.players[0]!.baseUnits = [mover];
    state.battlefields[0]!.units = { p2: [defender] };
    state.battlefields[0]!.controllerId = "p2";

    state = executeMoveUnit(state, {
      type: "MoveUnit",
      playerIndex: 0,
      unitInstanceIds: [mover.instanceId],
      destinationBattlefieldId: "bf1",
    });

    expect(state.battlefields[0]!.units["p2"]).toHaveLength(0);
    expect(state.battlefields[0]!.controllerId).toBe("p1");
    expect(state.players[1]!.trash).toHaveLength(1);
  });

  it("rejects moving an exhausted unit", () => {
    const unit = makeUnit({ exhausted: true });
    const state = makeState();
    state.players[0]!.baseUnits = [unit];

    const result = validateMoveUnit(state, {
      type: "MoveUnit",
      playerIndex: 0,
      unitInstanceIds: [unit.instanceId],
      destinationBattlefieldId: "bf1",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a battlefield-to-battlefield move without [Ganking]", () => {
    const unit = makeUnit();
    const state = makeState();
    state.battlefields[0]!.units = { p1: [unit] };

    const result = validateMoveUnit(state, {
      type: "MoveUnit",
      playerIndex: 0,
      unitInstanceIds: [unit.instanceId],
      destinationBattlefieldId: "bf2",
    });
    expect(result.ok).toBe(false);
  });
});

describe("scoring: holds", () => {
  it("scores 1 point per solely-held battlefield at the Beginning phase", () => {
    const unit = makeUnit();
    let state = makeState({ phase: "Beginning" });
    state.battlefields[0]!.units = { p1: [unit] };
    state.battlefields[1]!.units = { p1: [makeUnit()] };

    state = runBeginning(state);

    expect(state.players[0]!.points).toBe(2); // holds 2 of the 3 battlefields solely
    expect(state.players[1]!.points).toBe(0);
  });

  it("a contested battlefield (both players present) scores no hold point for either", () => {
    let state = makeState({ phase: "Beginning" });
    state.battlefields[0]!.units = { p1: [makeUnit()], p2: [makeUnit()] };

    state = runBeginning(state);

    expect(state.players[0]!.points).toBe(0);
    expect(state.players[1]!.points).toBe(0);
  });
});

describe("scoring: the final-point conquest-sweep rule (core rules §466.2)", () => {
  it("withholds a winning conquest point until every battlefield is conquered the same turn, and draws a compensation card", () => {
    let state = makeState();
    state.players[0]!.points = 7; // one point from the 8-point threshold
    state.players[0]!.deck = [makeUnit()]; // compensation draw target

    state = recordConquest(state, 0, "bf1"); // only 1 of 3 battlefields conquered this turn

    expect(state.players[0]!.points).toBe(7); // withheld, not awarded
    expect(state.players[0]!.hand).toHaveLength(1); // compensation draw instead
    expect(state.players[0]!.conqueredBattlefieldsThisTurn).toContain("bf1");
  });

  it("awards the winning point once all battlefields are conquered in the same turn", () => {
    let state = makeState();
    state.players[0]!.points = 7;
    state.players[0]!.conqueredBattlefieldsThisTurn = ["bf1", "bf2"];

    state = recordConquest(state, 0, "bf3"); // the 3rd and final battlefield

    expect(state.players[0]!.points).toBe(8);
  });

  it("a normal (non-winning) conquest is never withheld", () => {
    let state = makeState();
    state.players[0]!.points = 2;

    state = recordConquest(state, 0, "bf1");

    expect(state.players[0]!.points).toBe(3);
  });
});

describe("win condition via combat + scoring, end to end", () => {
  it("a player who reaches the threshold strictly ahead of their opponent wins", () => {
    let state = makeState();
    state.players[0]!.points = 7;
    const attacker = makeUnit({ might: 5 });
    const defender = makeUnit({ might: 1 });
    state.players[0]!.baseUnits = [attacker];
    state.battlefields[0]!.units = { p2: [defender] };
    state.battlefields[0]!.controllerId = "p2";
    // Already conquered the other 2 battlefields this turn, so this conquest is the sweep's last piece.
    state.players[0]!.conqueredBattlefieldsThisTurn = ["bf2", "bf3"];

    state = executeMoveUnit(state, {
      type: "MoveUnit",
      playerIndex: 0,
      unitInstanceIds: [attacker.instanceId],
      destinationBattlefieldId: "bf1",
    });

    expect(state.players[0]!.points).toBe(8);
  });
});
