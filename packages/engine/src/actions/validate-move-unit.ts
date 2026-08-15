import type { GameState } from "../model/game-state.js";
import { battlefieldTakesMovesFromAnywhere } from "../engine/battlefield-tokens.js";
import { unitMayMoveThisTurn } from "../engine/battlefield-continuous.js";
import type { MoveUnitAction } from "./player-action.js";
import { fail, ok, type ValidationResult } from "./validation-result.js";
import { hasKeyword } from "../engine/granted-keywords.js";
import { moveSurchargeFor } from "../engine/move-surcharge.js";

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
  if (!state.chainOpen) {
    return fail("Cannot move units while a spell is pending resolution");
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
    // Vex - Apathetic's "they can't move it this turn". Asked BESIDE exhaustion
    // rather than folded into it: a locked unit that gets readied is still
    // locked, which is the whole of what the clause buys her.
    if (!unitMayMoveThisTurn(state, unit.instanceId)) {
      return fail(`${unit.name} cannot move this turn`);
    }

    if (originBattlefield) {
      if (originBattlefield.id === destination.id) {
        return fail(`${unit.name} is already at the destination battlefield`);
      }
      // effectiveKeywords, not unit.keywords: Raging Soul and Bilgewater Bully
      // GAIN Ganking conditionally, and a granted keyword has to behave exactly
      // like a printed one.
      //
      // **The Baron Pit overrides it for its own destination** — "Units can move
      // here from anywhere", which is exactly 813's restriction being lifted. Asked
      // through the same helper `legal-actions.movableTo` asks, so the enumerator
      // and this gate cannot disagree about a move.
      if (
        !hasKeyword(state, unit, action.playerIndex, "Ganking") &&
        !battlefieldTakesMovesFromAnywhere(state, destination.id)
      ) {
        return fail(`${unit.name} needs Ganking to move battlefield-to-battlefield`);
      }
    }
  }

  // **UNL-163 Mageseeker Investigator's surcharge.** This function's own header
  // used to name it as one of the omissions; it is the last of them to land.
  //
  // A COST, never a prohibition. The card makes a group move expensive, not
  // impossible, so a mover who cannot pay is refused THIS action and remains free
  // to move the same units one at a time for nothing — which is exactly what the
  // printed text leaves them.
  //
  // Re-derived from the board rather than trusted from the action, the same rule
  // every other cost site here follows: a client could otherwise quote itself a
  // cheaper move than the one it names. The runes must also still be in the
  // mover's pool, since naming an id is not holding it.
  const owed = moveSurchargeFor(state, action.playerIndex, destination.id, action.unitInstanceIds.length);
  if (owed > 0) {
    const named = action.payment?.rainbowRunes ?? [];
    const held = named.filter((id) => actor.channeled.some((r) => r.id === id));
    if (held.length < owed) {
      return fail(`Moving ${action.unitInstanceIds.length} units to ${destination.name} costs ${owed} rainbow Power`);
    }
  }

  return ok();
}
