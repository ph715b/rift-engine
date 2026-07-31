import type { GameState, PlayerState } from "../model/game-state.js";
import type { GearInstance, UnitInstance } from "../model/card.js";
import { contextFor, type EffectContext } from "./effect-context.js";
import { giveMightThisTurn, giveMightThisTurnToOwnUnit, recycleFromTrash } from "./effect-helpers.js";
import { type TargetingSpec } from "./card-effects.js";

/**
 * Abilities you activate by exhausting the permanent that has them — the
 * ":rb_exhaust::" cost printed on a third of this card pool.
 *
 * This replaces a single hardcoded case. validate-activate-ability.ts carried
 * `ACTIVATABLE_UNIT_DEF_IDS = new Set(["OGS-014"])` and execute-activate-ability
 * carried Lux - Crownguard's effect inline, with a comment saying to widen it
 * "the day a second activated-ability card is implemented". This is that day, and
 * the widening is a registry rather than a second branch because of the shape of
 * what's left: 20 of the 30 Gear in this pool are exactly "exhaust: do one thing",
 * and none of them could be reached at all before — the action only ever looked at
 * units.
 */

/** Where an activated ability lives. Gear and Units take the same action and pay
 *  the same exhaust cost; they differ only in which zone the permanent sits in,
 *  which is why one registry can serve both. */
export type ActivatableKind = "Unit" | "Gear";

export interface ActivatedAbilityEvent {
  /** Chosen ahead of the action, same constraint as every other effect in this
   *  engine — it cannot pause mid-resolution to ask. */
  targetUnitInstanceId?: string;
}

/**
 * What activating costs. Every ability in this pool so far exhausts its source,
 * but that is not universal — Vi - Destructive reads "Recycle 1 from your trash:"
 * with no exhaust symbol at all, so it is repeatable while the trash lasts.
 * Assuming the exhaust would have quietly made her once per turn.
 */
export interface ActivationCost {
  /** Exhaust the source. Absent means the ability does NOT exhaust. */
  exhaust?: true;
  /** Recycle this many cards from the controller's own trash (rule 416). */
  recycleFromTrash?: number;
}

export interface ActivatedAbilityDefinition {
  kind: ActivatableKind;
  /** Defaults to `{ exhaust: true }` when omitted — the common case. */
  cost?: ActivationCost;
  /**
   * True when the ability banks a resource for a later play rather than changing
   * the board — Lux - Crownguard's "+2 Energy, spells only" is the whole category
   * today.
   *
   * The heuristic AI needs this. It filters candidates it has no evaluative basis
   * for, and `evaluate` scores board state only, so an ability that merely stores
   * Energy would score a meaningless tie with Pass. That reasoning was originally
   * written as a blanket "skip every ActivateAbility", which was correct while the
   * only such ability banked a resource and became wrong the moment a gear ability
   * moved Might — a change `evaluate` can see perfectly well. Flagging the
   * resource-bankers keeps the original judgement and drops the overreach.
   */
  banksResource?: true;
  /** What the player must choose before submitting. Reuses card-effects.ts's
   *  TargetingSpec so legal-actions' existing fan-out and the web UI's existing
   *  target picker both apply unchanged. */
  targeting: TargetingSpec;
  /** `sourceInstanceId` is the permanent being activated — needed by any ability
   *  whose text says "me" rather than naming a target. */
  resolve: (state: GameState, ctx: EffectContext, event: ActivatedAbilityEvent, sourceInstanceId: string) => GameState;
}

/**
 * Lux - Crownguard: "Exhaust: Add 2 Energy. Use only to play spells."
 *
 * Moved here verbatim from execute-activate-ability.ts — the granted Energy still
 * lands in PlayerState.restrictedSpellEnergy, the separate pool that only Spell
 * costs may drain (rune-payment.ts's computeEffectiveCost). Behaviour is
 * unchanged; only where it lives moved.
 */
const LUX_CROWNGUARD = "OGS-014";

/** Orb of Regret: "Exhaust: Give a unit -1 Might this turn, to a minimum of 1
 *  Might." The first Gear in this engine that does anything at all. */
const ORB_OF_REGRET = "OGN-090";

/** Vi - Destructive: "Recycle 1 from your trash: Give me +1 Might this turn."
 *  The first ability whose cost is NOT an exhaust. */
const VI_DESTRUCTIVE = "OGN-036";

const ACTIVATED_ABILITIES: Record<string, ActivatedAbilityDefinition> = {
  [LUX_CROWNGUARD]: {
    kind: "Unit",
    targeting: { kind: "none" },
    banksResource: true,
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = { ...actor, restrictedSpellEnergy: actor.restrictedSpellEnergy + 2 };
      return { ...state, players };
    },
  },
  [VI_DESTRUCTIVE]: {
    kind: "Unit",
    // "Recycle 1 from your trash: Give me +1 Might this turn." No exhaust symbol,
    // so `cost` names only the recycle — she can do this repeatedly as long as
    // the trash holds cards, which is the card's whole texture. Defaulting to an
    // exhaust here would have capped her at once per turn.
    cost: { recycleFromTrash: 1 },
    // "Give ME" — no target to choose.
    targeting: { kind: "none" },
    resolve: (state, ctx, _event, sourceInstanceId) =>
      giveMightThisTurnToOwnUnit(state, ctx.casterIndex, sourceInstanceId, 1),
  },
  [ORB_OF_REGRET]: {
    kind: "Gear",
    // "A unit" names no battlefield and no owner, so a unit in either player's
    // base is a legal target — the same reading base-targeting.test.ts already
    // pins for En Garde and Stupefy.
    targeting: { kind: "unit", scope: "anywhere" },
    // The floor is the card's own clause, not a safety net: giveMightThisTurn's
    // `floor` argument exists for exactly this wording, and it caps the stored
    // modifier rather than only the displayed Might, so repeated activations
    // can't dig a hole a later buff has to climb out of.
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId ? giveMightThisTurn(state, event.targetUnitInstanceId, -1, 1) : state,
  },
};

