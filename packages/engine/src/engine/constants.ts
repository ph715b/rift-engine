/** 2-player Victory Score — model/GameState.java:17 (`WIN_THRESHOLD_1V1 = 8`).
 *  The multiplayer threshold (11) and the Aspirant's Climb battlefield's +1
 *  modifier (model/GameState.java:852-856) don't apply — this engine is
 *  2-player only for now, and Aspirant's Climb isn't a battlefield mechanic
 *  yet (battlefields currently carry no passive effects at all). Shared by
 *  scoring.ts and win-condition.ts (was two separately-declared copies). */
export const WIN_THRESHOLD_1V1 = 8;

/**
 * "If an opponent's score is within 3 points of the Victory Score" — the
 * comeback clause printed on Leona - Zealot (enters ready) and Find Your Center
 * (costs 2 less).
 *
 * One definition rather than two, because the two cards would otherwise be free
 * to drift on whether "within 3" is inclusive. It is: at the 8-point Victory
 * Score, an opponent on 5 triggers it.
 *
 * Reads the OPPONENT's points, never the asking player's — both cards reward
 * being behind, so measuring the wrong side would invert them.
 */
export const COMEBACK_SCORE_GAP = 3;

export function opponentNearVictory(
  state: { players: readonly { points: number }[] },
  playerIndex: 0 | 1,
): boolean {
  const opponentIndex = playerIndex === 0 ? 1 : 0;
  return WIN_THRESHOLD_1V1 - state.players[opponentIndex]!.points <= COMEBACK_SCORE_GAP;
}
