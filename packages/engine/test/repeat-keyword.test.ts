import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { repeatCostOf, repeatCostsOf, repeatCostDefIds } from "../src/engine/card-effects.js";
import { COMPLETE_SETS } from "../src/engine/coverage.js";
import { modifiedRepeatEnergy } from "../src/engine/cost-modifiers.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import type { GameState } from "../src/model/game-state.js";
import { isSpellChainEntry } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { Domain } from "../src/model/domain.js";
import { answerDecisions, makeState, makeUnit, pickCard, spellInstance } from "./fixtures.js";

/**
 * `[Repeat]` — rule 820.1.
 *
 * "Repeat is an Optional Additional Cost keyword ... an optional cost that a
 * player may pay to execute the effect of their spells and abilities a second
 * time", spelled out in full by 820.1.d: *"You may pay [Cost] as an additional
 * cost as you play this. If you do, execute the instructions of this chain item
 * one additional time during resolution."*
 *
 * Two claims about this keyword were confidently written into the engine and
 * both were wrong, so this file is pointed squarely at them:
 *
 *  1. That it needed a Cleanup able to SUSPEND mid-resolution and resume. It
 *     does not — 320/321 make Cleanup and resolution mutually exclusive, so the
 *     two executions run back to back inside one resolution.
 *
 *  2. That the chain entry needed only "a FLAG". It does not — 820.1.d also
 *     says *"choices made for the additional execution do not have to be the
 *     same as the choices made for the initial execution"*, so the second
 *     execution carries its own choice SET. `different choices` below is the
 *     test that fails against a flag-only implementation, and it is the reason
 *     that design was rejected rather than shipped.
 */

const registry = defaultCardRegistry();

