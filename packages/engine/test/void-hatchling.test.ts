import { describe, expect, it } from "vitest";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { answerDecision, optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { holdEventTrigger } from "../src/engine/triggers.js";
import { holdBattlefieldTrigger } from "../src/engine/battlefield-abilities.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { CardInstance } from "../src/model/card.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { Domain } from "../src/model/domain.js";
import type { RuneCard } from "../src/model/rune.js";
import {
  answerDecisions,
  makePlayer,
  makeState,
  makeUnit,
  realUnitInstance,
  resolveHeldTriggers,
  spellInstance,
} from "./fixtures.js";

/**
 * Void Hatchling (SFD-018) — "If you would reveal cards from a deck, look at the
 * top card first. You may recycle it. Then reveal those cards."
 *
 * # Why this one needed a mechanism rather than an entry
 *
 * It REPLACES a step. Every other clause in this pool acts before or after
 * something; this acts INSIDE it, and `parkDecision` returns to a caller that has
 * already run. So each of the five reveal sites became a decision CONTINUATION:
 * its body extracted into a named function that is BOTH the inline path and the
 * resolver's body.
 *
 * # The failure mode these tests exist for
 *
 * **A naive implementation is worse than none.** Park the question, let the
 * reveal proceed anyway, and the card is a silent no-op — recycling after the
 * reveal changes nothing about what was revealed. Every site below therefore
 * asserts on WHAT WAS REVEALED after a recycle, not merely that a question
 * appeared.
 *
 * # And the trap the handoff named
 *
 * "A one-option decision auto-resolves", which here is not a hazard but a
 * requirement: `advanceDecisions` DROPS a question with no options, and dropping
 * this one would drop the reveal with it. So "decline" is always offered and an
 * empty deck resolves itself — asserted below.
 */

const registry = defaultCardRegistry();
const VOID_HATCHLING = "SFD-018";
const APPRENTICE_SMITH = "SFD-041"; // when I move, reveal top; gear -> draw, else recycle
const DAZZLING_AURORA = "OGN-160"; // at end of turn, reveal until a unit, play it
const TEEMO_STRATEGIST = "OGN-121"; // when I defend, reveal top 5, damage per [Hidden]
const BLIND_FURY = "OGN-025"; // each opponent reveals top; banish and play it
const RAVENBLOOM = "SFD-215"; // when you defend here, reveal top; spell -> hand

/** A real Gear and a real Unit, for stacking decks with known kinds. */
const A_GEAR = "OGN-090"; // Orb of Regret
const A_UNIT = "OGN-002";
const A_SPELL = "OGS-003"; // Incinerate

const card = (defId: string): CardInstance => createCardInstance(registry.get(defId));
const runes = (domain: Domain, n: number): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

/** Puts a Void Hatchling in p1's base when `watching`. */
function withHatchling(state: GameState, watching: boolean, index: 0 | 1 = 0): GameState {
  if (!watching) return state;
  state.players[index]!.baseUnits = [...state.players[index]!.baseUnits, realUnitInstance(VOID_HATCHLING)];
  return state;
}

/** Answers whatever question is pending with `optionId`, once. */
function answer(state: GameState, optionId: string): GameState {
  const decision = pendingDecision(state);
  expect(decision, `no question was pending when answering "${optionId}"`).toBeDefined();
  const next = answerDecision(state, decision!.id, optionId);
  expect(next, `"${optionId}" was not on offer`).toBeDefined();
  return next!;
}

describe("Void Hatchling: the gate itself", () => {
  it("asks nothing when its controller has none in play", () => {
    const state = makeState({ phase: "Action", players: [makePlayer("p1"), makePlayer("p2")] });
    state.players[0]!.deck = [card(A_GEAR), card(A_UNIT)];
    const smith = { ...realUnitInstance(APPRENTICE_SMITH), instanceId: "smith" };
    state.battlefields[0]!.units = { p1: [smith] };
    const after = resolveHeldTriggers(
      holdEventTrigger(state, { kind: "unitMoved", unitInstanceId: "smith", moverIndex: 0, from: "base", to: "bf1", movesThisTurn: 1 }),
    );
    expect(pendingDecision(after)).toBeUndefined();
    // And the reveal still happened: a Gear on top was drawn.
    expect(after.players[0]!.hand).toHaveLength(1);
  });

  it("offers a DECLINE and a RECYCLE while the deck has a top card", () => {
    const state = withHatchling(makeState({ phase: "Action", players: [makePlayer("p1"), makePlayer("p2")] }), true);
    state.players[0]!.deck = [card(A_GEAR), card(A_UNIT)];
    const smith = { ...realUnitInstance(APPRENTICE_SMITH), instanceId: "smith" };
    state.battlefields[0]!.units = { p1: [smith] };
    const after = resolveHeldTriggers(
      holdEventTrigger(state, { kind: "unitMoved", unitInstanceId: "smith", moverIndex: 0, from: "base", to: "bf1", movesThisTurn: 1 }),
    );
    expect(optionsFor(after, pendingDecision(after)!).map((o) => o.id)).toEqual(["decline", "recycle"]);
  });

  it("resolves ITSELF on an empty deck, so the reveal is never dropped", () => {
    // `advanceDecisions` drops a question with NO options, and the site's whole
    // body is the continuation — dropping the question would drop the reveal.
    // One option is what stops that, and it costs the player no click.
    const state = withHatchling(makeState({ phase: "Action", players: [makePlayer("p1"), makePlayer("p2")] }), true);
    state.players[0]!.deck = [];
    const smith = { ...realUnitInstance(APPRENTICE_SMITH), instanceId: "smith" };
    state.battlefields[0]!.units = { p1: [smith] };
    const after = resolveHeldTriggers(
      holdEventTrigger(state, { kind: "unitMoved", unitInstanceId: "smith", moverIndex: 0, from: "base", to: "bf1", movesThisTurn: 1 }),
    );
    expect(pendingDecision(after)).toBeUndefined();
  });
});

describe("Void Hatchling: Apprentice Smith (SFD-041)", () => {
  function board(watching: boolean, deck: string[]): GameState {
    const state = withHatchling(makeState({ phase: "Action", players: [makePlayer("p1"), makePlayer("p2")] }), watching);
    state.players[0]!.deck = deck.map(card);
    state.battlefields[0]!.units = { p1: [{ ...realUnitInstance(APPRENTICE_SMITH), instanceId: "smith" }] };
    return state;
  }
  const move = (state: GameState) =>
    resolveHeldTriggers(
      holdEventTrigger(state, { kind: "unitMoved", unitInstanceId: "smith", moverIndex: 0, from: "base", to: "bf1", movesThisTurn: 1 }),
    );

  it("recycling a non-gear top card lets the Smith reveal the GEAR under it", () => {
    // The whole point of the card, at the site where it is easiest to see: the
    // Smith draws only a gear, and a Hatchling turns a miss into a hit.
    const after = answer(move(board(true, [A_UNIT, A_GEAR])), "recycle");
    expect(after.players[0]!.hand.map((c) => c.defId), "the gear under the top card was not drawn").toEqual([A_GEAR]);
  });

  it("declining leaves the reveal exactly as it was", () => {
    const after = answer(move(board(true, [A_UNIT, A_GEAR])), "decline");
    expect(after.players[0]!.hand, "declining still drew something").toHaveLength(0);
  });

  it("matches the no-Hatchling board when declined — the control", () => {
    const declined = answer(move(board(true, [A_UNIT, A_GEAR])), "decline");
    const none = move(board(false, [A_UNIT, A_GEAR]));
    expect(declined.players[0]!.hand.length).toBe(none.players[0]!.hand.length);
  });
});

describe("Void Hatchling: Dazzling Aurora (OGN-160)", () => {
  function board(watching: boolean, deck: string[]): GameState {
    const state = withHatchling(makeState({ phase: "Action", players: [makePlayer("p1"), makePlayer("p2")] }), watching);
    state.players[0]!.deck = deck.map(card);
    state.players[0]!.activeGear = [];
    state.battlefields[0]!.units = { p1: [{ ...realUnitInstance(DAZZLING_AURORA), instanceId: "aurora" }] };
    return state;
  }

  it("changes WHICH unit the reveal-until finds", () => {
    // "Reveal until you reveal a unit and play it." Two units on top; recycling
    // the first means the second is the one played, and the first is at the
    // bottom rather than recycled with the rest.
    const state = board(true, [A_UNIT, A_UNIT, A_SPELL]);
    const firstUnitId = state.players[0]!.deck[0]!.instanceId;
    const secondUnitId = state.players[0]!.deck[1]!.instanceId;
    // Drained after the Hatchling's answer, because "play it, ignoring its cost"
    // parks its own placement question when the caster has presence at a
    // battlefield — a second question, and not this card's.
    const after = answerDecisions(answer(resolveHeldTriggers(runEnd(state)), "recycle"));
    const inPlay = [
      ...after.players[0]!.baseUnits,
      ...after.battlefields.flatMap((bf) => bf.units["p1"] ?? []),
    ].map((u) => u.instanceId);
    expect(inPlay, "the recycled unit was played anyway").not.toContain(firstUnitId);
    expect(inPlay, "the unit under it was not the one played").toContain(secondUnitId);
  });

  it("plays the top unit when declined", () => {
    const state = board(true, [A_UNIT, A_UNIT, A_SPELL]);
    const firstUnitId = state.players[0]!.deck[0]!.instanceId;
    const after = answerDecisions(answer(resolveHeldTriggers(runEnd(state)), "decline"));
    const inPlay = [
      ...after.players[0]!.baseUnits,
      ...after.battlefields.flatMap((bf) => bf.units["p1"] ?? []),
    ].map((u) => u.instanceId);
    expect(inPlay).toContain(firstUnitId);
  });
});

describe("Void Hatchling: Teemo - Strategist (OGN-118)", () => {
  function board(watching: boolean, deck: string[]): GameState {
    const state = withHatchling(makeState({ phase: "Action", players: [makePlayer("p1"), makePlayer("p2")] }), watching);
    state.players[0]!.deck = deck.map(card);
    state.battlefields[0]!.units = {
      p1: [{ ...realUnitInstance(TEEMO_STRATEGIST), instanceId: "teemo" }],
      p2: [makeUnit({ instanceId: "victim", name: "Victim", might: 9 })],
    };
    state.battlefields[0]!.contestedByIndex = 1;
    return state;
  }
  const defend = (state: GameState) =>
    resolveHeldTriggers(
      holdEventTrigger(state, { kind: "combatBegan", battlefieldId: "bf1", designated: ["teemo", "victim"] }),
    );
  const damageOn = (state: GameState) =>
    (state.battlefields[0]!.units["p2"] ?? []).find((u) => u.instanceId === "victim")?.damage ?? 0;

  it("changes the top 5, so the [Hidden] count changes with it", () => {
    // 6 cards: one [Hidden] sits sixth and cannot be reached without recycling
    // the top one. Recycling moves it into the window.
    const hiddenCard = registry
      .all()
      .find((d) => "hidden" in d && d.hidden === true)!;
    const state = board(true, [A_GEAR, A_GEAR, A_GEAR, A_GEAR, A_GEAR]);
    state.players[0]!.deck = [...state.players[0]!.deck, card(hiddenCard.id)];
    const recycled = answer(defend(state), "recycle");
    const declined = answer(defend(board(true, [...state.players[0]!.deck.map((c) => c.defId)])), "decline");
    expect(damageOn(recycled), "recycling did not bring the sixth card into the top 5").toBeGreaterThan(
      damageOn(declined),
    );
  });

  it("carries the battlefield across the question", () => {
    // "An enemy unit HERE" is about the combat that fired the trigger, and by the
    // time the answer arrives nothing on the board says which that was — so it
    // rides the decision. A dropped battlefield would silently deal no damage.
    const hiddenCard = registry
      .all()
      .find((d) => "hidden" in d && d.hidden === true)!;
    const state = board(true, [hiddenCard.id, hiddenCard.id]);
    expect(pendingDecision(defend(state))?.battlefieldId).toBe("bf1");
    expect(damageOn(answer(defend(state), "decline"))).toBeGreaterThan(0);
  });
});

describe("Void Hatchling: Blind Fury (OGN-025) — the site where the decks differ", () => {
  function board(watching: boolean, victimDeck: string[]): { state: GameState; spellId: string } {
    const spell = spellInstance(BLIND_FURY);
    const state = withHatchling(
      makeState({
        phase: "Action",
        players: [makePlayer("p1", { hand: [spell], channeled: runes("Fury", 8) }), makePlayer("p2")],
      }),
      watching,
    );
    state.players[1]!.deck = victimDeck.map(card);
    return { state, spellId: spell.instanceId };
  }
  const cast = (state: GameState, spellId: string) => {
    const play = legalActions(state).find(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === spellId,
    );
    expect(play, "Blind Fury was not offered").toBeDefined();
    return resolveHeldTriggers(executePlayCard(state, play!));
  };

  it("looks at the OPPONENT's deck, because the caster is the one revealing", () => {
    // "If YOU would reveal cards FROM A DECK" — the revealer is the caster and
    // the deck is the victim's. The one site of the five where those differ, and
    // the reason the gate takes both indices.
    const { state, spellId } = board(true, [A_UNIT, A_UNIT]);
    const topOfVictim = state.players[1]!.deck[0]!.instanceId;
    const after = cast(state, spellId);
    const option = optionsFor(after, pendingDecision(after)!).find((o) => o.id === "recycle");
    expect(option?.instanceId, "the question named a card from the wrong deck").toBe(topOfVictim);
  });

  it("steals the card UNDER the one recycled", () => {
    const { state, spellId } = board(true, [A_UNIT, A_UNIT]);
    const first = state.players[1]!.deck[0]!.instanceId;
    const second = state.players[1]!.deck[1]!.instanceId;
    const after = answer(cast(state, spellId), "recycle");
    const stolen = after.players[0]!.baseUnits.map((u) => u.instanceId);
    expect(stolen).toContain(second);
    expect(stolen).not.toContain(first);
  });

  it("does NOT fire on the victim's own Hatchling", () => {
    // "If YOU would reveal" — the victim is not revealing, they are being
    // revealed from. A Hatchling on their side asks nothing.
    const { state, spellId } = board(false, [A_UNIT, A_UNIT]);
    withHatchling(state, true, 1);
    expect(pendingDecision(cast(state, spellId))).toBeUndefined();
  });
});

describe("Void Hatchling: Ravenbloom Conservatory (SFD-215)", () => {
  function board(watching: boolean, deck: string[]): GameState {
    const state = withHatchling(makeState({ phase: "Action", players: [makePlayer("p1"), makePlayer("p2")] }), watching);
    state.players[0]!.deck = deck.map(card);
    state.battlefields[0]!.defId = RAVENBLOOM;
    return state;
  }
  const defend = (state: GameState) =>
    resolveHeldTriggers(holdBattlefieldTrigger(state, "defend", "bf1", 0));

  it("recycling a non-spell top card reaches the SPELL under it", () => {
    const after = answer(defend(board(true, [A_UNIT, A_SPELL])), "recycle");
    expect(after.players[0]!.hand.map((c) => c.defId), "the spell under the top card did not reach hand").toEqual([
      A_SPELL,
    ]);
  });

  it("declining leaves the reveal alone", () => {
    const after = answer(defend(board(true, [A_UNIT, A_SPELL])), "decline");
    expect(after.players[0]!.hand).toHaveLength(0);
  });
});

describe("Void Hatchling: coverage", () => {
  it("reports as implemented", () => {
    expect(isCardImplemented(registry.get(VOID_HATCHLING))).toBe(true);
  });
});
