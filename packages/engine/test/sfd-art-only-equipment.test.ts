import { describe, expect, it } from "vitest";
import { attachEquipment } from "../src/engine/equipment.js";
import { effectiveKeywords } from "../src/engine/granted-keywords.js";
import { modifiedDamageAmount } from "../src/engine/damage-modifiers.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { beginCombatAt, makeState, makeUnit } from "./fixtures.js";

/**
 * The last three ART-ONLY Equipment halves.
 *
 * None of this text is in the card data — each card's `text.plain` holds its
 * `[Equip]` line and nothing else, which is exactly why all three reported
 * IMPLEMENTED while doing none of it. Transcribed from the card images; see
 * docs/sfd-equipment-abilities.md.
 *
 * Each was PARTIAL for a named reason, and the reasons were different:
 * Forgefire Cape needed the wearer's-moments mechanism, Rabadon's Deathcrown a
 * damage modifier gated on ATTACHMENT, and Shurelya's Requiem an aura source
 * `KEYWORD_AURAS` could not express — a gear that borrows its wearer's square.
 */

const registry = defaultCardRegistry();

const FORGEFIRE_CAPE = "SFD-190";
const RABADONS_DEATHCROWN = "SFD-191";
const SHURELYAS_REQUIEM = "SFD-192";

const gear = (defId: string): GearInstance => createCardInstance(registry.get(defId)) as GearInstance;

describe("Forgefire Cape (SFD-190): when I attack or defend, deal 2 to all enemy units here", () => {
  /** A wearer and an enemy at bf1, with the Cape attached. Both sides present,
   *  which is what makes the Showdown a COMBAT and hands out designations. */
  function board(): GameState {
    const state = makeState({ phase: "Action" });
    const cape = gear(FORGEFIRE_CAPE);
    state.players[0]!.activeGear = [cape];
    state.battlefields[0]!.units["p1"] = [makeUnit({ instanceId: "wearer", might: 4 })];
    state.battlefields[0]!.units["p2"] = [
      makeUnit({ instanceId: "enemy-a", might: 4 }),
      makeUnit({ instanceId: "enemy-b", might: 4 }),
    ];
    return attachEquipment(state, 0, cape.instanceId, "wearer");
  }

  const damageOf = (state: GameState, id: string) =>
    state.battlefields[0]!.units["p2"]!.find((u) => u.instanceId === id)?.damage ?? 0;

  it("burns EVERY enemy unit at the battlefield when its wearer is designated", () => {
    const after = beginCombatAt(board(), "bf1", 0);

    // "ALL enemy units here" — both, not just one.
    expect(damageOf(after, "enemy-a"), "the first enemy took no burn").toBe(2);
    expect(damageOf(after, "enemy-b"), "the burn hit only one unit").toBe(2);
  });

  it("leaves the wearer's own side alone", () => {
    const after = beginCombatAt(board(), "bf1", 0);
    const wearer = after.battlefields[0]!.units["p1"]!.find((u) => u.instanceId === "wearer")!;

    expect(wearer.damage, "it burned its own side").toBe(0);
  });

  /** "Attack OR DEFEND" — both designations, so it fires with the OPPONENT as
   *  the attacker too. A side comparison instead of bare designation would make
   *  this half of the card silent. */
  it("fires when its wearer is the DEFENDER", () => {
    const after = beginCombatAt(board(), "bf1", 1);

    expect(damageOf(after, "enemy-a"), "it fired only while attacking").toBe(2);
  });

  /** No wearer, no moment: the gear's listener is rewritten as the unit wearing
   *  it, and an unattached Cape has none. */
  it("does nothing while unattached", () => {
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [gear(FORGEFIRE_CAPE)];
    state.battlefields[0]!.units["p1"] = [makeUnit({ instanceId: "wearer", might: 4 })];
    state.battlefields[0]!.units["p2"] = [makeUnit({ instanceId: "enemy-a", might: 4 })];

    const after = beginCombatAt(state, "bf1", 0);

    expect(damageOf(after, "enemy-a"), "an unattached Cape still burned").toBe(0);
  });

  it("is claimed and carries no partial note", () => {
    expect(isCardImplemented(registry.get(FORGEFIRE_CAPE))).toBe(true);
    expect(partialImplementationNote(registry.get(FORGEFIRE_CAPE))).toBeUndefined();
  });
});

