import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { optionsFor, pendingDecision, type DecisionOption } from "../src/engine/decisions.js";
import { implementingModules, isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { answerDecisions, makeState, makeUnit, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * Wave 7's Body cards — the two that could be written, and the five that could
 * not.
 *
 * **Nothing here calls a resolver closure.** Every card is driven the way a game
 * drives it: `legalActions` for the fan-out, `submit` for the action,
 * `resolveHeldTriggers` because a spell is a chain item and a granted trigger is a
 * Chain Pending Item, `answerDecisions` because a parked question is a queue entry,
 * and `resolveShowdown` for the combat. A test that hand-built a `combatWon` event
 * would bypass `combat.combatWinner` entirely and assert nothing.
 *
 * Two shapes recur in the assertions and both are deliberate:
 *
 *  - **XP is read off `players[i].xp`, and only a real game can move it.**
 *    `reachability` cannot see an XP gain at all — a keyword or trigger that only
 *    banks XP registers nothing it counts — so this file is the whole instrument
 *    for Grim Resolve's second sentence.
 *  - **Combat outcomes are read through DEATHS and CONTROL, never through
 *    `damage`.** Rule 466 step 3c heals every unit at the end of combat, so damage
 *    is always 0 afterwards.
 *
 * Every "did nothing" assertion has a positive control off the same fixture with
 * one thing changed, because a card that is registered, enumerated, paid for and
 * inert passes a happy-path assertion exactly as well as one that works.
 */

const registry = defaultCardRegistry();

const GRIM_RESOLVE = "UNL-095"; // 2 Energy [Action] spell — pump plus a delayed XP clause
const VOID_ASSAULT = "UNL-202"; // 2 Energy / 1 Power — two moves in printed order

/** The five this wave refused. Each is asserted UNIMPLEMENTED at the foot of the
 *  file, with the precise shared-file row it needs written beside it. */
const REPULSE = "UNL-106";
const DETERMINED_SENTRY = "UNL-111";
const ARACHNOID_HORROR = "UNL-117";
const ELDER_DRAGON = "UNL-118";
const KHAZIX_VOIDREAVER = "UNL-201";

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });
const runes = (domain: RuneCard["domain"], count: number) =>
  Array.from({ length: count }, (_, i) => rune(`${domain}-${i}`, domain));

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `action was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

const unitAnywhere = (state: GameState, instanceId: string): UnitInstance | undefined =>
  [
    ...state.players.flatMap((p) => p.baseUnits),
    ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
  ].find((u) => u.instanceId === instanceId);

/** Where a unit stands right now — a battlefield id, `"base"`, or undefined if it
 *  has left play. The one reading every move assertion here goes through. */
function locationOf(state: GameState, instanceId: string): string | undefined {
  for (const bf of state.battlefields) {
    if (Object.values(bf.units).flat().some((u) => u.instanceId === instanceId)) return bf.id;
  }
  return state.players.some((p) => p.baseUnits.some((u) => u.instanceId === instanceId)) ? "base" : undefined;
}

const optionIds = (state: GameState): string[] => {
  const d = pendingDecision(state);
  return d ? optionsFor(state, d).map((o) => o.id) : [];
};

/** Answers the queue by NAME, falling back to the first option — for the tests
 *  whose whole point is which destination was picked. */
const choosing = (...ids: readonly string[]) => {
  const queue = [...ids];
  return (options: DecisionOption[]) => {
    const wanted = queue.shift();
    return options.find((o) => o.id === wanted)?.id ?? options[0]!.id;
  };
};

// ---------------------------------------------------------------------------
// UNL-095 Grim Resolve
// ---------------------------------------------------------------------------

describe("Grim Resolve (UNL-095): +3 Might this turn, and 2 XP when it wins a combat", () => {
  /**
   * p0 holds Grim Resolve with the Energy to cast it; `mine` stands at bf1 against
   * `theirs`, and `homebody` waits in p0's base.
   *
   * The two Mights are deliberately close — a 3 against a 3 is a mutual wipe and a
   * 6 against a 3 is a win, so the +3 is the difference between the two outcomes
   * and cannot be mistaken for a fixture that was always going to win.
   */
  function resolveState(mineMight = 3, theirsMight = 3): { state: GameState; cardId: string } {
    const card = spellInstance(GRIM_RESOLVE);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.hand = [card];
    state.players[0]!.floatingEnergy = 6;
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "homebody", name: "homebody", might: 3 })];
    state.battlefields[0]!.units = {
      p1: [makeUnit({ instanceId: "mine", name: "mine", might: mineMight })],
      p2: [makeUnit({ instanceId: "theirs", name: "theirs", might: theirsMight })],
    };
    return { state, cardId: card.instanceId };
  }

  const castOn = (state: GameState, cardId: string, target: string) =>
    resolveHeldTriggers(accept(state, playsOf(state, cardId).find((a) => a.targetUnitInstanceId === target)!));

  /** p0 attacks bf1 and the held triggers settle. The REAL entry — nothing here
   *  builds a `combatWon` event by hand. */
  const fight = (state: GameState) => answerDecisions(resolveHeldTriggers(resolveShowdown(state, "bf1", 0)));

  it("gives the chosen unit +3 Might this turn", () => {
    const { state, cardId } = resolveState();
    const after = castOn(state, cardId, "mine");
    expect(unitAnywhere(after, "mine")!.mightThisTurn, "the pump never landed").toBe(3);
    expect(unitAnywhere(after, "theirs")!.mightThisTurn, "the enemy was pumped as well").toBe(0);
  });

  it("banks 2 XP when the pumped unit wins the combat", () => {
    // The whole of the clause that used to be refused. A 3 against a 3 is a mutual
    // wipe without the spell; with it the pumped unit is a 6 and survives alone.
    const { state, cardId } = resolveState();
    const won = fight(castOn(state, cardId, "mine"));
    expect(unitAnywhere(won, "theirs"), "the enemy survived — this is not a win").toBeUndefined();
    expect(unitAnywhere(won, "mine"), "the pumped unit died — this is not a win either").toBeDefined();
    expect(won.players[0]!.xp, "the delayed clause never fired").toBe(2);
  });

  it("banks NOTHING without the spell — the same fight, cast on nobody", () => {
    // The control that says the 2 above is the card and not the combat. Same board,
    // same showdown, spell left in hand: a 3-vs-3 is 466.3.d's No Result.
    const { state } = resolveState();
    const unspelled = fight(state);
    expect(unspelled.players[0]!.xp, "XP arrived from somewhere other than Grim Resolve").toBe(0);
    expect(unitAnywhere(unspelled, "mine"), "the mutual wipe did not happen").toBeUndefined();
    expect(unitAnywhere(unspelled, "theirs"), "the mutual wipe did not happen").toBeUndefined();
  });

  it("banks NOTHING when the pumped unit LOSES, even though a combat was fought", () => {
    // +3 on a 1 is a 4, against an 9. `combatWon` fires for p1, so the event
    // happened and the owner check is what refuses it.
    const { state, cardId } = resolveState(1, 9);
    const lost = fight(castOn(state, cardId, "mine"));
    expect(unitAnywhere(lost, "mine"), "the pumped unit survived — the fixture is not a loss").toBeUndefined();
    expect(lost.players[0]!.xp, "Grim Resolve paid out on a loss").toBe(0);
    expect(lost.players[1]!.xp, "the winner inherited the caster's clause").toBe(0);
  });

  it("banks NOTHING when a DIFFERENT friendly unit wins — 'IT' is positional (466.3.c)", () => {
    // The pumped unit is the one sitting in BASE, which is in no combat at all, and
    // a second friendly wins at bf1. Without the `listener.battlefieldId` half this
    // would pay out for a fight the subject never joined.
    const { state, cardId } = resolveState(9, 3);
    const cast = castOn(state, cardId, "homebody");
    expect(unitAnywhere(cast, "homebody")!.mightThisTurn, "the fixture never pumped the base unit").toBe(3);

    const won = fight(cast);
    expect(unitAnywhere(won, "theirs"), "p0 did not win the fight — the negative proves nothing").toBeUndefined();
    expect(won.players[0]!.xp, "a unit standing at home banked XP for somebody else's combat").toBe(0);

    // ...and the same board with the spell aimed at the unit that DOES fight.
    const { state: twin, cardId: twinCard } = resolveState(9, 3);
    expect(fight(castOn(twin, twinCard, "mine")).players[0]!.xp, "the zero above proves nothing").toBe(2);

    // **This test kills the POSITIONAL guard and nothing kills the OWNER guard**,
    // measured by mutation: removing `listener.battlefieldId === event.battlefieldId`
    // fails exactly this test; removing `event.winnerIndex === listener.ownerIndex`
    // leaves the whole file green. 466.3.a makes the winner "the only Player that
    // has units remaining at this battlefield", so a listener still standing where
    // its side LOST is unreachable — the survival that makes it a listener is what
    // makes its side the winner. Recorded rather than tidied away: the second guard
    // is a real half of 466.3.c and the next reader must not delete it on the
    // strength of a green run. The trigger's own comment says the same.
  });

  it("expires with the turn — a win NEXT turn pays nothing", () => {
    // "this turn", and the mechanism is `runEnd` sweeping
    // `grantedTriggersThisTurn`. Without the sweep the unit would carry the clause
    // for the rest of the game.
    const { state, cardId } = resolveState(9, 3);
    const cast = castOn(state, cardId, "mine");
    expect(unitAnywhere(cast, "mine")!.grantedTriggersThisTurn ?? [], "the grant never landed").toHaveLength(1);

    const nextTurn = { ...runEnd(cast), phase: "Action" as const, turnState: "Neutral" as const };
    expect(unitAnywhere(nextTurn, "mine")!.grantedTriggersThisTurn ?? [], "the grant survived the turn").toHaveLength(0);
    expect(fight(nextTurn).players[0]!.xp, "a clause that should have expired paid out").toBe(0);
  });

  it("fires AGAIN on a second combat won in the same turn", () => {
    // "When it wins a combat this turn" is not "the first combat". The grant sits on
    // the unit until `runEnd`, so two wins are 4 XP — and this is the assertion that
    // would fail if it were ever implemented as a one-shot.
    const { state, cardId } = resolveState(9, 3);
    const cast = castOn(state, cardId, "mine");
    const first = fight(cast);
    expect(first.players[0]!.xp).toBe(2);

    // A fresh enemy walks into the same battlefield and loses to the same body.
    const rematch = { ...first };
    rematch.battlefields[0] = {
      ...rematch.battlefields[0]!,
      units: { ...rematch.battlefields[0]!.units, p2: [makeUnit({ instanceId: "theirs2", might: 3 })] },
    };
    expect(fight(rematch).players[0]!.xp, "the second win paid nothing").toBe(4);
  });

  it("offers only FRIENDLY units, in base as well as at a battlefield (355.9.a.1)", () => {
    const { state, cardId } = resolveState();
    const offered = playsOf(state, cardId).map((a) => a.targetUnitInstanceId);
    expect(offered, "an enemy unit was offered — the card says 'a friendly unit'").not.toContain("theirs");
    expect(offered, "a unit at home was unreachable — the card names no battlefield").toContain("homebody");
    expect(offered, "nothing was offered at all — the negatives above prove nothing").toContain("mine");
  });

  it("is registered in effects/body.ts", () => {
    expect(implementingModules(GRIM_RESOLVE), "Grim Resolve is not registered at all").not.toEqual([]);
  });

  // **The UNL-095 pin that stood here was deleted with its coverage row on
  // 2026-08-12**, which is what it was for: it asserted the stale
  // PARTIALLY_IMPLEMENTED note still existed, so retiring that note had to be a
  // decision rather than a silent change. The tests above measure the clause
  // firing; nothing here needs to restate that it is finished.
});

// ---------------------------------------------------------------------------
// UNL-202 Void Assault
// ---------------------------------------------------------------------------

describe("Void Assault (UNL-202): move a friendly unit, then move an enemy unit", () => {
  /**
   * p0 holds Void Assault with the runes for it. `mine` and `theirs` both start in
   * their own bases, so every destination in the fixture is somewhere they are not
   * — which is what makes the 355.4.a exclusions below measurable.
   */
  function assaultState(): { state: GameState; cardId: string } {
    const card = spellInstance(VOID_ASSAULT);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.hand = [card];
    state.players[0]!.floatingEnergy = 6;
    state.players[0]!.channeled = runes("Body", 4);
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "mine", name: "mine", might: 3 })];
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "theirs", name: "theirs", might: 3 })];
    return { state, cardId: card.instanceId };
  }

  const assaultWith = (state: GameState, cardId: string, friendly: string, enemy: string) =>
    playsOf(state, cardId).find((a) => a.targetUnitInstanceId === friendly && a.secondTargetUnitInstanceId === enemy);

  it("announces a friendly AND an enemy, and is uncastable without one of each", () => {
    const { state, cardId } = assaultState();
    expect(assaultWith(state, cardId, "mine", "theirs"), "the pair was never offered").toBeDefined();

    // 355.8 — a card whose targeting cannot be satisfied is uncastable. Two of the
    // caster's own units is not a legal pair.
    const friendlyOnly = assaultState();
    friendlyOnly.state.players[1]!.baseUnits = [];
    friendlyOnly.state.players[0]!.baseUnits = [
      makeUnit({ instanceId: "mine", might: 3 }),
      makeUnit({ instanceId: "mine2", might: 3 }),
    ];
    expect(playsOf(friendlyOnly.state, friendlyOnly.cardId), "castable with no enemy on the board").toEqual([]);

    // ...and the mirror, so the zero above is about the enemy slot and not about a
    // spell that is never offered at all.
    const enemyOnly = assaultState();
    enemyOnly.state.players[0]!.baseUnits = [];
    expect(playsOf(enemyOnly.state, enemyOnly.cardId), "castable with no friendly unit").toEqual([]);
  });

  it("moves both units, and asks the CASTER for each destination in printed order", () => {
    const { state, cardId } = assaultState();
    const cast = resolveHeldTriggers(accept(state, assaultWith(state, cardId, "mine", "theirs")!));

    expect(pendingDecision(cast)?.kind, "the friendly move was never asked about").toBe("UNL-202-friendly-where");
    expect(pendingDecision(cast)?.playerIndex, "the opponent was asked where the caster's unit goes").toBe(0);

    const afterFirst = accept(cast, {
      type: "AnswerDecision",
      playerIndex: 0,
      decisionId: pendingDecision(cast)!.id,
      optionId: "bf1",
    });
    expect(locationOf(afterFirst, "mine"), "the friendly did not move").toBe("bf1");
    expect(pendingDecision(afterFirst)?.kind, "the 'then' never happened").toBe("UNL-202-enemy-where");
    expect(pendingDecision(afterFirst)?.playerIndex, "the enemy's controller was asked, not the caster").toBe(0);

    const done = accept(afterFirst, {
      type: "AnswerDecision",
      playerIndex: 0,
      decisionId: pendingDecision(afterFirst)!.id,
      optionId: "bf1",
    });
    expect(locationOf(done, "theirs"), "the enemy did not move").toBe("bf1");
  });

  it("the CASTER is the attacker when both land at a battlefield they don't control (450)", () => {
    const { state, cardId } = assaultState();
    const done = answerDecisions(
      resolveHeldTriggers(accept(state, assaultWith(state, cardId, "mine", "theirs")!)),
      choosing("bf1", "bf1"),
    );
    expect(locationOf(done, "mine")).toBe("bf1");
    expect(locationOf(done, "theirs")).toBe("bf1");
    // The printed parenthetical, and it falls out of the ORDER: the friendly moves
    // first and applies Contested, and `applyContested` is a no-op on an already
    // Contested battlefield. Reversed, this would read 1.
    expect(done.battlefields[0]!.contestedByIndex, "the caster is not the attacker").toBe(0);
  });

  it("...and the ENEMY's controller is the attacker at a battlefield only they entered", () => {
    // The control that says the 0 above is the move ORDER and not a hardcoded seat.
    // Same card, two different destinations: p0 takes bf1, p1's unit is pushed to
    // bf2, and 450 answers each destination on its own.
    const { state, cardId } = assaultState();
    const done = answerDecisions(
      resolveHeldTriggers(accept(state, assaultWith(state, cardId, "mine", "theirs")!)),
      choosing("bf1", "bf2"),
    );
    expect(locationOf(done, "mine")).toBe("bf1");
    expect(locationOf(done, "theirs")).toBe("bf2");
    expect(done.battlefields[0]!.contestedByIndex, "the caster did not contest their own destination").toBe(0);
    expect(done.battlefields[1]!.contestedByIndex, "450 was not applied to the second move").toBe(1);
  });

  it("excludes the unit's CURRENT location and offers its base (355.4.a / 198.1)", () => {
    const { state, cardId } = assaultState();
    // Both units start at bf1, so bf1 must not be on either option list and each
    // unit's own base must be.
    state.players[0]!.baseUnits = [];
    state.players[1]!.baseUnits = [];
    state.battlefields[0]!.units = {
      p1: [makeUnit({ instanceId: "mine", name: "mine", might: 3 })],
      p2: [makeUnit({ instanceId: "theirs", name: "theirs", might: 3 })],
    };

    const cast = resolveHeldTriggers(accept(state, assaultWith(state, cardId, "mine", "theirs")!));
    expect(optionIds(cast), "the battlefield it already stands at was offered").not.toContain("bf1");
    expect(optionIds(cast), "base is a Location and was not offered").toContain("base");
    expect(optionIds(cast), "no other battlefield was offered — the negatives prove nothing").toContain("bf2");
  });

  it("does NOT offer base to a unit already there — there is no move to make", () => {
    // The same rule from the other side: `mine` starts in base, so base is its
    // current Location and 355.4.a excludes it.
    const { state, cardId } = assaultState();
    const cast = resolveHeldTriggers(accept(state, assaultWith(state, cardId, "mine", "theirs")!));
    expect(optionIds(cast), "a unit in base was offered its own base").not.toContain("base");
    expect(optionIds(cast).sort(), "the battlefields were not offered either").toEqual(["bf1", "bf2"]);
  });

  it("sends the ENEMY unit to ITS OWN base, not the caster's (107.1.c)", () => {
    // The destination is the caster's choice but the base is not: "permanents and
    // runes controlled by a player reside in that player's Base", so `forceMoveToBase`
    // has only one base it can mean. A unit that landed in the caster's base would
    // be a unit the caster does not control sitting in their own base — invisible in
    // any assertion that only asks "is it in a base".
    const { state, cardId } = assaultState();
    state.players[0]!.baseUnits = [];
    state.players[1]!.baseUnits = [];
    state.battlefields[0]!.units = {
      p1: [makeUnit({ instanceId: "mine", name: "mine", might: 3 })],
      p2: [makeUnit({ instanceId: "theirs", name: "theirs", might: 3 })],
    };
    const done = answerDecisions(
      resolveHeldTriggers(accept(state, assaultWith(state, cardId, "mine", "theirs")!)),
      choosing("bf2", "base"),
    );
    expect(done.players[1]!.baseUnits.map((u) => u.instanceId), "the enemy did not go home").toContain("theirs");
    expect(done.players[0]!.baseUnits.map((u) => u.instanceId), "an enemy unit landed in the caster's base").not.toContain("theirs");
  });

  it("reaches a unit sheltering in the ENEMY's base — both nouns are bare (355.9.a.1)", () => {
    // `theirs` is in p1's base in the fixture, and it is the only enemy unit, so the
    // spell being castable at all is the assertion.
    const { state, cardId } = assaultState();
    const offered = playsOf(state, cardId).map((a) => a.secondTargetUnitInstanceId);
    expect(offered, "a unit in the enemy base was out of reach").toContain("theirs");
  });

  it("still performs the SECOND move when the FIRST has nowhere legal to go", () => {
    // The `VOID_ASSAULT_NOWHERE` branch, and the only board that reaches it: ONE
    // battlefield (so 355.4.a's "other than the Unit's current Location" leaves no
    // battlefield) with a Minotaur Reckoner out (so `mayMoveToBaseFrom` refuses the
    // base as well). Without the fallback the first question would return no options,
    // `advanceDecisions` would drop it as moot, and the enemy move would vanish with
    // it — silently, since a dropped question looks exactly like an answered one.
    const card = spellInstance(VOID_ASSAULT);
    const state = makeState({
      phase: "Action",
      activePlayerIndex: 0,
      battlefields: [{ id: "bf1", name: "Battlefield 1", controllerId: null, units: {}, contestedByIndex: null, hiddenCards: [] }],
    });
    state.players[0]!.hand = [card];
    state.players[0]!.floatingEnergy = 6;
    state.players[0]!.channeled = runes("Body", 4);
    // Minotaur Reckoner (SFD-014) — "Units can't move to base", global and symmetric.
    state.players[0]!.baseUnits = [realUnitInstance("SFD-014")];
    state.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "mine", name: "mine", might: 3 })] };
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "theirs", name: "theirs", might: 3 })];

    const cast = resolveHeldTriggers(accept(state, assaultWith(state, card.instanceId, "mine", "theirs")!));
    // Both questions are one-option and drain without a prompt, so the queue is
    // already empty here — the assertion is on the board.
    expect(locationOf(cast, "mine"), "the friendly moved despite having nowhere to go").toBe("bf1");
    expect(locationOf(cast, "theirs"), "the second instruction was swallowed by the first").toBe("bf1");
  });

  it("still performs the SECOND move when the first target died in the response window", () => {
    // 359.3.e.11 — "instructions that can be partially followed are followed as much
    // as possible". The friendly is removed after the spell is announced and before
    // it resolves, which is what a Reaction kill looks like from the resolver's side.
    const { state, cardId } = assaultState();
    const cast = accept(state, assaultWith(state, cardId, "mine", "theirs")!);
    const orphaned = { ...cast };
    orphaned.players[0] = { ...orphaned.players[0]!, baseUnits: [] };

    const done = answerDecisions(resolveHeldTriggers(orphaned), choosing("bf2"));
    expect(unitAnywhere(done, "mine"), "the fixture did not remove the friendly").toBeUndefined();
    expect(locationOf(done, "theirs"), "the enemy move was swallowed with the friendly one").toBe("bf2");
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(VOID_ASSAULT)), "Void Assault is still reported unimplemented").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// What this wave REFUSED, and the shared-file row each one needs
// ---------------------------------------------------------------------------

describe("the five cards wave 7 refused", () => {
  /**
   * Each of these is pinned UNIMPLEMENTED so that finishing one fails loudly here
   * rather than quietly changing behaviour nobody is watching. The precise edit is
   * written beside each, in the file it belongs to — none of which this wave owns.
   */
  it("Repulse (UNL-106) — needs a cross-target filter on `chainSpellAndUnit`", () => {
    // "Choose a friendly unit at a battlefield. Counter an enemy spell or ability
    // that chooses it AND NO OTHER friendly unit."
    //
    // The restriction is BETWEEN the two targets, and `chainSpellAndUnit`
    // (card-effects.ts) carries no filter fields at all. It needs, in order:
    //   1. card-effects.ts — `enemyOnly?: true` and a new `choosesOnlyThisUnit?: true`
    //      on the `chainSpellAndUnit` variant.
    //   2. counter-spell.ts — a predicate beside `choosesAFriendlyPermanent`, asking
    //      whether the chain entry's chosen ids include `unitInstanceId` and NO other
    //      unit of `counterorIndex`.
    //   3. legal-actions.ts + validate-play-card.ts — that predicate applied to each
    //      (spell, unit) pair of the cross product, in BOTH, or it is the
    //      offered-then-refused split.
    //
    // Approximating it as Not So Fast's `choosesFriendlyPermanent` was rejected: that
    // is wider than printed in three directions (a spell choosing two friendly units,
    // a chosen GEAR, and a friendly unit in BASE).
    expect(isCardImplemented(registry.get(REPULSE))).toBe(false);
  });

  it("Determined Sentry (UNL-111) — needs a per-UNIT gate where the engine has a per-BATTLEFIELD one", () => {
    // "I can't move to base." **446.1** makes a permanent changing position from one
    // space on the Board to another a Move, and **198.1** makes a Base a space — so
    // the engine's `RecallUnitAction` is that move despite its name.
    //
    // `battlefield-continuous.mayMoveToBaseFrom(state, battlefieldId)` is the one
    // door every way home comes through, and it takes no unit. The edit is a sibling
    // in that file — `unitMayMoveToBase(state, unit, battlefieldId)`, returning false
    // for this defId and otherwise deferring — plus the four call sites that have a
    // unit in hand: validate-recall-unit.ts:46, legal-actions.ts:2031 and
    // effect-helpers.ts's `forceMoveToBase` / `recallUnitToBase`. Its defId then
    // joins `moveRestrictionDefIds()` beside Minotaur Reckoner.
    //
    // **456.3** — "a Recall cannot be prevented by actions and Game Effects that
    // restrict or block Movement" — is why combat's step-3d recall (466.1.a.2) must
    // stay unaffected, exactly as it already is for Vilemaw's Lair.
    // **This refusal expired on 2026-08-13 and every line of it was right**,
    // including the 456.3 note: combat's step-3d recall goes through
    // `relocateToBaseUnchanged` and calls neither predicate, so it stayed
    // unaffected without a special case. Inverted rather than deleted — a
    // restriction that silently stopped applying makes an illegal retreat legal
    // and looks like nothing at all.
    expect(isCardImplemented(registry.get(DETERMINED_SENTRY)), "the Sentry went back to unwritten").toBe(true);
  });

  it("Arachnoid Horror (UNL-117) — needs a new PLACEMENT_GRANTS kind and its board-wide twin", () => {
    // Two sentences, two shared tables:
    //   1. "I can be played to an occupied battlefield if an enemy unit is ALONE
    //      there" — a `PlacementGrant` kind in unit-triggers.ts. **740.2.a**: "a unit
    //      is alone when there are no other friendly units at the same location", so
    //      the test is that the OPPONENT has exactly one unit there. Strictly narrower
    //      than Deadbloom Predator's `occupiedEnemyBattlefield` (`>= 1`), so it cannot
    //      reuse that row.
    //   2. "FRIENDLY UNITS can be played to an occupied battlefield if an enemy unit
    //      is alone there" — the board-wide widening, which is Miss Fortune -
    //      Buccaneer's shape in board-restrictions.ts and has to be read inside
    //      `mayPlaceWithoutPresence` the way `anyUnitMayTakeOpenBattlefield` reads
    //      hers.
    //
    // Its `[Hunt 2]` already works — that is the keyword's single registry entry —
    // which is why the card is not wholly inert today even though it reports
    // unimplemented.
    expect(isCardImplemented(registry.get(ARACHNOID_HORROR))).toBe(false);
  });

  it("Elder Dragon (UNL-118) — its passive needs damage to remember who marked it", () => {
    // "Any amount of your damage is enough to kill enemy units." The rules name this
    // card by hand at **142.4.c**: "some effects may alter this amount... Example:
    // Elder Dragon's passive ability reads 'Any amount of your damage is enough to
    // kill enemy units.' This alters the Lethal Damage value for enemy units that
    // have damage marked BY YOU."
    //
    // `UnitInstance.damage` is one unattributed number, so "your damage" cannot be
    // asked. The edit spans model/card.ts (per-marker damage), effect-helpers.ts's
    // `dealDamage` lethal branch, and combat.ts's `remainingMight` assignment order —
    // 465.2.c.3 assigns "lethal damage in full before moving to the next unit", and a
    // 1-point lethal threshold changes that arithmetic too.
    //
    // His on-play half IS written ("choose up to one enemy unit at each location,
    // deal 1 to them"), which is why this is a PARTIALLY_IMPLEMENTED row rather than
    // an absent card.
    expect(isCardImplemented(registry.get(ELDER_DRAGON))).toBe(false);
    expect(implementingModules(ELDER_DRAGON), "the on-play half is not registered either").not.toEqual([]);
  });

  it("Kha'Zix - Voidreaver (UNL-201) — his third clause needs an XP price on ActivationCost", () => {
    // "Spend 2 XP, [Exhaust]: Move an exhausted friendly unit from a battlefield to
    // its base", alongside his written "Spend 1 XP, [Exhaust]: [Buff] a unit".
    //
    // Two abilities on one defId must be MODES of one registry entry, and
    // `AbilityMode` already carries a per-mode `cost` — but `ActivationCost` has no
    // `xp` field, so the price has to be split into `availableWhile`, which is
    // declared on the ABILITY and receives no `modeId`. `canPayActivationCost`
    // RECEIVES a `modeId` (activated-abilities.ts:1957) and drops it on the floor at
    // line 1963.
    //
    // Cleanest edit, in activated-abilities.ts alone: `ActivationCost.xp?: number`,
    // checked in `canPayActivationCost` beside the `power` line and paid in
    // `payActivationCost` through `spendXp`. That also retires the split for Poppy,
    // Crowd Favorite, Blood Rose and Megatusk, which all price XP the same way.
    //
    // Gating one `availableWhile` on 1 XP instead would offer the 2-XP move to a
    // player who cannot pay it — the exhaust is taken BEFORE `resolve` runs, so the
    // refusal would leave a Legend spent for nothing.
    // **This pin expired on 2026-08-12, the day after it was written**, and is
    // inverted rather than deleted: it named `ActivationCost.xp` as the price, the
    // integrator landed exactly that, and his third clause went in as a second
    // mode. A cost that silently stopped being charged looks like nothing at all —
    // the ability simply becomes free — so the inversion is what would notice.
    expect(isCardImplemented(registry.get(KHAZIX_VOIDREAVER)), "Kha'Zix went back to being half-written").toBe(true);
  });

  it("...and the two this wave DID write are registered", () => {
    // The positive half, so the five refusals above cannot be mistaken for a wave
    // that measured nothing.
    for (const defId of [GRIM_RESOLVE, VOID_ASSAULT]) {
      expect(implementingModules(defId), `${defId} is not registered`).not.toEqual([]);
    }
  });
});
