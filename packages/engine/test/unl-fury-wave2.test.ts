import { describe, expect, it } from "vitest";
import { cardModeOf, repeatCostOf } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { effectiveKeywords, hasKeyword } from "../src/engine/granted-keywords.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { pendingDecision, optionsFor } from "../src/engine/decisions.js";
import { isCardImplemented, unimplementedKeywordsOn } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { RuneCard } from "../src/model/rune.js";
import { answerDecisions, makeState, makeUnit, playUnitTrigger, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * Unleashed cards owned by src/engine/effects/fury.ts — wave 2.
 *
 * Everything goes through a COMPOSED registry (`cardModeOf`) or a real
 * dispatcher (`playUnitTrigger`, `submit`), never a resolver imported by hand:
 * a card that is registered but unreachable has to fail here rather than pass
 * while being dead in a game.
 *
 * **Every card gets a negative control.** A happy-path assertion passes just as
 * well when the card fires unconditionally, which is the failure mode this suite
 * exists to catch — "give your OTHER units HERE" has three different ways to be
 * silently too generous and none of them shows up in a positive test.
 *
 * Three of the eight cards in this wave are NOT here, because they are not
 * written: Inferna (UNL-002) is keyword-only and waits on `[Ambush]`; Smite
 * (UNL-007) wants a this-turn death→banish replacement; Lotus Trap (UNL-013)
 * wants a per-unit damage-doubling replacement that also has to reach combat
 * damage ASSIGNMENT (465.2.c.4.a). Asserting anything about text nobody wrote is
 * what makes a gap look finished, so nothing here mentions them again.
 */

const registry = defaultCardRegistry();

const MISCHIEVOUS_MARAI = "UNL-003";
const UPSTAGE_COMEDY = "UNL-009";
const VAULT_BREAKER = "UNL-010";
const LORD_BROADMANE = "UNL-012";
const MONSTER_HARPOON = "UNL-014";
/** Blood Rush — a Fury spell whose `[Repeat]` IS priced. Only ever the positive
 *  control for the enumerator in the Upstage Comedy pin below. */
const BLOOD_RUSH = "SFD-003";

const fury = (id: string): RuneCard => ({ id, domain: "Fury", state: "Ready" });

type SpellEvent = Parameters<NonNullable<ReturnType<typeof cardModeOf>>["resolve"]>[2];

/** Resolves a Spell through the composed effect registry — the same route
 *  `resolveCardEffect` takes, so an unregistered or misfiled defId fails on the
 *  first line rather than silently returning the state unchanged. */
function resolveSpell(defId: string, casterIndex: 0 | 1, state: GameState, event: SpellEvent = {}): GameState {
  const effect = cardModeOf(spellInstance(defId), undefined);
  expect(effect, `${defId} has no registered effect`).toBeDefined();
  return effect!.resolve(state, contextFor(casterIndex), event);
}

const unitAt = (state: GameState, instanceId: string): UnitInstance | undefined =>
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

/** Plays every chain item out by passing focus until the chain is empty. */
function settle(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 12 && current.spellChain.length > 0; guard += 1) {
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) break;
    current = accept(current, pass);
  }
  return current;
}

