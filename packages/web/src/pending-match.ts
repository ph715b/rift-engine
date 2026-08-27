import { repeatExecutionsOf, type PlayCardAction } from "@rift-engine/engine";

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

/** An armed play's chosen mode, for a "Choose one —" card. `undefined` until the
 *  player has picked, which the two functions below read in opposite directions
 *  — the same settled/narrowing split as the optional costs at the bottom of
 *  this file. */
export interface PendingMode {
  modeId?: string;
}

/**
 * Does this candidate survive the mode chosen SO FAR? (Narrowing.)
 *
 * **The concept of a mode did not exist anywhere in `packages/web/src`** —
 * `modeId` appeared zero times, while every enumerated action for a modal card
 * carries one. That produced two different failures from one cause:
 *
 * Angle Shot STALLED. `targetingForCard` returns `{kind:"none"}` for an
 * unresolved mode — it cannot guess which of two different specs applies — so
 * the board asked for no target, and then no candidate matched a pending play
 * that named none. It armed and could never be submitted. Reported as "no
 * prompts or anything to choose a unit or gear".
 *
 * Rocket Barrage did something WORSE than stall. Its `killGear` candidates carry
 * no `targetUnitInstanceId` and its `damage` ones do, so a mode-less pending
 * matched all four gear candidates and neither damage one: the board silently
 * played "destroy a gear" at an arbitrary gear — sometimes the player's own —
 * and the damage mode was unreachable. A wrong play, made quietly.
 *
 * Unset excludes nothing, for the reason `matchesPendingCostFilter` gives: both
 * modes stay live until one is picked.
 */
export function modeFilterAllows(candidate: PlayCardAction, pending: PendingMode): boolean {
  if (pending.modeId === undefined) return true;
  return candidate.modeId === pending.modeId;
}

/**
 * Does this candidate carry exactly the mode the player picked? (Settled.)
 *
 * Unlike the filter above, an unmade choice matches only a candidate that has no
 * mode either — a non-modal card, whose actions omit `modeId` entirely. Letting
 * `undefined` match anything here is what allowed an arbitrary mode to be
 * submitted, so this is the strict half on purpose.
 */
