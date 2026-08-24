import { describe, expect, it, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { defaultCardRegistry, optionsFor, type GameState, type PendingDecision } from "@rift-engine/engine";
import { DecisionPrompt } from "../src/components/DecisionPrompt.js";
import { HoverPreviewProvider } from "../src/hover-preview.js";
import { DragGhostProvider } from "../src/drag-ghost.js";

/**
 * **Hovering a decision option reports WHICH piece it means, so the board can
 * highlight it.**
 *
 * Reported from playtesting: *"hovering a choice in a decision menu should
 * highlight the corresponding unit on the battlefield. With two identical units
 * on board you cannot tell which one you are equipping."*
 *
 * The overlay genuinely cannot answer this on its own. Two Recruit tokens make
 * two options both reading "Recruit" and both rendering the same art; the only
 * thing that distinguishes them is WHERE they stand, which lives on the board.
 * So the prompt's job is to say which instance the pointer is on, and
 * `GameBoard` folds that id into the `chainTargets.units` Set it already threads
 * to every unit through `isChainTargeted`.
 *
 * # Why this file tests the PROMPT and not the board
 *
 * `GameBoard` builds its own game from a `MatchConfig` and cannot be handed a
 * prepared state — a previous attempt at render tests against it measured
 * nothing. `DecisionPrompt` takes its state as a prop, so the half that can be
 * driven honestly is driven here, and the board's half is one `useState` and a
 * Set union with the existing highlight.
 */

const registry = defaultCardRegistry();

/** Two units with the SAME defId — the reported case exactly. */
function stateWithTwins(): GameState {
  let counter = 0;
  const instance = (defId: string) => ({
    ...structuredClone(registry.get(defId)),
    instanceId: `i${(counter += 1)}`,
    defId,
  });
  // In HAND, because the question these tests drive is `discard`, which offers
  // the answering player's hand. Two copies of one card is the reported case.
  const player = (id: string, hand: string[] = []) => ({
    id,
    name: id,
    hand: hand.map(instance),
    deck: [],
    baseUnits: [],
    activeGear: [],
    trash: [],
    banished: [],
    channeled: [],
    runeDeck: [],
    points: 0,
    xp: 0,
  });
  return {
    players: [player("p1", ["OGN-022", "OGN-022"]), player("p2")],
    battlefields: [],
  } as unknown as GameState;
}

const renderPrompt = (state: GameState, decision: PendingDecision, onHoverOption: (id: string | null) => void) =>
  render(
    <HoverPreviewProvider>
      <DragGhostProvider>
        <DecisionPrompt state={state} decision={decision} onAnswer={() => {}} onHoverOption={onHoverOption} />
      </DragGhostProvider>
    </HoverPreviewProvider>,
  );

/** A question whose options are the answering player's own units. */
const KILL_ONE_OF_YOURS: PendingDecision = { id: "d1", kind: "OGN-269-save", playerIndex: 0 };

describe("hovering a decision option names the instance it means", () => {
  it("reports the hovered option's instanceId, and null on leave", () => {
    const state = stateWithTwins();
    const decision: PendingDecision = { id: "d1", kind: "discard", playerIndex: 0 };
    // The fixture control: two options that a human cannot tell apart. Without
    // this the test would pass on a one-option question, where the feature is
    // pointless.
    const options = optionsFor(state, decision);
    expect(options.length, "the fixture produced no choice at all").toBeGreaterThan(1);

    const onHover = vi.fn();
    const { container } = renderPrompt(state, decision, onHover);
    const first = container.querySelector(".decision-card-option");
    expect(first, "the options did not render as cards").not.toBeNull();

    fireEvent.mouseEnter(first!);
    expect(onHover, "hovering reported nothing").toHaveBeenCalledWith(options[0]!.instanceId);

    fireEvent.mouseLeave(first!);
    expect(onHover, "leaving did not clear the highlight").toHaveBeenLastCalledWith(null);
    cleanup();
  });

  it("reports a DIFFERENT id for the second twin — the whole point", () => {
    // Two units of the same card. If the prompt reported the defId, the name, or
    // the option index, this is where it would show: both options look identical
    // and only the instance id separates them.
    const state = stateWithTwins();
    const decision: PendingDecision = { id: "d1", kind: "discard", playerIndex: 0 };
    const options = optionsFor(state, decision);
    const onHover = vi.fn();
    const { container } = renderPrompt(state, decision, onHover);

    const cards = container.querySelectorAll(".decision-card-option");
    expect(cards.length, "the twins did not both render").toBe(2);

    fireEvent.mouseEnter(cards[0]!);
    fireEvent.mouseEnter(cards[1]!);
    // Two mouseEnters with no leave between them: two calls, in order.
    const [firstCall, secondCall] = onHover.mock.calls.map((c) => c[0]);
    expect(firstCall).toBe(options[0]!.instanceId);
    expect(secondCall).toBe(options[1]!.instanceId);
    expect(firstCall, "both twins reported the same id — the board cannot tell them apart").not.toBe(secondCall);
    cleanup();
  });

  it("fires on FOCUS too, so the keyboard reaches the same highlight", () => {
    const state = stateWithTwins();
    const decision: PendingDecision = { id: "d1", kind: "discard", playerIndex: 0 };
    const onHover = vi.fn();
    const { container } = renderPrompt(state, decision, onHover);

    fireEvent.focus(container.querySelector(".decision-card-option")!);
    expect(onHover).toHaveBeenCalledWith(optionsFor(state, decision)[0]!.instanceId);
    cleanup();
  });

  it("says NOTHING for an option that names no instance", () => {
    // The negative control. A yes/no with no subject must not raise a highlight —
    // a handler that fired with `undefined` would light up whatever the board
    // last had, or clear a chain co-highlight that was correct.
    const state = stateWithTwins();
    const onHover = vi.fn();
    const { container } = renderPrompt(state, KILL_ONE_OF_YOURS, onHover);

    const buttons = container.querySelectorAll("button");
    expect(buttons.length, "the fixture rendered no button options").toBeGreaterThan(0);
    buttons.forEach((b) => fireEvent.mouseEnter(b));
    expect(onHover, "an option with no instance still reported one").not.toHaveBeenCalled();
    cleanup();
  });

  it("is optional — the prompt renders without a hover handler at all", () => {
    // Every other caller and test constructs it without one, so omitting it must
    // not throw when the mouse moves.
    const state = stateWithTwins();
    const { container } = render(
      <HoverPreviewProvider>
        <DragGhostProvider>
          <DecisionPrompt state={state} decision={{ id: "d1", kind: "discard", playerIndex: 0 }} onAnswer={() => {}} />
        </DragGhostProvider>
      </HoverPreviewProvider>,
    );
    expect(() => fireEvent.mouseEnter(container.querySelector(".decision-card-option")!)).not.toThrow();
    cleanup();
  });
});
