import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { validateAnswerDecision } from "../src/actions/validate-answer-decision.js";
import { optionsFor, parkDecision, pendingDecision } from "../src/engine/decisions.js";
import { actingPlayerIndex } from "../src/engine/timing.js";
import { discardCards, discardThenDraw, destroyUnit } from "../src/engine/effect-helpers.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { answerDecisions, makePlayer, makeState, makeUnit, pickCard } from "./fixtures.js";

/**
 * The engine stopping to ask a player a question.
 *
 * Everything else in this engine decides its choices before an action is
 * submitted; a trigger has no action to carry one on. These are the properties
 * the rest of the game leans on, so they are pinned to rules rather than to the
 * implementation that happens to satisfy them today.
 */

const registry = defaultCardRegistry();

/** A player holding `handSize` cards, with a deck to draw from. */
function asker(handSize: number, deckSize = 4): GameState {
  return makeState({
    phase: "Action",
    players: [
      makePlayer("p1", {
        hand: Array.from({ length: handSize }, () => makeUnit()),
        deck: Array.from({ length: deckSize }, () => makeUnit()),
      }),
      makePlayer("p2", { deck: Array.from({ length: deckSize }, () => makeUnit()) }),
    ],
  });
}

describe("while a question is pending, nothing else is legal", () => {
  it("offers only answers, and only to the player being asked", () => {
    const asked = discardCards(asker(3), 0, 1);
    const actions = legalActions(asked);

    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((a) => a.type === "AnswerDecision")).toBe(true);
    expect(actions.every((a) => a.playerIndex === 0)).toBe(true);
  });

  it("refuses every other action, including Pass and PassFocus", () => {
    // Rule 323.2.a — while resolution is suspended, Priority and Focus "are not
    // passed or awarded". Passing Focus out of a half-resolved effect would be
    // exactly that.
    const asked = discardCards(asker(3), 0, 1);

    for (const action of [{ type: "Pass" as const, playerIndex: 0 as const }, { type: "PassFocus" as const, playerIndex: 0 as const }]) {
      const result = submit(asked, action);
      expect(result.result.type).toBe("Invalid");
      expect(result.state).toBe(asked);
    }
  });

  it("points actingPlayerIndex at whoever was asked, not the turn player", () => {
    // Cull the Weak asks the non-turn player on the turn player's turn. Without
    // this the board would highlight and the AI would play for the wrong seat.
    const state = asker(3);
    state.players[1]!.hand = [makeUnit(), makeUnit()];
    const asked = discardCards(state, 1, 1);
    expect(asked.activePlayerIndex).toBe(0);
    expect(actingPlayerIndex(asked)).toBe(1);
  });

  it("refuses an answer from the other player", () => {
    const asked = discardCards(asker(3), 0, 1);
    const answer = legalActions(asked)[0]!;

    expect(validateAnswerDecision(asked, { ...answer, playerIndex: 1 } as never).ok).toBe(false);
  });

  it("refuses an answer aimed at a question already resolved", () => {
    // "Discard 2" asks twice in a row about different cards. An answer to the
    // first must not silently apply to the second.
    const asked = discardCards(asker(4), 0, 2);
    const first = pendingDecision(asked)!;
    const answered = submit(asked, legalActions(asked)[0]!).state;
    const second = pendingDecision(answered)!;

    expect(second.id).not.toBe(first.id);
    const stale = { type: "AnswerDecision" as const, playerIndex: 0 as const, decisionId: first.id, optionId: optionsFor(answered, second)[0]!.id };
    expect(validateAnswerDecision(answered, stale).ok).toBe(false);
  });

  it("refuses an option that isn't on offer", () => {
    const asked = discardCards(asker(3), 0, 1);
    const answer = legalActions(asked)[0]!;
    expect(validateAnswerDecision(asked, { ...answer, optionId: "not-a-card" } as never).ok).toBe(false);
  });
});

describe("a question with nothing to decide is never asked", () => {
  it("resolves a single-option question without queueing it", () => {
    // "Discard 2" holding exactly two cards is not a choice. A modal to confirm
    // it would be theatre, and — worse — a state the AI has to spend an action on.
    const after = discardCards(asker(2), 0, 2);
    expect(after.pendingDecisions).toHaveLength(0);
    expect(after.players[0]!.trash).toHaveLength(2);
  });

  it("drops a question with no options at all", () => {
    // Cull the Weak against a player with no units: 422's "do as much as you
    // can". Deadlocking on an unanswerable question is the alternative.
    const state = parkDecision(asker(0), { kind: "OGN-209-kill", playerIndex: 0 });
    expect(state.pendingDecisions).toHaveLength(0);
  });

  // "drops a question no registry can answer, rather than deadlocking" used to
  // live here, and its premise was wrong rather than its assertion. Dropping is
  // for a question that has become MOOT — the two cases above, both of which
  // still drop. A kind NOTHING registers is a bug in card registration, and
  // dropping it silently is how a card can park an unanswerable question, do
  // nothing, and still report implemented. It now throws; see
  // "a decision kind nothing registers" at the foot of this file.
});

