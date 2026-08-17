import type { BattlefieldState, GameState, PlayerState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import { recordConquest } from "./scoring.js";
import { effectiveMight } from "./effective-might.js";
import { anyDamageIsLethalTo, damageIsDoubledFor, takesNoDamage } from "./damage-modifiers.js";
import { hasKeyword } from "./granted-keywords.js";
import { healAllUnits, killUnit, relocateToBaseUnchanged } from "./effect-helpers.js";
import { clearContested } from "./cleanup.js";
import { holdEventTrigger } from "./triggers.js";

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
  // Rule 423: "A Stunned Unit does not contribute its might to damage in the
  // combat damage step." Only here — `remainingMight` below is deliberately
  // untouched, because the same rule says a stunned unit "must still have damage
  // applied to it equal to, or greater than, its full might value to be killed".
  // It hits for nothing and is no easier to kill; the two functions exist
  // precisely because those are different questions.
  if (unit.stunned) return 0;
  // "I don't deal combat damage" — Ezreal - Dashing (SFD-082). The exact
  // counterpart of the Stun line above, and it belongs in the same place for
  // the same reason: this function is the one question "how hard does this unit
  // hit" is asked, and `remainingMight` below is deliberately untouched, so he
  // is no easier to kill for dealing nothing.
  //
  // Written the moment the rest of his card was, because it is his DRAWBACK:
  // his attack trigger deals damage equal to his Might, and without this he
  // would deal it AND his Might in the damage step — strictly stronger than
  // printed, which is the one direction this codebase does not ship.
  if (DEALS_NO_COMBAT_DAMAGE_DEF_IDS.has(unit.defId)) return 0;
  return effectiveMight(state, unit, ownerIndex, { isCombat: true, isAttackingSide, combatRole: "outgoing", battlefieldId });
}

/** How much MORE damage a unit can absorb before dying. Mirrors
 *  ShowdownResolver.remainingMight (engine/ShowdownResolver.java:235-262),
 *  minus Fiora - Peerless's multiplier and Prevent (no printed card grants
 *  Prevent in this pool yet per Card.Unit.preventValue's own doc comment). */
function remainingMight(state: GameState, unit: UnitInstance, ownerIndex: 0 | 1, battlefieldId: string, isAttackingSide: boolean): number {
  // Elder Dragon — "any amount of your damage is enough to kill enemy units"
  // (142.4.c). LETHAL DAMAGE becomes 1, so what remains is 1 minus what is
  // already marked rather than Might minus it.
  //
  // **This one function covers both halves of combat, which is why the override
  // belongs here and not at the call sites.** `distribute` fills each target up
  // to `remainingMight` when ASSIGNING, and `removeDefeated` asks the same
  // function of the DAMAGED unit to decide who died. Overriding only the
  // assignment would hand every enemy exactly 1 damage and then rule them all
  // survivors.
  //
  // The attribution 142.4.c asks for ("damage marked by you") is structural in
  // combat: damage to one side comes from the other, so asking about the seat
  // opposing `ownerIndex` IS the question.
  if (anyDamageIsLethalTo(state, ownerIndex)) return Math.max(0, 1 - unit.damage);
  return Math.max(0, effectiveMight(state, unit, ownerIndex, { isCombat: true, isAttackingSide, combatRole: "remaining", battlefieldId }) - unit.damage);
}

/**
 * How much damage must be ASSIGNED to this unit to reach lethal.
 *
 * Ordinarily that is `remainingMight`. It differs only for a unit under UNL-013
 * Lotus Trap, and **465.2.c.5 is explicit about why**: "When assigning damage in
 * this way, replacement effects that would apply to the resulting damage are
 * considered to apply to the assignment instead", worked through with this card's
 * own text —
 *
 * > "The attacking player is assigning their 3 [M] worth of damage to two
 * > defending units with 2 [M] each. One of the units has a delayed replacement
 * > effect applied to it that reads 'Double all damage that would be dealt to it
 * > this turn.' ... when assigning damage to the unit with the delayed
 * > replacement effect they assign 2 damage to it; 1 damage that doubles to 2
 * > damage as it is assigned to the unit. When that damage is dealt, it doesn't
 * > get doubled again."
 *
 * So a doubled unit costs the attacker HALF the assignment, rounded up — and
 * `applyCombatDamage` below doubles what lands, rather than `dealDamage`'s
 * multiplier applying a second time. Combat never routes through `dealDamage`,
 * which is what keeps the two from compounding.
 */
