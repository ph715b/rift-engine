import type { GameState } from "../model/game-state.js";
import { WIN_THRESHOLD_1V1 } from "./constants.js";

/**
 * Returns the winning player's index, or null if no one has won yet.
 * Mirrors GameState.winner() (model/GameState.java:890-910): a player wins
 * only when their points are >= the threshold AND strictly greater than
 * every opponent's — a tie at/above threshold yields no winner. This was a
 * confirmed real bug in the Java engine's history (core rules §323.7,
 * fixed before this port started) — ported as the two-part check from day
 * one, not the simpler-but-wrong "first to threshold" version.
 */
export function winner(state: GameState): 0 | 1 | null {
  // An ALTERNATE win condition, checked before the score — The Grand Plaza's
  // "when you hold here, if you have 7+ units here, you win the game". Points
  // are not the only way to end a game, and a card that says "you win" must not
  // have to be expressed as enough points to reach the Victory Score: that would
  // also be beatable by a tie and would satisfy every "an opponent is within 3
  // points" clause on the board.
  if (state.declaredWinnerIndex !== null) return state.declaredWinnerIndex;

  const [a, b] = state.players;
  if (a.points === b.points) return null; // a tie at/above threshold is deliberately not a win

  const [maxIndex, maxPoints] = a.points > b.points ? ([0, a.points] as const) : ([1, b.points] as const);
  return maxPoints >= WIN_THRESHOLD_1V1 ? maxIndex : null;
}
