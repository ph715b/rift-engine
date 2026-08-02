import { describe, expect, it } from "vitest";
import { activatedAbilityDefIds, activatedAbilityTargeting, activationPayment, findActivatable } from "../src/engine/activated-abilities.js";
import { validateActivateAbility } from "../src/actions/validate-activate-ability.js";
import { executeActivateAbility } from "../src/actions/execute-activate-ability.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { chooseAction } from "../src/ai/heuristic-ai.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { runAwaken } from "../src/engine/turn-manager.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit } from "./fixtures.js";

/**
 * Activated abilities — the ":rb_exhaust::" cost — for Gear as well as Units.
 *
 * Before this, the ActivateAbility action's own field was called
 * `unitInstanceId` and its enumeration scanned base and battlefield units only,
 * so `activeGear` was never looked at. Twenty of the thirty Gear in this pool are
 * "exhaust: do one thing", which means the single largest block of unimplemented
 * cards was not merely unimplemented but unreachable — no action existed that
 * could name one.
 */

const registry = defaultCardRegistry();
const ORB_OF_REGRET = "OGN-090";
const LUX_CROWNGUARD = "OGS-014";
const VI_DESTRUCTIVE = "OGN-036";

const gear = (defId: string) => createCardInstance(registry.get(defId)) as GearInstance;

/** Orb of Regret in play, plus a unit for it to point at. */
function orbState(): { state: GameState; orb: GearInstance; target: ReturnType<typeof makeUnit> } {
  const orb = gear(ORB_OF_REGRET);
  const target = makeUnit({ might: 5 });
  const state = makeState({
    players: [makePlayer("p1", { activeGear: [orb] }), makePlayer("p2")],
  });
  state.battlefields[0]!.units = { p2: [target] };
  return { state, orb, target };
}

describe("Gear can be activated at all", () => {
  it("findActivatable sees Gear in activeGear, not just units", () => {
    const { state, orb } = orbState();
    const found = findActivatable(state, 0, orb.instanceId);
    expect(found?.card.name).toBe("Orb of Regret");
    expect(found?.definition.kind).toBe("Gear");
  });

  it("legalActions offers one action per legal target for a targeted gear ability", () => {
    const { state, orb, target } = orbState();
    const second = makeUnit({ might: 4 });
    state.battlefields[1]!.units = { p1: [second] };

    const offered = legalActions(state).filter((a) => a.type === "ActivateAbility");

    expect(offered).toHaveLength(2);
    expect(offered.every((a) => a.type === "ActivateAbility" && a.permanentInstanceId === orb.instanceId)).toBe(true);
    expect(offered.map((a) => (a.type === "ActivateAbility" ? a.targetUnitInstanceId : undefined)).sort()).toEqual(
      [target.instanceId, second.instanceId].sort(),
    );
  });

  it("offers nothing when a targeted ability has no legal target", () => {
    // Exhausting for no effect is never what the player meant, so it isn't
    // offered at all rather than offered and wasted.
    const orb = gear(ORB_OF_REGRET);
    const state = makeState({ players: [makePlayer("p1", { activeGear: [orb] }), makePlayer("p2")] });
    expect(legalActions(state).filter((a) => a.type === "ActivateAbility")).toHaveLength(0);
  });

  it("stops offering it once the gear is exhausted, and offers it again after Awaken", () => {
    const { state, orb, target } = orbState();

    const used = executeActivateAbility(state, {
      type: "ActivateAbility",
      playerIndex: 0,
      permanentInstanceId: orb.instanceId,
      targetUnitInstanceId: target.instanceId,
    });
    expect(used.players[0]!.activeGear[0]!.exhausted).toBe(true);
    expect(legalActions(used).filter((a) => a.type === "ActivateAbility")).toHaveLength(0);

    // Gear readies at Awaken alongside units, which is what makes the exhaust
    // cost a once-per-turn limit rather than a once-per-game one.
    const readied = runAwaken({ ...used, phase: "Awaken" });
    expect(readied.players[0]!.activeGear[0]!.exhausted).toBe(false);
  });
});

