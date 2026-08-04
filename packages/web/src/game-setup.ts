import {
  battlefieldPair,
  buildPlayerFromDeckList,
  chooseMatchBattlefields,
  defaultCardRegistry,
  mulberry32,
  pickBattlefield,
  type BattlefieldState,
  type DeckList,
  type GameState,
} from "@rift-engine/engine";

/**
 * Which of the two sanctioned 1v1 modes this match is played under. They differ
 * in more than game count:
 *   - `bo1` — 1v1 (Duel), rules 485.3-486.1. One game decides the match, and
 *     each player's battlefield is picked at RANDOM from their three (485.5).
 *   - `bo3` — 1v1 (Match), rules 486.3-487.4. First to two game wins; each
 *     player SELECTS their battlefield (487.2), and the ones used in a decided
 *     game are removed for the rest of the match (487.3).
 * Both share the same First Turn Process (the player going second channels an
 * extra rune — 486.1 / 487.4), which lives in the engine's runChannel.
 */
export type MatchFormat = "bo1" | "bo3";

export interface MatchConfig {
  humanDeck: DeckList;
  aiDeck: DeckList;
  format: MatchFormat;
  /**
   * SPECTATE — both seats are driven by the AI and the board is watched rather
   * than played.
   *
   * A dev/observability mode, not a game mode, and deliberately a flag on the
   * existing config rather than a third seat model: seat 0 stays "you" for every
   * purpose the board has (its hand is the one rendered face-up, its questions
   * are the ones that raise a prompt), and only WHO CHOOSES its actions changes.
   * That is what keeps `GameBoard`'s twenty-odd `HUMAN_INDEX` sites correct
   * unchanged, and it is why this is a flag rather than a refactor.
   *
   * `chooseAction` derives the seat it is choosing for and masks that seat's
   * hidden information itself, so driving seat 0 with it is information-safe by
   * construction rather than by care.
   */
  spectate?: boolean;
}

/** How many game wins take the match. */
export function winsNeeded(format: MatchFormat): number {
  return format === "bo3" ? 2 : 1;
}

/** Human-facing name for the mode, so the UI can stay traceable to the rules. */
export function formatLabel(format: MatchFormat): string {
  return format === "bo3" ? "Best of 3 · 1v1 Match" : "Best of 1 · 1v1 Duel";
}

/** Explicitly-chosen battlefield names for a game, when the mode has the
 *  players select rather than roll (1v1 Match). Absent means "roll for both",
 *  which is 1v1 Duel's own setup rule. */
export interface BattlefieldChoice {
  humanName: string;
  aiName: string;
}

/**
 * Builds a fresh GameState for any pair of decks (presets, imported real
 * .deck files, or user-built decks — buildPlayerFromDeckList doesn't care
 * which). `seed` drives both players' shuffles, the battlefield roll and the
 * turn-order roll deterministically, so the same seed always replays
 * identically (NFR: replayable seeded shuffles).
 *
 * `battlefields` overrides the random roll with an already-made choice — the
 * 1v1 Match path, where the human picks on the BattlefieldSelect screen and the
 * AI's side is rolled from its own remaining pool.
 */
export function createNewGame(config: MatchConfig, seed: number, battlefields?: BattlefieldChoice): GameState {
  const registry = defaultCardRegistry();

  const human = buildPlayerFromDeckList("p1", "You", config.humanDeck, registry, mulberry32(seed));
  const ai = buildPlayerFromDeckList("p2", "AI Opponent", config.aiDeck, registry, mulberry32(seed + 1));

  // 1v1 has exactly 2 battlefields in play, one from each player's own
  // deck's 3-battlefield pool — not a shared trio (confirmed against the
  // Java oracle's real game-construction path, RiftboundApp.java:112-125).
  const chosenBattlefields: [BattlefieldState, BattlefieldState] = battlefields
    ? battlefieldPair(battlefields.humanName, battlefields.aiName)
    : chooseMatchBattlefields(config.humanDeck, config.aiDeck, mulberry32(seed + 2));

  // Rule 117.x: "Determine Turn Order using any fair random method agreed on by
  // all players." This used to be hardcoded to 0, so the human always went
  // first and always ate the going-first disadvantage — see the engine's
  // firstPlayerIndex for the two turn steps that depend on this being real.
  //
  // Its own rng stream (seed + 3) rather than reusing one of the three above:
  // those are already consumed by the two shuffles and the battlefield roll, so
  // drawing from them would shift every existing seed's shuffle and break
  // replayability for no reason.
  const firstPlayerIndex: 0 | 1 = mulberry32(seed + 3)() < 0.5 ? 0 : 1;

  return {
    players: [human, ai],
    battlefields: chosenBattlefields,
    // Turn order is decided once, at setup, and both of these start equal —
    // activePlayerIndex then rotates every turn while firstPlayerIndex doesn't.
    activePlayerIndex: firstPlayerIndex,
    firstPlayerIndex,
    turnNumber: 1,
    phase: "Awaken",
    turnState: "Neutral",
    focusHolder: firstPlayerIndex,
    showdownBattlefieldId: null,
    showdownKind: null,
    consecutiveFocusPasses: 0,
    chainOpen: true,
    chainPriority: firstPlayerIndex,
    chainPasses: 0,
    chainOpenedByTrigger: false,
    spellChain: [],
    pendingTriggers: [],
    declaredWinnerIndex: null,
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
  };
}

/** The AI's battlefield for a Match-mode game: rolled from whatever it hasn't
 *  presented yet (rule 487.3). Only the human gets a chooser — the AI has no
 *  basis on which to prefer one of its own battlefields, the same reasoning that
 *  keeps it from mulliganing. */
export function rollAiBattlefield(config: MatchConfig, seed: number, used: string[]): string {
  return pickBattlefield(config.aiDeck.battlefieldNames, used, mulberry32(seed + 4));
}
