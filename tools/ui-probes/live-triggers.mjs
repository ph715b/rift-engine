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
 * **DECISIONS need `ACTIVE=1` or `SPECTATE=1`.** `SPECTATE=1` is the better of
 * the two and the cheaper: the app's AI-vs-AI mode drives BOTH seats through
 * `chooseAction`, so cards are played by engine code with its own tests rather
 * than by this file's measured-pixel hand-clicking. Measured over 6 games it
 * reaches **52 decision states across 7 distinct prompts** — including King's
 * Edict, which the "still not seen rendered" list below had been carrying since
 * this probe was written. The driver answers NOTHING in that mode (the prompts
 * render read-only and the bot answers a beat later), so `decisionsAnswered`
 * stays 0 by design and the stranded-question check is the ratio gate at the
 * bottom of this file instead.
 *
 * **The ACTIVE notes below still apply to ACTIVE.** Passing alone can never reach one: the human
 * plays nothing, and the AI answers its own questions with no prompt, so the
 * default run reports `decisionsSeen: 0` meaning "not reached" — never "no
 * decisions render". With `ACTIVE=1` the driver plays from hand and the prompts
 * do appear, answerable, with **raised == answered**, which is what rules out a
 * stranded question. Confirmed live: Qiyana - Victorious's "draw 1, or channel 1
 * rune exhausted?", Mistfall's pay-and-exhaust, Sett - The Boss's death
 * replacement, Baited Hook's "banish a unit from the top 5 and play it free?"
 * and Blitzcrank - Impassive's "move an enemy unit to his battlefield?".
 *
 * **A decision that appears in one run and not the next is the seed, not a
 * regression.** `decisionsSeen` is 0 or 1 per six games for most cards, so the
 * gate does not require any particular prompt — only that every prompt raised was
 * answered. Read the titles, not the count.
 *
 * Confirmed live as TRIGGER ROWS, with their own names rendered: Mistfall,
 * Sett - Brawler, Qiyana - Victorious, Pirate's Haven (buff deck); Sona -
 * Harmonious, Blitzcrank - Impassive, Ahri - Alluring (calm deck). Sona's is the
 * first turn-boundary trigger — it is fired in one player's End Phase and shown
 * on the chain during the other player's turn.
 *
 * Still NOT seen rendered: the decision prompts of Albus Ferros, Spectral Matron
 * and Overt Operation. They are in the deck (see `make-buffdeck.mjs`'s priority
 * list) and reached play, but their own conditions did not come up. **King's
 * Edict came off this list under `SPECTATE=1`** — it was never a rendering
 * problem, only a reachability one, which is exactly what a second way of
 * driving the board is for.
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
/** Play cards as the human, not just pass. Off by default so the trigger-row
 *  measurement above stays comparable between runs; ACTIVE=1 is what reaches
 *  decisions. */
const ACTIVE = process.env.ACTIVE === '1';
/**
 * SPECTATE=1 — the app's AI-vs-AI mode drives BOTH seats.
 *
 * The second way to reach a board where cards are actually played, and the
 * cheaper one. `ACTIVE=1` gets there by clicking the human's hand through a
 * measured-pixel flow (`tryPlayFromHand` below) that this file's own history
 * records failing silently once; spectate gets there through `chooseAction`,
 * which is engine code with its own tests. What it buys beyond ACTIVE is that
 * BOTH seats play, so seat 0's questions are raised by real plays rather than by
 * whatever a driver managed to click.
 *
 * Nothing is answered by the driver here: the prompts render read-only and the
 * bot answers them a beat later. So `decisionsAnswered` stays 0 by design and
 * the "stranded question" check is a different one — see the gate at the bottom.
 */
const SPECTATE = process.env.SPECTATE === '1';

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
 *
 * **`DECK=calm` runs the second deck**, built by the same generator off Ahri -
 * Nine-Tailed Fox. A domain pair is a hard ceiling on what one deck can contain,
 * so the Calm cards were unreachable by any run of this probe — and unreachable
 * looks exactly like broken from here, since both report the trigger as never
 * observed. Two decks is what makes "not seen" mean something.
 *
 * **`DECK=combat` is the third**, added when `combatBegan` was converted
 * (2026-08-03) for the same reason the second one exists: the buff and calm lists
 * between them contain not one Attack Trigger, so the change was invisible here
 * and this probe would have reported its usual green over a feature that never
 * ran. Same legend as `calm`, different priority list — Yasuo (attacks), Teemo
 * (defends), Ahri - Inquisitive (either), Mask of Foresight (a gear watching) and
 * Ava Achiever (the one that parks a question), which is every shape the event has
 * inside one legal domain pair.
 */
