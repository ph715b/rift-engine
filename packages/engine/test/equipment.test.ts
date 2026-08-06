import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { parseEquipCost } from "../src/cards/card-loader.js";
import {
  attachEquipment,
  detachAllFrom,
  detachEquipment,
  equipMightBonusOf,
  equipmentAttachedTo,
  equipmentMightBonusFor,
  isEquipmentGear,
} from "../src/engine/equipment.js";
import { activatedAbilityFor, activationCostOf, hasActivatableAbility } from "../src/engine/activated-abilities.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { destroyUnit } from "../src/engine/effect-helpers.js";
import { contextFor } from "../src/engine/effect-context.js";
import { partialImplementationNote } from "../src/engine/coverage.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, realGearInstance } from "./fixtures.js";

/**
 * Equipment attachment — SFD's headline subsystem.
 *
 * # The data gap this had to work around, and it is the finding
 *
 * **An Equipment's "+N Might" badge is in NO field of the card JSON.**
 * `attributes.might` is null on every one, and the badge appears in neither
 * `text.plain`, `text.rich` nor `accessibility_text`. It exists only on the
 * printed art: Doran's Blade shows a shield reading "+2" and its JSON says
 * nothing about it. About 20 of the 31 also have a SECOND ability rendered the
 * same art-only way, which is a larger gap still and is not covered here.
 *
 * So the badge is a hand-transcribed table, exactly like `powerDomainAlt`. The
 * values come from the frozen Java oracle, which surveyed all 31 — and two of
 * them were read off the card images independently here first, and agreed.
 */
const registry = defaultCardRegistry();

const DORANS_BLADE = "SFD-095"; // [Equip] 1 Body, +2 Might
const BFS = "SFD-161"; // B.F. Sword — [Equip] 1 Order, +3 Might
const SERRATED_DIRK = "SFD-009"; // [Equip] 1 Fury, +0 Might
const FORGEFIRE_CAPE = "SFD-190"; // rainbow cost — deliberately unwired
const LAST_RITES = "SFD-150"; // compound cost — deliberately unwired

const combat = { isCombat: false } as const;

describe("the Equipment data, which is mostly not in the data", () => {
  it("reads the +N badge from the table, since the JSON has none", () => {
    // The three values are independent, so a table that returned a constant
    // would fail here rather than looking plausible.
    expect(registry.get(DORANS_BLADE).equipMightBonus).toBe(2);
    expect(registry.get(BFS).equipMightBonus).toBe(3);
    expect(registry.get(SERRATED_DIRK).equipMightBonus).toBe(0);
    // And the gap itself, asserted so nobody "fixes" the table by parsing.
    const raw = registry.get(DORANS_BLADE);
    expect(raw.text).not.toContain("+2");
    expect(raw.type === "Gear" ? raw.might : undefined).toBeUndefined();
  });

  it("parses the [Equip] cost, which IS in the text", () => {
    expect(parseEquipCost("[Equip] :rb_rune_body: (reminder)")).toEqual({ energy: 0, domain: "Body", count: 1 });
    expect(parseEquipCost("[Equip] :rb_energy_1::rb_rune_fury:")).toEqual({ energy: 1, domain: "Fury", count: 1 });
    expect(parseEquipCost("[Equip] :rb_rune_rainbow:")).toEqual({ energy: 0, domain: "rainbow", count: 1 });
    expect(parseEquipCost("no equip here")).toBeUndefined();
  });

  it("refuses the two COMPOUND costs rather than half-reading them", () => {
    // A looser pattern would take the rune out of "[Equip] — :rb_rune_chaos:,
    // Recycle 2 cards from your trash" and hand the card an ability costing only
    // the rune — strictly CHEAPER than printed, which is the one direction this
    // codebase never ships.
    expect(registry.get(LAST_RITES).equipCost).toBeUndefined();
    expect(registry.get("SFD-178").equipCost).toBeUndefined();
    expect(registry.get(LAST_RITES).text).toContain("Recycle 2");
  });

  it("marks Equipment from the printed tag, not from having [Equip]", () => {
    expect(registry.get(DORANS_BLADE).isEquipment).toBe(true);
    // A non-Equipment Gear must not be swept in — Equipment is a printed tag and
    // `[Weaponmaster]`/Angle Shot mean exactly it.
    const plainGear = registry.all().find((c) => c.type === "Gear" && c.isEquipment !== true)!;
    expect(plainGear.isEquipment).toBeUndefined();
    expect(isEquipmentGear({ defId: plainGear.id })).toBe(false);
    expect(isEquipmentGear({ defId: DORANS_BLADE })).toBe(true);
  });
});

