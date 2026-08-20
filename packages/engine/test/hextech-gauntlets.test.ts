import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { validateActivateAbility } from "../src/actions/validate-activate-ability.js";
import { activatedAbilityDefIds, activationCostFor, activationCostOf } from "../src/engine/activated-abilities.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { ActivateAbilityAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realGearInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * **UNL-188 Hextech Gauntlets — "[Equip] [3][rainbow]. This ability's Energy
 * cost is reduced by the Might of the unit you choose."**
 *
 * The pool's first activation cost that depends on WHICH target was chosen.
 * `activationCostOf` is handed a defId and a mode and nothing else — the target
 * is picked afterwards — which is exactly what the refusal that carried this
 * card said: "no activation cost can depend on the chosen target".
 *
 * # The ability-level gate prices the BEST case, on purpose
 *
 * `canPayActivationCost` runs once per ability, before any target exists.
 * Pricing the un-reduced 3 Energy there would withhold the Gauntlets entirely
 * whenever the player could afford them only with the discount — a legal play
 * refused because the engine had not yet asked which unit. So `activationCostFor`
 * with no target returns the LARGEST reduction any legal target could give, and
 * each candidate is re-priced against its own target in the fan-out. Both halves
 * are asserted below: the affordable-only-with-a-discount play IS offered, and
 * the target that re-prices to unpayable is NOT.
 *
 * # Reading the payments: rule 164.2 makes them one rune short
 *
 * The `[Equip]` cost is Energy PLUS a rainbow Power pip, and `activationPayment`
 * pays the Power first because paying Power RECYCLES the rune, which banks 1
 * floating Energy (164.2.a/b — a rune does double duty). So a 3-Energy cost
 * names **two** energy runes, not three, and the Power rune is spent from state
 * rather than named at all. `energyRunesFor` below encodes that once so no
 * assertion has to restate it, and the same trap already cost this session an
 * afternoon on the replaced-cost tests.
 *
 * # Might is CURRENT Might
 *
 * 143.2, not the printed number — a pumped unit really does pay for more of the
 * attach, and one test below pumps a 0-Might unit to prove the read is live.
 */

const registry = defaultCardRegistry();
const GAUNTLETS = "UNL-188";
const PRINTED_ENERGY = 3;

/** The energy runes a cost of `PRINTED_ENERGY - might` actually names — one
 *  fewer than the Energy owed, because the rainbow Power pip recycles a rune
 *  and banks 1 floating Energy first (164.2). */
const energyRunesFor = (might: number): number => Math.max(0, PRINTED_ENERGY - might - 1);

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

/** The Gauntlets unattached in play, with friendly units of the given Mights. */
function board(mights: number[], runeCount = 8): { state: GameState; gearId: string } {
  const gear = realGearInstance(GAUNTLETS);
  const state = makeState({ phase: "Action", activePlayerIndex: 0, turnState: "Neutral", chainOpen: true });
  state.players[0]!.activeGear = [gear];
  state.players[0]!.baseUnits = mights.map((m, i) => makeUnit({ instanceId: `u${i}`, might: m }));
  state.players[0]!.channeled = Array.from({ length: runeCount }, (_, i) => rune(`f${i}`, "Fury"));
  return { state, gearId: gear.instanceId };
}

const equipsOf = (state: GameState, gearId: string): ActivateAbilityAction[] =>
  legalActions(state).filter(
    (a): a is ActivateAbilityAction => a.type === "ActivateAbility" && a.permanentInstanceId === gearId,
  );

const energyOf = (a: ActivateAbilityAction): number => a.payment?.energyRunes.length ?? 0;

