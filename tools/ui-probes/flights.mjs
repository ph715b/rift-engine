// Do cards actually FLY between the right zones?
//
// This is the positive control for the flight layer. Termination and layout
// probes stay green whether the animation works or never fires once, so this
// asserts the paths themselves were taken — and, crucially, that a DRAW flies
// from the deck rather than merely that something moved.
//
// Uses a page-side MutationObserver rather than polling: a flight lives ~460ms,
// so a poll loop would miss most of them and under-report by an unknown amount.
import { chromium, bootToBoard, step, sleep, SIZES } from "./lib.mjs";

const W = Number(process.argv[2] ?? 1600), H = Number(process.argv[3] ?? 950);
const STEPS = Number(process.env.STEPS ?? 200);

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: W, height: H } });
await bootToBoard(p);

await p.evaluate(() => {
  window.__flights = [];
  window.__badGeometry = [];
  const seen = new WeakSet();
  const record = (el) => {
    if (!(el instanceof HTMLElement) || !el.classList?.contains("flight-card") || seen.has(el)) return;
    seen.add(el);
    const from = el.getAttribute("data-from");
    const to = el.getAttribute("data-to");
    window.__flights.push(`${from}->${to}`);
    // The endpoints must be real places on screen. A flight to 0,0 (a missing
    // anchor) is the failure this would otherwise hide.
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || (r.left <= 1 && r.top <= 1)) {
      window.__badGeometry.push(`${from}->${to} @${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
  };
  // Scan the added node AND its descendants. `FlightLayer` renders null while
  // idle, so the first flight of a burst arrives as a child of the freshly-added
  // `.flight-layer` wrapper, not as the added node itself — checking only the
  // node reported 0 flights while the animation was working fine.
  const scan = (n) => {
    record(n);
    if (n instanceof HTMLElement) for (const el of n.querySelectorAll?.(".flight-card") ?? []) record(el);
  };
  new MutationObserver((records) => {
    for (const rec of records) for (const n of rec.addedNodes) scan(n);
  }).observe(document.body, { childList: true, subtree: true });
});

// A purely passive run only ever exercises the paths the ENGINE causes (draws,
// channels). The paths the PLAYER causes — recycling a rune, putting a card in
// the trash — need the player to act, so ACTIVE=1 does.
const ACTIVE = process.env.ACTIVE;

for (let s = 0; s < STEPS; s++) {
  if (ACTIVE) {
    // Recycle a rune: right-click sends a channelled rune back to the rune deck.
    if (s % 6 === 1) {
      const tile = p.locator(".rune-row").last().locator(".rune-tile.payable").first();
      if (await tile.count()) {
        await tile.click({ button: "right" }).catch(() => {});
        await sleep(320);
      }
    }
    // Play a card, which is what eventually puts things in the trash.
    if (s % 4 === 2) {
      const card = p.locator(".hand-fan-slot .card.selectable").first();
      if (await card.count()) {
        await card.click().catch(() => {});
        await sleep(280);
        const pay = p.getByRole("button", { name: /Auto Pay/i });
        if (await pay.count()) {
          await pay.first().click().catch(() => {});
          await sleep(320);
        }
        const cancel = p.getByRole("button", { name: /^Cancel/ });
        if (await cancel.count()) {
          await cancel.first().click().catch(() => {});
          await sleep(200);
        }
      }
    }
  }
  if (!(await step(p))) break;
}

const r = await p.evaluate(() => {
  const tally = {};
  for (const f of window.__flights) tally[f] = (tally[f] ?? 0) + 1;
  return { tally, total: window.__flights.length, bad: window.__badGeometry.slice(0, 5), badN: window.__badGeometry.length };
});

const paths = Object.entries(r.tally).sort((a, c) => c[1] - a[1]);
console.log(`${W}x${H}  totalFlights=${r.total}  badGeometry=${r.badN}`);
for (const [path, n] of paths) console.log(`   ${path.padEnd(22)} ${n}`);
if (r.bad.length) for (const bad of r.bad) console.log(`   BAD: ${bad}`);

// A draw happens every turn, so its absence means the feature never fired.
const drew = (r.tally["deck->hand"] ?? 0) > 0;
const ok = r.total > 0 && r.badN === 0 && drew;
console.log(ok ? "OK" : `FAIL${drew ? "" : " (no deck->hand flight seen — draws are the one path that must occur)"}`);
await b.close();
process.exit(ok ? 0 : 1);
