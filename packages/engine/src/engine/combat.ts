import type { BattlefieldState, GameState, PlayerState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import { recordConquest } from "./scoring.js";

/**
 * Combat resolution (a "Showdown" in the core rules), ported from
 * ShowdownResolver.java's general-purpose math only — every per-card
 * exception (Stun, Elder Dragon true-kill, death wards, Tryndamere's excess-
 * damage tracking, damage-assignment choice, etc.) is left out, since none
 * of those cards/mechanics exist in this engine yet. Also deliberately
 * skips the real priority/Focus-passing window a Showdown opens for
 * (letting either player respond with instant-speed spells before damage
 * resolves) — combat resolves immediately the instant a unit moves onto a
 * contested battlefield, because no Spell/Reaction timing is modeled yet
 * either. Both are documented gaps to close together once Spells land, not
 * independent oversights.
 */

/** Damage a unit DEALS. Shield is purely defensive and never contributes here —
 *  only [Assault] (attacker-only) does. Mirrors ShowdownResolver.outgoingMight
 *  (engine/ShowdownResolver.java:106-147), minus every named-card exception. */
function outgoingMight(unit: UnitInstance, isAttackingSide: boolean): number {
  const assault = isAttackingSide ? (unit.keywords.Assault ?? 0) : 0;
  return Math.max(0, unit.might + unit.bonus + assault);
}

/** How much MORE damage a unit can absorb before dying. Mirrors
 *  ShowdownResolver.remainingMight (engine/ShowdownResolver.java:235-262),
 *  minus Fiora - Peerless's multiplier and Prevent (no printed card grants
 *  Prevent in this pool yet per Card.Unit.preventValue's own doc comment). */
function remainingMight(unit: UnitInstance, isAttackingSide: boolean): number {
  const kw = isAttackingSide ? (unit.keywords.Assault ?? 0) : (unit.keywords.Shield ?? 0);
  return Math.max(0, unit.might + unit.bonus + kw - unit.damage);
}

/**
 * Assigns `pool` damage across `order` in list order, each target taking up
 * to its own lethal need; any leftover pool dumps onto the last target
 * (overkill). Mirrors ShowdownResolver.distribute (engine/ShowdownResolver.java:349-364),
 * minus Soraka/Backline/Tank reordering (assignedLast) and damage-assignment
 * choice (no interactive assignment modeled — natural unit-list order only).
 */
function distribute(pool: number, order: readonly UnitInstance[], isAttackingSide: boolean): Map<string, number> {
  const pending = new Map<string, number>();
  let remaining = pool;
  for (const target of order) {
    if (remaining <= 0) break;
    const lethal = remainingMight(target, isAttackingSide);
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

function removeDefeated(units: readonly UnitInstance[], isAttackingSide: boolean): UnitInstance[] {
  return units.filter((u) => remainingMight(u, isAttackingSide) > 0);
}

function heal(units: readonly UnitInstance[]): UnitInstance[] {
  return units.map((u) => (u.damage === 0 ? u : { ...u, damage: 0 }));
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

  const attackerPool = attackerUnits.reduce((sum, u) => sum + outgoingMight(u, true), 0);
  const defenderPool = defenderUnits.reduce((sum, u) => sum + outgoingMight(u, false), 0);

  const damageToDefenders = distribute(attackerPool, defenderUnits, false);
  const damageToAttackers = distribute(defenderPool, attackerUnits, true);

  const survivingAttackers = removeDefeated(applyDamage(attackerUnits, damageToAttackers), true);
  const survivingDefenders = removeDefeated(applyDamage(defenderUnits, damageToDefenders), false);

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

  const nextPlayers = state.players.map((p): PlayerState => {
    const defeatedHere = p.id === attacker.id ? defeatedAttackers : p.id === defender.id ? defeatedDefenders : [];
    if (defeatedHere.length === 0) return p;
    return { ...p, trash: [...p.trash, ...defeatedHere] };
  }) as [PlayerState, PlayerState];

  let next: GameState = { ...state, players: nextPlayers, battlefields: nextBattlefields };

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
