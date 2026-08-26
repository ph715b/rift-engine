import { useEffect, useRef, useState } from "react";

/**
 * Cards that actually TRAVEL between zones — deck to hand on a draw, hand to
 * trash on a discard, the rune zone to the rune deck on a recycle.
 *
 * The piles used to announce a change by pulsing in place, which says THAT a zone
 * moved but never where the card went. That was the honest limit of the old
 * layout: the deck and trash lived in a side rail and the hand was a row on the
 * other side of the board, so there was no shared space to draw a path through.
 * Both endpoints are on the board now, which is what makes this possible at all.
 *
 * Driven by DIFFING zone counts between renders, in the same spirit as
 * `prevChainTopRef` in GameBoard: the engine reports state, not events, so "what
 * just happened" has to be recovered by comparing snapshots.
 *
 * Endpoints are resolved by querying `[data-flight-anchor]` at the moment a
 * flight starts, rather than through a ref registry. That keeps every endpoint
 * discovered the same way and — more importantly — reads the position the element
 * has RIGHT NOW, which matters because the hand fan moves as it fans and the
 * whole board resizes with the window.
 */

/** Where a flight can start or end. Must match the `data-flight-anchor`
 *  attributes rendered by BoardPiles and the board itself. */
export type FlightAnchor = "deck" | "runeDeck" | "trash" | "banished" | "hand" | "runes" | "board";

export interface ZoneFlight {
  id: number;
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** The endpoint NAMES as well as their positions. Rendered onto the element as
   *  data attributes: a flight is a transient thing that appears for 460ms in
   *  response to a state change, so without a label on it there is no way to
   *  check that a draw drew from the DECK rather than merely that something
   *  moved. */
  fromAnchor: FlightAnchor;
  toAnchor: FlightAnchor;
  /** Drawn face-down for hidden origins (your deck, the rune deck) and face-up
   *  tinted for public ones — a card going to the trash is information, a card
   *  coming off the deck is not. */
  hidden: boolean;
  /**
   * How long THIS flight takes, in ms — scaled by the distance it covers.
   *
   * Every flight used to take `FLIGHT_MS` regardless, so a short hop from the
   * deck to the hand beside it and a long throw across the board to the trash
   * moved at wildly different speeds to cover wildly different distances in the
   * same time. Two objects on one table cannot have two different physics.
   *
   * Scaled rather than made constant-SPEED: true constant speed makes a
   * cross-board flight take long enough to gate the next click, which is the
   * failure `FLIGHT_MS`' own note warns about. The square root is the usual
   * compromise — longer trips take longer, but sub-linearly.
   */
  ms: number;
  /**
   * Peak height of the arc, in px, perpendicular to the path.
   *
   * A card slid across a table travels in a straight line; a card THROWN lifts.
   * These are throws — a discard, a draw — and a dead-straight interpolation is
   * the single thing that most reads as "an element was tweened between two
   * rectangles" rather than as an object moving.
   *
   * Proportional to distance and capped, so a short hop stays nearly flat.
   */
  lift: number;
}

/** The zone sizes a flight can be inferred from. */
export interface ZoneCounts {
  deck: number;
  hand: number;
  trash: number;
  banished: number;
  runeDeck: number;
  channeled: number;
}

/** One card per change, however many moved. This is a cue, not a count — four
 *  cards racing along the same path would read as noise, and the pile's own
 *  number is what actually reports the size. */
const MAX_PER_EVENT = 1;

/** Long enough to follow with the eye, short enough not to gate the next click.
 *  Roughly the chain-resolution beat, so the board keeps one rhythm.
 *
 *  **Now the CEILING rather than the duration of every flight** — see
 *  `ZoneFlight.ms`. Still what the cleanup timer waits on, so the longest
 *  possible flight is always cleared. */
export const FLIGHT_MS = 460;

/** The shortest a flight may be, however close its endpoints. Below this a
 *  flight reads as a flicker rather than as a card going somewhere. */
const FLIGHT_MIN_MS = 240;

/** The distance, in px, at which a flight takes the full `FLIGHT_MS`. Roughly a
 *  board's width — the longest trip anything actually makes. */
const FLIGHT_FULL_DISTANCE = 900;

/** Arc height as a fraction of distance travelled, and its ceiling in px. A
 *  gentle lift; enough to read as a throw, not enough to look like a lob. */
