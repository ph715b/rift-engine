/**
 * A pregame, per-player card exchange — NOT part of the `PlayerAction` union
 * on purpose. Mirrors GameEngine.mulligan(Player, List<Card>)
 * (engine/GameEngine.java:98-121), which is a plain method call with no
 * phase check at all, invoked directly between dealOpeningHandsOnly() and
 * beginFirstTurn() — never routed through the real action-submission system
 * (submit()/legalActions()). Kept in its own file, separate from
 * player-action.ts's union, so it can never be accidentally wired into
 * either of those.
 */
export interface MulliganAction {
  type: "Mulligan";
  playerIndex: 0 | 1;
  /** Up to 2 instanceIds, currently in this player's hand, to set aside and replace. */
  setAsideInstanceIds: string[];
}
