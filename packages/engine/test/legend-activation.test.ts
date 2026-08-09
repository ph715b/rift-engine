import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { validateActivateAbility } from "../src/actions/validate-activate-ability.js";
import { executeActivateAbility } from "../src/actions/execute-activate-ability.js";
import { runBeginning } from "../src/engine/turn-manager.js";
import { abilitiesAvailableTo, resolveActivation } from "../src/engine/activated-abilities.js";
import { isCardImplemented, needsImplementation } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance, type LegendInstance } from "../src/model/card.js";
import type { Domain } from "../src/model/domain.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";

/**
 * Activating a LEGEND, and Heimerdinger borrowing everyone else's abilities.
 *
 * The Legend zone was the one place an activatable thing could sit that nothing
 * scanned — so two of the three OGN preset legends were unreachable rather than
 * merely unimplemented: no action could name them. Coverage could not see that,
 * because Legend definitions carried no printed text at all.
 */

const registry = defaultCardRegistry();
const VIKTOR = "OGN-265"; // 1 Energy, exhaust: play a 1-Might Recruit token
const LEE_SIN = "OGN-257"; // 1 Energy, exhaust: buff a friendly unit
const JINX = "OGN-251"; // Beginning Phase: draw 1 if you hold one or fewer
const HEIMERDINGER = "OGN-111";
const ORB_OF_REGRET = "OGN-090";

