import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { giveMightThisTurn } from "../src/engine/effect-helpers.js";
import { EFFECT_SOURCES } from "../src/engine/effects/index.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * **Vendetta's dual-domain spell block, wave 4 — the last two, and the FIFTH
 * signature file.**
 *
 * VEN-156 Lightning Rush is Chaos+Order: the pool's first card whose two domains
 * are BOTH later than Body, so it is the first that `effects/signature-chaos.ts`
 * could hold. That file was predicted by name when the dual-domain block was
 * split four ways — "those files are not created until a card needs them" — and
 * this is the card that needed it.
 *
 * VEN-154 Public Execution brings the block's one genuinely new targeting axis:
 * `secondMightBelowFirst`, a RELATION between two chosen units rather than a
 * bound on one. It has to live on the spec, because a card whose pairing cannot
 * be satisfied must be uncastable (355.8) — a resolver that refused would leave
 * the card paid for and doing nothing.
 */

const registry = defaultCardRegistry();

const PUBLIC_EXECUTION = "VEN-154"; // Body+Order Spell, 2 Energy 1 Power
const LIGHTNING_RUSH = "VEN-156"; // Chaos+Order Spell, 1 Energy
const A_SPELL = "OGN-004";
const A_UNIT = "OGN-003";

const runes = (n = 12): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, domain: "Order", state: "Ready" }) as RuneCard);

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const playsFor = (state: GameState, defId: string) =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === defId);

/** Drives a closed chain to empty, stopping at a parked question. A Spell
 *  RESOLVES on a chain pop, not when it is submitted. */
function settle(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 12 && current.spellChain.length > 0; guard += 1) {
    if (current.pendingDecisions.length > 0) return current;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    expect(pass, "nobody could pass on the chain").toBeDefined();
    current = accept(current, pass!);
  }
  return current;
}

const unitOnBoard = (state: GameState, instanceId: string) =>
  [
    ...state.players.flatMap((p) => p.baseUnits),
    ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
  ].find((u) => u.instanceId === instanceId);

describe("both report implemented, and the fifth signature file is registered", () => {
  it("is what the rest of this file is about", () => {
    for (const id of [PUBLIC_EXECUTION, LIGHTNING_RUSH]) {
      expect(isCardImplemented(registry.get(id)), `${id} is not implemented`).toBe(true);
    }
  });

  it("has signature-chaos.ts in EFFECT_SOURCES", () => {
    // The premise for Lightning Rush working at all: a new effects file that is
    // written but never listed reads exactly like a card nobody implemented —
    // `mergeRegistries` simply never sees it, and coverage reports the card
    // inert. Asserted rather than assumed because this is the first new effects
    // file in five sets.
    expect(
      EFFECT_SOURCES.map((s) => s.name),
      "signature-chaos.ts was written but never registered",
    ).toContain("effects/signature-chaos.ts");
  });
});

