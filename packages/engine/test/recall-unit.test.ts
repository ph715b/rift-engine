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
    chosenChampionDefId: "TEST-CHAMPION",
    readyRunesAtEndOfTurn: 0,
    spellChoiceDrawnBattlefieldIds: [],
    deck: [],
    hand: [],
    trash: [],
    banished: [],
    activeGear: [],
    runeDeck: [],
    channeled: [],
    baseUnits: [],
    points: 0,
    xp: 0,
    floatingEnergy: 0,
    floatingPower: {},
    floatingRainbowPower: 0,
    cardsPlayedThisTurn: 0,
    firstFriendlyDeathUsedThisTurn: false,
    extraMightPerBuffThisTurn: 0,
    discardedThisTurn: false,
    xpGainedThisTurn: false,
    scoredBattlefieldsThisTurn: [],
    unitsEnterReadyThisTurn: false,
    restrictedSpellEnergy: 0,
    restrictedSpellPower: 0,
    restrictedGearPower: 0,
    gearPlayedThisTurn: 0,
    enemyChoicesThisTurn: 0,
    nextSpellRepeatGrants: 0,
    equipmentPlayedThisTurn: 0,
    nextUnitsEnterReady: 0,
    freeGearPlaysThisTurn: 0,
    trashUnitPlaysThisTurn: 0,
    pointsFromHoldingThisTurn: 0,
    powerSpentThisTurn: 0,
    buffUnitsPlayedThisTurn: 0,
    conqueredBattlefieldsThisTurn: [],
    unitsLostThisTurn: 0,
    nextSpellEnergyDiscount: 0,
    nextSpellBonusDamage: 0,
    cannotPlayCardsThisTurn: false,
    hideIgnoresCostThisTurn: false,
    preventsSpellDamageThisTurn: false,
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
    declaredWinnerIndex: null,
    killDamagedUnitsThisTurn: false,
    spellResolvingForIndex: null,
    markedForDeathOnDamageInstanceIds: [],
    damagePreventedOnceInstanceIds: [],
    extraTurns: 0,
    extraTurnsForIndex: 0,
    lastShowdownExcessDamage: null,
    deathWardedUnitInstanceIds: [],
    paidDeathWardUnitInstanceIds: [],
    unitsAwaitingDeathReplacement: [],
    unitsAwaitingFreePlacement: [],
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

/**
 * Walking a unit home is a MOVE, and it fires what a Move fires.
 *
 * Reported from playtesting: *"I moved a treasure hunter back from a BF and it
 * did not generate a gold gear token."* Treasure Hunter reads "When I move, play
 * a Gold gear token exhausted", and it was right to expect one.
 *
 * **I first called that correct behaviour**, citing 456.1 — "Recalls do not cause
 * Triggered Abilities to trigger that are triggered by Move actions". A true
 * sentence about Recalls, applied to something that is not one. **455 defines a
 * Recall as a relocation to base WITHOUT it being a Move.** A player sending
 * their own unit home is a Move: 446.1 makes any permanent changing position from
 * one space on the Board to another a Move, and 107.1.b makes a Base a Location.
 * The rules' Recalls are system relocations — 457.1's automatic gear recall, and
 * 446.1's "corrective Recall".
 *
 * The engine already agreed everywhere except its events: it exhausts (144.2, the
 * standard move cost) and `validate-recall-unit` gates it through
 * `mayMoveToBaseFrom`, which is Minotaur Reckoner's "units can't move to base".
 * The action is still NAMED `RecallUnit`, inherited from the Java oracle — which
 * is how one misreading came to sit in three places at once.
 */
describe("a unit walking home has moved", () => {
  const originId = "bf1";

  function walkHome(unitCount = 1) {
    const units = Array.from({ length: unitCount }, () => makeUnit());
    const state = makeState();
    state.battlefields[0]!.units = { p1: units };
    const action: RecallUnitAction = {
      type: "RecallUnit",
      playerIndex: 0,
      unitInstanceIds: units.map((u) => u.instanceId),
    };
    return { after: executeRecallUnit(state, action), units };
  }

  it("counts the walk home as a move on the unit", () => {
    const { after, units } = walkHome();
    // `movesThisTurn` is what a "when I move" card and Miss Fortune - Captain both
    // read. It was not incremented before this change, so a unit could walk out
    // and back all turn and read as never having moved.
    const home = after.players[0]!.baseUnits.find((u) => u.instanceId === units[0]!.instanceId);
    expect(home, "the unit never arrived in base").toBeDefined();
    expect(home!.movesThisTurn, "walking home did not count as a move").toBe(1);
  });

  it("counts one move per unit in a group walk-home", () => {
    // A group retreat is several moves, and "when I move" is asked of each mover.
    const { after, units } = walkHome(3);
    const homed = units.map((u) => after.players[0]!.baseUnits.find((b) => b.instanceId === u.instanceId));
    expect(homed.every((u) => u !== undefined), "not everyone came home").toBe(true);
    expect(homed.map((u) => u!.movesThisTurn), "some unit's move was not counted").toEqual([1, 1, 1]);
  });

  it("still exhausts them — 144.2, the standard move cost", () => {
    // The half that was already right, kept as a control: making the walk a Move
    // must not have made it free.
    const { after, units } = walkHome();
    expect(after.players[0]!.baseUnits.find((u) => u.instanceId === units[0]!.instanceId)!.exhausted).toBe(true);
  });
});
