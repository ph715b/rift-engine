import type { GameState } from "../model/game-state.js";
import type { PassAction } from "./player-action.js";
import { fail, ok, type ValidationResult } from "./validation-result.js";

/**
 * Mirrors ActionValidator's unconditional `case PlayerAction.Pass ignored ->
 * ValidationResult.ok()` in the closed-chain branch (engine/ActionValidator.java:85)
 * — Pass has no cost/state to check, only whose turn/phase it is (no
 * chain/Showdown modeled yet, so only the active player during their Action
 * phase may pass).
 */
export function validatePass(state: GameState, action: PassAction): ValidationResult {
  if (action.playerIndex !== state.activePlayerIndex) {
    return fail(`It is not player ${action.playerIndex}'s turn`);
  }
  if (state.phase !== "Action") {
    return fail(`Can only pass during the Action phase, currently: ${state.phase}`);
  }
  return ok();
}
