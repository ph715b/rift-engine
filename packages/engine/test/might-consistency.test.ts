import { describe, expect, it } from "vitest";
import { effectForCard } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * Found by a semantic audit of the precon cards (text vs. implementation):
 * five call sites computed a unit's Might by hand as `might + bonus` instead
 * of going through effectiveMight, the choke point that exists precisely so
 * continuous auras and per-card damage modifiers can't be forgotten. Each
 * test below is a case where the hand-rolled arithmetic gave a different —
 * and wrong — answer than the board.
 */

/** Garen - Commander (OGS-013): "Other friendly units have +1 Might here." */
function withCommanderAt(state: ReturnType<typeof makeState>, battlefieldIndex: number, playerId: string) {
  const bf = state.battlefields[battlefieldIndex]!;
  bf.units[playerId] = [...(bf.units[playerId] ?? []), realUnitInstance("OGS-013")];
  return state;
}

describe("Disintegrate: 'if this kills it, draw 1' asks the board, not arithmetic", () => {
  it("draws when Annie - Fiery's bonus damage is what made it lethal", () => {
    // Annie - Fiery ("your spells deal 1 Bonus Damage") makes this deal 4.
    // A 4-Might unit dies — but the old hand-rolled `- 3` said it lived, so
    // the card silently skipped its draw. Both cards are in the SAME precon.
    const disintegrate = spellInstance("OGN-005");
    const target = makeUnit({ might: 4 });
    const state = makeState();
    state.players[0]!.baseUnits = [realUnitInstance("OGS-001")]; // Annie - Fiery
    state.players[0]!.deck = [makeUnit()];
    state.battlefields[0]!.units = { p2: [target] };

    const result = effectForCard(disintegrate)!.resolve(state, contextFor(0), { targetUnitInstanceId: target.instanceId });

    expect(result.battlefields[0]!.units["p2"] ?? []).toHaveLength(0); // it died
    expect(result.players[0]!.hand).toHaveLength(1); // ...so it drew
  });

  it("does NOT draw when an aura kept the target alive", () => {
    // 3 Might printed, +1 from Garen - Commander standing with it = 4, so 3
    // damage leaves it at 1. The old check compared against the printed 3 and
    // drew a card for a kill that never happened.
    const disintegrate = spellInstance("OGN-005");
    const target = makeUnit({ might: 3 });
    const state = makeState();
    state.players[0]!.deck = [makeUnit()];
    state.battlefields[0]!.units = { p2: [target] };
    withCommanderAt(state, 0, "p2");

    const result = effectForCard(disintegrate)!.resolve(state, contextFor(0), { targetUnitInstanceId: target.instanceId });

    expect(result.battlefields[0]!.units["p2"]!.some((u) => u.instanceId === target.instanceId)).toBe(true);
    expect(result.players[0]!.hand).toHaveLength(0);
  });

  it("does NOT draw when Highlander's ward saved the target", () => {
    // Warded units are recalled to base instead of dying — so no kill, no draw.
    const disintegrate = spellInstance("OGN-005");
    const target = makeUnit({ might: 3 });
    const state = makeState();
    state.players[0]!.deck = [makeUnit()];
    state.battlefields[0]!.units = { p2: [target] };
    state.deathWardedUnitInstanceIds = [target.instanceId];

    const result = effectForCard(disintegrate)!.resolve(state, contextFor(0), { targetUnitInstanceId: target.instanceId });

    expect(result.players[1]!.baseUnits.map((u) => u.instanceId)).toContain(target.instanceId);
    expect(result.players[1]!.trash).toHaveLength(0);
    expect(result.players[0]!.hand).toHaveLength(0);
  });

  it("still draws on an ordinary kill", () => {
    const disintegrate = spellInstance("OGN-005");
    const target = makeUnit({ might: 2 });
    const state = makeState();
    state.players[0]!.deck = [makeUnit()];
    state.battlefields[0]!.units = { p2: [target] };

    const result = effectForCard(disintegrate)!.resolve(state, contextFor(0), { targetUnitInstanceId: target.instanceId });
    expect(result.players[0]!.hand).toHaveLength(1);
  });
});

describe("Gust's '3 Might or less' judges REAL Might, at every gate", () => {
  function gustState() {
    const gust = spellInstance("OGN-169");
    const target = makeUnit({ might: 3 });
    const state = makeState();
    state.players[0]!.hand = [gust];
    state.players[0]!.channeled = Array.from({ length: gust.energyCost }, (_, i) => ({
      id: `r${i}`,
      domain: "Chaos" as const,
      state: "Ready" as const,
    }));
    state.battlefields[0]!.units = { p2: [target] };
    return { gust, target, state };
  }

  it("a 3-Might unit is a legal target normally", () => {
    const { gust, target, state } = gustState();
    const candidates = legalActions(state).filter(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === gust.instanceId,
    );
    expect(candidates.map((a) => a.targetUnitInstanceId)).toContain(target.instanceId);
  });

  it("...but not once an aura pushes it to 4 — in legal-actions AND in validation", () => {
    const { gust, target, state } = gustState();
    withCommanderAt(state, 0, "p2");

    const candidates = legalActions(state).filter(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === gust.instanceId,
    );
    expect(candidates.map((a) => a.targetUnitInstanceId)).not.toContain(target.instanceId);

    // The two gates must agree — a UI that fanned out from legalActions would
    // otherwise offer a click the engine then rejects.
    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: gust,
      payment: { energyRunes: state.players[0]!.channeled.map((r) => r.id), powerRunes: [] },
      targetUnitInstanceId: target.instanceId,
    };
    expect(validatePlayCard(state, action).ok).toBe(false);
  });
});

describe("Stupefy's 'to a minimum of 1 Might' also judges real Might", () => {
  it("can still debuff a 1-Might unit that an aura has raised to 2", () => {
    const stupefy = spellInstance("OGN-095");
    const target = makeUnit({ might: 1 });
    const state = makeState();
    state.players[0]!.deck = [makeUnit()];
    state.battlefields[0]!.units = { p2: [target] };
    withCommanderAt(state, 0, "p2");

    const result = effectForCard(stupefy)!.resolve(state, contextFor(0), { targetUnitInstanceId: target.instanceId });

    expect(result.battlefields[0]!.units["p2"]!.find((u) => u.instanceId === target.instanceId)!.bonus).toBe(-1);
  });

  it("leaves a genuinely 1-Might unit alone", () => {
    const stupefy = spellInstance("OGN-095");
    const target = makeUnit({ might: 1 });
    const state = makeState();
    state.players[0]!.deck = [makeUnit()];
    state.battlefields[0]!.units = { p2: [target] };

    const result = effectForCard(stupefy)!.resolve(state, contextFor(0), { targetUnitInstanceId: target.instanceId });

    expect(result.battlefields[0]!.units["p2"]!.find((u) => u.instanceId === target.instanceId)!.bonus).toBe(0);
    expect(result.players[0]!.hand).toHaveLength(1); // draw happens either way
  });
});
