import type { GameState, PendingDeath, PlayerState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import { computeAutoPayment } from "./rune-payment.js";
import { parkDecision } from "./decisions.js";
import { killGear } from "./triggers.js";
import { effectiveMight } from "./effective-might.js";

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
  return [ZHONYAS_HOURGLASS, GUARDIAN_ANGEL, SORAKA_WANDERER];
}

/**
 * Guardian Angel — "If I would die, kill Guardian Angel instead. Heal me,
 * exhaust me, and recall me."
 *
 * **ART-ONLY ABILITY**, transcribed from the card image; see
 * docs/sfd-equipment-abilities.md. Its `text.plain` holds an `[Equip]` line and
 * nothing else.
 *
 * Zhonya's Hourglass' shape with one difference that is the whole card: the
 * Hourglass saves ANY friendly unit, and this saves only its WEARER. So it is
 * matched by attachment rather than by mere presence — an unattached Guardian
 * Angel in `activeGear` saves nobody.
 */
const GUARDIAN_ANGEL = "SFD-051";

/**
 * Soraka - Wanderer — "If another unit you control HERE would die, if it has
 * LESS Might than me, instead heal it, exhaust it, and recall it."
 *
 * The pool's first death replacement sourced from a UNIT, and the first with a
 * condition on the DYING unit rather than on the saver. Three clauses and all
 * three are printed:
 *
 *  - **ANOTHER** — she cannot save herself, which is what stops her being
 *    unkillable. By INSTANCE, so a second Soraka standing with her does save
 *    the first.
 *  - **HERE** — positional, so she saves nobody while she stands in base and
 *    nobody at another battlefield.
 *  - **LESS Might than me** — strictly less, read through `effectiveMight` so
 *    an aura or an Equipment on either unit counts. A unit of EQUAL Might is
 *    not saved, which is the difference between "less" and "no more".
 *
 * MANDATORY, like the Hourglass — no "you may" — so it asks nothing.
 */
const SORAKA_WANDERER = "SFD-173";

/**
 * The free, MANDATORY replacement that applies to this death, if any — Guardian
 * Angel's and Soraka's.
 *
 * One function so `killUnit` has a single place to ask, and so the ORDER
 * between them is stated once rather than falling out of two ifs. Guardian Angel
 * is checked first because it is the narrower card: it saves only its wearer and
 * costs the gear, and letting Soraka's free save consume a death the Angel was
 * attached for would waste it. Neither is a choice, so there is no question to
 * fold them into — the same ground the Hourglass is preferred on, and recorded
 * in docs/rules-conformance.md.
 */
