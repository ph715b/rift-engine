import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { allPresetDecks, presetDeckList } from "../src/decks/deck-presets.js";
import { buildPlayerFromDeckList } from "../src/decks/player-setup.js";
import { mulberry32 } from "../src/util/rng.js";
import type { GameState, PlayerState } from "../src/model/game-state.js";
import type { BattlefieldState } from "../src/model/game-state.js";
import { startGame, submit } from "../src/engine/game-engine.js";
import type { UnitInstance } from "../src/model/card.js";

function buildInitialGameState(): GameState {
  const registry = defaultCardRegistry();
  const garen = presetDeckList(allPresetDecks().find((d) => d.name.startsWith("Garen"))!);
  const masterYi = presetDeckList(allPresetDecks().find((d) => d.name.startsWith("Master Yi"))!);

  const p1 = buildPlayerFromDeckList("p1", "Alice (Garen)", garen, registry, mulberry32(1));
  const p2 = buildPlayerFromDeckList("p2", "Bob (Master Yi)", masterYi, registry, mulberry32(2));

  const battlefields: BattlefieldState[] = garen.battlefieldNames.map((name, i) => ({
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
    spellChain: [],
    deathWardedUnitInstanceIds: [],
  };
}

/** Finds a playable Unit in hand: no Power cost (not modeled in PlayCard yet)
 *  and affordable with however many runes are currently channeled. */
function findPlayableUnit(player: PlayerState): UnitInstance | undefined {
  return player.hand.find(
    (c): c is UnitInstance => c.kind === "Unit" && c.powerCost === 0 && c.energyCost <= player.channeled.length,
  );
}

describe("a full turn cycle with two real Proving Grounds decks (M1 vertical slice)", () => {
  it("deals opening hands and runs the first Start-of-Turn sequence", () => {
    const { state, result } = startGame(buildInitialGameState());

    expect(result).toEqual({ type: "Ok" });
    expect(state.phase).toBe("Action");
    expect(state.turnNumber).toBe(1);
    expect(state.activePlayerIndex).toBe(0);

    // Opening hand (4) + first Draw phase (1) = 5.
    expect(state.players[0].hand).toHaveLength(5);
    // Player 2 hasn't had a turn yet — opening hand only.
    expect(state.players[1].hand).toHaveLength(4);
    // Player 1 (going first) channels 2 runes on turn 1, no going-second bonus.
    expect(state.players[0].channeled).toHaveLength(2);
  });

  it("plays a card, passes, and hands priority + the going-second rune bonus to player 2", () => {
    let { state } = startGame(buildInitialGameState());

    const playable = findPlayableUnit(state.players[0]);
    if (playable) {
      const energyRunes = state.players[0].channeled.slice(0, playable.energyCost).map((r) => r.id);
      const result = submit(state, {
        type: "PlayCard",
        playerIndex: 0,
        card: playable,
        payment: { energyRunes, powerRunes: [] },
      });
      expect(result.result).toEqual({ type: "Ok" });
      state = result.state;
      expect(state.players[0].baseUnits).toHaveLength(1);
    }

    const passResult = submit(state, { type: "Pass", playerIndex: 0 });
    expect(passResult.result).toEqual({ type: "Ok" });
    state = passResult.state;

    // Turn passed to player 2; still turn "1" (turnNumber only advances on wrap to player 0).
    expect(state.activePlayerIndex).toBe(1);
    expect(state.turnNumber).toBe(1);
    expect(state.phase).toBe("Action");

    // Player 2 (going second) channeled 2 (opening) + their own Channel step: since it's
    // their first turn, they get the 3-rune going-second bonus instead of the usual 2.
    expect(state.players[1].channeled).toHaveLength(3);
    // Opening hand (4) + their own Draw phase (1) = 5.
    expect(state.players[1].hand).toHaveLength(5);

    // A card played last turn should still be exhausted — Awaken only readies
    // its OWNER's cards, and it isn't player 1's turn yet.
    if (state.players[0].baseUnits.length > 0) {
      expect(state.players[0].baseUnits[0]!.exhausted).toBe(true);
    }
  });

  it("readies an exhausted unit on its controller's next Awaken", () => {
    let { state } = startGame(buildInitialGameState());

    const playable = findPlayableUnit(state.players[0]);
    expect(playable, "expected at least one affordable Unit in player 1's opening hand for this seed").toBeDefined();

    const energyRunes = state.players[0].channeled.slice(0, playable!.energyCost).map((r) => r.id);
    ({ state } = submit(state, {
      type: "PlayCard",
      playerIndex: 0,
      card: playable!,
      payment: { energyRunes, powerRunes: [] },
    }));
    expect(state.players[0].baseUnits[0]!.exhausted).toBe(true);

    ({ state } = submit(state, { type: "Pass", playerIndex: 0 })); // -> player 2's turn
    ({ state } = submit(state, { type: "Pass", playerIndex: 1 })); // -> back to player 1, turn 2

    expect(state.activePlayerIndex).toBe(0);
    expect(state.turnNumber).toBe(2);
    expect(state.players[0].baseUnits[0]!.exhausted).toBe(false);
    // The rune spent last turn is Ready again too.
    expect(state.players[0].channeled.every((r) => r.state === "Ready")).toBe(true);
    // cardsPlayedThisTurn reset for the new turn.
    expect(state.players[0].cardsPlayedThisTurn).toBe(0);
  });

  it("rejects an out-of-turn action", () => {
    const { state } = startGame(buildInitialGameState());
    const result = submit(state, { type: "Pass", playerIndex: 1 });
    expect(result.result.type).toBe("Invalid");
  });
});
