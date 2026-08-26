import type { GameState, PlayerState } from "../model/game-state.js";
import type { PlayerAction } from "../actions/player-action.js";
import type { GameEvent } from "./triggers.js";
import { validatePlayCard } from "../actions/validate-play-card.js";
import { executePlayCard } from "../actions/execute-play-card.js";
import { validatePass } from "../actions/validate-pass.js";
import { validateMoveUnit } from "../actions/validate-move-unit.js";
import { executeMoveUnit } from "../actions/execute-move-unit.js";
import { validateRecallUnit } from "../actions/validate-recall-unit.js";
import { executeRecallUnit } from "../actions/execute-recall-unit.js";
import { validatePassFocus } from "../actions/validate-pass-focus.js";
import { executePassFocus } from "../actions/execute-pass-focus.js";
import { validateFloatRune } from "../actions/validate-float-rune.js";
import { executeFloatRune } from "../actions/execute-float-rune.js";
import { validateActivateAbility } from "../actions/validate-activate-ability.js";
import { executeActivateAbility } from "../actions/execute-activate-ability.js";
import { validateHideCard } from "../actions/validate-hide-card.js";
import { executeHideCard } from "../actions/execute-hide-card.js";
import { validateAnswerDecision } from "../actions/validate-answer-decision.js";
import { executeAnswerDecision } from "../actions/execute-answer-decision.js";
import { runEnd, runStartOfTurn } from "./turn-manager.js";
import { winner } from "./win-condition.js";
import { runCleanup } from "./cleanup.js";
import type { SubmitResult } from "./submit-result.js";

/**
 * Draws up to 4 cards per player from their deck into hand. Mirrors
 * GameEngine.dealOpeningHandsOnly (engine/GameEngine.java:74-96) — silently
 * stops early if a deck runs out (a real 40-card deck never will from a
 * 4-card opening hand; same "no Burn Out safety net needed here" reasoning
 * the Java doc comment gives).
 */
export function dealOpeningHands(state: GameState): GameState {
  const players = state.players.map((p): PlayerState => {
    const drawn = p.deck.slice(0, 4);
    return { ...p, deck: p.deck.slice(drawn.length), hand: [...p.hand, ...drawn] };
  }) as [PlayerState, PlayerState];
  return { ...state, players };
}

/**
 * Every resolved action ends the same way: run the Cleanup, then check whether
 * anyone has won. That order is the rules' own — rule 323's Cleanup performs its
 * state-based actions (including control lapsing, step 4) and the victory check
 * is a cleanup-time question (194.2 / 198.1). Cleanup can't create or destroy
 * points, so it can't change who wins this instant; running it first is about
 * never leaving a caller holding a state the rules wouldn't allow.
 */
function withCleanupAndWinnerCheck(state: GameState): { state: GameState; result: SubmitResult } {
  // ...unless the action stopped halfway through to ask someone a question.
  //
  // Rule 321: "while Chain Items are Resolving, a Cleanup cannot occur", and
  // 321.1 makes a Cleanup that becomes due during a resolution an Outstanding
  // Task instead. A pending decision IS a resolution in progress, so running the
  // Cleanup here would apply state-based actions to a half-finished effect —
  // lapsing control of a battlefield whose units are about to arrive, or killing
  // a unit the rest of the effect was going to heal.
  //
  // Nothing is lost by deferring: the Cleanup runs when the last answer comes
  // in, and 322 says a Cleanup repeats until the state stops changing, so one
  // at the end does the work of the ones skipped. Skipping the winner check with
  // it is the same reasoning — a game cannot be over in the middle of an effect.
  if (state.pendingDecisions.length > 0) return { state, result: { type: "Ok" } };

  const cleaned = runCleanup(state);
  const w = winner(cleaned);
  if (w === null) return { state: cleaned, result: { type: "Ok" } };
  return { state: cleaned, result: { type: "GameOver", winnerId: cleaned.players[w].id } };
}

/** Runs the first Start-of-Turn sequence on an already-hands-dealt state.
 *  Split out from `startGame` so callers can deal hands, run a pregame
 *  Mulligan for both players (see actions/execute-mulligan.ts), and only
 *  then begin the first turn — mirrors GameEngine.beginFirstTurn()
 *  (engine/GameEngine.java:123-131), which the real client calls only after
 *  its own mulligan screens finish (ui/RiftboundApp.java:135-139). */
export function beginFirstTurn(state: GameState): { state: GameState; result: SubmitResult } {
  return withCleanupAndWinnerCheck(runStartOfTurn(state));
}

/** Deals opening hands and runs the first Start-of-Turn sequence, with no
 *  mulligan step in between — used directly wherever a match doesn't need
 *  one (e.g. engine tests exercising turn machinery in isolation). */
export function startGame(state: GameState): { state: GameState; result: SubmitResult } {
  return beginFirstTurn(dealOpeningHands(state));
}

/**
 * Mirrors GameEngine.submit(PlayerAction) (engine/GameEngine.java:133-276),
 * scoped to the action types implemented so far. A bare `Pass` ends the turn
 * outright (`turnManager.endTurn(); turnManager.runStartOfTurn();`, :270-271)
 * and is illegal while a Showdown is open — the two-consecutive-passes
 * mechanic belongs to PassFocus instead (executePassFocus), which only
 * passes Focus within an open Showdown, not the whole turn.
 */
/**
 * The result of one submitted action: the new state, the outcome, and **what
 * happened on the way**.
 *
 * `events` is the engine's own narration — the same `GameEvent`s its triggers
 * already fire, which used to be computed and discarded. A caller can now say
 * "a unit died in combat" instead of noticing that a battlefield has one fewer
 * card than it did last render.
 *
 * Empty for a refused action: nothing happened, so nothing is reported.
 */
