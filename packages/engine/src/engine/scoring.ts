import type { BattlefieldState, GameState, PlayerState } from "../model/game-state.js";
import { WIN_THRESHOLD_1V1 } from "./constants.js";
import { dispatchLegendOnConquer } from "./legend-abilities.js";
import { holdEventTrigger } from "./triggers.js";

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
 * every named-card scoring-block (Tianna Crownguard, Forgotten Monument) and
 * hold-trigger dispatch (no cards with onHold effects exist yet).
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
  return updatePlayer(state, playerIndex, (p) => ({
    ...p,
    points: p.points + held.length,
    scoredBattlefieldsThisTurn: [...p.scoredBattlefieldsThisTurn, ...held],
  }));
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

  // The conqueror's Legend fires on the conquest itself, independently of
  // whether the POINT below is awarded or withheld by the final-point rule —
  // "when you conquer" is about taking the battlefield, not about scoring
  // (Garen - Might of Demacia; ScoringSystem.java dispatches from this same
  // spot). Placed before the withheld-point branch so the trigger can't be
  // skipped by an early return.
  next = dispatchLegendOnConquer(next, playerIndex, battlefieldId);
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
  //  - **The caster's LEGEND still fires inline, immediately above.** Those seven
  //    hooks cannot be held yet (`allListeningPermanents` never walks
  //    `players[i].legend`), so a conquer now resolves the Legend first and the
  //    permanents on the chain. That was already the order; only the window is new.
  next = holdEventTrigger(next, { kind: "battlefieldConquered", conquerorIndex: playerIndex, battlefieldId });

  // Already scored here this turn — the battlefield changed hands, and the
  // Conquer trigger above still fired, but no second point.
  if (alreadyScored) return next;

  const player = next.players[playerIndex];
  if (player.points === WIN_THRESHOLD_1V1 - 1) {
    const allBattlefieldIds = next.battlefields.map((bf) => bf.id);
    const scoredAll = allBattlefieldIds.every((id) => player.scoredBattlefieldsThisTurn.includes(id));
    if (!scoredAll) {
      return updatePlayer(next, playerIndex, (p) => {
        const [drawnCard, ...rest] = p.deck;
        return drawnCard ? { ...p, deck: rest, hand: [...p.hand, drawnCard] } : p;
      });
    }
  }

  return updatePlayer(next, playerIndex, (p) => ({ ...p, points: p.points + 1 }));
}
