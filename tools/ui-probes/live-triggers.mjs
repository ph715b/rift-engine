/**
 * Does the board survive — and SHOW — the work landed on 2026-08-02?
 *
 * Three things had never been seen in a browser:
 *  1. The ChainView TRIGGER ROW (`.chain-item-trigger`, the ⚡ marker). Engine
 *     tests cover the entry; nothing had confirmed it renders. Until
 *     `battlefieldConquered` was converted, the only card that could produce one
 *     was Mistfall, so it was close to unreachable in a real game.
 *  2. The 29 cards landed this session, several of which park DECISIONS. A
 *     decision that renders no options, or an option that cannot be clicked, is
 *     a soft-lock no engine test can see.
 *  3. The conquer conversion itself, which changes WHEN the opponent gets a
 *     priority window — a player-visible timing change.
 *
 * Every count here is a POSITIVE control: this probe fails if it observes
 * nothing, because "no errors" is exactly what a driver that never started a
 * game also reports.
 *
 * Console errors and page exceptions ARE hard failures. A React error boundary
 * or an uncaught throw is never acceptable and is the thing most likely to be
 * caused by a card whose resolver returns a shape the board cannot render.
 *
 * **KNOWN UNEXERCISED: decisions.** The human passes all game, so it never plays
 * a card and is never asked anything; the AI answers its own questions without a
 * prompt. `decisionsSeen: 0` here therefore means "not reached", NOT "no
 * decisions render" — the eight decision-parking cards landed on 2026-08-02 have
 * still never been seen in a browser. Reaching them needs a driver that plays
 * cards rather than only passing. Reported rather than gated, precisely so the
 * zero cannot be mistaken for a pass.
 */
import { chromium, ORIGIN, OUT, PORT, sleep, step } from "./lib.mjs";
import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * SIX games, not two, and the number is measured rather than chosen.
 *
 * A trigger reaches the chain roughly once per game with this deck (headlessly:
 * 112 conquer + 74 buff triggers per 100 games), and the browser only samples
 * between steps rather than seeing every state. Two consecutive runs of this
 * probe over 2 games gave 30 trigger-row states and then ZERO — same deck, same
 * code, different seed. With a hard gate on `triggerRowStates > 0` that is a
 * flake, and a flaky probe gets ignored, which is worse than no probe. Six games
 * puts it comfortably clear: 75 observations across three distinct abilities.
 */
const GAMES = Number(process.env.GAMES ?? 6);
const STEPS = Number(process.env.STEPS ?? 320);

/**
 * The preset decks CANNOT reach this feature, and finding that out is half the
 * value of this probe.
 *
 * Not one of the seven presets contains a single `battlefieldConquered` listener
 * (Sett - Brawler, Qiyana - Victorious, Kai'Sa - Survivor, Adaptatron) or
 * Mistfall — so a preset-vs-preset game can never put a trigger on the chain, and
 * the first run of this probe duly reported `triggerRowStates: 0` while saying
 * OK. That is the 0/0-reads-as-a-pass failure this project keeps rediscovering,
 * reproduced in a brand-new instrument.
 *
 * So the deck is IMPORTED through the real lobby UI: a buff deck built off Sett -
 * The Boss, the same shape `probes/chain-depth.ts` uses headlessly, containing
 * Sett - Brawler (conquer) and Mistfall (buff). Both seats use it, so the AI
 * alone can produce trigger rows for a passive human to watch.
 */
const DECK_TEXT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), ".buffdeck.txt"), "utf8");
const DECK_NAME = /Sett/i;

const consoleErrors = [];
const pageErrors = [];
let boardsReached = 0;
let stepsTaken = 0;
let triggerRowStates = 0;
let chainItemStates = 0;
let decisionsSeen = 0;
let decisionsAnswered = 0;
const decisionTitles = new Map();
const triggerNames = new Map();
let gamesOver = 0;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 950 } });
const page = await context.newPage();

page.on("console", (msg) => {
  if (msg.type() !== "error") return;
  const text = msg.text();
  // Vite's HMR chatter and the image CDN are not the app failing. Everything
  // else is kept, including React warnings, which is where a bad key or a
  // missing prop on a freshly-landed card would surface.
  if (/favicon|net::ERR|Failed to load resource/i.test(text)) return;
  consoleErrors.push(text);
});
page.on("pageerror", (err) => pageErrors.push(String(err?.message ?? err)));

/** Lobby -> paste decklist -> Parse -> DeckBuilder -> Save. Leaves the imported
 *  deck in the profile, selectable by both pickers. THROWS rather than falling
 *  back to a preset: silently playing the wrong deck is how this probe lied the
 *  first time. */
async function importBuffDeck(p) {
  await p.goto(ORIGIN, { waitUntil: "networkidle" });
  const ng = p.getByRole("button", { name: /new game/i });
  if (await ng.count()) {
    await ng.first().click();
    await sleep(700);
  }
  const box = p.locator("textarea.decklist-text-import-textarea");
  await box.waitFor({ timeout: 8000 });
  await box.fill(DECK_TEXT);
  await p.getByRole("button", { name: /^Parse$/ }).first().click();
  await sleep(900);
  const save = p.getByRole("button", { name: /save deck/i });
  await save.waitFor({ timeout: 8000 });
  await save.first().click();
  await sleep(900);
  const imported = p.locator("button.deck-option-button", { hasText: DECK_NAME });
  const found = await imported.count();
  if (found === 0) throw new Error("the imported deck never appeared in the lobby");
  return found;
}

