import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type SpellInstance, type UnitInstance } from "../src/model/card.js";
import type { BattlefieldState, GameState, PlayerState } from "../src/model/game-state.js";
import { effectForCard, requiresTarget } from "../src/engine/card-effects.js";
import {
  applyDirectDamageAndCheckLethal,
  buffAllFriendlies,
  destroyUnitDirectly,
} from "../src/engine/card-effect-resolution.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { executePassFocus } from "../src/actions/execute-pass-focus.js";
import { legalActions } from "../src/engine/legal-actions.js";
import type { PlayCardAction } from "../src/actions/player-action.js";

function spellInstance(defId: string): SpellInstance {
  return createCardInstance(defaultCardRegistry().get(defId)) as SpellInstance;
}

let unitCounter = 0;
function makeUnit(overrides: Partial<UnitInstance> = {}): UnitInstance {
  unitCounter += 1;
  return {
    instanceId: `unit-${unitCounter}`,
    defId: "TEST-000",
    name: overrides.name ?? `Test Unit ${unitCounter}`,
    domains: [],
    exhausted: false,
    isToken: false,
    kind: "Unit",
    energyCost: 0,
    powerCost: 0,
    powerDomain: null,
    might: 3,
    isChampion: false,
    keywords: {},
    isReaction: false,
    tags: [],
    damage: 0,
    bonus: 0,
    ...overrides,
  };
}

function makePlayer(id: string, overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    id,
    name: id,
    legend: {
      instanceId: `${id}-legend`,
      defId: "TEST-LEGEND",
      name: "Test Legend",
      domains: [],
      exhausted: false,
      isToken: false,
      kind: "Legend",
      championTag: "TEST",
    },
    championZone: null,
    deck: [],
    hand: [],
    trash: [],
    banished: [],
    activeGear: [],
    runeDeck: [],
    channeled: [],
    baseUnits: [],
    points: 0,
    floatingEnergy: 0,
    floatingPower: {},
    cardsPlayedThisTurn: 0,
    conqueredBattlefieldsThisTurn: [],
    ...overrides,
  };
}

function makeState(overrides: Partial<GameState> = {}): GameState {
  const p1 = makePlayer("p1");
  const p2 = makePlayer("p2");
  const battlefields: BattlefieldState[] = [
    { id: "bf1", name: "Battlefield 1", controllerId: null, units: {} },
    { id: "bf2", name: "Battlefield 2", controllerId: null, units: {} },
  ];
  return {
    players: [p1, p2],
    battlefields,
    activePlayerIndex: 0,
    turnNumber: 1,
    phase: "Action",
    turnState: "Neutral",
    focusHolder: 0,
    showdownBattlefieldId: null,
    consecutiveFocusPasses: 0,
    chainOpen: true,
    chainPriority: 0,
    chainPasses: 0,
    spellChain: [],
    ...overrides,
  };
}

describe("card-effects registry", () => {
  it("resolves the 5 registered cards to the right effect shape", () => {
    expect(effectForCard(spellInstance("OGS-003"))).toEqual({ kind: "DealDamage", amount: 2 }); // Incinerate
    expect(effectForCard(spellInstance("OGN-085"))).toEqual({ kind: "DealDamage", amount: 6 }); // Falling Comet
    expect(effectForCard(spellInstance("OGS-022"))).toEqual({ kind: "DealDamage", amount: 8 }); // Final Spark
    expect(effectForCard(spellInstance("OGS-012"))).toEqual({ kind: "DestroyUnit" }); // Blast of Power
    expect(effectForCard(spellInstance("OGS-024"))).toEqual({ kind: "BuffAllFriendlies", amount: 2 }); // Decisive Strike
  });

  it("returns undefined for an unregistered card", () => {
    expect(effectForCard(spellInstance("OGN-134"))).toBeUndefined(); // Mobilize — no registered effect
  });

  it("requiresTarget is true only for DealDamage/DestroyUnit", () => {
    expect(requiresTarget({ kind: "DealDamage", amount: 2 })).toBe(true);
    expect(requiresTarget({ kind: "DestroyUnit" })).toBe(true);
    expect(requiresTarget({ kind: "BuffAllFriendlies", amount: 2 })).toBe(false);
    expect(requiresTarget(undefined)).toBe(false);
  });
});

