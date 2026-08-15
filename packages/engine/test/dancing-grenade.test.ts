import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import type { UnitInstance } from "../src/model/card.js";
import { makeState, makeUnit, spellInstance } from "./fixtures.js";

/**
 * UNL-020 Dancing Grenade — "Deal 2 to a unit. **Its controller** may play this
 * spell again for [rainbow]. If they do, this deals 1 additional Bonus Damage for
 * each time this spell has dealt damage this turn."
 *
 * # The refusal was right about its blocker and wrong about its fix
 *
 * This card was refused across four waves, and its last refusal (2026-08-13) was
 * the sharpest: a replay has to become a PERMISSION the ordinary play path
 * spends, `timing.mayPlayCardNow` opens with `playerIndex !==
 * actingPlayerIndex(state)`, the card is Default-timed, and the grant clears at
 * `runEnd` — so a cross-seat replay is not merely unwritten, it is UNUSABLE. It
 * added that this engine cannot pay mid-resolution.
 *
 * Every word of the first half is true OF THE PERMISSION PATH, and the answer was
 * to not take it. A parked decision is answered by whoever it names — active
 * player or not — and `payPowerFromChanneled` has paid a Power cost from inside a
 * resolution since Flame Chompers. So the tests below are pointed squarely at the
 * two things the refusal said were impossible: **the opponent is the one who gets
 * the offer**, and **they pay a real pip for it**.
 *
 * # The three ways a plausible fake would differ
 *
 * The refusal named the fake that would have passed a shallow test — park a "pay
 * [rainbow] to deal 2 more" question on the CASTER — and named its three
 * differences. Each is asserted here by name:
 *
 *  - **wrong player**: the question goes to the DAMAGED unit's controller.
 *  - **no replay**: a real play fires `cardPlayed` again, which Katarina -
 *    Reckless and Black Market Broker watch, and bumps `cardsPlayedThisTurn`.
 *  - **a fixed bonus where the printed one escalates**: 2, then 3, then 4.
 *
 * Everything goes through `legalActions`/`submit`, never a resolver called by
 * hand: the whole point of this card is WHO is offered the action, and only the
 * real funnel can answer that.
 */

const registry = defaultCardRegistry();
const DANCING_GRENADE = "UNL-020";

const rune = (id: string, domain: RuneCard["domain"] = "Fury"): RuneCard => ({ id, domain, state: "Ready" });

const unitOnBoard = (state: GameState, instanceId: string): UnitInstance | undefined =>
  [
    ...state.players[0]!.baseUnits,
    ...state.players[1]!.baseUnits,
    ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
  ].find((u) => u.instanceId === instanceId);

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** Passes focus until the chain empties or a question stops it. */
function settle(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 12 && current.spellChain.length > 0; guard += 1) {
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) break;
    current = accept(current, pass);
  }
  return current;
}

/**
 * The caster (player 0) holds the Grenade; the opponent holds runes of their own,
 * which is what makes the replay offer reachable at all.
 *
 * Nine-Might bodies throughout so nothing the card does can kill one — a death
 * would remove the unit the next execution is measured on, and the escalation is
 * the point.
 */
function board(opponentRunes = 3): GameState {
  const state = makeState({ phase: "Action" });
  state.battlefields[0]!.units = {
    p1: [makeUnit({ instanceId: "bystander", might: 9 })],
    p2: [makeUnit({ instanceId: "enemy", might: 9 })],
  };
  state.players[0]!.baseUnits = [makeUnit({ instanceId: "myHomebody", might: 9 })];
  state.players[1]!.baseUnits = [makeUnit({ instanceId: "theirHomebody", might: 9 })];
  state.players[0]!.hand = [spellInstance(DANCING_GRENADE)];
  state.players[0]!.channeled = Array.from({ length: 8 }, (_, i) => rune(`f${i}`));
  state.players[1]!.channeled = Array.from({ length: opponentRunes }, (_, i) => rune(`o${i}`, "Chaos"));
  return state;
}

