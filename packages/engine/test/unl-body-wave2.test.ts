import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { modifiedEnergyCost } from "../src/engine/cost-modifiers.js";
import { activatedAbilityFor } from "../src/engine/activated-abilities.js";
import { implementingModule, isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { gainXp } from "../src/engine/effect-helpers.js";
import { createCardInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { Domain } from "../src/model/domain.js";
import { answerDecisions, makeState, makeUnit, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * Wave 2's Body cards, five of eight.
 *
 * Every card here is asserted through `submit`/`legalActions` rather than by
 * calling a resolver, because the two have come apart in this repo repeatedly: a
 * registered effect whose choice is dropped on the dispatch hop reports as
 * IMPLEMENTED and does nothing in a real game. So the shape of each test is the
 * same — enumerate the play, submit it, resolve the chain, and then assert both
 * that the effect fired AND that it does not fire when its condition is absent.
 *
 * Three cards land only HALF their printed text, and each half that is missing is
 * PINNED here with a test asserting the wrong answer, so closing the gap fails
 * loudly instead of silently changing behaviour nobody was watching.
 */

const registry = defaultCardRegistry();
const CONCENTRATE = "UNL-091";
const GRIM_RESOLVE = "UNL-095";
const CALL_TO_BATTLE = "UNL-101";
const CROWD_FAVORITE = "UNL-102";
const DISPOSAL_ORDER = "UNL-103";
const KARMA_CHANNELER = "OGN-235"; // "When you recycle one or more cards to your Main Deck, buff a friendly unit."

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `action was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** Passes focus until the chain empties or a question stops it — a Spell takes
 *  effect on resolution, and `submit` refuses a pass while a decision is
 *  outstanding (320.1). */
function resolveChain(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 12 && current.spellChain.length > 0; guard += 1) {
    if (current.pendingDecisions.length > 0) return current;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    expect(pass, "no focus pass was offered while the chain was non-empty").toBeDefined();
    current = accept(current, pass);
  }
  return current;
}

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

const runes = (domain: Domain, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

const unitsAt = (state: GameState, battlefieldId: string, playerId: string) =>
  state.battlefields.find((b) => b.id === battlefieldId)!.units[playerId] ?? [];

const unitAnywhere = (state: GameState, instanceId: string) =>
  [
    ...state.players.flatMap((p) => p.baseUnits),
    ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
  ].find((u) => u.instanceId === instanceId);

/** Filler cards for a deck or a trash — real registry instances, so nothing
 *  depends on a synthetic card definition the loader would not produce. */
function filler(count: number, defId = CONCENTRATE) {
  return Array.from({ length: count }, () => createCardInstance(registry.get(defId)));
}

describe("Concentrate (UNL-091): draw 2", () => {
  function armed(): { state: GameState; spellId: string } {
    const spell = spellInstance(CONCENTRATE);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runes("Body", 6);
    state.players[0]!.deck = filler(5);
    return { state, spellId: spell.instanceId };
  }

  it("draws 2 through the real play path", () => {
    const { state, spellId } = armed();
    const play = playsOf(state, spellId)[0];
    expect(play, "Concentrate was never offered").toBeDefined();

    const after = resolveChain(accept(state, play!));

    expect(after.players[0]!.hand, "the draw never fired").toHaveLength(2);
    expect(after.players[0]!.deck).toHaveLength(3);
  });

  it("PINS the unwritten half: the [Level] discounts do not reach the cost", () => {
    // "[Level 6][>] This costs [2] less. [Level 11][>] This costs [4] less
    // instead." — a COST reduction, which lives in cost-modifiers.ts and is not
    // written. 11 XP is past BOTH thresholds, so a card that priced either one
    // would answer 3 or 1 here rather than the printed 5.
    //
    // Asserting the WRONG answer deliberately, per this repo's rule for a
    // recorded divergence: whoever writes the discount has to come here and
    // change it, rather than the gap closing unnoticed.
    const state = gainXp(makeState({ phase: "Action" }), 0, 11);
    expect(modifiedEnergyCost(state, 0, "Spell", 5, CONCENTRATE)).toBe(5);
  });

  it("reports as PARTIAL rather than done, without a hand-written entry", () => {
    // Derived from the printed `[Level]` bracket, so no entry in coverage.ts's
    // PARTIALLY_IMPLEMENTED map was needed — `isCardImplemented` returns false
    // for any card carrying an unimplemented keyword. That derivation is what
    // stops the draw half claiming the whole card, and both halves are asserted:
    // the effect IS registered here, and the card still does not read finished.
    expect(implementingModule(CONCENTRATE), "the draw was never registered").toBe("card-effects");
    expect(isCardImplemented(registry.get(CONCENTRATE)), "the card reads as finished").toBe(false);
    expect(partialImplementationNote(registry.get(CONCENTRATE))).toMatch(/Level/);
  });
});

describe("Grim Resolve (UNL-095): +3 Might this turn to a friendly unit", () => {
  function armed(): { state: GameState; spellId: string } {
    const spell = spellInstance(GRIM_RESOLVE);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runes("Body", 4);
    state.battlefields[0]!.units = {
      p1: [makeUnit({ name: "Hero", instanceId: "hero", might: 3 })],
      p2: [makeUnit({ name: "Villain", instanceId: "villain", might: 3 })],
    };
    return { state, spellId: spell.instanceId };
  }

  it("pumps the chosen friendly unit", () => {
    const { state, spellId } = armed();
    const play = playsOf(state, spellId).find((p) => p.targetUnitInstanceId === "hero");
    expect(play, "no variant naming the friendly unit was offered").toBeDefined();

    const after = resolveChain(accept(state, play!));

    const hero = unitAnywhere(after, "hero")!;
    expect(effectiveMight(after, hero, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(6);
  });

  it("is never offered an ENEMY unit — 'a FRIENDLY unit' is in the spec, not the resolver", () => {
    // The negative control that matters for a pump: a spec that dropped `owner`
    // would enumerate the opponent's board and the card would read as working.
    const { state, spellId } = armed();
    const named = playsOf(state, spellId).map((p) => p.targetUnitInstanceId);
    expect(named).toContain("hero");
    expect(named, "the enemy unit was offered as a target").not.toContain("villain");
  });

  it("PINS the unwritten half: winning a combat this turn gains NO XP", () => {
    // "When it wins a combat this turn, gain 2 XP" is not implemented — a
    // resolved Spell sits in its caster's trash, which no listener walk reaches
    // (only `TRASH_LISTENER_DEF_IDS`' two cards fire from there). See the note at
    // `GRIM_RESOLVE_MIGHT` in effects/body.ts.
    //
    // Driven through a REAL combat rather than by inspecting the registry, so
    // this fails the day the clause lands however it is written.
    const { state, spellId } = armed();
    const play = playsOf(state, spellId).find((p) => p.targetUnitInstanceId === "hero");
    const pumped = resolveChain(accept(state, play!));
    expect(pumped.players[0]!.xp, "XP moved before any combat").toBe(0);

    // 6 Might against 3: the villain dies, the hero does not, so exactly one side
    // is left and 466.3.a makes it a win.
    const fought = answerDecisions(resolveHeldTriggers(resolveShowdown(pumped, "bf1", 0)));
    expect(unitsAt(fought, "bf1", "p2"), "the fixture did not actually win the combat").toHaveLength(0);
    expect(fought.players[0]!.xp, "the delayed XP clause fired — update this pin").toBe(0);
  });
});

describe("Call to Battle (UNL-101): both players move a unit to one battlefield", () => {
  function armed(controlsBattlefield: boolean): { state: GameState; spellId: string } {
    const spell = spellInstance(CALL_TO_BATTLE);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runes("Body", 5);
    state.players[0]!.baseUnits = [makeUnit({ name: "Hero", instanceId: "hero" })];
    state.players[1]!.baseUnits = [
      makeUnit({ name: "Grunt", instanceId: "grunt" }),
      makeUnit({ name: "Brute", instanceId: "brute" }),
    ];
    if (controlsBattlefield) state.battlefields[0]!.controllerId = "p1";
    return { state, spellId: spell.instanceId };
  }

  it("moves the caster's unit, then makes the OPPONENT choose one of theirs", () => {
    const { state, spellId } = armed(true);
    const play = playsOf(state, spellId).find((p) => p.targetUnitInstanceId === "hero");
    expect(play, "no variant naming the friendly unit was offered").toBeDefined();

    const stopped = resolveChain(accept(state, play!));

    // The caster's half has already happened, and the question that is waiting
    // belongs to the OTHER seat — which is the whole mechanism of the second
    // sentence and the thing a PlayCardAction cannot carry.
    expect(unitsAt(stopped, "bf1", "p1").map((u) => u.name), "the caster's unit never moved").toEqual(["Hero"]);
    const question = stopped.pendingDecisions[0];
    expect(question, "the opponent was never asked").toBeDefined();
    expect(question!.playerIndex, "the CASTER was asked to move the opponent's unit").toBe(1);

    const after = answerDecisions(stopped, (options) => options.find((o) => o.instanceId === "brute")!.id);

    expect(unitsAt(after, "bf1", "p2").map((u) => u.name)).toEqual(["Brute"]);
    expect(after.players[1]!.baseUnits.map((u) => u.name), "the wrong unit was moved").toEqual(["Grunt"]);
  });

  it("does NOTHING when the caster controls no battlefield", () => {
    // "To a battlefield you CONTROL" — presence is not control, and with no
    // destination the first instruction is unperformable, which leaves the second
    // with no "same battlefield" to name (359.3.e.11).
    const { state, spellId } = armed(false);
    const play = playsOf(state, spellId).find((p) => p.targetUnitInstanceId === "hero");

    const after = resolveChain(accept(state, play!));

    expect(after.pendingDecisions, "a question was raised with no destination to name").toHaveLength(0);
    expect(after.players[0]!.baseUnits.map((u) => u.name)).toEqual(["Hero"]);
    expect(after.players[1]!.baseUnits.map((u) => u.name)).toEqual(["Grunt", "Brute"]);
  });

  it("never offers the opponent a unit already standing there — 355.4.a", () => {
    // A move's destination must be "other than the Units' current Location". The
    // Grunt is already at bf1, so the only real answer is the Brute — and with
    // one option, `advanceDecisions` takes it without ever showing a question.
    const { state, spellId } = armed(true);
    state.players[1]!.baseUnits = [makeUnit({ name: "Brute", instanceId: "brute" })];
    state.battlefields[0]!.units = { p2: [makeUnit({ name: "Grunt", instanceId: "grunt" })] };

    const after = resolveChain(accept(state, playsOf(state, spellId).find((p) => p.targetUnitInstanceId === "hero")!));

    expect(after.pendingDecisions).toHaveLength(0);
    expect(unitsAt(after, "bf1", "p2").map((u) => u.name).sort()).toEqual(["Brute", "Grunt"]);
  });
});

describe("Crowd Favorite (UNL-102): Spend 2 XP: Buff me", () => {
  function armed(xp: number): { state: GameState; unitId: string } {
    const favorite = realUnitInstance(CROWD_FAVORITE);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [favorite] };
    return { state: gainXp(state, 0, xp), unitId: favorite.instanceId };
  }

  const activationsOf = (state: GameState, instanceId: string) =>
    legalActions(state).filter((a) => a.type === "ActivateAbility" && a.permanentInstanceId === instanceId);

  it("is registered through the DOMAIN-FILE seam, not the built-in table", () => {
    // The seam this wave was given. Proved before on a synthetic defId only; this
    // is the first real card through it, and if the merge ever stopped seeing
    // effects/body.ts the ability would be unreachable rather than merely absent.
    expect(activatedAbilityFor(CROWD_FAVORITE), "the ability is invisible to the merged table").toBeDefined();
    expect(implementingModule(CROWD_FAVORITE)).toBe("activated abilities");
    // His other clause is `[Hunt]`, which the keyword already serves, so unlike
    // the two half-written cards above this one is genuinely whole.
    expect(isCardImplemented(registry.get(CROWD_FAVORITE))).toBe(true);
    expect(partialImplementationNote(registry.get(CROWD_FAVORITE))).toBeUndefined();
  });

  it("spends 2 XP and buffs him", () => {
    const { state, unitId } = armed(2);
    const activation = activationsOf(state, unitId)[0];
    expect(activation, "the ability was never enumerated at 2 XP").toBeDefined();

    const after = accept(state, activation!);

    expect(after.players[0]!.xp, "the XP was not spent").toBe(0);
    expect(unitAnywhere(after, unitId)!.buffed, "he was not buffed").toBe(true);
  });

  it("is NOT offered below its price — the cost is asked where it is offered", () => {
    // The negative control the `availableWhile` hook exists for: a resolver that
    // checked instead would already have been activated, and (with no exhaust
    // printed) would look free and do nothing.
    //
    // **The POSITIVE half is asserted in the same test, and it has to be.** The
    // first version of this read `activationsOf(armed(1).state, armed(1).unitId)`
    // — two separate fixtures, so the id came from a unit that was not in the
    // state being searched, and the filter reported 0 for every XP total. It
    // survived a mutation that deleted `availableWhile` outright. A count of zero
    // is indistinguishable from a check that never ran, so the run that must find
    // something is here beside the runs that must not.
    for (const xp of [0, 1] as const) {
      const { state, unitId } = armed(xp);
      expect(activationsOf(state, unitId), `offered at ${xp} XP, which cannot pay 2`).toHaveLength(0);
    }
    const affordable = armed(2);
    expect(
      activationsOf(affordable.state, affordable.unitId),
      "nothing was enumerated even at 2 XP — the zeroes above prove nothing",
    ).toHaveLength(1);
  });

  it("does NOT exhaust him, because no exhaust is printed", () => {
    // `cost` defaults to `{ exhaust: true }` when omitted, so the empty object in
    // the registration is load-bearing: an exhaust this engine added would make a
    // repeatable XP sink a once-per-turn one.
    const { state, unitId } = armed(4);
    const once = accept(state, activationsOf(state, unitId)[0]!);
    expect(unitAnywhere(once, unitId)!.exhausted, "the ability exhausted him").toBe(false);
    expect(activationsOf(once, unitId), "he could not be activated a second time").toHaveLength(1);

    const twice = accept(once, activationsOf(once, unitId)[0]!);
    expect(twice.players[0]!.xp, "the second activation was free").toBe(0);
  });
});

describe("Disposal Order (UNL-103): choose one", () => {
  function armed(trashCount: number): { state: GameState; spellId: string } {
    const spell = spellInstance(DISPOSAL_ORDER);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runes("Body", 4);
    state.players[0]!.deck = filler(3);
    state.players[1]!.trash = filler(trashCount, GRIM_RESOLVE);
    return { state, spellId: spell.instanceId };
  }

  const modeOf = (state: GameState, spellId: string, modeId: string) =>
    playsOf(state, spellId).find((p) => p.modeId === modeId);

  it("offers BOTH modes", () => {
    const { state, spellId } = armed(4);
    expect(new Set(playsOf(state, spellId).map((p) => p.modeId))).toEqual(new Set(["recycle", "draw"]));
  });

  it("draws 1 on the second mode", () => {
    const { state, spellId } = armed(4);
    const after = resolveChain(accept(state, modeOf(state, spellId, "draw")!));
    expect(after.players[0]!.hand, "the draw mode drew nothing").toHaveLength(1);
    expect(after.players[0]!.deck).toHaveLength(2);
  });

  it("recycles up to 3 cards from the opponent's trash to the BOTTOM of their deck", () => {
    const { state, spellId } = armed(4);
    const opponentDeck = filler(2);
    state.players[1]!.deck = opponentDeck;
    const doomed = state.players[1]!.trash.slice(0, 3).map((c) => c.instanceId);

    const stopped = resolveChain(accept(state, modeOf(state, spellId, "recycle")!));
    // Takes the first real card each time; "decline" is listed first, so the
    // picker has to step past it.
    const after = answerDecisions(stopped, (options) => options.find((o) => o.id !== "decline")!.id);

    expect(after.players[1]!.trash, "the cards never left the trash").toHaveLength(1);
    const deck = after.players[1]!.deck;
    expect(deck, "the recycled cards did not reach the deck").toHaveLength(5);
    expect(deck.slice(0, 2).map((c) => c.instanceId), "they were not put on the BOTTOM (416.1)").toEqual(
      opponentDeck.map((c) => c.instanceId),
    );
    expect(deck.slice(2).map((c) => c.instanceId)).toEqual(doomed);
  });

  it("stops early when the chooser declines", () => {
    const { state, spellId } = armed(4);
    const stopped = resolveChain(accept(state, modeOf(state, spellId, "recycle")!));
    // One card, then decline — "up to 3".
    let taken = 0;
    const after = answerDecisions(stopped, (options) => {
      taken += 1;
      return taken === 1 ? options.find((o) => o.id !== "decline")!.id : "decline";
    });
    expect(after.players[1]!.trash).toHaveLength(3);
  });

  it("fires ONE cardsRecycled event for the whole instruction, not one per card", () => {
    // The batch-event trap this codebase names by hand: "their owners recycle
    // THEM" is one recycle of up to three cards, and Karma - Channeler pays out
    // once for "one or more". A per-answer event would pay her three times.
    //
    // She sits on the OPPONENT's board because 416.1.c sends the cards to their
    // own deck — "when you recycle to YOUR Main Deck" is theirs, not the caster's.
    const { state, spellId } = armed(4);
    state.battlefields[1]!.units = { p2: [realUnitInstance(KARMA_CHANNELER)] };

    const stopped = resolveChain(accept(state, modeOf(state, spellId, "recycle")!));
    const after = answerDecisions(stopped, (options) => options.find((o) => o.id !== "decline")!.id);

    const held = after.pendingTriggers.filter((e) => (e.event as { kind?: string }).kind === "cardsRecycled");
    expect(held, "Karma never saw the recycle at all — the event is not being fired").toHaveLength(1);
  });

  it("fires NOTHING when the opponent's trash is empty", () => {
    // The mode is still a legal choice (the card offers it unconditionally), it
    // just has nothing to do — 359.3.e.11. A `cardsRecycled` event held for a
    // recycle of zero cards would pay Karma for nothing.
    const { state, spellId } = armed(0);
    state.battlefields[1]!.units = { p2: [realUnitInstance(KARMA_CHANNELER)] };

    const after = resolveChain(accept(state, modeOf(state, spellId, "recycle")!));

    expect(after.pendingDecisions, "a question with no answers was left standing").toHaveLength(0);
    expect(after.pendingTriggers.filter((e) => (e.event as { kind?: string }).kind === "cardsRecycled")).toHaveLength(0);
  });
});
