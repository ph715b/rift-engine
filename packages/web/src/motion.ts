import type { Transition } from "framer-motion";

/**
 * **The board's motion vocabulary — how heavy each kind of movement feels.**
 *
 * Every animated thing on the board used to share ONE spring, `{ type: "spring",
 * stiffness: 400, damping: 32 }`, written inline in `CardView`. It is a good
 * spring and that was the problem: a card being drawn, a unit dying, a unit
 * marching to a battlefield and a rune being tapped all arrived with identical
 * weight and identical timing, so nothing on the board had a physical identity.
 * A real card game reads as a real game largely because a tap is crisp, a march
 * is deliberate, and a death is heavy.
 *
 * These are named for what they DO rather than for their numbers, so a call site
 * says why it moves the way it does and a later reader can retune the feel in one
 * place without hunting inline literals.
 *
 * # Springs, not durations, wherever something is CARRIED
 *
 * A spring's settle depends on the distance it travels, which is what makes a
 * short hop and a cross-board march feel like the same object moving. Durations
 * are used only where the thing is not travelling — a flash, a fade — because
 * there a fixed length is exactly what is wanted.
 *
 * # Reduced motion
 *
 * Nothing here consults `prefers-reduced-motion`; call sites do, through
 * `useReducedMotion()`, and swap in `INSTANT`. Baking the check in here would
 * hide it from the components that also need to skip staggers and flashes, which
 * are not transitions at all.
 */

/** A card TRAVELLING between zones or slots — hand to board, base to battlefield.
 *  Softer and slower than the old global spring: this is the movement the player
 *  is meant to follow with their eyes, and it is the one that reads as a unit
 *  deciding to go somewhere. */
export const TRAVEL: Transition = { type: "spring", stiffness: 260, damping: 30, mass: 0.9 };

/** A TAP — exhausting, readying, a toggle. Stiff and lightly underdamped so it
 *  arrives with a small overshoot, which is the tactile signature of a physical
 *  card being turned. This is the one place overshoot is wanted: everywhere else
 *  it reads as wobble. */
export const TAP: Transition = { type: "spring", stiffness: 700, damping: 22, mass: 0.6 };

/** Something ARRIVING for the first time — drawn, played, created. Slightly
 *  heavier than TRAVEL so an entrance lands rather than snaps. */
export const ARRIVE: Transition = { type: "spring", stiffness: 300, damping: 26, mass: 1 };

/** Something LEAVING play — killed, discarded, banished. A duration rather than
 *  a spring: an exit has no destination to settle at, and a spring's overshoot on
 *  the way out reads as the card changing its mind. */
export const DEPART: Transition = { type: "tween", duration: 0.26, ease: [0.4, 0, 1, 1] };

/** A unit DYING. Slower than `DEPART` and eased so it accelerates away — a
 *  death is the one departure the player is meant to watch, and the extra
 *  200ms is what separates 'destroyed' from 'tidied up'. Paired with a
 *  brightness blow-out in `CardView`, which is the part that reads as damage
 *  rather than as removal. */
export const DIE: Transition = { type: "tween", duration: 0.46, ease: [0.32, 0, 0.67, 0] };

/** A NUMBER changing, or a value flashing — Might, points. Short and linear-ish
 *  so it reads as a readout updating rather than an object moving. */
export const READOUT: Transition = { type: "tween", duration: 0.34, ease: [0.2, 0.8, 0.3, 1] };

/** No motion at all — what every call site substitutes under
 *  `prefers-reduced-motion`. A zero-duration tween rather than `false`, so the
 *  animated properties still apply and only the interpolation is skipped. */
export const INSTANT: Transition = { duration: 0 };

/**
 * Per-item delay for a group that moves together, in seconds.
 *
 * **The engine performs SIMULTANEOUS moves** — 144.3, enumerated by
 * `legal-actions` as one action moving several units — so "three units walk to a
 * battlefield" is one state change and, without this, three cards teleporting in
 * perfect unison. A small cascade is what turns that back into several units
 * arriving.
 *
 * Deliberately small. At 60ms a five-unit move takes a third of a second longer
 * than the move itself, which is the point at which a flourish starts costing the
 * player time; the cap below is what stops a large group from ever crossing it.
 */
export const STAGGER_S = 0.045;

/** The most a stagger may ever add, however large the group. Eight items' worth. */
const STAGGER_CAP_S = STAGGER_S * 8;

/** The delay for item `index` of a group — capped, and zero when motion is
 *  reduced. Call sites pass their own `reduced` rather than reading the media
 *  query here, so one component makes the decision once for its whole subtree. */
export function staggerDelay(index: number, reduced: boolean): number {
  if (reduced || index <= 0) return 0;
  return Math.min(index * STAGGER_S, STAGGER_CAP_S);
}