describe("Rabadon's Deathcrown (SFD-191): +3 Bonus Damage while ATTACHED", () => {
  function board(attached: boolean): GameState {
    const state = makeState({ phase: "Action" });
    const crown = gear(RABADONS_DEATHCROWN);
    state.players[0]!.activeGear = [crown];
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "wearer" })];
    return attached ? attachEquipment(state, 0, crown.instanceId, "wearer") : state;
  }

  it("adds 3 while attached", () => {
    expect(modifiedDamageAmount(board(true), 0, 2), "the bonus did not apply").toBe(5);
  });

  /** "While this is ATTACHED" — a Deathcrown sitting unattached in `activeGear`
   *  grants nothing, which is the whole reason it is not simply keyed to the
   *  card being in play. */
  it("adds nothing while unattached", () => {
    expect(modifiedDamageAmount(board(false), 0, 2), "an unattached crown still paid out").toBe(2);
  });

  /** "YOUR spells and abilities" — read off the CASTER's gear, so the opponent's
   *  damage is unaffected. */
  it("does not boost the opponent", () => {
    expect(modifiedDamageAmount(board(true), 1, 2)).toBe(2);
  });

  it("is claimed and carries no partial note", () => {
    expect(isCardImplemented(registry.get(RABADONS_DEATHCROWN))).toBe(true);
    expect(partialImplementationNote(registry.get(RABADONS_DEATHCROWN))).toBeUndefined();
  });
});

describe("Shurelya's Requiem (SFD-192): your units HERE have [Ganking]", () => {
  /** The Requiem worn by a unit at bf1, a second friendly beside it, and a third
   *  friendly at bf2 — so "here" can be told from "anywhere". */
  function board(): GameState {
    const state = makeState({ phase: "Action" });
    const requiem = gear(SHURELYAS_REQUIEM);
    state.players[0]!.activeGear = [requiem];
    state.battlefields[0]!.units["p1"] = [
      makeUnit({ instanceId: "wearer" }),
      makeUnit({ instanceId: "neighbour" }),
    ];
    state.battlefields[1]!.units["p1"] = [makeUnit({ instanceId: "far-away" })];
    return attachEquipment(state, 0, requiem.instanceId, "wearer");
  }

  const gankingAt = (state: GameState, bf: 0 | 1, id: string) =>
    effectiveKeywords(state, state.battlefields[bf]!.units["p1"]!.find((u) => u.instanceId === id)!, 0)["Ganking"];

  it("grants [Ganking] to a friendly unit at the wearer's battlefield", () => {
    expect(gankingAt(board(), 0, "neighbour"), "the aura did not reach a neighbour").toBe(1);
  });

  it("grants it to the WEARER too — a gear is not a unit, so nothing is excluded", () => {
    expect(gankingAt(board(), 0, "wearer")).toBe(1);
  });

  /** "HERE" is the wearer's square. This is the whole reason a plain `"gear"`
   *  source could not express the card: a gear has no location of its own. */
  it("does NOT reach a friendly unit at another battlefield", () => {
    expect(gankingAt(board(), 1, "far-away"), "the aura was not positional").toBeUndefined();
  });

  it("does not reach the OPPONENT's units standing there", () => {
    const state = board();
    state.battlefields[0]!.units["p2"] = [makeUnit({ instanceId: "enemy" })];
    const enemy = state.battlefields[0]!.units["p2"]![0]!;

    expect(effectiveKeywords(state, enemy, 1)["Ganking"], "\"your units\" reached the enemy").toBeUndefined();
  });

  /** No wearer, no square to be "here" at. */
  it("grants nothing while unattached", () => {
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [gear(SHURELYAS_REQUIEM)];
    state.battlefields[0]!.units["p1"] = [makeUnit({ instanceId: "neighbour" })];

    expect(gankingAt(state, 0, "neighbour"), "an unattached Requiem still granted").toBeUndefined();
  });

  /** A wearer in BASE is at no battlefield, so "here" reaches nobody — the same
   *  reading every other positional aura in the engine takes. */
  it("grants nothing while its wearer stands in base", () => {
    const state = makeState({ phase: "Action" });
    const requiem = gear(SHURELYAS_REQUIEM);
    state.players[0]!.activeGear = [requiem];
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "wearer" })];
    state.battlefields[0]!.units["p1"] = [makeUnit({ instanceId: "neighbour" })];
    const worn = attachEquipment(state, 0, requiem.instanceId, "wearer");

    expect(gankingAt(worn, 0, "neighbour"), "a base wearer granted [Ganking] at a battlefield").toBeUndefined();
  });

  it("is claimed and carries no partial note", () => {
    expect(isCardImplemented(registry.get(SHURELYAS_REQUIEM))).toBe(true);
    expect(partialImplementationNote(registry.get(SHURELYAS_REQUIEM))).toBeUndefined();
  });
});
