import { describe, expect, it } from "vitest";
import { modifiedEnergyCost, freeGearPlayApplies } from "../src/engine/cost-modifiers.js";
import { hasAccelerate } from "../src/engine/timing.js";
import { answerDecision, pendingDecision } from "../src/engine/decisions.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance, type SpellInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * Phase 3 — playing from somewhere other than your hand.
 *
 * **Three of these six cards are provably inert today, and the tests say so
 * rather than pretending otherwise.** There are exactly three places a card can
 * be played from in this engine — hand, the Champion Zone, and facedown at a
 * battlefield — and of the two non-hand ones, a from-Hidden play is priced at
 * zero before any modifier runs (811) while every other "play from elsewhere"
 * routes through `playCardIgnoringCost`, which bypasses pricing entirely. So
 * Void Drone's and Drag Under's discount, and Rek'Sai's `[Accelerate]` grant,
 * are reachable only through the Champion Zone.
 *
 * The rules are therefore tested at the FUNCTION that expresses them, with the
 * source passed explicitly. That is the honest level: it pins the card's text
 * without asserting a board state the engine cannot currently reach, and it will
 * keep passing unchanged the day a full-cost non-hand play exists.
 *
 * The other three — Fizz, Jayce, Glasc Mixologist — are fully live and are
 * driven through their real decisions.
 */

const registry = defaultCardRegistry();

const VOID_DRONE = "SFD-010";
const DRAG_UNDER = "SFD-164";
const REKSAI_BREACHER = "SFD-029";
const FIZZ_TRICKSTER = "SFD-140";
const JAYCE_PROGRESS = "SFD-084";
const GLASC_MIXOLOGIST = "SFD-165";

/** Long Sword — 2 Energy, no Power pip: a Gear that Jayce's permission can zero. */
const LONG_SWORD = "SFD-022";

const gear = (defId: string): GearInstance => createCardInstance(registry.get(defId)) as GearInstance;
const unit = (defId: string): UnitInstance => createCardInstance(registry.get(defId)) as UnitInstance;
const spell = (defId: string): SpellInstance => createCardInstance(registry.get(defId)) as SpellInstance;
const runes = (n: number, domain: RuneCard["domain"] = "Chaos"): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, domain, state: "Ready" as const }));

function unitDef(defId: string) {
  const def = registry.get(defId);
  if (def.type !== "Unit") throw new Error(`${defId} is not a Unit`);
  return def;
}
function spellDef(defId: string) {
  const def = registry.get(defId);
  if (def.type !== "Spell") throw new Error(`${defId} is not a Spell`);
  return def;
}
function gearDef(defId: string) {
  const def = registry.get(defId);
  if (def.type !== "Gear") throw new Error(`${defId} is not a Gear`);
  return def;
}

describe("Void Drone (SFD-010) and Drag Under (SFD-164): [2] less from anywhere but hand", () => {
  const state = () => makeState({ phase: "Action" });

  it("charges Void Drone full price from hand", () => {
    const printed = unitDef(VOID_DRONE).energyCost;
    expect(modifiedEnergyCost(state(), 0, "Unit", printed, VOID_DRONE, true)).toBe(printed);
  });

  it("takes [2] off Void Drone played from elsewhere", () => {
    const printed = unitDef(VOID_DRONE).energyCost;
    expect(modifiedEnergyCost(state(), 0, "Unit", printed, VOID_DRONE, false)).toBe(printed - 2);
  });

  it("takes [2] off Drag Under played from elsewhere", () => {
    const printed = spellDef(DRAG_UNDER).energyCost;
    expect(modifiedEnergyCost(state(), 0, "Spell", printed, DRAG_UNDER, false)).toBe(printed - 2);
  });

  /** The discount is keyed to these two cards, not to the source in general. */
  it("does not discount an ordinary card played from elsewhere", () => {
    expect(modifiedEnergyCost(state(), 0, "Gear", 2, LONG_SWORD, false)).toBe(2);
  });

  it.each([VOID_DRONE, DRAG_UNDER])("%s is claimed by a module", (defId) => {
    expect(isCardImplemented(registry.get(defId))).toBe(true);
  });
});

