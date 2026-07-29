import {
  buildPlayerFromDeckList,
  chooseMatchBattlefields,
  defaultCardRegistry,
  mulberry32,
  type DeckList,
  type GameState,
} from "@rift-engine/engine";

export interface MatchConfig {
  humanDeck: DeckList;
  aiDeck: DeckList;
}

/** Builds a fresh GameState for any pair of decks (presets, imported real
 *  .deck files, or user-built decks — buildPlayerFromDeckList doesn't care
 *  which). `seed` drives both players' shuffles and the battlefield choice
 *  deterministically, so the same seed always replays identically (NFR:
 *  replayable seeded shuffles). */
export function createNewGame(config: MatchConfig, seed: number): GameState {
  const registry = defaultCardRegistry();

  const human = buildPlayerFromDeckList("p1", "You", config.humanDeck, registry, mulberry32(seed));
  const ai = buildPlayerFromDeckList("p2", "AI Opponent", config.aiDeck, registry, mulberry32(seed + 1));

  // 1v1 has exactly 2 battlefields in play, one from each player's own
  // deck's 3-battlefield pool — not a shared trio (confirmed against the
  // Java oracle's real game-construction path, RiftboundApp.java:112-125).
  const battlefields = chooseMatchBattlefields(config.humanDeck, config.aiDeck, mulberry32(seed + 2));

  return {
    players: [human, ai],
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
    deathWardedUnitInstanceIds: [],
  };
}