describe("Public Execution (VEN-154): a Might RELATION between two targets", () => {
  /** p0 has friendlies of the given Mights at bf1, p1 has enemies of theirs. */
  function board(friendlies: number[], enemies: number[]) {
    const spell = spellInstance(PUBLIC_EXECUTION);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runes();
    state.battlefields[0]!.units = {
      p1: friendlies.map((might, i) => makeUnit({ instanceId: `mine-${i}`, might })),
      p2: enemies.map((might, i) => makeUnit({ instanceId: `theirs-${i}`, might })),
    };
    return { state, spellId: spell.instanceId };
  }

  const pairs = (state: GameState) =>
    playsFor(state, PUBLIC_EXECUTION).map((a) => `${a.targetUnitInstanceId}>${a.secondTargetUnitInstanceId}`);

  it("kills an enemy smaller than the friendly it names", () => {
    const { state } = board([5], [3]);
    const play = playsFor(state, PUBLIC_EXECUTION)[0];
    expect(play, "no pairing was offered").toBeDefined();

    const after = settle(accept(state, play!));
    expect(unitOnBoard(after, "theirs-0"), "the enemy survived").toBeUndefined();
    // The friendly was named as a measuring stick and nothing happens to it — the
    // card says "choose", not "exhaust" or "kill".
    expect(unitOnBoard(after, "mine-0"), "the friendly was consumed").toBeDefined();
    expect(unitOnBoard(after, "mine-0")?.damage, "the friendly took damage").toBe(0);
  });

  it("refuses a TIE — 'less Might than it' is strict", () => {
    // The tie is the whole price of a 2-Energy unconditional kill: this card
    // cannot trade evenly, let alone upward. An off-by-one here turns it into a
    // different and much stronger card.
    const { state } = board([4], [4]);
    expect(state.battlefields[0]!.units.p2, "the fixture put no enemy on the board").toHaveLength(1);
    expect(playsFor(state, PUBLIC_EXECUTION), "an equal-Might enemy was offered").toEqual([]);
  });

  it("offers only the pairings that fit, on a mixed board", () => {
    // 5 and 2 on my side, 4 and 1 on theirs: the 5 reaches both, the 2 reaches
    // only the 1. Naming the whole set is what catches a filter that is applied
    // to the wrong slot — a reversed comparison passes any single-pair test.
    const { state } = board([5, 2], [4, 1]);
    expect(pairs(state).sort()).toEqual(["mine-0>theirs-0", "mine-0>theirs-1", "mine-1>theirs-1"].sort());
  });

  it("is UNCASTABLE when every enemy outweighs every friendly (355.8)", () => {
    const { state } = board([2], [9]);
    expect(playsFor(state, PUBLIC_EXECUTION), "castable with no legal pairing").toEqual([]);
  });

  it("...and with no friendly at all — both halves are required", () => {
    const { state } = board([], [1]);
    expect(playsFor(state, PUBLIC_EXECUTION), "castable with nothing to measure against").toEqual([]);
  });

  it("reads EFFECTIVE Might, so a pump this turn opens a bigger kill", () => {
    // 143.2's "current Might". A printed-Might read would leave this pairing
    // illegal, which is the mutant this asserts against.
    const { state } = board([3], [5]);
    expect(playsFor(state, PUBLIC_EXECUTION), "the pairing was legal before the pump").toEqual([]);

    const pumped = giveMightThisTurn(state, "mine-0", 3); // 3 -> 6, over the 5
    expect(playsFor(pumped, PUBLIC_EXECUTION).length, "the pump did not open the kill").toBeGreaterThan(0);
  });

  it("reaches a BASE on either side — no location word is printed", () => {
    // 355.9.a.1 widens both bare nouns to the Board and 198.1 puts the Bases on
    // it, which is the difference between this and every "kill a unit at a
    // battlefield" in the pool.
    const { state } = board([], []);
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "mine-home", might: 6 })];
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "theirs-home", might: 2 })];

    expect(pairs(state), "a base-to-base pairing was not offered").toContain("mine-home>theirs-home");
  });

  it("REFUSES a hand-built pairing that breaks the relation", () => {
    // The validator's own site. Everything above drives `legalActions` and so can
    // only see the offer; a client is not obliged to have asked, and a relation
    // enforced on one side only is this codebase's most-repeated bug.
    const { state } = board([5, 2], [4]);
    const legal = playsFor(state, PUBLIC_EXECUTION).find((a) => a.targetUnitInstanceId === "mine-0");
    expect(legal, "the legal pairing was not offered").toBeDefined();

    const forged = { ...legal!, targetUnitInstanceId: "mine-1" }; // 2 Might, under the enemy's 4
    const { result } = submit(state, forged as never);
    expect(result, "a hand-built action killed a bigger unit").not.toMatchObject({ type: "Ok" });
  });
});

