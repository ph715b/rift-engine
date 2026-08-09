import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { runEnd, runStartOfTurn } from "../src/engine/turn-manager.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * Banish — and the distinction the pool turns on.
 *
 * Almost every "banish" in this set is TRANSIENT: the card is banished and
 * replayed in ONE instruction, with no window in which anything could observe the
 * middle zone. Those go straight to play and never touch
 * `PlayerState.banished` at all.
 *
 * **Time Warp is the exception and the zone's first real writer.** "Banish this"
 * is what stops the spell being recurred out of a trash for a second extra turn,
 * so it is the one place the card has to actually stay there.
 */

const registry = defaultCardRegistry();
const PORTAL_RESCUE = "OGN-102"; // "Banish a friendly unit, then its owner plays it to their base, ignoring its cost."
const TIME_WARP = "OGN-122"; // "Take a turn after this one. Banish this."
const DAZZLING_AURORA = "OGN-160"; // endOfTurn: reveal until a unit, banish it, play it free, recycle the rest

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const playsFor = (state: GameState, defId: string) =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === defId);

/** Casts the one card in hand and resolves the chain.
 *
 *  Takes ONE state and reuses it — an earlier version called the fixture twice,
 *  once for the state and once for the enumeration, so the action named a card
 *  instance that was not in the hand it was submitted against. The engine said
 *  so plainly ("not in p1's hand"), which is the only reason it took one run. */
function castAndResolve(state: GameState, defId: string): GameState {
  const play = playsFor(state, defId)[0];
  expect(play, `${defId} was not castable`).toBeDefined();
  return resolveChain(accept(state, play!));
}

/** Resolves a closed chain by passing until it empties. */
function resolveChain(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 12 && current.spellChain.length > 0; guard += 1) {
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    expect(pass, "nobody could pass on the chain").toBeDefined();
    current = accept(current, pass!);
  }
  return current;
}

describe("Portal Rescue (OGN-102): a blink", () => {
  /** A damaged, buffed unit at bf1 and Portal Rescue in hand. */
  function rescueState(): GameState {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = {
      p1: [makeUnit({ instanceId: "hurt", might: 5, damage: 3, buffed: true, mightThisTurn: 2, exhausted: true })],
    };
    state.players[0]!.hand = [spellInstance(PORTAL_RESCUE)];
    state.players[0]!.channeled = Array.from({ length: 8 }, (_, i) => rune(`m${i}`, "Mind"));
    return state;
  }

  it("takes the unit off the board and puts a FRESH copy in base", () => {
    // Leaving play is the point of the card: 705 strips the Buff, and damage and
    // this-turn Might are properties of the body that left. A relocation would
    // have kept all three, and looked identical on the board.
    const settled = castAndResolve(rescueState(), PORTAL_RESCUE);

    expect(settled.battlefields[0]!.units["p1"] ?? [], "the unit is still at the battlefield").toHaveLength(0);
    const back = settled.players[0]!.baseUnits.find((u) => u.instanceId === "hurt");
    expect(back, "the unit did not come back").toBeDefined();
    expect(back!.damage).toBe(0);
    expect(back!.buffed).toBe(false);
    expect(back!.mightThisTurn).toBe(0);
  });

  it("does NOT leave the unit in the banished zone — the banish is transient", () => {
    const settled = castAndResolve(rescueState(), PORTAL_RESCUE);
    expect(settled.players[0]!.banished).toHaveLength(0);
  });

  it("counts as a real PLAY, so a cardPlayed listener sees it", () => {
    // "Its owner PLAYS it" — the whole reason this goes through `playUnitToBase`
    // rather than a zone move. Driven through Cithria, who watches for another
    // unit being played.
    const state = rescueState();
    state.battlefields[0]!.units = { p1: [...state.battlefields[0]!.units["p1"]!, realUnitInstance("OGN-139")] };

    const played = castAndResolve(state, PORTAL_RESCUE);
    const settled = resolveHeldTriggers(played);
    const cithria = [...settled.players[0]!.baseUnits, ...settled.battlefields.flatMap((b) => b.units["p1"] ?? [])].find(
      (u) => u.defId === "OGN-139",
    );
    expect(cithria!.buffed, "the replayed unit was invisible to a cardPlayed listener").toBe(true);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(PORTAL_RESCUE))).toBe(true);
  });
});

