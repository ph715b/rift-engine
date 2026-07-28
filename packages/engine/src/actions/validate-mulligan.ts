import type { GameState } from "../model/game-state.js";
import type { MulliganAction } from "./mulligan-action.js";
import { fail, ok, type ValidationResult } from "./validation-result.js";

/**
 * Validates a Mulligan action. Mirrors the checks GameEngine.mulligan
 * (engine/GameEngine.java:98-121) performs inline before mutating state: a
 * hard cap of 2 cards, and every set-aside card must actually be in that
 * player's hand. Deliberately no phase/turn/chainOpen/turnState checks —
 * the real method has none either, since it only ever runs pregame, outside
 * the Awaken/Beginning/Channel/Draw/Action/End phase machine entirely.
 *
 * The explicit duplicate-id check has no direct Java line to cite: Java's
 * `List.remove(Object)` naturally rejects a repeated reference on its
 * second call ("not in hand" once already removed), but our action carries
 * ids rather than object references, so this reproduces the same rejection
 * explicitly rather than relying on a coincidental side effect.
 */
export function validateMulligan(state: GameState, action: MulliganAction): ValidationResult {
  if (action.setAsideInstanceIds.length > 2) {
    return fail("Can only mulligan up to 2 cards");
  }
  if (new Set(action.setAsideInstanceIds).size !== action.setAsideInstanceIds.length) {
    return fail("Cannot set aside the same card twice");
  }

  const actor = state.players[action.playerIndex];
  for (const id of action.setAsideInstanceIds) {
    if (!actor.hand.some((c) => c.instanceId === id)) {
      return fail(`Card ${id} is not in player ${action.playerIndex}'s hand`);
    }
  }

  return ok();
}
