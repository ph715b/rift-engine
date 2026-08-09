import type { GameState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import type { GameEvent, Listener } from "./triggers.js";

/**
 * Who is attacking and who is defending at a Combat Showdown — the one place
 * that answers it, for every card whose text says "when I attack" or "when I
 * defend".
 *
 * Rule 464.2.c's Combat Step 1 defines both sides in a single sentence: "The
 * Attacker is the player whose Unit(s) applied the Contested status to the
 * Battlefield... Units at the Contested Battlefield controlled by the Attacker
 * or Defender gain the Attacker or Defender designation now." So the Attacker is
 * `contestedByIndex` — literally the field 450 sets — and everyone else standing
 * there is defending.
 *
 * **The designation is handed out per UNIT PRESENT, not per unit that moved.**
 * That is the whole reason these predicates exist as a shared module rather than
 * as a filter inside the move executor: a unit already holding the battlefield
 * when a friend walks in and starts the fight gains the Attacker designation too,
 * and the old move-time dispatch could not see it.
 *
 * `contestedByIndex` is still set at this moment: `cleanup.clearContested` runs
 * only when the Showdown CLOSES (190.3.b), so it survives the whole window these
 * predicates are asked in.
 *
 * Shared by each listener's `applies` and its `resolve` so the two cannot drift.
 * Both need it, and for different reasons: `applies` decides whether the ability
 * TRIGGERED at all (383 fixes that at the moment of the event), while `resolve`
 * runs a response window later, by which time the unit may have been moved off
 * the battlefield it was attacking.
 */

/** 464.2.c's Attacker: the player whose units applied Contested here. `null` when
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

/** Every unit of EITHER side standing at `battlefieldId` — the set 464.2.c Step 1
 *  designates when a combat opens. */
export function unitsPresentAt(state: GameState, battlefieldId: string): string[] {
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  if (!bf) return [];
  return state.players.flatMap((p) => (bf.units[p.id] ?? []).map((u) => u.instanceId));
}

/**
 * 359.3.f's "HERE", asked at 359.3.f.2's moment: is the ability's SOURCE still
 * standing at the battlefield the instruction is about?
 *
 * **This is not the same question as `isAttackingAt`, and the difference is two
 * different rules.** 383 fixes THAT an ability triggered, at the moment of the
 * event — an opponent cannot un-trigger a fired attack trigger by moving its
 * unit. But "here", "my" and "its" are REFERENTS read from the ability's source
 * (359.3.f.1), and a referent is "checked on execution of the instruction"
 * (359.3.f.2); an illegal one returns null and "all instructions related to it
 * will be ignored" (359.3.f.2.a). So a fired trigger still resolves, and its
 * "here" instruction simply has nothing to point at.
 *
 * The rules' own worked example is Yasuo - Remorseful (OGN-076), verbatim: an
 * opponent answers his attack trigger with Fight or Flight, "when the attack
 * trigger resolves, 'here' is no longer the battlefield where combat is ongoing
 * and the attack trigger mistargets". So MOVED AWAY and DEAD both make the
 * instruction MOOT — it is dropped, never re-aimed at wherever the source ended
 * up. `unitsPresentAt` answers all three cases at once: a unit that left, a unit
 * that went home to base and a unit that died are all simply not there.
 *
 * The counterpart is 359.3.f.3 (Lillia - Fae Fawn), where the information comes
 * from the TRIGGER CONDITION and is fixed when the condition is met. Nothing in
 * this file's callers is that shape.
 */
export function isStillHere(state: GameState, sourceInstanceId: string, battlefieldId: string): boolean {
  return unitsPresentAt(state, battlefieldId).includes(sourceInstanceId);
}

/** Shared by both predicates: is this listener a UNIT standing at the
 *  battlefield this combat opened at? A Gear listener ("when a friendly unit
 *  attacks") is deliberately excluded — it is not a combatant, and Mask of
 *  Foresight asks its own question about the units instead. */
function isCombatantAt(listener: Listener, event: GameEvent): event is Extract<GameEvent, { kind: "combatBegan" }> {
  return (
    event.kind === "combatBegan" &&
    listener.card.kind === "Unit" &&
    listener.battlefieldId === event.battlefieldId &&
    // 383.4.f: the trigger is on GAINING the designation, "for the first time
    // during a combat". A unit already designated is not gaining it again when a
    // reinforcement arrives and the event fires for the newcomer.
    event.designated.includes(listener.card.instanceId)
  );
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