describe("Orb of Regret's effect (OGN-090)", () => {
  it("gives -1 Might this turn, floored at 1", () => {
    const { state, orb, target } = orbState();
    const before = effectiveMight(state, state.battlefields[0]!.units["p2"]![0]!, 1, { isCombat: false });

    const after = executeActivateAbility(state, {
      type: "ActivateAbility",
      playerIndex: 0,
      permanentInstanceId: orb.instanceId,
      targetUnitInstanceId: target.instanceId,
    });

    expect(effectiveMight(after, after.battlefields[0]!.units["p2"]![0]!, 1, { isCombat: false })).toBe(before - 1);
  });

  it("cannot push a unit below 1 Might, however many times it is used", () => {
    const orb1 = gear(ORB_OF_REGRET);
    const orb2 = gear(ORB_OF_REGRET);
    const target = makeUnit({ might: 2 });
    let state = makeState({
      players: [makePlayer("p1", { activeGear: [orb1, orb2] }), makePlayer("p2")],
    });
    state.battlefields[0]!.units = { p2: [target] };

    for (const orb of [orb1, orb2]) {
      state = executeActivateAbility(state, {
        type: "ActivateAbility",
        playerIndex: 0,
        permanentInstanceId: orb.instanceId,
        targetUnitInstanceId: target.instanceId,
      });
    }

    // 2 - 1 - 1 would be 0 without the card's own "to a minimum of 1" clause.
    expect(effectiveMight(state, state.battlefields[0]!.units["p2"]![0]!, 1, { isCombat: false })).toBe(1);
  });

  it("targets either player's units, including in base — the text names no owner", () => {
    expect(activatedAbilityTargeting(ORB_OF_REGRET)).toEqual({ kind: "unit", scope: "anywhere" });
    const orb = gear(ORB_OF_REGRET);
    const mine = makeUnit({ might: 4 });
    const state = makeState({
      players: [makePlayer("p1", { activeGear: [orb], baseUnits: [mine] }), makePlayer("p2")],
    });
    const offered = legalActions(state).filter((a) => a.type === "ActivateAbility");
    expect(offered).toHaveLength(1); // your own base unit is a legal target
  });
});

