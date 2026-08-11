import { describe, expect, it } from "vitest";
import { runCleanup } from "../src/engine/cleanup.js";
import { runBeginning } from "../src/engine/turn-manager.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { hasKeyword } from "../src/engine/granted-keywords.js";
import { pendingDecision, optionsFor } from "../src/engine/decisions.js";
import { eventTriggerFor } from "../src/engine/triggers.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { answerDecisions, makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * Unleashed's FIFTH Calm wave — engine/effects/calm.ts.
 *
 * Two of the five cards in this wave are written; three are refused outright and
 * one of the two is HALF written. Every refusal is one line in a file this pass
 * does not own, and the gaps that are REACHABLE IN PLAY are pinned below with a
 * test asserting the wrong answer, so closing one fails here rather than
 * silently changing behaviour nobody is watching.
 *
 * The discipline is wave 4's: drive the real path (a Cleanup that stages the
 * Showdown and HOLDS the triggers, a `runBeginning` that really scores a hold,
 * `answerDecisions` for what the card asks), because a resolver called directly
 * passes whether or not the dispatch hop that reaches it in a game carries what
 * it needs.
 *
 * **Every negative asserts its own positive first.** "Nothing happened" is
 * exactly what an inert card looks like — a hold that never happened and a
 * trigger that never fired read identically at the end state — so each negative
 * here first proves the fixture COULD have fired.
 */

const registry = defaultCardRegistry();

/** `registry.get` returns the `CardDefinition` UNION, and `might` / `keywords`
 *  live only on `UnitDefinition`. Narrow through this rather than through
 *  `def.type === "Unit" && def.might`, which yields `false` for a non-Unit and
 *  reports a type mistake as a wrong Might. */
function unitDef(defId: string) {
  const def = registry.get(defId);
  if (def.type !== "Unit") throw new Error(`${defId} is not a Unit definition`);
  return def;
}

const YUUMI = "UNL-056"; // when I attack or defend, give one of your OTHER units HERE +3 Might and [Tank] this turn
const ALPHA_WILDCLAW = "UNL-057"; // REFUSED — your units here with less Might than me can't be chosen by enemy spells
const LILLIA_PROTECTOR = "UNL-058"; // REFUSED — token-unit play trigger + "your token units have [Tank]"
const MASTER_YI_UNSTOPPABLE = "UNL-059"; // REFUSED — [Level] cost reductions + [Level 16] unchooseable
const VILEMAW = "UNL-060"; // when I hold, draw 1 (written); enemy units here with less Might deal no combat damage (refused)

const YUUMI_BUFF = 3;

/** p1's `mine` standing at bf1 against p2's `theirs`, with bf1 already Contested
 *  by `attackerIndex` — so the next Cleanup stages a COMBAT Showdown and
 *  464.2.c.3 hands out the Attacker and Defender designations for real. This is
 *  never a hand-built `combatBegan`: that would bypass `isFightingAt` entirely
 *  and assert nothing about the card. */
function contested(mine: UnitInstance[], theirs: UnitInstance[], attackerIndex: 0 | 1 = 0): GameState {
  const state = makeState({ phase: "Action" });
  state.battlefields[0]!.units = { p1: mine, p2: theirs };
  // Control sits with whoever is NOT contesting — a battlefield its contester
  // already controls stages nothing. Pinned explicitly rather than left null,
  // because `lapseUnoccupiedControl` can otherwise move it mid-run.
  state.battlefields[0]!.controllerId = attackerIndex === 0 ? "p2" : "p1";
  state.battlefields[0]!.contestedByIndex = attackerIndex;
  // A second, uncontested battlefield to walk out into. Without one, a "did not
  // fire" assertion could pass on an off-the-board branch and never notice a
  // resolver that re-aimed "here" at wherever the source went.
  state.battlefields[1]!.units = { p1: [], p2: [] };
  return state;
}

/** Player 0 in their Beginning Phase, alone at bf1 with `units` — what
 *  `scoring.isHeldBy` reads as a hold: presence, control, and no opponent. */
function holdingBf1(units: UnitInstance[]): GameState {
  const state = makeState({ phase: "Beginning", activePlayerIndex: 0 });
  state.battlefields[0]!.units = { p1: units };
  state.battlefields[0]!.controllerId = "p1";
  return state;
}

