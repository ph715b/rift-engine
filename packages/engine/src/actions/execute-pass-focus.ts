import { isSpellChainEntry, type GameState } from "../model/game-state.js";
import { resolvePendingTrigger } from "../engine/triggers.js";
import { closeShowdown } from "../engine/combat.js";
import { resolveCardEffect } from "../engine/card-effect-resolution.js";
import { dispatchOnSpellCast, resolveHeldOnMoveTrigger, resolveHeldOnPlayTrigger } from "../engine/unit-triggers.js";
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

  // A triggered ability waiting as a Pending Item (809.1.b.3) resolves like any
  // other chain item, but it is not a Spell: it has no cost to total and no
  // on-spell-cast listeners to notify, so it takes its own short path and never
  // reaches the Spell handling below (which reads `poppedEntry.card`).
  //
  // This branch was written before anything could reach it, so that converting
  // the dispatch sites would be a series of small changes against a resolution
  // path that already worked. Seven event kinds now push here (see
  // `HeldEventKind`), including three fired from the turn machinery itself — so
  // an ordinary turn with a Pirate's Haven on the board comes through this line
  // once per unit that Awakened.
  if (!isSpellChainEntry(poppedEntry)) {
    // THREE registries can produce a held trigger now, and `source` says which —
    // an EventTrigger-registry ability (a bystander watching the board), or a
    // unit's own "when you play me" / "when I move". They resolve differently
    // enough to need separate functions: see resolveHeldOnPlayTrigger on why a
    // dead source still resolves while a dead LISTENER does not. The two
    // unit-sourced kinds share that rule and differ only in their event shape.
    const afterTrigger =
      poppedEntry.source === "unitOnPlay"
        ? resolveHeldOnPlayTrigger(state, poppedEntry)
        : poppedEntry.source === "unitOnMove"
          ? resolveHeldOnMoveTrigger(state, poppedEntry)
          : resolvePendingTrigger(state, poppedEntry);
    const remaining = afterTrigger.spellChain.slice(0, -1);
    return finishChainPop(afterTrigger, remaining);
  }

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
  return finishChainPop(resolved, resolved.spellChain.slice(0, -1)); // pop the top (LIFO — last pushed)
}

/**
 * What happens once ANY chain item has resolved and been popped: either the
 * chain empties and the turn returns to an Open State, or the next link down
 * gets a fresh round of passes.
 *
 * Extracted so a Spell and a triggered ability share one exit rather than two
 * copies — the Showdown focus-pass rule (346) is subtle enough that a second
 * copy would drift, and a trigger resolving is just as much "the last item on
 * the chain" as a Spell is.
 */
function finishChainPop(resolved: GameState, spellChain: GameState["spellChain"]): GameState {
  if (spellChain.length === 0) {
    // The chain is empty, so how it opened stops being a live question — cleared
    // here rather than left to go stale, because unlike chainPriority this one is
    // read on the very next thing that closes the chain.
    const openedByTrigger = resolved.chainOpenedByTrigger;
    const reopened = { ...resolved, spellChain, chainOpen: true, chainPasses: 0, chainOpenedByTrigger: false };
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
    // 347's exception, now a real branch: "Focus will not pass in this way if the
    // chain opened as a result of a triggered ability being added to the chain, nor
    // if it opened as a result of an Add ability." Its printed example is the
    // Combat Chain, which opens exactly that way.
    //
    // This used to be a comment saying the case was unreachable because nothing but
    // a played Spell reached the chain. Triggers held as Pending Items and flushed
    // onto the chain make it reachable, and it is not cosmetic: staging a Showdown
    // gives Focus to whoever contested the battlefield (345, cleanup.stageShowdowns)
    // and then fires `combatBegan`. Without this branch that trigger's own
    // resolution would hand Focus straight to their opponent, before the player who
    // opened the Showdown had taken a single action inside it.
    //
    // Read from state, not from the popped entry — see chainOpenedByTrigger. A
    // [Reaction] Spell cast in response to a trigger is the last thing to pop, and
    // testing IT would take the wrong branch.
    if (openedByTrigger) return reopened;
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
