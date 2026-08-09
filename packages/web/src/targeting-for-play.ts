import { targetingForAnyCard, type CardInstance, type TargetingSpec } from "@rift-engine/engine";

/**
 * The engine's `targetingForAnyCard`, with the mode made MANDATORY.
 *
 * # Why a wrapper that adds nothing
 *
 * `targetingForAnyCard(card, modeId?)` has an OPTIONAL second parameter, and that
 * optionality is the entire reason a modal card was unplayable. Every one of the
 * board's six call sites omitted it and every one compiled. For a modal card the
 * engine then answers `{kind: "none"}` — correctly, since it cannot guess which
 * of two different specs applies — so the board saw a card that needs no target,
 * asked nothing, and either stalled (Angle Shot) or silently submitted a mode
 * nobody picked (Rocket Barrage).
 *
 * Passing the mode at those six sites fixes the two cards that exist. It does not
 * fix the SEVENTH call site, which someone will add without a mode exactly as the
 * first six were, and which will fail just as silently.
 *
 * So the parameter is required here, and `modeId: string | undefined` rather than
 * `modeId?: string`: an explicit `undefined` is a decision ("this card has no
 * mode, or none has been chosen yet"), while an omitted argument is an oversight,
 * and the type system can only tell those apart if omission is illegal.
 *
 * This is the same move as `targetingChoosesUnit` being exhaustive over the
 * union with no `default` — the next mistake of this shape breaks compilation
 * instead of a card. Both were adopted after the same class of playtest report.
 */
export function targetingForPlay(card: CardInstance, modeId: string | undefined): TargetingSpec {
  return targetingForAnyCard(card, modeId);
}