describe("the Cleanup waits for the answer (323.2.b)", () => {
  /** A battlefield this player controls but has no units at — the Cleanup lapses
   *  control of exactly this (323.11), so it is a visible marker of whether one ran. */
  function withLapsableBattlefield(state: GameState): GameState {
    const next = { ...state, battlefields: state.battlefields.map((bf) => ({ ...bf })) };
    next.battlefields[0]!.controllerId = "p1";
    return next;
  }

  it("does not run BETWEEN two questions of the same effect", () => {
    // "While Chain Items are Resolving, a Cleanup cannot occur." The sharp case
    // is a half-answered effect: "discard 2" answered once is still mid-
    // resolution, so submitting that answer must not trigger the Cleanup that
    // would lapse control of this empty battlefield (323.11).
    const asked = discardCards(withLapsableBattlefield(asker(4)), 0, 2);
    expect(asked.pendingDecisions).toHaveLength(1);

    const halfway = submit(asked, legalActions(asked)[0]!).state;

    expect(halfway.pendingDecisions).toHaveLength(1); // one card still owed
    expect(halfway.battlefields[0]!.controllerId).toBe("p1"); // still held, un-lapsed
  });

  it("runs once the queue empties (323.4)", () => {
    // Nothing is lost by deferring: a Cleanup repeats until the state stops
    // changing, so the one at the end does the work of the ones skipped.
    const state = withLapsableBattlefield(asker(3));
    const asked = discardCards(state, 0, 1);
    expect(asked.battlefields[0]!.controllerId).toBe("p1");

    const answered = submit(asked, legalActions(asked)[0]!).state;

    expect(answered.pendingDecisions).toHaveLength(0);
    expect(answered.battlefields[0]!.controllerId).toBeNull(); // the deferred Cleanup ran
  });
});

describe("discard, and the order of what follows it", () => {
  it("asks the discarding player, and honours which card they name", () => {
    const state = asker(3);
    const named = state.players[0]!.hand[2]!;

    const after = answerDecisions(discardCards(state, 0, 1), pickCard(named.instanceId));

    expect(after.players[0]!.trash.map((c) => c.instanceId)).toEqual([named.instanceId]);
  });

  it("asks once per card owed, recomputing the offer each time", () => {
    const state = asker(4);
    const asked = discardCards(state, 0, 2);
    expect(optionsFor(asked, pendingDecision(asked)!)).toHaveLength(4);

    const afterFirst = submit(asked, legalActions(asked)[0]!).state;

    // The card just discarded is no longer on offer for the second question —
    // the options are rebuilt from live state, not snapshotted when parked.
    expect(optionsFor(afterFirst, pendingDecision(afterFirst)!)).toHaveLength(3);
  });

  it("draws only AFTER the discards, so a drawn card can never be discarded", () => {
    // The guarantee "then" buys, and the one that quietly inverts if the draw is
    // wrapped around a discard that has become a question.
    const state = asker(3, 2);
    const deckIds = state.players[0]!.deck.map((c) => c.instanceId);

    const asked = discardThenDraw(state, 0, 1, 2);

    // Nothing has been drawn yet — the offer is the original hand alone.
    expect(optionsFor(asked, pendingDecision(asked)!).map((o) => o.instanceId)).not.toContain(deckIds[0]);
    const after = answerDecisions(asked);
    expect(after.players[0]!.hand.map((c) => c.instanceId)).toContain(deckIds[0]);
    expect(after.players[0]!.trash.map((c) => c.instanceId)).not.toContain(deckIds[0]);
  });

  it("still draws immediately when the discard needed no question", () => {
    const after = discardThenDraw(asker(1, 3), 0, 1, 2);
    expect(after.pendingDecisions).toHaveLength(0);
    expect(after.players[0]!.hand).toHaveLength(2);
  });
});

