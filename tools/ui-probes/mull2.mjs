// The mulligan screen still renders correctly.
//
// It shares the `.card-row` class with the board and sets its own much larger
// `--card-h`, and hijacking that base class has broken this screen outright
// before. `useRowFit` also changed to a callback ref in this session, and the
// mulligan is exactly the pregame screen that made the old plain ref misbehave.
import { chromium, sleep, ORIGIN, SIZES } from "./lib.mjs";

const b = await chromium.launch({ headless: true });
let bad = 0;

for (const [W, H] of SIZES) {
  const p = await b.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));

  await p.goto(ORIGIN, { waitUntil: "networkidle" });
  const ng = p.getByRole("button", { name: /new game/i });
  if (await ng.count()) { await ng.first().click(); await sleep(700); }
  const d = p.locator("button.deck-option-button");
  const per = (await d.count()) / 2;
  await d.nth(1).click(); await sleep(150);
  await d.nth(per + 1).click(); await sleep(150);
  await p.getByRole("button", { name: /start match/i }).first().click();
  await sleep(1800);

  const r = await p.evaluate(() => {
    const screen = document.querySelector(".mulligan-screen");
    if (!screen) return null;
    const row = screen.querySelector(".card-row");
    const cards = [...(row?.querySelectorAll(".card") ?? [])];
    const board = document.querySelector(".board").getBoundingClientRect();
    return {
      cards: cards.length,
      cardH: cards.length ? Math.round(cards[0].getBoundingClientRect().height) : 0,
      // The mulligan cards must be BIG — that is the whole point of the screen,
      // and the board's fitted sizing must not have leaked into it.
      isFitted: row ? row.classList.contains("fitted") : null,
      rowScrolls: row ? row.scrollHeight - row.clientHeight > 2 : null,
      offBoard: cards.filter((c) => {
        const cb = c.getBoundingClientRect();
        return cb.left < board.left - 1 || cb.right > board.right + 1 || cb.bottom > board.bottom + 1;
      }).length,
      hasKeep: Boolean([...document.querySelectorAll("button")].find((x) => /keep hand/i.test(x.textContent))),
    };
  });

  if (!r) { console.log(`${W}x${H} FAIL — mulligan screen never rendered`); bad++; await p.close(); continue; }
  const ok = r.cards === 4 && r.cardH > 90 && r.isFitted === false && r.offBoard === 0 && r.hasKeep && errors.length === 0;
  if (!ok) bad++;
  console.log(
    `${String(W + "x" + H).padEnd(9)} cards=${r.cards} cardH=${r.cardH}px fittedClassLeaked=${r.isFitted} rowScrolls=${r.rowScrolls} offBoard=${r.offBoard} keepBtn=${r.hasKeep} ${ok ? "OK" : "FAIL"}${errors.length ? " PAGEERR:" + errors[0] : ""}`,
  );
  await p.close();
}

await b.close();
process.exit(bad === 0 ? 0 : 1);
