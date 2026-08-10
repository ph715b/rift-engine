import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { CardInstance, UnitInstance } from "../src/model/card.js";
import {
  answerDecisions,
  beginCombatAt,
  makeState,
  makeUnit,
  realGearInstance,
  realUnitInstance,
  resolveHeldTriggers,
  spellInstance,
} from "./fixtures.js";

/**
 * Unleashed wave 3, effects/chaos.ts.
 *
 * Everything here drives the REAL path — `legalActions` to find the action,
 * `submit` to take it, `resolveHeldTriggers` for the chain, `answerDecisions` for
 * the questions. A resolver called directly proves only that the resolver
 * compiles; this codebase has repeatedly shipped cards that were written,
 * typechecked and unreachable at the same time.
 *
 * Every card here has a NEGATIVE control beside its positive one, and each
 * negative asserts its own positive control first — otherwise "nothing happened"
 * is exactly what an inert card looks like.
 *
 * Two tests deliberately assert the WRONG answer, and both are labelled: Scryer's
 * Bloom entering READY (its "This enters exhausted" needs a row in deploy.ts) and
 * Conscription refusing a 4-Might target at 5 XP (its optional XP additional cost
 * has no mechanism). Closing either should FLIP its pin, not delete it.
 */

const SCRYERS_BLOOM = "UNL-136";
const BONE_SKEWER = "UNL-139";
const CONSCRIPTION = "UNL-140";
const EVELYNN = "UNL-141";
const KHAZIX = "UNL-143";
/** Fury 1E/1P — "Deal 3 to a unit at a battlefield." Used here only to put a
 *  spell on the chain, which is how player 0 gets priority on player 1's turn. */
const HEXTECH_RAY = "OGN-009";

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** A board with the caster holding enough of everything to play any of these. */
function casterState(): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.floatingEnergy = 20;
  state.players[0]!.floatingPower = { Chaos: 9, Fury: 9 };
  return state;
}

const plays = (state: GameState, defId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === defId);

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

const unitsInPlay = (state: GameState): UnitInstance[] => [
  ...state.players[0]!.baseUnits,
  ...state.players[1]!.baseUnits,
  ...state.battlefields.flatMap((bf) => [...(bf.units["p1"] ?? []), ...(bf.units["p2"] ?? [])]),
];

const findAnywhere = (state: GameState, instanceId: string): UnitInstance | undefined =>
  unitsInPlay(state).find((u) => u.instanceId === instanceId);

/** Answers every question, taking the FIRST option whose id matches `wanted`
 *  (falling back to the first option) — the tests that care which answer is given
 *  say so, the ones that do not read like `answerDecisions` alone. */
function answerWith(state: GameState, wanted: (ids: string[]) => string | undefined): GameState {
  return answerDecisions(state, (options) => {
    const chosen = wanted(options.map((o) => o.id));
    return chosen !== undefined && options.some((o) => o.id === chosen) ? chosen : options[0]!.id;
  });
}

const names = (cards: readonly CardInstance[]): string[] => cards.map((c) => c.name);

// ---------------------------------------------------------------------------

