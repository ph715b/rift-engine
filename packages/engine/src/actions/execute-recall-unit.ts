import type { GameState, PlayerState } from "../model/game-state.js";
import type { RecallUnitAction } from "./player-action.js";
import { validateRecallUnit } from "./validate-recall-unit.js";

/**
 * Resolves a validated RecallUnit action, returning a new GameState. Mirrors
 * ActionExecutor.executeRecallUnit (engine/ActionExecutor.java:940-949):
 * remove from the battlefield, add to base, exhaust (retreating costs your
 * readiness, same as any other move). Deliberately does NOT touch the
 * battlefield's `controllerId` — Java doesn't either, since hold-scoring is
 * derived fresh from live unit presence each Beginning Phase (see
 * scoring.ts's `isHeldBy`), not from a cached controller flag; `controllerId`
 * only changes hands via an actual conquest (a walk-in or won combat).
 */
export function executeRecallUnit(state: GameState, action: RecallUnitAction): GameState {
  const validation = validateRecallUnit(state, action);
  if (!validation.ok) throw new Error(validation.error);

  const actor = state.players[action.playerIndex];
  const recallIds = new Set(action.unitInstanceIds);

  const battlefields = state.battlefields.map((bf) => {
    const ownUnits = bf.units[actor.id];
    if (!ownUnits || !ownUnits.some((u) => recallIds.has(u.instanceId))) return bf;
    return { ...bf, units: { ...bf.units, [actor.id]: ownUnits.filter((u) => !recallIds.has(u.instanceId)) } };
  });

  const recalledUnits = state.battlefields
    .flatMap((bf) => bf.units[actor.id] ?? [])
    .filter((u) => recallIds.has(u.instanceId))
    .map((u) => ({ ...u, exhausted: true }));

  const updatedActor: PlayerState = {
    ...actor,
    baseUnits: [...actor.baseUnits, ...recalledUnits],
  };

  const players = [...state.players] as [PlayerState, PlayerState];
  players[action.playerIndex] = updatedActor;

  return { ...state, players, battlefields };
}
