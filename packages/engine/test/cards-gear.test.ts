import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { executeActivateAbility } from "../src/actions/execute-activate-ability.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { createCardInstance } from "../src/model/card.js";
import { validateActivateAbility } from "../src/actions/validate-activate-ability.js";
import { computeEffectiveCost } from "../src/engine/rune-payment.js";
import { gearEntersExhausted } from "../src/engine/deploy.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { GearInstance } from "../src/model/card.js";
import { answerDecisions, makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";

/**
 * The Gear activated abilities.
 *
 * Everything is driven through `legalActions` -> `executeActivateAbility`, never
 * the resolver closure: a Gear ability that resolves correctly but is never
 * ENUMERATED is unreachable, and that half is the one only the enumerator can
 * prove.
 */

const registry = defaultCardRegistry();

const IRON_BALLISTA = "OGN-017";
const SEAL_OF_RAGE = "OGN-040";
const SEAL_OF_FOCUS = "OGN-081";
const ENERGY_CONDUIT = "OGN-098";
const GARBAGE_GRABBER = "OGN-099";
const SEAL_OF_INSIGHT = "OGN-120";
const ARENA_BAR = "OGN-124";
const SEAL_OF_STRENGTH = "OGN-163";
const THE_SYREN = "OGN-184";
const TREASURE_TROVE = "OGN-186";
const SEAL_OF_DISCORD = "OGN-204";
const SEAL_OF_UNITY = "OGN-245";

const SEALS: [string, string][] = [
  [SEAL_OF_RAGE, "Fury"],
  [SEAL_OF_FOCUS, "Calm"],
  [SEAL_OF_INSIGHT, "Mind"],
  [SEAL_OF_STRENGTH, "Body"],
  [SEAL_OF_DISCORD, "Chaos"],
  [SEAL_OF_UNITY, "Order"],
];

const BATCH = [
  IRON_BALLISTA, ENERGY_CONDUIT, GARBAGE_GRABBER, ARENA_BAR, THE_SYREN, TREASURE_TROVE,
  ...SEALS.map(([id]) => id),
];

function gear(defId: string, instanceId = "g1"): GearInstance {
  const def = registry.get(defId);
  return {
    instanceId, defId, name: def.name, domains: def.domains, exhausted: false, isToken: false,
    kind: "Gear", energyCost: 0, powerCost: 0, powerDomain: null, keywords: {},
  } as GearInstance;
}

/** A state where p1 controls `defId` and it is the Action phase. */
function withGear(defId: string, overrides: (s: GameState) => void = () => {}): GameState {
  const state = makeState({ phase: "Action" });
  state.players[0]!.activeGear = [gear(defId)];
  overrides(state);
  return state;
}

const abilityActions = (state: GameState) =>
  legalActions(state).filter((a) => a.type === "ActivateAbility" && a.permanentInstanceId === "g1");

/** Activate an ability and settle the chain — a gear's "when this leaves the
 *  board" is a Chain Pending Item now, so an ability that kills it only places
 *  the payout. */
const activate = (state: GameState, pick = (as: ReturnType<typeof abilityActions>) => as[0]!) =>
  resolveHeldTriggers(executeActivateAbility(state, pick(abilityActions(state)) as never));

describe("The six Seals: exhaust to add 1 Power of their domain", () => {
  for (const [defId, domain] of SEALS) {
    it(`${registry.get(defId).name} adds 1 ${domain} Power`, () => {
      const state = withGear(defId);
      const after = activate(state);

      expect(after.players[0]!.floatingPower[domain as never]).toBe(1);
      expect(after.players[0]!.activeGear[0]!.exhausted).toBe(true);
    });
  }

  it("adds power of ITS domain and no other — six near-identical cards, one parameter", () => {
    // The reason they are generated rather than hand-copied: six pasted entries
    // is six chances to hand a Seal the wrong domain, and nothing else in the
    // game would notice.
    for (const [defId, domain] of SEALS) {
      const after = activate(withGear(defId));
      const pools = Object.entries(after.players[0]!.floatingPower).filter(([, n]) => (n ?? 0) > 0);
      expect(pools).toEqual([[domain, 1]]);
    }
  });

  it("the banked Power really pays a Power pip of that domain", () => {
    const after = activate(withGear(SEAL_OF_RAGE));
    const { powerCost } = computeEffectiveCost(0, after.players[0]!.floatingPower, 0, 1, "Fury");
    expect(powerCost).toBe(0);
  });

  it("is not offered once exhausted", () => {
    const state = withGear(SEAL_OF_RAGE, (s) => {
      s.players[0]!.activeGear[0]!.exhausted = true;
    });
    expect(abilityActions(state)).toHaveLength(0);
  });
});

describe("Energy Conduit (OGN-098): exhaust to add 1 Energy", () => {
  it("adds unrestricted floating Energy, not Lux - Crownguard's spells-only pool", () => {
    const after = activate(withGear(ENERGY_CONDUIT));

    expect(after.players[0]!.floatingEnergy).toBe(1);
    expect(after.players[0]!.restrictedSpellEnergy).toBe(0);
  });
});

describe("Iron Ballista (OGN-017): enters exhausted, then 2 damage a turn", () => {
  it("is declared as entering exhausted — its whole cost", () => {
    expect(gearEntersExhausted(IRON_BALLISTA)).toBe(true);
    expect(gearEntersExhausted(ENERGY_CONDUIT)).toBe(false);
  });

  it("deals 2 to a unit at a battlefield", () => {
    const enemy = makeUnit({ name: "Enemy", might: 9 });
    const state = withGear(IRON_BALLISTA, (s) => {
      s.battlefields[0]!.units = { p2: [enemy] };
    });

    const after = activate(state, (as) => as.find((a) => a.type === "ActivateAbility" && a.targetUnitInstanceId === enemy.instanceId)!);

    expect(after.battlefields[0]!.units["p2"]![0]!.damage).toBe(2);
  });

  it("cannot reach a unit in base — 'at a battlefield' is printed", () => {
    const atHome = makeUnit({ name: "Home" });
    const state = withGear(IRON_BALLISTA, (s) => {
      s.players[1]!.baseUnits = [atHome];
    });

    expect(abilityActions(state)).toHaveLength(0);
  });
});

describe("Arena Bar (OGN-124): buff an EXHAUSTED friendly unit", () => {
  function barState(exhausted: boolean): { state: GameState; unit: ReturnType<typeof makeUnit> } {
    const unit = makeUnit({ name: "Mine" });
    unit.exhausted = exhausted;
    const state = withGear(ARENA_BAR, (s) => {
      s.battlefields[0]!.units = { p1: [unit] };
    });
    return { state, unit };
  }

  it("buffs an exhausted friendly unit", () => {
    const { state } = barState(true);
    const after = activate(state);
    expect(after.battlefields[0]!.units["p1"]![0]!.buffed).toBe(true);
  });

  it("never OFFERS a ready unit", () => {
    const { state } = barState(false);
    expect(abilityActions(state)).toHaveLength(0);
  });

  it("REFUSES a forged ready target — enumerator and validator agree", () => {
    const { state: readyState, unit: readyUnit } = barState(false);
    const { state: exhaustedState } = barState(true);
    const template = abilityActions(exhaustedState)[0]!;
    const forged = { ...template, targetUnitInstanceId: readyUnit.instanceId };

    expect(validateActivateAbility(readyState, forged as never).ok).toBe(false);
  });

  it("does not offer an ENEMY's exhausted unit", () => {
    const theirs = makeUnit({ name: "Theirs" });
    theirs.exhausted = true;
    const state = withGear(ARENA_BAR, (s) => {
      s.battlefields[0]!.units = { p2: [theirs] };
    });
    expect(abilityActions(state)).toHaveLength(0);
  });
});

describe("The Syren (OGN-184): 1 Energy, exhaust — send a friendly unit home", () => {
  it("recalls the unit and pays the Energy", () => {
    const mine = makeUnit({ name: "Mine" });
    const state = withGear(THE_SYREN, (s) => {
      s.battlefields[0]!.units = { p1: [mine] };
      s.players[0]!.channeled = [{ id: "r1", domain: "Chaos", state: "Ready" }];
    });

    const after = activate(state);

    expect(after.battlefields[0]!.units["p1"]).toHaveLength(0);
    expect(after.players[0]!.baseUnits.map((u) => u.name)).toEqual(["Mine"]);
    expect(after.players[0]!.channeled[0]!.state).toBe("Exhausted");
  });

  it("is not offered without the Energy", () => {
    const mine = makeUnit({ name: "Mine" });
    const state = withGear(THE_SYREN, (s) => {
      s.battlefields[0]!.units = { p1: [mine] };
    });
    expect(abilityActions(state)).toHaveLength(0);
  });
});

describe("Garbage Grabber (OGN-099): recycle 3, 1 Energy, exhaust — draw 1", () => {
  function grabberState(trashSize: number): GameState {
    return withGear(GARBAGE_GRABBER, (s) => {
      s.players[0]!.trash = Array.from({ length: trashSize }, (_, i) => makeUnit({ name: `t${i}` }));
      s.players[0]!.deck = [makeUnit({ name: "Drawn" })];
      s.players[0]!.channeled = [{ id: "r1", domain: "Mind", state: "Ready" }];
    });
  }

  it("pays all three costs and draws", () => {
    const after = activate(grabberState(4));

    expect(after.players[0]!.trash.map((c) => c.name)).toEqual(["t3"]);
    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["Drawn"]);
    expect(after.players[0]!.channeled[0]!.state).toBe("Exhausted");
    expect(after.players[0]!.activeGear[0]!.exhausted).toBe(true);
  });

  it("is not offered on a trash of 2 — 416.3 makes the Recycle all-or-nothing", () => {
    expect(abilityActions(grabberState(2))).toHaveLength(0);
  });
});

