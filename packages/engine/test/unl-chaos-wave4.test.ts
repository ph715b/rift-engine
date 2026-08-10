import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { destroyUnit } from "../src/engine/effect-helpers.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { GOLD_TOKEN_DEF_ID } from "../src/engine/token.js";
import { runAwaken, runEnd } from "../src/engine/turn-manager.js";
import type { GameState } from "../src/model/game-state.js";
import type { ActivateAbilityAction, PlayCardAction } from "../src/actions/player-action.js";
import type { CardInstance, UnitInstance } from "../src/model/card.js";
import { answerDecisions, makeState, makeUnit, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * Unleashed wave 4, effects/chaos.ts — Maduli the Gatekeeper (UNL-144) and
 * Pyke - Returned (UNL-145).
 *
 * Everything here drives the REAL path: `legalActions` to find the action,
 * `submit` to take it, `resolveHeldTriggers` for the chain, `answerDecisions` for
 * the questions. A resolver called directly proves only that the resolver
 * compiles, and this codebase has repeatedly shipped cards that were written,
 * typechecked and unreachable at the same time.
 *
 * Every clause has a NEGATIVE control beside its positive one, and each negative
 * asserts its own positive control FIRST — otherwise "nothing happened" is
 * exactly what an inert card looks like.
 *
 * **One test deliberately asserts the WRONG answer** and is labelled: Maduli
 * READIES in the Awaken phase, though he prints "I can't be readied". That
 * restriction needs `turn-manager.runAwaken` and `effect-helpers.readyUnit`, both
 * shared files this wave may not edit. Implementing it must FLIP that test rather
 * than silently changing behaviour nobody was watching.
 */

const MADULI = "UNL-144";
const PYKE = "UNL-145";
/** Fury 1E/1P — "Deal 3 to a unit at a battlefield." The kill this file uses to
 *  reach Pyke's death-watch through a real spell rather than a helper call. */
const HEXTECH_RAY = "OGN-009";

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** A board with player 0 holding enough of everything to pay for any of this. */
function casterState(): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.floatingEnergy = 20;
  state.players[0]!.floatingPower = { Chaos: 9, Fury: 9 };
  return state;
}

