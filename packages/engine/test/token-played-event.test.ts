import { describe, expect, it } from "vitest";
import { placeToken, placeGoldTokens, RECRUIT_TOKEN } from "../src/engine/token.js";
import { holdEventTrigger } from "../src/engine/triggers.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { makeState, realUnitInstance, resolveHeldTriggers, answerDecisions } from "./fixtures.js";

/**
 * **A token being put onto the board is a PLAY, and it is not the playing of a
 * card.** Those are two different sentences in the rules and this engine used to
 * collapse them by firing nothing at all.
 *
 *   - **185**: "Tokens are not cards." **185.1.a**: a token cannot lose that
 *     nature by any means.
 *   - **350.2**: "Tokens are not cards, but can still be Played."
 *   - **185.2.a**: "Tokens can be played by their owner if their card type is
 *     played, following all the applicable steps for playing a card plus any
 *     restrictions or modifications from the effect that created the token."
 *
 * So "when you play a UNIT" must fire for a token unit, "when you play a GEAR"
 * must fire for a Gold token, and "when you play a CARD" must NOT fire for
 * either. Before 2026-08-10 `placeToken` and `placeGearToken` held no event, so
 * both readings produced the same board: nothing happened. That made the
 * card-reading listeners accidentally correct and silently narrowed every
 * unit-reading one.
 *
 * # Why this file is the only thing watching
 *
 * The event carries `isToken`, and a listener that FORGETS to check it does not
 * go quiet — it wrongly fires. That is the opposite of the failure mode the
 * required-field convention in triggers.ts defends against, and the compiler
 * cannot see it. Every card-reading listener is therefore named here
 * individually, so adding a new one without the gate fails in a file that says
 * why rather than somewhere far away.
 *
 * **Viktor is the proof this is not theoretical.** He makes a Recruit token, so
 * the first build that emitted the event without gating him LOOPED: two existing
 * tests failed with "the chain never reopened".
 */

const registry = defaultCardRegistry();

const CITHRIA = "OGN-139"; // "When you play another unit, buff me" — must SEE a token unit
const PIT_CREW = "OGN-091"; // "When you play a gear, ready me" — must SEE a Gold token
const VIKTOR = "OGN-117"; // "...a CARD on an opponent's turn" — must NOT see a token, and makes one
const DARIUS = "OGN-027"; // "...your second CARD in a turn" — must NOT see a token

const findUnit = (state: GameState, instanceId: string): UnitInstance | undefined =>
  [
    ...state.players[0]!.baseUnits,
    ...state.players[1]!.baseUnits,
    ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
  ].find((u) => u.instanceId === instanceId);

/** `listener` in player 0's base, and nothing else going on. */
function withListener(defId: string, overrides: Partial<UnitInstance> = {}): { state: GameState; listener: UnitInstance } {
  const listener = { ...realUnitInstance(defId), ...overrides };
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.baseUnits = [listener];
  return { state, listener };
}

/** Drains the holding pen the way a real Cleanup would. */
const settle = (state: GameState): GameState => answerDecisions(resolveHeldTriggers(state));

describe("a token unit is PLAYED — 185.2.a — so unit-readers must see it", () => {
  it("Cithria of Cloudfield is buffed by a Recruit token entering her base", () => {
    // The card says "another UNIT", not "another card". A token unit is a unit
    // being played, so this is the reading 185.2.a requires.
    const { state, listener } = withListener(CITHRIA);
    const settled = settle(placeToken(state, 0, "base", RECRUIT_TOKEN));

    expect(findUnit(settled, listener.instanceId)!.buffed, "a token unit did not count as a unit being played").toBe(true);
  });

  it("...and she is not buffed when nothing is played — the fixture's own control", () => {
    // Without this, "she is buffed" could pass on a build that buffs her at any
    // Cleanup, which is a different bug wearing the same result.
    const { state, listener } = withListener(CITHRIA);
    const settled = settle(state);

    expect(findUnit(settled, listener.instanceId)!.buffed, "Cithria buffed herself with nothing played").toBe(false);
  });

  it("Pit Crew is readied by a GOLD GEAR token — the same rule, the other card type", () => {
    // `placeGearToken` is a separate path from `placeToken` and had the identical
    // silence. Asserted separately because fixing one would not fix the other.
    const { state, listener } = withListener(PIT_CREW, { exhausted: true });
    const settled = settle(placeGoldTokens(state, 0, 1));

    expect(findUnit(settled, listener.instanceId)!.exhausted, "a Gold gear token did not count as a gear being played").toBe(
      false,
    );
  });

  it("Pit Crew stays exhausted when no gear arrives", () => {
    const { state, listener } = withListener(PIT_CREW, { exhausted: true });
    expect(findUnit(settle(state), listener.instanceId)!.exhausted).toBe(true);
  });
});

