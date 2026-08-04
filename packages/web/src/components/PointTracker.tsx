interface PointTrackerProps {
  points: number;
  /**
   * How many points win THIS game — `victoryScore(state)`, not the printed 8.
   *
   * Passed in rather than read from the constant here, because Aspirant's Climb
   * ("increase the points needed to win the game by 1") makes it a property of
   * the board. A tracker showing 8 pips in a 9-point game would tell the player
   * they had won a turn before they had.
   */
  threshold: number;
}

/** A compact pip row (1..threshold), filled up to current points —
 *  a lighter-weight nod to a dedicated score track, without committing to a
 *  full sidebar layout (which would eat into the width battlefields/cards
 *  get, working against the "fit the window" fix). */
export function PointTracker({ points, threshold }: PointTrackerProps) {
  const pips = Array.from({ length: threshold }, (_, i) => i < points);
  return (
    <span className="point-tracker">
      {pips.map((filled, i) => (
        <span key={i} className={`point-pip${filled ? " filled" : ""}`} />
      ))}
    </span>
  );
}
