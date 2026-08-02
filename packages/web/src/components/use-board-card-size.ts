import { useCallback, useRef, useState, type CSSProperties } from "react";

/** Fraction of its row a card occupies, leaving room for the badges that sit
 *  slightly proud of a card's box. At an exact fit those alone reintroduce a
 *  scrollbar. */
const ROW_FILL = 0.88;

/** The real cards' aspect ratio (744x1039). Exported so anything deriving a
 *  width from the measured height uses this one number rather than repeating
 *  0.716 and drifting from it. */
export const CARD_ASPECT_RATIO = 0.716;

/**
 * ONE card size for the whole board, derived from the TIGHTEST row.
 *
 * Every board row sizes its cards to fit itself, which is what stops any of them
 * scrolling — but done per row it also made every zone a different size (measured
 * at 1600x950: battlefield 74px wide, hand 67px, runes 56px). Cards on a board are
 * the same object and should read as the same object.
 *
 * Equal flex shares do NOT fix it, and that is worth stating because it is the
 * obvious move: the zones carry different chrome. A battlefield spends one name
 * line on TWO unit rows, while the base, rune and hand zones each spend a label and
 * their own padding on one row. Equal boxes therefore still yield unequal rows.
 *
 * So the size is the SHORTEST row on the board, published as a CSS variable every
 * board row then uses. Anything that fits the tightest row fits everywhere.
 *
 * No feedback loop: row heights come from the flex layout with `min-height: 0` and
 * a zero basis, so they do not depend on the size of the cards inside them.
 */
export function useBoardCardSize() {
  const [cardHeight, setCardHeight] = useState<number | null>(null);
  const cleanup = useRef<(() => void) | null>(null);

  /**
   * A CALLBACK ref, not `useRef` + `useLayoutEffect([])`. The board is not mounted
   * for the whole life of this component — the pregame (battlefield select,
   * mulligan) renders instead — so an effect that reads the ref once on mount finds
   * nothing, returns, and with an empty dependency list never runs again. The
   * measurement then stays null forever and every row silently falls back to sizing
   * itself, which is the very inconsistency this exists to remove.
   */
  const boardRef = useCallback((board: HTMLDivElement | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!board) return;

    let observed: Element[] = [];
    const observer = new ResizeObserver(() => measure());

    function measure() {
      // EVERY row the size applies to, and the SHORTEST of them wins. Measuring one
      // representative row is not enough: a battlefield holding facedown cards
      // gives that row up to its hidden-card strip, so its unit rows are shorter
      // than another battlefield's. Sizing off the first row put 18 cards taller
      // than the row containing them.
      const rows = [...board!.querySelectorAll(".battlefield-side, .card-row.fitted, .rune-row")].filter(
        (el): el is HTMLElement => el instanceof HTMLElement,
      );
      if (rows.length === 0) return;

      if (rows.length !== observed.length || rows.some((row, i) => row !== observed[i])) {
        // Rows are re-rendered as the game goes on, so what is being measured can
        // be replaced underneath us.
        for (const old of observed) observer.unobserve(old);
        observed = rows;
        for (const row of rows) observer.observe(row);
      }

      const shortest = Math.min(...rows.map((row) => row.clientHeight));
      const next = Math.max(0, Math.round(shortest * ROW_FILL));
      if (next > 0) setCardHeight((prev) => (prev === next ? prev : next));
    }

    measure();
    observer.observe(board);
    cleanup.current = () => observer.disconnect();
  }, []);

  const style =
    cardHeight === null
      ? undefined
      : ({
          "--board-card-h": `${cardHeight}px`,
          "--board-card-w": `${Math.round(cardHeight * CARD_ASPECT_RATIO)}px`,
        } as CSSProperties);

  // `cardHeight` is returned as well as the CSS variables because the hand fan's
  // overlap is computed in JS (useRowFit takes a pixel gap), and it has to be
  // derived from the same measurement the cards are sized from — a second
  // constant would drift the moment the board's size changed.
  return { boardRef, style, cardHeight };
}
