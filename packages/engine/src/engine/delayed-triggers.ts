import type { GameState, PlayerState, TriggerChainEntry } from "../model/game-state.js";
import { banishCard } from "./effect-helpers.js";

/** Local, like every other module's — `updatePlayer` is module-private in
 *  effect-helpers, scoring, turn-manager and battlefield-abilities alike. */
function updatePlayer(state: GameState, index: 0 | 1, update: (p: PlayerState) => PlayerState): GameState {
  const players = [...state.players] as [PlayerState, PlayerState];
  players[index] = update(players[index]);
  return { ...state, players };
}

/**
 * DELAYED triggered abilities — ones created by an effect that has already
 * resolved, which then wait for a moment and fire with no card behind them.
 *
 * # Why this is a module and not a field somebody reads inline
 *
 * There were two delayed effects in this engine before UNL-169 Ashe - Focused,
 * and both are a boolean on state read by the site that would fire them
 * (`killDamagedUnitsThisTurn`, `buffUnitsPlayedThisTurn`). That works while the
 * delayed thing is a modifier to something already happening. It stops working
 * the moment the delayed thing is an ABILITY: 383.3 puts a Triggered Ability on
 * the Chain, opponents get a response window, and an inline mutation gives them
 * neither.
 *
 * Ashe is the first card in the pool whose delayed half is a full ability —
 * "when they hold, return it to their hand" — and her parenthetical says out
 * loud that it has outlived its source: "**even if I'm no longer on the board**".
 * So this holds a real `TriggerChainEntry`, with `source: "delayed"`, which
 * `execute-pass-focus` pops and resolves like any other.
 *
 * # What "no listener" means for the entry
 *
 * Every other source names a card that the resolver looks up. This one names one
 * only so the chain viewer can say what is waiting; nothing is looked up, and the
 * ability resolves off `PlayerState.banishedUntilHold`. That is the extreme of
 * the rule the non-`event` sources already share (383.3 / 377.3.a.1 — the ability's source
 * having left play does not remove the item): here the source having left is not
 * an edge case to survive, it is the printed behaviour.
 */

/** UNL-169 Ashe - Focused, the only card that arms one of these today. */
const ASHE_FOCUSED = "UNL-169";
const ASHE_FOCUSED_NAME = "Ashe - Focused";

/**
 * Banishes `cardInstanceId` out of `ownerIndex`'s hand and arms its return for
 * the next time `ownerIndex` holds.
 *
 * Through `banishCard`, the shared funnel, rather than a hand-rolled move: the
 * card really is banished (186/198 — it leaves for the banish zone, it is not
 * "set aside"), and anything counting banished cards must see it there.
 *
 * The armed id lives on the CARD's OWNER, because both halves of the printed
 * sentence are about them — "when THEY hold, return it to THEIR hand". The
 * firing site then reads the holder's own list and needs to know nothing about
 * who banished what, which is what makes two Ashes stack without any of them
 * knowing about the others.
 */
export function banishFromHandUntilHold(state: GameState, ownerIndex: 0 | 1, cardInstanceId: string): GameState {
  const inHand = state.players[ownerIndex].hand.some((c) => c.instanceId === cardInstanceId);
  // Nothing to banish is nothing to arm. Guarded together so a card that has
  // left the hand between the reveal and the answer cannot arm a return for a
  // card that is still sitting there — 359.3.e.12's "a check on something no
  // longer available returns null".
  if (!inHand) return state;
  const banished = banishCard(state, ownerIndex, cardInstanceId);
  return updatePlayer(banished, ownerIndex, (p) => ({
    ...p,
    banishedUntilHold: [...p.banishedUntilHold, cardInstanceId],
  }));
}

/**
 * The chain item for `holderIndex`'s armed returns, or the state unchanged when
 * nothing is armed.
 *
 * ONE item for however many cards are waiting, not one per card. Two Ashes
 * against the same opponent create two delayed abilities and the rules would put
 * two items on the Chain; this engine puts one that returns both, which is the
 * same divergence — and the same reasoning — as `TriggerChainEntry.times` for
 * Karthus - Eternal, recorded in docs/rules-conformance.md. Splitting them would
 * mean two response windows between two returns of cards nobody can interact
 * with in between.
 */
export function holdDelayedReturnTrigger(state: GameState, holderIndex: 0 | 1, battlefieldId: string): GameState {
  if (state.players[holderIndex].banishedUntilHold.length === 0) return state;
  const entry: TriggerChainEntry = {
    kind: "trigger",
    source: "delayed",
    // The HOLDER responds and the resolution runs under their index — it is
    // their hand the cards return to. Not Ashe's controller, who by then may not
    // be in the game state's memory at all.
    playerIndex: holderIndex,
    // Named for the chain viewer only. There is no instance to look up: that is
    // the whole point of a delayed ability, and `resolveHeldDelayedReturn` never
    // reads either of these.
    listenerInstanceId: `${ASHE_FOCUSED}-delayed-${holderIndex}`,
    listenerDefId: ASHE_FOCUSED,
    listenerName: ASHE_FOCUSED_NAME,
    battlefieldId,
    event: { kind: "battlefieldHeld", holderIndex, battlefieldId },
  };
  return { ...state, pendingTriggers: [...state.pendingTriggers, entry] };
}

/**
 * Returns every card `entry.playerIndex` has armed from their banish zone to
 * their hand, and disarms them.
 *
 * Re-read from LIVE state rather than captured on the entry, deliberately. The
 * armed list is the ability's subject, not the event's, and 359.3.e.12 says a
 * check on something no longer available returns null — so a card that left the
 * banish zone inside the response window simply does not come back, and its id
 * is dropped rather than resurrecting a card from nowhere.
 */
export function resolveHeldDelayedReturn(state: GameState, entry: TriggerChainEntry): GameState {
  const playerIndex = entry.playerIndex;
  const armed = new Set(state.players[playerIndex].banishedUntilHold);
  if (armed.size === 0) return state;
  return updatePlayer(state, playerIndex, (p) => ({
    ...p,
    hand: [...p.hand, ...p.banished.filter((c) => armed.has(c.instanceId))],
    banished: p.banished.filter((c) => !armed.has(c.instanceId)),
    // Cleared whole, including any id whose card was not found: the ability has
    // fired, and an id left armed would try again at the next hold.
    banishedUntilHold: [],
  }));
}
