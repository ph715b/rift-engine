import type { GameState } from "../model/game-state.js";
import type { ActivateAbilityAction } from "./player-action.js";
import { fail, ok, type ValidationResult } from "./validation-result.js";

/** Units with a real activated ability in this card pool — just
 *  Lux-Crownguard's "Exhaust: Add 2 Energy. Use only to play spells."
 *  Widen this set (and execute-activate-ability.ts's resolution) the day a
 *  second activated-ability card is implemented, not preemptively —
 *  matches this codebase's existing small-hardcoded-set convention
 *  (VISION_UNIT_DEF_IDS, OPEN_PLACEMENT_UNIT_DEF_IDS, etc.). */
const ACTIVATABLE_UNIT_DEF_IDS = new Set(["OGS-014"]); // Lux-Crownguard

export function hasActivatableAbility(defId: string): boolean {
  return ACTIVATABLE_UNIT_DEF_IDS.has(defId);
}

/**
 * Validates an ActivateAbility action. Mirrors validateFloatRune's own
 * permissiveness (both mirror a [Reaction]-tagged ability meant to be
 * usable essentially any time during the Action phase to bank a resource
 * for a later Spell): no turnState/chainOpen/whose-priority-it-is check,
 * just phase + ownership + the unit being Ready and actually having this
 * ability.
 */
export function validateActivateAbility(state: GameState, action: ActivateAbilityAction): ValidationResult {
  if (state.phase !== "Action") {
    return fail(`Abilities can only be activated during the Action phase, currently: ${state.phase}`);
  }

  const actor = state.players[action.playerIndex];
  if (!actor) return fail(`No player at index ${action.playerIndex}`);

  const inBase = actor.baseUnits.find((u) => u.instanceId === action.unitInstanceId);
  const atBattlefield = inBase
    ? undefined
    : state.battlefields.flatMap((bf) => bf.units[actor.id] ?? []).find((u) => u.instanceId === action.unitInstanceId);
  const unit = inBase ?? atBattlefield;
  if (!unit) {
    return fail(`No unit with id ${action.unitInstanceId} controlled by player ${action.playerIndex}`);
  }
  if (!hasActivatableAbility(unit.defId)) {
    return fail(`${unit.name} has no activated ability`);
  }
  if (unit.exhausted) {
    return fail(`${unit.name} must be Ready to activate this ability`);
  }

  return ok();
}
