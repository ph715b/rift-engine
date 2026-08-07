import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validateHideCard } from "../src/actions/validate-hide-card.js";
import { executeHideCard } from "../src/actions/execute-hide-card.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { chooseAction } from "../src/ai/heuristic-ai.js";
import { hiddenCardAt, hiddenCardIsPlayable, isFacedownPlaceholder, maskHiddenCards } from "../src/engine/hidden.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type CardInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit } from "./fixtures.js";

/**
 * `[Hidden]` — rule 811.
 *
 * Two things the rules keep apart and this suite keeps apart: **Hide** is a
 * Discretionary Action that opens no chain and costs 1 rainbow Power, and
 * **playing from Hidden** is a real play for 0 at Reaction speed, from the turn
 * after, with its targets restricted to that battlefield.
 */

const registry = defaultCardRegistry();
const CONSULT_THE_PAST = "OGN-083"; // [Hidden][Reaction] Draw 2
const FIGHT_OR_FLIGHT = "OGN-168"; // [Hidden][Action] Move a unit from a battlefield to its base
const HIDDEN_BLADE = "OGN-213"; // [Hidden][Action] Kill a unit at a battlefield; its controller draws 2
const STAND_UNITED = "OGN-053"; // [Hidden][Action] Buff a friendly unit; buffs give +1 more this turn
const SPRITE_CALL = "OGN-094"; // [Hidden][Action] Play a ready 3-Might Sprite token with [Temporary]
const card = (defId: string) => createCardInstance(registry.get(defId));

/**
 * A caster holding `held`, controlling bf1 **with a unit garrisoning it**, and
 * runes to pay anything here.
 *
 * The garrison is load-bearing, not scenery. Cleanup step 4 drops control of a
 * battlefield with none of your units on it, and step 5 then trashes any
 * facedown card there — so hiding at an EMPTY battlefield you nominally control
 * loses the card at the very next Cleanup. That is the rules working as written
 * (811 ties the card's life to control, 323 step 4 ties control to occupation),
 * and it is pinned as its own test below.
 */
function hideableState(held: CardInstance, overrides: Partial<GameState> = {}): GameState {
  const state = makeState({
    phase: "Action",
    players: [
      makePlayer("p1", {
        hand: [held],
        channeled: Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, domain: "Fury" as const, state: "Ready" as const })),
        deck: [card("OGN-002"), card("OGN-002"), card("OGN-002")],
      }),
      makePlayer("p2"),
    ],
    ...overrides,
  });
  state.battlefields[0]!.controllerId = "p1";
  state.battlefields[0]!.units = { p1: [makeUnit({ name: "Garrison" })] };
  return state;
}

const hideAction = (state: GameState, c: CardInstance, battlefieldId = "bf1") => {
  const hide = legalActions(state).find(
    (a) => a.type === "HideCard" && a.card.instanceId === c.instanceId && a.battlefieldId === battlefieldId,
  );
  expect(hide, "expected a legal Hide to be enumerated").toBeDefined();
  return hide as Extract<ReturnType<typeof legalActions>[number], { type: "HideCard" }>;
};

