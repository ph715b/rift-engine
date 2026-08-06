import type { BattlefieldState, GameState, PlayerState } from "../model/game-state.js";
import { victoryScore } from "./constants.js";
import { holdEventTrigger } from "./triggers.js";
import { holdBattlefieldTrigger } from "./battlefield-abilities.js";
import { gainPoints } from "./effect-helpers.js";

function updatePlayer(state: GameState, index: 0 | 1, update: (p: PlayerState) => PlayerState): GameState {
  const players = [...state.players] as [PlayerState, PlayerState];
  players[index] = update(players[index]);
  return { ...state, players };
}

/** A battlefield is held by `playerId` when they have units there and no
 *  opponent does. Mirrors ScoringSystem.isHeldBy (engine/ScoringSystem.java:199-205). */
function isHeldBy(bf: BattlefieldState, playerId: string): boolean {
  const ownUnits = bf.units[playerId];
  if (!ownUnits || ownUnits.length === 0) return false;
  return Object.entries(bf.units).every(([otherId, units]) => otherId === playerId || units.length === 0);
}

/**
 * Beginning-Phase Hold scoring: "The Turn Player Holds all Battlefields they
 * Control" (rule 315.2.b.3), where Hold means "maintains Control of a
 * Battlefield they did not yet Score this turn" (rule 471.1.a).
 *
 * Records each scored battlefield, which it previously did not — the
 * final-point rule asks whether every battlefield has been SCORED this turn
 * (rule 474), and holds are half of scoring. Without this, holding one
 * battlefield and conquering the other looked like an incomplete sweep and
 * the winning point was wrongly withheld.
 *
 * Hold points always apply, including as a winning point — the sweep
 * requirement in rule 473 is specific to gaining a point through a CONQUER.
 * Mirrors ScoringSystem.scoreHolds (engine/ScoringSystem.java:38-77), minus
 * every named-card scoring-block (Tianna Crownguard, Forgotten Monument).
 * Hold triggers are no longer among the omissions — see the `battlefieldHeld`
 * hold at the end of this function.
 */
export function scoreHolds(state: GameState, playerIndex: 0 | 1): GameState {
  const player = state.players[playerIndex];
  const held = state.battlefields
    .filter((bf) => isHeldBy(bf, player.id))
    // "did not yet Score this turn" — one score per battlefield per turn from
    // either method (rule 471.1.b).
    .filter((bf) => !player.scoredBattlefieldsThisTurn.includes(bf.id))
    .map((bf) => bf.id);
  if (held.length === 0) return state;
  // **Recording the scoring and AWARDING the points are two steps now**, and
  // they are deliberately separable: Tianna Crownguard blocks the second while
  // the first still happens, so 471.1.b's once-per-battlefield-per-turn lockout
  // fires either way and the opponent cannot retry the battlefield this turn.
  // That is the project-owner ruling of 2026-08-06, and this is the site that
  // makes the difference visible.
  const recorded = updatePlayer(state, playerIndex, (p) => ({
    ...p,
    scoredBattlefieldsThisTurn: [...p.scoredBattlefieldsThisTurn, ...held],
  }));
  const scored = gainPoints(recorded, playerIndex, held.length);

  // Permanents watch the hold itself (Ahri - Alluring, Blitzcrank - Impassive).
  // This function's own doc comment used to end "minus ... hold-trigger dispatch
  // (no cards with onHold effects exist yet)" — it fired NOTHING, and that is
  // what those two cards were waiting on.
  //
  // HELD as Chain Pending Items (383), like every other converted event, and
  // fired AFTER the points are recorded so a listener reads the score its own
  // hold produced. One event per battlefield: "when I hold" is about the
  // battlefield the unit stands at, and holding two at once is two separate
  // holds.
  //
  // These are fired inside the Beginning Phase, which `submit`'s Pass runs as
  // part of `runStartOfTurn` — so like `endOfTurn` they sit in the pen until the
  // single Cleanup at the end of that action. See HeldEventKind's turn-boundary
  // note.
  return held.reduce((next, battlefieldId) => {
    const withPermanents = holdEventTrigger(next, { kind: "battlefieldHeld", holderIndex: playerIndex, battlefieldId });
    // The BATTLEFIELD's own "when you hold here" (Grove of the God-Willow, The
    // Grand Plaza, five more), placed after the permanents so it resolves before
    // them under LIFO — see holdBattlefieldTrigger.
    return holdBattlefieldTrigger(withPermanents, "hold", battlefieldId, playerIndex);
  }, scored);
}

