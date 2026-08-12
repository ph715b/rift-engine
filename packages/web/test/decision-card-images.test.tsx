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
function stateWith(overrides: { deck?: string[]; opponentHand?: string[]; baseUnits?: string[] }): GameState {
  let counter = 0;
  const instance = (defId: string) => ({ ...structuredClone(registry.get(defId)), instanceId: `i${(counter += 1)}`, defId });
  const player = (id: string, hand: string[] = [], deck: string[] = [], baseUnits: string[] = []) => ({
    id,
    name: id,
    hand: hand.map(instance),
    deck: deck.map(instance),
    baseUnits: baseUnits.map(instance),
    activeGear: [],
    trash: [],
    banished: [],
    channeled: [],
    runeDeck: [],
    points: 0,
    xp: 0,
  });
  return {
    players: [player("p1", [], overrides.deck ?? [], overrides.baseUnits ?? []), player("p2", overrides.opponentHand ?? [], [])],
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

/**
 * ...but rendering the card must not THROW AWAY the label.
 *
 * Reported from playtesting: *"unit didn't move to base after relentless
 * pursuit."* The engine was doing its half correctly the whole time — measured
 * at 6/6 conquests over 60 self-play games, moving the unit every time the
 * answer was yes. There was simply no way to say yes.
 *
 * The block above splits options into "render as a card" and "render as a
 * button", and the card branch dropped `option.label`. That is correct for the
 * family it was written for — `{id: c.instanceId, label: c.name, instanceId:
 * c.instanceId}`, where the art already says everything the label does. The
 * engine emits a SECOND family that inverts it: `{id: "buff", label: "Buff me",
 * instanceId: theUnit.instanceId}`, a yes/no whose affirmative names its
 * SUBJECT. There the label is the question and the card is what it acts on, so
 * discarding it leaves an unexplained picture and no way to choose it.
 *
 * Seven decisions are the second kind. Only Relentless Pursuit was reported,
 * because a yes/no where only "no" carries a label does not look broken — it
 * looks like a choice you already made.
 *
 * The rule is about the TEXT, not the family: draw the label unless it is exactly
 * the card's name. The families are not marked in the data, so any rule that
 * tried to tell them apart would guess wrong on the next card.
 */
describe("a card option keeps the words that make it an answer", () => {
  const BUHRU_CAPTAIN = "SFD-091";

  /** Buhru Captain asks "draw 1, or buff me?" — three options, and exactly one
   *  of them carries a card. The mixed shape is the point: two of the three
   *  answers were labelled and the third was a silent picture. */
  const captainDecision = (): { state: GameState; decision: PendingDecision } => {
    const state = stateWith({ baseUnits: [BUHRU_CAPTAIN] });
    const captain = state.players[0]!.baseUnits[0]!;
    return { state, decision: { id: "d4", kind: "SFD-091-choose", playerIndex: 0, cardInstanceId: captain.instanceId } as PendingDecision };
  };

  it("draws the instruction next to the card it acts on", () => {
    const { state, decision } = captainDecision();
    // The premise, asserted rather than assumed: this option really does carry
    // BOTH a label and an instanceId. If the engine ever stops emitting that
    // shape, this test is about nothing and should say so here.
    const buff = optionsFor(state, decision).find((o) => o.id === "buff");
    expect(buff?.instanceId, "premise: the option names a card").toBeTruthy();
    expect(buff?.label, "premise: the option carries prose").toBe("Buff me");

    const { container } = renderPrompt(state, decision);
    expect(cardImageCount(container), "the card half regressed").toBe(1);
    expect(container.textContent, "the label was discarded — the reported bug").toContain("Buff me");
    cleanup();
  });

  it("does not repeat a label that is just the card's name", () => {
    // The other family. Stacked Deck's options are `label: c.name`, so drawing
    // the caption would print every card's name under its own art — noise on the
    // decisions that were already working.
    const state = stateWith({ deck: ["OGN-009", "OGN-022", "OGN-024"] });
    const decision: PendingDecision = { id: "d5", kind: "OGN-183-keep", playerIndex: 0 };
    const { container } = renderPrompt(state, decision);

    expect(container.querySelectorAll(".decision-option-label")).toHaveLength(0);
    cleanup();
  });

  it("leaves the button options exactly as they were", () => {
    // The control against over-reach: this change must not move a labelled
    // answer OUT of the button row, or a plain yes/no loses its controls the
    // other way round.
    const { state, decision } = captainDecision();
    const { container } = renderPrompt(state, decision);
    // **Scoped to the ANSWER row, not to every button on screen.** This read
    // `container.querySelectorAll("button")` until 2026-08-11, when the panel
    // gained a minimize control and that chrome button started reading as an
    // answer. The premise was always "the answers are unchanged"; the query was
    // simply wider than the premise — which only shows up when something
    // legitimate is added next door.
    const buttons = [...container.querySelectorAll(".choice-overlay-actions button")].map((b) => b.textContent);
    expect(buttons).toEqual(["Decline", "Draw 1"]);
    // The other half of the same claim: panel chrome must stay OUT of the
    // answer row, so a future control landing inside it fails here rather than
    // quietly becoming an answer.
    expect(
      [...container.querySelectorAll(".choice-overlay-actions button")].map((b) => b.getAttribute("aria-label")),
      "a chrome control is sitting in the answer row",
    ).not.toContain("Minimize");
    cleanup();
  });
});