describe("Hide is a Discretionary Action, not a play (rule 811)", () => {
  it("costs 1 Power of ANY domain, and never Energy", () => {
    const consult = card(CONSULT_THE_PAST);
    const state = hideableState(consult);
    const hide = hideAction(state, consult);

    expect(hide.payment.energyRunes).toHaveLength(0);
    expect(hide.payment.powerRunes).toHaveLength(1);
    // Fury runes paying a Mind card's hide: the pip is rainbow, so domain is
    // irrelevant — the reason this reuses matchesPowerDomain's null case.
    expect(state.players[0]!.channeled.every((r) => r.domain === "Fury")).toBe(true);
    expect(validateHideCard(state, hide).ok).toBe(true);
  });

  it("puts the card facedown and opens NO chain", () => {
    const consult = card(CONSULT_THE_PAST);
    const state = hideableState(consult);

    const after = executeHideCard(state, hideAction(state, consult));

    expect(hiddenCardAt(after, "bf1", 0)?.card.instanceId).toBe(consult.instanceId);
    expect(after.players[0]!.hand).toHaveLength(0);
    // "Hiding a card does not open a chain" — 811.
    expect(after.spellChain).toHaveLength(0);
    expect(after.chainOpen).toBe(true);
  });

  it("is NOT a play: cardsPlayedThisTurn does not move", () => {
    // "Hide is not a subset of Play" (811). [Legion]'s "if you've played another
    // card this turn" must not count a hidden card.
    const consult = card(CONSULT_THE_PAST);
    const state = hideableState(consult);
    const after = executeHideCard(state, hideAction(state, consult));
    expect(after.players[0]!.cardsPlayedThisTurn).toBe(state.players[0]!.cardsPlayedThisTurn);
  });

  it("is refused at a battlefield you don't control", () => {
    const consult = card(CONSULT_THE_PAST);
    const state = hideableState(consult);
    state.battlefields[1]!.controllerId = "p2";
    const offered = legalActions(state).filter((a) => a.type === "HideCard");
    expect(offered.every((a) => a.type === "HideCard" && a.battlefieldId === "bf1")).toBe(true);

    const forged = { ...hideAction(state, consult), battlefieldId: "bf2" as const };
    expect(validateHideCard(state, forged).ok).toBe(false);
  });

  it("is refused at a battlefield that already holds a facedown card", () => {
    const first = card(CONSULT_THE_PAST);
    const second = card(FIGHT_OR_FLIGHT);
    const state = hideableState(first);
    state.players[0]!.hand.push(second);

    const afterFirst = executeHideCard(state, hideAction(state, first));

    expect(legalActions(afterFirst).filter((a) => a.type === "HideCard")).toHaveLength(0);
  });

  it("is refused on the opponent's turn", () => {
    const consult = card(CONSULT_THE_PAST);
    const state = hideableState(consult, { activePlayerIndex: 1 });
    expect(legalActions(state).filter((a) => a.type === "HideCard")).toHaveLength(0);
  });

  it("is refused for a card without the keyword", () => {
    const plain = card("OGN-002"); // Brazen Buccaneer, no [Hidden]
    const state = hideableState(plain);
    expect(legalActions(state).filter((a) => a.type === "HideCard")).toHaveLength(0);
  });
});

