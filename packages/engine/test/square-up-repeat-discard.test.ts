import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, spellInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * **Square Up (UNL-017) — a `[Repeat]` priced in CARDS.**
 *
 * "[Repeat] — Discard 1. Give a unit [Assault 4] this turn."
 *
 * `RepeatCostSpec` held Energy, Power and a domain and nothing else, because
 * every other Repeat in the pool is a resource cost. 820.1.c.1 makes the Repeat
 * cost "an Additional Cost to be paid during the steps of playing the spell" and
 * says nothing about what KIND of cost it is.
 *
 * # WHICH card is a real choice
 *
 * Unlike Energy, one card in hand is not interchangeable with another — so the
 * chosen card rides the action and the enumerator fans out one variant per
 * discardable card. That is the same reason `additionalCostUnitInstanceId`
 * exists for a kill-a-unit cost.
 *
 * # This is NOT the multi-instance work
 *
 * Curtain Call and Syndra need `REPEAT_COSTS` to hold a LIST payable
 * individually (820.3). This is one instance whose price happens to be a card,
 * and it was separable — which is why it landed first.
 */

const registry = defaultCardRegistry();
const SQUARE_UP = "UNL-017";
const ASSAULT = 4;

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

/** Square Up in hand with `spare` other cards, and a unit to point at. */
function board(spare: number): { state: GameState; cardId: string } {
  const card = spellInstance(SQUARE_UP);
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.hand = [card, ...Array.from({ length: spare }, () => spellInstance("OGN-004"))];
  state.players[0]!.floatingEnergy = 10;
  state.players[0]!.channeled = Array.from({ length: 8 }, (_, i) => rune(`r${i}`, "Fury"));
  state.players[0]!.baseUnits = [makeUnit({ instanceId: "target", name: "Target", might: 3 })];
  return { state, cardId: card.instanceId };
}

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

describe("the Repeat is offered only when a card can pay for it", () => {
  it("fans out one repeat variant per discardable card", () => {
    const { state, cardId } = board(2);
    const repeats = playsOf(state, cardId).filter((a) => a.repeatPaid === true);

    expect(repeats.length, "no repeat variant was offered at all").toBeGreaterThan(0);
    const discards = new Set(repeats.map((a) => a.repeatDiscardCardInstanceId));
    expect(discards.size, "the repeat did not fan out over the hand").toBe(2);
    expect(discards.has(cardId), "Square Up was offered as its own price").toBe(false);
  });

  it("offers NO repeat when the hand holds nothing else — 204.2.a", () => {
    // The control, and the rule: an additional cost that cannot be paid is not
    // available. Without it, an unpayable repeat would be offered and refused.
    const { state, cardId } = board(0);
    const plays = playsOf(state, cardId);

    expect(plays.length, "the card became uncastable entirely").toBeGreaterThan(0);
    expect(plays.some((a) => a.repeatPaid === true), "a repeat was offered with no card to discard").toBe(false);
  });

  it("the plain play is still offered alongside — 'you MAY pay'", () => {
    const { state, cardId } = board(2);
    expect(
      playsOf(state, cardId).some((a) => a.repeatPaid !== true),
      "paying the repeat became mandatory",
    ).toBe(true);
  });
});

