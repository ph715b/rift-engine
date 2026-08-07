import { describe, expect, it } from "vitest";
import { effectiveKeywords } from "../src/engine/granted-keywords.js";
import { attachEquipment } from "../src/engine/equipment.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance } from "../src/model/card.js";
import type { CardDefinition } from "../src/model/card-definition.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit } from "./fixtures.js";

/**
 * Lucian - Purifier (SFD-183) — "Your Equipment each give [Assault]."
 *
 * A modifier on what every Equipment grants, NOT a keyword aura of his own — and
 * the difference is the whole card. An aura would hand [Assault] to every unit
 * you control; this hands it only to units actually WEARING something. The
 * unequipped-unit test is what holds that line.
 */

const registry = defaultCardRegistry();
const LUCIAN = "SFD-183";
/** Serrated Dirk prints [Assault 2] itself — the card that proves the merge
 *  takes the HIGHER value rather than stacking. */
const SERRATED_DIRK = "SFD-009";

type GearDef = Extract<CardDefinition, { type: "Gear" }>;
const isGearDef = (d: CardDefinition): d is GearDef => d.type === "Gear";
/** An Equipment that grants NO keyword of its own, so any [Assault] seen on its
 *  wearer came from Lucian. */
const PLAIN_EQUIPMENT = registry
  .all()
  .filter(isGearDef)
  .find((d) => d.isEquipment === true && d.id !== SERRATED_DIRK)!;

const gear = (defId: string) => createCardInstance(registry.get(defId)) as GearInstance;

/** A wearer and an unequipped bystander, with `legendDefId` in the Legend zone. */
function board(legendDefId: string, equipmentDefId = PLAIN_EQUIPMENT.id) {
  const equipment = gear(equipmentDefId);
  const state: GameState = makeState({
    phase: "Action",
    players: [
      makePlayer("p1", {
        baseUnits: [
          makeUnit({ name: "Wearer", instanceId: "wearer" }),
          makeUnit({ name: "Bare", instanceId: "bare" }),
        ],
        activeGear: [equipment],
      }),
      makePlayer("p2", { baseUnits: [makeUnit({ name: "Foe", instanceId: "foe" })] }),
    ],
  });
  state.players[0]!.legend = { ...state.players[0]!.legend, defId: legendDefId };
  return { state: attachEquipment(state, 0, equipment.instanceId, "wearer"), equipment };
}

const assaultOn = (state: GameState, unitInstanceId: string, ownerIndex: 0 | 1 = 0) => {
  const unit = state.players[ownerIndex]!.baseUnits.find((u) => u.instanceId === unitInstanceId)!;
  return effectiveKeywords(state, unit, ownerIndex).Assault ?? 0;
};

describe("Lucian - Purifier gives [Assault] through your Equipment", () => {
  it("grants it to a unit wearing an Equipment", () => {
    const { state } = board(LUCIAN);
    expect(assaultOn(state, "wearer"), "the wearer got no [Assault]").toBeGreaterThan(0);
  });

  /**
   * **The line between this and a keyword aura.** He does not give [Assault] to
   * your units — he gives it to your EQUIPMENT, which give it to whoever wears
   * them. A unit wearing nothing gets nothing, and an aura implementation would
   * fail exactly here.
   */
  it("gives NOTHING to a unit wearing nothing", () => {
    const { state } = board(LUCIAN);
    expect(assaultOn(state, "bare"), "an unequipped unit got [Assault] — this is not an aura").toBe(0);
  });

  it("gives nothing without him — the control for the whole card", () => {
    const { state } = board("SOME-OTHER-LEGEND");
    expect(assaultOn(state, "wearer"), "a wearer got [Assault] with no Lucian").toBe(0);
  });

  /**
   * "YOUR Equipment." The opponent's wearer is reached by their own Legend, not
   * by ours — asserted by giving the opponent an identical setup with a
   * different Legend.
   */
  it("does not reach the opponent's equipped unit", () => {
    const { state } = board(LUCIAN);
    const theirGear = gear(PLAIN_EQUIPMENT.id);
    const withTheirs: GameState = {
      ...state,
      players: [state.players[0]!, { ...state.players[1]!, activeGear: [theirGear] }],
    };
    const attached = attachEquipment(withTheirs, 1, theirGear.instanceId, "foe");

    expect(assaultOn(attached, "foe", 1), "our Lucian armed THEIR unit").toBe(0);
  });

  /**
   * 817.1.a makes duplicate keyword instances redundant, so Serrated Dirk's
   * printed [Assault 2] under Lucian is still 2 — not 3. Taking the larger is
   * what "redundant" means for a numbered keyword, and it is how every other
   * source in `equipmentKeywordsFor` already merges.
   */
  it("does not stack with an Equipment's own printed [Assault]", () => {
    const { state } = board(LUCIAN, SERRATED_DIRK);
    expect(assaultOn(state, "wearer"), "Lucian stacked on top of [Assault 2]").toBe(2);
  });
});
