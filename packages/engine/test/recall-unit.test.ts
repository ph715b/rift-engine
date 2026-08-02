import { describe, expect, it } from "vitest";
import type { GameState, PlayerState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { validateRecallUnit } from "../src/actions/validate-recall-unit.js";
import { executeRecallUnit } from "../src/actions/execute-recall-unit.js";
import type { RecallUnitAction } from "../src/actions/player-action.js";

let unitCounter = 0;
function makeUnit(overrides: Partial<UnitInstance> = {}): UnitInstance {
  unitCounter += 1;
  return {
    instanceId: `unit-${unitCounter}`,
    defId: "TEST-000",
    name: `Test Unit ${unitCounter}`,
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
    mightThisTurn: 0,
    buffed: false,
    stunned: false,
    keywordsThisTurn: {},
    abilityModesUsedThisTurn: [],
    movesThisTurn: 0,
    ...overrides,
  };
}

function makePlayer(id: string): PlayerState {
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
    firstFriendlyDeathUsedThisTurn: false,
    extraMightPerBuffThisTurn: 0,
    discardedThisTurn: false,
    scoredBattlefieldsThisTurn: [],
    unitsEnterReadyThisTurn: false,
    restrictedSpellEnergy: 0,
    restrictedSpellPower: 0,
    nextUnitsEnterReady: 0,
    unitsLostThisTurn: 0,
  };
}

function makeState(): GameState {
  return {
    players: [makePlayer("p1"), makePlayer("p2")],
    battlefields: [{ id: "bf1", name: "Test Battlefield", controllerId: "p1", units: {}, contestedByIndex: null, hiddenCards: [] }],
    activePlayerIndex: 0,
    firstPlayerIndex: 0,
    turnNumber: 1,
    phase: "Action",
    turnState: "Neutral",
    focusHolder: 0,
    showdownBattlefieldId: null,
    showdownKind: null,
    consecutiveFocusPasses: 0,
    chainOpen: true,
    chainPriority: 0,
    chainPasses: 0,
    chainOpenedByTrigger: false,
    spellChain: [],
    pendingTriggers: [],
    deathWardedUnitInstanceIds: [],
    unitsAwaitingDeathReplacement: [],
    pendingDecisions: [],
  };
}

describe("RecallUnit: battlefield -> base", () => {
  it("moves a ready unit from a battlefield back to base, exhausting it", () => {
    const unit = makeUnit();
    let state = makeState();
    state.battlefields[0]!.units = { p1: [unit] };

    const action: RecallUnitAction = { type: "RecallUnit", playerIndex: 0, unitInstanceIds: [unit.instanceId] };
    expect(validateRecallUnit(state, action)).toEqual({ ok: true });

    state = executeRecallUnit(state, action);

    expect(state.battlefields[0]!.units["p1"]).toHaveLength(0);
    expect(state.players[0]!.baseUnits).toHaveLength(1);
    expect(state.players[0]!.baseUnits[0]!.instanceId).toBe(unit.instanceId);
    expect(state.players[0]!.baseUnits[0]!.exhausted).toBe(true); // retreating costs readiness too
  });

  it("does not change the battlefield's controllerId — holds are derived from live presence, not a cached flag", () => {
    const unit = makeUnit();
    let state = makeState();
    state.battlefields[0]!.units = { p1: [unit] };
    state.battlefields[0]!.controllerId = "p1";

    const action: RecallUnitAction = { type: "RecallUnit", playerIndex: 0, unitInstanceIds: [unit.instanceId] };
    state = executeRecallUnit(state, action);

    // Mirrors ActionExecutor.executeRecallUnit (engine/ActionExecutor.java:940-949),
    // which never touches bf.controller either.
    expect(state.battlefields[0]!.controllerId).toBe("p1");
  });

  it("rejects recalling an exhausted unit", () => {
    const unit = makeUnit({ exhausted: true });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [unit] };

    const action: RecallUnitAction = { type: "RecallUnit", playerIndex: 0, unitInstanceIds: [unit.instanceId] };
    expect(validateRecallUnit(state, action).ok).toBe(false);
  });

  it("rejects recalling a unit that isn't at any battlefield", () => {
    const unit = makeUnit();
    const state = makeState();
    state.players[0]!.baseUnits = [unit]; // already at base, not a battlefield

    const action: RecallUnitAction = { type: "RecallUnit", playerIndex: 0, unitInstanceIds: [unit.instanceId] };
    expect(validateRecallUnit(state, action).ok).toBe(false);
  });

  it("rejects recalling out of turn", () => {
    const unit = makeUnit();
    const state = makeState();
    state.battlefields[0]!.units = { p2: [unit] };

    const action: RecallUnitAction = { type: "RecallUnit", playerIndex: 1, unitInstanceIds: [unit.instanceId] };
    expect(validateRecallUnit(state, action).ok).toBe(false);
  });

  it("recalls units from two DIFFERENT battlefields to base in a single action", () => {
    const unitA = makeUnit();
    const unitB = makeUnit();
    let state = makeState();
    state.battlefields.push({ id: "bf2", name: "Test Battlefield 2", controllerId: "p1", units: {}, contestedByIndex: null, hiddenCards: [] });
    state.battlefields[0]!.units = { p1: [unitA] };
    state.battlefields[1]!.units = { p1: [unitB] };

    const action: RecallUnitAction = { type: "RecallUnit", playerIndex: 0, unitInstanceIds: [unitA.instanceId, unitB.instanceId] };
    expect(validateRecallUnit(state, action)).toEqual({ ok: true });

    state = executeRecallUnit(state, action);

    expect(state.battlefields[0]!.units["p1"] ?? []).toHaveLength(0);
    expect(state.battlefields[1]!.units["p1"] ?? []).toHaveLength(0);
    expect(state.players[0]!.baseUnits).toHaveLength(2);
    expect(state.players[0]!.baseUnits.every((u) => u.exhausted)).toBe(true);
  });
});
