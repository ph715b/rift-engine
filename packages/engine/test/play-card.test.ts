import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type LegendInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState, PlayerState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import type { PlayCardAction } from "../src/actions/player-action.js";

function readyRune(id: string, domain: RuneCard["domain"] = "Order"): RuneCard {
  return { id, domain, state: "Ready" };
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
    conqueredBattlefieldsThisTurn: [],
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
    showdownBattlefieldId: null,
    consecutiveFocusPasses: 0,
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

describe("PlayCard: from the Champion Zone (not just hand)", () => {
  it("can be played straight from championZone, clearing it and leaving hand untouched", () => {
    const { state } = buildFixture();
    const registry = defaultCardRegistry();
    // Master Yi's champion (OGS-004) — a real champion sitting in reserve,
    // per Player.java: "the champion starts face-up in the base zone" (its
    // own dedicated zone, not hand). Before this fix, PlayCard only ever
    // checked hand membership, so a deck's own champion could never enter
    // play at all (ActionValidator.java:1126-1138 confirms hand-OR-Champion-
    // Zone is the real origin check).
    const championDef = registry.get("OGS-004");
    const champion = createCardInstance(championDef) as UnitInstance;
    expect(champion.energyCost).toBe(5);
    expect(champion.powerCost).toBe(1);
    state.players[0]!.championZone = champion;
    // Enough runes to cover the champion's real 5-energy + 1-power cost.
    // The Power rune must match the champion's printed powerDomain — Energy
    // runes are domain-agnostic, so only the last (Power) rune needs it.
    state.players[0]!.channeled = [
      ...Array.from({ length: 5 }, (_, i) => readyRune(`champ-rune-${i}`)),
      readyRune("champ-rune-5", champion.powerDomain ?? "Order"),
    ];

    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: champion,
      payment: {
        energyRunes: state.players[0]!.channeled.slice(0, 5).map((r) => r.id),
        powerRunes: state.players[0]!.channeled.slice(5, 6).map((r) => r.id),
      },
    };

    expect(validatePlayCard(state, action)).toEqual({ ok: true });

    const next = executePlayCard(state, action);
    const actor = next.players[0]!;
    expect(actor.championZone).toBeNull();
    expect(actor.baseUnits.some((u) => u.instanceId === champion.instanceId)).toBe(true);
    expect(actor.hand).toHaveLength(1); // the original hand card (Daring Poro) is untouched
  });

  it("rejects a card that's in neither hand nor the Champion Zone", () => {
    const { state } = buildFixture();
    const registry = defaultCardRegistry();
    const championDef = registry.get("OGS-004");
    const champion = createCardInstance(championDef) as UnitInstance;
    // Not assigned to championZone or hand — a stray instance.

    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: champion,
      payment: { energyRunes: [], powerRunes: [] },
    };

    expect(validatePlayCard(state, action).ok).toBe(false);
  });
});

describe("PlayCard: Power-cost rune recycling", () => {
  it("recycles a rune paid for Power (removed from channeled, reset Ready, sent to the bottom of the rune deck) distinct from Energy exhaustion", () => {
    const { state } = buildFixture();
    const registry = defaultCardRegistry();
    // Jinx - Demolitionist (OGN-030): 3 Energy + 1 Power (Fury).
    const jinxDef = registry.get("OGN-030");
    const jinx = createCardInstance(jinxDef) as UnitInstance;
    expect(jinx.energyCost).toBe(3);
    expect(jinx.powerCost).toBe(1);
    expect(jinx.powerDomain).toBe("Fury");

    state.players[0]!.hand = [jinx];
    // 3 plain Ready runes for Energy, plus 1 Exhausted Fury rune to freely cover Power.
    state.players[0]!.channeled = [
      readyRune("e1"),
      readyRune("e2"),
      readyRune("e3"),
      { id: "fury-exhausted", domain: "Fury", state: "Exhausted" },
    ];
    state.players[0]!.runeDeck = [];

    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: jinx,
      payment: { energyRunes: ["e1", "e2", "e3"], powerRunes: ["fury-exhausted"] },
    };

    expect(validatePlayCard(state, action)).toEqual({ ok: true });

    const next = executePlayCard(state, action);
    const actor = next.players[0]!;

    // The Power rune is fully recycled out of the pool, reset to Ready, and
    // sent to the bottom of the rune deck (ActionExecutor.java:1907-1911) —
    // NOT left in `channeled` as merely Exhausted, unlike Energy runes.
    expect(actor.channeled.find((r) => r.id === "fury-exhausted")).toBeUndefined();
    expect(actor.channeled).toHaveLength(3);
    expect(actor.runeDeck).toHaveLength(1);
    expect(actor.runeDeck[0]).toEqual({ id: "fury-exhausted", domain: "Fury", state: "Ready" });

    // Energy runes stay in the pool, now Exhausted.
    expect(actor.channeled.every((r) => r.state === "Exhausted")).toBe(true);

    // No double-duty rune was used here, so no floating Energy credit.
    expect(actor.floatingEnergy).toBe(0);
  });

  it("credits +1 floating Energy when a single Ready rune pays both Energy and Power (double duty)", () => {
    const { state } = buildFixture();
    const registry = defaultCardRegistry();
    const jinxDef = registry.get("OGN-030");
    const jinx = createCardInstance(jinxDef) as UnitInstance;

    state.players[0]!.hand = [jinx];
    // Only 3 Ready runes total, one of which is Fury and must double up on both
    // its own Energy slot and the Power cost (no Exhausted Fury rune available).
    state.players[0]!.channeled = [
      { id: "fury-ready", domain: "Fury", state: "Ready" },
      readyRune("e1"),
      readyRune("e2"),
    ];
    state.players[0]!.runeDeck = [];

    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: jinx,
      payment: { energyRunes: ["fury-ready", "e1", "e2"], powerRunes: ["fury-ready"] },
    };

    expect(validatePlayCard(state, action)).toEqual({ ok: true });

    const next = executePlayCard(state, action);
    const actor = next.players[0]!;

    // The double-duty rune is recycled (Power wins), the other two are Exhausted.
    expect(actor.channeled).toHaveLength(2);
    expect(actor.channeled.every((r) => r.state === "Exhausted")).toBe(true);
    expect(actor.runeDeck).toHaveLength(1);
    expect(actor.runeDeck[0]!.id).toBe("fury-ready");
    expect(actor.runeDeck[0]!.state).toBe("Ready");

    // Its Energy-paying potential would otherwise be wasted, so the player is
    // credited 1 floating Energy instead (ActionExecutor.java:1876-1886).
    expect(actor.floatingEnergy).toBe(1);
  });
});
