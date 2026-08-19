import type { GameState, PlayerState, RepeatChoices, RepeatExecution } from "../model/game-state.js";
import type {
  ActivateAbilityAction,
  FloatRuneAction,
  HideCardAction,
  MoveUnitAction,
  PassAction,
  PassFocusAction,
  PlayCardAction,
  PlayerAction,
  RecallUnitAction,
  RunePayment,
} from "../actions/player-action.js";
import { computeAutoPayment, computeEffectiveCost, matchesPowerDomain, restrictedPowerFor } from "./rune-payment.js";
import { variantCostDiscount } from "./cost-modifiers.js";
import { ownTrashCandidates } from "./card-effects.js";
import { counterFilter, counterableSpells, choosesOnlyThisFriendlyUnit } from "./counter-spell.js";
import { mayPlaceWithoutPresence, targetingForAnyCard, unitTriggerHasVisionChoice } from "./unit-triggers.js";
import {
  eligibleTargets,
  findUnitAnywhere,
  findUnitOnBattlefield,
  shareABattlefield,
  unitListCandidates,
  gearTargets,
  gearOwnerMatches,
  unitOrGearTargets,
  unitSatisfiesAttackingOnly,
  ownerIndexOf,
  unitSatisfiesEmpoweredOnly,
  unitSatisfiesNarrowing,
  unitWithinMaxMight,
  activatableGearTargets,
} from "./target-lookup.js";
import {
  modifiedEnergyCost,
  modifiedRepeatEnergy,
  discountedOptionalCosts,
  optionalCostDiscountApplies,
  targetChoiceDiscount,
  scaledPowerDiscount,
  combatSpellPowerDiscount,
  rainbowSurchargeForPlay,
} from "./cost-modifiers.js";
import {
  cardModesOf,
  cardMovesTarget,
  costExhaustsLegend,
  cardMayMoveToBase,
  cardPlacesTokens,
  targetMustBeElsewhere,
  moveDestinationAllowed,
  type TargetingSpec,
  discardChoiceOf,
  hasXRainbowCost,
  optionalPowerCostOf,
  optionalXpCostOf,
  optionalXpEnergyDiscountOf,
  xpWidenedTargetingFor,
  optionalUnitCostOf,
  grantedRepeatCostOf,
  repeatCostOf,
  repeatCostsOf,
  cardRequiresDistinctModes,
  slotOwner,
  slotScope,
  costNamesGear,
} from "./card-effects.js";
import {
  abilitiesAvailableTo,
  activationCostOf,
  activationPayment,
  availableModes,
  activationCostFor,
  canPayActivationCost,
  costPayerPairingAllowed,
  discardableForCost,
  exhaustableFriendlyUnits,
  killableFriendlyPermanents,
  type AbilityMode,
} from "./activated-abilities.js";
import {
  ACCELERATE_ENERGY,
  ACCELERATE_POWER,
  acceleratePowerDomain,
  actingPlayerIndex,
  hasAccelerate,
  ambushHasAnyDestination,
  mayPlayCardNow,
  mayPlayFromTrash,
  mayPlayFromTrashAtPrintedPrice,
  mayPlayUnitToBase,
  mayPlayUnitToBattlefield,
} from "./timing.js";
import { RAINBOW, hiddenCardIsPlayable, hideCostFor, isHiddenCard, mayHideWithEnergy } from "./hidden.js";
import { replacedCostFor } from "./replaced-costs.js";
import { battlefieldTakesMovesFromAnywhere } from "./battlefield-tokens.js";
import { foreignRepeatPip, reserveForeignPip, standingRepeatGrantFor } from "./repeat-grants.js";
import { moveSurchargeFor } from "./move-surcharge.js";
import {
  chosenUnitsOfActivation,
  chosenUnitsOfPlay,
  chosenUnitsOfRepeat,
  deflectSurchargeForTargets,
  hasKeyword,
} from "./granted-keywords.js";
import { hiddenCardLimitAt, unitMayMoveThisTurn, unitMayMoveToBase, mayPlayUnitAt } from "./battlefield-continuous.js";
import { effectiveMight } from "./effective-might.js";
import { attachableEquipment, equipmentPairedWith } from "./equipment.js";
import { optionsFor, pendingDecision } from "./decisions.js";
import { defaultCardRegistry } from "../cards/card-registry.js";
import type { CardInstance, UnitInstance } from "../model/card.js";

/**
 * Does a `secondAtDestination` spec's second target actually stand at the
 * destination the first is being moved to? True for every other spec.
 *
 * Shared by the enumerator and `validate-play-card` so a Dragon's Rage variant
 * can never be offered and then refused — the drift this codebase has shipped
 * three times.
 */
export function secondTargetIsAtDestination(
  state: GameState,
  targeting: { kind: string; secondAtDestination?: true },
  action: {
    targetUnitInstanceId?: string;
    secondTargetUnitInstanceId?: string;
    destinationBattlefieldId?: string;
    destinationIsBase?: true;
  },
): boolean {
  if (targeting.kind !== "unitSlots" || targeting.secondAtDestination !== true) return true;
  if (action.secondTargetUnitInstanceId === undefined) return true; // nothing chosen yet
  // The destination is a BASE — Dragon's Rage sending an enemy home and then
  // naming "another enemy unit at its destination", which is another unit
  // standing in that same base. `baseUnits` is per player and 107.1.c puts a
  // unit only in its controller's, so "the destination" is the base of whoever
  // owns the second target: they are at the same base exactly when they share a
  // controller.
  if (action.destinationIsBase === true) {
    const second = findUnitAnywhere(state, action.secondTargetUnitInstanceId);
    if (second === undefined || second.zone !== "base") return false;
    const moved = action.targetUnitInstanceId === undefined ? undefined : findUnitAnywhere(state, action.targetUnitInstanceId);
    return moved !== undefined && moved.ownerIndex === second.ownerIndex;
  }
  if (action.destinationBattlefieldId === undefined) return false;
  const at = findUnitOnBattlefield(state, action.secondTargetUnitInstanceId);
  return at !== undefined && state.battlefields[at.battlefieldIndex]!.id === action.destinationBattlefieldId;
}

/**
 * The units `playerIndex` may move to `destinationId` right now, asked one unit
 * at a time.
 *
 * Every condition here was already being asked by the two per-unit loops this
 * replaced, and each is kept in the same words for the same reason:
 *
 *   - a unit must be READY (144.2 makes exhausting it the cost);
 *   - Vex - Apathetic's this-turn lock is asked at BOTH origins. Gating only the
 *     battlefield loop once left a locked unit in BASE free to walk out, which is
 *     the exact board her own pin drives — she stuns a unit as it arrives, and it
 *     arrives in a base;
 *   - a unit already AT a battlefield needs `[Ganking]` to move to another, asked
 *     through the same grant layer the validator uses so a conditionally-Ganking
 *     unit is never offered a move that is then refused;
 *   - and it cannot move to where it already stands.
 */
function movableTo(state: GameState, playerIndex: 0 | 1, destinationId: string): UnitInstance[] {
  const actor = state.players[playerIndex];
  const fromBase = actor.baseUnits.filter((u) => !u.exhausted && unitMayMoveThisTurn(state, u.instanceId));
  // **The Baron Pit lifts 813's [Ganking] restriction for its own destination** —
  // "Units can move here from anywhere". Asked through the same helper
  // `validate-move-unit` asks, so an offered move can never be refused.
  const anywhere = battlefieldTakesMovesFromAnywhere(state, destinationId);
  const fromBattlefields = state.battlefields.flatMap((bf) =>
    bf.id === destinationId
      ? []
      : (bf.units[actor.id] ?? []).filter(
          (u) =>
            !u.exhausted &&
            unitMayMoveThisTurn(state, u.instanceId) &&
            (anywhere || hasKeyword(state, u, playerIndex, "Ganking")),
        ),
  );
  return [...fromBase, ...fromBattlefields];
}

/**
 * Every non-empty subset of `units`, smallest first.
 *
 * **Bounded, and the bound is reported rather than silent.** 144.3 allows any
 * number of units to move at once, so the honest enumeration is the full power
 * set — 2^n. That is fine at the sizes real boards reach and catastrophic if one
 * ever does not: the AI evaluates every action it is offered, so an unbounded
 * fan-out turns one large turn into a hang.
 *
 * `MAX_GROUPED_MOVERS` is the line. Below it the enumeration is complete; at or
 * above it, only the singletons and the all-in group are emitted, which keeps the
 * two moves anyone actually makes and drops the middle. A truncation nobody can
 * see is worse than one that is written down, so this says so here and
 * `groupedMoveTruncated` lets a test assert the boundary from both sides.
 */
const MAX_GROUPED_MOVERS = 4;

function nonEmptySubsets(units: readonly UnitInstance[]): UnitInstance[][] {
  if (units.length === 0) return [];
  // Asked through the SAME predicate the test pins, not through a second copy of
  // the comparison. A first version wrote `units.length > MAX_GROUPED_MOVERS`
  // here and `moverCount > MAX_GROUPED_MOVERS` there; mutating this one to `>=`
  // left every test green, because the assertion about the boundary was reading
  // the other function. Two expressions of one rule is how a bound comes to be
  // documented at a value it does not have.
  if (groupedMoveTruncated(units.length)) {
    return [...units.map((u) => [u]), [...units]];
  }
  const out: UnitInstance[][] = [];
  for (let mask = 1; mask < 1 << units.length; mask += 1) {
    out.push(units.filter((_, i) => (mask & (1 << i)) !== 0));
  }
  return out;
}

/** Whether a group of this size would be enumerated exhaustively — the boundary
 *  `MAX_GROUPED_MOVERS` draws, exported so a test can pin both sides of it. */
export function groupedMoveTruncated(moverCount: number): boolean {
  return moverCount > MAX_GROUPED_MOVERS;
}

/**
 * The most PRINTED `[Repeat]` instances this file will fan out over — the same
 * kind of stated bound `MAX_GROUPED_MOVERS` is, and here for the same reason.
 *
 * 820.1.c.2 makes every subset of a card's instances a distinct play at a
 * distinct price, so the honest enumeration is 2^n, and the AI evaluates every
 * action it is offered. UNL-182 Curtain Call prints exactly three, so at this
 * value nothing is truncated today; the bound exists so that a card printing
 * five does not silently turn one turn into a hang. Above the line only the
 * SINGLETONS and the all-in plan are offered, which is the same "keep the two
 * plays anyone makes, drop the middle" shape the mover bound takes.
 *
 * `repeatSubsetsTruncated` is the predicate, exported so a test can pin the
 * boundary from both sides rather than restating the comparison.
 */
const MAX_ENUMERATED_REPEAT_INSTANCES = 3;

/** Whether a card with this many printed `[Repeat]` instances is enumerated
 *  exhaustively. */
export function repeatSubsetsTruncated(instanceCount: number): boolean {
  return instanceCount > MAX_ENUMERATED_REPEAT_INSTANCES;
}

/** Every non-empty subset of `[0, count)`, smallest first, bounded as above. */
function repeatInstanceSubsets(count: number): number[][] {
  const all = Array.from({ length: count }, (_, i) => i);
  if (count === 0) return [];
  if (repeatSubsetsTruncated(count)) return [...all.map((i) => [i]), [...all]];
  const out: number[][] = [];
  for (let mask = 1; mask < 1 << count; mask += 1) {
    out.push(all.filter((i) => (mask & (1 << i)) !== 0));
  }
  return out.sort((a, b) => a.length - b.length);
}

/** Every `size`-element subset of `modes`, in printed order within each. */
function modeSubsetsOfSize<T>(modes: readonly T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (size > modes.length) return [];
  const out: T[][] = [];
  const walk = (start: number, picked: T[]): void => {
    if (picked.length === size) {
      out.push([...picked]);
      return;
    }
    for (let i = start; i < modes.length; i += 1) {
      picked.push(modes[i]!);
      walk(i + 1, picked);
      picked.pop();
    }
  };
  walk(0, []);
  return out;
}

/**
 * One `MoveUnit` action for `group`, carrying the Applied Cost when something
 * taxes it, or undefined when that cost cannot be paid.
 *
 * The surcharge is asked through `moveSurchargeFor` — the same function the
 * validator and the executor ask — so the three cannot disagree about the price.
 * Undefined means 204.4.c: a player who cannot pay cannot perform the action.
 */
function pricedMove(
  state: GameState,
  playerIndex: 0 | 1,
  destinationId: string,
  group: readonly UnitInstance[],
): MoveUnitAction | undefined {
  const move: MoveUnitAction = {
    type: "MoveUnit",
    playerIndex,
    unitInstanceIds: group.map((u) => u.instanceId),
    destinationBattlefieldId: destinationId,
  };
  const owed = moveSurchargeFor(state, playerIndex, destinationId, group.length);
  if (owed === 0) return move;
  // Any Ready rune pays a rainbow cost. Taken in channeled order, which is the
  // order `payMoveSurcharge` spends in, so this predicts exactly what it will take.
  const rainbow = state.players[playerIndex].channeled.filter((r) => r.state === "Ready").slice(0, owed);
  if (rainbow.length < owed) return undefined;
  return { ...move, payment: { energyRunes: [], powerRunes: [], rainbowRunes: rainbow.map((r) => r.id) } };
}

/** Every legal FloatRune candidate for `actor` — one Energy-mode candidate
 *  per Ready rune, one Power-mode (recycle) candidate per rune regardless
 *  of state (mirrors validateFloatRune's own Ready-only-for-Energy rule).
 *  Used in all three branches below (Neutral, Showdown, closed-chain),
 *  since the real rule lets a player float at essentially any time during
 *  the Action phase — see validate-float-rune.ts's own doc comment. */
function floatRuneCandidates(actor: PlayerState, playerIndex: 0 | 1): FloatRuneAction[] {
  const actions: FloatRuneAction[] = [];
  for (const rune of actor.channeled) {
    if (rune.state === "Ready") {
      actions.push({ type: "FloatRune", playerIndex, runeId: rune.id, forPower: false });
    }
    actions.push({ type: "FloatRune", playerIndex, runeId: rune.id, forPower: true });
  }
  return actions;
}

/**
 * Every legal ActivateAbility candidate for `actor` — one per Ready permanent
 * they control that has an activated ability, fanned out per legal target where
 * the ability targets.
 *
 * `activeGear` is in the scan now, not just units: the ":rb_exhaust::" cost is on
 * 20 of the 30 Gear in this pool, and while this only looked at base and
 * battlefield units none of them could ever be activated.
 *
 * Included in all three branches below, same permissiveness as
 * floatRuneCandidates — see validate-activate-ability.ts's own doc comment.
 */