describe("Kha'Zix - Mutating Horror (UNL-143): when I attack or defend, if an enemy unit is ALONE here", () => {
  /** Kha'Zix at bf1 facing `enemyCount` enemies there. */
  function khazixState(enemyCount: number): { state: GameState; kha: UnitInstance } {
    const kha = realUnitInstance(KHAZIX);
    const state = casterState();
    state.battlefields[0]!.units = {
      p1: [kha],
      p2: Array.from({ length: enemyCount }, (_, i) => makeUnit({ name: `Enemy ${i + 1}` })),
    };
    return { state, kha };
  }

  it("pays out when he ATTACKS into a lone enemy", () => {
    const { state, kha } = khazixState(1);
    expect(state.players[0]!.xp).toBe(0);

    const after = beginCombatAt(state, "bf1", 0);

    const live = findAnywhere(after, kha.instanceId)!;
    expect(live.mightThisTurn, "he was given no Might").toBe(2);
    // The printed 4 plus the 2, read through the same layer combat reads — a
    // `mightThisTurn` field nothing consults would be a write, not a pump.
    expect(
      effectiveMight(after, live, 0, { isCombat: false, battlefieldId: "bf1" }),
      "the pump never reached his effective Might",
    ).toBe(6);
    expect(after.players[0]!.xp, "the 2 XP never landed").toBe(2);
  });

  it("pays out when he DEFENDS against a lone enemy — 'attack OR defend'", () => {
    const { state, kha } = khazixState(1);

    const after = beginCombatAt(state, "bf1", 1);

    expect(findAnywhere(after, kha.instanceId)!.mightThisTurn, "defending paid nothing").toBe(2);
    expect(after.players[0]!.xp).toBe(2);
  });

  it("pays NOTHING when two enemies stand here — 740.2.a's 'alone'", () => {
    // Its own positive control first: one enemy on the same fixture pays 2/2.
    const control = beginCombatAt(khazixState(1).state, "bf1", 0);
    expect(control.players[0]!.xp, "the control board paid nothing either").toBe(2);

    const { state, kha } = khazixState(2);
    const after = beginCombatAt(state, "bf1", 0);

    expect(findAnywhere(after, kha.instanceId)!.mightThisTurn, "a crowd still paid out").toBe(0);
    expect(after.players[0]!.xp, "a crowd still paid XP").toBe(0);
  });

  it("counts only the ENEMY's units — his own friends standing beside him are irrelevant", () => {
    // 740.2.a measures "alone" against the subject unit's own friendlies, so
    // Kha'Zix piling in with allies does NOT switch his own payout off. This is
    // the reading that would silently invert if `enemyUnitsAt` were replaced by a
    // count of everyone present.
    const { state, kha } = khazixState(1);
    state.battlefields[0]!.units = {
      ...state.battlefields[0]!.units,
      p1: [kha, makeUnit({ name: "Ally A" }), makeUnit({ name: "Ally B" })],
    };

    const after = beginCombatAt(state, "bf1", 0);

    expect(findAnywhere(after, kha.instanceId)!.mightThisTurn).toBe(2);
    expect(after.players[0]!.xp).toBe(2);
  });
});

