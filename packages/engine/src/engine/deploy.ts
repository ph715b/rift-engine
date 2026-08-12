import type { GameState, PlayerState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import { dispatchOnPlayUnit } from "./unit-triggers.js";
import { holdEventTrigger, holdSelfTrigger } from "./triggers.js";
import { opponentNearVictory } from "./constants.js";
import { isMechUnit } from "./equipment.js";

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

/** Vayne - Hunter (OGN-035): "If an opponent controls a battlefield, I enter
 *  ready." A comeback clause like Leona's, measured off the BOARD rather than the
 *  score. Her conquer trigger is unrelated and lives in effects/fury.ts. */
const VAYNE_HUNTER = "OGN-035";

/**
 * Gear that prints "This enters exhausted" — Iron Ballista, whose whole cost of
 * being a 3-Energy repeatable 2 damage is that it cannot fire the turn it lands.
 *
 * A set rather than a field on GearInstance: it is a property of the CARD, not
 * of the copy, and the parse-time keyword table (card-loader) is for keywords
 * this is not. Same "small, precise, non-speculative table" convention as
 * effective-might.ts's aura list.
 */
const GEAR_ENTERING_EXHAUSTED = new Set([
  "OGN-017", // Iron Ballista
  // **Both added 2026-08-10, and both were STRONGER than printed without the
  // row** — the direction coverage.ts's own note calls the worse one, because a
  // card that does too much looks finished. Each shipped from a card wave with
  // its ability written and its "This enters exhausted" clause dropped, since
  // this table is shared and the wave could not touch it.
  "UNL-049",
  "UNL-136",
]);

export function gearEntersExhausted(defId: string): boolean {
  return GEAR_ENTERING_EXHAUSTED.has(defId);
}

/** For coverage.ts — this module implements Magma Wurm's whole printed text, the
 *  enter-ready half of Leona - Zealot's (effective-might.ts declares the other
 *  half, and coverage merges both), and Iron Ballista's enters-exhausted clause
 *  (its ability is in activated-abilities.ts). */
export function playCardDefIds(): string[] {
  // SFD's four conditional enter-readys are implemented HERE, so coverage must
  // be able to see them — a card whose whole text is "I enter ready if X" has
  // no other registration anywhere.
  return [
    MAGMA_WURM,
    LEONA_ZEALOT,
    VAYNE_HUNTER,
    DUNEBREAKER,
    DIREWING,
    BREAKNECK_MECH,
    XIN_ZHAO_VIGILANT,
    // UNL's, added 2026-08-08. Refused by the parallel card wave because this
    // file is shared; that refusal was right, and the fix is a case rather than
    // the hook the refusal asked for.
    TOWERING_PAIROFANT,
    // Both added 2026-08-10, and both are the SECOND half of a card whose first
    // half is a Might modifier in a domain file. Declared here so coverage merges
    // the two registrations — a card implemented across two modules must be
    // visible from both or the deck builder greys a card that works.
    SCORCHCLAW,
    MASTER_YI_WUJU_MASTER,
    ...GEAR_ENTERING_EXHAUSTED,
  ];
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
    // Master Yi - Wuju Master: "[Level 11][>] Your units enter ready."
    //
    // Beside Magma Wurm rather than in `conditionalEntersReady`'s switch, and the
    // distinction is the point: that switch answers "does THIS card enter ready",
    // keyed on the arriving unit's defId. This is a property of the CONTROLLER —
    // every unit they play, whatever it is — so keying it on the arrival would
    // have meant a case per card in the pool.
    //
    // Unlike the Wurm it needs no self-exclusion. Yi is a LEGEND and never the
    // unit arriving, so "your units" cannot include him and there is no copy of
    // himself to skip.
    //
    // Live, not latched (824.1.b.1 / 824.1.d): spending back below 11 XP stops
    // readying the NEXT unit, and takes nothing back from one already in play.
    masterYiReadiesYourUnits(state, playerIndex) ||
    // A property of THIS card and the score, unlike the three above — the only
    // override that depends on who is winning.
    (card.defId === LEONA_ZEALOT && opponentNearVictory(state, playerIndex)) ||
    // Vayne - Hunter: "If an opponent CONTROLS A BATTLEFIELD, I enter ready."
    // A property of the board rather than of the score, and the second override
    // that depends on how the game is going. `controllerId` is the whole test —
    // an opponent standing at an uncontrolled battlefield does not count, which
    // is what separates "controls" from "is present at".
    (card.defId === VAYNE_HUNTER &&
      state.battlefields.some((bf) => bf.controllerId === state.players[playerIndex === 0 ? 1 : 0].id)) ||
    // SFD's four conditional enter-readys. Every one is a property of the
    // board at the moment the unit arrives, which is exactly what this
    // predicate is for.
    //
    // **Deliberately NOT faked as an on-play `readyUnit` trigger**, and three
    // separate agents reached that conclusion independently while refusing to
    // write them. Three reasons, all observable: the trigger is a held Chain
    // Pending Item, so the unit would sit EXHAUSTED through the whole response
    // window; it would fire `unitReadied`, paying out Pirate's Haven for a
    // readying the rules say never happened; and it would be blockable by
    // Mageseeker Warden. "I enter ready" is a replacement, not a readying.
    //
    // `card-loader`'s QUICK_TEXT_OVERRIDES comment already rejected "a
    // redundant on-play un-exhaust effect" for this exact text.
    conditionalEntersReady(state, playerIndex, card)
  );
}

