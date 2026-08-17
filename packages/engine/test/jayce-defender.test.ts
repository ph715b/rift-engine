import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { abilitiesAvailableTo } from "../src/engine/activated-abilities.js";
import { empowerPermanent } from "../src/engine/effect-helpers.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance, type LegendInstance } from "../src/model/card.js";
import { makeState } from "./fixtures.js";
import type { GameState } from "../src/model/game-state.js";

/**
 * Jayce - Defender of Tomorrow — "[Empower] [2][rainbow][rainbow] … [1],
 * [Exhaust]: Ready a gear. [Empowered][>] [1], [Exhaust]: Ready 2 gear."
 *
 * **THREE activated abilities on one card**, which the registry could not express:
 * it is keyed by defId and his own key is taken by the generated `[Empower]`. The
 * two READY abilities therefore carry suffixed keys and are offered by
 * `abilitiesAvailableTo`, which already returns a list and already hands a source
 * a second entry under another key (Svellsongur's copy, Forge of the Fluft's
 * grant).
 *
 * **828 ADDS a dependent ability, it does not replace one**, so an Empowered
 * Jayce genuinely has both READY abilities and both must be offered — the 2-gear
 * one dominates at the same cost, but offering only the better one would be the
 * engine choosing for the player.
 *
 * He is also the first ABILITY in the pool to target a GEAR. Before this the
 * activation enumerator fanned out `"unit"` and `"unitOrGear"` and pushed
 * everything else TARGET-LESS, so a `"gear"` ability would have been offered with
 * nothing chosen and then done nothing — the exact shape Pack of Wonders' note
 * records having fixed for `unitOrGear`.
 */

const registry = defaultCardRegistry();
const JAYCE = "VEN-149";
const JAYCE_READY = "VEN-149-ready";
const JAYCE_READY_EMPOWERED = "VEN-149-ready-empowered";
const A_GEAR = "SFD-022"; // Long Sword — a real gear, so nothing here is synthetic

const gear = (instanceId: string, exhausted: boolean): GearInstance => ({
  ...(createCardInstance(registry.get(A_GEAR)) as GearInstance),
  instanceId,
  exhausted,
});

/** Jayce as the seated legend, with the given gear in play and Energy to spend. */
function board(gears: GearInstance[], empowered = false): GameState {
  const state = makeState({ phase: "Action" });
  state.players[0]!.legend = {
    ...(createCardInstance(registry.get(JAYCE)) as LegendInstance),
    instanceId: "jayce",
    exhausted: false,
  };
  state.players[0]!.activeGear = gears;
  state.players[0]!.floatingEnergy = 10;
  return empowered ? empowerPermanent(state, "jayce") : state;
}

const offered = (state: GameState): string[] =>
  abilitiesAvailableTo(state, 0, state.players[0]!.legend).map((a) => a.abilityDefId);

const readyActionsFor = (state: GameState, abilityDefId: string) =>
  legalActions(state).filter(
    (a) => a.type === "ActivateAbility" && a.permanentInstanceId === "jayce" && a.viaAbilityDefId === abilityDefId,
  );

describe("Jayce offers three abilities, and the third only while Empowered", () => {
  it("offers [Empower] and the printed Ready, but not the Empowered one", () => {
    const ids = offered(board([gear("g1", true)]));
    expect(ids, "his generated [Empower] is missing").toContain(JAYCE);
    expect(ids, "his printed Ready ability is missing").toContain(JAYCE_READY);
    expect(ids, "the dependent ability was offered un-Empowered").not.toContain(JAYCE_READY_EMPOWERED);
  });

  it("offers BOTH Ready abilities once Empowered — 828 adds, it does not replace", () => {
    const ids = offered(board([gear("g1", true)], true));
    expect(ids).toContain(JAYCE_READY);
    expect(ids, "the dependent ability was not offered to an Empowered Jayce").toContain(JAYCE_READY_EMPOWERED);
  });
});

describe("the gear target is fanned out and readied", () => {
  it("offers one action per EXHAUSTED friendly gear, and none per ready one", () => {
    // `exhaustedOnly` is `legal-actions`' own "paying for nothing is never what
    // the player meant" — a ready gear is nothing to ready.
    const state = board([gear("exhausted", true), gear("alreadyReady", false)]);
    const targets = readyActionsFor(state, JAYCE_READY).map((a) =>
      a.type === "ActivateAbility" ? a.targetPermanentInstanceId : undefined,
    );
    expect(targets, "a ready gear was offered as a target").toEqual(["exhausted"]);
  });

  it("is not offered at all with nothing exhausted to ready", () => {
    const state = board([gear("g1", false)]);
    expect(readyActionsFor(state, JAYCE_READY), "the ability was offered with no legal gear").toEqual([]);
  });

  it("readies the chosen gear through submit", () => {
    const state = board([gear("g1", true), gear("g2", true)]);
    const [action] = readyActionsFor(state, JAYCE_READY).filter((a) =>
      a.type === "ActivateAbility" ? a.targetPermanentInstanceId === "g1" : false,
    );
    expect(action, "no action targeting g1 was offered").toBeDefined();

    const { state: after, result } = submit(state, action!);
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
    const gearAfter = after.players[0]!.activeGear;
    expect(gearAfter.find((g) => g.instanceId === "g1")!.exhausted, "the chosen gear was not readied").toBe(false);
    // The printed ability readies ONE. The second gear stays exhausted, which is
    // what separates it from the Empowered version below.
    expect(gearAfter.find((g) => g.instanceId === "g2")!.exhausted, "the printed ability readied two gear").toBe(true);
  });

  it("the Empowered ability readies TWO", () => {
    const state = board([gear("g1", true), gear("g2", true)], true);
    const [action] = readyActionsFor(state, JAYCE_READY_EMPOWERED).filter((a) =>
      a.type === "ActivateAbility" ? a.targetPermanentInstanceId === "g1" : false,
    );
    expect(action, "no Empowered action targeting g1 was offered").toBeDefined();

    const { state: after, result } = submit(state, action!);
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
    for (const id of ["g1", "g2"]) {
      expect(after.players[0]!.activeGear.find((g) => g.instanceId === id)!.exhausted, `${id} was not readied`).toBe(false);
    }
  });

  it("readies just ONE when there is no second exhausted gear (359.3.e.6)", () => {
    // "An instruction that cannot be followed is ignored" — one gear readied is a
    // legal outcome, not a refusal.
    const state = board([gear("g1", true), gear("g2", false)], true);
    const [action] = readyActionsFor(state, JAYCE_READY_EMPOWERED);
    const { result } = submit(state, action!);
    expect(result, "the ability was refused with only one gear to ready").toMatchObject({ type: "Ok" });
  });
});

describe("coverage", () => {
  it("claims Jayce", () => {
    expect(isCardImplemented(registry.get(JAYCE)), "Jayce is written but unclaimed").toBe(true);
  });
});
