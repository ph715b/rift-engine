import { describe, expect, it } from "vitest";
import { effectForCard, targetingForCard } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { dispatchOnPlayUnit, targetingForUnitTrigger } from "../src/engine/unit-triggers.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * Discipline (OGN-058, Calm) and Cemetery Attendant (OGN-165, Chaos) — the two
 * cards implemented in effects/calm.ts and effects/chaos.ts.
 *
 * Everything here goes through the REGISTRY (effectForCard / dispatchOnPlayUnit)
 * rather than calling a resolver imported directly, because that hop is exactly
 * what has broken before: a card can be written, typechecked and unreachable at
 * the same time, and a silently-inert card is indistinguishable from a working
 * one in play.
 */

/** Ready runes for one card's full cost, in whatever domain its Power demands. */
function funded(state: ReturnType<typeof makeState>, card: { energyCost: number; powerCost: number; powerDomain?: string | null }) {
  state.players[0]!.channeled = Array.from({ length: card.energyCost + card.powerCost }, (_, i) => ({
    id: `r${i}`,
    domain: (card.powerDomain ?? "Order") as "Order",
    state: "Ready" as const,
  }));
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

describe("Discipline: give a unit +2 Might this turn, draw 1", () => {
  it("grants +2 this-turn Might (not a Buff) to a friendly unit and draws 1", () => {
    const discipline = spellInstance("OGN-058");
    const ally = makeUnit({ might: 3 });
    const topOfDeck = makeUnit();
    const state = makeState();
    state.battlefields[0]!.units = { p1: [ally] };
    state.players[0]!.deck = [topOfDeck];

    const result = effectForCard(discipline)!.resolve(state, contextFor(0), { targetUnitInstanceId: ally.instanceId });

    const pumped = result.battlefields[0]!.units.p1![0]!;
    expect(pumped.mightThisTurn).toBe(2);
    // The distinction the card's wording turns on: "this turn" is NOT a Buff
    // (rule 710), which would outlive the turn.
    expect(pumped.buffed).toBe(false);
    expect(pumped.might).toBe(3); // printed Might untouched
    expect(result.players[0]!.hand.map((c) => c.instanceId)).toEqual([topOfDeck.instanceId]);
    expect(result.players[0]!.deck).toHaveLength(0);
  });

  it("says 'a unit', not 'a unit at a battlefield' — so it reaches the ENEMY base", () => {
    const discipline = spellInstance("OGN-058");
    const enemyAtHome = makeUnit({ might: 2 });
    const state = makeState();
    state.players[0]!.hand = [discipline];
    state.players[1]!.baseUnits = [enemyAtHome];
    funded(state, discipline);

    expect(targetingForCard(discipline)).toEqual({ kind: "unit", scope: "anywhere" });

    // Offered by legal-actions and accepted by validation, not merely resolvable —
    // a scope the enumerator never offers is a scope no player can ever use.
    const offered = legalActions(state).filter(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === discipline.instanceId,
    );
    expect(offered.map((a) => a.targetUnitInstanceId)).toContain(enemyAtHome.instanceId);
    expect(validatePlayCard(state, playAction(state, discipline, { targetUnitInstanceId: enemyAtHome.instanceId })).ok).toBe(true);

    const resolved = effectForCard(discipline)!.resolve(state, contextFor(0), { targetUnitInstanceId: enemyAtHome.instanceId });
    expect(resolved.players[1]!.baseUnits[0]!.mightThisTurn).toBe(2);
  });

  it("still gives the Might when the deck is empty — the draw takes nothing, it doesn't throw", () => {
    const discipline = spellInstance("OGN-058");
    const ally = makeUnit({ might: 4 });
    const state = makeState();
    state.players[0]!.baseUnits = [ally];
    state.players[0]!.deck = [];

    const result = effectForCard(discipline)!.resolve(state, contextFor(0), { targetUnitInstanceId: ally.instanceId });

    expect(result.players[0]!.baseUnits[0]!.mightThisTurn).toBe(2);
    expect(result.players[0]!.hand).toHaveLength(0);
  });

  it("stacks with an existing this-turn modifier rather than overwriting it", () => {
    const discipline = spellInstance("OGN-058");
    const ally = makeUnit({ might: 3, mightThisTurn: 1 });
    const state = makeState();
    state.players[0]!.baseUnits = [ally];

    const result = effectForCard(discipline)!.resolve(state, contextFor(0), { targetUnitInstanceId: ally.instanceId });

    expect(result.players[0]!.baseUnits[0]!.mightThisTurn).toBe(3);
  });
});

describe("Cemetery Attendant: on play, return a unit from your trash to your hand", () => {
  it("targets a Unit in your own trash, not a Spell", () => {
    expect(targetingForUnitTrigger("OGN-165")).toEqual({ kind: "ownTrashCard", cardKind: "Unit" });
  });

  it("moves the chosen trashed unit to hand, reset", () => {
    const attendant = realUnitInstance("OGN-165");
    const corpse = makeUnit({ damage: 2, mightThisTurn: 1, buffed: true, exhausted: true });
    let state = makeState();
    state.players[0]!.trash = [corpse];

    state = dispatchOnPlayUnit(state, attendant, 0, "base", { trashCardInstanceId: corpse.instanceId });

    expect(state.players[0]!.trash).toHaveLength(0);
    const returned = state.players[0]!.hand[0]!;
    expect(returned.instanceId).toBe(corpse.instanceId);
    expect(returned.kind === "Unit" && returned.damage).toBe(0);
    expect(returned.kind === "Unit" && returned.mightThisTurn).toBe(0);
    // Rule 709 already took the Buff off when it left play; it must not ride
    // back into hand and get replayed for free.
    expect(returned.kind === "Unit" && returned.buffed).toBe(false);
    expect(returned.exhausted).toBe(false);
  });

  it("an EMPTY trash still deploys the Attendant — the trigger no-ops instead of throwing", () => {
    const attendant = realUnitInstance("OGN-165");
    const state = makeState();
    state.players[0]!.hand = [attendant];
    funded(state, attendant);

    // No legal trash card, so validate-play-card's targetOmissionAllowed lets the
    // Unit be played with its trigger target omitted.
    const action = playAction(state, attendant);
    expect(validatePlayCard(state, action).ok).toBe(true);

    const resolved = dispatchOnPlayUnit(state, attendant, 0, "base", {});
    expect(resolved.players[0]!.hand.map((c) => c.instanceId)).toEqual([attendant.instanceId]);
    expect(resolved.players[0]!.trash).toHaveLength(0);
  });

  it("a trash holding only SPELLS offers no candidate, and the trigger returns nothing", () => {
    const attendant = realUnitInstance("OGN-165");
    const trashedSpell = spellInstance("OGS-003"); // Incinerate — a Spell, not a Unit
    const state = makeState();
    state.players[0]!.hand = [attendant];
    state.players[0]!.trash = [trashedSpell];
    funded(state, attendant);

    const offered = legalActions(state).filter(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === attendant.instanceId,
    );
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every((a) => a.trashCardInstanceId === undefined)).toBe(true);
    expect(validatePlayCard(state, playAction(state, attendant, { trashCardInstanceId: trashedSpell.instanceId })).ok).toBe(false);

    const resolved = dispatchOnPlayUnit(state, attendant, 0, "base", {});
    expect(resolved.players[0]!.trash.map((c) => c.instanceId)).toEqual([trashedSpell.instanceId]);
  });

  it("reads YOUR trash only — a unit in the opponent's trash stays there", () => {
    const attendant = realUnitInstance("OGN-165");
    const enemyCorpse = makeUnit();
    let state = makeState();
    state.players[1]!.trash = [enemyCorpse];

    state = dispatchOnPlayUnit(state, attendant, 0, "base", { trashCardInstanceId: enemyCorpse.instanceId });

    expect(state.players[1]!.trash.map((c) => c.instanceId)).toEqual([enemyCorpse.instanceId]);
    expect(state.players[0]!.hand).toHaveLength(0);
  });

  it("picks exactly the unit chosen when several are in the trash", () => {
    const attendant = realUnitInstance("OGN-165");
    const first = makeUnit();
    const wanted = makeUnit();
    let state = makeState();
    state.players[0]!.trash = [first, wanted];

    state = dispatchOnPlayUnit(state, attendant, 0, "base", { trashCardInstanceId: wanted.instanceId });

    expect(state.players[0]!.hand.map((c) => c.instanceId)).toEqual([wanted.instanceId]);
    expect(state.players[0]!.trash.map((c) => c.instanceId)).toEqual([first.instanceId]);
  });
});
