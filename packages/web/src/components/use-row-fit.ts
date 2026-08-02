import { useLayoutEffect, useRef, useState } from "react";

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
  const rowRef = useRef<HTMLDivElement>(null);
  const [marginLeft, setMarginLeft] = useState(gapPx);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;

    function recompute() {
      const row = rowRef.current;
      const firstItem = row?.firstElementChild as HTMLElement | null | undefined;
      if (!row || !firstItem) return;

      const containerWidth = row.clientWidth;
      // getBoundingClientRect, not offsetWidth: offsetWidth is rounded to whole
      // pixels and these are sized in container units, so the real width is
      // fractional. Rounding up half a pixel per card made the fit under-reserve.
      const rect = firstItem.getBoundingClientRect();
      const itemWidth = rect.width;
      if (count <= 1 || itemWidth === 0) {
        setMarginLeft(gapPx);
        return;
      }

      // A TAPPED item is rotated 90deg, so it lies on its side and takes its HEIGHT
      // across instead of its width. Reserving that difference is what lets a tapped
      // card stay full size: the alternative is scaling it down to fit its upright
      // slot, which made spent runes visibly smaller than every other card.
      const rotatedExtra = Math.max(0, rotatedCount * (rect.height - itemWidth));

      const naturalTotal = count * itemWidth + rotatedExtra + (count - 1) * gapPx;
      if (naturalTotal <= containerWidth) {
        setMarginLeft(gapPx);
        return;
      }
      setMarginLeft((containerWidth - count * itemWidth - rotatedExtra) / (count - 1));
    }

    recompute();
    // The row's width changes with the window, and an item's width changes with
    // the row's HEIGHT (they are sized in container units), so both are observed.
    const observer = new ResizeObserver(recompute);
    observer.observe(row);
    const firstItem = row.firstElementChild;
    if (firstItem) observer.observe(firstItem);
    return () => observer.disconnect();
  }, [count, gapPx, rotatedCount]);

  return { rowRef, marginLeft };
}

/** Comfortable spacing while a row still has room to spare. */
export const DEFAULT_ROW_GAP_PX = 14;