const castsOf = (state: GameState, defId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === defId);

function castAt(state: GameState, targetInstanceId: string): GameState {
  const play = castsOf(state, DANCING_GRENADE).find((a) => a.targetUnitInstanceId === targetInstanceId);
  expect(play, `Dancing Grenade was not castable at ${targetInstanceId}`).toBeDefined();
  return settle(accept(state, play));
}

/** Answers the front question with the named option, through `submit`. */
function answer(state: GameState, optionId: string): GameState {
  const decision = pendingDecision(state);
  expect(decision, "no question was pending").toBeDefined();
  const action = legalActions(state).find((a) => a.type === "AnswerDecision" && a.optionId === optionId);
  expect(action, `"${optionId}" was not on offer; got ${JSON.stringify(optionsFor(state, decision!).map((o) => o.id))}`).toBeDefined();
  return settle(accept(state, action));
}

describe("the offer goes to the DAMAGED unit's controller, not the caster", () => {
  it("hitting an enemy unit parks the question for the OPPONENT", () => {
    const after = castAt(board(), "enemy");
    const decision = pendingDecision(after);

    expect(decision, "no replay question was parked at all").toBeDefined();
    expect(decision!.playerIndex, "the question went to the caster — that is the fake this card was refused over").toBe(1);
  });

  /**
   * The half the old refusal said WOULD have worked, kept as the control: pointing
   * the Grenade at your own unit makes you the controller, so the offer comes back
   * to you. If only this case worked, the card would be correct in the minority
   * case and inert in the majority — which is why the test above is the one that
   * matters and this one only proves the seat is read rather than hardcoded.
   */
  it("hitting your OWN unit parks it for you", () => {
    const after = castAt(board(), "bystander");
    expect(pendingDecision(after)?.playerIndex).toBe(0);
  });

  /** Only the answerer may act while the question stands — the whole reason this
   *  is a decision rather than a play permission. */
  it("and while it stands, the ONLY legal actions belong to that player", () => {
    const after = castAt(board(), "enemy");
    const actions = legalActions(after);

    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action.type).toBe("AnswerDecision");
      expect((action as { playerIndex: 0 | 1 }).playerIndex).toBe(1);
    }
  });
});

describe("the replay is a real play, paid for with a real pip", () => {
  it("costs 1 Power of any domain, and the opponent's pool pays it", () => {
    const start = board();
    const offered = castAt(start, "enemy");
    const before = offered.players[1]!.channeled.length;

    const replayed = answer(answer(offered, "replay"), "bystander");
    // Paying Power RECYCLES the rune — 416 — so the pool is one smaller.
    expect(replayed.players[1]!.channeled.length, "no rune was spent on the replay").toBe(before - 1);
  });

  /** "Play this spell AGAIN" — so it is a card the opponent played, which is what
   *  [Legion] and Viktor - Innovator count. */
  it("bumps the REPLAYER's cardsPlayedThisTurn, not the caster's", () => {
    const offered = castAt(board(), "enemy");
    const casterBefore = offered.players[0]!.cardsPlayedThisTurn;
    const replayed = answer(answer(offered, "replay"), "bystander");

    expect(replayed.players[1]!.cardsPlayedThisTurn).toBe(offered.players[1]!.cardsPlayedThisTurn + 1);
    expect(replayed.players[0]!.cardsPlayedThisTurn, "the caster was charged for a play they did not make").toBe(casterBefore);
  });

  /**
   * A card goes to its OWNER's trash, not its controller's. Without the
   * `spellTrashOwnerIndex` this needed from `playCardIgnoringCost`, the Grenade
   * migrates across the table one replay at a time.
   */
  it("returns to the CASTER's trash, not the replayer's", () => {
    const replayed = answer(answer(castAt(board(), "enemy"), "replay"), "bystander");

    expect(replayed.players[0]!.trash.filter((c) => c.defId === DANCING_GRENADE)).toHaveLength(1);
    expect(replayed.players[1]!.trash.filter((c) => c.defId === DANCING_GRENADE)).toHaveLength(0);
  });

  /** The replayer aims it, and "a unit" is bare — so their own board and the
   *  caster's are both on the list (355.9.a.1). */
  it("lets the replayer aim it anywhere on the board, including back at the caster", () => {
    const offered = answer(castAt(board(), "enemy"), "replay");
    const targets = optionsFor(offered, pendingDecision(offered)!).map((o) => o.id);

    expect(targets).toEqual(expect.arrayContaining(["enemy", "bystander", "myHomebody", "theirHomebody"]));
  });
});

