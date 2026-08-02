// The hand overlay's behavioural contract, tested as INTERACTION rather than
// geometry — `elementFromPoint` answers "what would this click actually hit",
// which is the question that matters and the one the reverted attempt got wrong.
//
//  1. AT REST THE HAND IS OUT OF THE WAY. Collapsed to a peek, a click on any of
//     your rune tiles must reach the RUNE, not the hand.
//  2. HOVER OPENS IT. Hovering a peek must expand the whole fan. This also tests
//     a load-bearing assumption in the stylesheet: `:hover` is matched on the
//     layer even though the layer is `pointer-events: none`, because the hovered
//     SLOT is a descendant. If that were false the fan would never open.
//  3. PINNED STAYS SHUT. While a card is armed or a unit is selected, hovering
//     must NOT open it.
//  4. THE PEEK IS INSIDE THE BOARD. `.board` is overflow:hidden, so a peek that
//     is merely translated down is cut off rather than tucked.
import { chromium, bootToBoard, step, sleep, SIZES } from "./lib.mjs";

const b = await chromium.launch({ headless: true });
let bad = 0;

for (const [W, H] of SIZES) {
  const p = await b.newPage({ viewport: { width: W, height: H } });
  await bootToBoard(p);

  const snap = () =>
    p.evaluate(() => {
      const board = document.querySelector(".board").getBoundingClientRect();
      const layer = document.querySelector(".hand-fan-layer");
      const slots = [...document.querySelectorAll(".hand-fan-slot")];
      const rows = [...document.querySelectorAll(".rune-row")];
      const mine = rows[rows.length - 1];
      const tiles = mine ? [...mine.querySelectorAll(".rune-tile")] : [];
      const hitOn = (t) => {
        const r = t.getBoundingClientRect();
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!el) return "none";
        if (el.closest(".rune-tile")) return "rune";
        if (el.closest(".hand-fan-layer")) return "hand";
        return "other";
      };
      return {
        pinned: layer?.classList.contains("pinned") ?? false,
        slotH: slots.length ? Math.round(slots[0].getBoundingClientRect().height) : 0,
        cardH: Math.round(parseFloat(getComputedStyle(document.querySelector(".board-main")).getPropertyValue("--board-card-h")) || 0),
        peekVisible: slots.length
          ? Math.min(...slots.map((s) => {
              const r = s.getBoundingClientRect();
              return Math.round(Math.max(0, Math.min(r.bottom, board.bottom) - Math.max(r.top, board.top)));
            }))
          : 0,
        runeHits: tiles.map(hitOn),
        slots: slots.length,
        tiles: tiles.length,
      };
    });

  let restStates = 0, runesBlocked = 0, minPeek = Infinity;
  let openTried = 0, openWorked = 0;
  let pinnedTried = 0, pinnedStayedShut = 0;
  let skipped = 0;

  // Let the shared card size converge before sampling anything.
  await sleep(1200);

  for (let s = 0; s < 110; s++) {
    const r = await snap();
    if (r.slots > 0 && r.tiles > 0 && !r.pinned) {
      restStates++;
      runesBlocked += r.runeHits.filter((h) => h === "hand").length;
      minPeek = Math.min(minPeek, r.peekVisible);
    }

    // Does hovering open it (or correctly refuse to, while pinned)?
    //
    // Driven by a raw mouse move to a measured point, NOT locator.hover(): the
    // cards sit under Framer Motion layout animations, so Playwright's
    // actionability wait intermittently gives up on a moving element. Those
    // give-ups were being scored as "the fan failed to open" — an instrument
    // artifact that looked exactly like a UI bug.
    // Always test while PINNED (that state is rare and gets cancelled out of
    // immediately, so sampling it on a schedule scored 0/0 — a check that never
    // ran, reported as nothing wrong).
    if (r.slots > 0 && (r.pinned || s % 5 === 2)) {
      const box = await p.evaluate(() => {
        const slots = [...document.querySelectorAll(".hand-fan-slot")];
        if (!slots.length) return null;
        // The LAST slot: later slots paint over earlier ones (DOM order), so this
        // is the one guaranteed not to be covered by a neighbour at its centre.
        const r = slots[slots.length - 1].getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      if (box) {
        await p.mouse.move(box.x, box.y);
        await sleep(450);
        // Is this sample still MEANINGFUL? Two races make it not: the hand can
        // gain a card between measuring the point and moving to it (useRowFit
        // then re-fans and every slot shifts out from under the cursor), and the
        // shared card size is still converging for the first few hundred ms after
        // the board mounts. Both were being scored as "the fan failed to open".
        // Skipped samples are counted and reported — silently dropping them would
        // be the same lie in the other direction.
        const valid = await p.evaluate(({ x, y, was }) => {
          const el = document.elementFromPoint(x, y);
          return Boolean(el?.closest(".hand-fan-layer")) && document.querySelectorAll(".hand-fan-slot").length === was;
        }, { ...box, was: r.slots });
        if (!valid) { skipped++; await p.mouse.move(Math.round(W / 2), 60); await sleep(250); continue; }
        const after = await snap();
        if (after.cardH > 0) {
          const opened = after.slotH > after.cardH * 0.8;
          if (r.pinned) { pinnedTried++; if (!opened) pinnedStayedShut++; }
          else {
            openTried++;
            if (opened) openWorked++;
            else {
              // Why did it not open? Report what is actually under the cursor
              // rather than counting a bare failure.
              const why = await p.evaluate(({ x, y }) => {
                const el = document.elementFromPoint(x, y);
                const layer = document.querySelector(".hand-fan-layer");
                return {
                  under: el ? (el.className?.baseVal ?? el.className ?? el.tagName) + "" : "none",
                  inLayer: Boolean(el?.closest(".hand-fan-layer")),
                  pinnedNow: layer?.classList.contains("pinned") ?? false,
                  slotsNow: document.querySelectorAll(".hand-fan-slot").length,
                };
              }, box);
              console.log(`   miss s=${s}: under="${why.under}" inLayer=${why.inLayer} pinnedNow=${why.pinnedNow} slots ${r.slots}->${why.slotsNow}`);
            }
          }
        }
        // Move the cursor off the hand so the next resting sample is honest.
        await p.mouse.move(Math.round(W / 2), 60);
        await sleep(320);
      }
    }

    if (!r.pinned) {
      const sel = p.locator(".hand-fan-slot .card.selectable");
      if ((await sel.count()) && (pinnedTried < 2 || s % 9 === 4)) {
        await sel.first().click().catch(() => {});
        await sleep(300);
        continue;
      }
    } else {
      const cancel = p.getByRole("button", { name: /^Cancel/ });
      if (await cancel.count()) {
        await cancel.first().click().catch(() => {});
        await sleep(250);
        continue;
      }
    }
    if (!(await step(p))) break;
  }

  const ok =
    restStates > 0 &&
    runesBlocked === 0 &&
    minPeek >= 8 &&
    openTried > 0 &&
    openWorked === openTried &&
    pinnedTried > 0 && pinnedStayedShut === pinnedTried;
  if (!ok) bad++;
  console.log(
    `${String(W + "x" + H).padEnd(9)} rest[states=${restStates} runesBlockedByHand=${runesBlocked} minPeek=${minPeek === Infinity ? "n/a" : minPeek + "px"}]  ` +
      `hoverOpens=${openWorked}/${openTried}  pinnedStayedShut=${pinnedStayedShut}/${pinnedTried}  racedSamplesSkipped=${skipped}  ${ok ? "OK" : "FAIL"}`,
  );
  await p.close();
}

await b.close();
process.exit(bad === 0 ? 0 : 1);