describe("Upstage Comedy (UNL-009): ready a unit", () => {
  it("readies the NAMED unit through a real cast — legalActions, submit, chain", () => {
    // The hop a composed-registry call cannot prove: the chosen target has to
    // survive validation, payment and the chain to reach the resolver.
    const target = makeUnit({ instanceId: "sleeper", exhausted: true });
    const bystander = makeUnit({ instanceId: "bystander", exhausted: true });
    const state = makeState();
    state.players[0]!.hand = [spellInstance(UPSTAGE_COMEDY)];
    state.players[0]!.channeled = Array.from({ length: 6 }, (_, i) => fury(`f${i}`));
    state.players[0]!.baseUnits = [target, bystander];

    const play = legalActions(state).find(
      (a) => a.type === "PlayCard" && a.card.defId === UPSTAGE_COMEDY && a.targetUnitInstanceId === "sleeper",
    );
    expect(play, "Upstage Comedy was not castable at the sleeper").toBeDefined();
    const after = settle(accept(state, play!));

    expect(unitAt(after, "sleeper")!.exhausted, "the spell resolved but the ready never landed").toBe(false);
    // NEGATIVE CONTROL: one unit, not a sweep. A resolver that readied everything
    // passes the assertion above and fails this one.
    expect(unitAt(after, "bystander")!.exhausted).toBe(true);
  });

  it("reaches a unit in BASE and at a battlefield alike — the bare noun (355.9.b)", () => {
    const atBattlefield = makeUnit({ instanceId: "front", exhausted: true });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [atBattlefield] };

    const after = resolveSpell(UPSTAGE_COMEDY, 0, state, { targetUnitInstanceId: "front" });
    expect(unitAt(after, "front")!.exhausted).toBe(false);
  });

  /**
   * **This pin did its job, and is now the positive assertion.**
   *
   * It asserted the WRONG answer on purpose — that `REPEAT_COSTS` had no UNL-009
   * row, so the printed "[Repeat] [2]" was real text doing nothing in play while
   * coverage reported the card finished. Adding the row on 2026-08-09 failed it
   * loudly, which is precisely what the pin existed for.
   *
   * Rewritten rather than deleted. The positive control below is KEPT and
   * inverted in role: it used to prove the instrument could see a repeat variant
   * when one existed, and now guards the opposite mistake — a change that made
   * every card offer a repeat would satisfy the new assertion just as happily, so
   * a card that must NOT be repeatable is asked on the same board.
   */
  it("the [Repeat] is priced, and paying it readies a SECOND unit", () => {
    expect(repeatCostOf(UPSTAGE_COMEDY), "the row was removed — the [Repeat] is inert again").toEqual({ energy: 2 });

    const state = makeState();
    state.players[0]!.hand = [spellInstance(UPSTAGE_COMEDY)];
    state.players[0]!.channeled = Array.from({ length: 8 }, (_, i) => fury(`f${i}`));
    state.players[0]!.baseUnits = [
      makeUnit({ instanceId: "sleeper", exhausted: true }),
      makeUnit({ instanceId: "sleeper2", exhausted: true }),
    ];

    const plays = legalActions(state).filter((a) => a.type === "PlayCard" && a.card.defId === UPSTAGE_COMEDY);
    expect(plays.length, "the spell is not castable at all — this test is measuring nothing").toBeGreaterThan(0);
    expect(plays.filter((a) => a.type === "PlayCard" && a.repeatPaid === true).length).toBeGreaterThan(0);
    // Declining stays available: 820.1 makes the Repeat an OPTIONAL additional cost.
    expect(plays.filter((a) => a.type === "PlayCard" && a.repeatPaid !== true).length).toBeGreaterThan(0);

    // NEGATIVE CONTROL on the instrument, kept from the pin it replaces: a change
    // that offered every card a repeat variant would pass the assertions above.
    // Vault Breaker prints no [Repeat] at all and must never carry one.
    state.players[0]!.hand = [spellInstance(VAULT_BREAKER)];
    const unpriced = legalActions(state).filter((a) => a.type === "PlayCard" && a.card.defId === VAULT_BREAKER);
    expect(unpriced.filter((a) => a.type === "PlayCard" && a.repeatPaid === true)).toHaveLength(0);
  });
});

