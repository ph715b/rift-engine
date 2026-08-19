import { describe, expect, it } from "vitest";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { RuneCard } from "../src/model/rune.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { cardModeOf, effectForCard } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { modifiedEnergyCost } from "../src/engine/cost-modifiers.js";
import { gearEntersExhausted } from "../src/engine/deploy.js";
import { empowerPermanent, isEmpowered } from "../src/engine/effect-helpers.js";
import { activatedAbilityFor } from "../src/engine/activated-abilities.js";
import { activatableGearTargets } from "../src/engine/target-lookup.js";
import { eventTriggerFor, holdEventTrigger } from "../src/engine/triggers.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { runEnd } from "../src/engine/turn-manager.js";
import {
  answerDecisions,
  makeState,
  makeUnit,
  playUnitTrigger,
  realGearInstance,
  realUnitInstance,
  resolveHeldTriggers,
  spellInstance,
} from "./fixtures.js";

/**
 * **Vendetta's Mind cards — the first wave, ten of the domain's nineteen.**
 *
 * The wave's shape is "a printed condition, asked in the right place". Six of the
 * ten do nothing unconditionally: Patched Porobot counts gear, Shock Blast and
 * Plaza Guardian price themselves off the board, Nasus fires once a turn, Swain
 * wants three different cards played first. So almost every test here comes in a
 * pair — the condition met, and the condition one short of met, which is the
 * boundary a fixture built only at the happy end can never see.
 *
 * # Two traps this wave walked into, both worth keeping
 *
 * **Coverage cannot see a half-written card.** Shock Blast and Hextech Formula
 * each reported implemented the moment their effect half landed, while their
 * printed cost discount and their enters-exhausted clause were still missing —
 * both in the direction that makes a card STRONGER than printed, which is the
 * direction that looks finished. Each is pinned here directly rather than left
 * to `isCardImplemented`.
 *
 * **Parentheses decide whether a sentence is a clause.** Patched Porobot's "(I
 * enter exhausted.)" is reminder text on a unit, which enters exhausted anyway;
 * Hextech Formula's "This enters exhausted." is a real replacement on a gear,
 * which does not. The two cards print the same words in the same wave and only
 * one of them owes a `deploy.ts` row.
 */

const registry = defaultCardRegistry();

/**
 * The printed Energy cost, NARROWED off the `CardDefinition` union.
 *
 * `CardDefinition` is a union whose Legend and battlefield members carry no
 * `energyCost`, so reading the field straight off `registry.get()` builds fine
 * (the build config excludes tests) and fails `npm run typecheck`, which does
 * not. That gap is documented in CLAUDE.md and this wave walked into it four
 * times; one narrowing helper is cheaper than a cast at each site.
 */
const printedEnergy = (defId: string): number => {
  const def = registry.get(defId);
  if (def.type === "Legend" || !("energyCost" in def)) throw new Error(`${defId} has no printed Energy cost`);
  return def.energyCost;
};

const printedKeywords = (defId: string): Partial<Record<string, number>> => {
  const def = registry.get(defId);
  return "keywords" in def ? (def.keywords as Partial<Record<string, number>>) : {};
};

const CLOUD_DRAKE = "VEN-048";
const DREDGE_UP = "VEN-049";
const ITERATIVE_DESIGN = "VEN-051";
const MESMERIZE = "VEN-052";
const PATCHED_POROBOT = "VEN-058";
const SHOCK_BLAST = "VEN-059";
const HEXTECH_FORMULA = "VEN-062";
const NASUS_GUARDIAN = "VEN-063";
const PLAZA_GUARDIAN = "VEN-064";
const SWAIN_VISIONARY = "VEN-065";

/** Any real gear, for the cards that only count them. */
const A_GEAR = "OGN-017";
/** A second, distinct gear def, so an "another gear" test has somewhere to point. */
const ANOTHER_GEAR = "OGN-101";

