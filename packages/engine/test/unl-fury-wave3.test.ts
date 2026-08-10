import { describe, expect, it } from "vitest";
import { repeatCostOf } from "../src/engine/card-effects.js";
import { effectiveMight, effectiveMightDefIds } from "../src/engine/effective-might.js";
import { hasKeyword } from "../src/engine/granted-keywords.js";
import { isCardImplemented, partialImplementationNote, unimplementedKeywordsOn } from "../src/engine/coverage.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { recordConquest } from "../src/engine/scoring.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { unitEntersReady } from "../src/engine/deploy.js";
import { GOLD_TOKEN_DEF_ID } from "../src/engine/token.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { GearInstance, UnitInstance } from "../src/model/card.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realGearInstance, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * Unleashed cards owned by src/engine/effects/fury.ts — wave 3.
 *
 * Four of the wave's eight cards are here. The other four are NOT, and naming
 * them is the point: asserting anything about text nobody wrote is what makes a
 * gap look finished.
 *
 *  - **UNL-002 Inferna** is keyword-only and waits on `[Ambush]` (a play
 *    permission, so unit-triggers.ts / timing.ts). The one pin below is that she
 *    still reports unimplemented.
 *  - **UNL-004 Prepared Neophyte** ("if you've spent [4] or more to play a spell
 *    this turn, I have +4 Might") has no counter to read. `PlayerState` tracks
 *    `powerSpentThisTurn` and nothing about Energy spent on a spell, so the
 *    condition is unanswerable from a domain file.
 *  - **UNL-012 Lord Broadmane** was written in wave 2; only his `[Ambush]` is
 *    outstanding, and `unl-fury-wave2.test.ts` already pins that.
 *  - **UNL-020 Dancing Grenade** needs the target's controller to play a spell
 *    out of the CASTER's trash, and a per-spell tally of damage instances this
 *    turn. Neither exists.
 *
 * Everything below goes through a real funnel — `legalActions`/`submit`,
 * `recordConquest`, `runEnd`, `effectiveMight` — never a resolver imported by
 * hand, because a card that is registered but unreachable has to fail here
 * rather than pass while being dead in a game.
 */

const registry = defaultCardRegistry();

const INFERNA = "UNL-002";
const SCORCHCLAW = "UNL-016"; // printed 3 Might, [Hunt 2], [Level 3][>] +1 Might and enter ready
const SQUARE_UP = "UNL-017";
const YETI_BRAWLER = "UNL-018";
const BLIGHTED_BATTLEAXE = "UNL-019";
/** Blood Rush — a Fury spell whose `[Repeat]` IS priced. Only ever the positive
 *  control for the enumerator in the Square Up pin. */
const BLOOD_RUSH = "SFD-003";

const fury = (id: string): RuneCard => ({ id, domain: "Fury", state: "Ready" });

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

describe("Scorchclaw (UNL-016): [Level 3][>] I have +1 Might", () => {
  /** Scorchclaw in his owner's base with `xp` on that owner. Base rather than a
   *  battlefield because the bonus prints no location and must not depend on one. */
  function withXp(xp: number): { state: GameState; scorchclaw: UnitInstance } {
    const state = makeState({ phase: "Action" });
    const scorchclaw = realUnitInstance(SCORCHCLAW);
    state.players[0]!.baseUnits = [scorchclaw];
    state.players[0]!.xp = xp;
    return { state, scorchclaw };
  }

  const mightAt = (xp: number): number => {
    const { state, scorchclaw } = withXp(xp);
    return effectiveMight(state, scorchclaw, 0, { isCombat: false });
  };

  it("is 3 below the threshold and 4 at it — 824.1.b.1's 'N or more'", () => {
    expect(mightAt(2), "the bonus applied below 3 XP").toBe(3);
    expect(mightAt(3), "the bonus did not apply at exactly 3 XP").toBe(4);
  });

  it("goes BACK to 3 when the XP is spent — 824.1.d, the half a one-shot pump gets wrong", () => {
    // The assertion that makes this a continuous modifier rather than an on-play
    // pump. A latched bonus passes the test above and fails this one.
    const { state, scorchclaw } = withXp(5);
    expect(effectiveMight(state, scorchclaw, 0, { isCombat: false })).toBe(4);

    const spent = { ...state, players: [{ ...state.players[0]!, xp: 2 }, state.players[1]!] } as GameState;
    expect(effectiveMight(spent, scorchclaw, 0, { isCombat: false }), "the bonus survived the XP being spent").toBe(3);
  });

  it("reads the OWNER's XP, not the asking player's", () => {
    const { state, scorchclaw } = withXp(0);
    state.players[1]!.xp = 20;
    expect(effectiveMight(state, scorchclaw, 0, { isCombat: false }), "the OPPONENT's XP paid the bonus").toBe(3);
  });

  it("NEGATIVE CONTROL: does not leak onto the unit standing beside him", () => {
    // Every registered modifier is asked about every unit, so one that forgot its
    // `unit.defId` test would buff the whole board.
    const { state } = withXp(20);
    const bystander = realUnitInstance("OGN-002");
    state.players[0]!.baseUnits.push(bystander);
    expect(effectiveMight(state, bystander, 0, { isCombat: false })).toBe(bystander.might);
  });

  it("is wired to coverage — the seam reports him, and a PARTIAL note is why he is not DONE", () => {
    // Two different claims, and the second changed at integration.
    //
    // The seam half still holds: `effectiveMightDefIds` must name him, or a card
    // whose only implementation is a Might modifier reports inert and is dropped
    // from generated decks.
    expect(effectiveMightDefIds(), "the mightModifiers seam is not reporting to coverage").toContain(SCORCHCLAW);

    // The second half asserted `isCardImplemented === true`, which was correct when
    // written and became a coverage LIE: his "and enter ready" is unwritten, and
    // registration is per defId, so the Might half alone claimed the whole card.
    // A PARTIALLY_IMPLEMENTED entry was added at integration — so he is now
    // reported NOT done, and the note says which half is missing. That is the
    // honest answer, and it is what the pin below is about.
    expect(isCardImplemented(registry.get(SCORCHCLAW)), "the partial note was dropped — he is claiming a half he does not have").toBe(false);
    expect(partialImplementationNote(registry.get(SCORCHCLAW))).toContain("enter ready");
  });

  it("PIN (DIVERGENCE): his 'and enter ready' half is UNWRITTEN — he still arrives exhausted at 3 XP", () => {
    // Asserting the WRONG answer on purpose. "I enter ready" is a replacement for
    // how a unit arrives and lives in `deploy.conditionalEntersReady`, a shared
    // file this wave may not edit; faking it as an on-play `readyUnit` was rejected
    // there in writing (the unit would sit exhausted through the held trigger's
    // whole response window, would fire `unitReadied`, and would be blockable).
    //
    // Registration is per defId, so the Might half above already reports the card
    // DONE — which is why this pin exists. Adding the deploy.ts case fails here
    // loudly instead of changing quietly.
    const { state, scorchclaw } = withXp(3);
    expect(unitEntersReady(state, 0, scorchclaw), "the [Level 3] enter-ready landed — update the pin").toBe(false);
    // Positive control on the instrument: it CAN say yes, so the `false` above is
    // a measurement rather than a broken call.
    const quick = { ...scorchclaw, keywords: { ...scorchclaw.keywords, Quick: 1 } };
    expect(unitEntersReady(state, 0, quick)).toBe(true);
  });
});

describe("Square Up (UNL-017): give a unit [Assault 4] this turn", () => {
  /** Two friendly units at bf1, so "a unit" has a bystander to miss. */
  function board(): GameState {
    const state = makeState();
    state.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "armed" }), makeUnit({ instanceId: "unarmed" })] };
    return state;
  }

  function castAt(state: GameState, targetInstanceId: string): GameState {
    state.players[0]!.hand = [spellInstance(SQUARE_UP)];
    state.players[0]!.channeled = Array.from({ length: 8 }, (_, i) => fury(`f${i}`));
    const play = legalActions(state).find(
      (a) => a.type === "PlayCard" && a.card.defId === SQUARE_UP && a.targetUnitInstanceId === targetInstanceId,
    );
    expect(play, `Square Up was not castable at ${targetInstanceId}`).toBeDefined();
    return settle(accept(state, play!));
  }

  it("grants the printed 4 through a REAL cast — legalActions, submit, the chain", () => {
    const after = castAt(board(), "armed");

    const granted = unitAt(after, "armed")!;
    expect(granted.keywordsThisTurn.Assault, "the spell resolved but the grant never landed").toBe(4);
    expect(hasKeyword(after, granted, 0, "Assault")).toBe(true);
  });

  it("NEGATIVE CONTROL: the unit standing beside it gets nothing", () => {
    const after = castAt(board(), "armed");
    const bystander = unitAt(after, "unarmed")!;
    expect(bystander.keywordsThisTurn).toEqual({});
    expect(hasKeyword(after, bystander, 0, "Assault")).toBe(false);
  });

  it("is worth +4 only to an ATTACKER — 807.1.c, not a flat pump", () => {
    // The measurement that separates "the flag is set" from "the keyword does
    // something", and the one that would still pass if [Assault] were written as
    // `mightThisTurn`. Read through `effectiveMight`, which is where 807 lives.
    const after = castAt(board(), "armed");
    const armed = unitAt(after, "armed")!;
    const ctx = { isCombat: true, combatRole: "outgoing" as const, battlefieldId: "bf1" };

    expect(effectiveMight(after, armed, 0, { ...ctx, isAttackingSide: true })).toBe(armed.might + 4);
    expect(effectiveMight(after, armed, 0, { ...ctx, isAttackingSide: false })).toBe(armed.might);
    expect(effectiveMight(after, armed, 0, { isCombat: false })).toBe(armed.might);
  });

  it("may arm an ENEMY unit, and reaches base — 'a unit', no owner and no battlefield printed", () => {
    // 355.9.a.1's widening ("'Unit,' 'gear,' and 'rune' refer to objects on the
    // Board unless specified otherwise"), NOT 355.9.b, which is the narrowing that
    // makes a printed "at a battlefield" load-bearing.
    const state = makeState();
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "theirs" })];

    const after = castAt(state, "theirs");
    expect(unitAt(after, "theirs")!.keywordsThisTurn).toEqual({ Assault: 4 });
  });

  it("PIN (DIVERGENCE): its `[Repeat] — Discard 1` is UNPRICED and therefore inert", () => {
    // Asserting the WRONG answer on purpose. `RepeatCostSpec` carries energy,
    // power/domain and rainbowPower — it cannot express a repeat cost of
    // "Discard 1", and this is the pool's first non-resource one. So no row
    // exists, the enumerator offers no repeat-paid variant, and the printed
    // keyword does nothing in play while coverage reports the card finished.
    expect(repeatCostOf(SQUARE_UP), "the [Repeat] was priced — delete this pin and test the repeat").toBeUndefined();

    const state = board();
    state.players[0]!.hand = [spellInstance(SQUARE_UP)];
    state.players[0]!.channeled = Array.from({ length: 12 }, (_, i) => fury(`f${i}`));
    const plays = legalActions(state).filter((a) => a.type === "PlayCard" && a.card.defId === SQUARE_UP);
    expect(plays.length, "the spell is not castable at all — this pin is measuring nothing").toBeGreaterThan(0);
    expect(plays.filter((a) => a.type === "PlayCard" && a.repeatPaid === true)).toHaveLength(0);

    // POSITIVE CONTROL on the instrument: a card whose [Repeat] IS priced does get
    // a repeat-paid variant on this same board, so the empty list above is a
    // measurement rather than an enumerator that never offers one.
    state.players[0]!.hand = [spellInstance(BLOOD_RUSH)];
    const priced = legalActions(state).filter((a) => a.type === "PlayCard" && a.card.defId === BLOOD_RUSH);
    expect(priced.filter((a) => a.type === "PlayCard" && a.repeatPaid === true).length).toBeGreaterThan(0);
  });
});

