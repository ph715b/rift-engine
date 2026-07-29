import { describe, expect, it } from "vitest";
import { effectForCard } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { legalActions } from "../src/engine/legal-actions.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { makeState, makeUnit, spellInstance } from "./fixtures.js";

function fakeDeck(count: number) {
  return Array.from({ length: count }, () => spellInstance("OGS-024")); // Decisive Strike, any Spell works as filler
}

describe("Meditation (OGN-048): optional exhaust-a-friendly-unit additional cost", () => {
  it("draws only 1 when the caster declines the additional cost", () => {
    const meditation = effectForCard(spellInstance("OGN-048"))!;
    const state = makeState();
    state.players[0]!.deck = fakeDeck(3);

    const result = meditation.resolve(state, contextFor(0), {});

    expect(result.players[0]!.hand).toHaveLength(1);
  });

  it("exhausts the chosen friendly unit and draws 2 when the cost is paid", () => {
    const meditation = effectForCard(spellInstance("OGN-048"))!;
    const friendly = makeUnit({ exhausted: false });
    const state = makeState();
    state.players[0]!.baseUnits = [friendly];
    state.players[0]!.deck = fakeDeck(3);

    const result = meditation.resolve(state, contextFor(0), { additionalCostUnitInstanceId: friendly.instanceId });

    expect(result.players[0]!.hand).toHaveLength(2);
    expect(result.players[0]!.baseUnits[0]!.exhausted).toBe(true);
  });

  it("also works when the chosen unit is at a battlefield, not just base", () => {
    const meditation = effectForCard(spellInstance("OGN-048"))!;
    const friendly = makeUnit({ exhausted: false });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [friendly] };
    state.players[0]!.deck = fakeDeck(3);

    const result = meditation.resolve(state, contextFor(0), { additionalCostUnitInstanceId: friendly.instanceId });

    expect(result.players[0]!.hand).toHaveLength(2);
    expect(result.battlefields[0]!.units["p1"]![0]!.exhausted).toBe(true);
  });

  it("validation rejects an EXHAUSTED unit as the additional cost", () => {
    const meditation = spellInstance("OGN-048");
    const friendly = makeUnit({ exhausted: true });
    const state = makeState();
    state.players[0]!.hand = [meditation];
    state.players[0]!.baseUnits = [friendly];
    state.players[0]!.channeled = Array.from({ length: meditation.energyCost }, (_, i) => ({
      id: `r${i}`,
      domain: "Calm" as const,
      state: "Ready" as const,
    }));

    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: meditation,
      payment: { energyRunes: state.players[0]!.channeled.map((r) => r.id), powerRunes: [] },
      additionalCostUnitInstanceId: friendly.instanceId,
    };
    expect(validatePlayCard(state, action).ok).toBe(false);
  });

  it("legalActions fans out a decline variant plus one per ready friendly unit", () => {
    const meditation = spellInstance("OGN-048");
    const readyFriendly = makeUnit({ exhausted: false });
    const exhaustedFriendly = makeUnit({ exhausted: true });
    const state = makeState();
    state.players[0]!.hand = [meditation];
    state.players[0]!.baseUnits = [readyFriendly, exhaustedFriendly];
    state.players[0]!.channeled = Array.from({ length: meditation.energyCost }, (_, i) => ({
      id: `r${i}`,
      domain: "Calm" as const,
      state: "Ready" as const,
    }));

    const actions = legalActions(state);
    const matching = actions.filter((a) => a.type === "PlayCard" && a.card.instanceId === meditation.instanceId);
    // decline + one per ready friendly unit (the exhausted one is never offered)
    expect(matching).toHaveLength(2);
    const ids = matching.map((a) => (a.type === "PlayCard" ? a.additionalCostUnitInstanceId : undefined));
    expect(ids).toContain(undefined);
    expect(ids).toContain(readyFriendly.instanceId);
    expect(ids).not.toContain(exhaustedFriendly.instanceId);
  });
});

describe("Highlander (OGS-020): applies a death ward to a chosen friendly unit", () => {
  it("adds the target to deathWardedUnitInstanceIds", () => {
    const highlander = effectForCard(spellInstance("OGS-020"))!;
    const friendly = makeUnit();
    const state = makeState();
    state.battlefields[0]!.units = { p1: [friendly] };

    const result = highlander.resolve(state, contextFor(0), { targetUnitInstanceId: friendly.instanceId });

    expect(result.deathWardedUnitInstanceIds).toContain(friendly.instanceId);
  });
});
