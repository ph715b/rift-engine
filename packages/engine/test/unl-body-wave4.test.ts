import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { attachEquipment } from "../src/engine/equipment.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import type { GameState, PendingDecision } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { Domain } from "../src/model/domain.js";
import { answerDecisions, makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * Wave 4's Body cards — three clauses written, five refused.
 *
 * Written: Poppy - Paragon (UNL-116) whole, Elder Dragon's (UNL-118) second
 * clause, Kha'Zix - Evolving Hunter's (UNL-119) second clause.
 *
 * Refused, each for a mechanism that lives outside effects/body.ts: Repulse
 * (UNL-106), Determined Sentry (UNL-111), Arachnoid Horror (UNL-117), Rengar -
 * Trophy Hunter (UNL-120), and Elder Dragon's FIRST clause. The last is PINNED at
 * the foot of this file, asserting the wrong answer so that closing it fails
 * loudly rather than silently changing a number nobody is watching.
 *
 * Every card here is driven through `submit`/`legalActions` or through the real
 * Cleanup that fires it, never by calling a resolver: a registered effect whose
 * choice is dropped on the dispatch hop reports IMPLEMENTED and does nothing in a
 * real game.
 *
 * **Every "nothing happened" assertion has a positive control beside it, in the
 * same test and off the same fixture.** A wave-3 mutation survived because a
 * fixture made a positional check unreachable — a 0 of 0, which reads exactly
 * like a pass.
 */

const registry = defaultCardRegistry();
const POPPY_PARAGON = "UNL-116";
const ELDER_DRAGON = "UNL-118";
const KHAZIX_EVOLVING_HUNTER = "UNL-119";
/** Filler for decks that must be non-empty — a Body spell with no listener of
 *  its own, so nothing it does can be mistaken for a card under test. */
const STARE_DOWN = "UNL-107";

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `action was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

const runes = (domain: Domain, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

const unitAnywhere = (state: GameState, instanceId: string) =>
  [
    ...state.players.flatMap((p) => p.baseUnits),
    ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
  ].find((u) => u.instanceId === instanceId);

const unitsAt = (state: GameState, battlefieldId: string, playerId: string) =>
  state.battlefields.find((b) => b.id === battlefieldId)!.units[playerId] ?? [];

const filler = (count: number) => Array.from({ length: count }, () => createCardInstance(registry.get(STARE_DOWN)));

/** The defIds of the triggered abilities waiting on the chain — the positive
 *  control that separates "correctly did nothing" from "never fired". Borrowed
 *  from attack-trigger-here-referent.test.ts, which needs it for the same reason. */
const heldTriggerDefIds = (state: GameState): string[] =>
  state.spellChain.flatMap((e) => ("kind" in e && e.kind === "trigger" ? [(e as { listenerDefId: string }).listenerDefId] : []));

describe("Poppy - Paragon (UNL-116): ready me and gain 3 XP while an opponent is close to winning", () => {
  /**
   * Poppy in hand with her 5 Energy sitting in the pool, and the opponent on
   * `opponentPoints` of the 8-point Victory Score. "Within 3" is INCLUSIVE, so 5
   * is the first score that turns her on and 4 is the last that does not.
   */
  function armed(opponentPoints: number): { state: GameState; poppyId: string } {
    const poppy = realUnitInstance(POPPY_PARAGON);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [poppy];
    state.players[0]!.floatingEnergy = 5;
    state.players[1]!.points = opponentPoints;
    return { state, poppyId: poppy.instanceId };
  }

  const play = (state: GameState, poppyId: string) =>
    answerDecisions(resolveHeldTriggers(accept(state, playsOf(state, poppyId)[0]!)));

  it("readies herself and banks 3 XP when the opponent is 3 points from victory", () => {
    const { state, poppyId } = armed(5);
    const after = play(state, poppyId);

    const poppy = unitAnywhere(after, poppyId);
    expect(poppy, "Poppy never entered play at all").toBeDefined();
    // 143.4.a enters her exhausted; "ready me" is what undoes it, so an exhausted
    // Poppy here means the trigger never landed.
    expect(poppy!.exhausted, "she was not readied").toBe(false);
    expect(after.players[0]!.xp, "the 3 XP never landed").toBe(3);
  });

  it("does NOTHING at 4 points, and the 5-point run beside it proves the check ran", () => {
    const behind = armed(4);
    const off = play(behind.state, behind.poppyId);
    expect(unitAnywhere(off, behind.poppyId)!.exhausted, "she readied herself from behind").toBe(true);
    expect(off.players[0]!.xp, "she banked XP from behind").toBe(0);

    // The positive control, off the identical fixture with one number changed —
    // without it, both zeroes above would also be what an inert card looks like.
    const close = armed(5);
    const on = play(close.state, close.poppyId);
    expect(unitAnywhere(on, close.poppyId)!.exhausted, "she did not ready at 5 either — the zeroes prove nothing").toBe(false);
    expect(on.players[0]!.xp).toBe(3);
  });

  it("reads the OPPONENT's score, not her own", () => {
    // Both clauses of `opponentNearVictory` in one test: her controller sitting on
    // 7 is not the trigger, and the same board with the points on the other seat
    // is. Measuring the wrong side inverts the card, which is exactly the mistake
    // constants.ts keeps `selfNearVictory` separate to prevent.
    const mine = armed(0);
    mine.state.players[0]!.points = 7;
    const wrongSide = play(mine.state, mine.poppyId);
    expect(wrongSide.players[0]!.xp, "her own score paid the trigger").toBe(0);

    const theirs = armed(7);
    expect(play(theirs.state, theirs.poppyId).players[0]!.xp, "the opponent's 7 did nothing — the zero above proves nothing").toBe(3);
  });
});

describe("Elder Dragon (UNL-118): choose up to one enemy unit at each location, deal 1", () => {
  /**
   * The Dragon in hand at his printed 12 Energy + 4 Body, and an enemy body at
   * every one of the three locations that can hold one: bf1, bf2 and the enemy
   * base. A FRIENDLY unit stands at bf1 too, so "enemy" has something to exclude.
   *
   * Every enemy has 4 Might, which is deliberate on both sides of the card: 1
   * damage never kills one (so a death cannot be mistaken for the strike landing,
   * and the refused first clause has something to fail against), and they are all
   * identical so nothing but the choice distinguishes them.
   */
  function armed(): { state: GameState; dragonId: string } {
    const dragon = realUnitInstance(ELDER_DRAGON);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [dragon];
    state.players[0]!.floatingEnergy = 12;
    state.players[0]!.channeled = runes("Body", 4);
    state.battlefields[0]!.units = {
      p1: [makeUnit({ name: "Ally", instanceId: "ally", might: 4 })],
      p2: [makeUnit({ name: "AtBf1", instanceId: "at-bf1", might: 4 })],
    };
    state.battlefields[1]!.units = { p2: [makeUnit({ name: "AtBf2", instanceId: "at-bf2", might: 4 })] };
    state.players[1]!.baseUnits = [makeUnit({ name: "AtBase", instanceId: "at-base", might: 4 })];
    return { state, dragonId: dragon.instanceId };
  }

  /** Plays him to base and answers each location's question with `pick`, which
   *  sees the question's own `battlefieldId` (absent = the enemy base). */
  const play = (
    state: GameState,
    dragonId: string,
    pick: (options: { id: string; instanceId?: string }[], d: PendingDecision) => string,
  ) => answerDecisions(resolveHeldTriggers(accept(state, playsOf(state, dragonId).find((p) => p.destinationBattlefieldId === undefined)!)), pick);

  const damageOf = (state: GameState, instanceId: string) => unitAnywhere(state, instanceId)?.damage;

  it("hits one enemy at EVERY location, including the enemy base", () => {
    const { state, dragonId } = armed();
    const after = play(state, dragonId, (options) => options.find((o) => o.id !== "decline")!.id);

    expect(damageOf(after, "at-bf1"), "the battlefield-1 enemy took nothing").toBe(1);
    expect(damageOf(after, "at-bf2"), "the battlefield-2 enemy took nothing").toBe(1);
    // 198.1's Bases-are-Locations half. Without it this is a two-battlefield card.
    expect(damageOf(after, "at-base"), "the enemy BASE was never swept").toBe(1);
  });

  it("never offers a FRIENDLY unit, and the enemy beside it proves the list was built", () => {
    const { state, dragonId } = armed();
    const named: string[] = [];
    play(state, dragonId, (options) => {
      named.push(...options.map((o) => o.instanceId ?? o.id));
      return options.find((o) => o.id !== "decline")!.id;
    });

    expect(named, "the Dragon offered his own side").not.toContain("ally");
    expect(named, "no enemy was offered either — the exclusion above proves nothing").toContain("at-bf1");
  });

  it("is 'UP TO one' — declining at one location leaves the others alone", () => {
    const { state, dragonId } = armed();
    const after = play(state, dragonId, (options, d) =>
      d.battlefieldId === "bf1" ? "decline" : options.find((o) => o.id !== "decline")!.id,
    );

    expect(damageOf(after, "at-bf1"), "declining still dealt damage").toBe(0);
    // The two positive halves: declining ONE location must not end the sweep, which
    // is exactly what a `repeatDecision`-style continuation would have done.
    expect(damageOf(after, "at-bf2"), "declining at bf1 cancelled the rest of the sweep").toBe(1);
    expect(damageOf(after, "at-base"), "declining at bf1 cancelled the rest of the sweep").toBe(1);
  });

  it("takes only ONE unit per location, however many stand there", () => {
    const { state, dragonId } = armed();
    state.battlefields[0]!.units = {
      ...state.battlefields[0]!.units,
      p2: [
        makeUnit({ name: "First", instanceId: "first", might: 4 }),
        makeUnit({ name: "Second", instanceId: "second", might: 4 }),
      ],
    };

    const after = play(state, dragonId, (options) => options.find((o) => o.id !== "decline")!.id);

    const hit = ["first", "second"].filter((id) => damageOf(after, id) === 1);
    expect(hit, "the sweep hit both bodies at one location").toHaveLength(1);
    // ...and it did fire at all, which "exactly one of two" would also read like if
    // the whole question had been dropped and something else damaged a unit.
    expect(damageOf(after, "at-bf2"), "nothing fired anywhere").toBe(1);
  });

  it("asks nothing at a location with no enemy on it", () => {
    // The narrowing in `elderDragonLocations`. With the enemy base empty the sweep
    // must be two questions, not three — measured by counting the questions asked
    // rather than by looking at damage, which cannot tell an empty question from a
    // declined one.
    const { state, dragonId } = armed();
    state.players[1]!.baseUnits = [];

    const asked: (string | undefined)[] = [];
    play(state, dragonId, (options, d) => {
      asked.push(d.battlefieldId);
      return options.find((o) => o.id !== "decline")!.id;
    });

    expect(asked, "the empty enemy base was still asked about").toEqual(["bf1", "bf2"]);
  });
});

describe("Kha'Zix - Evolving Hunter (UNL-119): spend 3 XP on attack to strike for my Might", () => {
  /**
   * Kha'Zix in p1's base with `xp` banked, an enemy holding bf1, and a second
   * enemy at bf2 he is not fighting at. Combat is opened by a REAL `MoveUnit`
   * submit — that is what applies Contested (450), which is what makes him the
   * Attacker (464.2.c) and what stages the Showdown in the next Cleanup.
   */
  function armed(xp: number): { state: GameState; khazixId: string } {
    const khazix = realUnitInstance(KHAZIX_EVOLVING_HUNTER);
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [khazix];
    state.players[0]!.xp = xp;
    state.players[0]!.deck = filler(3);
    state.battlefields[0]!.controllerId = "p2";
    state.battlefields[0]!.units = { p2: [makeUnit({ name: "Holder", instanceId: "holder", might: 9 })] };
    state.battlefields[1]!.units = { p2: [makeUnit({ name: "Elsewhere", instanceId: "elsewhere", might: 9 })] };
    return { state, khazixId: khazix.instanceId };
  }

  /** Walks him into bf1 through the real action, stopping at his question. */
  const attack = (state: GameState, khazixId: string) => {
    const move = legalActions(state).find(
      (a) => a.type === "MoveUnit" && a.unitInstanceIds.length === 1 && a.unitInstanceIds[0] === khazixId && a.destinationBattlefieldId === "bf1",
    );
    expect(move, "Kha'Zix was never offered the move that starts the fight").toBeDefined();
    return resolveHeldTriggers(accept(state, move!));
  };

  const damageOf = (state: GameState, instanceId: string) => unitAnywhere(state, instanceId)?.damage;

  it("spends 3 XP and deals its Might to a chosen enemy at the battlefield it attacked", () => {
    const { state, khazixId } = armed(5);
    const attacking = attack(state, khazixId);

    const question = pendingDecision(attacking);
    expect(question?.kind, "no question was raised when he attacked").toBe("UNL-119-pounce");

    const after = answerDecisions(attacking, (options) => options.find((o) => o.instanceId === "holder")!.id);

    expect(after.players[0]!.xp, "the 3 XP was not spent").toBe(2);
    // His printed Might is 5, read where he now stands.
    expect(damageOf(after, "holder"), "the strike dealt nothing").toBe(5);
    expect(damageOf(after, "elsewhere"), "he hit a unit at another battlefield").toBe(0);
  });

  it("offers only enemies at the battlefield he is attacking — 'HERE'", () => {
    const { state, khazixId } = armed(5);
    const attacking = attack(state, khazixId);
    const offered = optionsFor(attacking, pendingDecision(attacking)!).map((o) => o.instanceId ?? o.id);

    expect(offered, "a unit at another battlefield was on offer").not.toContain("elsewhere");
    expect(offered, "nothing at all was on offer — the exclusion above proves nothing").toContain("holder");
  });

  it("declining costs no XP and deals no damage", () => {
    const { state, khazixId } = armed(5);
    const declined = answerDecisions(attack(state, khazixId), () => "decline");

    expect(declined.players[0]!.xp, "declining still spent the XP").toBe(5);
    expect(damageOf(declined, "holder"), "declining still dealt the damage").toBe(0);
  });

  it("does NOT fire when he DEFENDS, and the attacking run proves the check ran", () => {
    // He holds bf1 and the OPPONENT walks in, so `contestedByIndex` is 1 and
    // `isAttackingAt` must say no. The Pending Item is what is asserted, not the
    // damage: "no damage" reads identically for "defended" and "never triggered".
    const { state, khazixId } = armed(5);
    state.battlefields[0]!.controllerId = "p1";
    state.battlefields[0]!.units = { p1: [unitAnywhere(state, khazixId)!], p2: [] };
    state.players[0]!.baseUnits = [];
    state.players[1]!.baseUnits = [makeUnit({ name: "Raider", instanceId: "raider", might: 9 })];

    const defended = resolveHeldTriggers(
      runCleanup({ ...state, activePlayerIndex: 1, focusHolder: 1, chainPriority: 1 }),
    );
    // The fixture has to actually stage the fight, or this is a 0 of 0.
    const opened = resolveHeldTriggers(
      runCleanup({
        ...defended,
        battlefields: defended.battlefields.map((bf) =>
          bf.id === "bf1" ? { ...bf, units: { ...bf.units, p2: [makeUnit({ name: "Raider", instanceId: "raider", might: 9 })] }, contestedByIndex: 1 as 0 | 1 } : bf,
        ),
      }),
    );
    expect(opened.showdownBattlefieldId, "no Showdown was staged — nothing was asked of him either way").toBe("bf1");
    expect(pendingDecision(opened), "he pounced while DEFENDING").toBeUndefined();
    expect(heldTriggerDefIds(opened), "his trigger was placed on the chain while defending").not.toContain(KHAZIX_EVOLVING_HUNTER);

    // The positive control: the same unit, attacking, does raise it.
    const { state: attackerState, khazixId: attackerId } = armed(5);
    expect(
      pendingDecision(attack(attackerState, attackerId))?.kind,
      "he does not fire on ATTACK either — the silence above proves nothing",
    ).toBe("UNL-119-pounce");
  });

  it("is not offered below 3 XP, and IS at exactly 3", () => {
    for (const xp of [0, 1, 2] as const) {
      const { state, khazixId } = armed(xp);
      const attacking = attack(state, khazixId);
      expect(pendingDecision(attacking), `a question was raised at ${xp} XP, which cannot pay 3`).toBeUndefined();
    }
    const { state, khazixId } = armed(3);
    const after = answerDecisions(attack(state, khazixId), (options) => options.find((o) => o.instanceId === "holder")!.id);
    expect(after.players[0]!.xp, "exactly 3 XP could not pay — the silences above prove nothing").toBe(0);
    expect(damageOf(after, "holder")).toBe(5);
  });

  it("reads his Might AFTER the 3 XP has gone — 383.3.b makes it the ability's base cost", () => {
    // The one board where the ORDER of cost and measurement is observable, and it
    // exists in this pool: Soul Sword (UNL-039) is `[Level 3] +1 Might` on its
    // wearer, read off `PlayerState.xp` every evaluation, so a controller sitting
    // exactly on 3 falls off the band the instant Kha'Zix's cost is taken.
    //
    // 383.3.b makes the cost the triggered ability's BASE cost and 383.3.b.1 has it
    // paid to finalize the ability — so it is gone long before the effect reads
    // anything.
    //
    // The Sword also carries a printed +1 BADGE that has nothing to do with XP, so
    // the two readings are 7 (band still on) against 6 (band gone), not 6 against
    // 5. That the badge survives the payment is itself part of the check: only the
    // XP-dependent half may move.
    const withSword = (xp: number) => {
      const { state, khazixId } = armed(xp);
      const sword = createCardInstance(registry.get("UNL-039"));
      state.players[0]!.activeGear = [sword as never];
      const attached = attachEquipment(state, 0, sword.instanceId, khazixId);
      return answerDecisions(attack(attached, khazixId), (options) => options.find((o) => o.instanceId === "holder")!.id);
    };

    // Positive control FIRST: at 6 XP he stays above the band after paying, so the
    // sword is really granting its +1 and the fixture is wired up.
    expect(damageOf(withSword(6), "holder"), "Soul Sword's [Level 3] band granted nothing — this test measures nothing").toBe(7);
    expect(damageOf(withSword(3), "holder"), "the Might was read BEFORE the cost was paid").toBe(6);
  });

  it("mistargets when he leaves the fight in the response window — 359.3.f", () => {
    // The rulebook's Yasuo - Remorseful example, on this card. The trigger FIRED
    // (383 fixes that), and "here" then has nothing to point at, so the
    // instruction is ignored rather than re-aimed. Asserted through the chain,
    // because "no damage" is also what a dead trigger looks like.
    const { state, khazixId } = armed(5);
    const staged = runCleanup({
      ...state,
      battlefields: state.battlefields.map((bf) => (bf.id === "bf1" ? { ...bf, units: { ...bf.units, p1: [unitAnywhere(state, khazixId)!] }, contestedByIndex: 0 as 0 | 1 } : bf)),
      players: [{ ...state.players[0]!, baseUnits: [] }, state.players[1]!] as GameState["players"],
    });
    expect(heldTriggerDefIds(staged), "his trigger never reached the chain — this test measures nothing").toContain(
      KHAZIX_EVOLVING_HUNTER,
    );

    // The reaction: he goes home before the trigger resolves.
    const walkedOut: GameState = {
      ...staged,
      battlefields: staged.battlefields.map((bf) => (bf.id === "bf1" ? { ...bf, units: { ...bf.units, p1: [] } } : bf)),
      players: [{ ...staged.players[0]!, baseUnits: [unitAnywhere(staged, khazixId)!] }, staged.players[1]!] as GameState["players"],
    };
    const resolved = resolveHeldTriggers(walkedOut);
    // No question is left standing for a player to answer. **This does NOT
    // distinguish the trigger's `isStillHere` from `khazixStrike`'s** and the
    // comment says so rather than claiming a protection it does not test: the two
    // checks are redundant by construction, and with the trigger's deleted the
    // question is parked, finds only Decline, and is drained by `advanceDecisions`
    // before anyone sees it. Measured by mutation — deleting the trigger's check
    // leaves all 17 tests green, and no assertion can tell the two states apart
    // because they are the same state.
    expect(pendingDecision(resolved), "a question was left outstanding with no 'here' to point at").toBeUndefined();

    const after = answerDecisions(resolved);
    expect(after.players[0]!.xp, "he paid for a strike that had nowhere to land").toBe(5);
    expect(damageOf(after, "holder"), "the strike landed from off the battlefield").toBe(0);
  });
});

describe("the Body clauses this wave REFUSED, and the two timing divergences", () => {
  it("Poppy reads the score at RESOLUTION, not when she was played — 383.2.a.1", () => {
    // **PIN, asserting the wrong answer.** Her "if" sits immediately after "when
    // you play me", so 383.2.a.1 makes it part of the TRIGGER CONDITION: it is
    // checked as she is played and, per the rule's Sona example, is not re-checked
    // when the held item resolves. `UnitTriggerDefinition` carries no `applies`, so
    // the engine can only read it at resolution.
    //
    // Below: the opponent is on 4 (she should not trigger) and reaches 5 in the
    // response window, and she pays out anyway. Closing the gap — an `applies` on
    // the unit-trigger seam, in unit-triggers.ts — makes this fail loudly.
    const poppy = realUnitInstance(POPPY_PARAGON);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [poppy];
    state.players[0]!.floatingEnergy = 5;
    state.players[1]!.points = 4;

    const played = accept(state, playsOf(state, poppy.instanceId)[0]!);
    // The premise: her trigger really is still waiting, so what follows is a
    // response window and not a play that already finished.
    expect(heldTriggerDefIds(played), "her trigger was not on the chain — there is no window to measure").toContain(
      POPPY_PARAGON,
    );

    const scored: GameState = {
      ...played,
      players: [played.players[0]!, { ...played.players[1]!, points: 5 }] as GameState["players"],
    };
    const after = answerDecisions(resolveHeldTriggers(scored));

    expect(
      after.players[0]!.xp,
      "the condition is now read when she was PLAYED (383.2.a.1) — delete this pin and the divergence row",
    ).toBe(3);
  });

  it("Kha'Zix can pay with XP he did not have when the trigger fired — 383.3.b.1", () => {
    // **PIN, asserting the wrong answer.** 383.3.b makes "spend 3 XP" the base cost
    // of the triggered ability and 383.3.b.1 requires it paid to FINALIZE the
    // ability onto the chain — so a Kha'Zix who attacks with 0 XP should never have
    // an ability to resolve. Here the question is asked at resolution, so XP that
    // arrives in the response window pays for it.
    //
    // Blood Rose (UNL-109) prints the identical shape and gates her offer in
    // `applies` instead, which happens to close THIS hole and opens the mirror one
    // (XP gained in the window is unusable). Neither is the rule; the rule needs a
    // cost hook at `cleanup.finalizePendingTriggers`.
    const khazix = realUnitInstance(KHAZIX_EVOLVING_HUNTER);
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [khazix];
    state.players[0]!.xp = 0;
    state.battlefields[0]!.controllerId = "p2";
    state.battlefields[0]!.units = { p2: [makeUnit({ name: "Holder", instanceId: "holder", might: 9 })] };

    const staged = runCleanup({
      ...state,
      battlefields: state.battlefields.map((bf) =>
        bf.id === "bf1" ? { ...bf, units: { ...bf.units, p1: [khazix] }, contestedByIndex: 0 as 0 | 1 } : bf,
      ),
      players: [{ ...state.players[0]!, baseUnits: [] }, state.players[1]!] as GameState["players"],
    });
    expect(heldTriggerDefIds(staged), "his trigger never reached the chain — there is no window to measure").toContain(
      KHAZIX_EVOLVING_HUNTER,
    );

    const funded: GameState = {
      ...staged,
      players: [{ ...staged.players[0]!, xp: 3 }, staged.players[1]!] as GameState["players"],
    };
    const after = answerDecisions(resolveHeldTriggers(funded), (options) => options.find((o) => o.instanceId === "holder")!.id);

    expect(
      unitAnywhere(after, "holder")?.damage,
      "the cost is now taken at finalization (383.3.b.1) — delete this pin and the divergence row",
    ).toBe(5);
    expect(after.players[0]!.xp).toBe(0);
  });

  it("Elder Dragon's 1 damage does NOT kill a bigger enemy — his passive is unwritten", () => {
    // **PIN.** "Any amount of your damage is enough to kill enemy units" is 142.4.c
    // by name, and it needs two things outside effects/body.ts: per-marker damage
    // (142.3.a — `UnitInstance.damage` is one unattributed number, model/card.ts)
    // and a Lethal Damage override at `effect-helpers.dealDamage`'s inline
    // `effectiveMight - damage <= 0`.
    //
    // Asserts the WRONG answer on purpose: with the clause written, the 4-Might
    // body below dies to the Dragon's own 1 damage and this test fails loudly
    // instead of the gap being closed silently.
    const dragon = realUnitInstance(ELDER_DRAGON);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [dragon];
    state.players[0]!.floatingEnergy = 12;
    state.players[0]!.channeled = runes("Body", 4);
    state.battlefields[0]!.units = { p2: [makeUnit({ name: "Survivor", instanceId: "survivor", might: 4 })] };

    const after = answerDecisions(
      resolveHeldTriggers(accept(state, playsOf(state, dragon.instanceId).find((p) => p.destinationBattlefieldId === undefined)!)),
      (options) => options.find((o) => o.instanceId === "survivor")!.id,
    );

    // The positive half first: the damage was really dealt, so the survival below
    // is about lethality rather than about a strike that never happened.
    expect(unitAnywhere(after, "survivor")?.damage, "the Dragon's strike never landed").toBe(1);
    expect(
      unitsAt(after, "bf1", "p2").map((u) => u.instanceId),
      "the enemy DIED to 1 damage — Elder Dragon's passive is implemented, so delete this pin",
    ).toEqual(["survivor"]);
  });

  it("Rengar - Trophy Hunter still cannot be played to a battlefield he does not hold", () => {
    // **PIN.** "I can be played to a battlefield where there are enemy units (even
    // if you don't have units there)" is byte-identical to Deadbloom Predator's
    // and Dauntless Vanguard's grant, and is ONE row in
    // `unit-triggers.PLACEMENT_GRANTS` (`"UNL-120": "occupiedEnemyBattlefield"`) —
    // a shared file this wave does not own.
    const rengar = realUnitInstance("UNL-120");
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [rengar];
    state.players[0]!.floatingEnergy = 12;
    state.players[0]!.channeled = runes("Body", 4);
    state.battlefields[0]!.units = { p2: [makeUnit({ name: "Trophy", instanceId: "trophy", might: 4 })] };

    const destinations = playsOf(state, rengar.instanceId).map((p) => p.destinationBattlefieldId);
    // The positive control: he IS playable, just only to base — so an empty list
    // here would mean the fixture cannot afford him rather than that the grant is
    // missing.
    expect(destinations, "he is not playable at all — this pin measures nothing").toContain(undefined);
    expect(destinations, "the occupied-enemy grant landed, so delete this pin").not.toContain("bf1");
  });
});
