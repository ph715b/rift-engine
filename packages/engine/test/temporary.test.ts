import { describe, expect, it } from "vitest";
import { runBeginning } from "../src/engine/turn-manager.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";

/**
 * [Temporary] — rule 816: "At the start of this permanent's controller's
 * Beginning Phase, before scoring, kill this."
 *
 * "Before scoring" is the entire keyword. Kill the unit after holds score and
 * every Temporary token becomes a free point, which inverts what the cards are
 * for. runBeginning is the only place that ordering can be got right, and it is
 * the one thing pinned hardest below.
 */

const temporaryUnit = (overrides: Partial<UnitInstance> = {}): UnitInstance =>
  makeUnit({ keywords: { Temporary: 1 }, ...overrides });

/** A Beginning-phase state where `activePlayerIndex` is about to score. */
function beginningState(): GameState {
  return makeState({ phase: "Beginning", activePlayerIndex: 0 });
}

describe("a Temporary permanent dies at the start of its controller's Beginning Phase", () => {
  it("dies in base", () => {
    const doomed = temporaryUnit();
    const state = beginningState();
    state.players[0]!.baseUnits = [doomed];

    const after = runBeginning(state);

    expect(after.players[0]!.baseUnits).toHaveLength(0);
    expect(after.players[0]!.trash.map((c) => c.instanceId)).toEqual([doomed.instanceId]);
  });

  it("dies at a battlefield", () => {
    const doomed = temporaryUnit();
    const state = beginningState();
    state.battlefields[0]!.units = { p1: [doomed] };

    const after = runBeginning(state);

    expect(after.battlefields[0]!.units["p1"] ?? []).toHaveLength(0);
  });

  it("leaves units without the keyword alone", () => {
    const doomed = temporaryUnit({ name: "Sprite" });
    const keeper = makeUnit({ name: "Keeper" });
    const state = beginningState();
    state.players[0]!.baseUnits = [doomed, keeper];

    const after = runBeginning(state);

    expect(after.players[0]!.baseUnits.map((u) => u.name)).toEqual(["Keeper"]);
  });

  it("kills every Temporary permanent, not just the first", () => {
    const state = beginningState();
    state.players[0]!.baseUnits = [temporaryUnit(), temporaryUnit()];
    state.battlefields[0]!.units = { p1: [temporaryUnit()] };

    const after = runBeginning(state);

    expect(after.players[0]!.baseUnits).toHaveLength(0);
    expect(after.battlefields[0]!.units["p1"] ?? []).toHaveLength(0);
    expect(after.players[0]!.trash).toHaveLength(3);
  });

  it("is redundant in multiple instances (817.1.a)", () => {
    // The keyword is a presence check, not a count, so a doubled grant behaves
    // identically — one death, not two.
    const state = beginningState();
    state.players[0]!.baseUnits = [temporaryUnit({ keywords: { Temporary: 2 } })];
    const after = runBeginning(state);
    expect(after.players[0]!.trash).toHaveLength(1);
  });
});

describe("only the ACTIVE player's Temporary permanents die", () => {
  it("spares the opponent's until their own Beginning Phase", () => {
    // This is what makes giving an ENEMY unit [Temporary] (Fading Memories)
    // delayed removal rather than instant removal.
    const mine = temporaryUnit({ name: "Mine" });
    const theirs = temporaryUnit({ name: "Theirs" });
    const state = beginningState();
    state.players[0]!.baseUnits = [mine];
    state.players[1]!.baseUnits = [theirs];

    const after = runBeginning(state);

    expect(after.players[0]!.baseUnits).toHaveLength(0);
    expect(after.players[1]!.baseUnits.map((u) => u.name)).toEqual(["Theirs"]);
  });

  it("kills the other player's on THEIR Beginning Phase", () => {
    const theirs = temporaryUnit({ name: "Theirs" });
    const state = makeState({ phase: "Beginning", activePlayerIndex: 1 });
    state.players[1]!.baseUnits = [theirs];

    const after = runBeginning(state);

    expect(after.players[1]!.baseUnits).toHaveLength(0);
  });
});

describe("the ordering that makes the keyword mean anything", () => {
  it("a lone Temporary unit at a battlefield you control does NOT score a hold", () => {
    // Rule 816 says "before scoring". If the kill ran after scoreHolds, this unit
    // would bank a point on the way out every single turn.
    const doomed = temporaryUnit();
    const state = beginningState();
    state.battlefields[0]!.controllerId = "p1";
    state.battlefields[0]!.units = { p1: [doomed] };

    const after = runBeginning(state);

    expect(after.players[0]!.points).toBe(0);
    expect(after.players[0]!.scoredBattlefieldsThisTurn).toEqual([]);
  });

  it("a NON-Temporary unit in the same spot does score it, so the test above isn't vacuous", () => {
    const keeper = makeUnit();
    const state = beginningState();
    state.battlefields[0]!.controllerId = "p1";
    state.battlefields[0]!.units = { p1: [keeper] };

    const after = runBeginning(state);

    expect(after.players[0]!.points).toBeGreaterThan(0);
  });
});

describe("a Temporary death is a real death", () => {
  it("fires the unit's [Deathknell] (rule 808)", () => {
    // Soaring Scout — "[Deathknell] Channel 1 rune exhausted." Dying to Temporary
    // is dying, so routing through destroyUnit rather than a bespoke removal is
    // what makes this work.
    const registry = defaultCardRegistry();
    const scout = createCardInstance(registry.get("OGN-216")) as UnitInstance;
    const doomedScout: UnitInstance = { ...scout, keywords: { ...scout.keywords, Temporary: 1 } };

    const state = makeState({
      phase: "Beginning",
      activePlayerIndex: 0,
      players: [
        makePlayer("p1", {
          baseUnits: [doomedScout],
          runeDeck: [{ id: "rd1", domain: "Order", state: "Ready" }],
        }),
        makePlayer("p2"),
      ],
    });
    const before = state.players[0]!.channeled.length;

    // Settled: the [Deathknell] is a Chain Pending Item, so the sweep places it
    // and the channel lands a chain-pop later.
    const after = resolveHeldTriggers(runBeginning(state));

    expect(after.players[0]!.baseUnits).toHaveLength(0);
    expect(after.players[0]!.channeled).toHaveLength(before + 1);
    expect(after.players[0]!.channeled.at(-1)!.state).toBe("Exhausted");
  });
});
