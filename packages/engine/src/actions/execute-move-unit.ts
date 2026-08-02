import type { GameState, PlayerState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import { applyContested } from "../engine/cleanup.js";
import { dispatchOnAttack, dispatchOnMove } from "../engine/unit-triggers.js";
import { holdEventTrigger } from "../engine/triggers.js";
import { findUnitOnBattlefield } from "../engine/target-lookup.js";
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
 * The destination becomes **Contested** if the mover doesn't already control it
 * (rule 458) — whether or not an opponent is standing there. That is the only
 * thing this does about Showdowns: the window itself is staged by the following
 * Cleanup (316.9 / 341, see cleanup.stageShowdowns), which also decides whether
 * it's a Combat Showdown (opposing units present) or a Non-Combat one.
 *
 * This replaced two different inline behaviours, and the second is the reason
 * for the change: a contested destination used to open a Showdown here, while an
 * UNCONTESTED one claimed control on the spot and scored instantly — skipping
 * the window entirely. Rules 458/317.1 give the empty-battlefield case its own
 * Showdown too, and 352.1 is where its control (and Conquer) is established, at
 * the point the window closes.
 */
export function executeMoveUnit(state: GameState, action: MoveUnitAction): GameState {
  const validation = validateMoveUnit(state, action);
  if (!validation.ok) throw new Error(validation.error);

  let next = state;
  const movedUnits: UnitInstance[] = [];
  for (const unitId of action.unitInstanceIds) {
    // Where it came FROM, captured before the removal — `removeFromOrigin` is
    // what makes that unanswerable afterwards.
    const origin = findUnitOnBattlefield(next, unitId)?.battlefieldIndex;
    const originId = origin !== undefined ? next.battlefields[origin]!.id : "base";
    const { state: afterRemove, unit } = removeFromOrigin(next, action.playerIndex, unitId);
    // `movesThisTurn` counts this unit's moves, for Miss Fortune - Captain's
    // "the FIRST time I move each turn" and Yasuo - Windrider's "the THIRD time
    // I move in a turn". Incremented on the Standard Move only: a unit relocated
    // by a spell (forceMoveToBattlefield) or recalled (454, explicitly not a
    // Move) has not moved in the sense those cards ask about.
    const moved = { ...unit, exhausted: true, movesThisTurn: unit.movesThisTurn + 1 };
    const isFirstMoveThisTurn = unit.movesThisTurn === 0;
    movedUnits.push(moved);
    next = addToBattlefield(afterRemove, action.playerIndex, action.destinationBattlefieldId, moved);
    // On-move fires for every completed move, contested or not (Traveling
    // Merchant, Noxian Drummer) — on-attack (below) only if it turns out to
    // be contested, so it must wait until every unit has actually landed.
    next = dispatchOnMove(next, moved, action.playerIndex, action.destinationBattlefieldId, isFirstMoveThisTurn);
    // A board-wide event, distinct from the per-card ON_MOVE_TRIGGERS table
    // above: that one is keyed by the MOVING unit's defId and can never reach a
    // listener sitting on a different card. Stealthy Pursuer watches "a friendly
    // unit moves FROM my location" and Volibear - Imposing watches an opponent's
    // moves, neither of which the table can express.
    //
    // HELD (383), never dispatched — the whole point of adding it now rather
    // than later is that a `dispatchEvent` site would grow the Chain backlog it
    // is being written against.
    //
    // Carries the ORIGIN as well as the destination, which is what Stealthy
    // Pursuer needs and what `dispatchOnMove` cannot provide: by the time it
    // runs the unit has already been removed from where it was.
    next = holdEventTrigger(next, {
      kind: "unitMoved",
      moverIndex: action.playerIndex,
      unitInstanceId: moved.instanceId,
      from: originId,
      to: action.destinationBattlefieldId,
      movesThisTurn: moved.movesThisTurn,
    });
  }

  const bf = next.battlefields.find((b) => b.id === action.destinationBattlefieldId)!;
  const opponentIndex: 0 | 1 = action.playerIndex === 0 ? 1 : 0;
  const opponent = next.players[opponentIndex];
  const opponentPresent = (bf.units[opponent.id]?.length ?? 0) > 0;

  if (opponentPresent) {
    // Landing on a battlefield the opponent holds is "attacking," same as a Unit
    // played directly there (execute-play-card.ts) — fires once per moved unit,
    // before the Showdown window opens (on-attack effects aren't a priority
    // window in this engine, same synchronous-resolution ordering on-play/on-move
    // triggers already use). Only the Combat case has attackers, so this stays
    // gated on the opponent actually being present rather than on Contested.
    for (const moved of movedUnits) {
      next = dispatchOnAttack(next, moved, action.playerIndex, action.destinationBattlefieldId);
    }
  }

  return applyContested(next, action.destinationBattlefieldId, action.playerIndex);
}
