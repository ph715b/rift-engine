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
