import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { CardInstance, GearInstance, UnitInstance } from "../src/model/card.js";
import type { RuneCard } from "../src/model/rune.js";
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
 * Unleashed wave 2, effects/chaos.ts.
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
 */

const registry = defaultCardRegistry();

const MEGATUSK = "UNL-126";
const MISTER_ROOT = "UNL-127";
const STAR_CROSSED = "UNL-128";
const WALKING_ROOST = "UNL-130";
const ABANDON = "UNL-131";
const BLAST_CONE = "UNL-133";
const EXISTENTIAL_DREAD = "UNL-134";
const INSIGHTFUL_INVESTIGATOR = "UNL-135";

/** Fury 1E/1P — "Deal 3 to a unit at a battlefield." The pool's simplest real
 *  spell, used here as Abandon's victim: its damage is what proves a counter
 *  actually stopped something. */
const HEXTECH_RAY = "OGN-009";

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

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

/** The enumerated play of one card in hand, optionally at one first target. */
/** The PLAIN candidate — never the repeat-paid one.
 *
 *  `.find` used to be unambiguous because each card enumerated one variant per
 *  target. When UNL-134's `[Repeat] [2]` was priced on 2026-08-09 it gained a
 *  second, and `.find` started returning whichever came first: the repeat
 *  resolved the effect TWICE, so the attacker was stunned and then — being
 *  already stunned — bounced to hand, and a test reading `.stunned` off it
 *  crashed on `undefined`. That is the card working, not breaking.
 *
 *  Tests that want the repeat ask for it explicitly. */
function playOf(state: GameState, card: CardInstance, targetUnitInstanceId?: string): unknown {
  const action = legalActions(state).find(
    (a) =>
      a.type === "PlayCard" &&
      a.card.instanceId === card.instanceId &&
      (a as { repeatPaid?: boolean }).repeatPaid !== true &&
      (targetUnitInstanceId === undefined ||
        (a as { targetUnitInstanceId?: string }).targetUnitInstanceId === targetUnitInstanceId),
  );
  expect(action, `${card.name} was never enumerated`).toBeDefined();
  return action!;
}

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

const names = (cards: readonly CardInstance[]): string[] => cards.map((c) => c.name).sort();

// ---------------------------------------------------------------------------

