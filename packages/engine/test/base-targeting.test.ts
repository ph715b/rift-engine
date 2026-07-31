import { describe, expect, it } from "vitest";
import { effectForCard } from "../src/engine/card-effects.js";
import { targetingForUnitTrigger, dispatchOnPlayUnit } from "../src/engine/unit-triggers.js";
import { contextFor } from "../src/engine/effect-context.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { dealDamage, destroyUnit, readyUnit, giveMightThisTurn, returnUnitToHand } from "../src/engine/effect-helpers.js";
import { hasAnyLegalEffectChoice, unitWithinMaxMight, findUnitAnywhere } from "../src/engine/target-lookup.js";
import { targetingForCard } from "../src/engine/card-effects.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * Riftbound distinguishes "a unit" from "a unit at a battlefield", and the
 * engine never modeled it: base units were untargetable by everything. Eight
 * precon cards were wrong. Base is no longer a safe parking spot — per the
 * project owner's rules call, "a unit" means any unit in play, INCLUDING the
 * opponent's base.
 *
 * The scope isolation tests at the bottom are the important half: widening
 * this must not leak into the 15 cards whose text does name a battlefield.
 */
function funded(state: ReturnType<typeof makeState>, card: { energyCost: number; powerCost: number; powerDomain?: string | null }) {
  state.players[0]!.channeled = Array.from({ length: card.energyCost + card.powerCost }, (_, i) => ({
    id: `r${i}`,
    domain: (card.powerDomain ?? "Order") as "Order",
    state: "Ready" as const,
  }));
  return state.players[0]!.channeled.map((r) => r.id);
}

function playAction(state: ReturnType<typeof makeState>, card: any, extra: Partial<PlayCardAction> = {}): PlayCardAction {
  const ids = state.players[0]!.channeled.map((r) => r.id);
  return {
    type: "PlayCard",
    playerIndex: 0,
    card,
    payment: { energyRunes: ids.slice(0, card.energyCost), powerRunes: ids.slice(card.energyCost) },
    ...extra,
  };
}

describe("effect helpers reach units in base", () => {
  it("dealDamage kills a unit in the ENEMY base and trashes it there", () => {
    const victim = makeUnit({ might: 2 });
    const state = makeState();
    state.players[1]!.baseUnits = [victim];

    const result = dealDamage(state, 0, victim.instanceId, 8);

    expect(result.players[1]!.baseUnits).toHaveLength(0);
    expect(result.players[1]!.trash.map((c) => c.instanceId)).toContain(victim.instanceId);
  });

  it("dealDamage marks a surviving base unit rather than losing it", () => {
    const victim = makeUnit({ might: 9 });
    const state = makeState();
    state.players[1]!.baseUnits = [victim];

    const result = dealDamage(state, 0, victim.instanceId, 3);

    expect(result.players[1]!.baseUnits).toHaveLength(1);
    expect(result.players[1]!.baseUnits[0]!.damage).toBe(3);
  });

  it("a warded base unit is recalled, not trashed", () => {
    const victim = makeUnit({ might: 2 });
    const state = makeState();
    state.players[1]!.baseUnits = [victim];
    state.deathWardedUnitInstanceIds = [victim.instanceId];

    const result = dealDamage(state, 0, victim.instanceId, 8);

    expect(result.players[1]!.trash).toHaveLength(0);
    expect(result.players[1]!.baseUnits).toHaveLength(1);
  });

  it("destroyUnit, readyUnit, giveMightThisTurn and returnUnitToHand all work in base", () => {
    const unit = makeUnit({ might: 3, exhausted: true });
    const state = makeState();
    state.players[0]!.baseUnits = [unit];

    expect(readyUnit(state, unit.instanceId).players[0]!.baseUnits[0]!.exhausted).toBe(false);
    expect(giveMightThisTurn(state, unit.instanceId, 2).players[0]!.baseUnits[0]!.mightThisTurn).toBe(2);
    expect(destroyUnit(state, unit.instanceId).players[0]!.trash.map((c) => c.instanceId)).toContain(unit.instanceId);
    expect(returnUnitToHand(state, unit.instanceId).players[0]!.hand.map((c) => c.instanceId)).toContain(unit.instanceId);
  });

  it("findUnitAnywhere reports the zone it found the unit in", () => {
    const inBase = makeUnit();
    const atBf = makeUnit();
    const state = makeState();
    state.players[0]!.baseUnits = [inBase];
    state.battlefields[0]!.units = { p1: [atBf] };

    expect(findUnitAnywhere(state, inBase.instanceId)!.zone).toBe("base");
    expect(findUnitAnywhere(state, atBf.instanceId)!.zone).toEqual({ battlefieldIndex: 0 });
  });
});

