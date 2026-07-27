import type { GameState } from "../model/game-state.js";
import { resolveShowdown } from "../engine/combat.js";
import type { PassFocusAction } from "./player-action.js";
import { validatePassFocus } from "./validate-pass-focus.js";

/**
 * Resolves a validated PassFocus action. Mirrors GameEngine.handlePassFocus's
 * open-Showdown branch, handleFocusPassOpenShowdown (engine/GameEngine.java:396-409):
 * a single pass just flips Focus to the opponent and increments the
 * consecutive-pass counter; two consecutive passes close the window and
 * resolve combat.
 *
 * `state.activePlayerIndex` is used as the attacker for `resolveShowdown`
 * rather than a dedicated `showdownAttackerIndex` field: it's frozen for the
 * Showdown's entire lifetime (Pass, the only action that changes it, is
 * illegal while turnState is "Showdown"), and is always the player who moved
 * the triggering unit in (validateMoveUnit requires the mover to be the
 * active player). Java's `showdownAttacker` field only needs to differ from
 * `activePlayer()` for Charm-style effects that let a caster move an
 * *enemy's* unit — nothing like that is implemented here.
 */
export function executePassFocus(state: GameState, action: PassFocusAction): GameState {
  const validation = validatePassFocus(state, action);
  if (!validation.ok) throw new Error(validation.error);

  const consecutiveFocusPasses = state.consecutiveFocusPasses + 1;
  if (consecutiveFocusPasses < 2) {
    const opponent: 0 | 1 = action.playerIndex === 0 ? 1 : 0;
    return { ...state, focusHolder: opponent, consecutiveFocusPasses };
  }

  const resolved = resolveShowdown(state, state.showdownBattlefieldId!, state.activePlayerIndex);
  return {
    ...resolved,
    turnState: "Neutral",
    showdownBattlefieldId: null,
    consecutiveFocusPasses: 0,
  };
}