describe("Lightning Rush (VEN-156): look at 3, draw one, trash the rest", () => {
  function board() {
    const spell = spellInstance(LIGHTNING_RUSH);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runes();
    state.players[0]!.deck = [
      realUnitInstance(A_UNIT),
      spellInstance(A_SPELL),
      realUnitInstance(A_UNIT),
      // A fourth, DEEPER than the three looked at — the control that says the
      // question is bounded by the card's number rather than by the deck.
      spellInstance(A_SPELL),
    ];
    state.players[0]!.deck.forEach((c, i) => {
      c.instanceId = `deck-${i}`;
    });
    return { state, spellId: spell.instanceId };
  }

  const askedState = (state: GameState) => settle(accept(state, playsFor(state, LIGHTNING_RUSH)[0]!));

  /** The trash, filtered to cards that came out of the DECK — the Rush itself is
   *  filed there when it is played, and counting it would make every assertion
   *  below one card wrong for a reason that has nothing to do with the card. */
  const trashedFromDeck = (state: GameState) =>
    state.players[0]!.trash
      .map((c) => c.instanceId)
      .filter((id) => id.startsWith("deck"))
      .sort();

  const answer = (state: GameState, optionId: string): GameState => {
    const pending = pendingDecision(state);
    expect(pending, "no question was parked").toBeDefined();
    return accept(state, {
      type: "AnswerDecision",
      playerIndex: pending!.playerIndex,
      decisionId: pending!.id,
      optionId,
    });
  };

  it("asks about the top THREE, and nothing deeper", () => {
    const asked = askedState(board().state);
    const pending = pendingDecision(asked);
    expect(pending, "no question was parked").toBeDefined();

    const ids = optionsFor(asked, pending!).map((o) => o.id);
    expect(ids, "the decline was not offered — 'you MAY choose'").toContain("decline");
    expect(ids.filter((id) => id.startsWith("deck")).sort(), "the wrong cards were offered").toEqual([
      "deck-0",
      "deck-1",
      "deck-2",
    ]);
  });

  it("draws the chosen card and trashes the other two", () => {
    const asked = askedState(board().state);
    const after = answer(asked, "deck-1");

    expect(after.players[0]!.hand.map((c) => c.instanceId), "the chosen card did not reach the hand").toEqual(["deck-1"]);
    // Filtered to the deck's own cards: `execute-play-card` files a SPELL in its
    // caster's trash the moment it is played, so the Rush itself is sitting
    // there too and an unfiltered assertion would be measuring that as well.
    expect(trashedFromDeck(after), "the rest did not reach the trash").toEqual(["deck-0", "deck-2"]);
    // The fourth card was never looked at and must still be on top.
    expect(after.players[0]!.deck.map((c) => c.instanceId), "the deck below the top 3 was disturbed").toEqual([
      "deck-3",
    ]);
  });

  it("...and it is a real DRAW, not a hand-move", () => {
    // The card says "draw it", where Stacked Deck says "put 1 into your hand" —
    // and the difference is everything watching a draw. Asserted through the
    // counter the draw funnel keeps, which a hand-rolled move would not touch.
    const { state } = board();
    const before = state.players[0]!.cardsDrawnThisTurn;
    const after = answer(askedState(state), "deck-0");
    expect(after.players[0]!.cardsDrawnThisTurn - before, "nothing was recorded as drawn").toBe(1);
  });

  it("trashes ALL THREE when the draw is declined", () => {
    // Declining is not a no-op: the three still go. Which is occasionally the
    // point in a set built on [Flow] and Last Rites.
    const after = answer(askedState(board().state), "decline");

    expect(after.players[0]!.hand, "a card was drawn after declining").toHaveLength(0);
    expect(trashedFromDeck(after), "the three did not reach the trash").toEqual(["deck-0", "deck-1", "deck-2"]);
    expect(after.players[0]!.deck.map((c) => c.instanceId), "the untouched card moved").toEqual(["deck-3"]);
  });

  it("ignores a forged answer naming a card deeper than the top 3", () => {
    // A client is not obliged to pick from the list it was shown. Naming the
    // fourth card must reach nothing — the alternative is a spell that draws any
    // card from anywhere in the deck.
    const asked = askedState(board().state);
    const pending = pendingDecision(asked)!;
    const { state: after } = submit(asked, {
      type: "AnswerDecision",
      playerIndex: pending.playerIndex,
      decisionId: pending.id,
      optionId: "deck-3",
    } as never);

    expect(after.players[0]!.hand.map((c) => c.instanceId), "a card from below the top 3 was drawn").not.toContain(
      "deck-3",
    );
  });
});
