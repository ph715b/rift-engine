import { describe, expect, it } from "vitest";
import { activationCostOf, canPayActivationCost, modesOf } from "../src/engine/activated-abilities.js";
import { executeActivateAbility } from "../src/actions/execute-activate-ability.js";
import { holdEventTrigger } from "../src/engine/triggers.js";
import { claimBattlefieldControl } from "../src/engine/combat.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { returnPermanentToHand } from "../src/engine/effect-helpers.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * Phase 6's first four — each its own small mechanism.
 *
 * Two of them needed the ENGINE to carry a fact it was throwing away, and those
 * are the interesting ones: Yone reads "a battlefield that WAS uncontrolled",
 * which is unanswerable once control has moved, and Prize of Progress reads an
 * ACTIVATION, which nothing previously announced.
 */

const registry = defaultCardRegistry();

const YONE_BLADEMASTER = "SFD-116";
const FACTORY_RECALL = "SFD-135";
const RENATA_MASTERMIND = "SFD-088";
const PRIZE_OF_PROGRESS = "SFD-075";
const LONG_SWORD = "SFD-022";

const gear = (defId: string): GearInstance => createCardInstance(registry.get(defId)) as GearInstance;
const runes = (n: number, domain: RuneCard["domain"]): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, domain, state: "Ready" as const }));

describe("Yone - Blademaster (SFD-116): conquering a battlefield that WAS uncontrolled", () => {
  /** Yone at bf1, and an enemy sitting at home for him to hit. */
  function board(): GameState {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units["p1"] = [{ ...realUnitInstance(YONE_BLADEMASTER), instanceId: "yone" }];
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "at-home", might: 9 })];
    return state;
  }

  const conquer = (state: GameState, wasUncontrolled: boolean, battlefieldId = "bf1") =>
    resolveHeldTriggers(
      holdEventTrigger(state, {
        kind: "battlefieldConquered",
        conquerorIndex: 0,
        battlefieldId,
        ...(wasUncontrolled ? { wasUncontrolled: true as const } : {}),
      }),
    );

  const damageAtHome = (state: GameState) =>
    state.players[1]!.baseUnits.find((u) => u.instanceId === "at-home")?.damage ?? 0;

  it("hits an enemy in a base for his Might", () => {
    const state = board();
    const printed = state.battlefields[0]!.units["p1"]![0]!;
    const might = effectiveMight(state, printed, 0, { isCombat: false });

    expect(damageAtHome(conquer(state, true)), "no damage was dealt").toBe(might);
  });

  /**
   * **The whole reason the event now carries `wasUncontrolled`.** Taking a
   * battlefield off the OPPONENT is not "a battlefield that was uncontrolled",
   * and by the time any listener runs the board cannot tell the two apart —
   * control has already moved to the conqueror either way.
   */
  it("does NOTHING when the battlefield was controlled by someone", () => {
    expect(damageAtHome(conquer(board(), false)), "he fired on an ordinary conquest").toBe(0);
  });

  /** "When **I** conquer" is positional — a conquest elsewhere is not his. */
  it("does not fire for a battlefield he is not standing at", () => {
    expect(damageAtHome(conquer(board(), true, "bf2")), "he fired for another battlefield").toBe(0);
  });

  /** "An enemy unit IN A BASE" — an enemy with nothing at home takes nothing,
   *  which is 055's do-as-much-as-you-can rather than a failure. */
  it("does nothing with no enemy at home", () => {
    const state = board();
    state.players[1]!.baseUnits = [];
    state.battlefields[1]!.units["p2"] = [makeUnit({ instanceId: "out-there" })];

    const after = conquer(state, true);

    expect(after.battlefields[1]!.units["p2"]![0]!.damage, "it reached a unit at a battlefield").toBe(0);
  });

  /**
   * **The tests above synthesize the event, so they never exercise the site that
   * CAPTURES `wasUncontrolled` — and a mutation proved it: hardcoding the
   * capture to `false` left every one of them green.** This drives a real
   * conquest through `claimBattlefieldControl`, the walk-in path, which is one
   * of the two callers of `updateControl` and the only place the prior
   * controller still exists to be read.
   */
  it("captures the uncontrolled case from a REAL walk-in conquest", () => {
    const state = board(); // bf1 has no controllerId — uncontrolled
    expect(state.battlefields[0]!.controllerId, "the fixture battlefield is already controlled").toBeNull();
    const printed = state.battlefields[0]!.units["p1"]![0]!;
    const might = effectiveMight(state, printed, 0, { isCombat: false });

    const after = resolveHeldTriggers(claimBattlefieldControl(state, "bf1", 0));

    expect(damageAtHome(after), "a real uncontrolled conquest did not fire him").toBe(might);
  });

  /** The other half of the same capture: taking it off the OPPONENT must not
   *  fire him, driven through the same real path. */
  it("captures the controlled case from a real conquest off the opponent", () => {
    const state = board();
    state.battlefields[0]!.controllerId = state.players[1]!.id;

    const after = resolveHeldTriggers(claimBattlefieldControl(state, "bf1", 0));

    expect(damageAtHome(after), "he fired on a battlefield taken off the opponent").toBe(0);
  });

  it("is claimed by a module", () => {
    expect(isCardImplemented(registry.get(YONE_BLADEMASTER))).toBe(true);
  });
});