/** Selects the imported deck for BOTH seats and starts, then clears the
 *  mulligan. Start Match stays disabled until both are chosen. */
async function bootWithImportedDeck(p) {
  // Matched by NAME and taken first-and-last, NOT by an index split. The shared
  // lib's "first half is the human, second half is the AI" holds for the preset
  // grid alone; the lobby actually renders human presets, then human saved decks,
  // then the opponent's of each — so one imported deck lands at two positions
  // that a `total / 2` split gets wrong, and the first version of this driver
  // duly failed with "human undefined, ai 11".
  const mine = p.locator("button.deck-option-button", { hasText: DECK_NAME });
  const n = await mine.count();
  if (n < 2) throw new Error(`imported deck is in ${n} picker(s), need 2 — did the save not persist?`);
  await mine.first().click();
  await sleep(150);
  await mine.last().click();
  await sleep(150);
  await p.getByRole("button", { name: /start match/i }).first().click();
  await sleep(1500);
  for (const label of [/keep hand/i, /keep/i]) {
    const btn = p.getByRole("button", { name: label });
    if (await btn.count()) {
      await btn.first().click().catch(() => {});
      await sleep(1200);
      break;
    }
  }
  await p.waitForSelector(".board-main", { timeout: 8000 });
  await sleep(300);
}

await importBuffDeck(page);

for (let g = 0; g < GAMES; g += 1) {
  try {
    if (g > 0) await page.goto(ORIGIN, { waitUntil: "networkidle" });
    if (g > 0) {
      const ng = page.getByRole("button", { name: /new game/i });
      if (await ng.count()) {
        await ng.first().click();
        await sleep(700);
      }
    }
    await bootWithImportedDeck(page);
  } catch (err) {
    console.log(`  BOOT FAILED g${g}: ${err.message}`);
    break;
  }
  boardsReached += 1;

  for (let s = 0; s < STEPS; s += 1) {
    // A decision overlay blocks the board, so it is answered FIRST and counted.
    // Counting raised-vs-answered separately is what rules out a stranded
    // question: a prompt that renders and cannot be dismissed would show up as
    // seen > answered rather than as a timeout with no explanation.
    const overlay = page.locator(".choice-overlay-panel");
    if (await overlay.count()) {
      decisionsSeen += 1;
      const title = (await page.locator(".choice-overlay-title").first().textContent().catch(() => "")) ?? "";
      decisionTitles.set(title.trim(), (decisionTitles.get(title.trim()) ?? 0) + 1);
      const buttons = overlay.locator("button");
      const n = await buttons.count();
      if (n > 0) {
        await buttons.nth(n - 1).click({ timeout: 1500 }).catch(() => {});
        await sleep(200);
        if ((await page.locator(".choice-overlay-panel").count()) === 0) decisionsAnswered += 1;
      }
    }

    // Sampled every step rather than waited for: the row lives only while the
    // trigger is on the chain, which is a handful of frames.
    const triggers = await page.locator(".chain-item-trigger").count();
    if (triggers > 0) {
      triggerRowStates += 1;
      // WHICH ability, not just "a row exists". A trigger row renders a ⚡ marker
      // instead of a card (a triggered ability has no card of its own), so a row
      // that failed to resolve its source name would still be counted by the
      // selector above while showing the player a blank. Counting the names is
      // what distinguishes "the row renders" from "the row renders something".
      for (const name of await page.locator(".chain-item-name").allTextContents()) {
        const key = name.trim();
        if (key) triggerNames.set(key, (triggerNames.get(key) ?? 0) + 1);
      }
    }
    if ((await page.locator(".chain-item").count()) > 0) chainItemStates += 1;

    stepsTaken += 1;
    const alive = await step(page);
    if (!alive) {
      gamesOver += 1;
      break;
    }
  }
  await page.screenshot({ path: join(OUT, `live-triggers-g${g}.png`) }).catch(() => {});
}

await browser.close();

// `triggerRowStates > 0` is a HARD gate, not a report. The deck is chosen
// precisely so trigger rows are reachable — headlessly the same deck puts 112
// conquer triggers plus 74 Mistfall triggers on the chain per 100 games — so
// zero here means either the row does not render or the probe never reached the
// state, and both are failures. Without this gate the first version of this file
// reported OK having seen none.
const ok =
  boardsReached === GAMES &&
  stepsTaken > GAMES * 10 &&
  consoleErrors.length === 0 &&
  pageErrors.length === 0 &&
  chainItemStates > 0 &&
  triggerRowStates > 0;

console.log(
  JSON.stringify(
    {
      origin: ORIGIN,
      port: PORT,
      games: GAMES,
      boardsReached,
      stepsTaken,
      gamesOver,
      positiveControls: {
        chainItemStates,
        triggerRowStates,
        decisionsSeen,
        decisionsAnswered,
        decisionTitles: Object.fromEntries(decisionTitles),
        triggerNames: Object.fromEntries(triggerNames),
      },
      failures: { consoleErrors: consoleErrors.slice(0, 10), pageErrors: pageErrors.slice(0, 10) },
    },
    null,
    1,
  ),
);
console.log(`live-triggers: ${ok ? "OK" : "FAIL"}`);
process.exit(ok ? 0 : 1);
