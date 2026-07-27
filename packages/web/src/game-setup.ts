import {
  allPresetDecks,
  buildPlayerFromDeckList,
  defaultCardRegistry,
  LEGACY_BATTLEFIELDS,
  mulberry32,
  presetDeckList,
  type BattlefieldState,
  type GameState,
} from "@rift-engine/engine";

/**
 * Hardcodes "you vs. the AI, two specific Proving Grounds presets" for this
 * first playable board — deck selection (any preset, a real .deck file, or
 * a user-built deck; FR2) is a UI feature to add on top of this, not
 * something the engine itself needs more work for (buildPlayerFromDeckList
 * already accepts any DeckList).
 */
export function createNewGame(seed: number): GameState {
  const registry = defaultCardRegistry();
  const presets = allPresetDecks();
  const humanPreset = presetDeckList(presets.find((d) => d.name.startsWith("Garen"))!);
  const aiPreset = presetDeckList(presets.find((d) => d.name.startsWith("Master Yi"))!);

  const human = buildPlayerFromDeckList("p1", "You", humanPreset, registry, mulberry32(seed));
  const ai = buildPlayerFromDeckList("p2", "AI Opponent", aiPreset, registry, mulberry32(seed + 1));

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
