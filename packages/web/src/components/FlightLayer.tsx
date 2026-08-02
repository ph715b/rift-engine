import { motion } from "framer-motion";
import { FLIGHT_MS, type ZoneFlight } from "./use-zone-flights.js";

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
  if (flights.length === 0) return null;
  return (
    <div className="flight-layer" aria-hidden>
      {flights.map((f) => (
        <motion.span
          key={f.id}
          className={`flight-card${f.hidden ? " flight-card-hidden" : ""}`}
          data-from={f.fromAnchor}
          data-to={f.toAnchor}
          initial={{ x: f.from.x, y: f.from.y, opacity: 0, scale: 0.6 }}
          animate={{
            x: f.to.x,
            y: f.to.y,
            // Fades up and back down rather than holding full opacity: the card
            // is a gesture toward where something went, not an object the player
            // should try to read mid-flight.
            opacity: [0, 1, 1, 0],
            scale: [0.6, 1, 1, 0.7],
          }}
          transition={{ duration: FLIGHT_MS / 1000, ease: "easeInOut", times: [0, 0.18, 0.72, 1] }}
        />
      ))}
    </div>
  );
}
