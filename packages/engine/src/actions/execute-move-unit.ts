import type { GameState, PlayerState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import { claimBattlefieldControl, resolveShowdown } from "../engine/combat.js";
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
 * If the destination becomes contested (both players present), combat
 * resolves immediately — see combat.ts's own doc comment for why there's no
 * priority window here yet. Otherwise this is a walk-in: the mover claims
 * sole control, recording a conquest if it changed hands.
 */
export function executeMoveUnit(state: GameState, action: MoveUnitAction): GameState {
  const validation = validateMoveUnit(state, action);
  if (!validation.ok) throw new Error(validation.error);

  let next = state;
  for (const unitId of action.unitInstanceIds) {
    const { state: afterRemove, unit } = removeFromOrigin(next, action.playerIndex, unitId);
    next = addToBattlefield(afterRemove, action.playerIndex, action.destinationBattlefieldId, { ...unit, exhausted: true });
  }

  const bf = next.battlefields.find((b) => b.id === action.destinationBattlefieldId)!;
  const opponentIndex: 0 | 1 = action.playerIndex === 0 ? 1 : 0;
  const opponent = next.players[opponentIndex];
  const opponentPresent = (bf.units[opponent.id]?.length ?? 0) > 0;

  return opponentPresent
    ? resolveShowdown(next, action.destinationBattlefieldId, action.playerIndex)
    : claimBattlefieldControl(next, action.destinationBattlefieldId, action.playerIndex);
}
