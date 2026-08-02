// The board pile cluster: is it fully on the board, does it collide with the
// rail content above it, and is the trash still clickable?
//
// The cluster is absolutely positioned into the lower part of the AI's rail, so
// the two things that can go wrong are geometric: it can overflow the bottom of
// `.board` (which is overflow:hidden, so it would be silently cut off), and it
// can grow up into the AI's Legend/Champion/counts at small viewport heights.
import { chromium, bootToBoard, step, sleep, SIZES } from "./lib.mjs";

const b = await chromium.launch({ headless: true });
let bad = 0;

for (const [W, H] of SIZES) {
  const p = await b.newPage({ viewport: { width: W, height: H } });
  await bootToBoard(p);

  // REGRESS=1 puts the cluster back the way it was built first — absolutely
  // positioned into the corner, blind to the rail content above it. The check
  // must FAIL here; a check that cannot be made to fail has verified nothing.
  if (process.env.REGRESS) {
    await p.addStyleTag({
      content: `.board-piles { position: absolute; left: 0; bottom: 0; width: var(--side-col-w); margin-top: 0; }
                .board-rail { position: relative; }`,
    });
    await sleep(400);
  }

  let worstClip = 0;
  let overlapStates = 0;
  let worstOverlap = 0;
  let trashHitOk = 0, trashHitTried = 0;
  let anchors = 0;
  let maxTrash = 0;

  const STEPS = Number(process.env.STEPS ?? 70);
  for (let s = 0; s < STEPS; s++) {
    // The trash starts empty and stays empty in a purely passive run, so the
    // one interactive pile went untested (0/0). Playing cards is what eventually
    // puts something in it.
    if (process.env.ACTIVE && s % 4 === 2) {
      const card = p.locator(".hand-fan-slot .card.selectable").first();
      if (await card.count()) {
        await card.click().catch(() => {});
        await sleep(260);
        const pay = p.getByRole("button", { name: /Auto Pay/i });
        if (await pay.count()) { await pay.first().click().catch(() => {}); await sleep(300); }
        const cancel = p.getByRole("button", { name: /^Cancel/ });
        if (await cancel.count()) { await cancel.first().click().catch(() => {}); await sleep(200); }
      }
    }
    const r = await p.evaluate(() => {
      const cluster = document.querySelector(".board-piles");
      if (!cluster) return null;
      const board = document.querySelector(".board").getBoundingClientRect();
      const c = cluster.getBoundingClientRect();
      const clip =
        Math.max(0, board.top - c.top) + Math.max(0, c.bottom - board.bottom) +
        Math.max(0, board.left - c.left) + Math.max(0, c.right - board.right);

      // The AI's rail content that sits above the cluster in the same column.
      //
      // Each child's rect is CLAMPED to the rail's own box first. `.side-column`
      // is `overflow-y: auto`, so a child scrolled out of view still reports a
      // rect down where the cluster is while being visually clipped — comparing
      // raw rects reported a fixed 3-52px "overlap" that did not change at all
      // when the layout was restructured to make overlap impossible, which is
      // what gave the measurement away.
      const rail = document.querySelector(".side-column");
      let overlap = 0;
      if (rail) {
        const rb = rail.getBoundingClientRect();
        for (const el of rail.querySelectorAll(".card, .zone-pile, .side-column-header")) {
          const e = el.getBoundingClientRect();
          const top = Math.max(e.top, rb.top);
          const bottom = Math.min(e.bottom, rb.bottom);
          if (bottom <= top) continue; // entirely scrolled out of the rail's view
          const dy = Math.min(bottom, c.bottom) - Math.max(top, c.top);
          const dx = Math.min(e.right, c.right) - Math.max(e.left, c.left);
          if (dy > 1 && dx > 1) overlap = Math.max(overlap, Math.round(dy));
        }
      }

      // Is the trash tile actually the thing a click would hit?
      const trash = cluster.querySelector('[data-flight-anchor="trash"]');
      let trashHit = null;
      if (trash && trash.tagName === "BUTTON") {
        const t = trash.getBoundingClientRect();
        const el = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2);
        trashHit = Boolean(el && trash.contains(el));
      }
      const trashCount = Number(cluster.querySelector('[data-flight-anchor="trash"] .board-pile-count')?.textContent ?? 0);
      return {
        clip: Math.round(clip),
        overlap,
        trashHit,
        trashCount,
        anchors: cluster.querySelectorAll("[data-flight-anchor]").length,
      };
    });
    if (r) {
      worstClip = Math.max(worstClip, r.clip);
      if (r.overlap > 1) { overlapStates++; worstOverlap = Math.max(worstOverlap, r.overlap); }
      if (r.trashHit !== null) { trashHitTried++; if (r.trashHit) trashHitOk++; }
      maxTrash = Math.max(maxTrash, r.trashCount ?? 0);
      anchors = Math.max(anchors, r.anchors);
    }
    if (!(await step(p))) break;
  }

  const ok = worstClip === 0 && overlapStates === 0 && anchors === 4 && (trashHitTried === 0 || trashHitOk === trashHitTried);
  if (!ok) bad++;
  console.log(
    `${String(W + "x" + H).padEnd(9)} clippedByBoard=${worstClip}px  overlapsRailContent=${overlapStates} states${worstOverlap ? ` (worst ${worstOverlap}px)` : ""}  ` +
      `maxTrashSeen=${maxTrash} trashClickable=${trashHitOk}/${trashHitTried}  flightAnchors=${anchors}  ${ok ? "OK" : "FAIL"}`,
  );
  await p.close();
}

await b.close();
process.exit(bad === 0 ? 0 : 1);
