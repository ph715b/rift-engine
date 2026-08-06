import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { tokensEnterReady } from "../src/engine/board-restrictions.js";
import { RECRUIT_TOKEN, placeGoldTokens, placeToken, type TokenSpec } from "../src/engine/token.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, realUnitInstance } from "./fixtures.js";

/**
 * Renata Glasc - Industrialist (SFD-171) — "Your tokens enter ready."
 *
 * # The ruling this pins, and why it is not the obvious one
 *
 * Sixteen SFD cards print "play a Gold gear token **exhausted**". The intuitive
 * reading — a card's own explicit instruction is more specific than a blanket
 * grant, so it wins — is WRONG, and the rules say so in four steps:
 *
 *  - **149.1** "Gear enter play Ready", so a gear token's default is READY.
 *  - **184.1** lets a token-making effect state a state "contrary to the default
 *    for the token's type". That is the only reason those sixteen print the word.
 *  - **369.3** names Renata's shape a replacement effect (Master Yi, Honed: "the
 *    event of him entering exhausted is replaced by one where he enters ready").
 *  - **375**'s second example ignores a generating-effect modification that
 *    "cannot apply" — hers fixes the entry state, so "exhausted" is ignored.
 *
 * So a ready Gold is the intended payoff. The gear half of this file is the half
 * that would silently regress if someone later "fixed" it back.
 */
const RENATA = "SFD-171";
const registry = defaultCardRegistry();

/** A Sprite — the one existing spec that asks for READY on its own authority,
 *  and so the control for "she is a no-op when nothing needed replacing". */
const SPRITE: TokenSpec = { name: "Sprite", might: 3, tag: "Sprite", entersReady: true };

function board(renataAt: "base" | "battlefield" | "none", forIndex: 0 | 1 = 0): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  if (renataAt === "base") state.players[forIndex]!.baseUnits = [realUnitInstance(RENATA)];
  if (renataAt === "battlefield") {
    const owner = state.players[forIndex]!.id;
    state.battlefields[0] = { ...state.battlefields[0]!, units: { [owner]: [realUnitInstance(RENATA)] } };
  }
  return state;
}

/** The single Gold token `placeGoldTokens` just added for `index`. */
function lastGold(state: GameState, index: 0 | 1) {
  const gear = state.players[index]!.activeGear;
  return gear[gear.length - 1]!;
}

/** The single unit token `placeToken` just added to `index`'s base. */
function lastBaseUnit(state: GameState, index: 0 | 1) {
  const units = state.players[index]!.baseUnits;
  return units[units.length - 1]!;
}

describe("Renata Glasc - Industrialist makes your tokens enter ready", () => {
  it("readies a UNIT token that would otherwise enter exhausted", () => {
    // 359.2.c enters units exhausted, and RECRUIT_TOKEN asks for nothing, so the
    // control here is the default rather than a card's instruction.
    const withHer = placeToken(board("base"), 0, "base", RECRUIT_TOKEN);
    const without = placeToken(board("none"), 0, "base", RECRUIT_TOKEN);
    expect(lastBaseUnit(without, 0).exhausted, "a Recruit entered ready with no Renata out").toBe(true);
    expect(lastBaseUnit(withHer, 0).exhausted, "the Recruit still entered exhausted through her").toBe(false);
  });

  it("readies a GOLD GEAR token despite the card printing \"exhausted\"", () => {
    // The half the intuitive reading gets wrong. `placeGoldTokens` passes
    // `entersExhausted: true` — the generating effect's 184.1 modification — and
    // her replacement effect overrides it under 375.
    const withHer = placeGoldTokens(board("base"), 0, 1);
    const without = placeGoldTokens(board("none"), 0, 1);
    expect(lastGold(without, 0).exhausted, "Gold entered ready with no Renata — the premise is wrong").toBe(true);
    expect(lastGold(withHer, 0).exhausted, "the printed \"exhausted\" beat her replacement effect").toBe(false);
  });

  it("is NOT positional — she works from base and from a battlefield alike", () => {
    // Unlike Tianna Crownguard and the Mageseeker Warden, her text names no
    // battlefield for herself. This is the line that separates the two shapes.
    expect(tokensEnterReady(board("base"), 0), "she did nothing from base").toBe(true);
    expect(tokensEnterReady(board("battlefield"), 0), "she did nothing from a battlefield").toBe(true);
    expect(tokensEnterReady(board("none"), 0)).toBe(false);
  });

  it("reads \"YOUR tokens\" — an opponent's tokens are untouched", () => {
    const state = board("base", 0);
    expect(tokensEnterReady(state, 0)).toBe(true);
    expect(tokensEnterReady(state, 1), "she readied her OPPONENT's tokens").toBe(false);

    // And through the real gate, not just the predicate.
    const opponentGold = placeGoldTokens(state, 1, 1);
    expect(lastGold(opponentGold, 1).exhausted, "the opponent's Gold entered ready").toBe(true);
  });

  it("is a no-op on a token that already asked to enter ready", () => {
    // Sprite Call already says "ready". She must not turn that into anything
    // else — a replacement effect applied to an event that already matches is
    // simply not observable.
    const withHer = placeToken(board("base"), 0, "base", SPRITE);
    const without = placeToken(board("none"), 0, "base", SPRITE);
    expect(lastBaseUnit(without, 0).exhausted).toBe(false);
    expect(lastBaseUnit(withHer, 0).exhausted).toBe(false);
  });

  it("readies EVERY token of a multi-token effect, not just the first", () => {
    // Trove Golem plays four at once; `placeGoldTokens` loops, and a check
    // hoisted out of the loop by a later refactor would still pass a 1-token test.
    const withHer = placeGoldTokens(board("base"), 0, 4);
    const minted = withHer.players[0]!.activeGear.slice(-4);
    expect(minted).toHaveLength(4);
    expect(minted.every((g) => !g.exhausted), "some of the four entered exhausted").toBe(true);
  });

  it("is reported implemented, with no partial note", () => {
    expect(isCardImplemented(registry.get(RENATA))).toBe(true);
    expect(partialImplementationNote(registry.get(RENATA))).toBeUndefined();
  });
});