describe("Vault Breaker (UNL-010): [Assault 2] and [Ganking] this turn", () => {
  function armed(): { state: GameState; target: UnitInstance; other: UnitInstance } {
    const target = makeUnit({ instanceId: "armed" });
    const other = makeUnit({ instanceId: "unarmed" });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [target, other] };
    return { state, target, other };
  }

  it("grants BOTH keywords to the named unit", () => {
    const { state } = armed();
    const after = resolveSpell(VAULT_BREAKER, 0, state, { targetUnitInstanceId: "armed" });

    const granted = unitAt(after, "armed")!;
    expect(granted.keywordsThisTurn.Assault, "[Assault 2] carries its printed value").toBe(2);
    expect(granted.keywordsThisTurn.Ganking, "[Ganking] is unnumbered, so 1").toBe(1);
    expect(hasKeyword(after, granted, 0, "Assault")).toBe(true);
    expect(hasKeyword(after, granted, 0, "Ganking")).toBe(true);
  });

  it("NEGATIVE CONTROL: the unit standing beside it gets neither", () => {
    const { state } = armed();
    const after = resolveSpell(VAULT_BREAKER, 0, state, { targetUnitInstanceId: "armed" });

    const bystander = unitAt(after, "unarmed")!;
    expect(bystander.keywordsThisTurn).toEqual({});
    expect(hasKeyword(after, bystander, 0, "Ganking")).toBe(false);
  });

  it("the [Ganking] is LIVE: legalActions offers a battlefield-to-battlefield move it did not before", () => {
    // The measurement that separates "the flag is set" from "the keyword does
    // something". `legal-actions` gates a bf→bf move on `hasKeyword(...Ganking)`,
    // so this is the enumerator agreeing with the grant.
    const { state } = armed();
    const bfMove = (s: GameState, id: string): number =>
      legalActions(s).filter((a) => a.type === "MoveUnit" && a.unitInstanceIds.includes(id)).length;

    expect(bfMove(state, "armed"), "a unit at a battlefield may already RECALL, not move sideways").toBe(0);

    const after = resolveSpell(VAULT_BREAKER, 0, state, { targetUnitInstanceId: "armed" });
    expect(bfMove(after, "armed"), "[Ganking] granted but no move offered").toBeGreaterThan(0);
    // NEGATIVE CONTROL on the same instrument: the neighbour still cannot.
    expect(bfMove(after, "unarmed")).toBe(0);
  });

  it("may arm an ENEMY unit, and reaches base — 'a unit', no owner and no battlefield printed", () => {
    const state = makeState();
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "theirs" })];

    const after = resolveSpell(VAULT_BREAKER, 0, state, { targetUnitInstanceId: "theirs" });
    expect(unitAt(after, "theirs")!.keywordsThisTurn).toEqual({ Assault: 2, Ganking: 1 });
  });
});

describe("Monster Harpoon (UNL-014): 2, or 4 while you control a facedown card", () => {
  /** A victim big enough to survive 4, at bf1; `hidden` decides whether p1 has a
   *  facedown card at a battlefield they control. */
  function board(hidden: "none" | "mine" | "theirs" | "uncontrolled"): GameState {
    const state = makeState();
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "victim", might: 20 })] };
    if (hidden === "none") return state;
    const card = spellInstance(MONSTER_HARPOON);
    const ownerIndex = hidden === "theirs" ? 1 : 0;
    state.battlefields[1]!.hiddenCards = [{ ownerIndex, card, hiddenOnTurn: 1 }];
    // 107.3.c/421.1: a card is only hidden at a battlefield its controller
    // controls, so the control flag is part of the fixture rather than decoration.
    if (hidden !== "uncontrolled") state.battlefields[1]!.controllerId = state.players[ownerIndex]!.id;
    return state;
  }

  it("deals 2 with no facedown card, through a real cast", () => {
    const state = board("none");
    state.players[0]!.hand = [spellInstance(MONSTER_HARPOON)];
    state.players[0]!.channeled = Array.from({ length: 6 }, (_, i) => fury(`f${i}`));

    const play = legalActions(state).find((a) => a.type === "PlayCard" && a.card.defId === MONSTER_HARPOON);
    expect(play, "Monster Harpoon was not castable").toBeDefined();
    const after = settle(accept(state, play!));

    expect(unitAt(after, "victim")!.damage, "the spell resolved but the damage never landed").toBe(2);
  });

  it("deals 4 while the caster controls their own facedown card", () => {
    const after = resolveSpell(MONSTER_HARPOON, 0, board("mine"), { targetUnitInstanceId: "victim" });
    expect(unitAt(after, "victim")!.damage).toBe(4);
  });

  it("NEGATIVE CONTROL: the OPPONENT's facedown card does not arm it", () => {
    const after = resolveSpell(MONSTER_HARPOON, 0, board("theirs"), { targetUnitInstanceId: "victim" });
    expect(unitAt(after, "victim")!.damage).toBe(2);
  });

  it("NEGATIVE CONTROL: a facedown card at a battlefield the caster no longer controls does not arm it", () => {
    // 107.3.d ties the card's life to control of the battlefield; between losing
    // control and the next Cleanup the card is still sitting there, and it must
    // not count.
    const after = resolveSpell(MONSTER_HARPOON, 0, board("uncontrolled"), { targetUnitInstanceId: "victim" });
    expect(unitAt(after, "victim")!.damage).toBe(2);
  });
});

