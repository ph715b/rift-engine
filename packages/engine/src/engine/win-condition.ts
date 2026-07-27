import type { GameState } from "../model/game-state.js";

/** 2-player Victory Score — model/GameState.java:17 (`WIN_THRESHOLD_1V1 = 8`).
 *  The multiplayer threshold (11) and the Aspirant's Climb battlefield's
 *  +1 modifier (model/GameState.java:852-856) don't apply — this engine is
 *  2-player only for now, and Aspirant's Climb isn't a battlefield mechanic
 *  yet (battlefields currently carry no passive effects at all). */
const WIN_THRESHOLD = 8;

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
  const [a, b] = state.players;
  if (a.points === b.points) return null; // a tie at/above threshold is deliberately not a win

  const [maxIndex, maxPoints] = a.points > b.points ? ([0, a.points] as const) : ([1, b.points] as const);
  return maxPoints >= WIN_THRESHOLD ? maxIndex : null;
}