describe("Time Warp (OGN-122): take a turn after this one", () => {
  function warpState(): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spellInstance(TIME_WARP)];
    state.players[0]!.channeled = Array.from({ length: 20 }, (_, i) => rune(`m${i}`, "Mind"));
    return state;
  }

  it("hands the turn back to the same player instead of rotating", () => {
    const cast = castAndResolve(warpState(), TIME_WARP);
    expect(cast.extraTurns, "the extra turn was never queued").toBe(1);

    const next = runEnd(cast);
    expect(next.activePlayerIndex, "the turn rotated anyway").toBe(0);
    expect(next.extraTurns, "the queued turn was not spent").toBe(0);
  });

  it("does not advance the turn NUMBER — a round is complete when play returns to the first player", () => {
    const cast = castAndResolve(warpState(), TIME_WARP);
    expect(runEnd(cast).turnNumber).toBe(cast.turnNumber);
  });

  it("rotates normally on the turn AFTER the extra one", () => {
    // The positive control for the negative above: without it, "did not rotate"
    // would be equally true of a rotation that had broken entirely.
    const cast = castAndResolve(warpState(), TIME_WARP);
    const extra = runStartOfTurn(runEnd(cast));
    expect(runEnd({ ...extra, phase: "Action" }).activePlayerIndex).toBe(1);
  });

  it("BANISHES itself — the zone's first real writer", () => {
    // Without this the spell sits in the trash, where Spectral Matron and
    // Immortal Phoenix can fetch it for an unbounded chain of extra turns.
    const cast = castAndResolve(warpState(), TIME_WARP);

    expect(cast.players[0]!.banished.map((c) => c.defId)).toEqual([TIME_WARP]);
    expect(cast.players[0]!.trash.some((c) => c.defId === TIME_WARP), "it is in BOTH zones").toBe(false);
  });

  it("stacks — two casts are two extra turns", () => {
    const cast = castAndResolve(warpState(), TIME_WARP);
    const twice = { ...cast, extraTurns: cast.extraTurns + 1 };

    const first = runEnd(twice);
    expect(first.activePlayerIndex).toBe(0);
    expect(first.extraTurns).toBe(1);
    const second = runEnd({ ...runStartOfTurn(first), phase: "Action" });
    expect(second.activePlayerIndex, "the second extra turn was skipped").toBe(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(TIME_WARP))).toBe(true);
  });
});

describe("Dazzling Aurora (OGN-160): the last endOfTurn card", () => {
  const aurora = (): GearInstance => ({ ...createCardInstance(registry.get(DAZZLING_AURORA)), instanceId: "aurora" }) as GearInstance;

  it("reveals until a unit, plays it free, and recycles the rest", () => {
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [aurora()];
    state.players[0]!.deck = [
      spellInstance("OGN-114"), // a Spell — revealed and recycled
      spellInstance("OGN-114"),
      makeUnit({ instanceId: "found", might: 4 }),
      makeUnit({ instanceId: "deeper", might: 4 }),
    ];

    const settled = resolveHeldTriggers(accept(state, { type: "Pass", playerIndex: 0 }));
    expect(settled.players[0]!.baseUnits.map((u) => u.instanceId), "the revealed unit was not played").toContain("found");
    // The two spells went to the BOTTOM, so the next card up is the one that was
    // below the unit — not one of the recycled pair.
    expect(settled.players[0]!.deck[0]!.instanceId).toBe("deeper");
    expect(settled.players[0]!.banished, "a transient banish must not leave the card behind").toHaveLength(0);
  });

  it("recycles the WHOLE deck and plays nothing when there is no unit", () => {
    // "Reveal until" has no cap, so a deck with no units is revealed entirely.
    // The order still changes, which is why this is a real outcome rather than a
    // no-op — and asserting only "nothing was played" would miss that.
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [aurora()];
    state.players[0]!.deck = [spellInstance("OGN-114"), spellInstance("OGN-123")];
    const before = state.players[0]!.deck.map((c) => c.defId);

    const settled = resolveHeldTriggers(accept(state, { type: "Pass", playerIndex: 0 }));
    expect(settled.players[0]!.baseUnits).toHaveLength(0);
    expect(settled.players[0]!.deck.map((c) => c.defId), "the revealed cards were not recycled").toEqual(before);
  });

  it("does not fire on the OPPONENT's end of turn", () => {
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.players[0]!.activeGear = [aurora()];
    state.players[0]!.deck = [makeUnit({ instanceId: "found", might: 4 })];

    const settled = resolveHeldTriggers(accept(state, { type: "Pass", playerIndex: 1 }));
    expect(settled.players[0]!.baseUnits).toHaveLength(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(DAZZLING_AURORA))).toBe(true);
  });
});
