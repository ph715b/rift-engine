/**
 * Shared boot for every live UI probe.
 *
 * These drive the REAL app in a real browser. They are in the repo, unlike the
 * engine probes' former home in a session-local scratchpad, because a probe kept
 * outside version control drifts silently — three of this project's gate probes
 * reported green for weeks while broken, and every session re-copied them from a
 * temp directory belonging to an older session.
 *
 * Playwright is a real devDependency here for the same reason: these used to
 * import it from a hardcoded path inside a THIRD session's temp directory, so the
 * whole suite would have died the moment Windows cleaned that folder — and the
 * failure would have read as "the probes are broken" rather than "the dependency
 * vanished".
 *
 * Browsers are not vendored. If `chromium.launch()` fails, run:
 *     npx playwright install chromium
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export { chromium };

/**
 * The dev server port.
 *
 * NOT hardcoded to 5173. Stale vite servers from previous sessions have been
 * observed holding 5173-5182 simultaneously, one of them warning that its own
 * config cache was out of date — so a probe aimed at a fixed port may be
 * measuring an ambiguous server rather than the one you just started.
 * Start the server, note the port it prints, and pass it as PORT.
 */
export const PORT = Number(process.env.PORT ?? 5173);
export const ORIGIN = `http://localhost:${PORT}`;

/** Where screenshots land. Gitignored — they are evidence for one run, not
 *  artefacts worth keeping. */
export const OUT = process.env.SHOT_DIR ?? join(dirname(fileURLToPath(import.meta.url)), ".shots");
mkdirSync(OUT, { recursive: true });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The four sizes every layout claim is checked at. The invariant that matters
 *  is `scrollableRows === 0` at all of them. */
export const SIZES = [
  [1600, 950],
  [1280, 800],
  [1024, 700],
  [900, 600],
];

/**
 * Landing page -> New Game -> BOTH deck pickers -> Start Match -> past mulligan.
 *
 * THROWS if it does not reach the board. A probe that silently fails to start a
 * game reports every check false, which is the single most repeated defect in
 * this project's instruments — and it looks exactly like a real regression.
 */
export async function bootToBoard(p) {
  await p.goto(ORIGIN, { waitUntil: "networkidle" });
  const ng = p.getByRole("button", { name: /new game/i });
  if (await ng.count()) {
    await ng.first().click();
    await sleep(700);
  }
  const d = p.locator("button.deck-option-button");
  const total = await d.count();
  if (total < 2) throw new Error(`lobby never rendered deck pickers (found ${total}) — is the dev server on :${PORT}?`);
  // First half of the buttons are the human's decks, second half the AI's.
  // Start Match stays disabled until BOTH are chosen; a probe that clicks only
  // Start times out on a disabled button.
  const per = total / 2;
  await d.nth(1).click();
  await sleep(150);
  await d.nth(per + 1).click();
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

/**
 * Advance the game one step, whichever control is live. Returns false when the
 * match is over.
 *
 * Every wait here is SHORT and swallowed. Playwright's 30s default turns "the
 * board is in a state with no Pass button right now" into a hung probe rather
 * than a slow step — which is what happened once a driver started arming cards
 * aggressively enough to leave a choice overlay open.
 */
const enabled = async (loc) => {
  try {
    return (await loc.count()) > 0 && (await loc.first().isEnabled({ timeout: 1200 }));
  } catch {
    return false;
  }
};

export async function step(p) {
  if (await p.locator(".rematch-panel").count()) return false;

  // An open modal blocks everything behind it, so clear it first.
  for (const name of [/^Close$/, /^Cancel$/]) {
    const btn = p.getByRole("button", { name });
    if (await enabled(btn)) {
      await btn.first().click().catch(() => {});
      await sleep(180);
      return true;
    }
  }

  const pf = p.getByRole("button", { name: "Pass Focus" });
  if (await enabled(pf)) {
    await pf.first().click().catch(() => {});
    await sleep(140);
    return true;
  }
  const pass = p.getByRole("button", { name: /^Pass$/ });
  if (await enabled(pass)) {
    await pass.first().click().catch(() => {});
    await sleep(200);
    return true;
  }
  await sleep(130);
  return true;
}