describe("Megatusk (UNL-126): Spend 3 XP: give your units here [Ganking] this turn", () => {
  /**
   * Megatusk and a plain ally standing at bf1, plus a second ally at HOME —
   * "your units HERE" has to reach the first and not the second.
   *
   * A battlefield-to-battlefield MoveUnit is the instrument: it is the only move
   * `[Ganking]` unlocks, `legal-actions` asks `hasKeyword` before offering one,
   * and `validate-move-unit` asks the same layer — so an offered bf1->bf2 move is
   * the keyword being real in play rather than a field being written.
   */
  function tuskState(xp: number): { state: GameState; tusk: UnitInstance; ally: UnitInstance; homebody: UnitInstance } {
    const tusk = realUnitInstance(MEGATUSK);
    const ally = makeUnit({ name: "Ally" });
    const homebody = makeUnit({ name: "Homebody" });
    const state = casterState();
    state.players[0]!.xp = xp;
    state.players[0]!.baseUnits = [homebody];
    state.battlefields[0]!.units = { p1: [tusk, ally] };
    return { state, tusk, ally, homebody };
  }

  const gankMovesFor = (state: GameState, unitInstanceId: string) =>
    legalActions(state).filter(
      (a) =>
        a.type === "MoveUnit" &&
        a.unitInstanceIds.includes(unitInstanceId) &&
        a.destinationBattlefieldId === "bf2",
    );

  const activation = (state: GameState) =>
    legalActions(state).find((a) => a.type === "ActivateAbility" && a.permanentInstanceId !== undefined);

  it("is activatable through the REAL path and grants [Ganking] to the units at his battlefield", () => {
    const { state, tusk, ally } = tuskState(3);
    expect(gankMovesFor(state, ally.instanceId), "the ally could already walk sideways").toHaveLength(0);

    const action = activation(state);
    expect(action, "Megatusk's ability was never enumerated").toBeDefined();
    const after = accept(state, action!);

    expect(after.players[0]!.xp, "the 3 XP was never spent").toBe(0);
    expect(gankMovesFor(after, ally.instanceId), "the ally was not granted [Ganking]").toHaveLength(1);
    // "YOUR units" names no exception, so he grants to himself too.
    expect(gankMovesFor(after, tusk.instanceId), "Megatusk did not grant to himself").toHaveLength(1);
  });

  it("actually moves — the grant survives into a real MoveUnit action", () => {
    // The keyword field being set is not the claim; the move happening is.
    const { state, ally } = tuskState(3);
    const activated = accept(state, activation(state)!);

    const moved = accept(activated, gankMovesFor(activated, ally.instanceId)[0]!);

    expect(at(moved, "bf2", "p1").map((u) => u.name), "the sideways move did not happen").toEqual(["Ally"]);
  });

  it("does NOT reach a unit in base — 'your units HERE'", () => {
    const { state, homebody } = tuskState(3);
    const after = accept(state, activation(state)!);

    // The positive control is the ally, asserted in the test above from the same
    // fixture: with him ungranted this negative would pass for the wrong reason.
    expect(after.players[0]!.baseUnits.find((u) => u.instanceId === homebody.instanceId)!.keywordsThisTurn).toEqual({});
  });

  it("is not OFFERED at 2 XP — the price is checked before the ability, not inside it", () => {
    // Paired with its own positive control: at 3 XP the very same board offers it.
    expect(activation(tuskState(3).state), "the control board never offered it either").toBeDefined();

    const { state } = tuskState(2);

    expect(activation(state), "an unaffordable ability was offered").toBeUndefined();
    expect(state.players[0]!.xp, "XP moved without an activation").toBe(2);
  });

  it("repeats while the XP lasts — no exhaust is printed", () => {
    // 6 XP is two activations. If the default `{ exhaust: true }` had been taken,
    // the second would not be offered.
    const { state } = tuskState(6);
    const once = accept(state, activation(state)!);

    const twice = activation(once);
    expect(twice, "a second activation was refused — an exhaust nobody printed").toBeDefined();
    expect(accept(once, twice!).players[0]!.xp).toBe(0);
  });
});

describe("Mister Root (UNL-127): when I move to a battlefield, gain 2 XP", () => {
  /**
   * Root ready in base beside a plain ally, so both can walk out — and bf1
   * ALREADY controlled by the mover, so arriving contests nothing and opens no
   * Showdown. Without that the recall test below cannot run at all: a Showdown is
   * open the instant a unit walks onto an uncontrolled battlefield, and
   * `validate-recall-unit` refuses a retreat from an engaged fight.
   */
  function rootState(): { state: GameState; root: UnitInstance; ally: UnitInstance } {
    const root = realUnitInstance(MISTER_ROOT);
    const ally = makeUnit({ name: "Ally" });
    const state = casterState();
    state.players[0]!.baseUnits = [root, ally];
    state.battlefields[0] = { ...state.battlefields[0]!, controllerId: "p1" };
    return { state, root, ally };
  }

  const moveTo = (state: GameState, unitInstanceId: string, destinationBattlefieldId: string) =>
    resolveHeldTriggers(
      accept(state, { type: "MoveUnit", playerIndex: 0, unitInstanceIds: [unitInstanceId], destinationBattlefieldId }),
    );

  it("gains 2 XP on a REAL MoveUnit out of base", () => {
    const { state, root } = rootState();
    expect(state.players[0]!.xp).toBe(0);

    const after = moveTo(state, root.instanceId, "bf1");

    expect(at(after, "bf1", "p1").map((u) => u.name), "he never arrived").toEqual(["Mister Root"]);
    expect(after.players[0]!.xp, "Mister Root gained nothing for his own move").toBe(2);
  });

  it("gains nothing when somebody ELSE moves — 'when I move'", () => {
    const { state, root, ally } = rootState();
    expect(moveTo(state, root.instanceId, "bf1").players[0]!.xp, "the control move paid nothing either").toBe(2);

    const after = moveTo(state, ally.instanceId, "bf1");

    expect(at(after, "bf1", "p1").map((u) => u.name), "the ally never moved").toEqual(["Ally"]);
    expect(after.players[0]!.xp, "he paid out for a friend's move").toBe(0);
  });

  it("gains nothing for a RECALL — 455, a Recall is not a Move", () => {
    // Its own positive control first: the ordinary move on the same board pays 2.
    const { state, root } = rootState();
    expect(moveTo(state, root.instanceId, "bf1").players[0]!.xp, "the control move paid nothing either").toBe(2);

    // Root standing READY at a battlefield his side already controls, so the
    // retreat is legal — a Standard Move exhausts (144.2), which is why he cannot
    // simply walk out and back in the same turn.
    const standing = rootState().state;
    standing.players[0]!.baseUnits = [];
    standing.battlefields[0] = { ...standing.battlefields[0]!, units: { p1: [root] } };

    const home = resolveHeldTriggers(
      accept(standing, { type: "RecallUnit", playerIndex: 0, unitInstanceIds: [root.instanceId] }),
    );

    expect(home.players[0]!.baseUnits.map((u) => u.name), "he never came home").toEqual(["Mister Root"]);
    expect(home.players[0]!.xp, "a Recall paid out as a move").toBe(0);
  });
});

