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
 *   - `bo1` — 1v1 (Duel), rule 485. One game decides the match, and
 *     each player's battlefield is picked at RANDOM from their three (485.5).
 *   - `bo3` — 1v1 (Match), rule 486. First to two game wins; each
 *     player SELECTS their battlefield (486.5), and the ones used in a decided
 *     game are removed for the rest of the match (486.5).
 * Both share the same First Turn Process (the player going second channels an
 * extra rune — 485.7 / 486.7), which lives in the engine's runChannel.
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
 * **Tournament rule 407, the "Play First Rule".** Who decides the turn order for
 * the game about to start, and what they should decide.
 *
 * The Tournament Rules are a SECOND source and they win where they differ:
 * **104.1** — "In some cases, information in this document may contradict, or
 * provide information not contained in, the Riftbound Core Rules. In all such
 * cases, this document takes precedence." Core Rules 115 says only "determine
 * Turn Order using any fair random method", which is what this app did for every
 * game of a match.
 *
 * - **407.1/407.2** — game 1: a random method picks a *designated player*, and
 *   that player chooses to play first or last.
 * - **407.4** — later games: "**the loser of the previous game gets to choose if
 *   they play first or last. If the previous game was a draw, the starting play
 *   from the previous game is maintained.**"
 *
 * # Game 1 stays a coin flip, and that is faithful rather than lazy
 *
 * Rolling `firstPlayerIndex` directly is not literally 407.1 — the roll should
 * pick who DECIDES, and that player then chooses. But the two are the same
 * distribution: whoever is designated takes the better seat, so the other player
 * gets the worse one, and a fair roll over "who is designated" is a fair roll
 * over "who plays first". Worth stating because it stops being true the moment
 * the two seats are not strictly opposed, and because 407.4 is the case where
 * the difference is real and is implemented properly below.
 *
 * # Which seat a chooser should want is MEASURED, not inferred
 *
 * `probes/first-player.ts` exists for this. See `PREFERS_TO_PLAY_FIRST`.
 */
export interface PlayFirstDecision {
  /** Who chooses, or `null` when nobody does and the order is rolled (game 1) or
   *  carried (a draw). */
  chooser: 0 | 1 | null;
  /** The turn order to use when `chooser` is null. Absent means "roll it". */
  carriedFirstPlayerIndex?: 0 | 1;
}

/** What the previous game of a match did, as 407.4 needs to read it. */
export interface PreviousGame {
  /** The seat that LOST. `null` for a draw — 407.4's "starting play from the
   *  previous game is maintained" branch. */
  loserIndex: 0 | 1 | null;
  /** Who played first in it, so a draw can carry the order forward. */
  firstPlayerIndex: 0 | 1;
}

/**
 * **407.4.** Given what the previous game did, who chooses the turn order now.
 *
 * `previous` absent is game 1 — 407.1's designated player, which this app rolls
 * (see the note above).
 */
export function playFirstDecision(previous?: PreviousGame): PlayFirstDecision {
  if (!previous) return { chooser: null };
  // **A draw maintains the previous game's starting play — nobody chooses.**
  //
  // **UNREACHABLE through this app today, and kept deliberately.** A draw is not
  // representable: `SubmitResult.GameOver` carries a required `winnerId`, and
  // `winner()` returns null for a tie at or above the Victory Score — which
  // `game-engine.submit` turns into an ordinary `Ok`, so the game simply
  // continues until someone breaks the tie. The tournament rules only produce a
  // draw off the round clock (408.2.b, "if no player has a point lead of two or
  // more, the game is a draw") and this app has no clock.
  //
  // Written anyway because it is one line, because the rule says it, and because
  // the alternative — falling through to "the loser chooses" with no loser — is
  // the silent wrong answer the day a clock or a concession is added. Pinned by
  // calling this function directly in `play-first-rule.test.ts`, which is the
  // only way to pin a branch the board cannot reach.
  if (previous.loserIndex === null) {
    return { chooser: null, carriedFirstPlayerIndex: previous.firstPlayerIndex };
  }
  return { chooser: previous.loserIndex };
}

