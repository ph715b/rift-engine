import { describe, expect, it } from "vitest";
import type { GameState, PlayerState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { validateFloatRune } from "../src/actions/validate-float-rune.js";
import { executeFloatRune } from "../src/actions/execute-float-rune.js";
import type { FloatRuneAction } from "../src/actions/player-action.js";

function rune(id: string, domain: RuneCard["domain"], state: RuneCard["state"] = "Ready"): RuneCard {
  return { id, domain, state };
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
    floatingRainbowPower: 0,
    cardsPlayedThisTurn: 0,
    firstFriendlyDeathUsedThisTurn: false,
    extraMightPerBuffThisTurn: 0,
    discardedThisTurn: false,
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
    unitsLostThisTurn: 0,
    nextSpellEnergyDiscount: 0,
    nextSpellBonusDamage: 0,
    cannotPlayCardsThisTurn: false,
    hideIgnoresCostThisTurn: false,
    preventsSpellDamageThisTurn: false,
    ...overrides,
  };
}

function makeState(overrides: Partial<GameState> = {}): GameState {
  return {
    players: [makePlayer("p1"), makePlayer("p2")],
    battlefields: [],
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
    extraTurns: 0,
    extraTurnsForIndex: 0,
    lastShowdownExcessDamage: null,
    deathWardedUnitInstanceIds: [],
    paidDeathWardUnitInstanceIds: [],
    unitsAwaitingDeathReplacement: [],
    unitsAwaitingFreePlacement: [],
    pendingDecisions: [],
    ...overrides,
  };
}

describe("validateFloatRune", () => {
  it("rejects outside the Action phase", () => {
    const state = makeState({ phase: "Awaken" });
    state.players[0]!.channeled = [rune("r1", "Fury")];
    const action: FloatRuneAction = { type: "FloatRune", playerIndex: 0, runeId: "r1", forPower: false };
    expect(validateFloatRune(state, action).ok).toBe(false);
  });

  it("rejects a rune that isn't in that player's channeled pool", () => {
    const state = makeState();
    const action: FloatRuneAction = { type: "FloatRune", playerIndex: 0, runeId: "not-there", forPower: false };
    expect(validateFloatRune(state, action).ok).toBe(false);
  });

  it("rejects exhausting an already-Exhausted rune for Energy", () => {
    const state = makeState();
    state.players[0]!.channeled = [rune("r1", "Fury", "Exhausted")];
    const action: FloatRuneAction = { type: "FloatRune", playerIndex: 0, runeId: "r1", forPower: false };
    expect(validateFloatRune(state, action).ok).toBe(false);
  });

  it("accepts exhausting a Ready rune for Energy", () => {
    const state = makeState();
    state.players[0]!.channeled = [rune("r1", "Fury", "Ready")];
    const action: FloatRuneAction = { type: "FloatRune", playerIndex: 0, runeId: "r1", forPower: false };
    expect(validateFloatRune(state, action)).toEqual({ ok: true });
  });

  it("accepts recycling for Power whether the rune is Ready or Exhausted", () => {
    const state = makeState();
    state.players[0]!.channeled = [rune("r1", "Fury", "Ready"), rune("r2", "Chaos", "Exhausted")];
    expect(validateFloatRune(state, { type: "FloatRune", playerIndex: 0, runeId: "r1", forPower: true })).toEqual({ ok: true });
    expect(validateFloatRune(state, { type: "FloatRune", playerIndex: 0, runeId: "r2", forPower: true })).toEqual({ ok: true });
  });
});

describe("executeFloatRune", () => {
  it("Energy mode exhausts the rune in place (stays in channeled) and gains 1 floating Energy", () => {
    const state = makeState();
    state.players[0]!.channeled = [rune("r1", "Fury", "Ready")];
    const action: FloatRuneAction = { type: "FloatRune", playerIndex: 0, runeId: "r1", forPower: false };

    const next = executeFloatRune(state, action);
    const actor = next.players[0]!;

    expect(actor.channeled).toHaveLength(1);
    expect(actor.channeled[0]!.state).toBe("Exhausted");
    expect(actor.floatingEnergy).toBe(1);
    expect(actor.runeDeck).toHaveLength(0);
  });

  it("Power mode on a Ready rune recycles it AND credits floating Energy (its Energy potential would otherwise be wasted)", () => {
    const state = makeState();
    state.players[0]!.channeled = [rune("r1", "Chaos", "Ready")];
    const action: FloatRuneAction = { type: "FloatRune", playerIndex: 0, runeId: "r1", forPower: true };

    const next = executeFloatRune(state, action);
    const actor = next.players[0]!;

    expect(actor.channeled).toHaveLength(0);
    expect(actor.runeDeck).toHaveLength(1);
    expect(actor.runeDeck[0]).toEqual({ id: "r1", domain: "Chaos", state: "Ready" });
    expect(actor.floatingPower).toEqual({ Chaos: 1 });
    expect(actor.floatingEnergy).toBe(1);
  });

  it("Power mode on an already-Exhausted rune recycles it WITHOUT crediting floating Energy (nothing was wasted)", () => {
    const state = makeState();
    state.players[0]!.channeled = [rune("r1", "Chaos", "Exhausted")];
    const action: FloatRuneAction = { type: "FloatRune", playerIndex: 0, runeId: "r1", forPower: true };

    const next = executeFloatRune(state, action);
    const actor = next.players[0]!;

    expect(actor.channeled).toHaveLength(0);
    expect(actor.runeDeck).toHaveLength(1);
    expect(actor.floatingPower).toEqual({ Chaos: 1 });
    expect(actor.floatingEnergy).toBe(0);
  });

  it("floating Power from two different domains doesn't clobber each other's count", () => {
    const state = makeState();
    state.players[0]!.channeled = [rune("r1", "Chaos", "Ready"), rune("r2", "Fury", "Ready")];

    let next = executeFloatRune(state, { type: "FloatRune", playerIndex: 0, runeId: "r1", forPower: true });
    next = executeFloatRune(next, { type: "FloatRune", playerIndex: 0, runeId: "r2", forPower: true });

    expect(next.players[0]!.floatingPower).toEqual({ Chaos: 1, Fury: 1 });
    expect(next.players[0]!.floatingEnergy).toBe(2);
  });

  it("throws when called with an invalid action, matching every other execute-* file's contract", () => {
    const state = makeState();
    const action: FloatRuneAction = { type: "FloatRune", playerIndex: 0, runeId: "not-there", forPower: false };
    expect(() => executeFloatRune(state, action)).toThrow();
  });
});