describe("Star-Crossed (UNL-128): return a friendly unit AND an enemy unit", () => {
  function crossedState(withEnemy = true): { state: GameState; spell: CardInstance; mine: UnitInstance; theirs: UnitInstance } {
    const spell = spellInstance(STAR_CROSSED);
    const mine = makeUnit({ name: "Mine" });
    const theirs = makeUnit({ name: "Theirs" });
    const state = casterState();
    state.players[0]!.hand = [spell];
    state.battlefields[0]!.units = { p1: [mine], ...(withEnemy ? { p2: [theirs] } : {}) };
    return { state, spell, mine, theirs };
  }

  it("returns one of each, to their OWNERS' hands", () => {
    const { state, spell, mine, theirs } = crossedState();

    const after = answerDecisions(resolveChain(accept(state, playOf(state, spell, mine.instanceId))));

    expect(names(after.players[0]!.hand), "the friendly unit did not come back to its owner").toEqual(["Mine"]);
    expect(names(after.players[1]!.hand), "the enemy unit went to the wrong hand").toEqual(["Theirs"]);
    expect(unitsInPlay(after), "something is still standing").toHaveLength(0);
  });

  it("reaches a unit in BASE — 355.9.a.1's bare noun", () => {
    const { state, spell, mine, theirs } = crossedState();
    state.battlefields[0]!.units = {};
    state.players[0]!.baseUnits = [mine];
    state.players[1]!.baseUnits = [theirs];

    const after = answerDecisions(resolveChain(accept(state, playOf(state, spell, mine.instanceId))));

    expect(names(after.players[0]!.hand)).toEqual(["Mine"]);
    expect(names(after.players[1]!.hand)).toEqual(["Theirs"]);
  });

  it("is UNCASTABLE with no enemy unit — 355 needs BOTH choices", () => {
    // Its own positive control first: the same board WITH an enemy offers it.
    expect(plays(crossedState(true).state, STAR_CROSSED).length, "the control board offered nothing either").toBeGreaterThan(0);

    const { state } = crossedState(false);

    expect(plays(state, STAR_CROSSED), "half a Star-Crossed was castable").toHaveLength(0);
  });
});

