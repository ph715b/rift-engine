import type { PlayCardAction } from "@rift-engine/engine";

/** The subset of an armed play's choices that this module compares. */
export interface PendingXChoice {
  xAmount?: number;
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
  if (pending.xAmount === undefined) return true;
  return candidate.xAmount === pending.xAmount;
}

/** The X on an armed play, if it has one. */
export function xAmountOf(pending: PendingXChoice): number | undefined {
  return pending.xAmount;
}
