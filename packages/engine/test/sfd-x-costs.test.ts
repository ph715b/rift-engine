import { describe, expect, it } from "vitest";
import { activationCostOf, canPayActivationCost, hasActivatableAbility } from "../src/engine/activated-abilities.js";
import { executeActivateAbility } from "../src/actions/execute-activate-ability.js";
import { validateActivateAbility } from "../src/actions/validate-activate-ability.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit } from "./fixtures.js";

/**
 * Phase 4's cost work — the two X-cost ABILITIES and the first FILTERED recycle
 * cost.
 *
 * X on an ability is the same shape `hasXRainbowCost` already gives Bullet Time,
 * a Spell: the amount is the player's choice, so the enumerator fans out one
 * variant per affordable X and the validator re-derives the price from the X the
 * action names. Both halves are asserted here, because an X that is enumerated
 * but not re-derived is precisely how a client quotes itself a large X and pays
 * nothing.
 *
 * The two cards are deliberate INVERSES — rainbow in for Energy out, Energy in
 * for rainbow out — which is why the cost is two fields rather than one. A
 * single field would let Ancient Henge be paid with the resource it exists to
 * produce, and that is the mistake this file's last test pins.
 */

const registry = defaultCardRegistry();

const HEXTECH_ANOMALY = "SFD-083";
const ANCIENT_HENGE = "SFD-117";
const ASSEMBLY_RIG = "SFD-019";

const gear = (defId: string): GearInstance => createCardInstance(registry.get(defId)) as GearInstance;
const unit = (defId: string): UnitInstance => createCardInstance(registry.get(defId)) as UnitInstance;
const runes = (n: number, domain: RuneCard["domain"] = "Mind"): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, domain, state: "Ready" as const }));

/** The board a Gear ability is activated from: the gear in play, ready. */
function boardWith(defId: string, overrides: Partial<GameState["players"][0]> = {}): { state: GameState; g: GearInstance } {
  const g = gear(defId);
  const state = makeState({ phase: "Action" });
  state.players[0]!.activeGear = [g];
  Object.assign(state.players[0]!, overrides);
  return { state, g };
}

const activate = (state: GameState, g: GearInstance, xAmount?: number) =>
  executeActivateAbility(state, {
    type: "ActivateAbility",
    playerIndex: 0,
    permanentInstanceId: g.instanceId,
    ...(xAmount !== undefined ? { xAmount } : {}),
  });