describe("a token is NOT a card — 185 — so card-readers must refuse it", () => {
  it("Viktor - Innovator does not fire on a token played on an opponent's turn", () => {
    // He reads "a CARD on an opponent's turn". Player 1 is active, player 0 owns
    // Viktor, so every condition EXCEPT cardness is satisfied — which is what
    // makes this a test of `isToken` rather than of the other two clauses.
    const { state } = withListener(VIKTOR);
    state.activePlayerIndex = 1;
    const before = state.players[0]!.baseUnits.length;

    const settled = settle(placeToken(state, 0, "base", RECRUIT_TOKEN));

    // One new unit: the token itself. A second would be Viktor's own Recruit.
    expect(settled.players[0]!.baseUnits.length, "Viktor made a Recruit for a token play").toBe(before + 1);
  });

  it("...and he DOES fire for a real card in the same window — the positive control", () => {
    // The half that makes the negative above meaningful: with cardness the only
    // difference, this proves the fixture really is a Viktor-firing situation.
    const { state } = withListener(VIKTOR);
    state.activePlayerIndex = 1;
    const before = state.players[0]!.baseUnits.length;

    // Fire the event by hand as a real CARD, which is the one thing a token
    // cannot be. Everything else on the event is identical to the token's, so
    // `isToken` is the only variable between this test and the one above.
    const asCard = settle(
      holdEventTrigger(state, {
        kind: "cardPlayed",
        casterIndex: 0,
        playedKind: "Unit",
        playedInstanceId: "some-real-card",
        playedPowerCost: 0,
        isToken: false,
      }),
    );

    expect(asCard.players[0]!.baseUnits.length, "Viktor ignored a real card too — the fixture proves nothing").toBe(
      before + 1,
    );
  });

  it("Viktor does not LOOP on the token he himself makes", () => {
    // The regression that actually happened. His token holds `cardPlayed`; if he
    // saw it he would make another, and `resolveHeldTriggers` would never drain.
    // Two tests in event-triggers.test.ts failed with "the chain never reopened"
    // on the first build that emitted this event.
    const { state } = withListener(VIKTOR);
    state.activePlayerIndex = 1;

    const settled = settle(
      holdEventTrigger(state, {
        kind: "cardPlayed",
        casterIndex: 0,
        playedKind: "Spell",
        playedInstanceId: "a-real-spell",
        playedPowerCost: 0,
        isToken: false,
      }),
    );

    // Exactly one Recruit: he fired once for the real card and not at all for the
    // token that firing created.
    expect(settled.players[0]!.baseUnits.filter((u) => u.isToken).length, "Viktor recursed on his own token").toBe(1);
  });

  it("Darius - Trifarian is not fired by a token, whose play does not count a card", () => {
    // "Your SECOND card in a turn", read off `cardsPlayedThisTurn` — which counts
    // CARDS and is not incremented by a token. Without the gate his `=== 2` would
    // be asked at a moment the counter had not moved, firing him on the wrong card.
    const { state, listener } = withListener(DARIUS);
    state.players[0]!.cardsPlayedThisTurn = 2;

    const settled = settle(placeToken(state, 0, "base", RECRUIT_TOKEN));

    expect(findUnit(settled, listener.instanceId)!.mightThisTurn, "a token counted as Darius's second card").toBe(0);
  });
});
