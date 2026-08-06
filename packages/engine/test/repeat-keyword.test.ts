import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { repeatCostOf, repeatCostDefIds } from "../src/engine/card-effects.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { Domain } from "../src/model/domain.js";
import { makeState, makeUnit, spellInstance } from "./fixtures.js";

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
   * which is only sound while the two domains agree. They do for all fourteen —
   * so this asserts it card by card instead of leaving it as a comment. The day
   * a set prints a Repeat cost in a domain the card itself does not, this fails
   * and the pricing has to grow a third bucket.
   */
  it("every Repeat Power cost is in the card's own printed domain", () => {
    for (const defId of repeatCostDefIds()) {
      const spec = repeatCostOf(defId)!;
      if (spec.power === undefined) continue;
      const def = registry.get(defId);
      expect(spec.domain, `${defId} (${def.name}) Repeat domain`).toBe(def.powerDomain);
    }
  });

  /**
   * 820.1.c.2/c.3 — "if a spell or ability has more than one instance of Repeat,
   * each Cost may be paid or not paid individually... each Repeat Cost can be
   * paid only a single time."
   *
   * No card in this pool prints two, so the engine models ONE instance. That is
   * a premise, not an assumption: this fails the day a set prints two, which is
   * the day `repeatPaid` has to stop being a boolean.
   */
  it("no card prints two instances of [Repeat] — the premise the one-instance model rests on", () => {
    for (const defId of repeatCostDefIds()) {
      const def = registry.get(defId);
      const instances = (def.text ?? "").match(/\[Repeat\]/g) ?? [];
      expect(instances.length, `${defId} (${def.name}) prints ${instances.length} [Repeat]`).toBe(1);
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

  it("covers every card in the set that prints the keyword, and nothing else", () => {
    const printed = registry
      .all()
      .filter((def) => (def.text ?? "").includes("[Repeat]"))
      .map((def) => def.id)
      .sort();
    // Temporal Portal GRANTS Repeat and Marai Spire DISCOUNTS it; neither prints
    // a cost of its own, so neither is in the table.
    const granters = ["SFD-078", "SFD-211"];
    expect(printed.filter((id) => !granters.includes(id))).toEqual(repeatCostDefIds().sort());
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
   * A KEYWORD does not stack, and this is the negative that proves the engine
   * knows the difference. 817.1.a makes multiple instances of a keyword
   * redundant, so repeating Blood Rush is a legal way to waste 1 Energy — the
   * unit ends on [Assault 2], NOT [Assault 4].
   *
   * If a future change makes `grantKeywordThisTurn` accumulate instead of taking
   * a max, this is what fails.
   */
  it("a KEYWORD does not stack — 817.1.a makes the second instance redundant", () => {
    const { state, spellId } = caster(BLOOD_RUSH, "Fury", 8, 1);
    const play = playsOf(state, spellId).find((a) => a.repeatPaid && a.targetUnitInstanceId === "ally0")!;
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
