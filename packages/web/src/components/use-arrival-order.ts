import { useRef } from "react";

/**
 * **Which cards in a row arrived THIS render, and in what order** — the cascade
 * index for `CardView`'s `staggerIndex`.
 *
 * # Why a group needs one at all
 *
 * `legal-actions` enumerates **144.3's simultaneous move**: one action that walks
 * several units to a battlefield at once. That is a single state change, so
 * without a cascade three units arrive in perfect unison and the row reads as
 * having teleported rather than as three units marching in.
 *
 * # Why NEW cards only, and not the row index
 *
 * Staggering by position in the row is the obvious version and it is wrong in the
 * direction the player feels most: a unit you just played is appended to the END
 * of the row, so it would receive the LARGEST delay. The one card whose response
 * you are actually waiting on would be the slowest to move, which reads as lag
 * rather than as choreography.
 *
 * Diffing against the previous render gives arrival order instead — the cards
 * that were not here last time cascade among themselves, and everything already
 * standing gets 0 and keeps moving at its own pace. That also means an ordinary
 * re-render (a hover, a resize, a prop change somewhere else) cascades nothing,
 * which is what stops the board from rippling every time React does its job.
 *
 * Recovered by DIFFING because the engine reports state, not events — the same
 * reasoning `use-zone-flights.ts` records at more length, and the same reason
 * `PointTracker` diffs its pips.
 *
 * # Not a hook per card
 *
 * Called once per ROW with every id in it, so one comparison serves the whole
 * row and the indices are consistent across it. A per-card version could not know
 * whether it was the first or third arrival.
 */
export function useArrivalOrder(ids: readonly string[]): ReadonlyMap<string, number> {
  const previous = useRef<ReadonlySet<string>>(new Set());
  const order = new Map<string, number>();

  // First render is NOT an arrival. Everything is new when a board mounts, and
  // cascading the whole thing on mount would make every page load and every
  // re-mount look like a dramatic entrance.
  const isFirstRender = previous.current.size === 0 && ids.length > 0;
  let arrivals = 0;
  for (const id of ids) {
    if (!isFirstRender && !previous.current.has(id)) {
      order.set(id, arrivals);
      arrivals += 1;
    } else {
      order.set(id, 0);
    }
  }

  previous.current = new Set(ids);
  return order;
}
