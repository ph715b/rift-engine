import {
  buildPlayerFromDeckList,
  defaultCardRegistry,
  LEGACY_BATTLEFIELDS,
  mulberry32,
  type BattlefieldState,
  type DeckList,
  type GameState,
} from "@rift-engine/engine";

export interface MatchConfig {
  humanDeck: DeckList;
  aiDeck: DeckList;
}

/** Builds a fresh GameState for any pair of decks (presets, imported real
 *  .deck files, or user-built decks — buildPlayerFromDeckList doesn't care
 *  which). `seed` drives both players' shuffles deterministically, so the
 *  same seed always replays identically (NFR: replayable seeded shuffles). */
export function createNewGame(config: MatchConfig, seed: number): GameState {
  const registry = defaultCardRegistry();

  const human = buildPlayerFromDeckList("p1", "You", config.humanDeck, registry, mulberry32(seed));
  const ai = buildPlayerFromDeckList("p2", "AI Opponent", config.aiDeck, registry, mulberry32(seed + 1));

  const battlefields: BattlefieldState[] = LEGACY_BATTLEFIELDS.map((name, i) => ({
    id: `bf-${i}`,
    name,
    controllerId: null,
    units: {},
  }));

  return {
    players: [human, ai],
    battlefields,
    activePlayerIndex: 0,
    turnNumber: 1,
    phase: "Awaken",
    turnState: "Neutral",
    focusHolder: 0,
  };
}
