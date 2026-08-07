import { describe, expect, it } from "vitest";
import { attachEquipment } from "../src/engine/equipment.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { validateActivateAbility } from "../src/actions/validate-activate-ability.js";
import { createCardInstance, type GearInstance } from "../src/model/card.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { ActivateAbilityAction } from "../src/actions/player-action.js";
import { makePlayer, makeState, makeUnit } from "./fixtures.js";

/**
 * Forge of the Fluft (SFD-208) — "While you control this battlefield, friendly
 * legends have '[Exhaust]: Attach an Equipment you control to a unit you
 * control.'"
 *
 * **The only battlefield in the pool whose printed text is an ACTIVATED
 * ability**, and the one this project left for last on the grounds that no table
 * modelled it. What made it tractable was noticing that
 * `abilitiesAvailableTo` — written for Heimerdinger - Inventor, who "has all
 * [Exhaust] abilities of all friendly legends, units, and gear" — is already the
 * single answer to "what can this source activate", shared by the enumerator,
 * the validator and the executor. The Forge is a second entry in that list.
 *
 * So the tests here are about the GRANT, not about attaching (Jax's file covers
 * that):
 *  - it reaches the LEGEND, not the battlefield, and the Legend pays the exhaust
 *    (416.1: "Exhaust me" belongs to whoever HAS the ability);
 *  - it is gated on CONTROL and disappears when control does;
 *  - it does not reach the opponent's Legend;
 *  - it composes with the Legend's OWN ability rather than replacing it.
 */

const registry = defaultCardRegistry();
const FORGE = "SFD-208";
const JAX = "SFD-193"; // a Legend who already has two abilities of his own
const DORANS_BLADE = "SFD-095";

const gear = (defId: string): GearInstance => createCardInstance(registry.get(defId)) as GearInstance;

/** `controller` says who holds the Forge — `undefined` leaves it uncontrolled. */
function board(controller?: 0 | 1, legendDefId = "TEST-LEGEND"): GameState {
  const blade = gear(DORANS_BLADE);
  const state = makeState({
    phase: "Action",
    players: [
      makePlayer("p1", {
        baseUnits: [makeUnit({ name: "Wearer", instanceId: "wearer" }), makeUnit({ name: "Other", instanceId: "other" })],
        activeGear: [blade],
      }),
      makePlayer("p2", { baseUnits: [makeUnit({ name: "Theirs", instanceId: "theirs" })] }),
    ],
  });
  state.players[0]!.legend = { ...state.players[0]!.legend, defId: legendDefId };
  state.battlefields[0] = {
    ...state.battlefields[0]!,
    defId: FORGE,
    ...(controller !== undefined ? { controllerId: state.players[controller]!.id } : {}),
  };
  return state;
}

const legendActions = (state: GameState, playerIndex: 0 | 1 = 0): ActivateAbilityAction[] =>
  legalActions(state).filter(
    (a): a is ActivateAbilityAction =>
      a.type === "ActivateAbility" && a.permanentInstanceId === state.players[playerIndex]!.legend.instanceId,
  );

const bladeOf = (state: GameState) => state.players[0]!.activeGear[0]!;