const legend = (defId: string) => createCardInstance(registry.get(defId)) as LegendInstance;
const gear = (defId: string) => createCardInstance(registry.get(defId)) as GearInstance;
const runes = (domain: Domain, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

/** A board whose player-0 legend is `defId`, with `energy` Ready runes. */
function withLegend(defId: string, energy = 2, extra: Partial<GameState> = {}): GameState {
  const state = makeState({
    phase: "Action",
    players: [makePlayer("p1", { channeled: runes("Mind", energy) }), makePlayer("p2")],
    ...extra,
  });
  state.players[0]!.legend = legend(defId);
  return state;
}

const activations = (state: GameState) =>
  legalActions(state).filter((a) => a.type === "ActivateAbility");

describe("a Legend can be activated at all", () => {
  it("is enumerated — the zone nothing used to scan", () => {
    const state = withLegend(VIKTOR);
    const mine = activations(state).filter(
      (a) => a.type === "ActivateAbility" && a.permanentInstanceId === state.players[0]!.legend.instanceId,
    );
    expect(mine).toHaveLength(1);
  });

  it("plays the token, spends the Energy and exhausts the legend", () => {
    const state = withLegend(VIKTOR);
    const action = activations(state)[0]!;

    const after = submit(state, action).state;

    expect(after.players[0]!.baseUnits.map((u) => u.name)).toEqual(["Recruit"]);
    expect(after.players[0]!.legend.exhausted).toBe(true);
    expect(after.players[0]!.channeled.filter((r) => r.state === "Ready")).toHaveLength(1); // 2 - 1 Energy
  });

  it("is once per turn, because Awaken is what readies it", () => {
    const state = withLegend(VIKTOR);
    const once = submit(state, activations(state)[0]!).state;

    expect(activations(once)).toHaveLength(0); // exhausted, so no second offer

    // Not a special rule — the ordinary ready/exhaust cycle, which the Legend
    // zone already had and simply had nothing using.
    const readied = { ...once, players: [{ ...once.players[0]!, legend: { ...once.players[0]!.legend, exhausted: false } }, once.players[1]!] } as GameState;
    expect(activations(readied)).toHaveLength(1);
  });

  it("is not offered with no Energy to pay", () => {
    // The exhaust is only half the cost; a legend that cannot pay the Energy is
    // never offered rather than offered and refused.
    expect(activations(withLegend(VIKTOR, 0))).toHaveLength(0);
  });

  it("refuses a payment naming runes that aren't Ready", () => {
    const state = withLegend(VIKTOR);
    const action = activations(state)[0]!;
    const forged = { ...action, payment: { energyRunes: ["not-a-rune"], powerRunes: [] } };
    expect(validateActivateAbility(state, forged as never).ok).toBe(false);
  });

  it("Lee Sin's buffs a friendly unit, and composes with Mistfall for free", () => {
    // addBuff is the single funnel, and it fires `unitBuffed` — so the Legend and
    // the gear work together without either knowing the other exists.
    const state = withLegend(LEE_SIN);
    const ally = makeUnit({ name: "Ally" });
    ally.exhausted = true;
    state.players[0]!.baseUnits = [ally];
    state.players[0]!.activeGear = [gear("OGN-152")]; // Mistfall
    state.players[0]!.channeled = [...runes("Mind", 2), ...runes("Body", 2)];

    const action = activations(state).find(
      (a) => a.type === "ActivateAbility" && a.permanentInstanceId === state.players[0]!.legend.instanceId,
    )!;
    const after = executeActivateAbility(state, action as never);

    expect(after.players[0]!.baseUnits[0]!.buffed).toBe(true);
    // Mistfall heard it — but as a Chain Pending Item now (808.1.d.3), so the
    // question comes after the response window rather than inside the activation.
    expect(after.pendingTriggers.map((t) => t.listenerDefId)).toEqual(["OGN-152"]);
    expect(resolveHeldTriggers(after).pendingDecisions[0]?.kind).toBe("OGN-152-ready");
  });

  it("Jinx's fires in the Beginning Phase, only on a hand of one or fewer", () => {
    const short = withLegend(JINX, 0, { phase: "Beginning", activePlayerIndex: 0 });
    short.players[0]!.deck = [makeUnit(), makeUnit()];
    short.players[0]!.hand = [makeUnit()];
    expect(runBeginning(short).players[0]!.hand).toHaveLength(2);

    const full = withLegend(JINX, 0, { phase: "Beginning", activePlayerIndex: 0 });
    full.players[0]!.deck = [makeUnit(), makeUnit()];
    full.players[0]!.hand = [makeUnit(), makeUnit()];
    expect(runBeginning(full).players[0]!.hand).toHaveLength(2); // unchanged
  });
});

describe("Heimerdinger - Inventor borrows every friendly exhaust ability (414.5)", () => {
  /** Heimerdinger in base, with `others` also in play. */
  function heimerState(withOrb: boolean, legendDefId = VIKTOR): GameState {
    const state = withLegend(legendDefId, 4);
    const heimer = createCardInstance(registry.get(HEIMERDINGER));
    state.players[0]!.baseUnits = [heimer as never];
    if (withOrb) state.players[0]!.activeGear = [gear(ORB_OF_REGRET)];
    return state;
  }

  const heimerActions = (state: GameState) =>
    activations(state).filter(
      (a) => a.type === "ActivateAbility" && a.permanentInstanceId === state.players[0]!.baseUnits[0]!.instanceId,
    );

  it("offers the abilities of friendly legends AND gear, as his own", () => {
    const state = heimerState(true);
    const borrowed = new Set(heimerActions(state).map((a) => (a.type === "ActivateAbility" ? a.viaAbilityDefId : undefined)));

    expect(borrowed).toContain(VIKTOR); // the legend's
    expect(borrowed).toContain(ORB_OF_REGRET); // the gear's
  });

  it("exhausts HIM, not the card he borrowed from", () => {
    // 414.5: the exhaust symbol means "exhaust me". He has the ability, so it is
    // his exhaust — which is the whole reason he can use it at all.
    const state = heimerState(true);
    const viaLegend = heimerActions(state).find((a) => a.type === "ActivateAbility" && a.viaAbilityDefId === VIKTOR)!;

    const after = executeActivateAbility(state, viaLegend as never);

    expect(after.players[0]!.baseUnits.find((u) => u.defId === HEIMERDINGER)!.exhausted).toBe(true);
    expect(after.players[0]!.legend.exhausted).toBe(false); // the legend is untouched
    expect(after.players[0]!.baseUnits.some((u) => u.name === "Recruit")).toBe(true); // and it worked
  });

  it("can use an ability whose source is already exhausted", () => {
    // Follows from the same rule: the source's readiness is not part of the cost
    // he pays, so a spent gear still grants its ability.
    const state = heimerState(true);
    state.players[0]!.activeGear[0]!.exhausted = true;

    expect(heimerActions(state).some((a) => a.type === "ActivateAbility" && a.viaAbilityDefId === ORB_OF_REGRET)).toBe(true);
  });

  it("pays the borrowed ability's Energy too, not just the exhaust", () => {
    const state = heimerState(false);
    const viaLegend = heimerActions(state)[0]!;

    const after = submit(state, viaLegend).state;

    expect(after.players[0]!.channeled.filter((r) => r.state === "Ready")).toHaveLength(3); // 4 - 1
  });

  it("offers nothing when no friendly permanent has an ability", () => {
    const state = heimerState(false, JINX); // Jinx's legend ability is not activated
    expect(heimerActions(state)).toHaveLength(0);
  });

  it("refuses an ability nobody friendly actually has", () => {
    // The guard that stops `viaAbilityDefId` from being a way to activate a card
    // you do not control.
    const state = heimerState(false, JINX);
    const heimerId = state.players[0]!.baseUnits[0]!.instanceId;
    expect(resolveActivation(state, 0, heimerId, ORB_OF_REGRET)).toBeUndefined();

    const forged = { type: "ActivateAbility", playerIndex: 0, permanentInstanceId: heimerId, viaAbilityDefId: ORB_OF_REGRET };
    expect(validateActivateAbility(state, forged as never).ok).toBe(false);
  });

  it("does not duplicate an ability two friendly copies both have", () => {
    const state = heimerState(true);
    state.players[0]!.activeGear = [gear(ORB_OF_REGRET), gear(ORB_OF_REGRET)];
    const heimer = state.players[0]!.baseUnits[0]!;

    const offered = abilitiesAvailableTo(state, 0, heimer).map((a) => a.abilityDefId);

    expect(offered.filter((id) => id === ORB_OF_REGRET)).toHaveLength(1);
  });
});

describe("coverage now sees Legends at all", () => {
  it("counts the three preset legends and Heimerdinger as implemented", () => {
    for (const id of [JINX, LEE_SIN, VIKTOR, HEIMERDINGER]) {
      const def = registry.get(id);
      expect(needsImplementation(def), `${id} (${def.name}) has printed text`).toBe(true);
      expect(isCardImplemented(def), `${id} (${def.name})`).toBe(true);
    }
  });
});
