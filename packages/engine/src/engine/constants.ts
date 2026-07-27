/** 2-player Victory Score — model/GameState.java:17 (`WIN_THRESHOLD_1V1 = 8`).
 *  The multiplayer threshold (11) and the Aspirant's Climb battlefield's +1
 *  modifier (model/GameState.java:852-856) don't apply — this engine is
 *  2-player only for now, and Aspirant's Climb isn't a battlefield mechanic
 *  yet (battlefields currently carry no passive effects at all). Shared by
 *  scoring.ts and win-condition.ts (was two separately-declared copies). */
export const WIN_THRESHOLD_1V1 = 8;