const DESERTS_CALL = "SFD-031"; // [Repeat] [2]; play a 2-Might Sand Soldier — 820.1.d's own example
const FERAL_STRENGTH = "SFD-034"; // [Repeat] [2]; give a unit +2 Might this turn
const BLOOD_RUSH = "SFD-003"; // [Repeat] [1]; give a unit [Assault 2] this turn
const FRIGID_TOUCH = "SFD-066"; // [Repeat] [2]; give a unit -2 Might this turn
const BONDS_OF_STRENGTH = "SFD-151"; // [Repeat] [2]; give two friendly units each +1
const PIERCING_LIGHT = "SFD-023"; // [Repeat] [2][Fury] — the Power-carrying shape
const MARCHING_ORDERS = "SFD-114"; // [Repeat] [3]; friendly anywhere duels enemy at a battlefield

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `action was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** Passes focus until the chain empties — a Spell takes effect on resolution. */
function resolveChain(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 8 && current.spellChain.length > 0; guard += 1) {
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    expect(pass, "no focus pass was offered while the chain was non-empty").toBeDefined();
    current = accept(current, pass);
  }
  expect(current.spellChain, "the chain never resolved").toHaveLength(0);
  return current;
}

/**
 * Passes focus until a decision is parked or the chain empties — for the cards
 * whose effect ASKS something.
 *
 * Distinct from `resolveChain`, which insists the chain empties: a spell that
 * parks a question stops the chain dead, because while a decision is pending the
 * only legal action is an answer. Using `resolveChain` on one of those hangs on
 * a PassFocus that is never offered.
 */
function untilDecision(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 8; guard += 1) {
    if (pendingDecision(current) !== undefined) return current;
    if (current.spellChain.length === 0) return current;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) return current;
    current = accept(current, pass);
  }
  return current;
}

const runes = (domain: Domain, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

/** A caster holding `defId` with `count` runes of `domain`, and whatever units
 *  the case needs in base. */
function caster(defId: string, domain: Domain, count: number, baseUnits = 0) {
  const spell = spellInstance(defId);
  const state = makeState({ phase: "Action" });
  state.players[0]!.hand = [spell];
  state.players[0]!.channeled = runes(domain, count);
  state.players[0]!.baseUnits = Array.from({ length: baseUnits }, (_, i) =>
    makeUnit({ name: `Ally${i}`, instanceId: `ally${i}`, might: 3 }),
  );
  return { state, spellId: spell.instanceId };
}

describe("the [Repeat] cost table matches what the cards actually print", () => {
  /**
   * The table in card-effects.ts records each Repeat cost's DOMAIN rather than
   * reading it off `card.powerDomain`, for the reason OPTIONAL_POWER_COSTS
   * records: a printed cost and an additional cost are two different pips.
   *
   * The pricing then adds the Repeat's Power to the card's OWN power bucket,
   * which is only sound while the two domains agree. They do for every printed
   * instance — so this asserts it instance by instance instead of leaving it as a
   * comment. The day a set prints a Repeat cost in a domain the card itself does
   * not, this fails and the pricing has to grow a third bucket.
   *
   * **Every INSTANCE, not just the first.** Read through `repeatCostOf` this
   * checked one spec per card, which was the same answer only while every card
   * printed one; Curtain Call's three would have had two of them unchecked.
   */
  it("every Repeat Power cost is in the card's own printed domain", () => {
    for (const defId of repeatCostDefIds()) {
      const def = registry.get(defId);
      for (const [i, spec] of repeatCostsOf(defId).entries()) {
        if (spec.power === undefined) continue;
        expect(spec.domain, `${defId} (${def.name}) Repeat instance ${i} domain`).toBe(def.powerDomain);
      }
    }
  });

  /**
   * 820.1.c.2/c.3 — "if a spell or ability has more than one instance of Repeat,
   * each Cost may be paid or not paid individually... each Repeat Cost can be
   * paid only a single time."
   *
   * **The premise this used to assert was "no card prints two", and it was
   * retired on 2026-08-14 rather than weakened.** It counted `[Repeat]` tokens in
   * the printed text, and UNL-182 Curtain Call would have passed it forever: the
   * card prints the keyword ONCE and then three slash-separated costs. So the
   * check was measuring the wrong thing, and it would have gone on reporting a
   * one-instance pool while the pool held a three-instance card.
   *
   * What replaces it is an invariant that cannot go vacuous: the REMINDER TEXT
   * says which case a card is, in the printed words "you may pay **each**
   * additional cost" versus "you may pay **the** additional cost", and the table
   * must agree with it card by card. A new multi-instance card whose row holds
   * one spec fails here, and so does a row that invents instances a card does not
   * print.
   */
  it("the table's instance count agrees with each card's printed reminder text", () => {
    for (const defId of repeatCostDefIds()) {
      const def = registry.get(defId);
      const printsSeveral = (def.text ?? "").includes("pay each additional cost");
      expect(
        repeatCostsOf(defId).length > 1,
        `${defId} (${def.name}) prints ${printsSeveral ? "several" : "one"} [Repeat] cost but the table holds ${repeatCostsOf(defId).length}`,
      ).toBe(printsSeveral);
    }
  });

  /**
   * The enumerator skips the Repeat variant on a from-hidden play, matching the
   * optional-Power and Accelerate branches beside it. Rule 811 ignores a hidden
   * card's BASE cost and an additional cost is not that, so it is a real
   * simplification — and it is unreachable only while no card prints both.
   */
  it("no [Repeat] card is also [Hidden] — the premise that keeps the from-hidden skip unreachable", () => {
    for (const defId of repeatCostDefIds()) {
      const def = registry.get(defId);
      // Read off the printed TEXT rather than a parsed keyword map: a
      // CardDefinition carries no `keywords` field (that is on the instance),
      // and the text is what `unimplementedKeywordsOn` reads for the same reason.
      expect((def.text ?? "").includes("[Hidden]"), `${defId} (${def.name}) is [Hidden]`).toBe(false);
    }
  });

  it("covers every card in a FINISHED set that prints the keyword, and nothing else", () => {
    // Cards that GRANT or DISCOUNT Repeat print no cost of their own, so none is
    // in the table: Temporal Portal and Marai Spire (SFD), and Syndra -
    // Transcendent (UNL), whose "your spells have [Repeat] :2::chaos:" gives the
    // cost to OTHER cards.
    const granters = ["SFD-078", "SFD-211", "UNL-146"];
    const printed = registry
      .all()
      .filter((def) => (def.text ?? "").includes("[Repeat]"))
      .map((def) => def.id)
      .filter((id) => !granters.includes(id))
      .sort();

    // **Two directions, not one equality — and the equality is what broke.**
    // It read "the finished sets' Repeat cards ARE the table", which held only
    // while no card outside a finished set was priced. On 2026-08-09 four UNL
    // cards were, and the assertion failed for a reason that was pure good news.
    //
    // Split into the two things actually meant, so pricing a card in a set under
    // construction is progress rather than a failure:
    //
    //   COMPLETENESS, over hard-gated sets only — a finished set may not have an
    //   unpriced Repeat card. This is the half with teeth for OGN/OGS/SFD, and
    //   scoping it is what stops a set's JSON landing from demanding six card
    //   implementations as the price of admission.
    //
    //   SOUNDNESS, over every set — a table row must name a real card that
    //   actually prints the keyword. That catches the typo'd or stale defId the
    //   old equality also caught, and it keeps catching it for UNL.
    const gated = printed.filter((id) => COMPLETE_SETS.includes(id.split("-")[0]!));
    const table = repeatCostDefIds().sort();
    expect(gated.filter((id) => !table.includes(id)), "a FINISHED set has an unpriced [Repeat] card").toEqual([]);
    expect(table.filter((id) => !printed.includes(id)), "the table prices a card that prints no [Repeat]").toEqual([]);
  });

  it("names the [Repeat] cards a set under construction has not priced yet", () => {
    // Stated, not counted, and stated HERE rather than in a doc: an unpriced
    // [Repeat] is invisible in play — the enumerator simply never offers the
    // repeat variant, and the card looks like it works.
    //
    // Four of these six print a plain 2-Energy cost and are ordinary table
    // entries. The other two are why this list is not just "not done yet":
    //
    //   UNL-017 Square Up prints `[Repeat] — Discard 1`, a cost that is not
    //   energy, power or exhaust. `RepeatCostSpec` has no way to say it.
    //
    //   UNL-182 Curtain Call prints THREE alternative costs and says "you may
    //   pay EACH additional cost to repeat this spell's effect" — which is
    //   820.1.c.2's multi-instance case, the exact thing the one-instance
    //   `repeatPaid` boolean two tests above records as unreachable. It is
    //   reachable now, and that premise-test is scoped to the table, so this is
    //   the only place that says so.
    const unpriced = registry
      .all()
      .filter((def) => (def.text ?? "").includes("[Repeat]"))
      .map((def) => def.id)
      .filter((id) => !COMPLETE_SETS.includes(id.split("-")[0]!))
      .filter((id) => id !== "UNL-146") // grants it; prints no cost of its own
      .filter((id) => !repeatCostDefIds().includes(id))
      .sort();
    // **Four dropped off this list on 2026-08-09**, when their effects were written
    // and `REPEAT_COSTS` gained a row each. What remains is the two the table
    // genuinely CANNOT express, which is the honest residue rather than a to-do:
    // UNL-017 Square Up pays "Discard 1" (a non-resource cost `RepeatCostSpec` has
    // no field for) and UNL-182 Curtain Call prints three alternative costs
    // (820.1.c.2's multi-instance case, which the one-instance `repeatPaid`
    // boolean cannot carry).
    // **UNL-017 Square Up left this list on 2026-08-13.** `RepeatCostSpec` gained
    // a `discard`, which is the whole of what it needed — its cost is one
    // instance whose price is a card, not the multi-instance case.
    //
    // **UNL-182 Curtain Call left it on 2026-08-14, and the list is now EMPTY.**
    // It was the harder half — three alternative costs, "you may pay EACH", which
    // is 820.1.c.2's multi-instance case — and it is what made the table's value
    // type `RepeatCostSpec | RepeatCostSpec[]` and the action carry
    // `repeatExecutions` instead of a boolean. See
    // `test/curtain-call-repeat.test.ts`.
    //
    // Empty is not the same as retired: this list is what an UNPRICED [Repeat]
    // in a set under construction looks like, and it is invisible in play —
    // the enumerator simply never offers the repeat variant and the card looks
    // like it works. It stays so the next set's landing says so out loud.
    expect(unpriced).toEqual([]);
  });
});

describe("[Repeat] is priced as an additional cost at announce (820.1.c.1)", () => {
  it("offers a plain candidate AND a repeat-paid one", () => {
    const { state, spellId } = caster(DESERTS_CALL, "Calm", 8);
    const plays = playsOf(state, spellId);

    expect(plays.filter((a) => a.repeatPaid).length, "no repeat variant offered").toBeGreaterThan(0);
    // Declining stays available — 820.1 calls it an OPTIONAL additional cost.
    expect(plays.filter((a) => !a.repeatPaid).length, "no plain variant offered").toBeGreaterThan(0);
  });

  it("the repeat variant costs the printed cost PLUS the repeat cost", () => {
    // Desert's Call is 2 Energy printed with a [Repeat] [2].
    const { state, spellId } = caster(DESERTS_CALL, "Calm", 8);
    const plays = playsOf(state, spellId);

    const plain = plays.find((a) => !a.repeatPaid)!;
    const repeated = plays.find((a) => a.repeatPaid)!;
    expect(plain.payment.energyRunes).toHaveLength(2);
    expect(repeated.payment.energyRunes).toHaveLength(4);
  });

  /**
   * The negative, and the one that matters: a board that can afford the card but
   * NOT the repeat must still offer the card. Three runes pays the printed 2 and
   * cannot reach 4.
   */
  it("does NOT offer the repeat when only the plain cost is affordable", () => {
    const { state, spellId } = caster(DESERTS_CALL, "Calm", 3);
    const plays = playsOf(state, spellId);

    expect(plays.length, "the card became unplayable entirely").toBeGreaterThan(0);
    expect(plays.filter((a) => a.repeatPaid)).toHaveLength(0);
  });

  it("prices a Repeat that carries Power as well as Energy", () => {
    // Piercing Light is 2 Energy + 1 Fury with a [Repeat] [2][Fury].
    //
    // Its first slot is scoped "at a battlefield", so the fixture has to STAND a
    // unit at one — a board with units only in base offers this card no legal
    // target and therefore no play at all, repeat or otherwise. That is the card
    // working, not the test being awkward: `slotScopes: ["battlefield", ...]` is
    // the printed restriction.
    const { state, spellId } = caster(PIERCING_LIGHT, "Fury", 10);
    state.battlefields[0]!.units["p1"] = [makeUnit({ name: "Front", instanceId: "front", might: 3 })];

    const repeated = playsOf(state, spellId).find((a) => a.repeatPaid);
    expect(repeated, "no repeat variant offered for the Power-carrying shape").toBeDefined();
    expect(repeated!.payment.energyRunes).toHaveLength(4);
    expect(repeated!.payment.powerRunes).toHaveLength(2);
  });

  /**
   * **Floating Energy reduces the TOTAL, additional cost included.**
   *
   * The regression this pins was shipped and then caught by `DECKS=sfd
   * probes/exercised.ts`, not by this suite — because no test here had floating
   * Energy banked, which is the very reason the discounted branch in
   * `legal-actions` carries the same warning about the same mistake.
   *
   * Blood Rush is 1 printed Energy with a [Repeat] [1]. With 2 floating Energy
   * the whole 2 is covered and the correct payment is ZERO runes. Pricing the
   * repeat by adding it to the already-float-reduced cost quotes one rune
   * instead, and the validator — which prices the total against the float —
   * refuses the action the enumerator just offered.
   */
  it("prices the repeat against floating Energy as one total, not after the fact", () => {
    const { state, spellId } = caster(BLOOD_RUSH, "Fury", 6, 1);
    state.players[0]!.floatingEnergy = 2;

    const repeated = playsOf(state, spellId).find((a) => a.repeatPaid);
    expect(repeated, "no repeat variant offered").toBeDefined();
    expect(repeated!.payment.energyRunes).toHaveLength(0);
    expect(validatePlayCard(state, repeated!), "enumerated but refused").toMatchObject({ ok: true });
  });

  /** The same question one notch down, where the float covers part of the total
   *  rather than all of it: 1 printed + 1 repeat - 1 floating = one rune. */
  it("and prices a partial float correctly too", () => {
    const { state, spellId } = caster(BLOOD_RUSH, "Fury", 6, 1);
    state.players[0]!.floatingEnergy = 1;

    const repeated = playsOf(state, spellId).find((a) => a.repeatPaid)!;
    expect(repeated.payment.energyRunes).toHaveLength(1);
    expect(validatePlayCard(state, repeated)).toMatchObject({ ok: true });
  });

  /**
   * The enumerator/validator agreement check. This codebase has shipped an
   * offered-then-refused split three times, and it is only ever caught by a test
   * that enumerates and then validates the SAME action.
   */
  it("every enumerated repeat play actually validates", () => {
    for (const defId of [DESERTS_CALL, FERAL_STRENGTH, BLOOD_RUSH, BONDS_OF_STRENGTH]) {
      const { state, spellId } = caster(defId, registry.get(defId).domains[0] as Domain, 10, 2);
      const repeats = playsOf(state, spellId).filter((a) => a.repeatPaid);
      expect(repeats.length, `${defId} offered no repeat variant`).toBeGreaterThan(0);
      for (const play of repeats) {
        expect(validatePlayCard(state, play), `${defId}: enumerated but refused`).toMatchObject({ ok: true });
      }
    }
  });
});

describe("[Repeat] executes the instructions one additional time (820.1.d)", () => {
  /**
   * The rulebook's own worked example, quoted verbatim:
   *
   *   "Desert's Call is a spell with [Repeat] [2] and 'Play a 2 [Might] Sand
   *   Soldier unit token.' If its controller pays its Repeat cost as they play
   *   it, the card's instruction to play a Sand Soldier is executed twice, as
   *   though the card says 'Play a 2 [Might] Sand Soldier unit token. Play a 2
   *   [Might] Sand Soldier unit token.'"
   */
  it("Desert's Call paid makes TWO Sand Soldiers", () => {
    const { state, spellId } = caster(DESERTS_CALL, "Calm", 8);
    const play = playsOf(state, spellId).find((a) => a.repeatPaid && a.destinationBattlefieldId === undefined)!;
    const after = resolveChain(accept(state, play));

    expect(after.players[0]!.baseUnits.filter((u) => u.name === "Sand Soldier")).toHaveLength(2);
  });

  /** The negative that gives the assertion above its meaning. */
  it("Desert's Call DECLINED makes exactly one", () => {
    const { state, spellId } = caster(DESERTS_CALL, "Calm", 8);
    const play = playsOf(state, spellId).find((a) => !a.repeatPaid && a.destinationBattlefieldId === undefined)!;
    const after = resolveChain(accept(state, play));

    expect(after.players[0]!.baseUnits.filter((u) => u.name === "Sand Soldier")).toHaveLength(1);
  });

  it("a numeric Might modifier STACKS across the two executions", () => {
    const { state, spellId } = caster(FERAL_STRENGTH, "Calm", 8, 1);
    const play = playsOf(state, spellId).find((a) => a.repeatPaid && a.targetUnitInstanceId === "ally0")!;
    const after = resolveChain(accept(state, play));

    // Base 3 Might, +2 twice.
    const ally = after.players[0]!.baseUnits.find((u) => u.instanceId === "ally0")!;
    expect(effectiveMight(after, ally, 0, { isCombat: false })).toBe(7);
  });

  it("and the declined play is +2 once, not +4", () => {
    const { state, spellId } = caster(FERAL_STRENGTH, "Calm", 8, 1);
    const play = playsOf(state, spellId).find((a) => !a.repeatPaid && a.targetUnitInstanceId === "ally0")!;
    const after = resolveChain(accept(state, play));

    const ally = after.players[0]!.baseUnits.find((u) => u.instanceId === "ally0")!;
    expect(effectiveMight(after, ally, 0, { isCombat: false })).toBe(5);
  });

  /**
   * **A VALUED keyword stacks across the two executions.** This asserted 2 —
   * "repeating Blood Rush is a legal way to waste 1 Energy" — on a citation of
   * "817.1.a makes multiple instances of a keyword redundant". 817.1.a is
   * Vision's "It is present on Permanents"; there is no general redundancy rule,
   * and 807.2 says the Assault Values of all granted instances are SUMMED.
   * 820.1.d makes the additional execution a second performance of the same
   * instruction, so it is a second grant — [Assault 4].
   *
   * The negative that gives this its meaning is not here but in
   * keyword-stacking.test.ts, where the same merge leaves [Ganking] and [Tank] at
   * 1 under their own redundancy rules (810.2, 815.2).
   */
  it("a VALUED keyword stacks across the two executions — 807.2 sums", () => {
    const { state, spellId } = caster(BLOOD_RUSH, "Fury", 8, 1);
    const play = playsOf(state, spellId).find((a) => a.repeatPaid && a.targetUnitInstanceId === "ally0")!;
    const after = resolveChain(accept(state, play));

    const ally = after.players[0]!.baseUnits.find((u) => u.instanceId === "ally0")!;
    expect(ally.keywordsThisTurn.Assault, "the repeat's [Assault 2] was swallowed").toBe(4);
  });

  /** And the declined play is 2, not 4 — the control that keeps the 4 above from
   *  being a property of Blood Rush rather than of the repeat. */
  it("and the declined play is [Assault 2] once", () => {
    const { state, spellId } = caster(BLOOD_RUSH, "Fury", 8, 1);
    const play = playsOf(state, spellId).find((a) => !a.repeatPaid && a.targetUnitInstanceId === "ally0")!;
    const after = resolveChain(accept(state, play));

    const ally = after.players[0]!.baseUnits.find((u) => u.instanceId === "ally0")!;
    expect(ally.keywordsThisTurn.Assault).toBe(2);
  });

  /**
   * A debuff stacks the same way a buff does — but the OBSERVABLE Might floors
   * at 0, because `effectiveMight` ends on `Math.max(0, m)`: a unit's Might is
   * never negative.
   *
   * So both halves are asserted. `mightThisTurn` is where the second execution
   * proves it happened (-2 twice), and `effectiveMight` is what the rest of the
   * engine sees. Asserting only the second would have passed against a
   * single-execution implementation, since 3 - 2 and 3 - 4 both floor to... 1 and
   * 0 respectively — close enough to look right and not be.
   */
  it("a debuff stacks too, though the visible Might floors at 0", () => {
    const { state, spellId } = caster(FRIGID_TOUCH, "Mind", 8, 1);
    const play = playsOf(state, spellId).find((a) => a.repeatPaid && a.targetUnitInstanceId === "ally0")!;
    const after = resolveChain(accept(state, play));

    const ally = after.players[0]!.baseUnits.find((u) => u.instanceId === "ally0")!;
    expect(ally.mightThisTurn).toBe(-4);
    expect(effectiveMight(after, ally, 0, { isCombat: false })).toBe(0);
  });
});

/**
 * `[Repeat]` × `[Deflect]` — project-owner ruling, 2026-08-06.
 *
 * "Opponents must pay N rainbow Power to choose me with a spell or ability."
 * 820.1.d puts the additional execution's choices at the same Make Relevant
 * Choices step, so they ARE choices; 355 makes each choice a target in its own
 * right; therefore **choosing the same unit in both executions owes the tax
 * twice**. No dedup.
 *
 * That is the same reading `chosenUnitsOfPlay` already applied WITHIN one
 * execution — a `unitList` naming one unit twice has always owed 2 — so the
 * ruling made the two consistent rather than introducing a new rule.
 *
 * Feral Strength is the vehicle: "give A UNIT +2 Might", no owner clause, so an
 * enemy is a legal target and the surcharge is actually reachable.
 */
describe("[Repeat] pays [Deflect] once per choice, so twice for the same unit", () => {
  /** An enemy `[Deflect 1]` unit in its own base, targetable by "a unit". */
  function withDeflectEnemy(runeCount = 12) {
    const { state, spellId } = caster(FERAL_STRENGTH, "Calm", runeCount);
    state.players[1]!.baseUnits = [
      makeUnit({ name: "Warded", instanceId: "warded", might: 5, keywords: { Deflect: 1 } }),
    ];
    return { state, spellId };
  }

  it("declining the repeat pays the tax ONCE", () => {
    const { state, spellId } = withDeflectEnemy();
    const plain = playsOf(state, spellId).find((a) => !a.repeatPaid && a.targetUnitInstanceId === "warded")!;

    expect(plain.payment.rainbowRunes ?? []).toHaveLength(1);
    expect(validatePlayCard(state, plain)).toMatchObject({ ok: true });
  });

  /** The assertion the ruling settles. */
  it("paying the repeat on the same unit pays it TWICE", () => {
    const { state, spellId } = withDeflectEnemy();
    const repeated = playsOf(state, spellId).find((a) => a.repeatPaid && a.targetUnitInstanceId === "warded")!;

    expect(repeated.payment.rainbowRunes ?? [], "same unit chosen twice owes 2").toHaveLength(2);
    expect(validatePlayCard(state, repeated), "enumerated but refused").toMatchObject({ ok: true });
  });

  /**
   * The escape hatch that existed while only the first execution was taxed: name
   * an ordinary unit first and the Deflect unit ONLY in `repeatChoices`. The tax
   * is owed for the repeat's choice on its own.
   */
  it("taxes a Deflect unit named ONLY by the repeat's choice set", () => {
    const { state, spellId } = withDeflectEnemy();
    state.players[0]!.baseUnits = [makeUnit({ name: "Ally0", instanceId: "ally0", might: 3 })];

    const base = playsOf(state, spellId).find((a) => a.repeatPaid && a.targetUnitInstanceId === "ally0")!;
    expect(base.payment.rainbowRunes ?? [], "no Deflect unit chosen yet").toHaveLength(0);

    // Now point the SECOND execution at the warded unit. The payment the
    // enumerator quoted for an untaxed pair no longer covers it.
    const dodging: PlayCardAction = { ...base, repeatChoices: { targetUnitInstanceId: "warded" } };
    const result = validatePlayCard(state, dodging);
    expect(result.ok, "the repeat's own choice escaped the surcharge").toBe(false);
    expect(JSON.stringify(result)).toContain("Deflect");
  });

  /**
   * And the same action WITH the surcharge paid is legal — otherwise the check
   * above would pass for a card that had simply become uncastable.
   */
  it("and accepts that same play once the repeat's surcharge is actually paid", () => {
    const { state, spellId } = withDeflectEnemy();
    state.players[0]!.baseUnits = [makeUnit({ name: "Ally0", instanceId: "ally0", might: 3 })];

    const base = playsOf(state, spellId).find((a) => a.repeatPaid && a.targetUnitInstanceId === "ally0")!;
    const spent = new Set([...base.payment.energyRunes, ...base.payment.powerRunes]);
    const spare = state.players[0]!.channeled.find((r) => !spent.has(r.id))!;
    const paid: PlayCardAction = {
      ...base,
      repeatChoices: { targetUnitInstanceId: "warded" },
      payment: { ...base.payment, rainbowRunes: [spare.id] },
    };

    expect(validatePlayCard(state, paid)).toMatchObject({ ok: true });
  });
});

/**
 * Marai Spire (SFD-211) — "While you control this battlefield, friendly
 * `[Repeat]` costs cost [1] less."
 *
 * The first battlefield in this repo whose continuous ability is neither
 * positional nor symmetric: it discounts a spell cast from ANYWHERE, but only
 * for whoever controls it. So it cannot be answered from a location, and every
 * assertion here is really about that asymmetry.
 */
describe("Marai Spire discounts friendly [Repeat] costs", () => {
  /** `spire` decides who controls the Spire; `null` leaves it uncontrolled. */
  function withSpire(defId: string, domain: Domain, controller: 0 | 1 | null, runeCount = 12) {
    const { state, spellId } = caster(defId, domain, runeCount, 1);
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      defId: "SFD-211",
      controllerId: controller === null ? null : state.players[controller]!.id,
    };
    return { state, spellId };
  }

  it("takes 1 Energy off the repeat cost for the controller", () => {
    // Feral Strength: 2 printed + [Repeat] [2] = 4, less the Spire's 1 = 3.
    const { state, spellId } = withSpire(FERAL_STRENGTH, "Calm", 0);
    const repeated = playsOf(state, spellId).find((a) => a.repeatPaid)!;

    expect(repeated.payment.energyRunes).toHaveLength(3);
    expect(validatePlayCard(state, repeated), "enumerated but refused").toMatchObject({ ok: true });
  });

  /** The negative that carries the "while YOU control" clause. */
  it("does NOT discount the opponent's repeat", () => {
    const { state, spellId } = withSpire(FERAL_STRENGTH, "Calm", 1);
    const repeated = playsOf(state, spellId).find((a) => a.repeatPaid)!;

    expect(repeated.payment.energyRunes, "the enemy's Spire discounted our repeat").toHaveLength(4);
  });

  /** And an uncontrolled Spire discounts nobody — "while you CONTROL". */
  it("does nothing while nobody controls it", () => {
    const { state, spellId } = withSpire(FERAL_STRENGTH, "Calm", null);
    const repeated = playsOf(state, spellId).find((a) => a.repeatPaid)!;

    expect(repeated.payment.energyRunes).toHaveLength(4);
  });

  /**
   * It discounts the REPEAT cost, not the card. A play that declines the repeat
   * pays its printed cost in full — otherwise this would be a general discount,
   * which is a different card.
   */
  it("leaves the printed cost alone when the repeat is declined", () => {
    const { state, spellId } = withSpire(FERAL_STRENGTH, "Calm", 0);
    const plain = playsOf(state, spellId).find((a) => !a.repeatPaid)!;

    expect(plain.payment.energyRunes).toHaveLength(2);
  });

  /**
   * Called Shot's `[Repeat]` is `[Chaos]` — one Power pip and NO Energy — so
   * there is nothing for an Energy discount to take off, and it must not go
   * negative and silently offset the Power half.
   *
   * Asserted through the modifier directly rather than through the card, because
   * Called Shot has no effect registered yet and so is not enumerable.
   */
  it("cannot discount a Repeat that costs no Energy below zero", () => {
    const { state } = withSpire(FERAL_STRENGTH, "Calm", 0);
    expect(repeatCostOf("SFD-122")).toMatchObject({ energy: 0, power: 1 });
    expect(modifiedRepeatEnergy(state, 0, 0)).toBe(0);
    // And the controller's discount really is live in that same state, so the
    // zero above is the floor doing its job rather than the Spire being absent.
    expect(modifiedRepeatEnergy(state, 0, 2)).toBe(1);
  });
});

/**
 * Danger Zone (SFD-182) — "[Reaction] [Repeat] [1][rainbow] Give your Mechs +1
 * Might this turn."
 *
 * The ONLY card whose Repeat cost carries a RAINBOW pip, so it is the only thing
 * that exercises `RepeatCostSpec.rainbowPower` at all — a bucket that until now
 * had a table entry, pricing code and no card behind it.
 *
 * It is also a tribal buff, which is the shape that produced a live bug on
 * 2026-08-06: three keyword auras granted to EVERY friendly unit because they
 * consulted `appliesTo` and never `appliesToDef`, and every test passed because
 * each only asserted that the MECH got the keyword. So the negative below is the
 * assertion with the information in it.
 */
describe("Danger Zone buffs Mechs only, and pays a RAINBOW repeat", () => {
  function mechBoard(runeCount = 12) {
    const { state, spellId } = caster("SFD-182", "Mind", runeCount);
    state.players[0]!.baseUnits = [
      makeUnit({ name: "Mech", instanceId: "mech", might: 3, tags: ["Mech"] }),
      makeUnit({ name: "Footsoldier", instanceId: "grunt", might: 3, tags: [] }),
    ];
    state.players[1]!.baseUnits = [makeUnit({ name: "Enemy Mech", instanceId: "foemech", might: 3, tags: ["Mech"] })];
    return { state, spellId };
  }

  it("prices the rainbow half of the repeat cost", () => {
    const { state, spellId } = mechBoard();
    const repeated = playsOf(state, spellId).find((a) => a.repeatPaid)!;

    // 1 printed Energy + 1 repeat Energy; 1 printed Power; 1 RAINBOW for the repeat.
    expect(repeated.payment.energyRunes).toHaveLength(2);
    expect(repeated.payment.powerRunes).toHaveLength(1);
    expect(repeated.payment.rainbowRunes ?? [], "the repeat's rainbow pip was not charged").toHaveLength(1);
    expect(validatePlayCard(state, repeated), "enumerated but refused").toMatchObject({ ok: true });
  });

  it("and charges no rainbow when the repeat is declined", () => {
    const { state, spellId } = mechBoard();
    const plain = playsOf(state, spellId).find((a) => !a.repeatPaid)!;
    expect(plain.payment.rainbowRunes ?? []).toHaveLength(0);
  });

  /** The negative the tribal-aura bug is a monument to. */
  it("pumps YOUR Mechs and nothing else", () => {
    const { state, spellId } = mechBoard();
    const plain = playsOf(state, spellId).find((a) => !a.repeatPaid)!;
    const after = resolveChain(accept(state, plain));

    const mine = (id: string) => after.players[0]!.baseUnits.find((u) => u.instanceId === id)!;
    expect(mine("mech").mightThisTurn, "the Mech").toBe(1);
    expect(mine("grunt").mightThisTurn, "a friendly NON-Mech was pumped").toBe(0);
    expect(
      after.players[1]!.baseUnits.find((u) => u.instanceId === "foemech")!.mightThisTurn,
      "an ENEMY Mech was pumped",
    ).toBe(0);
  });

  it("repeated, it is +2 on the Mech and still nothing on the rest", () => {
    const { state, spellId } = mechBoard();
    const repeated = playsOf(state, spellId).find((a) => a.repeatPaid)!;
    const after = resolveChain(accept(state, repeated));

    expect(after.players[0]!.baseUnits.find((u) => u.instanceId === "mech")!.mightThisTurn).toBe(2);
    expect(after.players[0]!.baseUnits.find((u) => u.instanceId === "grunt")!.mightThisTurn).toBe(0);
  });
});

/**
 * Called Shot (SFD-122) — "[Action] [Repeat] [Chaos] Look at the top 2 cards of
 * your Main Deck. Draw one and recycle the other."
 *
 * The `[Repeat]` case that is NOT a second set of targets: the choice is a
 * parked DECISION (the top of a deck is not public, so it cannot be enumerated
 * onto the action), and repeating parks a SECOND one. Two questions, asked in
 * order, the second against the deck the first left behind.
 */
describe("Called Shot parks one decision per execution", () => {
  /** A caster with a known 4-card deck and enough Chaos to repeat. */
  function board(runeCount = 8) {
    const { state, spellId } = caster("SFD-122", "Chaos", runeCount);
    state.players[0]!.deck = ["a", "b", "c", "d"].map((n) =>
      makeUnit({ name: `Card${n.toUpperCase()}`, instanceId: n, might: 1 }),
    );
    return { state, spellId };
  }

  it("declined, it asks ONCE and draws one of the top two", () => {
    const { state, spellId } = board();
    const plain = playsOf(state, spellId).find((a) => !a.repeatPaid)!;
    const after = answerDecisions(resolveChain(accept(state, plain)), pickCard("a"));

    expect(after.players[0]!.hand.map((c) => c.instanceId)).toContain("a");
    // "Recycle the other" — b goes to the BOTTOM, so the deck is c, d, b.
    expect(after.players[0]!.deck.map((c) => c.instanceId)).toEqual(["c", "d", "b"]);
  });

  /**
   * Repeated: two questions. The second is asked of the deck the FIRST left, so
   * it offers c and b (b having been recycled to the bottom behind d)... which
   * is to say it offers whatever is on top THEN, not a snapshot taken during
   * resolution. Picking by name rather than by position is what makes this
   * assertion about the live re-read rather than about ordering luck.
   */
  it("repeated, it asks TWICE and the second question sees the first's leftovers", () => {
    const { state, spellId } = board();
    const repeated = playsOf(state, spellId).find((a) => a.repeatPaid)!;
    const resolved = resolveChain(accept(state, repeated));

    // Both executions have run and BOTH questions are queued before either is
    // answered — 820.1.d puts them inside one resolution.
    expect(resolved.pendingDecisions.filter((d) => d.kind === "SFD-122-keep")).toHaveLength(2);

    const after = answerDecisions(resolved, pickCard("a"));
    // Two draws from one play: `a` (named), plus whichever the second question
    // offered — two cards in hand either way.
    expect(after.players[0]!.hand).toHaveLength(2);
    expect(after.players[0]!.hand.map((c) => c.instanceId)).toContain("a");
    // Four cards started in the deck; two are now in hand.
    expect(after.players[0]!.deck).toHaveLength(2);
  });

  /** Its Repeat is `[Chaos]` with NO Energy — the only such cost in the set. */
  it("charges a Power-only repeat cost", () => {
    const { state, spellId } = board();
    const plain = playsOf(state, spellId).find((a) => !a.repeatPaid)!;
    const repeated = playsOf(state, spellId).find((a) => a.repeatPaid)!;

    expect(plain.payment.energyRunes, "Called Shot prints 0 Energy").toHaveLength(0);
    expect(repeated.payment.energyRunes, "its Repeat adds no Energy either").toHaveLength(0);
    expect(plain.payment.powerRunes).toHaveLength(1);
    expect(repeated.payment.powerRunes, "1 printed Chaos + 1 repeat Chaos").toHaveLength(2);
  });
});

/**
 * Hard Bargain (SFD-136) — "[Reaction] [Repeat] [2] Counter a spell unless its
 * controller pays [2]."
 *
 * Repeating it is a DOUBLE RANSOM rather than a double counter, and that falls
 * out of the ordering: both executions run inside one resolution (820.1.d) and
 * queue their questions, so the controller is asked twice against the same
 * spell. Pay both and it lives; decline the first and the second finds nothing
 * left to counter (359.3).
 */
describe("Hard Bargain ransoms a spell once per execution", () => {
  /** p1 has a spell on the chain; p0 holds Hard Bargain and can afford it. */
  function chainWithVictim(victimRunes: number) {
    const bargain = spellInstance("SFD-136");
    const victim = spellInstance("OGN-064"); // Wind Wall — any spell will do
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [bargain];
    state.players[0]!.channeled = runes("Chaos", 12);
    state.players[1]!.channeled = runes("Calm", victimRunes);
    state.spellChain = [{ playerIndex: 1, card: victim }];
    return { state, bargainId: bargain.instanceId, victimId: victim.instanceId };
  }

  // Through `isSpellChainEntry` rather than reading `.card` off a raw ChainEntry:
  // the chain is a UNION of spell and trigger entries and only one of them has a
  // card. The engine's `build` tsconfig excludes tests, so a raw access here
  // typechecks green under `npm run build` and red under `npm run typecheck` —
  // which is the split that once sat red for 12 errors behind a green build.
  const chainHas = (state: GameState, id: string) =>
    state.spellChain.some((e) => isSpellChainEntry(e) && e.card.instanceId === id);

  it("declined, the spell is countered", () => {
    const { state, bargainId, victimId } = chainWithVictim(8);
    const play = playsOf(state, bargainId).find((a) => !a.repeatPaid && a.targetChainCardInstanceId === victimId)!;
    // "decline" is the first option, which is what the default picker takes.
    const after = answerDecisions(untilDecision(accept(state, play)));

    expect(chainHas(after, victimId), "declining did not counter it").toBe(false);
  });

  it("paid, the spell survives and the ransom is actually taken", () => {
    const { state, bargainId, victimId } = chainWithVictim(8);
    const play = playsOf(state, bargainId).find((a) => !a.repeatPaid && a.targetChainCardInstanceId === victimId)!;
    const after = answerDecisions(untilDecision(accept(state, play)), (options) => options.find((o) => o.id === "pay")!.id);

    expect(chainHas(after, victimId), "paying did not save it").toBe(true);
    // Two Ready runes went to pay the ransom.
    expect(after.players[1]!.channeled.filter((r) => r.state === "Exhausted")).toHaveLength(2);
  });

  /**
   * A controller who cannot pay is simply countered, and is never even asked.
   *
   * With only 1 rune against a ransom of 2 the "pay" option is not offered, which
   * leaves ONE option — and a one-option decision is AUTO-RESOLVED rather than
   * prompted. So the assertion is about the outcome and about the absence of any
   * prompt; there is deliberately no parked decision to inspect, and looking for
   * one is how this test was wrong the first time.
   */
  it("never even asks a controller who cannot afford the ransom", () => {
    const { state, bargainId, victimId } = chainWithVictim(1); // 1 rune, ransom is 2
    const play = playsOf(state, bargainId).find((a) => !a.repeatPaid && a.targetChainCardInstanceId === victimId)!;
    const after = untilDecision(accept(state, play));

    expect(pendingDecision(after), "a question with one answer should not have been asked").toBeUndefined();
    expect(chainHas(after, victimId), "the unaffordable ransom did not counter it").toBe(false);
    // The lone rune is untouched — nothing was part-paid on the way to failing.
    expect(after.players[1]!.channeled.filter((r) => r.state === "Exhausted")).toHaveLength(0);
  });

  /** The positive control for the test above: with 2 runes the question IS asked. */
  it("and does ask when the ransom is affordable", () => {
    const { state, bargainId, victimId } = chainWithVictim(2);
    const play = playsOf(state, bargainId).find((a) => !a.repeatPaid && a.targetChainCardInstanceId === victimId)!;
    const parked = untilDecision(accept(state, play));

    const decision = pendingDecision(parked)!;
    expect(decision.kind).toBe("SFD-136-ransom");
    expect(optionsFor(parked, decision).map((o) => o.id).sort()).toEqual(["decline", "pay"]);
  });

  /** Repeated and paid twice: 4 Energy total, and the spell lives. */
  it("repeated, it ransoms TWICE — pay both and the spell survives", () => {
    const { state, bargainId, victimId } = chainWithVictim(8);
    const play = playsOf(state, bargainId).find((a) => a.repeatPaid && a.targetChainCardInstanceId === victimId)!;
    const parked = untilDecision(accept(state, play));

    expect(parked.pendingDecisions.filter((d) => d.kind === "SFD-136-ransom"), "two ransoms").toHaveLength(2);

    const after = answerDecisions(parked, (options) => (options.find((o) => o.id === "pay") ?? options[0]!).id);
    expect(chainHas(after, victimId)).toBe(true);
    expect(after.players[1]!.channeled.filter((r) => r.state === "Exhausted"), "2 + 2").toHaveLength(4);
  });

  /**
   * Decline the FIRST ransom and the spell is countered; the second question
   * then has no subject. It must not counter anything again, and must not charge
   * a second ransom for a spell that is already gone — which is why the decision
   * re-checks the chain at answer time rather than trusting its stored target.
   */
  it("repeated, declining the first leaves the second with nothing to counter", () => {
    const { state, bargainId, victimId } = chainWithVictim(8);
    const play = playsOf(state, bargainId).find((a) => a.repeatPaid && a.targetChainCardInstanceId === victimId)!;
    const parked = untilDecision(accept(state, play));

    // Decline everything: the first counters, the second must no-op.
    const after = answerDecisions(parked, (options) => options[0]!.id);
    expect(chainHas(after, victimId)).toBe(false);
    // And nothing was charged for the second, dead question.
    expect(after.players[1]!.channeled.filter((r) => r.state === "Exhausted")).toHaveLength(0);
  });

  /**
   * **The counter that empties the chain must return the turn to an Open State**
   * — 334 ("the turn is said to be in an Open State if no Chain exists") and 345
   * Step 4 ("if the Chain is empty, play proceeds in an Open State").
   *
   * Hard Bargain is the first card that can empty the chain from OUTSIDE a chain
   * resolution. An ordinary counter removes its victim while its own entry is
   * still on the chain, so the pop that follows sees the chain empty and reopens
   * it; this card's counter fires when the RANSOM IS ANSWERED, which is after
   * Hard Bargain itself has already been popped. The last item then disappears
   * with nobody about to pop anything, and the chain was left closed and empty —
   * a state the rules have no name for, in which the next PassFocus pops
   * `undefined` and the engine throws.
   *
   * Found by `DECKS=sfd`, not by this suite: the fixtures above assign
   * `spellChain` directly and leave `chainOpen` at its default `true`, so none of
   * them was ever a genuinely closed chain. A real game reaches it in one line.
   *
   * Focus does NOT pass here, and that is the reason `counterSpell` reopens the
   * chain itself rather than calling the pop path: 346 passes Focus when the last
   * item RESOLVES, and a countered spell never resolves.
   */
  it("countering the LAST chain item returns the turn to an Open State", () => {
    const { state, bargainId, victimId } = chainWithVictim(8);
    const play = playsOf(state, bargainId).find((a) => !a.repeatPaid && a.targetChainCardInstanceId === victimId)!;
    const after = answerDecisions(untilDecision(accept(state, play)));

    expect(after.spellChain, "the chain should be empty").toHaveLength(0);
    expect(after.chainOpen, "an empty chain left CLOSED — the next pass pops nothing").toBe(true);
    expect(after.chainPasses, "stale passes carried into the open state").toBe(0);
    // The symptom, not just the cause: the very next pass used to throw.
    const pass = legalActions(after).find((a) => a.type === "PassFocus");
    if (pass) expect(() => submit(after, pass)).not.toThrow();
  });
});

/**
 * Thwonk! (SFD-040) — "[Action] [Repeat] [2] Stun an attacking unit."
 *
 * The first card that targets by combat DESIGNATION (464.2.c Step 1) rather than by
 * owner, Might or zone. The restriction lives in the SPEC, so a board with
 * nobody attacking makes the card UNCASTABLE rather than castable-and-inert —
 * and that negative is the assertion worth having, because a resolver-level
 * check would pass a "it stunned nothing" test just as happily.
 */
describe("Thwonk! targets by combat designation", () => {
  /** p1 has contested bf1, so p1's unit there is the ATTACKER and p0's is not. */
  function showdown() {
    const { state, spellId } = caster("SFD-040", "Calm", 10);
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      contestedByIndex: 1,
      units: {
        [state.players[0]!.id]: [makeUnit({ name: "Defender", instanceId: "defender", might: 3 })],
        [state.players[1]!.id]: [makeUnit({ name: "Attacker", instanceId: "attacker", might: 3 })],
      },
    };
    return { state, spellId };
  }

  it("offers the attacker and NOT the defender", () => {
    const { state, spellId } = showdown();
    const targets = playsOf(state, spellId).map((a) => a.targetUnitInstanceId);

    expect(targets, "the attacker was not offered").toContain("attacker");
    expect(targets, "a DEFENDER was offered as an attacking unit").not.toContain("defender");
  });

  /** A bystander at an UNCONTESTED battlefield is attacking nobody. */
  it("does not offer a unit at a battlefield nobody is contesting", () => {
    const { state, spellId } = showdown();
    state.battlefields[1] = {
      ...state.battlefields[1]!,
      units: { [state.players[1]!.id]: [makeUnit({ name: "Idler", instanceId: "idler", might: 3 })] },
    };
    const targets = playsOf(state, spellId).map((a) => a.targetUnitInstanceId);

    expect(targets).toContain("attacker");
    expect(targets, "an uncontested bystander was offered").not.toContain("idler");
  });

  /**
   * The negative that decides where the restriction lives: with nobody
   * attacking, the card must not be castable at all. A resolver-level check
   * would leave it castable and inert, which for a Spell means paid-for and
   * wasted.
   */
  it("is UNCASTABLE with nobody attacking", () => {
    const { state, spellId } = caster("SFD-040", "Calm", 10);
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      contestedByIndex: null,
      units: { [state.players[1]!.id]: [makeUnit({ name: "Idler", instanceId: "idler", might: 3 })] },
    };

    expect(playsOf(state, spellId), "castable with no attacker to stun").toHaveLength(0);
  });

  it("stuns the attacker it names", () => {
    const { state, spellId } = showdown();
    const play = playsOf(state, spellId).find((a) => !a.repeatPaid && a.targetUnitInstanceId === "attacker")!;
    const after = resolveChain(accept(state, play));

    const at = after.battlefields[0]!.units[after.players[1]!.id]!.find((u) => u.instanceId === "attacker")!;
    expect(at.stunned).toBe(true);
  });

  /**
   * A second stun on the SAME unit is redundant — `stunned` is a flag, not a
   * counter — so repeating Thwonk! earns its cost only by naming a different
   * attacker, which 820.1.d expressly allows.
   */
  it("repeated onto a second attacker, it stuns both", () => {
    const { state, spellId } = showdown();
    state.battlefields[0]!.units[state.players[1]!.id] = [
      makeUnit({ name: "Attacker", instanceId: "attacker", might: 3 }),
      makeUnit({ name: "Attacker2", instanceId: "attacker2", might: 3 }),
    ];

    const base = playsOf(state, spellId).find((a) => a.repeatPaid && a.targetUnitInstanceId === "attacker")!;
    const play: PlayCardAction = { ...base, repeatChoices: { targetUnitInstanceId: "attacker2" } };
    expect(validatePlayCard(state, play)).toMatchObject({ ok: true });

    const after = resolveChain(accept(state, play));
    const units = after.battlefields[0]!.units[after.players[1]!.id]!;
    expect(units.find((u) => u.instanceId === "attacker")!.stunned).toBe(true);
    expect(units.find((u) => u.instanceId === "attacker2")!.stunned).toBe(true);
  });

  /** And the repeat's own choice is checked by the same designation rule. */
  it("refuses a repeat choice that is not attacking", () => {
    const { state, spellId } = showdown();
    const base = playsOf(state, spellId).find((a) => a.repeatPaid && a.targetUnitInstanceId === "attacker")!;
    const play: PlayCardAction = { ...base, repeatChoices: { targetUnitInstanceId: "defender" } };

    const result = validatePlayCard(state, play);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("ATTACKING");
  });
});

/**
 * Bellows Breath (SFD-080) — "[Action] [Repeat] [1][Mind] Deal 1 to up to three
 * units at the same LOCATION."
 *
 * The word is the card. Rule **828**: "Locations include the Battlefields and
 * the Bases", so `sameLocation` is strictly wider than the existing
 * `sameBattlefield` — three units in one base are a legal group, and each base
 * is its own location so one unit in each base is not.
 */
describe("Bellows Breath groups by LOCATION, which includes bases", () => {
  /** Two units in p0's base, two in p1's base, two at bf1. */
  function spread() {
    const { state, spellId } = caster("SFD-080", "Mind", 10);
    state.players[0]!.baseUnits = [
      makeUnit({ name: "Mine1", instanceId: "mine1", might: 5 }),
      makeUnit({ name: "Mine2", instanceId: "mine2", might: 5 }),
    ];
    state.players[1]!.baseUnits = [makeUnit({ name: "Theirs1", instanceId: "theirs1", might: 5 })];
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      units: {
        [state.players[0]!.id]: [makeUnit({ name: "Front1", instanceId: "front1", might: 5 })],
        [state.players[1]!.id]: [makeUnit({ name: "Front2", instanceId: "front2", might: 5 })],
      },
    };
    return { state, spellId };
  }

  const sets = (state: GameState, spellId: string) =>
    playsOf(state, spellId).map((a) => [...(a.targetUnitInstanceIds ?? [])].sort().join(","));

  /** The assertion `sameBattlefield` would have failed: a base IS a location. */
  it("accepts a group standing in one BASE", () => {
    const { state, spellId } = spread();
    expect(sets(state, spellId), "two units in the same base were not offered as a group").toContain("mine1,mine2");
  });

  it("accepts a group at one battlefield, across both sides", () => {
    const { state, spellId } = spread();
    expect(sets(state, spellId)).toContain("front1,front2");
  });

  /** Each base is its OWN location — the negative that keeps `sameLocation` from
   *  degenerating into "anywhere". */
  it("refuses a unit from each base — two bases are two locations", () => {
    const { state, spellId } = spread();
    expect(sets(state, spellId), "units in DIFFERENT bases were grouped").not.toContain("mine1,theirs1");
    // And validation agrees with enumeration, which is the pair that matters.
    const base = playsOf(state, spellId)[0]!;
    const illegal: PlayCardAction = { ...base, targetUnitInstanceIds: ["mine1", "theirs1"] };
    expect(validatePlayCard(state, illegal)).toMatchObject({ ok: false });
  });

  it("refuses a base unit grouped with a battlefield unit", () => {
    const { state, spellId } = spread();
    expect(sets(state, spellId)).not.toContain("front1,mine1");
  });

  it("deals 1 to each unit it names", () => {
    const { state, spellId } = spread();
    const play = playsOf(state, spellId).find(
      (a) => !a.repeatPaid && [...(a.targetUnitInstanceIds ?? [])].sort().join(",") === "mine1,mine2",
    )!;
    const after = resolveChain(accept(state, play));

    for (const id of ["mine1", "mine2"]) {
      expect(after.players[0]!.baseUnits.find((u) => u.instanceId === id)!.damage, id).toBe(1);
    }
  });

  /** "Up to three" means zero is a legal choice — the card is castable on an
   *  empty board and does nothing. */
  it("is castable with no units at all", () => {
    const { state, spellId } = caster("SFD-080", "Mind", 10);
    expect(playsOf(state, spellId).length, "an empty board made it uncastable").toBeGreaterThan(0);
  });

  /** Repeated, the second execution may name a group at a DIFFERENT location. */
  it("repeated, it may hit a different location the second time", () => {
    const { state, spellId } = spread();
    const base = playsOf(state, spellId).find(
      (a) => a.repeatPaid && [...(a.targetUnitInstanceIds ?? [])].sort().join(",") === "mine1,mine2",
    )!;
    const play: PlayCardAction = { ...base, repeatChoices: { targetUnitInstanceIds: ["front1", "front2"] } };
    expect(validatePlayCard(state, play)).toMatchObject({ ok: true });

    const after = resolveChain(accept(state, play));
    expect(after.players[0]!.baseUnits.find((u) => u.instanceId === "mine1")!.damage).toBe(1);
    const atBf = after.battlefields[0]!;
    expect(atBf.units[after.players[0]!.id]!.find((u) => u.instanceId === "front1")!.damage).toBe(1);
    expect(atBf.units[after.players[1]!.id]!.find((u) => u.instanceId === "front2")!.damage).toBe(1);
  });
});

/**
 * Temptation (SFD-129) — "[Repeat] [2] Move an enemy unit to a location where
 * there's a unit with the same controller."
 *
 * The pool's first RESTRICTED move destination. "The same controller" is the
 * MOVED unit's controller, not the caster's, so the card lures an enemy toward
 * its own friends — and the negatives are what prove the predicate reads the
 * right side of the board.
 */
describe("Temptation restricts where the moved unit may go", () => {
  /**
   * p1 (the enemy) has a lone unit at bf1 and a second unit at bf2, so bf2 is a
   * legal destination for the lone one and bf1 is not (it is already there).
   * p0 also has a unit at bf3-equivalent — here, at bf1 — to prove the predicate
   * does not accept "a unit with the CASTER's controller".
   */
  function board() {
    const { state, spellId } = caster("SFD-129", "Chaos", 10);
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      units: {
        [state.players[1]!.id]: [makeUnit({ name: "Lonely", instanceId: "lonely", might: 3 })],
        [state.players[0]!.id]: [makeUnit({ name: "Mine", instanceId: "mine", might: 3 })],
      },
    };
    state.battlefields[1] = {
      ...state.battlefields[1]!,
      units: { [state.players[1]!.id]: [makeUnit({ name: "Friend", instanceId: "friend", might: 3 })] },
    };
    return { state, spellId };
  }

  const destinationsFor = (state: GameState, spellId: string, unitId: string) =>
    playsOf(state, spellId)
      .filter((a) => a.targetUnitInstanceId === unitId)
      .map((a) => a.destinationBattlefieldId);

  it("offers the battlefield where the moved unit's controller already has one", () => {
    const { state, spellId } = board();
    expect(destinationsFor(state, spellId, "lonely")).toContain("bf2");
  });

  /**
   * The negative that proves the predicate reads the MOVED unit's controller
   * rather than the caster's: p0 has a unit at bf1, and that must not make bf1 a
   * legal destination for p1's unit. (bf1 is also where `lonely` already stands,
   * so this doubles as the no-op-move check.)
   */
  it("does not accept a battlefield where only the CASTER has a unit", () => {
    const { state, spellId } = board();
    // Move `friend` (at bf2) — bf1 holds one of p0's units and one of p1's...
    // so it IS legal for friend. Use a third, empty battlefield instead.
    expect(destinationsFor(state, spellId, "friend")).toContain("bf1"); // p1's `lonely` is there
    // And the caster's own unit alone is not enough: strip p1 from bf1.
    const onlyCaster = {
      ...state,
      battlefields: state.battlefields.map((bf, i) =>
        i === 0 ? { ...bf, units: { [state.players[0]!.id]: bf.units[state.players[0]!.id]! } } : bf,
      ),
    };
    expect(
      destinationsFor(onlyCaster, spellId, "friend"),
      "a battlefield holding only the CASTER's unit was offered",
    ).not.toContain("bf1");
  });

  it("offers no destination at all when the enemy has nowhere with a friend", () => {
    const { state, spellId } = caster("SFD-129", "Chaos", 10);
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      units: { [state.players[1]!.id]: [makeUnit({ name: "Alone", instanceId: "alone", might: 3 })] },
    };
    expect(playsOf(state, spellId), "castable with nowhere legal to move to").toHaveLength(0);
  });

  it("moves the unit it names", () => {
    const { state, spellId } = board();
    const play = playsOf(state, spellId).find(
      (a) => !a.repeatPaid && a.targetUnitInstanceId === "lonely" && a.destinationBattlefieldId === "bf2",
    )!;
    const after = resolveChain(accept(state, play));

    const p1 = after.players[1]!.id;
    expect(after.battlefields[0]!.units[p1] ?? []).toHaveLength(0);
    expect((after.battlefields[1]!.units[p1] ?? []).map((u) => u.instanceId).sort()).toEqual(["friend", "lonely"]);
  });

  /** The validator re-derives the restriction rather than trusting the action. */
  it("refuses a hand-built action naming an illegal destination", () => {
    const { state, spellId } = board();
    const base = playsOf(state, spellId).find((a) => a.targetUnitInstanceId === "lonely")!;
    const empty: PlayCardAction = { ...base, destinationBattlefieldId: "bf2" };
    expect(validatePlayCard(state, empty)).toMatchObject({ ok: true });

    // Strip p1's unit from bf2 and the same destination becomes illegal.
    const stripped: GameState = {
      ...state,
      battlefields: state.battlefields.map((bf, i) => (i === 1 ? { ...bf, units: {} } : bf)),
    };
    const result = validatePlayCard(stripped, empty);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("already has one");
  });
});

/**
 * Rocket Barrage (SFD-077) — "[Repeat] [4][Mind] Choose one — Deal 4 to a unit
 * in a base. [or] Kill a gear."
 *
 * The pool's first MODAL card, and the one 820.1.d works its own example on:
 *
 *   "If Rocket Barrage's controller pays its Repeat cost as they play it, they
 *   may choose the same mode OR A DIFFERENT ONE, and if they choose the same
 *   mode, may choose the same target or a different one. If they choose 'Kill a
 *   gear' twice and choose two different gear, they must specify which gear is
 *   the first target and which is the second."
 *
 * So the mode is a choice that rides the action, AND part of the repeat's own
 * choice set. Both halves are asserted below.
 */
describe("Rocket Barrage is modal, and its repeat may switch modes", () => {
  function board() {
    const { state, spellId } = caster("SFD-077", "Mind", 14);
    state.players[1]!.baseUnits = [makeUnit({ name: "Homebody", instanceId: "homebody", might: 9 })];
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      units: { [state.players[1]!.id]: [makeUnit({ name: "Frontliner", instanceId: "frontliner", might: 9 })] },
    };
    state.players[1]!.activeGear = [
      { ...spellInstance("SFD-078"), kind: "Gear" } as never, // Temporal Portal, as a body to kill
    ];
    return { state, spellId };
  }

  it("offers BOTH modes, each with its own targets", () => {
    const { state, spellId } = board();
    const plays = playsOf(state, spellId);

    const damage = plays.filter((a) => a.modeId === "damage");
    const kill = plays.filter((a) => a.modeId === "killGear");
    expect(damage.length, "the damage mode was not offered").toBeGreaterThan(0);
    expect(kill.length, "the kill-a-gear mode was not offered").toBeGreaterThan(0);
    // Every emitted play names a mode — a modal card has no unnamed variant.
    expect(plays.every((a) => a.modeId !== undefined)).toBe(true);
  });

  /**
   * "A unit IN A BASE" is the narrowest scope in the engine. The negative is the
   * assertion with information in it: a unit at a battlefield must not be
   * offered, which is the opposite of the usual restriction.
   */
  it("the damage mode reaches a base and NOT a battlefield", () => {
    const { state, spellId } = board();
    const targets = playsOf(state, spellId)
      .filter((a) => a.modeId === "damage")
      .map((a) => a.targetUnitInstanceId);

    expect(targets).toContain("homebody");
    expect(targets, "a unit at a battlefield was offered to a base-only mode").not.toContain("frontliner");
  });

  /** And the gear mode offers gear only — not the units `unitOrGear` would add. */
  it("the kill mode offers gear and nothing else", () => {
    const { state, spellId } = board();
    const kill = playsOf(state, spellId).filter((a) => a.modeId === "killGear");

    expect(kill.every((a) => a.targetPermanentInstanceId !== undefined)).toBe(true);
    expect(kill.map((a) => a.targetPermanentInstanceId)).not.toContain("homebody");
  });

  it("resolves the mode it was told to", () => {
    const { state, spellId } = board();
    const play = playsOf(state, spellId).find((a) => a.modeId === "damage" && !a.repeatPaid)!;
    const after = resolveChain(accept(state, play));

    expect(after.players[1]!.baseUnits.find((u) => u.instanceId === "homebody")!.damage).toBe(4);
    expect(after.players[1]!.activeGear, "the gear died on a play that chose damage").toHaveLength(1);
  });

  /** **The rulebook's own example.** Damage first, then switch to killing a gear. */
  it("a repeat may choose a DIFFERENT mode", () => {
    const { state, spellId } = board();
    const gearId = state.players[1]!.activeGear[0]!.instanceId;
    const base = playsOf(state, spellId).find((a) => a.repeatPaid && a.modeId === "damage")!;
    const play: PlayCardAction = { ...base, repeatChoices: { modeId: "killGear", targetPermanentInstanceId: gearId } as never };
    expect(validatePlayCard(state, play)).toMatchObject({ ok: true });

    const after = resolveChain(accept(state, play));
    expect(after.players[1]!.baseUnits.find((u) => u.instanceId === "homebody")!.damage, "mode 1 ran").toBe(4);
    expect(after.players[1]!.activeGear, "mode 2 ran on the repeat").toHaveLength(0);
  });

  /** Naming a mode on a card that has none is refused, not ignored. */
  it("refuses a mode on a non-modal card", () => {
    const { state, spellId } = caster(FERAL_STRENGTH, "Calm", 8, 1);
    const base = playsOf(state, spellId)[0]!;
    const result = validatePlayCard(state, { ...base, modeId: "damage" });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("not modal");
  });

  it("refuses an unknown mode id", () => {
    const { state, spellId } = board();
    const base = playsOf(state, spellId)[0]!;
    const result = validatePlayCard(state, { ...base, modeId: "nonsense" });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("no mode");
  });

  /** A repeat that switches modes has its targets checked against THAT mode. */
  it("checks a mode-switched repeat's targets against the mode it switched to", () => {
    const { state, spellId } = board();
    const base = playsOf(state, spellId).find((a) => a.repeatPaid && a.modeId === "damage")!;
    // "killGear" mode with a UNIT named — illegal for that mode.
    const play: PlayCardAction = {
      ...base,
      repeatChoices: { modeId: "killGear", targetPermanentInstanceId: "homebody" } as never,
    };

    const result = validatePlayCard(state, play);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("not a gear");
  });
});

describe("the second execution makes its OWN choices (820.1.d)", () => {
  /**
   * **The test that rejects the flag-only design.**
   *
   * 820.1.d: "Choices made for the additional execution do not have to be the
   * same as the choices made for the initial execution." So a repeated Feral
   * Strength may pump two DIFFERENT units for +2 each, rather than one unit for
   * +4. Under an implementation that carried only a boolean, `ally1` would be
   * untouched and `ally0` would be at 7.
   */
  it("Feral Strength may pump a different unit the second time", () => {
    const { state, spellId } = caster(FERAL_STRENGTH, "Calm", 8, 2);
    const base = playsOf(state, spellId).find((a) => a.repeatPaid && a.targetUnitInstanceId === "ally0")!;
    const play: PlayCardAction = { ...base, repeatChoices: { targetUnitInstanceId: "ally1" } };
    expect(validatePlayCard(state, play)).toMatchObject({ ok: true });

    const after = resolveChain(accept(state, play));
    const ally0 = after.players[0]!.baseUnits.find((u) => u.instanceId === "ally0")!;
    const ally1 = after.players[0]!.baseUnits.find((u) => u.instanceId === "ally1")!;
    expect(effectiveMight(after, ally0, 0, { isCombat: false })).toBe(5);
    expect(effectiveMight(after, ally1, 0, { isCombat: false })).toBe(5);
  });

  it("Bonds of Strength may name a different PAIR, spreading +1 over four units", () => {
    const { state, spellId } = caster(BONDS_OF_STRENGTH, "Order", 10, 4);
    const base = playsOf(state, spellId).find(
      (a) => a.repeatPaid && a.targetUnitInstanceId === "ally0" && a.secondTargetUnitInstanceId === "ally1",
    )!;
    const play: PlayCardAction = {
      ...base,
      repeatChoices: { targetUnitInstanceId: "ally2", secondTargetUnitInstanceId: "ally3" },
    };
    expect(validatePlayCard(state, play)).toMatchObject({ ok: true });

    const after = resolveChain(accept(state, play));
    for (const id of ["ally0", "ally1", "ally2", "ally3"]) {
      const unit = after.players[0]!.baseUnits.find((u) => u.instanceId === id)!;
      expect(effectiveMight(after, unit, 0, { isCombat: false }), `${id}`).toBe(4);
    }
  });

  /**
   * The second choice set is checked by the SAME function as the first, so it
   * cannot accept a target the first would reject. Bonds of Strength's slots are
   * both "friendly"; naming an enemy in the repeat set must fail.
   */
  it("an illegal second choice is refused, by the same checks as the first", () => {
    const { state, spellId } = caster(BONDS_OF_STRENGTH, "Order", 10, 2);
    state.players[1]!.baseUnits = [makeUnit({ name: "Foe", instanceId: "foe", might: 3 })];
    const base = playsOf(state, spellId).find((a) => a.repeatPaid)!;
    const play: PlayCardAction = {
      ...base,
      repeatChoices: { targetUnitInstanceId: "foe", secondTargetUnitInstanceId: "ally1" },
    };

    const result = validatePlayCard(state, play);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("[Repeat]");
  });

  /**
   * Choices for a repeat that was never paid for would be silently dropped at
   * resolution — the dropped-field shape this pipeline has shipped before. It is
   * refused rather than ignored.
   */
  it("naming repeat choices without paying the repeat cost is refused", () => {
    const { state, spellId } = caster(FERAL_STRENGTH, "Calm", 8, 2);
    const base = playsOf(state, spellId).find((a) => !a.repeatPaid && a.targetUnitInstanceId === "ally0")!;
    const play: PlayCardAction = { ...base, repeatChoices: { targetUnitInstanceId: "ally1" } };

    expect(validatePlayCard(state, play)).toMatchObject({ ok: false });
  });

  it("claiming [Repeat] on a card that does not print it is refused", () => {
    // Smoke Screen (OGN-093) — a plain targeted Mind spell with no [Repeat] and,
    // unlike Sudden Storm, no [Hidden] to be rejected on timing first.
    const { state, spellId } = caster("OGN-093", "Mind", 10, 1);
    const base = playsOf(state, spellId)[0]!;
    const play: PlayCardAction = { ...base, repeatPaid: true };

    const result = validatePlayCard(state, play);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("does not have [Repeat]");
  });

  /**
   * **The repeat may DECLINE an optional slot the first execution filled.**
   *
   * Piercing Light is "Deal 2 to a unit at a battlefield, then deal 2 to up to
   * one OTHER unit" — the second slot is genuinely optional each time (`min: 1`).
   * So a caster may hit two units, then repeat onto only the first.
   *
   * This is the case that decides `repeatChoices`' merge semantics. It WHOLLY
   * REPLACES the choice fields rather than merging: under a field-by-field merge
   * the omitted second target would silently inherit the first execution's, and
   * `back` would take 4 instead of the 2 the caster actually named.
   */
  it("Piercing Light's repeat may decline the optional second slot", () => {
    const { state, spellId } = caster(PIERCING_LIGHT, "Fury", 12);
    state.battlefields[0]!.units["p1"] = [
      makeUnit({ name: "Front", instanceId: "front", might: 10 }),
      makeUnit({ name: "Back", instanceId: "back", might: 10 }),
    ];

    const base = playsOf(state, spellId).find(
      (a) => a.repeatPaid && a.targetUnitInstanceId === "front" && a.secondTargetUnitInstanceId === "back",
    )!;
    // The second execution names ONLY the first slot — the "up to one other" is
    // declined this time round.
    const play: PlayCardAction = { ...base, repeatChoices: { targetUnitInstanceId: "front" } };
    expect(validatePlayCard(state, play)).toMatchObject({ ok: true });

    const after = resolveChain(accept(state, play));
    const at = (id: string) => after.battlefields[0]!.units["p1"]!.find((u) => u.instanceId === id)!;
    expect(at("front").damage, "front: 2 from each execution").toBe(4);
    expect(at("back").damage, "back: hit once, NOT inherited by the repeat").toBe(2);
  });

  /**
   * Marching Orders scopes its two slots differently from Challenge, which is
   * the one word that separates the cards: the enemy must be AT A BATTLEFIELD.
   * The negative is the assertion with information in it — an enemy sitting in
   * its own base is not a legal second target here, though it is for Challenge.
   */
  it("Marching Orders will not duel an enemy standing in its own base", () => {
    const { state, spellId } = caster(MARCHING_ORDERS, "Body", 10, 1);
    state.players[1]!.baseUnits = [makeUnit({ name: "Homebody", instanceId: "homebody", might: 4 })];

    const plays = playsOf(state, spellId);
    expect(
      plays.some((a) => a.secondTargetUnitInstanceId === "homebody"),
      "offered an enemy in base as a duellist",
    ).toBe(false);
    // And with no enemy at a battlefield at all, the card is uncastable (min: 2).
    expect(plays).toHaveLength(0);
  });

  it("Marching Orders duels twice when repeated, reading Mights before dealing", () => {
    const { state, spellId } = caster(MARCHING_ORDERS, "Body", 10, 1);
    state.battlefields[0]!.units["p2"] = [makeUnit({ name: "Foe", instanceId: "foe", might: 9 })];

    const play = playsOf(state, spellId).find(
      (a) => a.repeatPaid && a.targetUnitInstanceId === "ally0" && a.secondTargetUnitInstanceId === "foe",
    )!;
    const after = resolveChain(accept(state, play));

    // ally0 is 3 Might, foe is 9. First duel: foe takes 3, ally takes 9 and dies
    // (3 Might, 9 damage). The SECOND execution then finds its friendly duellist
    // gone — 359.3 ignores a check on something no longer available — so foe
    // takes nothing further and is left on the 3 from the first exchange.
    expect(after.players[0]!.baseUnits.find((u) => u.instanceId === "ally0")).toBeUndefined();
    expect(after.battlefields[0]!.units["p2"]!.find((u) => u.instanceId === "foe")!.damage).toBe(3);
  });

  /**
   * Omitting `repeatChoices` entirely is legal and means "the same choices
   * again" — that is what the enumerator samples, and the first execution's
   * targets must actually be reused rather than dropped.
   */
  it("omitting the second choice set repeats the first one's targets", () => {
    const { state, spellId } = caster(FERAL_STRENGTH, "Calm", 8, 2);
    const play = playsOf(state, spellId).find((a) => a.repeatPaid && a.targetUnitInstanceId === "ally0")!;
    expect(play.repeatChoices).toBeUndefined();

    const after = resolveChain(accept(state, play));
    const ally0 = after.players[0]!.baseUnits.find((u) => u.instanceId === "ally0")!;
    const ally1 = after.players[0]!.baseUnits.find((u) => u.instanceId === "ally1")!;
    expect(effectiveMight(after, ally0, 0, { isCombat: false })).toBe(7);
    expect(effectiveMight(after, ally1, 0, { isCombat: false })).toBe(3); // untouched
  });
});

/**
 * The four Unleashed cards priced on 2026-08-09.
 *
 * Their effects were written by four separate wave-2 agents, in four domain
 * files, none of which could add a `REPEAT_COSTS` row (shared file). Each agent
 * independently reported the same consequence: with no row, the enumerator never
 * offers a repeat-paid variant, so the `[Repeat]` is inert — while coverage
 * reports the card fully implemented, because the keyword no longer greys a card.
 *
 * **That is a coverage LIE, and worse than a refusal**, which at least shows up
 * as unfinished. Adding the rows fixes it, but it also turns ON behaviour none of
 * those agents could test, so the variant is verified here rather than assumed to
 * follow from the row.
 */
describe("the Unleashed [Repeat] cards actually offer their repeat", () => {
  const UNL_REPEATS = [
    { defId: "UNL-009", domain: "Fury" as const, name: "Upstage Comedy" },
    { defId: "UNL-032", domain: "Calm" as const, name: "Double Trouble" },
    { defId: "UNL-061", domain: "Mind" as const, name: "Downstage Dramatics" },
    { defId: "UNL-134", domain: "Chaos" as const, name: "Existential Dread" },
  ];

  for (const { defId, domain, name } of UNL_REPEATS) {
    it(`${name} offers a repeat-paid variant, at printed + 2`, () => {
      // Plenty of runes and a couple of friendly bodies, so nothing here fails for
      // want of a legal target rather than for want of the repeat variant.
      const { state, spellId } = caster(defId, domain, 10, 2);
      // ...and a CONTESTED battlefield, because Existential Dread targets by
      // combat designation (`attackingOnly`, Thwonk!'s spec) and is UNCASTABLE
      // with nobody attacking. My first fixture had no showdown and enumerated
      // zero plays; the positive control below is what said so, instead of the
      // three cost assertions all passing vacuously on an empty list.
      state.battlefields[0] = {
        ...state.battlefields[0]!,
        contestedByIndex: 1,
        units: {
          [state.players[0]!.id]: [makeUnit({ name: "Defender", instanceId: "def1", might: 3 })],
          [state.players[1]!.id]: [makeUnit({ name: "Attacker", instanceId: "atk1", might: 3 })],
        },
      };
      const plays = playsOf(state, spellId);

      // The positive control FIRST: an empty candidate list would make every
      // assertion below vacuously true, and a card with no legal target enumerates
      // exactly that.
      expect(plays.length, `${name} enumerated no plays at all — the fixture is wrong, not the card`).toBeGreaterThan(0);

      const plain = plays.find((a) => !a.repeatPaid);
      const repeated = plays.find((a) => a.repeatPaid);
      expect(plain, `${name} offers no plain variant — 820.1 makes the repeat OPTIONAL`).toBeDefined();
      expect(repeated, `${name}'s [Repeat] is inert — no repeat-paid variant enumerated`).toBeDefined();

      // The printed cost plus exactly the table's 2, which is what makes this a
      // check on the PRICING rather than on the flag being set somewhere.
      expect(repeated!.payment.energyRunes.length - plain!.payment.energyRunes.length).toBe(2);
    });
  }
});

