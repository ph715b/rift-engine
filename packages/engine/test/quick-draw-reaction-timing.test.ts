import { describe, expect, it } from "vitest";
import { timingRejection, timingTierOf } from "../src/engine/timing.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance } from "../src/model/card.js";
import { makeState, makeUnit, spellInstance } from "./fixtures.js";
import type { GameState } from "../src/model/game-state.js";

/**
 * **`[Quick-Draw]` Gear can be played at Reaction speed.**
 *
 * The keyword's own reminder text is "This has [Reaction]. When you play it,
 * attach it to a unit you control", and the loader has set `isReaction: true` on
 * the DEFINITION since Quick-Draw was written.
 *
 * The INSTANCE dropped it. `createCardInstance`'s Gear branch carried neither
 * `isReaction` nor `isAction`, and `timing.timingTierOf` shape-tests the
 * instance — `"isReaction" in card` — so every Quick-Draw Gear tiered as
 * `Default` and the board said, in playtest:
 *
 *     "Long Sword needs [Reaction] to be played while a spell is on the chain."
 *
 * **This is the same silent loss `createCardInstance` already documents for a
 * Spell's `isAction`**, one card kind over: "the definition carried it, a
 * PlayCardAction carries the INSTANCE, and the instance didn't have it."
 *
 * Asserted at BOTH ends — the tier, and the timing gate that reports the message
 * a player actually saw — because the tier alone would have passed against an
 * engine that computed it correctly and then refused the play anyway.
 */

const registry = defaultCardRegistry();
const LONG_SWORD = "SFD-022";
const SPINNING_AXE = "SFD-186";
/** A Gear with no [Quick-Draw], so "every Gear is a Reaction" cannot pass here. */
const ORB_OF_REGRET = "OGN-090";

const gear = (defId: string) => createCardInstance(registry.get(defId)) as GearInstance;

/** A closed chain: one spell resolving, which is the exact state the reported
 *  message came from (310 — "if a Chain exists, the turn is in a Closed State"). */
function chainOpenWithASpell(): GameState {
  const state = makeState({ phase: "Action" });
  state.chainOpen = false;
  state.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "ally" })] };
  state.spellChain = [
    { kind: "spell", playerIndex: 1, card: spellInstance("OGN-085"), payment: { energyRunes: [], powerRunes: [] } } as never,
  ];
  return state;
}

describe("[Quick-Draw] Gear is playable at Reaction speed", () => {
  it("the DEFINITION has always said so", () => {
    // The half that was already right, asserted so a regression in the loader is
    // told apart from a regression in the instance.
    for (const defId of [LONG_SWORD, SPINNING_AXE]) {
      const def = registry.get(defId);
      expect(def.type === "Gear" && def.isReaction, `${defId} lost [Quick-Draw]'s [Reaction] at the loader`).toBe(true);
    }
  });

  it("the INSTANCE carries it too — the field that was dropped", () => {
    expect(gear(LONG_SWORD).isReaction, "createCardInstance dropped isReaction for Gear").toBe(true);
    expect(gear(SPINNING_AXE).isReaction).toBe(true);
  });

  it("tiers as Reaction, not Default", () => {
    expect(timingTierOf(gear(LONG_SWORD))).toBe("Reaction");
    expect(timingTierOf(gear(SPINNING_AXE))).toBe("Reaction");
  });

  it("is NOT refused while a spell is on the chain — the reported bug", () => {
    // The message the playtest report quoted, asserted as absent.
    const state = chainOpenWithASpell();
    expect(
      timingRejection(state, 0, gear(LONG_SWORD)),
      "Long Sword was still refused at Reaction speed",
    ).toBeNull();
    expect(timingRejection(state, 0, gear(SPINNING_AXE))).toBeNull();
  });

  it("a Gear WITHOUT [Quick-Draw] is still refused — the negative control", () => {
    // Without this, granting every Gear Reaction speed would pass every test
    // above. Orb of Regret prints no [Quick-Draw], so the closed chain must
    // still stop it, with the message the report quoted.
    const state = chainOpenWithASpell();
    const rejection = timingRejection(state, 0, gear(ORB_OF_REGRET));

    expect(timingTierOf(gear(ORB_OF_REGRET))).toBe("Default");
    expect(rejection).toContain("[Reaction]");
  });
});
