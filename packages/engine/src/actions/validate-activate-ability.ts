import type { GameState } from "../model/game-state.js";
import type { ActivateAbilityAction } from "./player-action.js";
import { canPayActivationCost, findActivatable } from "../engine/activated-abilities.js";
import { eligibleTargets } from "../engine/target-lookup.js";
import { fail, ok, type ValidationResult } from "./validation-result.js";

/**
 * Validates an ActivateAbility action.
 *
 * Mirrors validateFloatRune's own permissiveness (both mirror a
 * [Reaction]-tagged ability meant to be usable essentially any time during the
 * Action phase to bank a resource for a later Spell): no
 * turnState/chainOpen/whose-priority-it-is check, just phase + ownership + the
 * permanent being Ready and actually having an ability.
 *
 * The registry (engine/activated-abilities.ts) replaced the hardcoded
 * single-card set that used to live here; `findActivatable` looks across base,
 * every battlefield and activeGear, so Gear reaches this path too.
 */
export function validateActivateAbility(state: GameState, action: ActivateAbilityAction): ValidationResult {
  if (state.phase !== "Action") {
    return fail(`Abilities can only be activated during the Action phase, currently: ${state.phase}`);
  }

  const actor = state.players[action.playerIndex];
  if (!actor) return fail(`No player at index ${action.playerIndex}`);

  const found = findActivatable(state, action.playerIndex, action.permanentInstanceId);
  if (!found) {
    return fail(`No permanent with id ${action.permanentInstanceId} controlled by player ${action.playerIndex} has an activated ability`);
  }
  const { card, definition } = found;

  // Not always an exhaust: Vi - Destructive's cost is a Recycle and nothing else,
  // so she is repeatable while her trash lasts. canPayActivationCost answers both
  // shapes, and the enumerator asks the same question so an ability is never
  // offered and then refused.
  if (!canPayActivationCost(state, action.playerIndex, card)) {
    return fail(`${card.name}'s activation cost cannot be paid right now`);
  }

  if (definition.targeting.kind === "unit") {
    if (action.targetUnitInstanceId === undefined) {
      return fail(`${card.name}'s ability needs a target unit`);
    }
    // Checked against the same eligibleTargets the enumeration uses, so a legal
    // action and an accepted action can't come apart — the failure mode that bit
    // this codebase before, when legal-actions offered a destination the
    // validator refused.
    const legal = eligibleTargets(state, action.playerIndex, definition.targeting.owner, definition.targeting.scope);
    if (!legal.some((u) => u.instanceId === action.targetUnitInstanceId)) {
      return fail(`${action.targetUnitInstanceId} is not a legal target for ${card.name}'s ability`);
    }
  }

  return ok();
}
