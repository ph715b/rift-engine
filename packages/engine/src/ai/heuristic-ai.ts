import type { GameState } from "../model/game-state.js";
import type { UnitInstance } from "../model/card.js";
import type { PlayerAction } from "../actions/player-action.js";
import { legalActions } from "../engine/legal-actions.js";
import { executePlayCard } from "../actions/execute-play-card.js";
import { executeMoveUnit } from "../actions/execute-move-unit.js";
import { executeRecallUnit } from "../actions/execute-recall-unit.js";
import { executePassFocus } from "../actions/execute-pass-focus.js";
import { effectiveMight } from "../engine/effective-might.js";
import { runCleanup } from "../engine/cleanup.js";
import { actingPlayerIndex } from "../engine/timing.js";

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
 * approximation. One of the AI's own actions deep, but each candidate's
 * DEFERRED resolution is driven to completion before scoring (see
 * settleDeferredResolution): in this engine both combat and Spells pay off
 * behind PassFocus rather than at the moment the action is taken, so scoring
 * the immediate state left the AI structurally unable to do either.
 * Java's own lookahead mode (HeuristicAI.java:55, `lookaheadEnabled`)
 * does something similar but bolted on top of static heuristics, since its
 * engine doesn't produce cheap immutable snapshots the way this one does.
 *
 * Extend this by widening `evaluate`'s board-state weighting or by adding a
 * real N-ply search once move ordering / branching factor matters — not by
 * porting HeuristicAI.java's per-card special cases wholesale.
 */

/**
 * Applies one candidate action the way the real game would.
 *
 * The `runCleanup` wrapper is load-bearing, not tidiness: `submit` runs a Cleanup
 * after every action (rule 323), and the Cleanup is what STAGES a Showdown at a
 * Contested battlefield (341) and what lapses control of an emptied one (323.11).
 * Calling the executors bare would let the lookahead score a state the real game
 * never passes through — in particular a Move onto an empty battlefield would
 * look like "my unit is somewhere else, no points", because the Non-Combat
 * Showdown that eventually scores it would never have opened.
 */
function applyAction(state: GameState, action: PlayerAction): GameState {
  return runCleanup(applyBare(state, action));
}