describe("applyDirectDamageAndCheckLethal", () => {
  it("below-lethal damage adds to .damage; the unit survives at its battlefield", () => {
    const target = makeUnit({ might: 5 });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [target] };

    state = applyDirectDamageAndCheckLethal(state, target.instanceId, 3);

    expect(state.battlefields[0]!.units["p2"]).toHaveLength(1);
    expect(state.battlefields[0]!.units["p2"]![0]!.damage).toBe(3);
    expect(state.players[1]!.trash).toHaveLength(0);
  });

  it("at/above-lethal damage moves the unit to its owner's trash (not the caster's)", () => {
    const target = makeUnit({ might: 3 });
    let state = makeState({ activePlayerIndex: 0 }); // p1 is the caster
    state.battlefields[0]!.units = { p2: [target] }; // p2 owns the target

    state = applyDirectDamageAndCheckLethal(state, target.instanceId, 3);

    expect(state.battlefields[0]!.units["p2"]).toHaveLength(0);
    expect(state.players[1]!.trash).toHaveLength(1); // owner's (p2's) trash
    expect(state.players[1]!.trash[0]!.instanceId).toBe(target.instanceId);
    expect(state.players[0]!.trash).toHaveLength(0); // never the caster's
  });

  it("[Shield] does not reduce direct damage — a Shielded unit still dies to lethal damage", () => {
    const target = makeUnit({ might: 3, keywords: { Shield: 5 } });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [target] };

    state = applyDirectDamageAndCheckLethal(state, target.instanceId, 3);

    expect(state.battlefields[0]!.units["p2"]).toHaveLength(0);
    expect(state.players[1]!.trash).toHaveLength(1);
  });

  it("no-ops if the target isn't found on any battlefield", () => {
    const state = makeState();
    expect(applyDirectDamageAndCheckLethal(state, "nonexistent", 5)).toBe(state);
  });
});

describe("destroyUnitDirectly", () => {
  it("unconditionally trashes the unit regardless of remaining Might/Shield, no damage applied first", () => {
    const target = makeUnit({ might: 20, keywords: { Shield: 10 } });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [target] };

    state = destroyUnitDirectly(state, target.instanceId);

    expect(state.battlefields[0]!.units["p2"]).toHaveLength(0);
    expect(state.players[1]!.trash).toHaveLength(1);
    const trashed = state.players[1]!.trash[0]!;
    expect(trashed.kind === "Unit" && trashed.damage).toBe(0); // never damaged, just removed
  });
});

describe("buffAllFriendlies", () => {
  it("buffs every base and battlefield unit the caster controls, not the opponent's", () => {
    const casterBaseUnit = makeUnit({ might: 3 });
    const casterBfUnit = makeUnit({ might: 4 });
    const opponentUnit = makeUnit({ might: 5 });
    let state = makeState();
    state.players[0]!.baseUnits = [casterBaseUnit];
    state.battlefields[0]!.units = { p1: [casterBfUnit], p2: [opponentUnit] };

    state = buffAllFriendlies(state, 0, 2);

    expect(state.players[0]!.baseUnits[0]!.bonus).toBe(2);
    expect(state.battlefields[0]!.units["p1"]![0]!.bonus).toBe(2);
    expect(state.battlefields[0]!.units["p2"]![0]!.bonus).toBe(0); // opponent's untouched
  });

  it("the buff expires at the caster's next End of Turn (runEnd already resets .bonus)", () => {
    const unit = makeUnit({ might: 3 });
    let state = makeState();
    state.players[0]!.baseUnits = [unit];

    state = buffAllFriendlies(state, 0, 2);
    expect(state.players[0]!.baseUnits[0]!.bonus).toBe(2);

    state = runEnd(state);
    expect(state.players[0]!.baseUnits[0]!.bonus).toBe(0);
  });
});

describe("end-to-end: casting a registered Spell resolves its effect after two passes", () => {
  it("Incinerate deals 2 damage to a targeted enemy unit at a battlefield", () => {
    const registry = defaultCardRegistry();
    const incinerate = createCardInstance(registry.get("OGS-003")) as SpellInstance;
    expect(incinerate.energyCost).toBeGreaterThanOrEqual(0);

    const target = makeUnit({ might: 5 });
    let state = makeState();
    state.players[0]!.hand = [incinerate];
    state.players[0]!.channeled = Array.from({ length: incinerate.energyCost }, (_, i) => ({
      id: `rune-${i}`,
      domain: "Order" as const,
      state: "Ready" as const,
    }));
    state.battlefields[0]!.units = { p2: [target] };

    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: incinerate,
      payment: { energyRunes: state.players[0]!.channeled.map((r) => r.id), powerRunes: [] },
      targetUnitInstanceId: target.instanceId,
    };

    expect(validatePlayCard(state, action)).toEqual({ ok: true });

    state = executePlayCard(state, action);
    expect(state.chainOpen).toBe(false);
    expect(state.battlefields[0]!.units["p2"]![0]!.damage).toBe(0); // not yet resolved

    state = executePassFocus(state, { type: "PassFocus", playerIndex: 0 });
    state = executePassFocus(state, { type: "PassFocus", playerIndex: 1 });

    expect(state.chainOpen).toBe(true);
    expect(state.battlefields[0]!.units["p2"]![0]!.damage).toBe(2);
  });
});

