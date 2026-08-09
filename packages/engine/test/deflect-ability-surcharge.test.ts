import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validateActivateAbility } from "../src/actions/validate-activate-ability.js";
import { deflectSurchargeForTargets } from "../src/engine/granted-keywords.js";
import type { GameState } from "../src/model/game-state.js";
import type { ActivateAbilityAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, realUnitInstance } from "./fixtures.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import type { GearInstance } from "../src/model/card.js";

/**
 * `[Deflect N]` — "Opponents must pay N rainbow Power to choose me **with a
 * spell or ability**."
 *
 * **The ability half was never wired.** `deflectSurchargeForTargets` had exactly
 * two callers, `legal-actions`' PlayCard branch and `validate-play-card`, so an
 * ACTIVATED ability could choose a Deflect unit for nothing — measured across the
 * pool at six activations from four sources, none taxed.
 *
 * The subjects here are deliberately gear with NO Energy cost (Iron Ballista,
 * Orb of Regret): their actions carried no `payment` at all, so the surcharge has
 * to be able to create one rather than extend one.
 */

const POUTY_PORO = "OGN-013"; // a unit whose entire printed text is [Deflect 1]
const IRON_BALLISTA = "OGN-017"; // exhaust: damage a unit — no Energy cost
const ORB_OF_REGRET = "OGN-090"; // exhaust: targets a unit — no Energy cost

const registry = defaultCardRegistry();
const gear = (defId: string) => createCardInstance(registry.get(defId)) as GearInstance;
const rune = (id: string, domain: RuneCard["domain"] = "Fury"): RuneCard => ({ id, domain, state: "Ready" });

/** Player 0 holds `sourceDefId` as READY gear; an enemy [Deflect 1] unit stands
 *  at bf1; the pool is deep enough that nothing fails for want of runes. */
function boardWith(sourceDefId: string): { state: GameState; poroId: string } {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  const poro = realUnitInstance(POUTY_PORO);
  state.battlefields[0] = { ...state.battlefields[0]!, units: { p2: [poro] } };
  state.players[0]!.activeGear = [{ ...gear(sourceDefId), exhausted: false }];
  state.players[0]!.channeled = Array.from({ length: 6 }, (_, i) => rune(`f${i}`));
  return { state, poroId: poro.instanceId };
}

/** The enumerated activation that names the Poro, if there is one. */
function activationAtPoro(state: GameState, poroId: string): ActivateAbilityAction | undefined {
  return legalActions(state).find(
    (a): a is ActivateAbilityAction => a.type === "ActivateAbility" && a.targetUnitInstanceId === poroId,
  );
}

describe("[Deflect] taxes an ABILITY that chooses the unit, not only a spell", () => {
  for (const source of [IRON_BALLISTA, ORB_OF_REGRET]) {
    describe(`${source} activated at a [Deflect 1] unit`, () => {
      it("is offered at all — otherwise everything below is vacuous", () => {
        const { state, poroId } = boardWith(source);
        expect(activationAtPoro(state, poroId), "no activation names the Poro").toBeDefined();
        expect(deflectSurchargeForTargets(state, 0, [poroId]), "the Poro is not taxed at all").toBe(1);
      });

      it("the ENUMERATED action carries the surcharge", () => {
        const { state, poroId } = boardWith(source);
        const action = activationAtPoro(state, poroId)!;
        expect(
          (action.payment?.rainbowRunes ?? []).length,
          "the ability chose a [Deflect] unit and was quoted no rainbow Power",
        ).toBe(1);
      });

      it("is REFUSED when the surcharge is stripped", () => {
        const { state, poroId } = boardWith(source);
        const action = activationAtPoro(state, poroId)!;
        const untaxed: ActivateAbilityAction = {
          ...action,
          ...(action.payment ? { payment: { ...action.payment, rainbowRunes: [] } } : {}),
        };
        expect(validateActivateAbility(state, untaxed).ok, "an untaxed activation was accepted").toBe(false);
      });

      it("is ACCEPTED when it is paid, and the rune really leaves the pool", () => {
        const { state, poroId } = boardWith(source);
        const action = activationAtPoro(state, poroId)!;
        const paidId = action.payment!.rainbowRunes![0]!;
        const { state: after, result } = submit(state, action);
        expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
        expect(
          after.players[0]!.channeled.some((r) => r.id === paidId),
          "the rune spent on the tax is still sitting in the pool",
        ).toBe(false);
      });
    });
  }

  it("charges NOTHING for choosing a unit with no [Deflect]", () => {
    // The control. Without it, a surcharge applied to everything would pass every
    // assertion above.
    const { state } = boardWith(IRON_BALLISTA);
    const plain = realUnitInstance("OGN-164");
    state.battlefields[0] = { ...state.battlefields[0]!, units: { p2: [plain] } };
    const action = activationAtPoro(state, plain.instanceId);
    expect(action, "the plain unit is not even targetable — the control proves nothing").toBeDefined();
    expect((action!.payment?.rainbowRunes ?? []).length).toBe(0);
  });

  it("charges nothing for choosing your OWN [Deflect] unit — 'OPPONENTS must pay'", () => {
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    const mine = realUnitInstance(POUTY_PORO);
    state.battlefields[0] = { ...state.battlefields[0]!, units: { p1: [mine] } };
    state.players[0]!.activeGear = [{ ...gear(IRON_BALLISTA), exhausted: false }];
    state.players[0]!.channeled = Array.from({ length: 6 }, (_, i) => rune(`f${i}`));
    const action = activationAtPoro(state, mine.instanceId);
    if (action) expect((action.payment?.rainbowRunes ?? []).length).toBe(0);
  });
});

