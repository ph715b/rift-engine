import type { GameState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import type { GameEvent, Listener } from "./triggers.js";

/**
 * Who is attacking and who is defending at a Combat Showdown — the one place
 * that answers it, for every card whose text says "when I attack" or "when I
 * defend".
 *
 * Rule 465's Combat Step 1 defines both sides in a single sentence: "The
 * Attacker is the player whose Unit(s) applied the Contested status to the
 * Battlefield... Units at the Contested Battlefield controlled by the Attacker
 * or Defender gain the Attacker or Defender designation now." So the Attacker is
 * `contestedByIndex` — literally the field 458 sets — and everyone else standing
 * there is defending.
 *
 * **The designation is handed out per UNIT PRESENT, not per unit that moved.**
 * That is the whole reason these predicates exist as a shared module rather than
 * as a filter inside the move executor: a unit already holding the battlefield
 * when a friend walks in and starts the fight gains the Attacker designation too,
 * and the old move-time dispatch could not see it.
 *
 * `contestedByIndex` is still set at this moment: `cleanup.clearContested` runs
 * only when the Showdown CLOSES (190.6.a), so it survives the whole window these
 * predicates are asked in.
 *
 * Shared by each listener's `applies` and its `resolve` so the two cannot drift.
 * Both need it, and for different reasons: `applies` decides whether the ability
 * TRIGGERED at all (383 fixes that at the moment of the event), while `resolve`
 * runs a response window later, by which time the unit may have been moved off
 * the battlefield it was attacking.
 */

/** 465's Attacker: the player whose units applied Contested here. `null` when
 *  the battlefield is unknown or not contested, which is not a combat at all. */
export function attackerIndexAt(state: GameState, battlefieldId: string): 0 | 1 | null {
  return state.battlefields.find((b) => b.id === battlefieldId)?.contestedByIndex ?? null;
}

/** Every unit that gains the Attacker designation at `battlefieldId` — the
 *  Attacker's own units standing there, in board order. Used by the Legend hook,
 *  which fires per attacking unit and is not reached by the listener walk. */
export function attackingUnitsAt(state: GameState, battlefieldId: string): UnitInstance[] {
  const attackerIndex = attackerIndexAt(state, battlefieldId);
  if (attackerIndex === null) return [];
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  return [...(bf?.units[state.players[attackerIndex].id] ?? [])];
}

/** Shared by both predicates: is this listener a UNIT standing at the
 *  battlefield this combat opened at? A Gear listener ("when a friendly unit
 *  attacks") is deliberately excluded — it is not a combatant, and Mask of
 *  Foresight asks its own question about the units instead. */
function isCombatantAt(listener: Listener, event: GameEvent): event is Extract<GameEvent, { kind: "combatBegan" }> {
  return event.kind === "combatBegan" && listener.card.kind === "Unit" && listener.battlefieldId === event.battlefieldId;
}

/** "When I attack" — this listener is a unit on the side that applied Contested. */
export function isAttackingAt(state: GameState, listener: Listener, event: GameEvent): boolean {
  if (!isCombatantAt(listener, event)) return false;
  return attackerIndexAt(state, event.battlefieldId) === listener.ownerIndex;
}

/** "When I defend" — this listener is a unit at the contested battlefield on the
 *  other side. Asked as "contested by SOMEONE, and not by me" rather than as
 *  "not attacking", so a battlefield that is not contested at all produces
 *  neither an attacker nor a defender. */
export function isDefendingAt(state: GameState, listener: Listener, event: GameEvent): boolean {
  if (!isCombatantAt(listener, event)) return false;
  const attackerIndex = attackerIndexAt(state, event.battlefieldId);
  return attackerIndex !== null && attackerIndex !== listener.ownerIndex;
}

/** "When I attack OR defend" — Ahri - Inquisitive, whose text does not care which
 *  side started the fight, only that she is in it. Written as its own predicate
 *  rather than as `isAttackingAt || isDefendingAt` at the call site so that the
 *  cards which deliberately ignore the designation say so once, in a name. */
export function isFightingAt(state: GameState, listener: Listener, event: GameEvent): boolean {
  return isAttackingAt(state, listener, event) || isDefendingAt(state, listener, event);
}
