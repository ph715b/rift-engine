import type { GameState, PlayerState } from "../model/game-state.js";
import type { ActivateAbilityAction } from "./player-action.js";
import { exhaustOwnUnitAnywhere } from "../engine/effect-helpers.js";
import { validateActivateAbility } from "./validate-activate-ability.js";

/**
 * Resolves a validated ActivateAbility action — currently only
 * Lux-Crownguard's "Exhaust: Add 2 Energy. Use only to play spells."
 * (validateActivateAbility's own doc comment covers why this is a single
 * hardcoded case rather than a per-defId registry). The granted Energy
 * lands in the new restricted pool (PlayerState.restrictedSpellEnergy),
 * drained only for Spell costs and only after floating Energy — see
 * rune-payment.ts's computeEffectiveCost.
 */
export function executeActivateAbility(state: GameState, action: ActivateAbilityAction): GameState {
  const validation = validateActivateAbility(state, action);
  if (!validation.ok) throw new Error(validation.error);

  const exhausted = exhaustOwnUnitAnywhere(state, action.playerIndex, action.unitInstanceId);
  const actor = exhausted.players[action.playerIndex];
  const players = [...exhausted.players] as [PlayerState, PlayerState];
  players[action.playerIndex] = { ...actor, restrictedSpellEnergy: actor.restrictedSpellEnergy + 2 };
  return { ...exhausted, players };
}