export function freeDeathReplacement(
  state: GameState,
  unit: UnitInstance,
  ownerIndex: 0 | 1,
  battlefieldId: string | undefined,
  /**
   * What the dying unit was WEARING, captured by `killUnit` before it detached
   * everything.
   *
   * **Passed in rather than read off the board, and that is load-bearing.**
   * `killUnit` runs `detachAllFrom` before any replacement is considered — it
   * has to, because a dangling `attachedToInstanceId` reads in play as a Might
   * bonus from an Equipment attached to nothing. So by the time this function
   * runs, the Guardian Angel is already unattached and a live-board lookup finds
   * nothing. The first version did exactly that and never fired; the test caught
   * it. `PendingDeath.wornEquipment` exists for this same reason.
   */
  wornEquipment: readonly { instanceId: string; defId: string }[],
): GameState | undefined {
  const wornAngel = wornEquipment.find((g) => g.defId === GUARDIAN_ANGEL);
  // Re-found on the live board to get the real instance for `killGear`, which
  // needs the gear as it currently is rather than as it was when captured.
  const angel = wornAngel
    ? state.players[ownerIndex].activeGear.find((g) => g.instanceId === wornAngel.instanceId)
    : undefined;
  if (angel) {
    // killGear, not a quiet removal: the Angel is KILLED, so it goes through the
    // funnel that fires a gear's own killed-trigger — the same reading the
    // Hourglass takes.
    return reviveToBase(killGear(state, angel, ownerIndex), unit, ownerIndex);
  }

  // "HERE" — a unit dying in BASE is at no battlefield, so Soraka never reaches
  // it however close she is standing.
  if (battlefieldId === undefined) return undefined;
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  const here = bf?.units[state.players[ownerIndex].id] ?? [];
  const soraka = here.find((u) => u.defId === SORAKA_WANDERER && u.instanceId !== unit.instanceId);
  if (soraka === undefined) return undefined;
  const ctx = { isCombat: false as const, battlefieldId };
  // Strictly LESS. Equal Might is not saved.
  if (effectiveMight(state, unit, ownerIndex, ctx) >= effectiveMight(state, soraka, ownerIndex, ctx)) return undefined;
  return reviveToBase(state, unit, ownerIndex);
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
 * NOT clear the Buff: the unit never left play, and 705 only strips buffs on
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

/**
 * Altar of Blood (UNL-206) — "If a unit here would die DURING COMBAT, its
 * controller may pay [3 rainbow] to heal it, exhaust it, and recall it instead."
 *
 * **The pool's first POSITIONAL death replacement, and its first from a
 * battlefield.** Every other one is sourced from a card its controller owns —
 * Highlander's armed ward, Sett's legend ability, the Hourglass in play, Guardian
 * Angel attached, Soraka standing by. This one is a property of WHERE the unit
 * died, so it reaches both players and neither of them has to own anything.
 *
 * Two conditions, and both are already on `PendingDeath` because the death funnel
 * has carried them since Soraka:
 *
 *  - **HERE** — `death.battlefieldId`, so a unit dying in base is never offered
 *    it however the battlefield is doing.
 *  - **DURING COMBAT** — `death.diedInCombat`, set by `combat.processDefeated`
 *    alone. A unit killed HERE by a Spell is not covered, which is the whole
 *    shape of the card: it is insurance against the damage step, not against
 *    removal.
 *
 * `[3 rainbow]` is three Power of any domain — `payPowerFromChanneled` with a
 * `null` domain, the same call Power Nexus makes. Checked before parking, the
 * 416.3 discipline every offer here follows.
 */
const ALTAR_OF_BLOOD = "UNL-206";
export const ALTAR_OF_BLOOD_PIPS = 3;
export const ALTAR_OF_BLOOD_SAVE = `${ALTAR_OF_BLOOD}-save`;

/** For coverage — the battlefield this module implements. Its own export rather
 *  than a row in `deathReplacementDefIds`, because that list is about CARDS and
 *  `battlefield-coverage.test.ts` is the only gate that can see a battlefield. */
export function deathReplacementBattlefieldDefIds(): string[] {
  return [ALTAR_OF_BLOOD];
}

/** Is the battlefield this unit died at an Altar of Blood? */
function diedAtAltarOfBlood(state: GameState, death: PendingDeath): boolean {
  if (death.battlefieldId === undefined || death.diedInCombat !== true) return false;
  return state.battlefields.find((b) => b.id === death.battlefieldId)?.defId === ALTAR_OF_BLOOD;
}

/**
 * Offers the Altar's save, or `undefined` when it does not apply — the same shape
 * `offerPaidDeathWard` has, and it sits beside it in `killUnit` for the same
 * reason: both are OPTIONAL and PAID, so neither can be preferred on the
 * "it isn't a choice" ground the Hourglass wins on.
 */
export function offerAltarOfBlood(state: GameState, death: PendingDeath): GameState | undefined {
  if (!diedAtAltarOfBlood(state, death)) return undefined;
  // **`computeAutoPayment`, not `payPowerFromChanneled`**, and the reason is a
  // cycle rather than a preference: the payer lives in `effect-helpers`, which
  // imports THIS module, so asking it here would close the loop. The Armory's
  // offer one function up makes the same call for the same reason.
  //
  // `null` domain — any three pips. `null` is this function's failure value, and
  // comparing against `undefined` instead is the mistake `offerPaidDeathWard`
  // records getting wrong once.
  if (computeAutoPayment(state.players[death.ownerIndex].channeled, 0, ALTAR_OF_BLOOD_PIPS, null) === null) {
    return undefined;
  }

  const held: GameState = {
    ...state,
    unitsAwaitingDeathReplacement: [...state.unitsAwaitingDeathReplacement, death],
  };
  return parkDecision(held, {
    kind: ALTAR_OF_BLOOD_SAVE,
    playerIndex: death.ownerIndex,
    targetInstanceId: death.unit.instanceId,
  });
}

/** The question Zhonya's Hourglass parks when a BATCH of deaths gives its
 *  controller a choice, written once because `withSimultaneousDeaths` raises it
 *  and `effects/calm.ts` answers it. */
export const HOURGLASS_SAVE = "OGN-077-save";

/** Is there an Hourglass on this player's board to spend? */
export function hasHourglass(state: GameState, ownerIndex: 0 | 1): boolean {
  return state.players[ownerIndex].activeGear.some((g) => g.defId === ZHONYAS_HOURGLASS);
}

/**
 * Spends the Hourglass on one death: "kill this instead. Heal that unit, exhaust
 * it, and recall it."
 *
 * `killGear`, not a quiet removal — the Hourglass is KILLED, so it reaches the
 * trash through the funnel that fires a gear's own killed-trigger.
 *
 * `undefined` when there is no gear to spend — the same "there was no
 * replacement here" answer `freeDeathReplacement` gives, so the caller falls
 * through to the ordinary death. That is also what makes the batch honest about
 * **370.2** ("a Replacement Effect can only be applied once to an event"): a
 * second call in one batch finds nothing left.
 *
 * The gear is re-found here rather than passed in, because a batch can kill it:
 * Bottled Constellation's cost eats friendly units AND gear in the same sweep,
 * so the Hourglass can be fodder for the very deaths it was going to replace.
 */
export function applyHourglass(state: GameState, unit: UnitInstance, ownerIndex: 0 | 1): GameState | undefined {
  const hourglass = state.players[ownerIndex].activeGear.find((g) => g.defId === ZHONYAS_HOURGLASS);
  if (!hourglass) return undefined;
  return reviveToBase(killGear(state, hourglass, ownerIndex), unit, ownerIndex);
}

/** Holds a death back for the open batch rather than settling it now — see
 *  `GameState.hourglassBatch` for what the two states of that field mean. */
export function deferToHourglassBatch(state: GameState, death: PendingDeath): GameState {
  return { ...state, hourglassBatch: [...(state.hourglassBatch ?? []), death] };
}

/**
 * Closes an open batch: moves its deaths into the replacement pen and asks each
 * affected controller WHICH of their dying units the Hourglass takes.
 *
 * One question per player with one option per candidate, rather than a
 * save-or-pass per death. That is 373 read literally — with a single Hourglass,
 * spent by the first application, "the order to apply them in" and "which one
 * gets it" are the same choice — and it keeps the card MANDATORY for free:
 * declining is not on the menu because the card prints no "you may".
 *
 * A batch with ONE candidate produces a one-option question, which
 * `advanceDecisions` executes without prompting. That is why a lone death still
 * behaves exactly as it did before the choice existed.
 */
export function settleHourglassBatch(state: GameState): GameState {
  const batch = state.hourglassBatch ?? [];
  // DELETED rather than set to undefined: `exactOptionalPropertyTypes` is on, and
  // the two are exactly the distinction this field is carrying — an absent key is
  // "no batch open", which is what closing one must leave behind.
  const { hourglassBatch: _closed, ...rest } = state;
  const cleared: GameState = rest;
  if (batch.length === 0) return cleared;

  const penned: GameState = {
    ...cleared,
    unitsAwaitingDeathReplacement: [...cleared.unitsAwaitingDeathReplacement, ...batch],
  };

  // Turn order, so that with both players losing units at once the turn player
  // is asked first — the same reading 383.3.d.1 gets for simultaneous triggers.
  const turn = state.activePlayerIndex;
  const order: (0 | 1)[] = [turn, turn === 0 ? 1 : 0];
  let next = penned;
  for (const playerIndex of order) {
    const mine = batch.filter((d) => d.ownerIndex === playerIndex);
    if (mine.length === 0) continue;
    next = parkDecision(next, {
      kind: HOURGLASS_SAVE,
      playerIndex,
      cardInstanceIds: mine.map((d) => d.unit.instanceId),
    });
  }
  return next;
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