describe("Final Spark can snipe a unit at home", () => {
  it("offers, validates and resolves against an ENEMY base unit", () => {
    const finalSpark = spellInstance("OGS-022");
    const victim = makeUnit({ might: 4 });
    const state = makeState();
    state.players[0]!.hand = [finalSpark];
    funded(state, finalSpark);
    state.players[1]!.baseUnits = [victim];

    const offered = legalActions(state).filter(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === finalSpark.instanceId,
    );
    expect(offered.map((a) => a.targetUnitInstanceId)).toContain(victim.instanceId);

    const action = playAction(state, finalSpark, { targetUnitInstanceId: victim.instanceId });
    expect(validatePlayCard(state, action).ok).toBe(true);

    const resolved = effectForCard(finalSpark)!.resolve(state, contextFor(0), { targetUnitInstanceId: victim.instanceId });
    expect(resolved.players[1]!.baseUnits).toHaveLength(0);
  });
});

describe("En Garde treats base as a location for 'the only unit you control there'", () => {
  it("a LONE unit in your base gets the full +2", () => {
    const lone = makeUnit({ might: 2 });
    const state = makeState();
    state.players[0]!.baseUnits = [lone];

    const result = effectForCard(spellInstance("OGN-046"))!.resolve(state, contextFor(0), { targetUnitInstanceId: lone.instanceId });

    expect(result.players[0]!.baseUnits[0]!.mightThisTurn).toBe(2);
  });

  it("...but only +1 with a second unit at home", () => {
    const target = makeUnit({ might: 2 });
    const state = makeState();
    state.players[0]!.baseUnits = [target, makeUnit()];

    const result = effectForCard(spellInstance("OGN-046"))!.resolve(state, contextFor(0), { targetUnitInstanceId: target.instanceId });

    expect(result.players[0]!.baseUnits[0]!.mightThisTurn).toBe(1);
  });
});

