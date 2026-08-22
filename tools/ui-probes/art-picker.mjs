// **Can a player actually change a card's printing, and does it stick?**
//
// Reported from playtesting: there is no way to pick a card's alternate art. The
// pool prints 99 and `shouldSkip` drops every one from the registry, so the art
// was loadable and unreachable.
//
// The unit tests pin the store and the CardView read. This drives the real
// control: hover a browser tile, click its badge, and check the tile's own `src`
// changed — then RELOAD and check it is still changed, which is the half no
// jsdom test can prove because it owns its localStorage.
//
//     node tools/ui-probes/art-picker.mjs
import { chromium, sleep, ORIGIN, PORT, SIZES } from "./lib.mjs";

const only = process.argv[2] ? [[Number(process.argv[2]), Number(process.argv[3])]] : [SIZES[0]];
const b = await chromium.launch({ headless: true });
let bad = 0;
const rows = [];

for (const [W, H] of only) {
  const p = await b.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));

  const openBuilderWithLegend = async () => {
    await p.getByRole("button", { name: /deck builder|build a deck|new deck/i }).first().click();
    await sleep(900);
    // NOT anchored: the tab reads "Setup •" until a legend is chosen.
    await p.locator(".builder-tab", { hasText: /Setup/ }).first().click();
    await sleep(400);
    await p.locator(".deck-option-button").first().click();
    await sleep(300);
    await p.locator(".builder-tab", { hasText: /^Cards$/ }).first().click();
    await sleep(800);
  };

  await p.goto(ORIGIN, { waitUntil: "networkidle" });
  await openBuilderWithLegend();

  // Find a tile that HAS a picker. Most of the pool has one printing, so the
  // badge is deliberately absent on those — a probe that grabbed the first tile
  // would usually find nothing and report the feature missing.
  // Counted on the WHOLE locator, not on `.first()` — a first-locator count is
  // 0 or 1 by construction and would report "1 tile has a picker" however many do.
  const withPicker = await p.locator(".card-tile-art-toggle").count();
  const totalTiles = await p.locator(".card-browser-grid .card-tile").count();
  if (!withPicker) throw new Error(`no art picker on any browser tile — is the dev server on :${PORT}?`);
  // …and NOT on every tile: most of the pool has one printing, so a badge
  // everywhere would mean the `printings.length > 1` guard had stopped working.
  const onlySome = withPicker < totalTiles;
  const badge = p.locator(".card-tile-art-toggle").first();

  const tile = p.locator(".card-tile", { has: p.locator(".card-tile-art-toggle") }).first();
  const srcOf = () => tile.locator("img.card-tile-art").getAttribute("src");
  const before = await srcOf();
  const labelBefore = (await badge.innerText()).trim();

  // The badge only appears on hover, so a click without one is a click on art.
  await tile.hover();
  await sleep(150);
  const visibleOnHover = await badge.isVisible();
  await badge.click();
  await sleep(300);
  const after = await srcOf();
  const labelAfter = (await badge.innerText()).trim();

  // …and it must SURVIVE a reload, which is the whole point of persisting it.
  await p.reload({ waitUntil: "networkidle" });
  await openBuilderWithLegend();
  const reloadTile = p.locator(".card-tile", { has: p.locator(".card-tile-art-toggle") }).first();
  const afterReload = await reloadTile.locator("img.card-tile-art").getAttribute("src");

  // Cycling all the way round must come back to the default AND clear storage,
  // so a card is never pinned against a set that adds a third printing later.
  const reloadBadge = reloadTile.locator(".card-tile-art-toggle");
  await reloadTile.hover();
  await sleep(150);
  await reloadBadge.click();
  await sleep(300);
  const wrapped = await reloadTile.locator("img.card-tile-art").getAttribute("src");
  const stored = await p.evaluate(() => localStorage.getItem("rift-engine.cardArt"));

  const changed = before !== after;
  const persisted = afterReload === after;
  const wrappedToDefault = wrapped === before;
  const clearedStorage = (stored ?? "{}") === "{}";
  const ok = changed && persisted && wrappedToDefault && clearedStorage && visibleOnHover && onlySome && errors.length === 0;
  if (!ok) bad += 1;

  rows.push({
    viewport: `${W}x${H}`,
    tilesWithPicker: `${withPicker} of ${totalTiles}`,
    onlySome,
    visibleOnHover,
    label: `${labelBefore} -> ${labelAfter}`,
    changed,
    persisted,
    wrappedToDefault,
    clearedStorage,
    errors,
  });
  await p.close();
}

console.log(JSON.stringify({ probe: "art-picker", rows, ok: bad === 0 }, null, 1));
await b.close();
process.exit(bad === 0 ? 0 : 1);