describe("Treasure Trove (OGN-186): pay Chaos and kill it to cash it in", () => {
  function troveState(power: boolean): GameState {
    return withGear(TREASURE_TROVE, (s) => {
      s.players[0]!.deck = [makeUnit({ name: "Drawn" })];
      s.players[0]!.runeDeck = [{ id: "rd1", domain: "Chaos", state: "Ready" }];
      if (power) s.players[0]!.channeled = [{ id: "r1", domain: "Chaos", state: "Ready" }];
    });
  }

  it("kills itself and pays out its leave-the-board trigger", () => {
    const after = activate(troveState(true));

    expect(after.players[0]!.activeGear).toHaveLength(0);
    expect(after.players[0]!.trash.some((c) => c.defId === TREASURE_TROVE)).toBe(true);
    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["Drawn"]);
    expect(after.players[0]!.channeled.some((r) => r.id === "rd1" && r.state === "Exhausted")).toBe(true);
  });

  it("pays the draw ONCE — the payout is on the trigger, not on the ability", () => {
    const after = activate(troveState(true));
    expect(after.players[0]!.hand).toHaveLength(1);
  });

  it("is not offered without the Chaos Power", () => {
    expect(abilityActions(troveState(false))).toHaveLength(0);
  });
});

/**
 * Spirit's Refuge (OGN-063): "When you play this, buff a friendly unit."
 *
 * The only Gear here whose text fires on PLAY rather than on activation, so it is
 * driven through `legalActions` -> `executePlayCard` — the dispatch hop where a
 * self-trigger can silently do nothing.
 *
 * Its second sentence ("Friendly buffed units have [Deflect]") is deliberately
 * unimplemented, so unlike the batch above this card must NOT report as finished.
 * That is asserted below, because a half-written card reading as whole is the
 * failure coverage.ts exists to prevent.
 */
