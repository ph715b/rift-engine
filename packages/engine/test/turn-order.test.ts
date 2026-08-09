import { describe, expect, it } from "vitest";
import { runChannel, runEnd } from "../src/engine/turn-manager.js";
import { battlefieldPair, chooseMatchBattlefields, pickBattlefield } from "../src/decks/battlefield-setup.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import type { DeckList } from "../src/decks/deck-list.js";
import { makePlayer, makeState } from "./fixtures.js";

/** A rune deck big enough that "2 vs 3 channeled" is never limited by supply. */
function runeDeck(prefix: string): RuneCard[] {
  return Array.from({ length: 6 }, (_, i) => ({ id: `${prefix}-${i}`, domain: "Order" as const, state: "Ready" as const }));
}

function channelState(firstPlayerIndex: 0 | 1, activePlayerIndex: 0 | 1, turnNumber = 1): GameState {
  return makeState({
    players: [
      makePlayer("p1", { runeDeck: runeDeck("p1") }),
      makePlayer("p2", { runeDeck: runeDeck("p2") }),
    ],
    firstPlayerIndex,
    activePlayerIndex,
    turnNumber,
    phase: "Channel",
  });
}

/**
 * Rule 115 picks the First Player by "any fair random method", so either
 * player can start — and two steps used to assume it was always player 0. These
 * cover both seatings; the firstPlayerIndex-0 cases are regression pins that
 * hold today's numbers in place.
 */
describe("going-second Channel bonus follows the First Player, not the seat (rules 485.7 / 486.7)", () => {
  it("gives the extra rune to player 0 when player 1 went first", () => {
    // The case the old `active === 1` test got exactly backwards.
    const next = runChannel(channelState(1, 0));
    expect(next.players[0].channeled).toHaveLength(3);
  });

  it("does NOT give it to player 1 when player 1 went first", () => {
    const next = runChannel(channelState(1, 1));
    expect(next.players[1].channeled).toHaveLength(2);
  });

  it("still gives it to player 1 when player 0 went first", () => {
    const next = runChannel(channelState(0, 1));
    expect(next.players[1].channeled).toHaveLength(3);
  });

  it("never gives it to the player who went first", () => {
    expect(runChannel(channelState(0, 0)).players[0].channeled).toHaveLength(2);
    expect(runChannel(channelState(1, 1)).players[1].channeled).toHaveLength(2);
  });

  it("is a first-turn-only bonus, whoever went first", () => {
    // turnNumber 2: the going-second player is back to the ordinary 2.
    expect(runChannel(channelState(1, 0, 2)).players[0].channeled).toHaveLength(2);
    expect(runChannel(channelState(0, 1, 2)).players[1].channeled).toHaveLength(2);
  });
});

describe("turnNumber advances on wrapping to the First Player (rule 118)", () => {
  const actionState = (firstPlayerIndex: 0 | 1, activePlayerIndex: 0 | 1, turnNumber = 1): GameState =>
    makeState({ firstPlayerIndex, activePlayerIndex, turnNumber, phase: "Action" });

  it("player 1 first: p1 ending turn 1 hands to p0 and the round is still turn 1", () => {
    const next = runEnd(actionState(1, 1));
    expect(next.activePlayerIndex).toBe(0);
    expect(next.turnNumber).toBe(1);
  });

  it("player 1 first: p0 ending hands back to p1 and starts turn 2", () => {
    const next = runEnd(actionState(1, 0));
    expect(next.activePlayerIndex).toBe(1);
    expect(next.turnNumber).toBe(2);
  });

  it("player 0 first: unchanged from before firstPlayerIndex existed", () => {
    expect(runEnd(actionState(0, 0)).turnNumber).toBe(1);
    expect(runEnd(actionState(0, 1)).turnNumber).toBe(2);
  });

  it("keeps the going-second player's first turn on turnNumber 1 for either seating", () => {
    // The two changes have to agree: if the turn counter advanced on the wrong
    // wrap, the going-second player's first Channel would land on turnNumber 2
    // and silently lose the compensation rune even with the Channel test fixed.
    for (const first of [0, 1] as const) {
      const second = first === 0 ? 1 : 0;
      const afterFirstTurn = runEnd(
        makeState({
          players: [makePlayer("p1", { runeDeck: runeDeck("p1") }), makePlayer("p2", { runeDeck: runeDeck("p2") })],
          firstPlayerIndex: first,
          activePlayerIndex: first,
          turnNumber: 1,
          phase: "Action",
        }),
      );
      expect(afterFirstTurn.activePlayerIndex).toBe(second);
      expect(afterFirstTurn.turnNumber).toBe(1);
      const channeled = runChannel({ ...afterFirstTurn, phase: "Channel" }).players[second].channeled;
      expect(channeled).toHaveLength(3);
    }
  });
});

describe("battlefield selection", () => {
  const deck = (names: string[]): DeckList => ({
    name: "d",
    legendId: "L",
    championId: "C",
    cardIds: [],
    runeDomainACount: 6,
    runeDomainBCount: 6,
    battlefieldNames: names,
    sideboardCardIds: [],
  });
  const always = (value: number) => () => value;

  it("battlefieldPair puts the human's choice at bf-0 and the opponent's at bf-1", () => {
    expect(battlefieldPair("Mine", "Theirs")).toEqual([
      { id: "bf-0", name: "Mine", controllerId: null, units: {}, contestedByIndex: null, hiddenCards: [] },
      { id: "bf-1", name: "Theirs", controllerId: null, units: {}, contestedByIndex: null, hiddenCards: [] },
    ]);
  });

  it("pickBattlefield never returns an excluded name (rule 486.5)", () => {
    const names = ["A", "B", "C"];
    // Sweep the whole rng range rather than trusting one draw.
    for (let i = 0; i < 100; i++) {
      const rng = always(i / 100);
      expect(pickBattlefield(names, ["A", "B"], rng)).toBe("C");
      expect(["B", "C"]).toContain(pickBattlefield(names, ["A"], rng));
    }
  });

  it("falls back to the full pool rather than throwing if every name is excluded", () => {
    // Unreachable in a best-of-3 (3 battlefields, at most 3 games), but being
    // unable to present a battlefield must not end a match with an exception.
    expect(["A", "B", "C"]).toContain(pickBattlefield(["A", "B", "C"], ["A", "B", "C"], always(0.5)));
  });

  it("chooseMatchBattlefields honours per-side exclusions independently", () => {
    const pair = chooseMatchBattlefields(deck(["A", "B", "C"]), deck(["X", "Y", "Z"]), always(0), {
      human: ["A"],
      ai: ["X", "Y"],
    });
    expect(pair[0].name).toBe("B");
    expect(pair[1].name).toBe("Z");
  });
});