export function sameMode(candidate: PlayCardAction, pending: PendingMode): boolean {
  return (candidate.modeId ?? null) === (pending.modeId ?? null);
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
  // **Four axes the engine has offered all along with no way to answer them.**
  // Added 2026-08-26, when `ui-can-express-every-choice.test.ts` was merged back
  // from master and named them. Each was a legal play a human could not choose:
  // the enumerator emitted both variants, `matchesPending` could only ever find
  // the unpaid one, and the paid line was unreachable however plainly the card
  // printed it.
  //
  // They cost one line each because this is a LIST — `sameOptionalCosts`,
  // `matchesPendingCostFilter`, `costFlagAlternative` and the button row all
  // iterate it. That is the whole claim the comment above makes, and it holds.
  //
  // 356.1.a — Jhin - Meticulous Killer and Undying Legion print "you may play me
  // for [Cost]" instead of their printed one. A REPLACEMENT, not a discount, which
  // is why it cannot share `acceleratePaid`'s flag.
  { key: "replacedCostPaid", on: "Play for its alternate cost", off: "Play for its printed cost" },
  // 204.2 — Safety Inspector (3 XP, buying exemption from his own kill) and
  // Poppy - Defender of the Meek (3 XP, and she costs [3] less). The amount is
  // per card, so the label cannot name it; the cost line on the armed card does.
  { key: "optionalXpPaid", on: "Spend XP as an additional cost", off: "Don't spend XP" },
  // VEN-157 Dragon Roost — "ANY player may pay [2 rainbow] as an additional cost
  // to play a Dragon. If they do, they play it to this battlefield." The only one
  // here that buys a PLACEMENT rather than an effect, so paying it settles where
  // the Dragon lands; the enumerator only ever emits it paired with the Roost.
  { key: "dragonRoostPaid", on: "Pay to play at the Dragon Roost", off: "Don't pay — play it elsewhere" },
  // SFD-079 Bard - Mercurial. **The one REGRESSION of the four**: master's board
  // expressed this and the rewrite on this branch did not carry it across, so it
  // was reachable once and then was not.
  { key: "exhaustLegendPaid", on: "Exhaust your Legend to pay", off: "Don't exhaust your Legend" },
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

/**
 * The armed card's OTHER variant along one optional-cost axis, if the engine is
 * offering one right now.
 *
 * **This is what decides whether a toggle button exists at all**, which makes it
 * the difference between a cost a player can pay and one that is merely modelled.
 * Lifted out of `GameBoard` so that decision can be tested against a REAL
 * enumeration: for the four axes added on 2026-08-26 the field being read by the
 * board was necessary and not sufficient — a button that never finds an
 * alternative never renders, and looks exactly like a card that has no such cost.
 *
 * Every OTHER settled choice must still match, or the "alternative" would be a
 * different variant entirely — a repeat-paid candidate aimed at a different
 * target, say.
 */
export function costFlagAlternative(
  candidates: readonly PlayCardAction[],
  pending: PendingOptionalCosts,
  key: OptionalCostKey,
): PlayCardAction | undefined {
  const want = !(pending[key] ?? false);
  return candidates.find(
    (a) =>
      (a[key] ?? false) === want &&
      OPTIONAL_COST_FLAGS.every((f) => f.key === key || (a[f.key] ?? false) === (pending[f.key] ?? false)),
  );
}

/**
 * The cards in hand that can pay a card-costed `[Repeat]` — Square Up's
 * "[Repeat] — Discard 1".
 *
 * Resolved from the CANDIDATES rather than from a rule re-derived here. The card
 * being played is itself in hand and must never be its own discard; the engine
 * already knows that, and reading the answer off what it enumerated is what keeps
 * the rule in one place instead of two that can disagree.
 *
 * Lifted out of `GameBoard` for the reason `costFlagAlternative` was: a list that
 * silently comes back empty renders an overlay with nothing in it, which is
 * indistinguishable from a card that asks no such question.
 */
export function repeatDiscardOptions<T extends { instanceId: string }>(
  candidates: readonly PlayCardAction[],
  hand: readonly T[],
): T[] {
  const eligible = new Set(candidates.map((a) => a.repeatDiscardCardInstanceId));
  return hand.filter((c) => eligible.has(c.instanceId));
}

/** The `[Repeat]` instances a candidate pays, sorted — its identity for the
 *  subset comparison below. `repeatExecutionsOf` normalises the two spellings, so
 *  a single-instance card's `repeatPaid` reads as `[0]` and nothing here has to
 *  know which spelling the enumerator chose. */
export function paidRepeatInstances(play: PlayCardAction): number[] {
  return repeatExecutionsOf(play)
    .map((e) => e.instance)
    .sort((a, b) => a - b);
}

/**
 * Does this candidate pay exactly the `[Repeat]` instances the player picked?
 *
 * **820.1.c.2 — "if a spell or ability has more than one instance of Repeat, each
 * Cost may be paid or not paid individually".** UNL-182 Curtain Call is the pool's
 * only card that prints more than one, at three DIFFERENT prices, so "how many"
 * does not describe the play: paying the cheap instance and paying the dear one
 * buy the same extra execution for different runes.
 *
 * An UNSET pick matches everything, the same distinction `matchesPendingCostFilter`
 * draws — before the player has chosen, every subset is still live, and treating
 * that as "pays none" would drop every paid variant the moment the card is armed.
 */
export function matchesRepeatInstances(
  candidate: PlayCardAction,
  picked: readonly number[] | undefined,
): boolean {
  if (picked === undefined) return true;
  const paid = paidRepeatInstances(candidate);
  const want = [...picked].sort((a, b) => a - b);
  return paid.length === want.length && paid.every((v, i) => v === want[i]);
}

/**
 * A `[Repeat]` instance's price, short enough for a button.
 *
 * The price is the whole point of naming the instance: Curtain Call's three are
 * `[1]`, `[rainbow]` and `[1][rainbow]`, and a button reading "Repeat #2" would
 * make the player guess which one they were buying. The middle instance really
 * does ask for ZERO Energy, so an empty Energy part is a price rather than a
 * placeholder and must not render as "[0]".
 */
export function repeatCostLabel(cost: { energy?: number; power?: number; rainbowPower?: number; domain?: string }): string {
  const parts: string[] = [];
  if ((cost.energy ?? 0) > 0) parts.push(`[${cost.energy}]`);
  if ((cost.rainbowPower ?? 0) > 0) parts.push("[rainbow]".repeat(cost.rainbowPower ?? 0));
  if ((cost.power ?? 0) > 0 && cost.domain) parts.push(`[${cost.domain}]`.repeat(cost.power ?? 0));
  // Every instance in the pool prices something; an empty label would be a table
  // entry with no cost, which is a bug rather than a free repeat.
  return parts.length > 0 ? parts.join("") : "free";
}
