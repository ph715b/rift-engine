import { describe, expect, it } from "vitest";
import { isOpenBattlefield, mayPlaceOnOpenBattlefield } from "../src/engine/unit-triggers.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit } from "./fixtures.js";

/**
 * "You may play me to an open battlefield" — Sai Scout (OGN-174) and Sneaky
 * Deckhand (OGN-176).
 *
 * Rule 170.11.c defines the word exactly: "Battlefields can be 'open.' This
 * means they are **unoccupied and uncontrolled**."
 *
 * Reported from playtesting: Sai Scout was played to a battlefield the player
 * already CONTROLLED. The grant was a per-card boolean that never looked at the
 * battlefield at all, so these two units could be played anywhere — including
 * onto a battlefield the OPPONENT held, which applies Contested and opens a
 * Showdown. That turned "play me to an open battlefield" into a free 5-Might
 * attack, which is the more serious half of the same bug.
 */

const registry = defaultCardRegistry();
const SAI_SCOUT = "OGN-174";
const SNEAKY_DECKHAND = "OGN-176";
const unit = (defId: string) => createCardInstance(registry.get(defId)) as UnitInstance;

/** A caster holding `card` with runes to spare, and no units anywhere. */
function casterHolding(card: UnitInstance): GameState {
  return makeState({
    phase: "Action",
    players: [
      makePlayer("p1", {
        hand: [card],
        deck: [makeUnit()],
        channeled: Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, domain: "Order" as const, state: "Ready" as const })),
      }),
      makePlayer("p2"),
    ],
  });
}

const playsTo = (state: GameState, card: UnitInstance, battlefieldId: string) =>
  legalActions(state).filter(
    (a) => a.type === "PlayCard" && a.card.instanceId === card.instanceId && a.destinationBattlefieldId === battlefieldId,
  );

/** A hand-built action, to prove the VALIDATOR refuses it too and not just the
 *  enumeration — the board and the AI take different routes to the same rule.
 *  `visionRecycle` is supplied because Sai Scout carries [Vision] and validation
 *  requires that choice; without it the negative cases below would pass for the
 *  wrong reason, rejected on a missing Vision decision rather than on the
 *  destination. The `rejects` helper checks the MESSAGE for exactly that. */
const forcedPlay = (state: GameState, card: UnitInstance, battlefieldId: string) => ({
  type: "PlayCard" as const,
  playerIndex: 0 as const,
  card,
  payment: {
    energyRunes: state.players[0]!.channeled.slice(0, card.energyCost).map((r) => r.id),
    powerRunes: state.players[0]!.channeled.slice(card.energyCost, card.energyCost + card.powerCost).map((r) => r.id),
  },
  destinationBattlefieldId: battlefieldId,
  visionRecycle: false,
});

/** Refused, and refused BECAUSE of the destination rule. */
function rejectsOnDestination(state: GameState, card: UnitInstance, battlefieldId: string) {
  const result = validatePlayCard(state, forcedPlay(state, card, battlefieldId));
  expect(result.ok).toBe(false);
  expect(result.ok === false && result.error).toMatch(/battlefield where you already have units/);
}

describe("rule 170.11.c: an open battlefield is unoccupied AND uncontrolled", () => {
  it("recognises a genuinely open battlefield", () => {
    const state = makeState();
    expect(isOpenBattlefield(state.battlefields[0]!)).toBe(true);
  });

  it("a controlled battlefield is not open, even with no units on it", () => {
    const state = makeState();
    state.battlefields[0]!.controllerId = "p1";
    expect(isOpenBattlefield(state.battlefields[0]!)).toBe(false);
  });

  it("an occupied battlefield is not open, even with nobody controlling it", () => {
    const state = makeState();
    state.battlefields[0]!.units = { p2: [makeUnit()] };
    expect(isOpenBattlefield(state.battlefields[0]!)).toBe(false);
  });
});

describe("Sai Scout cannot be played to a battlefield you already control", () => {
  it("is not offered there — the reported bug", () => {
    const scout = unit(SAI_SCOUT);
    const state = casterHolding(scout);
    state.battlefields[0]!.controllerId = "p1"; // yours, and empty

    expect(playsTo(state, scout, "bf1")).toHaveLength(0);
  });

  it("is refused there by the validator too", () => {
    const scout = unit(SAI_SCOUT);
    const state = casterHolding(scout);
    state.battlefields[0]!.controllerId = "p1";

    rejectsOnDestination(state, scout, "bf1");
  });
});

describe("Sai Scout cannot be played onto the opponent's battlefield", () => {
  it("is not offered onto one they control", () => {
    // The more serious half: landing on an opponent-held battlefield applies
    // Contested and opens a Showdown, so this was a free attack with a 5-Might
    // body that the card never promised.
    const scout = unit(SAI_SCOUT);
    const state = casterHolding(scout);
    state.battlefields[0]!.controllerId = "p2";

    expect(playsTo(state, scout, "bf1")).toHaveLength(0);
    rejectsOnDestination(state, scout, "bf1");
  });

  it("is not offered onto one holding enemy units", () => {
    const scout = unit(SAI_SCOUT);
    const state = casterHolding(scout);
    state.battlefields[0]!.units = { p2: [makeUnit({ might: 3 })] };

    expect(playsTo(state, scout, "bf1")).toHaveLength(0);
    rejectsOnDestination(state, scout, "bf1");
  });
});

describe("what the grant still DOES allow", () => {
  it("Sai Scout is offered a genuinely open battlefield", () => {
    const scout = unit(SAI_SCOUT);
    const state = casterHolding(scout); // both battlefields empty and uncontrolled

    expect(playsTo(state, scout, "bf1").length).toBeGreaterThan(0);
    expect(validatePlayCard(state, forcedPlay(state, scout, "bf1")).ok).toBe(true);
  });

  it("Sneaky Deckhand gets the same grant and the same limits", () => {
    const deckhand = unit(SNEAKY_DECKHAND);
    const open = casterHolding(deckhand);
    expect(playsTo(open, deckhand, "bf1").length).toBeGreaterThan(0);

    const mine = casterHolding(deckhand);
    mine.battlefields[0]!.controllerId = "p1";
    expect(playsTo(mine, deckhand, "bf1")).toHaveLength(0);
  });

  it("an ordinary unit still reinforces where you already have one, open or not", () => {
    // The grant is an EXCEPTION to the reinforce rule, not a replacement for it —
    // tightening it must not have taken ordinary reinforcement away.
    const plain = unit("OGN-002"); // Brazen Buccaneer, no grant
    const state = casterHolding(plain);
    state.battlefields[0]!.controllerId = "p1";
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Garrison" })] };

    expect(playsTo(state, plain, "bf1").length).toBeGreaterThan(0);
  });

  it("a granted unit ALSO still reinforces a battlefield it already occupies", () => {
    const scout = unit(SAI_SCOUT);
    const state = casterHolding(scout);
    state.battlefields[0]!.controllerId = "p1";
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Garrison" })] };

    expect(mayPlaceOnOpenBattlefield(SAI_SCOUT, state.battlefields[0]!)).toBe(false); // not open...
    expect(playsTo(state, scout, "bf1").length).toBeGreaterThan(0); // ...but presence covers it
  });
});
