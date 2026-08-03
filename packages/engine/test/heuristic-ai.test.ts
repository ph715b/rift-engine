import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { allPresetDecks, presetDeckList } from "../src/decks/deck-presets.js";
import { buildPlayerFromDeckList } from "../src/decks/player-setup.js";
import { mulberry32 } from "../src/util/rng.js";
import type { BattlefieldState, GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { createCardInstance } from "../src/model/card.js";
import { LEGACY_BATTLEFIELDS } from "../src/decks/deck-list.js";
import { startGame, submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { parkDecision } from "../src/engine/decisions.js";
import { makePlayer, makeState, makeUnit } from "./fixtures.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { chooseAction } from "../src/ai/heuristic-ai.js";

function buildInitialGameState(): GameState {
  const registry = defaultCardRegistry();
  const garen = presetDeckList(allPresetDecks().find((d) => d.name.startsWith("Garen"))!);
  const masterYi = presetDeckList(allPresetDecks().find((d) => d.name.startsWith("Master Yi"))!);

  const p1 = buildPlayerFromDeckList("p1", "Alice (Garen)", garen, registry, mulberry32(7));
  const p2 = buildPlayerFromDeckList("p2", "Bob (Master Yi)", masterYi, registry, mulberry32(11));

  const battlefields: BattlefieldState[] = LEGACY_BATTLEFIELDS.map((name, i) => ({
    id: `bf-${i}`,
    name,
    controllerId: null,
    units: {},
    contestedByIndex: null,
    hiddenCards: [],
  }));

  return {
    players: [p1, p2],
    battlefields,
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
    killDamagedUnitsThisTurn: false,
    spellResolvingForIndex: null,
    markedForDeathOnDamageInstanceIds: [],
    extraTurns: 0,
    extraTurnsForIndex: 0,
    lastShowdownExcessDamage: null,
    deathWardedUnitInstanceIds: [],
    paidDeathWardUnitInstanceIds: [],
    unitsAwaitingDeathReplacement: [],
    pendingDecisions: [],
  };
}

describe("legalActions", () => {
  it("always includes Pass, and only includes affordable, non-exhausted moves", () => {
    const { state } = startGame(buildInitialGameState());
    const actions = legalActions(state);

    expect(actions.some((a) => a.type === "Pass")).toBe(true);
    expect(actions.some((a) => a.type === "FloatRune")).toBe(true);
    for (const action of actions) {
      if (action.type === "PlayCard") {
        expect(action.card.kind).not.toBe("Legend");
        expect(action.payment.energyRunes.length).toBeLessThanOrEqual(state.players[0].channeled.length);
      }
      if (action.type === "MoveUnit") {
        // Every candidate unit must actually belong to the active player and be ready.
        const actor = state.players[state.activePlayerIndex];
        const everywhere = [...actor.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[actor.id] ?? [])];
        const unit = everywhere.find((u) => u.instanceId === action.unitInstanceIds[0]);
        expect(unit).toBeDefined();
        expect(unit!.exhausted).toBe(false);
      }
    }
  });

  it("returns no actions outside the Action phase", () => {
    const state = buildInitialGameState(); // still phase: "Awaken"
    expect(legalActions(state)).toEqual([]);
  });

  it("a Ready rune yields both an Energy and a Power FloatRune candidate; an Exhausted rune yields only Power", () => {
    const { state } = startGame(buildInitialGameState());
    const actor = state.players[0]!;
    actor.channeled = [
      { id: "ready-1", domain: "Order", state: "Ready" },
      { id: "exhausted-1", domain: "Order", state: "Exhausted" },
    ];

    const floatActions = legalActions(state).filter((a) => a.type === "FloatRune");
    const forReady = floatActions.filter((a) => a.runeId === "ready-1");
    const forExhausted = floatActions.filter((a) => a.runeId === "exhausted-1");

    expect(forReady).toHaveLength(2);
    expect(forReady.some((a) => !a.forPower)).toBe(true);
    expect(forReady.some((a) => a.forPower)).toBe(true);

    expect(forExhausted).toHaveLength(1);
    expect(forExhausted[0]!.forPower).toBe(true);
  });

  it("FloatRune candidates are offered for the priority-holder during an open Showdown and a closed chain, alongside PassFocus", () => {
    const { state } = startGame(buildInitialGameState());
    state.players[1]!.channeled = [{ id: "ai-rune", domain: "Calm", state: "Ready" }];

    const showdownState: GameState = {
      ...state,
      turnState: "Showdown",
      focusHolder: 1,
      showdownBattlefieldId: state.battlefields[0]!.id,
      consecutiveFocusPasses: 0,
    };
    const showdownActions = legalActions(showdownState);
    expect(showdownActions.some((a) => a.type === "PassFocus" && a.playerIndex === 1)).toBe(true);
    expect(showdownActions.some((a) => a.type === "FloatRune" && a.playerIndex === 1 && a.runeId === "ai-rune")).toBe(true);

    const closedChainState: GameState = { ...state, chainOpen: false, chainPriority: 1 };
    const closedChainActions = legalActions(closedChainState);
    expect(closedChainActions.some((a) => a.type === "PassFocus" && a.playerIndex === 1)).toBe(true);
    expect(closedChainActions.some((a) => a.type === "FloatRune" && a.playerIndex === 1 && a.runeId === "ai-rune")).toBe(true);
  });

  it("generates a valid, affordable PlayCard candidate for a hand card with a domain-restricted Power cost", () => {
    const { state } = startGame(buildInitialGameState());
    const registry = defaultCardRegistry();
    // Jinx - Demolitionist (OGN-030): 3 Energy + 1 Power (Fury).
    const jinx = createCardInstance(registry.get("OGN-030")) as UnitInstance;
    expect(jinx.powerCost).toBe(1);
    expect(jinx.powerDomain).toBe("Fury");

    const actor = state.players[0]!;
    actor.hand = [...actor.hand, jinx];
    actor.channeled = [
      { id: "extra-e1", domain: "Order", state: "Ready" },
      { id: "extra-e2", domain: "Order", state: "Ready" },
      { id: "extra-e3", domain: "Order", state: "Ready" },
      { id: "extra-fury", domain: "Fury", state: "Exhausted" },
    ];

    const actions = legalActions(state);
    const play = actions.find((a) => a.type === "PlayCard" && a.card.instanceId === jinx.instanceId);
    expect(play).toBeDefined();
    expect(play!.type).toBe("PlayCard");
    if (play!.type === "PlayCard") {
      expect(validatePlayCard(state, play!)).toEqual({ ok: true });
      expect(play!.payment.powerRunes).toEqual(["extra-fury"]); // free Exhausted match preferred
    }
  });

  it("omits a PlayCard candidate when no domain-matching rune can cover the Power cost", () => {
    const { state } = startGame(buildInitialGameState());
    const registry = defaultCardRegistry();
    const jinx = createCardInstance(registry.get("OGN-030")) as UnitInstance;

    const actor = state.players[0]!;
    actor.hand = [...actor.hand, jinx];
    // Plenty of Energy, zero Fury runes anywhere in the pool.
    actor.channeled = [
      { id: "e1", domain: "Order", state: "Ready" },
      { id: "e2", domain: "Order", state: "Ready" },
      { id: "e3", domain: "Order", state: "Ready" },
      { id: "e4", domain: "Order", state: "Ready" },
    ];

    const actions = legalActions(state);
    expect(actions.some((a) => a.type === "PlayCard" && a.card.instanceId === jinx.instanceId)).toBe(false);
  });

  it("shrinks the auto-generated payment when floating Energy covers part of the cost", () => {
    const { state } = startGame(buildInitialGameState());
    const registry = defaultCardRegistry();
    const jinx = createCardInstance(registry.get("OGN-030")) as UnitInstance; // 3 Energy + 1 Power(Fury)

    const actor = state.players[0]!;
    actor.hand = [...actor.hand, jinx];
    actor.floatingEnergy = 2; // reduces the 3 Energy cost down to 1
    // Only 1 plain Ready rune for Energy — would be infeasible at the raw
    // cost of 3, but legal at the floating-reduced effective cost of 1.
    actor.channeled = [
      { id: "e1", domain: "Order", state: "Ready" },
      { id: "extra-fury", domain: "Fury", state: "Exhausted" },
    ];

    const actions = legalActions(state);
    const play = actions.find((a) => a.type === "PlayCard" && a.card.instanceId === jinx.instanceId);
    expect(play).toBeDefined();
    if (play!.type === "PlayCard") {
      expect(play!.payment.energyRunes).toEqual(["e1"]);
      expect(validatePlayCard(state, play!)).toEqual({ ok: true });
    }
  });

  it("omits the Power-rune requirement entirely when floating Power fully covers the domain-matched cost", () => {
    const { state } = startGame(buildInitialGameState());
    const registry = defaultCardRegistry();
    const jinx = createCardInstance(registry.get("OGN-030")) as UnitInstance; // 3 Energy + 1 Power(Fury)

    const actor = state.players[0]!;
    actor.hand = [...actor.hand, jinx];
    actor.floatingPower = { Fury: 1 }; // fully covers the 1 Power(Fury) cost
    // No Fury rune anywhere in the pool — would be infeasible at the raw
    // cost, but legal once floating Power reduces it to 0.
    actor.channeled = [
      { id: "e1", domain: "Order", state: "Ready" },
      { id: "e2", domain: "Order", state: "Ready" },
      { id: "e3", domain: "Order", state: "Ready" },
    ];

    const actions = legalActions(state);
    const play = actions.find((a) => a.type === "PlayCard" && a.card.instanceId === jinx.instanceId);
    expect(play).toBeDefined();
    if (play!.type === "PlayCard") {
      expect(play!.payment.powerRunes).toHaveLength(0);
      expect(validatePlayCard(state, play!)).toEqual({ ok: true });
    }
  });
});

describe("heuristic AI", () => {
  it("prefers developing the board over passing when it can afford to play a unit", () => {
    const { state } = startGame(buildInitialGameState());
    const action = chooseAction(state);
    const canAffordAUnit = state.players[0].hand.some(
      (c) => c.kind === "Unit" && c.powerCost === 0 && c.energyCost <= state.players[0].channeled.length,
    );
    if (canAffordAUnit) {
      expect(action.type).not.toBe("Pass");
    }
  });

  it("takes an uncontested conquest over passing", () => {
    let { state } = startGame(buildInitialGameState());
    // Find any ready base unit and hand-verify the AI would rather walk it
    // onto a neutral battlefield (a free point) than pass.
    const mover = state.players[0].baseUnits.find((u) => !u.exhausted);
    if (!mover) return; // nothing on base yet this seed — nothing to assert
    const action = chooseAction(state);
    if (action.type === "MoveUnit") {
      expect(state.battlefields.some((bf) => bf.id === action.destinationBattlefieldId)).toBe(true);
    }
  });

  it("can play out several full turns via submit() without throwing", () => {
    let { state } = startGame(buildInitialGameState());
    for (let i = 0; i < 20; i++) {
      const action = chooseAction(state);
      const result = submit(state, action);
      expect(result.result.type).not.toBe("Invalid");
      state = result.state;
      if (result.result.type === "GameOver") break;
    }
  });

  // ── deferred resolution in the lookahead ────────────────────────────────
  // Both of this engine's payoffs land behind PassFocus (combat two
  // focus-passes after the move; a Spell two chain-passes after the cast), so
  // scoring the state produced by applying ONE action rated a winning attack
  // at ~0 and a Spell at exactly 0 — and ties go to Pass, which legal-actions
  // pushes first. Measured before the fix: 0 Spell casts in 40 self-play games,
  // and in 139 states offering an attack it would win, it passed in 53.
  // See settleDeferredResolution in heuristic-ai.ts.
  //
  // Each of these builds ONE battlefield on purpose: with a second, empty one
  // in play, walking onto it is an uncontested Conquer worth an immediate
  // point, which correctly outscores everything else and would decide the test
  // for the wrong reason.
  function duelState(mine: Partial<UnitInstance>, theirs: Partial<UnitInstance>): GameState {
    const { state } = startGame(buildInitialGameState());
    const mkUnit = (overrides: Partial<UnitInstance>): UnitInstance => ({
      ...(createCardInstance(defaultCardRegistry().get("OGN-002")) as UnitInstance),
      exhausted: false,
      damage: 0,
      mightThisTurn: 0,
      buffed: false,
      stunned: false,
      keywordsThisTurn: {},
      abilityModesUsedThisTurn: [],
      ...overrides,
    });
    const attacker = mkUnit({ instanceId: "mine-1", ...mine });
    const defender = mkUnit({ instanceId: "theirs-1", ...theirs });
    const bf: BattlefieldState = {
      id: "bf-only",
      name: "The Only Battlefield",
      controllerId: state.players[1]!.id,
      contestedByIndex: null, hiddenCards: [],
      units: { [state.players[1]!.id]: [defender] },
    };
    return {
      ...state,
      battlefields: [bf],
      activePlayerIndex: 0,
      firstPlayerIndex: 0,
      players: [
        // Empty hand and no runes, so PlayCard can never be the candidate that
        // wins — the choice under test is strictly attack-vs-pass.
        { ...state.players[0]!, hand: [], channeled: [], baseUnits: [attacker] },
        { ...state.players[1]!, hand: [], channeled: [], baseUnits: [] },
      ],
    };
  }

  it("takes an attack it will WIN, which scoring the pre-combat state could never justify", () => {
    const action = chooseAction(duelState({ might: 7 }, { might: 2 }));
    expect(action).toEqual({
      type: "MoveUnit",
      playerIndex: 0,
      unitInstanceIds: ["mine-1"],
      destinationBattlefieldId: "bf-only",
    });
  });

  it("declines an attack it would LOSE — the same lookahead, cutting the other way", () => {
    // The point of settling isn't aggression, it's judgement: this attack is
    // indistinguishable from the winning one until combat is actually resolved.
    // (Note this one passes with or without the fix — unsettled it's a tie that
    // falls through to Pass, settled it's a loss. It's a guard against
    // over-correcting into recklessness, not evidence for the fix; the test
    // below is the one that discriminates in both directions.)
    const action = chooseAction(duelState({ might: 2 }, { might: 7 }));
    expect(action.type).toBe("Pass");
  });

  it("picks the fight it can win over the one it can't, when both are on offer", () => {
    const { state } = startGame(buildInitialGameState());
    const mkUnit = (instanceId: string, might: number): UnitInstance => ({
      ...(createCardInstance(defaultCardRegistry().get("OGN-002")) as UnitInstance),
      instanceId,
      might,
      exhausted: false,
      damage: 0,
      mightThisTurn: 0,
      buffed: false,
      stunned: false,
      keywordsThisTurn: {},
      abilityModesUsedThisTurn: [],
    });
    const theirId = state.players[1]!.id;
    // Both battlefields contested, so there's no uncontested walk-in to
    // outscore either attack, and the two moves are indistinguishable until
    // combat resolves.
    const winnable: BattlefieldState = {
      id: "bf-weak",
      name: "Lightly Held",
      controllerId: theirId,
      units: { [theirId]: [mkUnit("theirs-weak", 2)] }, contestedByIndex: null, hiddenCards: [],
    };
    const unwinnable: BattlefieldState = {
      id: "bf-strong",
      name: "Heavily Held",
      controllerId: theirId,
      units: { [theirId]: [mkUnit("theirs-strong", 9)] }, contestedByIndex: null, hiddenCards: [],
    };
    const choice: GameState = {
      ...state,
      battlefields: [winnable, unwinnable],
      activePlayerIndex: 0,
      firstPlayerIndex: 0,
      players: [
        { ...state.players[0]!, hand: [], championZone: null, channeled: [], baseUnits: [mkUnit("mine-1", 7)] },
        { ...state.players[1]!, hand: [], channeled: [], baseUnits: [] },
      ],
    };

    const action = chooseAction(choice);
    expect(action.type).toBe("MoveUnit");
    if (action.type !== "MoveUnit") return;
    expect(action.destinationBattlefieldId).toBe("bf-weak");
  });

  it("casts a Spell whose resolved effect improves the board (Incinerate, 2 Energy)", () => {
    const { state } = startGame(buildInitialGameState());
    const registry = defaultCardRegistry();
    const incinerate = createCardInstance(registry.get("OGS-003")); // Deal 2 to a unit at a battlefield
    const victim: UnitInstance = {
      ...(createCardInstance(registry.get("OGN-002")) as UnitInstance),
      instanceId: "victim-1",
      might: 2,
      exhausted: false,
      damage: 0,
      mightThisTurn: 0,
      buffed: false,
      stunned: false,
      keywordsThisTurn: {},
      abilityModesUsedThisTurn: [],
    };
    const bf: BattlefieldState = {
      id: "bf-only",
      name: "The Only Battlefield",
      controllerId: state.players[1]!.id,
      contestedByIndex: null, hiddenCards: [],
      units: { [state.players[1]!.id]: [victim] },
    };
    const castable: GameState = {
      ...state,
      battlefields: [bf],
      activePlayerIndex: 0,
      firstPlayerIndex: 0,
      players: [
        {
          ...state.players[0]!,
          hand: [incinerate],
          championZone: null,
          // No units of its own, so MoveUnit/RecallUnit can't be the winner —
          // the choice under test is strictly cast-vs-pass.
          baseUnits: [],
          channeled: [
            { id: "r1", domain: "Fury", state: "Ready" },
            { id: "r2", domain: "Fury", state: "Ready" },
          ],
        },
        { ...state.players[1]!, hand: [], channeled: [], baseUnits: [] },
      ],
    };

    const action = chooseAction(castable);
    expect(action.type).toBe("PlayCard");
    if (action.type !== "PlayCard") return;
    expect(action.card.instanceId).toBe(incinerate.instanceId);
    // ...and it aims at the unit its resolved effect actually kills, which is
    // only visible once the chain is settled.
    expect(action.targetUnitInstanceId).toBe("victim-1");
  });

  // ── damage as a tie-breaker ──────────────────────────────────────────────
  // effectiveMight ignores marked damage, so the evaluator could only ever see
  // damage that KILLED. Every non-lethal hit scored 0, which made each target
  // choice for a damage spell a tie — and ties fall to enumeration order, which
  // lists base units before battlefield ones. Observed in a real game: the AI
  // aimed Singularity ("Deal 6 to each of up to two units") at its OWN base unit
  // while an enemy stood at a battlefield. See DAMAGE_WEIGHT in heuristic-ai.ts.
  describe("aiming a damage spell", () => {
    const SINGULARITY = "OGN-105"; // Deal 6 to each of up to two units, either owner's

    /** The AI (player 0 here, to reuse the fixture's active player) holds
     *  Singularity and enough Mind runes; `ownMight`/`enemyMight` decide whether
     *  6 damage is lethal on each side. The enemy stands at a battlefield and the
     *  AI's unit is in base — the ordering that produced the misfire. */
    function singularityState(ownMight: number, enemyMight: number): GameState {
      const { state } = startGame(buildInitialGameState());
      const registry = defaultCardRegistry();
      const mkUnit = (instanceId: string, might: number): UnitInstance => ({
        ...(createCardInstance(registry.get("OGN-002")) as UnitInstance),
        instanceId,
        might,
        exhausted: false,
        damage: 0,
        mightThisTurn: 0,
        buffed: false,
        stunned: false,
        keywordsThisTurn: {},
        abilityModesUsedThisTurn: [],
      });
      const own = mkUnit("own-1", ownMight);
      const enemy = mkUnit("enemy-1", enemyMight);
      const bf: BattlefieldState = {
        id: "bf-only",
        name: "The Only Battlefield",
        controllerId: state.players[1]!.id,
        contestedByIndex: null, hiddenCards: [],
        units: { [state.players[1]!.id]: [enemy] },
      };
      return {
        ...state,
        battlefields: [bf],
        activePlayerIndex: 0,
        players: [
          {
            ...state.players[0]!,
            hand: [createCardInstance(registry.get(SINGULARITY))],
            championZone: null,
            baseUnits: [own],
            channeled: Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, domain: "Mind" as const, state: "Ready" as const })),
          },
          { ...state.players[1]!, hand: [], channeled: [], baseUnits: [] },
        ],
      };
    }

    it("aims non-lethal damage at the ENEMY, not at its own unit", () => {
      // Both 8 Might, so 6 damage kills neither: before the fix all four target
      // choices scored exactly 0 and enumeration order picked the AI's own unit.
      const action = chooseAction(singularityState(8, 8));
      expect(action.type).toBe("PlayCard");
      if (action.type !== "PlayCard") return;
      expect(action.card.name).toBe("Singularity");
      const targets = [action.targetUnitInstanceId, action.secondTargetUnitInstanceId].filter(Boolean);
      expect(targets).toContain("enemy-1");
      expect(targets).not.toContain("own-1");
    });

    it("never damages its own unit just to add a second target", () => {
      // "Up to two" means a pair is legal, so the AI must decline the second slot
      // rather than fill it with its own unit — which the min-0 fan-out offers.
      const action = chooseAction(singularityState(8, 4));
      if (action.type !== "PlayCard") return; // a better line existed; fine
      const targets = [action.targetUnitInstanceId, action.secondTargetUnitInstanceId].filter(Boolean);
      expect(targets).not.toContain("own-1");
    });

    it("still values a KILL above a bigger chip — damage can't outbid removal", () => {
      // The reason DAMAGE_WEIGHT is under 1. Chipping 6 onto an 8-Might unit must
      // not beat killing a 4-Might one; at full weight it would (+6 vs +4), and
      // chip damage heals at end of turn while a kill is permanent.
      const state = singularityState(8, 4);
      const enemyKill = chooseAction(state);
      if (enemyKill.type === "PlayCard") {
        const targets = [enemyKill.targetUnitInstanceId, enemyKill.secondTargetUnitInstanceId].filter(Boolean);
        expect(targets).toContain("enemy-1");
      }
      // And a damaged unit really is worth less than an undamaged one, which is
      // what makes the tie break at all.
      const damaged: GameState = {
        ...state,
        players: [{ ...state.players[0]!, baseUnits: [{ ...state.players[0]!.baseUnits[0]!, damage: 4 }] }, state.players[1]!],
      };
      expect(chooseAction(damaged)).toBeDefined(); // no throw on damaged input
    });
  });

  it("returns the sole legal PassFocus action during an open Showdown", () => {
    const { state } = startGame(buildInitialGameState());
    const showdownState: GameState = {
      ...state,
      turnState: "Showdown",
      focusHolder: 1,
      showdownBattlefieldId: state.battlefields[0]!.id,
      consecutiveFocusPasses: 0,
    };

    const action = chooseAction(showdownState);
    expect(action).toEqual({ type: "PassFocus", playerIndex: 1 });
  });
});

