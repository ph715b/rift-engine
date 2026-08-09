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
        attachedEquipment={[{ instanceId: "g1", name: sword.name, defId: LONG_SWORD }]}
        attachedMightBonus={2}
      />,
    );
    const badge = badgeTitled(/Equipped:/);
    expect(badge, "no attachment badge rendered").toBeDefined();
    expect(badge!.getAttribute("title")).toContain(sword.name);
  });

  it("reports the Might those Equipment add, which is the 'why is it bigger' answer", () => {
    draw(<CardView card={unit()} attachedEquipment={[{ instanceId: "g1", name: "Long Sword", defId: "SFD-095" }]} attachedMightBonus={2} />);
    expect(badgeTitled(/Equipped:/)!.getAttribute("title")).toContain("+2 Might");
  });

  it("counts them when there is more than one", () => {
    draw(
      <CardView
        card={unit()}
        attachedEquipment={[
          { instanceId: "g1", name: "Long Sword", defId: "SFD-095" },
          { instanceId: "g2", name: "Doran's Blade", defId: "SFD-095" },
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

/**
 * The paper layout: an attached Equipment is tucked UNDER its wearer and skewed
 * so its name line still reads.
 *
 * **Reported from playtesting**: "more clear view of what equipment is attached
 * to what unit... something like what is done in paper where players put the
 * equipment card under the unit it is attached to, skewed so the text line is
 * still readable."
 *
 * The badges above are not deleted — they still answer "how much Might" and
 * survive when a gear has no art. What they could not do is show the
 * RELATIONSHIP: the gear stayed in the flat gear row, so reading it took two
 * hovers in two places.
 */
describe("attached Equipment renders under its wearer, paper-style", () => {
  it("renders one card per attached Equipment", () => {
    const { container } = draw(
      <CardView
        card={unit()}
        attachedEquipment={[
          { instanceId: "g1", name: "Long Sword", defId: LONG_SWORD },
          { instanceId: "g2", name: "Doran's Blade", defId: "SFD-095" },
        ]}
      />,
    );
    expect(container.querySelectorAll(".attached-card")).toHaveLength(2);
  });

  it("fans each one further, so two do not exactly overlap", () => {
    // The `--fan` index is what separates them. Without it both sit at the same
    // offset and rotation and the second is invisible behind the first — which
    // looks exactly like a unit wearing one Equipment.
    const { container } = draw(
      <CardView
        card={unit()}
        attachedEquipment={[
          { instanceId: "g1", name: "Long Sword", defId: LONG_SWORD },
          { instanceId: "g2", name: "Doran's Blade", defId: "SFD-095" },
        ]}
      />,
    );
    const fans = [...container.querySelectorAll<HTMLElement>(".attached-card")].map((el) =>
      el.style.getPropertyValue("--fan"),
    );
    expect(fans).toEqual(["0", "1"]);
  });

  it("renders NOTHING for a unit with no Equipment", () => {
    // The negative control: a stack that always rendered would put an empty
    // skewed card under every unit on the board.
    const { container } = draw(<CardView card={unit()} />);
    expect(container.querySelector(".attached-stack")).toBeNull();
  });

  it("renders nothing for a GEAR — only a wearer has a stack", () => {
    // A gear showing its own art tucked under itself is the shape this could
    // regress into, since `attachedEquipment` is a prop anyone could pass.
    const { container } = draw(
      <CardView
        card={gear(LONG_SWORD, "wearer")}
        attachedEquipment={[{ instanceId: "g1", name: "Long Sword", defId: LONG_SWORD }]}
      />,
    );
    expect(container.querySelector(".attached-stack")).toBeNull();
  });

  it("does not steal clicks from the unit it sits under", () => {
    // The stack overlays the card's own box, so without `pointer-events: none`
    // the gear peeking out would swallow clicks meant for the wearer — which
    // would make an equipped unit untargetable, a far worse bug than the one
    // being fixed. Asserted on the class the CSS rule keys off.
    const { container } = draw(
      <CardView card={unit()} attachedEquipment={[{ instanceId: "g1", name: "Long Sword", defId: LONG_SWORD }]} />,
    );
    expect(container.querySelector(".attached-stack")?.getAttribute("aria-hidden")).toBe("true");
  });
});

/**
 * **The tests above passed while nothing was visible on the board.**
 *
 * The first version of the paper layout shipped, was reported unusable — "i
 * cant see the equipment attached to a unit" — and every test still passed.
 * They asserted the elements were in the DOM. They were. Two CSS facts made
 * them unseeable:
 *
 *   `.card { overflow: hidden }` clipped away the band meant to stick out below
 *   the wearer, which is the whole point of the paper layout.
 *
 *   `.card-art` is `position: absolute; inset: 0` and paints AFTER the stack,
 *   so it covered everything the clip had not already removed.
 *
 * jsdom does no layout, so no test here can assert "visible" directly. What it
 * CAN assert is the one thing that decides it — the modifier class the CSS
 * keys off. That is the honest thing to pin: not a proxy for visibility, but
 * the specific switch whose absence caused it.
 */
describe("the attached stack is not clipped away", () => {
  it("opens the wearer's overflow, which is what makes the stack visible at all", () => {
    const { container } = draw(
      <CardView card={unit()} attachedEquipment={[{ instanceId: "g1", name: "Long Sword", defId: LONG_SWORD }]} />,
    );
    const card = container.querySelector(".card");
    expect(card?.className, "without `has-attached` the stack is clipped and invisible").toContain("has-attached");
  });

  it("does NOT open it for a unit wearing nothing", () => {
    // Every other card must keep clipping — `overflow: hidden` is load-bearing
    // for the card silhouette, so this is not a blanket change.
    const { container } = draw(<CardView card={unit()} />);
    expect(container.querySelector(".card")?.className).not.toContain("has-attached");
  });

  it("does not open it for a GEAR that was handed the prop", () => {
    const { container } = draw(
      <CardView
        card={gear(LONG_SWORD, "wearer")}
        attachedEquipment={[{ instanceId: "g1", name: "Long Sword", defId: LONG_SWORD }]}
      />,
    );
    expect(container.querySelector(".card")?.className).not.toContain("has-attached");
  });
});

describe("the protruding band identifies the Equipment", () => {
  /**
   * The band that sticks out below the wearer shows the MIDDLE of the gear's
   * artwork, which does not say which gear it is. The first version rendered the
   * name only as a no-art fallback, so every gear that HAS art — almost all of
   * them — protruded as an anonymous strip of picture. The ask was "skewed so
   * that the text line is still readable"; without this the text line is not
   * there at all.
   */
  it("names the gear even when the registry HAS art for it", () => {
    const { container } = draw(
      <CardView
        card={unit()}
        attachedEquipment={[{ instanceId: "g1", name: "Long Sword", defId: LONG_SWORD }]}
      />,
    );
    expect(defaultCardRegistry().tryGet(LONG_SWORD)?.imageUrl, "premise: this gear has art").toBeTruthy();
    expect(container.querySelector(".attached-card .attached-art"), "art still drawn").not.toBeNull();
    expect(container.querySelector(".attached-card .attached-name")?.textContent).toBe("Long Sword");
  });

  it("still names it when there is no art at all", () => {
    const { container } = draw(
      <CardView card={unit()} attachedEquipment={[{ instanceId: "g1", name: "Ghost Gear", defId: "NO-SUCH-CARD" }]} />,
    );
    expect(container.querySelector(".attached-card .attached-art")).toBeNull();
    expect(container.querySelector(".attached-card .attached-name")?.textContent).toBe("Ghost Gear");
  });
});
