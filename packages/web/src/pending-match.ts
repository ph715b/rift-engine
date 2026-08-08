import type { PlayCardAction } from "@rift-engine/engine";

/** The subset of an armed play's choices that this module compares. */
export interface PendingXChoice {
  xAmount?: number;
  /** The GEAR a `unitAndEquipment` card named — Relentless Pursuit's "you may
   *  attach an Equipment with the same controller to it". */
  targetPermanentInstanceId?: string;
  /**
   * Has the player finished with the Equipment step — by picking one, or by
   * declining?
   *
   * Needed because an absent `targetPermanentInstanceId` is otherwise ambiguous
   * between "declined it" and "hasn't chosen yet", the same ambiguity
   * `additionalCostResolved` resolves for Meditation's optional cost and
   * `BASE_ZONE_ID` resolves for placement. Without it a declined attach would
   * still match the attaching candidate, and the player would silently get an
   * attach they refused.
   */
  equipmentChoiceResolved?: boolean;
}

/**
 * Does a candidate action carry the X the player chose?
 *
 * Extracted from `GameBoard.matchesPending` because it is the clause that was
 * MISSING there, and a comparison living inside a 2,400-line component is
 * exactly where a missing clause survives — the same reason `target-hint.ts` and
 * `card-destination.ts` were pulled out.
 *
 * **`0` is a real answer, not "unset".** Bullet Time's "pay any amount" includes
 * none, so the comparison has to be against `undefined` rather than falsy; `!x`
 * would make a chosen 0 look like an unmade choice and match every variant.
 */
export function matchesPendingChoices(candidate: PlayCardAction, pending: PendingXChoice): boolean {
  if (pending.xAmount !== undefined && candidate.xAmount !== pending.xAmount) return false;
  return matchesPendingEquipment(candidate, pending);
}

/**
 * Does a candidate carry the Equipment the player chose — or the ABSENCE of one
 * they declined?
 *
 * **Gated on `equipmentChoiceResolved`, and that gate is what keeps every OTHER
 * gear-targeting card working.** `unitOrGear` (Fading Memories) and `{kind:
 * "gear"}` (Rocket Barrage) also fill `targetPermanentInstanceId`, and the UI
 * has never had a step that lets a player pick which gear — it takes whichever
 * candidate comes first. Comparing unconditionally would turn that arbitrary-
 * but-working behaviour into no match at all, which is precisely the silent
 * no-op this whole change exists to fix, inflicted on two more cards.
 *
 * So: cards that go through the Equipment step opt in by setting the flag;
 * everything else is unaffected. Widening the step to those two is real work and
 * is note 3/4's, not this fix's.
 */
export function matchesPendingEquipment(candidate: PlayCardAction, pending: PendingXChoice): boolean {
  if (!pending.equipmentChoiceResolved) return true;
  return (candidate.targetPermanentInstanceId ?? null) === (pending.targetPermanentInstanceId ?? null);
}

/** The X on an armed play, if it has one. */
export function xAmountOf(pending: PendingXChoice): number | undefined {
  return pending.xAmount;
}