describe("Rek'Sai - Breacher (SFD-029): units played from elsewhere have [Accelerate]", () => {
  /** Rek'Sai in base, plus a plain unit that prints no [Accelerate] of its own. */
  function board(): { state: GameState; plain: UnitInstance } {
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [{ ...realUnitInstance(REKSAI_BREACHER), instanceId: "reksai" }];
    const plain = makeUnit({ instanceId: "plain", keywords: {} });
    return { state, plain };
  }

  it("grants [Accelerate] to a unit played from a non-hand zone", () => {
    const { state, plain } = board();
    expect(hasAccelerate(plain, state, 0, false), "the grant did not apply").toBe(true);
  });

  it("does NOT grant it to a unit played from hand", () => {
    const { state, plain } = board();
    expect(hasAccelerate(plain, state, 0, true), "the grant reached a hand play").toBe(false);
  });

  it("does nothing while Rek'Sai is not in play", () => {
    const { state, plain } = board();
    state.players[0]!.baseUnits = [];
    expect(hasAccelerate(plain, state, 0, false), "the grant outlived its source").toBe(false);
  });

  /** Every caller that only ever meant the PRINTED keyword must be unchanged. */
  it("still answers the printed question when asked without a source", () => {
    const { plain } = board();
    expect(hasAccelerate(plain)).toBe(false);
    expect(hasAccelerate(unit(REKSAI_BREACHER)), "his own printed [Accelerate] was lost").toBe(true);
  });

  it("is claimed by a module", () => {
    expect(isCardImplemented(registry.get(REKSAI_BREACHER))).toBe(true);
  });
});

describe("Jayce - Man of Progress (SFD-084): kill a gear, play one free this turn", () => {
  function board(): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [gear(LONG_SWORD)];
    return state;
  }

  const ask = (state: GameState) =>
    resolveHeldTriggers(runCleanup({ ...state, pendingDecisions: [{ id: "d1", kind: "SFD-084-kill", playerIndex: 0 }] }));

  it("kills the chosen gear and opens the window", () => {
    const state = board();
    const target = state.players[0]!.activeGear[0]!;
    const after = answerDecision(ask(state), "d1", target.instanceId)!;

    expect(after.players[0]!.activeGear, "the gear was not killed").toHaveLength(0);
    expect(after.players[0]!.freeGearPlaysThisTurn, "no window was opened").toBe(1);
  });

  /** "If you do" — declining gives nothing at all. */
  it("opens no window when declined", () => {
    const after = answerDecision(ask(board()), "d1", "decline")!;

    expect(after.players[0]!.activeGear, "declining still killed the gear").toHaveLength(1);
    expect(after.players[0]!.freeGearPlaysThisTurn, "declining still opened a window").toBe(0);
  });

  it("zeroes a gear's Energy while the window is open", () => {
    const state = board();
    const printed = gearDef(LONG_SWORD).energyCost;
    expect(modifiedEnergyCost(state, 0, "Gear", printed, LONG_SWORD), "priced free with no window").toBe(printed);

    state.players[0]!.freeGearPlaysThisTurn = 1;
    expect(modifiedEnergyCost(state, 0, "Gear", printed, LONG_SWORD), "the window did not apply").toBe(0);
  });

  /** The window is for GEAR — a unit played the same turn pays in full. */
  it("does not cheapen a unit", () => {
    const state = board();
    state.players[0]!.freeGearPlaysThisTurn = 1;
    const printed = unitDef(VOID_DRONE).energyCost;

    expect(modifiedEnergyCost(state, 0, "Unit", printed, VOID_DRONE)).toBe(printed);
  });

  /** "no more than [7]" is a printed ceiling. */
  it("does not apply above the printed ceiling", () => {
    const state = board();
    state.players[0]!.freeGearPlaysThisTurn = 1;

    expect(freeGearPlayApplies(state, 0, "Gear", 7), "a 7-cost gear was refused").toBe(true);
    expect(freeGearPlayApplies(state, 0, "Gear", 8), "an 8-cost gear was let through").toBe(false);
  });

  it("is claimed by a module and carries no partial note", () => {
    expect(isCardImplemented(registry.get(JAYCE_PROGRESS))).toBe(true);
    expect(partialImplementationNote(registry.get(JAYCE_PROGRESS))).toBeUndefined();
  });
});

