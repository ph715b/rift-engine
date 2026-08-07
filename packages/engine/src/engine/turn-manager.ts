import type { GameState, PlayerState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import { scoreHolds } from "./scoring.js";
import { dispatchLegendBeginningPhase } from "./legend-abilities.js";
import { destroyUnit, drawCards, healAllUnits } from "./effect-helpers.js";
import { dispatchEvent, holdEventTrigger, killGear } from "./triggers.js";
import { holdBattlefieldTrigger, runBattlefieldBeginningPhase } from "./battlefield-abilities.js";

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

  // Captured BEFORE the mass ready, because that is the only moment "was it
  // exhausted" is still answerable — rule 415 makes readying an already-Ready
  // unit a no-op, so a unit that was standing Ready must NOT produce a
  // `unitReadied` event. Ids rather than units: each of the holds below reads a
  // board this function has already rebuilt.
  const awakened = [
    ...state.players[active].baseUnits,
    ...state.battlefields.flatMap((bf) => bf.units[state.players[active].id] ?? []),
  ]
    .filter((u) => u.exhausted)
    .map((u) => u.instanceId);

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

  // One `unitReadied` PER UNIT, not one for the phase. Pirate's Haven reads
  // "give IT +1 Might this turn", so the event has to name a unit; a single
  // Awaken-shaped event could not say which. Rule 415 is what makes the Awaken a
  // readying at all — see the event's own note and docs/rules-calls-resolved.md.
  //
  // These are HELD, so a player with N exhausted units and a Pirate's Haven in
  // play puts N Pending Items on the chain at the top of every turn. That is the
  // rules' own shape (383 places each triggered ability separately) and it is why
  // probes/chain-depth.ts now carries an Awaken positive control — N triggers per
  // turn is the first thing in this engine that can make the chain deep by
  // routine play rather than by a combo.
  const held = awakened.reduce(
    (current, unitInstanceId) => holdEventTrigger(current, { kind: "unitReadied", ownerIndex: active, unitInstanceId }),
    next,
  );

  return { ...held, phase: "Beginning" };
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
  const afterUnits = doomed.reduce((next, instanceId) => destroyUnit(next, instanceId), state);

  // GEAR can be Temporary too — Fading Memories targets "a unit at a battlefield
  // or a gear", and 816 says "kill THIS permanent", not "this unit". Routed
  // through killGear so a gear that triggers on its own death (Scrapheap) fires,
  // exactly as a unit's [Deathknell] does — this was the site the earlier comment
  // here said would need to change once gear deaths had triggers.
  const doomedGear = afterUnits.players[controller].activeGear.filter((g) => "Temporary" in g.keywords);
  return doomedGear.reduce((next, gear) => killGear(next, gear, controller), afterUnits);
}

/** Kills [Temporary] permanents, then scores holds for the active player. Mirrors
 *  TurnManager.runBeginning (engine/TurnManager.java:86-98). */