describe("playing from Hidden (rule 811)", () => {
  /** Hide `c` at bf1, then advance to the next turn. */
  function hiddenSinceLastTurn(c: CardInstance): GameState {
    const state = hideableState(c);
    const hidden = executeHideCard(state, hideAction(state, c));
    return { ...hidden, turnNumber: hidden.turnNumber + 1 };
  }

  const fromHiddenPlays = (state: GameState, c: CardInstance) =>
    legalActions(state).filter((a) => a.type === "PlayCard" && a.card.instanceId === c.instanceId);

  it("cannot be played the turn it was hidden, and can the next", () => {
    const consult = card(CONSULT_THE_PAST);
    const state = hideableState(consult);
    const sameTurn = executeHideCard(state, hideAction(state, consult));

    expect(fromHiddenPlays(sameTurn, consult)).toHaveLength(0);

    const nextTurn = { ...sameTurn, turnNumber: sameTurn.turnNumber + 1 };
    expect(fromHiddenPlays(nextTurn, consult).length).toBeGreaterThan(0);
  });

  /**
   * **"The next TURN" is not "the next `turnNumber`".** `turn-manager.runEnd`
   * advances `turnNumber` only when play wraps back to the First Player, so it
   * counts ROUNDS — and the gate used to read `turnNumber > hiddenOnTurn`, which
   * skips the opponent's turn that falls between yours.
   *
   * Since a hidden card is played at REACTION speed, that skipped turn is the
   * single moment it exists to be played in. Reported from play as "I am unable
   * to play cards from hidden — during the AI's turn / in a showdown".
   *
   * The test above hides this by simulating "the next turn" as a `turnNumber`
   * bump, which is the buggy model itself. These ask the question the way the
   * game does.
   */
  it("IS playable on the opponent's turn in the same round — 811's 'next turn'", () => {
    const consult = card(CONSULT_THE_PAST);
    const state = hideableState(consult);
    const hidden = executeHideCard(state, hideAction(state, consult));
    expect(hidden.turnNumber, "hiding must not itself advance the round").toBe(state.turnNumber);

    // Your turn ends; the opponent's begins, and they open a Showdown you hold
    // Focus in. Same ROUND, so `turnNumber` has not moved — but a turn HAS
    // passed, which is what 811 asks about.
    //
    // A Showdown rather than a bare `activePlayerIndex` flip, because on a
    // NEUTRAL opponent's turn you hold no priority and so can play nothing at
    // all — the card being dead there is the turn structure, not this gate. The
    // Showdown is the window the card was hidden FOR, and it is what the report
    // named.
    const opponentsShowdown: GameState = {
      ...hidden,
      activePlayerIndex: 1,
      turnState: "Showdown",
      showdownBattlefieldId: "bf1",
      showdownKind: "Combat",
      chainOpen: false,
      focusHolder: 0,
      chainPriority: 0,
    };
    expect(
      fromHiddenPlays(opponentsShowdown, consult).length,
      "the card was dead on the opponent's turn — the window it was hidden for",
    ).toBeGreaterThan(0);
  });

  /** The negative that keeps the fix honest: during YOUR OWN hiding turn it is
   *  still dead, which is the half of 811 that was never broken. Hiding is legal
   *  only on your own turn, so this is the state the second clause must reject. */
  it("is still dead on your own turn, the one you hid it on", () => {
    const consult = card(CONSULT_THE_PAST);
    const state = hideableState(consult);
    const sameTurn = executeHideCard(state, hideAction(state, consult));

    expect(sameTurn.activePlayerIndex, "you can only hide on your own turn").toBe(0);
    expect(fromHiddenPlays(sameTurn, consult)).toHaveLength(0);
  });

  /**
   * The bug was ASYMMETRIC, which is why it survived: hide as the SECOND player
   * and the round wraps the instant your turn ends, so `turnNumber` has already
   * advanced and the old gate happened to be right. Both seats must behave the
   * same, and asserting only one of them is what a per-seat bug hides behind.
   */
  it("behaves the same whichever seat hid it", () => {
    for (const owner of [0, 1] as const) {
      const consult = card(CONSULT_THE_PAST);
      const state = hideableState(consult);
      const hidden = executeHideCard(state, hideAction(state, consult));
      // Re-seat the facedown card and ask from the OTHER player's turn.
      const reseated: GameState = {
        ...hidden,
        activePlayerIndex: owner === 0 ? 1 : 0,
        battlefields: hidden.battlefields.map((bf) => ({
          ...bf,
          hiddenCards: bf.hiddenCards.map((h) => ({ ...h, ownerIndex: owner })),
        })),
      };
      const playable = reseated.battlefields
        .flatMap((bf) => bf.hiddenCards)
        .every((h) => hiddenCardIsPlayable(reseated, h));
      expect(playable, `owner ${owner}: dead on the opponent's turn`).toBe(true);
    }
  });

  it("costs 0 — the base cost is ignored, not discounted", () => {
    const consult = card(CONSULT_THE_PAST); // printed 4 Energy
    expect(consult.kind === "Spell" && consult.energyCost).toBe(4);
    const state = hiddenSinceLastTurn(consult);

    const play = fromHiddenPlays(state, consult)[0]!;
    expect(play.type === "PlayCard" && play.payment.energyRunes).toHaveLength(0);
    expect(play.type === "PlayCard" && play.payment.powerRunes).toHaveLength(0);
    expect(validatePlayCard(state, play as never).ok).toBe(true);
  });

  it("does not touch FLOATING resources either — ignored means ignored", () => {
    // The half that was wrong. `validatePlayCard` already priced a from-hidden
    // play at { energyCost: 0, powerCost: 0 } and required an empty payment, but
    // the EXECUTOR went on deducting floating Energy against the printed cost —
    // so Consult the Past (4 Energy) played from Hidden with 3 floating Energy
    // banked silently burned all three for a card that was supposed to be free.
    // Rule 811 says the base cost is IGNORED, not discounted and not partly paid.
    const consult = card(CONSULT_THE_PAST);
    const state = hiddenSinceLastTurn(consult);
    const withFloat = {
      ...state,
      players: [{ ...state.players[0]!, floatingEnergy: 3, floatingPower: { Mind: 2 as number } }, state.players[1]!],
    } as GameState;

    const play = fromHiddenPlays(withFloat, consult)[0]!;
    const after = submit(withFloat, play).state;

    expect(after.players[0]!.floatingEnergy).toBe(3);
    expect(after.players[0]!.floatingPower["Mind"]).toBe(2);
  });

  it("resolves, leaves the hidden zone, and does not touch the rune pool", () => {
    const consult = card(CONSULT_THE_PAST);
    const state = hiddenSinceLastTurn(consult);
    const runesBefore = state.players[0]!.channeled.length;

    let next = submit(state, fromHiddenPlays(state, consult)[0]!).state;
    // A Spell goes on the chain; two passes resolve it.
    next = submit(next, { type: "PassFocus", playerIndex: 0 }).state;
    next = submit(next, { type: "PassFocus", playerIndex: 1 }).state;

    expect(next.players[0]!.hand).toHaveLength(2); // drew 2
    expect(hiddenCardAt(next, "bf1", 0)).toBeUndefined();
    expect(next.players[0]!.channeled).toHaveLength(runesBefore); // nothing paid
  });

  it("works at REACTION speed even though the card prints [Action]", () => {
    // 811: the card "gains [Reaction] while facedown or played from facedown".
    // Fight or Flight prints [Action], which alone could not be cast onto a
    // closed chain.
    const fof = card(FIGHT_OR_FLIGHT);
    const state = hiddenSinceLastTurn(fof);
    const target = makeUnit({ might: 3 });
    const closed: GameState = {
      ...state,
      chainOpen: false,
      battlefields: state.battlefields.map((bf, i) => (i === 0 ? { ...bf, units: { p1: [target] } } : bf)),
    };

    expect(fromHiddenPlays(closed, fof).length).toBeGreaterThan(0);
  });
});

