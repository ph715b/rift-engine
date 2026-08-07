import { describe, expect, it } from "vitest";
import { attachEquipment } from "../src/engine/equipment.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { validateActivateAbility } from "../src/actions/validate-activate-ability.js";
import { activationCostOf } from "../src/engine/activated-abilities.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import { createCardInstance, type GearInstance } from "../src/model/card.js";
import type { ActivateAbilityAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makePlayer, makeState, makeUnit } from "./fixtures.js";

/**
 * Jax - Grandmaster At Arms (SFD-193) — "[1], [Exhaust]: Attach a detached
 * Equipment you control to a unit you control. [Exhaust]: Attach an attached
 * Equipment you control to a unit you control."
 *
 * **The first card in the pool whose two abilities are priced differently**, and
 * the reason `AbilityMode` grew a `cost`. Both exhaust, so only one is usable per
 * turn either way; what the price separates is the JOB. Putting an idle Equipment
 * onto a unit costs [1]; picking one up and moving it is free.
 *
 * Which makes the mis-pricing the thing to test hardest, in both directions:
 *  - his free mode must not be charged, and
 *  - his priced mode must not be sold at the free price — the direction this
 *    codebase never ships.
 *
 * He is also the first ability to fan out over unit x EQUIPMENT, so the
 * enumerator and the validator have a second axis to disagree about. Every
 * negative below is asserted through the VALIDATOR as well, because "not
 * offered" and "refused if submitted" are different claims and a card is only
 * safe when both hold.
 */

const registry = defaultCardRegistry();
const JAX = "SFD-193";
const DORANS_BLADE = "SFD-095"; // [Equip] 1 Body, +2 Might
const BFS = "SFD-161"; // B.F. Sword

const gear = (defId: string): GearInstance => createCardInstance(registry.get(defId)) as GearInstance;
const runes = (n: number): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, domain: "Body" as const, state: "Ready" as const }));

/**
 * Jax in the Legend zone, two friendly units, and two Equipment. `attachedTo`
 * says which unit the FIRST one starts on — `undefined` leaves it detached, which
 * is the only difference between the two modes' inputs.
 */
function board(attachedTo?: string, energy = 4): { state: GameState; blade: GearInstance; sword: GearInstance } {
  const blade = gear(DORANS_BLADE);
  const sword = gear(BFS);
  let state = makeState({
    phase: "Action",
    players: [
      makePlayer("p1", {
        baseUnits: [makeUnit({ name: "Wearer", instanceId: "wearer" }), makeUnit({ name: "Other", instanceId: "other" })],
        activeGear: [blade, sword],
        channeled: runes(energy),
      }),
      makePlayer("p2", { baseUnits: [makeUnit({ name: "Foe", instanceId: "foe" })] }),
    ],
  });
  state.players[0]!.legend = { ...state.players[0]!.legend, defId: JAX };
  // The SECOND Equipment is always detached, so each mode has exactly one
  // eligible gear in the "attached" fixture and the fan-out counts are readable.
  if (attachedTo) state = attachEquipment(state, 0, blade.instanceId, attachedTo);
  return { state, blade, sword };
}

const jaxActions = (state: GameState): ActivateAbilityAction[] =>
  legalActions(state).filter(
    (a): a is ActivateAbilityAction =>
      a.type === "ActivateAbility" && a.permanentInstanceId === state.players[0]!.legend.instanceId,
  );

const attachedTo = (state: GameState, gearInstanceId: string) =>
  state.players[0]!.activeGear.find((g) => g.instanceId === gearInstanceId)?.attachedToInstanceId ?? null;