function activateAbilityCandidates(state: GameState, actor: PlayerState, playerIndex: 0 | 1): ActivateAbilityAction[] {
  // `grantedAbilitiesThisTurn` is declared here rather than left to structural
  // widening: a UnitInstance assigned into this literal type LOSES the field at
  // the type level, so `abilitiesAvailableTo` would be handed the grant at
  // runtime and unable to read it — a Dominus'd unit would silently never offer
  // its granted ability, with nothing red anywhere.
  const owned: {
    instanceId: string;
    defId: string;
    exhausted: boolean;
    buffed?: boolean;
    grantedAbilitiesThisTurn?: readonly string[];
  }[] = [
    ...actor.baseUnits,
    ...state.battlefields.flatMap((bf) => bf.units[actor.id] ?? []),
    ...actor.activeGear,
    // The legend zone, which is not on the board — two preset legends have an
    // exhaust ability and were unreachable while this list held board zones only.
    actor.legend,
  ];

  const out: ActivateAbilityAction[] = [];
  for (const permanent of owned) {
    // A list, not a lookup: Heimerdinger offers every friendly permanent's
    // ability with himself as the source, so one card can be several candidates.
    for (const { abilityDefId } of abilitiesAvailableTo(state, playerIndex, permanent)) {
      // Each variant carries the cost choices of the MODE that produced it —
      // Jax - Grandmaster At Arms prices his two modes differently, so a single
      // list per ability would charge one mode's price for the other's job.
      //
      // Carried at PUSH time rather than looked up afterwards. A first version
      // registered them in a Map keyed by the variant after each mode's block,
      // and the `continue`s above it (a `unitOrGear` mode, a target-less one)
      // jumped straight past the registration — Malzahar - Fanatic lost his
      // kill-choice axis entirely, which his own test caught.
      // `mode` rides along for the same reason `costChoices` does: the cross
      // below runs OUTSIDE the mode loop, and the pair check it applies is a
      // property of the mode. Reading it from a variable that has moved on is
      // precisely the bug the `costChoices` comment below was written after.
      const variants: { action: ActivateAbilityAction; costChoices: Partial<ActivateAbilityAction>[]; mode: AbilityMode }[] = [];

      // One candidate per MODE still available — Udyr's four are four separate
      // choices, and one he has already taken this turn is not offered again.
      for (const mode of availableModes(abilityDefId, permanent)) {
        // **Priced inside the mode loop, not outside it.** Jax - Grandmaster At
        // Arms's two modes cost [1]+exhaust and exhaust; one price computed per
        // ABILITY would sell whichever job the cheaper mode named. Every other
        // ability's modes share one price, so this is the same answer for them
        // however many times it is asked.
        //
        // Asks the same payability question the validator does — an exhaust, a
        // Recycle, a spent Buff and an Energy cost fail for different reasons, and
        // only the registry knows which this ability has.
        if (!canPayActivationCost(state, playerIndex, permanent, abilityDefId, mode.id)) continue;

        // Priced with NO target, which for every ability but one is the only
        // price there is. UNL-188 Hextech Gauntlets reduces its Energy by the
        // chosen unit's Might, and `activationCostFor` answers the BEST case
        // here on purpose: this gate runs before any target exists, and pricing
        // the un-reduced cost would withhold the Gauntlets entirely whenever the
        // player could afford them only with the discount. Each candidate is
        // re-priced against its own target in the fan-out below.
        const cost = activationCostFor(state, playerIndex, abilityDefId, mode.id);
        const payment = cost.energy !== undefined ? activationPayment(state, playerIndex, cost) : undefined;
        if (cost.energy !== undefined && payment === undefined) continue;
        /** This ability's action for a chosen target, re-priced when the cost
         *  depends on it. Returns undefined when that target's price is
         *  unpayable, so a candidate is never offered and then refused. */
        const pricedFor = (action: ActivateAbilityAction, targetUnitInstanceId: string): ActivateAbilityAction | undefined => {
          const targeted = activationCostFor(state, playerIndex, abilityDefId, mode.id, targetUnitInstanceId);
          if (targeted.energy === undefined) return action;
          if (targeted.energy === cost.energy) return action; // nothing target-dependent moved
          const repriced = activationPayment(state, playerIndex, targeted);
          if (repriced === undefined) return undefined;
          return { ...action, payment: repriced };
        };

        const base: ActivateAbilityAction = {
          type: "ActivateAbility",
          playerIndex,
          permanentInstanceId: permanent.instanceId,
          // Named only when it is somebody else's ability, so an ordinary
          // activation's action is byte-for-byte what it always was.
          ...(abilityDefId !== permanent.defId ? { viaAbilityDefId: abilityDefId } : {}),
          ...(payment !== undefined ? { payment } : {}),
        };

        // A cost that carries a CHOICE fans out its own axis, crossed with the
        // mode/target axes below — Malzahar - Fanatic names WHICH friendly
        // permanent he kills to pay, Unlicensed Armory WHICH card it discards. A
        // single `[{}]` for every other ability, so their actions are unchanged.
        const costChoices = activationCostChoices(state, playerIndex, permanent.instanceId, cost);
        const push = (action: ActivateAbilityAction) => variants.push({ action, costChoices, mode });
        // `modeId` is omitted for a plain ability's single unnamed mode, so an
        // ordinary activation's action is exactly what it always was.
        const withMode = mode.id === "" ? base : { ...base, modeId: mode.id };
        // Pack of Wonders is the first ABILITY to target a unit-or-gear, and this
        // branch is why it could not simply reuse the spec: ability enumeration
        // fanned out only `"unit"` and pushed everything else target-less, so a
        // `unitOrGear` ability would have been offered with nothing chosen and
        // then done nothing. Rides `targetPermanentInstanceId`, the same field a
        // Spell's unitOrGear uses, so nothing expecting a unit is handed a gear.
        if (mode.targeting.kind === "unitOrGear") {
          for (const t of unitOrGearTargets(state, {
            playerIndex,
            ...(mode.targeting.owner !== undefined ? { owner: mode.targeting.owner } : {}),
            ...(mode.targeting.excludesSelf ? { excludeInstanceId: permanent.instanceId } : {}),
            ...(mode.targeting.includesFacedown !== undefined ? { includesFacedown: mode.targeting.includesFacedown } : {}),
          })) {
            push({ ...withMode, targetPermanentInstanceId: t.instanceId });
          }
          continue;
        }
        // Jayce - Defender of Tomorrow is the first ABILITY to target a GEAR, and
        // this branch is why it could not simply reuse the spec: ability
        // enumeration fanned out `"unit"` and `"unitOrGear"` and pushed
        // everything else TARGET-LESS, so a `"gear"` ability would have been
        // offered with nothing chosen and then done nothing — the exact shape the
        // `unitOrGear` note above records having fixed for Pack of Wonders.
        //
        // Through `activatableGearTargets`, the same walk `validate-activate-
        // ability` asks, so the enumerator cannot offer a gear the validator then
        // refuses. That disagreement is this file's most-repeated bug.
        if (mode.targeting.kind === "gear") {
          for (const g of activatableGearTargets(state, playerIndex, mode.targeting, permanent.instanceId)) {
            push({ ...withMode, targetPermanentInstanceId: g.instanceId });
          }
          continue;
        }
        if (mode.targeting.kind !== "unit") {
          push(withMode);
          continue;
        }
        // Fan out one action per legal target, exactly as the PlayCard path does
        // for a targeted Spell — the choice has to be in the submitted action. A
        // mode with no legal target is simply not offered, since paying for
        // nothing is never what the player meant.
        for (const target of eligibleTargets(state, playerIndex, mode.targeting.owner, mode.targeting.scope, mode.targeting.domain)) {
          if (!unitWithinMaxMight(state, target, mode.targeting.maxMight)) continue;
          if (mode.targeting.exhaustedOnly && !target.exhausted) continue;
          // Wired on the ability path too, though no ability prints it today.
          // `exhaustedOnly` was wired ONLY here and not on the spell path, which
          // is the mirror-image gap; one filter reaching only half its call
          // sites is how a spec field comes to be silently ignored.
          if (!unitSatisfiesAttackingOnly(state, target, mode.targeting.attackingOnly)) continue;
          // A mode that ATTACHES an Equipment needs to name WHICH, so the
          // fan-out is unit x Equipment — the same second-axis shape
          // `movesTarget` uses, off the same shared walk the validator checks
          // against. A unit with nothing attachable to it is simply not offered.
          if (mode.attachesEquipment) {
            for (const gear of attachableEquipment(state, playerIndex, mode.attachesEquipment, target.instanceId)) {
              const priced = pricedFor(
                { ...withMode, targetUnitInstanceId: target.instanceId, targetPermanentInstanceId: gear.instanceId },
                target.instanceId,
              );
              if (priced) push(priced);
            }
            continue;
          }
          // Azir - Ascendant's "if it's equipped, you MAY attach one of its
          // Equipment to me" — the reverse direction: the Equipment is chosen off
          // the TARGET and ends up on the SOURCE.
          //
          // The decline goes first and unconditionally, because "you may" stays
          // refusable even when a legal Equipment exists — and because a target
          // wearing nothing must still be a legal swap. Same shared walk Angle
          // Shot's validator uses, so the two cannot disagree about what is worn.
          if (mode.attachesFromTargetToSelf) {
            push({ ...withMode, targetUnitInstanceId: target.instanceId });
            for (const gear of equipmentPairedWith(state, target.instanceId, "attachedToIt")) {
              push({ ...withMode, targetUnitInstanceId: target.instanceId, targetPermanentInstanceId: gear.instanceId });
            }
            continue;
          }
          if (!mode.movesTarget) {
            // The Gauntlets' `[Equip]` is a plain unit-targeting ability, so this
            // is the branch their per-target price is actually taken at.
            const priced = pricedFor({ ...withMode, targetUnitInstanceId: target.instanceId }, target.instanceId);
            if (priced) push(priced);
            continue;
          }
          // A mode that MOVES its target needs a destination too, so the fan-out
          // is target x battlefield — the same second axis a Charm-style Spell
          // already gets from cardMovesTarget. Where the unit already is is not
          // a destination: offering it would be a no-op the player paid for.
          const from = findUnitOnBattlefield(state, target.instanceId);
          for (const bf of state.battlefields) {
            if (from !== undefined && state.battlefields[from.battlefieldIndex]!.id === bf.id) continue;
            push({ ...withMode, targetUnitInstanceId: target.instanceId, destinationBattlefieldId: bf.id });
          }
        }
      }

      for (const { action: variant, costChoices, mode } of variants) {
        // **[Deflect] on what this variant CHOSE.** Priced per variant for the
        // same reason a Spell's is: the price depends on the target, so one
        // variant can be affordable while another is not, and a single payment
        // computed once per ability cannot say so.
        //
        // The surcharge can CREATE a payment where there was none. Most taxed
        // abilities in this pool cost only an exhaust (Iron Ballista, Orb of
        // Regret), so their actions carried no `payment` at all — a version that
        // only extended an existing one would have left exactly those untaxed.
        const owed = deflectSurchargeForTargets(state, playerIndex, chosenUnitsOfActivation(variant));
        const taxed = owed > 0 ? withActivationSurcharge(state, playerIndex, variant, owed, abilityDefId) : variant;
        // An unpayable surcharge is not an offer. Same rule as the Spell path,
        // and the same reason: never enumerate what the validator will refuse.
        if (taxed === undefined) continue;
        for (const choice of costChoices) {
          const candidate = { ...taxed, ...choice };
          // The one constraint that spans the cost axis and the target axis at
          // once — UNL-045's "a DIFFERENT unit", and its refusal to move a unit
          // to where it already stands. Vacuously true for every other ability,
          // and re-derived by `validate-activate-ability` from the same function
          // so a pair offered here and a pair accepted there cannot come apart.
          if (!costPayerPairingAllowed(state, mode, candidate)) continue;
          out.push(candidate);
        }
      }
    }
  }
  return out;
}

/**
 * `action` with `owed` rainbow runes added to its payment, or undefined when the
 * pool cannot cover the surcharge.
 *
 * Runes already named for the ability's own Energy are excluded, which is the
 * same rule `computeAutoPayment` applies to a Spell's: 164.2's double duty is
 * about paying YOUR cost, and a tax handed to an opponent refunds nothing.
 *
 * ANY domain and ANY state — a Power cost is paid by recycling (416), so an
 * already-exhausted rune recycles for the tax just as well as a Ready one.
 */
function withActivationSurcharge(
  state: GameState,
  playerIndex: 0 | 1,
  action: ActivateAbilityAction,
  owed: number,
  /** The ability being taxed, so its own Power cost can be RESERVED below. */
  abilityDefId: string,
): ActivateAbilityAction | undefined {
  const spent = new Set(action.payment?.energyRunes ?? []);

  // **Reserve the runes the ability's own Power cost will take.**
  //
  // This used to exclude only `energyRunes`, and its comment said so accurately —
  // the gap is that an activated ability's POWER runes are named NOWHERE in the
  // action. `payActivationCost` pays that cost by calling `payPowerFromChanneled`,
  // which picks from state itself, and it runs BEFORE the surcharge. So the tax
  // could name the very rune the Power cost was about to spend; the Power step
  // took it, `recycleRunesForSurcharge` then could not find it, and
  // `executeActivateAbility` THREW — a hard crash, not a refusal, because
  // `canPayActivationCost` never looks at the surcharge and had already said yes.
  //
  // Found 2026-08-09 by the `hunt-xp` probe, which died on "Xerath - Freed's
  // activation cost cannot be paid" while holding FOUR ready Fury runes. It was
  // reachable only once something taxable was on the board: wave 2 added Bird
  // tokens carrying `[Deflect]`, and the collision needs a `[Deflect]` target AND
  // an ability with a domain Power cost. The engine tests never caught it because
  // no fixture put those two together — which is the case for keeping a probe
  // that plays whole games alongside them.
  //
  // Reserved in the SAME order `payPowerFromChanneled` spends (channeled order,
  // domain-matching first), so this predicts exactly what it will take rather
  // than approximating. Floating Power is deliberately not modelled: it pays
  // BEFORE any rune there, so ignoring it only ever over-reserves, which costs a
  // surcharge option rather than crashing.
  const powerCost = activationCostOf(abilityDefId, action.modeId).power;
  const reserved = new Set(
    powerCost === undefined
      ? []
      : state.players[playerIndex].channeled
          .filter((r) => matchesPowerDomain(r, powerCost.domain))
          .slice(0, powerCost.count)
          .map((r) => r.id),
  );
  const rainbow = state.players[playerIndex].channeled
    .filter((r) => !spent.has(r.id) && !reserved.has(r.id))
    .slice(0, owed);
  if (rainbow.length < owed) return undefined;
  return {
    ...action,
    payment: {
      energyRunes: action.payment?.energyRunes ?? [],
      powerRunes: action.payment?.powerRunes ?? [],
      rainbowRunes: rainbow.map((r) => r.id),
    },
  };
}

/**
 * The ways an activation cost that carries a CHOICE could be paid, as action
 * fields — one entry per way, or a single empty entry for the costs that need
 * no choice at all.
 *
 * Fanned out here rather than asked at resolution for the reason every other
 * choice in this engine is: the submitted action carries the whole decision, so
 * a replay of the action log is deterministic without a decision transcript.
 */
function activationCostChoices(
  state: GameState,
  playerIndex: 0 | 1,
  sourceInstanceId: string,
  cost: ReturnType<typeof activationCostOf>,
): Partial<ActivateAbilityAction>[] {
  let choices: Partial<ActivateAbilityAction>[] = [{}];
  if (cost.killFriendlyPermanent) {
    choices = choices.flatMap((c) =>
      killableFriendlyPermanents(state, playerIndex, sourceInstanceId).map((p) => ({ ...c, costPermanentInstanceId: p.instanceId })),
    );
  }
  // UNL-045 Forgotten Signpost's "Exhaust a unit you control". The SAME action
  // field as the kill above, because no card prints both and both answer "which
  // permanent did the cost name" — and the same walk `payActivationCost` and the
  // validator use, so the four sites cannot disagree about what is exhaustable.
  //
  // **This axis is not independent of the target**, unlike every other choice in
  // this function: the payer must not BE the target and must not stand where the
  // target already is. Neither can be checked here — the target does not exist
  // yet — so the pair is filtered at the cross, by `costPayerPairingAllowed`.
  if (cost.exhaustFriendlyUnit) {
    choices = choices.flatMap((c) =>
      exhaustableFriendlyUnits(state, playerIndex).map((u) => ({ ...c, costPermanentInstanceId: u.instanceId })),
    );
  }
  if (cost.discard !== undefined) {
    // One per DISTINCT card in hand rather than per copy: two copies of the same
    // card are the same discard, and offering both doubles the AI's branching
    // for a choice that cannot differ. The same de-duplication the hand-play
    // enumerator already does.
    const seen = new Set<string>();
    // Through the shared walk, so Sky Cruiser's "discard a GEAR" offers gear and
    // nothing else — the narrowing the validator asks about too.
    const hand = discardableForCost(state, playerIndex, cost).filter((c) => !seen.has(c.defId) && seen.add(c.defId));
    choices = choices.flatMap((c) => hand.map((card) => ({ ...c, costDiscardCardInstanceId: card.instanceId })));
  }
  // An X cost — Hextech Anomaly's rainbow, Ancient Henge's Energy. Fanned out
  // one variant per affordable amount, the same shape Bullet Time's X takes on
  // the play path, and CROSSED with the axes above so an ability with both
  // still enumerates every combination.
  //
  // X = 0 is deliberately NOT offered: the ability would exhaust its source to
  // do nothing, which is never a move worth putting in front of a player, and
  // both cards' resolvers no-op on it anyway.
  //
  // The two pools are counted separately because the two costs are: Hextech
  // Anomaly is paid with runes of ANY domain (rainbow), Ancient Henge with
  // Energy from the floating pool plus what ready runes can supply.
  if (cost.xRainbowPower) {
    const affordable = state.players[playerIndex].channeled.length;
    choices = choices.flatMap((c) => Array.from({ length: affordable }, (_, i) => ({ ...c, xAmount: i + 1 })));
  }
  if (cost.xEnergy) {
    const affordable = state.players[playerIndex].floatingEnergy;
    choices = choices.flatMap((c) => Array.from({ length: affordable }, (_, i) => ({ ...c, xAmount: i + 1 })));
  }
  return choices;
}

/**
 * Rule 811's targeting restriction, as a predicate: when a card is played FROM a
 * facedown state, every target must be chosen "from among options at that
 * Battlefield". Always true for an ordinary play.
 *
 * Applied during ENUMERATION rather than only in validation, because 811 says a
 * card "cannot be played from Hidden if it is a spell with no valid targets
 * under these restrictions" — a card with no legal target there must not be
 * offered at all, which a validation-only check could not express.
 *
 * The restriction is per target, so this filters each candidate list rather than
 * the finished combination.
 */
function atHiddenBattlefield(state: GameState, unitInstanceId: string, fromHiddenBattlefieldId: string | undefined): boolean {
  if (fromHiddenBattlefieldId === undefined) return true;
  const bf = state.battlefields.find((b) => b.id === fromHiddenBattlefieldId);
  return Object.values(bf?.units ?? {}).some((list) => list.some((u) => u.instanceId === unitInstanceId));
}

/**
 * Every legal Hide — rule 811's Discretionary Action.
 *
 * One per (hidden card in hand or Champion Zone) x (battlefield you control with
 * no facedown card there). Only in a Neutral Open state on your own turn, since
 * hiding needs Priority and is not a play; the card's own `[Action]`/`[Reaction]`
 * keyword is irrelevant to hiding and is deliberately not consulted.
 */
function hideCardCandidates(state: GameState, actor: PlayerState, playerIndex: 0 | 1): HideCardAction[] {
  if (state.activePlayerIndex !== playerIndex || !state.chainOpen || state.turnState !== "Neutral") return [];

  const registry = defaultCardRegistry();
  const hideable = [...actor.hand, ...(actor.championZone ? [actor.championZone as CardInstance] : [])].filter((c) =>
    isHiddenCard(registry.tryGet(c.defId)),
  );
  if (hideable.length === 0) return [];

  // A flat 1 Power in ANY domain — RAINBOW is null, which computeAutoPayment
  // already understands as "any rune matches".
  // Priced through the shared helper so Guerilla Warfare's free-hide turn is
  // seen here as well as by the validator.
  const payment = computeAutoPayment(actor.channeled, 0, hideCostFor(state, playerIndex), RAINBOW);
  // Teemo - Swift Scout's alternative: the same-sized price in Energy instead of
  // rainbow Power. A second candidate rather than a replacement — the rainbow
  // route stays available, and which one a player wants depends on what else the
  // turn has to pay for.
  const energyPayment = mayHideWithEnergy(state, playerIndex)
    ? computeAutoPayment(actor.channeled, hideCostFor(state, playerIndex), 0, null)
    : undefined;
  // Either route will do — a Teemo player who cannot afford the rainbow can still
  // hide off Energy, which is most of what the alternative is for.
  const payments = [payment, energyPayment].filter((p): p is RunePayment => p !== undefined);
  if (payments.length === 0) return [];

  // 811's one-facedown-per-battlefield limit, raised by Bandle Tree's "you may
  // hide an ADDITIONAL card here". The same function `validate-hide-card` asks.
  const destinations = state.battlefields.filter(
    (bf) => bf.controllerId === actor.id && bf.hiddenCards.length < hiddenCardLimitAt(state, bf.id),
  );
  return hideable.flatMap((card) =>
    destinations.flatMap((bf) =>
      payments.map((p): HideCardAction => ({ type: "HideCard", playerIndex, card, battlefieldId: bf.id, payment: p })),
    ),
  );
}

