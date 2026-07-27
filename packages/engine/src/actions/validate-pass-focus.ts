import type { GameState } from "../model/game-state.js";
import type { PassFocusAction } from "./player-action.js";
import { fail, ok, type ValidationResult } from "./validation-result.js";

/**
 * Validates a PassFocus action. Dispatches on `chainOpen` FIRST, mirroring
 * GameEngine.handlePassFocus's own dispatch (engine/GameEngine.java:390-394:
 * `return state.chainOpen ? handleFocusPassOpenShowdown() : handleChainPass();`) —
 * a closed chain takes priority over the Showdown-Focus case regardless of
 * turnState. A 2-branch `if` (not a 3-way Neutral/Showdown/chain-closed
 * split) is sufficient here because Spells can't currently be cast during an
 * open Showdown (validatePlayCard rejects all PlayCard while turnState isn't
 * "Neutral"), so `!chainOpen` only ever occurs with `turnState === "Neutral"`
 * in this engine today — the two states can't overlap yet.
 */
export function validatePassFocus(state: GameState, action: PassFocusAction): ValidationResult {
  if (!state.chainOpen) {
    if (action.playerIndex !== state.chainPriority) {
      return fail(`It is not player ${action.playerIndex}'s chain priority to pass`);
    }
    return ok();
  }
  if (state.turnState !== "Showdown") {
    return fail("Nothing to pass — no Showdown or Chain is active");
  }
  if (action.playerIndex !== state.focusHolder) {
    return fail(`It is not player ${action.playerIndex}'s Focus to pass`);
  }
  return ok();
}