/**
 * The surcharge must not name a rune the ability's OWN Power cost will spend.
 *
 * **This crashed the engine, and no test in this suite could see it.** Found
 * 2026-08-09 by the `hunt-xp` probe, which died mid-run on *"Xerath - Freed's
 * activation cost cannot be paid"* while its controller held FOUR ready Fury
 * runes.
 *
 * The cause is an ordering gap between two things that never compared notes:
 *
 *   `withActivationSurcharge` (legal-actions.ts) chose the tax runes while
 *   excluding only the runes named for the ability's ENERGY. An activated
 *   ability's POWER runes are named nowhere in the action — `payActivationCost`
 *   pays that cost by calling `payPowerFromChanneled`, which picks from state.
 *
 *   And it picks FIRST. So the tax could name the very rune the Power cost was
 *   about to take; the Power step took it, `recycleRunesForSurcharge` then could
 *   not find it, and `executeActivateAbility` **threw**.
 *
 * A throw, not a refusal — because `canPayActivationCost` never looks at the
 * surcharge, so the enumerator had already offered the action and the validator
 * had already approved it. Every layer said yes and the executor exploded.
 *
 * **Why the whole suite above missed it.** It needs BOTH a `[Deflect]` target and
 * an ability whose cost is domain Power, and every fixture here uses Iron
 * Ballista or Orb of Regret, which cost only an exhaust. It became reachable in
 * play only when wave 2 added Bird tokens carrying `[Deflect]`. That is the case
 * for keeping a probe that plays whole games next to the unit tests: the
 * combination existed in no fixture anyone had thought to write.
 */
describe("the [Deflect] tax and the ability's own Power cost never claim the same rune", () => {
  const XERATH_FREED = "UNL-026"; // "[Fury], [Exhaust]: Deal 3 to a unit."

  /** Xerath at a battlefield (his `availableWhile` demands it), an enemy
   *  [Deflect 1] Poro to shoot, and a rune pool whose FIRST rune is the Fury one
   *  his Power cost will take — which is the collision. */
  function xerathBoard(): { state: GameState; poroId: string } {
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    const xerath = realUnitInstance(XERATH_FREED);
    const poro = realUnitInstance(POUTY_PORO);
    state.battlefields[0] = { ...state.battlefields[0]!, units: { p1: [xerath], p2: [poro] } };
    // Fury first, then Order: `payPowerFromChanneled` takes the first matching
    // rune in channeled order, and the old surcharge took the first rune of ANY
    // domain. Both land on `f0`.
    state.players[0]!.channeled = [rune("f0", "Fury"), rune("o1", "Order"), rune("o2", "Order"), rune("o3", "Order")];
    return { state, poroId: poro.instanceId };
  }

  it("the fixture really does set up the collision — the premise", () => {
    const { state, poroId } = xerathBoard();
    expect(deflectSurchargeForTargets(state, 0, [poroId]), "the Poro is not taxed, so nothing collides").toBe(1);
    const action = activationAtPoro(state, poroId);
    expect(action, "Xerath's ability was never offered at the Poro").toBeDefined();
    expect(action!.payment?.rainbowRunes ?? [], "no surcharge was attached").toHaveLength(1);
  });

  it("does NOT name the rune the Fury cost will spend", () => {
    // The single assertion that would have caught the crash.
    const { state, poroId } = xerathBoard();
    const action = activationAtPoro(state, poroId)!;
    expect(action.payment!.rainbowRunes, "the tax claimed the same Fury rune the Power cost takes").not.toContain("f0");
  });

  it("and the activation actually SUBMITS rather than throwing", () => {
    // The end-to-end proof. `submit` is what the probe drives, and this is the
    // shape that killed it: every layer approved the action and the executor
    // threw on a cost it had already been told was payable.
    const { state, poroId } = xerathBoard();
    const action = activationAtPoro(state, poroId)!;
    expect(validateActivateAbility(state, action).ok, "the validator refuses its own enumerated action").toBe(true);

    const after = submit(state, action);
    expect(after.result.type, after.result.type === "Invalid" ? after.result.error : "").toBe("Ok");
    // Two runes gone: one recycled for the Fury cost, one for the tax. If they
    // had been the same rune this would be 3 — which is the bug stated as a
    // number rather than as an absence of a crash.
    expect(after.state.players[0]!.channeled, "the tax and the cost shared a rune").toHaveLength(2);
  });
});
