import { describe, expect, it, afterEach } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { ChoiceOverlay } from "../src/components/ChoiceOverlay.js";

/**
 * **Minimizing a decision panel.**
 *
 * Requested from playtesting: *"would like to be able to minimize selection
 * popups so that you can see boardstate before making a decision."*
 *
 * The panel covers the board at exactly the moment the board matters most.
 * "Each player must kill one of their units" is unanswerable without seeing
 * which units you have and where they are standing, and a mandatory decision
 * has no Cancel — so before this the only way to look was to answer and find
 * out.
 *
 * # What minimizing is, and what it must never become
 *
 * It hides the VIEW, never the question. Nothing is submitted, nothing is
 * defaulted, and the game cannot advance while it is collapsed — the engine
 * offers no legal action but an answer (rule 321). That is why it is offered for
 * mandatory decisions at all: they are the ones you cannot otherwise escape to
 * look at the board.
 *
 * # The assertion that earns this file
 *
 * **A NEW question must open expanded.** Minimize one, answer it, and if the
 * next opened collapsed the player would be staring at an idle-looking board
 * with the only clue a bar they had just learned to ignore. That is a worse
 * failure than the one being fixed, because it is silent.
 *
 * It is keyed on `resetKey` — the decision's id — rather than on the title,
 * because two questions in a row can share wording exactly: Cull the Weak asks
 * both players to kill one of their own units, in the same words. A title-keyed
 * reset would collapse the second.
 */

afterEach(cleanup);

const PROMPT = "Cull the Weak: kill one of your units";

describe("a decision panel can be minimized to see the board", () => {
  it("shows the panel and a minimize control by default", () => {
    render(
      <ChoiceOverlay title={PROMPT} resetKey="d1">
        <button>Kill Poro</button>
      </ChoiceOverlay>,
    );

    expect(screen.getByText(PROMPT)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Kill Poro" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Minimize" })).toBeTruthy();
  });

  it("minimizing hides the choices and the backdrop, and leaves a restore bar", () => {
    const { container } = render(
      <ChoiceOverlay title={PROMPT} resetKey="d1">
        <button>Kill Poro</button>
      </ChoiceOverlay>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));

    // The options are gone — that is the point, the board is what you want to see.
    expect(screen.queryByRole("button", { name: "Kill Poro" })).toBeNull();
    // **The backdrop must be GONE, not transparent.** A transparent full-screen
    // backdrop would still swallow every click and hover, leaving the board
    // visible and dead — which looks interactive and is not.
    expect(container.querySelector(".choice-overlay-backdrop"), "the backdrop still covers the board").toBeNull();
    // And the question is still announced, so a mandatory decision cannot be lost.
    expect(container.querySelector(".choice-overlay-minimized"), "no restore bar").toBeTruthy();
    expect(screen.getByText(PROMPT)).toBeTruthy();
  });

  it("restoring brings the same choices back", () => {
    const { container } = render(
      <ChoiceOverlay title={PROMPT} resetKey="d1">
        <button>Kill Poro</button>
      </ChoiceOverlay>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    fireEvent.click(screen.getByRole("button", { name: "Show choices" }));

    expect(screen.getByRole("button", { name: "Kill Poro" })).toBeTruthy();
    expect(container.querySelector(".choice-overlay-backdrop")).toBeTruthy();
    expect(container.querySelector(".choice-overlay-minimized")).toBeNull();
  });

  it("a NEW decision opens EXPANDED, even with the identical prompt", () => {
    // The load-bearing test. Cull the Weak asks both players in the same words,
    // so this pair differs only in `resetKey` — which is exactly why the reset is
    // keyed on the decision id and not on the title.
    const { container, rerender } = render(
      <ChoiceOverlay title={PROMPT} resetKey="d1">
        <button>Kill Poro</button>
      </ChoiceOverlay>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    expect(container.querySelector(".choice-overlay-minimized"), "did not minimize").toBeTruthy();

    rerender(
      <ChoiceOverlay title={PROMPT} resetKey="d2">
        <button>Kill Sprite</button>
      </ChoiceOverlay>,
    );

    expect(
      container.querySelector(".choice-overlay-minimized"),
      "the second question opened collapsed — the player is waiting on a board that looks idle",
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Kill Sprite" })).toBeTruthy();
  });

  it("...and staying on the SAME decision keeps it minimized across re-renders", () => {
    // The other half: a board re-render (an animation, a hover) must not pop the
    // panel back open while the player is still reading the board.
    const { container, rerender } = render(
      <ChoiceOverlay title={PROMPT} resetKey="d1">
        <button>Kill Poro</button>
      </ChoiceOverlay>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    rerender(
      <ChoiceOverlay title={PROMPT} resetKey="d1">
        <button>Kill Poro</button>
      </ChoiceOverlay>,
    );

    expect(container.querySelector(".choice-overlay-minimized"), "a re-render reopened the panel").toBeTruthy();
  });

  it("a CANCELLABLE overlay keeps its Cancel button, and can still be minimized", () => {
    // Minimizing is not a substitute for cancelling and must not replace it: a
    // play-time choice is still backed out of with Cancel, and minimizing it is
    // for looking at the board mid-decision.
    let cancelled = false;
    render(
      <ChoiceOverlay title="Choose a mode" resetKey="p1" onCancel={() => { cancelled = true; }}>
        <button>Mode A</button>
      </ChoiceOverlay>,
    );

    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    expect(screen.queryByRole("button", { name: "Cancel" }), "Cancel survived minimizing").toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show choices" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelled, "Cancel stopped working after a minimize/restore round trip").toBe(true);
  });

  it("falls back to the TITLE as its identity when no resetKey is given", () => {
    // The play-time overlays pass no key: each names its own card, so the title
    // is a sound identity there. Asserted so the default cannot rot into "never
    // resets".
    const { container, rerender } = render(
      <ChoiceOverlay title="Bone Skewer — choose a card from your trash">
        <button>Pick</button>
      </ChoiceOverlay>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    rerender(
      <ChoiceOverlay title="Fizz - Trickster — choose a target">
        <button>Pick</button>
      </ChoiceOverlay>,
    );

    expect(container.querySelector(".choice-overlay-minimized"), "a different card's question stayed collapsed").toBeNull();
  });
});
