import type { GameState, PlayerState } from "../model/game-state.js";
import type { RuneCard } from "../model/rune.js";
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
 * Ported behavior, Unit-to-base case:
 *   - hand.remove(card), or championZone.set(null) if it was played from
 *     there instead — ActionExecutor.java:327-333
 *   - baseUnits.add(unit) (no `destination` battlefield supplied) — :353
 *   - payCost -> applyPayment (engine/ActionExecutor.java:1869-1905):
 *     - a rune paid for Power is fully recycled — removed from the pool,
 *       reset to Ready, sent to the bottom of the rune deck (`flushToDeck`,
 *       :1907-1911) — NOT just exhausted, unlike Energy.
 *     - a rune paid for Energy only (not also Power) becomes Exhausted and
 *       stays in the pool, returning to Ready at next Awaken.
 *     - a single Ready rune CAN cover both an Energy slot and a Power slot
 *       at once ("double duty" — computeAutoPayment's own doc comment); in
 *       that case it's recycled (Power wins), and since its Energy-paying
 *       potential would otherwise go to waste, the player is credited 1
 *       floating Energy instead (the real rule this fixes a playtesting
 *       bug for, per ActionExecutor's own comment at :1876-1886).
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

  const paidEnergyIds = new Set(action.payment.energyRunes);
  const paidPowerIds = new Set(action.payment.powerRunes);

  let floatingEnergyGained = 0;
  const recycled: RuneCard[] = [];
  const remainingChanneled: RuneCard[] = [];
  for (const rune of actor.channeled) {
    if (paidPowerIds.has(rune.id)) {
      // Double duty: this Ready rune also paid an Energy slot, but gets
      // recycled (Power wins) instead of merely Exhausted — credit the
      // Energy-paying potential it would otherwise have wasted.
      if (paidEnergyIds.has(rune.id)) floatingEnergyGained += 1;
      recycled.push({ ...rune, state: "Ready" });
    } else if (paidEnergyIds.has(rune.id)) {
      remainingChanneled.push({ ...rune, state: "Exhausted" });
    } else {
      remainingChanneled.push(rune);
    }
  }

  const deployedUnit = { ...card, exhausted: !("Quick" in card.keywords) };
  const playedFromChampionZone = actor.championZone?.instanceId === card.instanceId;

  const updatedActor: PlayerState = {
    ...actor,
    hand: actor.hand.filter((c) => c.instanceId !== card.instanceId),
    championZone: playedFromChampionZone ? null : actor.championZone,
    channeled: remainingChanneled,
    runeDeck: [...actor.runeDeck, ...recycled],
    floatingEnergy: actor.floatingEnergy + floatingEnergyGained,
    baseUnits: [...actor.baseUnits, deployedUnit],
    cardsPlayedThisTurn: actor.cardsPlayedThisTurn + 1,
  };

  const players = [...state.players] as [PlayerState, PlayerState];
  players[action.playerIndex] = updatedActor;

  return { ...state, players };
}
