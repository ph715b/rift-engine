import { describe, expect, it } from "vitest";
import { createCardInstance, defaultCardRegistry } from "@rift-engine/engine";
import { listTargetHint } from "../src/target-hint.js";

/**
 * The board must SAY that a list-targeting card wants more than one target.
 *
 * Reported from playtesting: "not sure how targeting works with this card — it
 * doesn't seem to cast when I try to target the same creature twice." The engine
 * was right the whole time (`[e0, e0]` is enumerated and validated); the board
 * simply had no hint for the `unitList` step, so the card asked for two targets
 * in silence and a second click on the same unit produced no visible change.
 */

const registry = defaultCardRegistry();
const card = (defId: string) => createCardInstance(registry.get(defId));

const FALLING_STAR = "OGN-029"; // "Deal 3 to a unit. Deal 3 to a unit." — min 2, max 2, duplicates legal
const FOX_FIRE = "OGN-256"; // "Kill any number of units at a battlefield..." — min 0, no max
const HEXTECH_RAY = "OGN-009"; // an ordinary single-target spell, for the control

describe("the list-targeting hint", () => {
  it("says HOW MANY Falling Star wants, and counts progress", () => {
    expect(listTargetHint(card(FALLING_STAR), 0)).toContain("choose 2 units");
    expect(listTargetHint(card(FALLING_STAR), 0)).toContain("[0/2]");
    expect(listTargetHint(card(FALLING_STAR), 1)).toContain("[1/2]");
  });

  it("says the same unit MAY be chosen twice — the question that was asked", () => {
    // Invisible from the board otherwise: a unit already picked just looks
    // picked, so there is nothing to suggest clicking it again is legal.
    expect(listTargetHint(card(FALLING_STAR), 1)).toMatch(/more than once/i);
  });

  it("points an 'any number' card at Done instead of a total", () => {
    const hint = listTargetHint(card(FOX_FIRE), 2);
    expect(hint).toMatch(/any number/i);
    expect(hint).toMatch(/Done/);
    expect(hint).toContain("2 chosen");
  });

  it("does not claim duplicates are legal when they are not", () => {
    // Fox-Fire kills a SET — the same unit twice would be meaningless, and the
    // spec says so. A hint that promised otherwise would be worse than none.
    expect(listTargetHint(card(FOX_FIRE), 0)).not.toMatch(/more than once/i);
  });

  it("degrades to a plain sentence for a card that is not list-targeted", () => {
    // The control: this is only ever called from the list step, but it must not
    // invent a count for a card that has none.
    const hint = listTargetHint(card(HEXTECH_RAY), 0);
    expect(hint).toContain("Hextech Ray");
    expect(hint).not.toMatch(/\[\d/);
  });
});
