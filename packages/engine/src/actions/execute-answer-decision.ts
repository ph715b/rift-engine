import type { GameState } from "../model/game-state.js";
import type { AnswerDecisionAction } from "./player-action.js";
import { answerDecision } from "../engine/decisions.js";

/**
 * Applies an answer, and lets the resolution carry on from where it stopped.
 *
 * `answerDecision` re-checks what the validator checked and returns undefined if
 * the answer doesn't apply, rather than this file repeating the checks — two
 * copies of "is this answer legal" is how enumeration and validation drift
 * apart, which this codebase has already paid for more than once.
 */
export function executeAnswerDecision(state: GameState, action: AnswerDecisionAction): GameState {
  return answerDecision(state, action.decisionId, action.optionId) ?? state;
}
