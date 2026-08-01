import type { GameState } from "../model/game-state.js";
import { defaultCardRegistry } from "../cards/card-registry.js";
import { opponentNearVictory } from "./constants.js";
import { legionActive } from "./effect-helpers.js";

/**
 * Cross-cutting cost modifiers — checked at every cost-computation call
 * site (validate-play-card.ts, legal-actions.ts, execute-play-card.ts's
 * float-deduction math), same choke-point convention as damage-modifiers.ts.
 * Deliberately narrow (one confirmed card) rather than a general modifier-
 * stacking system.
 */
/** Eager Apprentice: "While I'm at a battlefield, the Energy costs for spells
 *  you play is reduced by 1, to a minimum of 1." Battlefield presence only — a
 *  base-zone Eager Apprentice does not apply (unlike Annie - Fiery's
 *  base-or-battlefield damage modifier). */
const EAGER_APPRENTICE = "OGN-084";

/** Rhasa the Sunderer: "I cost 1 Energy less for each card in your trash." A
 *  self-scaling cost rather than a modifier on other cards — the only one of its
 *  shape in the pool, which is why it keys off the card being played rather than
 *  off the board. */
const RHASA_THE_SUNDERER = "OGN-195";

/**
 * `[Legion] — I cost N less.` (Noxus Hopeful)
 *
 * Handled as a RULE rather than as a per-card branch, because it already is
 * one: `card-loader.ts` derives `legionDiscount` from the printed text of every
 * card, so the discount is data the definition carries and any future
 * "[Legion] — I cost N less" card works with no edit here. That is the opposite
 * choice from the two hardcoded ids above, and it earns it — those two are
 * genuinely bespoke sentences, this is a keyword with a number.
 *
 * Cost time, so `countingSelf: false`: the card being priced has not been played
 * yet, and "another card" is any one card.
 */
function legionDiscountFor(state: GameState, playerIndex: 0 | 1, defId: string | undefined): number {
  if (defId === undefined) return 0;
  const def = defaultCardRegistry().tryGet(defId);
  const discount = def && "legionDiscount" in def ? def.legionDiscount : 0;
  if (discount <= 0) return 0;
  return legionActive(state, playerIndex, false) ? discount : 0;
}

/** Every card whose printed `[Legion] — I cost N less` this module implements.
 *  Derived from the pool rather than listed, for the same reason the discount
 *  itself is: a hand-kept list would drift the first time a card was added. */
function legionDiscountDefIds(): string[] {
  return defaultCardRegistry()
    .all()
    .filter((def) => "legionDiscount" in def && def.legionDiscount > 0)
    .map((def) => def.id);
}

/**
 * Find Your Center: "If an opponent's score is within 3 points of the Victory
 * Score, this costs 2 Energy less."
 *
 * The same comeback clause Leona - Zealot's enter-ready half reads, and asked
 * through the same shared predicate so the two can never disagree about what
 * "within 3" means. Its own half — draw 1 and channel 1 — is in effects/calm.ts;
 * only the cost can live here, because a cost has to be known before the card is
 * paid for.
 */
const FIND_YOUR_CENTER = "OGN-047";
const FIND_YOUR_CENTER_DISCOUNT = 2;

/** The cards this module implements — see effective-might.ts's
 *  effectiveMightDefIds for why coverage.ts needs to be told. */
export function costModifierDefIds(): string[] {
  return [EAGER_APPRENTICE, RHASA_THE_SUNDERER, FIND_YOUR_CENTER, ...legionDiscountDefIds()];
}

/**
 * A card's Energy cost after every cross-cutting modifier.
 *
 * `defId` is optional so that existing callers computing a cost for a card they
 * only know structurally keep working; pass it and self-scaling costs apply too.
 * Floored at 0, not at 1: the general rule has no minimum, and the one card in
 * this pool that DOES state a minimum ("to a minimum of 1") states it on itself.
 */
export function modifiedEnergyCost(
  state: GameState,
  playerIndex: 0 | 1,
  cardKind: "Unit" | "Spell" | "Gear" | "Legend",
  rawEnergyCost: number,
  defId?: string,
): number {
  const player = state.players[playerIndex];
  let cost = rawEnergyCost;

  // Before the other two: a discount that only sometimes applies should be taken
  // off the printed cost, not off an already-reduced one, and Eager Apprentice's
  // own "to a minimum of 1" then clamps whatever is left.
  cost = Math.max(0, cost - legionDiscountFor(state, playerIndex, defId));

  if (defId === FIND_YOUR_CENTER && opponentNearVictory(state, playerIndex)) {
    cost = Math.max(0, cost - FIND_YOUR_CENTER_DISCOUNT);
  }

  if (defId === RHASA_THE_SUNDERER) {
    // "For EACH card in your trash" — your own trash only, and every card in it,
    // not just units. A long game makes this free, which is the card's point.
    cost = Math.max(0, cost - player.trash.length);
  }

  if (cardKind === "Spell") {
    const hasEagerApprenticeAtBattlefield = state.battlefields.some((bf) =>
      (bf.units[player.id] ?? []).some((u) => u.defId === EAGER_APPRENTICE),
    );
    // Eager Apprentice's own floor of 1, stated on the card.
    if (hasEagerApprenticeAtBattlefield) cost = Math.max(1, cost - 1);
  }

  return cost;
}