describe("a question raised during a Cleanup", () => {
  it("survives a Deathknell that fires while the board is being tidied", () => {
    // Undercover Agent's Deathknell discards 2. Killed in a way that resolves
    // through the Cleanup, the question is parked from inside it — which is the
    // case legalActions has to answer BEFORE its Action-phase guard, or the game
    // hangs on a question nobody can answer.
    const agent = createCardInstance(registry.get("OGN-178"));
    const state = makeState({
      phase: "Beginning",
      players: [
        makePlayer("p1", { hand: [makeUnit(), makeUnit(), makeUnit()], deck: [makeUnit(), makeUnit()] }),
        makePlayer("p2"),
      ],
    });
    state.players[0]!.baseUnits = [agent as never];

    const asked = destroyUnit(state, agent.instanceId);

    expect(asked.phase).toBe("Beginning");
    // Two entries: the discard question, and the "then draw 2" queued behind it.
    expect(asked.pendingDecisions.map((d) => d.kind)).toEqual(["discard", "draw"]);
    expect(legalActions(asked).length).toBeGreaterThan(0); // answerable outside the Action phase
    expect(answerDecisions(asked).pendingDecisions).toHaveLength(0);
  });
});

/**
 * An unregistered decision kind is a BUG, not a game state.
 *
 * `advanceDecisions` used to drop one silently, defended by "an unregistered
 * kind cannot be answered by anyone, so dropping it is the only option that
 * doesn't deadlock the game". That is true about the runtime and wrong about
 * the consequence: a card that parks a kind nobody registered then does
 * nothing, costs its runes, goes to the trash — and still reports IMPLEMENTED,
 * because `coverage.ts` sees the card registered in `decisions.ts`'s own map
 * and cannot tell that the seed names a key the map lacks.
 *
 * The precedent is `resolvePendingTrigger`, which was changed to throw on an
 * unregistered defId for exactly this reason: a silent no-op is how all 7
 * legend hooks would have vanished with no failing test.
 *
 * The distinction that has to survive is between a kind with NO DEFINITION (a
 * bug) and a registered definition returning NO OPTIONS (legitimate — "discard
 * 1" with an empty hand really has become moot). Both are pinned here.
 */
describe("a decision kind nothing registers", () => {
  it("throws when parked, naming the kind", () => {
    const state = asker(2);
    expect(() => parkDecision(state, { kind: "sfd-unwritten-question", playerIndex: 0 })).toThrow(
      /sfd-unwritten-question/,
    );
  });

  it("still DROPS a registered question that has become moot", () => {
    // The half that must not change. "Discard 1" with an empty hand has no
    // options and is genuinely finished — dropping it is the rules working, and
    // it is why the fix cannot simply be "no options means throw".
    const state = makeState({ players: [makePlayer("p1", { hand: [] }), makePlayer("p2")] });
    const asked = parkDecision(state, { kind: "discard", playerIndex: 0, count: 1 });
    expect(asked.pendingDecisions).toHaveLength(0);
  });

  it("throws rather than reporting no legal actions", () => {
    // The path the AI walks. `legalActions` reads `optionsFor`, which returned
    // `[]` for an unregistered kind — indistinguishable from a moot question,
    // and the shape that made the settle loop score a half-resolved board.
    const state = asker(2);
    const stuck: GameState = {
      ...state,
      pendingDecisions: [{ id: "d1", kind: "sfd-unwritten-question", playerIndex: 0 }],
    };
    expect(() => legalActions(stuck)).toThrow(/sfd-unwritten-question/);
  });
  it("never leaves a head question with no answer — the invariant the AI leans on", () => {
    // `settleDeferredResolution` now THROWS rather than scoring a half-settled
    // board when a pending question offers nothing, and that is only safe
    // because of this: `parkDecision` either drains the head or leaves one with
    // real options. Never a head with zero.
    //
    // Pinned here rather than in the AI because this is where it can actually
    // break. Measured before the AI was changed: 18,823 pending-decision
    // iterations across 440 self-play games, none of them reaching that branch.
    const states = [
      parkDecision(asker(0), { kind: "discard", playerIndex: 0, count: 1 }), // moot: empty hand
      parkDecision(asker(3), { kind: "discard", playerIndex: 0, count: 1 }), // a real question
      parkDecision(asker(2), { kind: "draw", playerIndex: 0, count: 1 }), // one option, executed
    ];
    for (const state of states) {
      const head = pendingDecision(state);
      if (!head) continue;
      expect(optionsFor(state, head).length, `${head.kind} sits at the head with no answer`).toBeGreaterThan(0);
      expect(legalActions(state).length).toBeGreaterThan(0);
    }
    // And the positive control: at least one of those really did leave a
    // question standing, or this sweep is asserting nothing.
    expect(states.filter((s) => pendingDecision(s) !== undefined).length).toBeGreaterThan(0);
  });
});