describe("Glasc Mixologist (SFD-165): [Deathknell] play a unit from your trash", () => {
  /** A trash holding one cheap unit and one that is over the ceiling. */
  function board(): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.trash = [{ ...unit(VOID_DRONE), instanceId: "cheapish" }];
    return state;
  }

  const ask = (state: GameState) =>
    resolveHeldTriggers(runCleanup({ ...state, pendingDecisions: [{ id: "d1", kind: "SFD-165-play", playerIndex: 0 }] }));

  /** "no more than [3] and no more than [rainbow]" — Void Drone is 3 Energy and
   *  no Power, so it sits exactly on the ceiling and must be offered. */
  it("offers a unit inside the printed ceiling and plays it free", () => {
    const state = board();
    expect(unitDef(VOID_DRONE).energyCost, "the fixture no longer sits on the ceiling").toBeLessThanOrEqual(3);

    const after = answerDecision(ask(state), "d1", "cheapish")!;

    expect(after.players[0]!.baseUnits.map((u) => u.instanceId), "it did not enter play").toContain("cheapish");
    expect(after.players[0]!.trash, "it was left in the trash as well").toHaveLength(0);
    // "Ignoring its COST" — both halves, so nothing is spent.
    expect(after.players[0]!.channeled, "runes were spent on a free play").toHaveLength(0);
  });

  it("plays nothing when declined", () => {
    const after = answerDecision(ask(board()), "d1", "decline")!;

    expect(after.players[0]!.baseUnits, "declining still played it").toHaveLength(0);
    expect(after.players[0]!.trash, "the card left the trash anyway").toHaveLength(1);
  });

  it("does not offer a unit over the printed ceiling", () => {
    const state = makeState({ phase: "Action" });
    // Rek'Sai is a 3-Energy unit but prints a Power pip of 1... use a clearly
    // expensive one instead, asserted rather than assumed.
    const pricey = { ...unit(GLASC_MIXOLOGIST), instanceId: "pricey" };
    expect(unitDef(GLASC_MIXOLOGIST).energyCost, "the control unit is not over the ceiling").toBeGreaterThan(3);
    state.players[0]!.trash = [pricey];

    const offered = runCleanup({ ...state, pendingDecisions: [{ id: "d1", kind: "SFD-165-play", playerIndex: 0 }] });
    const after = answerDecision(offered, "d1", "pricey") ?? offered;

    expect(after.players[0]!.baseUnits, "a unit over the ceiling was played").toHaveLength(0);
  });

  it("is claimed by a module", () => {
    expect(isCardImplemented(registry.get(GLASC_MIXOLOGIST))).toBe(true);
  });
});

describe("Fizz - Trickster (SFD-140): play a spell from your trash for its Power only", () => {
  /** Drag Under is 5 Energy — over Fizz's [3] ceiling — so the fixture uses a
   *  cheap Chaos spell the pool really has. Asserted, not assumed. */
  const CHEAP_SPELL = "OGN-009"; // Hextech Ray — 1 Energy, 1 Fury Power.

  function board(runeCount = 3): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.trash = [{ ...spell(CHEAP_SPELL), instanceId: "cheap" }];
    state.players[0]!.channeled = runes(runeCount, "Fury");
    return state;
  }

  const ask = (state: GameState) =>
    resolveHeldTriggers(runCleanup({ ...state, pendingDecisions: [{ id: "d1", kind: "SFD-140-play", playerIndex: 0 }] }));

  it("uses a fixture spell inside the printed ceiling", () => {
    expect(spellDef(CHEAP_SPELL).energyCost, "the fixture spell is over Fizz's ceiling").toBeLessThanOrEqual(3);
  });

  it("recycles the spell to the bottom of the deck after playing it", () => {
    const state = board();
    const after = answerDecision(ask(state), "d1", "cheap")!;

    // "Recycle that spell AFTER you play it" — bottom of the deck, not the trash
    // it came from, which is what stops him looping one spell every turn.
    expect(after.players[0]!.deck.map((c) => c.instanceId), "it was not recycled to the deck").toContain("cheap");
    expect(after.players[0]!.trash.map((c) => c.instanceId), "it was left in the trash").not.toContain("cheap");
  });

  it("plays nothing and recycles nothing when declined", () => {
    const after = answerDecision(ask(board()), "d1", "decline")!;

    expect(after.players[0]!.trash.map((c) => c.instanceId), "declining still moved it").toContain("cheap");
    expect(after.players[0]!.deck, "declining still recycled it").toHaveLength(0);
  });

  /**
   * "(You must still pay its Power cost.)" — a spell whose Power cannot be paid
   * is not offered at all, which is this file's rule for every paid offer.
   */
  it("does not offer a spell whose Power cost cannot be paid", () => {
    const state = board(0);
    const printedPower = spellDef(CHEAP_SPELL).powerCost;
    expect(printedPower, "the fixture spell has no Power cost to fail on").toBeGreaterThan(0);

    const offered = runCleanup({ ...state, pendingDecisions: [{ id: "d1", kind: "SFD-140-play", playerIndex: 0 }] });
    const after = answerDecision(offered, "d1", "cheap") ?? offered;

    expect(after.players[0]!.deck, "an unpayable spell was played anyway").toHaveLength(0);
    expect(after.players[0]!.trash.map((c) => c.instanceId)).toContain("cheap");
  });

  it("is claimed by a module", () => {
    expect(isCardImplemented(registry.get(FIZZ_TRICKSTER))).toBe(true);
  });
});
