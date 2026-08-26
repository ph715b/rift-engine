import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { PlayAnnouncement } from "../event-log.js";
import { CardView } from "./CardView.js";
import { INSTANT } from "../motion.js";

/**
 * **Holds up the card the opponent just played.**
 *
 * The AI's turn arrives as a board that has silently changed. A unit is simply
 * THERE, and a spell is never seen at all — it resolves and goes to the trash
 * between two renders, so the only trace is whatever it did. Working out what
 * happened meant reading the log, and a player should not have to open a panel to
 * find out what was just played at them.
 *
 * This is the piece of MTG Arena's presentation that carries the most: the card
 * comes forward, large enough to read, and gets out of the way again.
 *
 * # It must not block the board
 *
 * `pointer-events: none` throughout, and it clears itself on a timer. The AI acts
 * every `AI_MOVE_DELAY_MS`, so an announcement that outstayed its welcome would
 * still be up when the next one arrived — the caller replaces rather than queues,
 * for the same reason the header narration does.
 *
 * # Reduced motion gets the card, not the movement
 *
 * The information — WHICH card — is the point, and it is exactly as useful
 * without the flourish. So the card still appears; it simply does not fly.
 */
export function PlayAnnouncer({ announcement }: { announcement: PlayAnnouncement | null }) {
  const reduced = useReducedMotion() ?? false;

  return (
    <AnimatePresence>
      {announcement && (
        <motion.div
          key={announcement.card.instanceId}
          className="play-announcer"
          aria-hidden
          initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.7, y: 34 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
          // Leaves UPWARD and shrinking, towards the board it is about to affect —
          // the opposite of the way it arrived, so the gesture reads as one motion
          // rather than as a panel opening and closing.
          exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.86, y: -22 }}
          transition={
            reduced
              ? INSTANT
              : { type: "spring", stiffness: 260, damping: 22, mass: 0.9, exit: { duration: 0.28 } }
          }
        >
          {/* The scale lives on an INNER element on purpose. framer-motion writes
              `transform` on the node it animates, so anything this file also put
              there — a centring `translate(-50%, -50%)`, a fixed scale — would be
              overwritten the moment the animation ran, silently. The wrapper is
              centred by grid instead, and owns nothing framer touches. */}
          <div className="play-announcer-card">
            <CardView card={announcement.card} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
