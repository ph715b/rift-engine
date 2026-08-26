import { describe, expect, it, afterEach } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { allPresetDecks, presetDeckList } from "@rift-engine/engine";
import { GameBoard } from "../src/components/GameBoard.js";
import { HoverPreviewProvider } from "../src/hover-preview.js";
import { DragGhostProvider } from "../src/drag-ghost.js";
import type { MatchConfig } from "../src/game-setup.js";

/**
 * **An armed card that can never resolve now says so.**
 *
 * A refusal was already shown — `submit` returning `Invalid` puts the engine's
 * own message in the header. But there is a second failure that looks identical
 * from the seat and had no feedback at all: the action is never SUBMITTED, so
 * there is nothing to refuse. Every choice is made, no enumerated action matches
 * them, and the card just sits there.
 *
 * **That is exactly how Tideturner presented.** Played from hidden with a swap
 * target chosen, its pending state was missing `destinationBattlefieldId`, so
 * `matchesPending` compared "bf1" against "base" and matched nothing. From the
 * seat: click the card, click the target, press Pass Focus, and the board does
 * nothing whatsoever. It cost a bug report and a debugging session.
 *
 * # What this file does NOT cover, and why that is stated rather than hidden
 *
 * **The positive case — the message actually appearing — is not tested here.**
 * Reaching the stuck state through the rendered board needs a bug to be present,
 * and the bug that produced it is fixed.
 *
 * A first version of this file tried anyway, with three tests that armed a card
 * and clicked through a turn. **All three were vacuous**, and a mutation caught
 * it: with `matchesPending` forced to return `false` — the exact Tideturner shape
 * — every test still passed. The board renders four hand cards on a fresh game
 * and *none of them is selectable*, so `if (!playable) return` skipped the body
 * every time. They were asserting nothing at all.
 *
 * Driving the board to a playable state is not currently possible from a test:
 * `GameBoard` seeds its own game with `Date.now()`, so there is no reproducible
 * opening board to search for one. That is worth fixing on its own account — a
 * game you cannot reproduce is a game you cannot report a bug against — but it is
 * a different change from this one.
 *
 * **Measured, not assumed — two mutants, and only one dies.** Breaking the hand
 * selector back to `.hand-fan` (the original mistake) IS caught, so this file can
 * no longer silently measure nothing. Forcing the notice to fire unconditionally
 * is NOT caught, because nothing on a fresh board is armable for it to fire
 * against. That second result is the limitation above, confirmed rather than
 * argued: **the cry-wolf guard here is real only for the states a fresh board can
 * reach**, and a playable-state harness is what would extend it.
 *
 * So what is left is the half that IS real and IS worth guarding: **the notice
 * must not cry wolf.** A message that appears during an ordinary turn would be
 * worse than no message, because it would train the player to ignore the one case
 * it exists for. The stuck branch itself is guarded indirectly by
 * `hidden-play-seed.test.ts`, whose mutant reintroduces the precise bug this
 * message describes.
 */

const [first, second] = allPresetDecks();
const config: MatchConfig = {
  humanDeck: presetDeckList(first!),
  aiDeck: presetDeckList(second ?? first!),
  format: "bo1",
};

afterEach(cleanup);

/** The board, past the mulligan it opens on. */
function boardInPlay(): HTMLElement {
  // Both providers `App` supplies: `CardView` calls `useCardHover` and
  // `useDragGhost`, which throw without them. Rendering GameBoard bare fails as a
  // component error, which reads as "the board is broken" rather than as "the
  // test rendered it wrong".
  const { container } = render(
    <HoverPreviewProvider>
      <DragGhostProvider>
        <GameBoard initialConfig={config} onMainMenu={() => {}} />
      </DragGhostProvider>
    </HoverPreviewProvider>,
  );
  const confirm = container.querySelector<HTMLButtonElement>("button.menu-primary-button");
  expect(confirm, "the mulligan's confirm button was not found — the board did not render").not.toBeNull();
  fireEvent.click(confirm!);
  expect(container.querySelector(".board"), "still on the mulligan — the board never became live").not.toBeNull();
  return container;
}

const notice = (container: HTMLElement) => container.querySelector(".header-notice")?.textContent ?? null;

describe("the board this file is querying really is there", () => {
  /**
   * **The controls, and they exist because the first version of this file had
   * none and was measuring nothing.** Its selectors were `.hand-fan .card`; the
   * real class is `.hand-fan-layer`, so every query returned an empty list and
   * every assertion below it was trivially satisfied.
   */
  it("renders a hand", () => {
    const container = boardInPlay();
    expect(
      container.querySelectorAll(".hand-fan-layer .card").length,
      "no hand cards — this file's selectors have drifted again",
    ).toBeGreaterThan(0);
  });

  it("renders a header, which is where a notice would go", () => {
    // `applyAction` renders a refusal into `.header-notice` inside `.header`. If
    // that element stopped existing, "no notice" below would be true forever.
    expect(boardInPlay().querySelector(".header"), "no header to hold a notice").not.toBeNull();
  });
});

describe("the notice does not cry wolf", () => {
  it("says nothing on a freshly live board", () => {
    // Nothing is armed, so nothing could have failed to resolve. This is the one
    // assertion the fresh board can genuinely make — and a false positive here
    // would greet every player with a warning on turn one.
    expect(notice(boardInPlay()), "the board greeted the player with a warning").toBeNull();
  });

  it("says nothing after passing the turn", () => {
    // Passing runs the AI's turn and returns priority, which is the most state
    // churn reachable from here without a playable card. The effect that raises
    // the notice runs on every `legal` change, so this exercises it repeatedly.
    const container = boardInPlay();
    const pass = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      /^pass/i.test(b.textContent ?? ""),
    );
    if (pass) fireEvent.click(pass);

    expect(notice(container), "passing the turn produced a spurious warning").toBeNull();
  });
});
