import type { GameState } from "../model/game-state.js";
import type { ActivateAbilityAction } from "./player-action.js";
import { activationCostOf, canPayActivationCost, resolveActivation, resolveMode } from "../engine/activated-abilities.js";
import { energyAfterFloat } from "../engine/rune-payment.js";
import { eligibleTargets, findUnitOnBattlefield } from "../engine/target-lookup.js";
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

  // One resolver, shared with the enumerator and the executor, so "which ability
  // is this?" has exactly one answer — including for Heimerdinger, who names
  // somebody else's ability with himself as the source.
  const found = resolveActivation(state, action.playerIndex, action.permanentInstanceId, action.viaAbilityDefId);
  if (!found) {
    return fail(`No permanent with id ${action.permanentInstanceId} controlled by player ${action.playerIndex} has that activated ability`);
  }
  const { card, abilityDefId } = found;

  // Not always an exhaust: Vi - Destructive's cost is a Recycle and nothing else,
  // so she is repeatable while her trash lasts. canPayActivationCost answers both
  // shapes, and the enumerator asks the same question so an ability is never
  // offered and then refused.
  if (!canPayActivationCost(state, action.playerIndex, card, abilityDefId)) {
    return fail(`${card.name}'s activation cost cannot be paid right now`);
  }

  // The Energy half is a payment, so the runes named must actually cover what
  // floating Energy does not. Checked here rather than trusted from enumeration,
  // the same way validate-play-card re-derives a card's cost.
  const cost = activationCostOf(abilityDefId);
  if (cost.energy !== undefined) {
    const owed = energyAfterFloat(actor.floatingEnergy, cost.energy);
    const named = (action.payment?.energyRunes ?? []).filter((id) =>
      actor.channeled.some((r) => r.id === id && r.state === "Ready"),
    );
    if (named.length < owed) {
      return fail(`${card.name}'s ability needs ${owed} more Energy than the runes named cover`);
    }
  }

  // Every ability is a list of modes, plain ones having exactly one — so this
  // needs no "is it modal" branch, and neither do the enumerator or the executor.
  const mode = resolveMode(abilityDefId, card, action.modeId);
  if (!mode) {
    return fail(`${card.name} has no such mode available${action.modeId ? ` (${action.modeId})` : ""}`);
  }

  const targeting = mode.targeting;
  if (targeting.kind === "unit") {
    if (action.targetUnitInstanceId === undefined) {
      return fail(`${card.name}'s ability needs a target unit`);
    }
    // Checked against the same eligibleTargets the enumeration uses, so a legal
    // action and an accepted action can't come apart — the failure mode that bit
    // this codebase before, when legal-actions offered a destination the
    // validator refused.
    const legal = eligibleTargets(state, action.playerIndex, targeting.owner, targeting.scope).filter(
      (u) => !targeting.exhaustedOnly || u.exhausted,
    );
    if (!legal.some((u) => u.instanceId === action.targetUnitInstanceId)) {
      return fail(`${action.targetUnitInstanceId} is not a legal target for ${card.name}'s ability`);
    }
  }

  // A mode that moves its target needs somewhere to move it, and it must be a
  // real battlefield the unit is not already standing on — the two conditions
  // the enumerator's own fan-out applies, asked here in the same words so a
  // legal action and an accepted action cannot come apart.
  if (mode.movesTarget) {
    if (action.destinationBattlefieldId === undefined) {
      return fail(`${card.name}'s ability needs a destination battlefield`);
    }
    if (!state.battlefields.some((bf) => bf.id === action.destinationBattlefieldId)) {
      return fail(`No battlefield with id ${action.destinationBattlefieldId}`);
    }
    const from = action.targetUnitInstanceId ? findUnitOnBattlefield(state, action.targetUnitInstanceId) : undefined;
    if (from !== undefined && state.battlefields[from.battlefieldIndex]!.id === action.destinationBattlefieldId) {
      return fail(`${card.name}'s target is already at that battlefield`);
    }
  }

  return ok();
}