describe("Spirit's Refuge (OGN-063): buff a friendly unit when it is played", () => {
  const SPIRITS_REFUGE = "OGN-063"; // 2 Energy + 1 Calm Power

  /** Spirit's Refuge in hand, Calm runes to pay with, and `units` friendly
   *  bodies on the board to choose between. */
  function refugeState(unitNames: string[]): GameState {
    const state = makeState({ phase: "Action" });
    const card = createCardInstance(registry.get(SPIRITS_REFUGE)) as GearInstance;
    state.players[0]!.hand = [card];
    state.players[0]!.channeled = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      domain: "Calm" as const,
      state: "Ready" as const,
    }));
    state.players[0]!.baseUnits = unitNames.map((name) => makeUnit({ name, instanceId: name }));
    return state;
  }

  const playRefuge = (state: GameState) => {
    const action = legalActions(state).find((a) => a.type === "PlayCard" && a.card.defId === SPIRITS_REFUGE);
    expect(action, "Spirit's Refuge was never enumerated as playable").toBeDefined();
    // Settled: Spirit's Refuge's "when you play this" is held, so the question it
    // parks arrives a chain-pop after the play.
    return resolveHeldTriggers(executePlayCard(state, action as never));
  };

  it("asks which friendly unit to buff, and buffs the one chosen", () => {
    const after = playRefuge(refugeState(["Alpha", "Beta"]));
    const decision = pendingDecision(after);

    expect(decision?.kind).toBe("OGN-063-buff");
    expect(optionsFor(after, decision!).map((o) => o.id)).toEqual(["Alpha", "Beta"]);

    const answered = answerDecisions(after, (options) => options.find((o) => o.id === "Beta")!.id);
    // The chosen one, and ONLY the chosen one.
    expect(answered.players[0]!.baseUnits.filter((u) => u.buffed).map((u) => u.name)).toEqual(["Beta"]);
  });

  it("reaches the board at all — the gear is in play, not just the buff", () => {
    const after = answerDecisions(playRefuge(refugeState(["Alpha"])));
    expect(after.players[0]!.activeGear.map((g) => g.defId)).toEqual([SPIRITS_REFUGE]);
  });

  it("plays fine with no friendly unit, and parks no unanswerable question", () => {
    // Rule 055's "do as much as you can": nothing to buff is not a reason the
    // Gear cannot be played, and a decision with no options must never be parked.
    const after = playRefuge(refugeState([]));
    expect(after.pendingDecisions).toHaveLength(0);
    expect(after.players[0]!.activeGear).toHaveLength(1);
  });

  it("is WHOLE — it was the last card on the partial list, and the list is now empty", () => {
    // This assertion has been inverted twice and the history is the point. It
    // first held because `[Deflect]` had no implementation at all, so granting it
    // would have been a no-op. Then it held for a different reason — the
    // surcharge was real but the GRANT was not, carried by a hand-written
    // `coverage.PARTIALLY_IMPLEMENTED` entry.
    //
    // Both gaps are closed: `granted-keywords.KEYWORD_AURAS` gives a GEAR-source
    // aura with a per-target condition somewhere to live, and the entry was
    // DELETED rather than reworded. See keyword-auras.test.ts, which asserts the
    // grant actually reaches `deflectSurcharge` — flipping this to `true` on its
    // own would only mean the map had been emptied.
    expect(isCardImplemented(registry.get(SPIRITS_REFUGE))).toBe(true);
  });
});

describe("coverage", () => {
  it("reports all twelve gear as implemented", () => {
    expect(BATCH.filter((id) => !isCardImplemented(registry.get(id)))).toEqual([]);
  });
});
