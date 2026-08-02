import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

/**
 * The four hidden//discard zones as actual PILES, replacing four lines of text.
 *
 * A count alone tells you the size of a zone but never that it CHANGED, and every
 * one of these changes as a consequence of something else — a draw, a recycle, a
 * unit dying. Those are the moments a player needs to notice without reading, which
 * is what the flying card is for: it says WHICH zone moved and in WHICH direction.
 *
 * Deliberately not clickable except for the trash, which is the only one of the
 * four that is public information (its browser already existed).
 */

export type PileKind = "deck" | "rune" | "trash" | "banished";

interface ZonePileProps {
  kind: PileKind;
  label: string;
  count: number;
  title: string;
  onClick?: (() => void) | undefined;
}

/** How many card backs to draw in the stack. Purely cosmetic depth — a 40-card
 *  deck and a 4-card one differ by their COUNT, which is printed, not by drawing
 *  forty overlapping rectangles. */
function stackDepth(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  return count < 6 ? 2 : 3;
}

function ZonePile({ kind, label, count, title, onClick }: ZonePileProps) {
  // The animation is driven by the DELTA, so it needs the previous count. A ref
  // rather than state: it must not itself cause a render, or every count change
  // would render twice.
  const previous = useRef(count);
  const [flight, setFlight] = useState<{ id: number; direction: "in" | "out" } | null>(null);
  const flightId = useRef(0);

  useEffect(() => {
    const delta = count - previous.current;
    previous.current = count;
    if (delta === 0) return;
    flightId.current += 1;
    // Leaving a pile (a draw, a rune channelled) flies OUT; arriving (a trash, a
    // recycle) flies IN. One card per change however many moved: this is a cue,
    // not a count, and four cards racing for the same 40px would read as noise.
    setFlight({ id: flightId.current, direction: delta < 0 ? "out" : "in" });
  }, [count]);

  const depth = stackDepth(count);
  const Wrapper = onClick ? "button" : "div";

  return (
    <Wrapper
      className={`zone-pile zone-pile-${kind}${onClick ? " zone-pile-clickable" : ""}`}
      title={title}
      {...(onClick ? { onClick, type: "button" as const } : {})}
    >
      <span className="zone-pile-stack">
        {depth === 0 ? (
          <span className="zone-pile-empty" aria-hidden />
        ) : (
          Array.from({ length: depth }, (_, i) => (
            <span key={i} className="zone-pile-card" style={{ transform: `translate(${i * 2}px, ${i * -2}px)` }} aria-hidden />
          ))
        )}
        <AnimatePresence>
          {flight && (
            <motion.span
              key={flight.id}
              className="zone-pile-flight"
              aria-hidden
              initial={flight.direction === "out" ? { opacity: 0.9, y: 0, scale: 1 } : { opacity: 0, y: -22, scale: 0.8 }}
              animate={flight.direction === "out" ? { opacity: 0, y: -22, scale: 0.8 } : { opacity: 0.9, y: 0, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.34, ease: "easeOut" }}
              onAnimationComplete={() => setFlight(null)}
            />
          )}
        </AnimatePresence>
      </span>
      <span className="zone-pile-label">{label}</span>
      <span className="zone-pile-count">{count}</span>
    </Wrapper>
  );
}

interface ZonePilesProps {
  deckCount: number;
  runeDeckCount: number;
  trashCount: number;
  banishedCount: number;
  gearCount: number;
  /** Only ever supplied for a non-empty trash — it is the one public pile. */
  onViewTrash?: (() => void) | undefined;
}

export function ZonePiles({ deckCount, runeDeckCount, trashCount, banishedCount, gearCount, onViewTrash }: ZonePilesProps) {
  return (
    <div className="zone-piles">
      <ZonePile kind="deck" label="Deck" count={deckCount} title="Cards remaining in your main deck" />
      <ZonePile kind="rune" label="Runes" count={runeDeckCount} title="Runes remaining in the rune deck" />
      <ZonePile
        kind="trash"
        label="Trash"
        count={trashCount}
        title={trashCount > 0 ? "View this trash pile (public information)" : "Trash"}
        onClick={trashCount > 0 ? onViewTrash : undefined}
      />
      <ZonePile kind="banished" label="Banished" count={banishedCount} title="Banished" />
      {/* Gear stays a line of text: it is not a pile, it is permanents in play, and
          drawing it as one would say the opposite of where those cards are. */}
      <span className="zone-piles-gear" title="Gear in play, unattached">
        Gear: {gearCount}
      </span>
    </div>
  );
}