describe("attaching and detaching", () => {
  /** A unit at base with an unattached Doran's Blade in the same player's gear. */
  function board(gearDefId = DORANS_BLADE): { state: GameState; unitId: string; gearId: string } {
    const unit = makeUnit({ name: "Wearer", might: 3 });
    const gear = realGearInstance(gearDefId);
    const state = makeState();
    state.players[0]!.baseUnits = [unit];
    state.players[0]!.activeGear = [gear];
    return { state, unitId: unit.instanceId, gearId: gear.instanceId };
  }

  it("attaches, and the gear STAYS in activeGear", () => {
    // Attaching is not a zone change — `attachedToInstanceId` is state layered on
    // top, which is what lets an attached gear still be killed, readied and
    // counted like any other.
    const { state, unitId, gearId } = board();
    const after = attachEquipment(state, 0, gearId, unitId);
    expect(after.players[0]!.activeGear).toHaveLength(1);
    expect(after.players[0]!.activeGear[0]!.attachedToInstanceId).toBe(unitId);
    expect(equipmentAttachedTo(after, unitId).map((g) => g.instanceId)).toEqual([gearId]);
  });

  it("MOVES an already-attached Equipment rather than refusing", () => {
    // [Weaponmaster]'s own reminder is explicit — "even if it's already
    // attached" — so re-equipping relocates and needs no detach first.
    const { state, unitId, gearId } = board();
    const second = makeUnit({ name: "Second" });
    state.players[0]!.baseUnits.push(second);

    const moved = attachEquipment(attachEquipment(state, 0, gearId, unitId), 0, gearId, second.instanceId);

    expect(equipmentAttachedTo(moved, unitId)).toHaveLength(0);
    expect(equipmentAttachedTo(moved, second.instanceId)).toHaveLength(1);
  });

  it("does nothing when the gear is not that player's", () => {
    const { state, unitId, gearId } = board();
    expect(attachEquipment(state, 1, gearId, unitId)).toEqual(state);
  });

  it("detaches on request, leaving the gear in play", () => {
    const { state, unitId, gearId } = board();
    const after = detachEquipment(attachEquipment(state, 0, gearId, unitId), 0, gearId);
    expect(after.players[0]!.activeGear).toHaveLength(1);
    expect(after.players[0]!.activeGear[0]!.attachedToInstanceId).toBeNull();
  });
});

describe("the +N Might badge, applied continuously", () => {
  it("raises the wearer's effective Might, and only while attached", () => {
    const unit = makeUnit({ name: "Wearer", might: 3 });
    const gear = realGearInstance(DORANS_BLADE);
    const state = makeState();
    state.players[0]!.baseUnits = [unit];
    state.players[0]!.activeGear = [gear];

    expect(effectiveMight(state, unit, 0, combat)).toBe(3);
    const armed = attachEquipment(state, 0, gear.instanceId, unit.instanceId);
    expect(effectiveMight(armed, unit, 0, combat)).toBe(5);
    // Continuous, not a stored buff: detaching removes it in the same instant.
    const bare = detachEquipment(armed, 0, gear.instanceId);
    expect(effectiveMight(bare, unit, 0, combat)).toBe(3);
    expect(bare.players[0]!.baseUnits[0]!.buffed, "a stored buff would survive the detach").toBe(false);
  });

  it("stacks across several Equipment", () => {
    const unit = makeUnit({ name: "Wearer", might: 1 });
    const blade = realGearInstance(DORANS_BLADE); // +2
    const sword = realGearInstance(BFS); // +3
    const state = makeState();
    state.players[0]!.baseUnits = [unit];
    state.players[0]!.activeGear = [blade, sword];

    let armed = attachEquipment(state, 0, blade.instanceId, unit.instanceId);
    armed = attachEquipment(armed, 0, sword.instanceId, unit.instanceId);
    expect(equipmentMightBonusFor(armed, unit.instanceId)).toBe(5);
    expect(effectiveMight(armed, unit, 0, combat)).toBe(6);
  });

  it("gives nothing for a 0-badge Equipment, which is a real printed value", () => {
    expect(equipMightBonusOf({ defId: SERRATED_DIRK })).toBe(0);
  });
});