/** The defIds of the triggered abilities waiting on the chain — the positive
 *  control every "and then it did nothing" assertion in this file needs, since
 *  "correctly mistargeted" and "never fired" are indistinguishable at the end
 *  state. Asserted BEFORE `resolveHeldTriggers` drains the chain. */
const heldTriggerDefIds = (state: GameState): string[] =>
  state.spellChain.flatMap((e) => ("kind" in e && e.kind === "trigger" ? [(e as { listenerDefId: string }).listenerDefId] : []));

const everyUnit = (state: GameState): UnitInstance[] => [
  ...state.players[0]!.baseUnits,
  ...state.players[1]!.baseUnits,
  ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
];

const find = (state: GameState, instanceId: string): UnitInstance | undefined =>
  everyUnit(state).find((u) => u.instanceId === instanceId);

/** Did the buff LAND on this unit — both halves of Yuumi's one sentence? Asked
 *  as one predicate so a test cannot assert the Might and quietly skip the
 *  keyword, which is the half that has no number to look wrong. */
function buffed(state: GameState, instanceId: string): { might: number; tank: boolean } {
  const unit = find(state, instanceId);
  // A unit that is off the board received nothing, which is the right answer for
  // the two response-window tests rather than a crash.
  if (!unit) return { might: 0, tank: false };
  // `hasKeyword` is what `combat.assignmentOrder` itself reads, so a [Tank] this
  // asserts is a [Tank] the damage step will honour — `keywordsThisTurn` would
  // be the storage rather than the reading. Owner is p1 for every unit this
  // helper is asked about.
  return { might: unit.mightThisTurn, tank: hasKeyword(state, unit, 0, "Tank") };
}

// ---------------------------------------------------------------------------

