import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { READOUT, TAP } from "../motion.js";

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

/**
 * A compact pip row (1..threshold), filled up to current points — a lighter-weight
 * nod to a dedicated score track, without committing to a full sidebar layout
 * (which would eat into the width battlefields/cards get, working against the
 * "fit the window" fix).
 *
 * # Scoring is the most important moment in the game, and it used to be silent
 *
 * A pip simply gained a `filled` class between renders. The single event the
 * whole game is played to reach had less feedback than hovering a card.
 *
 * The pips that are NEWLY filled now pop — the same `TAP` overshoot a card's
 * exhaust uses, because both are "a discrete thing just flipped" — and the rest
 * are left alone. Animating every filled pip on every render would say "the score
 * changed" every time React re-rendered for an unrelated reason, which is worse
 * than saying nothing: it would train the player to ignore it.
 *
 * **Which pips are new is recovered by DIFFING**, like everything else on this
 * board (see `use-zone-flights.ts` for why: the engine reports state, not events).
 * Here that is exact rather than a guess — a pip index either was filled last
 * render or was not, and there is no other way for it to have changed.
 *
 * **Points can go DOWN** (Tianna Crownguard blocks a gain; some effects remove
 * one), so `justFilled` is a set of indices rather than a high-water mark, and an
 * un-filling pip animates nothing. A loss is not a moment to celebrate.
 */
export function PointTracker({ points, threshold }: PointTrackerProps) {
  const reduced = useReducedMotion() ?? false;
  const previous = useRef(points);
  const [justFilled, setJustFilled] = useState<ReadonlySet<number>>(new Set());

  useEffect(() => {
    const before = previous.current;
    previous.current = points;
    if (points <= before) return;
    const gained = new Set<number>();
    for (let i = before; i < points; i += 1) gained.add(i);
    setJustFilled(gained);
    // Cleared on a timer so a pip pops once and then rests. Without this the set
    // would still name those indices on the next unrelated render and they would
    // re-animate — the exact "cried wolf" failure the doc comment above is about.
    const timer = setTimeout(() => setJustFilled(new Set()), 600);
    return () => clearTimeout(timer);
  }, [points]);

  const pips = Array.from({ length: threshold }, (_, i) => i < points);
  return (
    <span className="point-tracker">
      {pips.map((filled, i) => (
        <motion.span
          key={i}
          className={`point-pip${filled ? " filled" : ""}`}
          // `animate` rather than a variant so a resting pip is genuinely static:
          // it is handed its own current values and nothing interpolates.
          animate={justFilled.has(i) && !reduced ? { scale: [1, 1.55, 1] } : { scale: 1 }}
          transition={justFilled.has(i) ? TAP : READOUT}
        />
      ))}
    </span>
  );
}
