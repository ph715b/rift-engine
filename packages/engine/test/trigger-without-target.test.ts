import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { hasAnyLegalEffectChoice } from "../src/engine/target-lookup.js";
import { targetingForAnyCard } from "../src/engine/unit-triggers.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * A Unit's on-play trigger does as much as it can and no more: with nothing
 * legal to point at, the unit is still played and the trigger simply doesn't
 * fire. Before this, a trigger with no available target made its own HOST
 * unplayable — Annie-Stubborn uncastable on an empty trash, First Mate
 * uncastable as your first unit, Maddened Marauder uncastable on an empty
 * board — withholding a body you paid for because a bonus couldn't happen.
 *
 * A Spell is deliberately different: its targeting IS its effect, so "no
 * legal target" really does mean "can't cast" (asserted at the bottom).
 */
function readyRunes(count: number, domain: "Chaos" | "Fury" | "Body" = "Chaos") {
  return Array.from({ length: count }, (_, i) => ({ id: `r${i}`, domain, state: "Ready" as const }));
}

function fundedState(card: { energyCost: number; powerCost: number; powerDomain: string | null }) {
  const state = makeState();
  const domain = (card.powerDomain ?? "Chaos") as "Chaos" | "Fury" | "Body";
  state.players[0]!.channeled = readyRunes(card.energyCost + card.powerCost, domain);
  return state;
}

type PlayableCard = Extract<PlayCardAction["card"], { energyCost: number }>;

function playAction(state: ReturnType<typeof makeState>, card: PlayableCard): PlayCardAction {
  const runes = state.players[0]!.channeled.map((r) => r.id);
  return {
    type: "PlayCard",
    playerIndex: 0,
    card,
    payment: { energyRunes: runes.slice(0, card.energyCost), powerRunes: runes.slice(card.energyCost) },
  };
}

describe("a Unit whose on-play trigger has no legal target is still playable", () => {
  it("Annie - Stubborn is playable with an EMPTY trash (and the trigger no-ops)", () => {
    const annie = realUnitInstance("OGS-010"); // "return a spell from your trash to your hand"
    const state = fundedState(annie);
    state.players[0]!.hand = [annie];
    expect(state.players[0]!.trash).toHaveLength(0);

    const candidates = legalActions(state).filter((a) => a.type === "PlayCard" && a.card.instanceId === annie.instanceId);
    expect(candidates.length).toBeGreaterThan(0);

    const action = playAction(state, annie);
    expect(validatePlayCard(state, action).ok).toBe(true);

    const next = executePlayCard(state, action);
    expect(next.players[0]!.baseUnits.map((u) => u.defId)).toContain("OGS-010");
    expect(next.players[0]!.hand).toHaveLength(0);
  });

  it("Annie - Stubborn is playable with a trash holding only UNITS (her trigger wants a Spell)", () => {
    const annie = realUnitInstance("OGS-010");
    const state = fundedState(annie);
    state.players[0]!.hand = [annie];
    state.players[0]!.trash = [makeUnit()];

    const action = playAction(state, annie);
    expect(validatePlayCard(state, action).ok).toBe(true);
    // The unit stays in the trash — nothing eligible was returned.
    expect(executePlayCard(state, action).players[0]!.trash).toHaveLength(1);
  });

  it("Maddened Marauder is playable with no units at any battlefield", () => {
    const marauder = realUnitInstance("OGN-191"); // "move a unit from a battlefield to its base"
    const state = fundedState(marauder);
    state.players[0]!.hand = [marauder];

    const action = playAction(state, marauder);
    expect(validatePlayCard(state, action).ok).toBe(true);
    expect(executePlayCard(state, action).players[0]!.baseUnits.map((u) => u.defId)).toContain("OGN-191");
  });

  it("First Mate is playable as your first unit", () => {
    const firstMate = realUnitInstance("OGN-132"); // "ready another unit"
    const state = fundedState(firstMate);
    state.players[0]!.hand = [firstMate];

    expect(validatePlayCard(state, playAction(state, firstMate)).ok).toBe(true);
  });

  it("but an omitted target is still REJECTED when a legal one exists", () => {
    const marauder = realUnitInstance("OGN-191");
    const state = fundedState(marauder);
    state.players[0]!.hand = [marauder];
    // A unit at a battlefield IS a legal target, so skipping the choice would
    // be ducking a mandatory trigger.
    state.battlefields[0]!.units = { p2: [makeUnit()] };

    const result = validatePlayCard(state, playAction(state, marauder));
    expect(result.ok).toBe(false);
  });

  it("a SPELL with no legal target stays uncastable — its targeting IS the effect", () => {
    const morbidReturn = spellInstance("OGN-170"); // "return a unit from your trash"
    const state = fundedState(morbidReturn);
    state.players[0]!.hand = [morbidReturn];
    expect(state.players[0]!.trash).toHaveLength(0);

    const candidates = legalActions(state).filter((a) => a.type === "PlayCard" && a.card.instanceId === morbidReturn.instanceId);
    expect(candidates).toHaveLength(0);
    expect(validatePlayCard(state, playAction(state, morbidReturn)).ok).toBe(false);
  });
});

describe("hasAnyLegalEffectChoice agrees with legal-actions' own fan-out", () => {
  it("reports false exactly when the fan-out produces no candidate for a Unit trigger", () => {
    const marauder = realUnitInstance("OGN-191");
    const empty = fundedState(marauder);
    empty.players[0]!.hand = [marauder];
    expect(hasAnyLegalEffectChoice(empty, 0, targetingForAnyCard(marauder))).toBe(false);

    const occupied = fundedState(marauder);
    occupied.players[0]!.hand = [marauder];
    occupied.battlefields[0]!.units = { p2: [makeUnit()] };
    expect(hasAnyLegalEffectChoice(occupied, 0, targetingForAnyCard(marauder))).toBe(true);
    const targeted = legalActions(occupied).filter(
      (a) => a.type === "PlayCard" && a.card.instanceId === marauder.instanceId && a.targetUnitInstanceId !== undefined,
    );
    expect(targeted.length).toBeGreaterThan(0);
  });

  it("a unitPair needs two DISTINCT units, not one that satisfies both roles", () => {
    const duel = spellInstance("OGS-008"); // friendly + enemy pair
    const state = makeState();
    state.battlefields[0]!.units = { p1: [makeUnit()] }; // friendly only
    expect(hasAnyLegalEffectChoice(state, 0, targetingForAnyCard(duel))).toBe(false);

    state.battlefields[0]!.units = { p1: [makeUnit()], p2: [makeUnit()] };
    expect(hasAnyLegalEffectChoice(state, 0, targetingForAnyCard(duel))).toBe(true);
  });
});