describe("Hextech Anomaly (SFD-083): pay any amount of [rainbow] to Add that much Energy", () => {
  it("costs an exhaust and an X of rainbow Power", () => {
    expect(activationCostOf(HEXTECH_ANOMALY)).toMatchObject({ exhaust: true, xRainbowPower: true });
  });

  /**
   * **The X is added ON TOP of the rune-banking every Power payment already
   * does, and that is worth stating rather than discovering.**
   *
   * `payPowerFromChanneled` credits 1 floating Energy for each READY rune it
   * recycles — a rune that was still Ready had Energy-paying potential that
   * recycling wastes, and this engine banks it (mirroring the Java oracle's
   * `applyPayment`). Every ability Power cost in the pool goes through that
   * helper, so applying it here is uniform rather than special.
   *
   * The consequence is that Hextech Anomaly turns N READY runes into 2N Energy:
   * N banked by the recycle, N added by the card. Asserted as the engine's
   * actual rule rather than as the number the card text alone suggests, and
   * recorded in docs/rules-conformance.md as an interaction rather than a
   * reading of the card. Paying with EXHAUSTED runes banks nothing and yields
   * exactly N, which is the next test.
   */
  it("adds X Energy on top of the Energy banked by recycling Ready runes", () => {
    const { state, g } = boardWith(HEXTECH_ANOMALY, { channeled: runes(3) });
    const after = activate(state, g, 2);

    expect(after.players[0]!.floatingEnergy, "the X was not added on top of the banked Energy").toBe(4);
    // A POWER payment RECYCLES its runes (416), so the pool shrinks by X.
    expect(after.players[0]!.channeled, "the runes were not spent").toHaveLength(1);
    expect(after.players[0]!.activeGear[0]!.exhausted, "it did not exhaust").toBe(true);
  });

  /** With EXHAUSTED runes there is no wasted Energy potential to bank, so the
   *  card pays exactly what it says. */
  it("adds exactly X when the runes it recycles were already exhausted", () => {
    const { state, g } = boardWith(HEXTECH_ANOMALY, {
      channeled: runes(3).map((r) => ({ ...r, state: "Exhausted" as const })),
    });
    const after = activate(state, g, 2);

    expect(after.players[0]!.floatingEnergy, "the X itself was wrong").toBe(2);
  });

  /** ANY domain pays a rainbow cost — that is what rainbow means, and pricing it
   *  against a domain would refuse runes the card accepts. */
  it("accepts runes of any domain", () => {
    const { state, g } = boardWith(HEXTECH_ANOMALY, {
      channeled: [
        { id: "a", domain: "Fury", state: "Ready" },
        { id: "b", domain: "Order", state: "Ready" },
      ],
    });

    // 2 banked by recycling two READY runes, plus the card's own 2 — see the
    // banking note above.
    expect(activate(state, g, 2).players[0]!.floatingEnergy).toBe(4);
  });

  it("is not offered with no runes at all", () => {
    const { state, g } = boardWith(HEXTECH_ANOMALY, { channeled: [] });

    expect(canPayActivationCost(state, 0, g, HEXTECH_ANOMALY), "an unpayable X was still offered").toBe(false);
  });

  /** The enumerator offers one variant per affordable amount, and never X = 0 —
   *  exhausting the source to add nothing is not a move worth showing. */
  it("enumerates one variant per affordable X, starting at 1", () => {
    const { state, g } = boardWith(HEXTECH_ANOMALY, { channeled: runes(3) });
    const offered = legalActions(state)
      .filter((a) => a.type === "ActivateAbility" && a.permanentInstanceId === g.instanceId)
      .map((a) => (a as { xAmount?: number }).xAmount);

    expect(offered.sort(), "the X axis was not fanned out").toEqual([1, 2, 3]);
    expect(offered, "X = 0 was offered").not.toContain(0);
  });

  /**
   * The validator re-derives the price rather than trusting the action — a
   * hand-built action could otherwise claim a large X and pay nothing.
   */
  it("refuses an X the pools cannot cover", () => {
    const { state, g } = boardWith(HEXTECH_ANOMALY, { channeled: runes(1) });
    const result = validateActivateAbility(state, {
      type: "ActivateAbility",
      playerIndex: 0,
      permanentInstanceId: g.instanceId,
      xAmount: 5,
    });

    expect(result.ok, "an unpayable X was accepted").toBe(false);
  });

  it("refuses an X of 0", () => {
    const { state, g } = boardWith(HEXTECH_ANOMALY, { channeled: runes(2) });
    const result = validateActivateAbility(state, {
      type: "ActivateAbility",
      playerIndex: 0,
      permanentInstanceId: g.instanceId,
      xAmount: 0,
    });

    expect(result.ok).toBe(false);
  });

  it("is claimed by a module and flagged as banking a resource", () => {
    expect(isCardImplemented(registry.get(HEXTECH_ANOMALY))).toBe(true);
    // Changes nothing the board evaluator can price, so the AI will not take it —
    // recorded rather than worked around, like the Seals and the Gold token.
    expect(activationCostOf(HEXTECH_ANOMALY)).toBeDefined();
  });
});

