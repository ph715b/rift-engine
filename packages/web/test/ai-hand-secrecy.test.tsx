import { describe, expect, it } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { allPresetDecks, defaultCardRegistry, presetDeckList } from "@rift-engine/engine";
import { GameBoard } from "../src/components/GameBoard.js";
import { HoverPreviewProvider } from "../src/hover-preview.js";
import { DragGhostProvider } from "../src/drag-ghost.js";

/**
 * The opponent's hand must reach the DOM as a count and nothing else.
 *
 * Like the facedown card, this is a local rendering decision and not a property
 * of the data: `ai.hand` holds the real card identities, nothing in the web
 * package masks anything, and `GameBoard` rendering
 * `Array.from({ length: ai.hand.length })` is the entire protection.
 *
 * **A card's name is not in its text.** `CardView` renders an `<img>` whose `alt`
 * carries the name; `textContent` on a hand card is empty. An earlier version of
 * this file asserted on text and attributes-I-guessed-at, and three of its four
 * tests passed — the POSITIVE CONTROL is what caught it, by failing to find the
 * viewer's own card names either. Every assertion here therefore searches the
 * whole serialized subtree, attributes included.
 *
 * The deck lists are known ahead of time, so the assertion can be the strong one:
 * NO name from the AI's 40-card deck may appear anywhere in its hand strip, and
 * at least one name from the human's deck must appear in theirs. Both sides use
 * the same preset here, which makes the negative strictly harder to satisfy —
 * the AI's forbidden names are exactly the human's required ones.
 */

const registry = defaultCardRegistry();
const [first, second] = allPresetDecks();
const humanDeck = presetDeckList(first!);
const aiDeck = presetDeckList(second ?? first!);
const config = { humanDeck, aiDeck, format: "bo1" as const };

/** Every printed name a deck could put in a hand. */
const namesIn = (deck: typeof humanDeck): string[] => [
  ...new Set(deck.cardIds.map((id) => registry.tryGet(id)?.name).filter((n): n is string => typeof n === "string" && n.length > 0)),
];

const AI_NAMES = namesIn(aiDeck);
const HUMAN_NAMES = namesIn(humanDeck);

/** Everything a subtree could show a player: its markup, which is text AND every
 *  attribute — `alt`, `src`, `title`, `aria-label` and anything a later refactor
 *  adds. Serializing beats naming attributes one by one; the version of this file
 *  that named them missed `alt`, which is where the name actually is. */
const everythingIn = (el: Element): string => el.outerHTML;

/** Renders the board and gets past the mulligan, which is the screen it opens on
 *  — the AI hand strip does not exist until the game is live. */
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
  // `fireEvent`, not `element.click()`: testing-library wraps the dispatch in
  // `act`, which flushes the state update that swaps the mulligan for the board.
  // A raw click leaves the mulligan on screen and every query below finds
  // nothing — reading as "the strip does not render" rather than as "the test
  // never got past the first screen".
  fireEvent.click(confirm!);
  expect(container.querySelector(".board"), "still on the mulligan — the board never became live").not.toBeNull();
  return container;
}

const aiStrip = (container: HTMLElement): Element => {
  const strip = container.querySelector(".ai-hand-fan");
  expect(strip, "the AI hand strip did not render").not.toBeNull();
  return strip!;
};

describe("the opponent's hand reaches the DOM as a count and nothing else", () => {
  it("names none of the AI's cards, anywhere in the strip", () => {
    const strip = aiStrip(boardInPlay());
    const markup = everythingIn(strip);

    // Gate on tried > 0 twice over: an empty strip, or an empty forbidden-name
    // list, would satisfy the assertion while proving nothing — which reads
    // exactly like a pass.
    expect(strip.querySelectorAll(".hand-back").length, "the AI is holding no cards — this proves nothing").toBeGreaterThan(0);
    expect(AI_NAMES.length, "no card names were derived from the AI deck").toBeGreaterThan(10);

    const leaked = AI_NAMES.filter((name) => markup.includes(name));
    expect(leaked, "the opponent's hand named these cards").toEqual([]);
    cleanup();
  });

  it("renders featureless backs — no image, so no alt to leak through", () => {
    // The mechanism, asserted directly: a hand back is a bare `<span>`, where a
    // real card is a `CardView` with an `<img alt={name}>`. This is what a
    // refactor that "just reuses CardView for consistency" would break.
    const strip = aiStrip(boardInPlay());

    expect(strip.querySelectorAll("img")).toHaveLength(0);
    for (const back of strip.querySelectorAll(".hand-back")) {
      expect(back.tagName).toBe("SPAN");
      expect(back.textContent).toBe("");
      expect(back.children).toHaveLength(0);
    }
    cleanup();
  });

  it("says only HOW MANY, in the one attribute it does carry", () => {
    const strip = aiStrip(boardInPlay());
    const count = strip.querySelectorAll(".hand-back").length;
    expect(strip.getAttribute("title")).toBe(`AI Opponent's hand: ${count} card${count === 1 ? "" : "s"}`);
    cleanup();
  });

  it("POSITIVE CONTROL: the viewer's OWN hand DOES name its cards, in the same DOM", () => {
    // Without this, every assertion above would pass just as happily against a
    // board that rendered nothing readable — and in an earlier version of this
    // file, that is exactly what was happening.
    const container = boardInPlay();
    const ownFan = container.querySelector(".hand-fan-layer");
    expect(ownFan, "the human's own hand fan did not render").not.toBeNull();

    const markup = everythingIn(ownFan!);
    const shown = HUMAN_NAMES.filter((name) => markup.includes(name));
    expect(shown.length, "the viewer cannot read their own hand either — the query is blind").toBeGreaterThan(0);
    cleanup();
  });
});