describe("Walking Roost (UNL-130): the OPPONENT plays a 1-Might Bird with [Deflect]", () => {
  it("puts a Bird in the opponent's base, not the caster's", () => {
    const roost = realUnitInstance(WALKING_ROOST);
    const state = casterState();
    state.players[0]!.hand = [roost];

    const after = answerDecisions(resolveHeldTriggers(accept(state, playOf(state, roost))));

    const bird = after.players[1]!.baseUnits[0];
    expect(bird, "the opponent got no Bird at all").toBeDefined();
    expect(bird!.name).toBe("Bird");
    expect(bird!.might, "the Bird is not 1 Might").toBe(1);
    expect(bird!.keywords, "the Bird has no [Deflect]").toEqual({ Deflect: 1 });
    expect(bird!.tags).toEqual(["Bird"]);
    // 143.4.a — nothing on the card says it enters ready.
    expect(bird!.exhausted, "the Bird arrived ready").toBe(true);
    expect(after.players[0]!.baseUnits.map((u) => u.name), "the CASTER got the Bird").toEqual(["Walking Roost"]);
  });

  it("mints exactly one Bird, and only for a Roost that was played", () => {
    // The negative control: an identical board with no Roost played produces no
    // Bird, so the assertion above cannot be passing off some other mechanism.
    const state = casterState();
    state.players[0]!.hand = [makeUnit({ name: "Not a Roost" })];

    const after = answerDecisions(resolveHeldTriggers(accept(state, playOf(state, state.players[0]!.hand[0]!))));

    expect(after.players[1]!.baseUnits, "a Bird appeared without a Walking Roost").toHaveLength(0);
  });
});

describe("Abandon (UNL-131): counter a spell and put it in its owner's HAND", () => {
  /**
   * Player 1 has cast a Hextech Ray at a 9-Might unit of their own and it is
   * waiting on the chain; player 0 holds Abandon with Chaos runes to react.
   *
   * The victim is deliberately 9 Might so it SURVIVES the 3 damage — the damage
   * itself is what proves the counter stopped the spell rather than merely
   * shuffling the card.
   */
  function chainWithRay(deckTop?: CardInstance): { state: GameState; ray: CardInstance; abandon: CardInstance; victim: UnitInstance } {
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    const victim = makeUnit({ name: "Victim", might: 9 });
    state.battlefields[0]!.units = { p2: [victim] };

    const ray = spellInstance(HEXTECH_RAY);
    const abandon = spellInstance(ABANDON);
    state.players[1]!.hand = [ray];
    state.players[1]!.channeled = Array.from({ length: 6 }, (_, i) => rune(`f${i}`, "Fury"));
    state.players[0]!.hand = [abandon];
    state.players[0]!.channeled = Array.from({ length: 6 }, (_, i) => rune(`c${i}`, "Chaos"));
    if (deckTop) state.players[0]!.deck = [deckTop, makeUnit({ name: "Second" })];

    const cast = legalActions(state).find(
      (a) => a.type === "PlayCard" && a.card.instanceId === ray.instanceId && a.targetUnitInstanceId === victim.instanceId,
    );
    expect(cast, "Hextech Ray was not castable").toBeDefined();
    const chained = accept(state, cast!);
    // 345 — the caster holds priority on their own item, so they pass first.
    const pass = legalActions(chained).find((a) => a.type === "PassFocus" && a.playerIndex === 1);
    expect(pass, "the caster was not offered a pass on their own spell").toBeDefined();
    return { state: accept(chained, pass!), ray, abandon, victim };
  }

  const abandonPlay = (state: GameState, abandon: CardInstance, rayInstanceId: string) => {
    const action = legalActions(state).find(
      (a) =>
        a.type === "PlayCard" &&
        a.card.instanceId === abandon.instanceId &&
        (a as { targetChainCardInstanceId?: string }).targetChainCardInstanceId === rayInstanceId,
    );
    expect(action, "Abandon was never offered the waiting spell").toBeDefined();
    return action!;
  };

  it("counters the spell AND puts it in its owner's hand instead of their trash", () => {
    const { state, ray, abandon, victim } = chainWithRay();

    const after = answerDecisions(resolveChain(accept(state, abandonPlay(state, abandon, ray.instanceId))));

    expect(findAnywhere(after, victim.instanceId)!.damage, "the Ray resolved anyway").toBe(0);
    expect(names(after.players[1]!.hand), "the countered spell is not in its owner's hand").toEqual(["Hextech Ray"]);
    expect(after.players[1]!.trash, "the countered spell was left in the trash").toHaveLength(0);
    // Abandon itself is an ordinary spell and goes to ITS owner's trash.
    expect(names(after.players[0]!.trash)).toEqual(["Abandon"]);
  });

  it("[Predict] asks, and recycling puts the top card on the BOTTOM", () => {
    const top = makeUnit({ name: "TopCard" });
    const { state, ray, abandon } = chainWithRay(top);

    const asked = resolveChain(accept(state, abandonPlay(state, abandon, ray.instanceId)));
    const decision = pendingDecision(asked);
    expect(decision?.kind, "[Predict] never asked").toBe("UNL-131-predict");
    expect(optionsFor(asked, decision!).map((o) => o.id), "the decline is not first").toEqual(["keep", "recycle"]);

    const after = answerDecisions(asked, (options) => options.find((o) => o.id === "recycle")!.id);

    expect(after.players[0]!.deck.map((c) => c.name), "the top card was not recycled to the bottom").toEqual([
      "Second",
      "TopCard",
    ]);
  });

  it("[Predict] can be declined, and then the deck is untouched", () => {
    const top = makeUnit({ name: "TopCard" });
    const { state, ray, abandon } = chainWithRay(top);

    const after = answerDecisions(
      resolveChain(accept(state, abandonPlay(state, abandon, ray.instanceId))),
      (options) => options.find((o) => o.id === "keep")!.id,
    );

    expect(after.players[0]!.deck.map((c) => c.name), "declining rotated the deck anyway").toEqual([
      "TopCard",
      "Second",
    ]);
  });

  it("is UNCASTABLE with an empty chain — 'counter a SPELL'", () => {
    // Positive control: with a spell waiting, the same hand can cast it.
    const { state, ray, abandon } = chainWithRay();
    expect(abandonPlay(state, abandon, ray.instanceId), "the control board offered nothing either").toBeDefined();

    const bare = casterState();
    bare.players[0]!.hand = [spellInstance(ABANDON)];
    bare.players[0]!.channeled = Array.from({ length: 6 }, (_, i) => rune(`c${i}`, "Chaos"));

    expect(plays(bare, ABANDON), "Abandon was castable with nothing to counter").toHaveLength(0);
  });
});