describe("Yeti Brawler (UNL-018): when I conquer with 3+ excess damage, two Gold gear tokens", () => {
  /** The Brawler standing at bf1, with `excess` recorded against that fight for
   *  `attackerIndex`. `null` excess is a conquest that was not an attack. */
  function board(
    excess: { battlefieldId: string; attackerIndex: 0 | 1; amount: number } | null,
    where: "bf1" | "bf2" = "bf1",
  ): { state: GameState; brawler: UnitInstance } {
    const brawler = realUnitInstance(YETI_BRAWLER);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[where === "bf1" ? 0 : 1]!.units = { p1: [brawler] };
    state.lastShowdownExcessDamage = excess;
    return { state, brawler };
  }

  const goldCount = (state: GameState, playerIndex: 0 | 1): number =>
    state.players[playerIndex]!.activeGear.filter((g) => g.defId === GOLD_TOKEN_DEF_ID).length;

  it("plays TWO Gold gear tokens, exhausted, through the real conquest funnel", () => {
    const { state } = board({ battlefieldId: "bf1", attackerIndex: 0, amount: 3 });
    expect(goldCount(state, 0), "the fixture already had gold — this test would pass vacuously").toBe(0);

    const after = resolveHeldTriggers(recordConquest(state, 0, "bf1"));
    expect(goldCount(after, 0), "the trigger never reached the resolver").toBe(2);
    expect(after.players[0]!.activeGear.every((g) => g.exhausted), "'play two Gold gear tokens EXHAUSTED'").toBe(true);
    expect(goldCount(after, 1), "the opponent was paid").toBe(0);
  });

  it("the threshold is >=, not > — exactly 3 pays and 2 does not", () => {
    const three = board({ battlefieldId: "bf1", attackerIndex: 0, amount: 3 });
    expect(goldCount(resolveHeldTriggers(recordConquest(three.state, 0, "bf1")), 0)).toBe(2);

    // NEGATIVE CONTROL: the same board one point of excess short.
    const two = board({ battlefieldId: "bf1", attackerIndex: 0, amount: 2 });
    expect(goldCount(resolveHeldTriggers(recordConquest(two.state, 0, "bf1")), 0)).toBe(0);
  });

  it("NEGATIVE CONTROL: a conquest that was not an attack pays nothing", () => {
    // Walking into an empty battlefield never writes the record, so there is no
    // number to borrow — the clause "you assigned excess damage" implies a fight.
    const { state } = board(null);
    expect(goldCount(resolveHeldTriggers(recordConquest(state, 0, "bf1")), 0)).toBe(0);
  });

  it("NEGATIVE CONTROL: another fight's excess cannot be borrowed", () => {
    // The record is from bf2 and the conquest is at bf1.
    const { state } = board({ battlefieldId: "bf2", attackerIndex: 0, amount: 9 });
    expect(goldCount(resolveHeldTriggers(recordConquest(state, 0, "bf1")), 0)).toBe(0);
  });

  it("NEGATIVE CONTROL: the excess the OPPONENT assigned is not 'you assigned'", () => {
    const { state } = board({ battlefieldId: "bf1", attackerIndex: 1, amount: 9 });
    expect(goldCount(resolveHeldTriggers(recordConquest(state, 0, "bf1")), 0)).toBe(0);
  });

  it("NEGATIVE CONTROL: 'when *I* conquer' is positional — a conquest at bf1 while he stands at bf2 pays nothing", () => {
    const { state } = board({ battlefieldId: "bf1", attackerIndex: 0, amount: 9 }, "bf2");
    expect(goldCount(resolveHeldTriggers(recordConquest(state, 0, "bf1")), 0)).toBe(0);
  });

  it("NEGATIVE CONTROL: the OPPONENT's conquest at his battlefield pays nothing", () => {
    const { state } = board({ battlefieldId: "bf1", attackerIndex: 1, amount: 9 });
    expect(goldCount(resolveHeldTriggers(recordConquest(state, 1, "bf1")), 0)).toBe(0);
    expect(goldCount(resolveHeldTriggers(recordConquest(state, 1, "bf1")), 1)).toBe(0);
  });

  it("is HELD — the trigger reaches the chain rather than resolving at the conquest", () => {
    const { state } = board({ battlefieldId: "bf1", attackerIndex: 0, amount: 5 });
    const held = recordConquest(state, 0, "bf1");
    expect(held.pendingTriggers.map((e) => e.listenerDefId)).toContain(YETI_BRAWLER);
    expect(goldCount(held, 0), "it resolved inline instead of waiting on the chain").toBe(0);
  });
});