describe("rule 811's targeting restriction, applied in ENUMERATION", () => {
  function bladeHiddenAt(bfIndex: 0 | 1): { state: GameState; blade: CardInstance; here: ReturnType<typeof makeUnit>; elsewhere: ReturnType<typeof makeUnit> } {
    const blade = card(HIDDEN_BLADE);
    const here = makeUnit({ name: "Here", might: 3 });
    const elsewhere = makeUnit({ name: "Elsewhere", might: 3 });
    let state = hideableState(blade);
    state = executeHideCard(state, hideAction(state, blade));
    state = { ...state, turnNumber: state.turnNumber + 1 };
    state.battlefields[0]!.units = { p2: [here] };
    state.battlefields[1]!.units = { p2: [elsewhere] };
    void bfIndex;
    return { state, blade, here, elsewhere };
  }

  it("offers ONLY targets at the battlefield the card was hidden at", () => {
    const { state, blade, here } = bladeHiddenAt(0);
    const targets = legalActions(state)
      .filter((a) => a.type === "PlayCard" && a.card.instanceId === blade.instanceId)
      .map((a) => (a.type === "PlayCard" ? a.targetUnitInstanceId : undefined));

    expect(targets).toEqual([here.instanceId]);
  });

  it("rejects a hand-built action pointing somewhere else", () => {
    const { state, blade, elsewhere } = bladeHiddenAt(0);
    const play = legalActions(state).find((a) => a.type === "PlayCard" && a.card.instanceId === blade.instanceId)!;
    const forged = { ...play, targetUnitInstanceId: elsewhere.instanceId };
    expect(validatePlayCard(state, forged as never).ok).toBe(false);
  });

  it("does not offer the card AT ALL when nothing at that battlefield is targetable", () => {
    // 811: "a card cannot be played from Hidden if it is a spell with no valid
    // targets under these restrictions" — which is why this is an enumeration
    // rule and not only a validation rule.
    const { state, blade } = bladeHiddenAt(0);
    const emptied: GameState = {
      ...state,
      battlefields: state.battlefields.map((bf, i) => (i === 0 ? { ...bf, units: {} } : bf)),
    };
    expect(emptied.battlefields[1]!.units["p2"]).toHaveLength(1); // a target exists ELSEWHERE
    expect(
      legalActions(emptied).filter((a) => a.type === "PlayCard" && a.card.instanceId === blade.instanceId),
    ).toHaveLength(0);
  });
});

describe("a from-hidden token spell must place at THAT battlefield (rule 811)", () => {
  it("offers exactly one destination, and it is not base", () => {
    // "If a hidden spell ... causes you to play a unit, you must choose to play
    // that unit at that battlefield." The base variant every token-placing Spell
    // otherwise gets is forbidden here — offering it handed the player a choice
    // the rules don't give them, and stalled the UI waiting for a decision that
    // should never have been asked.
    const sprite = card(SPRITE_CALL);
    let state = hideableState(sprite);
    state.battlefields[1]!.controllerId = "p1"; // a second controlled battlefield
    state = executeHideCard(state, hideAction(state, sprite));
    state = { ...state, turnNumber: state.turnNumber + 1 };

    const plays = legalActions(state).filter((a) => a.type === "PlayCard" && a.card.instanceId === sprite.instanceId);

    expect(plays).toHaveLength(1);
    expect(plays[0]!.type === "PlayCard" && plays[0]!.destinationBattlefieldId).toBe("bf1");
  });

  it("still offers base plus every controlled battlefield when played from HAND", () => {
    const sprite = card(SPRITE_CALL);
    const state = hideableState(sprite);
    state.battlefields[1]!.controllerId = "p1";
    const destinations = legalActions(state)
      .filter((a) => a.type === "PlayCard" && a.card.instanceId === sprite.instanceId)
      .map((a) => (a.type === "PlayCard" ? (a.destinationBattlefieldId ?? "base") : ""));
    expect(destinations).toEqual(expect.arrayContaining(["base", "bf1", "bf2"]));
  });
});