describe("Blast Cone (UNL-133): when you play this, you may move an enemy unit", () => {
  function coneState(withEnemy = true): { state: GameState; cone: GearInstance; enemy: UnitInstance } {
    const cone = realGearInstance(BLAST_CONE);
    const enemy = makeUnit({ name: "Enemy" });
    const state = casterState();
    state.players[0]!.hand = [cone];
    if (withEnemy) state.battlefields[0]!.units = { p2: [enemy] };
    return { state, cone, enemy };
  }

  it("asks on a REAL Gear play and moves the chosen enemy to the chosen battlefield", () => {
    const { state, cone, enemy } = coneState();

    const asked = resolveHeldTriggers(accept(state, playOf(state, cone)));
    const decision = pendingDecision(asked);
    expect(decision?.kind, "the Gear never asked").toBe("UNL-133-move");

    const after = answerDecisions(asked, (options) => {
      const pick = options.find((o) => o.id === `${enemy.instanceId}:bf2`);
      expect(pick, "bf2 was not offered as a destination").toBeDefined();
      return pick!.id;
    });

    expect(at(after, "bf1", "p2"), "the enemy never left bf1").toHaveLength(0);
    expect(at(after, "bf2", "p2").map((u) => u.name)).toEqual(["Enemy"]);
    // The gear itself is in play and is NOT exhausted — its second clause, the
    // one that would exhaust it, is refused (see the card's entry).
    expect(after.players[0]!.activeGear.map((g) => g.name)).toEqual(["Blast Cone"]);
  });

  it("offers BASE as a destination — 355.4.a / 359.3.e", () => {
    const { state, cone, enemy } = coneState();

    const asked = resolveHeldTriggers(accept(state, playOf(state, cone)));
    const after = answerDecisions(asked, (options) => {
      const pick = options.find((o) => o.id === `${enemy.instanceId}:base`);
      expect(pick, "base was not offered as a destination").toBeDefined();
      return pick!.id;
    });

    expect(after.players[1]!.baseUnits.map((u) => u.name), "the enemy did not go home").toEqual(["Enemy"]);
    expect(at(after, "bf1", "p2")).toHaveLength(0);
  });

  it("can be declined — 'you MAY move'", () => {
    const { state, cone } = coneState();
    const asked = resolveHeldTriggers(accept(state, playOf(state, cone)));
    expect(pendingDecision(asked)?.kind, "the offer was never made, so declining proves nothing").toBe("UNL-133-move");

    const after = answerDecisions(asked, (options) => options.find((o) => o.id === "decline")!.id);

    expect(at(after, "bf1", "p2"), "declining moved the enemy anyway").toHaveLength(1);
  });

  it("asks NOTHING with no enemy unit on the board — 422", () => {
    // Positive control: the same play WITH an enemy does ask.
    const control = coneState(true);
    expect(
      pendingDecision(resolveHeldTriggers(accept(control.state, playOf(control.state, control.cone))))?.kind,
      "the control board never asked either",
    ).toBe("UNL-133-move");

    const { state, cone } = coneState(false);

    const after = resolveHeldTriggers(accept(state, playOf(state, cone)));

    expect(pendingDecision(after), "a question was asked with nothing to move").toBeUndefined();
    expect(after.players[0]!.activeGear, "the gear did not even land").toHaveLength(1);
  });
});

