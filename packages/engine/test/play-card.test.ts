import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type LegendInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState, PlayerState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import type { PlayCardAction } from "../src/actions/player-action.js";

function readyRune(id: string): RuneCard {
  return { id, domain: "Order", state: "Ready" };
}

function emptyPlayer(id: string, name: string, legend: LegendInstance): PlayerState {
  return {
    id,
    name,
    legend,
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
  };
}

/**
 * A vertical-slice fixture: one real card (Daring Poro, OGN-210) in hand,
 * enough ready runes channeled to pay its printed cost, nothing else set up
 * (no full turn/phase engine yet — that's M1). Good enough to exercise
 * PlayCard end-to-end per M0's goal.
 */
function buildFixture() {
  const registry = defaultCardRegistry();
  const garenLegendDef = registry.get("OGS-023");
  const legend = createCardInstance(garenLegendDef) as LegendInstance;

  const daringPoroDef = registry.get("OGN-210");
  const poro = createCardInstance(daringPoroDef) as UnitInstance;
  expect(poro.energyCost).toBe(2);
  expect(poro.powerCost).toBe(0);

  const player: PlayerState = emptyPlayer("p1", "Alice", legend);
  player.hand = [poro];
  player.channeled = [readyRune("rune-1"), readyRune("rune-2"), readyRune("rune-3")];

  const opponentLegendDef = registry.get("OGS-021");
  const opponent: PlayerState = emptyPlayer("p2", "Bob", createCardInstance(opponentLegendDef) as LegendInstance);

  const state: GameState = {
    players: [player, opponent],
    battlefields: [],
    activePlayerIndex: 0,
    turnNumber: 1,
    phase: "Action",
    turnState: "Neutral",
    focusHolder: 0,
  };

  return { state, poro };
}

describe("PlayCard: Unit to base (M0 vertical slice)", () => {
  it("validates a legal payment", () => {
    const { state, poro } = buildFixture();
    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: poro,
      payment: { energyRunes: ["rune-1", "rune-2"], powerRunes: [] },
    };

    expect(validatePlayCard(state, action)).toEqual({ ok: true });
  });

  it("rejects a payment that doesn't match the printed energy cost", () => {
    const { state, poro } = buildFixture();
    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: poro,
      payment: { energyRunes: ["rune-1"], powerRunes: [] }, // Daring Poro costs 2 energy
    };

    const result = validatePlayCard(state, action);
    expect(result.ok).toBe(false);
  });

  it("moves the card from hand to base and exhausts exactly the paid runes", () => {
    const { state, poro } = buildFixture();
    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: poro,
      payment: { energyRunes: ["rune-1", "rune-2"], powerRunes: [] },
    };

    const next = executePlayCard(state, action);
    const actor = next.players[0];

    // Card left the hand and entered base (no destination battlefield supplied).
    expect(actor.hand).toHaveLength(0);
    expect(actor.baseUnits).toHaveLength(1);
    expect(actor.baseUnits[0]!.instanceId).toBe(poro.instanceId);
    // Daring Poro has no [Quick] — real core rule: units enter play exhausted
    // by default (ActionExecutor.java:376-384).
    expect(actor.baseUnits[0]!.exhausted).toBe(true);

    // Exactly the 2 runes spent on Energy are now Exhausted; the 3rd (unpaid) stays Ready.
    // Mirrors ActionExecutor.applyPayment (engine/ActionExecutor.java:1889-1891): a rune
    // paid for Energy is exhausted but stays in the pool, returning to Ready at next Awaken.
    expect(actor.channeled.find((r) => r.id === "rune-1")!.state).toBe("Exhausted");
    expect(actor.channeled.find((r) => r.id === "rune-2")!.state).toBe("Exhausted");
    expect(actor.channeled.find((r) => r.id === "rune-3")!.state).toBe("Ready");
    expect(actor.channeled).toHaveLength(3); // Energy payment never removes runes from the pool

    expect(actor.cardsPlayedThisTurn).toBe(1);

    // Input state is untouched — the engine stays (state, action) -> nextState (PRD Goal 4).
    expect(state.players[0]!.hand).toHaveLength(1);
    expect(state.players[0]!.baseUnits).toHaveLength(0);
    expect(state.players[0]!.channeled.every((r) => r.state === "Ready")).toBe(true);
  });

  it("rejects playing a card that isn't in the acting player's hand", () => {
    const { state } = buildFixture();
    const someOtherCard = createCardInstance(defaultCardRegistry().get("OGN-013")) as UnitInstance;
    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: someOtherCard,
      payment: { energyRunes: [], powerRunes: [] },
    };

    const result = validatePlayCard(state, action);
    expect(result.ok).toBe(false);
  });
});
