import { describe, expect, it, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { allPresetDecks, presetDeckList } from "@rift-engine/engine";
import { GameBoard } from "../src/components/GameBoard.js";
import { HoverPreviewProvider } from "../src/hover-preview.js";
import { DragGhostProvider } from "../src/drag-ghost.js";
import type { MatchConfig } from "../src/game-setup.js";

/**
 * **The AI's turn used to be completely silent.**
 *
 * It takes several actions a turn, `AI_MOVE_DELAY_MS` apart, and every one of
 * them changed the board with no explanation. A player watching their unit die
 * had no way to learn what killed it short of reconstructing the position.
 *
 * The log holds the whole history, but it is closed by default and nobody should
 * have to open a panel to find out what just happened to them. So the newest line
 * from the AI's turn appears in the header, replaced as the turn unfolds, and
 * clears the moment the player acts — by then it is history, and the log is where
 * history lives.
 *
 * # Mutation results, including the one that does not die
 *
 * | mutant | result |
 * |---|---|
 * | the narration never appears | **KILLED** |
 * | it is never cleared when you act | **KILLED** |
 * | it shows the OLDEST line rather than the newest | survives |
 *
 * The third survives because a single AI action almost always raises exactly ONE
 * narratable line, so `at(0)` and `at(-1)` are the same value and the mutant is
 * EQUIVALENT on the play this file drives. It is not equivalent in general — a
 * play that kills something raises "played X" and "Y died", and the second is the
 * one worth reading — and the assertion that would catch it (the header equals
 * the log's newest line) is in place, waiting for a drive that reaches such an
 * action. Recorded rather than chased: forcing that case deterministically is
 * more machinery than the distinction currently earns.
 *
 * # Fake timers, and why they are load-bearing here
 *
 * The AI acts on a `setTimeout`. Without advancing it the board simply sits on
 * the human's turn and every assertion below would be about a game that never
 * moved — the vacuous shape this suite has already shipped once. The control
 * asserts the AI actually got a turn before anything else is checked.
 */

const [first, second] = allPresetDecks();
const config: MatchConfig = {
  humanDeck: presetDeckList(first!),
  aiDeck: presetDeckList(second ?? first!),
  format: "bo1",
};

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function boardInPlay(): HTMLElement {
  const { container } = render(
    <HoverPreviewProvider>
      <DragGhostProvider>
        <GameBoard initialConfig={config} onMainMenu={() => {}} seed={5} />
      </DragGhostProvider>
    </HoverPreviewProvider>,
  );
  fireEvent.click(container.querySelector<HTMLButtonElement>("button.menu-primary-button")!);
  return container;
}

const narration = (c: HTMLElement) => c.querySelector(".header-ai-narration")?.textContent ?? null;
const logLineCount = (c: HTMLElement) => c.querySelectorAll(".game-log-row").length;

/**
 * Drives the board until the AI has actually taken a turn.
 *
 * **Passing once is not enough, and assuming it was is how the first version of
 * this file measured nothing.** A Pass raises an end-of-turn trigger, that
 * trigger goes on the chain, and priority comes straight back to the human —
 * the header reads "Spell pending resolution — your priority" and the AI effect,
 * which only runs while the human CANNOT act, never fires. The log had one line
 * in it and every line was the human's own.
 *
 * So this presses whatever ends the turn, advances the AI's timer, and repeats
 * until a line attributable to the AI appears. Returns whether it got there, so
 * callers assert on it rather than silently testing an empty board.
 */
function playUntilAiActs(container: HTMLElement, rounds = 12): boolean {
  for (let i = 0; i < rounds; i += 1) {
    if (container.querySelector(".game-log-text.theirs")) return true;
    const advance = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      /^pass/i.test(b.textContent ?? ""),
    );
    if (advance) fireEvent.click(advance);
    act(() => {
      vi.advanceTimersByTime(4000);
    });
  }
  return container.querySelector(".game-log-text.theirs") !== null;
}

/**
 * The Pass button, once it is actually usable.
 *
 * **A disabled button's click is a no-op**, and `<button disabled>` is exactly
 * what the board renders while it is the AI's turn — so a test that clicked it
 * without waiting was asserting against an action that never happened. That is
 * what "the AI narration outlived the player acting" turned out to mean: nothing
 * had acted.
 */
function passWhenPlayable(container: HTMLElement, rounds = 12): HTMLButtonElement | null {
  for (let i = 0; i < rounds; i += 1) {
    const pass = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => /^pass/i.test(b.textContent ?? "") && !b.disabled,
    );
    if (pass) return pass;
    act(() => {
      vi.advanceTimersByTime(4000);
    });
  }
  return null;
}

/** Opens the log panel, so its rows can be read. */
function openLog(container: HTMLElement) {
  const toggle = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    /^log/i.test(b.textContent ?? ""),
  );
  expect(toggle, "no log toggle — the board did not render").toBeDefined();
  if (!container.querySelector(".game-log")) fireEvent.click(toggle!);
}

describe("nothing is claimed before the AI has played", () => {
  it("the header is silent on a freshly live board", () => {
    // Whatever the seat order, no AI action has happened yet at this point.
    expect(narration(boardInPlay()), "the board narrated an AI turn that had not happened").toBeNull();
  });
});

describe("the AI's actions are narrated as they happen", () => {
  it("a line appears once the AI has acted", () => {
    vi.useFakeTimers();
    const container = boardInPlay();
    // Opened FIRST: the driver watches for a line attributable to the AI, and
    // those rows do not exist in the DOM while the panel is closed.
    openLog(container);

    const aiPlayed = playUntilAiActs(container);
    // **The control.** Without it, "no narration" and "the AI never got a turn"
    // are the same result — which is exactly how the first version of this file
    // passed while measuring nothing.
    expect(aiPlayed, "the AI never acted, so this test measures nothing").toBe(true);

    expect(narration(container), "the AI acted and the header said nothing").not.toBeNull();
  });

  it("the header line is one the LOG also recorded, not a separate story", () => {
    // Both come from one recorder. If they could disagree, the header would be a
    // second narration free to drift from the history the log keeps.
    vi.useFakeTimers();
    const container = boardInPlay();
    openLog(container);
    expect(playUntilAiActs(container), "the AI never acted").toBe(true);

    const line = narration(container);
    expect(line, "nothing to compare — the header is empty").not.toBeNull();
    const logTexts = [...container.querySelectorAll(".game-log-text")].map((el) => el.textContent);
    expect(logTexts, "the header narrated something the log never recorded").toContain(line);

    // **And it is the NEWEST line, not just some line.** The log is oldest-first,
    // so the AI's most recent action is at the bottom. Showing an earlier line
    // would narrate a stale moment while the board displayed a newer one — most
    // visibly when one action raises several lines, as a play that kills
    // something does: "played X" and "Y died" both arrive, and the second is the
    // one worth reading.
    expect(logTexts.at(-1), "the header showed an older line than the log's newest").toBe(line);
  });

  it("clears the moment the player acts", () => {
    // By then it is history, and the log is where history lives. A stale line
    // sitting through the player's own turn would claim the AI had just moved.
    vi.useFakeTimers();
    const container = boardInPlay();
    openLog(container);
    expect(playUntilAiActs(container), "the AI never acted").toBe(true);
    expect(narration(container)).not.toBeNull();

    const pass = passWhenPlayable(container);
    expect(pass, "the turn never came back to the player — cannot test the clear").not.toBeNull();
    fireEvent.click(pass!);

    expect(narration(container), "the AI narration outlived the player acting").toBeNull();
  });
});