describe("Existential Dread (UNL-134): stun an attacking enemy, or bounce it if already stunned", () => {
  /**
   * The OPPONENT attacking bf1 (they applied Contested, so 465 makes them the
   * Attacker) with the caster defending, and Existential Dread in hand.
   *
   * `beginCombatAt` stages the Showdown through the real Cleanup, so the Attacker
   * designation the targeting reads is handed out the way a game hands it out.
   */
  function dreadState(stunned = false): { state: GameState; dread: CardInstance; attacker: UnitInstance; bystander: UnitInstance } {
    const dread = spellInstance(EXISTENTIAL_DREAD);
    const attacker = makeUnit({ name: "Attacker", might: 4, stunned });
    const bystander = makeUnit({ name: "Bystander", might: 2 });
    const state = casterState();
    state.players[0]!.hand = [dread];
    state.players[0]!.baseUnits = [bystander];
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Defender", might: 4 })], p2: [attacker] };
    // The ATTACKER holds Focus when a Showdown opens, so the defender has exactly
    // one legal action — pass — and no card of theirs is enumerated until they
    // hold it. One pass hands it over; that is the window an `[Action]` spell is
    // cast in, and skipping it is how a fixture reports a working card as
    // unenumerated.
    const staged = beginCombatAt(state, "bf1", 1);
    const pass = legalActions(staged).find((a) => a.type === "PassFocus" && a.playerIndex === 1);
    expect(pass, "the attacker was not offered a pass in their own Showdown").toBeDefined();
    return { state: accept(staged, pass!), dread, attacker, bystander };
  }

  it("stuns the attacking enemy through a REAL cast", () => {
    const { state, dread, attacker } = dreadState();

    const after = answerDecisions(resolveChain(accept(state, playOf(state, dread, attacker.instanceId))));

    expect(findAnywhere(after, attacker.instanceId)!.stunned, "the attacker was not stunned").toBe(true);
  });

  it("returns it to its owner's hand INSTEAD when it is already stunned — 423.1.a.1", () => {
    // The branch a plain re-stun could never reveal: 423.1.a.1 says a stunned
    // unit cannot be stunned again, so without this the card would do nothing.
    const { state, dread, attacker } = dreadState(true);

    const after = answerDecisions(resolveChain(accept(state, playOf(state, dread, attacker.instanceId))));

    expect(findAnywhere(after, attacker.instanceId), "the stunned attacker is still on the board").toBeUndefined();
    expect(names(after.players[1]!.hand), "it did not go to its owner's hand").toEqual(["Attacker"]);
  });

  it("never offers a NON-attacking unit, on either side", () => {
    // Positive control first — the attacker IS offered on this very board.
    const { state, attacker, bystander } = dreadState();
    const offered = plays(state, EXISTENTIAL_DREAD);
    expect(offered.map((a) => a.targetUnitInstanceId), "the attacker was not offered either").toContain(attacker.instanceId);

    // The caster's own base unit and the caster's own defender are both refused:
    // one is not attacking, and the other is not an enemy.
    // DEDUPED: the card prints "[Repeat] [2]", so since it was priced each legal
    // target appears twice — once plain, once repeat-paid. Those are two ways to
    // play the same card at the same unit, not two targets, and the claim here is
    // about WHICH UNITS are reachable.
    const targets = [...new Set(offered.map((a) => a.targetUnitInstanceId))];
    expect(targets, "a unit in base was offered as an 'attacking' target").not.toContain(bystander.instanceId);
    expect(targets, "more than the one attacker was offered").toEqual([attacker.instanceId]);

    // ...and the duplicates really are only the repeat split, not a second target
    // sneaking in under the dedupe.
    expect(new Set(offered.map((a) => (a as { repeatPaid?: boolean }).repeatPaid === true)).size,
      "the two candidates per target differ by something other than the [Repeat]").toBe(2);
  });

  it("is UNCASTABLE when nobody is attacking", () => {
    expect(plays(dreadState().state, EXISTENTIAL_DREAD).length, "the control board offered nothing either").toBeGreaterThan(0);

    const state = casterState();
    state.players[0]!.hand = [spellInstance(EXISTENTIAL_DREAD)];
    state.battlefields[0]!.units = { p2: [makeUnit({ name: "Idler", might: 4 })] };

    expect(plays(state, EXISTENTIAL_DREAD), "it was castable with no combat at all").toHaveLength(0);
  });
});