describe("validation refuses what enumeration never offers", () => {
  it("rejects a targeted ability submitted with no target", () => {
    const { state, orb } = orbState();
    const result = validateActivateAbility(state, {
      type: "ActivateAbility",
      playerIndex: 0,
      permanentInstanceId: orb.instanceId,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a target that isn't on the board", () => {
    const { state, orb } = orbState();
    const result = validateActivateAbility(state, {
      type: "ActivateAbility",
      playerIndex: 0,
      permanentInstanceId: orb.instanceId,
      targetUnitInstanceId: "nonexistent",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects gear another player controls", () => {
    const orb = gear(ORB_OF_REGRET);
    const target = makeUnit({ might: 5 });
    const state = makeState({
      players: [makePlayer("p1"), makePlayer("p2", { activeGear: [orb] })],
    });
    state.battlefields[0]!.units = { p1: [target] };
    const result = validateActivateAbility(state, {
      type: "ActivateAbility",
      playerIndex: 0,
      permanentInstanceId: orb.instanceId,
      targetUnitInstanceId: target.instanceId,
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a target that has left the board since the action was chosen", () => {
    // The engine decides targets ahead of resolution, so a target can legitimately
    // vanish in between. Refusing is right: it costs the player nothing, whereas
    // executing would exhaust the gear for no effect.
    const { state, orb, target } = orbState();
    const vanished: GameState = {
      ...state,
      battlefields: state.battlefields.map((bf, i) => (i === 0 ? { ...bf, units: { p2: [] } } : bf)),
    };
    const action = {
      type: "ActivateAbility" as const,
      playerIndex: 0 as const,
      permanentInstanceId: orb.instanceId,
      targetUnitInstanceId: target.instanceId,
    };
    expect(validateActivateAbility(vanished, action).ok).toBe(false);
    expect(() => executeActivateAbility(vanished, action)).toThrow();
    expect(vanished.players[0]!.activeGear[0]!.exhausted).toBe(false); // nothing was paid
  });
});

describe("Lux - Crownguard still behaves exactly as before the move", () => {
  it("exhausts and grants 2 restricted Spell Energy", () => {
    const lux = createCardInstance(registry.get(LUX_CROWNGUARD));
    let state = makeState();
    state.players[0]!.baseUnits = [lux as never];

    state = executeActivateAbility(state, {
      type: "ActivateAbility",
      playerIndex: 0,
      permanentInstanceId: lux.instanceId,
    });

    expect(state.players[0]!.baseUnits[0]!.exhausted).toBe(true);
    expect(state.players[0]!.restrictedSpellEnergy).toBe(2);
  });
});

describe("coverage counts activated abilities", () => {
  it("reports every registered card", () => {
    expect(activatedAbilityDefIds()).toEqual(expect.arrayContaining([ORB_OF_REGRET, LUX_CROWNGUARD, VI_DESTRUCTIVE]));
    for (const id of [ORB_OF_REGRET, LUX_CROWNGUARD, VI_DESTRUCTIVE]) {
      expect(isCardImplemented(registry.get(id)), `${id} should count as implemented`).toBe(true);
    }
  });
});

/**
 * Vi - Destructive: "Recycle 1 from your trash: Give me +1 Might this turn."
 *
 * The first ability whose cost is NOT an exhaust. Assuming the exhaust would
 * have silently capped her at once per turn; rule 416.3 ("when Recycling is
 * listed as a Cost, the action must be able to be completed for the cost to be
 * paid") is what makes an empty trash a refusal rather than a free activation.
 */
describe("Vi - Destructive (OGN-036): a Recycle cost, and no exhaust", () => {
  const VI = VI_DESTRUCTIVE;

  function viInPlay(trashCount: number) {
    const vi = createCardInstance(registry.get(VI)) as UnitInstance;
    const state = makeState({
      phase: "Action",
      players: [
        makePlayer("p1", {
          baseUnits: [vi],
          trash: Array.from({ length: trashCount }, () => createCardInstance(registry.get("OGN-002"))),
        }),
        makePlayer("p2"),
      ],
    });
    return { state, vi };
  }

  const activate = (state: GameState, vi: UnitInstance) =>
    executeActivateAbility(state, { type: "ActivateAbility", playerIndex: 0, permanentInstanceId: vi.instanceId });

  it("recycles one card to the BOTTOM of the deck and gives itself +1 Might", () => {
    const { state, vi } = viInPlay(2);
    const oldestTrashId = state.players[0]!.trash[0]!.instanceId;
    const before = effectiveMight(state, state.players[0]!.baseUnits[0]!, 0, { isCombat: false });

    const after = activate(state, vi);

    expect(after.players[0]!.trash).toHaveLength(1);
    expect(after.players[0]!.deck.at(-1)!.instanceId).toBe(oldestTrashId); // bottom, per rule 416
    expect(effectiveMight(after, after.players[0]!.baseUnits[0]!, 0, { isCombat: false })).toBe(before + 1);
  });

  it("does NOT exhaust, so it can be activated again in the same turn", () => {
    const { state, vi } = viInPlay(3);
    const once = activate(state, vi);
    expect(once.players[0]!.baseUnits[0]!.exhausted).toBe(false);

    const twice = activate(once, vi);
    expect(twice.players[0]!.trash).toHaveLength(1);
    // +1 each time: this-turn Might stacks, unlike a Buff.
    expect(twice.players[0]!.baseUnits[0]!.mightThisTurn).toBe(2);
    expect(legalActions(twice).filter((a) => a.type === "ActivateAbility")).toHaveLength(1); // still offered
  });

  it("is neither offered nor accepted with an empty trash (rule 416.3)", () => {
    const { state, vi } = viInPlay(0);
    expect(legalActions(state).filter((a) => a.type === "ActivateAbility")).toHaveLength(0);
    expect(
      validateActivateAbility(state, { type: "ActivateAbility", playerIndex: 0, permanentInstanceId: vi.instanceId }).ok,
    ).toBe(false);
  });

  it("stays available while EXHAUSTED — the cost never mentions readiness", () => {
    // The check this pins: legal-actions used to skip every exhausted permanent
    // before asking what the cost actually was.
    const { state, vi } = viInPlay(1);
    const exhausted: GameState = {
      ...state,
      players: [
        { ...state.players[0]!, baseUnits: [{ ...vi, exhausted: true }] },
        state.players[1]!,
      ] as GameState["players"],
    };
    expect(legalActions(exhausted).filter((a) => a.type === "ActivateAbility")).toHaveLength(1);
  });
});

describe("the AI uses the abilities it can price, and skips the ones it can't", () => {
  it("activates Orb of Regret to weaken an enemy unit", () => {
    // The AI used to filter EVERY ActivateAbility out of its candidate pool on
    // the grounds that a 1-ply board evaluator can't value a banked resource.
    // True of Lux - Crownguard, false of a gear ability that moves Might — which
    // is precisely what `evaluate` scores.
    const { state, orb, target } = orbState();
    state.phase = "Action";

    const chosen = chooseAction(state);

    expect(chosen.type).toBe("ActivateAbility");
    expect(chosen.type === "ActivateAbility" && chosen.permanentInstanceId).toBe(orb.instanceId);
    expect(chosen.type === "ActivateAbility" && chosen.targetUnitInstanceId).toBe(target.instanceId);
  });

  it("still never activates Lux - Crownguard's Energy banking", () => {
    // Nothing changed for the resource-bankers: scoring one produces a
    // meaningless tie with Pass, so it stays out of the pool.
    const lux = createCardInstance(registry.get(LUX_CROWNGUARD));
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [lux as never];

    const offered = legalActions(state).filter((a) => a.type === "ActivateAbility");
    expect(offered).toHaveLength(1); // legal, and offered to a human

    expect(chooseAction(state).type).not.toBe("ActivateAbility"); // but not to the AI
  });
});

/**
 * The Energy half of an activation is priced BEFORE the ability is paid for,
 * and `payActivationCost` pays Power first — which recycles the rune rather
 * than exhausting it. Pricing Energy against the pre-Power pool can therefore
 * name a rune that will not be there when the Energy is actually paid.
 *
 * Nothing in the pool combines `energy` with `power` yet (OGN-242 Baited Hook
 * would be the first), so these ask the pure pricing function directly with a
 * cost no registered ability has. That is the whole point: the arithmetic that
 * currently saves the pre-Power version is a coincidence — recycling a READY
 * rune banks exactly the 1 floating Energy that rune could have paid — and the
 * first card to combine the two would be relying on it.
 */
describe("activationPayment prices Energy against the pool the Power step leaves", () => {
  const fury = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `fury-${i}`, domain: "Fury" as const, state: "Ready" as const }));
  const withRunes = (n: number) => makeState({ players: [makePlayer("p1", { channeled: fury(n) }), makePlayer("p2")] });

  it("does not name a rune that paying Power will recycle", () => {
    const payment = activationPayment(withRunes(3), 0, { power: { domain: "Fury", count: 1 }, energy: 2, exhaust: true });

    // fury-0 is recycled for the Power and banks 1 floating Energy, so only 1
    // of the 2 Energy is still owed — and it is owed against the two runes that
    // are left. Pricing against all three named fury-0 for Energy as well.
    expect(payment?.energyRunes).toEqual(["fury-1"]);
  });

  it("refuses when the Power half cannot be paid at all", () => {
    const payment = activationPayment(withRunes(1), 0, { power: { domain: "Order", count: 1 }, energy: 1, exhaust: true });
    expect(payment).toBeUndefined();
  });

  it("is unchanged for the Energy-only costs every registered ability actually has", () => {
    expect(activationPayment(withRunes(2), 0, { energy: 2, exhaust: true })?.energyRunes).toEqual(["fury-0", "fury-1"]);
    expect(activationPayment(withRunes(1), 0, { energy: 2, exhaust: true })).toBeUndefined();
  });
});