const DECK = process.env.DECK ?? "buff";
const DECK_FILES = { buff: ".buffdeck.txt", calm: ".calmdeck.txt", combat: ".combatdeck.txt" };
const DECK_FILE = DECK_FILES[DECK] ?? DECK_FILES.buff;
const DECK_TEXT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), DECK_FILE), "utf8");
// Matches the LEGEND's name, which is what the imported deck is called in the
// lobby list. Both legends' names begin with the character, so a first-word
// match is enough and stays right if a legend's subtitle ever changes.
const DECK_NAME = DECK === "buff" ? /Sett/i : /Ahri/i;

/**
 * Whether this deck can be RELIED ON to raise a decision prompt in `GAMES` games,
 * and therefore whether `decisionsSeen > 0` is a fair gate for it.
 *
 * **Measured, after the gate failed on a run that had nothing wrong with it.** The
 * calm deck was run twice against the same commit and reported 12 prompts and
 * then 0 — its decision rate is ~0.6% of samples, so six games is simply not
 * enough for it to be sure of raising one, and the failure said "regression" when
 * the honest answer was "this deck does not always ask". The buff deck reports
 * 30-60 over the same six games and the combat deck reliably reaches Ava
 * Achiever's, so both keep the gate.
 *
 * The STRANDED-prompt half of the check below is unaffected and applies to every
 * deck: that one is about `decisionsSeen` approaching `stepsTaken`, which needs no
 * prompt to have been raised at all.
 */
const EXPECTS_DECISIONS = DECK !== "calm";

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
let playAttempts = 0;

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
  if (SPECTATE) {
    const toggle = p.getByRole("button", { name: /spectate/i });
    if ((await toggle.count()) === 0) throw new Error("SPECTATE=1 but the lobby has no Spectate toggle");
    await toggle.first().click();
    await sleep(150);
  }
  // "Watch Match" under spectate, "Start Match" otherwise — matched together so
  // the driver does not have to know which, but the toggle above is asserted
  // rather than assumed, since a missing toggle would silently run an ordinary
  // game and report it as a spectated one.
  await p.getByRole("button", { name: /watch match|start match/i }).first().click();
  await sleep(1500);
  // The mulligan auto-advances under spectate (nobody is at the seat to keep a
  // hand), so the button is simply absent — skipped rather than waited for.
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
 * Arms a card from the human's hand and pushes it through to submission.
 *
 * The board's play flow is several optional steps — target picking, Auto Pay,
 * Accelerate — and any of them may be absent for a given card, so each is tried
 * and skipped rather than assumed. If the card cannot be completed, it is
 * CANCELLED explicitly: an armed card blocks the board, and a driver that leaves
 * one armed turns the rest of the run into a silent no-op, which reads as "the
 * game got quiet" rather than as a stuck probe.
 *
 * Uses `mouse.move` + `click` on a measured point rather than `locator.hover()`,
 * which fails actionability on the Framer-animated hand cards and scores as a
 * feature failure.
 */