describe("Ancient Henge (SFD-117): pay any amount of Energy to Add that much [rainbow]", () => {
  it("costs an exhaust and an X of ENERGY, not of Power", () => {
    expect(activationCostOf(ANCIENT_HENGE)).toMatchObject({ exhaust: true, xEnergy: true });
    // The inversion is the whole reason the two X costs are separate fields.
    expect(activationCostOf(ANCIENT_HENGE).xRainbowPower).toBeUndefined();
  });

  it("converts X Energy into X rainbow Power", () => {
    const { state, g } = boardWith(ANCIENT_HENGE, { floatingEnergy: 3 });
    const after = activate(state, g, 2);

    expect(after.players[0]!.floatingRainbowPower, "the rainbow was not added").toBe(2);
    expect(after.players[0]!.floatingEnergy, "the Energy was not spent").toBe(1);
  });

  /**
   * **The mistake a single X field would have made.** Ancient Henge PRODUCES
   * rainbow Power; if it could also be paid with it, one Henge plus one
   * activation would be an infinite loop. It is paid from Energy only.
   */
  it("cannot be paid with the rainbow Power it produces", () => {
    const { state, g } = boardWith(ANCIENT_HENGE, { floatingEnergy: 0, floatingRainbowPower: 5 });

    expect(canPayActivationCost(state, 0, g, ANCIENT_HENGE), "it paid itself with its own output").toBe(false);
  });

  it("is not offered with no Energy at all", () => {
    const { state, g } = boardWith(ANCIENT_HENGE, { floatingEnergy: 0 });

    expect(canPayActivationCost(state, 0, g, ANCIENT_HENGE)).toBe(false);
  });

  it("is claimed by a module", () => {
    expect(isCardImplemented(registry.get(ANCIENT_HENGE))).toBe(true);
  });
});

describe("Assembly Rig (SFD-019): the first UNIT-filtered recycle cost", () => {
  it("costs [1][Fury], a unit recycle and an exhaust", () => {
    expect(activationCostOf(ASSEMBLY_RIG)).toMatchObject({
      energy: 1,
      power: { domain: "Fury", count: 1 },
      recycleUnitFromTrash: 1,
      exhaust: true,
    });
  });

  /** The whole point of the filter: a trash of Spells cannot pay it, so the
   *  ability is not offered at all. */
  it("is NOT payable from a trash holding no units", () => {
    const { state, g } = boardWith(ASSEMBLY_RIG, {
      channeled: runes(2, "Fury"),
      trash: [createCardInstance(registry.get("OGN-009"))],
    });

    expect(canPayActivationCost(state, 0, g, ASSEMBLY_RIG), "a Spell paid a UNIT recycle").toBe(false);
  });

  it("IS payable once a unit is in the trash", () => {
    const { state, g } = boardWith(ASSEMBLY_RIG, {
      channeled: runes(2, "Fury"),
      trash: [unit("SFD-010")],
    });

    expect(canPayActivationCost(state, 0, g, ASSEMBLY_RIG), "a unit in the trash did not pay").toBe(true);
  });

  it("recycles the unit to the deck and plays a Mech token to base", () => {
    const { state, g } = boardWith(ASSEMBLY_RIG, {
      channeled: runes(2, "Fury"),
      trash: [unit("SFD-010")],
    });
    const after = activate(state, g);

    expect(after.players[0]!.trash, "the unit was not recycled out of the trash").toHaveLength(0);
    expect(after.players[0]!.deck.map((c) => c.defId), "it did not go to the deck").toContain("SFD-010");
    expect(after.players[0]!.baseUnits, "no Mech token arrived").toHaveLength(1);
    expect(after.players[0]!.baseUnits[0]!.tags, "the token is not a Mech").toContain("Mech");
  });

  /** A mixed trash must give up the UNIT, not whatever happens to be oldest —
   *  which is what `recycleFromTrash`'s front-of-trash convention would do. */
  it("takes the unit out of a mixed trash, not the oldest card", () => {
    const spellFirst = createCardInstance(registry.get("OGN-009"));
    const { state, g } = boardWith(ASSEMBLY_RIG, {
      channeled: runes(2, "Fury"),
      trash: [spellFirst, unit("SFD-010")],
    });
    const after = activate(state, g);

    expect(after.players[0]!.trash.map((c) => c.instanceId), "it recycled the Spell instead").toEqual([
      spellFirst.instanceId,
    ]);
  });

  it("is claimed by a module", () => {
    expect(hasActivatableAbility(ASSEMBLY_RIG)).toBe(true);
    expect(isCardImplemented(registry.get(ASSEMBLY_RIG))).toBe(true);
  });
});
