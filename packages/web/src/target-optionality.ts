/**
 * Is a card's single target OPTIONAL — "you MAY choose a unit"?
 *
 * # Why this is asked of the engine rather than listed here
 *
 * `GameBoard.pendingMinTargets` used to return a flat 1 for every `unit`-kind
 * card. `canFinishTargeting` compares the chosen count against that minimum, so
 * a card whose target is optional showed no "Choose no targets" button and could
 * not be played at all through the board — the player was left with Pass, Cancel
 * and Hide.
 *
 * Reported from play against Tideturner (OGN-199), whose on-play trigger reads
 * "you MAY choose a unit you control at another location": *"I am unable to play
 * Tideturner regularly if I control a battlefield. Only options are to pass,
 * cancel the cast or hide."*
 *
 * **The battlefield in that report is the diagnosis.** Controlling one means a
 * garrison unit is standing there, which is an eligible swap target, which is
 * what opens the target step in the first place. On a board with no eligible
 * unit anywhere the step was skipped and the card played normally — so the bug
 * appeared only on the boards where the card is actually worth casting, which is
 * why it survived to a playtest.
 *
 * # The predicate
 *
 * The engine already answers this by enumerating a variant with NO target
 * alongside the targeted ones — that is what "may" means in `legal-actions`. So
 * the question is not "which cards are optional" (a list, which would drift from
 * the engine the way `targetingChoosesUnit` replaced a hand-copied union) but
 * "did the engine offer a no-target play".
 *
 * Kept in its own module for the reason `card-destination.ts` is: a predicate
 * inside `GameBoard` can only be tested by driving the DOM, and this repo has
 * shipped vacuous DOM-presence tests before.
 */

/** The shape this needs from a candidate play — deliberately structural, so a
 *  test can pass plain objects and the app can pass real `PlayCardAction`s. */
export interface TargetableCandidate {
  targetUnitInstanceId?: string | undefined;
}

/**
 * True when the engine offers a play of this card that names no unit, which is
 * exactly the case where the player must be allowed to decline.
 *
 * An EMPTY candidate list returns false: nothing is playable, so there is no
 * decline to offer, and answering true would put a button on a step that has no
 * legal action behind it.
 */
export function singleTargetIsOptional(candidates: readonly TargetableCandidate[]): boolean {
  return candidates.some((a) => a.targetUnitInstanceId === undefined);
}

/**
 * How many targets this step must have before the player may finish.
 *
 * The WHOLE rule, not just the optional half, so the component's own function is
 * a single call and a mutation to it cannot slip past the tests here. That is
 * the lesson `cardHasDestination` was extracted for: logic left inside
 * `GameBoard` can only be reached by driving the DOM, and a predicate tested in
 * isolation while the component quietly ignores it is worse than no test.
 *
 * - `unitSlots` / `unitList` carry their own printed minimum.
 * - a single `unit` / `chainSpellAndUnit` slot is mandatory UNLESS the engine
 *   enumerated a play with no target — see `singleTargetIsOptional`.
 * - everything else chooses no unit at all, so nothing is required.
 */
export function minimumTargetsFor(
  targeting: { kind: string; min?: number },
  candidates: readonly TargetableCandidate[],
): number {
  if (targeting.kind === "unitSlots" || targeting.kind === "unitList") return targeting.min ?? 0;
  if (targeting.kind === "unit" || targeting.kind === "chainSpellAndUnit") {
    return singleTargetIsOptional(candidates) ? 0 : 1;
  }
  return 0;
}
