import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type SpellInstance, type UnitInstance } from "../src/model/card.js";
import { answerDecision, optionsFor, pendingDecision, type DecisionOption } from "../src/engine/decisions.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { executePassFocus } from "../src/actions/execute-pass-focus.js";
import { dispatchOnPlayUnit } from "../src/engine/unit-triggers.js";
import type { PendingDecision } from "../src/model/game-state.js";
import type { BattlefieldState, GameState, PlayerState } from "../src/model/game-state.js";

/** Shared test builders for engine tests that need a minimal GameState —
 *  extracted here (rather than redeclared per test file) once card-effect
 *  tests started spanning multiple files (unit triggers, cross-event
 *  triggers, continuous auras, etc. — see the phased card-effects plan). */

export function spellInstance(defId: string): SpellInstance {
  return createCardInstance(defaultCardRegistry().get(defId)) as SpellInstance;
}

/** A real Unit CardInstance straight from the registry (distinct from
 *  makeUnit below, which builds a synthetic test-only unit) — needed by
 *  on-play-unit-trigger tests, which key off a card's real defId. */
export function realUnitInstance(defId: string): UnitInstance {
  return createCardInstance(defaultCardRegistry().get(defId)) as UnitInstance;
}

let unitCounter = 0;
export function makeUnit(overrides: Partial<UnitInstance> = {}): UnitInstance {
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

export function makePlayer(id: string, overrides: Partial<PlayerState> = {}): PlayerState {
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
    floatingRainbowPower: 0,
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
    nextSpellEnergyDiscount: 0,
    nextSpellBonusDamage: 0,
    cannotPlayCardsThisTurn: false,
    hideIgnoresCostThisTurn: false,
    preventsSpellDamageThisTurn: false,
    ...overrides,
  };
}

export function makeState(overrides: Partial<GameState> = {}): GameState {
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

/**
 * Drives triggers held as Chain Pending Items through to resolution, standing in
 * for the two players passing on them.
 *
 * Needed because a converted trigger no longer resolves at its dispatch site: it is
 * held in `pendingTriggers`, finalized onto the chain by the Cleanup, and resolved
 * by two consecutive PassFocus actions (340). A test that calls `addBuff` and then
 * looks straight at `pendingDecisions` is now looking a full response window too
 * early.
 *
 * Stops at a pending question rather than answering it, so callers keep control of
 * the answer — compose with `answerDecisions` for the full sequence. This mirrors
 * `submit`, which likewise refuses a PassFocus while a decision is outstanding
 * (323.2.a).
 *
 * Returns unchanged states unchanged, so it is safe to wrap any call.
 */
export function resolveHeldTriggers(state: GameState): GameState {
  let current = runCleanup(state);
  for (let guard = 0; guard < 32; guard += 1) {
    if (current.pendingDecisions.length > 0) return current;
    if (current.chainOpen) return current;
    current = runCleanup(executePassFocus(current, { type: "PassFocus", playerIndex: current.chainPriority }));
  }
  throw new Error("resolveHeldTriggers: the chain never reopened");
}

/**
 * Answers every pending question, standing in for a player at the board.
 *
 * `pick` chooses among the options on offer; omitted, it takes the first, which
 * for a discard is the front of hand — deliberately the same card the engine
 * used to take on its own. That means a test that does not care WHICH card goes
 * reads exactly as it did before this mechanism existed, and only the tests
 * about the choice itself have to say anything about it.
 */
/**
 * `dispatchOnPlayUnit` and then settle — an on-play unit trigger is a Chain
 * Pending Item now, so the dispatcher only HOLDS it and the effect lands a
 * chain-pop later.
 *
 * For the many tests that are about WHAT a card does rather than WHEN: they
 * assert the card's effect and should not each have to re-assert the chain
 * machinery. `test/on-play-chain.test.ts` is where the timing itself is pinned,
 * and it deliberately does NOT use this.
 */
export function playUnitTrigger(
  state: GameState,
  unit: UnitInstance,
  casterIndex: 0 | 1,
  destination: Parameters<typeof dispatchOnPlayUnit>[3],
  extra?: Parameters<typeof dispatchOnPlayUnit>[4],
): GameState {
  return resolveHeldTriggers(dispatchOnPlayUnit(state, unit, casterIndex, destination, extra));
}

export function answerDecisions(
  state: GameState,
  pick: (options: DecisionOption[], decision: PendingDecision) => string = (options) => options[0]!.id,
): GameState {
  let current = state;
  for (let guard = 0; guard < 32; guard += 1) {
    const decision = pendingDecision(current);
    if (!decision) return current;
    const answered = answerDecision(current, decision.id, pick(optionsFor(current, decision), decision));
    if (!answered) throw new Error(`answerDecisions: the chosen option was refused for ${decision.kind}`);
    current = answered;
  }
  throw new Error("answerDecisions: the queue never emptied");
}

/** Picks the named card when it is on offer, and the first option otherwise —
 *  for the tests whose whole point is that the choice is real. */
export function pickCard(instanceId: string) {
  return (options: DecisionOption[]) => options.find((o) => o.instanceId === instanceId)?.id ?? options[0]!.id;
}
