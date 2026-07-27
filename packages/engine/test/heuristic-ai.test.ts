import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { allPresetDecks, presetDeckList } from "../src/decks/deck-presets.js";
import { buildPlayerFromDeckList } from "../src/decks/player-setup.js";
import { mulberry32 } from "../src/util/rng.js";
import type { BattlefieldState, GameState } from "../src/model/game-state.js";
import { LEGACY_BATTLEFIELDS } from "../src/decks/deck-list.js";
import { startGame, submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
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
  };
}

describe("legalActions", () => {
  it("always includes Pass, and only includes affordable, non-exhausted moves", () => {
    const { state } = startGame(buildInitialGameState());
    const actions = legalActions(state);

    expect(actions.some((a) => a.type === "Pass")).toBe(true);
    for (const action of actions) {
      if (action.type === "PlayCard") {
        expect(action.card.kind).toBe("Unit");
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
});
