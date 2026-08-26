import { motion, useReducedMotion } from "framer-motion";
import { type ZoneFlight } from "./use-zone-flights.js";

/**
 * Draws the cards currently in flight between zones (see use-zone-flights.ts).
 *
 * Fixed-position and `pointer-events: none`, so it sits over the whole board
 * without being part of any zone's layout and without ever intercepting a click.
 * That matters more than usual here: these appear exactly when the player has
 * just acted and is about to act again, so a flight that ate the next click would
 * be a real regression dressed up as polish.
 */
export function FlightLayer({ flights }: { flights: ZoneFlight[] }) {
  // Hooks before the early return, or the hook order changes with the flight
  // count and React tears the component down.
  const reduced = useReducedMotion() ?? false;
  if (flights.length === 0 || reduced) return null;
  return (
    <div className="flight-layer" aria-hidden>
      {flights.map((f) => (
        <motion.span
          key={f.id}
          className={`flight-card${f.hidden ? " flight-card-hidden" : ""}`}
          data-from={f.fromAnchor}
          data-to={f.toAnchor}
          initial={{ x: f.from.x, y: f.from.y, opacity: 0, scale: 0.6, rotate: 0 }}
          animate={{
            x: f.to.x,
            // **An ARC, not a straight line.** The midpoint is lifted by `f.lift`
            // (see use-zone-flights.ts), so the card rises and falls the way a
            // thrown card does. A dead-straight interpolation between two
            // rectangles is the single thing that most reads as "an element was
            // tweened" rather than as an object moving.
            y: [f.from.y, (f.from.y + f.to.y) / 2 - f.lift, f.to.y],
            // Fades up and back down rather than holding full opacity: the card
            // is a gesture toward where something went, not an object the player
            // should try to read mid-flight.
            opacity: [0, 1, 1, 0],
            scale: [0.6, 1, 1, 0.7],
            // A little spin. Real thrown cards turn; a card that stays perfectly
            // axis-aligned through an arc looks pinned to a rail. Direction
            // follows the travel so it never spins back against its own path.
            rotate: [0, f.to.x >= f.from.x ? 7 : -7, 0],
          }}
          // Per-flight duration, scaled by distance — one physics for the whole
          // board. `times` differs per property because the arc needs three stops
          // and the fade needs four.
          transition={{
            duration: f.ms / 1000,
            ease: "easeInOut",
            opacity: { times: [0, 0.18, 0.72, 1], duration: f.ms / 1000 },
            scale: { times: [0, 0.18, 0.72, 1], duration: f.ms / 1000 },
            y: { times: [0, 0.5, 1], duration: f.ms / 1000, ease: "easeOut" },
          }}
        />
      ))}
    </div>
  );
}
