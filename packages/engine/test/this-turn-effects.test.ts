import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { resolveCardEffect } from "../src/engine/card-effect-resolution.js";
import { dealDamage } from "../src/engine/effect-helpers.js";
import { modifiedEnergyCost } from "../src/engine/cost-modifiers.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import type { GameState, SpellChainEntry } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * The "this turn" cluster — effects that arm now and fire later.
 *
 * They share a shape rather than a mechanism: a field that `runEnd` clears, read
 * at whatever choke point the card's sentence names. Tested together because the
 * failure they share is the one that is invisible — an effect that outlives its
 * turn, or one that never fires at all, both look like nothing happening.
 */

const registry = defaultCardRegistry();
const SKY_SPLITTER = "OGN-014"; // cost reduced by the highest Might among units you control
const EAGER_APPRENTICE = "OGN-084"; // spells cost 1 less, to a minimum of 1 — 356.4.e's other half
const RAGING_FIREBRAND = "OGN-031"; // the NEXT spell you play this turn costs 5 less
const UNYIELDING_SPIRIT = "OGN-145"; // prevent all spell and ability damage this turn
const IMPERIAL_DECREE = "OGN-221"; // when ANY unit takes damage this turn, kill it
const NOXIAN_GUILLOTINE = "OGN-254"; // kill it the next time it takes damage this turn
const HEXTECH_RAY = "OGN-009"; // Fury 1E/1P — "Deal 3 to a unit at a battlefield"

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return resolveHeldTriggers(next);
}

const playsFor = (state: GameState, defId: string) =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === defId);

function resolveChain(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 12 && current.spellChain.length > 0; guard += 1) {
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    expect(pass, "nobody could pass on the chain").toBeDefined();
    current = accept(current, pass!);
  }
  return current;
}

const unitAt = (state: GameState, instanceId: string, owner = "p2") =>
  state.battlefields.flatMap((bf) => bf.units[owner] ?? []).find((u) => u.instanceId === instanceId);

describe("Sky Splitter (OGN-014): cost reduced by your biggest body", () => {
  it("is 8 Energy on an empty board and free behind an 8-Might unit", () => {
    const state = makeState({ phase: "Action" });
    expect(modifiedEnergyCost(state, 0, "Spell", 8, SKY_SPLITTER), "an empty board should not discount it").toBe(8);

    state.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "big", might: 8 })] };
    expect(modifiedEnergyCost(state, 0, "Spell", 8, SKY_SPLITTER)).toBe(0);
  });

  it("reads the HIGHEST, not the sum", () => {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [makeUnit({ might: 3 }), makeUnit({ might: 4 })] };
    expect(modifiedEnergyCost(state, 0, "Spell", 8, SKY_SPLITTER), "3 + 4 is not the discount").toBe(4);
  });

  it("reads EFFECTIVE Might, so a this-turn pump makes it cheaper", () => {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [makeUnit({ might: 4, mightThisTurn: 2 })] };
    expect(modifiedEnergyCost(state, 0, "Spell", 8, SKY_SPLITTER)).toBe(2);
  });

  it("does not count the OPPONENT's units", () => {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p2: [makeUnit({ might: 8 })] };
    expect(modifiedEnergyCost(state, 0, "Spell", 8, SKY_SPLITTER)).toBe(8);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(SKY_SPLITTER))).toBe(true);
  });

  /**
   * **356.4.e's OWN worked example, with both cards in this pool — and the
   * engine got it wrong until 2026-08-23.**
   *
   * **INVERTED the same day it was written.** It first went in asserting the
   * divergent answer (1), was mutation-checked by hoisting the Apprentice block,
   * and is now pointed the right way round. Kept rather than deleted because it
   * is the rules' own example: if the ordering ever regresses, this is the line
   * that says so.
   *
   * *"356.4.e. If a discount applies a minimum cost, that minimum applies only to
   * that discount. Example: **Eager Apprentice** says 'While I'm at a
   * battlefield, the Energy costs for spells you play is reduced by [1], to a
   * minimum of [1].' A player who controls Eager Apprentice and a unit with 7
   * Might plays **Sky Splitter**, a spell that costs 8 Energy and says 'This
   * spell's Energy cost is reduced by the highest Might among units you control.'
   * That player **can choose to apply Eager Apprentice's discount first**,
   * reducing Sky Splitter's Energy cost to 7, then apply Sky Splitter's discount,
   * reducing its Energy cost to **0**. If they applied these discounts in the
   * other order, Sky Splitter's Energy cost would be **1**."*
   *
   * **356.4.c.1 and 356.4.d.1 make the order the PLAYER's choice** ("may be
   * applied in any order"). `modifiedEnergyCost` fixed one order instead, and the
   * order it fixed was the expensive one: Sky Splitter's self-scaling discount ran
   * long before Eager Apprentice's floored one. Every block in that function
   * carried the same reasoning — "a sometimes-discount should reduce what the card
   * prints, not something already reduced" — which is right for an UNFLOORED
   * discount and exactly backwards for a floored one.
   *
   * `applyFlooredDiscounts` now runs every discount that states a minimum first,
   * highest minimum first, in the never-raise form. See its doc comment for the
   * derivation and for why the player is not asked to pick the order.
   */
  it("lets the player pay 0, not 1 — 356.4.e's own worked example", () => {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = {
      p1: [realUnitInstance(EAGER_APPRENTICE), makeUnit({ might: 7, name: "Big" })],
    };
    // The two controls, so this cannot pass on a board that is not the example's.
    expect(modifiedEnergyCost(state, 0, "Spell", 8, SKY_SPLITTER + "-nope"), "the fixture's Apprentice is not discounting")
      .toBe(7);
    expect(
      modifiedEnergyCost(state, 0, "Spell", 8, SKY_SPLITTER),
      "the discounts went back to the expensive order",
    ).toBe(0);
  });

  it("...and the Apprentice never RAISES a spell already priced below its floor", () => {
    // Measured before the fix: Sky Splitter behind an 8-Might unit costs 0, and an
    // Eager Apprentice on the board made it cost 1. A card that says spells cost
    // LESS must never make one cost more. `vexSpellSwing` had this right and named
    // this exact case; the other four floored discounts used the plain
    // `Math.max(floor, ...)` form that raises.
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = {
      p1: [realUnitInstance(EAGER_APPRENTICE), makeUnit({ might: 8, name: "Huge" })],
    };
    expect(modifiedEnergyCost(state, 0, "Spell", 8, SKY_SPLITTER), "the Apprentice raised a free spell").toBe(0);
    // A printed-0 spell, with nothing else on the board to confuse it.
    const bare = makeState({ phase: "Action" });
    bare.battlefields[0]!.units = { p1: [realUnitInstance(EAGER_APPRENTICE)] };
    expect(modifiedEnergyCost(bare, 0, "Spell", 0, "OGN-999"), "a printed-0 spell was raised to 1").toBe(0);
  });
});