/**
 * Enumerates every currently-legal PlayerAction for the active player (or,
 * during an open Showdown, for whoever holds Focus — not necessarily the
 * same player). Unlike the Java oracle (which has no single generic
 * enumerator — HeuristicAI builds its own ad hoc candidate list per action
 * type, engine/HeuristicAI.java:367-425), this is a real shared contract:
 * both the AI and the UI's "what can I click" logic consume the same
 * function, so they can't drift on what's legal.
 *
 * Scoped to what's implemented: PlayCard for Units/Spells/Gear from hand or
 * the Champion Zone (Unit only), with an auto-computed rune payment covering
 * both Energy and domain-restricted Power costs (no Legend play, no
 * Accelerate/additional costs, no EquipGear), MoveUnit for every ready unit
 * to every battlefield it can legally reach, RecallUnit for every ready
 * unit at a battlefield, and Pass. `computeAutoPayment` picks a single
 * minimal valid payment rather than exploring every possible rune
 * selection — which specific rune covers a domain-agnostic Energy cost
 * never changes the outcome, and for Power there's exactly one eligible
 * domain-matching pool to draw from anyway. Which cards are candidates in which
 * state is decided per card by `timing.mayPlayCardNow`, reading the printed
 * [Action]/[Reaction] keywords — the same predicate validate-play-card uses.
 * A Spell whose registered effect (card-effects.ts)
 * requires a target fans out into one PlayCardAction per legal target —
 * every unit at any battlefield, either owner, per this slice's
 * un-restricted targeting rule. A Unit ALSO fans out into one additional
 * PlayCardAction per battlefield the actor already has a unit at
 * (direct-to-battlefield "reinforce" — see validate-play-card.ts's
 * presence rule), alongside its unconditional base-play candidate, never
 * replacing it — mirroring the MoveUnit double-loop below it in this same
 * function.
 *
 * Enumerated FOR whoever may act right now — `timing.actingPlayerIndex`: the
 * chain-priority holder while a chain is closed (313), the Focus holder during a
 * Showdown (348), the Turn Player otherwise. That is how "[Action] on any
 * player's turn" (806) needs no special case here: during a Showdown the acting
 * player alternates between both players as Focus passes.
 *
 * Outside a Neutral Open state, MoveUnit/RecallUnit/Pass drop out (their
 * validators reject there, and Action/Reaction are card-play permissions that
 * grant nothing for moving), leaving PassFocus, FloatRune, ActivateAbility, and
 * whichever cards their timing permits. FloatRune is deliberately offered in
 * every state — the real rule lets a player float essentially any time during
 * the Action phase, see validate-float-rune.ts. One scope cut remains: this only
 * ever enumerates for the CURRENT acting player, not "either player regardless
 * of priority."
 */
