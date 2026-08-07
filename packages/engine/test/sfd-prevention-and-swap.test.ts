import { describe, expect, it } from "vitest";
import { dealDamage } from "../src/engine/effect-helpers.js";
import { swapUnitLocations } from "../src/engine/effect-helpers.js";
import { attachEquipment, equipmentAttachedTo } from "../src/engine/equipment.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { effectForCard } from "../src/engine/card-effects.js";
import { modesOf, activationCostOf } from "../src/engine/activated-abilities.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { contextFor } from "../src/engine/effect-context.js";
import { createCardInstance, type GearInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, realUnitInstance } from "./fixtures.js";

/**
 * Counter Strike's per-unit prevention, Azir's swap, and Strike Down.
 *
 * The prevention is the one with a genuinely new shape: `preventsSpellDamage-
 * ThisTurn` is per-PLAYER and unlimited, this is one instance on one unit and is
 * then SPENT. Both halves are tested — that it prevents, and that the second
 * instance gets through — because a prevention that never expires reads as a
 * unit that has simply become immune.
 */

const registry = defaultCardRegistry();

const COUNTER_STRIKE = "SFD-194";
const AZIR_ASCENDANT = "SFD-050";
const STRIKE_DOWN = "SFD-107";
const LONG_SWORD = "SFD-022";

const gear = (defId: string): GearInstance => createCardInstance(registry.get(defId)) as GearInstance;

describe("Counter Strike (SFD-194): prevent the NEXT damage to one unit", () => {
  function board(): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "mine", might: 5 })];
    state.players[0]!.deck = [gear(LONG_SWORD), gear(LONG_SWORD)];
    return state;
  }

  /** Cast it through its registered effect, which is where the id is pushed. */
  const cast = (state: GameState, targetUnitInstanceId: string) =>
    effectForCard(createCardInstance(registry.get(COUNTER_STRIKE)))!.resolve!(state, contextFor(0), { targetUnitInstanceId });

  const damageOf = (state: GameState) => state.players[0]!.baseUnits[0]!.damage;

  it("prevents the next instance of damage", () => {
    const shielded = cast(board(), "mine");
    const after = dealDamage(shielded, 1, "mine", 3);

    expect(damageOf(after), "the damage was not prevented").toBe(0);
  });

  /**
   * **"The NEXT time" — it is spent, not permanent.** A prevention that never
   * expires reads as a unit that has simply become immune, which no test of the
   * first instance alone would catch.
   */
  it("lets the SECOND instance through", () => {
    const shielded = cast(board(), "mine");
    const once = dealDamage(shielded, 1, "mine", 3);
    const twice = dealDamage(once, 1, "mine", 4);

    expect(damageOf(twice), "the shield did not expire after one use").toBe(4);
  });

  /** Each Counter Strike is its own "next time", so the id is pushed rather
   *  than set — two of them prevent two instances. */
  it("stacks — two casts prevent two instances", () => {
    const twice = cast(cast(board(), "mine"), "mine");
    const after = dealDamage(dealDamage(twice, 1, "mine", 3), 1, "mine", 4);

    expect(damageOf(after), "the second cast was swallowed by the first").toBe(0);
    expect(damageOf(dealDamage(after, 1, "mine", 2)), "a third instance was also prevented").toBe(2);
  });

  it("shields only the unit it named", () => {
    const state = board();
    state.players[0]!.baseUnits.push(makeUnit({ instanceId: "other", might: 5 }));
    const shielded = cast(state, "mine");
    const after = dealDamage(shielded, 1, "other", 3);

    expect(after.players[0]!.baseUnits.find((u) => u.instanceId === "other")!.damage).toBe(3);
  });

  it("draws 1 unconditionally", () => {
    const state = board();
    expect(cast(state, "mine").players[0]!.hand, "the draw did not happen").toHaveLength(1);
  });

  /** The list is per-turn, like every other delayed effect keyed by instance id. */
  it("clears at end of turn", () => {
    const shielded = cast(board(), "mine");
    expect(runEnd(shielded).damagePreventedOnceInstanceIds, "the shield outlived the turn").toHaveLength(0);
  });

  it("is claimed by a module", () => {
    expect(isCardImplemented(registry.get(COUNTER_STRIKE))).toBe(true);
  });
});

