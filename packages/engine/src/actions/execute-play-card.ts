import type { GameState, PlayerState } from "../model/game-state.js";
import type { RuneCard } from "../model/rune.js";
import { claimBattlefieldControl } from "../engine/combat.js";
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
 *   - before rune selection, floating Energy/Power (banked from earlier
 *     recycled runes this same turn) reduces the printed cost — validated
 *     against by validate-play-card.ts's computeEffectiveCost, and spent
 *     here independently via `deductFloat`'s own re-derivation from the RAW
 *     cost (never trusting a value validation already computed).
 *   - a rune paid for Power is fully recycled — removed from the pool,
 *     reset to Ready, sent to the bottom of the rune deck (`flushToDeck`,
 *     :1907-1911) — NOT just exhausted, unlike Energy.
 *   - a rune paid for Energy only (not also Power) becomes Exhausted and
 *     stays in the pool, returning to Ready at next Awaken.
 *   - a single Ready rune CAN cover both an Energy slot and a Power slot at
 *     once ("double duty" — computeAutoPayment's own doc comment); in that
 *     case it's recycled (Power wins) and its Energy-paying potential is
 *     used directly by that same payment, so nothing further is credited.
 *   - a Ready rune recycled for Power WITHOUT also being used for Energy in
 *     the same payment has its Energy-paying potential go to waste by being
 *     recycled — so THAT case (not double duty) is what credits 1 floating
 *     Energy instead, per ActionExecutor.applyPayment's real rule (:1876-1886):
 *     `if (rune.isReady() && !payment.energyRunes().contains(rune))
 *     player.floatingEnergy += 1;` — i.e. credited whenever a Ready
 *     power-rune is NOT also an energy-rune in this payment, not the reverse.
 *   - cardsPlayedThisTurn++ — :267
 *
 * Per-kind zone transition, post-payment:
 *   - Unit, no destination: hand.remove(card) or championZone.set(null) if
 *     played from there (:327-333); baseUnits.add(unit), entering play
 *     EXHAUSTED unless it has [Quick] (:376-384's full condition also
 *     excludes Accelerate/per-card exceptions, none modeled yet).
 *   - Unit, with destinationBattlefieldId ("reinforce" — see
 *     validate-play-card.ts's presence rule): added to that battlefield's
 *     units instead of base, exhaustion rule unchanged (destination-agnostic
 *     per ActionExecutor.java:376-384). Landing on a contested battlefield
 *     opens a Showdown via the identical mechanism MoveUnit's does — a
 *     confirmed real mechanic, not inferred (GameEngine.java:201-263's own
 *     "playtesting fix" comment: a unit played directly to a battlefield
 *     never opened a real Showdown even when landing on enemy-occupied
 *     territory). Landing uncontested claims control immediately
 *     (`claimBattlefieldControl`, same walk-in shape MoveUnit's uncontested
 *     case uses).
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
      // A Ready rune recycled for Power that is NOT also used for Energy in
      // this same payment has its Energy-paying potential wasted by being
      // recycled — bank it as floating Energy instead. True double duty
      // (also in energyRunes) already spends that potential directly, so no
      // credit is due there.
      if (rune.state === "Ready" && !paidEnergyIds.has(rune.id)) floatingEnergyGained += 1;
      recycled.push({ ...rune, state: "Ready" });
    } else if (paidEnergyIds.has(rune.id)) {
      remainingChanneled.push({ ...rune, state: "Exhausted" });
    } else {
      remainingChanneled.push(rune);
    }
  }

  // Floating Energy/Power is deducted independently here, re-derived fresh
  // from the RAW printed cost rather than trusting validatePlayCard's
  // effective-cost math — mirrors ActionExecutor's deductFloat, which never
  // trusts an earlier-computed value at mutation time. Energy floats freely;
  // Power floats only within its matching domain (card.powerDomain is only
  // ever null when powerCost is 0, so the lookup is never needed then).
  const floatingEnergySpent = Math.min(actor.floatingEnergy, card.energyCost);
  const floatingPowerAvailable = card.powerDomain !== null ? (actor.floatingPower[card.powerDomain] ?? 0) : 0;
  const floatingPowerSpent = Math.min(floatingPowerAvailable, card.powerCost);

  const handAfterRemoval = actor.hand.filter((c) => c.instanceId !== card.instanceId);
  const sharedUpdates = {
    hand: handAfterRemoval,
    channeled: remainingChanneled,
    runeDeck: [...actor.runeDeck, ...recycled],
    floatingEnergy: actor.floatingEnergy - floatingEnergySpent + floatingEnergyGained,
    floatingPower:
      card.powerDomain !== null && floatingPowerSpent > 0
        ? { ...actor.floatingPower, [card.powerDomain]: floatingPowerAvailable - floatingPowerSpent }
        : actor.floatingPower,
    cardsPlayedThisTurn: actor.cardsPlayedThisTurn + 1,
  };

  if (card.kind === "Unit") {
    const deployedUnit = { ...card, exhausted: !("Quick" in card.keywords) };
    const playedFromChampionZone = actor.championZone?.instanceId === card.instanceId;
    const updatedActor: PlayerState = {
      ...actor,
      ...sharedUpdates,
      championZone: playedFromChampionZone ? null : actor.championZone,
    };

    if (action.destinationBattlefieldId === undefined) {
      const players = [...state.players] as [PlayerState, PlayerState];
      players[action.playerIndex] = { ...updatedActor, baseUnits: [...actor.baseUnits, deployedUnit] };
      return { ...state, players };
    }

    const players = [...state.players] as [PlayerState, PlayerState];
    players[action.playerIndex] = updatedActor;

    const bfIndex = state.battlefields.findIndex((bf) => bf.id === action.destinationBattlefieldId);
    const bf = state.battlefields[bfIndex]!;
    const battlefields = [...state.battlefields];
    battlefields[bfIndex] = {
      ...bf,
      units: { ...bf.units, [actor.id]: [...(bf.units[actor.id] ?? []), deployedUnit] },
    };

    const next: GameState = { ...state, players, battlefields };

    const opponentIndex: 0 | 1 = action.playerIndex === 0 ? 1 : 0;
    const opponent = next.players[opponentIndex];
    const opponentPresent = (bf.units[opponent.id]?.length ?? 0) > 0;

    if (!opponentPresent) {
      return claimBattlefieldControl(next, action.destinationBattlefieldId, action.playerIndex);
    }

    return {
      ...next,
      turnState: "Showdown",
      focusHolder: action.playerIndex,
      showdownBattlefieldId: action.destinationBattlefieldId,
      consecutiveFocusPasses: 0,
    };
  }

  let updatedActor: PlayerState;
  let nextState = state;

  if (card.kind === "Spell") {
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