describe("Yuumi - Magical Cat (UNL-056): when I attack or defend, buff another of your units here", () => {
  const yuumi = () => realUnitInstance(YUUMI);
  const ally = (name = "Ally") => makeUnit({ name, might: 3 });
  /** Big enough that nothing here dies to the combat that is being staged. */
  const wall = () => makeUnit({ name: "Wall", might: 20 });

  it("fires on an ATTACK and lands +3 Might AND [Tank] on the one other unit here", () => {
    const cat = yuumi();
    const friend = ally();
    const staged = runCleanup(contested([cat, friend], [wall()]));
    expect(heldTriggerDefIds(staged), "the trigger was never placed on the chain").toContain(YUUMI);

    const settled = resolveHeldTriggers(staged);

    // ONE candidate, so `advanceDecisions` executes it without asking — that is
    // the engine's rule for a question with a single answer, and it means the
    // buff has already landed here rather than waiting on a prompt.
    expect(pendingDecision(settled), "a one-answer question should never be asked").toBeUndefined();
    expect(buffed(settled, friend.instanceId)).toEqual({ might: YUUMI_BUFF, tank: true });
  });

  it("fires on a DEFEND too — 383.4.f is a second rule, not the same one", () => {
    // p2 contests, so p1's units gain the DEFENDER designation. A card written
    // against `isAttackingAt` alone passes every test above and fails this one.
    const cat = yuumi();
    const friend = ally();
    const staged = runCleanup(contested([cat, friend], [wall()], 1));
    expect(heldTriggerDefIds(staged), "the defend trigger was never placed").toContain(YUUMI);

    const settled = resolveHeldTriggers(staged);
    expect(buffed(settled, friend.instanceId)).toEqual({ might: YUUMI_BUFF, tank: true });
  });

  it("never buffs HERSELF — 'one of your OTHER units'", () => {
    const cat = yuumi();
    const friend = ally();
    const settled = resolveHeldTriggers(runCleanup(contested([cat, friend], [wall()])));

    expect(buffed(settled, cat.instanceId), "she buffed herself").toEqual({ might: 0, tank: true });
    // ...and the [Tank] above is her PRINTED one, which is why the positive
    // control matters: the friend really was buffed on the same board.
    expect(buffed(settled, friend.instanceId).might, "nothing fired at all — this negative proves nothing").toBe(YUUMI_BUFF);
  });

  it("offers a real choice between two friends, and buffs only the one chosen", () => {
    const cat = yuumi();
    const first = ally("First Friend");
    const second = ally("Second Friend");
    const settled = resolveHeldTriggers(runCleanup(contested([cat, first, second], [wall()])));

    const decision = pendingDecision(settled);
    expect(decision?.kind, "two candidates and no question was asked").toBe("UNL-056-buff");
    expect(optionsFor(settled, decision!).map((o) => o.label).sort()).toEqual(["First Friend", "Second Friend"]);
    // No "Decline" — the card prints no "you may", so once it has triggered the
    // buff has to land somewhere.
    expect(optionsFor(settled, decision!).some((o) => o.id === "decline"), "a mandatory buff offered a decline").toBe(false);

    // Explicitly the SECOND, because `answerDecisions`' default takes the first
    // option and would make this test pass on a resolver that ignored the answer.
    const answered = answerDecisions(settled, (options) => options.find((o) => o.label === "Second Friend")!.id);
    expect(buffed(answered, second.instanceId)).toEqual({ might: YUUMI_BUFF, tank: true });
    expect(buffed(answered, first.instanceId), "it buffed the unit that was not chosen").toEqual({ might: 0, tank: false });
  });

  it("reaches nobody in BASE or at another battlefield — 'HERE' is printed", () => {
    const cat = yuumi();
    const homebody = ally("Homebody");
    const elsewhere = ally("Elsewhere");
    const state = contested([cat], [wall()]);
    state.players[0]!.baseUnits = [homebody];
    state.battlefields[1]!.units = { p1: [elsewhere], p2: [] };

    const staged = runCleanup(state);
    // The POSITIVE half of this negative: the ability really did trigger. Without
    // this the whole test passes on a Yuumi that does nothing at all.
    expect(heldTriggerDefIds(staged), "the trigger was never placed").toContain(YUUMI);

    const settled = resolveHeldTriggers(staged);
    expect(pendingDecision(settled), "an out-of-reach unit was offered the buff").toBeUndefined();
    expect(buffed(settled, homebody.instanceId), "it reached into base").toEqual({ might: 0, tank: false });
    expect(buffed(settled, elsewhere.instanceId), "it reached another battlefield").toEqual({ might: 0, tank: false });
  });

  it("triggers with nobody to buff, and the instruction is simply ignored (359.3.e.6)", () => {
    // Attacking alone. The ability's condition is "when I attack or defend" and
    // nothing else, so the Pending Item IS placed — putting the emptiness test in
    // `applies` would be 383.4.e.2.b's "other requirements besides attacking",
    // which this card does not print.
    const cat = yuumi();
    const staged = runCleanup(contested([cat], [wall()]));
    expect(heldTriggerDefIds(staged), "the trigger did not fire for a lone attacker").toContain(YUUMI);

    const settled = resolveHeldTriggers(staged);
    expect(pendingDecision(settled), "it asked a question with no answers").toBeUndefined();
    expect(buffed(settled, cat.instanceId).might, "it fell back to buffing herself").toBe(0);
  });

  it("mistargets when Yuumi leaves the fight during the response window (359.3.f.2)", () => {
    // The rules' worked example, applied to her: an opponent answers the trigger
    // by moving its source, and "'here' is no longer the battlefield where combat
    // is ongoing and the attack trigger mistargets". Held first, board edited
    // second, chain popped third — `resolveHeldTriggers` in one call would leave
    // nowhere to stand in for the opponent.
    const cat = yuumi();
    const friend = ally();
    const staged = runCleanup(contested([cat, friend], [wall()]));
    expect(heldTriggerDefIds(staged), "the trigger was never placed").toContain(YUUMI);

    const walkedOut: GameState = {
      ...staged,
      battlefields: staged.battlefields.map((bf) =>
        bf.id === "bf1"
          ? { ...bf, units: { ...bf.units, p1: (bf.units["p1"] ?? []).filter((u) => u.instanceId !== cat.instanceId) } }
          : bf.id === "bf2"
            ? { ...bf, units: { p1: [cat], p2: [] } }
            : bf,
      ),
    };
    const settled = resolveHeldTriggers(walkedOut);

    expect(buffed(settled, friend.instanceId), "it reached into a fight its source had left").toEqual({ might: 0, tank: false });
  });

  it("mistargets when Yuumi DIED during the response window", () => {
    // A different code path from the walk-out: `resolvePendingTrigger` falls back
    // to the CAPTURED listener card, whose recorded battlefield is still the
    // combat's, so a check written against that field would pass here.
    const cat = yuumi();
    const friend = ally();
    const staged = runCleanup(contested([cat, friend], [wall()]));
    expect(heldTriggerDefIds(staged), "the trigger was never placed").toContain(YUUMI);

    const killed: GameState = {
      ...staged,
      battlefields: staged.battlefields.map((bf) =>
        bf.id === "bf1" ? { ...bf, units: { ...bf.units, p1: [friend] } } : bf,
      ),
    };
    const settled = resolveHeldTriggers(killed);
    expect(buffed(settled, friend.instanceId), "a dead source still resolved its 'here'").toEqual({ might: 0, tank: false });
  });

  it("is registered through the domain-file event-trigger seam, on combatBegan", () => {
    expect(eventTriggerFor(YUUMI)?.on, "the entry is not listening for the combat moment").toBe("combatBegan");
    expect(isCardImplemented(registry.get(YUUMI))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("Vilemaw (UNL-060): when I hold, draw 1", () => {
  const deckOf = (n: number) => Array.from({ length: n }, (_, i) => makeUnit({ name: `Deck ${i}` }));

  it("draws exactly 1 off a hold at the battlefield he is standing at", () => {
    const spider = realUnitInstance(VILEMAW);
    const state = holdingBf1([spider]);
    state.players[0]!.deck = deckOf(3);

    const settled = resolveHeldTriggers(runBeginning(state));

    expect(settled.players[0]!.points, "no hold happened at all — this fixture proves nothing").toBe(1);
    expect(settled.players[0]!.hand.map((c) => c.name), "the hold trigger did not draw").toEqual(["Deck 0"]);
    expect(settled.players[0]!.deck, "it drew more than one").toHaveLength(2);
  });

  it("does NOT draw off a hold at a battlefield he is not standing at — 'when I HOLD'", () => {
    // An outpost holds bf1 while Vilemaw sits in BASE, so the hold is real and
    // his `battlefieldId` cannot match it. 383.4.d.2.a makes the ability the
    // UNIT's, so it is his presence that is being asked about, not his
    // controller's point.
    const state = holdingBf1([makeUnit({ name: "Outpost" })]);
    state.players[0]!.baseUnits = [realUnitInstance(VILEMAW)];
    state.players[0]!.deck = deckOf(3);

    const settled = resolveHeldTriggers(runBeginning(state));

    expect(settled.players[0]!.points, "no hold happened at all — this negative proves nothing").toBe(1);
    expect(settled.players[0]!.hand, "he drew off a hold that was not his").toHaveLength(0);
  });

  it("does NOT draw while standing at a DIFFERENT battlefield from the one held", () => {
    // The base case above cannot see a "is he at a battlefield at all" mis-read —
    // a unit in base has no battlefield either way. Here he IS at one, and it is
    // not the one being held: bf2 is not a hold because the opponent is standing
    // there too (`isHeldBy`).
    const state = holdingBf1([makeUnit({ name: "Outpost" })]);
    state.battlefields[1]!.units = { p1: [realUnitInstance(VILEMAW)], p2: [makeUnit({ name: "Squatter" })] };
    state.players[0]!.deck = deckOf(3);

    const settled = resolveHeldTriggers(runBeginning(state));

    expect(settled.players[0]!.points, "no hold happened at all — this negative proves nothing").toBe(1);
    expect(settled.players[0]!.hand, "he drew off a hold at another battlefield").toHaveLength(0);
  });

  it("PINS THE GAP: a smaller enemy unit here still DOES deal him combat damage", () => {
    // Printed: "Enemy units here with less Might than me don't deal combat
    // damage." The mechanism is `combat.outgoingMight`, whose
    // `DEALS_NO_COMBAT_DAMAGE_DEF_IDS` is keyed by the SUFFERING unit's own defId
    // — Vilemaw's is a board-conditional aura over somebody ELSE's units, so it
    // needs a new predicate in a file this pass does not own.
    //
    // Measured as a DEATH rather than as `damage`, because 466 step 3c heals
    // every unit at the end of the combat: an assertion on the damage counter
    // after `resolveShowdown` reads 0 whether the hit landed or not, which is a
    // measurement that lies. Vilemaw goes in with 7 of his 8 Might already gone,
    // so the 2 from a 2-Might enemy is exactly lethal.
    //
    // Asserting the WRONG answer on purpose: closing the gap turns this red
    // instead of quietly changing every combat he is in.
    function fight(enemy: UnitInstance): { state: GameState; spider: UnitInstance } {
      const spider = { ...realUnitInstance(VILEMAW), damage: 7 };
      const state = makeState({ phase: "Action" });
      state.battlefields[0]!.units = { p1: [spider], p2: [enemy] };
      state.battlefields[0]!.controllerId = "p2";
      state.battlefields[0]!.contestedByIndex = 0;
      return { state: resolveShowdown(state, "bf1", 0), spider };
    }

    const hit = fight(makeUnit({ name: "Small", might: 2 }));
    expect(find(hit.state, hit.spider.instanceId), "the gap CLOSED — delete this pin and the PARTIAL coverage entry").toBeUndefined();

    // The positive control for that death: the SAME 2-Might body, stunned, deals
    // nothing (423) and he lives. So the kill above really is that enemy's
    // combat damage rather than the fixture's own arithmetic — which is exactly
    // the difference the printed clause would make.
    const stunned = fight(makeUnit({ name: "Small", might: 2, stunned: true }));
    expect(find(stunned.state, stunned.spider.instanceId), "he died with nothing hitting him — this pin proves nothing").toBeDefined();
  });

  it("is registered on battlefieldHeld, and [Ambush] is the loader's", () => {
    expect(eventTriggerFor(VILEMAW)?.on).toBe("battlefieldHeld");
    // The keyword really is on the printed definition, so nothing here has to
    // grant it — a check worth making because "implemented" would otherwise rest
    // on an assumption about the card data.
    expect(unitDef(VILEMAW).keywords).toMatchObject({ Ambush: 1 });
  });
});

// ---------------------------------------------------------------------------

describe("the cards this wave REFUSED, and why each is visible", () => {
  // These are NOT pins on a divergence — nothing was written for them, so there
  // is no wrong behaviour to freeze. They exist so that "implemented" cannot
  // creep up on these ids from a half-written registration in this file:
  // registration is per defId, so one clause would flip the flag for the whole
  // card. If a later wave writes one properly it will also remove its id here.
  for (const [defId, needs] of [
    [ALPHA_WILDCLAW, "target-lookup.UNCHOOSEABLE_BY_ENEMIES is a flat defId Set; this is a Might-conditional aura over OTHER units"],
    [MASTER_YI_UNSTOPPABLE, "the [Level] bands reduce POWER pips as well as Energy, which modifiedEnergyCost cannot express, plus a second UNCHOOSEABLE entry"],
  ] as const) {
    it(`${defId} is still unimplemented — ${needs}`, () => {
      expect(isCardImplemented(registry.get(defId))).toBe(false);
    });
  }

  it("UNL-058 Lillia is WRITTEN — this refusal expired on 2026-08-10", () => {
    // **Removed from the list above rather than left to rot, and the reason is
    // worth keeping.** This wave's refusal named two blockers and both were
    // accurate at the time: `placeToken` fired no event whatsoever, so "when you
    // play a token unit" could not be observed, and `KEYWORD_AURAS` had no way
    // to ask about the RECIPIENT's token nature.
    //
    // Neither turned out to be a subsystem. The first became a required
    // `isToken` field on the `cardPlayed` event — which the rules demanded
    // anyway, since 185.2.a makes a token PLAYED while 185 keeps it from being a
    // CARD, and three listeners in the pool had been accidentally right only
    // because nothing fired at all. The second was `appliesTo`, which already
    // existed for Spirit's Refuge's "buffed".
    //
    // Kept as an assertion rather than deleted so that a regression in either
    // mechanism fails HERE, next to the refusal it invalidated.
    expect(isCardImplemented(registry.get(LILLIA_PROTECTOR)), "Lillia went back to being unimplemented").toBe(true);
  });
});