describe("validatePlayCard: targeted-spell validation", () => {
  it("rejects a targeted Spell with no targetUnitInstanceId", () => {
    const registry = defaultCardRegistry();
    const incinerate = createCardInstance(registry.get("OGS-003")) as SpellInstance;
    let state = makeState();
    state.players[0]!.hand = [incinerate];
    state.players[0]!.channeled = Array.from({ length: incinerate.energyCost }, (_, i) => ({
      id: `rune-${i}`,
      domain: "Order" as const,
      state: "Ready" as const,
    }));

    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: incinerate,
      payment: { energyRunes: state.players[0]!.channeled.map((r) => r.id), powerRunes: [] },
    };
    expect(validatePlayCard(state, action).ok).toBe(false);
  });

  it("rejects a targeted Spell whose target isn't found on any battlefield", () => {
    const registry = defaultCardRegistry();
    const incinerate = createCardInstance(registry.get("OGS-003")) as SpellInstance;
    let state = makeState();
    state.players[0]!.hand = [incinerate];
    state.players[0]!.channeled = Array.from({ length: incinerate.energyCost }, (_, i) => ({
      id: `rune-${i}`,
      domain: "Order" as const,
      state: "Ready" as const,
    }));

    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: incinerate,
      payment: { energyRunes: state.players[0]!.channeled.map((r) => r.id), powerRunes: [] },
      targetUnitInstanceId: "nonexistent",
    };
    expect(validatePlayCard(state, action).ok).toBe(false);
  });
});

describe("legalActions: targeted-spell fan-out", () => {
  it("fans out one PlayCardAction per unit at any battlefield (both owners) for a targeted spell", () => {
    const registry = defaultCardRegistry();
    const incinerate = createCardInstance(registry.get("OGS-003")) as SpellInstance;
    const friendlyTarget = makeUnit({ might: 3 });
    const enemyTarget = makeUnit({ might: 3 });

    let state = makeState();
    state.players[0]!.hand = [incinerate];
    state.players[0]!.channeled = Array.from({ length: incinerate.energyCost }, (_, i) => ({
      id: `rune-${i}`,
      domain: "Order" as const,
      state: "Ready" as const,
    }));
    state.battlefields[0]!.units = { p1: [friendlyTarget], p2: [enemyTarget] };

    const actions = legalActions(state);
    const incinerateActions = actions.filter(
      (a) => a.type === "PlayCard" && a.card.instanceId === incinerate.instanceId,
    );
    expect(incinerateActions).toHaveLength(2); // one per unit at the battlefield, either owner
    const targetIds = incinerateActions.map((a) => (a.type === "PlayCard" ? a.targetUnitInstanceId : undefined)).sort();
    expect(targetIds).toEqual([enemyTarget.instanceId, friendlyTarget.instanceId].sort());
  });

  it("untargeted spells (Decisive Strike) and Units/Gear still produce exactly one action", () => {
    const registry = defaultCardRegistry();
    const decisiveStrike = createCardInstance(registry.get("OGS-024")) as SpellInstance;
    let state = makeState();
    state.players[0]!.hand = [decisiveStrike];
    state.players[0]!.channeled = Array.from({ length: decisiveStrike.energyCost + decisiveStrike.powerCost }, (_, i) => ({
      id: `rune-${i}`,
      domain: decisiveStrike.powerDomain ?? "Order",
      state: "Ready" as const,
    }));

    const actions = legalActions(state);
    const matching = actions.filter((a) => a.type === "PlayCard" && a.card.instanceId === decisiveStrike.instanceId);
    expect(matching).toHaveLength(1);
    expect(matching[0]!.type === "PlayCard" && matching[0]!.targetUnitInstanceId).toBeUndefined();
  });
});
