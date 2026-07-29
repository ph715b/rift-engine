import type { GameState } from "../model/game-state.js";

/**
 * Cross-cutting cost modifiers — checked at every cost-computation call
 * site (validate-play-card.ts, legal-actions.ts, execute-play-card.ts's
 * float-deduction math), same choke-point convention as damage-modifiers.ts.
 * Deliberately narrow (one confirmed card) rather than a general modifier-
 * stacking system.
 */
export function modifiedEnergyCost(
  state: GameState,
  playerIndex: 0 | 1,
  cardKind: "Unit" | "Spell" | "Gear" | "Legend",
  rawEnergyCost: number,
): number {
  if (cardKind !== "Spell") return rawEnergyCost;
  const player = state.players[playerIndex];
  // Eager Apprentice: "While I'm at a battlefield, the Energy costs for
  // spells you play is reduced by 1, to a minimum of 1." Battlefield
  // presence only — a base-zone Eager Apprentice does not apply (unlike
  // Annie-Fiery's base-or-battlefield damage modifier).
  const hasEagerApprenticeAtBattlefield = state.battlefields.some((bf) =>
    (bf.units[player.id] ?? []).some((u) => u.defId === "OGN-084"),
  );
  return hasEagerApprenticeAtBattlefield ? Math.max(1, rawEnergyCost - 1) : rawEnergyCost;
}