describe("Evelynn - Entrancing (UNL-141): played FROM FACE DOWN on YOUR turn", () => {
  /**
   * Evelynn hidden at bf1 since turn 1, with an enemy sitting in the opponent's
   * BASE — "a different location", which by 828 includes a base and is the reach
   * this clause buys over an "at a battlefield" wording.
   *
   * **The Guard is not decoration.** Cleanup step 5 removes a facedown card from a
   * battlefield its owner no longer controls (`removeUnheldHiddenCards`), and
   * control lapses at an unoccupied battlefield — so a hidden card at an empty,
   * uncontrolled bf1 survives only as long as no Cleanup runs. The negative below
   * submits an action before playing her, so without a body holding bf1 she would
   * simply be gone and the test would pass for the wrong reason.
   */
  function evelynnState(activePlayerIndex: 0 | 1 = 0): { state: GameState; eve: UnitInstance; prey: UnitInstance } {
    const eve = realUnitInstance(EVELYNN);
    const prey = makeUnit({ name: "Prey" });
    const state = casterState();
    state.turnNumber = 3;
    state.activePlayerIndex = activePlayerIndex;
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      controllerId: "p1",
      units: { p1: [makeUnit({ name: "Guard", might: 9 })] },
      hiddenCards: [{ ownerIndex: 0, card: eve, hiddenOnTurn: 1 }],
    };
    state.players[1]!.baseUnits = [prey];
    if (activePlayerIndex === 1) {
      // On the OPPONENT'S turn she can only be played at all while player 0 is
      // the one the game is waiting on — `actingPlayerIndex` hands a Neutral Open
      // State to the TURN player, so a bare `activePlayerIndex = 1` enumerates
      // nothing for player 0 and the negative below would be vacuous. So the
      // opponent gets a spell to put on the chain and then passes, which is the
      // ordinary way a [Hidden] card is unhidden as a Reaction (811): priority
      // comes to player 0 with the chain closed.
      state.players[1]!.hand = [spellInstance(HEXTECH_RAY)];
      state.players[1]!.floatingEnergy = 20;
      state.players[1]!.floatingPower = { Fury: 9 };
    }
    return { state, eve, prey };
  }

  /** The board with the enemy dragged in — asserted by name so a test that means
   *  "she pulled it here" cannot pass on the Guard alone. */
  const atHerBattlefield = (state: GameState): string[] => [
    ...at(state, "bf1", "p1").map((u) => u.name),
    ...at(state, "bf1", "p2").map((u) => u.name),
  ];

  const hiddenPlay = (state: GameState, instanceId: string) =>
    legalActions(state).find(
      (a) => a.type === "PlayCard" && a.card.instanceId === instanceId && a.fromHiddenBattlefieldId !== undefined,
    );

  it("drags an enemy out of their base onto her battlefield", () => {
    const { state, eve, prey } = evelynnState(0);
    const action = hiddenPlay(state, eve.instanceId);
    expect(action, "the hidden Evelynn was never offered").toBeDefined();

    const played = resolveHeldTriggers(accept(state, action!));
    // The question is really asked — a card that parked nothing would sail past
    // `answerDecisions` and this test would then assert its own fixture.
    expect(pendingDecision(played)?.kind, "Evelynn asked nothing").toBe("UNL-141-move");

    const after = answerWith(played, (ids) => ids.find((id) => id !== "decline"));

    expect(atHerBattlefield(after), "she never arrived, or the enemy was not dragged in").toEqual([
      "Guard",
      "Evelynn - Entrancing",
      "Prey",
    ]);
    expect(after.players[1]!.baseUnits, "the enemy is still at home too").toHaveLength(0);
    expect(findAnywhere(after, prey.instanceId), "the moved unit vanished").toBeDefined();
  });

  it("is genuinely optional — declining leaves the enemy where it was", () => {
    const { state, eve, prey } = evelynnState(0);
    const played = resolveHeldTriggers(accept(state, hiddenPlay(state, eve.instanceId)!));

    const after = answerWith(played, () => "decline");

    expect(after.players[1]!.baseUnits.map((u) => u.name), "the decline still moved it").toEqual(["Prey"]);
    expect(findAnywhere(after, prey.instanceId)!.instanceId).toBe(prey.instanceId);
  });

  it("does NOT fire when she is played from HAND — 'from face down'", () => {
    // Its own positive control: the from-hidden play on the same board moves it.
    const control = evelynnState(0);
    const moved = answerWith(
      resolveHeldTriggers(accept(control.state, hiddenPlay(control.state, control.eve.instanceId)!)),
      (ids) => ids.find((id) => id !== "decline"),
    );
    expect(at(moved, "bf1", "p2"), "the control play moved nothing either").toHaveLength(1);

    const { state, eve, prey } = evelynnState(0);
    // Same board, same destination — she is simply in HAND instead of face down,
    // and the Guard already gives her the presence an ordinary play needs.
    state.battlefields[0] = { ...state.battlefields[0]!, hiddenCards: [] };
    state.players[0]!.hand = [eve];
    const fromHand = legalActions(state).find(
      (a) => a.type === "PlayCard" && a.card.instanceId === eve.instanceId && a.destinationBattlefieldId === "bf1",
    );
    expect(fromHand, "she could not be played from hand at all").toBeDefined();

    const resolved = resolveHeldTriggers(accept(state, fromHand!));
    // Asked BEFORE anything is answered. Answering with the default first option
    // would take "Decline", which looks exactly like the trigger never firing —
    // a mutation run proved that: deleting the condition left this test green.
    expect(pendingDecision(resolved)?.kind, "she asked her question off a hand play").not.toBe("UNL-141-move");
    // And answered greedily, so a trigger that DID fire would move the enemy.
    const after = answerWith(resolved, (ids) => ids.find((id) => id !== "decline"));

    expect(atHerBattlefield(after), "she never arrived").toEqual(["Guard", "Evelynn - Entrancing"]);
    expect(after.players[1]!.baseUnits.map((u) => u.name), "a hand play dragged the enemy in").toEqual(["Prey"]);
    expect(findAnywhere(after, prey.instanceId)!.instanceId).toBe(prey.instanceId);
  });

  it("does NOT fire on the OPPONENT'S turn — 'on your turn'", () => {
    // Positive control first, on the same fixture with the turn the other way.
    const control = evelynnState(0);
    const moved = answerWith(
      resolveHeldTriggers(accept(control.state, hiddenPlay(control.state, control.eve.instanceId)!)),
      (ids) => ids.find((id) => id !== "decline"),
    );
    expect(at(moved, "bf1", "p2"), "the control play moved nothing either").toHaveLength(1);

    const { state, eve, prey } = evelynnState(1);
    const ray = legalActions(state).find(
      (a) => a.type === "PlayCard" && a.card.defId === HEXTECH_RAY && a.targetUnitInstanceId !== undefined,
    );
    expect(ray, "the opponent could not open a chain — this negative is vacuous").toBeDefined();
    const chained = accept(state, ray!);
    expect(chained.chainOpen, "the chain never closed").toBe(false);
    // The caster keeps priority after playing, so they pass it across — that pass
    // is what makes player 0 the acting player and is the whole point of driving
    // this through the real path rather than hand-setting `chainPriority`.
    const passed = accept(chained, legalActions(chained).find((a) => a.type === "PassFocus")!);

    const action = hiddenPlay(passed, eve.instanceId);
    // [Hidden] is exactly what makes this legal on the other player's turn (811);
    // if it were not offered this negative would prove nothing.
    expect(action, "the reaction play was not offered — this negative is vacuous").toBeDefined();

    const resolved = resolveChain(accept(passed, action!));
    // Asked BEFORE anything is answered, for the reason the hand-play negative
    // above records: "Decline" is the first option, so `answerDecisions`' default
    // makes a firing trigger indistinguishable from a silent one.
    expect(pendingDecision(resolved)?.kind, "she asked her question on the wrong turn").not.toBe("UNL-141-move");
    const after = answerWith(resolved, (ids) => ids.find((id) => id !== "decline"));

    expect(at(after, "bf1", "p1").map((u) => u.name), "she never arrived").toContain("Evelynn - Entrancing");
    expect(after.players[1]!.baseUnits.map((u) => u.name), "she ambushed on the wrong turn").toEqual(["Prey"]);
    expect(findAnywhere(after, prey.instanceId)!.instanceId).toBe(prey.instanceId);
  });
});