describe("Raging Firebrand (OGN-031): the next spell costs 5 less", () => {
  /** Firebrand in hand with runes, and a Hextech Ray to spend the charge on. */
  function firebrandState(): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [createCardInstance(registry.get(RAGING_FIREBRAND)), spellInstance(HEXTECH_RAY), spellInstance(HEXTECH_RAY)];
    state.players[0]!.channeled = Array.from({ length: 14 }, (_, i) => rune(`f${i}`, "Fury"));
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "victim", might: 9 })] };
    return state;
  }

  it("arms a charge when played", () => {
    const state = firebrandState();
    const played = accept(state, playsFor(state, RAGING_FIREBRAND)[0]!);
    expect(played.players[0]!.nextSpellEnergyDiscount).toBe(5);
  });

  it("is SPENT by the first spell and gone for the second", () => {
    // A charge, not a standing discount — the distinction the card turns on, and
    // the one that would be invisible: a permanent discount just looks generous.
    const state = firebrandState();
    const armed = accept(state, playsFor(state, RAGING_FIREBRAND)[0]!);
    const first = resolveChain(accept(armed, playsFor(armed, HEXTECH_RAY)[0]!));

    expect(first.players[0]!.nextSpellEnergyDiscount, "the charge survived the spell that used it").toBe(0);
  });

  it("does not discount a UNIT — 'the next SPELL you play'", () => {
    const state = firebrandState();
    const armed = accept(state, playsFor(state, RAGING_FIREBRAND)[0]!);
    expect(modifiedEnergyCost(armed, 0, "Unit", 4, "TEST-000"), "a unit was discounted").toBe(4);
    expect(modifiedEnergyCost(armed, 0, "Spell", 4, HEXTECH_RAY)).toBe(0);
  });

  it("expires with the turn", () => {
    const state = firebrandState();
    const armed = accept(state, playsFor(state, RAGING_FIREBRAND)[0]!);
    expect(runEnd(armed).players[0]!.nextSpellEnergyDiscount).toBe(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(RAGING_FIREBRAND))).toBe(true);
  });
});

describe("Unyielding Spirit (OGN-145): prevent all spell and ability damage this turn", () => {
  it("prevents damage to the CASTER's units and not to the opponent's", () => {
    // "Prevent all damage this turn" protects the player who cast it — casting it
    // must not also switch off your own removal.
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = {
      p1: [makeUnit({ instanceId: "mine", might: 5 })],
      p2: [makeUnit({ instanceId: "theirs", might: 5 })],
    };
    const protectedState: GameState = {
      ...state,
      players: [{ ...state.players[0]!, preventsSpellDamageThisTurn: true }, state.players[1]!],
    };

    expect(unitAt(dealDamage(protectedState, 1, "mine", 3), "mine", "p1")!.damage, "the prevention did not hold").toBe(0);
    expect(unitAt(dealDamage(protectedState, 0, "theirs", 3), "theirs")!.damage, "it protected the wrong side").toBe(3);
  });

  it("expires with the turn", () => {
    const state = makeState({ phase: "Action" });
    const armed: GameState = { ...state, players: [{ ...state.players[0]!, preventsSpellDamageThisTurn: true }, state.players[1]!] };
    expect(runEnd(armed).players[0]!.preventsSpellDamageThisTurn).toBe(false);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(UNYIELDING_SPIRIT))).toBe(true);
  });
});