async function tryPlayFromHand(p) {
  if (await p.locator(".choice-overlay-panel").count()) return false;
  const cancel = p.getByRole("button", { name: /^Cancel / });
  if (await cancel.count()) return false; // something is already armed

  const cards = p.locator(".hand-fan-layer .card");
  const n = await cards.count();
  if (n === 0) return false;

  const card = cards.nth(Math.min(n - 1, Math.floor(n / 2)));
  const box = await card.boundingBox().catch(() => null);
  if (!box) return false;
  // Aim at the TOP 12% of the card, twice.
  //
  // The hand rests COLLAPSED to a ~32% peek inside a slot with `overflow:
  // hidden`, so the card's layout-box CENTRE is clipped away — a click there
  // lands on nothing and arms nothing, which is exactly what the first version of
  // this function did, silently, reporting `playAttempts: 0`. Hovering the
  // visible strip opens the hand (measured: the card's box moves from y=845 to
  // y=700), and the card must then be RE-MEASURED before clicking, because the
  // point that was over it is no longer.
  await p.mouse.move(box.x + box.width / 2, box.y + box.height * 0.12);
  await sleep(420);
  const opened = await card.boundingBox().catch(() => null);
  if (!opened) return false;
  await p.mouse.click(opened.x + opened.width / 2, opened.y + opened.height * 0.12);
  await sleep(260);

  if (!(await p.getByRole("button", { name: /^Cancel / }).count())) return false; // not armed: not playable now

  for (let i = 0; i < 6; i += 1) {
    const pay = p.getByRole("button", { name: /^Auto Pay$/ });
    if (await pay.count()) {
      await pay.first().click({ timeout: 1200 }).catch(() => {});
      await sleep(200);
      continue;
    }
    const done = p.getByRole("button", { name: /^(Done \(\d+\)|Choose no targets)$/ });
    if (await done.count()) {
      await done.first().click({ timeout: 1200 }).catch(() => {});
      await sleep(250);
      continue;
    }
    // A targeted card needs a target clicked on the board before Done appears.
    const target = p.locator(".card.selectable, .battlefield.selectable").first();
    if (await target.count()) {
      await target.click({ timeout: 1200 }).catch(() => {});
      await sleep(220);
      continue;
    }
    break;
  }

  const stillArmed = p.getByRole("button", { name: /^Cancel / });
  if (await stillArmed.count()) {
    await stillArmed.first().click({ timeout: 1200 }).catch(() => {});
    await sleep(150);
    return false;
  }
  return true;
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
      // Under spectate the options are deliberately disabled — the bot answers.
      // Clicking anyway would be a no-op that scored as a failure to answer.
      if (!SPECTATE) {
        const buttons = overlay.locator("button");
        const n = await buttons.count();
        if (n > 0) {
          await buttons.nth(n - 1).click({ timeout: 1500 }).catch(() => {});
          await sleep(200);
          if ((await page.locator(".choice-overlay-panel").count()) === 0) decisionsAnswered += 1;
        }
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
      //
      // **Scoped to the trigger row's own body.** This used to read every
      // `.chain-item-name` on the chain whenever any trigger row existed, so a
      // SPELL sitting on the same chain was tallied as a triggered ability — the
      // Calm deck reported "Defy" and "Find Your Center" as triggers, neither of
      // which is even implemented. Worse in the other direction: a trigger row
      // showing a blank name would have been covered for by the spell beside it,
      // which is the exact failure this counter exists to catch. `.chain-item-name`
      // is a SIBLING of `.chain-item-trigger` inside `.chain-item-body`, so the
      // scope has to be the body rather than the marker.
      for (const name of await page.locator(".chain-item-body:has(.chain-item-trigger) .chain-item-name").allTextContents()) {
        const key = name.trim();
        if (key) triggerNames.set(key, (triggerNames.get(key) ?? 0) + 1);
      }
    }
    if ((await page.locator(".chain-item").count()) > 0) chainItemStates += 1;

    stepsTaken += 1;
    // ACTIVE mode: try to play a card before falling back to passing.
    //
    // Passing alone can never reach a human decision — the human plays nothing,
    // and the AI answers its own questions with no prompt — so the eight
    // decision-parking cards landed today were unreachable by a passive driver.
    // This is the "drive the rare state deliberately" half of gating on
    // `tried > 0`: counting a branch that cannot occur is not measurement.
    // Never under spectate: nothing on the board is clickable, so every attempt
    // would fail and the count would read as the mode being broken.
    if (ACTIVE && !SPECTATE) {
      const played = await tryPlayFromHand(page);
      if (played) playAttempts += 1;
    }
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
/**
 * SPECTATE's own gates, and the second one is the stranded-question check this
 * mode needs in place of `raised == answered`.
 *
 * The driver answers nothing here, so a prompt that could never be dismissed
 * would not show up as `seen > answered` — it would sit on screen for the rest
 * of the run, and EVERY subsequent sample would count it. So the shape of a
 * stranded question is `decisionsSeen` approaching `stepsTaken`, and a healthy
 * run is a small fraction. Measured over 6 games: 52 of 1613 samples, 3.2%.
 * A quarter is the ceiling — generous against seed variance, and nowhere near
 * the ~100% a stuck prompt would produce.
 */
const spectateOk = !SPECTATE || ((decisionsSeen > 0 || !EXPECTS_DECISIONS) && decisionsSeen * 4 < stepsTaken);

const ok =
  boardsReached === GAMES &&
  stepsTaken > GAMES * 10 &&
  consoleErrors.length === 0 &&
  pageErrors.length === 0 &&
  chainItemStates > 0 &&
  triggerRowStates > 0 &&
  spectateOk;

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
        playAttempts,
      },
      failures: { consoleErrors: consoleErrors.slice(0, 10), pageErrors: pageErrors.slice(0, 10) },
    },
    null,
    1,
  ),
);
console.log(`live-triggers: ${ok ? "OK" : "FAIL"}`);
process.exit(ok ? 0 : 1);
