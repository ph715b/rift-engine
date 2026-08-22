// **Does Best of 3's battlefield-select screen fit, and does it show the cards?**
//
// Reported from playtesting: you cannot hover the battlefields on the pre-game
// selector. It rendered three names in three buttons — no art, no rules text —
// for a choice (486.5) whose entire basis is the printed ability.
//
// Adding the card art to that screen is a HEIGHT change, and this repo's lobby
// has form here: a fifth zone once took the deck zone from 526px to 379px and
// pushed its own button under the zone below, where the overflow was invisible
// in a screenshot because nothing clips it. So this measures the boxes rather
// than looking at them, at all four sizes.
//
//     node tools/ui-probes/battlefield-select.mjs
import { chromium, sleep, ORIGIN, PORT, SIZES } from "./lib.mjs";

const only = process.argv[2] ? [[Number(process.argv[2]), Number(process.argv[3])]] : SIZES;
const b = await chromium.launch({ headless: true });
let bad = 0;
const rows = [];

for (const [W, H] of only) {
  const p = await b.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));

  await p.goto(ORIGIN, { waitUntil: "networkidle" });
  const ng = p.getByRole("button", { name: /new game/i });
  if (await ng.count()) {
    await ng.first().click();
    await sleep(700);
  }

  // BEST OF 3 — the only format with this screen at all. A probe that forgot to
  // pick it would sail past into a bo1 mulligan and report every check false.
  const bo3 = p.locator("button.format-option", { hasText: /Best of 3/ });
  if (!(await bo3.count())) throw new Error(`no Best of 3 format option — is the dev server on :${PORT}?`);
  await bo3.first().click();
  await sleep(200);

  const d = p.locator("button.deck-option-button");
  const total = await d.count();
  if (total < 2) throw new Error(`lobby never rendered deck pickers (found ${total})`);
  const per = total / 2;
  await d.nth(1).click();
  await sleep(150);
  await d.nth(per + 1).click();
  await sleep(150);
  await p.getByRole("button", { name: /start match/i }).first().click();
  await sleep(1200);

  await p.waitForSelector(".battlefield-select", { timeout: 8000 });

  const options = p.locator("button.battlefield-select-option");
  const count = await options.count();
  const arts = await p.locator("img.battlefield-select-art").count();

  // Does the screen fit? The container is the page; anything taller than the
  // viewport means the option row has pushed the note (or itself) out of sight.
  const doc = await p.evaluate(() => ({
    scrollH: document.documentElement.scrollHeight,
    clientH: document.documentElement.clientHeight,
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
  }));

  // Does the hover actually open the shared preview?
  await options.first().hover();
  await sleep(250);
  const previewOpen = (await p.locator(".card-preview").count()) > 0;
  const previewHasText = previewOpen && ((await p.locator(".card-preview .card-preview-text").innerText()) ?? "").length > 10;
  await p.mouse.move(2, 2);
  await sleep(250);
  const previewClosed = (await p.locator(".card-preview").count()) === 0;

  const fitsV = doc.scrollH <= doc.clientH + 1;
  const fitsH = doc.scrollW <= doc.clientW + 1;
  const ok = count === 3 && arts === 3 && previewOpen && previewHasText && previewClosed && fitsV && fitsH && errors.length === 0;
  if (!ok) bad += 1;

  rows.push({
    viewport: `${W}x${H}`,
    options: count,
    arts,
    previewOpen,
    previewHasText,
    previewClosed,
    page: `${doc.scrollW}x${doc.scrollH} in ${doc.clientW}x${doc.clientH}`,
    fitsV,
    fitsH,
    errors,
  });
  await p.close();
}

console.log(JSON.stringify({ probe: "battlefield-select", rows, ok: bad === 0 }, null, 1));
await b.close();
process.exit(bad === 0 ? 0 : 1);
