import { describe, expect, it } from "vitest";
import type { UnitInstance } from "../src/model/card.js";
import type { BattlefieldState, GameState, PlayerState } from "../src/model/game-state.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { legalActions } from "../src/engine/legal-actions.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { submit } from "../src/engine/game-engine.js";

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
    mightThisTurn: 0,
    buffed: false,
    stunned: false,
    keywordsThisTurn: {},
    abilityModesUsedThisTurn: [],
    movesThisTurn: 0,
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
    chosenChampionDefId: "TEST-CHAMPION",
    readyRunesAtEndOfTurn: 0,
    spellChoiceDrawnBattlefieldIds: [],
    starSpringUsedBattlefieldIds: [],
    nonTokenUnitSurchargeThisTurn: 0,
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
    restrictedUnitEnergy: 0,
    restrictedSpellPower: 0,
    restrictedGearPower: 0,
    gearPlayedThisTurn: 0,
    nonTokenUnitsPlayedThisTurn: 0,
    enemyChoicesThisTurn: 0,
    nextSpellRepeatGrants: 0,
    equipmentPlayedThisTurn: 0,
    nextUnitsEnterReady: 0,
    freeGearPlaysThisTurn: 0,
    trashUnitPlaysThisTurn: 0,
    replacedCostPlays: [],
    banishedUntilHold: [],
    pointsFromHoldingThisTurn: 0,
    powerSpentThisTurn: 0,
    maxSpellEnergySpentThisTurn: 0,
    spellsPlayedThisTurn: 0,
    cardsDrawnThisTurn: 0,
    buffUnitsPlayedThisTurn: 0,
    conqueredBattlefieldsThisTurn: [],
    unitsLostThisTurn: 0,
    nextSpellEnergyDiscount: 0,
    nextCardEnergyDiscount: 0,
    nextCardPowerDiscount: 0,
    nextSpellBonusDamage: 0,
    cannotPlayCardsThisTurn: false,
    cannotPlaySpellsThisTurn: false,
    unitsLostInBeginningPhaseThisTurn: 0,
    hideIgnoresCostThisTurn: false,
    preventsSpellDamageThisTurn: false,
    ...overrides,
  };
}

function makeState(overrides: Partial<GameState> = {}): GameState {
  const p1 = makePlayer("p1");
  const p2 = makePlayer("p2");
  const battlefields: BattlefieldState[] = [
    { id: "bf1", name: "Battlefield 1", controllerId: null, units: {}, contestedByIndex: null, hiddenCards: [] },
    { id: "bf2", name: "Battlefield 2", controllerId: null, units: {}, contestedByIndex: null, hiddenCards: [] },
  ];
  return {
    players: [p1, p2],
    battlefields,
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
    movementLockedUnitInstanceIds: [],
    spellResolvingForIndex: null,
    markedForDeathOnDamageInstanceIds: [],
    damagePreventedOnceInstanceIds: [],
    damagePreventionPoolByInstanceId: {},
    disempowerAtEndOfTurn: [],
    empowerAtEndOfTurn: [],
    damageInstancesByCardThisTurn: {},
    extraTurns: 0,
    extraTurnsForIndex: 0,
    lastShowdownExcessDamage: null,
    deathWardedUnitInstanceIds: [],
    banishOnDeathUnitInstanceIds: [],
    damageDoubledUnitInstanceIds: [],
    paidDeathWardUnitInstanceIds: [],
    unitsAwaitingDeathReplacement: [],
    unitsAwaitingFreePlacement: [],
    pendingDecisions: [],
    ...overrides,
  };
}

