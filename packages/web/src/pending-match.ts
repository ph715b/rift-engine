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

/**
 * The boolean optional-cost variants a play can carry, in one list so the
 * several places that must agree about them cannot drift apart.
 *
 * **Only `acceleratePaid` was ever compared, and the other three were invisible
 * to the board.** With a repeat-paid candidate and a plain one looking identical
 * to `matchesPending`, `.find` took whichever came first — always the plain,
 * undiscounted play. So a human could not pay a `[Repeat]` at all, free or
 * otherwise. That surfaced as a playtest report that Ezreal - Prodigy's discount
 * "did nothing": the engine priced it correctly and the board could not reach it.
 *
 * The seventh instance in this project of a field that exists on the action, is
 * enumerated and is validated, and gets lost on one hop — and the first where
 * the fix is a LIST rather than another remembered line, because
 * `acceleratePaid` already had this plumbing four times over and three more
 * copies would have needed a fifth for the next optional cost.
 *
 * They are separate flags rather than one enum because a card can carry more
 * than one at once: a printed `[Repeat]` under a Temporal Portal grant is
 * `repeatPaid` AND `grantedRepeatPaid`, which 820.1.c.2 makes two instances paid
 * separately.
 */
export const OPTIONAL_COST_FLAGS = [
  { key: "acceleratePaid", on: "Accelerate (enter ready)", off: "Don't Accelerate" },
  { key: "optionalPowerPaid", on: "Pay optional cost", off: "Don't pay optional cost" },
  { key: "repeatPaid", on: "Repeat (pay again)", off: "Don't Repeat" },
  { key: "grantedRepeatPaid", on: "Repeat (granted)", off: "Don't use granted Repeat" },
] as const;

export type OptionalCostKey = (typeof OPTIONAL_COST_FLAGS)[number]["key"];

/** An armed play's optional-cost choices. Each is `undefined` until the player
 *  has settled it, which is why nothing here defaults to `false` at the call
 *  sites that decide whether a choice has been MADE. */
export type PendingOptionalCosts = Partial<Record<OptionalCostKey, boolean>> & {
  /** Ezreal - Prodigy and Irelia - Graceful share this. Not a boolean, and it
   *  must match exactly: the validator REFUSES a play claiming an axis that buys
   *  nothing, so a board that ignored it would offer actions `submit` rejects. */
  targetDiscountAxis?: "energy" | "power";
};

/**
 * Does this candidate carry the same optional-cost variant the armed play has
 * settled on?
 *
 * Compares every flag as a settled boolean — by the time this is asked, the
 * armed play's choices are final and an absent flag means "not paid", which is a
 * real answer rather than an open question. `matchesPendingCostFilter` below is
 * the other half, for narrowing while choices are still being made.
 */
export function sameOptionalCosts(candidate: PlayCardAction, pending: PendingOptionalCosts): boolean {
  for (const { key } of OPTIONAL_COST_FLAGS) {
    if ((candidate[key] ?? false) !== (pending[key] ?? false)) return false;
  }
  return (candidate.targetDiscountAxis ?? null) === (pending.targetDiscountAxis ?? null);
}

/**
 * Does this candidate survive the optional-cost choices made SO FAR?
 *
 * The narrowing counterpart of `sameOptionalCosts`. An unset flag must not
 * exclude anything — before the player has chosen, both variants are still live,
 * and treating `undefined` as `false` here would silently drop every paid
 * variant the moment a card was armed. That distinction is the whole reason
 * these are two functions.
 */
export function matchesPendingCostFilter(candidate: PlayCardAction, pending: PendingOptionalCosts): boolean {
  for (const { key } of OPTIONAL_COST_FLAGS) {
    if (pending[key] !== undefined && (candidate[key] ?? false) !== pending[key]) return false;
  }
  if (pending.targetDiscountAxis !== undefined && (candidate.targetDiscountAxis ?? null) !== pending.targetDiscountAxis) {
    return false;
  }
  return true;
}