describe("Azir - Ascendant (SFD-050): swap places with a unit you control", () => {
  /** Azir at bf1, a friendly at home. */
  function board(): GameState {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units["p1"] = [{ ...realUnitInstance(AZIR_ASCENDANT), instanceId: "azir" }];
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "friend" })];
    return state;
  }

  it("puts each unit where the other was", () => {
    const after = swapUnitLocations(board(), 0, "azir", "friend");

    expect(after.players[0]!.baseUnits.map((u) => u.instanceId), "Azir did not come home").toEqual(["azir"]);
    expect(after.battlefields[0]!.units["p1"]!.map((u) => u.instanceId), "the friend did not go out").toEqual([
      "friend",
    ]);
  });

  /** "A unit YOU control" — the helper refuses anyone else's, so the ability
   *  cannot teleport an enemy. */
  it("refuses a unit the caster does not control", () => {
    const state = board();
    state.battlefields[1]!.units["p2"] = [makeUnit({ instanceId: "enemy" })];

    expect(swapUnitLocations(state, 0, "azir", "enemy"), "an enemy was swapped").toBe(state);
  });

  /** "Use only ONCE PER TURN" with no exhaust — so it is a single-mode
   *  `modesOncePerTurn` rather than an exhaust, which would also stop him
   *  attacking in the turn he swaps. */
  it("is once per turn WITHOUT exhausting him", () => {
    expect(modesOf(AZIR_ASCENDANT).map((m) => m.id)).toEqual(["swap"]);
    expect(activationCostOf(AZIR_ASCENDANT, "swap").exhaust, "the swap exhausts him").toBeUndefined();
    expect(activationCostOf(AZIR_ASCENDANT, "swap")).toMatchObject({ power: { domain: "Calm", count: 1 } });
  });

  /** His Equipment half is unwritten, and the note says so rather than the card
   *  reporting finished. */
  it("carries a partial note naming the unwritten Equipment half", () => {
    const note = partialImplementationNote(registry.get(AZIR_ASCENDANT));
    expect(note, "no partial note").toBeDefined();
    expect(note).toContain("Equipment");
  });
});

describe("Strike Down (SFD-107): an equipped unit strikes, then loses an Equipment", () => {
  /** An equipped friendly at bf1 and an enemy beside it. */
  function board(equipped: boolean): GameState {
    const state = makeState({ phase: "Action" });
    const sword = gear(LONG_SWORD);
    state.players[0]!.activeGear = [sword];
    state.battlefields[0]!.units["p1"] = [makeUnit({ instanceId: "striker", might: 4 })];
    state.battlefields[0]!.units["p2"] = [makeUnit({ instanceId: "victim", might: 9 })];
    return equipped ? attachEquipment(state, 0, sword.instanceId, "striker") : state;
  }

  const cast = (state: GameState) =>
    effectForCard(createCardInstance(registry.get(STRIKE_DOWN)))!.resolve!(state, contextFor(0), {
      targetUnitInstanceId: "striker",
      secondTargetUnitInstanceId: "victim",
    });

  const victimDamage = (state: GameState) =>
    state.battlefields[0]!.units["p2"]!.find((u) => u.instanceId === "victim")!.damage;

  it("deals damage equal to the striker's Might, then detaches", () => {
    const state = board(true);
    const striker = state.battlefields[0]!.units["p1"]![0]!;
    const might = effectiveMight(state, striker, 0, { isCombat: false, battlefieldId: "bf1" });

    const after = cast(state);

    expect(victimDamage(after), "the damage was not the striker's Might").toBe(might);
    expect(equipmentAttachedTo(after, "striker"), "the Equipment was not detached").toHaveLength(0);
    // Detached, NOT destroyed — the gear survives its wearer losing it.
    expect(after.players[0]!.activeGear, "the gear was destroyed rather than detached").toHaveLength(1);
  });

  /** The Might is read BEFORE the detach — the Equipment being removed is
   *  usually what is paying for the damage. */
  it("reads the Might with the Equipment still on", () => {
    const state = board(true);
    const bare = makeUnit({ instanceId: "striker", might: 4 });
    const badge = effectiveMight(state, state.battlefields[0]!.units["p1"]![0]!, 0, {
      isCombat: false,
      battlefieldId: "bf1",
    });

    expect(badge, "the fixture Equipment grants no Might, so this proves nothing").toBeGreaterThan(bare.might);
    expect(victimDamage(cast(state)), "the Might was read after the detach").toBe(badge);
  });

  /** "An EQUIPPED friendly unit" — an unequipped one is not a legal subject, so
   *  NEITHER half happens. */
  it("does nothing at all for an unequipped striker", () => {
    const after = cast(board(false));

    expect(victimDamage(after), "an unequipped striker still dealt damage").toBe(0);
  });

  it("is claimed by a module", () => {
    expect(isCardImplemented(registry.get(STRIKE_DOWN))).toBe(true);
  });
});