describe("losing the battlefield loses the card (Cleanup step 5, rule 323)", () => {
  it("trashes a facedown card to its OWNER's trash when control is lost", () => {
    const consult = card(CONSULT_THE_PAST);
    const state = hideableState(consult);
    const hidden = executeHideCard(state, hideAction(state, consult));

    // Control flips to the opponent.
    const lost: GameState = {
      ...hidden,
      battlefields: hidden.battlefields.map((bf, i) => (i === 0 ? { ...bf, controllerId: "p2" } : bf)),
    };
    const after = runCleanup(lost);

    expect(hiddenCardAt(after, "bf1", 0)).toBeUndefined();
    expect(after.players[0]!.trash.map((c) => c.instanceId)).toContain(consult.instanceId); // owner's
    expect(after.players[1]!.trash).toHaveLength(0); // never the new controller's
  });

  it("leaves it alone while its owner still controls the battlefield", () => {
    const consult = card(CONSULT_THE_PAST);
    const state = hideableState(consult); // garrisoned, so control holds
    const hidden = executeHideCard(state, hideAction(state, consult));
    expect(hiddenCardAt(runCleanup(hidden), "bf1", 0)).toBeDefined();
  });

  it("loses the card at an UNOCCUPIED battlefield, via the control lapse", () => {
    // The consequence worth knowing before you hide anything: step 4 drops
    // control of a battlefield none of your units occupy, and step 5 then takes
    // the facedown card with it. Hiding somewhere you aren't standing is a card
    // thrown away, and the ordering of those two steps inside runCleanup is what
    // makes it happen in a single Cleanup rather than two.
    const consult = card(CONSULT_THE_PAST);
    const state = hideableState(consult);
    const ungarrisoned: GameState = {
      ...state,
      battlefields: state.battlefields.map((bf, i) => (i === 0 ? { ...bf, units: {} } : bf)),
    };
    const hidden = executeHideCard(ungarrisoned, hideAction(ungarrisoned, consult));

    const after = runCleanup(hidden);

    expect(after.battlefields[0]!.controllerId).toBeNull();
    expect(hiddenCardAt(after, "bf1", 0)).toBeUndefined();
    expect(after.players[0]!.trash.map((c) => c.instanceId)).toContain(consult.instanceId);
  });
});

describe("privacy: presence is public, identity is not", () => {
  function boardWithOpponentHiddenCard(): GameState {
    const consult = card(CONSULT_THE_PAST);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.controllerId = "p2";
    state.battlefields[0]!.hiddenCards = [{ ownerIndex: 1, card: consult, hiddenOnTurn: 1 }];
    return state;
  }

  it("keeps the entry but replaces the card for anyone who isn't the owner", () => {
    const masked = maskHiddenCards(boardWithOpponentHiddenCard(), 0);
    const entry = masked.battlefields[0]!.hiddenCards[0]!;

    expect(entry.ownerIndex).toBe(1); // presence and owner survive...
    expect(entry.hiddenOnTurn).toBe(1);
    expect(isFacedownPlaceholder(entry.card)).toBe(true); // ...identity does not
    expect(entry.card.name).not.toBe("Consult the Past");
  });

  it("leaves your OWN hidden card untouched — you must still be able to play it", () => {
    const masked = maskHiddenCards(boardWithOpponentHiddenCard(), 1);
    expect(isFacedownPlaceholder(masked.battlefields[0]!.hiddenCards[0]!.card)).toBe(false);
  });

  it("returns the same object when there is nothing to mask", () => {
    const plain = makeState();
    expect(maskHiddenCards(plain, 0)).toBe(plain);
  });

  it("the AI never chooses an action naming a card it cannot see", () => {
    // The real point: chooseAction reads a masked state, so a hidden card of the
    // opponent's is not in its candidate pool at all.
    const state = boardWithOpponentHiddenCard();
    const withTurn: GameState = { ...state, activePlayerIndex: 0, turnNumber: 5 };
    const chosen = chooseAction(withTurn);
    const named = chosen.type === "PlayCard" || chosen.type === "HideCard" ? chosen.card.instanceId : undefined;
    expect(named).not.toBe(state.battlefields[0]!.hiddenCards[0]!.card.instanceId);
  });
});

describe("the five Hidden cards are implemented", () => {
  it("coverage reports all of them", () => {
    for (const id of [CONSULT_THE_PAST, FIGHT_OR_FLIGHT, HIDDEN_BLADE, STAND_UNITED, SPRITE_CALL]) {
      expect(isCardImplemented(registry.get(id)), `${id} (${registry.get(id).name})`).toBe(true);
    }
  });
});
