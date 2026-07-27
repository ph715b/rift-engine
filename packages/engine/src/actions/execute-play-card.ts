import type { GameState, PlayerState } from "../model/game-state.js";
import type { PlayCardAction } from "./player-action.js";
import { validatePlayCard } from "./validate-play-card.js";

/**
 * Resolves a validated PlayCard action for a Unit going to base, returning a
 * new GameState rather than mutating the input — the engine is meant to
 * stay `(state, action) -> nextState` throughout (PRD Goal 4), which is a
 * deliberate departure from the Java oracle's in-place-mutation style (see
 * PRD open-question #2's resolution): Java's ActionExecutor.executePlayCard
 * (engine/ActionExecutor.java:228-354) mutates `active.hand`/`baseUnits` and
 * the rune pool directly; this does the equivalent updates immutably.
 *
 * Ported behavior, energy-only cost, Unit-to-base case:
 *   - hand.remove(card) — ActionExecutor.java:328
 *   - baseUnits.add(unit) (no `destination` battlefield supplied) — :353
 *   - payCost -> applyPayment: each energy rune paid becomes Exhausted,
 *     stays in the pool (returns to Ready at next Awaken) — :1889-1891
 *   - the unit enters play EXHAUSTED unless it has [Quick] — real core rule,
 *     not a placeholder default; ActionExecutor.java:376-384's full
 *     condition also excludes Accelerate/several per-card exceptions, none
 *     of which are modeled yet (no `payAccelerate` on our PlayCardAction) —
 *     only the [Quick] check is ported so far.
 *   - cardsPlayedThisTurn++ — :267
 *
 * Throws if validation fails — callers are expected to call
 * `validatePlayCard` first (e.g. when enumerating legal moves) and only
 * ever execute actions already known to be legal, matching the
 * Validator/Executor split in the Java oracle.
 */
export function executePlayCard(state: GameState, action: PlayCardAction): GameState {
  const validation = validatePlayCard(state, action);
  if (!validation.ok) throw new Error(validation.error);

  const actor = state.players[action.playerIndex];
  const card = action.card;
  if (card.kind !== "Unit") throw new Error("executePlayCard: only Unit cards are implemented so far");

  const paidEnergyRuneIds = new Set(action.payment.energyRunes);
  const updatedChanneled = actor.channeled.map((rune) =>
    paidEnergyRuneIds.has(rune.id) ? { ...rune, state: "Exhausted" as const } : rune,
  );

  const deployedUnit = { ...card, exhausted: !("Quick" in card.keywords) };

  const updatedActor: PlayerState = {
    ...actor,
    hand: actor.hand.filter((c) => c.instanceId !== card.instanceId),
    channeled: updatedChanneled,
    baseUnits: [...actor.baseUnits, deployedUnit],
    cardsPlayedThisTurn: actor.cardsPlayedThisTurn + 1,
  };

  const players = [...state.players] as [PlayerState, PlayerState];
  players[action.playerIndex] = updatedActor;

  return { ...state, players };
}