/**
 * The units whose "I enter ready" carries a condition — SFD's four, and UNL's.
 *
 * Asked BEFORE the unit is inserted into its zone (see this function's only
 * caller in execute-play-card), so a count of "other units" needs no
 * self-exclusion — the arriving unit is not there yet. Pinned by a test,
 * because that is exactly the sort of off-by-one that reads correct.
 *
 * **Renamed off `sfdConditionalEntersReady` on 2026-08-08**, when Unleashed
 * added to it. The old name was accurate when written and became a small lie the
 * moment a second set printed the same shape; a set-scoped name on a
 * pool-wide table is how a future card gets a near-duplicate function instead
 * of a case.
 */
function conditionalEntersReady(state: GameState, playerIndex: 0 | 1, card: UnitInstance): boolean {
  const player = state.players[playerIndex];
  switch (card.defId) {
    case TOWERING_PAIROFANT:
      // UNL — "If a unit died this turn, I enter ready."
      //
      // ANY unit, either side: the card prints no "friendly" and no "enemy",
      // and 355.10.a.1's bare noun is the whole board. So both players'
      // counters are summed, and a Pairofant played after trading in combat
      // arrives ready off the opponent's loss as readily as your own.
      //
      // Needs NO new state — `unitsLostThisTurn` is incremented in the death
      // funnel and zeroed for both players by `runEnd`, which is exactly the
      // "this turn" window the card asks about.
      return state.players[0].unitsLostThisTurn + state.players[1].unitsLostThisTurn > 0;
    case DUNEBREAKER:
      // "If you have two or fewer cards in your hand, I enter ready." Read
      // AFTER he has left hand to be played, which is what "you have" means at
      // the moment he arrives.
      return player.hand.length <= DUNEBREAKER_MAX_HAND;
    case DIREWING:
      // "I enter ready if you control another Dragon." ANOTHER, so he cannot
      // be his own Dragon — and he is not in a zone yet, so this counts only
      // the ones already there.
      return ownUnitsOf(state, playerIndex).some((u) => u.tags.includes("Dragon"));
    case BREAKNECK_MECH:
      return ownUnitsOf(state, playerIndex).some((u) => isMechUnit(state, u));
    case XIN_ZHAO_VIGILANT:
      // "if you have two or more OTHER units in your BASE" — base only, not
      // the battlefields, and "other" is free for the same reason.
      return player.baseUnits.length >= XIN_ZHAO_OTHER_UNITS;
    case SCORCHCLAW:
      // UNL — "[Level 3][>] I have +1 [Might] and enter ready."
      //
      // The second half of a card whose first half is a `mightModifiers` entry in
      // effects/fury.ts, and the two are in different files because they are
      // genuinely different mechanisms: a continuous Might aura and a deploy-time
      // replacement. His agent refused this half by name and was right to — the
      // file is shared and the workaround it rejected is the one this function's
      // own header rejects.
      //
      // **Read live, not latched**, which is why it belongs in this predicate
      // rather than on the instance: 824.1.b.1 makes `[Level 3][>]` "while you
      // have 3 or more XP", so a Scorchclaw played at 2 XP arrives exhausted and
      // one played at 3 arrives ready. The question is only ever asked once, at
      // the moment he is played, so 824.1.d's "goes Inactive when XP drops" has
      // nothing to take back here.
      return player.xp >= SCORCHCLAW_LEVEL;
    default:
      return false;
  }
}

/**
 * Master Yi - Wuju Master's `[Level 11]` — "Your units enter ready."
 *
 * Reads the player's LEGEND rather than the board, because that is where a
 * Legend lives: `PlayerState.legend` is a single slot, never in `baseUnits`, so
 * the unit walks every other aura in this file uses would never find him.
 *
 * His `[Level 6]` +1 Might aura is a `mightModifiers` entry in
 * effects/signature.ts. The two halves of the card are in different files for
 * the same reason Scorchclaw's are: a continuous Might modifier and a
 * deploy-time replacement are different mechanisms, and neither table can
 * express the other.
 */
function masterYiReadiesYourUnits(state: GameState, playerIndex: 0 | 1): boolean {
  const player = state.players[playerIndex];
  return player.legend.defId === MASTER_YI_WUJU_MASTER && player.xp >= MASTER_YI_ENTERS_READY_LEVEL;
}

/** Every unit this player has in play, base and battlefields alike. */
function ownUnitsOf(state: GameState, playerIndex: 0 | 1): UnitInstance[] {
  const player = state.players[playerIndex];
  return [...player.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[player.id] ?? [])];
}

