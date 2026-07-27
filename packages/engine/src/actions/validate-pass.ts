import type { GameState } from "../model/game-state.js";
import type { PassAction } from "./player-action.js";
import { fail, ok, type ValidationResult } from "./validation-result.js";

/**
 * Mirrors ActionValidator's unconditional `case PlayerAction.Pass ignored ->
 * ValidationResult.ok()` in the Neutral/chain-open branch
 * (engine/ActionValidator.java:85) — Pass has no cost to check, only whose
 * turn/phase/turnState it is. Rejecting it during an open Showdown mirrors
 * validateShowdownOpen's own hard rejection ("Cannot end turn during a
 * Showdown — use Pass Focus"): Pass ends the whole turn, which would
 * otherwise abandon an unresolved fight and leave turnState stuck at
 * "Showdown" forever.
 */
export function validatePass(state: GameState, action: PassAction): ValidationResult {
  if (action.playerIndex !== state.activePlayerIndex) {
    return fail(`It is not player ${action.playerIndex}'s turn`);
  }
  if (state.phase !== "Action") {
    return fail(`Can only pass during the Action phase, currently: ${state.phase}`);
  }
  if (state.turnState !== "Neutral") {
    return fail("Cannot end your turn while a Showdown is open — use Pass Focus instead");
  }
  return ok();
}
