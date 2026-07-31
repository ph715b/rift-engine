import { describe, expect, it } from "vitest";
import { effectForCard } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { dispatchOnPlayUnit } from "../src/engine/unit-triggers.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { legalActions } from "../src/engine/legal-actions.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

describe("Morbid Return: return a unit from your trash to your hand", () => {
  it("moves the trashed unit to hand, reset", () => {
    const morbidReturn = effectForCard(spellInstance("OGN-170"))!;
    const trashedUnit = makeUnit({ damage: 2, mightThisTurn: 1, exhausted: true });
    const state = makeState();
    state.players[0]!.trash = [trashedUnit];

    const result = morbidReturn.resolve(state, contextFor(0), { trashCardInstanceId: trashedUnit.instanceId });

    expect(result.players[0]!.trash).toHaveLength(0);
    expect(result.players[0]!.hand).toHaveLength(1);
    const returned = result.players[0]!.hand[0]!;
    expect(returned.kind === "Unit" && returned.damage).toBe(0);
    expect(returned.kind === "Unit" && returned.mightThisTurn).toBe(0);
    expect(returned.exhausted).toBe(false);
  });

  it("validation requires a Unit-kind trash card, not a Spell", () => {
    const morbidReturn = spellInstance("OGN-170");
    const trashedSpell = spellInstance("OGS-003"); // Incinerate (Spell), not a Unit
    const state = makeState();
    state.players[0]!.hand = [morbidReturn];
    state.players[0]!.trash = [trashedSpell];
    state.players[0]!.channeled = Array.from({ length: morbidReturn.energyCost }, (_, i) => ({
      id: `r${i}`,
      domain: "Order" as const,
      state: "Ready" as const,
    }));

    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: morbidReturn,
      payment: { energyRunes: state.players[0]!.channeled.map((r) => r.id), powerRunes: [] },
      trashCardInstanceId: trashedSpell.instanceId,
    };
    expect(validatePlayCard(state, action).ok).toBe(false);
  });

  it("legalActions fans out one candidate per eligible Unit in trash, not per Spell", () => {
    const morbidReturn = spellInstance("OGN-170");
    const trashedUnit = makeUnit();
    const trashedSpell = spellInstance("OGS-003");
    const state = makeState();
    state.players[0]!.hand = [morbidReturn];
    state.players[0]!.trash = [trashedUnit, trashedSpell];
    state.players[0]!.channeled = Array.from({ length: morbidReturn.energyCost }, (_, i) => ({
      id: `r${i}`,
      domain: "Order" as const,
      state: "Ready" as const,
    }));

    const actions = legalActions(state);
    const matching = actions.filter((a) => a.type === "PlayCard" && a.card.instanceId === morbidReturn.instanceId);
    expect(matching).toHaveLength(1);
    expect(matching[0]!.type === "PlayCard" && matching[0]!.trashCardInstanceId).toBe(trashedUnit.instanceId);
  });
});

describe("Annie - Stubborn: on-play, return a spell from your trash to your hand", () => {
  it("moves a trashed spell to hand", () => {
    const annieStubborn = realUnitInstance("OGS-010");
    const trashedSpell = spellInstance("OGS-003");
    let state = makeState();
    state.players[0]!.trash = [trashedSpell];

    state = dispatchOnPlayUnit(state, annieStubborn, 0, "base", { trashCardInstanceId: trashedSpell.instanceId });

    expect(state.players[0]!.trash).toHaveLength(0);
    expect(state.players[0]!.hand.map((c) => c.instanceId)).toContain(trashedSpell.instanceId);
  });

  // REGRESSION: the test above dispatches the trigger DIRECTLY, which is
  // exactly the hop that was broken — executePlayCard forwarded
  // targetUnitInstanceId and visionRecycle into dispatchOnPlayUnit but
  // silently dropped trashCardInstanceId, so a real submitted PlayCard paid
  // the runes, deployed Annie, and then no-op'd inside returnCardFromTrash
  // on an undefined id. Nothing between the action and the trigger complained
  // (validate-play-card.ts checks the field, legal-actions.ts fans it out) —
  // it only surfaced by playing the card in the actual UI. So this one goes
  // through the real submit path end to end.
  it("returns the chosen spell when the card is actually PLAYED (not just dispatched)", () => {
    const annieStubborn = realUnitInstance("OGS-010");
    const trashedSpell = spellInstance("OGS-003");
    const state = makeState();
    state.players[0]!.championZone = annieStubborn;
    state.players[0]!.trash = [trashedSpell];
    state.players[0]!.channeled = [
      ...Array.from({ length: annieStubborn.energyCost }, (_, i) => ({
        id: `e${i}`,
        domain: "Chaos" as const,
        state: "Ready" as const,
      })),
      { id: "p0", domain: annieStubborn.powerDomain ?? ("Chaos" as const), state: "Ready" as const },
    ];

    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: annieStubborn,
      payment: {
        energyRunes: Array.from({ length: annieStubborn.energyCost }, (_, i) => `e${i}`),
        powerRunes: ["p0"],
      },
      trashCardInstanceId: trashedSpell.instanceId,
    };
    expect(validatePlayCard(state, action).ok).toBe(true);

    const next = executePlayCard(state, action);

    expect(next.players[0]!.trash).toHaveLength(0);
    expect(next.players[0]!.hand.map((c) => c.instanceId)).toContain(trashedSpell.instanceId);
  });
});
