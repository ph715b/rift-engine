import type { GameState } from "../model/game-state.js";
import type { MoveUnitAction } from "./player-action.js";
import { fail, ok, type ValidationResult } from "./validation-result.js";

/**
 * Validates a MoveUnit action. Mirrors ActionValidator.validateMoveUnit
 * (engine/ActionValidator.java:1507-1577), minus every named-card
 * exception (Ganking granted by Raging Soul/Windswept Hillock/Breakneck
 * Mech/Sivir - Mercenary, Baron Pit's origin-agnostic destination, Vex -
 * Apathetic's movement lock, Mageseeker Investigator's surcharge) — only
 * the printed [Ganking] keyword itself is checked for battlefield-to-
 * battlefield moves. Base -> battlefield needs no keyword at all.
 *
 * The turnState check mirrors ActionValidator.validateShowdownOpen's hard
 * rejection of MoveUnit ("the fight is already engaged") — once a Showdown
 * is open, only PassFocus (and, eventually, reaction-speed plays) are legal.
 */
export function validateMoveUnit(state: GameState, action: MoveUnitAction): ValidationResult {
  if (action.playerIndex !== state.activePlayerIndex) {
    return fail(`It is not player ${action.playerIndex}'s turn`);
  }
  if (state.phase !== "Action") {
    return fail(`Units can only move during the Action phase, currently: ${state.phase}`);
  }
  if (state.turnState !== "Neutral") {
    return fail("Cannot move units while a Showdown is open — the fight is already engaged");
  }
  if (action.unitInstanceIds.length === 0) {
    return fail("Must move at least one unit");
  }
  if (new Set(action.unitInstanceIds).size !== action.unitInstanceIds.length) {
    return fail("Cannot move the same unit twice in one action");
  }

  const destination = state.battlefields.find((bf) => bf.id === action.destinationBattlefieldId);
  if (!destination) return fail(`No battlefield with id ${action.destinationBattlefieldId}`);

  const actor = state.players[action.playerIndex];

  for (const unitId of action.unitInstanceIds) {
    const inBase = actor.baseUnits.find((u) => u.instanceId === unitId);
    const originBattlefield = state.battlefields.find((bf) => bf.units[actor.id]?.some((u) => u.instanceId === unitId));
    const unit = inBase ?? originBattlefield?.units[actor.id]?.find((u) => u.instanceId === unitId);

    if (!unit) return fail(`Unit ${unitId} does not belong to player ${action.playerIndex} in a movable zone`);
    if (unit.exhausted) return fail(`${unit.name} is exhausted and cannot move`);

    if (originBattlefield) {
      if (originBattlefield.id === destination.id) {
        return fail(`${unit.name} is already at the destination battlefield`);
      }
      if (!("Ganking" in unit.keywords)) {
        return fail(`${unit.name} needs Ganking to move battlefield-to-battlefield`);
      }
    }
  }

  return ok();
}