const runes = (n: number): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}`, domain: "Mind", state: "Ready" }) as RuneCard);

/** Resolves a Spell's registered effect — through `cardModeOf`, which normalises
 *  the modal and non-modal shapes into one list, so a test does not have to know
 *  which the card was written as. */
const resolveSpell = (state: GameState, defId: string, casterIndex: 0 | 1, event: Record<string, unknown> = {}) => {
  const mode = cardModeOf(spellInstance(defId), (event as { modeId?: string }).modeId);
  return mode!.resolve(state, contextFor(casterIndex, "src"), event as never);
};

/** A death-watch reaches the engine as a `unitDied` event trigger — see
 *  `deathWatchEventTriggers`. Tests drive it the way the engine does rather than
 *  through a second accessor that would not exist in play. */
const nasusWatch = () => eventTriggerFor(NASUS_GUARDIAN)!;
const diedEvent = (unit: UnitInstance, ownerIndex: 0 | 1, battlefieldId?: string) => ({
  kind: "unitDied" as const,
  death: { unit, ownerIndex, ...(battlefieldId === undefined ? {} : { battlefieldId }) },
});

describe("Cloud Drake (VEN-048) and Dredge Up (VEN-049): the wave's two cantrips", () => {
  it("Cloud Drake draws on play", () => {
    const state = makeState();
    state.players[0]!.deck = [spellInstance(DREDGE_UP), spellInstance(DREDGE_UP)];

    const after = playUnitTrigger(state, realUnitInstance(CLOUD_DRAKE), 0, "base", {});

    expect(after.players[0]!.hand).toHaveLength(1);
    expect(after.players[0]!.deck).toHaveLength(1);
  });

  it("Dredge Up draws, and its [Flow] needs no code of its own", () => {
    // 829.1.c.1's alternative cost is plumbed generically, and a card effect is
    // reached identically whichever price paid for it. The assertion that matters
    // is therefore that the card is REACHABLE from the trash at its Flow price,
    // which is the machinery, not the effect.
    const state = makeState();
    state.players[0]!.deck = [spellInstance(CLOUD_DRAKE)];

    expect(resolveSpell(state, DREDGE_UP, 0).players[0]!.hand).toHaveLength(1);
    expect(registry.get(DREDGE_UP), "the Flow price is gone").toMatchObject({ flowCost: expect.anything() });
  });
});

describe("Iterative Design (VEN-051): a shared Mech token", () => {
  it("plays a 3-Might Mech to base", () => {
    const after = resolveSpell(makeState(), ITERATIVE_DESIGN, 0);
    const [token] = after.players[0]!.baseUnits;

    expect(token, "no token was minted").toBeDefined();
    expect(token!.might).toBe(3);
    expect(token!.isToken).toBe(true);
    // The `Mech` tag is load-bearing: four keyword auras read it, and a Mech
    // without it is the only Mech on the board those auras do not reach.
    expect(token!.tags, "the Mech tag was dropped").toContain("Mech");
  });
});

describe("Mesmerize (VEN-052): a modal [Reaction]", () => {
  it("offers TWO modes, and they target different sides", () => {
    // The reason it is modal rather than one spec: a single spec could only
    // express the union of "a friendly unit" and "an enemy unit", and would offer
    // each half targets it cannot legally use.
    const card = spellInstance(MESMERIZE);
    expect(effectForCard(card)?.modes, "it was not written as a modal card at all").toHaveLength(2);
    const bounce = cardModeOf(card, "bounce");
    const shrink = cardModeOf(card, "shrink");

    expect(bounce?.targeting).toMatchObject({ kind: "unit", owner: "friendly" });
    expect(shrink?.targeting).toMatchObject({ kind: "unit", owner: "enemy" });
  });

  it("bounces a friendly unit to its owner's hand", () => {
    const state = makeState();
    const mine = makeUnit();
    state.battlefields[0]!.units = { p1: [mine] };

    const after = resolveSpell(state, MESMERIZE, 0, { modeId: "bounce", targetUnitInstanceId: mine.instanceId });

    expect(after.battlefields[0]!.units.p1 ?? []).toEqual([]);
    expect(after.players[0]!.hand.map((c) => c.instanceId)).toContain(mine.instanceId);
  });

  it("shrinks an enemy unit by 2 this turn, and it EXPIRES", () => {
    const state = makeState();
    const theirs = makeUnit();
    state.battlefields[0]!.units = { p2: [theirs] };

    const after = resolveSpell(state, MESMERIZE, 0, { modeId: "shrink", targetUnitInstanceId: theirs.instanceId });
    const shrunk = after.battlefields[0]!.units.p2![0]!;
    expect(shrunk.mightThisTurn).toBe(-2);

    // "This turn" is the Expiration Step (317), which runEnd gets for free.
    const next = runEnd({ ...after, phase: "Action" });
    expect(next.battlefields[0]!.units.p2![0]!.mightThisTurn, "the shrink outlived the turn").toBe(0);
  });

  it("is a [Reaction], which is what the card is bought for", () => {
    expect(registry.get(MESMERIZE)).toMatchObject({ isReaction: true });
  });
});

describe("Patched Porobot (VEN-058): three or more OTHER gear", () => {
  const withGear = (count: number): GameState => {
    const state = makeState();
    state.players[0]!.activeGear = Array.from({ length: count }, () => realGearInstance(A_GEAR));
    state.players[0]!.deck = [spellInstance(DREDGE_UP)];
    return state;
  };

  it("draws at THREE", () => {
    const after = playUnitTrigger(withGear(3), realUnitInstance(PATCHED_POROBOT), 0, "base", {});
    expect(after.players[0]!.hand).toHaveLength(1);
  });

  it("does NOT draw at two — the boundary", () => {
    // The pair. A fixture built only at the happy end cannot tell "3 or more"
    // from "1 or more", and this wave has six conditional cards.
    const after = playUnitTrigger(withGear(2), realUnitInstance(PATCHED_POROBOT), 0, "base", {});
    expect(after.players[0]!.hand, "two gear was enough").toEqual([]);
  });

  it("counts YOUR gear, not the opponent's", () => {
    const state = withGear(0);
    state.players[1]!.activeGear = Array.from({ length: 5 }, () => realGearInstance(A_GEAR));

    const after = playUnitTrigger(state, realUnitInstance(PATCHED_POROBOT), 0, "base", {});
    expect(after.players[0]!.hand, "the enemy's gear counted").toEqual([]);
  });

  it("owes NOTHING for its parenthesised '(I enter exhausted.)'", () => {
    // Reminder text on a unit, which enters exhausted anyway — unlike Hextech
    // Formula's unparenthesised sentence on a GEAR below. Pinned because the two
    // print the same words in the same wave.
    expect(gearEntersExhausted(PATCHED_POROBOT), "a unit was put in the GEAR table").toBe(false);
    expect(registry.get(PATCHED_POROBOT).text ?? "").toContain("(I enter exhausted.)");
  });
});

describe("Shock Blast (VEN-059): the discount is half the card", () => {
  const boardWith = (empowered: boolean): GameState => {
    const state = makeState();
    const gear = realGearInstance(A_GEAR);
    state.players[0]!.activeGear = [gear];
    return empowered ? empowerPermanent(state, gear.instanceId) : state;
  };

  it("costs 2 less while you control something Empowered", () => {
    const printed = printedEnergy(SHOCK_BLAST);
    expect(modifiedEnergyCost(boardWith(true), 0, "Spell", printed, SHOCK_BLAST)).toBe(printed - 2);
  });

  it("...and full price otherwise — the pair that makes the line mean anything", () => {
    const printed = printedEnergy(SHOCK_BLAST);
    expect(modifiedEnergyCost(boardWith(false), 0, "Spell", printed, SHOCK_BLAST)).toBe(printed);
  });

  it("reads 'SOMETHING', so an Empowered GEAR counts — not only a unit", () => {
    // The word the card prints, and the reason this test exists at all: a
    // predicate that walked only units would be silently wrong on exactly the
    // board this set builds toward, and a missing discount looks identical to one
    // that was never printed. The fixture above empowers a GEAR deliberately.
    const printed = printedEnergy(SHOCK_BLAST);
    const unitSide = makeState();
    const unit = makeUnit();
    unitSide.battlefields[0]!.units = { p1: [unit] };
    const withUnit = empowerPermanent(unitSide, unit.instanceId);

    expect(modifiedEnergyCost(withUnit, 0, "Spell", printed, SHOCK_BLAST), "an Empowered UNIT did not count").toBe(
      printed - 2,
    );
  });

  it("reads YOUR board", () => {
    const printed = printedEnergy(SHOCK_BLAST);
    const theirs = makeState();
    const gear = realGearInstance(A_GEAR);
    theirs.players[1]!.activeGear = [gear];

    expect(modifiedEnergyCost(empowerPermanent(theirs, gear.instanceId), 0, "Spell", printed, SHOCK_BLAST)).toBe(
      printed,
    );
  });

  it("deals 4 to a unit at a battlefield", () => {
    const state = makeState();
    const victim = makeUnit({ might: 9 });
    state.battlefields[0]!.units = { p2: [victim] };

    const after = resolveSpell(state, SHOCK_BLAST, 0, { targetUnitInstanceId: victim.instanceId });
    expect(after.battlefields[0]!.units.p2![0]!.damage).toBe(4);
  });
});

describe("Hextech Formula (VEN-062): empower ANOTHER gear", () => {
  function board(): { state: GameState; formula: ReturnType<typeof realGearInstance>; other: ReturnType<typeof realGearInstance> } {
    const state = makeState();
    const formula = realGearInstance(HEXTECH_FORMULA);
    const other = realGearInstance(ANOTHER_GEAR);
    state.players[0]!.activeGear = [formula, other];
    return { state, formula, other };
  }

  it("enters EXHAUSTED — the clause its parentheses-free sentence owes", () => {
    // Gear enter ready by default, so this is a real replacement on entry
    // (369.3). Without the row the card would be stronger than printed and would
    // look finished, which is the direction that hides.
    expect(gearEntersExhausted(HEXTECH_FORMULA)).toBe(true);
  });

  it("empowers another gear", () => {
    const { state, formula, other } = board();
    const ability = activatedAbilityFor(HEXTECH_FORMULA)!;
    expect(ability.resolve, "the ability has no resolver").toBeDefined();

    const after = ability.resolve!(
      state,
      contextFor(0, formula.instanceId),
      { targetPermanentInstanceId: other.instanceId } as never,
      formula.instanceId,
    );
    expect(isEmpowered(after, other.instanceId)).toBe(true);
  });

  it("is never OFFERED itself, in both the enumerator and the validator's walk", () => {
    // "ANOTHER" is filtered in `activatableGearTargets`, which both go through —
    // a resolver check would refuse the play after the exhaust cost was paid,
    // which is the offered-then-refused shape this codebase has produced six of.
    //
    // **The spec is read off the CARD, never written out here.** Passing
    // `{ excludesSelf: true }` literally was this test's first draft, and it
    // asserted only that the WALK honours a flag — a mutant that dropped the flag
    // from Hextech Formula's own targeting survived it untouched. Measured.
    const { state, formula, other } = board();
    const spec = activatedAbilityFor(HEXTECH_FORMULA)!.targeting;
    expect(spec, "the ability declares no gear targeting at all").toMatchObject({ kind: "gear" });
    const offered = activatableGearTargets(state, 0, spec as never, formula.instanceId).map((g) => g.instanceId);

    expect(offered, "it offered itself").not.toContain(formula.instanceId);
    expect(offered, "it offered nothing at all — this measures nothing").toContain(other.instanceId);
  });

  it("...and WITHOUT the flag the same walk keeps it — the control on the filter", () => {
    const { state, formula } = board();
    expect(activatableGearTargets(state, 0, {}, formula.instanceId).map((g) => g.instanceId)).toContain(
      formula.instanceId,
    );
  });
});

describe("Nasus, Guardian of Knowledge (VEN-063): once each turn", () => {
  function board(): { state: GameState; nasus: UnitInstance; enemy: UnitInstance; second: UnitInstance } {
    const state = makeState();
    const nasus = realUnitInstance(NASUS_GUARDIAN);
    const enemy = makeUnit();
    const second = makeUnit();
    state.battlefields[0]!.units = { p1: [nasus], p2: [enemy, second] };
    state.players[0]!.runeDeck = runes(5);
    return { state, nasus, enemy, second };
  }

  const listenerFor = (state: GameState, nasus: UnitInstance) => ({
    card: nasus,
    ownerIndex: 0 as const,
    battlefieldId: "bf1",
    defId: NASUS_GUARDIAN,
  });

  it("channels 1 exhausted when an enemy unit dies HERE", () => {
    const { state, nasus, enemy } = board();
    const watch = nasusWatch();
    expect(watch, "he registered no death-watch at all").toBeDefined();

    const context = diedEvent(enemy, 1, "bf1");
    expect(watch!.applies!(state, listenerFor(state, nasus) as never, context as never)).toBe(true);

    const after = watch!.resolve(state, listenerFor(state, nasus) as never, context as never);
    expect(after.players[0]!.channeled).toHaveLength(1);
    expect(after.players[0]!.channeled[0]!.state, "the rune came in ready").toBe("Exhausted");
  });

  it("does NOT fire for a FRIENDLY death, or for a death elsewhere", () => {
    const { state, nasus, enemy } = board();
    const watch = nasusWatch();

    expect(watch.applies!(state, listenerFor(state, nasus) as never, diedEvent(enemy, 0, "bf1") as never), "a friendly death fired him").toBe(false);
    expect(watch.applies!(state, listenerFor(state, nasus) as never, diedEvent(enemy, 1, "bf2") as never), "a death elsewhere fired him").toBe(false);
    expect(watch.applies!(state, listenerFor(state, nasus) as never, diedEvent(enemy, 1) as never), "a death in BASE fired him").toBe(false);
  });

  it("fires ONCE — the second enemy death the same turn does nothing", () => {
    const { state, nasus, enemy, second } = board();
    const watch = nasusWatch();
    const listener = listenerFor(state, nasus) as never;

    const once = watch.resolve(state, listener, diedEvent(enemy, 1, "bf1") as never);
    expect(once.players[0]!.channeled).toHaveLength(1);

    // `applies` refuses to place the second Pending Item at all...
    expect(watch.applies!(once, listener, diedEvent(second, 1, "bf1") as never), "a second death was still held").toBe(false);
    // ...and `resolve` refuses it too, because two deaths in one window hold two
    // items and only the first to resolve spends the turn.
    expect(watch.resolve(once, listener, diedEvent(second, 1, "bf1") as never).players[0]!.channeled, "the second resolution channelled again").toHaveLength(1);
  });

  it("...and the turn RESETS it", () => {
    const { state, nasus, enemy } = board();
    const watch = nasusWatch();
    const listener = listenerFor(state, nasus) as never;

    const once = watch.resolve(state, listener, diedEvent(enemy, 1, "bf1") as never);
    const nextTurn = runEnd({ ...once, phase: "Action" });

    expect(watch.applies!(nextTurn, listener, diedEvent(enemy, 1, "bf1") as never), "the mark outlived the turn").toBe(true);
  });
});

describe("Plaza Guardian (VEN-064): one less per gear", () => {
  const withGear = (count: number): GameState => {
    const state = makeState();
    state.players[0]!.activeGear = Array.from({ length: count }, () => realGearInstance(A_GEAR));
    return state;
  };

  it("scales with the count", () => {
    const printed = printedEnergy(PLAZA_GUARDIAN);
    expect(modifiedEnergyCost(withGear(0), 0, "Unit", printed, PLAZA_GUARDIAN)).toBe(printed);
    expect(modifiedEnergyCost(withGear(3), 0, "Unit", printed, PLAZA_GUARDIAN)).toBe(printed - 3);
  });

  it("floors at 0 rather than going negative", () => {
    const printed = printedEnergy(PLAZA_GUARDIAN);
    expect(modifiedEnergyCost(withGear(printed + 5), 0, "Unit", printed, PLAZA_GUARDIAN)).toBe(0);
  });

  it("reads YOUR gear", () => {
    const printed = printedEnergy(PLAZA_GUARDIAN);
    const theirs = makeState();
    theirs.players[1]!.activeGear = Array.from({ length: 4 }, () => realGearInstance(A_GEAR));
    expect(modifiedEnergyCost(theirs, 0, "Unit", printed, PLAZA_GUARDIAN)).toBe(printed);
  });
});

describe("Swain, Visionary (VEN-065): three different cards this turn", () => {
  function conquered(state: GameState): GameState {
    return holdEventTrigger(state, { kind: "battlefieldConquered", conquerorIndex: 0, battlefieldId: "bf1" });
  }

  function board(unit: number, gear: number, spells: number): { state: GameState; swain: UnitInstance } {
    const state = makeState();
    const swain = realUnitInstance(SWAIN_VISIONARY);
    state.battlefields[0]!.units = { p1: [swain] };
    state.players[0]!.nonTokenUnitsPlayedThisTurn = unit;
    state.players[0]!.gearPlayedThisTurn = gear;
    state.players[0]!.spellsPlayedThisTurn = spells;
    return { state, swain };
  }

  const score = (state: GameState) => resolveHeldTriggers(conquered(state)).players[0]!.points;

  it("scores 1 when all three were played", () => {
    expect(score(board(1, 1, 1).state)).toBe(1);
  });

  it("scores NOTHING when any one of the three is missing", () => {
    // Three separate boundaries rather than one, because a resolver reading two
    // of the three passes a test that only removes the third.
    expect(score(board(0, 1, 1).state), "no unit was played and it still scored").toBe(0);
    expect(score(board(1, 0, 1).state), "no gear was played and it still scored").toBe(0);
    expect(score(board(1, 1, 0).state), "no spell was played and it still scored").toBe(0);
  });

  it("needs him standing AT the battlefield taken", () => {
    // "When I conquer" is positional, the reading Plundering Poro's entry sets
    // out — a Swain in base is not the body that took anything.
    const { state, swain } = board(1, 1, 1);
    state.battlefields[0]!.units = {};
    state.players[0]!.baseUnits = [swain];

    expect(score(state), "a Swain in base scored").toBe(0);
  });

  it("counts NON-TOKEN units, which is the counter that had to be added", () => {
    // `cardsPlayedThisTurn` counts every kind and cannot tell a unit from the
    // gear beside it, so this is the one of the three facts that needed new
    // state. Asserted through the real play path rather than by poking the field.
    const state = makeState();
    state.players[0]!.hand = [realUnitInstance("OGN-003")];
    state.players[0]!.channeled = Array.from({ length: 4 }, (_, i) => ({
      id: `f${i}`,
      domain: "Fury",
      state: "Ready",
    })) as never;

    const play = legalActions(state).find((a) => a.type === "PlayCard" && a.card.defId === "OGN-003");
    expect(play, "the fixture could not play a unit at all").toBeDefined();

    const { state: after } = submit(state, play!);
    expect(after.players[0]!.nonTokenUnitsPlayedThisTurn, "playing a unit did not count").toBe(1);
    expect(after.players[0]!.gearPlayedThisTurn, "playing a unit counted as a gear").toBe(0);
  });

  it("...and the counter is swept by the turn", () => {
    const state = makeState();
    state.players[0]!.nonTokenUnitsPlayedThisTurn = 3;
    expect(runEnd({ ...state, phase: "Action" }).players[0]!.nonTokenUnitsPlayedThisTurn).toBe(0);
  });

  it("[Vision] is PRINTED and needs no code of its own", () => {
    // `unitTriggerHasVisionChoice` reads the keyword — and the auras that grant
    // it — so the predict is fanned onto the PlayCard action before he is on the
    // board. Pinned so a future erratum to the keyword cannot silently drop it.
    expect(printedKeywords(SWAIN_VISIONARY).Vision).toBeGreaterThan(0);
  });
});

describe("coverage sees the whole wave", () => {
  it("all ten report implemented", () => {
    for (const id of [
      CLOUD_DRAKE,
      DREDGE_UP,
      ITERATIVE_DESIGN,
      MESMERIZE,
      PATCHED_POROBOT,
      SHOCK_BLAST,
      HEXTECH_FORMULA,
      NASUS_GUARDIAN,
      PLAZA_GUARDIAN,
      SWAIN_VISIONARY,
    ]) {
      expect(isCardImplemented(registry.get(id)), `${id} ${registry.get(id).name} still reports unimplemented`).toBe(
        true,
      );
    }
  });
});
