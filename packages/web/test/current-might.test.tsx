import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createCardInstance, defaultCardRegistry, type UnitInstance } from "@rift-engine/engine";
import { CardView } from "../src/components/CardView.js";
import { HoverPreviewProvider } from "../src/hover-preview.js";
import { DragGhostProvider } from "../src/drag-ghost.js";

/**
 * The card face shows a unit's CURRENT Might, not its printed Might.
 *
 * **Reported from playtesting**: "need to have UI accurately represent a unit's
 * current might". The gap was total rather than partial — `effectiveMight` was
 * not called ANYWHERE in `packages/web`, so the face showed the printed number
 * and only three modifiers had badges of their own (marked damage, a this-turn
 * pump, a Buff).
 *
 * So the two cases with NO indication at all were the ones a player is least
 * able to work out for themselves: a positional AURA, and an attached
 * Equipment's `+N` badge — which is art-only data the card face does not print
 * either. A unit at printed 3 wearing a +4 Blade of the Ruined King showed "3".
 *
 * `currentMight` is computed once in `GameBoard.attachmentProps`, the same
 * provider that already answers "what is attached to what", so the board cannot
 * reach a different number than the engine. These tests drive `CardView`
 * directly, which is where the RENDERING decision lives.
 */

const registry = defaultCardRegistry();
/** A plain 3-Might unit, so the numbers below are the card's and not invented. */
const unit = (): UnitInstance => createCardInstance(registry.get("OGN-164")) as UnitInstance;

/** CardView reads BOTH the hover and drag-ghost contexts, so every render needs
 *  both providers — it throws without them. */
const show = (card: UnitInstance, currentMight?: number) =>
  render(
    <DragGhostProvider>
      <HoverPreviewProvider>
        <CardView card={card} {...(currentMight === undefined ? {} : { currentMight })} />
      </HoverPreviewProvider>
    </DragGhostProvider>,
  );

describe("the current-Might overlay", () => {
  it("renders NOTHING when the current Might equals the printed one", () => {
    // The card art already prints the Might, so an overlay here would duplicate
    // it. This is the negative control AND the design: the overlay is a
    // correction, not a readout, and a board that stamped every unit would be
    // noise the player learns to ignore.
    const card = unit();
    const { container } = show(card, card.might);
    expect(container.querySelector(".might-overlay")).toBeNull();
  });

  it("renders nothing when the board gives no context at all", () => {
    // A card in hand or the champion zone gets no `currentMight`, and printed IS
    // the answer there. Absent must not render as 0.
    const card = unit();
    const { container } = show(card);
    expect(container.querySelector(".might-overlay")).toBeNull();
  });

  it("shows the RAISED value over the art, with the printed one struck through", () => {
    // The reported case: a +4 Blade of the Ruined King, or a positional aura,
    // moved the real Might and the only number on screen was the wrong one.
    const card = unit();
    const { container } = show(card, card.might + 4);

    const overlay = container.querySelector(".might-overlay");
    expect(overlay).toBeTruthy();
    expect(overlay?.querySelector(".stat-might-current")?.textContent).toBe(String(card.might + 4));
    expect(overlay?.querySelector(".stat-might-printed")?.textContent).toBe(String(card.might));
  });

  it("shows a LOWERED value too", () => {
    // Icevale Archer and Frigid Touch both give -Might, and a debuffed unit is
    // exactly as misleading to read off the art as a buffed one.
    const card = unit();
    const { container } = show(card, card.might - 2);
    expect(container.querySelector(".stat-might-current")?.textContent).toBe(String(card.might - 2));
  });

  it("renders 0 as a value, not as an absent one", () => {
    // A unit taken to 0 or below reads as 0 (the Might property: below 0 "is
    // treated as 0 when referenced"). Written with `||` anywhere in the chain,
    // a real 0 would fall back to the printed value and the overlay would
    // vanish exactly when it matters most.
    const card = unit();
    const { container } = show(card, 0);
    expect(container.querySelector(".stat-might-current")?.textContent).toBe("0");
  });

  it("carries the numbers in its accessible label, not only in colour", () => {
    // The overlay is the only place these two numbers appear together, so the
    // relationship has to survive without sight of the styling.
    const card = unit();
    const { container } = show(card, card.might + 1);
    const label = container.querySelector(".might-overlay")?.getAttribute("aria-label") ?? "";
    expect(label).toContain(String(card.might + 1));
    expect(label).toContain(String(card.might));
  });
});