const DUNEBREAKER = "SFD-027";
const DUNEBREAKER_MAX_HAND = 2;
const DIREWING = "SFD-094";
const BREAKNECK_MECH = "SFD-071";
const XIN_ZHAO_VIGILANT = "SFD-176";
/** Towering Pairofant (UNL-008) — "If a unit died this turn, I enter ready."
 *  ANY unit, either side, which is why its case sums both players' counters. */
const TOWERING_PAIROFANT = "UNL-008";
const XIN_ZHAO_OTHER_UNITS = 2;
/** Scorchclaw (UNL-016) — "[Level 3][>] I have +1 [Might] and enter ready."
 *  The Might half is a `mightModifiers` entry in effects/fury.ts; only the
 *  enters-ready half is answerable here. */
const SCORCHCLAW = "UNL-016";
const SCORCHCLAW_LEVEL = 3;
/** Master Yi - Wuju Master (UNL-191) — "[Level 11][>] Your units enter ready."
 *  A LEGEND's aura, so it is a board query beside Magma Wurm's rather than a case
 *  in the per-card switch: it is a property of the controller, not of the unit
 *  arriving. His `[Level 6]` Might aura is a `mightModifiers` entry in
 *  effects/signature.ts. */
const MASTER_YI_WUJU_MASTER = "UNL-191";
const MASTER_YI_ENTERS_READY_LEVEL = 11;

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
/**
 * The same free play, but landing at a BATTLEFIELD — Ava Achiever's "if it's a
 * unit, play it HERE".
 *
 * Beside `playUnitToBase` rather than a parameter on it, because the two
 * genuinely differ after the unit is placed: arriving at a battlefield can make
 * it Contested and can be an ATTACK, and neither is possible at a base. The
 * caller applies those — this only places and fires what a play fires — for the
 * same reason this module does not pay: the card that played it knows whether
 * its arrival is an attack, and this does not.
 */
export function playUnitToBattlefield(
  state: GameState,
  playerIndex: 0 | 1,
  card: UnitInstance,
  battlefieldId: string,
): GameState {
  const bfIndex = state.battlefields.findIndex((bf) => bf.id === battlefieldId);
  if (bfIndex === -1) return playUnitToBase(state, playerIndex, card);

  const deployed: UnitInstance = { ...card, exhausted: !unitEntersReady(state, playerIndex, card) };
  const spent = consumeNextUnitEntersReady(state, playerIndex, card);
  const ownerId = spent.players[playerIndex].id;
  const battlefields = [...spent.battlefields];
  const bf = battlefields[bfIndex]!;
  battlefields[bfIndex] = { ...bf, units: { ...bf.units, [ownerId]: [...(bf.units[ownerId] ?? []), deployed] } };

  const arrived = dispatchOnPlayUnit({ ...spent, battlefields }, deployed, playerIndex, { battlefieldId }, {});
  const withEvent = holdEventTrigger(arrived, {
    kind: "cardPlayed",
    casterIndex: playerIndex,
    playedKind: deployed.kind,
    playedInstanceId: deployed.instanceId,
    playedPowerCost: deployed.powerCost,
    // A real card, never a token — see `isToken`'s note in triggers.ts for why
    // the two must be told apart (185 vs 350.2).
    isToken: false,
  });
  // Last, so LIFO resolves it first — see execute-play-card for why the position
  // is chosen rather than incidental.
  return holdSelfTrigger(withEvent, "played", deployed, playerIndex);
}

export function playUnitToBase(state: GameState, playerIndex: 0 | 1, card: UnitInstance): GameState {
  const deployed: UnitInstance = { ...card, exhausted: !unitEntersReady(state, playerIndex, card) };
  const spent = consumeNextUnitEntersReady(state, playerIndex, card);
  const players = [...spent.players] as [PlayerState, PlayerState];
  players[playerIndex] = { ...spent.players[playerIndex], baseUnits: [...spent.players[playerIndex].baseUnits, deployed] };

  const arrived = dispatchOnPlayUnit({ ...spent, players }, deployed, playerIndex, "base", {});
  // A token deployed straight to base is still a Unit being played, and Cithria
  // of Cloudfield's "another unit" makes no exception for one.
  //
  // HELD, matching execute-play-card: `cardPlayed` is a Chain Pending Item, and
  // an event kind has to be converted at EVERY producer at once or the same event
  // resolves one way from one call site and another way from the other.
  const withEvent = holdEventTrigger(arrived, {
    kind: "cardPlayed",
    casterIndex: playerIndex,
    playedKind: deployed.kind,
    playedInstanceId: deployed.instanceId,
    playedPowerCost: deployed.powerCost,
    // A real card, never a token — see `isToken`'s note in triggers.ts for why
    // the two must be told apart (185 vs 350.2).
    isToken: false,
  });
  // Last, so LIFO resolves it first — see execute-play-card for the reasoning.
  return holdSelfTrigger(withEvent, "played", deployed, playerIndex);
}
