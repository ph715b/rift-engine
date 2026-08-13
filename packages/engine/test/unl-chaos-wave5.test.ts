import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { findUnitAnywhere } from "../src/engine/target-lookup.js";
import type { GameState } from "../src/model/game-state.js";
import type { CardInstance, UnitInstance } from "../src/model/card.js";
import type { MoveUnitAction, PlayCardAction } from "../src/actions/player-action.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * Unleashed wave 5, effects/chaos.ts — Diana - No Longer Human (UNL-149) and
 * Vex - Apathetic (UNL-150).
 *
 * Everything here drives the REAL path: `legalActions` to find the action,
 * `submit` to take it, then the chain is passed out and the held triggers
 * settled. A resolver called directly proves only that the resolver compiles,
 * and this codebase has repeatedly shipped cards that were written, typechecked
 * and unreachable in the same commit.
 *
 * Every negative control asserts its own POSITIVE control first, in the same
 * test where that is possible — "nothing happened" is exactly what an inert card
 * looks like, so a bare `toBe(0)` proves nothing on its own.
 *
 * **One test deliberately asserts the WRONG answer** and is labelled: Vex's
 * "they can't move it this turn" is unimplemented, so the stunned unit is still
 * offered a legal `MoveUnit`. That restriction needs `validate-move-unit.ts`, a
 * shared file this wave may not edit, and that file's own doc comment already
 * names "Vex - Apathetic's movement lock" among the exceptions it omits.
 * Implementing it must FLIP that test rather than silently changing behaviour
 * nobody was watching.
 */

const DIANA = "UNL-149";
const VEX = "UNL-150";
/** Confront — Body, 2 Energy, no Power, no target. The cheapest real SPELL that
 *  resolves with nothing on the board, so "she pumped" cannot be an artefact of
 *  what the spell itself did. */
const CONFRONT = "OGN-129";
/** Chaos, 3 Energy, 3 Might, and PRINTED BLANK — the opponent body Vex stuns.
 *  Vanilla on purpose: an on-play trigger of its own would put a second held item
 *  on the chain beside the one under test. */
const VANILLA_UNIT = "OGN-175";
/** Chaos, 3 Energy, 3 Might, "You may play me to an open battlefield" — a SECOND
 *  distinct body, so a two-unit test cannot confuse the two. */
const OPEN_FIELD_UNIT = "OGN-176";

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** A board where both players can pay for anything in this file. */
function richState(activePlayerIndex: 0 | 1): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex });
  for (const player of state.players) {
    player.floatingEnergy = 20;
    player.floatingPower = { Chaos: 9, Body: 9, Fury: 9, Mind: 9, Order: 9, Calm: 9 };
    // Confront draws 1, and an empty deck is a loss condition rather than a
    // no-op — filler so the spell under test never ends the game mid-assertion.
    player.deck = [spellInstance(CONFRONT), spellInstance(CONFRONT), spellInstance(CONFRONT)];
  }
  return state;
}

