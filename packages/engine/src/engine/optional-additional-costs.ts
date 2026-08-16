import {
  repeatExecutionsOf,
  type GameState,
  type RepeatChoices,
  type RepeatExecution,
} from "../model/game-state.js";
import type { CardInstance } from "../model/card.js";
import type { Domain } from "../model/domain.js";
import { discountedOptionalCosts, modifiedRepeatEnergy } from "./cost-modifiers.js";
import { grantedRepeatCostOf, optionalPowerCostOf, repeatCostsOf } from "./card-effects.js";
import { foreignRepeatPip, standingRepeatGrantFor } from "./repeat-grants.js";
import { ACCELERATE_ENERGY, ACCELERATE_POWER } from "./timing.js";

/**
 * What the OPTIONAL ADDITIONAL COSTS a play opted into add to its price.
 *
 * # Why this is a function and not two copies
 *
 * 204.2 and 820.1.c.1 make an additional cost part of what the play costs — "an
 * Additional Cost to be paid during the steps of playing" — so it has to be
 * priced identically wherever the play is priced. It was priced in TWO places
 * and only one of them added it: `validate-play-card` ran the whole bundle
 * through `discountedOptionalCosts` before `computeEffectiveCost`, while
 * `execute-play-card` re-derived from the RAW printed cost and consulted
 * `acceleratePaid`, `repeatPaid` and `optionalPowerPaid` **nowhere at all**.
 *
 * The two halves therefore disagreed in the payer's favour whenever floating
 * Energy covered the difference: the validator charged runes for base + additional
 * and the executor then deducted the float against the BASE ALONE, so a caster
 * with enough banked got every `[Repeat]`, `[Accelerate]` and optional-Power cost
 * FREE. Measured on SFD-034 Feral Strength (2 Energy, `[Repeat] [2]`) with 10
 * floating Energy and no runes: the plain play and the repeat-paying play each
 * spent exactly 2.
 *
 * **That was the THIRD time the missed cost site was `execute-play-card`** —
 * `docs/rules-conformance.md` records the same shape against Irelia - Graceful
 * and against `variantCostDiscount`. The pattern is not that the executor is
 * careless; it is that "re-derive from the raw cost so the two halves cannot
 * drift" (that file's own stated convention) makes each half a place a term can
 * be forgotten, and a forgotten term is silent in the direction nobody tests.
 * So the term is a shared function now: there is one list of optional costs and
 * both sites read it, which is the shape `[Repeat]`'s own cost already uses in
 * the Java oracle for exactly this reason.
 *
 * # Why the ENUMERATOR still prices its own, and should
 *
 * `legal-actions` has four more `discountedOptionalCosts` calls and they are
 * deliberately not folded in here. They price a HYPOTHETICAL variant — one
 * optional cost at a time, while deciding which variants to offer — so there is
 * no action yet to read the paid flags off, and inverting them to build a
 * throwaway action per variant would be a larger and riskier change than the bug
 * this fixes.
 *
 * The asymmetry is also principled rather than merely tolerable. **An
 * enumerator/validator disagreement is LOUD**: every action is validated, so a
 * mispriced candidate is refused and something visibly stops working. The
 * validator/executor disagreement was SILENT, because nothing re-checks the
 * executor — it is the last word on what a play actually costs. That is why
 * those two share a function and these four do not, and it is the reason this
 * bug shape has landed three times on the executor and never once on the
 * enumerator.
 *
 * # What it deliberately does NOT do
 *
 * It does not apply the `ignoresBaseCost` / `fromHidden` / `costIgnored` gates.
 * Both callers already zero the whole price in those cases and must keep doing
 * so — a from-hidden play costs nothing, additional costs included.
 *
 * It returns the DISCOUNTED bundle: Ezreal - Prodigy's "[1] or [rainbow] less"
 * is once per qualifying optional additional cost (owner ruling 2026-08-08), so
 * the costs go in as a LIST and each is reduced separately before they are
 * summed. Summing first and discounting once under-pays by a pip on the only
 * board where it is observable.
 */
export interface OptionalAdditionalCosts {
  energy: number;
  power: number;
  rainbow: number;
}