const LIFT_RATIO = 0.16;
const LIFT_MAX = 90;

/** The duration and arc for one flight, from the distance it covers. */
function flightShape(from: { x: number; y: number }, to: { x: number; y: number }): { ms: number; lift: number } {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const t = Math.min(1, Math.sqrt(distance / FLIGHT_FULL_DISTANCE));
  return {
    ms: Math.round(FLIGHT_MIN_MS + (FLIGHT_MS - FLIGHT_MIN_MS) * t),
    lift: Math.min(LIFT_MAX, distance * LIFT_RATIO),
  };
}

function anchorPoint(anchor: FlightAnchor): { x: number; y: number } | null {
  const el =
    anchor === "board"
      ? document.querySelector(".board-center")
      : document.querySelector(`[data-flight-anchor="${anchor}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

export function useZoneFlights(counts: ZoneCounts) {
  const previous = useRef<ZoneCounts | null>(null);
  const nextId = useRef(0);
  const [flights, setFlights] = useState<ZoneFlight[]>([]);

  useEffect(() => {
    const before = previous.current;
    previous.current = counts;
    if (!before) return; // first render establishes the baseline, it is not an event

    const d = {
      deck: counts.deck - before.deck,
      hand: counts.hand - before.hand,
      trash: counts.trash - before.trash,
      banished: counts.banished - before.banished,
      runeDeck: counts.runeDeck - before.runeDeck,
      channeled: counts.channeled - before.channeled,
    };

    const events: Array<{ from: FlightAnchor; to: FlightAnchor; n: number; hidden: boolean }> = [];

    // A draw: the deck shrinks and the hand grows. Tested together rather than on
    // the deck alone, because a card can leave the deck without being drawn (a
    // [Vision] recycle, a mill) and that is not this animation.
    if (d.deck < 0 && d.hand > 0) events.push({ from: "deck", to: "hand", n: Math.min(-d.deck, d.hand), hidden: true });

    // A discard. Ordered before the generic board-to-trash case below so a card
    // leaving your HAND is drawn from the hand, which is where you saw it last.
    if (d.hand < 0 && d.trash > 0) events.push({ from: "hand", to: "trash", n: Math.min(-d.hand, d.trash), hidden: false });
    else if (d.trash > 0) events.push({ from: "board", to: "trash", n: d.trash, hidden: false });

    if (d.banished > 0) events.push({ from: "board", to: "banished", n: d.banished, hidden: false });

    // Channelling takes a rune off the rune deck into your rune zone; recycling
    // sends a channelled rune back. Both are real card movements the player
    // otherwise has to infer from two numbers changing.
    if (d.runeDeck < 0 && d.channeled > 0) events.push({ from: "runeDeck", to: "runes", n: Math.min(-d.runeDeck, d.channeled), hidden: true });
    else if (d.runeDeck > 0 && d.channeled < 0) events.push({ from: "runes", to: "runeDeck", n: Math.min(d.runeDeck, -d.channeled), hidden: false });

    if (events.length === 0) return;

    const added: ZoneFlight[] = [];
    for (const e of events) {
      const from = anchorPoint(e.from);
      const to = anchorPoint(e.to);
      // A missing endpoint means that zone is not on screen right now. Skipping
      // is deliberate: a flight drawn to 0,0 would be worse than no flight.
      if (!from || !to) continue;
      for (let i = 0; i < Math.min(e.n, MAX_PER_EVENT); i++) {
        nextId.current += 1;
        added.push({
          id: nextId.current,
          from,
          to,
          fromAnchor: e.from,
          toAnchor: e.to,
          hidden: e.hidden,
          ...flightShape(from, to),
        });
      }
    }
    if (added.length === 0) return;

    setFlights((current) => [...current, ...added]);
    const ids = new Set(added.map((f) => f.id));
    const timer = setTimeout(() => setFlights((current) => current.filter((f) => !ids.has(f.id))), FLIGHT_MS + 120);
    return () => clearTimeout(timer);
    // Depending on the individual counts rather than the object: it is rebuilt
    // every render, so an object dependency would fire this on every render and
    // diff a snapshot against itself.
  }, [counts.deck, counts.hand, counts.trash, counts.banished, counts.runeDeck, counts.channeled]);

  return flights;
}