describe("Bone Skewer (UNL-139): the OPPONENT plays a unit from their hand, stunned", () => {
  function skewerState(opponentHand: CardInstance[]): { state: GameState; spell: CardInstance } {
    const spell = spellInstance(BONE_SKEWER);
    const state = casterState();
    state.players[0]!.hand = [spell];
    state.players[1]!.hand = opponentHand;
    return { state, spell };
  }

  const skewerAt = (state: GameState, spellInstanceId: string, battlefieldId: string) =>
    legalActions(state).find(
      (a) => a.type === "PlayCard" && a.card.instanceId === spellInstanceId && a.targetBattlefieldId === battlefieldId,
    );

  it("puts their unit at the battlefield the caster chose, stunned", () => {
    const victim = makeUnit({ name: "Conscript", might: 5 });
    const { state, spell } = skewerState([victim]);
    const action = skewerAt(state, spell.instanceId, "bf1");
    expect(action, "Bone Skewer was never enumerated at bf1").toBeDefined();

    const after = answerWith(resolveChain(accept(state, action!)), (ids) => ids.find((id) => id !== "decline"));

    const arrived = at(after, "bf1", "p2");
    expect(arrived.map((u) => u.name), "the unit was never played").toEqual(["Conscript"]);
    expect(arrived[0]!.stunned, "it arrived unstunned").toBe(true);
    // 143.4.a — nothing on the card says it enters ready.
    expect(arrived[0]!.exhausted, "it arrived ready").toBe(true);
    expect(after.players[1]!.hand, "the card is still in their hand as well").toHaveLength(0);
    // "THEY play that unit" — it is their play, so it is their [Legion] counter.
    expect(after.players[1]!.cardsPlayedThisTurn, "the play was credited to the wrong seat").toBe(1);
    expect(after.players[0]!.cardsPlayedThisTurn, "the caster was credited with their play").toBe(1);
  });

  it("reaches a unit they could never have afforded — 'ignoring any and all costs'", () => {
    const bomb = makeUnit({ name: "Bomb", might: 8, energyCost: 9, powerCost: 3, powerDomain: "Fury" });
    const { state, spell } = skewerState([bomb]);
    // The opponent has no runes and no floating anything, so a cost check of any
    // kind would withhold this option.
    expect(state.players[1]!.channeled, "the opponent could actually pay").toHaveLength(0);

    const after = answerWith(resolveChain(accept(state, skewerAt(state, spell.instanceId, "bf1")!)), (ids) =>
      ids.find((id) => id !== "decline"),
    );

    expect(at(after, "bf1", "p2").map((u) => u.name)).toEqual(["Bomb"]);
  });

  it("is genuinely optional — 'you MAY choose a unit'", () => {
    const victim = makeUnit({ name: "Conscript" });
    const { state, spell } = skewerState([victim]);

    const after = answerWith(resolveChain(accept(state, skewerAt(state, spell.instanceId, "bf1")!)), () => "decline");

    expect(at(after, "bf1", "p2"), "the decline played it anyway").toHaveLength(0);
    expect(names(after.players[1]!.hand), "the card left their hand on a decline").toEqual(["Conscript"]);
  });

  it("asks nothing when their hand holds no UNIT", () => {
    // Its own positive control: with a unit in hand, the same board asks.
    const withUnit = skewerState([makeUnit({ name: "Conscript" })]);
    const asked = resolveChain(accept(withUnit.state, skewerAt(withUnit.state, withUnit.spell.instanceId, "bf1")!));
    expect(pendingDecision(asked)?.kind, "the control board asked nothing either").toBe("UNL-139-play");

    const { state, spell } = skewerState([spellInstance("OGN-009")]); // Hextech Ray — a Spell
    const after = resolveChain(accept(state, skewerAt(state, spell.instanceId, "bf1")!));

    expect(pendingDecision(after), "a question was asked about a hand with no unit").toBeUndefined();
    expect(at(after, "bf1", "p2"), "a Spell was played as a unit").toHaveLength(0);
    expect(after.players[1]!.hand, "their hand was emptied anyway").toHaveLength(1);
  });
});

