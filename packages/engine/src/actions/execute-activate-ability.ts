import type { GameState } from "../model/game-state.js";
import type { ActivateAbilityAction } from "./player-action.js";
import { payActivationCost, recordModeUsed, resolveActivation, resolveMode, tracksModeUse } from "../engine/activated-abilities.js";
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

  const found = resolveActivation(state, action.playerIndex, action.permanentInstanceId, action.viaAbilityDefId);
  if (!found) throw new Error(`No activatable permanent ${action.permanentInstanceId}`);

  // The cost belongs to the ABILITY, the exhaust to the SOURCE (416.1) — which
  // are the same card for everything except a borrowed ability.
  const paid = payActivationCost(state, action.playerIndex, action.permanentInstanceId, found.abilityDefId, action.payment, {
    ...(action.costPermanentInstanceId !== undefined ? { costPermanentInstanceId: action.costPermanentInstanceId } : {}),
    ...(action.costDiscardCardInstanceId !== undefined ? { costDiscardCardInstanceId: action.costDiscardCardInstanceId } : {}),
  });
  if (paid === undefined) throw new Error(`${found.card.name}'s activation cost cannot be paid`);

  const mode = resolveMode(found.abilityDefId, found.card, action.modeId);
  if (!mode) throw new Error(`${found.card.name} has no such mode available`);

  // Record the mode BEFORE resolving, so "you've not chosen this turn" is true of
  // a mode whose own effect ends up doing nothing — the choice was still spent.
  const recorded = tracksModeUse(found.abilityDefId)
    ? recordModeUsed(paid, action.playerIndex, action.permanentInstanceId, mode.id)
    : paid;

  return mode.resolve(
    recorded,
    contextFor(action.playerIndex),
    {
      ...(action.targetUnitInstanceId !== undefined ? { targetUnitInstanceId: action.targetUnitInstanceId } : {}),
      // Pack of Wonders' unit-or-gear-or-facedown target. Forwarded for the
      // reason this codebase has now recorded four times: a field that exists on
      // the action, is enumerated and is validated, and is then dropped on the
      // dispatch hop, leaves the ability paying its cost and doing nothing.
      ...(action.targetPermanentInstanceId !== undefined ? { targetPermanentInstanceId: action.targetPermanentInstanceId } : {}),
      ...(action.destinationBattlefieldId !== undefined
        ? { destinationBattlefieldId: action.destinationBattlefieldId }
        : {}),
    },
    action.permanentInstanceId,
  );
}
