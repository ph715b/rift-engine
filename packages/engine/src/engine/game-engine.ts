import type { GameState, PlayerState } from "../model/game-state.js";
import type { PlayerAction } from "../actions/player-action.js";
import { validatePlayCard } from "../actions/validate-play-card.js";
import { executePlayCard } from "../actions/execute-play-card.js";
import { validatePass } from "../actions/validate-pass.js";
import { validateMoveUnit } from "../actions/validate-move-unit.js";
import { executeMoveUnit } from "../actions/execute-move-unit.js";
import { validateRecallUnit } from "../actions/validate-recall-unit.js";
import { executeRecallUnit } from "../actions/execute-recall-unit.js";
import { validatePassFocus } from "../actions/validate-pass-focus.js";
import { executePassFocus } from "../actions/execute-pass-focus.js";
import { validateFloatRune } from "../actions/validate-float-rune.js";
import { executeFloatRune } from "../actions/execute-float-rune.js";
import { validateActivateAbility } from "../actions/validate-activate-ability.js";
import { executeActivateAbility } from "../actions/execute-activate-ability.js";
import { runEnd, runStartOfTurn } from "./turn-manager.js";
import { winner } from "./win-condition.js";
import { runCleanup } from "./cleanup.js";
import type { SubmitResult } from "./submit-result.js";

/**
 * Draws up to 4 cards per player from their deck into hand. Mirrors
 * GameEngine.dealOpeningHandsOnly (engine/GameEngine.java:74-96) — silently
 * stops early if a deck runs out (a real 40-card deck never will from a
 * 4-card opening hand; same "no Burn Out safety net needed here" reasoning
 * the Java doc comment gives).
 */
export function dealOpeningHands(state: GameState): GameState {
  const players = state.players.map((p): PlayerState => {
    const drawn = p.deck.slice(0, 4);
    return { ...p, deck: p.deck.slice(drawn.length), hand: [...p.hand, ...drawn] };
  }) as [PlayerState, PlayerState];
  return { ...state, players };
}

/**
 * Every resolved action ends the same way: run the Cleanup, then check whether
 * anyone has won. That order is the rules' own — rule 323's Cleanup performs its
 * state-based actions (including control lapsing, step 4) and the victory check
 * is a cleanup-time question (194.4 / 198.1). Cleanup can't create or destroy
 * points, so it can't change who wins this instant; running it first is about
 * never leaving a caller holding a state the rules wouldn't allow.
 */
function withCleanupAndWinnerCheck(state: GameState): { state: GameState; result: SubmitResult } {
  const cleaned = runCleanup(state);
  const w = winner(cleaned);
  if (w === null) return { state: cleaned, result: { type: "Ok" } };
  return { state: cleaned, result: { type: "GameOver", winnerId: cleaned.players[w].id } };
}

/** Runs the first Start-of-Turn sequence on an already-hands-dealt state.
 *  Split out from `startGame` so callers can deal hands, run a pregame
 *  Mulligan for both players (see actions/execute-mulligan.ts), and only
 *  then begin the first turn — mirrors GameEngine.beginFirstTurn()
 *  (engine/GameEngine.java:123-131), which the real client calls only after
 *  its own mulligan screens finish (ui/RiftboundApp.java:135-139). */
export function beginFirstTurn(state: GameState): { state: GameState; result: SubmitResult } {
  return withCleanupAndWinnerCheck(runStartOfTurn(state));
}

/** Deals opening hands and runs the first Start-of-Turn sequence, with no
 *  mulligan step in between — used directly wherever a match doesn't need
 *  one (e.g. engine tests exercising turn machinery in isolation). */
export function startGame(state: GameState): { state: GameState; result: SubmitResult } {
  return beginFirstTurn(dealOpeningHands(state));
}

/**
 * Mirrors GameEngine.submit(PlayerAction) (engine/GameEngine.java:133-276),
 * scoped to the action types implemented so far. A bare `Pass` ends the turn
 * outright (`turnManager.endTurn(); turnManager.runStartOfTurn();`, :270-271)
 * and is illegal while a Showdown is open — the two-consecutive-passes
 * mechanic belongs to PassFocus instead (executePassFocus), which only
 * passes Focus within an open Showdown, not the whole turn.
 */
export function submit(state: GameState, action: PlayerAction): { state: GameState; result: SubmitResult } {
  if (winner(state) !== null) {
    return { state, result: { type: "Invalid", error: "Game is already over" } };
  }

  switch (action.type) {
    case "PlayCard": {
      const validation = validatePlayCard(state, action);
      if (!validation.ok) return { state, result: { type: "Invalid", error: validation.error } };
      return withCleanupAndWinnerCheck(executePlayCard(state, action));
    }
    case "Pass": {
      const validation = validatePass(state, action);
      if (!validation.ok) return { state, result: { type: "Invalid", error: validation.error } };
      return withCleanupAndWinnerCheck(runStartOfTurn(runEnd(state)));
    }
    case "MoveUnit": {
      const validation = validateMoveUnit(state, action);
      if (!validation.ok) return { state, result: { type: "Invalid", error: validation.error } };
      return withCleanupAndWinnerCheck(executeMoveUnit(state, action));
    }
    case "RecallUnit": {
      const validation = validateRecallUnit(state, action);
      if (!validation.ok) return { state, result: { type: "Invalid", error: validation.error } };
      return withCleanupAndWinnerCheck(executeRecallUnit(state, action));
    }
    case "PassFocus": {
      const validation = validatePassFocus(state, action);
      if (!validation.ok) return { state, result: { type: "Invalid", error: validation.error } };
      return withCleanupAndWinnerCheck(executePassFocus(state, action));
    }
    case "FloatRune": {
      const validation = validateFloatRune(state, action);
      if (!validation.ok) return { state, result: { type: "Invalid", error: validation.error } };
      return withCleanupAndWinnerCheck(executeFloatRune(state, action));
    }
    case "ActivateAbility": {
      const validation = validateActivateAbility(state, action);
      if (!validation.ok) return { state, result: { type: "Invalid", error: validation.error } };
      return withCleanupAndWinnerCheck(executeActivateAbility(state, action));
    }
  }
}