describe("Mischievous Marai (UNL-003): deal 2 to an enemy unit HERE", () => {
  /** Marai reinforcing bf1, with `enemiesHere` opposite her and one enemy parked
   *  at bf2 that "here" must never reach. */
  function board(enemiesHere: number, enemiesElsewhere = 1): { state: GameState; marai: UnitInstance } {
    const marai = realUnitInstance(MISCHIEVOUS_MARAI);
    const state = makeState();
    state.battlefields[0]!.units = {
      p1: [marai],
      p2: Array.from({ length: enemiesHere }, (_, i) => makeUnit({ instanceId: `here-${i}`, might: 20 })),
    };
    state.battlefields[1]!.units = {
      p2: Array.from({ length: enemiesElsewhere }, (_, i) => makeUnit({ instanceId: `away-${i}`, might: 20 })),
    };
    return { state, marai };
  }

  it("deals 2 to the chosen enemy unit at her destination", () => {
    const { state, marai } = board(2);
    const played = playUnitTrigger(state, marai, 0, { battlefieldId: "bf1" });

    const decision = pendingDecision(played);
    expect(decision, "no question was asked with two enemies to choose between").toBeDefined();
    const offered = optionsFor(played, decision!).map((o) => o.instanceId);
    // NEGATIVE CONTROL on the OFFER, not just on the outcome: "here" is the
    // battlefield she landed at, so the enemy at bf2 must never be on the list.
    expect(offered).toEqual(["here-0", "here-1"]);

    const after = answerDecisions(played, (options) => options.find((o) => o.instanceId === "here-1")!.id);
    expect(unitAt(after, "here-1")!.damage).toBe(2);
    expect(unitAt(after, "here-0")!.damage, "the unnamed enemy took damage too").toBe(0);
    expect(unitAt(after, "away-0")!.damage).toBe(0);
  });

  it("asks nothing and deals nothing when she is played to BASE", () => {
    // "When you play me TO A BATTLEFIELD" — printed, and the reason this clause
    // is narrower than Janna - Savior's "your units here".
    const { state, marai } = board(2);
    const after = playUnitTrigger(state, marai, 0, "base");

    expect(pendingDecision(after)).toBeUndefined();
    expect(unitAt(after, "here-0")!.damage).toBe(0);
    expect(unitAt(after, "here-1")!.damage).toBe(0);
  });

  it("asks nothing when no enemy stands at her destination", () => {
    const { state, marai } = board(0);
    const after = playUnitTrigger(state, marai, 0, { battlefieldId: "bf1" });

    expect(pendingDecision(after)).toBeUndefined();
    expect(unitAt(after, "away-0")!.damage, "an enemy elsewhere was shot").toBe(0);
  });

  it("fires through a REAL play — legalActions, submit, the on-play dispatch", () => {
    // The dispatch hop a `playUnitTrigger` call cannot prove: a Unit's on-play
    // trigger has to survive validation, payment, the chain and the Cleanup.
    const { state, marai } = board(1, 0);
    // She reinforces, so she starts in hand with a friendly already at bf1.
    state.battlefields[0]!.units = { ...state.battlefields[0]!.units, p1: [makeUnit({ instanceId: "anchor" })] };
    state.players[0]!.hand = [marai];
    state.players[0]!.channeled = Array.from({ length: 6 }, (_, i) => fury(`f${i}`));

    const play = legalActions(state).find(
      (a) => a.type === "PlayCard" && a.card.defId === MISCHIEVOUS_MARAI && a.destinationBattlefieldId === "bf1",
    );
    expect(play, "the Marai could not be played to bf1").toBeDefined();
    // One enemy here means one option, which `advanceDecisions` takes on the
    // player's behalf — so the damage lands without anybody being asked.
    const after = answerDecisions(settle(accept(state, play!)));

    expect(unitAt(after, "here-0")!.damage, "the trigger never reached the resolver").toBe(2);
  });
});