export function runBeginning(state: GameState): GameState {
  if (state.phase !== "Beginning") {
    throw new Error(`runBeginning requires Beginning phase, currently: ${state.phase}`);
  }
  const afterTemporary = killTemporaryPermanents(state);
  // Beginning-Phase abilities fire after the [Temporary] kill and before holds
  // score. Both orderings are load-bearing: a Temporary unit must not be around
  // to be counted by anything, and rule 816's "before scoring" sets the frame
  // that everything else in this phase sits inside.
  const afterAbilities = dispatchEvent(afterTemporary, {
    kind: "beginningPhase",
    playerIndex: afterTemporary.activePlayerIndex,
  });
  // The Legend's own Beginning-Phase ability (Jinx - Loose Cannon), in the same
  // window as the permanents' — it is not a permanent on the board, so the
  // listener walk the event bus does cannot reach it.
  const afterLegend = dispatchLegendBeginningPhase(afterAbilities, afterAbilities.activePlayerIndex);
  // The BATTLEFIELDS' own Beginning-Phase abilities (Obelisk of Power, The
  // Arena's Greatest), in the same window and resolved INLINE for the same
  // reason the permanents' and the Legend's are: holding them would put them
  // after `scoreHolds`, and a point gained after holds score is a point gained
  // in the wrong phase.
  const afterBattlefields = runBattlefieldBeginningPhase(afterLegend, afterLegend.activePlayerIndex);
  return { ...scoreHolds(afterBattlefields, afterBattlefields.activePlayerIndex), phase: "Channel" };
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
 * their turn-1 draw" exception (out of scope — this engine is 2-player only).
 *
 * **Burn Out (rule 431) is no longer missing here.** This used to no-op on an
 * empty deck, described as a gap "weaker than the real rules but not a crash".
 * It was in fact a livelock: two empty decks with no battlefield held is a
 * position only Burn Out can break, and self-play sat in it passing to turn 538.
 * It now goes through `drawCards`, the same funnel every card effect draws
 * through, so the turn's draw and a spell's draw cannot disagree about what
 * running out of cards means.
 */
export function runDraw(state: GameState): GameState {
  if (state.phase !== "Draw") {
    throw new Error(`runDraw requires Draw phase, currently: ${state.phase}`);
  }
  return { ...drawCards(state, state.activePlayerIndex, 1), phase: "Action" };
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

  // **No separate Legend dispatch here.** Annie - Dark Child's "at the end of
  // your turn, ready up to 2 runes" used to fire inline, immediately before the
  // hold below, because `allListeningPermanents` did not walk the Legend zone and
  // so nothing could re-find her at resolution. It does now, and she is an
  // ordinary `endOfTurn` listener — held with Sona and respondable like her.
  //
  // Permanents watch the same moment (Sona - Harmonious). HELD, not dispatched
  // (383): a triggered ability is a Chain Pending Item from the instant it fires
  // and becomes respondable when the Cleanup finalizes it.
  //
  // **Fired here, before every reset below, and that is the whole point of the
  // position.** The resets clear exactly the "this turn" state an end-of-turn
  // ability is about, so a trigger fired after them would be asked its question
  // about a turn that had already been erased.
  //
  // The event carries the ending player rather than leaving listeners to read
  // `state.activePlayerIndex`, because it does NOT resolve here. `submit`'s Pass
  // is `runStartOfTurn(runEnd(state))` with a single Cleanup at the end, so this
  // entry sits in the pen across the rotation below, across the next player's
  // Awaken, hold scoring and draw, and finalizes onto the chain only after all of
  // it. By then `activePlayerIndex` is the OTHER player. See HeldEventKind's
  // turn-boundary note and test/turn-boundary-triggers.test.ts, which pins it.
  const withPermanents = holdEventTrigger(state, { kind: "endOfTurn", playerIndex: state.activePlayerIndex });

  // The BATTLEFIELDS' own delayed abilities — Targon's Peak's "ready up to 2
  // runes AT THE END OF THIS TURN", armed by a conquest earlier in the turn.
  //
  // Fired for EVERY battlefield, and it is each ability's `applies` that keeps
  // this from placing a Pending Item every turn for a battlefield that did
  // nothing. Held rather than resolved inline, like every other trigger, which
  // means it resolves in the next player's Action phase along with `endOfTurn` —
  // the recorded turn-boundary divergence, and the reason the delayed ability
  // CAPTURES its count here rather than reading it after the resets below.
  const afterTriggers = state.battlefields.reduce(
    (next, bf) => holdBattlefieldTrigger(next, "endOfTurn", bf.id, state.activePlayerIndex),
    withPermanents,
  );

  // This-turn Might expires; Buffs deliberately do NOT. Rule 709 removes a Buff
  // only when its unit leaves play, so "buff a friendly unit" is a lasting
  // +1 Might that carries into later turns — which is what makes the eight
  // cards reading "while I'm buffed" worth anything.
  // Stun expires with it — rule 422: "Stunned Units lose the Stunned status
  // during step 3d of the end of turn cleanup." Same sweep, since both are
  // this-turn states on every unit in play, on both sides.
  const expireMightThisTurn = <T extends { damage: number; mightThisTurn: number; stunned?: boolean }>(u: T): T => ({
    ...u,
    mightThisTurn: 0,
    ...(u.stunned ? { stunned: false } : {}),
    // Udyr's this-turn [Ganking] and his record of which modes he has spent —
    // both expire here for the same reason mightThisTurn does.
    ...("keywordsThisTurn" in u ? { keywordsThisTurn: {} } : {}),
    ...("abilityModesUsedThisTurn" in u ? { abilityModesUsedThisTurn: [] } : {}),
    // Miss Fortune - Captain's "the first time I move EACH TURN" — the memory
    // has to be per unit and has to expire, exactly like the two above.
    ...("movesThisTurn" in u ? { movesThisTurn: 0 } : {}),
  });

  const players = afterTriggers.players.map((p) => ({
    ...p,
    baseUnits: p.baseUnits.map(expireMightThisTurn),
    floatingEnergy: 0,
    floatingPower: {},
    floatingRainbowPower: 0,
    cardsPlayedThisTurn: 0,
    firstFriendlyDeathUsedThisTurn: false,
    extraMightPerBuffThisTurn: 0,
    discardedThisTurn: false,
    // Targon's Peak's armed ready is 'this turn' state and ends with the turn.
    // The trigger fired above already CAPTURED the count, so clearing it here
    // cannot take the effect away — see BattlefieldTriggerDefinition.capture.
    readyRunesAtEndOfTurn: 0,
    // The Dreaming Tree's once-per-turn draw, cleared for both players — the
    // same sweep every other "this turn" field here goes through.
    spellChoiceDrawnBattlefieldIds: [] as string[],
    unitsEnterReadyThisTurn: false,
    restrictedSpellEnergy: 0,
    restrictedSpellPower: 0,
    restrictedGearPower: 0,
    gearPlayedThisTurn: 0,
    equipmentPlayedThisTurn: 0,
    // Ezreal - Prodigal Explorer's "twice THIS TURN". Cleared for both players,
    // like every field here — he is a [Reaction], so the turn his count is
    // measured against can be the opponent's.
    enemyChoicesThisTurn: 0,
    // Temporal Portal's armed grant is "the next spell you play THIS TURN" and
    // expires unspent with the turn, like every other field here.
    nextSpellRepeatGrants: 0,
    // Sun Disc's armed charge and the per-turn death tally Spoils of War prices
    // itself from — both are "this turn" state, so both end with the turn.
    nextUnitsEnterReady: 0,
    // Jayce - Man of Progress's window closes with the turn that opened it.
    freeGearPlaysThisTurn: 0,
    // Last Rites' trash-play permission, for the same reason: it is a window
    // held open only because this engine cannot play a card mid-resolution, so
    // it must not outlive the turn that opened it.
    trashUnitPlaysThisTurn: 0,
    pointsFromHoldingThisTurn: 0,
    powerSpentThisTurn: 0,
    buffUnitsPlayedThisTurn: 0,
    // Annotated because this object is cast to a PlayerState tuple below, and a
    // bare `[]` infers `never[]`, which does not overlap `string[]`.
    conqueredBattlefieldsThisTurn: [] as string[],
    unitsLostThisTurn: 0,
    // Raging Firebrand's unspent charge and Unyielding Spirit's prevention are
    // both "this turn" and end with it, exactly like the fields above.
    nextSpellEnergyDiscount: 0,
    nextSpellBonusDamage: 0,
    cannotPlayCardsThisTurn: false,
    hideIgnoresCostThisTurn: false,
    preventsSpellDamageThisTurn: false,
  })) as [PlayerState, PlayerState];

  const battlefields = afterTriggers.battlefields.map((bf) => {
    const units: typeof bf.units = {};
    for (const [playerId, list] of Object.entries(bf.units)) {
      units[playerId] = list.map(expireMightThisTurn);
    }
    return { ...bf, units };
  });

  // An EXTRA turn (Time Warp) hands the turn straight back rather than rotating.
  // Everything else about it is an ordinary turn — its own Awaken, scoring, draw
  // and End — because the card says "take a turn", not "take another action
  // phase". The `turnNumber` bump below therefore does NOT happen: a round is
  // complete when play returns to the FIRST player (118), and it has not.
  const takesAnotherTurn = state.extraTurns > 0 && state.extraTurnsForIndex === state.activePlayerIndex;
  const nextIndex = takesAnotherTurn ? state.activePlayerIndex : (((state.activePlayerIndex + 1) % 2) as 0 | 1);
  const turnNumber = !takesAnotherTurn && nextIndex === state.firstPlayerIndex ? state.turnNumber + 1 : state.turnNumber;

  // Global damage heal — the same one combat cleanup performs, expressed once
  // in effect-helpers.ts rather than inlined per unit here.
  return healAllUnits({
    ...afterTriggers,
    players,
    battlefields,
    activePlayerIndex: nextIndex,
    turnNumber,
    // Spent as it is taken, so two Time Warps really are two extra turns and a
    // queue can never outlive the player it belongs to.
    extraTurns: takesAnotherTurn ? state.extraTurns - 1 : state.extraTurns,
    phase: "Awaken",
    // Highlander's ward only lasts "this turn" — cleared here same as every
    // other "this turn" field above (TurnManager.java:335's own reset).
    lastShowdownExcessDamage: null,
    deathWardedUnitInstanceIds: [],
    paidDeathWardUnitInstanceIds: [],
    // Imperial Decree's sweep and Noxian Guillotine's death sentences are the
    // same shape and expire the same way — a delayed effect that outlived its
    // turn would kill on a board the caster never saw.
    killDamagedUnitsThisTurn: false,
    markedForDeathOnDamageInstanceIds: [],
    damagePreventedOnceInstanceIds: [],
  });
}
