import {
  costExhaustsLegend,
  optionalPowerCostOf,
  repeatCostOf,
  type CardInstance,
  type PlayCardAction,
} from "@rift-engine/engine";

/**
 * The yes/no costs a player may take as they play a card, and the board's ONE
 * way of asking about them.
 *
 * # Why these four are one mechanism
 *
 * `ui-can-express-every-choice.test.ts` measured twelve choices the engine fans
 * out and the board could not express. Four of them — `repeatPaid`,
 * `grantedRepeatPaid`, `optionalPowerPaid`, `exhaustLegendPaid` — are the same
 * shape: a BOOLEAN the enumerator emits two candidates for, differing only in
 * whether an additional cost was paid. Together they are about twenty cards,
 * including the whole `[Repeat]` keyword.
 *
 * The board resolved all four by taking whichever candidate `find` returned
 * first, so `[Repeat]` was never offered at all, and Bard - Mercurial's and
 * Akshan - Mischievous's entire paid halves were unreachable — both shipped in
 * the same week and both passed every engine gate.
 *
 * # Why the axes are a table rather than four branches
 *
 * A card can carry MORE THAN ONE at once: 3509 makes a printed `[Repeat]` and a
 * granted one independently payable, so a spell under Temporal Portal has two
 * boolean axes and four priced combinations. Four hardcoded branches would each
 * have to know about the others; one table asked in order does not.
 *
 * It is also the shape this whole sweep exists because of. A hand-written list of
 * the engine's choices inside a 2,400-line component is what left
 * `unitAndEquipment` unhandled — so this list is small, declared in one place, and
 * the gate test asserts it covers exactly the fields it claims.
 */
export interface OptionalCostAxis {
  /** The `PlayCardAction` flag this axis sets. */
  readonly field: "repeatPaid" | "grantedRepeatPaid" | "optionalPowerPaid" | "exhaustLegendPaid";
  /** What the player is being asked, in the card's own terms. */
  readonly prompt: (card: CardInstance) => string;
}

/** A cost's pips, as a player reads them — "[2][Fury]", "[1]", "[Calm]". */
function pips(cost: { energy?: number; power?: number; count?: number; domain?: string | null; rainbowPower?: number }): string {
  const parts: string[] = [];
  if (cost.energy) parts.push(`${cost.energy} Energy`);
  const power = cost.power ?? cost.count ?? 0;
  if (power > 0) parts.push(`${power} ${cost.domain ?? "rainbow"} Power`);
  if (cost.rainbowPower) parts.push(`${cost.rainbowPower} rainbow Power`);
  return parts.length > 0 ? parts.join(" + ") : "nothing";
}

/**
 * The axes, in the order they are asked.
 *
 * `[Repeat]` leads because it is the one that changes what the card DOES rather
 * than only what it costs — a player deciding whether to pay a Power pip wants to
 * know first whether the spell is resolving once or twice.
 */
export const OPTIONAL_COST_AXES: readonly OptionalCostAxis[] = [
  {
    field: "repeatPaid",
    prompt: (card) => {
      const cost = repeatCostOf(card.defId);
      return `Pay ${cost ? pips(cost) : "its [Repeat] cost"} to repeat ${card.name}?`;
    },
  },
  {
    field: "grantedRepeatPaid",
    // The GRANTED instance (Temporal Portal). Named apart from the printed one
    // above, because a spell can be asked both and "repeat it again?" would not
    // say which instance is being paid for.
    prompt: (card) => `Pay the GRANTED [Repeat] cost to execute ${card.name} an additional time?`,
  },
  {
    field: "optionalPowerPaid",
    prompt: (card) => {
      const cost = optionalPowerCostOf(card.defId);
      return `Pay ${cost ? pips(cost) : "the additional cost"} as an additional cost for ${card.name}?`;
    },
  },
  {
    field: "exhaustLegendPaid",
    prompt: (card) => `Exhaust your legend as an additional cost for ${card.name}?`,
  },
];

/** Does this card carry this axis at all? Asked of the ENGINE's own tables, so a
 *  card gaining an optional cost needs no edit here. `grantedRepeatPaid` is not
 *  card-keyed — it depends on a Portal having been played — so it is decided by
 *  the candidates instead, in `pendingOptionalCostAxis` below. */
export function cardHasAxis(card: CardInstance, field: OptionalCostAxis["field"]): boolean {
  switch (field) {
    case "repeatPaid":
      return repeatCostOf(card.defId) !== undefined;
    case "optionalPowerPaid":
      return optionalPowerCostOf(card.defId) !== undefined;
    case "exhaustLegendPaid":
      return costExhaustsLegend(card.defId);
    case "grantedRepeatPaid":
      return false;
  }
}

/** The choices already answered on an armed play. */
export type ResolvedOptionalCosts = Partial<Record<OptionalCostAxis["field"], boolean>>;

/**
 * The next yes/no cost to ask about, or undefined when they are all settled.
 *
 * **Decided from the CANDIDATES, not from the card**, which is what makes it
 * correct for a cost the player cannot afford: the enumerator simply does not
 * emit the paid variant, so the axis never varies and is never asked. A version
 * keyed only on the card would stall on a question with one answer — the trap
 * `advanceDecisions` avoids by executing a one-option decision rather than
 * showing it.
 */
export function pendingOptionalCostAxis(
  candidates: readonly PlayCardAction[],
  resolved: ResolvedOptionalCosts,
): OptionalCostAxis | undefined {
  return OPTIONAL_COST_AXES.find((axis) => {
    if (resolved[axis.field] !== undefined) return false;
    const paid = candidates.some((a) => a[axis.field] === true);
    const declined = candidates.some((a) => a[axis.field] !== true);
    // Both must be on offer, or there is nothing to choose between.
    return paid && declined;
  });
}

/**
 * Does a candidate carry the yes/no answers already given?
 *
 * An UNANSWERED axis is a wildcard, so every candidate stays live and the next
 * step has something to offer. An answered one is compared against `=== true`
 * rather than truthiness, because the flags are `true | undefined` on the action
 * and `false` is a real answer the player gave.
 */
export function matchesOptionalCosts(candidate: PlayCardAction, resolved: ResolvedOptionalCosts): boolean {
  return OPTIONAL_COST_AXES.every((axis) => {
    const answer = resolved[axis.field];
    if (answer === undefined) return true;
    return (candidate[axis.field] === true) === answer;
  });
}