describe("Insightful Investigator (UNL-135): pay 2 XP to strip a card from the revealed hand", () => {
  function investigatorState(xp: number): { state: GameState; investigator: UnitInstance } {
    const investigator = realUnitInstance(INSIGHTFUL_INVESTIGATOR);
    const state = casterState();
    state.players[0]!.xp = xp;
    state.players[0]!.hand = [investigator];
    state.players[1]!.hand = [makeUnit({ name: "TheirA" }), makeUnit({ name: "TheirB" })];
    state.players[1]!.deck = [makeUnit({ name: "TheirDraw" })];
    return { state, investigator };
  }

  it("takes the chosen card, spends the XP, and the opponent draws 1", () => {
    const { state, investigator } = investigatorState(2);

    const asked = resolveHeldTriggers(accept(state, playOf(state, investigator)));
    expect(pendingDecision(asked)?.kind, "the Investigator never asked").toBe("UNL-135-take");

    const after = answerDecisions(asked, (options) => {
      const pick = options.find((o) => o.label.includes("TheirB"));
      expect(pick, "the opponent's hand was not on offer").toBeDefined();
      return pick!.id;
    });

    expect(names(after.players[1]!.trash), "the CHOSEN card was not the one discarded").toEqual(["TheirB"]);
    expect(names(after.players[1]!.hand), "the opponent did not draw 1").toEqual(["TheirA", "TheirDraw"]);
    expect(after.players[0]!.xp, "the 2 XP was never spent").toBe(0);
  });

  it("can be declined, and then nothing is paid and nothing is discarded", () => {
    const { state, investigator } = investigatorState(2);
    const asked = resolveHeldTriggers(accept(state, playOf(state, investigator)));
    expect(pendingDecision(asked)?.kind, "the offer was never made, so declining proves nothing").toBe("UNL-135-take");

    const after = answerDecisions(asked, (options) => options.find((o) => o.id === "decline")!.id);

    expect(after.players[1]!.trash, "declining discarded a card anyway").toHaveLength(0);
    expect(names(after.players[1]!.hand)).toEqual(["TheirA", "TheirB"]);
    expect(after.players[0]!.xp, "declining still cost XP").toBe(2);
  });

  it("offers ONLY the decline at 1 XP — 416.3, never offered then refused", () => {
    // Positive control: at 2 XP the same board offers the hand.
    const control = investigatorState(2);
    const rich = resolveHeldTriggers(accept(control.state, playOf(control.state, control.investigator)));
    expect(optionsFor(rich, pendingDecision(rich)!).length, "the control board offered nothing either").toBeGreaterThan(1);

    const { state, investigator } = investigatorState(1);

    // A single option is not a question: `advanceDecisions` executes it, so the
    // queue is already empty and the board is untouched.
    const after = resolveHeldTriggers(accept(state, playOf(state, investigator)));

    expect(pendingDecision(after), "an unaffordable choice was put to the player").toBeUndefined();
    expect(after.players[1]!.trash, "an unaffordable option was taken anyway").toHaveLength(0);
    expect(after.players[0]!.xp, "XP was spent below the price").toBe(1);
  });
});