export interface SubmitOutcome {
  state: GameState;
  result: SubmitResult;
  events: readonly GameEvent[];
}

/**
 * Submits an action, and reports the events it raised.
 *
 * **The events are cleared before the action and read after it**, so `events`
 * describes THIS action and nothing earlier. `GameState.recentEvents` carries
 * them on the state because that is the only channel the engine's internals
 * share; this wrapper is what turns a rolling field into a per-action answer.
 *
 * The AI does not come through here — `heuristic-ai`'s lookahead calls the
 * executors directly — which is why the field is capped rather than trusted to
 * be reset. See `RECENT_EVENT_CAP` in triggers.ts.
 */
export function submit(state: GameState, action: PlayerAction): SubmitOutcome {
  const outcome = submitAction({ ...state, recentEvents: [] }, action);
  /**
   * **A REFUSED action returns the state it was given — the identical object.**
   *
   * That contract predates this wrapper and two tests assert it in as many words
   * ("a refused action must leave the state alone"). Clearing `recentEvents` on
   * the way in makes a fresh object, so without this line every refusal returned
   * a state that was equal to the caller's but not the same as it.
   *
   * Worth keeping rather than weakening the tests: "nothing happened" is exactly
   * what an Invalid result means, and a caller that compares by identity to
   * decide whether to re-render is asking a fair question.
   *
   * Events are empty for the same reason. A refusal raises none — it never got
   * far enough to raise anything.
   */
  if (outcome.result.type === "Invalid") return { state, result: outcome.result, events: [] };
  return { ...outcome, events: outcome.state.recentEvents ?? [] };
}

function submitAction(state: GameState, action: PlayerAction): { state: GameState; result: SubmitResult } {
  // A win is declared IN A CLEANUP (rule 194.2: "A player wins the game if, in a
  // cleanup, they have points greater than or equal to the Victory Score..."), and
  // 321 says a Cleanup cannot occur while a resolution is suspended. So while
  // a question is pending, points being over the threshold is NOT yet a win — the
  // Cleanup that would declare it has not run and cannot run.
  //
  // Reading `winner` as a bare points predicate here stranded games: an action that
  // parked a question and THEN crossed the threshold (combat kills a buffed unit,
  // Sett's replacement offer is parked, the loop continues into scoring) returned
  // Ok with the winner check skipped by withCleanupAndWinnerCheck above — and then
  // this gate refused every subsequent action INCLUDING the AnswerDecision that
  // would have finished the resolution. The unit was left in
  // `unitsAwaitingDeathReplacement` forever, in neither play nor a trash.
  // Measured at 5 stranded units per 300 self-play games before this line changed.
  //
  // The suspension is the same one line 62 already honours, expressed once more
  // here rather than letting the two guards disagree about whether the game is over.
  if (state.pendingDecisions.length === 0 && winner(state) !== null) {
    return { state, result: { type: "Invalid", error: "Game is already over" } };
  }

  // One central gate rather than the same guard bolted onto eight validators.
  // While the engine is waiting on an answer the game is paused mid-resolution,
  // so nothing else is legal for either player — not a play, not a Pass, not
  // even passing Focus, since 320.1 says Priority and Focus "are not passed or
  // awarded" while resolution is suspended.
  if (state.pendingDecisions.length > 0 && action.type !== "AnswerDecision") {
    return { state, result: { type: "Invalid", error: "A decision is pending — answer it first" } };
  }

  switch (action.type) {
    case "AnswerDecision": {
      const validation = validateAnswerDecision(state, action);
      if (!validation.ok) return { state, result: { type: "Invalid", error: validation.error } };
      return withCleanupAndWinnerCheck(executeAnswerDecision(state, action));
    }
    case "PlayCard": {
      const validation = validatePlayCard(state, action);
      if (!validation.ok) return { state, result: { type: "Invalid", error: validation.error } };
      return withCleanupAndWinnerCheck(executePlayCard(state, action));
    }
    case "HideCard": {
      const validation = validateHideCard(state, action);
      if (!validation.ok) return { state, result: { type: "Invalid", error: validation.error } };
      return withCleanupAndWinnerCheck(executeHideCard(state, action));
    }
    case "Pass": {
      const validation = validatePass(state, action);
      if (!validation.ok) return { state, result: { type: "Invalid", error: validation.error } };
      return withCleanupAndWinnerCheck(runStartOfTurn(runEnd(state)));
    }
    case "MoveUnit": {
      const validation = validateMoveUnit(state, action);
      if (!validation.ok) return { state, result: { type: "Invalid", error: validation.error } };
      return withCleanupAndWinnerCheck(executeMoveUnit(state, action));
    }
    case "RecallUnit": {
      const validation = validateRecallUnit(state, action);
      if (!validation.ok) return { state, result: { type: "Invalid", error: validation.error } };
      return withCleanupAndWinnerCheck(executeRecallUnit(state, action));
    }
    case "PassFocus": {
      const validation = validatePassFocus(state, action);
      if (!validation.ok) return { state, result: { type: "Invalid", error: validation.error } };
      return withCleanupAndWinnerCheck(executePassFocus(state, action));
    }
    case "FloatRune": {
      const validation = validateFloatRune(state, action);
      if (!validation.ok) return { state, result: { type: "Invalid", error: validation.error } };
      return withCleanupAndWinnerCheck(executeFloatRune(state, action));
    }
    case "ActivateAbility": {
      const validation = validateActivateAbility(state, action);
      if (!validation.ok) return { state, result: { type: "Invalid", error: validation.error } };
      return withCleanupAndWinnerCheck(executeActivateAbility(state, action));
    }
  }
}
