import type { CardInstance, GearInstance, SpellInstance, UnitInstance } from "../model/card.js";
import type { GameState, PlayerState } from "../model/game-state.js";
import { contextFor } from "./effect-context.js";
import { cardModeOf } from "./card-effects.js";
import { gearEntersExhausted, playUnitToBase, playUnitToBattlefield } from "./deploy.js";
import { playUnitFree } from "./free-play.js";
import { holdEventTrigger, holdSelfTrigger } from "./triggers.js";

/**
 * Playing a card for free FROM INSIDE another card's resolution — Blind Fury's
 * "banish it, then play it, ignoring its cost", Kai'Sa - Evolutionary's spell
 * from the trash, Reinforce's unit from the top five.
 *
 * Its own module because the three card kinds diverge sharply and each divergence
 * is a decision worth stating once rather than three times.
 *
 * **The CALLER pays and the CALLER removes the card from its zone.** This does
 * neither — the whole point of these cards is that the printed cost is not paid,
 * and the zone a card comes from differs per card (a deck's top, a trash, the top
 * five). It only ever puts the card into play and fires what a play fires.
 *
 * **DIVERGENCE, and it is the reason this needed writing rather than reusing
 * `executePlayCard`: a SPELL played this way resolves IMMEDIATELY rather than
 * going on the chain.** The rules would put it there like any other spell, giving
 * the opponent a window. This engine cannot: these calls happen while a chain item
 * is being resolved, and `execute-pass-focus` pops the LAST entry when that
 * resolution finishes — so a spell appended here would be popped instead of the
 * card that played it, and the original would never resolve at all. Recorded in
 * docs/rules-conformance.md. The practical cost is one missing response window on
 * a spell the opponent could not have seen coming anyway.
 */
export function playCardIgnoringCost(
  state: GameState,
  playerIndex: 0 | 1,
  card: CardInstance,
  /** Where a UNIT lands, when the card that played it says so — Ava Achiever's
   *  "if it's a unit, play it here". Ignored for a Gear or a Spell, neither of
   *  which is ever at a battlefield. Absent means base, as every earlier caller
   *  wanted. */
  destinationBattlefieldId?: string,
): GameState {
  if (card.kind === "Unit") {
    return destinationBattlefieldId === undefined
      ? playUnitFree(state, playerIndex, card as UnitInstance)
      : playUnitToBattlefield(state, playerIndex, card as UnitInstance, destinationBattlefieldId);
  }
  if (card.kind === "Gear") return playGear(state, playerIndex, card as GearInstance);
  if (card.kind === "Spell") return playSpellImmediately(state, playerIndex, card as SpellInstance);
  // A Legend is never in a deck or a trash, so nothing can reach here — and a
  // silent no-op is the right answer rather than a throw, since every caller
  // takes whatever the zone handed it.
  return state;
}

/** Gear enters play and fires the two events a play fires. Exhaustion follows
 *  the same per-card table `executePlayCard` uses (`gearEntersExhausted`), so a
 *  free Gear enters the way a paid one would. */
function playGear(state: GameState, playerIndex: 0 | 1, card: GearInstance): GameState {
  const players = [...state.players] as [PlayerState, PlayerState];
  players[playerIndex] = {
    ...players[playerIndex],
    activeGear: [...players[playerIndex].activeGear, gearEntersExhausted(card.defId) ? { ...card, exhausted: true } : card],
  };
  return firePlayed({ ...state, players }, playerIndex, card);
}

/**
 * A Spell's effect, run here and now, then trashed.
 *
 * Trashed AFTER resolving rather than before, unlike a normal cast: the ordinary
 * path trashes at cast time because the card sits on the chain in between, and
 * there is no in-between here. Anything reading its own controller's trash mid
 * resolution (Rhasa's cost, Dr. Mundo's Might) therefore sees the same trash a
 * normal cast would have shown it — one card larger.
 */
function playSpellImmediately(state: GameState, playerIndex: 0 | 1, card: SpellInstance): GameState {
  const played = firePlayed(state, playerIndex, card);
  // No mode either: `cardModeOf(card, undefined)` gives the sole mode of an
  // ordinary card and NOTHING for a modal one, which is the same "as much as
  // it can and no more" answer an absent target already gets.
  const effect = cardModeOf(card, undefined);
  // No targets: the choices a spell needs are made when it is ANNOUNCED, and
  // nothing announced this one. A targeted spell played this way therefore does
  // as much as it can and no more, which is 422's convention and the same answer
  // every resolver here already gives an absent target.
  const resolved = effect ? effect.resolve(played, contextFor(playerIndex, card.instanceId), {}) : played;
  const players = [...resolved.players] as [PlayerState, PlayerState];
  players[playerIndex] = { ...players[playerIndex], trash: [...players[playerIndex].trash, card] };
  return { ...resolved, players };
}

/**
 * The two events every play fires, in the order `executePlayCard` fires them.
 *
 * Skipping them would make a freely-played card invisible to Cithria, Darius -
 * Trifarian and Viktor - Innovator, and to its own self-trigger — a card that
 * says "play it" would be playing in a way nothing could see. `cardsPlayedThisTurn`
 * is NOT bumped here: the caller decides, because a card played by another card's
 * text is not obviously "a card you played" for [Legion]'s purposes and the two
 * cards that do it read differently.
 */
function firePlayed(state: GameState, playerIndex: 0 | 1, card: CardInstance): GameState {
  const withEvent = holdEventTrigger(state, {
    kind: "cardPlayed",
    casterIndex: playerIndex,
    playedKind: card.kind,
    playedInstanceId: card.instanceId,
  });
  // Last, so LIFO resolves it first — see execute-play-card for the reasoning.
  return holdSelfTrigger(withEvent, "played", card, playerIndex);
}
