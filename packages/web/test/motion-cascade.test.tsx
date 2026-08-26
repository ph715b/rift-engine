import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { STAGGER_S, staggerDelay } from "../src/motion.js";
import { useArrivalOrder } from "../src/components/use-arrival-order.js";

/**
 * **The arrival cascade's DECISIONS, not its pixels.**
 *
 * Animation is mostly not worth testing — an assertion that a transform exists
 * proves nothing about whether the board feels right, and this repo has shipped
 * vacuous DOM-presence tests before. What IS worth testing is the logic that
 * decides *whether and how much* to cascade, because every one of its rules
 * exists to prevent a specific bad behaviour and all of them fail silently:
 *
 * - Cascade on first render → every page load looks like a dramatic entrance.
 * - Cascade by row index → the card you just played is the LAST to move.
 * - Cascade uncapped → a large group adds visible dead time before you can act.
 * - Cascade on any re-render → the board ripples whenever React does its job.
 *
 * None of those throws, none of them fails a type check, and none of them looks
 * wrong in a screenshot. They only look wrong in motion, which no test sees.
 *
 * `legal-actions` enumerates 144.3's simultaneous move — one action walking
 * several units to a battlefield — which is what makes a cascade worth having at
 * all, and what makes "several arrived at once" a real case rather than a
 * hypothetical.
 */

describe("staggerDelay", () => {
  it("gives the first item no delay at all", () => {
    // The card you just played is index 0 of its arrival group, and it must move
    // the instant you commit. A delay here would read as input lag, which is the
    // one thing a flourish must never buy.
    expect(staggerDelay(0, false)).toBe(0);
  });

  it("cascades the rest in order", () => {
    expect(staggerDelay(1, false)).toBeCloseTo(STAGGER_S);
    expect(staggerDelay(2, false)).toBeCloseTo(STAGGER_S * 2);
  });

  it("CAPS, so a large group never adds visible dead time", () => {
    // Without the cap a ten-unit arrival would delay its last card by nearly half
    // a second past the state change. The cap is eight items' worth.
    const capped = staggerDelay(8, false);
    expect(staggerDelay(20, false)).toBe(capped);
    expect(staggerDelay(200, false)).toBe(capped);
    // ...and the cap is short enough to stay a flourish.
    expect(capped).toBeLessThan(0.4);
  });

  it("is zero under reduced motion, at every index", () => {
    for (const i of [0, 1, 5, 50]) expect(staggerDelay(i, true)).toBe(0);
  });
});

describe("useArrivalOrder", () => {
  it("treats the FIRST render as no arrivals — a board mount is not an entrance", () => {
    // Everything is "new" when a board mounts. Cascading it would make every page
    // load, and every remount, look like a dramatic entrance.
    const { result } = renderHook(({ ids }) => useArrivalOrder(ids), {
      initialProps: { ids: ["a", "b", "c"] },
    });
    expect([...result.current.values()]).toEqual([0, 0, 0]);
  });

  it("cascades only the cards that ARRIVED, numbering them from zero", () => {
    const { result, rerender } = renderHook(({ ids }) => useArrivalOrder(ids), {
      initialProps: { ids: ["a"] },
    });
    rerender({ ids: ["a", "b", "c"] });

    // `a` was already standing and keeps its own pace; `b` and `c` cascade
    // among THEMSELVES, so the first arrival is 0 rather than inheriting the
    // row position it happens to occupy.
    expect(result.current.get("a")).toBe(0);
    expect(result.current.get("b")).toBe(0);
    expect(result.current.get("c")).toBe(1);
  });

  it("numbers arrivals by arrival, NOT by position in the row", () => {
    // The distinction the whole hook exists for. If this returned the row index,
    // a unit appended to a row of four would be delayed four steps — the slowest
    // thing on screen would be the one the player is waiting for.
    const { result, rerender } = renderHook(({ ids }) => useArrivalOrder(ids), {
      initialProps: { ids: ["w", "x", "y", "z"] },
    });
    rerender({ ids: ["w", "x", "y", "z", "new"] });

    expect(result.current.get("new"), "the newcomer inherited its row index").toBe(0);
  });

  it("cascades NOTHING on a re-render that changed no ids", () => {
    // A hover, a resize, an unrelated prop change. Without this the board would
    // ripple every time React re-rendered it.
    const { result, rerender } = renderHook(({ ids }) => useArrivalOrder(ids), {
      initialProps: { ids: ["a", "b"] },
    });
    rerender({ ids: ["a", "b"] });
    rerender({ ids: ["a", "b"] });

    expect([...result.current.values()]).toEqual([0, 0]);
  });

  it("a card LEAVING is not an arrival for the survivors", () => {
    // A unit dying re-renders the row with one fewer id. The remaining cards did
    // not arrive and must not re-animate — their `layout` reflow is the motion
    // that belongs to that moment.
    const { result, rerender } = renderHook(({ ids }) => useArrivalOrder(ids), {
      initialProps: { ids: ["a", "b", "c"] },
    });
    rerender({ ids: ["a", "c"] });

    expect([...result.current.values()]).toEqual([0, 0]);
  });

  it("a card that comes BACK counts as a new arrival", () => {
    // Recalled to base and played again is a genuine second entrance, and the
    // set-difference gives that for free. Asserted so it is a decision rather
    // than an accident of the implementation.
    const { result, rerender } = renderHook(({ ids }) => useArrivalOrder(ids), {
      initialProps: { ids: ["a", "b"] },
    });
    rerender({ ids: ["a"] });
    rerender({ ids: ["a", "b"] });

    expect(result.current.get("b")).toBe(0);
  });
});