function accept(state: GameState, action: ActivateAbilityAction): GameState {
  const { state: next, result } = submit(state, action);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

describe("Jax's two modes are priced apart", () => {
  it("the registry prices them apart — [1] to attach, free to move", () => {
    expect(activationCostOf(JAX, "detached")).toEqual({ energy: 1, exhaust: true });
    expect(activationCostOf(JAX, "attached")).toEqual({ exhaust: true });
  });

  /** Enumeration prices per MODE: only the [1] mode's actions carry a payment. */
  it("only the priced mode's actions name runes to pay", () => {
    const { state, blade } = board("wearer");
    const priced = jaxActions(state).filter((a) => a.modeId === "detached");
    const free = jaxActions(state).filter((a) => a.modeId === "attached");

    expect(priced.length, "the [1] mode was not offered").toBeGreaterThan(0);
    expect(free.length, "the free mode was not offered").toBeGreaterThan(0);
    expect(priced.every((a) => (a.payment?.energyRunes ?? []).length === 1), "the [1] mode was offered free").toBe(true);
    expect(free.every((a) => (a.payment?.energyRunes ?? []).length === 0), "the free mode was charged").toBe(true);
    // The premise of the split: the attached blade is the free mode's subject and
    // the detached sword is the priced mode's.
    expect(free.every((a) => a.targetPermanentInstanceId === blade.instanceId)).toBe(true);
  });

  /**
   * **The direction that must never ship**: with no Energy at all, the free mode
   * is still offered and the priced one is gone. One price per ABILITY would
   * either sell the [1] job free or make the free job unaffordable.
   */
  it("with no Energy, the free mode survives and the priced one does not", () => {
    const { state } = board("wearer", 0);
    const offered = jaxActions(state);

    expect(offered.some((a) => a.modeId === "attached"), "the free mode vanished with the Energy").toBe(true);
    expect(offered.some((a) => a.modeId === "detached"), "the [1] mode was offered with no Energy").toBe(false);
  });

  /** And the validator agrees — not offered AND refused if submitted. */
  it("refuses the priced mode submitted with no Energy", () => {
    const { state, sword } = board("wearer", 0);
    const forged: ActivateAbilityAction = {
      type: "ActivateAbility",
      playerIndex: 0,
      permanentInstanceId: state.players[0]!.legend.instanceId,
      modeId: "detached",
      targetUnitInstanceId: "other",
      targetPermanentInstanceId: sword.instanceId,
    };
    expect(validateActivateAbility(state, forged).ok, "an unpayable [1] mode was accepted").toBe(false);
  });
});

describe("Jax attaches", () => {
  it("attaches a DETACHED Equipment and takes the [1] and the exhaust", () => {
    const { state, sword } = board();
    const play = jaxActions(state).find(
      (a) => a.modeId === "detached" && a.targetPermanentInstanceId === sword.instanceId && a.targetUnitInstanceId === "wearer",
    )!;
    const after = accept(state, play);

    expect(attachedTo(after, sword.instanceId), "the sword did not move").toBe("wearer");
    expect(after.players[0]!.legend.exhausted, "he was not exhausted").toBe(true);
    expect(after.players[0]!.channeled.filter((r) => r.state === "Exhausted"), "the [1] was not paid").toHaveLength(1);
  });

  it("MOVES an attached Equipment for free", () => {
    const { state, blade } = board("wearer");
    const play = jaxActions(state).find(
      (a) => a.modeId === "attached" && a.targetPermanentInstanceId === blade.instanceId && a.targetUnitInstanceId === "other",
    )!;
    const after = accept(state, play);

    expect(attachedTo(after, blade.instanceId), "the blade did not move").toBe("other");
    expect(after.players[0]!.legend.exhausted).toBe(true);
    expect(after.players[0]!.channeled.filter((r) => r.state === "Exhausted"), "the free mode charged Energy").toHaveLength(0);
  });
});

describe("what each mode may name", () => {
  /** "A DETACHED Equipment" — the attached blade is not a subject of that mode. */
  it("the priced mode offers only DETACHED Equipment", () => {
    const { state, blade, sword } = board("wearer");
    const named = new Set(jaxActions(state).filter((a) => a.modeId === "detached").map((a) => a.targetPermanentInstanceId));

    expect(named, "the detached sword was not offered").toContain(sword.instanceId);
    expect(named, "an ATTACHED Equipment was offered to the detached mode").not.toContain(blade.instanceId);
  });

  /** And the mirror: "an ATTACHED Equipment" cannot name the idle one. */
  it("the free mode offers only ATTACHED Equipment", () => {
    const { state, blade, sword } = board("wearer");
    const named = new Set(jaxActions(state).filter((a) => a.modeId === "attached").map((a) => a.targetPermanentInstanceId));

    expect(named).toContain(blade.instanceId);
    expect(named, "a DETACHED Equipment was offered to the move mode").not.toContain(sword.instanceId);
  });

  /**
   * Re-attaching an Equipment to the unit it is ALREADY on is a no-op the player
   * would have paid an exhaust for, so it is not offered — the same call the move
   * fan-out makes about a unit's current battlefield.
   */
  it("does not offer moving an Equipment onto the unit it already wears", () => {
    const { state, blade } = board("wearer");
    const selfMove = jaxActions(state).filter(
      (a) => a.targetPermanentInstanceId === blade.instanceId && a.targetUnitInstanceId === "wearer",
    );

    expect(selfMove, "offered a re-attach that changes nothing").toHaveLength(0);
  });

  /** "To a UNIT YOU CONTROL" — an enemy unit is never a destination. */
  it("never offers an enemy unit as the wearer", () => {
    const { state } = board("wearer");
    expect(jaxActions(state).map((a) => a.targetUnitInstanceId), "an enemy unit was offered").not.toContain("foe");
  });

  /**
   * The validator does not trust the enumerator's filter. A hand-built action
   * naming the OPPONENT's Equipment must be refused — `attachEquipment` is a
   * no-op on gear you do not control, so without this the exhaust would be paid
   * for nothing.
   */
  it("refuses an Equipment the activating player does not control", () => {
    const { state } = board("wearer");
    const theirs = gear(BFS);
    const withTheirs: GameState = {
      ...state,
      players: [state.players[0]!, { ...state.players[1]!, activeGear: [theirs] }],
    };
    const forged: ActivateAbilityAction = {
      type: "ActivateAbility",
      playerIndex: 0,
      permanentInstanceId: state.players[0]!.legend.instanceId,
      modeId: "detached",
      targetUnitInstanceId: "wearer",
      targetPermanentInstanceId: theirs.instanceId,
      payment: { energyRunes: ["r0"], powerRunes: [], rainbowRunes: [] },
    };

    expect(validateActivateAbility(withTheirs, forged).ok, "attached an opponent's Equipment").toBe(false);
  });

  /** And the cross-mode forgery: the free mode may not do the priced job. */
  it("refuses the FREE mode used on a detached Equipment", () => {
    const { state, sword } = board("wearer");
    const forged: ActivateAbilityAction = {
      type: "ActivateAbility",
      playerIndex: 0,
      permanentInstanceId: state.players[0]!.legend.instanceId,
      modeId: "attached",
      targetUnitInstanceId: "wearer",
      targetPermanentInstanceId: sword.instanceId,
    };

    expect(validateActivateAbility(state, forged).ok, "the [1] job was done at the free price").toBe(false);
  });

  /** With no Equipment at all, neither mode is offered — an exhaust for nothing
   *  is never an offer. */
  it("offers nothing while he controls no Equipment", () => {
    const { state } = board();
    const bare: GameState = {
      ...state,
      players: [{ ...state.players[0]!, activeGear: [] }, state.players[1]!],
    };
    expect(jaxActions(bare), "offered an attach with nothing to attach").toHaveLength(0);
  });

  /** Exhausted, he offers neither — both modes' costs include the exhaust. */
  it("offers nothing while exhausted", () => {
    const { state } = board("wearer");
    const spent: GameState = {
      ...state,
      players: [
        { ...state.players[0]!, legend: { ...state.players[0]!.legend, exhausted: true } },
        state.players[1]!,
      ],
    };
    expect(jaxActions(spent)).toHaveLength(0);
  });
});
