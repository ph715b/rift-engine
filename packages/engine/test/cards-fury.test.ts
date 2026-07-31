import { describe, expect, it } from "vitest";
import { effectForCard } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { dispatchOnPlayUnit } from "../src/engine/unit-triggers.js";
import { eligibleTargets } from "../src/engine/target-lookup.js";
import { answerDecisions, makeState, makeUnit, pickCard, realUnitInstance, spellInstance } from "./fixtures.js";

/** Fury cards implemented in src/engine/effects/fury.ts. Everything here goes
 *  through the COMPOSED registries (effectForCard / dispatchOnPlayUnit) rather
 *  than calling a resolver directly, so a card that is registered but not
 *  reachable — the failure effect-registry.test.ts was written for — still
 *  fails here. */
function resolveSpell(
  defId: string,
  casterIndex: 0 | 1,
  state: ReturnType<typeof makeState>,
  event: Parameters<NonNullable<ReturnType<typeof effectForCard>>["resolve"]>[2] = {},
) {
  const effect = effectForCard(spellInstance(defId));
  expect(effect, `${defId} has no registered effect`).toBeDefined();
  return effect!.resolve(state, contextFor(casterIndex), event);
}

describe("Void Seeker (OGN-024): deal 4 to a unit at a battlefield, draw 1", () => {
  it("damages the chosen unit and draws, leaving a survivor on the board", () => {
    const target = makeUnit({ might: 6 });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [target] };
    state.players[0]!.deck = [makeUnit()];

    state = resolveSpell("OGN-024", 0, state, { targetUnitInstanceId: target.instanceId });

    expect(state.battlefields[0]!.units["p2"]![0]!.damage).toBe(4);
    expect(state.players[0]!.hand).toHaveLength(1);
    expect(state.players[0]!.deck).toHaveLength(0);
  });

  it("kills a 4-Might unit and still draws", () => {
    const target = makeUnit({ might: 4 });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [target] };
    state.players[0]!.deck = [makeUnit()];

    state = resolveSpell("OGN-024", 0, state, { targetUnitInstanceId: target.instanceId });

    expect(state.battlefields[0]!.units["p2"]).toHaveLength(0);
    expect(state.players[1]!.trash.map((c) => c.instanceId)).toEqual([target.instanceId]);
    expect(state.players[0]!.hand).toHaveLength(1);
  });

  it("still draws when the target is no longer in play", () => {
    // "Instructions that can be partially followed are followed as much as
    // possible" (rule 359.3.e) — the damage is impossible, the draw is not.
    let state = makeState();
    state.players[0]!.deck = [makeUnit()];

    state = resolveSpell("OGN-024", 0, state, { targetUnitInstanceId: "gone-before-resolution" });

    expect(state.players[0]!.hand).toHaveLength(1);
  });

  it("deals its damage even with an empty deck, and draws nothing", () => {
    const target = makeUnit({ might: 6 });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [target] };

    state = resolveSpell("OGN-024", 0, state, { targetUnitInstanceId: target.instanceId });

    expect(state.battlefields[0]!.units["p2"]![0]!.damage).toBe(4);
    expect(state.players[0]!.hand).toHaveLength(0); // Burn Out isn't modelled; the draw is simply skipped
  });

  it('targets "a unit at a battlefield" only — a base unit is not offered', () => {
    // The load-bearing half of this card's targeting. Final Spark ("deal 8 to a
    // unit") reaches base; this one names a battlefield and must not.
    const atBattlefield = makeUnit({ might: 6 });
    const inEnemyBase = makeUnit({ might: 6 });
    const inOwnBase = makeUnit({ might: 6 });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [atBattlefield] };
    state.players[1]!.baseUnits = [inEnemyBase];
    state.players[0]!.baseUnits = [inOwnBase];

    const targeting = effectForCard(spellInstance("OGN-024"))!.targeting;
    expect(targeting.kind).toBe("unit");
    const scope = targeting.kind === "unit" ? targeting.scope : undefined;
    const owner = targeting.kind === "unit" ? targeting.owner : undefined;

    expect(eligibleTargets(state, 0, owner, scope).map((u) => u.instanceId)).toEqual([atBattlefield.instanceId]);
  });
});

describe("Chemtech Enforcer (OGN-003): when you play me, discard 1", () => {
  it("discards from the CASTER's hand into the caster's trash, not the opponent's", () => {
    const enforcer = realUnitInstance("OGN-003");
    const mine = [makeUnit(), makeUnit()];
    const theirs = [makeUnit()];
    const state = makeState();
    state.players[0]!.hand = [...mine];
    state.players[1]!.hand = [...theirs];

    const after = answerDecisions(dispatchOnPlayUnit(state, enforcer, 0, "base"));

    expect(after.players[0]!.hand).toHaveLength(1);
    expect(after.players[0]!.trash.map((c) => c.instanceId)).toEqual([mine[0]!.instanceId]);
    expect(after.players[1]!.hand).toHaveLength(1);
    expect(after.players[1]!.trash).toHaveLength(0);
  });

  it("lets the CASTER pick which card goes", () => {
    // This test used to assert the front of hand and cite it as the documented
    // convention. The convention is gone: the discard asks, and either card is a
    // legal answer — which is the whole difference.
    const enforcer = realUnitInstance("OGN-003");
    const first = makeUnit({ name: "First" });
    const second = makeUnit({ name: "Second" });
    const state = makeState();
    state.players[0]!.hand = [first, second];

    const asked = dispatchOnPlayUnit(state, enforcer, 0, "base");
    expect(asked.pendingDecisions[0]!.playerIndex).toBe(0);

    const keptFirst = answerDecisions(asked, pickCard(second.instanceId));
    expect(keptFirst.players[0]!.hand.map((c) => c.name)).toEqual(["First"]);
    expect(keptFirst.players[0]!.trash.map((c) => c.name)).toEqual(["Second"]);

    const keptSecond = answerDecisions(asked, pickCard(first.instanceId));
    expect(keptSecond.players[0]!.hand.map((c) => c.name)).toEqual(["Second"]);
  });

  it("does nothing with an empty hand instead of failing", () => {
    // Rule 422: discard as many cards as possible, ignore the rest.
    const enforcer = realUnitInstance("OGN-003");
    const state = makeState();

    const after = dispatchOnPlayUnit(state, enforcer, 0, "base");

    expect(after.players[0]!.hand).toHaveLength(0);
    expect(after.players[0]!.trash).toHaveLength(0);
  });

  it("fires for the second player too, discarding from THEIR hand", () => {
    const enforcer = realUnitInstance("OGN-003");
    const state = makeState();
    state.players[0]!.hand = [makeUnit()];
    state.players[1]!.hand = [makeUnit(), makeUnit()];

    const asked = dispatchOnPlayUnit(state, enforcer, 1, "base");
    // The question is asked of player 1, not of whoever's turn it is.
    expect(asked.pendingDecisions[0]!.playerIndex).toBe(1);
    const after = answerDecisions(asked);

    expect(after.players[1]!.hand).toHaveLength(1);
    expect(after.players[1]!.trash).toHaveLength(1);
    expect(after.players[0]!.hand).toHaveLength(1); // untouched
  });
});
