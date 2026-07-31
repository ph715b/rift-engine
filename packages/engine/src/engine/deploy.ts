import type { GameState, PlayerState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import { dispatchOnPlayUnit } from "./unit-triggers.js";
import { dispatchEvent, dispatchSelfEvent } from "./triggers.js";

/**
 * A unit arriving in play, and the state it arrives in.
 *
 * Lifted out of execute-play-card.ts once a second thing could put a unit into
 * play: Flame Chompers' "when you discard me, you may pay [Fury] to play me"
 * resolves inside a trigger, with no PlayCardAction anywhere. Leaving the rules
 * below inlined in the play path would have meant a second copy of "does this
 * unit enter ready?", which is exactly how a unit ends up entering ready in one
 * place and exhausted in another for the same reason.
 */

/**
 * Magma Wurm (OGN-011): "Other friendly units enter ready."
 *
 * A continuous property of a unit already in play, not a flag set when it was
 * played — so it applies to everything you play for as long as the Wurm is
 * there, and stops the moment it dies. `excludeInstanceId` is the card being
 * played, so a Wurm never readies itself.
 */
const MAGMA_WURM = "OGN-011";

function otherFriendlyUnitsEnterReady(state: GameState, playerIndex: 0 | 1, excludeInstanceId: string): boolean {
  const actor = state.players[playerIndex];
  const own = [...actor.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[actor.id] ?? [])];
  return own.some((u) => u.defId === MAGMA_WURM && u.instanceId !== excludeInstanceId);
}

/** For coverage.ts — this module implements Magma Wurm's whole printed text. */
export function playCardDefIds(): string[] {
  return [MAGMA_WURM];
}

/**
 * Does this unit enter READY rather than exhausted?
 *
 * Rule 143.4.a makes exhausted the default; three separate things override it,
 * and they are genuinely different: the printed [Quick] keyword, Confront's
 * this-turn flag on the player, and a Magma Wurm already on the board making it
 * true continuously for everything ELSE you play. The last is a property of the
 * board, so it is asked fresh rather than stored — and it excludes the unit
 * itself, which matters because a second Wurm shouldn't ready the first one's
 * copy on the way in.
 */
export function unitEntersReady(state: GameState, playerIndex: 0 | 1, card: UnitInstance, acceleratePaid?: boolean): boolean {
  return (
    "Quick" in card.keywords ||
    // [Accelerate] paid as an additional cost (805): "if you do, I enter ready".
    acceleratePaid === true ||
    state.players[playerIndex].unitsEnterReadyThisTurn ||
    otherFriendlyUnitsEnterReady(state, playerIndex, card.instanceId)
  );
}

/**
 * Puts a unit into its controller's base as a PLAY, for the effects that play a
 * unit without a PlayCardAction to carry it.
 *
 * "Play" is meant strictly: both the events a real play fires go off here, in
 * the order the play path uses them. Skipping them would make Flame Chompers'
 * arrival invisible to Viktor - Innovator (which watches `cardPlayed`) and to
 * the card's own self-trigger, so a card that says "play me" would be playing in
 * a way nothing could see.
 *
 * The CALLER pays. This does not touch runes, floating resources or
 * `cardsPlayedThisTurn` — those belong to whatever agreed the price, which for a
 * card whose text replaces its own cost is not the printed one.
 */
export function playUnitToBase(state: GameState, playerIndex: 0 | 1, card: UnitInstance): GameState {
  const deployed: UnitInstance = { ...card, exhausted: !unitEntersReady(state, playerIndex, card) };
  const players = [...state.players] as [PlayerState, PlayerState];
  players[playerIndex] = { ...state.players[playerIndex], baseUnits: [...state.players[playerIndex].baseUnits, deployed] };

  const arrived = dispatchOnPlayUnit({ ...state, players }, deployed, playerIndex, "base", {});
  const self = dispatchSelfEvent(arrived, "played", deployed, playerIndex);
  return dispatchEvent(self, { kind: "cardPlayed", casterIndex: playerIndex });
}
