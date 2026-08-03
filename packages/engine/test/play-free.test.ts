import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { recordConquest } from "../src/engine/scoring.js";
import { hideCostFor } from "../src/engine/hidden.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { answerDecisions, makeState, makeUnit, pickCard, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * Playing a card for free from somewhere other than a hand — the pool's biggest
 * remaining group, and one shared helper (`play-free.ts`) behind all of it.
 *
 * The divergence worth stating up front: a SPELL played this way resolves
 * IMMEDIATELY rather than going on the chain. It has to. These calls happen while
 * a chain item is being resolved, and `execute-pass-focus` pops the LAST entry
 * when that resolution finishes — so a spell appended here would be popped
 * instead of the card that played it, and the original would never resolve.
 */

const registry = defaultCardRegistry();
const BLIND_FURY = "OGN-025"; // "Each opponent reveals the top card... banish it, then play it, ignoring its cost."
const REINFORCE = "OGN-062"; // "You may banish a unit from the top 5, then play it, reducing its cost by 5."
const KAISA_EVOLUTIONARY = "OGN-112"; // "When I conquer, you may play a spell from your trash..."
const GUERILLA_WARFARE = "OGN-264"; // "Return up to two [Hidden] cards from your trash. You can hide ignoring costs this turn."
const CONSULT_THE_PAST = "OGN-083"; // a [Hidden] Mind spell, for Guerilla Warfare's trash
const HEXTECH_RAY = "OGN-009"; // Fury 1E/1P — cheap, so it clears Kai'Sa's points threshold

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const playsFor = (state: GameState, defId: string) =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === defId);

function castAndResolve(state: GameState, defId: string): GameState {
  const play = playsFor(state, defId)[0];
  expect(play, `${defId} was not castable`).toBeDefined();
  let current = accept(state, play!);
  for (let guard = 0; guard < 12 && current.spellChain.length > 0; guard += 1) {
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) break;
    current = accept(current, pass!);
  }
  return current;
}

describe("Blind Fury (OGN-025): steal the top of their deck and play it", () => {
  function blindFuryState(topCard: GameState["players"][0]["deck"][number]): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spellInstance(BLIND_FURY)];
    state.players[0]!.channeled = Array.from({ length: 12 }, (_, i) => rune(`f${i}`, "Fury"));
    state.players[1]!.deck = [topCard, makeUnit({ instanceId: "deeper", might: 1 })];
    return state;
  }

  it("plays the opponent's top UNIT into the CASTER's base", () => {
    // "Choose one and play IT" names no owner, on a card whose whole point is
    // taking the top of an enemy deck — so it joins the caster's board, not its
    // owner's.
    const settled = castAndResolve(blindFuryState(makeUnit({ instanceId: "stolen", might: 4 })), BLIND_FURY);

    expect(settled.players[0]!.baseUnits.map((u) => u.instanceId), "the stolen unit did not arrive").toContain("stolen");
    expect(settled.players[1]!.deck.map((c) => c.instanceId), "it was left in their deck").not.toContain("stolen");
  });

  it("resolves a stolen SPELL immediately, and trashes it", () => {
    // The recorded divergence. A spell cannot be appended to the chain from
    // inside a resolution of that chain, so it resolves here and now.
    const state = blindFuryState(spellInstance("OGN-114")); // Progress Day — "Draw 4."
    state.players[0]!.deck = Array.from({ length: 6 }, (_, i) => makeUnit({ instanceId: `d${i}`, might: 1 }));

    const settled = castAndResolve(state, BLIND_FURY);
    expect(settled.players[0]!.hand.length, "the stolen spell never resolved").toBe(4);
    expect(settled.players[0]!.trash.some((c) => c.defId === "OGN-114"), "it did not reach a trash").toBe(true);
  });

  it("does nothing to an empty deck rather than throwing", () => {
    const state = blindFuryState(makeUnit({ instanceId: "unused", might: 1 }));
    state.players[1]!.deck = [];
    expect(castAndResolve(state, BLIND_FURY).players[0]!.baseUnits).toHaveLength(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(BLIND_FURY))).toBe(true);
  });
});

