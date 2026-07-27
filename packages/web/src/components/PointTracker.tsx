import { WIN_THRESHOLD_1V1 } from "@rift-engine/engine";

interface PointTrackerProps {
  points: number;
}

/** A compact pip row (1..WIN_THRESHOLD_1V1), filled up to current points —
 *  a lighter-weight nod to a dedicated score track, without committing to a
 *  full sidebar layout (which would eat into the width battlefields/cards
 *  get, working against the "fit the window" fix). */
export function PointTracker({ points }: PointTrackerProps) {
  const pips = Array.from({ length: WIN_THRESHOLD_1V1 }, (_, i) => i < points);
  return (
    <span className="point-tracker">
      {pips.map((filled, i) => (
        <span key={i} className={`point-pip${filled ? " filled" : ""}`} />
      ))}
    </span>
  );
}