describe("Conscription (UNL-140): take control of it, exhaust it, and recall it", () => {
  function conscriptState(victimMight: number, xp = 0): { state: GameState; spell: CardInstance; victim: UnitInstance } {
    const spell = spellInstance(CONSCRIPTION);
    const victim = makeUnit({ name: "Victim", might: victimMight });
    const state = casterState();
    state.players[0]!.hand = [spell];
    state.players[0]!.xp = xp;
    state.battlefields[0]!.units = { p2: [victim] };
    return { state, spell, victim };
  }

  const conscriptionAt = (state: GameState, spellInstanceId: string, targetUnitInstanceId: string) =>
    legalActions(state).find(
      (a) =>
        a.type === "PlayCard" &&
        a.card.instanceId === spellInstanceId &&
        (a as { targetUnitInstanceId?: string }).targetUnitInstanceId === targetUnitInstanceId,
    );

  it("moves a 3-Might enemy into the caster's base, EXHAUSTED", () => {
    const { state, spell, victim } = conscriptState(3);
    const action = conscriptionAt(state, spell.instanceId, victim.instanceId);
    expect(action, "Conscription was never enumerated at the 3-Might unit").toBeDefined();

    const after = answerDecisions(resolveChain(accept(state, action!)));

    expect(after.players[0]!.baseUnits.map((u) => u.name), "control never changed").toEqual(["Victim"]);
    expect(after.players[0]!.baseUnits[0]!.exhausted, "it was taken READY — the exhaust is missing").toBe(true);
    expect(at(after, "bf1", "p2"), "it is still standing at the battlefield too").toHaveLength(0);
    expect(after.players[1]!.baseUnits, "it went home to its old owner instead").toHaveLength(0);
  });

  it("cannot be cast at a 4-Might enemy — '3 Might or less'", () => {
    // Its own positive control first: the 3-Might board offers it.
    expect(plays(conscriptState(3).state, CONSCRIPTION).length, "the control board offered nothing either").toBeGreaterThan(0);

    expect(plays(conscriptState(4).state, CONSCRIPTION), "a 4-Might unit was conscripted").toHaveLength(0);
  });

  it("cannot reach a unit in the enemy BASE — 'at a battlefield'", () => {
    const { state, victim } = conscriptState(3);
    state.battlefields[0]!.units = {};
    state.players[1]!.baseUnits = [victim];

    expect(plays(state, CONSCRIPTION), "a base unit was conscripted").toHaveLength(0);
  });

  /**
   * PINNED HALF — asserts the WRONG answer on purpose.
   *
   * "You may spend 5 XP as an additional cost to play this ... If you paid the
   * additional cost, choose ANY enemy unit at a battlefield instead." That is an
   * Optional Additional Cost (805) and it is NOT implemented: there is no XP cost
   * of any kind in `card-effects.ts`'s cost tables, none on `PlayCardAction`, and
   * none in `ActivationCost` either. So a caster sitting on 5 XP is offered
   * nothing extra and the 3-Might cap always stands.
   *
   * Its own positive control runs first, because "no play was offered" reads the
   * same whether the cost is missing or the fixture simply has no castable spell.
   *
   * Closing this should FLIP the second expectation, not delete it.
   */
  it("offers no upgraded target at 5 XP — the optional XP cost is unimplemented", () => {
    expect(plays(conscriptState(3, 5).state, CONSCRIPTION).length, "the control board offered nothing either").toBeGreaterThan(0);

    const { state } = conscriptState(4, 5);

    // 1-or-more under 805. 0 is what this engine does, and what this pin records.
    expect(plays(state, CONSCRIPTION), "the XP additional cost is implemented now — flip this pin").toHaveLength(0);
    expect(state.players[0]!.xp, "XP moved without a cost to pay it on").toBe(5);
  });
});

