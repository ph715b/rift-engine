import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import { timingTierOf } from "../src/engine/timing.js";

/**
 * A Gear instance carries its PRINTED keywords, and `[Quick-Draw]`'s `[Reaction]`
 * with them.
 *
 * Reported from playtesting: *"unable to play longsword or spinning axe during a
 * combat even though it has [Quick-Draw]."*
 *
 * `createCardInstance`'s Gear branch hardcoded `keywords: {}` and omitted
 * `isReaction` entirely, on the strength of a comment claiming "Gear in this pool
 * prints no keywords of its own" — which was already false for Long Sword when it
 * was written. So every printed Gear keyword was dropped between the definition
 * and the instance.
 *
 * **The measurement that hid it**: `equipment.ts` recorded "all four printed
 * Quick-Draw Gear come out of the loader with `isReaction: true` already —
 * measured, not assumed". True, and about the DEFINITION. `timingTierOf` reads
 * the INSTANCE. The right object was never checked.
 *
 * `timingTierOf`'s own comment even anticipated the gap: "adding it to Gear later
 * then needs no change here." It was right; the field simply never arrived.
 */
describe("a Gear instance keeps what it prints", () => {
  const registry = defaultCardRegistry();

  it("Long Sword carries [Quick-Draw] and is Reaction tier", () => {
    const def = registry.get("SFD-022");
    if (def.type !== "Gear") throw new Error("SFD-022 is not a Gear");
    // The premise, asserted rather than assumed — this is the half that was
    // already true and made the bug invisible.
    expect(def.keywords, "the DEFINITION lost [Quick-Draw]").toMatchObject({ "Quick-Draw": 1 });
    expect(def.isReaction, "the loader stopped setting isReaction").toBe(true);

    const instance = createCardInstance(def);
    if (instance.kind !== "Gear") throw new Error("not a Gear instance");
    expect(instance.keywords, "the INSTANCE dropped its printed keywords").toMatchObject({ "Quick-Draw": 1 });
    expect(timingTierOf(instance), "it cannot be played in a Showdown").toBe("Reaction");
  });

  it("a Gear that prints NO [Reaction] is still Default tier — the control", () => {
    // Without this, "everything is Reaction" would pass the test above.
    const plain = createCardInstance(registry.get("SFD-030"));
    expect(timingTierOf(plain)).toBe("Default");
  });

  it("and an Unleashed Gear keeps [Temporary], which decides whether it survives", () => {
    // The other half of the same drop, and the more dangerous one:
    // `killTemporaryPermanents` tests `"Temporary" in keywords`, so a gear whose
    // printed [Temporary] was lost never dies on its own.
    const fountain = createCardInstance(registry.get("UNL-078"));
    if (fountain.kind !== "Gear") throw new Error("UNL-078 is not a Gear instance");
    expect(fountain.keywords, "Sprite Fountain lost its printed [Temporary]").toMatchObject({ Temporary: 1 });
  });
});
