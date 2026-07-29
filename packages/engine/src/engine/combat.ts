import type { BattlefieldState, GameState, PlayerState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import { recordConquest } from "./scoring.js";
import { effectiveMight } from "./effective-might.js";
import { isDeathWarded, reviveWithDeathWard } from "./death-ward.js";

/**
 * Combat resolution (a "Showdown" in the core rules), ported from
 * ShowdownResolver.java's general-purpose math only — every per-card
 * exception (Stun, Elder Dragon true-kill, death wards, Tryndamere's excess-
 * damage tracking, damage-assignment choice, etc.) is left out, since none
 * of those cards/mechanics exist in this engine yet.
 *
 * This module is pure combat math — it has no knowledge of the Focus
 * priority window a Showdown opens for before this ever runs (execute-move-
 * unit.ts opens the window; execute-pass-focus.ts calls resolveShowdown once
 * two consecutive passes close it). What's still not modeled is the full
 * spell-chain/reaction system: no card can yet respond mid-Showdown, since
 * no Spell/Reaction timing exists yet either — that's the remaining
 * documented gap, deferred until Spells/Gear/Legend abilities are playable.
 */

/** Damage a unit DEALS. Shield is purely defensive and never contributes here —
 *  only [Assault] (attacker-only) does. Mirrors ShowdownResolver.outgoingMight
 *  (engine/ShowdownResolver.java:106-147), minus every named-card exception.
 *  Routes through effectiveMight (engine/effective-might.ts) for the
 *  keyword math AND any continuous aura (Garen - Commander, etc.) — this is
 *  "outgoing," not "remaining," so damage is never subtracted here. */
function outgoingMight(state: GameState, unit: UnitInstance, ownerIndex: 0 | 1, battlefieldId: string, isAttackingSide: boolean): number {
  return effectiveMight(state, unit, ownerIndex, { isCombat: true, isAttackingSide, combatRole: "outgoing", battlefieldId });
}

/** How much MORE damage a unit can absorb before dying. Mirrors
 *  ShowdownResolver.remainingMight (engine/ShowdownResolver.java:235-262),
 *  minus Fiora - Peerless's multiplier and Prevent (no printed card grants
 *  Prevent in this pool yet per Card.Unit.preventValue's own doc comment). */
function remainingMight(state: GameState, unit: UnitInstance, ownerIndex: 0 | 1, battlefieldId: string, isAttackingSide: boolean): number {
  return Math.max(0, effectiveMight(state, unit, ownerIndex, { isCombat: true, isAttackingSide, combatRole: "remaining", battlefieldId }) - unit.damage);
}

/**
 * Assigns `pool` damage across `order` in list order, each target taking up
 * to its own lethal need; any leftover pool dumps onto the last target
 * (overkill). Mirrors ShowdownResolver.distribute (engine/ShowdownResolver.java:349-364),
 * minus Soraka/Backline/Tank reordering (assignedLast) and damage-assignment
 * choice (no interactive assignment modeled — natural unit-list order only).
 */
function distribute(
  state: GameState,
  pool: number,
  order: readonly UnitInstance[],
  ownerIndex: 0 | 1,
  battlefieldId: string,
  isAttackingSide: boolean,
): Map<string, number> {
  const pending = new Map<string, number>();
  let remaining = pool;
  for (const target of order) {
    if (remaining <= 0) break;
    const lethal = remainingMight(state, target, ownerIndex, battlefieldId, isAttackingSide);
    const hit = Math.min(remaining, lethal);
    pending.set(target.instanceId, (pending.get(target.instanceId) ?? 0) + hit);
    remaining -= hit;
  }
  if (remaining > 0 && order.length > 0) {
    const last = order[order.length - 1]!;
    pending.set(last.instanceId, (pending.get(last.instanceId) ?? 0) + remaining);
  }
  return pending;
}

function applyDamage(units: readonly UnitInstance[], pending: Map<string, number>): UnitInstance[] {
  return units.map((u) => {
    const dmg = pending.get(u.instanceId);
    return dmg ? { ...u, damage: u.damage + dmg } : u;
  });
}

function removeDefeated(
  state: GameState,
  units: readonly UnitInstance[],
  ownerIndex: 0 | 1,
  battlefieldId: string,
  isAttackingSide: boolean,
): UnitInstance[] {
  return units.filter((u) => remainingMight(state, u, ownerIndex, battlefieldId, isAttackingSide) > 0);
}

function heal(units: readonly UnitInstance[]): UnitInstance[] {
  return units.map((u) => (u.damage === 0 ? u : { ...u, damage: 0 }));
}

/** A defeated unit is a "death" too — checked against Highlander's ward
 *  (death-ward.ts) the same way dealDamage/destroyUnit are (effect-helpers.ts),
 *  reviving instead of trashing when warded. */
function processDefeated(state: GameState, defeated: readonly UnitInstance[], ownerIndex: 0 | 1): GameState {
  let next = state;
  for (const unit of defeated) {
    if (isDeathWarded(next, unit.instanceId)) {
      next = reviveWithDeathWard(next, unit, ownerIndex);
    } else {
      const players = [...next.players] as [PlayerState, PlayerState];
      players[ownerIndex] = { ...players[ownerIndex], trash: [...players[ownerIndex].trash, unit] };
      next = { ...next, players };
    }
  }
  return next;
}

/**
 * Resolves combat at `battlefieldId` between `attackerIndex` (whoever just
 * moved a unit in) and the other player. Mirrors
 * ShowdownResolver.resolveWithAssignments (engine/ShowdownResolver.java:24-90).
 * No-ops if fewer than 2 players actually have units there (nothing to fight).
 */
export function resolveShowdown(state: GameState, battlefieldId: string, attackerIndex: 0 | 1): GameState {
  const defenderIndex: 0 | 1 = attackerIndex === 0 ? 1 : 0;
  const bfIndex = state.battlefields.findIndex((b) => b.id === battlefieldId);
  const bf = state.battlefields[bfIndex];
  if (!bf) throw new Error(`No battlefield with id ${battlefieldId}`);

  const attacker = state.players[attackerIndex];
  const defender = state.players[defenderIndex];
  const attackerUnits = bf.units[attacker.id] ?? [];
  const defenderUnits = bf.units[defender.id] ?? [];
  if (attackerUnits.length === 0 || defenderUnits.length === 0) return state;

  const attackerPool = attackerUnits.reduce((sum, u) => sum + outgoingMight(state, u, attackerIndex, battlefieldId, true), 0);
  const defenderPool = defenderUnits.reduce((sum, u) => sum + outgoingMight(state, u, defenderIndex, battlefieldId, false), 0);

  const damageToDefenders = distribute(state, attackerPool, defenderUnits, defenderIndex, battlefieldId, false);
  const damageToAttackers = distribute(state, defenderPool, attackerUnits, attackerIndex, battlefieldId, true);

  const survivingAttackers = removeDefeated(state, applyDamage(attackerUnits, damageToAttackers), attackerIndex, battlefieldId, true);
  const survivingDefenders = removeDefeated(state, applyDamage(defenderUnits, damageToDefenders), defenderIndex, battlefieldId, false);

  const defeatedAttackers = attackerUnits.filter((u) => !survivingAttackers.some((s) => s.instanceId === u.instanceId));
  const defeatedDefenders = defenderUnits.filter((u) => !survivingDefenders.some((s) => s.instanceId === u.instanceId));

  const nextBattlefields = [...state.battlefields];
  nextBattlefields[bfIndex] = {
    ...bf,
    units: {
      ...bf.units,
      [attacker.id]: heal(survivingAttackers),
      [defender.id]: heal(survivingDefenders),
    },
  };

  let next: GameState = { ...state, battlefields: nextBattlefields };
  next = processDefeated(next, defeatedAttackers, attackerIndex);
  next = processDefeated(next, defeatedDefenders, defenderIndex);

  const attackerSurvived = survivingAttackers.length > 0;
  const defenderSurvived = survivingDefenders.length > 0;
  if (attackerSurvived && !defenderSurvived) {
    next = updateControl(next, bfIndex, attackerIndex);
  } else if (defenderSurvived && !attackerSurvived) {
    next = updateControl(next, bfIndex, defenderIndex);
  } else if (!attackerSurvived && !defenderSurvived) {
    next = setController(next, bfIndex, null);
  }
  // A tie (both sides have survivors) — no control change. Mirrors updateControl's
  // `else` branch (engine/ShowdownResolver.java:442-456), minus Symbol of the Solari.

  return next;
}

function setController(state: GameState, bfIndex: number, controllerId: string | null): GameState {
  const battlefields = [...state.battlefields];
  battlefields[bfIndex] = { ...battlefields[bfIndex]!, controllerId };
  return { ...state, battlefields };
}

function updateControl(state: GameState, bfIndex: number, winnerIndex: 0 | 1): GameState {
  const bf = state.battlefields[bfIndex]!;
  const winner = state.players[winnerIndex];
  const isConquest = bf.controllerId !== winner.id;
  const next = setController(state, bfIndex, winner.id);
  return isConquest ? recordConquest(next, winnerIndex, bf.id) : next;
}

/**
 * Claims sole control of a battlefield for `winnerIndex` (a walk-in — the
 * uncontested-after-move case), recording a conquest if control actually
 * changed hands. Shared with executeMoveUnit's own uncontested branch.
 * Mirrors ActionExecutor.executeMoveUnit's `if (!dest.isContested())`
 * branch (engine/ActionExecutor.java:870-889).
 */
export function claimBattlefieldControl(state: GameState, battlefieldId: string, winnerIndex: 0 | 1): GameState {
  const bfIndex = state.battlefields.findIndex((b) => b.id === battlefieldId);
  if (bfIndex === -1) throw new Error(`No battlefield with id ${battlefieldId}`);
  return updateControl(state, bfIndex, winnerIndex);
}