const playOf = (state: GameState, card: CardInstance, destinationBattlefieldId?: string): PlayCardAction => {
  const candidates = legalActions(state).filter(
    (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === card.instanceId,
  );
  const match =
    destinationBattlefieldId === undefined
      ? candidates.find((a) => a.destinationBattlefieldId === undefined)
      : candidates.find((a) => a.destinationBattlefieldId === destinationBattlefieldId);
  expect(match, `no legal play for ${card.name} to ${destinationBattlefieldId ?? "base"}`).toBeDefined();
  return match!;
};

/** Pops whatever is on the chain: both players pass, then the held items settle. */
function resolveChain(state: GameState): GameState {
  let next = state;
  for (let guard = 0; guard < 8 && next.spellChain.length > 0; guard += 1) {
    const pass = legalActions(next).find((a) => a.type === "PassFocus");
    if (!pass) break;
    next = accept(next, pass);
  }
  return resolveHeldTriggers(next);
}

/** Plays `card` through the real path and settles everything it put on the chain. */
const playAndSettle = (state: GameState, card: CardInstance, destinationBattlefieldId?: string): GameState =>
  resolveChain(accept(state, playOf(state, card, destinationBattlefieldId)));

/**
 * How many of Vex's triggered abilities are waiting to resolve.
 *
 * Both queues, because a held item lives in `pendingTriggers` until the Cleanup
 * finalizes it onto `spellChain` and which side of that line a `submit` leaves it
 * on is not this file's business to assert.
 */
const vexTriggersOn = (state: GameState): number =>
  [...state.pendingTriggers, ...state.spellChain].filter(
    (entry) => "listenerDefId" in entry && entry.listenerDefId === VEX,
  ).length;

const live = (state: GameState, instanceId: string): UnitInstance => {
  const found = findUnitAnywhere(state, instanceId);
  expect(found, "the unit left the board").toBeDefined();
  return found!.unit;
};

// ---------------------------------------------------------------------------

describe("Diana - No Longer Human (UNL-149): when you play a spell, give me +2 Might this turn", () => {
  /** Diana at bf1 for player 0, with `CONFRONT` in that player's hand. */
  function dianaState(dianaAt: "bf1" | "base" = "bf1"): {
    state: GameState;
    diana: UnitInstance;
    spell: CardInstance;
  } {
    const diana = realUnitInstance(DIANA);
    const spell = spellInstance(CONFRONT);
    const state = richState(0);
    if (dianaAt === "base") state.players[0]!.baseUnits = [diana];
    else state.battlefields[0]!.units = { p1: [diana] };
    state.players[0]!.hand = [spell];
    return { state, diana, spell };
  }

  it("is the 3-Might body these figures are written against", () => {
    const diana = realUnitInstance(DIANA);
    expect(diana.might).toBe(3);
    expect(diana.mightThisTurn).toBe(0);
  });

  it("grows +2 when her controller plays a spell", () => {
    const { state, diana, spell } = dianaState();

    const after = playAndSettle(state, spell);

    expect(live(after, diana.instanceId).mightThisTurn, "Diana never saw the spell").toBe(2);
  });

  it("grows again for a SECOND spell in the same turn — she prints no cap", () => {
    const { state, diana } = dianaState();
    const first = spellInstance(CONFRONT);
    const second = spellInstance(CONFRONT);
    state.players[0]!.hand = [first, second];

    const once = playAndSettle(state, first);
    expect(live(once, diana.instanceId).mightThisTurn, "the first spell did nothing").toBe(2);

    const twice = playAndSettle(once, second);
    expect(live(twice, diana.instanceId).mightThisTurn, "the second spell was swallowed").toBe(4);
  });

  it("fires from BASE too — she prints no location", () => {
    const { state, diana, spell } = dianaState("base");

    const after = playAndSettle(state, spell);

    expect(live(after, diana.instanceId).mightThisTurn).toBe(2);
  });

  it("does NOT grow on a UNIT being played, though it does on a spell", () => {
    const { state, diana } = dianaState();
    const unit = realUnitInstance(VANILLA_UNIT);
    const spell = spellInstance(CONFRONT);
    state.players[0]!.hand = [unit, spell];

    const afterUnit = playAndSettle(state, unit);
    expect(live(afterUnit, diana.instanceId).mightThisTurn, "a unit is not a spell").toBe(0);

    // The positive control, on the SAME board — otherwise the zero above is
    // indistinguishable from a trigger that never fires at all.
    const afterSpell = playAndSettle(afterUnit, spell);
    expect(live(afterSpell, diana.instanceId).mightThisTurn).toBe(2);
  });

  it("does NOT grow on the OPPONENT's spell — 'when YOU play'", () => {
    const { state, diana } = dianaState();
    const mine = spellInstance(CONFRONT);
    const theirs = spellInstance(CONFRONT);
    state.players[0]!.hand = [mine];
    state.players[1]!.hand = [theirs];

    const enemyTurn = playAndSettle({ ...state, activePlayerIndex: 1 }, theirs);
    expect(live(enemyTurn, diana.instanceId).mightThisTurn, "an enemy spell fed her").toBe(0);

    const ownTurn = playAndSettle({ ...enemyTurn, activePlayerIndex: 0 }, mine);
    expect(live(ownTurn, diana.instanceId).mightThisTurn).toBe(2);
  });
});

// ---------------------------------------------------------------------------

describe("Vex - Apathetic (UNL-150): when an opponent plays a unit while I'm at a battlefield, Stun it", () => {
  /** Vex at `vexAt` for player 0, with player 1 active and a body in hand. */
  function vexState(vexAt: "bf1" | "base"): { state: GameState; vex: UnitInstance; body: UnitInstance } {
    const vex = realUnitInstance(VEX);
    const body = realUnitInstance(VANILLA_UNIT);
    const state = richState(1);
    if (vexAt === "base") state.players[0]!.baseUnits = [vex];
    else state.battlefields[0]!.units = { p1: [vex] };
    state.players[1]!.hand = [body];
    return { state, vex, body };
  }

  it("stuns the unit an opponent plays", () => {
    const { state, body } = vexState("bf1");

    const after = playAndSettle(state, body);

    expect(live(after, body.instanceId).stunned, "the arrival was never stunned").toBe(true);
  });

  it("reaches a unit played at a DIFFERENT battlefield — she prints 'at a battlefield', not 'here'", () => {
    const { state, body } = vexState("bf1");
    // 813 only lets a unit be played to a battlefield its controller already
    // occupies, so player 1 needs a foothold at bf2 for the destination to be
    // offered at all. That garrison is deliberately NOT the unit under test — it
    // was on the board before Vex's trigger existed and must stay unstunned.
    const garrison = makeUnit({ name: "Garrison" });
    state.battlefields[1]!.units = { p2: [garrison] };

    const after = playAndSettle(state, body, "bf2");

    expect(live(after, garrison.instanceId).stunned, "a bystander was stunned too").toBe(false);

    expect(
      state.battlefields[0]!.units["p1"]!.map((u) => u.defId),
      "the fixture put Vex somewhere other than bf1",
    ).toEqual([VEX]);
    expect(live(after, body.instanceId).stunned, "she only watched her own battlefield").toBe(true);
  });

  it("does NOT stun while Vex is in BASE, though the same play is stunned from a battlefield", () => {
    const fromBase = vexState("base");
    const afterBase = playAndSettle(fromBase.state, fromBase.body);
    expect(live(afterBase, fromBase.body.instanceId).stunned, "a Vex at home stunned anyway").toBe(false);

    const fromField = vexState("bf1");
    const afterField = playAndSettle(fromField.state, fromField.body);
    expect(live(afterField, fromField.body.instanceId).stunned, "the positive control failed").toBe(true);
  });

  it("does NOT stun her CONTROLLER's own units, though it stuns the opponent's", () => {
    const { state, vex } = vexState("bf1");
    const friendly = realUnitInstance(VANILLA_UNIT);
    const enemy = realUnitInstance(OPEN_FIELD_UNIT);
    const ownTurn = { ...state, activePlayerIndex: 0 as const };
    ownTurn.players[0]!.hand = [friendly];
    ownTurn.players[1]!.hand = [enemy];

    const afterFriendly = playAndSettle(ownTurn, friendly);
    expect(live(afterFriendly, friendly.instanceId).stunned, "Vex stunned her own reinforcement").toBe(false);
    expect(live(afterFriendly, vex.instanceId), "Vex left the board").toBeDefined();

    const afterEnemy = playAndSettle({ ...afterFriendly, activePlayerIndex: 1 }, enemy);
    expect(live(afterEnemy, enemy.instanceId).stunned, "the positive control failed").toBe(true);
  });

  it("does NOT fire on an opponent's SPELL, though it fires on their unit", () => {
    const { state, body } = vexState("bf1");
    const spell = spellInstance(CONFRONT);
    state.players[1]!.hand = [spell, body];

    // **Asserted on the CHAIN, before it is drained, and that is the whole
    // point of this test.** A Vex whose `playedKind` check was missing would
    // still leave the board untouched after a Spell — `stunUnits` is handed the
    // Spell's instanceId, finds no unit, and returns the state it was given. The
    // only observable difference is the Pending Item that should never have been
    // placed, so a board assertion here is vacuous and was measured to be: the
    // mutation that drops the check survived it.
    const afterSpell = accept(state, playOf(state, spell));
    expect(vexTriggersOn(afterSpell), "a Spell put a Vex trigger on the chain").toBe(0);

    const settled = resolveChain(afterSpell);
    const afterUnit = accept(settled, playOf(settled, body));
    expect(vexTriggersOn(afterUnit), "the positive control failed — no trigger for a unit either").toBe(1);
    expect(live(resolveChain(afterUnit), body.instanceId).stunned, "the positive control failed").toBe(true);
  });

  it("stuns a unit that arrives in the opponent's BASE — 355.9.a.1's bare 'a unit'", () => {
    const { state, body } = vexState("bf1");

    const after = playAndSettle(state, body);

    expect(
      after.players[1]!.baseUnits.map((u) => u.instanceId),
      "the fixture played it somewhere other than base",
    ).toEqual([body.instanceId]);
    expect(live(after, body.instanceId).stunned).toBe(true);
  });

  /**
   * **PINNED GAP — this asserts the WRONG answer on purpose.**
   *
   * "They can't move it this turn" is unimplemented: there is no per-unit
   * movement lock in this engine and `validate-move-unit.ts` is a shared file
   * this wave may not edit. Its own doc comment already lists "Vex - Apathetic's
   * movement lock" among the named-card exceptions it omits.
   *
   * The gap is NARROWER than it reads, which is why it needs a fixture rather
   * than an obvious repro: a unit normally arrives exhausted and an exhausted
   * unit cannot move at all, so the lock only bites when something readied it.
   * `unitsEnterReadyThisTurn` (Confront's flag) is the cheapest such thing.
   *
   * Implementing the clause must flip the second expectation to "no legal move",
   * loudly, rather than quietly changing what a stunned unit can do.
   */
  it("PINNED: the stunned unit can still be moved this turn — 'they can't move it' is unwritten", () => {
    const { state, body } = vexState("bf1");
    state.players[1]!.unitsEnterReadyThisTurn = true;

    const after = playAndSettle(state, body);

    expect(live(after, body.instanceId).stunned, "the stun itself failed, so this pins nothing").toBe(true);
    expect(live(after, body.instanceId).exhausted, "it arrived exhausted, so the move was never possible").toBe(false);

    const moves = legalActions(after).filter(
      (a): a is MoveUnitAction => a.type === "MoveUnit" && a.unitInstanceIds.includes(body.instanceId),
    );
    // **FLIPPED on 2026-08-13, exactly as this pin's own message asked.** The
    // lock is `GameState.movementLockedUnitInstanceIds`, written when Vex
    // resolves and swept by `runEnd` like every other this-turn effect.
    //
    // The positive control above still stands and is what keeps this honest: the
    // stunned unit arrives READY, so it could move but for the lock. Without that
    // line, an exhausted body would satisfy this assertion for the wrong reason —
    // which is precisely why the lock is its own field rather than more
    // exhaustion.
    expect(moves.length, "the stunned unit can be moved again — Vex's second clause stopped applying").toBe(0);
  });
});
