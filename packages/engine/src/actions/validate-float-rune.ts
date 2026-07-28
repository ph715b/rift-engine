import type { GameState } from "../model/game-state.js";
import type { FloatRuneAction } from "./player-action.js";
import { fail, ok, type ValidationResult } from "./validation-result.js";

/**
 * Validates a FloatRune action. Mirrors ActionValidator.validateFloatRune
 * (engine/ActionValidator.java:772-792) — deliberately permissive:
 * floating is legal essentially any time during the Action phase,
 * regardless of turnState/chainOpen/whose priority it is (mirrors
 * ActionValidator.validate()'s dispatch, engine/ActionValidator.java:19-30,
 * which routes FloatRune to this validator BEFORE the Showdown/closed-chain
 * gates every other action respects). Only Energy mode (`forPower: false`)
 * requires the rune to be Ready — recycling for Power accepts Ready or
 * Exhausted, matching the real "Recycle this" ability's own lack of a
 * state restriction.
 */
export function validateFloatRune(state: GameState, action: FloatRuneAction): ValidationResult {
  if (state.phase !== "Action") {
    return fail(`Runes can only be floated during the Action phase, currently: ${state.phase}`);
  }

  const actor = state.players[action.playerIndex];
  const rune = actor.channeled.find((r) => r.id === action.runeId);
  if (!rune) {
    return fail(`Rune ${action.runeId} is not in player ${action.playerIndex}'s channeled pool`);
  }
  if (!action.forPower && rune.state !== "Ready") {
    return fail("Only a Ready rune can be exhausted for Energy");
  }

  return ok();
}
