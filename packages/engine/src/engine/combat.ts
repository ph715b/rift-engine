import type { BattlefieldState, GameState, PlayerState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import { recordConquest } from "./scoring.js";
import { effectiveMight } from "./effective-might.js";
import { healAllUnits, killUnit, relocateToBaseUnchanged } from "./effect-helpers.js";
import { clearContested } from "./cleanup.js";

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
 * The order damage is assigned in: `[Tank]` units first, everything else after,
 * stable within each group.
 *
 * Rule (Tank keyword): "I must be assigned lethal damage before any other unit
 * with the same controller as me that does not have [Tank] during the Combat
 * Damage step." Since `distribute` below fills each target to lethal before
 * moving on, putting Tanks at the front of the list IS that rule — a Tank
 * soaks a full lethal allocation before anything behind it takes a point.
 *
 * Three precon units have it (Maddened Marauder, Lecturing Yordle, Stormclaw
 * Ursine), so this was affecting real games: the keyword parsed into the model
 * and then changed nothing.
 *
 * `[Backline]` is the mirror ("assigned last") and is deliberately absent — it's
 * an UNL-set keyword with no card in this pool, and the keyword model's own doc
 * comment defers that set. It slots in here as a second sort tier when it lands.
 *
 * The rules let the ASSIGNING player choose freely within these constraints;
 * this engine has no interactive assignment, so within a tier the natural
 * unit-list order stands in for that choice.
 */
function assignmentOrder(units: readonly UnitInstance[]): readonly UnitInstance[] {
  const tanks = units.filter((u) => "Tank" in u.keywords);
  if (tanks.length === 0 || tanks.length === units.length) return units; // nothing to reorder
  return [...tanks, ...units.filter((u) => !("Tank" in u.keywords))];
}

/**
 * Assigns `pool` damage across `order` in list order, each target taking up
 * to its own lethal need; any leftover pool dumps onto the last target
 * (overkill).
 *
 * This is rule 465.2.c's assignment model, not an approximation of it: "Units
 * must have lethal damage assigned to them in full before damage is assigned to
 * a different Unit" (so `min(remaining, lethal)` then move on, never spreading),
 * "Units cannot have more damage assigned to them than the minimum required to
 * constitute lethal damage unless no further units remain" (hence the cap, and
 * the overkill dump only onto the last), and lethal counts damage already marked
 * (`remainingMight` subtracts `unit.damage`). Mirrors
 * ShowdownResolver.distribute (engine/ShowdownResolver.java:349-364).
 *
 * Callers pass an `assignmentOrder`-sorted list, which is where Tank applies.
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


/**
 * A defeated unit is a "death" too, so it goes through the same funnel as
 * dealDamage and destroyUnit — killUnit (effect-helpers.ts), which handles the
 * ward, strips the Buff, trashes, and fires [Deathknell].
 *
 * This used to inline the ward-or-trash choice itself, which was fine while
 * dying had no consequences beyond changing zones. It stopped being fine with
 * rule 808: a unit killed in combat has to fire its Deathknell exactly like one
 * killed by a spell, and the surest way to get that wrong is to have two places
 * that decide what dying means.
 *
 * `removeDefeated` has already taken these units off the battlefield, so
 * killUnit's contract ("already removed from wherever it was") holds.
 */
function processDefeated(
  state: GameState,
  defeated: readonly UnitInstance[],
  ownerIndex: 0 | 1,
  battlefieldId: string,
): GameState {
  let next = state;
  for (const unit of defeated) {
    next = killUnit(next, unit, ownerIndex, battlefieldId);
  }
  return next;
}

/**
 * Closes the open Showdown — the single exit point for "all players passed in
 * sequence" (349), dispatching on which kind of Showdown it was.
 *
 * A Showdown is a window, not a fight. Rule 351.1: "If it is a Combat Showdown,
 * proceed with the remaining steps of Combat to resolve the phase." Rule 352.1:
 * "If it is a Non-Combat Showdown... If only one player's Units remain at the
 * Battlefield, and if that player does not already Control the Battlefield, that
 * player establishes Control over the Battlefield" — which "results in a Conquer
 * if that player has not yet scored that Battlefield this turn".
 *
 * The Non-Combat outcome is what `executeMoveUnit` used to do inline and
 * instantly, skipping the window; `claimBattlefieldControl` is reused so the
 * Conquer bookkeeping (recordConquest, including the final-point rule) is
 * literally the same code as before.
 *
 * Contested clears here rather than when the window merely ends, because 190.6.a
 * ties it to Control being "established or re-established".
 */
export function closeShowdown(state: GameState): GameState {
  const battlefieldId = state.showdownBattlefieldId;
  if (battlefieldId === null) return state;

  const resolved =
    state.showdownKind === "Combat"
      ? resolveShowdown(state, battlefieldId, state.activePlayerIndex)
      : resolveNonCombatShowdown(state, battlefieldId);

  return clearContested(resolved, battlefieldId);
}

/** Rule 352.1 — the Non-Combat Showdown's only outcome. "Only one player's
 *  Units remain" is the whole test: nobody there leaves control alone (the
 *  cleanup's own lapse step handles an emptied battlefield), and both players
 *  there can't happen, since that would have been promoted to a Combat Showdown
 *  in a Cleanup (317.2) before it could close. */
function resolveNonCombatShowdown(state: GameState, battlefieldId: string): GameState {
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  if (!bf) return state;
  const present = ([0, 1] as const).filter((index) => (bf.units[state.players[index].id]?.length ?? 0) > 0);
  if (present.length !== 1) return state;
  return claimBattlefieldControl(state, battlefieldId, present[0]!);
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

  // Tank-first on BOTH sides — the keyword is about a unit's own controller's
  // assignment order, so it applies whichever side is being assigned damage.
  const damageToDefenders = distribute(state, attackerPool, assignmentOrder(defenderUnits), defenderIndex, battlefieldId, false);
  const damageToAttackers = distribute(state, defenderPool, assignmentOrder(attackerUnits), attackerIndex, battlefieldId, true);

  const survivingAttackers = removeDefeated(state, applyDamage(attackerUnits, damageToAttackers), attackerIndex, battlefieldId, true);
  const survivingDefenders = removeDefeated(state, applyDamage(defenderUnits, damageToDefenders), defenderIndex, battlefieldId, false);

  const defeatedAttackers = attackerUnits.filter((u) => !survivingAttackers.some((s) => s.instanceId === u.instanceId));
  const defeatedDefenders = defenderUnits.filter((u) => !survivingDefenders.some((s) => s.instanceId === u.instanceId));

  const nextBattlefields = [...state.battlefields];
  nextBattlefields[bfIndex] = {
    ...bf,
    units: {
      ...bf.units,
      [attacker.id]: survivingAttackers,
      [defender.id]: survivingDefenders,
    },
  };

  let next: GameState = { ...state, battlefields: nextBattlefields };
  next = processDefeated(next, defeatedAttackers, attackerIndex, battlefieldId);
  next = processDefeated(next, defeatedDefenders, defenderIndex, battlefieldId);

  // ── Combat Cleanup, rule 466 Step 3 ────────────────────────────────────
  // 3c. "Heal all Units" — GLOBAL, not just the units that fought here: a
  // unit softened by a Spell at another battlefield, or standing in base,
  // heals too. Only reached after a real exchange; the uncontested
  // early-return above performs no cleanup and so heals nothing (352).
  next = healAllUnits(next);

  // 3d. "Recall Attackers present at the Battlefield if Defenders are still
  // present." Failing to clear a defended battlefield sends your attackers
  // home — without this they sat there contesting it forever, since a
  // showdown only resolves once per move. Ordered after 3c, so they arrive
  // healed. A Recall is not a Move (454): no move triggers fire, which is why
  // this calls relocateToBaseUnchanged and NOT dispatchOnMove — Traveling
  // Merchant must not discard/draw and Noxian Drummer must not make a token.
  const defendersRemain = survivingDefenders.length > 0;
  if (defendersRemain && survivingAttackers.length > 0) {
    for (const unit of survivingAttackers) next = relocateToBaseUnchanged(next, unit.instanceId);
  }

  // Rule 466.5.d ("if No Result and both players have units remaining, stage a
  // Showdown and a Combat here") is unreachable in a 2-player game: 3d removes
  // the attackers exactly when defenders remain, so both sides can never still
  // be present afterward. It exists for multiplayer, where a third player's
  // units can be at the battlefield. Deliberately not implemented.

  // ── Establish control, rule 466.7 ──────────────────────────────────────
  // The rules ask one question, not three: whoever still has units here takes
  // control if they didn't already, and if nobody does the battlefield becomes
  // Uncontrolled. Establishing control is a Conquer when that battlefield
  // hasn't been scored this turn (469.1) — recordConquest owns that check.
  return establishControlAfterCombat(next, bfIndex);
}

/** Rule 466.7: the player with units remaining here Establishes Control if
 *  they didn't already have it; with no units left from anyone, the
 *  battlefield becomes Uncontrolled. Replaces a three-way branch on who
 *  survived, which had no answer for "both survived" — that case is now
 *  resolved by step 3d having already sent the attackers home. */
function establishControlAfterCombat(state: GameState, bfIndex: number): GameState {
  const bf = state.battlefields[bfIndex]!;
  const playersPresent = ([0, 1] as const).filter((index) => (bf.units[state.players[index].id]?.length ?? 0) > 0);

  if (playersPresent.length === 0) return setController(state, bfIndex, null);
  if (playersPresent.length === 1) return updateControl(state, bfIndex, playersPresent[0]!);
  // Both present — only possible in a shape 3d rules out (see above). Leave
  // control alone rather than inventing an outcome.
  return state;
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
