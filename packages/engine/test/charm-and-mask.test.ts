import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { cardModeOf } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * Charm and Mask of Foresight — the last two inert cards in the presets.
 *
 * Both look like something that already exists and are not: Charm's move is not a
 * Standard Move, and Mask's "alone" bonus is not Wielder of Water's. Each test
 * below is really about that distinction.
 */

const registry = defaultCardRegistry();
const CHARM = "OGN-043";
const MASK_OF_FORESIGHT = "OGN-060";

const resolveCharm = (state: GameState, targetUnitInstanceId: string, destinationBattlefieldId: string) =>
  cardModeOf(spellInstance(CHARM), undefined)!.resolve(state, contextFor(0), { targetUnitInstanceId, destinationBattlefieldId });

describe("Charm (OGN-043): move an enemy unit", () => {
  /** An enemy unit at bf1, mine nowhere. */
  function charmState(): { state: GameState; enemy: UnitInstance } {
    const enemy = makeUnit({ name: "Enemy" });
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p2: [enemy] };
    state.battlefields[0]!.controllerId = "p2";
    return { state, enemy };
  }

  it("moves the enemy unit to the named battlefield", () => {
    const { state, enemy } = charmState();

    const after = resolveCharm(state, enemy.instanceId, "bf2");

    expect(after.battlefields[0]!.units["p2"] ?? []).toHaveLength(0);
    expect(after.battlefields[1]!.units["p2"]!.map((u) => u.name)).toEqual(["Enemy"]);
  });

  it("does NOT exhaust it — the exhaust is the Standard Move's cost (415.1.b)", () => {
    // The distinction that stopped this reusing executeMoveUnit. 415.1.b: "a
    // unit's Standard Move exhausts the unit AS A COST", and 316.7.c lists a move
    // as possibly the result of a Spell. Exhausting here would quietly turn a
    // reposition into a reposition-and-tap the card never offers.
    const { state, enemy } = charmState();

    const after = resolveCharm(state, enemy.instanceId, "bf2");

    expect(after.battlefields[1]!.units["p2"]![0]!.exhausted).toBe(false);
  });

  it("contests the destination for the MOVED unit's controller (458)", () => {
    // "not controlled by the controller of the Unit or Units that moved" — so
    // charming an enemy onto neutral ground contests it for THEM, not for me.
    // A caster-indexed call would have got this backwards and handed the caster
    // a Showdown they never entered.
    const { state, enemy } = charmState();

    const after = resolveCharm(state, enemy.instanceId, "bf2");

    expect(after.battlefields[1]!.contestedByIndex).toBe(1);
  });

  it("contests nothing when the mover already controls the destination", () => {
    const { state, enemy } = charmState();
    state.battlefields[1]!.controllerId = "p2";

    const after = resolveCharm(state, enemy.instanceId, "bf2");

    expect(after.battlefields[1]!.contestedByIndex).toBeNull();
  });

  it("reaches a unit in the enemy's BASE, which names no battlefield to leave", () => {
    const inBase = makeUnit({ name: "Homebody" });
    const state = makeState({ phase: "Action" });
    state.players[1]!.baseUnits = [inBase];

    const after = resolveCharm(state, inBase.instanceId, "bf1");

    expect(after.players[1]!.baseUnits).toHaveLength(0);
    expect(after.battlefields[0]!.units["p2"]!.map((u) => u.name)).toEqual(["Homebody"]);
  });

  it("no-ops on a unit that has left play, and on a destination it is already at", () => {
    const { state, enemy } = charmState();
    expect(resolveCharm(state, "gone", "bf2")).toBe(state);
    expect(resolveCharm(state, enemy.instanceId, "bf1")).toBe(state);
  });

  it("is enumerated with a destination, and refused without one", () => {
    const spell = createCardInstance(registry.get(CHARM));
    const enemy = makeUnit({ name: "Enemy" });
    const state = makeState({
      phase: "Action",
      players: [
        makePlayer("p1", {
          hand: [spell],
          channeled: Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, domain: "Calm" as const, state: "Ready" as const })),
        }),
        makePlayer("p2"),
      ],
    });
    state.battlefields[0]!.units = { p2: [enemy] };

    const plays = legalActions(state).filter((a) => a.type === "PlayCard" && a.card.instanceId === spell.instanceId);

    expect(plays.length).toBeGreaterThan(0);
    // **Premise updated 2026-08-07**: a base is a Location and so a legal Move
    // Destination (355.7 / 197 / 107.2.b), which the rules work by name at
    // 359.3.e. So "every candidate names a battlefield" is no longer the
    // invariant — "every candidate names EXACTLY ONE destination" is, and it is
    // the stronger of the two: it also catches a variant carrying both.
    const named = (a: (typeof plays)[number]) =>
      (a.type === "PlayCard" && a.destinationBattlefieldId !== undefined ? 1 : 0) +
      (a.type === "PlayCard" && a.destinationIsBase === true ? 1 : 0);
    expect(plays.every((a) => named(a) === 1)).toBe(true);
    expect(plays.some((a) => a.type === "PlayCard" && a.destinationBattlefieldId === "bf1")).toBe(false);
    expect(plays.some((a) => a.type === "PlayCard" && a.destinationIsBase === true), "base was not offered").toBe(true);
    expect(validatePlayCard(state, plays[0]! as never).ok).toBe(true);

    // Neither field set: still not a legal action, which is the half of this
    // test that must survive base becoming legal — a move needs a destination.
    const noDestination = { ...plays[0]!, destinationBattlefieldId: undefined, destinationIsBase: undefined };
    expect(validatePlayCard(state, noDestination as never).ok).toBe(false);
    // BOTH set is malformed and must also be refused.
    const bothDestinations = { ...plays[0]!, destinationBattlefieldId: "bf2", destinationIsBase: true };
    expect(validatePlayCard(state, bothDestinations as never).ok).toBe(false);
  });
});

