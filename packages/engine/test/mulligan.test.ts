import { describe, expect, it } from "vitest";
import type { GameState, PlayerState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { validateMulligan } from "../src/actions/validate-mulligan.js";
import { executeMulligan } from "../src/actions/execute-mulligan.js";
import type { MulliganAction } from "../src/actions/mulligan-action.js";

let unitCounter = 0;
function makeCard(overrides: Partial<UnitInstance> = {}): UnitInstance {
  unitCounter += 1;
  return {
    instanceId: `card-${unitCounter}`,
    defId: "TEST-000",
    name: `Test Card ${unitCounter}`,
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
  return {
    players: [makePlayer("p1"), makePlayer("p2")],
    battlefields: [],
    activePlayerIndex: 0,
    firstPlayerIndex: 0,
    turnNumber: 1,
    phase: "Awaken",
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

describe("validateMulligan", () => {
  it("rejects setting aside more than 2 cards", () => {
    const [c1, c2, c3] = [makeCard(), makeCard(), makeCard()];
    const state = makeState();
    state.players[0]!.hand = [c1, c2, c3];

    const action: MulliganAction = { type: "Mulligan", playerIndex: 0, setAsideInstanceIds: [c1.instanceId, c2.instanceId, c3.instanceId] };
    expect(validateMulligan(state, action).ok).toBe(false);
  });

  it("rejects a duplicate id in the set-aside list", () => {
    const c1 = makeCard();
    const state = makeState();
    state.players[0]!.hand = [c1];

    const action: MulliganAction = { type: "Mulligan", playerIndex: 0, setAsideInstanceIds: [c1.instanceId, c1.instanceId] };
    expect(validateMulligan(state, action).ok).toBe(false);
  });

  it("rejects an id that isn't in that player's hand", () => {
    const c1 = makeCard();
    const state = makeState();
    state.players[0]!.hand = [c1];

    const action: MulliganAction = { type: "Mulligan", playerIndex: 0, setAsideInstanceIds: ["not-in-hand"] };
    expect(validateMulligan(state, action).ok).toBe(false);
  });

  it("accepts 0, 1, or 2 valid ids", () => {
    const [c1, c2] = [makeCard(), makeCard()];
    const state = makeState();
    state.players[0]!.hand = [c1, c2];

    expect(validateMulligan(state, { type: "Mulligan", playerIndex: 0, setAsideInstanceIds: [] })).toEqual({ ok: true });
    expect(validateMulligan(state, { type: "Mulligan", playerIndex: 0, setAsideInstanceIds: [c1.instanceId] })).toEqual({ ok: true });
    expect(
      validateMulligan(state, { type: "Mulligan", playerIndex: 0, setAsideInstanceIds: [c1.instanceId, c2.instanceId] }),
    ).toEqual({ ok: true });
  });
});

describe("executeMulligan", () => {
  it("keeps hand size and deck size unchanged overall, swapping set-aside cards for the deck's front cards", () => {
    const hand = [makeCard({ name: "Keep A" }), makeCard({ name: "Keep B" }), makeCard({ name: "Aside A" }), makeCard({ name: "Aside B" })];
    const deck = [makeCard({ name: "Deck 1" }), makeCard({ name: "Deck 2" }), makeCard({ name: "Deck 3" })];
    const state = makeState();
    state.players[0]!.hand = hand;
    state.players[0]!.deck = deck;

    const asideA = hand[2]!;
    const asideB = hand[3]!;
    const action: MulliganAction = { type: "Mulligan", playerIndex: 0, setAsideInstanceIds: [asideA.instanceId, asideB.instanceId] };
    expect(validateMulligan(state, action)).toEqual({ ok: true });

    const next = executeMulligan(state, action);
    const actor = next.players[0]!;

    expect(actor.hand).toHaveLength(4);
    expect(actor.deck).toHaveLength(3);
    expect(actor.hand.some((c) => c.instanceId === asideA.instanceId)).toBe(false);
    expect(actor.hand.some((c) => c.instanceId === asideB.instanceId)).toBe(false);
    expect(actor.hand.map((c) => c.name)).toEqual(["Keep A", "Keep B", "Deck 1", "Deck 2"]);
  });

  it("recycles set-aside cards to the bottom of the deck in their original relative hand order, not draw order", () => {
    const asideFirst = makeCard({ name: "Aside First (set aside first in hand order)" });
    const keep = makeCard({ name: "Keep" });
    const asideSecond = makeCard({ name: "Aside Second (set aside second in hand order)" });
    const hand = [asideFirst, keep, asideSecond];
    const deck = [makeCard({ name: "Deck 1" })];
    const state = makeState();
    state.players[0]!.hand = hand;
    state.players[0]!.deck = deck;

    // List the ids in the OPPOSITE order from their hand position, to prove
    // the result follows original hand order, not the order listed in the action.
    const action: MulliganAction = {
      type: "Mulligan",
      playerIndex: 0,
      setAsideInstanceIds: [asideSecond.instanceId, asideFirst.instanceId],
    };

    const next = executeMulligan(state, action);
    const actor = next.players[0]!;

    expect(actor.deck.map((c) => c.name)).toEqual(["Aside First (set aside first in hand order)", "Aside Second (set aside second in hand order)"]);
  });

  it("draws no replacement it just recycled — a mulligan can never redraw its own set-aside card", () => {
    const asideA = makeCard({ name: "Aside A" });
    const asideB = makeCard({ name: "Aside B" });
    const keep = makeCard({ name: "Keep" });
    const state = makeState();
    // Deck is EMPTY before the mulligan — if the executor ever appended the
    // set-aside cards before drawing, it would wrongly redraw one of them.
    state.players[0]!.hand = [keep, asideA, asideB];
    state.players[0]!.deck = [];

    const action: MulliganAction = { type: "Mulligan", playerIndex: 0, setAsideInstanceIds: [asideA.instanceId, asideB.instanceId] };
    const next = executeMulligan(state, action);
    const actor = next.players[0]!;

    // Deck was empty, so 0 replacements are drawable — hand shrinks to just what was kept.
    expect(actor.hand).toEqual([keep]);
    expect(actor.deck.map((c) => c.name)).toEqual(["Aside A", "Aside B"]);
  });

  it("gracefully handles a deck that can't cover every replacement (draws fewer, still recycles all set-aside cards)", () => {
    const asideA = makeCard({ name: "Aside A" });
    const asideB = makeCard({ name: "Aside B" });
    const keep = makeCard({ name: "Keep" });
    const onlyDeckCard = makeCard({ name: "Only Deck Card" });
    const state = makeState();
    state.players[0]!.hand = [keep, asideA, asideB];
    state.players[0]!.deck = [onlyDeckCard]; // only 1 card available, but 2 were set aside

    const action: MulliganAction = { type: "Mulligan", playerIndex: 0, setAsideInstanceIds: [asideA.instanceId, asideB.instanceId] };
    const next = executeMulligan(state, action);
    const actor = next.players[0]!;

    // Only 1 replacement was drawable, so the hand ends at 3, not 4.
    expect(actor.hand.map((c) => c.name)).toEqual(["Keep", "Only Deck Card"]);
    // Both set-aside cards still get recycled, even though the deck emptied out.
    expect(actor.deck.map((c) => c.name)).toEqual(["Aside A", "Aside B"]);
  });

  it("throws when called with an invalid action, matching every other execute-* file's contract", () => {
    const state = makeState();
    state.players[0]!.hand = [];

    const action: MulliganAction = { type: "Mulligan", playerIndex: 0, setAsideInstanceIds: ["not-in-hand"] };
    expect(() => executeMulligan(state, action)).toThrow();
  });
});
