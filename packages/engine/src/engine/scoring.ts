import type { BattlefieldState, GameState, PlayerState } from "../model/game-state.js";

/** 2-player Victory Score — see win-condition.ts's own doc comment for why
 *  this is duplicated as a local constant rather than imported (avoiding a
 *  cyclic import isn't a concern in TS the way it was for the C# port, but
 *  these two modules genuinely don't need to share the value beyond this
 *  coincidence — see PRD's resolved port-strategy question). */
const WIN_THRESHOLD = 8;

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
 * Awards 1 point per battlefield the player currently holds solely. Hold
 * points always apply, including as a winning point — no sweep requirement
 * (unlike recordConquest below). Mirrors ScoringSystem.scoreHolds
 * (engine/ScoringSystem.java:38-77), minus every named-card scoring-block
 * (Tianna Crownguard, Forgotten Monument) and hold-trigger dispatch (no
 * cards with onHold effects exist yet).
 */
export function scoreHolds(state: GameState, playerIndex: 0 | 1): GameState {
  const player = state.players[playerIndex];
  const heldCount = state.battlefields.filter((bf) => isHeldBy(bf, player.id)).length;
  if (heldCount === 0) return state;
  return updatePlayer(state, playerIndex, (p) => ({ ...p, points: p.points + heldCount }));
}

/**
 * Records a conquest (a battlefield changing to this player's control) and
 * awards the point, subject to the final-point rule: if this would be the
 * player's WINNING point (points already at threshold - 1) and they haven't
 * conquered every battlefield this turn, the point is withheld and they
 * draw 1 compensation card instead (core rules §466.2). Mirrors
 * ScoringSystem.recordConquest (engine/ScoringSystem.java:136-195), minus
 * every named-card conquest-trigger dispatch and blocking check.
 */
export function recordConquest(state: GameState, playerIndex: 0 | 1, battlefieldId: string): GameState {
  let next = updatePlayer(state, playerIndex, (p) => ({
    ...p,
    conqueredBattlefieldsThisTurn: p.conqueredBattlefieldsThisTurn.includes(battlefieldId)
      ? p.conqueredBattlefieldsThisTurn
      : [...p.conqueredBattlefieldsThisTurn, battlefieldId],
  }));

  const player = next.players[playerIndex];
  if (player.points === WIN_THRESHOLD - 1) {
    const allBattlefieldIds = next.battlefields.map((bf) => bf.id);
    const conqueredAll = allBattlefieldIds.every((id) => player.conqueredBattlefieldsThisTurn.includes(id));
    if (!conqueredAll) {
      return updatePlayer(next, playerIndex, (p) => {
        const [drawnCard, ...rest] = p.deck;
        return drawnCard ? { ...p, deck: rest, hand: [...p.hand, drawnCard] } : p;
      });
    }
  }

  return updatePlayer(next, playerIndex, (p) => ({ ...p, points: p.points + 1 }));
}