describe("Imperial Decree (OGN-221): any damage this turn is lethal", () => {
  function decreed(): GameState {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = {
      p1: [makeUnit({ instanceId: "mine", might: 9 })],
      p2: [makeUnit({ instanceId: "theirs", might: 9 })],
    };
    return { ...state, killDamagedUnitsThisTurn: true };
  }

  it("kills a 9-Might unit with 1 damage", () => {
    const after = dealDamage(decreed(), 0, "theirs", 1);
    expect(unitAt(after, "theirs"), "the sentence did not fire").toBeUndefined();
    expect(after.players[1]!.trash.map((c) => c.instanceId)).toContain("theirs");
  });

  it("reaches the CASTER's own units too — 'ANY unit'", () => {
    const after = dealDamage(decreed(), 1, "mine", 1);
    expect(unitAt(after, "mine", "p1"), "it spared the caster's own board").toBeUndefined();
  });

  it("does nothing without the decree — the positive control", () => {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "theirs", might: 9 })] };
    expect(unitAt(dealDamage(state, 0, "theirs", 1), "theirs")!.damage).toBe(1);
  });

  it("expires with the turn", () => {
    expect(runEnd(decreed()).killDamagedUnitsThisTurn).toBe(false);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(IMPERIAL_DECREE))).toBe(true);
  });
});

/** Resolves the Guillotine at a named unit, the way a popped chain entry would. */
function castGuillotine(state: GameState, targetUnitInstanceId: string): GameState {
  return resolveCardEffect(state, {
    card: spellInstance(NOXIAN_GUILLOTINE),
    playerIndex: 0,
    payment: { energyRunes: [], powerRunes: [] },
    targetUnitInstanceId,
  } as SpellChainEntry);
}

describe("Noxian Guillotine (OGN-254): a death sentence on one unit", () => {
  function sentenced(): GameState {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = {
      p2: [makeUnit({ instanceId: "doomed", might: 9 }), makeUnit({ instanceId: "safe", might: 9 })],
    };
    return { ...state, markedForDeathOnDamageInstanceIds: ["doomed"] };
  }

  it("kills the marked unit on ANY damage, and leaves its neighbour alone", () => {
    const after = dealDamage(sentenced(), 0, "doomed", 1);
    expect(unitAt(after, "doomed")).toBeUndefined();
    expect(unitAt(dealDamage(sentenced(), 0, "safe", 1), "safe")!.damage, "the sentence spread").toBe(1);
  });

  it("expires with the turn", () => {
    expect(runEnd(sentenced()).markedForDeathOnDamageInstanceIds).toHaveLength(0);
  });

  it("kills it NOW instead when [Legion] is on — and does not also mark it", () => {
    // The premise this test used to carry was that the card's second half is
    // `[Repeat]`, a cost this engine models nowhere. It is `[Legion]`, which has
    // worked since Darius: the note was a misreading of the card, not a gap.
    //
    // `cardsPlayedThisTurn` is 2 because the Guillotine itself is already
    // counted when it resolves — "ANOTHER card" is one besides it.
    const state = { ...sentenced(), markedForDeathOnDamageInstanceIds: [] };
    const legion: GameState = {
      ...state,
      players: [{ ...state.players[0]!, cardsPlayedThisTurn: 2 }, state.players[1]!],
    };
    const after = castGuillotine(legion, "doomed");

    expect(unitAt(after, "doomed"), "it survived a Legion Guillotine").toBeUndefined();
    expect(after.markedForDeathOnDamageInstanceIds, "it was killed AND marked").toHaveLength(0);
  });

  it("only MARKS it without [Legion] — one other card is the whole condition", () => {
    const state = { ...sentenced(), markedForDeathOnDamageInstanceIds: [] };
    const alone: GameState = {
      ...state,
      players: [{ ...state.players[0]!, cardsPlayedThisTurn: 1 }, state.players[1]!],
    };
    const after = castGuillotine(alone, "doomed");

    expect(unitAt(after, "doomed"), "it died without [Legion]").toBeDefined();
    expect(after.markedForDeathOnDamageInstanceIds).toEqual(["doomed"]);
  });

  it("is reported as implemented by coverage", () => {
    expect(partialImplementationNote(registry.get(NOXIAN_GUILLOTINE))).toBeUndefined();
    expect(isCardImplemented(registry.get(NOXIAN_GUILLOTINE))).toBe(true);
  });
});
