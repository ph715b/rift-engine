import { describe, expect, it } from "vitest";
import { destroyUnit } from "../src/engine/effect-helpers.js";
import { attachEquipment } from "../src/engine/equipment.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, realUnitInstance } from "./fixtures.js";

/**
 * The two FREE, MANDATORY death replacements — Guardian Angel's and Soraka's.
 *
 * Both sit beside Zhonya's Hourglass in `killUnit` rather than going through
 * `offerDeathReplacement`, because neither prints "you may": there is no
 * question to ask, so there is nothing to fold into the optional path.
 *
 * The interesting assertions are the NEGATIVES. A replacement that fires too
 * widely reads as a unit that simply stopped dying, and none of the positive
 * cases would catch it — so each of Soraka's three printed clauses ("another",
 * "here", "less Might than me") is pinned on its own.
 */

const registry = defaultCardRegistry();

const GUARDIAN_ANGEL = "SFD-051";
const SORAKA_WANDERER = "SFD-173";

const gear = (defId: string): GearInstance => createCardInstance(registry.get(defId)) as GearInstance;

/** Did the unit survive — i.e. is it back in base, healed and exhausted? */
const savedToBase = (state: GameState, id: string) =>
  state.players[0]!.baseUnits.find((u) => u.instanceId === id);

describe("Guardian Angel (SFD-051): kill the gear instead of its WEARER", () => {
  /** A wearer at bf1 with the Angel attached, plus a bystander beside it. */
  function board(attached: boolean): GameState {
    const state = makeState({ phase: "Action" });
    const angel = gear(GUARDIAN_ANGEL);
    state.players[0]!.activeGear = [angel];
    state.battlefields[0]!.units["p1"] = [
      makeUnit({ instanceId: "wearer", might: 3, damage: 2 }),
      makeUnit({ instanceId: "bystander", might: 3 }),
    ];
    return attached ? attachEquipment(state, 0, angel.instanceId, "wearer") : state;
  }

  it("saves its wearer and dies in its place", () => {
    const after = runCleanup(destroyUnit(board(true), "wearer"));

    const saved = savedToBase(after, "wearer");
    expect(saved, "the wearer was not recalled to base").toBeDefined();
    // "Heal me, exhaust me, and recall me" — all three.
    expect(saved!.damage, "it was not healed").toBe(0);
    expect(saved!.exhausted, "it was not exhausted").toBe(true);
    expect(after.players[0]!.activeGear, "the Angel did not die in its place").toHaveLength(0);
  });

  /**
   * **The whole difference from Zhonya's Hourglass**, which saves ANY friendly
   * unit. This one is matched by ATTACHMENT, so the unit beside its wearer is
   * not covered.
   */
  it("does NOT save a unit it is not attached to", () => {
    const after = runCleanup(destroyUnit(board(true), "bystander"));

    expect(savedToBase(after, "bystander"), "it saved somebody it was not worn by").toBeUndefined();
    expect(after.players[0]!.activeGear, "the Angel died for a unit it was not on").toHaveLength(1);
  });

  it("does nothing while UNATTACHED", () => {
    const after = runCleanup(destroyUnit(board(false), "wearer"));

    expect(savedToBase(after, "wearer"), "an unattached Angel still saved").toBeUndefined();
  });

  it("is claimed and carries no partial note", () => {
    expect(isCardImplemented(registry.get(GUARDIAN_ANGEL))).toBe(true);
    expect(partialImplementationNote(registry.get(GUARDIAN_ANGEL))).toBeUndefined();
  });
});

describe("Soraka - Wanderer (SFD-173): saves a smaller friendly unit HERE", () => {
  /** Soraka at bf1 with a smaller friendly beside her. */
  function board(opts: { allyMight?: number; sorakaHere?: boolean } = {}): GameState {
    const { allyMight = 2, sorakaHere = true } = opts;
    const state = makeState({ phase: "Action" });
    const soraka = { ...realUnitInstance(SORAKA_WANDERER), instanceId: "soraka" };
    state.battlefields[0]!.units["p1"] = [
      makeUnit({ instanceId: "ally", might: allyMight, damage: 1 }),
      ...(sorakaHere ? [soraka] : []),
    ];
    if (!sorakaHere) state.players[0]!.baseUnits = [soraka];
    return state;
  }

  it("saves a smaller friendly unit standing with her", () => {
    const after = runCleanup(destroyUnit(board(), "ally"));

    const saved = savedToBase(after, "ally");
    expect(saved, "the ally was not saved").toBeDefined();
    expect(saved!.damage, "it was not healed").toBe(0);
    expect(saved!.exhausted, "it was not exhausted").toBe(true);
  });

  /** "LESS Might than me" — strictly less, so an EQUAL unit dies. That is the
   *  difference between "less" and "no more", and it is the clause most likely
   *  to be written the loose way. */
  it("does NOT save a unit of EQUAL Might", () => {
    const printed = registry.get(SORAKA_WANDERER);
    const equalMight = printed.type === "Unit" ? printed.might : 4;
    const after = runCleanup(destroyUnit(board({ allyMight: equalMight }), "ally"));

    expect(savedToBase(after, "ally"), "an equal-Might unit was saved").toBeUndefined();
  });

  it("does NOT save a BIGGER unit", () => {
    const after = runCleanup(destroyUnit(board({ allyMight: 99 }), "ally"));

    expect(savedToBase(after, "ally"), "a bigger unit was saved").toBeUndefined();
  });

  /** "HERE" — she reaches nobody from base. */
  it("does NOT save from base", () => {
    const after = runCleanup(destroyUnit(board({ sorakaHere: false }), "ally"));

    expect(savedToBase(after, "ally"), "she saved from base").toBeUndefined();
  });

  /** "ANOTHER unit" — she cannot save herself, which is what stops her being
   *  unkillable. */
  it("does NOT save HERSELF", () => {
    const after = runCleanup(destroyUnit(board(), "soraka"));

    expect(savedToBase(after, "soraka"), "she saved herself").toBeUndefined();
  });

  it("does not reach a unit at another battlefield", () => {
    const state = board();
    state.battlefields[1]!.units["p1"] = [makeUnit({ instanceId: "far", might: 1 })];
    const after = runCleanup(destroyUnit(state, "far"));

    expect(savedToBase(after, "far"), "she reached another battlefield").toBeUndefined();
  });

  it("is claimed by a module", () => {
    expect(isCardImplemented(registry.get(SORAKA_WANDERER))).toBe(true);
  });
});