describe("Reinforce (OGN-062): a unit from the top five", () => {
  function reinforceState(): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spellInstance(REINFORCE)];
    state.players[0]!.channeled = Array.from({ length: 8 }, (_, i) => rune(`c${i}`, "Calm"));
    state.players[0]!.deck = [
      spellInstance("OGN-114"),
      makeUnit({ instanceId: "cheap", might: 3, energyCost: 4 }),
      makeUnit({ instanceId: "dear", might: 9, energyCost: 9 }),
      makeUnit({ instanceId: "deep", might: 1 }),
      spellInstance("OGN-114"),
      makeUnit({ instanceId: "sixth", might: 1 }),
    ];
    return state;
  }

  it("offers only units the 5-Energy reduction covers, and plays the chosen one free", () => {
    // The recorded divergence: a threshold rather than a payment, because paying
    // Energy inside a resolution is the one thing this engine cannot ask for.
    // Strictly narrower than the card — never wider.
    const cast = castAndResolve(reinforceState(), REINFORCE);
    const decision = cast.pendingDecisions[0];
    expect(decision?.kind).toBe("OGN-062-banish");

    const settled = answerDecisions(cast, pickCard("cheap"));
    expect(settled.players[0]!.baseUnits.map((u) => u.instanceId)).toContain("cheap");
    expect(settled.players[0]!.channeled.filter((r) => r.state === "Ready").length, "it charged for the unit").toBe(3);
  });

  it("recycles the rest of the five whether or not one is taken", () => {
    // "Recycle the remaining cards" is a separate instruction from the
    // banish-and-play, so declining still churns the top five.
    const declined = answerDecisions(castAndResolve(reinforceState(), REINFORCE));
    expect(declined.players[0]!.deck[0]!.instanceId, "the top five were not recycled").toBe("sixth");
    expect(declined.players[0]!.baseUnits).toHaveLength(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(REINFORCE))).toBe(true);
  });
});

describe("Kai'Sa - Evolutionary (OGN-112): a spell from the trash on conquer", () => {
  /** Kai'Sa at bf1 with a cheap spell already in the trash. */
  function kaisaState(points: number): GameState {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [realUnitInstance(KAISA_EVOLUTIONARY)] };
    state.players[0]!.points = points;
    state.players[0]!.trash = [spellInstance(HEXTECH_RAY)];
    state.battlefields[1]!.units = { p2: [makeUnit({ instanceId: "victim", might: 9 })] };
    return state;
  }

  it("offers the spell once your points clear its cost, and not before", () => {
    // Hextech Ray prints 1 Energy, so "less than your points" needs 2+ — and the
    // conquest itself awards a point BEFORE the trigger resolves, which the card
    // comment calls out. So 0 points becomes 1 (not enough) and 1 would already
    // become 2 (enough): starting from 0 is the only honest "too poor".
    const tooPoor = resolveHeldTriggers(recordConquest(kaisaState(0), 0, "bf1"));
    expect(tooPoor.pendingDecisions, "it was offered below the threshold").toHaveLength(0);

    const rich = resolveHeldTriggers(recordConquest(kaisaState(4), 0, "bf1"));
    expect(rich.pendingDecisions[0]?.kind).toBe("OGN-112-play");
  });

  it("RECYCLES the spell rather than returning it to the trash", () => {
    // "Then recycle it" is the card's own answer to the loop it would otherwise
    // be: bottom of the deck, so a second conquest cannot replay the same one.
    const conquered = resolveHeldTriggers(recordConquest(kaisaState(4), 0, "bf1"));
    const settled = answerDecisions(conquered, pickCard(conquered.players[0]!.trash[0]?.instanceId ?? ""));

    expect(settled.players[0]!.trash.some((c) => c.defId === HEXTECH_RAY), "it went back to the trash").toBe(false);
    expect(settled.players[0]!.deck.map((c) => c.defId), "it was not recycled").toContain(HEXTECH_RAY);
  });

  it("does not fire for a battlefield she is not at", () => {
    const settled = resolveHeldTriggers(recordConquest(kaisaState(4), 0, "bf2"));
    expect(settled.pendingDecisions).toHaveLength(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(KAISA_EVOLUTIONARY))).toBe(true);
  });
});

describe("Guerilla Warfare (OGN-264): free hiding this turn", () => {
  function warfareState(trashCount: number): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spellInstance(GUERILLA_WARFARE)];
    state.players[0]!.channeled = Array.from({ length: 8 }, (_, i) => rune(`m${i}`, "Mind"));
    state.players[0]!.trash = Array.from({ length: trashCount }, () => spellInstance(CONSULT_THE_PAST));
    return state;
  }

  it("returns up to TWO [Hidden] cards and no more", () => {
    const settled = castAndResolve(warfareState(3), GUERILLA_WARFARE);
    expect(settled.players[0]!.hand.filter((c) => c.defId === CONSULT_THE_PAST)).toHaveLength(2);
    expect(settled.players[0]!.trash.filter((c) => c.defId === CONSULT_THE_PAST)).toHaveLength(1);
  });

  it("is castable with an EMPTY trash — 'up to two' includes zero", () => {
    const settled = castAndResolve(warfareState(0), GUERILLA_WARFARE);
    expect(settled.players[0]!.hideIgnoresCostThisTurn, "the second half did not happen").toBe(true);
  });

  it("makes hiding FREE for the rest of the turn, not just once", () => {
    // A waiver, not a charge — the sentence says "cards", plural.
    const settled = castAndResolve(warfareState(2), GUERILLA_WARFARE);
    expect(hideCostFor(settled, 0)).toBe(0);
    expect(hideCostFor(settled, 1), "it waived the opponent's cost too").toBe(1);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(GUERILLA_WARFARE))).toBe(true);
  });
});
