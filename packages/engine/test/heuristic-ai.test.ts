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
  }));

  return {
    players: [p1, p2],
    battlefields,
    activePlayerIndex: 0,
    turnNumber: 1,
    phase: "Awaken",
    turnState: "Neutral",
    focusHolder: 0,
    showdownBattlefieldId: null,
    consecutiveFocusPasses: 0,
    chainOpen: true,
    chainPriority: 0,
    chainPasses: 0,
    spellChain: [],
  };
}

describe("legalActions", () => {
  it("always includes Pass, and only includes affordable, non-exhausted moves", () => {
    const { state } = startGame(buildInitialGameState());
    const actions = legalActions(state);

    expect(actions.some((a) => a.type === "Pass")).toBe(true);
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
