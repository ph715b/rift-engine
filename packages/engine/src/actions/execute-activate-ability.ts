import type { GameState } from "../model/game-state.js";
import type { ActivateAbilityAction } from "./player-action.js";
import { payActivationCost, recordModeUsed, resolveActivation, resolveMode, tracksModeUse } from "../engine/activated-abilities.js";
import { contextFor } from "../engine/effect-context.js";
import { validateActivateAbility } from "./validate-activate-ability.js";
import { holdUnitsChosen } from "../engine/triggers.js";
import { recordEnemyChoices } from "../engine/effect-helpers.js";

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

  // Resolved before the payment because the MODE can carry the price — Jax -
  // Grandmaster At Arms's two differ by [1]. Paying the ability's cost and then
  // resolving the mode would charge his free mode for his priced one.
  const mode = resolveMode(found.abilityDefId, found.card, action.modeId);
  if (!mode) throw new Error(`${found.card.name} has no such mode available`);

  // The cost belongs to the ABILITY, the exhaust to the SOURCE (416.1) — which
  // are the same card for everything except a borrowed ability.
  const paid = payActivationCost(
    state,
    action.playerIndex,
    action.permanentInstanceId,
    found.abilityDefId,
    action.payment,
    {
      ...(action.costPermanentInstanceId !== undefined ? { costPermanentInstanceId: action.costPermanentInstanceId } : {}),
      ...(action.costDiscardCardInstanceId !== undefined ? { costDiscardCardInstanceId: action.costDiscardCardInstanceId } : {}),
      ...(action.xAmount !== undefined ? { xAmount: action.xAmount } : {}),
    },
    mode.id,
  );
  if (paid === undefined) throw new Error(`${found.card.name}'s activation cost cannot be paid`);

  // Record the mode BEFORE resolving, so "you've not chosen this turn" is true of
  // a mode whose own effect ends up doing nothing — the choice was still spent.
  const recorded = tracksModeUse(found.abilityDefId)
    ? recordModeUsed(paid, action.playerIndex, action.permanentInstanceId, mode.id)
    : paid;

  // An ABILITY choosing a unit is a choice too, and this is the half
  // `holdUnitsChosenBySpell` never covered — Irelia - Fervent's own comment named
  // "it never sees an ABILITY choosing her" as one of three reasons it could not
  // be reused.
  //
  // Held BEFORE the ability resolves, matching 355's announcement moment. An
  // ability's effect runs inline rather than on the chain, so the held trigger
  // resolves after it — the opposite order from the Spell path, and it follows
  // from where each effect happens rather than from a choice made here.
  const chosen =
    action.targetUnitInstanceId !== undefined
      ? holdUnitsChosen(recorded, action.playerIndex, [action.targetUnitInstanceId], false)
      : recorded;

  // Ezreal - Prodigal Explorer's tally — "with spells or UNIT abilities", so the
  // source's kind is the whole gate here. A Legend's ability chooses units every
  // time Jax - Grandmaster At Arms is used and must not count; nor must a gear's.
  // Read off the resolved source rather than from the action, which does not say
  // what it named.
  const counted =
    found.card.kind === "Unit"
      ? recordEnemyChoices(
          chosen,
          action.playerIndex,
          [action.targetUnitInstanceId, action.targetPermanentInstanceId].filter((id): id is string => id !== undefined),
        )
      : chosen;

  return mode.resolve(
    counted,
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
      // The X of an X-cost ability. Forwarded for the same reason as every
      // field above it: enumerated, validated, and then dropped on this hop
      // would leave Hextech Anomaly exhausting itself to add nothing.
      ...(action.xAmount !== undefined ? { xAmount: action.xAmount } : {}),
    },
    action.permanentInstanceId,
  );
}