describe("a unit leaving play", () => {
  it("DETACHES its Equipment rather than destroying it", () => {
    // The Zero Drive's "Use only if unattached" and Spinning Axe's "if this is
    // unattached, kill it" both presuppose a gear outliving its wearer.
    const unit = makeUnit({ name: "Doomed", might: 2 });
    const gear = realGearInstance(DORANS_BLADE);
    const state = makeState();
    state.players[0]!.baseUnits = [unit];
    state.players[0]!.activeGear = [gear];
    const armed = attachEquipment(state, 0, gear.instanceId, unit.instanceId);

    // `destroyUnit`, NOT `killUnit`: killUnit expects the unit to have been
    // REMOVED from wherever it stood already, and calling it directly leaves the
    // board holding two of it. That trap is recorded in this repo and this test
    // walked straight into it on the first run.
    const after = destroyUnit(armed, unit.instanceId);

    expect(after.players[0]!.baseUnits, "the unit survived — the fixture is wrong").toHaveLength(0);
    expect(after.players[0]!.activeGear, "the gear was destroyed with its wearer").toHaveLength(1);
    expect(after.players[0]!.activeGear[0]!.attachedToInstanceId, "a dangling attachment").toBeNull();
  });

  it("detaches from BOTH sides, since control and ownership can differ", () => {
    // Nothing says an Equipment and its wearer share a controller, and
    // `takeControlOfUnit` already moves units between lists. Scanning one side
    // would leave a gear pointing at a unit that is gone — which reads in play as
    // a Might bonus from an Equipment attached to nothing.
    const unit = makeUnit({ name: "Shared" });
    const theirs = realGearInstance(DORANS_BLADE);
    const state = makeState();
    state.players[0]!.baseUnits = [unit];
    state.players[1]!.activeGear = [{ ...theirs, attachedToInstanceId: unit.instanceId }];

    const after = detachAllFrom(state, unit.instanceId);
    expect(after.players[1]!.activeGear[0]!.attachedToInstanceId).toBeNull();
  });
});

describe("the generated [Equip] ability", () => {
  it("gives 25 of the 31 Equipment a working ability, with no per-card code", () => {
    // The scope-reducer: the cost parses, the attach is generic, so a table
    // entry per card would be 25 copies of one thing, each free to drift.
    const equipment = registry.all().filter((c) => c.type === "Gear" && c.isEquipment === true);
    expect(equipment).toHaveLength(31);
    const wired = equipment.filter((c) => hasActivatableAbility(c.id));
    expect(wired).toHaveLength(25);
  });

  it("costs what the card prints, and does NOT exhaust", () => {
    // An exhaust nobody printed would make every Equipment a once-per-turn
    // attach, and re-equipping is the point.
    expect(activationCostOf(DORANS_BLADE)).toEqual({ power: { domain: "Body", count: 1 } });
    expect(activationCostOf("SFD-030")).toMatchObject({ energy: 1, power: { domain: "Fury", count: 1 } });
    expect(activationCostOf(DORANS_BLADE).exhaust).toBeUndefined();
  });

  it("attaches when it resolves, to the unit the activation named", () => {
    const unit = makeUnit({ name: "Wearer", might: 3 });
    const gear = realGearInstance(DORANS_BLADE);
    const state = makeState();
    state.players[0]!.baseUnits = [unit];
    state.players[0]!.activeGear = [gear];

    const ability = activatedAbilityFor(DORANS_BLADE);
    expect(ability, "Doran's Blade has no generated ability").toBeDefined();
    const after = ability!.resolve!(
      state,
      contextFor(0),
      { targetUnitInstanceId: unit.instanceId },
      gear.instanceId,
    );
    expect(equipmentAttachedTo(after, unit.instanceId)).toHaveLength(1);
    expect(effectiveMight(after, unit, 0, combat)).toBe(5);
  });

  it("leaves the 6 it cannot price UNWIRED, and each says why", () => {
    // Four rainbow costs (ActivationCost names one domain, and rainbow is not a
    // domain) and two compound costs. Named individually rather than under a
    // keyword flag, which would have greyed the 25 that work along with them.
    for (const defId of [FORGEFIRE_CAPE, "SFD-191", "SFD-192", "SFD-186"]) {
      expect(hasActivatableAbility(defId), `${defId} should be unwired`).toBe(false);
      expect(partialImplementationNote(registry.get(defId))).toContain("RAINBOW");
    }
    for (const defId of [LAST_RITES, "SFD-178"]) {
      expect(hasActivatableAbility(defId)).toBe(false);
      expect(partialImplementationNote(registry.get(defId))).toContain("compound cost");
    }
  });
});
