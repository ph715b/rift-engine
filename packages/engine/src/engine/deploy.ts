import type { GameState, PlayerState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import { dispatchOnPlayUnit } from "./unit-triggers.js";
import { dispatchEvent, dispatchSelfEvent } from "./triggers.js";
import { opponentNearVictory } from "./constants.js";

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

/**
 * Leona - Zealot (OGN-079): "If an opponent's score is within 3 points of the
 * Victory Score, I enter ready."
 *
 * A condition on the BOARD at the moment she is played, not a keyword and not a
 * flag anyone set — so it belongs here with the other three enter-ready
 * overrides rather than in a card registry, and it is asked fresh every time.
 *
 * The "within 3 points" test itself lives in constants.ts as
 * `opponentNearVictory`, shared with Find Your Center, which prints the same
 * clause as a cost reduction. Two copies of an inclusive-vs-exclusive boundary
 * is exactly the kind of thing that drifts.
 *
 * Her second clause ("stunned enemy units here have -8 Might") is a continuous
 * modifier and lives in effective-might.ts; the two halves have nothing to do
 * with each other beyond sharing a card.
 */
const LEONA_ZEALOT = "OGN-079";

/**
 * Gear that prints "This enters exhausted" — Iron Ballista, whose whole cost of
 * being a 3-Energy repeatable 2 damage is that it cannot fire the turn it lands.
 *
 * A set rather than a field on GearInstance: it is a property of the CARD, not
 * of the copy, and the parse-time keyword table (card-loader) is for keywords
 * this is not. Same "small, precise, non-speculative table" convention as
 * effective-might.ts's aura list.
 */
const GEAR_ENTERING_EXHAUSTED = new Set(["OGN-017"]); // Iron Ballista

export function gearEntersExhausted(defId: string): boolean {
  return GEAR_ENTERING_EXHAUSTED.has(defId);
}

/** For coverage.ts — this module implements Magma Wurm's whole printed text, the
 *  enter-ready half of Leona - Zealot's (effective-might.ts declares the other
 *  half, and coverage merges both), and Iron Ballista's enters-exhausted clause
 *  (its ability is in activated-abilities.ts). */
export function playCardDefIds(): string[] {
  return [MAGMA_WURM, LEONA_ZEALOT, ...GEAR_ENTERING_EXHAUSTED];
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
    // Sun Disc's armed charge. A COUNT, not a flag: it readies the NEXT unit
    // only, unlike Confront's blanket this-turn permission above. Only read
    // here; `consumeNextUnitEntersReady` below spends it, and the two are
    // separate because a caller that asks must not accidentally spend.
    state.players[playerIndex].nextUnitsEnterReady > 0 ||
    otherFriendlyUnitsEnterReady(state, playerIndex, card.instanceId) ||
    // A property of THIS card and the score, unlike the three above — the only
    // override that depends on who is winning.
    (card.defId === LEONA_ZEALOT && opponentNearVictory(state, playerIndex))
  );
}

/**
 * Spends one Sun Disc charge, if the unit that just entered play used one.
 *
 * Separate from `unitEntersReady` because that predicate is asked in more places
 * than a unit actually enters play — the UI asks it to preview, and the AI's
 * lookahead asks it once per candidate. Spending inside the predicate would burn
 * the charge on a play that never happened, which is exactly the class of bug
 * this codebase's lookahead has produced before.
 *
 * Only spends when the charge was the REASON: a `[Quick]` unit, or one played
 * under Confront, readies on its own and leaves the charge armed for the next.
 */
export function consumeNextUnitEntersReady(
  state: GameState,
  playerIndex: 0 | 1,
  card: UnitInstance,
  acceleratePaid?: boolean,
): GameState {
  const player = state.players[playerIndex];
  if (player.nextUnitsEnterReady <= 0) return state;
  const readiedByOtherMeans =
    "Quick" in card.keywords ||
    acceleratePaid === true ||
    player.unitsEnterReadyThisTurn ||
    otherFriendlyUnitsEnterReady(state, playerIndex, card.instanceId);
  if (readiedByOtherMeans) return state;

  const players = [...state.players] as [PlayerState, PlayerState];
  players[playerIndex] = { ...player, nextUnitsEnterReady: player.nextUnitsEnterReady - 1 };
  return { ...state, players };
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
  const spent = consumeNextUnitEntersReady(state, playerIndex, card);
  const players = [...spent.players] as [PlayerState, PlayerState];
  players[playerIndex] = { ...spent.players[playerIndex], baseUnits: [...spent.players[playerIndex].baseUnits, deployed] };

  const arrived = dispatchOnPlayUnit({ ...spent, players }, deployed, playerIndex, "base", {});
  const self = dispatchSelfEvent(arrived, "played", deployed, playerIndex);
  // A token deployed straight to base is still a Unit being played, and Cithria
  // of Cloudfield's "another unit" makes no exception for one.
  return dispatchEvent(self, {
    kind: "cardPlayed",
    casterIndex: playerIndex,
    playedKind: deployed.kind,
    playedInstanceId: deployed.instanceId,
  });
}
