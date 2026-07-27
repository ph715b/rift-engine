import type { GameState, PlayerState } from "../model/game-state.js";
import type { PlayerAction } from "../actions/player-action.js";
import { legalActions } from "../engine/legal-actions.js";
import { executePlayCard } from "../actions/execute-play-card.js";
import { executeMoveUnit } from "../actions/execute-move-unit.js";

/**
 * A simple heuristic AI opponent — enough to be a real (if not yet strong)
 * opponent for playtesting, per PRD Goal 2/FR9. Deliberately NOT a port of
 * HeuristicAI.java (1955 lines of largely per-card scoring functions,
 * engine/HeuristicAI.java) — that scale of card-specific tuning only makes
 * sense once this engine has a comparable number of cards' effects
 * implemented. Instead this takes advantage of a real architectural win
 * from the engine being a pure `(state, action) -> nextState` reducer (PRD
 * Goal 4): rather than hand-rolling heuristics that approximate combat
 * math, every legal candidate action is actually APPLIED via the real
 * validator/executor pipeline to get a genuine resulting state, which is
 * then scored directly — a correct 1-ply lookahead by construction, not an
 * approximation. Java's own lookahead mode (HeuristicAI.java:55, `lookaheadEnabled`)
 * does something similar but bolted on top of static heuristics, since its
 * engine doesn't produce cheap immutable snapshots the way this one does.
 *
 * Extend this by widening `evaluate`'s board-state weighting or by adding a
 * real N-ply search once move ordering / branching factor matters — not by
 * porting HeuristicAI.java's per-card special cases wholesale.
 */

function applyAction(state: GameState, action: PlayerAction): GameState {
  switch (action.type) {
    case "Pass":
      return state;
    case "PlayCard":
      return executePlayCard(state, action);
    case "MoveUnit":
      return executeMoveUnit(state, action);
  }
}

function totalBoardMight(state: GameState, player: PlayerState): number {
  let total = player.baseUnits.reduce((sum, u) => sum + u.might + u.bonus, 0);
  for (const bf of state.battlefields) {
    total += (bf.units[player.id] ?? []).reduce((sum, u) => sum + u.might + u.bonus, 0);
  }
  return total;
}

/** Points dominate (winning the game outranks any board-state consideration);
 *  board Might is the tiebreak/proxy for "which position is developing better"
 *  in the absence of any deeper positional evaluation yet. */
function evaluate(state: GameState, forIndex: 0 | 1): number {
  const opponentIndex: 0 | 1 = forIndex === 0 ? 1 : 0;
  const me = state.players[forIndex];
  const opponent = state.players[opponentIndex];
  return me.points * 1000 - opponent.points * 1000 + totalBoardMight(state, me) - totalBoardMight(state, opponent);
}

/** Picks the legal action whose resulting state scores highest for the
 *  active player, falling back to Pass when nothing beats it. */
export function chooseAction(state: GameState): PlayerAction {
  const forIndex = state.activePlayerIndex;
  const candidates = legalActions(state);

  let best: PlayerAction = { type: "Pass", playerIndex: forIndex };
  let bestScore = -Infinity;
  for (const action of candidates) {
    const score = evaluate(applyAction(state, action), forIndex);
    if (score > bestScore) {
      bestScore = score;
      best = action;
    }
  }
  return best;
}
