import { describe, expect, it, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { createCardInstance, defaultCardRegistry, type CardInstance, type GearInstance } from "@rift-engine/engine";
import { HoverPreviewProvider } from "../src/hover-preview.js";
import { DragGhostProvider } from "../src/drag-ghost.js";
import { CardView } from "../src/components/CardView.js";

/**
 * What is attached to what, on the board.
 *
 * Reported from playtesting: *"need a UI element that better shows what
 * equipment is attached to what unit."*
 *
 * # It was not merely unstyled — it was unrepresentable
 *
 * Measured 2026-08-07: **nothing in `packages/web/src` read
 * `attachedToInstanceId`**, and `engine/equipment.js` was not even exported from
 * the engine's public index. So a unit whose Might had gone up by 2 displayed the
 * new number with nothing on screen saying why, and the 43 SFD cards that turn on
 * attachment turned on a relationship the player could not see.
 *
 * # Why BOTH sides of the relationship get a badge
 *
 * A unit needs "what am I wearing"; a gear needs "am I attached, and to whom".
 * The second is not cosmetic — gear renders in a flat row with no spatial link to
 * its wearer, so an attached Equipment and a loose one are otherwise identical,
 * and several cards turn on the difference (The Zero Drive's "use only if
 * unattached", Spinning Axe's "if this is unattached, kill it").
 *
 * The badges live in the existing `.card-status-badges` overlay rather than a new
 * row, because the board's standing invariant is `scrollableRows === 0` at every
 * supported size — a new row costs real height in a fixed 100dvh column.
 */

const registry = defaultCardRegistry();
const LONG_SWORD = "SFD-022";
const DORANS_BLADE = "SFD-095";
const A_UNIT = "OGN-002";

const gear = (defId: string, attachedTo: string | null): GearInstance =>
  ({ ...createCardInstance(registry.get(defId)), attachedToInstanceId: attachedTo }) as GearInstance;
const unit = (): CardInstance => createCardInstance(registry.get(A_UNIT));

/** Both providers: `CardView` uses `useCardHover` AND `useDragGhost`, so a bare
 *  render throws. Recorded in the verification-loop notes after the same trip.
 */
const draw = (element: React.ReactElement) =>
  render(
    <HoverPreviewProvider>
      <DragGhostProvider>{element}</DragGhostProvider>
    </HoverPreviewProvider>,
  );
/** The badge, found by its title — which is where the ANSWER lives; the glyph
 *  alone would pass whatever the title said. */
const badgeTitled = (match: RegExp) =>
  screen.queryAllByTitle(match).find((el) => el.className.includes("status-attached"));

afterEach(cleanup);

describe("a unit shows what it is wearing", () => {
  it("names the Equipment in the badge's title", () => {
    const sword = registry.get(LONG_SWORD);
    draw(
      <CardView
        card={unit()}
        attachedEquipment={[{ instanceId: "g1", name: sword.name }]}
        attachedMightBonus={2}
      />,
    );
    const badge = badgeTitled(/Equipped:/);
    expect(badge, "no attachment badge rendered").toBeDefined();
    expect(badge!.getAttribute("title")).toContain(sword.name);
  });

  it("reports the Might those Equipment add, which is the 'why is it bigger' answer", () => {
    draw(<CardView card={unit()} attachedEquipment={[{ instanceId: "g1", name: "Long Sword" }]} attachedMightBonus={2} />);
    expect(badgeTitled(/Equipped:/)!.getAttribute("title")).toContain("+2 Might");
  });

  it("counts them when there is more than one", () => {
    draw(
      <CardView
        card={unit()}
        attachedEquipment={[
          { instanceId: "g1", name: "Long Sword" },
          { instanceId: "g2", name: "Doran's Blade" },
        ]}
        attachedMightBonus={3}
      />,
    );
    const badge = badgeTitled(/Equipped:/)!;
    expect(badge.textContent).toContain("2");
    expect(badge.getAttribute("title")).toContain("Doran's Blade");
  });

  it("shows NOTHING on a unit wearing nothing — the control", () => {
    // The load-bearing negative. A badge that rendered unconditionally would be
    // noise on every unit in the game and would tell a player nothing.
    draw(<CardView card={unit()} />);
    expect(badgeTitled(/Equipped:/)).toBeUndefined();
  });
});

describe("a gear shows whether it is attached, and to whom", () => {
  it("names its wearer", () => {
    draw(<CardView card={gear(LONG_SWORD, "wearer")} attachedToUnitName="Rugged Ranger" />);
    const badge = badgeTitled(/Attached to/);
    expect(badge, "an attached gear rendered no badge").toBeDefined();
    expect(badge!.getAttribute("title")).toContain("Rugged Ranger");
  });

  it("shows NOTHING on an UNATTACHED gear — the distinction the card text turns on", () => {
    // "Use only if unattached" (The Zero Drive) is a real gate; a board that drew
    // the badge either way would be actively misleading about it.
    draw(<CardView card={gear(DORANS_BLADE, null)} />);
    expect(badgeTitled(/Attached to/)).toBeUndefined();
  });
});
