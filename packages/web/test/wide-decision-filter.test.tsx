import { describe, expect, it, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { optionsFor, type GameState, type PendingDecision } from "@rift-engine/engine";
import { DecisionPrompt } from "../src/components/DecisionPrompt.js";
import { HoverPreviewProvider } from "../src/hover-preview.js";
import { DragGhostProvider } from "../src/drag-ghost.js";
import { createNewGame } from "../src/game-setup.js";
import { allPresetDecks, presetDeckList } from "@rift-engine/engine";

/**
 * **A question can be 233 options wide, and a row of buttons is not a control.**
 *
 * Fallen Feline (VEN-132) is "when you play me, name a spell", and rule 762
 * bounds that to any card legal in the format — so the engine offers every spell
 * in the pool. `.choice-overlay-actions` was a single un-wrapped flex row, which
 * means the engine would have been asking a question the board could not show.
 *
 * That is this repo's most-repeated web failure and it has its own note in
 * memory: the mechanic is correct, tested, and reported exercised, while the
 * human has nothing to click. Four playtest reports in one day were this exact
 * shape.
 *
 * These tests are therefore about BEHAVIOUR, not about the DOM containing an
 * element — the other lesson from that day, where a set of presence-only
 * assertions passed against a board nobody could use. Each one either answers
 * the question or proves an option is reachable.
 */

const renderPrompt = (state: GameState, decision: PendingDecision, onAnswer: (id: string) => void = () => {}) =>
  render(
    <HoverPreviewProvider>
      <DragGhostProvider>
        <DecisionPrompt state={state} decision={decision} onAnswer={onAnswer} />
      </DragGhostProvider>
    </HoverPreviewProvider>,
  );

/** The Feline's real question, against a real game state — the option list comes
 *  from the ENGINE, so a test here cannot drift from what she actually offers. */
const NAMING: PendingDecision = { id: "d1", kind: "VEN-132-name", playerIndex: 0 };

/** Built through the real setup path rather than as a state literal — the same
 *  reason its sibling tests give, and the reason three headless probes once
 *  drifted out of sync with GameState while reporting plausible numbers. */
function gameState(): GameState {
  const [first, second] = allPresetDecks();
  return createNewGame(
    { humanDeck: presetDeckList(first!), aiDeck: presetDeckList(second ?? first!), format: "bo1" },
    12345,
  );
}

const buttonLabels = (container: HTMLElement): string[] =>
  [...container.querySelectorAll(".choice-overlay-actions button")].map((b) => b.textContent ?? "");

const filterBox = (container: HTMLElement): HTMLInputElement =>
  container.querySelector(".decision-option-filter") as HTMLInputElement;

describe("a decision too wide for a row of buttons", () => {
  it("offers every spell the ENGINE offers — the fixture is not a sample", () => {
    // The premise for everything below. If the engine's own list were small,
    // every assertion in this file would be vacuously satisfied.
    const state = gameState();
    expect(optionsFor(state, NAMING).length).toBeGreaterThan(200);
    cleanup();
  });

  it("renders a filter box rather than 233 buttons in one row", () => {
    const state = gameState();
    const { container } = renderPrompt(state, NAMING);

    expect(filterBox(container), "a 233-option question rendered with no way to search it").not.toBeNull();
    // The grid WRAPS and scrolls — the class carrying that is what stops the
    // overlay growing past the screen.
    expect(container.querySelector(".choice-overlay-actions-wide")).not.toBeNull();
    cleanup();
  });

  it("narrows the list as you type, and the match is a SUBSTRING", () => {
    const state = gameState();
    const { container } = renderPrompt(state, NAMING);
    const before = buttonLabels(container).length;

    fireEvent.change(filterBox(container), { target: { value: "guard" } });
    const after = buttonLabels(container);

    expect(after.length, "typing narrowed nothing").toBeLessThan(before);
    expect(after.length, "typing narrowed everything away").toBeGreaterThan(0);
    // Substring, not prefix — every survivor contains it somewhere.
    expect(after.every((label) => label.toLowerCase().includes("guard"))).toBe(true);
    // ...and at least one survivor does NOT start with it, which is the half a
    // prefix match would have thrown away.
    expect(after.some((label) => !label.toLowerCase().startsWith("guard"))).toBe(true);
    cleanup();
  });

  it("ignores case, so a lowercase search finds a capitalised name", () => {
    const state = gameState();
    const { container } = renderPrompt(state, NAMING);

    fireEvent.change(filterBox(container), { target: { value: "cleave" } });
    expect(buttonLabels(container), "a lowercase search missed the card").toContain("Cleave");
    cleanup();
  });

  it("ANSWERS with the filtered option — the whole point of the control", () => {
    // The behaviour assertion. A filter that shows the right button but answers
    // with the wrong id is worse than no filter at all.
    const onAnswer = vi.fn();
    const state = gameState();
    const { container } = renderPrompt(state, NAMING, onAnswer);

    fireEvent.change(filterBox(container), { target: { value: "cleave" } });
    const cleave = [...container.querySelectorAll(".choice-overlay-actions button")].find(
      (b) => b.textContent === "Cleave",
    );
    fireEvent.click(cleave!);

    expect(onAnswer).toHaveBeenCalledWith("Cleave");
    cleanup();
  });

  it("says so when nothing matches, instead of showing an empty dialog", () => {
    // This question cannot be cancelled, so a blank panel under a search box is
    // indistinguishable from a broken one.
    const state = gameState();
    const { container } = renderPrompt(state, NAMING);

    fireEvent.change(filterBox(container), { target: { value: "zzzzzz no such spell" } });

    expect(buttonLabels(container)).toEqual([]);
    expect(container.querySelector(".decision-option-empty")?.textContent ?? "").toContain("No option matches");
    cleanup();
  });

  it("does not carry a filter over to the NEXT question", () => {
    // This component stays mounted across consecutive decisions, and a stale
    // filter is worse than a stale collapsed bar: it HIDES options, so the next
    // question opens already narrowed by a word typed at the previous one.
    const state = gameState();
    const { container, rerender } = renderPrompt(state, NAMING);
    fireEvent.change(filterBox(container), { target: { value: "cleave" } });
    expect(buttonLabels(container).length, "the filter did not take at all").toBeLessThan(10);

    rerender(
      <HoverPreviewProvider>
        <DragGhostProvider>
          <DecisionPrompt state={state} decision={{ ...NAMING, id: "d-next" }} onAnswer={() => {}} />
        </DragGhostProvider>
      </HoverPreviewProvider>,
    );

    expect(filterBox(container).value, "the box still holds the last question's text").toBe("");
    expect(buttonLabels(container).length, "the next question opened already narrowed").toBeGreaterThan(200);
    cleanup();
  });

  it("leaves an ORDINARY question exactly as it was — the control", () => {
    // Every other question in the pool is well under the threshold, and none of
    // them should sprout a search box. A yes/no with a filter above it is the
    // regression this control exists to catch.
    const state = gameState();
    const narrow: PendingDecision = { id: "d2", kind: "draw", playerIndex: 0, count: 1 };
    const { container } = renderPrompt(state, narrow);

    // Non-vacuous in both directions: the control really does render BUTTONS, so
    // "no filter box" is a statement about the threshold rather than about an
    // empty dialog.
    expect(buttonLabels(container).length, "the control question rendered no buttons at all").toBeGreaterThan(0);
    expect(optionsFor(state, narrow).length).toBeLessThan(20);
    expect(filterBox(container), "an ordinary question grew a filter box").toBeNull();
    expect(container.querySelector(".choice-overlay-actions-wide")).toBeNull();
    cleanup();
  });
});
