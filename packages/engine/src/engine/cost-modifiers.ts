import type { GameState } from "../model/game-state.js";

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

/** The cards this module implements — see effective-might.ts's
 *  effectiveMightDefIds for why coverage.ts needs to be told. */
export function costModifierDefIds(): string[] {
  return [EAGER_APPRENTICE, RHASA_THE_SUNDERER];
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
