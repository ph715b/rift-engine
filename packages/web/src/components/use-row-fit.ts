import { useCallback, useLayoutEffect, useRef, useState } from "react";

/**
 * An element's own LAYOUT (border-box) size, reconstructed from computed style.
 *
 * Deliberately NOT `getBoundingClientRect()`, which is what this used to call and
 * which reports the TRANSFORMED box. Every card is a Framer Motion `motion.div`
 * carrying `layout` + `layoutId`, so a card that persists from the mulligan screen
 * into the board's hand is animated from its old ~250px box down to its real ~48px
 * one with a transform. A fit computed during that window is sized for a card five
 * times too wide: measured at 1024x700, the margin latched at -143px and four of
 * five hand cards rendered off the LEFT edge of the board entirely.
 *
 * It never corrected itself, either — `ResizeObserver` reports layout size, so a
 * transform settling back to identity fires nothing, and the row's own dependencies
 * do not change until the card count does.
 *
 * `offsetWidth` is the other transform-free option and was rejected before for a
 * real reason: it rounds to whole pixels, and these are sized in container units,
 * so rounding up half a pixel per card made the fit under-reserve. Computed style
 * keeps the fraction. It resolves `width` to the CONTENT box whatever `box-sizing`
 * says, so padding and border are added back to land on the border-box figure
 * `getBoundingClientRect()` returned in the healthy case — this is a no-op when
 * nothing is transformed, which is the point: it removes the contamination without
 * changing the arithmetic.
 *
 * The same applies to the height, which feeds the rotated-card reservation below:
 * a TAPPED tile is `rotate(90deg)`, so its client rect reports its height as its
 * width, and a row whose first tile was spent measured its own item width wrong.
 */
function layoutSize(el: HTMLElement): { width: number; height: number } {
  const cs = getComputedStyle(el);
  const sum = (...values: string[]) => values.reduce((total, v) => total + (parseFloat(v) || 0), 0);
  return {
    width: sum(cs.width, cs.paddingLeft, cs.paddingRight, cs.borderLeftWidth, cs.borderRightWidth),
    height: sum(cs.height, cs.paddingTop, cs.paddingBottom, cs.borderTopWidth, cs.borderBottomWidth),
  };
}

/**
 * Fits a single row of same-width cards into whatever width it actually has, by
 * fanning them with a computed overlap.
 *
 * Extracted from RuneZone, which had this logic inline and is now one of four
 * callers. The others are the AI base, your base and your hand — every row that
 * used to wrap onto a second line and grow a scrollbar.
 *
 * A CSS-only version was tried first and cannot work: the overlap has to be a
 * function of the CONTAINER's width, which CSS can express only as a percentage of
 * that width, while what needs scaling is a count of fixed-width cards. Tuning a
 * constant per breakpoint just relocates the spill — measured at 95-162px past the
 * zone's border at four different viewport sizes before this replaced it.
 *
 * The returned margin is the ONLY spacing between items: callers must not also set
 * a flex `gap`, which survives a negative margin and is re-added once per adjacent
 * pair (~194px across a 12-card hand, enough to breach the border on its own).
 *
 * There is deliberately no floor on how negative the offset gets. An earlier
 * version clamped the overlap so a sliver of every card stayed visible, but hitting
 * that clamp at a high count in a narrow row meant the total exceeded the container
 * and spilled past the zone's border — a real breach, caught visually. Fitting
 * exactly, however much overlap that takes, is what actually guarantees no breach.
 */
// Return type left to inference: annotating the ref widened it to
// `RefObject<HTMLDivElement | null>`, which this React version's `ref` prop does
// not accept.
export function useRowFit(count: number, gapPx = DEFAULT_ROW_GAP_PX, rotatedCount = 0) {
  // A CALLBACK ref, for the reason `use-board-card-size.ts` already documents at
  // length: the board is not mounted for this component's whole life (the pregame
  // renders instead), so an effect keyed only on the counts never re-runs once the
  // row finally appears, and the row goes unobserved until something unrelated
  // changes the card count.
  const [row, setRow] = useState<HTMLDivElement | null>(null);
  const rowRef = useCallback((node: HTMLDivElement | null) => setRow(node), []);
  const [marginLeft, setMarginLeft] = useState(gapPx);
  // The child currently under observation, so a re-rendered list re-binds rather
  // than leaving the observer watching a detached node.
  const observedChild = useRef<Element | null>(null);

  useLayoutEffect(() => {
    if (!row) return;
    observedChild.current = null;
    const observer = new ResizeObserver(() => recompute());

    function recompute() {
      const firstItem = row?.firstElementChild as HTMLElement | null | undefined;
      if (!row || !firstItem) return;

      if (firstItem !== observedChild.current) {
        if (observedChild.current) observer.unobserve(observedChild.current);
        observer.observe(firstItem);
        observedChild.current = firstItem;
      }

      const containerWidth = row.clientWidth;
      const { width: itemWidth, height: itemHeight } = layoutSize(firstItem);
      if (count <= 1 || itemWidth === 0) {
        setMarginLeft(gapPx);
        return;
      }

      // A TAPPED item is rotated 90deg, so it lies on its side and takes its HEIGHT
      // across instead of its width. Reserving that difference is what lets a tapped
      // card stay full size: the alternative is scaling it down to fit its upright
      // slot, which made spent runes visibly smaller than every other card.
      const rotatedExtra = Math.max(0, rotatedCount * (itemHeight - itemWidth));

      const naturalTotal = count * itemWidth + rotatedExtra + (count - 1) * gapPx;
      if (naturalTotal <= containerWidth) {
        setMarginLeft(gapPx);
        return;
      }
      setMarginLeft((containerWidth - count * itemWidth - rotatedExtra) / (count - 1));
    }

    recompute();
    // The row's width changes with the window, and an item's width changes with
    // the row's HEIGHT (they are sized in container units), so both are observed —
    // the child via `recompute` above, which re-binds whenever it is replaced.
    observer.observe(row);
    return () => observer.disconnect();
  }, [row, count, gapPx, rotatedCount]);

  return { rowRef, marginLeft };
}

/** Comfortable spacing while a row still has room to spare. */
export const DEFAULT_ROW_GAP_PX = 14;