describe("Lord Broadmane (UNL-012): give your OTHER units HERE [Assault] this turn", () => {
  /** Broadmane at bf1 with an ally beside him, an ally at bf2, an ally in base
   *  and an enemy beside him — one of each thing the grant must not reach. */
  function board(): { state: GameState; lord: UnitInstance } {
    const lord = realUnitInstance(LORD_BROADMANE);
    const state = makeState();
    state.battlefields[0]!.units = {
      p1: [lord, makeUnit({ instanceId: "ally-here" })],
      p2: [makeUnit({ instanceId: "enemy-here" })],
    };
    state.battlefields[1]!.units = { p1: [makeUnit({ instanceId: "ally-away" })] };
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "ally-home" })];
    return { state, lord };
  }

  it("pumps the friendly unit standing with him", () => {
    const { state, lord } = board();
    const after = playUnitTrigger(state, lord, 0, { battlefieldId: "bf1" });

    const ally = unitAt(after, "ally-here")!;
    expect(ally.keywordsThisTurn.Assault, "bare [Assault] is 1").toBe(1);
    expect(hasKeyword(after, ally, 0, "Assault")).toBe(true);
  });

  it("NEGATIVE CONTROL: not himself, not the enemy beside him, not friendlies elsewhere", () => {
    const { state, lord } = board();
    const after = playUnitTrigger(state, lord, 0, { battlefieldId: "bf1" });

    expect(unitAt(after, lord.instanceId)!.keywordsThisTurn, "'OTHER' — he pumped himself").toEqual({});
    expect(unitAt(after, "enemy-here")!.keywordsThisTurn, "'YOUR' units — the enemy was pumped").toEqual({});
    expect(unitAt(after, "ally-away")!.keywordsThisTurn, "'HERE' — a friendly at bf2 was pumped").toEqual({});
    expect(unitAt(after, "ally-home")!.keywordsThisTurn, "'HERE' — a friendly in base was pumped").toEqual({});
  });

  it("a SECOND Lord Broadmane already here IS pumped — 'other' is by instance", () => {
    const { state, lord } = board();
    const twin = realUnitInstance(LORD_BROADMANE);
    state.battlefields[0]!.units.p1 = [...state.battlefields[0]!.units.p1!, twin];

    const after = playUnitTrigger(state, lord, 0, { battlefieldId: "bf1" });
    const twinAfter = unitAt(after, twin.instanceId)!;
    expect(twinAfter.keywordsThisTurn.Assault, "the grant itself is a bare [Assault]").toBe(1);
    // The twin PRINTS [Assault 1], and 807.2 sums the values of all Assault
    // sources — so the granted one stacks on the printed one rather than being
    // redundant. Read through `effectiveKeywords`, which is where that rule lives.
    expect(effectiveKeywords(after, twinAfter, 0).Assault).toBe(2);
    expect(unitAt(after, lord.instanceId)!.keywordsThisTurn).toEqual({});
  });

  it("played to BASE he pumps his other units in base — he prints no 'to a battlefield'", () => {
    const { state, lord } = board();
    state.players[0]!.baseUnits = [...state.players[0]!.baseUnits, lord];

    const after = playUnitTrigger(state, lord, 0, "base");
    expect(unitAt(after, "ally-home")!.keywordsThisTurn.Assault).toBe(1);
    expect(unitAt(after, "ally-here")!.keywordsThisTurn, "a friendly at bf1 was pumped from base").toEqual({});
  });

  it("PIN: he still reports unimplemented, because [Ambush] is", () => {
    // Registration is per defId and this file registers his SECOND clause only.
    // His `[Ambush]` is a play permission that lives in unit-triggers.ts /
    // timing.ts, and `coverage.UNIMPLEMENTED_KEYWORDS` is what keeps him greyed
    // until it lands. Asserting the wrong answer on purpose, so closing that gap
    // fails loudly here instead of changing quietly.
    const def = registry.get(LORD_BROADMANE);
    expect(def.text).toContain("[Ambush]");
    expect(unimplementedKeywordsOn(def), "the keyword he parses and cannot use").toEqual([]);
    expect(isCardImplemented(def), "[Ambush] landed 2026-08-09 — this card is whole now").toBe(true);
  });
});
