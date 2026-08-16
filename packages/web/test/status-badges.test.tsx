import { describe, expect, it } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { createCardInstance, defaultCardRegistry, type GearInstance, type UnitInstance } from "@rift-engine/engine";
import { CardView } from "../src/components/CardView.js";
import { HoverPreviewProvider } from "../src/hover-preview.js";
import { DragGhostProvider } from "../src/drag-ghost.js";

/**
 * Statuses the ENGINE tracks have to be visible on the card.
 *
 * Both of these were engine mechanics with no board affordance at all — the same
 * shape as the trash-play dead end, one layer up, and found by the same two-grep
 * check (`grep empowered src/` returned 0; so did `stunned`).
 *
 *   **Stunned** (423) is the older and the worse of the two. 423.1 stops a unit
 *   contributing its Might in the damage step, so a player who cannot see it
 *   reads their own combat arithmetic as broken rather than as a rule.
 *
 *   **Empowered** (441 / 828) shipped the day before this test. A player could
 *   pay `[Empower]` and then had no way to tell it had worked, or to tell that an
 *   opponent had Disempowered it back off (442).
 *
 * These drive `CardView` directly, which is where the rendering decision lives —
 * the same reasoning `current-might.test.tsx` gives for testing it there rather
 * than through the board.
 *
 * **A card's badge is not in `textContent` alone**, and the glyphs are the whole
 * content of these spans, so the assertions look for the CLASS. That is
 * deliberate: asserting on ✦ or ✷ would pass just as well if the two were
 * swapped, and swapping them is a real mistake — one means the unit is better
 * than it prints and the other means it is worse.
 */

const registry = defaultCardRegistry();
/** A real 3-Might unit, so nothing below depends on an invented card. */
const unit = (): UnitInstance => createCardInstance(registry.get("OGN-164")) as UnitInstance;
/** A real Vendetta Gear that prints `[Empower]`, so the Gear case is not synthetic. */
const gear = (): GearInstance => createCardInstance(registry.get("VEN-018")) as GearInstance;

const show = (card: UnitInstance | GearInstance): HTMLElement => {
  const { container } = render(
    <DragGhostProvider>
      <HoverPreviewProvider>
        <CardView card={card} />
      </HoverPreviewProvider>
    </DragGhostProvider>,
  );
  return container;
};

const has = (container: HTMLElement, cls: string): boolean => container.querySelector(`.${cls}`) !== null;

describe("the board shows the statuses the engine tracks", () => {
  it("shows NEITHER badge on a plain unit — the control", () => {
    // Without this, every assertion below would pass against a card that always
    // renders both badges.
    const container = show(unit());
    expect(has(container, "status-empowered"), "a plain unit is not Empowered").toBe(false);
    expect(has(container, "status-stunned"), "a plain unit is not Stunned").toBe(false);
    cleanup();
  });

  it("shows the Empowered badge on an Empowered unit", () => {
    expect(has(show({ ...unit(), empowered: true }), "status-empowered")).toBe(true);
    cleanup();
  });

  it("shows the Stunned badge on a Stunned unit", () => {
    expect(has(show({ ...unit(), stunned: true }), "status-stunned")).toBe(true);
    cleanup();
  });

  it("keeps the two badges DISTINCT on a unit carrying both", () => {
    // They can co-occur — a Stunned unit stays Empowered — and they mean opposite
    // things, so one must not stand in for the other.
    const container = show({ ...unit(), empowered: true, stunned: true });
    expect(has(container, "status-empowered")).toBe(true);
    expect(has(container, "status-stunned")).toBe(true);
    cleanup();
  });

  it("shows Empowered on GEAR too, which is not a unit", () => {
    // 827.1.a puts the keyword on "permanents and legends", and Vendetta prints
    // it on four Gear. The unit badges live behind a `kind === "Unit"` guard, so
    // folding Empowered in there would have shown the status on some of the cards
    // that can hold it and not others — a half-delivery that reads as working.
    expect(has(show({ ...gear(), empowered: true }), "status-empowered")).toBe(true);
    cleanup();
  });

  it("does not show Empowered on a plain gear", () => {
    expect(has(show(gear()), "status-empowered")).toBe(false);
    cleanup();
  });
});
