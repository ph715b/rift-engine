// **Are the deck builder's tiles the size their own CSS says?**
//
// The battlefield picker's tiles are the one place in this app where a LANDSCAPE
// card is laid out beside portrait ones, and that is exactly the shape a cascade
// accident hides in: `.card-tile.battlefield-tile` and
// `.battlefield-picker-grid .card-tile` have EQUAL specificity (0,2,0), so which
// one sizes a tile is decided by declaration order in styles.css and by nothing
// a reader would think to check.
//
// Reported from playtesting: the battlefield images in the deck builder are far
// too big.
//
// Measures the RENDERED box of a tile in each of the two grids and reports the
// aspect ratio, because that is the half that says WHICH rule won: a portrait
// ratio on a battlefield tile means the landscape rule lost.
//
//     node tools/ui-probes/deck-builder-tiles.mjs
import { chromium, sleep, ORIGIN, PORT, SIZES } from "./lib.mjs";

/** Printed ratios. A battlefield card is the same stock rotated. */
const PORTRAIT = 744 / 1039;
const LANDSCAPE = 1039 / 744;

const only = process.argv[2] ? [[Number(process.argv[2]), Number(process.argv[3])]] : SIZES;
const b = await chromium.launch({ headless: true });
let bad = 0;
const rows = [];

for (const [W, H] of only) {
  const p = await b.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));

  await p.goto(ORIGIN, { waitUntil: "networkidle" });
  // Landing -> Deck Builder. The button's label has moved before; match loosely
  // and THROW rather than silently measuring the landing page.
  const open = p.getByRole("button", { name: /deck builder|build a deck|new deck/i });
  if (!(await open.count())) throw new Error(`no deck-builder entry point on the landing page — is the dev server on :${PORT}?`);
  await open.first().click();
  await sleep(900);

  // The tabs are role="tab" inside a role="tablist", NOT buttons — a
  // getByRole("button") lookup here finds nothing and reads as "the deck builder
  // never opened".
  if (!(await p.locator(".deck-builder").count())) throw new Error("the deck builder never opened");
  const tab = p.locator(".builder-tab", { hasText: /^Battlefields$/ });
  if (!(await tab.count())) throw new Error("the Battlefields tab never rendered — the left pane's tabs have changed");
  await tab.first().click();
  await sleep(500);

  const box = async (sel) => {
    const el = p.locator(sel).first();
    if (!(await el.count())) return null;
    const r = await el.boundingBox();
    return r ? { w: Math.round(r.width), h: Math.round(r.height), ratio: r.width / r.height } : null;
  };

  const bf = await box(".battlefield-picker-grid .card-tile");
  const paneW = (await p.locator(".builder-pane").first().boundingBox())?.width ?? 0;
  if (!bf) throw new Error("no battlefield tile rendered — the picker grid has changed");

  // THE CONTROL. The fix removed the battlefield picker from the shared
  // fill-the-cell rule, so the thing to prove is that the CARD BROWSER still
  // has it: a portrait tile must keep filling its grid cell, or the column
  // count would change the spacing instead of the card size.
  // The browser is EMPTY until a legend is chosen — "Pick a legend on the Setup
  // tab to browse its legal cards" — so a probe that just clicks Cards measures
  // an empty pane and reports the grid missing.
  // NOT anchored: the tab reads "Setup •" while no legend is chosen, so /^Setup$/
  // matches nothing and reads as "the deck builder has changed".
  await p.locator(".builder-tab", { hasText: /Setup/ }).first().click();
  await sleep(400);
  await p.locator(".deck-option-button").first().click();
  await sleep(300);
  await p.locator(".builder-tab", { hasText: /^Cards$/ }).first().click();
  await sleep(700);
  const browser = await box(".card-browser-grid .card-tile");
  if (!browser) throw new Error("no card-browser tile rendered — the browser grid has changed");
  const browserIsPortrait = browser.ratio < 1;

  // A battlefield tile is landscape (wider than tall). Anything at or below 1 is
  // the portrait rule having won, which is the reported bug.
  const isLandscape = bf.ratio > 1;
  // …and it must not eat the pane. `width: 100%` inside a flex-wrap container
  // resolves to the FULL pane width, which is how "too big" presents.
  const fitsSeveralAcross = bf.w < paneW / 2;
  const ok = isLandscape && fitsSeveralAcross && browserIsPortrait && errors.length === 0;
  if (!ok) bad += 1;

  rows.push({
    viewport: `${W}x${H}`,
    battlefieldTile: `${bf.w}x${bf.h}`,
    ratio: Number(bf.ratio.toFixed(2)),
    expectedLandscape: Number(LANDSCAPE.toFixed(2)),
    portraitWouldBe: Number(PORTRAIT.toFixed(2)),
    paneWidth: Math.round(paneW),
    isLandscape,
    fitsSeveralAcross,
    browserTile: `${browser.w}x${browser.h}`,
    browserRatio: Number(browser.ratio.toFixed(2)),
    browserIsPortrait,
    errors,
  });
  await p.close();
}

console.log(JSON.stringify({ probe: "deck-builder-tiles", rows, ok: bad === 0 }, null, 1));
await b.close();
process.exit(bad === 0 ? 0 : 1);