describe("Mask of Foresight (OGN-060): when a friendly unit attacks or defends alone", () => {
  /** Mask in play for p1, with `mine` units of theirs at bf1 opposite one enemy. */
  function maskState(mine: number): GameState {
    const mask = createCardInstance(registry.get(MASK_OF_FORESIGHT)) as GearInstance;
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [mask];
    state.battlefields[0]!.units = {
      p1: Array.from({ length: mine }, (_, i) => makeUnit({ name: `Mine${i}`, might: 3 })),
      p2: [makeUnit({ name: "Enemy", might: 3 })],
    };
    // Contested by the enemy, so the next Cleanup stages a Combat Showdown here.
    state.battlefields[0]!.contestedByIndex = 1;
    return state;
  }

  const mightOf = (state: GameState, name: string) =>
    state.battlefields[0]!.units["p1"]!.find((u) => u.name === name)!.mightThisTurn;

  // `combatBegan` is a Chain Pending Item now, so the Cleanup that stages the
  // combat only PLACES the gear's ability — these settle the chain before asking
  // what it did. `test/attack-trigger-moment.test.ts` pins the wait itself, and
  // the fact that the buff goes to the unit that was alone rather than to
  // whoever stands first when it resolves.
  it("gives +1 this turn to a unit standing alone when combat begins", () => {
    const after = resolveHeldTriggers(maskState(1));

    expect(after.showdownKind).toBe("Combat");
    expect(mightOf(after, "Mine0")).toBe(1);
  });

  it("gives nothing when two units are there — nobody is alone", () => {
    const after = resolveHeldTriggers(maskState(2));

    expect(after.showdownKind).toBe("Combat");
    expect(mightOf(after, "Mine0")).toBe(0);
    expect(mightOf(after, "Mine1")).toBe(0);
  });

  it("keeps the +1 for the whole turn, even once it is no longer alone", () => {
    // The difference from Wielder of Water's superficially similar text: that one
    // is "WHILE I'm attacking or defending alone" and is re-derived continuously;
    // this is granted once and stays. A reinforcement arriving later must not
    // silently take it back.
    const after = resolveHeldTriggers(maskState(1));
    const reinforced = {
      ...after,
      battlefields: after.battlefields.map((bf, i) =>
        i === 0 ? { ...bf, units: { ...bf.units, p1: [...bf.units["p1"]!, makeUnit({ name: "Late", might: 3 })] } } : bf,
      ),
    };

    expect(mightOf(reinforced, "Mine0")).toBe(1);
    expect(effectiveMight(reinforced, reinforced.battlefields[0]!.units["p1"]![0]!, 0, { isCombat: true, battlefieldId: "bf1" })).toBe(4);
  });

  it("does not fire for a NON-combat Showdown, where nobody attacks or defends", () => {
    const state = maskState(1);
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Mine0", might: 3 })] }; // no opponent
    state.battlefields[0]!.contestedByIndex = 0;

    const after = resolveHeldTriggers(state);

    expect(after.showdownKind).toBe("NonCombat");
    expect(mightOf(after, "Mine0")).toBe(0);
  });

  it("does nothing for the opponent's lone unit", () => {
    const after = resolveHeldTriggers(maskState(1));
    expect(after.battlefields[0]!.units["p2"]![0]!.mightThisTurn).toBe(0);
  });
});

describe("coverage counts both", () => {
  it("reports them as implemented", () => {
    for (const id of [CHARM, MASK_OF_FORESIGHT]) {
      expect(isCardImplemented(registry.get(id)), `${id} (${registry.get(id).name})`).toBe(true);
    }
  });
});
