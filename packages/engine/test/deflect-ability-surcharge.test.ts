import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validateActivateAbility } from "../src/actions/validate-activate-ability.js";
import { deflectSurchargeForTargets } from "../src/engine/granted-keywords.js";
import type { GameState } from "../src/model/game-state.js";
import type { ActivateAbilityAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance } from "./fixtures.js";
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

/**
 * A token-placing spell's DESTINATION variants owe the surcharge too.
 *
 * `legal-actions` fans a token-placing Spell out over the battlefields its caster
 * controls, and that branch pushed `variantPayment` — the untaxed one — while the
 * Unit reinforce branch directly above it pushes `variantPaymentForTargets` under
 * a comment recording that using the plain payment there had been "a real
 * offered-then-refused bug".
 *
 * The same bug, one branch down, latent because the table held three cards that
 * could not attract a surcharge. Adding Desert's Call and Flurry of Feathers on
 * 2026-08-09 made it live and `hunt-xp` died on *"Flurry of Feathers must pay 1
 * rainbow Power for Vex - Cheerless, but named 0"* — a THROW rather than a
 * refusal, because the AI takes an enumerated action straight to the executor.
 *
 * Vex - Cheerless's tax is not target-keyed: any spell owes it while she is on the
 * board. That is why a fan-out with no targets at all could still owe one, and
 * why this is testable without any [Deflect] unit.
 */
describe("a token-placing spell's destination variants carry the surcharge", () => {
  const FLURRY_OF_FEATHERS = "UNL-044"; // [Reaction], and its `birds` mode places tokens
  const VEX_CHEERLESS = "SFD-146";

  it("every enumerated destination names the rainbow, not just the base play", () => {
    // **The fixture is the point, and my first two attempts had it wrong.** Vex is
    // SFD-146 (I reached for SFD-121, a different card), and her tax applies only
    // to a spell cast INTO HER COMBAT — `vexSpellSwing` returns 0 unless
    // `showdownKind === "Combat"` and she is standing at the showdown battlefield.
    // That is exactly why the probe hit this on Flurry of Feathers, a [Reaction]
    // castable inside a combat, and never on Desert's Call, which is not.
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.hand = [createCardInstance(defaultCardRegistry().get(FLURRY_OF_FEATHERS))];
    state.players[0]!.channeled = Array.from({ length: 10 }, (_, i) => rune(`r${i}`, "Calm"));
    // A running COMBAT at bf1, with Vex on the enemy side of it and the caster
    // controlling the battlefield so a token destination is offered at all.
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      controllerId: "p1",
      units: { p1: [makeUnit({ name: "Mine" })], p2: [realUnitInstance(VEX_CHEERLESS)] },
    };
    state.turnState = "Showdown";
    state.showdownKind = "Combat";
    state.showdownBattlefieldId = "bf1";
    state.focusHolder = 0;

    const plays = legalActions(state).filter(
      (a): a is Extract<typeof a, { type: "PlayCard" }> => a.type === "PlayCard" && a.card.defId === FLURRY_OF_FEATHERS,
    );

    // Premises, both asserted: the spell is castable here, and a DESTINATION
    // variant really is fanned out. Without the second this tests the base play
    // only, which was never the broken half.
    expect(plays.length, "the spell enumerated nothing — this asserts nothing").toBeGreaterThan(0);
    const destinations = plays.filter((a) => a.destinationBattlefieldId !== undefined);
    expect(destinations.length, "no destination variant was fanned out").toBeGreaterThan(0);

    // Every candidate, not just the base one. The bug produced a MIX — the base
    // play taxed, the destination variants not — so an assertion over the first
    // candidate would have passed.
    for (const play of plays) {
      expect(
        (play.payment.rainbowRunes ?? []).length,
        `the ${play.destinationBattlefieldId ?? "base"} variant names no rainbow, and the executor THROWS on it`,
      ).toBe(1);
    }
  });
});