describe("the escalation — 1 more for each time this spell has dealt damage this turn", () => {
  it("2, then 3", () => {
    const offered = castAt(board(), "enemy");
    expect(unitOnBoard(offered, "enemy")!.damage, "the first hit was not the printed 2").toBe(2);

    const replayed = answer(answer(offered, "replay"), "bystander");
    // One damage instance already this turn, so 2 + 1.
    expect(unitOnBoard(replayed, "bystander")!.damage).toBe(3);
  });

  it("...then 4, and the tally is per CARD INSTANCE", () => {
    const first = castAt(board(4), "enemy");
    const second = answer(answer(first, "replay"), "bystander");
    // The second execution damaged the caster's own unit, so the third offer is
    // the CASTER's, and they have runes.
    expect(pendingDecision(second)?.playerIndex).toBe(0);
    const third = answer(answer(second, "replay"), "theirHomebody");

    expect(unitOnBoard(third, "theirHomebody")!.damage).toBe(4);
  });

  /** The control: a fresh copy of the card opens at 2, however much a different
   *  copy has already dealt. The tally is keyed by instanceId for exactly this. */
  it("a SECOND copy of the card opens at 2 rather than inheriting the first's history", () => {
    const start = board();
    const second = spellInstance(DANCING_GRENADE);
    start.players[0]!.hand = [...start.players[0]!.hand, second];

    // The second execution hits the caster's own unit, so a THIRD offer is parked
    // for the caster — declined here, because a pending question is the only
    // thing `legal-actions` will offer and the second copy could not be cast
    // while it stood.
    const afterFirst = answer(answer(answer(castAt(start, "enemy"), "replay"), "bystander"), "decline");
    const play = castsOf(afterFirst, DANCING_GRENADE).find(
      (a) => a.card.instanceId === second.instanceId && a.targetUnitInstanceId === "theirHomebody",
    );
    expect(play, "the second copy was not castable").toBeDefined();
    const afterSecond = settle(accept(afterFirst, play));

    expect(unitOnBoard(afterSecond, "theirHomebody")!.damage).toBe(2);
  });
});

describe("declining, and the offer that is never made", () => {
  it("declining leaves the damage and nothing else", () => {
    const declined = answer(castAt(board(), "enemy"), "decline");

    expect(unitOnBoard(declined, "enemy")!.damage).toBe(2);
    expect(declined.players[0]!.trash.filter((c) => c.defId === DANCING_GRENADE)).toHaveLength(1);
    expect(declined.pendingDecisions).toEqual([]);
    expect(declined.players[1]!.channeled.length, "a rune was spent on a declined offer").toBe(3);
  });

  /**
   * 416.3 — the cost must be payable for the option to exist. With the opponent's
   * pool empty the list is a bare decline, and `advanceDecisions` executes a
   * one-option question without prompting, so nothing is even asked.
   */
  it("an opponent who cannot pay the pip is never offered the replay", () => {
    const after = castAt(board(0), "enemy");

    expect(pendingDecision(after), "a question with only a decline was still put to the player").toBeUndefined();
    expect(unitOnBoard(after, "enemy")!.damage).toBe(2);
  });
});

describe("coverage", () => {
  it("is implemented, with no partial note left behind", () => {
    expect(isCardImplemented(registry.get(DANCING_GRENADE))).toBe(true);
    expect(partialImplementationNote(registry.get(DANCING_GRENADE))).toBeUndefined();
  });
});
