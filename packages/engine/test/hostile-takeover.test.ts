import { describe, expect, it } from "vitest";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { Domain } from "../src/model/domain.js";
import type { RuneCard } from "../src/model/rune.js";
import { makePlayer, makeState, makeUnit, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * Hostile Takeover (SFD-202) — "[Hidden] Take control of an enemy unit at a
 * battlefield. Ready it. (Start a combat if other enemies are there. Otherwise,
 * conquer.) Lose control of that unit and recall it at end of turn. (Send it to
 * base. This isn't a move.)"
 *
 * # The half that did not exist
 *
 * `takeControlOfUnit` has been here since Possession and is the WRONG half: it
 * recalls the stolen unit to the taker's base, which is what makes a permanent
 * theft safe and is the opposite of this card's parenthetical. What was genuinely
 * missing is the REVERSAL, and the reason is structural rather than an oversight
 * — control in this engine IS which player's list a unit sits in, so a stolen
 * unit is indistinguishable from an owned one and nothing could give it back.
 *
 * So the tests come in three parts: the unit changes hands AND STAYS PUT, the
 * board reacts to it becoming present (a combat or a conquest), and end of turn
 * hands it back.
 *
 * The last is the one worth being careful about: a borrowed unit that is never
 * returned looks completely correct for the turn it was stolen in, and turns the
 * card into Possession-for-5 on every turn after.
 */

const registry = defaultCardRegistry();
const HOSTILE_TAKEOVER = "SFD-202";

const runes = (domain: Domain, n: number): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

/**
 * p1 holds Hostile Takeover and can pay it (5 Energy + 2 Mind Power); p2 has
 * `enemies` units at bf1, the first of them exhausted and named "victim".
 */
function board(enemies = 1): { state: GameState; spellId: string } {
  const spell = spellInstance(HOSTILE_TAKEOVER);
  const state = makeState({
    phase: "Action",
    players: [makePlayer("p1", { hand: [spell], channeled: runes("Mind", 9) }), makePlayer("p2")],
  });
  state.battlefields[0]!.units = {
    p2: Array.from({ length: enemies }, (_, i) =>
      makeUnit({ instanceId: i === 0 ? "victim" : `enemy-${i}`, name: i === 0 ? "Victim" : `Enemy ${i}`, exhausted: i === 0 }),
    ),
  };
  return { state, spellId: spell.instanceId };
}

const cast = (state: GameState, spellId: string): GameState => {
  const play = legalActions(state).find(
    (a): a is PlayCardAction =>
      a.type === "PlayCard" && a.card.instanceId === spellId && a.targetUnitInstanceId === "victim",
  );
  expect(play, "Hostile Takeover was not offered against the victim").toBeDefined();
  return resolveHeldTriggers(executePlayCard(state, play!));
};

const at = (state: GameState, playerIndex: 0 | 1, bfIndex = 0) =>
  state.battlefields[bfIndex]!.units[state.players[playerIndex]!.id] ?? [];

describe("Hostile Takeover: the theft", () => {
  it("moves the unit into the caster's list AT THE SAME BATTLEFIELD", () => {
    // The whole difference from Possession, which recalls to the taker's base.
    const { state, spellId } = board();
    const after = cast(state, spellId);
    expect(at(after, 0).map((u) => u.instanceId)).toContain("victim");
    expect(at(after, 1).map((u) => u.instanceId)).not.toContain("victim");
    expect(after.players[0]!.baseUnits, "it was recalled instead of left standing").toHaveLength(0);
  });

  it("readies it", () => {
    const { state, spellId } = board();
    expect(at(cast(state, spellId), 0).find((u) => u.instanceId === "victim")!.exhausted).toBe(false);
  });

  it("cannot reach a unit in the enemy BASE — 'at a battlefield' is printed", () => {
    const { state, spellId } = board();
    state.battlefields[0]!.units = {};
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "victim", name: "Victim" })];
    const offered = legalActions(state).filter(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === spellId,
    );
    expect(offered.map((p) => p.targetUnitInstanceId)).not.toContain("victim");
  });

  it("records who to give it back to", () => {
    const { state, spellId } = board();
    expect(at(cast(state, spellId), 0).find((u) => u.instanceId === "victim")!.returnControlAtEndOfTurnToIndex).toBe(1);
  });
});