/**
 * The card fields this pricing reads — structural, so a `SpellInstance`, a
 * `UnitInstance` and a `GearInstance` all satisfy it with no caller converting.
 *
 * `kind` is taken from `CardInstance` rather than typed as `string` so that
 * `standingRepeatGrantFor`'s own `Pick<CardInstance, "kind">` is satisfied
 * exactly; `grantedRepeatCostOf` needs the two printed costs because Temporal
 * Portal's granted instance is priced FROM the card it is granted to.
 */
export type PricedCard = Pick<CardInstance, "kind"> & {
  defId: string;
  energyCost: number;
  powerCost: number;
  powerDomain: Domain | null;
  powerDomainAlt?: Domain;
};

/** The play fields this pricing reads. Structural for the same reason
 *  `repeatExecutionsOf` is: `model/` must not import `actions/`. */
export interface PricedPlay {
  playerIndex: 0 | 1;
  acceleratePaid?: true;
  optionalPowerPaid?: true;
  grantedRepeatPaid?: true;
  // The repeat trio is spelled EXACTLY as `repeatExecutionsOf` declares it —
  // plain optionals, no `| undefined`. Under `exactOptionalPropertyTypes` the two
  // spellings are different types, and widening here makes this un-passable to
  // the very function it exists to feed.
  repeatExecutions?: readonly RepeatExecution[];
  repeatPaid?: true;
  repeatChoices?: RepeatChoices;
  targetDiscountAxis?: "energy" | "power";
}

export function optionalAdditionalCostsFor(
  state: GameState,
  action: PricedPlay,
  card: PricedCard,
): OptionalAdditionalCosts {
  const actor = state.players[action.playerIndex]!;

  // ONE BUNDLE PER PAID INSTANCE, not one summed bundle: 820.1.c.2 makes each
  // printed instance its own Optional Additional Cost, so each gets its own
  // Ezreal pip. A one-element list for the twenty single-instance cards.
  //
  // `repeatCosts[instance]` is read defensively rather than with a `!`. The
  // validator has already refused an out-of-range instance by the time the
  // executor runs, so the two agree on every action that reaches either — but a
  // pricing helper that throws is a worse failure than one that prices what it
  // recognises, and this now runs on the execution path too.
  const repeatCosts = repeatCostsOf(card.defId);
  const repeatBundles = repeatExecutionsOf(action).flatMap((execution) => {
    const cost = repeatCosts[execution.instance];
    if (cost === undefined) return [];
    return [
      {
        energy: modifiedRepeatEnergy(state, action.playerIndex, cost.energy),
        power: cost.power ?? 0,
        rainbow: cost.rainbowPower ?? 0,
      },
    ];
  });

  // Temporal Portal's armed grant first, then Syndra's standing one — the SAME
  // precedence the enumerator and the validator use. Two spellings of that order
  // is exactly how two gates drift apart.
  const grantedRepeatCost =
    grantedRepeatCostOf(card, actor.nextSpellRepeatGrants) ?? standingRepeatGrantFor(state, action.playerIndex, card);
  const grantedEnergy = action.grantedRepeatPaid
    ? modifiedRepeatEnergy(state, action.playerIndex, grantedRepeatCost?.energy ?? 0)
    : 0;
  // A FOREIGN pip (Syndra's Chaos on a Fury spell) is NOT part of the card's own
  // Power total — it is checked against its own named domain and paid out of its
  // own reserved runes, so folding it in here would demand a Fury rune for it.
  const grantedForeignPip = foreignRepeatPip(card, grantedRepeatCost);
  const grantedPower = action.grantedRepeatPaid && !grantedForeignPip ? (grantedRepeatCost?.power ?? 0) : 0;

  const optionalPower = optionalPowerCostOf(state, action.playerIndex, card.defId);

  return discountedOptionalCosts(state, action.playerIndex, action.targetDiscountAxis, [
    ...(action.acceleratePaid ? [{ energy: ACCELERATE_ENERGY, power: ACCELERATE_POWER, rainbow: 0 }] : []),
    ...repeatBundles,
    ...(action.grantedRepeatPaid ? [{ energy: grantedEnergy, power: grantedPower, rainbow: 0 }] : []),
    // Sea Monkey pays only Energy and Blast Corps Cadet pays one of each, so the
    // Power line is not the whole price of an optional cost.
    ...(action.optionalPowerPaid
      ? [{ energy: optionalPower?.energy ?? 0, power: optionalPower?.count ?? 0, rainbow: 0 }]
      : []),
  ]);
}