export function legalActions(state: GameState): PlayerAction[] {
  // A pending question is the only thing on offer, for exactly one player.
  //
  // Checked BEFORE the phase guard, and that ordering is load-bearing: a
  // [Deathknell] discard can be parked during the Beginning Phase (a Temporary
  // unit dies, Undercover Agent's trigger fires, the discard stops to ask). With
  // the phase check first this would return nothing at all and the game would
  // hang with a question nobody could answer.
  const pending = pendingDecision(state);
  if (pending) {
    return optionsFor(state, pending).map((option) => ({
      type: "AnswerDecision",
      playerIndex: pending.playerIndex,
      decisionId: pending.id,
      optionId: option.id,
    }));
  }

  // A closed chain outranks the phase, for the same reason a pending decision does:
  // something is mid-resolution and the game is waiting on a specific player.
  //
  // The phase guard below is about DISCRETIONARY actions — "a Game Action that may
  // be performed at any time during a player's turn during a Neutral Open State"
  // (307, States of the Turn). Passing on a chain item is not discretionary; it is
  // the only way the resolution advances, which is why it belongs above the guard.
  //
  // Reachable because 383 puts triggered abilities on the Chain "during Closed
  // States or Open States on any player's turn": once triggers are held as Pending
  // Items and finalized onto the chain, the chain can be closed during the Beginning
  // Phase. With the phase check first, that state returns NO legal actions for
  // either player and the game hangs outright — the same shape as the
  // pending-decision hang the comment above describes.
  //
  // Only OUTSIDE the Action phase. Inside it the normal enumeration below already
  // handles a closed chain correctly and offers [Reaction] casting alongside the
  // pass — short-circuiting here would silently delete the response window this
  // whole mechanism exists to create.
  if (state.phase !== "Action" && !state.chainOpen) {
    return [{ type: "PassFocus", playerIndex: actingPlayerIndex(state) } satisfies PassFocusAction];
  }

  if (state.phase !== "Action") return [];

  // ONE enumeration path for every state, rather than the three it used to be
  // (a Showdown branch, a closed-chain branch, and the real one). The old shape
  // hard-coded "only PassFocus/FloatRune/ActivateAbility exist outside a Neutral
  // Open state", which is exactly the assumption [Action]/[Reaction] break — and
  // it tested `turnState === "Showdown"` BEFORE `!chainOpen`, so a spell cast
  // into a Showdown would have enumerated for the Focus holder when the rules
  // give priority to the chain (313). `actingPlayerIndex` has that precedence in
  // one place now.
  const playerIndex = actingPlayerIndex(state);
  const actor = state.players[playerIndex];
  const actions: PlayerAction[] = [];

  // "Neutral Open" in rule 310's sense: no Showdown or Combat in progress AND no
  // chain. It's what separates the actions that end a turn or reposition units
  // from the ones a Showdown window allows.
  const isNeutralOpen = state.chainOpen && state.turnState === "Neutral";

  if (isNeutralOpen) {
    const pass: PassAction = { type: "Pass", playerIndex };
    actions.push(pass);
  } else {
    // Passing Focus is the "I decline to respond" move that advances a Showdown
    // (349) or a chain (340).
    const passFocus: PassFocusAction = { type: "PassFocus", playerIndex };
    actions.push(passFocus);
  }
  actions.push(...floatRuneCandidates(actor, playerIndex));
  actions.push(...activateAbilityCandidates(state, actor, playerIndex));

  actions.push(...hideCardCandidates(state, actor, playerIndex));

  /**
   * Everything playable, and where from. A facedown card is a real source: rule
   * 811 lets it be played for 0 at Reaction speed from the turn after it was
   * hidden, with its targets restricted to that battlefield.
   */
  // `fromHand` is carried rather than re-derived by searching the hand for the
  // instance: this list already KNOWS which zone each card came from, and a
  // champion that also has copies in hand would make an identity search answer
  // for the wrong object. Void Drone and Drag Under read it — see
  // `PLAY_FROM_ELSEWHERE_DISCOUNT_DEF_IDS`.
  //
  // `printedPriceAvailable` is the second thing a source carries, and it is
  // false for exactly one shape: a card reachable in the trash ONLY by its own
  // "play me from your trash for [Cost]" permission (356.1.a). Last Rites grants
  // a FULL-COST play, so its units keep the printed price; UNL-025 Undying
  // Legion's permission grants a price along with the zone, and offering it at
  // the print as well would sell a 3-Energy-plus-[Fury] card for 3 Energy —
  // cheaper than casting it from hand, which is the opposite of what it prints.
  const playableSources: {
    card: CardInstance;
    fromHiddenBattlefieldId?: string;
    fromHand: boolean;
    printedPriceAvailable: boolean;
  }[] = [
    ...actor.hand.map((card) => ({ card, fromHand: true, printedPriceAvailable: true })),
    ...(actor.championZone
      ? [{ card: actor.championZone as CardInstance, fromHand: false, printedPriceAvailable: true }]
      : []),
    // Last Rites' trash units. The FIRST full-cost play from a non-hand zone in
    // this engine, and the reason `fromHand: false` above stopped being reachable
    // only through the Champion Zone: Void Drone's and Drag Under's "[2] less to
    // play from anywhere other than your hand" and Rek'Sai - Breacher's
    // [Accelerate] grant are all written against this flag and now have a second
    // zone to pay out from.
    //
    // Gated on the shared predicate rather than on the counter alone, so a trash
    // Spell is never offered — the card says "a unit".
    ...actor.trash
      .filter((card) => mayPlayFromTrash(state, playerIndex, card))
      .map((card) => ({
        card,
        fromHand: false,
        printedPriceAvailable: mayPlayFromTrashAtPrintedPrice(state, playerIndex, card),
      })),
    ...state.battlefields.flatMap((bf) =>
      bf.hiddenCards
        // The battlefield is passed so Noxus Saboteur's "can't be revealed HERE"
        // is asked at enumeration too — the validator asks the same question of
        // the same function, so a blocked card is never offered and then refused.
        .filter((h) => h.ownerIndex === playerIndex && hiddenCardIsPlayable(state, h, bf.id))
        .map((h) => ({
          card: h.card,
          fromHiddenBattlefieldId: bf.id,
          fromHand: false,
          printedPriceAvailable: true,
        })),
    ),
  ];

  for (const { card, fromHiddenBattlefieldId, fromHand, printedPriceAvailable } of playableSources) {
    if (card.kind === "Legend") continue;
    const fromHidden = fromHiddenBattlefieldId !== undefined;
    // The per-card timing gate, and the whole reason this loop now runs in every
    // state: a Default-tier card is only offered in a Neutral Open state, an
    // [Action] card additionally during Showdowns, a [Reaction] card also onto a
    // closed chain. Same predicate validate-play-card uses, so enumeration and
    // validation can't disagree about what's castable.
    // **`[Ambush]` is why this is not simply `continue`.** 822.1.b gives the card
    // Reaction timing only WHILE being played to a battlefield where its
    // controller has units, so the tier is a property of the (card, destination)
    // pair rather than of the card. Dropping the card here — before any
    // destination is known — is what made all 12 Ambush units unplayable in a
    // Showdown, which is the only state their keyword is for.
    //
    // So the card survives this gate if ANY battlefield would grant it, and each
    // destination is then gated individually below. Base plays are unaffected:
    // 822.1.b says "to a battlefield", so a base play still needs the ordinary
    // tier and is checked with no destination.
    if (!mayPlayCardNow(state, playerIndex, card, fromHidden) && !ambushHasAnyDestination(state, playerIndex, card)) {
      continue;
    }
    const timedForBase = mayPlayCardNow(state, playerIndex, card, fromHidden);

    // A discard choice is fanned out per card in hand, exactly like Vision's
    // two-way choice: the engine cannot pause mid-resolution to ask, so which
    // card is discarded has to be decided in the submitted action. The card
    // being played is excluded — by the time it resolves it has already left
    // hand. Bounded by hand size, so the fan-out stays small.
    const discardChoice = discardChoiceOf(card.defId);
    const discardable = discardChoice ? actor.hand.filter((c) => c.instanceId !== card.instanceId) : [];
    if (discardChoice && !discardChoice.optional && discardable.length === 0) continue; // mandatory and unpayable

    // 811: "ignoring its base cost" — not reduced, ignored.
    // A discard that BUYS a discount changes what the payment must cover, so the
    // discounted cost is computed separately — but through computeEffectiveCost,
    // exactly like the plain one. Subtracting the discount from the raw cost and
    // stopping there skipped the floating-Energy reduction the plain path
    // applies, so enumeration offered a 4-rune payment for a card validation
    // priced at 3. Caught by a self-play probe, not by the suite, because no
    // test had floating Energy banked at the time.
    const effectiveCost = fromHidden
      ? { energyCost: 0, powerCost: 0 }
      : computeEffectiveCost(
        actor.floatingEnergy,
        actor.floatingPower,
        modifiedEnergyCost(state, playerIndex, card.kind, card.energyCost, card.defId, fromHand),
        Math.max(
          0,
          card.powerCost -
            scaledPowerDiscount(state, playerIndex, card.defId) -
            // Vex - Cheerless's friendly half. Her ENEMY half is a rainbow
            // surcharge and rides `surcharge` below, not this term.
            combatSpellPowerDiscount(state, playerIndex, card.kind),
        ),
        card.powerDomain,
        card.powerDomainAlt,
        card.kind === "Spell" ? actor.restrictedSpellEnergy : 0,
        restrictedPowerFor(actor, card.kind),
        // Malzahar's rainbow, unlike Kai'Sa's, has no Spells-only clause — so no
        // kind check, and a Unit may be bought with it.
        actor.floatingRainbowPower,
      );
    // Null when the card has no printed-price play to offer at all — a trash
    // card reachable only by its own "for [Cost]" permission. Nulled HERE rather
    // than at each emission site because every printed-price branch below
    // (plain, discarded, accelerated, repeated) already skips on a null payment,
    // so one binding closes all of them; a per-site check is how the enumerator
    // and the validator start disagreeing.
    const payment = printedPriceAvailable
      ? computeAutoPayment(
          actor.channeled,
          effectiveCost.energyCost,
          effectiveCost.powerCost,
          card.powerDomain,
          card.powerDomainAlt,
        )
      : null;
    /**
     * The axes worth pricing an OPTIONAL-ADDITIONAL-COST variant at.
     *
     * `undefined` is the undiscounted play and is always present; the two named
     * axes appear only while Ezreal - Prodigy is on the board, so an ordinary game
     * enumerates exactly what it always did. His "[1] or [rainbow]" is a real
     * choice between two resources — see `optionalCostDiscount` — so each branch
     * below that can pay an additional cost fans out over this, exactly as
     * Irelia - Graceful's own loop does for the card's PRINTED cost.
     *
     * The undiscounted variant stays on offer even though his discount is not
     * optional. It is strictly worse and no player will take it, and removing it
     * would mean the enumerator disagreeing with a validator that still accepts
     * it — the split this file has shipped three times.
     */
    const additionalCostAxes: (undefined | "energy" | "power")[] = optionalCostDiscountApplies(state, playerIndex)
      ? [undefined, "energy", "power"]
      : [undefined];
    // The DISCOUNTED payment is computed alongside the plain one, not inside the
    // variant loop below, because a card can be affordable only WITH the
    // discount — Brazen Buccaneer at 6 Energy with 4 runes is exactly that. An
    // earlier version bailed out here on the plain payment alone and so never
    // offered the discounted play at all, which is the whole point of the card.
    const discountedEffective =
      discardChoice?.energyDiscount !== undefined && !fromHidden && printedPriceAvailable
        ? computeEffectiveCost(
            actor.floatingEnergy,
            actor.floatingPower,
            Math.max(0, modifiedEnergyCost(state, playerIndex, card.kind, card.energyCost, card.defId) - discardChoice.energyDiscount),
            card.powerCost,
            card.powerDomain,
            card.powerDomainAlt,
            card.kind === "Spell" ? actor.restrictedSpellEnergy : 0,
            restrictedPowerFor(actor, card.kind),
            actor.floatingRainbowPower,
          )
        : undefined;
    const discountedPayment = discountedEffective
      ? computeAutoPayment(
          actor.channeled,
          discountedEffective.energyCost,
          discountedEffective.powerCost,
          card.powerDomain,
          card.powerDomainAlt,
        )
      : payment;
    // Call to Glory — "you may spend a buff ... if you do, ignore this spell's
    // cost." Its printed cost is IGNORED rather than reduced when the additional
    // cost is paid, so affordability is a per-VARIANT question: the card is
    // castable with no runes at all if a buffed friendly unit is there to spend.
    // Bailing here on the printed cost would have made that variant unreachable
    // exactly when it matters most — the same mistake the discount path already
    // records having made with Brazen Buccaneer.
    const canIgnoreCost = printedPriceAvailable && optionalUnitCostOf(card.defId)?.ignoresCostWhenPaid === true;
    // A REPEATABLE cost can make an otherwise-unaffordable card castable —
    // Commander Ledros prints 4 Power and can be played for none of it by killing
    // four units. Bailing on the printed price here would have made exactly the
    // variants the card exists for unreachable, which is the mistake this line
    // already records making twice (Brazen Buccaneer's discount, Call to Glory's
    // ignore).
    const canDiscountByRepeating = printedPriceAvailable && optionalUnitCostOf(card.defId)?.repeatable === true;
    /**
     * Poppy - Defender of the Meek's "spend 3 XP ... I cost [3] less".
     *
     * **Priced out here, above the affordability bail, for the reason this file
     * has now recorded getting wrong three times** — Brazen Buccaneer's discard,
     * Call to Glory's ignore, and the replaced costs. She prints 6 Energy and
     * costs 3 with the XP paid, so a caster holding 4 runes can afford ONLY the
     * paid variant; bailing on her printed price first makes exactly the variant
     * the card exists for unreachable.
     *
     * Gated on affording the XP itself, like the emission branch further down:
     * a caster short of XP has no paid variant at all rather than one the
     * validator would refuse.
     */
    const xpEnergyDiscount = optionalXpEnergyDiscountOf(card.defId);
    // The `actor.xp` term here is MEASURED-REDUNDANT with `canPayOptionalXp`
    // below, which gates the emission: for a discount card an unaffordable XP
    // already leaves `xpDiscountedPayment` null, so deleting either check alone
    // changes no behaviour. Kept because this binding's job is "should I price
    // this variant at all", and pricing a payment the caster can never claim is
    // work with no consumer. Labelled rather than deleted so the next reader is
    // not left wondering which of the two is load-bearing — both are, for
    // different cards.
    const xpDiscountApplies =
      xpEnergyDiscount > 0 &&
      !fromHidden &&
      printedPriceAvailable &&
      actor.xp >= (optionalXpCostOf(card.defId) ?? 0);
    const xpDiscountedEffective = xpDiscountApplies
      ? computeEffectiveCost(
          actor.floatingEnergy,
          actor.floatingPower,
          Math.max(0, modifiedEnergyCost(state, playerIndex, card.kind, card.energyCost, card.defId, fromHand) - xpEnergyDiscount),
          Math.max(
            0,
            card.powerCost -
              scaledPowerDiscount(state, playerIndex, card.defId) -
              combatSpellPowerDiscount(state, playerIndex, card.kind),
          ),
          card.powerDomain,
          card.powerDomainAlt,
          card.kind === "Spell" ? actor.restrictedSpellEnergy : 0,
          restrictedPowerFor(actor, card.kind),
          actor.floatingRainbowPower,
        )
      : null;
    const xpDiscountedPayment = xpDiscountedEffective
      ? computeAutoPayment(
          actor.channeled,
          xpDiscountedEffective.energyCost,
          xpDiscountedEffective.powerCost,
          card.powerDomain,
          card.powerDomainAlt,
        )
      : null;
    /**
     * "You may play me for [Cost]" (356.1.a) — priced ALONGSIDE the printed cost
     * rather than instead of it, because the card says "may".
     *
     * Both variants stay on offer wherever both are legal. UNL-089 Jhin -
     * Meticulous Killer is cheaper in Energy and dearer in Power than his print,
     * so neither dominates and a player with the wrong runes channeled can
     * afford exactly one of the two. Offering only the replacement would remove
     * plays the rules give; offering only the print would make the permission
     * unreachable.
     *
     * **Above the affordability bail rather than beside `accelerated`**, and for
     * the reason the discount path and Call to Glory's ignore each already
     * record having got wrong: a card can be affordable ONLY in its variant, and
     * bailing on the printed price first is what makes exactly the variant the
     * card exists for unreachable. Undying Legion in the trash is the sharpest
     * case — its printed price is not merely unaffordable there, it is not a
     * legal play at all.
     */
    const replacedCost = fromHidden ? null : replacedCostFor(state, playerIndex, card);
    const replacedEffective = replacedCost
      ? computeEffectiveCost(
          actor.floatingEnergy,
          actor.floatingPower,
          modifiedEnergyCost(state, playerIndex, card.kind, replacedCost.energyCost, card.defId, fromHand),
          Math.max(
            0,
            replacedCost.powerCost -
              scaledPowerDiscount(state, playerIndex, card.defId) -
              combatSpellPowerDiscount(state, playerIndex, card.kind),
          ),
          replacedCost.powerDomain,
          // No alt domain: the replacement names its own pip, and the card's
          // hybrid second domain does not survive it — see the executor's and
          // the validator's matching bindings.
          undefined,
          card.kind === "Spell" ? actor.restrictedSpellEnergy : 0,
          restrictedPowerFor(actor, card.kind),
          actor.floatingRainbowPower,
        )
      : null;
    const replacedPayment =
      replacedCost && replacedEffective
        ? computeAutoPayment(
            actor.channeled,
            replacedEffective.energyCost,
            replacedEffective.powerCost,
            replacedCost.powerDomain,
            undefined,
          )
        : null;
    if (!printedPriceAvailable && !replacedPayment) continue; // the only price it has, and it can't be paid
    if (
      printedPriceAvailable &&
      !payment &&
      !discountedPayment &&
      !canIgnoreCost &&
      !canDiscountByRepeating &&
      !replacedPayment &&
      !xpDiscountedPayment
    ) {
      continue; // can't afford it any way
    }

    // [Accelerate] (805) is an OPTIONAL additional cost, so it is a second
    // candidate rather than a replacement — declining must stay available even
    // when you could afford it. Only offered when the bigger payment is actually
    // payable; a card you can afford plainly but not accelerated simply has no
    // accelerated variant.
    /**
     * **Re-derived through `computeEffectiveCost`, not added to the reduced cost.**
     *
     * This read `effectiveCost.powerCost + ACCELERATE_POWER`, and `effectiveCost`
     * has ALREADY had floating Power taken off it — so the accelerate pip was
     * added after the reduction and could never be absorbed by it. The validator
     * re-derives from the printed cost with the additional term folded in, and
     * lets floating rainbow Power cover it.
     *
     * With one floating rainbow banked, a 0-Power `[Accelerate]` unit therefore
     * enumerated a 1-Power payment the validator priced at 0, and
     * `executePlayCard` THREW — "Lillia - Fae Fawn costs 0 power after floating
     * Power, payment supplied 1". Found by `hunt-xp`, not by the suite, because it
     * needs floating rainbow Power banked at the moment an Accelerate card is
     * played, and wave 4 added the first cards that bank it routinely.
     *
     * The comment ~500 lines down already records this exact shape ("[Accelerate]
     * is priced once per card, which is wrong the moment anything else about the
     * variant changes the price"). This is the same mistake at the other end: not
     * a stale price, but a price built by arithmetic on an already-reduced number.
     */
    const acceleratedEffective =
      hasAccelerate(card, state, playerIndex, fromHand) && !fromHidden && printedPriceAvailable
        ? computeEffectiveCost(
            actor.floatingEnergy,
            actor.floatingPower,
            modifiedEnergyCost(state, playerIndex, card.kind, card.energyCost, card.defId, fromHand) + ACCELERATE_ENERGY,
            Math.max(
              0,
              card.powerCost -
                scaledPowerDiscount(state, playerIndex, card.defId) -
                combatSpellPowerDiscount(state, playerIndex, card.kind),
            ) + ACCELERATE_POWER,
            acceleratePowerDomain(card),
            card.powerDomainAlt,
            card.kind === "Spell" ? actor.restrictedSpellEnergy : 0,
            restrictedPowerFor(actor, card.kind),
            actor.floatingRainbowPower,
          )
        : null;
    const accelerated = acceleratedEffective
      ? computeAutoPayment(
          actor.channeled,
          acceleratedEffective.energyCost,
          acceleratedEffective.powerCost,
          acceleratePowerDomain(card),
          card.powerDomainAlt,
        )
      : null;

    // A MODAL card has no single targeting — each mode carries its own, and
    // Rocket Barrage's two name a UNIT and a GEAR respectively. So the fan-out
    // runs once per mode and tags each variant with the mode it came from.
    //
    // A plain card has exactly ONE (unnamed) mode, so `modeId` never appears on
    // its actions and its enumeration is byte-for-byte what it always was —
    // which is the whole reason `cardModesOf` normalises rather than branching.
    const cardModes = card.kind === "Unit" ? [] : cardModesOf(card);
    const isModal = cardModes.length > 1;
    // The spec used by everything AFTER the fan-out (the destination filter, the
    // Vision copy). Naming no mode is deliberate: `cardModeOf` returns the sole
    // mode of a plain card and NOTHING for a modal one, so a modal card reads
    // `"none"` here. Safe today because no modal card moves its target or carries
    // [Vision]; a future one would have to read the per-variant `modeId`.
    const targeting = targetingForAnyCard(card);

    // Base "effect choice" fan-out: one partial-action-fields variant per
    // legal target (or a single empty variant for "none"/unregistered).
    const variantsForTargeting = (targeting: TargetingSpec): Partial<PlayCardAction>[] => {
    const effectVariants: Partial<PlayCardAction>[] = [];
    if (targeting.kind === "unit") {
      // eligibleTargets applies the owner constraint AND the spec's scope —
      // "a unit" (Final Spark) includes both bases, "a unit at a battlefield"
      // (Incinerate) does not. Enumerating it here by hand is what let the
      // two gates drift apart in the first place.
      for (const target of eligibleTargets(state, playerIndex, targeting.owner, targeting.scope, targeting.domain)) {
        if (!unitWithinMaxMight(state, target, targeting.maxMight)) continue;
        if (!unitSatisfiesEmpoweredOnly(state, target, targeting.empoweredOnly)) continue;
        if (!unitSatisfiesNarrowing(state, target, ownerIndexOf(state, target), targeting.narrowing)) continue;
        if (!unitSatisfiesAttackingOnly(state, target, targeting.attackingOnly)) continue;
        if (!atHiddenBattlefield(state, target.instanceId, fromHiddenBattlefieldId)) continue;
        effectVariants.push({ targetUnitInstanceId: target.instanceId });
      }
    } else if (targeting.kind === "battlefield") {
      for (const bf of state.battlefields) {
        if (fromHidden && bf.id !== fromHiddenBattlefieldId) continue;
        effectVariants.push({ targetBattlefieldId: bf.id });
      }
    } else if (targeting.kind === "unitOrGear") {
      // One candidate per unit at a battlefield AND per gear in play — a single
      // choice across two kinds of permanent.
      //
      // **The spec's narrowings are passed through as of 2026-08-17**, for Decree
      // of Unity's "an ENEMY CHAOS unit or gear". This call took no options at
      // all before, which was correct while every `unitOrGear` spec reached from
      // here carried none; the validator's matching call is widened in the same
      // change, because a filter applied at one of the two is exactly how this
      // codebase's most-repeated bug happens.
      for (const t of unitOrGearTargets(state, {
        playerIndex,
        ...(targeting.owner !== undefined ? { owner: targeting.owner } : {}),
        ...(targeting.domain !== undefined ? { domain: targeting.domain } : {}),
        ...(targeting.includesFacedown !== undefined ? { includesFacedown: targeting.includesFacedown } : {}),
      })) {
        if (!atHiddenBattlefield(state, t.instanceId, fromHiddenBattlefieldId)) continue;
        effectVariants.push({ targetPermanentInstanceId: t.instanceId });
      }
    } else if (targeting.kind === "unitAndEquipment") {
      // Angle Shot: unit x Equipment, the same second-axis shape an ABILITY's
      // `attachesEquipment` fans out over, and asked through the same shared
      // walk (`equipmentPairedWith`) the validator checks against so the two
      // cannot disagree about which pairs are legal.
      //
      // Angle Shot names no owner, so every unit on the board is a candidate —
      // "the same controller" relates the two TARGETS to each other, not to the
      // caster. Relentless Pursuit says "a FRIENDLY unit" before it mentions an
      // Equipment, and that constraint rides `owner`.
      for (const target of eligibleTargets(state, playerIndex, targeting.owner, "anywhere")) {
        if (!atHiddenBattlefield(state, target.instanceId, fromHiddenBattlefieldId)) continue;
        // The DECLINE variant, for a card whose Equipment half is a "you may".
        // Pushed whether or not a legal Equipment exists, because "may" has to
        // stay refusable — the rule the optional additional costs keep.
        if (targeting.optionalEquipment) effectVariants.push({ targetUnitInstanceId: target.instanceId });
        for (const gear of equipmentPairedWith(state, target.instanceId, targeting.relation)) {
          effectVariants.push({
            targetUnitInstanceId: target.instanceId,
            targetPermanentInstanceId: gear.instanceId,
          });
        }
      }
    } else if (targeting.kind === "gear") {
      // `owner` is Akshan - Mischievous' "an ENEMY gear"; absent leaves the walk
      // unfiltered, which is Rocket Barrage's and Detonate's "a gear".
      for (const g of gearTargets(state)) {
        if (!gearOwnerMatches(targeting.owner, g.ownerIndex, playerIndex)) continue;
        effectVariants.push({ targetPermanentInstanceId: g.instanceId });
      }
    } else if (targeting.kind === "ownTrashCard") {
      // Through the shared predicate rather than a local filter: the spec now
      // carries cost ceilings as well as a kind, and a ceiling applied here but
      // not in the validator is the offered-then-refused split.
      for (const trashCard of ownTrashCandidates(state, playerIndex, targeting)) {
        effectVariants.push({ trashCardInstanceId: trashCard.instanceId });
      }
    } else if (targeting.kind === "chainSpell") {
      // One candidate per counterable spell waiting on the chain. The counter
      // itself is not among them: enumeration happens before it is pushed, so
      // "a spell cannot target itself" holds by construction rather than by a
      // check — see the spec's own note.
      for (const { entry } of counterableSpells(state, targeting.maxPrintedEnergy, targeting.maxPrintedPower, counterFilter(targeting, playerIndex))) {
        effectVariants.push({ targetChainCardInstanceId: entry.card.instanceId });
      }
    } else if (targeting.kind === "chainSpellAndUnit") {
      // The CROSS PRODUCT of the two choices (Riposte). Both are announced, so
      // every legal pairing is a distinct play — and with either side empty this
      // emits nothing, which is how 355.8 makes the card uncastable rather than
      // castable-and-half-inert.
      //
      // Through the same two helpers the `chainSpell` and `unit` branches use, so
      // the enumerator cannot offer a pair the validator then refuses — the drift
      // this file's own notes keep warning about.
      // `counterFilter` is passed now, so Repulse's "an ENEMY spell" narrows the
      // spell half exactly as it does for the `chainSpell` kind. Riposte names no
      // filter fields and gets `undefined`, i.e. the walk it always had.
      for (const { entry } of counterableSpells(
        state,
        targeting.maxPrintedEnergy,
        targeting.maxPrintedPower,
        counterFilter(targeting, playerIndex),
      )) {
        for (const target of eligibleTargets(state, playerIndex, targeting.owner, targeting.scope)) {
          if (!atHiddenBattlefield(state, target.instanceId, fromHiddenBattlefieldId)) continue;
          // The PAIR restriction — Repulse's "chooses it and no other friendly
          // unit". Applied here because this cross product is the first place both
          // choices exist at once, and re-derived from the same function in
          // `validate-play-card` so the two cannot disagree.
          if (
            targeting.choosesOnlyThisUnit &&
            !choosesOnlyThisFriendlyUnit(state, entry, target.instanceId, playerIndex)
          ) {
            continue;
          }
          effectVariants.push({
            targetChainCardInstanceId: entry.card.instanceId,
            targetUnitInstanceId: target.instanceId,
          });
        }
      }
    } else if (targeting.kind === "unitList") {
      // A BOUNDED sample, not the powerset — see `unitListCandidates`, which is
      // also what `validate-play-card` measures a submitted set against, so the
      // AI can never be handed a set the validator refuses.
      //
      // Rule 811's per-target restriction filters the sets rather than the pool,
      // so a from-hidden play cannot smuggle in a target elsewhere on the board.
      for (const ids of unitListCandidates(state, playerIndex, targeting)) {
        if (!ids.every((id) => atHiddenBattlefield(state, id, fromHiddenBattlefieldId))) continue;
        effectVariants.push({ targetUnitInstanceIds: ids });
      }
    } else if (targeting.kind === "unitSlots") {
      // Rule 811's restriction is PER TARGET, so it filters the candidate pool
      // both slots draw from rather than the pair as a whole.
      // Every legal FILLING of the two slots, down to `min`:
      //   - min 0 -> the empty choice is legal ("up to two")
      //   - one target -> fills slot 0, so it must satisfy slot 0's role
      //   - two -> slot-0 x slot-1, distinct units
      // The two targets need not share a location unless the spec says so —
      // `sameBattlefield` is Facebreaker's, and it is enforced HERE as well as
      // in the validator so the AI (which trusts this enumeration and calls the
      // executor directly) is never handed a pair the validator would refuse.
      //
      // Scope is asked PER SLOT: Zenith Blade's enemy target is "at a
      // battlefield" and its friendly one is not.
      const forSlot = (slot: 0 | 1) =>
        eligibleTargets(state, playerIndex, slotOwner(targeting.slots[slot]), slotScope(targeting, slot)).filter((u) =>
          atHiddenBattlefield(state, u.instanceId, fromHiddenBattlefieldId),
        );
      const firstSlot = forSlot(0);
      const secondSlot = forSlot(1);
      // When both slots take the same role the pair is USUALLY symmetric, so
      // (A,B) and (B,A) are the same choice — enumerating both would double the
      // AI's search space and offer the player a distinction that doesn't exist.
      //
      // Same ROLE is not the same as same TREATMENT, though, and reading it that
      // way was a real bug. Back to Back and Singularity do the same thing to
      // both units, so the pruning is right for them; Convergent Mutation's slots
      // are both "friendly" but slot 0 is the BENEFICIARY and slot 1 is only
      // measured ("increase its Might to the Might of another friendly unit"), so
      // dropping one ordering hid half the card — measured with a 7-Might and a
      // 2-Might unit, the single offered pairing was the one that increases by 0.
      // `asymmetricSlots` is how a spec says the roles coincide but the meanings
      // do not.
      const symmetric = targeting.slots[0] === targeting.slots[1] && targeting.asymmetricSlots !== true;

      if (targeting.min === 0) effectVariants.push({});
      if (targeting.min <= 1) {
        for (const only of firstSlot) effectVariants.push({ targetUnitInstanceId: only.instanceId });
      }
      for (const [i, first] of firstSlot.entries()) {
        for (const [j, second] of secondSlot.entries()) {
          if (first.instanceId === second.instanceId) continue;
          if (symmetric && j < i) continue; // keep one ordering of each pair
          if (targeting.sameBattlefield && !shareABattlefield(state, first.instanceId, second.instanceId)) continue;
          effectVariants.push({ targetUnitInstanceId: first.instanceId, secondTargetUnitInstanceId: second.instanceId });
        }
      }
    } else {
      effectVariants.push({});
    }
      return effectVariants;
    };

    /**
     * UNL-140 Conscription — "if you paid the additional cost, choose ANY enemy
     * unit at a battlefield instead".
     *
     * **The WIDE-ONLY targets are fanned as variants carrying `optionalXpPaid`
     * FROM BIRTH**, which is exactly what its three-wave refusal asked for: "the
     * targeting filter has to be asked per variant, not once per card". Fanning
     * them here rather than letting the generic XP dimension copy them later is
     * the whole point — that dimension runs BELOW the target fan-out, so a paid
     * variant built there would carry a target already capped at 3 Might and sell
     * the XP for nothing.
     *
     * **EVERY target is offered in both states, including the ones the XP does
     * not unlock.** Paying 5 XP and then choosing a 3-Might unit is legal in the
     * paper game — pointless, but legal — and the project owner's standing
     * ruling is that this engine is a digital version of that game. Offering
     * what the rules offer and letting the PLAYER decide what is sensible is the
     * job; withholding a legal play because no reasonable person would take it is
     * not.
     *
     * This is deliberately NOT the same as this file's "if uncertain, do not
     * offer" rule, which is about never enumerating a play that might be
     * ILLEGAL. That one stands — every offered-then-refused crash here argues
     * for it. The difference is uncertainty versus substituting our judgement
     * for the player's.
     */
    const xpWidened = xpWidenedTargetingFor(card.defId);
    const xpWidenedAffordable =
      xpWidened !== undefined && !fromHidden && actor.xp >= (optionalXpCostOf(card.defId) ?? 0);
    const narrowVariants = variantsForTargeting(targeting);
    const effectVariants: Partial<PlayCardAction>[] = isModal
      ? cardModes.flatMap((mode) =>
          variantsForTargeting(targetingForAnyCard(card, mode.id)).map((v) => ({ ...v, modeId: mode.id })),
        )
      : xpWidened !== undefined && xpWidenedAffordable
        ? [
            ...narrowVariants,
            // The paid state of EVERY target the widened spec allows — which
            // includes the ones the free play already reached.
            ...variantsForTargeting(xpWidened).map((v) => ({ ...v, optionalXpPaid: true as const })),
          ]
        : narrowVariants;

    // A UNIT's targeting comes from its on-play TRIGGER, and a trigger with
    // no legal choice simply does nothing — it never makes the unit itself
    // unplayable. Without this, Annie-Stubborn was uncastable with an empty
    // trash, First Mate uncastable as your first unit, and Maddened Marauder
    // uncastable with an empty board — in every case a body you paid for,
    // withheld because a bonus couldn't happen. Mirrors the Java oracle,
    // whose UnitAbilities call sites check `candidates.isEmpty()` before
    // opening a choice at all rather than gating the play (see
    // ui/BoardController.java:2143-2151's note on that convention).
    // Spells are deliberately NOT given this treatment: their targeting IS
    // the effect, so "no legal target" really does mean "can't cast."
    if (card.kind === "Unit" && effectVariants.length === 0) effectVariants.push({});

    // **"You MAY choose" — so DECLINING is one of the choices.** Tideturner
    // (OGN-199) is the only card in the pool this reaches, swept 2026-08-05.
    //
    // Separate from the rule above rather than folded into it, because the two
    // say different things: that one is "a trigger with nothing to choose does
    // nothing", this one is "a trigger whose text is optional may be declined
    // even when there IS something to choose". Folding them would make every
    // Unit's on-play trigger optional, which is wrong for the 47 that are not.
    //
    // 402.1 puts the decision at the Make Relevant Choices step — "if the first
    // part of a Triggered Ability's effect is 'you may', its controller decides
    // whether or not to perform the Triggered Ability NOW" — which is why it is
    // an enumerated variant rather than a branch inside the resolver.
    if (card.kind === "Unit" && !isModal && targeting.kind === "unit" && targeting.optionalChoice === true) {
      if (!effectVariants.some((v) => v.targetUnitInstanceId === undefined)) effectVariants.push({});
    }

    // [Vision] choice fan-out: every effect variant above also needs a
    // recycle-true and recycle-false copy, since the choice must already be
    // decided in the submitted action (this engine can't pause mid-resolution
    // to ask).
    // Asked of the BOARD, not just the card: Gemcraft Seer grants [Vision] to
    // other friendly units, so whether this play needs a recycle choice depends
    // on what is already in play. `validate-play-card` asks the same function.
    const hasVision = card.kind === "Unit" && unitTriggerHasVisionChoice(state, playerIndex, card.defId);
    const afterVision: Partial<PlayCardAction>[] = hasVision
      ? effectVariants.flatMap((v) => [
          { ...v, visionRecycle: true },
          { ...v, visionRecycle: false },
        ])
      : effectVariants;

    // Meditation's optional additional cost: a "decline" copy of every
    // variant above, plus one copy per ready friendly unit (base or
    // battlefield) the caster could exhaust instead — same "the choice must
    // already be decided" reasoning as Vision above.
    // NOT gated on `card.kind === "Spell"` any more: a Unit's on-play trigger can
    // carry an optional cost too (Wildclaw Shaman), and while this only looked at
    // Spells that card had to smuggle the choice onto its target field — which
    // silently lost the decline whenever every friendly unit was already buffed.
    const optionalCost = optionalUnitCostOf(card.defId);
    const variants: Partial<PlayCardAction>[] = optionalCost
      ? afterVision.flatMap((v) => {
          // A GEAR-valued cost fans out over `activeGear` and rides its own
          // field — Zaun Punk kills a friendly gear, Legion Quartermaster
          // returns one to hand. Handled first and returned early, because none
          // of the unit machinery below means anything for it: a gear is never
          // ready-or-not for this purpose, never buffed, and never repeatable.
          if (costNamesGear(optionalCost.kind)) {
            const paid = actor.activeGear.map((g) => ({ ...v, additionalCostPermanentInstanceId: g.instanceId }));
            // Same decline rule as the unit costs below: a MANDATORY cost has
            // no decline, so Legion Quartermaster with no gear of his own is
            // simply not offered rather than offered and refused.
            return optionalCost.mandatory ? paid : [v, ...paid];
          }
          const own = [...actor.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[actor.id] ?? [])];
          // A READY unit and a BUFFED unit are different sets; the registry says
          // which this card wants rather than this loop guessing.
          const byKind =
            optionalCost.kind === "exhaustReadyFriendly"
              ? own.filter((u) => !u.exhausted)
              : optionalCost.kind === "spendBuffFriendly"
                ? own.filter((u) => u.buffed)
                : own; // killFriendly — any unit you control can be the price
          // ...and then the card's own restriction on WHICH unit, when it names
          // a subset rather than "a friendly unit" — Sacrifice's "[Mighty]".
          // `validate-play-card` applies the identical predicate; a filter that
          // lived in only one of the two is this repo's enumerate/execute
          // mismatch, and every instance of it so far has been a crash.
          const eligible = optionalCost.candidate
            ? byKind.filter((u) => optionalCost.candidate!(state, u, playerIndex))
            : byKind;
          // A REPEATABLE cost (Kraken Hunter, Commander Ledros) is fanned out by
          // COUNT rather than by unit, and the count is capped by the printed
          // Power cost — "reduce my cost by [1 Power] for each" buys nothing once
          // the cost is zero. That is what keeps this to a handful of variants
          // instead of the powerset of the caster's own board.
          //
          // WHICH units are spent is chosen by a deterministic heuristic —
          // weakest first, since Ledros is choosing what to kill and Kraken
          // Hunter what to strip a buff from, and in both the cheapest bodies are
          // the ones a player almost always picks. `validate-play-card` accepts
          // ANY legal set, so a human clicking their own choice is not limited to
          // this sample; the same split `unitList` targeting makes.
          if (optionalCost.repeatable) {
            const byCheapest = [...eligible].sort(
              (a, b) => effectiveMight(state, a, playerIndex, { isCombat: false }) - effectiveMight(state, b, playerIndex, { isCombat: false }),
            );
            const maxSpend = Math.min(byCheapest.length, card.powerCost);
            const counts: Partial<PlayCardAction>[] = [];
            for (let n = 1; n <= maxSpend; n += 1) {
              counts.push({ ...v, additionalCostUnitInstanceIds: byCheapest.slice(0, n).map((u) => u.instanceId) });
            }
            return [v, ...counts];
          }
          const paid = eligible.map((u) => ({ ...v, additionalCostUnitInstanceId: u.instanceId }));
          // The decline variant leads, and is what makes "you may" mean may —
          // but ONLY for an optional cost. A mandatory one has no decline, so a
          // card whose cost cannot be paid is not offered at all.
          return optionalCost.mandatory ? paid : [v, ...paid];
        })
      : afterVision;

    // Bard - Mercurial's "you may exhaust your legend as an additional cost".
    //
    // Two variants per candidate rather than a fan-out, because a player has one
    // Legend and there is nothing to pick — `OPTIONAL_POWER_COSTS`' shape, and the
    // decline leads for the same reason it does above.
    //
    // Offered only while the Legend is READY, so a card whose cost cannot be paid
    // is never offered and then refused (416.3, and the same rule
    // `canPayActivationCost` applies to an ability's exhaust). The plain variant
    // survives either way — the cost is a "may".
    const variantsWithLegend: Partial<PlayCardAction>[] = costExhaustsLegend(card.defId)
      ? variants.flatMap((v) => (actor.legend.exhausted ? [v] : [v, { ...v, exhaustLegendPaid: true as const }]))
      : variants;

    // Charm needs a destination as well as a target, and unlike a token-placing
    // spell's it is mandatory: "Move an enemy unit" with nowhere to go is not a
    // move, so the card is simply not offered rather than offered and refused.
    // A destination the unit is ALREADY at is skipped for the same reason.
    //
    // That skip is asked OWNER-AGNOSTICALLY, through `findUnitOnBattlefield`.
    // It used to look the target up under `players[1 - playerIndex]` — the
    // opponent — which was written for Charm's "an enemy unit" and silently did
    // nothing for a FRIENDLY target. It never bit, because the only other card
    // in this set was Showstopper, whose target is base-scoped and so is never at
    // a battlefield to begin with. Ride The Wind's "a friendly unit" is the first
    // that reaches a battlefield, and under the old check its current battlefield
    // was offered back to it: a no-op move the player paid 2 Energy and a Power
    // for. The unit's OWNER is irrelevant to the question being asked, which is
    // "is it already standing here".
    const withDestinations: Partial<PlayCardAction>[] = cardMovesTarget(card.defId)
      ? variantsWithLegend.flatMap((v) => {
          const currentBattlefieldIndex =
            v.targetUnitInstanceId !== undefined ? findUnitOnBattlefield(state, v.targetUnitInstanceId)?.battlefieldIndex : undefined;
          const toBattlefields: Partial<PlayCardAction>[] = state.battlefields
            .filter((_bf, index) => index !== currentBattlefieldIndex)
            .map((bf) => ({ ...v, destinationBattlefieldId: bf.id }));
          // **BASE is a Location too** (198.1 / 107.1.b), and 355.4.a makes every
          // Location the unit may be present at a valid Move Destination — the
          // rules work this exact case at 359.3.e ("Base is a legal move
          // destination for Ride the Wind"). Only for the cards whose printed
          // text does not name a battlefield, which `cardMayMoveToBase` decides.
          //
          // Offered only when the unit is AT a battlefield: 355.4.a excludes the
          // Unit's current Location, and a unit already in base has no move to
          // make. `currentBattlefieldIndex` is undefined exactly then.
          //
          // **Deliberately NOT gated on Vilemaw's Lair**, and that is 359.3.e
          // rather than an oversight: its worked example is a Ride the Wind at
          // the Lair, where the destination is legal and the CHOICE is offered,
          // and it is the move INSTRUCTION that is ignored on resolution. Gating
          // the enumerator would make the engine refuse a choice the rules
          // explicitly allow.
          // **A LIST-targeting card reaches base too.** `currentBattlefieldIndex`
          // is derived from `targetUnitInstanceId`, which a `unitList` variant
          // never sets — so requiring it silently withheld the base from Tricksy
          // Tentacles (UNL-054), whose "a single location" the project owner ruled
          // on 2026-08-13 DOES include the enemy base.
          //
          // The index requirement is right for a SINGLE target (a unit already in
          // base has nowhere to go, so offering base is a no-op choice) and simply
          // does not apply to a group: the owner ruling recorded at
          // docs/rules-conformance.md makes a destination some of the group already
          // occupies a legal choice with a PARTIAL no-op, not an illegal one.
          const movesAChosenList = (v.targetUnitInstanceIds?.length ?? 0) > 0;
          const toBase: Partial<PlayCardAction>[] =
            cardMayMoveToBase(card.defId) && (currentBattlefieldIndex !== undefined || movesAChosenList)
              ? [{ ...v, destinationIsBase: true as const }]
              : [];
          return [...toBattlefields, ...toBase]
            .filter((withDest) => secondTargetIsAtDestination(state, targeting, withDest))
            // Temptation's "to a location where there's a unit with the same
            // controller" — the same predicate the validator re-derives, so a
            // destination can never be offered and then refused.
            .filter((withDest) =>
              moveDestinationAllowed(
                state,
                card.defId,
                withDest.targetUnitInstanceId,
                withDest.destinationIsBase === true ? "base" : withDest.destinationBattlefieldId!,
                playerIndex,
              ),
            );
        })
      : variantsWithLegend;

    /**
     * The REPLACED-COST dimension (356.1.a), folded in as another variant rather
     * than pushed as a standalone candidate.
     *
     * **This has to ride the variant loop, not sit beside it.** A Unit's
     * destinations — the base play and every reinforce battlefield — are decided
     * INSIDE that loop, and a lone `actions.push` outside it produced a base play
     * and nothing else, silently withholding every battlefield the card may
     * legally be played to. Carrying the flag on the variant means `...variant`
     * spreads it onto each of those pushes for free, which is the same mechanism
     * `exhaustLegendPaid` and the targeting fan-out already use.
     *
     * The printed variants are kept when `printedPriceAvailable`; when it is
     * false (a trash card reachable only by its own permission) the replaced ones
     * are all there is.
     */
    const withReplacedPricing: Partial<PlayCardAction>[] = replacedPayment
      ? [
          ...(printedPriceAvailable ? withDestinations : []),
          ...withDestinations.map((v) => ({ ...v, replacedCostPaid: true as const })),
        ]
      : withDestinations;

    /**
     * The optional-XP dimension, folded in for the same reason the replaced cost
     * is — and this one FIXES A PRE-EXISTING GAP rather than only serving a new
     * card.
     *
     * The XP variant used to be a lone `actions.push({ ...play, optionalXpPaid })`
     * further down, and `play` is the BASE-play candidate. So for a UNIT the paid
     * variant was offered only into base: UNL-164 Safety Inspector has been
     * unplayable-with-XP to any battlefield for as long as he has existed, and
     * nothing noticed because his XP buys a resolution-time exemption rather than
     * a price, so no assertion about cost could see it.
     *
     * UNL-178 Poppy makes it impossible to leave: she prints `[Ambush]`, whose
     * entire purpose is playing her to a battlefield as a Reaction, and her XP
     * buys the discount that makes that affordable.
     *
     * Riding the variant means `...variant` spreads the flag onto the base push
     * AND every reinforce destination, exactly as it does for the replaced cost.
     * Deliberately crossed with NOTHING else — the price-modifying branches below
     * are gated off for an XP variant, so this adds destinations rather than
     * inventing combinations no card prints.
     */
    const canPayOptionalXp =
      optionalXpCostOf(card.defId) !== undefined &&
      // A card whose XP widens its TARGETING already carries the flag on the
      // variants that need it (see `xpWidened` above). Copying every variant
      // again here would offer "pay 5 XP, choose a 3-Might unit" — legal,
      // strictly worse, and a variant the validator must then agree with for
      // nothing.
      xpWidenedTargetingFor(card.defId) === undefined &&
      !fromHidden &&
      printedPriceAvailable &&
      actor.xp >= (optionalXpCostOf(card.defId) ?? 0) &&
      // A card whose XP buys a DISCOUNT needs that discounted payment to exist;
      // one whose XP buys an exemption reuses the plain payment and needs nothing.
      (xpEnergyDiscount === 0 || xpDiscountedPayment !== null);
    const withPricing: Partial<PlayCardAction>[] = canPayOptionalXp
      ? [...withReplacedPricing, ...withReplacedPricing.map((v) => ({ ...v, optionalXpPaid: true as const }))]
      : withReplacedPricing;

    /**
     * One `RepeatChoices` per mode, with that mode's target SAMPLED.
     *
     * **The sample is this branch's whole bound on the target axis, and it is
     * the rule this file already applies to every other `[Repeat]`**: the second
     * execution may name different targets (820.2.a), so the complete
     * enumeration is the cross product of the executions' choice sets — for
     * Curtain Call, up to three additional executions each aiming at any unit on
     * the board, which is cubic in the board before the subset and mode axes are
     * even counted. So one target per mode is offered and `validate-play-card`
     * accepts any legal set, exactly as it does for the single-instance cards.
     *
     * What the AI still sees in full is every MODE in every position, because
     * the base execution's mode and target are fanned out by `effectVariants`
     * above — so "deal 2 to that unit" is offered pointed at each unit in turn,
     * just not simultaneously with an independently-aimed second execution.
     *
     * `undefined` for a mode with no legal target: that mode cannot be an
     * execution at all, which is 355.8 rather than a sampling decision.
     */
    const sampledRepeatChoices = new Map<string, RepeatChoices | undefined>();
    const sampleChoicesForMode = (modeId: string): RepeatChoices | undefined => {
      if (sampledRepeatChoices.has(modeId)) return sampledRepeatChoices.get(modeId);
      const options = variantsForTargeting(targetingForAnyCard(card, modeId));
      const first = options[0];
      // Only the fields `RepeatChoices` declares — a repeat execution varies
      // targets, not the play's costs, and copying a `Partial<PlayCardAction>`
      // wholesale would smuggle a cost field into a choice set.
      const sampled: RepeatChoices | undefined =
        first === undefined
          ? undefined
          : {
              modeId,
              ...(first.targetUnitInstanceId !== undefined ? { targetUnitInstanceId: first.targetUnitInstanceId } : {}),
              ...(first.secondTargetUnitInstanceId !== undefined
                ? { secondTargetUnitInstanceId: first.secondTargetUnitInstanceId }
                : {}),
              ...(first.targetUnitInstanceIds !== undefined ? { targetUnitInstanceIds: first.targetUnitInstanceIds } : {}),
              ...(first.targetBattlefieldId !== undefined ? { targetBattlefieldId: first.targetBattlefieldId } : {}),
              ...(first.targetChainCardInstanceId !== undefined
                ? { targetChainCardInstanceId: first.targetChainCardInstanceId }
                : {}),
              ...(first.targetPermanentInstanceId !== undefined
                ? { targetPermanentInstanceId: first.targetPermanentInstanceId }
                : {}),
              ...(first.destinationBattlefieldId !== undefined
                ? { destinationBattlefieldId: first.destinationBattlefieldId }
                : {}),
              ...(first.destinationIsBase === true ? { destinationIsBase: true as const } : {}),
            };
      sampledRepeatChoices.set(modeId, sampled);
      return sampled;
    };

    /**
     * Every combination of PAID `[Repeat]` instances this variant can offer, each
     * with its executions' choices already settled.
     *
     * For a card printing ONE instance this is the single plan `[{ instance: 0 }]`
     * and the branch below emits exactly the action it always did — no
     * `repeatExecutions` field, no extra candidate, no change of any kind.
     *
     * For a MULTI-instance card it is the subset fan-out (820.1.c.2, bounded by
     * `MAX_ENUMERATED_REPEAT_INSTANCES`) crossed with the modes those executions
     * choose. Curtain Call's "Choose one you haven't already chosen" is what
     * makes the mode assignment part of the plan rather than a free choice: the
     * modes are drawn from those the base execution did NOT take, and they are
     * assigned to the paid instances in printed order.
     *
     * **Mode SETS, not orderings.** k paid instances take a k-subset of the
     * remaining modes rather than a k-permutation, which is 6 assignments where
     * the full ordering would be 24. Order between additional executions is
     * observable only when one kills what another would have hit, and with the
     * targets sampled anyway the distinction buys nothing the validator does not
     * already accept from a client that wants it.
     */
    const repeatPlansFor = (
      variant: Partial<PlayCardAction>,
      instanceCount: number,
    ): (readonly RepeatExecution[])[] => {
      if (instanceCount <= 1) return [[{ instance: 0 }]];
      const distinct = cardRequiresDistinctModes(card);
      if (!distinct) {
        // No card prints this shape today. The honest offer is "the same choices
        // again" for each paid instance, which is what an absent `choices` means
        // and what every single-instance Repeat is already sampled as.
        return repeatInstanceSubsets(instanceCount).map((subset) => subset.map((instance) => ({ instance })));
      }
      const remaining = cardModes.filter((m) => m.id !== variant.modeId);
      const plans: (readonly RepeatExecution[])[] = [];
      for (const subset of repeatInstanceSubsets(instanceCount)) {
        for (const modeSet of modeSubsetsOfSize(remaining, subset.length)) {
          const choices = modeSet.map((mode) => sampleChoicesForMode(mode.id));
          // A mode with no legal target cannot be one of these executions —
          // 355.8, the same rule that makes a spell with no target uncastable.
          if (choices.some((c) => c === undefined)) continue;
          plans.push(subset.map((instance, i) => ({ instance, choices: choices[i]! })));
        }
      }
      return plans;
    };

    for (const variant of withPricing) {
      // Every price-modifying branch below prices the card's PRINTED base, so a
      // replaced-cost variant takes none of them: the replacement IS the base
      // (356.1.a), and nothing in this pool combines one with an optional
      // additional cost. Each such branch is gated on this rather than being
      // skipped wholesale, so the printed variants keep behaving exactly as they
      // did — a replaced-cost card is additive to this function, not a mode of it.
      const usingReplacedCost = variant.replacedCostPaid === true;
      // An XP variant takes none of the price-modifying branches below, for the
      // same reason a replaced-cost one does not: it is a fixed alternative
      // pricing of this card, and no card in the pool prints an XP cost beside a
      // `[Repeat]`, an `[Accelerate]` or a discard discount. Gating rather than
      // crossing keeps the enumeration to plays a card can actually make.
      const usingOptionalXp = variant.optionalXpPaid === true;
      // fromHiddenBattlefieldId rides on EVERY variant this card produces — it is
      // what tells the validator to ignore the base cost, use Reaction timing and
      // look for the card at a battlefield rather than in hand.
      const hiddenFields = fromHiddenBattlefieldId !== undefined ? { fromHiddenBattlefieldId } : {};
      // A variant that PAID the cost-ignoring additional cost pays nothing else.
      // Empty rather than small — the validator re-derives exactly this, and the
      // two must agree or the UI offers a click validation then refuses.
      // A REPEATABLE cost DISCOUNTS rather than replaces: each unit spent takes
      // 1 Power off, floored at 0. Re-priced per variant for the same reason
      // [Deflect] is — the price now depends on the choice, so one variant can be
      // affordable while another is not, and a single payment computed once per
      // card cannot say so.
      const repeatableSpend = variant.additionalCostUnitInstanceIds?.length ?? 0;
      const repeatablePayment =
        repeatableSpend > 0
          ? computeAutoPayment(
              actor.channeled,
              effectiveCost.energyCost,
              Math.max(0, effectiveCost.powerCost - repeatableSpend),
              card.powerDomain,
              card.powerDomainAlt,
            )
          : undefined;
      // **Atakhan's scaled sacrifice discount, priced per VARIANT.**
      //
      // Its size depends on WHICH unit this variant kills, so unlike every
      // board-keyed discount it cannot be folded into the once-per-card
      // `effectiveCost` above. Re-run through `computeEffectiveCost` rather than
      // subtracted from it, which is the bug the discard branch already records:
      // taking a discount off the raw cost and stopping there skips the
      // floating-Energy reduction the plain path applies, and enumeration then
      // offers a payment the validator prices differently.
      const sacrificeDiscount = variantCostDiscount(state, playerIndex, card.defId, {
        ...(variant.additionalCostUnitInstanceId !== undefined
          ? { additionalCostUnitInstanceId: variant.additionalCostUnitInstanceId }
          : {}),
        ...(variant.trashCardInstanceId !== undefined ? { trashCardInstanceId: variant.trashCardInstanceId } : {}),
      });
      const sacrificeEffective =
        sacrificeDiscount.energy + sacrificeDiscount.power > 0 && !fromHidden
          ? computeEffectiveCost(
              actor.floatingEnergy,
              actor.floatingPower,
              Math.max(
                0,
                modifiedEnergyCost(state, playerIndex, card.kind, card.energyCost, card.defId, fromHand) -
                  sacrificeDiscount.energy,
              ),
              Math.max(
                0,
                card.powerCost -
                  sacrificeDiscount.power -
                  scaledPowerDiscount(state, playerIndex, card.defId) -
                  combatSpellPowerDiscount(state, playerIndex, card.kind),
              ),
              card.powerDomain,
              card.powerDomainAlt,
              card.kind === "Spell" ? actor.restrictedSpellEnergy : 0,
              restrictedPowerFor(actor, card.kind),
              actor.floatingRainbowPower,
            )
          : undefined;
      const sacrificePayment = sacrificeEffective
        ? computeAutoPayment(
            actor.channeled,
            sacrificeEffective.energyCost,
            sacrificeEffective.powerCost,
            card.powerDomain,
            card.powerDomainAlt,
          )
        : undefined;
      const variantPayment = usingReplacedCost
        ? replacedPayment
        : usingOptionalXp && xpEnergyDiscount > 0
          ? xpDiscountedPayment
          : canIgnoreCost && variant.additionalCostUnitInstanceId !== undefined
          ? { energyRunes: [], powerRunes: [] }
          : sacrificePayment !== undefined
            ? sacrificePayment
            : repeatableSpend > 0
              ? repeatablePayment
              : payment;
      // **The rainbow surcharge this VARIANT owes on top.** Computed here rather
      // than beside its use below, because the discard branch immediately after
      // emits its own candidates and owes the same tax — see that branch for why
      // it cannot simply fall through to the re-pricing.
      //
      // `[Deflect]` on what this variant chooses, PLUS Vex - Cheerless's flat tax
      // on an enemy spell cast into her combat. Through the one shared function so
      // the validator cannot price it differently — Vex is board-keyed rather than
      // target-keyed, so unlike `[Deflect]` she can make a variant that targets
      // nothing owe a surcharge, which is why every branch below must go through
      // this figure rather than skipping when the target list is empty.
      const deflected = rainbowSurchargeForPlay(state, playerIndex, card.kind, chosenUnitsOfPlay(variant));

      // One candidate per discardable card, priced against the DISCOUNTED cost —
      // and taxed for [Deflect] like every other variant.
      //
      // This branch emits BEFORE the per-variant re-pricing below, so for a while
      // it was the one path that skipped the surcharge. A MANDATORY discard makes
      // that unreachable-looking gap the only path the card has: Get Excited!
      // `continue`s three lines down, so every candidate it ever produces comes
      // out of here. Self-play on a generated deck threw "Get Excited! must pay 1
      // rainbow Power for [Deflect] on its target, but named 0" the first time it
      // met a Pouty Poro — the third instance of this file's offered-then-refused
      // bug, after Maddened Marauder's reinforce variant and Brazen Buccaneer's
      // floating-Energy mispricing.
      // `!usingReplacedCost`: a discard that BUYS a discount reduces the printed
      // base, and a replaced base is not the printed one — see the pricing
      // dimension's own note. No card in this pool prints both.
      if (discardChoice && discountedPayment && !usingReplacedCost && !usingOptionalXp) {
        // The discounted cost when a discount applies, the printed one otherwise —
        // whichever `discountedPayment` itself was derived from.
        const discardBase = discountedEffective ?? effectiveCost;
        const discardPaymentForTargets =
          deflected > 0
            ? computeAutoPayment(
                actor.channeled,
                discardBase.energyCost,
                discardBase.powerCost,
                card.powerDomain,
                card.powerDomainAlt,
                deflected,
              )
            : discountedPayment;
        // Unaffordable ONCE THE TAX IS ADDED skips this variant, not the card —
        // the same rule the untaxed path below applies, and the reason a
        // [Deflect] unit simply drops off the target list rather than making the
        // card unplayable.
        if (discardPaymentForTargets) {
          for (const c of discardable) {
            actions.push({
              type: "PlayCard",
              playerIndex,
              card,
              payment: discardPaymentForTargets,
              ...variant,
              ...hiddenFields,
              discardCardInstanceId: c.instanceId,
            });
          }
        }
      }
      // A MANDATORY discard has no undiscarded candidate — Get Excited! without a
      // card to discard was skipped above, and its plain variant must not appear
      // here either.
      if (discardChoice && !discardChoice.optional) continue;
      if (!variantPayment) continue; // affordable only WITH the discount, already emitted

      // **[Deflect]: re-price THIS variant.** Every payment above is computed once
      // per card, which was correct while nothing made the price depend on the
      // choice. `[Deflect N]` does: the surcharge is owed for choosing a
      // particular unit, so two variants of the same card can cost differently
      // and one can be unaffordable while another is fine. This is the per-variant
      // restructure the conformance row called for, and Call to Glory's
      // `ignoresCostWhenPaid` was its first, smaller instance.
      //
      // `deflected` is computed above, before the discard branch that also needs
      // it. Zero when nothing targeted has [Deflect], so the ordinary card keeps
      // the single shared payment object it always had.
      let variantPaymentForTargets: RunePayment = variantPayment;
      if (deflected > 0) {
        // **Re-priced from the BASE this variant is actually paying, not always
        // the printed one.** This block used to hardcode `effectiveCost` and
        // `card.powerDomain`, which is correct for a printed-price variant and
        // silently wrong for the two alternative pricings beside it: a
        // replaced-cost play (829.1's `[Flow]`, and the printed replacements) and
        // an XP-discounted one both have a different base, and re-pricing them at
        // the printed figure produces an action the validator refuses.
        //
        // **Found by a probe on 2026-08-17, and it is the SIXTH instance of this
        // file's offered-then-refused bug** — after Maddened Marauder's reinforce
        // variant, Brazen Buccaneer's floating-Energy mispricing, Get Excited!'s
        // mandatory-discard path, Kraken Hunter's accelerated repeat and Call to
        // Glory's ignored cost. Every one of the six was a per-variant price that
        // one branch computed from the wrong base.
        //
        // It was LATENT from the day `[Flow]` landed and needed three things at
        // once to fire: a Flow spell in the trash, a legal target carrying
        // `[Deflect]`, and enough runes to make the untaxed play look affordable.
        // Vendetta is the first set with any Flow card at all, and the crash names
        // Lacerate — whose Flow cost is the pool's only one with TWO pips of a
        // NAMED domain, which is what made the mispricing large enough to be
        // refused rather than coincidentally equal.
        //
        // Every OTHER price-modifying branch in this loop is already gated on
        // `!usingReplacedCost`/`!usingOptionalXp`; this one was reached by both
        // because it is not a pricing branch but a re-pricing of whatever was
        // chosen. So it takes the base rather than being skipped.
        const taxBase =
          usingReplacedCost && replacedEffective && replacedCost
            ? { cost: replacedEffective, domain: replacedCost.powerDomain, alt: undefined }
            : usingOptionalXp && xpDiscountedEffective
              ? { cost: xpDiscountedEffective, domain: card.powerDomain, alt: card.powerDomainAlt }
              : { cost: effectiveCost, domain: card.powerDomain, alt: card.powerDomainAlt };
        const taxed = computeAutoPayment(
          actor.channeled,
          taxBase.cost.energyCost,
          taxBase.cost.powerCost,
          taxBase.domain,
          taxBase.alt,
          deflected,
        );
        // Unaffordable ONCE THE TAX IS ADDED — the card may still be playable at
        // another target, so this skips the variant rather than the card.
        if (!taxed) continue;
        variantPaymentForTargets = taxed;
      }

      /**
       * Tideturner's "at ANOTHER location" — a restriction relating the TARGET to
       * the DESTINATION, which `TargetingSpec` cannot express because `scope`
       * describes the target alone and knows nothing about where the card lands.
       *
       * Enforced at enumeration because it is a targeting restriction (355.9.b,
       * the narrowing half) and 355.8 declares targets at finalization. Left to
       * the resolver it becomes a silent no-op: the swap runs with both units in
       * the same place and nothing moves, which is precisely how it was reported
       * — "tideturner is not working".
       */
      const targetIsElsewhere = (destination: string | undefined): boolean => {
        if (!targetMustBeElsewhere(card.defId)) return true;
        const targetId = (variant as { targetUnitInstanceId?: string }).targetUnitInstanceId;
        if (targetId === undefined) return true; // the declined variant
        const found = findUnitAnywhere(state, targetId);
        if (!found) return true;
        const targetLocation = found.zone === "base" ? "base" : state.battlefields[found.zone.battlefieldIndex]!.id;
        return targetLocation !== (destination ?? "base");
      };

      const play: PlayCardAction = { type: "PlayCard", playerIndex, card, payment: variantPaymentForTargets, ...variant, ...hiddenFields };
      // [Accelerate] is priced once per card, which is wrong the moment anything
      // else about the variant changes the price. Kraken Hunter is both
      // accelerable and repeatable-discounted, and the shared `accelerated`
      // payment ignored the discount entirely — so the enumerator offered a
      // 3-Power accelerated play that the validator, which re-derives from the
      // discounted cost, then refused at 1. Found by the first test to enumerate
      // and validate the same action, which is the only way this class of bug
      // ever shows up.
      // Bullet Time's X. One variant per affordable amount, priced through the
      // SAME `rainbowRunes` bucket [Deflect] built — the one bucket whose runes
      // are not domain-checked against the card, which is what "any amount of
      // rainbow Power" needs.
      //
      // X = 0 is deliberately included: the card is castable for nothing and
      // deals nothing, which is what "any amount" means and is occasionally what
      // a player wants (it still costs its printed Energy). Capped by the pool
      // rather than by a number, so the fan-out is at most one per rune.
      //
      // **The surcharge is added to X rather than replacing it.** X and a
      // surcharge are two debts sharing one bucket, so the payment must cover
      // both — and `validate-play-card` subtracts the surcharge back off before
      // checking that the rainbow runes match the X the action claims. This
      // branch owed nothing until Vex - Cheerless: Bullet Time targets no unit,
      // so `[Deflect]` could never reach it, and a board-keyed tax can.
      if (hasXRainbowCost(card.defId) && !fromHidden) {
        for (let x = 0; x <= actor.channeled.length; x += 1) {
          const priced = computeAutoPayment(
            actor.channeled,
            effectiveCost.energyCost,
            effectiveCost.powerCost,
            card.powerDomain,
            card.powerDomainAlt,
            x + deflected,
          );
          if (!priced) break; // pools only get tighter as X grows
          actions.push({ type: "PlayCard", playerIndex, card, payment: priced, ...variant, ...hiddenFields, xAmount: x });
        }
        continue; // the X variants ARE this card's plays; no plain one beside them
      }
      // Clockwork Keeper's optional Power cost — a second candidate priced one
      // Power higher, exactly as [Accelerate] is, and on its own flag so the two
      // cannot be confused (that one also means "enters ready").
      const optionalPower = optionalPowerCostOf(state, playerIndex, card.defId);
      if (optionalPower && !fromHidden) {
        // Priced against the cost's OWN domain, not the card's `powerDomain` —
        // Clockwork Keeper prints no Power at all, so that field is null and
        // pricing through it accepted any rune.
        // **Both halves, because an optional cost can carry either or both.**
        // Clockwork Keeper is Power-only, Sea Monkey is Energy-only, and Blast
        // Corps Cadet prints one of each — a version that priced only the rune
        // would sell the Cadet's bonus for the rune alone.
        //
        // The Energy is added to the ALREADY-FLOAT-REDUCED figure here, which is
        // the mistake this file records making twice (the discount branch, then
        // `[Repeat]`) — and it is correct in this one case for a reason worth
        // naming rather than inheriting: `effectiveCost` is what the play owes
        // AFTER float, so float is already spent, and adding to it charges the
        // extra in full. That is what these cards say: an ADDITIONAL cost, not a
        // larger printed one. The two differ only when float remains unspent,
        // which by construction it does not.
        //
        // **The `[Deflect]` surcharge rides this branch too**, and it did not
        // until Frostcoat Cub. Clockwork Keeper — the only card here before —
        // targets nothing, so an optional-cost variant could never owe a tax and
        // the omission was unreachable. The Cub targets a unit, and a `[Deflect]`
        // unit made the enumerator offer a play the validator then refused:
        // "must pay 1 rainbow Power for [Deflect] on its target, but named 0".
        // Found by `DECKS=sfd`, not by the suite, which is the fifth time.
        //
        // `powerDomainAlt` is passed for the same reason every other branch
        // passes it: a split-pip card has two domains and pricing through one
        // rejects runes the card accepts.
        //
        // Ezreal - Prodigy's axis fans this out, exactly as it does the two
        // `[Repeat]` branches and `[Accelerate]` below — these are all the same
        // kind of cost and the enumerator has to offer all four at his price or
        // he is dead in a real game, which is what the 2026-08-08 report found.
        const pricedOptional = new Set<string>();
        for (const axis of additionalCostAxes) {
          const own = targetChoiceDiscount(state, playerIndex, chosenUnitsOfPlay(variant), axis);
          const additional = discountedOptionalCosts(state, playerIndex, axis, [
            { energy: optionalPower.energy ?? 0, power: optionalPower.count ?? 0, rainbow: 0 },
          ]);
          // **Re-derived through `computeEffectiveCost`, not added to the
          // already-float-reduced figure — corrected 2026-08-10, and this is the
          // SECOND time this exact mistake has been made in this file.**
          //
          // The paragraph above used to argue the arithmetic was safe here: float
          // "is already spent, so adding to it charges the extra in full... the two
          // differ only when float remains unspent, which by construction it does
          // not". That construction does not hold for a card printing NO Power.
          // `effectiveCost` has nothing to spend the float ON, so it survives, and
          // the validator — which folds the additional cost in BEFORE applying
          // float — then prices the play a pip lower than this did.
          //
          // Live on UNL-028 Pyke - Dockside Butcher and UNL-052 Nami - Headstrong,
          // both 0-Power cards with an optional Power cost, both added the day
          // before. `hunt-xp` threw "Pyke - Dockside Butcher costs 0 power after
          // floating Power, payment supplied 1" — the FIFTH offered-then-refused
          // crash in this engine and the fifth found by a probe rather than by the
          // suite, because it needs floating Power of the right domain banked at
          // the moment such a card is played.
          //
          // The `[Accelerate]` branch ~1000 lines up carries the identical
          // correction, for the identical reason, found by the identical probe.
          const optionalEffective = computeEffectiveCost(
            actor.floatingEnergy,
            actor.floatingPower,
            Math.max(
              0,
              modifiedEnergyCost(state, playerIndex, card.kind, card.energyCost, card.defId, fromHand) - own.energy,
            ) + additional.energy,
            Math.max(
              0,
              card.powerCost -
                own.power -
                scaledPowerDiscount(state, playerIndex, card.defId) -
                combatSpellPowerDiscount(state, playerIndex, card.kind),
            ) + additional.power,
            optionalPower.domain ?? card.powerDomain,
            card.powerDomainAlt,
            card.kind === "Spell" ? actor.restrictedSpellEnergy : 0,
            restrictedPowerFor(actor, card.kind),
            actor.floatingRainbowPower,
          );
          const energyCost = optionalEffective.energyCost;
          const powerCost = optionalEffective.powerCost;
          const shape = `${energyCost}/${powerCost}`;
          if (pricedOptional.has(shape)) continue; // this axis buys nothing new
          pricedOptional.add(shape);
          const paid = computeAutoPayment(
            actor.channeled,
            energyCost,
            powerCost,
            optionalPower.domain ?? card.powerDomain,
            card.powerDomainAlt,
            deflected,
          );
          // Offered only when the bigger payment is really payable — a card you can
          // afford plainly but not with the extra simply has no paid variant.
          if (paid) {
            actions.push({
              type: "PlayCard",
              playerIndex,
              card,
              payment: paid,
              ...variant,
              ...hiddenFields,
              optionalPowerPaid: true,
              ...(axis !== undefined ? { targetDiscountAxis: axis } : {}),
            });
          }
        }
      }
      // "You may spend N XP as an additional cost" (204.2) — Conscription and
      // Safety Inspector.
      //
      // **The simplest additional cost in this file, and deliberately so.** XP is
      // not a Game Object (731): it cannot be targeted, taxed by `[Deflect]`, or
      // reduced by a discount axis, and it has no domain to price against. So the
      // paid variant reuses the plain `paidPayment` UNCHANGED and differs only by
      // the flag — none of the `computeAutoPayment` fan-out above applies, and a
      // version that ran it anyway would have invented rune costs the card does
      // not print.
      //
      // `!fromHidden` matches the neighbouring branches. 811 ignores a hidden
      // card's BASE cost and an additional cost is not that, so this is a real if
      // currently unreachable simplification: neither card prints `[Hidden]`.
      //
      // Gated on affording it, exactly as the optional-Power branch is — a caster
      // short of XP simply has no paid variant, rather than being offered one the
      // validator would refuse. That split is this file's recurring crash class.
      // **The optional-XP variant is no longer pushed here.** It was a lone
      // `actions.push({ ...play, optionalXpPaid: true })`, and `play` is the
      // BASE-play candidate — so a UNIT's paid variant reached base and no
      // battlefield. It is now a dimension on `withPricing` above, which spreads
      // it onto the base push and every reinforce destination alike. See that
      // binding for the gap this closed.
      // Irelia - Graceful — "your spells that choose me cost [1] OR [rainbow]
      // less." TWO candidates, one per axis, because the "or" is a real choice
      // and neither resource substitutes for the other.
      //
      // A sibling of the optional-Power branch above rather than a re-pricing of
      // the plain variant: the axis rides the action, so each priced payment has
      // to be pushed with the flag it was priced under or the validator will
      // re-derive a different cost. That is this file's offered-then-refused bug,
      // and the comment above records three of them.
      //
      // Subtracted from the ALREADY-FLOAT-REDUCED `effectiveCost`, which is the
      // mistake this file records making twice — and is correct here for a
      // reason worth stating rather than inheriting. The validator applies float
      // to the DISCOUNTED cost; this applies the discount to the FLOATED cost.
      // Both clamp at 0, and `max(0, max(0, p - f) - d)` equals
      // `max(0, p - d - f)` for non-negative f and d, so the two agree on what
      // is owed. What they would NOT agree on is float SPENT — which is why the
      // executor subtracts before it touches float rather than after.
      //
      // The plain variant is still emitted, so declining the discount stays
      // legal — it can only ever be worse, but a rule that says "may" is not
      // enforced by removing the alternative.
      for (const axis of ["energy", "power"] as const) {
        const discount = targetChoiceDiscount(state, playerIndex, chosenUnitsOfPlay(variant), axis);
        if (discount.energy + discount.power === 0) break; // this variant chooses no such unit
        const paid = computeAutoPayment(
          actor.channeled,
          Math.max(0, effectiveCost.energyCost - discount.energy),
          Math.max(0, effectiveCost.powerCost - discount.power),
          card.powerDomain,
          card.powerDomainAlt,
          deflected,
        );
        if (paid) {
          actions.push({ type: "PlayCard", playerIndex, card, payment: paid, ...variant, ...hiddenFields, targetDiscountAxis: axis });
        }
      }
      // `[Repeat]` (820.1) — a second candidate priced with the additional cost
      // on top, exactly as Clockwork Keeper's optional Power is just above.
      //
      // **The repeat's own choices are sampled, not fanned out.** 820.1.d lets
      // the second execution name DIFFERENT targets, so the complete
      // enumeration is the cross product of the two choice sets — quadratic in
      // the board, and for Bellows Breath's up-to-three it is worse than that.
      // So this emits the one variant that repeats the SAME choices, and
      // `validate-play-card` accepts any legal second set. That asymmetry is
      // this engine's standing answer to an unbounded choice space (see
      // `unitList` targeting and the repeatable additional costs, which are
      // sampled the same way and for the same reason): the AI gets a bounded
      // list, and a human clicking a combination the sampler never emitted is
      // still able to cast the card.
      //
      // `!fromHidden` matches the optional-Power and Accelerate branches. Rule
      // 811 ignores a hidden card's BASE cost and an additional cost is not
      // that, so this is a real (if unreachable) simplification — no card in
      // the pool prints both [Hidden] and [Repeat], asserted in the table test.
      //
      // # A card printing SEVERAL instances fans out over WHICH ones it pays
      //
      // 820.1.c.2 makes each instance separately payable, and UNL-182 Curtain
      // Call prints three at three different prices — so "how many" does not
      // price the play and the subset itself is a dimension. `repeatPlans` below
      // is that fan-out; for the twenty single-instance cards it is the one plan
      // `[{ instance: 0 }]` and everything past it is byte-for-byte what it was.
      const repeatCosts = repeatCostsOf(card.defId);
      const repeatCost = repeatCosts[0];
      // `!usingReplacedCost` for the reason the discard branch above gives: a
      // `[Repeat]` is an optional ADDITIONAL cost priced on top of the printed
      // base, and a replaced base is not that. No card prints both.
      if (repeatCost && !fromHidden && !usingReplacedCost && !usingOptionalXp) {
        for (const plan of repeatPlansFor(variant, repeatCosts.length)) {
        // The costs this plan actually buys, in the order it lists them.
        const planCosts = plan.map((execution) => repeatCosts[execution.instance]!);
        // Only a MULTI-instance card carries the list on the action; a
        // single-instance one keeps the `repeatPaid` spelling every card in the
        // pool and every existing test already uses. `repeatExecutionsOf`
        // normalises both, so this is a choice about what the action READS like
        // rather than about what it means.
        const planFields =
          repeatCosts.length > 1 ? { repeatExecutions: plan as readonly RepeatExecution[] } : {};
        // **The `[Deflect]` tax is owed by BOTH executions** (project-owner
        // ruling, 2026-08-06 — the same unit chosen twice owes twice). This
        // variant repeats the SAME choices, so its taxable set is the first
        // set twice over. Asked through the very helpers the validator uses,
        // against the candidate action itself, rather than doubling `deflected`
        // by hand: this figure is where the offered-then-refused split lives.
        //
        // Vex - Cheerless's tax rides the same figure and is owed ONCE, not per
        // execution: hers is a price on PLAYING an enemy spell, and a `[Repeat]`
        // is one play that executes twice. `rainbowSurchargeForPlay` adds it once
        // however long the chosen-unit list it is handed is.
        // A Repeat priced in CARDS fans out per discardable card — Square Up's
        // "Discard 1". Unlike Energy, one card in hand is not interchangeable
        // with another, so WHICH is spent is a real choice and rides the action.
        //
        // The spell itself is excluded: it is still in hand at enumeration time
        // and paying for a card with itself is not a cost anyone can take.
        const repeatDiscardCost = planCosts.reduce((sum, c) => sum + (c.discard ?? 0), 0);
        const repeatDiscardable =
          repeatDiscardCost > 0 ? actor.hand.filter((c) => c.instanceId !== card.instanceId) : [];
        // A card cost that CANNOT be paid offers no repeat at all, which is
        // 204.2.a — an unpayable additional cost is simply not available.
        //
        // **`continue` here was a bug and a test caught it.** This block sits
        // inside the loop that also emits the PLAIN play, so skipping the
        // iteration made Square Up entirely uncastable with a hand of one card,
        // rather than castable-without-the-repeat. The guard has to withhold the
        // repeat and nothing else.
        const repeatIsPayable = repeatDiscardCost === 0 || repeatDiscardable.length > 0;
        const repeatVariant = { ...variant, repeatPaid: true as const, ...planFields };
        const repeatDeflected = rainbowSurchargeForPlay(state, playerIndex, card.kind, [
          ...chosenUnitsOfPlay(repeatVariant),
          ...chosenUnitsOfRepeat(repeatVariant),
        ]);
        // Ezreal - Prodigy's axis, and Irelia - Graceful's with it: they share the
        // field, so a variant carrying an axis owes BOTH reductions or the
        // validator — which applies both — prices it lower than this did. The
        // duplicate-shape guard at the bottom is what keeps the `undefined` entry
        // from emitting the same play twice when an axis buys nothing.
        const priced = new Set<string>();
        for (const axis of additionalCostAxes) {
          const own = targetChoiceDiscount(state, playerIndex, chosenUnitsOfPlay(variant), axis);
          // ONE BUNDLE PER PAID INSTANCE — each is its own Optional Additional
          // Cost (820.1.c.2) and the 2026-08-08 ruling gives each its own Ezreal
          // pip, which is the same shape the granted-instance branch below built
          // for exactly that reason. `validate-play-card` prices from the same
          // list, so the two cannot disagree about what the play costs.
          const additional = discountedOptionalCosts(
            state,
            playerIndex,
            axis,
            planCosts.map((c) => ({
              energy: modifiedRepeatEnergy(state, playerIndex, c.energy),
              power: c.power ?? 0,
              rainbow: c.rainbowPower ?? 0,
            })),
          );
          // **Re-priced through `computeEffectiveCost` from the PRINTED cost, not
          // by adding the Repeat to the already-float-reduced `effectiveCost`.**
          // Floating Energy reduces the TOTAL a play costs, additional costs
          // included, so adding afterwards double-counts the float away: with 1
          // printed Energy, a [Repeat] [1] and 2 floating Energy, adding-after
          // quotes 0 + 1 = one rune while the validator prices the whole 2 against
          // the float and demands zero. That is the offered-then-refused split,
          // and it is the SAME mistake the discounted branch above records having
          // made — see this function's own note at the `effectiveCost` binding.
          // Also found by a self-play probe rather than by the suite, and for the
          // same reason: no unit test had floating Energy banked.
          const repeatEffective = computeEffectiveCost(
            actor.floatingEnergy,
            actor.floatingPower,
            Math.max(0, modifiedEnergyCost(state, playerIndex, card.kind, card.energyCost, card.defId) - own.energy) +
              additional.energy,
            // Vex's friendly discount comes off the card's OWN Power and is clamped
            // there before the Repeat's is added, which is the order
            // `validate-play-card` applies — an additional cost is not reduced by a
            // discount aimed at the printed one.
            Math.max(0, card.powerCost - combatSpellPowerDiscount(state, playerIndex, card.kind) - own.power) +
              additional.power,
            card.powerDomain,
            card.powerDomainAlt,
            card.kind === "Spell" ? actor.restrictedSpellEnergy : 0,
            restrictedPowerFor(actor, card.kind),
            actor.floatingRainbowPower,
          );
          const shape = `${repeatEffective.energyCost}/${repeatEffective.powerCost}/${additional.rainbow}`;
          if (priced.has(shape)) continue; // this axis buys nothing this play does not already have
          priced.add(shape);
          const paidRepeat = computeAutoPayment(
            actor.channeled,
            repeatEffective.energyCost,
            repeatEffective.powerCost,
            card.powerDomain,
            card.powerDomainAlt,
            repeatDeflected + additional.rainbow,
          );
          // Offered only when the bigger payment is really payable — a spell you
          // can afford plainly but not with the repeat simply has no paid variant,
          // the same rule the optional-Power branch above applies.
          if (paidRepeat) {
            // One action per discardable card when the Repeat is priced in cards,
            // and exactly one otherwise. `[undefined]` rather than a branch keeps
            // the push itself single — a second `actions.push` here is how the
            // surcharge got skipped on one path before.
            const discardChoices: (string | undefined)[] = !repeatIsPayable
              ? []
              : repeatDiscardCost > 0
                ? repeatDiscardable.map((c) => c.instanceId)
                : [undefined];
            for (const discardId of discardChoices) {
              actions.push({
                type: "PlayCard",
                playerIndex,
                card,
                payment: paidRepeat,
                ...variant,
                ...hiddenFields,
                repeatPaid: true,
                ...planFields,
                ...(discardId !== undefined ? { repeatDiscardCardInstanceId: discardId } : {}),
                ...(axis !== undefined ? { targetDiscountAxis: axis } : {}),
              });
            }
          }
        }
        }
      }
      // Temporal Portal's GRANTED `[Repeat]`, priced from the card's PRINTED cost
      // through the same `computeEffectiveCost` call the printed instance goes
      // through — and for the same recorded reason: adding an additional cost on
      // top of an already-float-reduced figure double-counts the float away and
      // is the offered-then-refused split this branch's twin already carries a
      // note about.
      //
      // Enumerated as its own variant AND crossed with the printed instance when
      // the card has one, because 820.1.c.2 makes them independently payable: pay
      // neither, either, or both, at four different prices for three different
      // execution counts.
      // TWO sources of a granted Repeat, and they are different shapes: Temporal
      // Portal ARMS a counter spent by the next spell, and UNL-146 Syndra -
      // Transcendent grants a STANDING one to every spell while she is in a
      // showdown. See `repeat-grants.ts`.
      //
      // **The armed one wins when both are live, and that is an under-offer.**
      // 820.1.c.2 makes them separately payable, so the rules allow paying both
      // for two extra executions; the action carries `grantedRepeatPaid` as a
      // single boolean and `card-effect-resolution` runs one extra execution for
      // it, so a second granted instance has nowhere to be recorded. Recorded as
      // a divergence rather than approximated — offering one instance is
      // narrower than printed, which is the direction this engine errs in.
      const grantedCost =
        grantedRepeatCostOf(card, actor.nextSpellRepeatGrants) ?? standingRepeatGrantFor(state, playerIndex, card);
      // The part of that cost the card's own Power bucket cannot hold — Syndra's
      // Chaos pip on a Fury spell. Reserved out of the pool first, so the general
      // payment below cannot spend the rune this pip needs.
      const foreignPip = foreignRepeatPip(card, grantedCost);
      const foreignReserve = foreignPip ? reserveForeignPip(actor.channeled, foreignPip) : undefined;
      if (grantedCost && !fromHidden && !usingReplacedCost && !usingOptionalXp && !(foreignPip && !foreignReserve)) {
        const pricedGranted = new Set<string>();
        for (const alsoPrinted of repeatCost ? [false, true] : [false]) {
          for (const axis of additionalCostAxes) {
            const own = targetChoiceDiscount(state, playerIndex, chosenUnitsOfPlay(variant), axis);
            // TWO bundles when both instances are paid, because 820.1.c.2 makes them
            // two separately-payable optional additional costs and the
            // project-owner ruling of 2026-08-08 gives each its own Ezreal pip.
            // This crossed branch is the only place in the pool where that is
            // observable — `[Accelerate]` is a Unit keyword and every `[Repeat]`
            // card is a Spell, so those two can never meet on one play.
            const additional = discountedOptionalCosts(state, playerIndex, axis, [
              {
                energy: modifiedRepeatEnergy(state, playerIndex, grantedCost.energy),
                // A FOREIGN pip is not part of the card's Power total — it is paid
                // from its own reserved runes below. Folding it in here is what
                // would demand Fury of a Fury spell for Syndra's Chaos pip.
                power: foreignPip ? 0 : (grantedCost.power ?? 0),
                rainbow: 0,
              },
              ...(alsoPrinted
                ? [
                    {
                      energy: modifiedRepeatEnergy(state, playerIndex, repeatCost!.energy),
                      power: repeatCost!.power ?? 0,
                      rainbow: repeatCost!.rainbowPower ?? 0,
                    },
                  ]
                : []),
            ]);
            const grantedEffective = computeEffectiveCost(
              actor.floatingEnergy,
              actor.floatingPower,
              Math.max(0, modifiedEnergyCost(state, playerIndex, card.kind, card.energyCost, card.defId) - own.energy) +
                additional.energy,
              // Vex's friendly discount, clamped against the card's own Power before
              // either additional cost is added — the printed-Repeat branch above
              // says why that order is the validator's.
              Math.max(0, card.powerCost - combatSpellPowerDiscount(state, playerIndex, card.kind) - own.power) +
                additional.power,
              card.powerDomain,
              card.powerDomainAlt,
              card.kind === "Spell" ? actor.restrictedSpellEnergy : 0,
              restrictedPowerFor(actor, card.kind),
              actor.floatingRainbowPower,
            );
            const shape = `${alsoPrinted}/${grantedEffective.energyCost}/${grantedEffective.powerCost}/${additional.rainbow}/${foreignPip?.count ?? 0}`;
            if (pricedGranted.has(shape)) continue; // this axis buys nothing new
            pricedGranted.add(shape);
            const grantedVariant = {
              ...variant,
              grantedRepeatPaid: true as const,
              ...(alsoPrinted ? { repeatPaid: true as const } : {}),
            };
            // The `[Deflect]` tax is owed once per EXECUTION that chooses the unit
            // — the 2026-08-06 ruling, applied here by asking the same helpers the
            // validator asks, against the candidate action itself.
            // Vex - Cheerless's tax is in this figure too, and once — see the
            // printed-Repeat branch above for why a play that executes three times
            // still owes her only one.
            const grantedDeflected = rainbowSurchargeForPlay(state, playerIndex, card.kind, [
              ...chosenUnitsOfPlay(grantedVariant),
              ...(alsoPrinted ? chosenUnitsOfRepeat(grantedVariant) : []),
            ]);
            const paidGranted = computeAutoPayment(
              // The pool MINUS the foreign pip's reserved runes — see
              // `reserveForeignPip` for why they come out first.
              foreignReserve?.remaining ?? actor.channeled,
              grantedEffective.energyCost,
              grantedEffective.powerCost,
              card.powerDomain,
              card.powerDomainAlt,
              grantedDeflected + additional.rainbow,
            );
            if (paidGranted) {
              actions.push({
                type: "PlayCard",
                playerIndex,
                card,
                // The foreign pip's reserved runes ride in their own bucket —
                // `computeAutoPayment` never saw them, so it cannot have named
                // them for anything else.
                payment: foreignReserve
                  ? { ...paidGranted, foreignPowerRunes: foreignReserve.reserved.map((r) => r.id) }
                  : paidGranted,
                ...variant,
                ...hiddenFields,
                ...grantedVariant,
                ...(axis !== undefined ? { targetDiscountAxis: axis } : {}),
              });
            }
          }
        }
      }
      // `[Accelerate]` is an Optional Additional Cost by name (805/805.2), so it
      // fans out over Ezreal - Prodigy's axis like the two `[Repeat]` branches
      // above. `additionalCostAxes` is the single-element `[undefined]` when he
      // is not on the board, and this then prices exactly the one candidate it
      // always did — including the `accelerated` shortcut, which stays the
      // payment used whenever nothing about the variant changes the price.
      const canAccelerate =
        hasAccelerate(card, state, playerIndex, fromHand) &&
        !fromHidden &&
        printedPriceAvailable &&
        !usingReplacedCost &&
        !usingOptionalXp;
      const pricedAccelerated = new Set<string>();
      for (const axis of canAccelerate ? additionalCostAxes : []) {
        const own = targetChoiceDiscount(state, playerIndex, chosenUnitsOfPlay(variant), axis);
        const additional = discountedOptionalCosts(state, playerIndex, axis, [
          { energy: ACCELERATE_ENERGY, power: ACCELERATE_POWER, rainbow: 0 },
        ]);
        const energyCost = Math.max(0, effectiveCost.energyCost - own.energy) + additional.energy;
        const powerCost =
          Math.max(0, Math.max(0, effectiveCost.powerCost - repeatableSpend) - own.power) + additional.power;
        const shape = `${energyCost}/${powerCost}`;
        if (pricedAccelerated.has(shape)) continue; // this axis buys nothing new
        pricedAccelerated.add(shape);
        // The untouched, un-repeatable, un-discounted shape is the one `accelerated`
        // was computed for above — reused rather than re-priced so the ordinary
        // card's enumeration is byte-for-byte what it was.
        const acceleratedForVariant =
          repeatableSpend === 0 && axis === undefined && own.energy + own.power === 0
            ? accelerated
            : computeAutoPayment(
                actor.channeled,
                energyCost,
                powerCost,
                acceleratePowerDomain(card),
                // The repeatable-spend path priced without the alt domain before
                // this branch was merged, and still does — narrowing what a
                // payment may contain is safe, widening it is what moves an
                // existing candidate's runes, and nothing here is trying to.
                repeatableSpend > 0 ? undefined : card.powerDomainAlt,
              );
        if (acceleratedForVariant) {
          actions.push({
            type: "PlayCard",
            playerIndex,
            card,
            payment: acceleratedForVariant,
            ...variant,
            ...hiddenFields,
            acceleratePaid: true,
            ...(axis !== undefined ? { targetDiscountAxis: axis } : {}),
          });
        }
      }
      // The default candidate puts a token-placing Spell's tokens in BASE. Rule
      // 811 forbids that for a from-hidden play: "if a hidden spell ... causes
      // you to play a unit, you must choose to play that unit at that
      // battlefield." So the base variant is skipped and only the
      // that-battlefield one below is offered — without this the player was
      // handed a choice the rules don't give them, and the UI stalled waiting
      // for a placement decision that should never have been asked.
      // Rule 811's placement clause, and it covers a hidden PERMANENT as well as
      // a hidden spell that makes one: "you must choose to play that unit at
      // that battlefield". A hidden UNIT therefore has no base play either —
      // which is what the doc had recorded as unreachable on the strength of the
      // PRESET decks, while the pool holds six hidden units and a hidden gear.
      // Every one of them was playable straight into base for free.
      //
      // Perched Grimwyrm adds a second, card-keyed reason: "(You can't play me
      // anywhere else.)" makes his narrowing TOTAL, so he has no base play at
      // all. Asked through the same predicate the validator uses, so a base play
      // cannot be offered and then refused.
      const baseVariantForbidden =
        (fromHidden && ((card.kind === "Spell" && cardPlacesTokens(card.defId)) || card.kind === "Unit")) ||
        (card.kind === "Unit" && !mayPlayUnitToBase(card.defId));
      // `timedForBase`: an Ambush card that only survived the gate above because
      // some battlefield qualifies must NOT get a base play out of it.
      if (timedForBase && !baseVariantForbidden && targetIsElsewhere(undefined)) actions.push(play);

      // A Unit may ALSO be played directly to a battlefield where the actor
      // already has a unit of their own — "reinforce" — alongside the
      // unconditional base-play candidate just pushed above, never replacing
      // it. Mirrors validate-play-card.ts's presence rule exactly, including
      // the small open-battlefield-placement exception (Sneaky Deckhand, Sai
      // Scout) — those additionally get every OTHER battlefield too, not
      // just ones they already occupy.
      if (card.kind === "Unit") {
        for (const bf of state.battlefields) {
          // A from-hidden unit goes to ITS battlefield and nowhere else (811),
          // and that clause overrides both of the checks below: the presence
          // requirement (the card being there IS the reason it may be played
          // there) and 813's Showdown narrowing (a hidden card is played at
          // Reaction speed, so 813 would otherwise forbid the one destination
          // 811 requires — the more specific rule wins, recorded Unverified).
          if (fromHidden) {
            if (bf.id !== fromHiddenBattlefieldId) continue;
          } else {
            const hasPresence = (bf.units[actor.id]?.length ?? 0) > 0;
            // "An OPEN battlefield" is unoccupied AND uncontrolled (170.11.c), so
            // this is asked per battlefield rather than once per card. Same shared
            // predicate the validator uses.
            // The cost unit is passed because Stalking Wolf's waiver depends on
            // WHICH unit is paying — the same battlefield qualifies under one
            // variant and not another, so this must be asked per variant rather
            // than once per card. Every other grant ignores the argument.
            if (!hasPresence && !mayPlaceWithoutPresence(state, playerIndex, card.defId, bf, variant.additionalCostUnitInstanceId))
              continue;
            // Rule 813 narrows a Unit's destinations outside a Neutral Open state to
            // your base or a battlefield you control. Checked here as well as in the
            // validator, via the same shared predicate: without it, enumeration
            // offered a [Reaction] Unit a reinforce destination the validator then
            // refused, and the AI (which trusts legalActions and calls the executor
            // directly) threw on it mid-game.
            if (!mayPlayUnitToBattlefield(state, playerIndex, bf.id, card.defId, card)) continue;
            // The TIMING half, asked per destination — `[Ambush]` grants Reaction
            // into this battlefield specifically (822.1.b). Without it an Ambush
            // unit that passed the card-level gate would be offered at every
            // battlefield, including ones where its controller has nobody.
            if (!mayPlayCardNow(state, playerIndex, card, fromHidden, bf.id)) continue;
          }
          const reinforce: PlayCardAction = {
            type: "PlayCard",
            playerIndex,
            card,
            // The TAXED payment, not the plain one. A Unit's on-play trigger can
            // target — Maddened Marauder's does — and its target is chosen on
            // this same action, so a reinforce variant owes the surcharge exactly
            // as the base-play variant does. Using `variantPayment` here was a
            // real offered-then-refused bug: the AI takes an enumerated action
            // straight to the executor, and self-play threw "must pay 1 rainbow
            // Power for [Deflect] on its target, but named 0" as soon as a
            // Marauder targeted a Deflect unit.
            payment: variantPaymentForTargets,
            ...variant,
            ...hiddenFields,
            destinationBattlefieldId: bf.id,
          };
          if (targetIsElsewhere(bf.id)) actions.push(reinforce);
        }
      }

      // A token-placing Spell (Recruit the Vanguard) fans out the same way,
      // but over battlefields the actor CONTROLS rather than merely occupies
      // — see validate-play-card.ts for why that's a genuinely narrower rule.
      // The base variant is the plain candidate already pushed above.
      if (card.kind === "Spell" && cardPlacesTokens(card.defId)) {
        for (const bf of state.battlefields) {
          if (bf.controllerId !== actor.id) continue;
          // Rockfall Path: "units can't be PLAYED here", and a unit token played
          // to a battlefield is a unit being played — Recruit the Vanguard's own
          // text is "play a 1 Might Recruit unit token". Gated here as well as on
          // the Unit path, because the two reach a destination by different
          // routes and only this one covers a Spell that makes a body.
          if (!mayPlayUnitAt(state, bf.id)) continue;
          // Rule 811 again: "if a hidden spell ... causes you to play a unit, you
          // must CHOOSE to play that unit at that battlefield" — so a from-hidden
          // Sprite Call has exactly one destination, not a choice of them.
          if (fromHidden && bf.id !== fromHiddenBattlefieldId) continue;
          actions.push({
            type: "PlayCard",
            playerIndex,
            card,
            // **The TAXED payment — the same bug the reinforce branch above
            // already fixed, latent here until 2026-08-09.** This read
            // `variantPayment`, and every candidate it pushed omitted a surcharge
            // the validator then demanded. It was unreachable while this table
            // held three cards that could not attract one; adding Desert's Call
            // and Flurry of Feathers made it live, and `hunt-xp` died on "Flurry
            // of Feathers must pay 1 rainbow Power for Vex - Cheerless, but named
            // 0" — a THROW, because the AI takes an enumerated action straight to
            // the executor.
            //
            // Vex - Cheerless's tax is not target-keyed, so it is owed by any
            // spell while she is out — which is why a destination fan-out with no
            // targets at all could still owe one.
            payment: variantPaymentForTargets,
            ...variant,
            destinationBattlefieldId: bf.id,
            ...(fromHiddenBattlefieldId !== undefined ? { fromHiddenBattlefieldId } : {}),
          });
        }
      }
    }
  }

  // Moving and recalling are Neutral-Open-only. [Action]/[Reaction] are card-play
  // permissions and grant nothing here — validateMoveUnit/validateRecallUnit
  // reject outside a Neutral Open state, so enumerating them would offer actions
  // the validator refuses. (It's also why a Reaction Unit can't open a second
  // Showdown inside one: rule 813 confines it to your base or a battlefield you
  // already control.)
  if (!isNeutralOpen) return actions;

  // **Every SUBSET of the units that can reach a destination, not one action per
  // unit.** Rule 144.3: "players may perform multiple Units' standard move
  // simultaneously. This is treated as one game action performed on multiple
  // Units." A one-action-per-unit enumerator can express only the degenerate case,
  // and until 2026-08-14 that is all this did — which left UNL-163 Mageseeker
  // Investigator's applied cost (204.4) reachable by a human client and by nothing
  // else, since his tax starts at the second unit.
  //
  // The eligibility rules are unchanged and still asked PER UNIT, exactly as the
  // two loops this replaced asked them — see `movableTo`. Only the grouping is new.
  //
  // A group the surcharge makes unaffordable is NOT offered. That is 204.4.c ("a
  // player who can't pay cannot perform the associated Game Action") rather than
  // merely this file's usual rule against offering what the validator refuses,
  // though it is both.
  for (const dest of state.battlefields) {
    for (const group of nonEmptySubsets(movableTo(state, playerIndex, dest.id))) {
      const priced = pricedMove(state, playerIndex, dest.id, group);
      if (priced !== undefined) actions.push(priced);
    }
  }

  for (const bf of state.battlefields) {
    const unitsHere = bf.units[actor.id] ?? [];
    for (const unit of unitsHere) {
      if (unit.exhausted) continue;
      // Vex - Apathetic's this-turn lock, asked here as well as in the validator
      // so a locked unit is never OFFERED a move and then refused one.
      if (!unitMayMoveThisTurn(state, unit.instanceId)) continue;

      // Vilemaw's Lair — the same gate `validate-recall-unit` reads, so the two
      // cannot disagree about whether a retreat from here is legal.
      // The per-UNIT door — Determined Sentry is barred from base while every
      // other unit at the same battlefield is not.
      if (unitMayMoveToBase(state, unit, bf.id)) {
        const recall: RecallUnitAction = { type: "RecallUnit", playerIndex, unitInstanceIds: [unit.instanceId] };
        actions.push(recall);
      }

      // The MOVE half of this loop is now the subset fan-out above; what stays
      // here is the RECALL, which is a different Game Action (454 calls it
      // "explicitly not a Move") and keeps its per-unit shape.
    }
  }

  return actions;
}
