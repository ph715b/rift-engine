import type { GameState } from "../model/game-state.js";
import type { RecallUnitAction } from "./player-action.js";
import { fail, ok, type ValidationResult } from "./validation-result.js";

/**
 * Validates a RecallUnit action (battlefield -> base). Mirrors
 * ActionValidator.validateRecallUnit (engine/ActionValidator.java:1579-1626),
 * minus every named-card exception (Minotaur Reckoner, Vilemaw's Lair,
 * Determined Sentry — none of those cards/mechanics exist yet).
 */
export function validateRecallUnit(state: GameState, action: RecallUnitAction): ValidationResult {
  if (action.playerIndex !== state.activePlayerIndex) {
    return fail(`It is not player ${action.playerIndex}'s turn`);
  }
  if (state.phase !== "Action") {
    return fail(`Units can only be recalled during the Action phase, currently: ${state.phase}`);
  }
  if (state.turnState !== "Neutral") {
    return fail("Cannot recall units while a Showdown is open — the fight is already engaged");
  }
  if (action.unitInstanceIds.length === 0) {
    return fail("Must recall at least one unit");
  }
  if (new Set(action.unitInstanceIds).size !== action.unitInstanceIds.length) {
    return fail("Cannot recall the same unit twice in one action");
  }

  const actor = state.players[action.playerIndex];

  for (const unitId of action.unitInstanceIds) {
    const originBattlefield = state.battlefields.find((bf) => bf.units[actor.id]?.some((u) => u.instanceId === unitId));
    const unit = originBattlefield?.units[actor.id]?.find((u) => u.instanceId === unitId);

    if (!unit || !originBattlefield) {
      return fail(`Unit ${unitId} is not at a battlefield for player ${action.playerIndex}`);
    }
    if (unit.exhausted) {
      return fail(`${unit.name} is exhausted and cannot be recalled`);
    }
  }

  return ok();
}