export function activatedAbilityFor(defId: string): ActivatedAbilityDefinition | undefined {
  return ACTIVATED_ABILITIES[defId];
}

export function hasActivatableAbility(defId: string): boolean {
  return defId in ACTIVATED_ABILITIES;
}

/** What activating `defId` costs, with the common `{ exhaust: true }` default
 *  made explicit so no caller has to remember it. */
export function activationCostOf(defId: string): ActivationCost {
  return ACTIVATED_ABILITIES[defId]?.cost ?? { exhaust: true };
}

/**
 * Can `playerIndex` pay this ability's cost right now?
 *
 * Both halves are real refusals, not do-as-much-as-you-can: an exhausted source
 * can't pay an exhaust, and rule 416.3 says a Recycle cost "must be able to be
 * completed for the cost to be paid". Shared by the validator and the
 * enumerator so an ability is never offered and then refused.
 */
export function canPayActivationCost(state: GameState, playerIndex: 0 | 1, card: { defId: string; exhausted: boolean }): boolean {
  const cost = activationCostOf(card.defId);
  if (cost.exhaust && card.exhausted) return false;
  if (cost.recycleFromTrash !== undefined && state.players[playerIndex].trash.length < cost.recycleFromTrash) return false;
  return true;
}

/** Pays an activation cost, or returns undefined if it cannot be paid. */
export function payActivationCost(state: GameState, playerIndex: 0 | 1, instanceId: string, defId: string): GameState | undefined {
  const cost = activationCostOf(defId);
  let next = state;
  if (cost.recycleFromTrash !== undefined) {
    const recycled = recycleFromTrash(next, playerIndex, cost.recycleFromTrash);
    if (recycled === undefined) return undefined;
    next = recycled;
  }
  if (cost.exhaust) next = exhaustActivated(next, playerIndex, instanceId);
  return next;
}

/** Does this ability only bank a resource? See `banksResource` — the AI skips
 *  these because a board-state evaluator cannot price them. */
export function abilityBanksResource(defId: string): boolean {
  return ACTIVATED_ABILITIES[defId]?.banksResource === true;
}

/** Targeting for an activated ability, defaulting to "none" — same shape and
 *  default as targetingForCard, so callers can treat the two alike. */
export function activatedAbilityTargeting(defId: string): TargetingSpec {
  return ACTIVATED_ABILITIES[defId]?.targeting ?? { kind: "none" };
}

/** Every defId with an activated ability, for coverage.ts. */
export function activatedAbilityDefIds(): string[] {
  return Object.keys(ACTIVATED_ABILITIES);
}

/** A permanent `playerIndex` controls that could be activated right now, found by
 *  instanceId across all three zones an activatable thing can sit in. Shared by
 *  the validator and the executor so "can I?" and "do it" can't disagree about
 *  where things are. */
export function findActivatable(
  state: GameState,
  playerIndex: 0 | 1,
  instanceId: string,
): { card: UnitInstance | GearInstance; definition: ActivatedAbilityDefinition } | undefined {
  const actor = state.players[playerIndex];
  const candidates: (UnitInstance | GearInstance)[] = [
    ...actor.baseUnits,
    ...state.battlefields.flatMap((bf) => bf.units[actor.id] ?? []),
    ...actor.activeGear,
  ];
  const card = candidates.find((c) => c.instanceId === instanceId);
  if (!card) return undefined;
  const definition = ACTIVATED_ABILITIES[card.defId];
  return definition ? { card, definition } : undefined;
}

/** Exhausts the activated permanent, wherever it lives. The exhaust IS the cost
 *  (rule: an exhaust symbol in a cost line), so this runs whether or not the
 *  effect ends up doing anything — a fizzled target does not refund it. */
export function exhaustActivated(state: GameState, playerIndex: 0 | 1, instanceId: string): GameState {
  const players = [...state.players] as [PlayerState, PlayerState];
  const actor = players[playerIndex];
  const exhaust = <T extends { instanceId: string; exhausted: boolean }>(c: T): T =>
    c.instanceId === instanceId ? { ...c, exhausted: true } : c;

  players[playerIndex] = {
    ...actor,
    baseUnits: actor.baseUnits.map(exhaust),
    activeGear: actor.activeGear.map(exhaust),
  };

  const battlefields = state.battlefields.map((bf) => {
    const mine = bf.units[actor.id];
    if (!mine) return bf;
    return { ...bf, units: { ...bf.units, [actor.id]: mine.map(exhaust) } };
  });

  return { ...state, players, battlefields };
}