describe("the grant", () => {
  it("gives a Legend with NO ability of its own an attach", () => {
    const state = board(0);
    const offered = legendActions(state);

    expect(offered.length, "the Forge granted nothing").toBeGreaterThan(0);
    expect(offered.every((a) => a.viaAbilityDefId === FORGE), "the ability was not the Forge's").toBe(true);
    expect(new Set(offered.map((a) => a.targetPermanentInstanceId))).toEqual(new Set([bladeOf(state).instanceId]));
  });

  /** The LEGEND pays, not the battlefield — 416.1's "Exhaust me". */
  it("attaches, and exhausts the LEGEND", () => {
    const state = board(0);
    const use = legendActions(state).find((a) => a.targetUnitInstanceId === "wearer")!;
    const { state: after, result } = submit(state, use);

    expect(result).toMatchObject({ type: "Ok" });
    expect(after.players[0]!.activeGear[0]!.attachedToInstanceId, "the Equipment did not attach").toBe("wearer");
    expect(after.players[0]!.legend.exhausted, "the Legend did not pay the exhaust").toBe(true);
  });

  /** "While you CONTROL this battlefield" — an uncontrolled Forge grants nothing. */
  it("grants nothing while nobody controls the Forge", () => {
    expect(legendActions(board()), "an uncontrolled Forge granted an ability").toHaveLength(0);
  });

  /** And it is not offered to the player who does NOT control it. */
  it("does not reach the opponent's Legend", () => {
    const theirs = board(1);
    expect(legendActions(theirs, 0), "the opponent's Forge granted us an ability").toHaveLength(0);
  });

  /** The validator agrees rather than trusting enumeration: a hand-built action
   *  naming the Forge's ability without controlling it must be refused. */
  it("refuses the granted ability when the Forge is not controlled", () => {
    const state = board();
    const forged: ActivateAbilityAction = {
      type: "ActivateAbility",
      playerIndex: 0,
      permanentInstanceId: state.players[0]!.legend.instanceId,
      viaAbilityDefId: FORGE,
      targetUnitInstanceId: "wearer",
      targetPermanentInstanceId: bladeOf(state).instanceId,
    };

    expect(validateActivateAbility(state, forged).ok, "an ungranted ability was accepted").toBe(false);
  });

  /** "A unit YOU control" — the opponent's unit is never a destination. */
  it("never offers an enemy unit as the wearer", () => {
    expect(legendActions(board(0)).map((a) => a.targetUnitInstanceId)).not.toContain("theirs");
  });

  /** Re-attaching where it already sits is a no-op the exhaust would pay for. */
  it("does not offer the unit the Equipment already wears", () => {
    const state = board(0);
    const worn = attachEquipment(state, 0, bladeOf(state).instanceId, "wearer");

    expect(legendActions(worn).map((a) => a.targetUnitInstanceId), "offered a re-attach that changes nothing").not.toContain(
      "wearer",
    );
    // The positive control: the OTHER unit is still offered, so the filter is
    // narrowing rather than emptying.
    expect(legendActions(worn).map((a) => a.targetUnitInstanceId)).toContain("other");
  });

  /**
   * **"An Equipment", with no detached/attached line** — so it does both of Jax's
   * jobs. The same board offers the move as well as the attach, which is the
   * difference between `"any"` and either of his two.
   */
  it("attaches a DETACHED Equipment and moves an ATTACHED one alike", () => {
    const detached = board(0);
    expect(legendActions(detached).length, "no attach from a detached Equipment").toBeGreaterThan(0);

    const worn = attachEquipment(detached, 0, bladeOf(detached).instanceId, "wearer");
    expect(legendActions(worn).length, "no move from an attached Equipment").toBeGreaterThan(0);
  });
});

describe("the grant beside a Legend's own ability", () => {
  /**
   * It ADDS rather than replaces: Jax keeps both of his modes and gains the
   * Forge's. That is what makes `abilitiesAvailableTo` returning a LIST the right
   * door — a lookup would have had to pick one.
   */
  it("Jax keeps his own two and gains the Forge's", () => {
    const state = board(0, JAX);
    // Runes for his priced mode, so all three are affordable and any absence is
    // about the grant rather than about the money.
    const funded: GameState = {
      ...state,
      players: [
        { ...state.players[0]!, channeled: [{ id: "r0", domain: "Body", state: "Ready" }] },
        state.players[1]!,
      ],
    };
    const offered = legendActions(funded);

    expect(new Set(offered.map((a) => a.viaAbilityDefId ?? JAX)), "one of the two ability sources was lost").toEqual(
      new Set([JAX, FORGE]),
    );
    // His own modes are still enumerated and still priced as his. Only
    // `detached` has a subject on this board — the one Equipment is unattached,
    // and his other mode needs an ATTACHED one — so this asserts what the board
    // can actually offer rather than the whole mode list.
    expect(new Set(offered.filter((a) => a.viaAbilityDefId === undefined).map((a) => a.modeId))).toEqual(
      new Set(["detached"]),
    );
    // ...and with the Equipment worn, his OTHER mode is the one with a subject —
    // which is the premise of the line above rather than a separate claim.
    const worn = attachEquipment(funded, 0, bladeOf(funded).instanceId, "wearer");
    expect(new Set(legendActions(worn).filter((a) => a.viaAbilityDefId === undefined).map((a) => a.modeId))).toEqual(
      new Set(["attached"]),
    );
  });

  /** And the Forge's grant is FREE where Jax's equivalent mode costs [1] — the
   *  clearest proof the two are separate abilities rather than one merged. */
  it("the granted attach costs no Energy, unlike Jax's own", () => {
    const state = board(0, JAX);
    const funded: GameState = {
      ...state,
      players: [
        { ...state.players[0]!, channeled: [{ id: "r0", domain: "Body", state: "Ready" }] },
        state.players[1]!,
      ],
    };
    const granted = legendActions(funded).filter((a) => a.viaAbilityDefId === FORGE);
    const own = legendActions(funded).filter((a) => a.viaAbilityDefId === undefined && a.modeId === "detached");

    expect(granted.every((a) => (a.payment?.energyRunes ?? []).length === 0), "the granted attach was charged").toBe(true);
    expect(own.every((a) => (a.payment?.energyRunes ?? []).length === 1), "Jax's own [1] mode stopped costing [1]").toBe(true);
  });
});