function applyBare(state: GameState, action: PlayerAction): GameState {
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

/** How many PassFocus rounds `settleDeferredResolution` will drive before
 *  giving up. Two per pending item in a 2-player game, so this covers a chain
 *  several entries deep plus a Showdown — far more than anything reachable —
 *  and exists only so a future mechanic that re-closes the chain during
 *  resolution can't spin this forever. */
const MAX_SETTLE_PASSES = 16;

/**
 * Drives deferred resolution to completion, so a candidate action can be
 * scored on what it ACHIEVES rather than on the moment it's taken.
 *
 * This is load-bearing, not a refinement. Both of this engine's payoffs are
 * deferred behind PassFocus: `MoveUnit` into a contested battlefield only
 * opens a Showdown (combat resolves two focus-passes later), and a Spell's
 * `PlayCard` only pushes a ChainEntry (its effect resolves two chain-passes
 * later). Scoring the immediate state therefore showed an attack as "my unit
 * is standing somewhere else" and a cast as literally no change at all — so
 * `evaluate` returned a tie, and ties go to `Pass` because legal-actions.ts
 * pushes it first and `chooseAction` compares with a strict `>`.
 *
 * Measured over 12 self-play games before this existed: of 139 states offering
 * an attack the AI would WIN, the immediate score rated the best one at a
 * median of 0 (range −1…+2 — pure location-aura noise, not the fight), and the
 * AI passed in 53 of them. Settling first rates those same attacks at a median
 * of +1003. Spells were worse: the immediate score was exactly 0 in all 211
 * states one was legal (runes and cards aren't in `evaluate`, so a cast
 * couldn't even score as a cost), and the AI cast a Spell 0 times in 40 games.
 *
 * Note this cuts BOTH ways, which is the point — the settled score runs as low
 * as −7 on a losing attack, so the AI now declines bad fights for the same
 * reason it takes good ones. It gains judgement, not just aggression.
 *
 * The one assumption: that the opponent passes rather than responding. Now that
 * [Action]/[Reaction] casting exists, that is a genuine OPTIMISTIC assumption
 * rather than the only legal outcome — the AI scores every attack and every cast
 * as though it resolves unopposed, and will walk into removal it could have
 * anticipated. Correcting it means modelling the opponent's best response
 * (2-ply), which is a separate piece of work; it is recorded as a known
 * consequence in docs/rules-conformance.md rather than papered over here.
 */
function settleDeferredResolution(state: GameState): GameState {
  let settled = state;
  for (let i = 0; i < MAX_SETTLE_PASSES; i++) {
    // A closed chain takes precedence over an open Showdown, mirroring
    // executePassFocus's own dispatch order (it checks `chainOpen` first).
    if (!settled.chainOpen) {
      // Cleanup after each pass, same as `submit` — a chain closing inside a
      // Showdown can restage or promote one (317.2), which the next iteration
      // must see.
      settled = runCleanup(executePassFocus(settled, { type: "PassFocus", playerIndex: settled.chainPriority }));
      continue;
    }
    if (settled.turnState === "Showdown") {
      settled = runCleanup(executePassFocus(settled, { type: "PassFocus", playerIndex: settled.focusHolder }));
      continue;
    }
    return settled;
  }
  return settled;
}

/**
 * What one point of marked damage is worth, relative to one point of Might.
 *
 * Deliberately BELOW 1, and that bound is the whole design. `effectiveMight`
 * ignores marked damage, so before this the evaluator could only see damage that
 * actually killed something — every non-lethal hit scored exactly 0. That made
 * each target choice for a damage spell a tie, and ties fall through to
 * enumeration order, which lists base units before battlefield ones: the
 * observable symptom was the AI aiming Singularity ("Deal 6 to each of up to two
 * units") at its OWN base unit while an enemy stood at a battlefield.
 *
 * Weighting damage at full value would fix the sign and introduce a new error:
 * chipping 6 onto an 8-Might unit (+6) would outbid killing a 4-Might one (+4),
 * when the chip heals at end of turn (runEnd) or at Combat Cleanup and the kill
 * is permanent. Keeping the weight under 1 means accumulated damage can never
 * outbid removing the unit outright, so this only ever breaks ties — which is
 * exactly the job. It is a tie-breaker, not a valuation of damage.
 */
const DAMAGE_WEIGHT = 0.25;

/** A unit's worth to its controller: its Might, less a discount for damage
 *  already marked on it (see DAMAGE_WEIGHT). */
function unitValue(state: GameState, unit: UnitInstance, playerIndex: 0 | 1, battlefieldId?: string): number {
  const might = effectiveMight(state, unit, playerIndex, battlefieldId === undefined ? { isCombat: false } : { isCombat: false, battlefieldId });
  return might - unit.damage * DAMAGE_WEIGHT;
}

function totalBoardMight(state: GameState, playerIndex: 0 | 1): number {
  const player = state.players[playerIndex];
  let total = player.baseUnits.reduce((sum, u) => sum + unitValue(state, u, playerIndex), 0);
  for (const bf of state.battlefields) {
    total += (bf.units[player.id] ?? []).reduce((sum, u) => sum + unitValue(state, u, playerIndex, bf.id), 0);
  }
  return total;
}

/** Points dominate (winning the game outranks any board-state consideration);
 *  board value is the tiebreak/proxy for "which position is developing better"
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
  const forIndex = actingPlayerIndex(state);
  const candidates = legalActions(state).filter((a) => a.type !== "FloatRune" && a.type !== "ActivateAbility");

  let best: PlayerAction = { type: "Pass", playerIndex: forIndex };
  let bestScore = -Infinity;
  for (const action of candidates) {
    // Every candidate is scored on its SETTLED outcome — see
    // settleDeferredResolution for why scoring the immediate state made the AI
    // structurally unable to attack a contested battlefield or cast a Spell.
    // Only the scoring looks ahead; the action actually returned is still the
    // single candidate, so the real game still resolves through the real
    // PassFocus actions (and, in the UI, at the AI's own pacing).
    const score = evaluate(settleDeferredResolution(applyAction(state, action)), forIndex);
    if (score > bestScore) {
      bestScore = score;
      best = action;
    }
  }
  return best;
}
