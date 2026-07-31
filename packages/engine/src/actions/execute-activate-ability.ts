import type { GameState } from "../model/game-state.js";
import type { ActivateAbilityAction } from "./player-action.js";
import { findActivatable, payActivationCost } from "../engine/activated-abilities.js";
import { contextFor } from "../engine/effect-context.js";
import { validateActivateAbility } from "./validate-activate-ability.js";

/**
 * Resolves a validated ActivateAbility action: pay the exhaust cost, then run the
 * registered effect.
 *
 * Cost before effect, deliberately. An effect that removes its own source
 * (Treasure Trove's "Kill this", Forge of the Future's) must have already paid,
 * and an effect whose target vanished must not refund the cost. Doing it the
 * other way round would get both cases wrong in the player's favour.
 *
 * The cost is not always an exhaust — Vi - Destructive's is a Recycle and nothing
 * else, which is why payActivationCost owns this rather than a bare exhaust call.
 *
 * Lux - Crownguard's inline "+2 restricted Energy" used to live in this file; it
 * moved into engine/activated-abilities.ts unchanged, so this function no longer
 * knows anything about any particular card.
 */
export function executeActivateAbility(state: GameState, action: ActivateAbilityAction): GameState {
  const validation = validateActivateAbility(state, action);
  if (!validation.ok) throw new Error(validation.error);

  const found = findActivatable(state, action.playerIndex, action.permanentInstanceId);
  if (!found) throw new Error(`No activatable permanent ${action.permanentInstanceId}`);

  const paid = payActivationCost(state, action.playerIndex, action.permanentInstanceId, found.card.defId);
  if (paid === undefined) throw new Error(`${found.card.name}'s activation cost cannot be paid`);

  return found.definition.resolve(
    paid,
    contextFor(action.playerIndex),
    { ...(action.targetUnitInstanceId !== undefined ? { targetUnitInstanceId: action.targetUnitInstanceId } : {}) },
    action.permanentInstanceId,
  );
}