describe("PlayCard: direct-to-battlefield Unit deploy (reinforce)", () => {
  it("walk-in reinforce: adds the unit to an already-occupied, uncontested battlefield with no Showdown", () => {
    const existing = makeUnit({ might: 2 });
    const played = makeUnit({ might: 3 });
    let state = makeState();
    state.players[0]!.hand = [played];
    state.battlefields[0]!.units = { p1: [existing] };
    state.battlefields[0]!.controllerId = "p1";

    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: played,
      payment: { energyRunes: [], powerRunes: [] },
      destinationBattlefieldId: "bf1",
    };

    expect(validatePlayCard(state, action)).toEqual({ ok: true });

    state = executePlayCard(state, action);

    expect(state.battlefields[0]!.units["p1"]).toHaveLength(2);
    expect(state.battlefields[0]!.units["p1"]!.some((u) => u.instanceId === played.instanceId)).toBe(true);
    expect(state.battlefields[0]!.controllerId).toBe("p1");
    expect(state.turnState).toBe("Neutral"); // no Showdown
    expect(state.players[0]!.hand).toHaveLength(0);
  });

  it("[Quick]-exhaustion is identical regardless of destination: a non-Quick unit enters exhausted, a Quick one enters ready", () => {
    const existing = makeUnit({ might: 2 });
    const playedPlain = makeUnit({ might: 3 });
    const playedQuick = makeUnit({ might: 3, keywords: { Quick: 1 } });
    let state = makeState();
    state.players[0]!.hand = [playedPlain, playedQuick];
    state.battlefields[0]!.units = { p1: [existing] };

    state = executePlayCard(state, {
      type: "PlayCard",
      playerIndex: 0,
      card: playedPlain,
      payment: { energyRunes: [], powerRunes: [] },
      destinationBattlefieldId: "bf1",
    });
    const deployedPlain = state.battlefields[0]!.units["p1"]!.find((u) => u.instanceId === playedPlain.instanceId)!;
    expect(deployedPlain.exhausted).toBe(true);

    state = executePlayCard(state, {
      type: "PlayCard",
      playerIndex: 0,
      card: playedQuick,
      payment: { energyRunes: [], powerRunes: [] },
      destinationBattlefieldId: "bf1",
    });
    const deployedQuick = state.battlefields[0]!.units["p1"]!.find((u) => u.instanceId === playedQuick.instanceId)!;
    expect(deployedQuick.exhausted).toBe(false);
  });

  it("contested reinforce opens a Showdown instead of resolving immediately", () => {
    const ownUnit = makeUnit({ might: 2 });
    const enemyUnit = makeUnit({ might: 2 });
    const played = makeUnit({ might: 4 });
    let state = makeState();
    state.players[0]!.hand = [played];
    // Actor must already have presence here for the play to be legal at all —
    // unlike MoveUnit's contested test, which starts the mover with zero prior presence.
    state.battlefields[0]!.units = { p1: [ownUnit], p2: [enemyUnit] };

    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: played,
      payment: { energyRunes: [], powerRunes: [] },
      destinationBattlefieldId: "bf1",
    };

    expect(validatePlayCard(state, action)).toEqual({ ok: true });

    // Through submit: playing the unit applies Contested (190.3.a's "Moves or
    // otherwise becomes present"), and the following Cleanup stages the window.
    state = submit(state, action).state;

    expect(state.turnState).toBe("Showdown");
    expect(state.showdownKind).toBe("Combat"); // opposing units present
    expect(state.focusHolder).toBe(0);
    expect(state.showdownBattlefieldId).toBe("bf1");
    expect(state.consecutiveFocusPasses).toBe(0);
    // Combat hasn't resolved yet — both sides' units still present, plus the new arrival.
    expect(state.battlefields[0]!.units["p1"]).toHaveLength(2);
    expect(state.battlefields[0]!.units["p2"]).toHaveLength(1);
  });

  it("rejects deploying to a battlefield where the actor has no units", () => {
    const played = makeUnit();
    const state = makeState();
    state.players[0]!.hand = [played];
    // bf1 has no p1 presence at all.

    const result = validatePlayCard(state, {
      type: "PlayCard",
      playerIndex: 0,
      card: played,
      payment: { energyRunes: [], powerRunes: [] },
      destinationBattlefieldId: "bf1",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects deploying to a nonexistent battlefield id", () => {
    const existing = makeUnit();
    const played = makeUnit();
    const state = makeState();
    state.players[0]!.hand = [played];
    state.battlefields[0]!.units = { p1: [existing] };

    const result = validatePlayCard(state, {
      type: "PlayCard",
      playerIndex: 0,
      card: played,
      payment: { energyRunes: [], powerRunes: [] },
      destinationBattlefieldId: "does-not-exist",
    });
    expect(result.ok).toBe(false);
  });
});

describe("legalActions: reinforce fan-out", () => {
  it("fans out one reinforce candidate per battlefield the actor already occupies, alongside the unconditional base-play candidate", () => {
    const presence = makeUnit();
    const played = makeUnit();
    const state = makeState();
    state.players[0]!.hand = [played];
    state.battlefields[0]!.units = { p1: [presence] }; // bf1: actor has presence
    // bf2: no presence — should NOT get a reinforce candidate.

    const actions = legalActions(state);
    const forPlayed = actions.filter(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === played.instanceId,
    );

    expect(forPlayed).toHaveLength(2); // base-play + bf1 reinforce
    expect(forPlayed.some((a) => a.destinationBattlefieldId === undefined)).toBe(true);
    expect(forPlayed.some((a) => a.destinationBattlefieldId === "bf1")).toBe(true);
    expect(forPlayed.some((a) => a.destinationBattlefieldId === "bf2")).toBe(false);
  });

  it("a Unit with zero reinforceable battlefields still yields exactly one PlayCard candidate (no regression)", () => {
    const played = makeUnit();
    const state = makeState(); // empty board, no presence anywhere
    state.players[0]!.hand = [played];

    const actions = legalActions(state);
    const forPlayed = actions.filter(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === played.instanceId,
    );
    expect(forPlayed).toHaveLength(1);
    expect(forPlayed[0]!.destinationBattlefieldId).toBeUndefined();
  });
});