describe("Scryer's Bloom (UNL-136): Kill this, [1], [Exhaust]: [Predict 2], then draw 1. Gain 1 XP", () => {
  const card = (name: string): UnitInstance => makeUnit({ name });

  function bloomState(deck: CardInstance[]): { state: GameState; bloom: CardInstance } {
    const bloom = realGearInstance(SCRYERS_BLOOM);
    const state = casterState();
    state.players[0]!.activeGear = [bloom];
    state.players[0]!.deck = deck;
    return { state, bloom };
  }

  const activation = (state: GameState, gearInstanceId: string) =>
    legalActions(state).find((a) => a.type === "ActivateAbility" && a.permanentInstanceId === gearInstanceId);

  /** Activate, then answer the Predict with `optionId` (and let the draw settle). */
  function crack(deck: CardInstance[], optionId: (ids: string[]) => string | undefined) {
    const { state, bloom } = bloomState(deck);
    const action = activation(state, bloom.instanceId);
    expect(action, "Scryer's Bloom's ability was never enumerated").toBeDefined();
    const activated = accept(state, action!);
    expect(pendingDecision(activated)?.kind, "the Predict was never asked").toBe("UNL-136-predict");
    return { activated, bloom, after: answerWith(activated, optionId) };
  }

  it("pays all three costs and delivers all three payouts", () => {
    const { bloom, after } = crack([card("A"), card("B"), card("C")], () => "keep");

    // COST: the gear is dead and in the trash, not merely exhausted.
    expect(after.players[0]!.activeGear, "the Bloom survived its own cost").toHaveLength(0);
    expect(names(after.players[0]!.trash), "it was not killed into the trash").toContain("Scryer's Bloom");
    expect(after.players[0]!.trash.some((c) => c.instanceId === bloom.instanceId)).toBe(true);
    // EFFECT: keep the order, then draw the top one, then 1 XP.
    expect(names(after.players[0]!.hand), "the draw never happened, or drew the wrong card").toEqual(["A"]);
    expect(names(after.players[0]!.deck), "the deck was disturbed by a 'keep'").toEqual(["B", "C"]);
    expect(after.players[0]!.xp, "the 1 XP never landed").toBe(1);
  });

  it("offers all FIVE arrangements of the top two — 436.1.a", () => {
    const { state, bloom } = bloomState([card("A"), card("B"), card("C")]);
    const activated = accept(state, activation(state, bloom.instanceId)!);

    const decision = pendingDecision(activated)!;
    const labels = optionsFor(activated, decision).map((o) => o.label);

    expect(labels, "the Predict 2 question is not the five-way subset-plus-order choice").toEqual([
      "Keep A on top, B under it",
      "Put B on top, A under it",
      "Recycle A",
      "Recycle B",
      "Recycle both A and B",
    ]);
  });

  it("SWAP puts the second card on top — 'put the rest back in any order'", () => {
    const { after } = crack([card("A"), card("B"), card("C")], () => "swap");

    expect(names(after.players[0]!.hand), "the swap did not change what was drawn").toEqual(["B"]);
    expect(names(after.players[0]!.deck), "the order under the draw is wrong").toEqual(["A", "C"]);
  });

  it("RECYCLING ONE sends it to the BOTTOM (416.1), not the trash", () => {
    const { after } = crack([card("A"), card("B"), card("C")], (ids) => ids.find((id) => id.startsWith("recycle:")));

    expect(names(after.players[0]!.hand), "the recycled card was drawn anyway").toEqual(["B"]);
    expect(names(after.players[0]!.deck), "A did not go to the bottom").toEqual(["C", "A"]);
    expect(names(after.players[0]!.trash), "a recycle trashed the card").not.toContain("A");
  });

  it("RECYCLING BOTH sends both to the bottom and draws what was under them", () => {
    const { after } = crack([card("A"), card("B"), card("C"), card("D")], () => "recycleBoth");

    expect(names(after.players[0]!.hand), "the draw did not come from under the recycled pair").toEqual(["C"]);
    expect(names(after.players[0]!.deck), "the pair is not at the bottom").toEqual(["D", "A", "B"]);
  });

  it("asks a two-option question on a one-card deck — 436.4's 'as many as possible'", () => {
    const { state, bloom } = bloomState([card("A")]);
    const activated = accept(state, activation(state, bloom.instanceId)!);

    expect(optionsFor(activated, pendingDecision(activated)!).map((o) => o.label)).toEqual(["Keep A on top", "Recycle A"]);
  });

  it("is NOT offered while the Bloom is exhausted — the printed [Exhaust]", () => {
    // Positive control: the same board with a ready Bloom offers it.
    const ready = bloomState([card("A"), card("B")]);
    expect(activation(ready.state, ready.bloom.instanceId), "the control board offered nothing either").toBeDefined();

    const { state, bloom } = bloomState([card("A"), card("B")]);
    state.players[0]!.activeGear = [{ ...state.players[0]!.activeGear[0]!, exhausted: true }];

    expect(activation(state, bloom.instanceId), "an exhausted Bloom was still activatable").toBeUndefined();
  });

  /**
   * PINNED DIVERGENCE — asserts the WRONG answer on purpose.
   *
   * The card's first sentence is "This enters exhausted." The mechanism exists
   * and is one row: `GEAR_ENTERING_EXHAUSTED` in `engine/deploy.ts`, read by
   * `execute-play-card` as a Gear enters `activeGear`, holding only Iron Ballista
   * (OGN-017) today. effects/chaos.ts may not edit deploy.ts, so the Bloom enters
   * READY and can be cracked the turn it lands — STRONGER than printed, which is
   * the wrong direction to err and the reason this is pinned rather than left.
   *
   * The positive control is the second assertion: the ability really is offered
   * on the turn it arrives, so this is not passing on a Bloom that simply is not
   * in play.
   *
   * Adding the row should FLIP both expectations, not delete them.
   */
  it("enters READY — divergent from its own 'This enters exhausted'", () => {
    const bloom = realGearInstance(SCRYERS_BLOOM);
    const state = casterState();
    state.players[0]!.hand = [bloom];
    state.players[0]!.deck = [card("A"), card("B")];

    const play = legalActions(state).find((a) => a.type === "PlayCard" && a.card.instanceId === bloom.instanceId);
    expect(play, "the Bloom could not be played at all").toBeDefined();
    const landed = answerDecisions(resolveHeldTriggers(accept(state, play!)));

    // false under the card's own text. true is what this engine does.
    expect(
      landed.players[0]!.activeGear[0]!.exhausted,
      "'This enters exhausted' is implemented now — flip this pin and drop the PARTIALLY_IMPLEMENTED entry",
    ).toBe(false);
    expect(activation(landed, bloom.instanceId), "it could not be cracked the turn it landed after all").toBeDefined();
  });
});
