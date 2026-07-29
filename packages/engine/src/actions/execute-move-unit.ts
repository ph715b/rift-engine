import type { GameState, PlayerState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import { claimBattlefieldControl } from "../engine/combat.js";
import { dispatchOnAttack, dispatchOnMove } from "../engine/unit-triggers.js";
import type { MoveUnitAction } from "./player-action.js";
import { validateMoveUnit } from "./validate-move-unit.js";

function removeFromOrigin(state: GameState, playerIndex: 0 | 1, unitId: string): { state: GameState; unit: UnitInstance } {
  const actor = state.players[playerIndex];
  const inBase = actor.baseUnits.find((u) => u.instanceId === unitId);
  if (inBase) {
    const players = [...state.players] as [PlayerState, PlayerState];
    players[playerIndex] = { ...actor, baseUnits: actor.baseUnits.filter((u) => u.instanceId !== unitId) };
    return { state: { ...state, players }, unit: inBase };
  }

  const bfIndex = state.battlefields.findIndex((bf) => bf.units[actor.id]?.some((u) => u.instanceId === unitId));
  const bf = state.battlefields[bfIndex]!;
  const unit = bf.units[actor.id]!.find((u) => u.instanceId === unitId)!;
  const battlefields = [...state.battlefields];
  battlefields[bfIndex] = { ...bf, units: { ...bf.units, [actor.id]: bf.units[actor.id]!.filter((u) => u.instanceId !== unitId) } };
  return { state: { ...state, battlefields }, unit };
}

function addToBattlefield(state: GameState, playerIndex: 0 | 1, battlefieldId: string, unit: UnitInstance): GameState {
  const actor = state.players[playerIndex];
  const bfIndex = state.battlefields.findIndex((bf) => bf.id === battlefieldId);
  const bf = state.battlefields[bfIndex]!;
  const battlefields = [...state.battlefields];
  battlefields[bfIndex] = { ...bf, units: { ...bf.units, [actor.id]: [...(bf.units[actor.id] ?? []), unit] } };
  return { ...state, battlefields };
}

/**
 * Resolves a validated MoveUnit action, returning a new GameState. Mirrors
 * ActionExecutor.executeMoveUnit (engine/ActionExecutor.java:811-892), minus
 * every named-card trigger (Ahri - Nine-Tailed Fox, Yasuo - Windrider,
 * Noxian Drummer) and the Mageseeker Investigator surcharge. Every moved
 * unit is exhausted unconditionally (a real core rule, not a placeholder —
 * `unit.exhaust()` runs for every move regardless of destination,
 * ActionExecutor.java:849).
 *
 * If the destination becomes contested (both players present), this OPENS a
 * Showdown (turnState/focusHolder/showdownBattlefieldId) instead of
 * resolving combat immediately — mirrors GameEngine.enterShowdown
 * (engine/GameEngine.java:829-858). Combat only actually resolves once two
 * consecutive PassFocus actions close the window (execute-pass-focus.ts).
 * Otherwise this is a walk-in: the mover claims sole control immediately,
 * recording a conquest if it changed hands.
 */
export function executeMoveUnit(state: GameState, action: MoveUnitAction): GameState {
  const validation = validateMoveUnit(state, action);
  if (!validation.ok) throw new Error(validation.error);

  let next = state;
  const movedUnits: UnitInstance[] = [];
  for (const unitId of action.unitInstanceIds) {
    const { state: afterRemove, unit } = removeFromOrigin(next, action.playerIndex, unitId);
    const moved = { ...unit, exhausted: true };
    movedUnits.push(moved);
    next = addToBattlefield(afterRemove, action.playerIndex, action.destinationBattlefieldId, moved);
    // On-move fires for every completed move, contested or not (Traveling
    // Merchant, Noxian Drummer) — on-attack (below) only if it turns out to
    // be contested, so it must wait until every unit has actually landed.
    next = dispatchOnMove(next, moved, action.playerIndex, action.destinationBattlefieldId);
  }

  const bf = next.battlefields.find((b) => b.id === action.destinationBattlefieldId)!;
  const opponentIndex: 0 | 1 = action.playerIndex === 0 ? 1 : 0;
  const opponent = next.players[opponentIndex];
  const opponentPresent = (bf.units[opponent.id]?.length ?? 0) > 0;

  if (!opponentPresent) {
    return claimBattlefieldControl(next, action.destinationBattlefieldId, action.playerIndex);
  }

  // Landing on a contested battlefield is "attacking," same as a Unit
  // played directly there (execute-play-card.ts) — fires once per moved
  // unit, before the Showdown window opens (on-attack effects aren't a
  // priority window in this engine, same synchronous-resolution ordering
  // on-play/on-move triggers already use).
  for (const moved of movedUnits) {
    next = dispatchOnAttack(next, moved, action.playerIndex, action.destinationBattlefieldId);
  }

  return {
    ...next,
    turnState: "Showdown",
    focusHolder: next.activePlayerIndex,
    showdownBattlefieldId: action.destinationBattlefieldId,
    consecutiveFocusPasses: 0,
  };
}