const playOf = (state: GameState, card: CardInstance, targetInstanceId?: string): PlayCardAction => {
  const candidates = legalActions(state).filter(
    (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === card.instanceId,
  );
  const match =
    targetInstanceId === undefined ? candidates[0] : candidates.find((a) => a.targetUnitInstanceId === targetInstanceId);
  expect(match, `no legal play for ${card.name}`).toBeDefined();
  return match!;
};

/** Pops whatever is on the chain: both players pass, then the held triggers settle. */
function resolveChain(state: GameState): GameState {
  let next = state;
  for (let guard = 0; guard < 8 && next.spellChain.length > 0; guard += 1) {
    const pass = legalActions(next).find((a) => a.type === "PassFocus");
    if (!pass) break;
    next = accept(next, pass);
  }
  return resolveHeldTriggers(next);
}

const at = (state: GameState, battlefieldId: string, playerId: "p1" | "p2"): UnitInstance[] =>
  state.battlefields.find((b) => b.id === battlefieldId)!.units[playerId] ?? [];

const goldOf = (state: GameState, index: 0 | 1) => state.players[index]!.activeGear.filter((g) => g.defId === GOLD_TOKEN_DEF_ID);

// ---------------------------------------------------------------------------

describe("Maduli the Gatekeeper (UNL-144): [Chaos]: move me to an occupied enemy battlefield", () => {
  /**
   * Maduli in player 0's base, with `enemies` at bf2 (and optionally at bf1).
   *
   * He starts at BASE rather than at a battlefield so that every destination in
   * these tests is genuinely reachable — 355.4.a excludes the Location he is
   * already at, and putting him on the board would silently remove one option
   * from every option-count assertion below.
   */
  function maduliState(bf2Mights: number[], bf1Mights: number[] = []): { state: GameState; maduli: UnitInstance } {
    const maduli = realUnitInstance(MADULI);
    const state = casterState();
    state.players[0]!.baseUnits = [maduli];
    state.battlefields[0]!.units = { p2: bf1Mights.map((m, i) => makeUnit({ name: `A${i}`, might: m })) };
    state.battlefields[1]!.units = { p2: bf2Mights.map((m, i) => makeUnit({ name: `B${i}`, might: m })) };
    return { state, maduli };
  }

  const activationsOf = (state: GameState, instanceId: string): ActivateAbilityAction[] =>
    legalActions(state).filter(
      (a): a is ActivateAbilityAction => a.type === "ActivateAbility" && a.permanentInstanceId === instanceId,
    );

  /** He is 6 Might printed — this is the figure every threshold below is set against. */
  it("is the 6-Might body these thresholds are written against", () => {
    expect(realUnitInstance(MADULI).might).toBe(6);
  });

  it("walks onto an occupied enemy battlefield he outweighs, for one Chaos", () => {
    const { state, maduli } = maduliState([3]);

    const offers = activationsOf(state, maduli.instanceId);
    expect(offers, "the ability was never offered").toHaveLength(1);

    const after = answerDecisions(accept(state, offers[0]!));

    expect(
      at(after, "bf2", "p1").map((u) => u.instanceId),
      "he never arrived at the battlefield he was sent to",
    ).toEqual([maduli.instanceId]);
    expect(after.players[0]!.baseUnits, "he is in two places").toHaveLength(0);
    expect(after.players[0]!.floatingPower.Chaos, "the Chaos pip was not taken").toBe(8);
  });

  it("is NOT offered when the enemy Might there EQUALS his — 'GREATER than'", () => {
    // Positive control: the same board one Might lighter DOES offer it, so a
    // silent zero here would fail this line rather than pass the test.
    const { state: lighter, maduli: m1 } = maduliState([5]);
    expect(activationsOf(lighter, m1.instanceId), "control: 5 Might is under his 6 and IS offered").toHaveLength(1);

    const { state, maduli } = maduliState([3, 3]);
    expect(activationsOf(state, maduli.instanceId), "6 vs 6 is not 'greater than'").toHaveLength(0);
  });

  it("counts EFFECTIVE Might, not printed — a this-turn pump closes the door", () => {
    const { state: control, maduli: m1 } = maduliState([5]);
    expect(activationsOf(control, m1.instanceId), "control: an unpumped 5 IS offered").toHaveLength(1);

    const { state, maduli } = maduliState([5]);
    state.battlefields[1]!.units = { p2: [{ ...at(state, "bf2", "p2")[0]!, mightThisTurn: 1 }] };
    expect(activationsOf(state, maduli.instanceId), "the +1 this turn was not counted").toHaveLength(0);
  });

  it("is NOT offered a battlefield with no ENEMY on it — 'OCCUPIED enemy battlefield'", () => {
    const { state: control, maduli: m1 } = maduliState([1]);
    expect(activationsOf(control, m1.instanceId), "control: one enemy there IS offered").toHaveLength(1);

    // bf2 empty of enemies; bf1 holds only Maduli's OWN ally, so neither is an
    // "occupied enemy battlefield" however weak the opposition is.
    const { state, maduli } = maduliState([]);
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Friend", might: 1 })] };
    expect(activationsOf(state, maduli.instanceId), "an empty board is not an enemy battlefield").toHaveLength(0);
  });

  it("asks WHICH battlefield when two qualify, and moves him to the one chosen", () => {
    const { state, maduli } = maduliState([1], [1]);

    const asked = accept(state, activationsOf(state, maduli.instanceId)[0]!);
    const decision = pendingDecision(asked);
    expect(decision?.kind, "he never asked where to go").toBe("UNL-144-move");
    expect(optionsFor(asked, decision!).map((o) => o.id)).toEqual(["bf1", "bf2"]);

    // The SECOND option deliberately — the default chooser takes the first, so
    // picking it would not distinguish a working resolver from a broken one.
    const after = answerDecisions(asked, (options) => options.find((o) => o.id === "bf2")!.id);
    expect(at(after, "bf2", "p1").map((u) => u.instanceId)).toEqual([maduli.instanceId]);
    expect(at(after, "bf1", "p1"), "he went to the battlefield nobody chose").toHaveLength(0);
  });

  /**
   * **PIN OF A KNOWN DIVERGENCE — this asserts the WRONG answer on purpose.**
   *
   * Maduli prints "I can't be readied", and **315.1.b.1** puts that restriction in
   * the Awaken step: "The Turn Player readies all Game Objects they control **that
   * are able to be readied**." `turn-manager.runAwaken` readies the whole board
   * with an inline map and `effect-helpers.readyUnit` is the other door; both are
   * shared files this wave may not edit, so the restriction is unwritten and he is
   * STRONGER than printed.
   *
   * Implementing it must FLIP this test — change the expectation to `true` and
   * delete this comment — rather than quietly changing what an untested card does.
   */
  it("DIVERGENCE: readies in Awaken, though he prints 'I can't be readied'", () => {
    const { state, maduli } = maduliState([]);
    const exhausted: GameState = {
      ...state,
      phase: "Awaken",
      players: [{ ...state.players[0]!, baseUnits: [{ ...maduli, exhausted: true }] }, state.players[1]!],
    };

    const awakened = runAwaken(exhausted);

    expect(
      awakened.players[0]!.baseUnits[0]!.exhausted,
      "PIN: he stayed exhausted — 'I can't be readied' is implemented now, so flip this to true",
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("Pyke - Returned (UNL-145): once each turn, an enemy death mints a Gold", () => {
  /**
   * Pyke at bf1, `enemies` enemy units at bf1, and `rays` Hextech Rays in hand —
   * the kill goes through a real spell so the death-watch is reached the way a
   * game reaches it, not by calling the resolver.
   */
  function pykeState(enemies: number, rays = 1): {
    state: GameState;
    pyke: UnitInstance;
    foes: UnitInstance[];
    rays: CardInstance[];
  } {
    const pyke = realUnitInstance(PYKE);
    const foes = Array.from({ length: enemies }, (_, i) => makeUnit({ name: `Foe ${i + 1}`, might: 1 }));
    const hand = Array.from({ length: rays }, () => spellInstance(HEXTECH_RAY));
    const state = casterState();
    state.battlefields[0]!.units = { p1: [pyke], p2: foes };
    state.players[0]!.hand = hand;
    return { state, pyke, foes, rays: hand };
  }

  /** Kill one named enemy with one named Ray, through submit, and settle. */
  const zap = (state: GameState, ray: CardInstance, victim: UnitInstance): GameState =>
    answerDecisions(resolveChain(accept(state, playOf(state, ray, victim.instanceId))));

  it("mints one exhausted Gold when an enemy unit dies", () => {
    const { state, foes, rays } = pykeState(1);
    expect(goldOf(state, 0), "the fixture already had Gold").toHaveLength(0);

    const after = zap(state, rays[0]!, foes[0]!);

    expect(at(after, "bf1", "p2"), "the enemy survived — this fixture killed nothing").toHaveLength(0);
    const gold = goldOf(after, 0);
    expect(gold, "no Gold token was made").toHaveLength(1);
    expect(gold[0]!.exhausted, "a ready Gold is a free rainbow Power the turn it arrives").toBe(true);
  });

  /** The positive board again — the control every negative below asserts first. */
  const goldFromAnEnemyDeath = (): number => {
    const { state, foes, rays } = pykeState(1);
    return goldOf(zap(state, rays[0]!, foes[0]!), 0).length;
  };

  it("mints nothing when a FRIENDLY unit dies — 'an ENEMY unit'", () => {
    expect(goldFromAnEnemyDeath(), "the control board minted nothing either").toBe(1);

    const { state, rays } = pykeState(0);
    const ally = makeUnit({ name: "Ally", might: 1 });
    state.battlefields[0]!.units = { ...state.battlefields[0]!.units, p1: [...at(state, "bf1", "p1"), ally] };

    const after = zap(state, rays[0]!, ally);

    expect(at(after, "bf1", "p1").map((u) => u.name), "the ally survived").not.toContain("Ally");
    expect(goldOf(after, 0), "he paid out for his own side's loss").toHaveLength(0);
  });

  it("mints nothing while he is in BASE — 'while I'm at a battlefield'", () => {
    expect(goldFromAnEnemyDeath(), "the control board minted nothing either").toBe(1);

    const { state, pyke, foes, rays } = pykeState(1);
    // Same board, Pyke sent home: the enemy still dies at a battlefield, and the
    // clause under test is about where PYKE is, not where the death is.
    state.battlefields[0]!.units = { p2: foes };
    state.players[0]!.baseUnits = [pyke];

    const after = zap(state, rays[0]!, foes[0]!);

    expect(at(after, "bf1", "p2"), "the enemy survived").toHaveLength(0);
    expect(goldOf(after, 0), "he minted from base").toHaveLength(0);
  });

  it("mints ONCE for two enemy deaths in sequence — 'once each turn' (383.3.e.1)", () => {
    const { state, foes, rays } = pykeState(2, 2);

    const once = zap(state, rays[0]!, foes[0]!);
    expect(goldOf(once, 0), "the first death minted nothing — this test proves nothing").toHaveLength(1);

    const twice = zap(once, rays[1]!, foes[1]!);
    expect(goldOf(twice, 0), "the second death minted again").toHaveLength(1);
  });

  /**
   * The `applies` half of 383.3.e.1 — "if its trigger condition would be fulfilled
   * and it has already been performed that many times, **it does not trigger**".
   *
   * Observed on the CHAIN rather than on the board, because "does not trigger" and
   * "triggers and does nothing" are indistinguishable from the Gold count: both
   * end at one token. The difference is real in play — a placed Pending Item costs
   * both players a PassFocus round and opens a response window — and this is the
   * only assertion in this file that can see it. Written after a mutation run:
   * deleting the `applies` guard SURVIVED every other test here.
   */
  it("places NO chain item for a second enemy death — 'it does not trigger'", () => {
    const { state, foes, rays } = pykeState(2, 1);

    const spent = zap(state, rays[0]!, foes[0]!);
    expect(goldOf(spent, 0), "the first death minted nothing — this test proves nothing").toHaveLength(1);
    expect(spent.pendingTriggers, "the first death's item never settled").toHaveLength(0);

    const second = destroyUnit(spent, foes[1]!.instanceId);

    expect(
      second.pendingTriggers.filter((t) => t.listenerDefId === PYKE),
      "a spent Pyke still placed a chain item",
    ).toHaveLength(0);
  });

  /**
   * The other half of 383.3.e.1 — "will only be **performed** the specified number
   * of times each turn". Two enemies dying before either trigger resolves BOTH
   * fulfil the condition (383 fixes the set at the moment of the event), so both
   * are placed; only the resolve-side guard stops the second from minting.
   *
   * Killed through `destroyUnit` rather than a spell because that is the only way
   * to get two deaths held before either pops: the sequential test above is the
   * one that covers the full submit path.
   */
  it("mints ONCE when two enemies die SIMULTANEOUSLY", () => {
    const { state, foes } = pykeState(2);

    const both = resolveHeldTriggers(destroyUnit(destroyUnit(state, foes[0]!.instanceId), foes[1]!.instanceId));

    expect(at(both, "bf1", "p2"), "the sweep killed nothing").toHaveLength(0);
    expect(goldOf(both, 0), "both triggers minted").toHaveLength(1);
  });

  it("re-arms next turn — 'once each TURN'", () => {
    const { state, foes, rays } = pykeState(2, 2);

    const once = zap(state, rays[0]!, foes[0]!);
    expect(goldOf(once, 0)).toHaveLength(1);

    // runEnd clears `abilityModesUsedThisTurn` for every unit on both sides,
    // which is where his allowance lives.
    //
    // Two things it ALSO does have to be undone by hand, and both bit this test
    // before they were: it sweeps floating Energy and Power (this-turn resources,
    // so the second Ray became unaffordable — "no legal play for Hextech Ray"),
    // and it rotates the turn to player 1 (so player 0 could not act at all).
    // Neither is the clause under test; putting the board back where it was is
    // what isolates the field runEnd cleared.
    const swept = runEnd(once);
    const nextTurn: GameState = {
      ...swept,
      phase: "Action",
      activePlayerIndex: 0,
      players: [
        { ...swept.players[0]!, floatingEnergy: 20, floatingPower: { Chaos: 9, Fury: 9 } },
        swept.players[1]!,
      ],
    };
    const twice = zap(nextTurn, rays[1]!, foes[1]!);

    expect(goldOf(twice, 0), "he never re-armed").toHaveLength(2);
  });
});
