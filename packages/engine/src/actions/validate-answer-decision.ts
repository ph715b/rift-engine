import type { GameState } from "../model/game-state.js";
import type { AnswerDecisionAction } from "./player-action.js";
import { optionsFor, pendingDecision } from "../engine/decisions.js";
import { fail, ok, type ValidationResult } from "./validation-result.js";

/**
 * Validates an answer to the question the engine has stopped to ask.
 *
 * Notably absent: any check of phase, turn, Focus, priority or chain state. A
 * pending decision sits INSIDE a resolution, and while one is open the game is
 * not in a state where those questions have answers — rule 321 makes the
 * point from the other direction ("while Chain Items are Resolving, a Cleanup
 * cannot occur"). The gate in game-engine.submit is what stops anything else
 * from happening; this only checks that the answer itself makes sense.
 */
export function validateAnswerDecision(state: GameState, action: AnswerDecisionAction): ValidationResult {
  const decision = pendingDecision(state);
  if (!decision) return fail("Nothing is waiting to be answered");

  // A question already answered must not have its answer land on whatever took
  // its place — "discard 2" queues two questions in a row, and they are
  // different questions about different cards.
  if (decision.id !== action.decisionId) {
    return fail(`That answer is for a question that has already been resolved (${action.decisionId})`);
  }
  if (decision.playerIndex !== action.playerIndex) {
    return fail("That question was asked of the other player");
  }
  if (!optionsFor(state, decision).some((o) => o.id === action.optionId)) {
    return fail(`"${action.optionId}" is not one of the available answers`);
  }
  return ok();
}