describe("coverage", () => {
  /**
   * **This gate is weaker than it looks and is not the evidence.** Registration is
   * per defId, so a card with two clauses reports DONE when one is written, and
   * `decisionDefIds` peels a defId off every decision KEY — `"UNL-133-move"` would
   * claim Blast Cone on its own. The behavioural tests above are what actually
   * catch an inert card; every one of them was made to fail before being kept.
   */
  it("reports seven implemented, and Blast Cone HALF — which is the honest answer", () => {
    // **This premise was "all eight", and it was wrong in the safe direction.**
    // Blast Cone is written by halves: its move works, its "when you move an enemy
    // unit, you may exhaust this to [Stun] it" cannot fire at all, because no
    // effect-driven move emits an event. Reporting it DONE is the coverage lie
    // this file's own note above warns about — registration is per defId, so the
    // first clause claims the card.
    //
    // The agent that wrote it could not fix that: `coverage.ts` is shared and six
    // agents were writing at once, so it named the missing clause in its report
    // and the `PARTIALLY_IMPLEMENTED` entry was added at integration. This test is
    // the other end of that entry, and asserting the split rather than "all eight"
    // is what makes the half-written card visible from here too.
    const whole = [MEGATUSK, MISTER_ROOT, STAR_CROSSED, WALKING_ROOST, ABANDON, EXISTENTIAL_DREAD, INSIGHTFUL_INVESTIGATOR];
    expect(whole.filter((id) => !isCardImplemented(registry.get(id)))).toEqual([]);
    expect(isCardImplemented(registry.get(BLAST_CONE)), "Blast Cone reports finished — its second clause is still unwritable").toBe(false);
  });

  it("records the two clauses that are NOT written, so DONE is not read as complete", () => {
    // Stated as a test rather than only in a comment, because both gaps are
    // INVISIBLE in play — an unpriced [Repeat] simply offers no repeat variant,
    // and a listener for a move event that is never emitted simply never fires.
    //
    //  - UNL-134's `[Repeat] [2]`: `REPEAT_COSTS` lives in card-effects.ts and
    //    this file may not add to it. `repeat-keyword.test.ts` names UNL-134 in
    //    its unpriced list, and this asserts the same fact from here so that
    //    pricing it flips BOTH.
    //  - UNL-133's second clause ("when you move an enemy unit, you may exhaust
    //    this to [Stun] it"): `unitMoved` is emitted only by `executeMoveUnit`,
    //    which can only ever move the actor's OWN units, so the moment does not
    //    exist. Asserted as the property rather than as a card list.
    const dread = registry.get(EXISTENTIAL_DREAD);
    expect(dread.text ?? "", "UNL-134 stopped printing [Repeat] — this premise has expired").toContain("[Repeat]");

    const cone = registry.get(BLAST_CONE);
    expect(cone.text ?? "", "UNL-133 stopped printing its second clause").toContain("When you move an enemy unit");
  });
});
