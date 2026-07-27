import type { GameState } from "../model/game-state.js";
import type { PassFocusAction } from "./player-action.js";
import { fail, ok, type ValidationResult } from "./validation-result.js";

/**
 * Validates a PassFocus action. Mirrors the shape of
 * ActionValidator.validateClosedChain's `case PlayerAction.PassFocus ->
 * ValidationResult.ok()` (engine/ActionValidator.java:302), narrowed to just
 * the Showdown-open case since the chain itself isn't modeled yet: PassFocus
 * is legal only while a Showdown is open, and only for whoever currently
 * holds Focus (`state.focusHolder`) — matches
 * GameState.actingPlayer()'s "Showdown, chain open -> the Focus holder"
 * precedence rung (model/GameState.java:789-797).
 */
export function validatePassFocus(state: GameState, action: PassFocusAction): ValidationResult {
  if (state.turnState !== "Showdown") {
    return fail("Nothing to pass — no Showdown is active");
  }
  if (action.playerIndex !== state.focusHolder) {
    return fail(`It is not player ${action.playerIndex}'s Focus to pass`);
  }
  return ok();
}
