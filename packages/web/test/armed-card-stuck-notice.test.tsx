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
 * # Measured, not argued — THREE mutants, and only one dies
 *
 * | mutant | result |
 * |---|---|
 * | `matchesPending` always false — the exact Tideturner shape | **KILLED** |
 * | the notice fires unconditionally | survives |
 * | the notice never fires at all | survives |
 *
 * **The first is the one worth having**, and it is the one this file could not
 * catch until `GameBoard` took a `seed`. Before that the board seeded itself with
 * `Date.now()`, no test could ask for a deal containing a playable card, and an
 * earlier version of this file armed nothing and asserted nothing — it passed
 * with `matchesPending` returning false, which is the bug it was written for.
 *
 * **The other two survive, and that is stated rather than glossed.** Firing
 * unconditionally is unreachable here because a one-candidate play resolves the
 * instant it is armed, so the branch that would cry wolf never runs; catching it
 * needs a card that stays mid-choice. And nothing asserts the message APPEARS,
 * because reaching a genuinely stuck board requires a bug to be present and the
 * one that produced it is fixed — `hidden-play-seed.test.ts` guards that
 * indirectly, with a mutant that reintroduces it.
 *
 * So: this file pins the regression shape and the no-false-positive rule. It does
 * not pin the message's own existence. Both halves are true and only one of them
 * used to be.
 */

const [first, second] = allPresetDecks();
const config: MatchConfig = {
  humanDeck: presetDeckList(first!),
  aiDeck: presetDeckList(second ?? first!),
  format: "bo1",
};

afterEach(cleanup);

/**
 * A seed whose opening hand actually contains a playable card.
 *
 * **Found by search, and only possible since `GameBoard` took a `seed` prop.**
 * Before that the board seeded itself with `Date.now()`, so no test could ask for
 * a particular deal — which is precisely why this file's first version armed
 * nothing and asserted nothing. Seed 5 deals a five-card hand with two
 * selectable; seeds 4, 9, 11 and 12 also work if this one ever stops.
 */
const SEED_WITH_A_PLAYABLE_CARD = 5;

/** The board, past the mulligan it opens on. */
function boardInPlay(seed = SEED_WITH_A_PLAYABLE_CARD): HTMLElement {
  // Both providers `App` supplies: `CardView` calls `useCardHover` and
  // `useDragGhost`, which throw without them. Rendering GameBoard bare fails as a
  // component error, which reads as "the board is broken" rather than as "the
  // test rendered it wrong".
  const { container } = render(
    <HoverPreviewProvider>
      <DragGhostProvider>
        <GameBoard initialConfig={config} onMainMenu={() => {}} seed={seed} />
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
    // Nothing is armed, so nothing could have failed to resolve. A false
    // positive here would greet every player with a warning on turn one.
    expect(notice(boardInPlay()), "the board greeted the player with a warning").toBeNull();
  });

  it("says nothing while a card is ARMED and still asking", () => {
    /**
     * **The case the first version of this file could not reach.** Mid-choice is
     * the ordinary reason nothing resolves yet, and it is indistinguishable from
     * stuck if the guard reads only "no resolved action" — `pendingStep()` is
     * what separates them.
     *
     * The control below is load-bearing: without it a hand with nothing
     * selectable would satisfy this test by arming nothing at all, which is
     * exactly how the vacuous version passed.
     */
    const container = boardInPlay();
    const playable = container.querySelector<HTMLElement>(".hand-fan-layer .card.selectable");
    expect(playable, "no playable card in this seed's opening hand — the seed has drifted").not.toBeNull();

    fireEvent.click(playable!);
    expect(notice(container), "arming a card warned the player before they chose anything").toBeNull();
  });

  it("says nothing after arming and then clicking a legal target", () => {
    // One step further in: a choice made, still not submitted. The effect that
    // raises the notice runs on every `legal` change, so this exercises it with a
     // half-built play on screen — the state the message must stay quiet through.
    const container = boardInPlay();
    const playable = container.querySelector<HTMLElement>(".hand-fan-layer .card.selectable");
    expect(playable, "no playable card in this seed's opening hand").not.toBeNull();
    fireEvent.click(playable!);

    const target = container.querySelector<HTMLElement>(".battlefield.targetable, .card.targetable");
    if (target) fireEvent.click(target);

    expect(notice(container), "a half-built play produced a spurious warning").toBeNull();
  });

  it("says nothing after passing the turn", () => {
    const container = boardInPlay();
    const pass = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      /^pass/i.test(b.textContent ?? ""),
    );
    if (pass) fireEvent.click(pass);

    expect(notice(container), "passing the turn produced a spurious warning").toBeNull();
  });
});