describe("the other widened cards", () => {
  it("First Mate can ready a unit sitting in your base", () => {
    const exhausted = makeUnit({ exhausted: true });
    const state = makeState();
    state.players[0]!.baseUnits = [exhausted];

    const result = dispatchOnPlayUnit(state, realUnitInstance("OGN-132"), 0, "base", {
      targetUnitInstanceId: exhausted.instanceId,
    });

    expect(result.players[0]!.baseUnits[0]!.exhausted).toBe(false);
    expect(targetingForUnitTrigger("OGN-132")).toMatchObject({ scope: "anywhere" });
  });

  it("Stupefy debuffs a base unit", () => {
    const target = makeUnit({ might: 3 });
    const state = makeState();
    state.players[0]!.deck = [makeUnit()];
    state.players[1]!.baseUnits = [target];

    const result = effectForCard(spellInstance("OGN-095"))!.resolve(state, contextFor(0), { targetUnitInstanceId: target.instanceId });
    expect(result.players[1]!.baseUnits[0]!.mightThisTurn).toBe(-1);
  });

  it("Singularity can be pointed at two enemy BASE units", () => {
    const a = makeUnit({ might: 2 });
    const b = makeUnit({ might: 2 });
    const state = makeState();
    state.players[1]!.baseUnits = [a, b];

    const result = effectForCard(spellInstance("OGN-105"))!.resolve(state, contextFor(0), {
      targetUnitInstanceId: a.instanceId,
      secondTargetUnitInstanceId: b.instanceId,
    });
    expect(result.players[1]!.baseUnits).toHaveLength(0); // both died
  });

  it("Back to Back buffs chosen friendly units at home", () => {
    const a = makeUnit();
    const b = makeUnit();
    const state = makeState();
    state.players[0]!.baseUnits = [a, b];

    const result = effectForCard(spellInstance("OGN-206"))!.resolve(state, contextFor(0), {
      targetUnitInstanceId: a.instanceId,
      secondTargetUnitInstanceId: b.instanceId,
    });
    expect(result.players[0]!.baseUnits.map((u) => u.mightThisTurn)).toEqual([2, 2]);
  });

  it("Highlander can ward a unit at home", () => {
    const ally = makeUnit();
    const state = makeState();
    state.players[0]!.baseUnits = [ally];

    const result = effectForCard(spellInstance("OGS-020"))!.resolve(state, contextFor(0), { targetUnitInstanceId: ally.instanceId });
    expect(result.deathWardedUnitInstanceIds).toContain(ally.instanceId);
  });

  it("Gentlemen's Duel can pair two units standing at home", () => {
    const friendly = makeUnit({ might: 2 });
    const enemy = makeUnit({ might: 1 });
    const state = makeState();
    state.players[0]!.baseUnits = [friendly];
    state.players[1]!.baseUnits = [enemy];

    const result = effectForCard(spellInstance("OGS-008"))!.resolve(state, contextFor(0), {
      targetUnitInstanceId: friendly.instanceId,
      secondTargetUnitInstanceId: enemy.instanceId,
    });

    // friendly 2+3=5 kills the 1-Might enemy; enemy deals 1 back.
    expect(result.players[1]!.baseUnits).toHaveLength(0);
    expect(result.players[0]!.baseUnits[0]!.damage).toBe(1);
  });
});

describe("SCOPE ISOLATION: battlefield-only cards must not have widened", () => {
  it("Incinerate cannot target a base unit — not offered, not validated", () => {
    const incinerate = spellInstance("OGS-003");
    const victim = makeUnit({ might: 2 });
    const state = makeState();
    state.players[0]!.hand = [incinerate];
    funded(state, incinerate);
    state.players[1]!.baseUnits = [victim];

    const offered = legalActions(state).filter(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === incinerate.instanceId,
    );
    expect(offered).toHaveLength(0); // no legal target anywhere it can reach

    const action = playAction(state, incinerate, { targetUnitInstanceId: victim.instanceId });
    expect(validatePlayCard(state, action).ok).toBe(false);
  });

  it("Gust cannot pull a unit out of base", () => {
    const gust = spellInstance("OGN-169");
    const victim = makeUnit({ might: 2 });
    const state = makeState();
    state.players[1]!.baseUnits = [victim];

    expect(hasAnyLegalEffectChoice(state, 0, targetingForCard(gust))).toBe(false);
  });

  it("battlefield-scoped specs still see battlefield units", () => {
    const victim = makeUnit({ might: 2 });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [victim] };

    expect(hasAnyLegalEffectChoice(state, 0, targetingForCard(spellInstance("OGS-003")))).toBe(true);
  });

  it("maxMight is enforced for a BASE target too (it used to be skipped)", () => {
    // unitWithinMaxMight returned true for anything it couldn't find at a
    // battlefield, so a base unit would have bypassed the restriction.
    const big = makeUnit({ might: 7 });
    const small = makeUnit({ might: 2 });
    const state = makeState();
    state.players[1]!.baseUnits = [big, small];

    expect(unitWithinMaxMight(state, big, 3)).toBe(false);
    expect(unitWithinMaxMight(state, small, 3)).toBe(true);
  });
});
