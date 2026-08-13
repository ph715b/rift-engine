import type { GameState } from "../model/game-state.js";
import type { RecallUnitAction } from "./player-action.js";
import { fail, ok, type ValidationResult } from "./validation-result.js";
import { unitMayMoveThisTurn, unitMayMoveToBase } from "../engine/battlefield-continuous.js";

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
  if (!state.chainOpen) {
    return fail("Cannot recall units while a spell is pending resolution");
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
    // Vilemaw's Lair — "units can't move from here to base". The same function
    // `legal-actions` asks, so the recall can never be offered and then refused.
    // **A Recall IS a move to base**, so Vex - Apathetic's this-turn lock reaches
    // it. Gating only `validate-move-unit` left this path open, and the test that
    // caught it hand-built exactly the action a locked unit should not be able to
    // take — the enumerator was already refusing to offer it, which is the shape
    // that hides a validator gap.
    if (!unitMayMoveThisTurn(state, unit.instanceId)) {
      return fail(`${unit.name} cannot move this turn`);
    }
    // Through the per-UNIT door: Determined Sentry's "I can't move to base" is
    // a fact about one unit, and the board-only predicate would let him home.
    if (!unitMayMoveToBase(state, unit, originBattlefield.id)) {
      return fail(`${unit.name} cannot move from ${originBattlefield.name} to base`);
    }
  }

  return ok();
}
