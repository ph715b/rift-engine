import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { answerDecision, optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { equipmentAttachedTo } from "../src/engine/equipment.js";
import { createCardInstance, type GearInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { beginCombatAt, makeState, makeUnit, realUnitInstance } from "./fixtures.js";

/**
 * Rell - Magnetic (SFD-024) — "[Tank] When I attack, you may play an Equipment
 * with Energy cost no more than [2] from hand, ignoring its cost. If you do,
 * then do this: Attach it to me."
 *
 * # The moment
 *
 * `combatBegan` with `isAttackingAt`, the shared adapter every "when I attack"
 * card here uses. The combat is driven through the real Cleanup by
 * `beginCombatAt` rather than by synthesising the event, which is trap 6: a test
 * that hands a trigger its own precondition tests the trigger and not the
 * designation.
 *
 * # The three things worth pinning separately
 *
 *  - **The ceiling is on the PRINTED Energy cost.** The play ignores the cost, so
 *    there is no modified price to compare against.
 *  - **"You MAY" is a real decline**, and declining must play nothing.
 *  - **"If you do, THEN do this"** ties the attach to the play — a declined offer
 *    attaches nothing, and a played Equipment must actually end up on Rell rather
 *    than merely in play.
 */

const registry = defaultCardRegistry();
const RELL_MAGNETIC = "SFD-024";
const DORANS_BLADE = "SFD-095"; // 2 Energy Equipment — exactly on the ceiling
const ZERO_DRIVE = "SFD-090"; // 3 Energy Equipment — over it
const ENERGY_CONDUIT = "OGN-098"; // a NON-Equipment gear

const gear = (defId: string, instanceId: string): GearInstance =>
  ({ ...createCardInstance(registry.get(defId)), instanceId }) as GearInstance;

/** Rell at bf1 with an enemy walking in, so SHE is the defender unless the
 *  contest is hers. `attackerIndex: 0` makes p1 the Attacker. */
function board(hand: GearInstance[]): GameState {
  const state = makeState({ phase: "Action" });
  state.battlefields.find((b) => b.id === "bf1")!.units = {
    p1: [{ ...realUnitInstance(RELL_MAGNETIC), instanceId: "rell" }],
    p2: [makeUnit({ instanceId: "enemy", name: "Enemy" })],
  };
  state.players[0]!.hand = hand;
  return state;
}

const attack = (state: GameState) => beginCombatAt(state, "bf1", 0);

describe("Rell - Magnetic's on-attack Equipment offer", () => {
  it("offers each eligible Equipment in hand, plus a decline", () => {
    const opened = attack(board([gear(DORANS_BLADE, "blade")]));
    const decision = pendingDecision(opened);

    expect(decision?.kind, "no offer was raised on the attack").toBe("SFD-024-equip");
    expect(optionsFor(opened, decision!).map((o) => o.id).sort()).toEqual(["blade", "decline"]);
  });

  it("plays the chosen Equipment for free and attaches it to Rell", () => {
    const opened = attack(board([gear(DORANS_BLADE, "blade")]));
    const after = answerDecision(opened, pendingDecision(opened)!.id, "blade")!;

    expect(after.players[0]!.hand, "it never left hand").toHaveLength(0);
    expect(after.players[0]!.activeGear.map((g) => g.instanceId), "it never entered play").toContain("blade");
    expect(
      equipmentAttachedTo(after, "rell").map((g) => g.instanceId),
      "it was played but not attached to Rell",
    ).toEqual(["blade"]);
    // "Ignoring its cost" — nothing was spent.
    expect(after.players[0]!.channeled, "runes were spent on a free play").toHaveLength(0);
  });

  /** "You may" — declining plays nothing and attaches nothing. */
  it("plays nothing when declined", () => {
    const opened = attack(board([gear(DORANS_BLADE, "blade")]));
    const after = answerDecision(opened, pendingDecision(opened)!.id, "decline")!;

    expect(after.players[0]!.hand, "declining still played it").toHaveLength(1);
    expect(after.players[0]!.activeGear, "declining still put it in play").toHaveLength(0);
    expect(equipmentAttachedTo(after, "rell"), "declining still attached something").toHaveLength(0);
  });

  it("does not offer an Equipment over the printed ceiling", () => {
    const overCeiling = registry.get(ZERO_DRIVE);
    expect(overCeiling.type === "Gear" && overCeiling.energyCost, "the fixture is no longer over the ceiling").toBeGreaterThan(2);

    const opened = attack(board([gear(ZERO_DRIVE, "drive")]));
    expect(pendingDecision(opened), "an over-cost Equipment raised an offer").toBeUndefined();
    expect(opened.players[0]!.hand, "it was played anyway").toHaveLength(1);
  });

  /** `[Equip]` is what makes a gear an Equipment; an ordinary gear is not one. */
  it("does not offer a non-Equipment gear", () => {
    const opened = attack(board([gear(ENERGY_CONDUIT, "conduit")]));
    expect(pendingDecision(opened), "a plain gear was offered as Equipment").toBeUndefined();
  });

  /** With nothing eligible the question is dropped WHOLE rather than shown as a
   *  lone Decline — a one-option decision auto-resolves anyway (trap 7). */
  it("raises no question at all with an empty hand", () => {
    expect(pendingDecision(attack(board([]))), "an empty hand still asked").toBeUndefined();
  });

  /** The load-bearing negative: she must not fire while DEFENDING. */
  it("does not fire when Rell is the defender", () => {
    const opened = beginCombatAt(board([gear(DORANS_BLADE, "blade")]), "bf1", 1);
    expect(pendingDecision(opened), "the offer fired for the defender").toBeUndefined();
  });
});

describe("Rell - Magnetic's coverage", () => {
  it("is claimed by a module and carries no partial note", () => {
    expect(isCardImplemented(registry.get(RELL_MAGNETIC)), "SFD-024 is not reported implemented").toBe(true);
    expect(partialImplementationNote(registry.get(RELL_MAGNETIC))).toBeUndefined();
  });
});