/**
 * A battlefield changing to this player's control. It SCORES only if they
 * haven't already scored that battlefield this turn — "Conquer: A player gains
 * Control of a Battlefield they did not yet Score this turn" (rule 471.1), and
 * "A player may only Score, from either method, once per Battlefield per turn"
 * (rule 471.1.b). Taking a battlefield back after losing it in the same turn
 * therefore gains no second point; it used to.
 *
 * The point is further subject to the final-point rule: gaining a point
 * through a Conquer while already 1 short of the Victory Score only awards it
 * if the player has SCORED every battlefield this turn — holds count — and
 * otherwise draws a card instead (rule 474; this comment previously cited
 * §466.2, which in the current rules is Combat Cleanup, not scoring).
 *
 * Mirrors ScoringSystem.recordConquest (engine/ScoringSystem.java:136-195),
 * minus every named-card conquest-trigger dispatch and blocking check.
 */
export function recordConquest(state: GameState, playerIndex: 0 | 1, battlefieldId: string): GameState {
  const alreadyScored = state.players[playerIndex].scoredBattlefieldsThisTurn.includes(battlefieldId);

  let next = updatePlayer(state, playerIndex, (p) => ({
    ...p,
    scoredBattlefieldsThisTurn: alreadyScored ? p.scoredBattlefieldsThisTurn : [...p.scoredBattlefieldsThisTurn, battlefieldId],
  }));

  // The conqueror's LEGEND watches this moment too (Garen - Might of Demacia,
  // Sett - The Boss), and is now held by the same call rather than dispatched
  // just above it — `allListeningPermanents` walks the Legend zone, so a Legend
  // is an ordinary listener. It is placed LAST in that walk and so resolves
  // FIRST under LIFO, which is exactly where the inline dispatch used to sit.
  //
  // "When you conquer" is about taking the battlefield, not about scoring, so
  // this stays before the withheld-point branch and cannot be skipped by an early
  // return — the same reason ScoringSystem.java dispatches from this spot.
  //
  // Permanents watch the same moment (Kai'Sa - Survivor), and so does a card in
  // the trash (Super Mega Death Rocket). Placed beside the Legend dispatch and
  // before the withheld-point branch for the same reason: "when you conquer" is
  // about taking the battlefield, not about the point.
  //
  // HELD, not dispatched (383 / 809.1.b.3): a triggered ability goes on the Chain
  // as a Pending Item the instant it fires and becomes respondable when the
  // Cleanup finalizes it, so the opponent gets a window before Kai'Sa's draw or
  // Qiyana's choice resolves. See cleanup.finalizePendingTriggers.
  //
  // Two consequences of holding here, both of which are the rules working rather
  // than a regression:
  //  - **The POINT below is now awarded BEFORE these resolve.** Inline, a conquer
  //    trigger ran before the final-point check at 474; held, it runs after. No
  //    listener in this pool awards points, so nothing observable changes today —
  //    and 383's "on the chain the instant it fires, resolved later" is what makes
  //    the new order the correct one rather than merely a different one.
  //  - **The Legend is held by this same call now (2026-08-03).** It used to fire
  //    inline immediately above, because nothing could re-find it at resolution;
  //    the walk reaches the Legend zone, so a conquer puts the Legend and the
  //    permanents on the chain together. The Legend still resolves first, by
  //    being placed last — see listeningPermanents.
  next = holdEventTrigger(next, { kind: "battlefieldConquered", conquerorIndex: playerIndex, battlefieldId });
  // The BATTLEFIELD's own "when you conquer here" (Zaun Warrens, Targon's Peak,
  // three more), placed after the permanents so it resolves before them under
  // LIFO — see holdBattlefieldTrigger. Before the withheld-point branch below for
  // the same reason the permanents are: "when you conquer" is about taking the
  // battlefield, not about the point.
  next = holdBattlefieldTrigger(next, "conquer", battlefieldId, playerIndex);

  // Already scored here this turn — the battlefield changed hands, and the
  // Conquer trigger above still fired, but no second point.
  if (alreadyScored) return next;

  const player = next.players[playerIndex];
  // 474's Final Point rule, measured against THIS game's Victory Score rather
  // than the printed 8 — Aspirant's Climb moves the point at which it bites.
  if (player.points === victoryScore(next) - 1) {
    const allBattlefieldIds = next.battlefields.map((bf) => bf.id);
    const scoredAll = allBattlefieldIds.every((id) => player.scoredBattlefieldsThisTurn.includes(id));
    if (!scoredAll) {
      return updatePlayer(next, playerIndex, (p) => {
        const [drawnCard, ...rest] = p.deck;
        return drawnCard ? { ...p, deck: rest, hand: [...p.hand, drawnCard] } : p;
      });
    }
  }

  // Through `gainPoints`, the single choke point every point-gain goes through
  // so Tianna Crownguard's "opponents can't gain points" reaches it.
  //
  // The battlefield is recorded as scored ABOVE regardless — blocking a point
  // does not unrecord the scoring (project-owner ruling), so 471.1.b's
  // once-per-turn lockout still fires.
  return gainPoints(next, playerIndex, 1);
}
