// The one board measurement: shared card size, every row's height, and the
// invariant that matters — scrollableRows === 0 at every viewport size.
//
// Selector lists deliberately INCLUDE the not-yet-existing `.hand-fan` /
// `.ai-hand-fan`. A driver that only knows the old selectors reports green about
// an element it never looked at, which is how this project's instruments have
// lied before.
import { chromium, sleep, bootToBoard, step, SIZES, OUT } from "./lib.mjs";

const ROWS = ".battlefield-side, .card-row.fitted, .rune-row, .hand-fan-layer, .ai-hand-fan";
const CARDS = ".battlefield-side .card, .card-row.fitted .card, .rune-tile, .hand-fan-layer .card, .ai-hand-fan .hand-back";

const only = process.argv[2] ? [[Number(process.argv[2]), Number(process.argv[3])]] : SIZES;
const STEPS = Number(process.env.STEPS ?? 90);
const SHOT = process.env.SHOT;

const b = await chromium.launch({ headless: true });
let bad = 0;

for (const [W, H] of only) {
  const p = await b.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await bootToBoard(p);

  let scrollableStates = 0;
  let hBreachStates = 0;
  let worstPx = 0;
  let worstWho = "";
  let maxItems = 0;
  let clippedStates = 0;
  let clippedWho = "";

  for (let s = 0; s < STEPS; s++) {
    const r = await p.evaluate(
      ({ ROWS, CARDS }) => {
        let sc = 0, br = 0, w = 0, who = "", mn = 0;
        for (const row of document.querySelectorAll(ROWS)) {
          if (!row.children.length) continue;
          mn = Math.max(mn, row.children.length);
          const cs = getComputedStyle(row);
          if (/auto|scroll/.test(cs.overflowX + cs.overflowY)) sc++;
          const over = row.scrollWidth - row.clientWidth;
          if (over > 1) {
            br++;
            if (over > w) { w = over; who = row.className.split(" ")[0] + ":" + row.children.length; }
          }
        }
        // Is any card CLIPPED by the board's overflow:hidden? This is the check
        // that the reverted attempt needed and did not have: a fan tucked under
        // an edge with a negative offset is cut off, not peeking.
        //
        // What is measured is the card's VISIBLE region, not its layout box. A
        // hand card at rest is deliberately clipped by its own slot (that is what
        // the collapsed peek IS), so its box extends far below the board while
        // nothing improper is on screen. Intersecting with the slot first is what
        // separates "the fan is collapsed" from "the board cut a card in half".
        //
        // This check was previously keyed on a `.yielded` class that a later
        // rename removed, so it silently stopped excluding anything and reported
        // 80-90 clipped states about a board that was fine.
        const board = document.querySelector(".board");
        let clipped = 0, cwho = "";
        if (board) {
          const bb = board.getBoundingClientRect();
          for (const c of document.querySelectorAll(CARDS)) {
            let cb = c.getBoundingClientRect();
            if (cb.width === 0 && cb.height === 0) continue;
            const slot = c.closest(".hand-fan-slot");
            if (slot) {
              const sb = slot.getBoundingClientRect();
              const top = Math.max(cb.top, sb.top), bottom = Math.min(cb.bottom, sb.bottom);
              const left = Math.max(cb.left, sb.left), right = Math.min(cb.right, sb.right);
              if (bottom <= top || right <= left) continue;
              cb = { top, bottom, left, right };
            }
            const hiddenPx = Math.max(0, bb.top - cb.top) + Math.max(0, cb.bottom - bb.bottom)
                           + Math.max(0, bb.left - cb.left) + Math.max(0, cb.right - bb.right);
            if (hiddenPx > 2) { clipped++; if (!cwho) cwho = c.className.split(" ")[0] + "+" + Math.round(hiddenPx) + "px"; }
          }
        }
        return { sc, br, w, who, mn, clipped, cwho };
      },
      { ROWS, CARDS },
    );
    if (r.sc) scrollableStates++;
    if (r.br) { hBreachStates++; if (r.w > worstPx) { worstPx = r.w; worstWho = r.who; } }
    if (r.clipped) { clippedStates++; if (!clippedWho) clippedWho = r.cwho; }
    maxItems = Math.max(maxItems, r.mn);
    if (SHOT && s === Number(SHOT)) await p.screenshot({ path: `${OUT}/board-${W}x${H}.png` });
    if (!(await step(p))) break;
  }

  const sizes = await p.evaluate(
    ({ ROWS }) => {
      const px = (e, prop) => Math.round(parseFloat(getComputedStyle(e)[prop]));
      const one = (sel) => { const e = document.querySelector(sel); return e ? px(e, "height") : null; };
      const bm = document.querySelector(".board-main");
      const cs = bm ? getComputedStyle(bm) : null;
      return {
        sharedH: cs ? cs.getPropertyValue("--board-card-h").trim() : "(none)",
        battlefield: one(".battlefield-side .card"),
        base: one(".base-and-runes .card-row.fitted .card"),
        handRow: one(".hand-zone .card-row.fitted .card"),
        handFan: one(".hand-fan-layer .card"),
        rune: one(".rune-tile"),
        rows: [...document.querySelectorAll(ROWS)].map((e) => e.className.split(" ").slice(0, 2).join(".") + "=" + e.clientHeight),
      };
    },
    { ROWS },
  );

  // `hBreach` is REPORTED but does not fail the run. scrollWidth counts
  // transformed descendants, so Framer Motion's exit transforms and the 90deg
  // rotation on a tapped card inflate it — a single-child row has reported a
  // 106px "breach" that was pure paint. `scrollableRows` is the invariant.
  const ok = scrollableStates === 0 && clippedStates === 0;
  if (!ok) bad++;
  console.log(
    `${String(W + "x" + H).padEnd(9)} shared=${String(sizes.sharedH).padEnd(7)} bf=${sizes.battlefield} base=${sizes.base} ` +
      `hand=${sizes.handRow ?? sizes.handFan} rune=${sizes.rune} | scrollableRows=${scrollableStates} ` +
      `hBreach=${hBreachStates}${worstPx ? ` (worst ${worstPx}px ${worstWho})` : ""} clipped=${clippedStates}${clippedWho ? ` (${clippedWho})` : ""} ` +
      `maxItems=${maxItems} ${ok ? "OK" : "FAIL"}${errors.length ? " PAGEERR:" + errors[0] : ""}`,
  );
  console.log("          rows: " + sizes.rows.join("  "));
  await p.close();
}

await b.close();
process.exit(bad === 0 ? 0 : 1);