function assignmentNeeded(
  state: GameState,
  unit: UnitInstance,
  ownerIndex: 0 | 1,
  battlefieldId: string,
  isAttackingSide: boolean,
): number {
  const lethal = remainingMight(state, unit, ownerIndex, battlefieldId, isAttackingSide);
  return damageIsDoubledFor(state, unit.instanceId) ? Math.ceil(lethal / 2) : lethal;
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
 *
 * Asked through `hasKeyword`, never through `unit.keywords`. This was the only
 * keyword read in this file and it read the PRINTED set, so a granted [Tank]
 * — Block (OGN-057) is the card, and it grants for the turn via
 * `keywordsThisTurn` — reordered nothing while the card reported implemented.
 */
/**
 * Cards printing `[Backline]` as PLAIN PROSE — "I must be assigned combat damage
 * last".
 *
 * A per-card set BESIDE the keyword, and Caitlyn is why: she prints the sentence
 * as prose rather than as a bracket, so `parseKeywords` sees nothing on her and
 * no keyword check can reach her.
 *
 * **The rest of this comment used to say "Backline is absent from `KEYWORDS`
 * entirely", and that went stale without anyone noticing.** It was true when
 * written; `"Backline"` was added to `model/keyword.ts` with Unleashed, whose four
 * cards DO print the bracket. So for a week `assignmentOrder` consulted a
 * one-entry allowlist while the parser was already populating a keyword it never
 * asked about, and the coverage note blamed a mechanism that existed. Reading the
 * keyword — as of 2026-08-10 — also picks up a GRANTED `[Backline]`, which an
 * allowlist could never have done.
 */
const ASSIGNED_LAST_DEF_IDS = new Set(["OGN-068"]); // Caitlyn - Patrolling, who prints it as prose

/** Units whose printed text says they deal no combat damage. Read by
 *  `outgoingMight`, beside the Stun rule it mirrors. */
const DEALS_NO_COMBAT_DAMAGE_DEF_IDS = new Set(["SFD-082"]); // Ezreal - Dashing

/** Symbol of the Solari: "If a combat where you are the attacker ends in a tie,
 *  recall ALL units instead." A Gear that changes rule 466's step 3d, so it is
 *  read here rather than registered as an effect. */
const SYMBOL_OF_THE_SOLARI = "OGN-227";

/**
 * Rule 465.2.c's assignment order: Tanks first, Backline last, everyone else
 * between.
 *
 * **The old `tanks.length === 0` early return had to go.** With only two tiers,
 * "no tanks" really did mean "nothing to reorder"; with a third it is false —
 * a lone Caitlyn among ordinary units still goes last.
 *
 * 465.2.c's exclusionary clause — a unit with BOTH Tank and Backline has its
 * assigner pick ONE of the two abilities, never both — is reachable in this pool
 * today, since Block grants `[Tank]`. Resolved here in Tank's favour, which is
 * the assigner's choice and is recorded Unverified in docs/rules-conformance.md:
 * the rules give the choice to the player assigning damage, and this engine has
 * no interactive assignment to ask through.
 */
function assignmentOrder(state: GameState, units: readonly UnitInstance[], ownerIndex: 0 | 1): readonly UnitInstance[] {
  const isTank = (u: UnitInstance) => hasKeyword(state, u, ownerIndex, "Tank");
  // The keyword and the allowlist are BOTH consulted: the four UNL cards print
  // `[Backline]`, Caitlyn prints the same sentence as prose, and `hasKeyword`
  // additionally catches a Backline granted by an effect.
  //
  // **`!isTank(u)` is Tank winning the tie, and it is MEASURED-REDUNDANT for
  // observable outcomes** — kept because it is correct, labelled so nobody reads
  // it as load-bearing. Dropping it survived mutation on 2026-08-10, and the
  // reason is worth knowing before `distribute` is ever changed: without it a
  // Tank+Backline unit lands in BOTH tiers and appears twice in the returned
  // list, but `distribute` recomputes `lethal` from state each time and dumps any
  // surplus on the last entry, so a Tank+Backline unit with 5 Might facing a
  // 9-Might pool produced identical survivors AND identical
  // `lastShowdownExcessDamage` either way. The guard becomes observable the
  // moment assignment stops being pure arithmetic over the same state.
  const isBackline = (u: UnitInstance) =>
    !isTank(u) && (hasKeyword(state, u, ownerIndex, "Backline") || ASSIGNED_LAST_DEF_IDS.has(u.defId));
  const tanks = units.filter(isTank);
  const backline = units.filter(isBackline);
  if (tanks.length === 0 && backline.length === 0) return units; // nothing to reorder
  const middle = units.filter((u) => !isTank(u) && !isBackline(u));
  return [...tanks, ...middle, ...backline];
}

/** The cards whose printed text this module implements, for coverage.ts — the
 *  same reason effective-might.ts and granted-keywords.ts export theirs. */
export function combatAssignmentDefIds(): string[] {
  return [...ASSIGNED_LAST_DEF_IDS, ...DEALS_NO_COMBAT_DAMAGE_DEF_IDS, SYMBOL_OF_THE_SOLARI];
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
    const lethal = assignmentNeeded(state, target, ownerIndex, battlefieldId, isAttackingSide);
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

/**
 * How much of the attacking pool was EXCESS — assigned beyond what it took to
 * kill what it was assigned to.
 *
 * **"Excess damage" is not a defined term anywhere in the rules** (`excess`
 * appears only under Burn Out), and the survey recorded three candidate
 * readings: `distribute`'s overkill dump onto the last target; the attacker's
 * pool minus the total lethal need; or per-unit `assigned − remainingMight`
 * summed. Under this engine's lethal-first assignment **all three give the same
 * number** — every unit but the last is assigned exactly its remaining Might, so
 * the only surplus anywhere is the leftover — which is why this could be
 * implemented without picking one. It is computed as the second reading, the
 * clearest of the three, and stays true if the assignment order ever changes.
 * Recorded Unverified.
 */
function excessAssigned(
  state: GameState,
  pool: number,
  targets: readonly UnitInstance[],
  ownerIndex: 0 | 1,
  battlefieldId: string,
): number {
  const totalLethalNeed = targets.reduce((sum, u) => sum + remainingMight(state, u, ownerIndex, battlefieldId, false), 0);
  return Math.max(0, pool - totalLethalNeed);
}

function applyDamage(state: GameState, units: readonly UnitInstance[], pending: Map<string, number>): UnitInstance[] {
  return units.map((u) => {
    const dmg = pending.get(u.instanceId);
    // Kayn - Unleashed after his second move takes none of what was assigned to
    // him — assignment above is untouched, so he still absorbs a lethal
    // allocation and shields whoever is behind him. See `takesNoDamage`.
    if (dmg && takesNoDamage(state, u)) return u;
    // Lotus Trap's doubling lands HERE, on the halved assignment
    // `assignmentNeeded` handed out — 465.2.c.5's "1 damage that doubles to 2
    // damage as it is assigned". It is applied once: combat never routes through
    // `dealDamage`, whose own multiplier is the non-combat half of the same card.
    const landed = dmg !== undefined && damageIsDoubledFor(state, u.instanceId) ? dmg * 2 : dmg;
    return landed ? { ...u, damage: u.damage + landed } : u;
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
  // Combat damage comes from the units on the other side, so the killer is the
  // opposing player — the answer "when you kill a unit" (Solari Shrine) needs,
  // and the one case where it can be derived rather than passed in.
  const killerIndex: 0 | 1 = ownerIndex === 0 ? 1 : 0;
  let next = state;
  for (const unit of defeated) {
    // `true` here and nowhere else: this is the combat damage step, and it is
    // the one site that can honestly say so.
    next = killUnit(next, unit, ownerIndex, battlefieldId, killerIndex, true);
  }
  return next;
}

/**
 * Closes the open Showdown — the single exit point for "all players passed in
 * sequence" (348), dispatching on which kind of Showdown it was.
 *
 * A Showdown is a window, not a fight. Rule 348.1: "If it is a Combat Showdown,
 * proceed with the remaining steps of Combat to resolve the phase." Rule 348.2.a:
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
 * Contested clears here rather than when the window merely ends, because 190.3.b
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

/** Rule 348.2.a — the Non-Combat Showdown's only outcome. "Only one player's
 *  Units remain" is the whole test: nobody there leaves control alone (the
 *  cleanup's own lapse step handles an emptied battlefield), and both players
 *  there can't happen, since that would have been promoted to a Combat Showdown
 *  in a Cleanup (316.8.b.1.a) before it could close. */
function resolveNonCombatShowdown(state: GameState, battlefieldId: string): GameState {
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  if (!bf) return state;
  const present = ([0, 1] as const).filter((index) => (bf.units[state.players[index].id]?.length ?? 0) > 0);
  if (present.length !== 1) return state;
  return claimBattlefieldControl(state, battlefieldId, present[0]!);
}

/**
 * Rule 466.3.a's winner: the only player with units remaining here, or
 * undefined when that is nobody or both.
 *
 * The two undefined cases are 466.3.d's **No Result**, not an oversight — both
 * sides standing (which is exactly when step 3d recalls the attackers) and
 * neither side standing. So a mutual wipe wins nothing, and a failed attack is
 * not a defender's victory.
 *
 * Asked in one place and used by both fire sites below, so the uncontested
 * walkout and the fought-out exchange cannot come to different answers about
 * what winning is.
 */
function combatWinner(
  attackerSurvivors: readonly unknown[],
  defenderSurvivors: readonly unknown[],
  attackerIndex: 0 | 1,
  defenderIndex: 0 | 1,
): 0 | 1 | undefined {
  if (attackerSurvivors.length > 0 && defenderSurvivors.length === 0) return attackerIndex;
  if (defenderSurvivors.length > 0 && attackerSurvivors.length === 0) return defenderIndex;
  return undefined;
}

/** Holds the 466.3.a win, if there was one. A no-op on a No Result, so callers
 *  do not each repeat the check. */
function holdCombatWon(
  state: GameState,
  battlefieldId: string,
  winnerIndex: 0 | 1 | undefined,
): GameState {
  return winnerIndex === undefined
    ? state
    : holdEventTrigger(state, { kind: "combatWon", battlefieldId, winnerIndex }, winnerIndex);
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

  // ── One side is gone: no fight, but emphatically not nothing ────────────
  //
  // This used to `return state` untouched, on the reading that with nobody to
  // fight there is nothing to resolve. The rules disagree, and it cost real
  // points: an opponent who Flashes their unit out of a Showdown (OGS-011,
  // "Move up to 2 friendly units to base") left the other player standing alone
  // at the battlefield and NOT credited with taking it.
  //
  //   - 466.3.a: a player has WON the combat if they "are the only Player that
  //     has units remaining at this battlefield during this step".
  //   - 466.3.d: "No Result" is only for units recalled in step 3d, BOTH players
  //     present, or NEITHER present. One side leaving is none of those.
  //   - 466.5 / 466.5.d: the player with units remaining Establishes Control,
  //     and that is a Conquer if they have not yet scored it this turn.
  //
  // Step 2 (the Combat Damage Step) is the only part that is conditional — it
  // opens with "If both Attacking and Defending units remain at this
  // battlefield" — so the exchange is skipped and everything after it still
  // runs. Step 3's heal included; step 3d ("Recall Attackers if Defenders are
  // still present") is a no-op in both one-sided shapes, since whichever side
  // would be recalled or would trigger the recall is the side that left.
  //
  // `establishControlAfterCombat` also covers the empty-empty case on its own
  // terms: nobody present makes the battlefield Uncontrolled (466.5.b).
  if (attackerUnits.length === 0 || defenderUnits.length === 0) {
    // 466.3.a applies here too, and this is the shape that produces most of
    // them: the `walkout` probe counts 191 of these in 200 games. Whoever is
    // still standing has WON, which is the same reading the comment above
    // already took for establishing control.
    const walkoverWinner = combatWinner(attackerUnits, defenderUnits, attackerIndex, defenderIndex);
    return establishControlAfterCombat(holdCombatWon(healAllUnits(state), battlefieldId, walkoverWinner), bfIndex);
  }

  const attackerPool = attackerUnits.reduce((sum, u) => sum + outgoingMight(state, u, attackerIndex, battlefieldId, true), 0);
  const defenderPool = defenderUnits.reduce((sum, u) => sum + outgoingMight(state, u, defenderIndex, battlefieldId, false), 0);

  // Tank-first on BOTH sides — the keyword is about a unit's own controller's
  // assignment order, so it applies whichever side is being assigned damage.
  const damageToDefenders = distribute(state, attackerPool, assignmentOrder(state, defenderUnits, defenderIndex), defenderIndex, battlefieldId, false);
  // Tryndamere - Barbarian's "if you assigned 5 or more EXCESS damage to enemy
  // units". See `excessAssigned` for why the three readings of a word the rules
  // never define all give this same number.
  const excessToDefenders = excessAssigned(state, attackerPool, defenderUnits, defenderIndex, battlefieldId);
  const damageToAttackers = distribute(state, defenderPool, assignmentOrder(state, attackerUnits, attackerIndex), attackerIndex, battlefieldId, true);

  const survivingAttackers = removeDefeated(state, applyDamage(state, attackerUnits, damageToAttackers), attackerIndex, battlefieldId, true);
  const survivingDefenders = removeDefeated(state, applyDamage(state, defenderUnits, damageToDefenders), defenderIndex, battlefieldId, false);

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

  let next: GameState = {
    ...state,
    battlefields: nextBattlefields,
    // Recorded on the state rather than passed down, because the card that reads
    // it is a HELD `battlefieldConquered` listener: it resolves in the Cleanup
    // after this function has returned, and nothing else survives that gap. One
    // slot rather than a per-battlefield map — a held conquer trigger is
    // finalized by the Cleanup that immediately follows its own combat, so two
    // combats can never both be waiting on it.
    lastShowdownExcessDamage: { battlefieldId, attackerIndex, amount: excessToDefenders },
  };
  next = processDefeated(next, defeatedAttackers, attackerIndex, battlefieldId);
  next = processDefeated(next, defeatedDefenders, defenderIndex, battlefieldId);

  // ── Combat Cleanup, rule 466 Step 3 ────────────────────────────────────
  // 3c. "Heal all Units" — GLOBAL, not just the units that fought here: a
  // unit softened by a Spell at another battlefield, or standing in base,
  // heals too. Only reached after a real exchange; the uncontested
  // early-return above performs no cleanup and so heals nothing (348.2).
  next = healAllUnits(next);

  // 3d. "Recall Attackers present at the Battlefield if Defenders are still
  // present." Failing to clear a defended battlefield sends your attackers
  // home — without this they sat there contesting it forever, since a
  // showdown only resolves once per move. Ordered after 3c, so they arrive
  // healed. A Recall is not a Move (456): no move triggers fire, which is why
  // this calls relocateToBaseUnchanged and NOT dispatchOnMove — Traveling
  // Merchant must not discard/draw and Noxian Drummer must not make a token.
  const defendersRemain = survivingDefenders.length > 0;
  if (defendersRemain && survivingAttackers.length > 0) {
    // Symbol of the Solari — "If a combat where you are the attacker ends in a
    // tie, recall ALL units instead."
    //
    // **A "tie" IS rule 466.3.d's No Result**, and this is the branch that
    // produces it: both sides still standing after the damage step, which is
    // exactly when 3d recalls the attackers. The survey filed the card as needing
    // a concept the engine lacked; it does not — the branch was already here, and
    // the card's own reminder text confirms the timing ("ties are calculated
    // after combat damage is dealt").
    //
    // "ALL units" replaces the attacker-only recall, so the DEFENDERS go home
    // too and the battlefield empties. That is what makes it worth a card: it
    // turns a failed attack into a cleared battlefield.
    //
    // "Where YOU are the attacker" — the gear only helps its own controller's
    // attacks, so it is asked against `attackerIndex` rather than either side.
    const solari = state.players[attackerIndex].activeGear.some((g) => g.defId === SYMBOL_OF_THE_SOLARI);
    const recalled = solari ? [...survivingAttackers, ...survivingDefenders] : survivingAttackers;
    for (const unit of recalled) next = relocateToBaseUnchanged(next, unit.instanceId);
  }

  // Rule 466.3.d ("if No Result and both players have units remaining, stage a
  // Showdown and a Combat here") is unreachable in a 2-player game: 3d removes
  // the attackers exactly when defenders remain, so both sides can never still
  // be present afterward. It exists for multiplayer, where a third player's
  // units can be at the battlefield. Deliberately not implemented.

  // 466.3.a, after the exchange. Held BEFORE control is established so the
  // win resolves ahead of any conquer trigger the same combat produces —
  // winning is what caused the conquest, not the other way round.
  next = holdCombatWon(next, battlefieldId, combatWinner(survivingAttackers, survivingDefenders, attackerIndex, defenderIndex));

  // ── Establish control, rule 466.5 ──────────────────────────────────────
  // The rules ask one question, not three: whoever still has units here takes
  // control if they didn't already, and if nobody does the battlefield becomes
  // Uncontrolled. Establishing control is a Conquer when that battlefield
  // hasn't been scored this turn (469.1) — recordConquest owns that check.
  return establishControlAfterCombat(next, bfIndex);
}

/** Rule 466.5: the player with units remaining here Establishes Control if
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
  // Yone - Blademaster reads "a battlefield that WAS UNCONTROLLED", and this is
  // the only place that can answer it: `setController` on the next line moves
  // control, and every listener runs after that.
  const wasUncontrolled = bf.controllerId === null;
  const next = setController(state, bfIndex, winner.id);
  return isConquest ? recordConquest(next, winnerIndex, bf.id, wasUncontrolled) : next;
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