/**
 * Which seat a 407.4 chooser takes. `true` = they choose to play FIRST.
 *
 * # The measurement, stated honestly
 *
 * `probes/first-player.ts` was written for this — see its header for why
 * `ai-ab.ts` could not answer it (that harness pins `firstPlayerIndex` to 0 in
 * both halves of every mirrored pair, deliberately cancelling the seat).
 *
 * Basis: **Annie: Fury + Chaos mirrored across both seats, battlefields pinned.**
 * Mirror DECKS rather than mirror games, so turn order is the only asymmetry
 * left; `firstPlayerIndex` alternates across seeds so a seat bug would show as a
 * split between the halves rather than being absorbed.
 *
 * **Going first wins 53.1% of 1600 decided games** (95% CI ≈ 50.7–55.6%,
 * p ≈ 0.013), with the two halves at 52.4% and 53.9% — a 1.5pp spread. Small,
 * and real.
 *
 * **It needed the depth, and the shallow runs would have been quoted wrongly in
 * both directions.** 60 games said 58.3% — an overstatement. 400 said 53.0%,
 * which is the right point estimate but ±4.9pp, so not distinguishable from a
 * coin flip, and its halves disagreed by 5.0pp — as much as the effect. Only at
 * 1600 do the halves converge (5.0pp → 1.5pp) and the interval clear 50%. The
 * point estimate barely moved between 400 and 1600 (53.0 → 53.1); what moved was
 * the confidence, which is the thing that decides whether it may be quoted.
 *
 * The rules lean the same way independently: 1v1 gives the player going SECOND
 * an extra rune on their first Channel Phase (485.7 / 486.7), which is the rules
 * compensating the second seat — and the compensation does not close the gap.
 *
 * **Re-measure before trusting this on another basis.** One deck pairing settled
 * it here, and `cardInHand: 0.5` is this repo's standing warning about a true
 * number measured on a basis that stopped being representative.
 */
export const PREFERS_TO_PLAY_FIRST = true;

/** What `chooserIndex` should pick, as a `firstPlayerIndex`. */
export function chosenFirstPlayer(chooserIndex: 0 | 1): 0 | 1 {
  const other: 0 | 1 = chooserIndex === 0 ? 1 : 0;
  return PREFERS_TO_PLAY_FIRST ? chooserIndex : other;
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
 *
 * `firstPlayerIndex` overrides the turn-order ROLL with an already-made
 * decision — 407.4's loser's choice, or a draw's carried order. Absent keeps the
 * roll, which is game 1 and every Best of 1, so no existing seed replays
 * differently.
 */
export function createNewGame(
  config: MatchConfig,
  seed: number,
  battlefields?: BattlefieldChoice,
  firstPlayerIndexOverride?: 0 | 1,
): GameState {
  const registry = defaultCardRegistry();

  const human = buildPlayerFromDeckList("p1", "You", config.humanDeck, registry, mulberry32(seed));
  const ai = buildPlayerFromDeckList("p2", "AI Opponent", config.aiDeck, registry, mulberry32(seed + 1));

  // 1v1 has exactly 2 battlefields in play, one from each player's own
  // deck's 3-battlefield pool — not a shared trio (confirmed against the
  // Java oracle's real game-construction path, RiftboundApp.java:112-125).
  const chosenBattlefields: [BattlefieldState, BattlefieldState] = battlefields
    ? battlefieldPair(battlefields.humanName, battlefields.aiName)
    : chooseMatchBattlefields(config.humanDeck, config.aiDeck, mulberry32(seed + 2));

  // Rule 115: "Determine Turn Order using any fair random method agreed on by
  // all players." This used to be hardcoded to 0, so the human always went
  // first and always ate the going-first disadvantage — see the engine's
  // firstPlayerIndex for the two turn steps that depend on this being real.
  //
  // Its own rng stream (seed + 3) rather than reusing one of the three above:
  // those are already consumed by the two shuffles and the battlefield roll, so
  // drawing from them would shift every existing seed's shuffle and break
  // replayability for no reason.
  // 407.4's answer when there is one, the roll otherwise. See
  // `playFirstDecision` — game 1 and every Best of 1 still roll, so no existing
  // seed replays differently.
  const firstPlayerIndex: 0 | 1 = firstPlayerIndexOverride ?? (mulberry32(seed + 3)() < 0.5 ? 0 : 1);

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
    movementLockedUnitInstanceIds: [],
    spellResolvingForIndex: null,
    markedForDeathOnDamageInstanceIds: [],
    damagePreventedOnceInstanceIds: [],
    damagePreventionPoolByInstanceId: {},
    disempowerAtEndOfTurn: [],
    empowerAtEndOfTurn: [],
    damageInstancesByCardThisTurn: {},
    extraTurns: 0,
    extraTurnsForIndex: 0,
    lastShowdownExcessDamage: null,
    deathWardedUnitInstanceIds: [],
    banishOnDeathUnitInstanceIds: [],
    damageDoubledUnitInstanceIds: [],
    paidDeathWardUnitInstanceIds: [],
    unitsAwaitingDeathReplacement: [],
    unitsAwaitingFreePlacement: [],
    pendingDecisions: [],
  };
}

/** The AI's battlefield for a Match-mode game: rolled from whatever it hasn't
 *  presented yet (rule 486.5). Only the human gets a chooser — the AI has no
 *  basis on which to prefer one of its own battlefields, the same reasoning that
 *  keeps it from mulliganing. */
export function rollAiBattlefield(config: MatchConfig, seed: number, used: string[]): string {
  return pickBattlefield(config.aiDeck.battlefieldNames, used, mulberry32(seed + 4));
}
