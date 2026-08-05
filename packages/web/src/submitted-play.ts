import type { PlayCardAction, RunePayment } from "@rift-engine/engine";

/**
 * The PlayCard the board actually submits, built from the enumerated action the
 * player's choices resolved to.
 *
 * **This exists because rebuilding the action field by field dropped fields.**
 * `GameBoard` used to assemble a fresh `PlayCardAction` from `pendingPlay`, one
 * spread per optional field, and three never got a line:
 *
 *   - `targetUnitInstanceIds` — every `unitList` card. Falling Star was submitted
 *     with no targets at all and refused with "Falling Star requires 2 targets,
 *     got 0". Before refusals were surfaced, that read as the card silently
 *     refusing to cast, which is exactly how it was reported from play.
 *   - `xAmount` — Bullet Time's X, chosen and then thrown away.
 *   - `fromHiddenBattlefieldId` — rule 811's play from facedown, which tells the
 *     validator to look for the card at a battlefield rather than in hand.
 *
 * That is the SIXTH recorded instance of this shape in this codebase, after
 * `targetPermanentInstanceId` and four before it. A list of fields to copy is a
 * list somebody has to remember to extend, and the field added next will be
 * forgotten in exactly the same way — silently, because a dropped choice makes
 * the engine refuse an action the board thought it had built.
 *
 * So the list is gone. `pendingLegalAction` has already narrowed `legal` to the
 * ONE enumerated action matching every choice the player made — `matchesPending`
 * compares each of them exactly — which means that action already carries every
 * field, including any field added in future. The only thing the board knows
 * better is WHICH RUNES pay: the enumerated payment is one the engine computed,
 * and the player may have clicked different ones of the same size.
 */
export function submittedPlay(resolved: PlayCardAction, payment: RunePayment): PlayCardAction {
  return { ...resolved, payment };
}
