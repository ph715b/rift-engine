import { describe, expect, it } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { defaultCardRegistry, optionsFor, type GameState, type PendingDecision } from "@rift-engine/engine";
import { DecisionPrompt } from "../src/components/DecisionPrompt.js";
import { HoverPreviewProvider } from "../src/hover-preview.js";
import { DragGhostProvider } from "../src/drag-ghost.js";

/**
 * A decision whose options ARE cards must render the cards, not four words of
 * prose in a button.
 *
 * Reported from playtesting for Stacked Deck and Mindsplitter, and both had the
 * same cause in `DecisionPrompt.findCard`: it searched five zones of the
 * ANSWERING player, and neither card's options live in any of them — Stacked
 * Deck offers the top of the **deck**, Mindsplitter offers the **opponent's**
 * hand. The lookup silently found nothing and fell through to the button
 * fallback, which is a real fallback for a yes/no question and looked like a
 * deliberate choice here.
 */

const registry = defaultCardRegistry();
const STACKED_DECK = "OGN-183";
const MINDSPLITTER = "OGN-192";

/** A minimal two-player state — only the zones these two questions read. */
function stateWith(overrides: { deck?: string[]; opponentHand?: string[] }): GameState {
  let counter = 0;
  const instance = (defId: string) => ({ ...structuredClone(registry.get(defId)), instanceId: `i${(counter += 1)}`, defId });
  const player = (id: string, hand: string[] = [], deck: string[] = []) => ({
    id,
    name: id,
    hand: hand.map(instance),
    deck: deck.map(instance),
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
    players: [player("p1", [], overrides.deck ?? []), player("p2", overrides.opponentHand ?? [], [])],
    battlefields: [],
  } as unknown as GameState;
}

const renderPrompt = (state: GameState, decision: PendingDecision) =>
  render(
    <HoverPreviewProvider>
      <DragGhostProvider>
        <DecisionPrompt state={state} decision={decision} onAnswer={() => {}} />
      </DragGhostProvider>
    </HoverPreviewProvider>,
  );

/** Card art is an <img>; its `alt` carries the printed name. A button-fallback
 *  option renders the name as TEXT instead, so counting images is what tells the
 *  two apart — see ai-hand-secrecy.test.tsx on why text alone lies here. */
const cardImageCount = (container: HTMLElement) => container.querySelectorAll("img").length;

describe("a decision whose options are cards renders them as cards", () => {
  it("Stacked Deck shows the three cards it is looking at", () => {
    const state = stateWith({ deck: ["OGN-009", "OGN-022", "OGN-024"] });
    const decision: PendingDecision = { id: "d1", kind: "OGN-183-keep", playerIndex: 0 };

    expect(optionsFor(state, decision), "the fixture reached no options at all").toHaveLength(3);
    const { container } = renderPrompt(state, decision);

    expect(cardImageCount(container), "the top of the deck rendered as bare buttons").toBe(3);
    cleanup();
  });

  it("Mindsplitter shows the OPPONENT's hand it just revealed", () => {
    // "They reveal their hand. Choose a card from it" — the card itself is what
    // makes these visible, so rendering them is the instruction, not a leak.
    const state = stateWith({ opponentHand: ["OGN-009", "OGN-022"] });
    const decision: PendingDecision = { id: "d2", kind: "OGN-192-discard", playerIndex: 0 };

    expect(optionsFor(state, decision), "the fixture reached no options at all").toHaveLength(2);
    const { container } = renderPrompt(state, decision);

    expect(cardImageCount(container), "the revealed hand rendered as bare buttons").toBe(2);
    cleanup();
  });

  it("still falls back to BUTTONS for a question that is not about cards", () => {
    // The control. A plain yes/no must not sprout card art, and a lookup that
    // matched anything would make the two assertions above meaningless.
    const state = stateWith({});
    const decision: PendingDecision = { id: "d3", kind: "OGN-269-save", playerIndex: 0 };
    const { container } = renderPrompt(state, decision);

    expect(cardImageCount(container)).toBe(0);
    cleanup();
  });
});