describe("the Energy cost falls by the chosen unit's Might", () => {
  it("is the printed 3 for a 0-Might unit and 1 for a 2-Might one", () => {
    const { state } = board([0, 2]);

    expect(activationCostFor(state, 0, GAUNTLETS, undefined, "u0").energy, "a 0-Might unit did not cost the printed Energy").toBe(
      PRINTED_ENERGY,
    );
    expect(activationCostFor(state, 0, GAUNTLETS, undefined, "u1").energy, "the 2-Might unit did not reduce the cost").toBe(
      PRINTED_ENERGY - 2,
    );
  });

  it("floors at 0 — a unit bigger than the cost does not pay you back", () => {
    const { state } = board([9]);
    expect(activationCostFor(state, 0, GAUNTLETS, undefined, "u0").energy, "a 9-Might unit produced a negative cost").toBe(0);
  });

  it("reads CURRENT Might, not the printed number", () => {
    // 143.2. A 0-Might unit pumped to 2 must reduce by 2; a version reading
    // `unit.might` straight off the instance reduces by nothing.
    const { state } = board([0]);
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "u0", might: 0, mightThisTurn: 2 })];

    expect(activationCostFor(state, 0, GAUNTLETS, undefined, "u0").energy, "the pump was ignored").toBe(PRINTED_ENERGY - 2);
  });

  it("with no target it names the BEST case — the gate must not withhold", () => {
    const { state } = board([1, 4]);
    expect(activationCostFor(state, 0, GAUNTLETS).energy, "the gate priced something other than the best target").toBe(0);
  });

  it("re-prices EXACTLY the abilities that declare a board-dependent price", () => {
    // **This pin used to assert that NOTHING but the Gauntlets was re-priced, and
    // it flipped on 2026-08-19** when Vendetta's three self-modifying `[Empower]`
    // costs landed ("This ability costs [1] less for each rune you control",
    // 827.1.c.3). Its premise — "the Gauntlets are the only state-priced ability"
    // — was a fact about the pool at the time, not an invariant, so it was
    // guaranteed to fire for the second such card whether or not anything was
    // wrong.
    //
    // Replaced with the invariant it was reaching for, which cannot be outrun:
    // `activationCostFor` differs from `activationCostOf` for exactly those
    // abilities that DECLARE a board-dependent price, and no others.
    //
    // **Two-sided on purpose, which is what stops it going vacuous.** The old
    // form asserted an empty list; deleting `applyEnergyDiscount` entirely would
    // have kept that green forever. Here the declared set must ALSO actually move,
    // so a rule that is declared and never applied is red.
    //
    // FOUR runes, not the fixture's default eight, and that is load-bearing:
    // Baccai Sandspinner's discount is "if you control 4 OR FEWER runes", so at
    // eight it correctly does not bite and would drop out of the moved set for a
    // reason that has nothing to do with the wiring. Four makes every declared
    // rule bite at once — 5 -> 2, and 12 -> 8 for the two per-rune cards.
    const { state } = board([9], 4);

    const declaresBoardPrice = (defId: string) =>
      defId === GAUNTLETS || activationCostOf(defId).energyDiscount !== undefined;
    const moved = activatedAbilityDefIds().filter(
      (defId) => JSON.stringify(activationCostFor(state, 0, defId)) !== JSON.stringify(activationCostOf(defId)),
    );
    const declared = activatedAbilityDefIds().filter(declaresBoardPrice);

    expect(declared.length, "no ability declares a board-dependent price — this test measures nothing").toBeGreaterThan(1);
    expect(moved.sort(), "the re-priced set is not exactly the declared set").toEqual(declared.sort());
  });
});

describe("the enumerated actions carry the per-target price", () => {
  it("prices three targets three different ways in one enumeration", () => {
    // The shape a single per-ABILITY price cannot produce: three candidates off
    // one activation, at three different prices.
    const { state, gearId } = board([0, 1, 3]);
    const byTarget = new Map(equipsOf(state, gearId).map((a) => [a.targetUnitInstanceId, energyOf(a)]));

    expect(byTarget.get("u0"), "the 0-Might target was discounted").toBe(energyRunesFor(0));
    expect(byTarget.get("u1"), "the 1-Might target was not priced separately").toBe(energyRunesFor(1));
    expect(byTarget.get("u2"), "the 3-Might target did not reach the floor").toBe(energyRunesFor(3));
  });

  it("is still offered when only the DISCOUNTED cost is affordable", () => {
    // **The fidelity test.** Two runes cannot cover the printed 3 Energy plus the
    // pip, but a 2-Might unit brings the Energy to 1 and the recycled Power rune
    // pays even that. A gate that priced the un-reduced cost before knowing the
    // target would drop the ability entirely and the player would never see a
    // play the rules allow.
    const { state, gearId } = board([2], 2);

    expect(
      equipsOf(state, gearId).length,
      "the Gauntlets were withheld because the UNDISCOUNTED price was unaffordable",
    ).toBe(1);
  });

  it("and the target it cannot afford is dropped, not offered-then-refused", () => {
    // The other half. With two runes, the 2-Might unit is payable and the 0-Might
    // one is not; offering both would be the enumerate/validate split this engine
    // has shipped five times.
    const { state, gearId } = board([0, 2], 2);
    const targets = equipsOf(state, gearId).map((a) => a.targetUnitInstanceId);

    expect(targets, "the affordable target was dropped too").toContain("u1");
    expect(targets, "an unaffordable target was offered").not.toContain("u0");
  });
});