describe("Factory Recall (SFD-135): return a gear to its owner's hand", () => {
  it("returns the OPPONENT's gear to their hand", () => {
    const enemyGear = gear(LONG_SWORD);
    const state = makeState({ phase: "Action" });
    state.players[1]!.activeGear = [enemyGear];

    const after = returnPermanentToHand(state, enemyGear.instanceId);

    expect(after.players[1]!.activeGear, "the gear was not removed from play").toHaveLength(0);
    // "To its OWNER's hand" — the opponent's, not the caster's.
    expect(after.players[1]!.hand.map((c) => c.instanceId), "it went to the wrong hand").toContain(
      enemyGear.instanceId,
    );
    expect(after.players[0]!.hand, "it went to the caster's hand").toHaveLength(0);
  });

  it("returns your own gear too — the card says 'a gear', unqualified", () => {
    const ownGear = gear(LONG_SWORD);
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [ownGear];

    const after = returnPermanentToHand(state, ownGear.instanceId);

    expect(after.players[0]!.activeGear).toHaveLength(0);
    expect(after.players[0]!.hand.map((c) => c.instanceId)).toContain(ownGear.instanceId);
  });

  it("is claimed by a module", () => {
    expect(isCardImplemented(registry.get(FACTORY_RECALL))).toBe(true);
  });
});

describe("Renata Glasc - Mastermind (SFD-088): the pool's first ability that SCORES", () => {
  /** Renata at a battlefield with runes to spend. */
  function board(atBattlefield: boolean, mind = 8): GameState {
    const state = makeState({ phase: "Action" });
    const renata = { ...realUnitInstance(RENATA_MASTERMIND), instanceId: "renata" };
    if (atBattlefield) state.battlefields[0]!.units["p1"] = [renata];
    else state.players[0]!.baseUnits = [renata];
    state.players[0]!.channeled = runes(mind, "Mind");
    state.players[0]!.floatingEnergy = 8;
    state.players[0]!.deck = Array.from({ length: 4 }, () => gear(LONG_SWORD));
    return state;
  }

  const renataOf = (state: GameState) =>
    state.battlefields[0]!.units["p1"]?.[0] ?? state.players[0]!.baseUnits[0]!;

  it("has two modes with DIFFERENT costs", () => {
    const modes = modesOf(RENATA_MASTERMIND);
    expect(modes.map((m) => m.id).sort()).toEqual(["draw", "score"]);
    // The draw prints no exhaust, so it repeats while the Energy lasts; the score
    // costs four of each AND the exhaust.
    expect(activationCostOf(RENATA_MASTERMIND, "draw")).toMatchObject({ energy: 1 });
    expect(activationCostOf(RENATA_MASTERMIND, "draw").exhaust).toBeUndefined();
    expect(activationCostOf(RENATA_MASTERMIND, "score")).toMatchObject({ energy: 4, exhaust: true });
  });

  it("scores a real point through the shared gainPoints path", () => {
    const state = board(true);
    const after = executeActivateAbility(state, {
      type: "ActivateAbility",
      playerIndex: 0,
      permanentInstanceId: "renata",
      modeId: "score",
    });

    expect(after.players[0]!.points, "no point was scored").toBe(1);
  });

  /** "Use my abilities only while I'm AT A BATTLEFIELD" is a restriction on
   *  ACTIVATING, so it is asked before any cost is taken. */
  it("cannot be used from base", () => {
    const state = board(false);
    expect(canPayActivationCost(state, 0, renataOf(state), RENATA_MASTERMIND, "draw"), "base use was allowed").toBe(
      false,
    );
  });

  it("CAN be used from a battlefield", () => {
    const state = board(true);
    expect(canPayActivationCost(state, 0, renataOf(state), RENATA_MASTERMIND, "draw")).toBe(true);
  });

  it("is claimed by a module", () => {
    expect(isCardImplemented(registry.get(RENATA_MASTERMIND))).toBe(true);
  });
});

describe("Prize of Progress (SFD-075): +1 Might when you use a GEAR's ability", () => {
  function board(): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [{ ...realUnitInstance(PRIZE_OF_PROGRESS), instanceId: "prize" }];
    return state;
  }

  const activated = (state: GameState, sourceKind: "Gear" | "Unit" | "Legend", activatorIndex: 0 | 1 = 0) =>
    resolveHeldTriggers(
      holdEventTrigger(state, {
        kind: "abilityActivated",
        activatorIndex,
        sourceKind,
        sourceInstanceId: "whatever",
      }),
    );

  const mightOf = (state: GameState) =>
    effectiveMight(state, state.players[0]!.baseUnits[0]!, 0, { isCombat: false });

  it("grows off a GEAR's ability", () => {
    const state = board();
    expect(mightOf(activated(state, "Gear")), "he did not grow").toBe(mightOf(state) + 1);
  });

  /** "of a GEAR" is the whole condition — a unit's ability and a legend's are
   *  not a gear's. */
  it("does NOT grow off a unit's or a legend's ability", () => {
    const state = board();
    expect(mightOf(activated(state, "Unit")), "a unit's ability fed him").toBe(mightOf(state));
    expect(mightOf(activated(state, "Legend")), "a legend's ability fed him").toBe(mightOf(state));
  });

  it("reads \"YOU use\" — the opponent's gear ability pays nothing", () => {
    const state = board();
    expect(mightOf(activated(state, "Gear", 1)), "he grew off the opponent").toBe(mightOf(state));
  });

  /** Not capped: every gear activation pays, which in a deck of Gold tokens is
   *  the card. */
  it("stacks across several activations", () => {
    const state = board();
    const twice = activated(activated(state, "Gear"), "Gear");
    expect(mightOf(twice)).toBe(mightOf(state) + 2);
  });

  it("is claimed by a module", () => {
    expect(isCardImplemented(registry.get(PRIZE_OF_PROGRESS))).toBe(true);
  });
});