describe("Blighted Battleaxe (UNL-019): at the end of your turn, if I didn't conquer, unattach and deal 4", () => {
  /**
   * The axe worn by a unit at bf1. The Might badge is +4 and the damage is 4, so
   * the wearer is printed big enough to survive both — a dead wearer would make
   * every assertion below read off a trash instead of a board.
   *
   * `attachedToInstanceId` is set directly rather than through `attachEquipment`,
   * which fires a held `equipmentAttached` event these fixtures do not want to
   * settle first.
   */
  function board(conqueredHere = false): { state: GameState; axe: GearInstance; wearer: UnitInstance } {
    const wearer = makeUnit({ instanceId: "wearer", might: 12 });
    const axe = { ...realGearInstance(BLIGHTED_BATTLEAXE), attachedToInstanceId: wearer.instanceId };
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0]!.units = { p1: [wearer] };
    state.players[0]!.activeGear = [axe];
    if (conqueredHere) state.players[0]!.conqueredBattlefieldsThisTurn = ["bf1"];
    return { state, axe, wearer };
  }

  const axeIn = (state: GameState, playerIndex: 0 | 1, instanceId: string): GearInstance | undefined =>
    state.players[playerIndex]!.activeGear.find((g) => g.instanceId === instanceId);

  it("unattaches itself and deals 4 to its wearer at the end of its controller's turn", () => {
    const { state, axe } = board();
    // POSITIVE CONTROL on the fixture: it really is attached and undamaged first,
    // so the two assertions below are measuring a change.
    expect(axeIn(state, 0, axe.instanceId)!.attachedToInstanceId).toBe("wearer");
    expect(unitAt(state, "wearer")!.damage).toBe(0);

    const after = resolveHeldTriggers(runEnd(state));

    expect(axeIn(after, 0, axe.instanceId)!.attachedToInstanceId, "'unattach this' never happened").toBeNull();
    expect(unitAt(after, "wearer")!.damage, "'deal 4 to me' never landed").toBe(4);
  });

  it("NEGATIVE CONTROL: a wearer that conquered this turn keeps the axe and takes nothing", () => {
    const { state, axe } = board(true);
    const after = resolveHeldTriggers(runEnd(state));

    expect(axeIn(after, 0, axe.instanceId)!.attachedToInstanceId, "it unattached from a conqueror").toBe("wearer");
    expect(unitAt(after, "wearer")!.damage).toBe(0);
  });

  it("NEGATIVE CONTROL: 'at the end of YOUR turn' — the opponent's turn ending does nothing", () => {
    const { state, axe } = board();
    const after = resolveHeldTriggers(runEnd({ ...state, activePlayerIndex: 1 }));

    expect(axeIn(after, 0, axe.instanceId)!.attachedToInstanceId).toBe("wearer");
    expect(unitAt(after, "wearer")!.damage).toBe(0);
  });

  it("NEGATIVE CONTROL: an UNATTACHED axe has no 'me' and fires nothing", () => {
    const { state, axe } = board();
    state.players[0]!.activeGear = [{ ...axe, attachedToInstanceId: null }];

    const held = runEnd(state);
    expect(held.pendingTriggers.map((e) => e.listenerDefId), "it triggered with nobody wearing it").not.toContain(
      BLIGHTED_BATTLEAXE,
    );
    expect(unitAt(resolveHeldTriggers(held), "wearer")!.damage).toBe(0);
  });

  it("the condition is read at the MOMENT, not at resolution — runEnd clears the conquest record in between", () => {
    // The trap this trigger is written around. `endOfTurn` is held and resolves in
    // the NEXT player's Action phase, by which time `conqueredBattlefieldsThisTurn`
    // has been cleared with the rest of the turn — so a `resolve` that re-asked
    // would read "didn't conquer" for every wearer, every turn, and this test is
    // what makes that visible.
    const { state } = board(true);
    const ended = runEnd(state);
    expect(ended.players[0]!.conqueredBattlefieldsThisTurn, "runEnd stopped clearing it — re-read this trigger").toEqual([]);
    expect(ended.pendingTriggers.map((e) => e.listenerDefId), "it triggered for a wearer that conquered").not.toContain(
      BLIGHTED_BATTLEAXE,
    );

    // POSITIVE CONTROL on the same instrument: without the conquest it IS held, so
    // the absence above is the condition working rather than the event never firing.
    expect(runEnd(board().state).pendingTriggers.map((e) => e.listenerDefId)).toContain(BLIGHTED_BATTLEAXE);
  });

  it("unattaches BEFORE dealing the 4 — printed order, and it decides lethality", () => {
    // The badge is +4 and the damage is 4, so a 4-Might wearer is at 8 while worn
    // and at 4 the instant it is detached. Detach-then-damage kills it;
    // damage-then-detach would leave it on 8 with 4 marked. 359.3.d executes a
    // card's instructions top to bottom.
    const { state } = board();
    const small = makeUnit({ instanceId: "wearer", might: 4 });
    state.battlefields[0]!.units = { p1: [small] };

    const after = resolveHeldTriggers(runEnd(state));
    expect(unitAt(after, "wearer"), "the wearer survived — the 4 was dealt while the badge was still on").toBeUndefined();
    expect(after.players[0]!.trash.some((c) => c.instanceId === "wearer")).toBe(true);
  });
});

