import { describe, expect, it, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { allPresetDecks, presetDeckList } from "@rift-engine/engine";
import { GameBoard } from "../src/components/GameBoard.js";
import { HoverPreviewProvider } from "../src/hover-preview.js";
import { DragGhostProvider } from "../src/drag-ghost.js";
import type { MatchConfig } from "../src/game-setup.js";

/**
 * **Conceding — 650, "A player may concede at any time."**
 *
 * There was no way to lose on purpose. Restart and Main Menu ABANDON a match;
 * neither records a result, and in a Best of 3 neither advances the series. A
 * player who wanted out of a game they had lost had to play it out or throw the
 * whole match away.
 *
 * **651.1** does the work: the player remaining wins. So a concession sets this
 * game's result to `GameOver` with the opponent as winner and reaches the board's
 * ordinary game-over path — the series banks it, 407.4's loser-goes-first
 * tracking reads it, and the between-games panel appears exactly as it would for
 * a defeat on the board.
 *
 * **Tournament 410.1 and 410.2 are two different acts** — concede the game, or
 * concede the match — and in a Best of 3 with games left the prompt has to say
 * which, or it lies at the one moment the player needs the truth.
 *
 * # The seed is what makes this testable
 *
 * `GameBoard` seeded itself with `Date.now()` until 2026-08-26, so no test could
 * reach a specific board. It takes a `seed` now, which is what lets this file
 * drive a real match rather than render a component with hand-built props.
 */

const [first, second] = allPresetDecks();
const bo1: MatchConfig = {
  humanDeck: presetDeckList(first!),
  aiDeck: presetDeckList(second ?? first!),
  format: "bo1",
};
const bo3: MatchConfig = { ...bo1, format: "bo3" };

afterEach(cleanup);

function boardInPlay(config: MatchConfig = bo1): HTMLElement {
  const { container } = render(
    <HoverPreviewProvider>
      <DragGhostProvider>
        <GameBoard initialConfig={config} onMainMenu={() => {}} seed={5} />
      </DragGhostProvider>
    </HoverPreviewProvider>,
  );
  // A Bo3 stops at the battlefield chooser first, and that screen is a row of
  // battlefield buttons rather than a primary-button confirm — so this walks
  // whichever screen is in front of it until the hand appears.
  for (let i = 0; i < 4 && !container.querySelector(".hand-fan-layer"); i += 1) {
    const battlefield = container.querySelector<HTMLButtonElement>(".battlefield-select button");
    if (battlefield) {
      fireEvent.click(battlefield);
      continue;
    }
    const next = container.querySelector<HTMLButtonElement>("button.menu-primary-button");
    if (!next) break;
    fireEvent.click(next);
  }
  expect(container.querySelector(".hand-fan-layer"), "the board never became live").not.toBeNull();
  return container;
}

const button = (name: RegExp) => screen.queryByRole("button", { name });

describe("the concede button", () => {
  it("is offered during a live game", () => {
    boardInPlay();
    expect(button(/^concede$/i), "no way to concede a game in progress").not.toBeNull();
  });

  it("asks before doing it", () => {
    // It cannot be undone, so it takes the same two-step every other destructive
    // control in this header takes.
    const container = boardInPlay();
    fireEvent.click(button(/^concede$/i)!);
    // The PROMPT element, not any text matching /concede/ — the confirm button
    // says "Concede" too, and `getByText` refuses an ambiguous match.
    expect(
      container.querySelector(".header-exit-prompt")?.textContent ?? "",
      "conceding did not confirm first",
    ).toMatch(/concede/i);
    expect(button(/^cancel$/i), "no way back out of the prompt").not.toBeNull();
  });

  it("cancelling leaves the game alone", () => {
    // The control that makes the confirm real. Without it, "asks before doing it"
    // would pass on a prompt whose Cancel conceded anyway.
    const container = boardInPlay();
    fireEvent.click(button(/^concede$/i)!);
    fireEvent.click(button(/^cancel$/i)!);

    expect(button(/^concede$/i), "Cancel dismissed the button as well as the prompt").not.toBeNull();
    expect(container.querySelector(".hand-fan-layer"), "Cancel ended the game").not.toBeNull();
  });
});

describe("conceding ends the game with the opponent winning", () => {
  it("the OPPONENT wins it — the point of conceding", () => {
    /**
     * **The assertion a mutation run said was missing.** Awarding the win to the
     * HUMAN instead passed every other test in this file: they checked that the
     * game ended, not who won it, and "I quit" quietly reading as "I win" is the
     * one thing conceding must never do.
     *
     * **651.1** — the player remaining wins — so a Bo1 concession must show the
     * AI winning.
     */
    const container = boardInPlay(bo1);
    fireEvent.click(button(/^concede$/i)!);
    fireEvent.click(screen.getByRole("button", { name: /^concede$/i }));

    const panel = container.querySelector(".rematch-panel, .series-panel");
    expect(panel, "conceding did not end the game").not.toBeNull();
    expect(panel!.textContent ?? "", "conceding declared the CONCEDING player the winner").toMatch(/AI wins/i);
    expect(panel!.textContent ?? "", "conceding announced a win for the player who quit").not.toMatch(/You win/i);
  });

  it("reaches the game-over path", () => {
    const container = boardInPlay();
    fireEvent.click(button(/^concede$/i)!);
    fireEvent.click(screen.getByRole("button", { name: /^concede$/i }));

    // The board's own end-of-game surface. Asserted by its absence-then-presence
    // rather than by text, since the panel's wording is not this file's business.
    expect(
      container.querySelector(".rematch-panel, .series-panel"),
      "conceding did not end the game",
    ).not.toBeNull();
  });

  it("...and the concede button is gone once it has", () => {
    // Nothing left to concede. A control that is present but inert invites the
    // click it will ignore.
    boardInPlay();
    fireEvent.click(button(/^concede$/i)!);
    fireEvent.click(screen.getByRole("button", { name: /^concede$/i }));

    expect(button(/^concede$/i), "a finished game still offers to be conceded").toBeNull();
  });
});

describe("the prompt tells the truth about what is lost", () => {
  it("a Best of 1 says the MATCH is lost", () => {
    boardInPlay(bo1);
    fireEvent.click(button(/^concede$/i)!);
    expect(screen.getByText(/wins the match/i), "a Bo1 concession claimed the match continues").toBeTruthy();
  });

  it("a Best of 3 with games left says the MATCH CONTINUES", () => {
    // Tournament 410.1 rather than 410.2. Getting this backwards would tell a
    // player they were quitting the match when they were conceding one game.
    boardInPlay(bo3);
    const concede = button(/^concede$/i);
    expect(concede, "the Bo3 board never became live — the pregame walk failed").not.toBeNull();
    fireEvent.click(concede!);

    expect(screen.getByText(/match continues/i), "a Bo3 concession claimed the match was over").toBeTruthy();
  });
});
