import type { GameState } from "../model/game-state.js";
import { resolveShowdown } from "../engine/combat.js";
import { resolveCardEffect } from "../engine/card-effect-resolution.js";
import { dispatchOnSpellCast } from "../engine/unit-triggers.js";
import type { PassFocusAction } from "./player-action.js";
import { validatePassFocus } from "./validate-pass-focus.js";

/**
 * Resolves a validated PassFocus action. Dispatches on `chainOpen` first,
 * mirroring GameEngine.handlePassFocus (engine/GameEngine.java:390-394):
 * a closed chain (a Spell pending resolution) resolves via `resolveChainPass`
 * regardless of turnState; an open chain falls through to the existing
 * Showdown-Focus-pass logic (only meaningful when turnState is "Showdown").
 */
export function executePassFocus(state: GameState, action: PassFocusAction): GameState {
  const validation = validatePassFocus(state, action);
  if (!validation.ok) throw new Error(validation.error);

  if (!state.chainOpen) {
    return resolveChainPass(state, action);
  }
  return resolveShowdownFocusPass(state, action);
}

/**
 * Two consecutive PassFocus actions while the chain is closed resolve its
 * top entry. Mirrors GameEngine.handleChainPass (engine/GameEngine.java:742-771).
 * Dispatches the popped entry to `resolveCardEffect`, which no-ops for any
 * card with no registered effect (card-effects.ts) — exactly Java's own
 * safe no-op-if-unregistered-effect behavior
 * (ActionExecutor.resolveChainEntry only dispatches `if (EffectRegistry.has(...))`).
 *
 * Deliberately NOT handling the case where the chain closes while a Showdown
 * is also open (Java's handleChainPass hands Focus back to the opponent and
 * resets consecutiveFocusPasses there, GameEngine.java:754-757) — that
 * combination can't occur in this engine yet, since validatePlayCard rejects
 * all PlayCard while turnState isn't "Neutral", so a chain can never close
 * during an open Showdown. Add that branch back if Showdown-window
 * spell-casting is supported later.
 */
function resolveChainPass(state: GameState, action: PassFocusAction): GameState {
  const chainPasses = state.chainPasses + 1;
  if (chainPasses < 2) {
    const opponent: 0 | 1 = action.playerIndex === 0 ? 1 : 0;
    return { ...state, chainPriority: opponent, chainPasses };
  }

  const poppedEntry = state.spellChain[state.spellChain.length - 1]!;
  const resolvedEffect = resolveCardEffect(state, poppedEntry);
  // On-spell-cast listeners (Ravenbloom Student, Lux-Illuminated) fire once
  // the Spell's own effect has resolved — every ChainEntry is a Spell by
  // construction (ChainEntry.card: SpellInstance), so this always applies.
  const resolved = dispatchOnSpellCast(resolvedEffect, poppedEntry.playerIndex, poppedEntry.card.energyCost);
  const spellChain = resolved.spellChain.slice(0, -1); // pop the top (LIFO — last pushed)
  if (spellChain.length === 0) {
    return { ...resolved, spellChain, chainOpen: true, chainPasses: 0 };
  }
  // The player who owns the next link to resolve gets priority first for a
  // fresh round of passes on it — mirrors GameEngine.java:758-767. Currently
  // unreachable via any public action (nothing can push a 2nd chain entry
  // before the 1st resolves, since reaction-speed casting isn't supported
  // yet) but kept correct and covered by a white-box test, not speculative:
  // it needs no restructuring the moment reaction casting is added.
  const newTop = spellChain[spellChain.length - 1]!;
  return { ...resolved, spellChain, chainPriority: newTop.playerIndex, chainPasses: 0 };
}

/**
 * Mirrors GameEngine.handleFocusPassOpenShowdown (engine/GameEngine.java:396-409):
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
function resolveShowdownFocusPass(state: GameState, action: PassFocusAction): GameState {
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
