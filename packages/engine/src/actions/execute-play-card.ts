import type { GameState, PlayerState } from "../model/game-state.js";
import type { RuneCard } from "../model/rune.js";
import type { PlayCardAction } from "./player-action.js";
import { validatePlayCard } from "./validate-play-card.js";

/**
 * Resolves a validated PlayCard action, returning a new GameState rather than
 * mutating the input — the engine is meant to stay `(state, action) ->
 * nextState` throughout (PRD Goal 4), which is a deliberate departure from
 * the Java oracle's in-place-mutation style (see PRD open-question #2's
 * resolution): Java's ActionExecutor.executePlayCard
 * (engine/ActionExecutor.java:228-354) mutates `active.hand`/`baseUnits`/etc.
 * directly; this does the equivalent updates immutably.
 *
 * Cost payment (shared across every card kind) — payCost -> applyPayment
 * (engine/ActionExecutor.java:1869-1905):
 *   - a rune paid for Power is fully recycled — removed from the pool,
 *     reset to Ready, sent to the bottom of the rune deck (`flushToDeck`,
 *     :1907-1911) — NOT just exhausted, unlike Energy.
 *   - a rune paid for Energy only (not also Power) becomes Exhausted and
 *     stays in the pool, returning to Ready at next Awaken.
 *   - a single Ready rune CAN cover both an Energy slot and a Power slot at
 *     once ("double duty" — computeAutoPayment's own doc comment); in that
 *     case it's recycled (Power wins), and since its Energy-paying potential
 *     would otherwise go to waste, the player is credited 1 floating Energy
 *     instead (the real rule this fixes a playtesting bug for, per
 *     ActionExecutor's own comment at :1876-1886).
 *   - cardsPlayedThisTurn++ — :267
 *
 * Per-kind zone transition, post-payment:
 *   - Unit: hand.remove(card) or championZone.set(null) if played from there
 *     (:327-333); baseUnits.add(unit), entering play EXHAUSTED unless it has
 *     [Quick] (:376-384's full condition also excludes Accelerate/per-card
 *     exceptions, none modeled yet).
 *   - Spell: hand.remove(card); trash.add(card) IMMEDIATELY — before it ever
 *     resolves, mirroring ActionExecutor.payAndQueueSpell's trash-add at
 *     cast time (:566-567), not after resolution; pushes a ChainEntry onto
 *     `spellChain` and closes the chain (GameEngine.handleSpellOnChain,
 *     :280-311). Resolving the chain (execute-pass-focus.ts) does nothing
 *     further to the card's zone — it's already in trash.
 *   - Gear: hand.remove(card); activeGear.add(card) — a real "in play,
 *     unequipped" zone (ActionExecutor.executePlayCard's Card.Gear branch,
 *     :418-424). No chain interaction, no target chosen at play time —
 *     attaching to a unit is a separate EquipGear action, not implemented
 *     yet (Gear just sits here, which is itself a valid, honest game state).
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
  if (card.kind === "Legend") throw new Error("executePlayCard: Legend cards are not implemented");

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

  const handAfterRemoval = actor.hand.filter((c) => c.instanceId !== card.instanceId);
  const sharedUpdates = {
    hand: handAfterRemoval,
    channeled: remainingChanneled,
    runeDeck: [...actor.runeDeck, ...recycled],
    floatingEnergy: actor.floatingEnergy + floatingEnergyGained,
    cardsPlayedThisTurn: actor.cardsPlayedThisTurn + 1,
  };

  let updatedActor: PlayerState;
  let nextState = state;

  if (card.kind === "Unit") {
    const deployedUnit = { ...card, exhausted: !("Quick" in card.keywords) };
    const playedFromChampionZone = actor.championZone?.instanceId === card.instanceId;
    updatedActor = {
      ...actor,
      ...sharedUpdates,
      championZone: playedFromChampionZone ? null : actor.championZone,
      baseUnits: [...actor.baseUnits, deployedUnit],
    };
  } else if (card.kind === "Spell") {
    updatedActor = {
      ...actor,
      ...sharedUpdates,
      trash: [...actor.trash, card],
    };
    nextState = {
      ...nextState,
      chainOpen: false,
      chainPriority: action.playerIndex,
      chainPasses: 0,
      spellChain: [
        ...state.spellChain,
        {
          playerIndex: action.playerIndex,
          card,
          ...(action.targetUnitInstanceId !== undefined ? { targetUnitInstanceId: action.targetUnitInstanceId } : {}),
        },
      ],
    };
  } else {
    updatedActor = {
      ...actor,
      ...sharedUpdates,
      activeGear: [...actor.activeGear, card],
    };
  }

  const players = [...nextState.players] as [PlayerState, PlayerState];
  players[action.playerIndex] = updatedActor;

  return { ...nextState, players };
}