describe("paying it discards the named card and executes twice", () => {
  it("moves the chosen card from hand to trash", () => {
    const { state, cardId } = board(2);
    const repeat = playsOf(state, cardId).find((a) => a.repeatPaid === true)!;
    const discarded = repeat.repeatDiscardCardInstanceId!;

    const after = resolveHeldTriggers(submit(state, repeat).state);
    expect(after.players[0]!.hand.some((c) => c.instanceId === discarded), "the card never left hand").toBe(false);
    expect(after.players[0]!.trash.some((c) => c.instanceId === discarded), "the discard never reached the trash").toBe(
      true,
    );
  });

  it("gives [Assault 4] TWICE — 820.3's additional execution", () => {
    // The payoff, and what separates "the cost was taken" from "the repeat
    // happened". Both executions name the same unit, so the buff stacks.
    const { state, cardId } = board(2);
    const repeat = playsOf(state, cardId).find(
      (a) => a.repeatPaid === true && a.targetUnitInstanceId === "target",
    )!;

    // `[Assault N]` is a this-turn KEYWORD grant carrying a VALUE, not a Might
    // bump — it is worth +N only while the unit is an attacker, which is why it
    // cannot live in `mightThisTurn`. 807.2 makes a second grant an additional
    // source, so the two executions sum rather than one overwriting the other.
    const after = resolveHeldTriggers(submit(state, repeat).state);
    const target = after.players[0]!.baseUnits.find((u) => u.instanceId === "target")!;
    expect(target.keywordsThisTurn["Assault"], "the repeat did not execute a second time").toBe(ASSAULT * 2);
  });

  it("...and ONCE without paying — the control", () => {
    const { state, cardId } = board(2);
    const plain = playsOf(state, cardId).find(
      (a) => a.repeatPaid !== true && a.targetUnitInstanceId === "target",
    )!;

    const after = resolveHeldTriggers(submit(state, plain).state);
    const target = after.players[0]!.baseUnits.find((u) => u.instanceId === "target")!;
    expect(target.keywordsThisTurn["Assault"], "the unpaid play executed twice").toBe(ASSAULT);
    expect(after.players[0]!.trash.length, "an unpaid play discarded something").toBe(1);
  });
});

describe("the validator re-derives the cost", () => {
  it("refuses a repeat that names no discard", () => {
    const { state, cardId } = board(2);
    const repeat = playsOf(state, cardId).find((a) => a.repeatPaid === true)!;
    const forged: PlayCardAction = { ...repeat };
    delete (forged as { repeatDiscardCardInstanceId?: string }).repeatDiscardCardInstanceId;

    expect(validatePlayCard(state, forged).ok, "a free repeat was accepted").toBe(false);
  });

  it("refuses a discard of a card not in hand", () => {
    const { state, cardId } = board(2);
    const repeat = playsOf(state, cardId).find((a) => a.repeatPaid === true)!;
    const forged: PlayCardAction = { ...repeat, repeatDiscardCardInstanceId: "not-in-hand" };

    expect(validatePlayCard(state, forged).ok, "a card the player does not hold paid the cost").toBe(false);
  });

  it("refuses the spell paying for itself", () => {
    const { state, cardId } = board(2);
    const repeat = playsOf(state, cardId).find((a) => a.repeatPaid === true)!;
    const forged: PlayCardAction = { ...repeat, repeatDiscardCardInstanceId: cardId };

    expect(validatePlayCard(state, forged).ok, "Square Up discarded itself to repeat itself").toBe(false);
  });

  it("refuses a discard named on a play that owes none", () => {
    // The other direction: a dropped-field bug looks like a harmless extra until
    // the card it names quietly leaves hand.
    const { state, cardId } = board(2);
    const plain = playsOf(state, cardId).find((a) => a.repeatPaid !== true)!;
    const spare = state.players[0]!.hand.find((c) => c.instanceId !== cardId)!;
    const forged: PlayCardAction = { ...plain, repeatDiscardCardInstanceId: spare.instanceId };

    expect(validatePlayCard(state, forged).ok, "a discard was accepted on a play that owes none").toBe(false);
  });

  it("accepts every variant the enumerator offers", () => {
    const { state, cardId } = board(2);
    const plays = playsOf(state, cardId);
    expect(plays.length, "nothing was enumerated — this test would be vacuous").toBeGreaterThan(1);
    for (const play of plays) {
      expect(validatePlayCard(state, play).ok, `an offered play was refused: ${JSON.stringify(play.repeatPaid)}`).toBe(
        true,
      );
    }
  });
});

describe("coverage", () => {
  it("is whole, with no partial note left", () => {
    expect(isCardImplemented(registry.get(SQUARE_UP)), "Square Up is greyed").toBe(true);
    expect(partialImplementationNote(registry.get(SQUARE_UP)), "it still names a missing half").toBeUndefined();
  });
});
