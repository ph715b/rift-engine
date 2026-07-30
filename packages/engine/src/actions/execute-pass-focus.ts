import type { GameState } from "../model/game-state.js";
import { closeShowdown } from "../engine/combat.js";
import { resolveCardEffect } from "../engine/card-effect-resolution.js";
import { dispatchOnSpellCast } from "../engine/unit-triggers.js";
import { dispatchLegendOnSpellCast } from "../engine/legend-abilities.js";
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
 * A chain closing while a Showdown is ALSO open now happens routinely — that's
 * what Action-speed casting into a Showdown produces — and rule 346 says Focus
 * passes when it does. See the branch below (Java does the same at
 * GameEngine.java:754-757).
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
  //
  // "Costs 5 or more" means the WHOLE printed cost, Energy plus Power — this
  // used to pass energyCost alone, so a 4-Energy/1-Power spell (a real shape
  // in this pool) silently failed to trigger Lux - Illuminated. Both Lux
  // cards read the combined figure in the oracle (UnitAbilities.java:66 and
  // LegendAbilities.java:47 are the same `energyCost + powerCost >= 5`).
  const totalCost = poppedEntry.card.energyCost + poppedEntry.card.powerCost;
  const afterUnits = dispatchOnSpellCast(resolvedEffect, poppedEntry.playerIndex, totalCost);
  // The caster's Legend listens at the same moment (Lux - Lady of Luminosity).
  const resolved = dispatchLegendOnSpellCast(afterUnits, poppedEntry.playerIndex, totalCost);
  const spellChain = resolved.spellChain.slice(0, -1); // pop the top (LIFO — last pushed)
  if (spellChain.length === 0) {
    const reopened = { ...resolved, spellChain, chainOpen: true, chainPasses: 0 };
    if (reopened.turnState !== "Showdown") return reopened;
    // Rule 346: "When the last item on the chain resolves and the turn returns to
    // an Open State during a Showdown, Focus passes, and the next Player gains
    // both Focus and Priority." Rule 348 is the reason it matters — playing a
    // card during a Showdown starts a Chain, and "when that Chain closes, Focus
    // passes to the next Player in Turn Order", so casting is a turn-taking move
    // inside the window rather than a free action.
    //
    // The pass count resets because the all-passed sequence (349) was broken by
    // someone actually doing something; without that, one earlier pass plus this
    // cast would let the very next pass close the window.
    //
    // 347's exception — Focus does NOT pass if the chain was opened by a
    // triggered ability or an Add ability — is unreachable here: nothing in this
    // engine puts anything but a played Spell on the chain. Left as a comment
    // rather than a branch that could never be exercised or tested.
    const nextFocus: 0 | 1 = reopened.focusHolder === 0 ? 1 : 0;
    return { ...reopened, focusHolder: nextFocus, chainPriority: nextFocus, consecutiveFocusPasses: 0 };
  }
  // The player who owns the next link to resolve gets priority first for a
  // fresh round of passes on it — mirrors GameEngine.java:758-767, and rule 345
  // ("the controller of the newest item on the chain gains Priority"). Reachable
  // through public actions now that [Reaction] can add to a closed chain; it was
  // written against a white-box fixture before that, and needed no restructuring
  // when the real path arrived.
  const newTop = spellChain[spellChain.length - 1]!;
  return { ...resolved, spellChain, chainPriority: newTop.playerIndex, chainPasses: 0 };
}

/**
 * Mirrors GameEngine.handleFocusPassOpenShowdown (engine/GameEngine.java:396-409):
 * a single pass just flips Focus to the opponent and increments the
 * consecutive-pass counter; two consecutive passes close the window.
 *
 * Rule 349: "If all Players have passed once in sequence, the Showdown ends."
 * What happens then depends on which kind of Showdown it was, which is
 * `closeShowdown`'s job — a Combat Showdown runs the remaining steps of Combat
 * (351.1), a Non-Combat one just establishes Control (352.1). This used to call
 * `resolveShowdown` directly, on the assumption that every Showdown was a fight.
 */
function resolveShowdownFocusPass(state: GameState, action: PassFocusAction): GameState {
  const consecutiveFocusPasses = state.consecutiveFocusPasses + 1;
  if (consecutiveFocusPasses < 2) {
    const opponent: 0 | 1 = action.playerIndex === 0 ? 1 : 0;
    return { ...state, focusHolder: opponent, consecutiveFocusPasses };
  }

  const resolved = closeShowdown(state);
  return {
    ...resolved,
    turnState: "Neutral",
    showdownBattlefieldId: null,
    showdownKind: null,
    consecutiveFocusPasses: 0,
  };
}