describe("what this wave did and did not write", () => {
  /** The four refusals, each with the mechanism it is waiting on. Asserting the
   *  WRONG answer on purpose for the two that are genuinely unwritten: a card
   *  written against a mechanism that does not exist reports DONE and does
   *  nothing, and this is what makes the difference visible. */
  it.each([
    [YETI_BRAWLER, true],
    // **The stale row was deleted at integration and this flipped to true.**
    [BLIGHTED_BATTLEAXE, true],
    // Both HALF-written, and both now carry a PARTIALLY_IMPLEMENTED entry added
    // at integration — which is what turns these from `true` to `false`. Without
    // the entry each reported DONE on its first clause, which is the coverage LIE
    // this wave produced seven of.
    [SCORCHCLAW, false],
    [SQUARE_UP, false],
    // REFUSED — "if you've spent [4] or more to play a spell this turn". No
    // counter exists: PlayerState carries `powerSpentThisTurn` and nothing about
    // Energy spent on a spell, so nothing continuous can answer the condition.
    ["UNL-004", false],
    // REFUSED — "its controller may play this spell again for [rainbow]... 1
    // additional Bonus Damage for each time this spell has dealt damage this
    // turn". No mechanism plays a card out of the OTHER player's trash, and
    // nothing tallies one spell's damage instances.
    ["UNL-020", false],
  ])("%s reports implemented: %s", (defId, implemented) => {
    expect(isCardImplemented(registry.get(defId as string))).toBe(implemented);
  });

  it("Blighted Battleaxe carries NO partial note — its ability is written", () => {
    // **This was a pin asserting the row was stale, and it did its job.** The row
    // said "art-only: its end-of-turn unattach-and-deal-4 is unwritten"; the wave
    // wrote it, `coverage.ts` was a shared file the agent could not edit, and the
    // card under-reported as partial — the SAFE direction of wrong, and the quiet
    // one, because nobody chases a card that claims to be unfinished. It also kept
    // the card out of every generated deck, since `deck-generator` filters on
    // `isCardImplemented`.
    //
    // The row was deleted at integration and the pin's own message said to delete
    // the pin too. Kept and inverted instead: a note reappearing here would mean
    // somebody had re-added the row without checking the card, which is exactly
    // how it went stale the first time.
    expect(partialImplementationNote(registry.get(BLIGHTED_BATTLEAXE))).toBeUndefined();
  });

});

describe("Inferna (UNL-002): PIN — keyword-only, and [Ambush] is unimplemented", () => {
  it("still reports unimplemented, so nothing in this wave made her look finished", () => {
    // Her whole text is `[Ambush]` and `[Assault 2]`. The Assault works through the
    // keyword machinery; `[Ambush]` is a play PERMISSION ("you may play me as a
    // [Reaction] to a battlefield where you have units") and belongs beside
    // PLACEMENT_GRANTS in unit-triggers.ts and the timing tier in timing.ts —
    // neither of which a domain effect file may edit. Asserting the wrong answer
    // on purpose, so that landing [Ambush] fails here instead of changing quietly.
    const def = registry.get(INFERNA);
    expect(def.text).toContain("[Ambush]");
    expect(unimplementedKeywordsOn(def), "the keyword she parses and cannot use").toEqual(["Ambush"]);
    expect(isCardImplemented(def), "UNL-002 reports DONE — has [Ambush] landed?").toBe(false);
  });
});