/**
 * Desert's Call now offers a DESTINATION, like every other token-playing spell.
 *
 * It sat outside `TOKEN_PLACEMENT_SPELL_DEF_IDS` while Sprite Call — which prints
 * the identical shape, "Play a [N] Might [X] unit token" with no destination
 * clause — sat inside it. Two cards saying the same thing behaved differently,
 * which meant one was wrong regardless of which rule you preferred.
 *
 * 185.2.a settles it: tokens are played "following all the applicable steps for
 * playing a card plus any restrictions or modifications from the effect that
 * created the token", and the inherent restriction on playing a Unit is "base or
 * a battlefield they control". Desert's Call restricts nothing, so the choice
 * exists. Sprite Call was right.
 *
 * **This is a behaviour change in SFD, a declared-complete set**, made on the
 * project owner's call rather than folded into a card wave.
 */
describe("Desert's Call places its token where the caster chooses", () => {
  it("offers a battlefield the caster controls, not only base", () => {
    const { state, spellId } = caster(DESERTS_CALL, "Calm", 8);
    state.battlefields[0] = { ...state.battlefields[0]!, controllerId: "p1" };

    const destinations = playsOf(state, spellId).map((a) => a.destinationBattlefieldId ?? "base");
    expect(destinations.length, "the spell enumerated nothing — this asserts nothing").toBeGreaterThan(0);
    expect(new Set(destinations), "no destination choice is offered — the token always lands in base").toContain("bf1");
    expect(new Set(destinations), "base stopped being an option").toContain("base");
  });

  it("and its [Repeat] still works alongside the new choice", () => {
    // The control on the change: adding a destination axis multiplies the
    // candidate list, and the repeat variant must survive that rather than be
    // crowded out. Both fan-outs ride `destinationBattlefieldId`.
    const { state, spellId } = caster(DESERTS_CALL, "Calm", 8);
    state.battlefields[0] = { ...state.battlefields[0]!, controllerId: "p1" };
    expect(playsOf(state, spellId).filter((a) => a.repeatPaid).length, "the repeat variant vanished").toBeGreaterThan(0);
  });
});
