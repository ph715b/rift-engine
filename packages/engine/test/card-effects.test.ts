import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type SpellInstance } from "../src/model/card.js";
import { effectForCard, targetingForCard } from "../src/engine/card-effects.js";
import { buffAllFriendlies, dealDamage, destroyUnit } from "../src/engine/effect-helpers.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { executePassFocus } from "../src/actions/execute-pass-focus.js";
import { legalActions } from "../src/engine/legal-actions.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { makeState, makeUnit, spellInstance } from "./fixtures.js";

describe("card-effects registry", () => {
  it("has an effect registered, with the right targeting shape, for the 5 launch cards", () => {
    expect(targetingForCard(spellInstance("OGS-003"))).toEqual({ kind: "unit" }); // Incinerate
    expect(targetingForCard(spellInstance("OGN-085"))).toEqual({ kind: "unit" }); // Falling Comet
    // Final Spark reads "Deal 8 to a unit" — no battlefield named, so unlike
    // its neighbours here it reaches units in base too.
    expect(targetingForCard(spellInstance("OGS-022"))).toEqual({ kind: "unit", scope: "anywhere" });
    expect(targetingForCard(spellInstance("OGS-012"))).toEqual({ kind: "unit" }); // Blast of Power
    expect(targetingForCard(spellInstance("OGS-024"))).toEqual({ kind: "none" }); // Decisive Strike
  });

  it("returns undefined for an unregistered card", () => {
    // Cannon Barrage — deliberately unregistered (see card-effects.ts's own
    // doc comment: its effect only has real targets during an open
    // Showdown, which can't be cast into yet).
    expect(effectForCard(spellInstance("OGN-127"))).toBeUndefined();
  });

  it("targetingForCard defaults to 'none' for an unregistered card", () => {
    expect(targetingForCard(spellInstance("OGN-127"))).toEqual({ kind: "none" });
  });
});

describe("dealDamage", () => {
  it("below-lethal damage adds to .damage; the unit survives at its battlefield", () => {
    const target = makeUnit({ might: 5 });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [target] };

    state = dealDamage(state, 0, target.instanceId, 3);

    expect(state.battlefields[0]!.units["p2"]).toHaveLength(1);
    expect(state.battlefields[0]!.units["p2"]![0]!.damage).toBe(3);
    expect(state.players[1]!.trash).toHaveLength(0);
  });

  it("at/above-lethal damage moves the unit to its owner's trash (not the caster's)", () => {
    const target = makeUnit({ might: 3 });
    let state = makeState({ activePlayerIndex: 0 }); // p1 is the caster
    state.battlefields[0]!.units = { p2: [target] }; // p2 owns the target

    state = dealDamage(state, 0, target.instanceId, 3);

    expect(state.battlefields[0]!.units["p2"]).toHaveLength(0);
    expect(state.players[1]!.trash).toHaveLength(1); // owner's (p2's) trash
    expect(state.players[1]!.trash[0]!.instanceId).toBe(target.instanceId);
    expect(state.players[0]!.trash).toHaveLength(0); // never the caster's
  });

  it("[Shield] does not reduce direct damage — a Shielded unit still dies to lethal damage", () => {
    const target = makeUnit({ might: 3, keywords: { Shield: 5 } });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [target] };

    state = dealDamage(state, 0, target.instanceId, 3);

    expect(state.battlefields[0]!.units["p2"]).toHaveLength(0);
    expect(state.players[1]!.trash).toHaveLength(1);
  });

  it("no-ops if the target isn't found on any battlefield", () => {
    const state = makeState();
    expect(dealDamage(state, 0, "nonexistent", 5)).toBe(state);
  });
});

describe("destroyUnit", () => {
  it("unconditionally trashes the unit regardless of remaining Might/Shield, no damage applied first", () => {
    const target = makeUnit({ might: 20, keywords: { Shield: 10 } });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [target] };

    state = destroyUnit(state, target.instanceId);

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