describe("Hostile Takeover: what becoming present does", () => {
  it("CONQUERS when no other enemy is there", () => {
    // "(Otherwise, conquer.)" The battlefield is applied Contested for the
    // caster, and with no opposing unit left standing the Cleanup's Non-Combat
    // Showdown is what establishes control (348.2.a). The card's own instruction is
    // the Contested, so that is what this pins.
    const { state, spellId } = board(1);
    const after = cast(state, spellId);
    expect(after.battlefields[0]!.contestedByIndex, "nothing contested the battlefield").toBe(0);
    expect(at(after, 1), "an enemy was left standing where there should be none").toHaveLength(0);
  });

  it("leaves the other enemies standing, so a COMBAT is what follows", () => {
    // "(Start a combat if other enemies are there.)" Two enemies, one stolen: the
    // battlefield is contested by the caster and both players have units on it,
    // which is the rules' own test for a Combat Showdown (341).
    const { state, spellId } = board(2);
    const after = cast(state, spellId);
    expect(after.battlefields[0]!.contestedByIndex).toBe(0);
    expect(at(after, 0).map((u) => u.instanceId)).toContain("victim");
    expect(at(after, 1).map((u) => u.instanceId)).toEqual(["enemy-1"]);
  });
});

describe("Hostile Takeover: the reversal", () => {
  it("hands the unit back to its owner at end of turn", () => {
    const { state, spellId } = board();
    const ended = runEnd(cast(state, spellId));
    expect(ended.players[1]!.baseUnits.map((u) => u.instanceId)).toContain("victim");
    expect(at(ended, 0).map((u) => u.instanceId)).not.toContain("victim");
  });

  it("sends it to the OWNER's base, not the thief's", () => {
    const { state, spellId } = board();
    const ended = runEnd(cast(state, spellId));
    expect(ended.players[0]!.baseUnits.map((u) => u.instanceId)).not.toContain("victim");
  });

  it("clears the obligation, so it is not handed back a second time", () => {
    const { state, spellId } = board();
    const ended = runEnd(cast(state, spellId));
    const returned = ended.players[1]!.baseUnits.find((u) => u.instanceId === "victim")!;
    expect(returned.returnControlAtEndOfTurnToIndex).toBeUndefined();
  });

  it("leaves units that were never stolen exactly where they are", () => {
    // The control. `returnBorrowedUnits` walks both players' units at every
    // battlefield, so a sweep that read the flag wrongly would empty the board.
    const { state } = board(2);
    state.battlefields[1]!.units = { p1: [makeUnit({ instanceId: "mine", name: "Mine" })] };
    const ended = runEnd(state);
    expect(at(ended, 1).map((u) => u.instanceId)).toEqual(["victim", "enemy-1"]);
    expect(at(ended, 0, 1).map((u) => u.instanceId)).toEqual(["mine"]);
  });

  it("returns a unit stolen by the NON-active player too", () => {
    // The card is [Hidden], so it is cast as a Reaction on the opponent's turn as
    // often as on your own — and the turn that ends is then not the thief's. A
    // sweep scoped to the active player would strand it permanently.
    const { state, spellId } = board();
    const stolen = cast(state, spellId);
    const onTheirTurn = { ...stolen, activePlayerIndex: 1 as const };
    const ended = runEnd(onTheirTurn);
    expect(ended.players[1]!.baseUnits.map((u) => u.instanceId)).toContain("victim");
  });
});

describe("Hostile Takeover: coverage", () => {
  it("reports as implemented", () => {
    expect(isCardImplemented(registry.get(HOSTILE_TAKEOVER))).toBe(true);
  });
});
