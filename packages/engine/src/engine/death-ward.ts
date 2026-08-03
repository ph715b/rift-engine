import type { GameState, PendingDeath, PlayerState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import { computeAutoPayment } from "./rune-payment.js";
import { parkDecision } from "./decisions.js";

/**
 * Highlander's death ward — "the next time it would die this turn, heal
 * it, exhaust it, and recall it instead." Consumed at every point a unit
 * would actually die (dealDamage's lethal branch in effect-helpers.ts,
 * combat.ts's Showdown resolution), instead of the usual trash step.
 */
export function isDeathWarded(state: GameState, unitInstanceId: string): boolean {
  return state.deathWardedUnitInstanceIds.includes(unitInstanceId);
}

/**
 * Zhonya's Hourglass: "If a friendly unit would die, kill this instead. Heal
 * that unit, exhaust it, and recall it."
 *
 * A MANDATORY replacement sourced from a Gear sitting in play, which is why it
 * cannot live in any card registry: nothing dispatches on "a unit would die"
 * except `killUnit` itself, and by then the card is not a listener anywhere —
 * it is a condition on the board. Declared here, where the other death
 * replacement lives, and consumed by killUnit.
 */
export const ZHONYAS_HOURGLASS = "OGN-077";

/** For coverage.ts — the cards this module's rules implement. Highlander's ward
 *  is registered by the card that grants it; the Hourglass has no other home. */
export function deathReplacementDefIds(): string[] {
  return [ZHONYAS_HOURGLASS];
}

/**
 * "Heal it, exhaust it, and recall it" — the payoff every death replacement in
 * this pool spells out identically (Highlander, Sett - The Boss, Zhonya's
 * Hourglass all print the same three words).
 *
 * `unit` should already be removed from wherever it died; this only adds it to
 * baseUnits. A recall, not a move (454), so no vacancy or contest checks.
 *
 * Shared so the three cannot drift on what "recall" resets. It deliberately does
 * NOT clear the Buff: the unit never left play, and 709 only strips buffs on
 * leaving.
 */
export function reviveToBase(state: GameState, unit: UnitInstance, ownerIndex: 0 | 1): GameState {
  const revived: UnitInstance = { ...unit, damage: 0, exhausted: true };
  const players = [...state.players] as [PlayerState, PlayerState];
  players[ownerIndex] = { ...players[ownerIndex], baseUnits: [...players[ownerIndex].baseUnits, revived] };
  return { ...state, players };
}

/** Consumes a unit's ward: revives it as above, and clears the ward so the next
 *  death is a real one ("the NEXT time it would die this turn"). */
export function reviveWithDeathWard(state: GameState, unit: UnitInstance, ownerIndex: 0 | 1): GameState {
  return {
    ...reviveToBase(state, unit, ownerIndex),
    deathWardedUnitInstanceIds: state.deathWardedUnitInstanceIds.filter((id) => id !== unit.instanceId),
  };
}

/**
 * Unlicensed Armory's ward — the same three words as Highlander's, but OPTIONAL
 * and PAID: "the next time it would die this turn, you MAY PAY [Fury] to heal
 * it, exhaust it, and recall it instead."
 *
 * Its own list rather than a flag on `deathWardedUnitInstanceIds`, because the
 * two behave differently at the moment of death: the free ward simply replaces
 * the death, this one has to stop and ask. Reading a paid ward out of the free
 * list would silently save units nobody paid for.
 */
export const UNLICENSED_ARMORY = "OGN-023";
export const ARMORY_WARD_POWER = { domain: "Fury", count: 1 } as const;

/**
 * Offers an armed Armory ward, or undefined when there is none to offer.
 *
 * Checks payability BEFORE parking, the same 416.3 discipline
 * `offerDeathReplacement` follows — a player with no Fury is not asked a
 * question whose only answer is "no".
 */
export function offerPaidDeathWard(state: GameState, death: PendingDeath): GameState | undefined {
  if (!state.paidDeathWardUnitInstanceIds.includes(death.unit.instanceId)) return undefined;
  const owner = state.players[death.ownerIndex];
  // `null`, not undefined — computeAutoPayment's own failure value, the same
  // comparison Sett's offer records having got wrong once.
  if (computeAutoPayment(owner.channeled, 0, ARMORY_WARD_POWER.count, ARMORY_WARD_POWER.domain) === null) return undefined;

  const held: GameState = {
    ...state,
    unitsAwaitingDeathReplacement: [...state.unitsAwaitingDeathReplacement, death],
  };
  return parkDecision(held, {
    kind: "OGN-023-save",
    playerIndex: death.ownerIndex,
    targetInstanceId: death.unit.instanceId,
  });
}

/** The held death a replacement decision is about, if it is still waiting.
 *  Shared by every optional replacement — Sett's and the Armory's — so "which
 *  death is this question about" has one answer. */
export function pendingDeathFor(state: GameState, unitInstanceId: string | undefined): PendingDeath | undefined {
  if (unitInstanceId === undefined) return undefined;
  return state.unitsAwaitingDeathReplacement.find((p) => p.unit.instanceId === unitInstanceId);
}

/** Releases a held death from the waiting list — called by both branches of a
 *  replacement decision, since either way the question is now answered. */
export function releasePendingDeath(state: GameState, unitInstanceId: string): GameState {
  return {
    ...state,
    unitsAwaitingDeathReplacement: state.unitsAwaitingDeathReplacement.filter((p) => p.unit.instanceId !== unitInstanceId),
  };
}

/** Consumes an Armory ward — "the NEXT time", so it is spent whether or not the
 *  save was taken. */
export function clearPaidDeathWard(state: GameState, unitInstanceId: string): GameState {
  return {
    ...state,
    paidDeathWardUnitInstanceIds: state.paidDeathWardUnitInstanceIds.filter((id) => id !== unitInstanceId),
  };
}
