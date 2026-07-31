import type { GameState, PlayerState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import { scoreHolds } from "./scoring.js";
import { dispatchLegendEndOfTurn } from "./legend-abilities.js";
import { destroyUnit, healAllUnits } from "./effect-helpers.js";

/**
 * The turn/phase loop, ported from engine/TurnManager.java. Each function is
 * a pure `(state) -> state` step rather than a mutation on a shared
 * TurnManager instance — Java's `startingPlayerIndex`/`secondPlayerBonusGranted`
 * instance fields (TurnManager.java:178-180) are replaced by deriving the
 * same "does the second player get a 3rd Channel rune this game" condition
 * from `turnNumber` and `GameState.firstPlayerIndex` (see runChannel below).
 *
 * `firstPlayerIndex` is what Java's `startingPlayerIndex` is for, and it is
 * load-bearing rather than bookkeeping: rule 117.x determines turn order by
 * "any fair random method", so either player can go first, and BOTH steps that
 * care (the going-second Channel bonus and the turn counter) used to test
 * against the literal indices 1 and 0 on the assumption that the game always
 * began with player 0. That assumption held only because the setup code
 * hardcoded it.
 *
 * Only the general-purpose steps are ported — the long tail of per-card
 * triggers TurnManager.java's runBeginning/runEnd fire (~40 "this turn" field
 * resets, legend/unit/battlefield ability hooks) isn't modeled yet, since none of those cards/mechanics are implemented. Add them
 * here alongside each mechanic, the same deferral discipline as everywhere
 * else in this port.
 */

function updatePlayer(state: GameState, index: 0 | 1, update: (p: PlayerState) => PlayerState): GameState {
  const players = [...state.players] as [PlayerState, PlayerState];
  players[index] = update(players[index]);
  return { ...state, players };
}

/** Ready all exhausted cards for the active player; ready exhausted runes in
 *  their pool; reset their per-turn conquest tracking. Mirrors
 *  TurnManager.runAwaken (engine/TurnManager.java:65-84) plus
 *  ScoringSystem.onTurnStart (engine/ScoringSystem.java:30-32, called from
 *  runAwaken), minus UnitAbilities.cannotBeReadied (no card grants that yet). */
export function runAwaken(state: GameState): GameState {
  if (state.phase !== "Awaken") {
    throw new Error(`runAwaken requires Awaken phase, currently: ${state.phase}`);
  }
  const active = state.activePlayerIndex;

  const battlefields = state.battlefields.map((bf) => ({
    ...bf,
    units: {
      ...bf.units,
      [state.players[active].id]: (bf.units[state.players[active].id] ?? []).map((u) => ({ ...u, exhausted: false })),
    },
  }));

  const next = updatePlayer({ ...state, battlefields }, active, (p) => ({
    ...p,
    baseUnits: p.baseUnits.map((u) => ({ ...u, exhausted: false })),
    activeGear: p.activeGear.map((g) => ({ ...g, exhausted: false })),
    legend: { ...p.legend, exhausted: false },
    channeled: p.channeled.map((r) => (r.state === "Exhausted" ? { ...r, state: "Ready" as const } : r)),
    scoredBattlefieldsThisTurn: [],
  }));

  return { ...next, phase: "Beginning" };
}

/**
 * Kills the active player's [Temporary] permanents — rule 816: "At the start of
 * this permanent's controller's Beginning Phase, before scoring, kill this."
 *
 * "Before scoring" is the whole point of the keyword and the only reason it needs
 * its own step rather than folding into Awaken: a Temporary unit standing alone
 * at a battlefield must NOT hold it for a point. Ordering this after scoreHolds
 * would make every Temporary token a free point, quietly inverting the card.
 *
 * "This permanent's controller's" — only the ACTIVE player's Temporary things
 * die here. The opponent's survive until their own Beginning Phase, which is what
 * makes giving an enemy unit [Temporary] (Fading Memories) a delayed removal
 * rather than an instant one.
 *
 * Multiple instances are redundant (817.1.a), which is free here: the keyword is
 * a presence check, not a count.
 */
function killTemporaryPermanents(state: GameState): GameState {
  const controller = state.activePlayerIndex;
  const owner = state.players[controller];

  const isTemporary = (u: UnitInstance) => "Temporary" in u.keywords;
  const doomed = [
    ...owner.baseUnits.filter(isTemporary),
    ...state.battlefields.flatMap((bf) => (bf.units[owner.id] ?? []).filter(isTemporary)),
  ].map((u) => u.instanceId);

  // Route through destroyUnit, not a hand-rolled removal: a Temporary unit that
  // also has a [Deathknell] must still fire it (rule 808 fires on any death), and
  // destroyUnit is what carries that whole funnel. Ids rather than units, because
  // each kill rebuilds the board and a captured unit object would go stale.
  return doomed.reduce((next, instanceId) => destroyUnit(next, instanceId), state);
}

/** Kills [Temporary] permanents, then scores holds for the active player. Mirrors
 *  TurnManager.runBeginning (engine/TurnManager.java:86-98), minus every
 *  Beginning-Phase ability hook (Mushroom Pouch is the only card in this pool
 *  that wants one and it isn't implemented yet). */
export function runBeginning(state: GameState): GameState {
  if (state.phase !== "Beginning") {
    throw new Error(`runBeginning requires Beginning phase, currently: ${state.phase}`);
  }
  const afterTemporary = killTemporaryPermanents(state);
  return { ...scoreHolds(afterTemporary, afterTemporary.activePlayerIndex), phase: "Channel" };
}

/**
 * Reveals runes from the rune deck into the channeled pool: 2 normally, 3 on
 * the second-acting player's very first turn. That extra rune is the First
 * Turn Process both sanctioned 1v1 modes share — "the player going second
 * channels an extra Rune from their Rune Deck during their first Channel Phase
 * of the game" (rules 486.1 for 1v1 Duel, 487.4 for 1v1 Match). Mirrors
 * TurnManager.runChannel (engine/TurnManager.java:182-201).
 *
 * "Going second" is `active !== state.firstPlayerIndex`, NOT `active === 1`.
 * The old literal-1 test silently gave the compensation to whoever sat at
 * index 1 — correct only while setup hardcoded player 0 to start, and exactly
 * backwards once turn order is randomized per rule 117.x. Combined with
 * runEnd's matching change, the going-second player's first turn is always
 * `turnNumber === 1` regardless of which seat they occupy.
 *
 * Note this is deliberately NOT the FFA3 First Turn Process, which also makes
 * the player going FIRST skip their first draw (rule 488.1). That adjustment
 * belongs to a 3-player mode; neither 1v1 mode has it.
 */
export function runChannel(state: GameState): GameState {
  if (state.phase !== "Channel") {
    throw new Error(`runChannel requires Channel phase, currently: ${state.phase}`);
  }
  const active = state.activePlayerIndex;
  const goingSecond = active !== state.firstPlayerIndex;
  const toChannel = state.turnNumber === 1 && goingSecond ? 3 : 2;

  const next = updatePlayer(state, active, (p) => {
    const runeDeck = [...p.runeDeck];
    const drawn = runeDeck.splice(0, Math.min(toChannel, runeDeck.length)).map((r) => ({ ...r, state: "Ready" as const }));
    return { ...p, runeDeck, channeled: [...p.channeled, ...drawn] };
  });

  return { ...next, phase: "Draw" };
}

/**
 * Draws 1 card for the active player. Mirrors TurnManager.runDraw
 * (engine/TurnManager.java:203-222), minus the >2-player "player 0 skips
 * their turn-1 draw" exception (out of scope — this engine is 2-player
 * only) and Burn Out (drawing from an empty deck should recycle the trash
 * and award the opponent 1 point, core rules §431-433) — not implemented
 * yet (no ScoringSystem); an empty deck silently no-ops here for now, a
 * documented, weaker-than-real-rules gap rather than a crash.
 */
export function runDraw(state: GameState): GameState {
  if (state.phase !== "Draw") {
    throw new Error(`runDraw requires Draw phase, currently: ${state.phase}`);
  }
  const next = updatePlayer(state, state.activePlayerIndex, (p) => {
    if (p.deck.length === 0) return p; // TODO: Burn Out (see doc comment)
    const [drawn, ...rest] = p.deck;
    return { ...p, deck: rest, hand: [...p.hand, drawn!] };
  });
  return { ...next, phase: "Action" };
}

/** Runs Awaken -> Beginning -> Channel -> Draw, landing in Action phase.
 *  Mirrors TurnManager.runStartOfTurn (engine/TurnManager.java:18-27), minus
 *  the Blue Sentinel rainbow-choice queue (no card grants that yet). */
export function runStartOfTurn(state: GameState): GameState {
  return runDraw(runChannel(runBeginning(runAwaken(state))));
}

/**
 * Ends the active player's turn: clears turn-scoped bonuses, empties floating
 * Energy/Power, resets cardsPlayedThisTurn, and rotates to the next player
 * (incrementing turnNumber when play wraps back to the FIRST player — rule
 * 118's turn order is "a looping queue of turns, starting with the First
 * Player", so a round is complete when it returns to them, whichever seat that
 * is; testing against the literal index 0 was only right while setup hardcoded
 * player 0 to start). Mirrors the
 * general-purpose parts of TurnManager.runEnd (engine/TurnManager.java:224-360)
 * — the ~40 per-card "this turn" field resets there have no equivalent yet
 * since none of those fields exist on our GameState/PlayerState (see this
 * file's own top doc comment).
 *
 * Damage heals here, for every unit on BOTH sides — units heal at the end of
 * every combat Showdown AND at the end of a player's turn (project owner's
 * rules call), so this is one of the two places that clears it; combat.ts's
 * own `heal` on the survivors of a resolved Showdown is the other. Matches
 * TurnManager.java:277-286.
 *
 * A previous round briefly removed this on the reading that marked damage
 * should survive until a Showdown ended. It shouldn't: both events heal. The
 * consequence worth knowing is that damage dealt outside combat on your own
 * turn (a Spell, an on-play trigger) is gone by the time your opponent acts,
 * so softening a blocker only pays off within the same turn you did it.
 */
export function runEnd(state: GameState): GameState {
  if (state.phase !== "Action") {
    throw new Error(`runEnd requires Action phase, currently: ${state.phase}`);
  }

  // The ending player's Legend fires FIRST, while it's still their turn and
  // before any of the resets below — Annie - Dark Child's "at the end of your
  // turn, ready up to 2 runes" has to see (and leave) a rune pool that the
  // opponent's upcoming turn will not touch. Deliberately not folded into the
  // map below: it's an ability firing, not a field reset.
  const afterLegend = dispatchLegendEndOfTurn(state, state.activePlayerIndex);

  // This-turn Might expires; Buffs deliberately do NOT. Rule 709 removes a Buff
  // only when its unit leaves play, so "buff a friendly unit" is a lasting
  // +1 Might that carries into later turns — which is what makes the eight
  // cards reading "while I'm buffed" worth anything.
  const expireMightThisTurn = <T extends { damage: number; mightThisTurn: number }>(u: T): T => ({ ...u, mightThisTurn: 0 });

  const players = afterLegend.players.map((p) => ({
    ...p,
    baseUnits: p.baseUnits.map(expireMightThisTurn),
    floatingEnergy: 0,
    floatingPower: {},
    cardsPlayedThisTurn: 0,
    firstFriendlyDeathUsedThisTurn: false,
    unitsEnterReadyThisTurn: false,
    restrictedSpellEnergy: 0,
  })) as [PlayerState, PlayerState];

  const battlefields = afterLegend.battlefields.map((bf) => {
    const units: typeof bf.units = {};
    for (const [playerId, list] of Object.entries(bf.units)) {
      units[playerId] = list.map(expireMightThisTurn);
    }
    return { ...bf, units };
  });

  const nextIndex = ((state.activePlayerIndex + 1) % 2) as 0 | 1;
  const turnNumber = nextIndex === state.firstPlayerIndex ? state.turnNumber + 1 : state.turnNumber;

  // Global damage heal — the same one combat cleanup performs, expressed once
  // in effect-helpers.ts rather than inlined per unit here.
  return healAllUnits({
    ...afterLegend,
    players,
    battlefields,
    activePlayerIndex: nextIndex,
    turnNumber,
    phase: "Awaken",
    // Highlander's ward only lasts "this turn" — cleared here same as every
    // other "this turn" field above (TurnManager.java:335's own reset).
    deathWardedUnitInstanceIds: [],
  });
}