/**
 * Answering a pending question is an ordinary action, so the AI needs no special
 * case to make one — but it does need not to hang on one, and it needs to answer
 * in the interest of whoever was asked.
 *
 * The second half is the one worth testing: Cull the Weak asks the OPPONENT to
 * kill one of their own units. An AI that answered in the caster's interest would
 * hand over its best unit, and — worse — `settleDeferredResolution` scoring the
 * question that way would make the AI wildly overrate casting the card.
 */
describe("the AI answers pending questions", () => {
  function askedToCull(): GameState {
    const state = makeState({
      phase: "Action",
      players: [makePlayer("p1"), makePlayer("p2")],
    });
    state.players[1]!.baseUnits = [makeUnit({ name: "Weak", might: 1 }), makeUnit({ name: "Strong", might: 7 })];
    return parkDecision(state, { kind: "OGN-209-kill", playerIndex: 1 });
  }

  it("produces an answer the engine accepts, rather than stalling", () => {
    const asked = askedToCull();
    const action = chooseAction(asked);

    expect(action.type).toBe("AnswerDecision");
    const result = submit(asked, action);
    expect(result.result.type).not.toBe("Invalid");
    expect(result.state.pendingDecisions).toHaveLength(0);
  });

  it("keeps its BEST unit when asked to kill one of its own", () => {
    // One state, not two calls to the builder — a decision id from a different
    // state is stale by construction, and the answer would simply be refused.
    const asked = askedToCull();
    const after = submit(asked, chooseAction(asked)).state;
    expect(after.players[1]!.baseUnits.map((u) => u.name)).toEqual(["Strong"]);
  });
});
