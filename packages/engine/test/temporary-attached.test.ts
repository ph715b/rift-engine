import { describe, expect, it } from "vitest";
import { runBeginning } from "../src/engine/turn-manager.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { GearInstance } from "../src/model/card.js";
import { makeState, realUnitInstance, realGearInstance } from "./fixtures.js";

/**
 * **An ATTACHED Equipment does not die to its own `[Temporary]`.**
 *
 * Reported from playtesting: "spinning axe temporary triggered even though it is
 * equipped to a unit". The report was right and the engine was wrong.
 *
 * # Why the reminder text is not the reason
 *
 * Spinning Axe (SFD-186) prints "(If this is unattached, kill it at the start of
 * its controller's Beginning Phase, before scoring.)" — which says exactly this.
 * But **135.2.d.3**: "The presence, absence, or exact wording of reminder text
 * has no effect on game [rules]", and the generic keyword it is reminding you of
 * is unconditional — **816.1.b**, "functionally short for 'At the start of this
 * permanent's controller's Beginning Phase, before scoring, kill this.'"
 *
 * So on the keyword alone the engine's old behaviour was defensible, and this
 * looked like a card-specific reminder contradicting its own keyword.
 *
 * It is not. **718.2** settles it: "While in this state, the card's printed Rules
 * Text is Inactive." `[Temporary]` is a Triggered Ability (816.1), it is printed
 * Rules Text, and while the Axe is Attached it does not function. The reminder is
 * accurate — it just is not the authority.
 *
 * # Scope, measured
 *
 * Spinning Axe is the ONLY Equipment in the pool printing `[Temporary]`; the
 * other three Temporary gear (SFD-104, UNL-078, UNL-085) have no `[Equip]` and
 * so can never be attached. Their reminders say the unconditional thing, which
 * is consistent. That asymmetry is asserted below, because if a later set prints
 * a second Temporary Equipment this file should already cover it.
 */

const registry = defaultCardRegistry();
const SPINNING_AXE = "SFD-186";
/** Any unit to wear it — the wearer's identity is not part of the rule. */
const WEARER = "OGN-002";

/** Player 0's Beginning Phase, with `gear` in their gear row. `runBeginning`
 *  sweeps the ACTIVE player's permanents only, so player 0 is active here. */
function beginningPhaseWith(gear: GearInstance[]): GameState {
  const state = makeState({ phase: "Beginning", activePlayerIndex: 0 });
  state.players[0]!.activeGear = gear;
  state.players[0]!.baseUnits = [realUnitInstance(WEARER)];
  return state;
}

const survives = (state: GameState): boolean =>
  state.players[0]!.activeGear.some((g) => g.defId === SPINNING_AXE);

describe("Spinning Axe (SFD-186): [Temporary] is Inactive while Attached (718.2)", () => {
  it("dies at the start of its controller's turn while UNATTACHED", () => {
    // The control. Without it, a change that stopped the sweep from running at
    // all would pass the test below and look like the fix.
    const axe = realGearInstance(SPINNING_AXE);
    const after = runBeginning(beginningPhaseWith([axe]));

    expect(survives(after), "the [Temporary] sweep no longer kills a loose gear at all").toBe(false);
  });

  it("SURVIVES while attached to a unit", () => {
    const wearer = realUnitInstance(WEARER);
    const axe: GearInstance = { ...realGearInstance(SPINNING_AXE), attachedToInstanceId: wearer.instanceId };
    const state = beginningPhaseWith([axe]);
    state.players[0]!.baseUnits = [wearer];

    const after = runBeginning(state);
    expect(survives(after), "an attached Equipment was killed by its own Inactive [Temporary]").toBe(true);
  });

  it("dies again once DETACHED — the state is not sticky", () => {
    // 718.1: "A card remains in this state until Detached." The sparing is a
    // property of the current attachment, not a permanent exemption earned by
    // having once been attached — which is what caching it on the instance, the
    // obvious alternative implementation, would produce.
    const wearer = realUnitInstance(WEARER);
    const attached: GearInstance = { ...realGearInstance(SPINNING_AXE), attachedToInstanceId: wearer.instanceId };
    const state = beginningPhaseWith([attached]);
    state.players[0]!.baseUnits = [wearer];

    const kept = runBeginning(state);
    expect(survives(kept), "the fixture never got past the first turn").toBe(true);

    // Back to the top of a Beginning Phase — `runBeginning` leaves the state in
    // the phase AFTER it, and calling it twice without this throws rather than
    // measuring anything.
    const loosened = { ...kept, phase: "Beginning" as const };
    loosened.players = [...kept.players] as GameState["players"];
    loosened.players[0] = {
      ...kept.players[0]!,
      activeGear: kept.players[0]!.activeGear.map((g) => ({ ...g, attachedToInstanceId: null })),
    };

    expect(survives(runBeginning(loosened)), "a once-attached gear became permanently immortal").toBe(false);
  });

  it("does not spare the OTHER Temporary gear, which cannot be attached anyway", () => {
    // The over-correction: reading the field as "spare anything not obviously
    // loose" — e.g. a truthy check that a `null` slips through differently, or
    // sparing on a missing field — would keep these alive forever.
    for (const defId of ["SFD-104", "UNL-078", "UNL-085"]) {
      const state = beginningPhaseWith([realGearInstance(defId)]);
      const after = runBeginning(state);
      expect(
        after.players[0]!.activeGear.some((g) => g.defId === defId),
        `${defId} stopped dying to [Temporary]`,
      ).toBe(false);
    }
  });
});

describe("the pool this rests on", () => {
  it("Spinning Axe is the only Equipment printing [Temporary]", () => {
    // If this fails, a new card has landed in the same shape and belongs in the
    // tests above — the sparing is generic, but nothing else exercises it.
    const temporaryEquipment = registry
      .all()
      .filter((d) => d.type === "Gear" && d.keywords?.Temporary !== undefined && d.keywords?.Equip !== undefined)
      .map((d) => d.id);

    expect(temporaryEquipment, "the set of Temporary Equipment changed").toEqual([SPINNING_AXE]);
  });

  it("...and it still prints the conditional reminder that started this", () => {
    expect(registry.get(SPINNING_AXE).text, "the reminder changed — re-read 718.2 against the new text").toContain(
      "If this is unattached",
    );
  });
});
