import type { GameState } from "../model/game-state.js";
import type { ActivateAbilityAction } from "./player-action.js";
import {
  activationCostOf,
  activationCostFor,
  canPayActivationCost,
  costPayerPairingAllowed,
  exhaustableFriendlyUnits,
  killableFriendlyPermanents,
  resolveActivation,
  resolveMode,
} from "../engine/activated-abilities.js";
import { payEnergyFromPool, payPowerFromChanneled } from "../engine/effect-helpers.js";
import { energyAfterFloat } from "../engine/rune-payment.js";
import { chosenUnitsOfActivation, deflectSurchargeForTargets } from "../engine/granted-keywords.js";
import {
  eligibleTargets,
  findUnitOnBattlefield,
  unchooseableAmong,
  unitOrGearTargets,
  unitSatisfiesAttackingOnly,
} from "../engine/target-lookup.js";
import { attachableEquipment, equipmentPairedWith } from "../engine/equipment.js";
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

  // **The mode is resolved BEFORE the cost, because for Jax - Grandmaster At Arms
  // the mode IS the cost** — his detached-attach costs [1] and his re-attach is
  // free. Everything below prices `mode.id`, which is the same answer for every
  // other ability in the pool, whose modes share one price.
  //
  // Every ability is a list of modes, plain ones having exactly one — so this
  // needs no "is it modal" branch, and neither do the enumerator or the executor.
  const mode = resolveMode(abilityDefId, card, action.modeId);
  if (!mode) {
    return fail(`${card.name} has no such mode available${action.modeId ? ` (${action.modeId})` : ""}`);
  }

  // Not always an exhaust: Vi - Destructive's cost is a Recycle and nothing else,
  // so she is repeatable while her trash lasts. canPayActivationCost answers both
  // shapes, and the enumerator asks the same question so an ability is never
  // offered and then refused.
  // The X an X-cost ability names has to be one the pools can actually cover,
  // and re-derived here rather than trusted: a hand-built action could claim a
  // large X and pay nothing. Asked through the same helpers that will spend it.
  const xCost = activationCostOf(abilityDefId, mode.id);
  if (xCost.xRainbowPower || xCost.xEnergy) {
    const x = action.xAmount ?? 0;
    if (x <= 0) return fail(`${card.name}'s ability must be activated for an X of at least 1`);
    const payable = xCost.xRainbowPower
      ? payPowerFromChanneled(state, action.playerIndex, null, x) !== undefined
      : payEnergyFromPool(state, action.playerIndex, x) !== undefined;
    if (!payable) return fail(`${card.name}'s ability cannot pay an X of ${x}`);
  }
  if (!canPayActivationCost(state, action.playerIndex, card, abilityDefId, mode.id)) {
    return fail(`${card.name}'s activation cost cannot be paid right now`);
  }

  // The Energy half is a payment, so the runes named must actually cover what
  // floating Energy does not. Checked here rather than trusted from enumeration,
  // the same way validate-play-card re-derives a card's cost.
  //
  // **Reckoned AFTER the Power step, because that is the order the cost is
  // actually paid in.** `payActivationCost` pays Power first, and paying Power
  // recycles a rune — which banks 1 floating Energy for a Ready one (164.2: a
  // Basic Rune has both `[E]: Add [1]` and `Recycle this: Add [C]`, so one Ready
  // rune can produce both). Measuring `owed` against the PRE-Power pool therefore
  // over-charges by exactly the runes the Power step will recycle.
  //
  // That desynchronised the enumerator from the validator when `activationPayment`
  // moved to post-Power reckoning: `legal-actions` offered Baited Hook and this
  // function refused it, "needs 1 more Energy than the runes named cover" — the
  // offered-then-refused failure this file's own comment above exists to prevent.
  // It was unreachable until OGN-242 became the first ability to combine `energy`
  // with `power`, and the first test to drive that path through `submit` found it.
  // Priced against the TARGET this action names — UNL-188's Energy is reduced
  // by the chosen unit's Might, so a cost read without it would refuse the very
  // payment the enumerator offered.
  const cost = activationCostFor(state, action.playerIndex, abilityDefId, mode.id, action.targetUnitInstanceId);
  if (cost.energy !== undefined) {
    const afterPower = cost.power
      ? (payPowerFromChanneled(state, action.playerIndex, cost.power.domain, cost.power.count) ?? state)
      : state;
    const payer = afterPower.players[action.playerIndex];
    const owed = energyAfterFloat(payer.floatingEnergy, cost.energy);
    const named = (action.payment?.energyRunes ?? []).filter((id) =>
      payer.channeled.some((r) => r.id === id && r.state === "Ready"),
    );
    if (named.length < owed) {
      return fail(`${card.name}'s ability needs ${owed} more Energy than the runes named cover`);
    }
  }

  // **[Deflect]** — "opponents must pay N rainbow Power to choose me with a
  // spell OR ABILITY". Re-derived here rather than trusted from the action,
  // exactly as `validate-play-card` re-derives a Spell's: a client could
  // otherwise quote itself a cheaper target than the one it names.
  //
  // Asked through the same `chosenUnitsOfActivation` the enumerator uses, so
  // the two cannot come to different answers about which fields name a unit —
  // the offered-then-refused failure this file already carries a comment about.
  // Ruin Runner — asked of the SAME list, immediately before the surcharge.
  // 'I can't be chosen by enemy spells and ABILITIES', so this path is half
  // the card and not an afterthought of the Spell one.
  const unchooseable = unchooseableAmong(state, action.playerIndex, chosenUnitsOfActivation(action));
  if (unchooseable !== undefined) {
    return fail(`${unchooseable} can't be chosen by enemy spells and abilities`);
  }
  const deflected = deflectSurchargeForTargets(state, action.playerIndex, chosenUnitsOfActivation(action));
  if (deflected > 0) {
    const rainbow = action.payment?.rainbowRunes ?? [];
    if (rainbow.length < deflected) {
      return fail(
        `${card.name}'s ability must pay ${deflected} rainbow Power for [Deflect] on its target, ` +
          `but named ${rainbow.length}`,
      );
    }
    const ownCost = new Set(action.payment?.energyRunes ?? []);
    for (const id of rainbow) {
      if (!actor.channeled.some((r) => r.id === id)) {
        return fail(`Rune ${id} is not in ${actor.name}'s channeled pool`);
      }
      // One rune cannot pay both the ability's own cost and an opponent's tax —
      // the same line `validate-play-card` draws, for the same reason.
      if (ownCost.has(id)) {
        return fail(`Rune ${id} is already spent on ${card.name}'s own cost and cannot also pay its [Deflect] surcharge`);
      }
    }
  }

  // The three costs that carry a CHOICE, re-derived from the same walks the
  // enumerator fans out from — a hand-built action could otherwise kill an
  // ENEMY unit "to pay", exhaust one that is already exhausted, or discard a card
  // it does not hold.
  if (cost.exhaustFriendlyUnit) {
    const legal = exhaustableFriendlyUnits(state, action.playerIndex);
    if (!legal.some((u) => u.instanceId === action.costPermanentInstanceId)) {
      return fail(
        `${card.name}'s ability must exhaust a ready friendly unit to pay, and ${action.costPermanentInstanceId ?? "nothing"} is not one`,
      );
    }
  }
  if (cost.killFriendlyPermanent) {
    const legal = killableFriendlyPermanents(state, action.playerIndex, action.permanentInstanceId);
    if (!legal.some((p) => p.instanceId === action.costPermanentInstanceId)) {
      return fail(`${card.name}'s ability must kill a friendly permanent to pay, and ${action.costPermanentInstanceId ?? "nothing"} is not one`);
    }
  }
  if (cost.discard !== undefined) {
    if (!actor.hand.some((c) => c.instanceId === action.costDiscardCardInstanceId)) {
      return fail(`${card.name}'s ability must discard a card from hand to pay`);
    }
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
      (u) => (!targeting.exhaustedOnly || u.exhausted) && unitSatisfiesAttackingOnly(state, u, targeting.attackingOnly),
    );
    if (!legal.some((u) => u.instanceId === action.targetUnitInstanceId)) {
      return fail(`${action.targetUnitInstanceId} is not a legal target for ${card.name}'s ability`);
    }
  }

  // Pack of Wonders' unit-or-gear-or-facedown target, asked through the same walk
  // the enumerator fans out from — including its three narrowings, or a player
  // could name the Pack itself and bounce the card that is paying for the ability.
  if (targeting.kind === "unitOrGear") {
    if (action.targetPermanentInstanceId === undefined) {
      return fail(`${card.name}'s ability needs a target`);
    }
    const legal = unitOrGearTargets(state, {
      playerIndex: action.playerIndex,
      ...(targeting.owner !== undefined ? { owner: targeting.owner } : {}),
      ...(targeting.excludesSelf ? { excludeInstanceId: action.permanentInstanceId } : {}),
      ...(targeting.includesFacedown !== undefined ? { includesFacedown: targeting.includesFacedown } : {}),
    });
    if (!legal.some((t) => t.instanceId === action.targetPermanentInstanceId)) {
      return fail(`${action.targetPermanentInstanceId} is not a legal target for ${card.name}'s ability`);
    }
  }

  // A mode that ATTACHES an Equipment needs to name WHICH, and it must be one the
  // same walk the enumerator fans out from would have offered — friendly, an
  // Equipment, and on the right side of the detached/attached line this mode is
  // about. Without the walk a hand-built action could move an opponent's
  // Equipment, or pay Jax's [1] mode to re-seat one that was already attached.
  if (mode.attachesEquipment) {
    if (action.targetPermanentInstanceId === undefined) {
      return fail(`${card.name}'s ability needs an Equipment to attach`);
    }
    const legal = attachableEquipment(state, action.playerIndex, mode.attachesEquipment, action.targetUnitInstanceId ?? "");
    if (!legal.some((g) => g.instanceId === action.targetPermanentInstanceId)) {
      return fail(`${action.targetPermanentInstanceId} is not an Equipment ${card.name} can attach to that unit`);
    }
  }

  // Azir - Ascendant's reverse axis. Naming NO Equipment is legal — the card says
  // "you MAY" — so only a named one is checked, and it must be worn by the very
  // unit chosen, through the same walk the enumerator fanned out from.
  if (mode.attachesFromTargetToSelf && action.targetPermanentInstanceId !== undefined) {
    const worn = equipmentPairedWith(state, action.targetUnitInstanceId ?? "", "attachedToIt");
    if (!worn.some((g) => g.instanceId === action.targetPermanentInstanceId)) {
      return fail(`${action.targetPermanentInstanceId} is not an Equipment worn by that unit`);
    }
  }

  // The pair check — UNL-045's "a DIFFERENT unit you control" and its refusal to
  // move a unit to where it already stands. Asked LAST, after both halves have
  // been checked individually, and through the very function the enumerator's
  // cross calls so an offered pair and an accepted pair cannot come apart.
  if (!costPayerPairingAllowed(state, mode, action)) {
    return fail(`${card.name}'s ability cannot exhaust that unit to move this one — they must differ and be in different locations`);
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
