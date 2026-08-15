import type { GameState } from "../model/game-state.js";
import type { CardInstance } from "../model/card.js";
import type { RepeatCostSpec } from "./card-effects.js";
import type { Domain } from "../model/domain.js";
import type { RuneCard } from "../model/rune.js";

/**
 * STANDING `[Repeat]` grants — a continuous ability that gives spells a Repeat
 * cost for as long as some condition holds, as opposed to the ARMED counter
 * Temporal Portal spends on one spell.
 *
 * # The two are genuinely different, and sharing one field was the trap
 *
 * `PlayerState.nextSpellRepeatGrants` is a COUNTER: armed by Temporal Portal,
 * spent by the next spell played. UNL-146 Syndra - Transcendent's "while I'm in a
 * showdown, your spells have [Repeat] [2][Chaos]" is not a counter at all — it is
 * true of every spell for as long as she stands there, and riding the counter
 * would have given her one repeatable spell per arming instead. That was the
 * third of the three blockers her refusal named, and it is why this is a separate
 * source rather than a bigger `grantedRepeatCostOf`.
 *
 * # Her price is a CONSTANT, in a domain the spell need not print
 *
 * Temporal Portal's granted cost is derived from the card it is granted to ("a
 * [Repeat] equal to its cost"), so `grantedRepeatCostOf` returns
 * `{ energy: card.energyCost, power: card.powerCost }` and carries no domain —
 * the pip is always in the card's own. Syndra's is a flat `[2][Chaos]` handed to
 * "your spells", so the first Fury spell cast beside her owes a Fury pip and a
 * Chaos pip at once.
 *
 * **That is what makes `RepeatCostSpec.domain` load-bearing for the first time.**
 * The field existed and was dead data: both pricing sites folded a Repeat's Power
 * into `card.powerCost` and paid the total with `card.powerDomain`, which is
 * correct only because all fourteen PRINTED Repeats are in their own card's
 * domain. `repeat-cost-table.test.ts` asserts that card by card, which is exactly
 * why nobody noticed the field was unread.
 */
const SYNDRA_TRANSCENDENT = "UNL-146";

/** Her printed grant — "[Repeat] [2][Chaos]". */
const SYNDRA_REPEAT: RepeatCostSpec = { energy: 2, power: 1, domain: "Chaos" };

/**
 * Is `playerIndex` controlling a Syndra - Transcendent who is IN the open
 * showdown?
 *
 * "While I'm in a showdown" — the pool's first such condition, so there was no
 * predicate to reuse. Read as: a showdown is open, and she is standing at the
 * battlefield it is being fought over. Being merely on the board elsewhere is not
 * being in it.
 */
function syndraInShowdown(state: GameState, playerIndex: 0 | 1): boolean {
  const battlefieldId = state.showdownBattlefieldId;
  // An EARLY RETURN, not the load-bearing check — mutating it away changes no
  // answer, because a null id matches no battlefield and the lookup below then
  // finds nobody. Kept because it says what the condition IS ("while I'm in a
  // showdown" needs a showdown), and measured so the next reader knows the
  // battlefield lookup is what actually decides.
  if (battlefieldId === null) return false;
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  const mine = bf?.units[state.players[playerIndex].id] ?? [];
  return mine.some((u) => u.defId === SYNDRA_TRANSCENDENT);
}

/**
 * The standing `[Repeat]` cost `card` has for `playerIndex` right now, or
 * undefined when nothing grants one.
 *
 * Asked from every pricing site, so the enumerator, the validator and the
 * executor cannot disagree about whether the grant is live — and it is re-derived
 * from the board each time rather than latched, because "while I'm in a showdown"
 * stops being true the moment she leaves or the showdown closes.
 */
export function standingRepeatGrantFor(
  state: GameState,
  playerIndex: 0 | 1,
  card: Pick<CardInstance, "kind">,
): RepeatCostSpec | undefined {
  // "Your SPELLS" — a unit or gear is not one.
  if (card.kind !== "Spell") return undefined;
  return syndraInShowdown(state, playerIndex) ? SYNDRA_REPEAT : undefined;
}

/**
 * The part of a granted `[Repeat]`'s Power that CANNOT fold into the card's own
 * Power total — a pip in a domain the card does not print.
 *
 * Undefined for every Repeat the engine had before Syndra: a printed one is
 * always in its own card's domain (all fourteen, asserted card by card in
 * `repeat-cost-table.test.ts`), and Temporal Portal's granted one is derived from
 * the card and so shares its domain by construction. Both keep folding into
 * `powerCost` and paying with `card.powerDomain`, exactly as before.
 *
 * `powerDomainAlt` counts as the card's own — a genuinely hybrid-pip card (Tibbers)
 * can pay a pip of either printed domain from its ordinary bucket, so a grant in
 * one of them is not foreign.
 */
export function foreignRepeatPip(
  card: { powerDomain: Domain | null; powerDomainAlt?: Domain },
  spec: RepeatCostSpec | undefined,
): { domain: Domain; count: number } | undefined {
  if (spec?.domain === undefined) return undefined;
  const count = spec.power ?? 0;
  if (count <= 0) return undefined;
  if (spec.domain === card.powerDomain || spec.domain === card.powerDomainAlt) return undefined;
  return { domain: spec.domain, count };
}

/**
 * Takes `count` runes of `domain` out of the pool for a foreign pip, returning
 * them and what is left.
 *
 * **Reserved BEFORE the rest of the payment is computed, and the remainder is
 * what `computeAutoPayment` then sees.** The card's own Power is
 * domain-restricted and this pip is restricted to a DIFFERENT domain, so letting
 * the general payment run first could spend the only Chaos rune on something else
 * and make a payable play unpayable. The same ordering argument
 * `computeAutoPayment` already makes for taking the `[Deflect]` surcharge last,
 * applied from the other end.
 *
 * Undefined when the pool cannot cover it, which is how the enumerator declines
 * to offer the paid variant rather than offering one the validator refuses.
 */
export function reserveForeignPip(
  channeled: readonly RuneCard[],
  pip: { domain: Domain; count: number },
): { reserved: RuneCard[]; remaining: RuneCard[] } | undefined {
  const reserved: RuneCard[] = [];
  const remaining: RuneCard[] = [];
  for (const rune of channeled) {
    // Ready runes only: paying Power RECYCLES the rune (416), and an exhausted
    // one has nothing left to recycle. `computeAutoPayment` draws the same line
    // for the rainbow surcharge, and for the same reason.
    if (reserved.length < pip.count && rune.state === "Ready" && rune.domain === pip.domain) reserved.push(rune);
    else remaining.push(rune);
  }
  return reserved.length < pip.count ? undefined : { reserved, remaining };
}

/** For coverage.ts. */
export function standingRepeatGrantDefIds(): string[] {
  return [SYNDRA_TRANSCENDENT];
}