describe("the enumerator and the validator agree", () => {
  it("every offered equip validates", () => {
    const { state, gearId } = board([0, 2, 5]);
    const offered = equipsOf(state, gearId);

    expect(offered.length, "nothing was offered — this asserts nothing").toBe(3);
    for (const action of offered) {
      const verdict = validateActivateAbility(state, action);
      expect(verdict.ok, verdict.ok ? "" : `offered but refused: ${verdict.error}`).toBe(true);
    }
  });

  it("REFUSES a forged cheap payment against an expensive target", () => {
    // Naming the 0-Might unit while paying the 3-Might unit's price. Only a
    // forged action reaches this, which is why the validator has to re-derive
    // the cost from the target rather than trust what it was handed.
    const { state, gearId } = board([0, 3], 4);
    const cheap = equipsOf(state, gearId).find((a) => a.targetUnitInstanceId === "u1")!;
    const forged: ActivateAbilityAction = { ...cheap, targetUnitInstanceId: "u0" };

    expect(validateActivateAbility(state, forged).ok, "a 0-Energy payment bought a 3-Energy attach").toBe(false);
  });
});

describe("executing it", () => {
  /**
   * Equips the named unit on a board holding BOTH a 0-Might and a 2-Might one,
   * and reports the holder plus how many runes actually left the ready pool.
   *
   * **The two Mights have to coexist on one board**, which is the whole reason
   * this fixture is shaped this way. A first version equipped a lone unit and
   * compared two boards, and the executor could then drop the target entirely
   * without any test noticing: with one unit on the board the BEST case and the
   * chosen case are the same number. Only a board where they differ can tell the
   * third cost site from the gate.
   */
  const equip = (targetInstanceId: string): { holder: string | null | undefined; runesSpent: number } => {
    const { state, gearId } = board([0, 2]);
    const action = equipsOf(state, gearId).find((a) => a.targetUnitInstanceId === targetInstanceId)!;

    const { state: after, result } = submit(state, action);
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
    const settled = resolveHeldTriggers(after);
    const ready = (s: GameState) => s.players[0]!.channeled.filter((r) => r.state === "Ready").length;

    return {
      holder: settled.players[0]!.activeGear.find((g) => g.instanceId === gearId)?.attachedToInstanceId,
      runesSpent: ready(state) - ready(settled),
    };
  };

  it("attaches the gear to the unit that was chosen", () => {
    expect(equip("u0").holder, "the gear did not attach").toBe("u0");
    expect(equip("u1").holder, "it attached to the wrong unit").toBe("u1");
  });

  it("charges the price of the unit CHOSEN, not the cheapest one available", () => {
    // The executor re-derives the cost from the action's own target, so this is
    // the third cost site agreeing with the other two. Asserted as a DIFFERENCE:
    // the absolute figures are muddied by the Power pip's recycled rune banking
    // 1 floating Energy (164.2), and an absolute assertion here failed for
    // exactly that reason on the replaced-cost work earlier this session.
    expect(equip("u0").runesSpent - equip("u1").runesSpent, "the executor ignored which unit was chosen").toBe(2);
  });
});

describe("coverage", () => {
  it("reports the card finished", () => {
    const def = registry.get(GAUNTLETS);
    expect(isCardImplemented(def), "it still reports unfinished").toBe(true);
    expect(partialImplementationNote(def), "it carries a partial note").toBeUndefined();
  });
});
