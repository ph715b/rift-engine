// Does the opponent's facedown card keep its identity secret in the real DOM?
//
// The state reaching the UI is NOT masked — `h.card` carries the real identity
// for both players — so the only thing protecting a [Hidden] card is one branch
// in BattlefieldView. This checks that branch against live games rather than by
// reading it: every facedown tile that is not the viewer's own must render the
// literal "Facedown", and neither its text nor its tooltip may carry a name.
import { chromium, bootToBoard, step, sleep } from "./lib.mjs";

const W = Number(process.argv[2] ?? 1600), H = Number(process.argv[3] ?? 950);
const STEPS = Number(process.env.STEPS ?? 400);

const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: W, height: H } });
await bootToBoard(p);

let enemyTilesSeen = 0;
let ownTilesSeen = 0;
const leaks = [];

for (let s = 0; s < STEPS; s++) {
  const r = await p.evaluate(() => {
    const tiles = [...document.querySelectorAll(".facedown-card")];
    return tiles.map((t) => ({
      mine: t.classList.contains("mine"),
      text: (t.textContent ?? "").trim(),
      title: t.getAttribute("title") ?? "",
    }));
  });
  for (const t of r) {
    if (t.mine) { ownTilesSeen++; continue; }
    enemyTilesSeen++;
    // The enemy tile must say exactly "Facedown", and its tooltip must be the
    // generic one — anything else means a name reached the DOM.
    if (t.text !== "Facedown" || /—/.test(t.title)) {
      const key = `${t.text} | ${t.title}`;
      if (!leaks.includes(key)) leaks.push(key);
    }
  }
  if (!(await step(p))) break;
}

console.log(`${W}x${H} enemyFacedownTilesObserved=${enemyTilesSeen} ownFacedownTilesObserved=${ownTilesSeen} leaks=${leaks.length}`);
for (const l of leaks) console.log(`   LEAK: ${l}`);
if (enemyTilesSeen === 0) console.log("   (no enemy facedown card ever reached the board in this run — branch NOT exercised)");
await b.close();
process.exit(leaks.length === 0 ? 0 : 1);
