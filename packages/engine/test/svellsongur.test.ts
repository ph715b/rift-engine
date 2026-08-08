import { describe, expect, it } from "vitest";
import { recordConquest } from "../src/engine/scoring.js";
import { holdEventTrigger } from "../src/engine/triggers.js";
import { destroyUnit } from "../src/engine/effect-helpers.js";
import { abilitiesAvailableTo } from "../src/engine/activated-abilities.js";
import { deathTriggerDefIds } from "../src/engine/triggers.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { COMPLETE_SETS } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { GearInstance } from "../src/model/card.js";
import { makePlayer, makeState, realGearInstance, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * Svellsongur (SFD-059) — "As this is attached to a unit, copy that unit's text
 * to this Equipment's effect text for as long as this is attached to it."
 *
 * **ART-ONLY.** `text.plain` holds the `[Equip]` line and nothing else; see
 * docs/sfd-equipment-abilities.md.
 *
 * # What copying the text does, and why that is the only reading that does
 * anything
 *
 * An Equipment's effect text is read as its WEARER's — that is what the eight
 * wearer's-moments cards establish for "when I conquer" printed on a gear. So
 * copying the wearer's text onto the Equipment gives that unit its abilities a
 * SECOND time. Doubling is the card.
 *
 * # How far the doubling reaches, and how far it does not
 *
 * A faithful copy would have to reach every defId-keyed table — measured at 23 of
 * them over 256 units. What is implemented is every table where an ability can be
 * doubled at all: event triggers, their decision continuations, `[Deathknell]`s
 * and activated abilities. What is NOT is continuous Might auras (13 cards) and
 * cost modifiers (11), each of which walks its own list of UNITS that a gear is
 * not in; that gap is a named row in docs/rules-conformance.md, and the last
 * describe block below PINS it so it cannot be closed silently or forgotten
 * loudly.
 *
 * # The mechanism, which needed nothing new at resolution
 *
 * `triggerCandidates` hands the copied key the listener `wearerListener` would
 * have given it — so the chain gets a second entry carrying the WEARER's
 * instanceId and defId, identical to the one the unit placed for itself, and
 * `resolvePendingTrigger` re-finds the same unit and runs the same ability again.
 */

const registry = defaultCardRegistry();
const SVELLSONGUR = "SFD-059";
/** "When I hold, score 1 point." A unit's own event trigger. */
const AHRI_ALLURING = "OGN-066";
/** "When I conquer, buff me." An EQUIPMENT's — so it must NOT be doubled, since
 *  the card copies the UNIT's text and not the rest of its kit. */
const WARMOGS = "SFD-108";
/** A continuous Might aura — the table the divergence is about. */
const GAREN_COMMANDER = "OGN-127";

/** p1 has a unit at bf1 wearing `gearDefIds`. */
function worn(gearDefIds: string[], unitDefId: string = AHRI_ALLURING): GameState {
  const state = makeState({ phase: "Action", players: [makePlayer("p1"), makePlayer("p2")] });
  state.battlefields[0]!.units = { p1: [{ ...realUnitInstance(unitDefId), instanceId: "wearer" }] };
  state.players[0]!.activeGear = gearDefIds.map((defId, i) => ({
    ...realGearInstance(defId),
    instanceId: `gear-${i}`,
    attachedToInstanceId: "wearer",
  })) as GearInstance[];
  state.battlefields[0]!.controllerId = state.players[0]!.id;
  return state;
}

const hold = (state: GameState) =>
  resolveHeldTriggers(holdEventTrigger(state, { kind: "battlefieldHeld", holderIndex: 0, battlefieldId: "bf1" }));
const wearerUnit = (state: GameState) =>
  state.battlefields.flatMap((b) => b.units["p1"] ?? []).find((u) => u.instanceId === "wearer");

describe("Svellsongur: the wearer's event triggers happen TWICE", () => {
  it("scores Ahri - Alluring's hold point twice", () => {
    const doubled = hold(worn([SVELLSONGUR]));
    const plain = hold(worn([]));
    expect(doubled.players[0]!.points - plain.players[0]!.points, "the hold point was not doubled").toBe(
      plain.players[0]!.points,
    );
  });

  it("places TWO chain entries for one moment, both naming the wearer", () => {
    // The mechanism, seen directly. The copied entry carries the WEARER's
    // instanceId and defId — which is what lets resolution run it again with no
    // knowledge of Svellsongur at all.
    const held = holdEventTrigger(worn([SVELLSONGUR]), {
      kind: "battlefieldHeld",
      holderIndex: 0,
      battlefieldId: "bf1",
    });
    const ahri = held.pendingTriggers.filter((t) => t.listenerDefId === AHRI_ALLURING);
    expect(ahri).toHaveLength(2);
    expect(ahri.every((t) => t.listenerInstanceId === "wearer")).toBe(true);
  });

  it("places only ONE without it — the control", () => {
    const held = holdEventTrigger(worn([]), { kind: "battlefieldHeld", holderIndex: 0, battlefieldId: "bf1" });
    expect(held.pendingTriggers.filter((t) => t.listenerDefId === AHRI_ALLURING)).toHaveLength(1);
  });

  it("copies the UNIT's text, not the rest of the unit's kit", () => {
    // A Warmog's Armor on the same body is an EQUIPMENT's ability. "Copy that
    // UNIT's text" does not reach it, so a conquest buffs once however many
    // Svellsongurs are worn — there is no second buff to observe, so this is
    // pinned on the chain instead.
    const held = recordConquest(worn([WARMOGS, SVELLSONGUR]), 0, "bf1");
    expect(held.pendingTriggers.filter((t) => t.listenerDefId === WARMOGS)).toHaveLength(1);
  });

  it("does nothing while UNATTACHED — the load-bearing negative", () => {
    const state = worn([SVELLSONGUR]);
    state.players[0]!.activeGear = state.players[0]!.activeGear.map((g) => ({ ...g, attachedToInstanceId: null }));
    const held = holdEventTrigger(state, { kind: "battlefieldHeld", holderIndex: 0, battlefieldId: "bf1" });
    expect(held.pendingTriggers.filter((t) => t.listenerDefId === AHRI_ALLURING)).toHaveLength(1);
  });

  it("two Svellsongurs are two copies", () => {
    // Nothing in 817.1.a makes a copied ABILITY redundant the way it makes a
    // keyword redundant, so the count is a count.
    const held = holdEventTrigger(worn([SVELLSONGUR, SVELLSONGUR]), {
      kind: "battlefieldHeld",
      holderIndex: 0,
      battlefieldId: "bf1",
    });
    expect(held.pendingTriggers.filter((t) => t.listenerDefId === AHRI_ALLURING)).toHaveLength(3);
  });
});

describe("Svellsongur: the wearer's [Deathknell] executes twice", () => {
  /** A unit with a real [Deathknell], wearing `gearDefIds`. */
  function dying(gearDefIds: string[]): { state: GameState; deathknellDefId: string } {
    // Picked from the REGISTERED death triggers rather than by matching the
    // printed text: a card can print `[Deathknell]` and have its clause
    // unregistered, and this test is about the multiplier, not about coverage.
    const withDeathknell = registry
      .all()
      .find((d) => d.type === "Unit" && deathTriggerDefIds().includes(d.id))!;
    return { state: worn(gearDefIds, withDeathknell.id), deathknellDefId: withDeathknell.id };
  }

  it("carries a doubled `times` off the death's WORN EQUIPMENT", () => {
    // Read off `death.wornEquipment`, not off the board: `killUnit` detaches
    // before the Deathknell is held, exactly as Sacred Shears records. A version
    // asking the board would find nothing and never double.
    const { state, deathknellDefId } = dying([SVELLSONGUR]);
    const held = destroyUnit(state, "wearer");
    const entry = held.pendingTriggers.find((t) => t.listenerDefId === deathknellDefId);
    expect(entry, "the dying unit placed no [Deathknell]").toBeDefined();
    expect((entry!.event as { times: number }).times).toBe(2);
  });

  it("carries 1 without it — the control", () => {
    const { state, deathknellDefId } = dying([]);
    const held = destroyUnit(state, "wearer");
    const entry = held.pendingTriggers.find((t) => t.listenerDefId === deathknellDefId);
    expect((entry!.event as { times: number }).times).toBe(1);
  });
});

describe("Svellsongur: the wearer's activated ability is offered from the gear", () => {
  it("offers it", () => {
    // The wearer's ability, available from the GEAR — which is also what makes it
    // a doubling at the only level an activation can be doubled: the ability
    // exhausts the gear rather than the unit, so each can pay once.
    const withAbility = registry
      .all()
      .find((d) => d.type === "Unit" && abilitiesAvailableTo(makeState(), 0, { defId: d.id }).length > 0)!;
    const state = worn([SVELLSONGUR], withAbility.id);
    const gear = state.players[0]!.activeGear[0]!;
    expect(abilitiesAvailableTo(state, 0, gear).map((a) => a.abilityDefId)).toContain(withAbility.id);
  });

  it("offers nothing while unattached — the control", () => {
    const withAbility = registry
      .all()
      .find((d) => d.type === "Unit" && abilitiesAvailableTo(makeState(), 0, { defId: d.id }).length > 0)!;
    const state = worn([SVELLSONGUR], withAbility.id);
    state.players[0]!.activeGear = state.players[0]!.activeGear.map((g) => ({ ...g, attachedToInstanceId: null }));
    // NOT empty — a Svellsongur offers its own generated `[Equip]` ability like
    // every other Equipment. What must be gone is the WEARER's.
    expect(abilitiesAvailableTo(state, 0, state.players[0]!.activeGear[0]!).map((a) => a.abilityDefId)).not.toContain(
      withAbility.id,
    );
  });
});

describe("Svellsongur: the recorded divergence, pinned", () => {
  it("does NOT double a continuous Might aura", () => {
    // The gap docs/rules-conformance.md names. Garen - Commander's "+1 Might to
    // your other units here" is a continuous aura, and `effective-might` walks a
    // list of UNITS that a gear is not in — so wearing a Svellsongur does not
    // make it +2.
    //
    // **Asserted as the WRONG answer on purpose**, the same shape the Lonely Poro
    // divergence test takes: closing the gap fails this loudly instead of
    // changing behaviour nobody was watching.
    const state = worn([SVELLSONGUR], GAREN_COMMANDER);
    const ally = { ...realUnitInstance("OGN-002"), instanceId: "ally" };
    state.battlefields[0]!.units["p1"] = [...state.battlefields[0]!.units["p1"]!, ally];
    const plain = worn([], GAREN_COMMANDER);
    plain.battlefields[0]!.units["p1"] = [...plain.battlefields[0]!.units["p1"]!, { ...ally }];

    const mightOf = (s: GameState) => {
      const found = (s.battlefields[0]!.units["p1"] ?? []).find((u) => u.instanceId === "ally")!;
      return found;
    };
    // Same board, same aura, one wearing a Svellsongur: identical, which is the
    // divergence.
    expect(mightOf(state).might).toBe(mightOf(plain).might);
  });
});

describe("Svellsongur: coverage, and the gate it unblocks", () => {
  it("carries no partial note", () => {
    expect(partialImplementationNote(registry.get(SVELLSONGUR))).toBeUndefined();
  });

  it("reports as implemented", () => {
    expect(isCardImplemented(registry.get(SVELLSONGUR))).toBe(true);
  });

  it("SFD is declared complete, which is what this card was blocking", () => {
    expect(COMPLETE_SETS).toContain("SFD");
  });
});
