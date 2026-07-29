import type { GameState } from "../model/game-state.js";
import type { PlayerAction } from "../actions/player-action.js";
import { legalActions } from "../engine/legal-actions.js";
import { executePlayCard } from "../actions/execute-play-card.js";
import { executeMoveUnit } from "../actions/execute-move-unit.js";
import { executeRecallUnit } from "../actions/execute-recall-unit.js";
import { executePassFocus } from "../actions/execute-pass-focus.js";
import { effectiveMight } from "../engine/effective-might.js";

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
    case "RecallUnit":
      return executeRecallUnit(state, action);
    case "PassFocus":
      return executePassFocus(state, action);
    case "FloatRune":
      // Never reached — chooseAction filters FloatRune (and
      // ActivateAbility, same reasoning) out of its own candidate pool
      // below. A safe no-op fallback so this switch stays exhaustive over
      // PlayerAction.
      return state;
    case "ActivateAbility":
      // Never reached — see the FloatRune case above; banking restricted
      // Energy for a future Spell is exactly the same "no evaluative basis
      // in a 1-ply lookahead" case.
      return state;
  }
}

function totalBoardMight(state: GameState, playerIndex: 0 | 1): number {
  const player = state.players[playerIndex];
  let total = player.baseUnits.reduce((sum, u) => sum + effectiveMight(state, u, playerIndex, { isCombat: false }), 0);
  for (const bf of state.battlefields) {
    total += (bf.units[player.id] ?? []).reduce(
      (sum, u) => sum + effectiveMight(state, u, playerIndex, { isCombat: false, battlefieldId: bf.id }),
      0,
    );
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
  return me.points * 1000 - opponent.points * 1000 + totalBoardMight(state, forIndex) - totalBoardMight(state, opponentIndex);
}

/** Picks the legal action whose resulting state scores highest for the
 *  acting player, falling back to Pass when nothing beats it.
 *
 *  `forIndex` mirrors GameBoard.tsx's own `actingPlayerIndex` precedence
 *  (chain closed -> chainPriority, Showdown -> focusHolder, else ->
 *  activePlayerIndex) — this used to be hardcoded to `activePlayerIndex`,
 *  which was harmless only because `legalActions` used to return exactly
 *  one candidate (PassFocus) during a Showdown/closed chain, so the loop
 *  below always picked that single real action regardless of which index
 *  it was scored from. Now that FloatRune candidates can also appear
 *  alongside PassFocus in those states (see legal-actions.ts), scoring them
 *  "for activePlayerIndex" would be wrong whenever Focus/chain priority
 *  sits with the other player — this is that exact fix.
 *
 *  FloatRune AND ActivateAbility are both filtered out of the candidate
 *  pool entirely: `evaluate` only scores board state (points/Might), which
 *  can't meaningfully value a resource banked for a future play this 1-ply
 *  lookahead never sees — scoring either would only ever produce a
 *  meaningless tie with Pass/PassFocus. Matches this project's "no
 *  speculative heuristic without a real evaluative basis" precedent (e.g.
 *  the AI never mulligans either, for the same reason). */
export function chooseAction(state: GameState): PlayerAction {
  const forIndex: 0 | 1 = !state.chainOpen
    ? state.chainPriority
    : state.turnState === "Showdown"
      ? state.focusHolder
      : state.activePlayerIndex;
  const candidates = legalActions(state).filter((a) => a.type !== "FloatRune" && a.type !== "ActivateAbility");

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
