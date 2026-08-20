import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { effectiveKeywords } from "../src/engine/granted-keywords.js";
import { disempowerPermanent, empowerPermanent, isEmpowered } from "../src/engine/effect-helpers.js";
import { parseEmpowerCost, parseEmpoweredGrant } from "../src/cards/card-loader.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type UnitInstance } from "../src/model/card.js";
import { makeState } from "./fixtures.js";
import type { GameState } from "../src/model/game-state.js";

/**
 * `[Empower]` (827), `[Empowered]` (828) and the status behind them (441 / 442),
 * all read against `pdftotext -q -raw`.
 *
 * > 441.1.a "Empowered is a binary state. A Game Object is Empowered or it isn't."
 * > 441.1.b "An Empowered Game Object can not be Empowered."
 * > 442.1.a "Disempowering affects only cards that are currently Empowered."
 * > 827.1.c.1 "Empower is functionally short for '[Cost]: Empower this. Play only if not Empowered.'"
 * > 828.1.b.1 "While I have the Empowered status, this card gains `[Text]`."
 * > 828.1.c "As long as the Game Object has the Empowered status, then the Dependent Ability will be active."
 *
 * **The status is PER OBJECT, which is the whole difference from `[Level]`**,
 * whose superficially identical `[Level N][>]` clause reads one integer on
 * `PlayerState`. Two copies of one Empowered unit can disagree, and the test for
 * that is below.
 */

const registry = defaultCardRegistry();

const SHADOW_FIEND = "VEN-014"; // [Empower] 2 Energy + Fury; [Empowered][>] I have [Assault 3]
const MOURNFUL_WITNESS = "VEN-028"; // [Empowered][>] I have +2 Might
const PUNCHING_PORO = "VEN-007"; // compound Empower cost ("— Discard 1"), grant +1 Might

const unit = (defId: string, instanceId?: string): UnitInstance => {
  const made = createCardInstance(registry.get(defId)) as UnitInstance;
  return instanceId ? { ...made, instanceId } : made;
};

function boardWith(units: UnitInstance[]): GameState {
  const state = makeState({ phase: "Action" });
  state.players[0]!.baseUnits = units;
  state.players[0]!.floatingEnergy = 20;
  state.players[0]!.floatingPower = { Fury: 5, Body: 5, Order: 5, Calm: 5, Mind: 5, Chaos: 5 };
  return state;
}

describe("the Empowered status is a binary per-object state (441)", () => {
  it("empowers, and a SECOND Empower does nothing (441.1.b / 441.1.c)", () => {
    const before = boardWith([unit(SHADOW_FIEND, "u1")]);
    expect(isEmpowered(before, "u1")).toBe(false);
    const once = empowerPermanent(before, "u1");
    expect(isEmpowered(once, "u1")).toBe(true);
    // 441.1.c: "If a Game Object is instructed to be Empowered when it is already
    // Empowered, nothing additional happens." Identity, not merely equal state —
    // a rebuild would fire the Might-transition machinery for no change.
    expect(empowerPermanent(once, "u1"), "a redundant Empower rebuilt the state").toBe(once);
  });

  it("disempowers, and disempowering an un-Empowered card does nothing (442.1.a.1)", () => {
    const state = boardWith([unit(SHADOW_FIEND, "u1")]);
    expect(disempowerPermanent(state, "u1"), "a no-op Disempower rebuilt the state").toBe(state);
    const empowered = empowerPermanent(state, "u1");
    expect(isEmpowered(disempowerPermanent(empowered, "u1"), "u1")).toBe(false);
  });

  it("is a property of the OBJECT — two copies of one card disagree", () => {
    // The distinction from `[Level]`, which reads a player counter and so cannot
    // tell two copies apart. Asserted on Might, so it measures the status through
    // a reader rather than only through the flag.
    const state = empowerPermanent(boardWith([unit(MOURNFUL_WITNESS, "a"), unit(MOURNFUL_WITNESS, "b")]), "a");
    const [first, second] = state.players[0]!.baseUnits as [UnitInstance, UnitInstance];
    expect(effectiveMight(state, first, 0, { isCombat: false })).toBeGreaterThan(effectiveMight(state, second, 0, { isCombat: false }));
  });
});

describe("[Empower] is an activated ability (827)", () => {
  const empowerActionFor = (state: GameState, instanceId: string) =>
    legalActions(state).find((a) => a.type === "ActivateAbility" && a.permanentInstanceId === instanceId);

  it("is offered, and paying it Empowers the source", () => {
    const state = boardWith([unit(SHADOW_FIEND, "u1")]);
    const activate = empowerActionFor(state, "u1");
    expect(activate, "no [Empower] ability was offered").toBeDefined();

    const { state: after, result } = submit(state, activate!);
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
    expect(isEmpowered(after, "u1"), "paying [Empower] did not Empower the unit").toBe(true);
  });

  it("is NOT offered once the source is Empowered (827.1.c.1)", () => {
    // "Play only if not Empowered." Placed in `availableWhile` rather than in the
    // resolver on purpose: a resolver that refused would have taken the cost
    // first, so the player would pay to do nothing.
    const empowered = empowerPermanent(boardWith([unit(SHADOW_FIEND, "u1")]), "u1");
    expect(empowerActionFor(empowered, "u1"), "[Empower] was offered to an already-Empowered unit").toBeUndefined();
  });

  it("charges the printed cost", () => {
    const state = boardWith([unit(SHADOW_FIEND, "u1")]);
    const cost = registry.get(SHADOW_FIEND).empowerCost;
    expect(cost, "Shadow Fiend's Empower cost did not parse — this test measures nothing").toBeDefined();
    const before = state.players[0]!.floatingEnergy;
    const { state: after } = submit(state, empowerActionFor(state, "u1")!);
    expect(before - after.players[0]!.floatingEnergy).toBe(cost!.energy);
  });
});

describe("[Empowered][>] grants only while the status holds (828.1.c)", () => {
  it("grants Might, and loses it on Disempower", () => {
    const plain = boardWith([unit(MOURNFUL_WITNESS, "u1")]);
    const base = effectiveMight(plain, plain.players[0]!.baseUnits[0]!, 0, { isCombat: false });

    const empowered = empowerPermanent(plain, "u1");
    const raised = effectiveMight(empowered, empowered.players[0]!.baseUnits[0]!, 0, { isCombat: false });
    expect(raised - base, "the Empowered Might bonus was not granted").toBe(
      registry.get(MOURNFUL_WITNESS).empoweredGrant!.might,
    );

    // 828.1.c is "as long as", so the grant is re-asked and must vanish.
    const back = disempowerPermanent(empowered, "u1");
    expect(effectiveMight(back, back.players[0]!.baseUnits[0]!, 0, { isCombat: false }), "the bonus outlived the status").toBe(base);
  });

  it("grants a VALUED keyword at its printed magnitude", () => {
    // Shadow Fiend prints `[Empowered][>] I have [Assault 3]`, so the value comes
    // off the card. A grant defaulting to 1 — which is what `CONDITIONAL_GRANTS`
    // does for its own entries — would silently under-grant every valued clause.
    const plain = boardWith([unit(SHADOW_FIEND, "u1")]);
    expect(effectiveKeywords(plain, plain.players[0]!.baseUnits[0]!, 0).Assault).toBeUndefined();

    const empowered = empowerPermanent(plain, "u1");
    expect(effectiveKeywords(empowered, empowered.players[0]!.baseUnits[0]!, 0).Assault).toBe(3);
  });
});

describe("what the parsers refuse (and why coverage must agree)", () => {
  it("READS a compound cost term by term (827.1.c.2)", () => {
    // "Empower costs may include both resource costs and non-resource costs."
    // Every term below is one `ActivationCost` already had a field for, which is
    // why the compound half needed no new cost model — the same payoff
    // `EquipExtraCost` buys for `[Equip]`'s two compound costs.
    expect(parseEmpowerCost("[Empower] — Discard 1 (reminder)")).toEqual({
      energy: 0,
      powerCost: 0,
      powerDomain: null,
      extra: { discard: 1 },
    });
    expect(parseEmpowerCost("[Empower] — :rb_exhaust: (reminder)")).toEqual({
      energy: 0,
      powerCost: 0,
      powerDomain: null,
      extra: { exhaust: true },
    });
    // Comma-separated terms, and the resource half is summed rather than dropped.
    expect(parseEmpowerCost("[Empower] — :rb_energy_1:, :rb_exhaust: (reminder)")).toEqual({
      energy: 1,
      powerCost: 0,
      powerDomain: null,
      extra: { exhaust: true },
    });
    expect(parseEmpowerCost("[Empower] — Kill a friendly unit (reminder)")).toEqual({
      energy: 0,
      powerCost: 0,
      powerDomain: null,
      extra: { killFriendlyPermanent: true },
    });
  });

  it("reads the two compound shapes that were once left unwritten", () => {
    // **Both of these used to assert `toBeUndefined()`, and both refusal notes
    // named their blocker exactly right** — which is why each says how it was
    // closed rather than being deleted:
    //
    //   "Discard a spell" was refused because "`ActivationCost.discard` is a
    //   COUNT of any cards, so charging it would let the player discard a UNIT
    //   instead… It needs a narrowed discard field." That field is `discardKind`,
    //   added in another set for Sky Cruiser's "Discard a GEAR".
    //
    //   "[1] or [Body]" was refused because "either half alone is cheaper than
    //   the choice and both together are dearer, so neither is the card." Both
    //   still true — so it is neither: it becomes two MODES and the player picks.
    expect(parseEmpowerCost("[Empower] — Discard a spell (reminder)")).toEqual({
      energy: 0,
      powerCost: 0,
      powerDomain: null,
      extra: { discard: 1, discardKind: "Spell" },
    });
    expect(parseEmpowerCost("[Empower] — :rb_energy_1: or :rb_rune_body: (reminder)")).toEqual({
      energy: 1,
      powerCost: 0,
      powerDomain: null,
      alternative: { energy: 0, powerCost: 1, powerDomain: "Body" },
    });
  });

  it("...and STILL refuses a compound cost with a term it cannot charge", () => {
    // The half of the old pin that is untouched, and the rule it protects: a term
    // this reader has never seen must take the whole cost with it rather than
    // yielding the terms before it. Reading half a cost makes an ability CHEAPER
    // than printed, which turns on a card's whole `[Empowered]` clause for free.
    expect(parseEmpowerCost("[Empower] — :rb_energy_1:, Sacrifice a rune (reminder)")).toBeUndefined();
    // An unknown half of an ALTERNATIVE takes the whole cost too — otherwise the
    // "or" reader would quietly charge the half it understood, which is the
    // cheapest possible misreading of a card whose price IS a choice.
    expect(parseEmpowerCost("[Empower] — :rb_energy_1: or Sacrifice a rune (reminder)")).toBeUndefined();
    // Three-way, which no card prints and this reader must not invent a price for.
    expect(
      parseEmpowerCost("[Empower] — :rb_energy_1: or :rb_rune_body: or :rb_rune_fury: (reminder)"),
    ).toBeUndefined();
    // A narrowed discard of a kind that is not a card type.
    expect(parseEmpowerCost("[Empower] — Discard a rune (reminder)")).toBeUndefined();
  });

  it("charges the compound half through the generated ability", () => {
    // Punching Poro's Empower costs a DISCARD and no resources. Asserting the
    // hand shrinks is what says the non-resource half is actually taken — a cost
    // spread into the ability but never charged would leave this at 0.
    const poro = unit(PUNCHING_PORO, "p1");
    const state = boardWith([poro]);
    state.players[0]!.hand = [unit(SHADOW_FIEND), unit(SHADOW_FIEND)];
    const activate = legalActions(state).find(
      (a) => a.type === "ActivateAbility" && a.permanentInstanceId === "p1",
    );
    expect(activate, "no [Empower] ability was offered for a compound cost").toBeDefined();

    const before = state.players[0]!.hand.length;
    const { state: after, result } = submit(state, activate!);
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
    expect(before - after.players[0]!.hand.length, "the discard was not charged").toBe(1);
    expect(isEmpowered(after, "p1"), "the compound Empower did not Empower the unit").toBe(true);
  });

  it("does not offer a compound Empower whose cost cannot be paid", () => {
    // The control on the above: with an EMPTY hand there is no discard to make,
    // and `canPayActivationCost` must refuse rather than let the player pay
    // nothing. Without this, the test above would pass against an ability whose
    // discard is declared and never checked.
    const state = boardWith([unit(PUNCHING_PORO, "p1")]);
    state.players[0]!.hand = [];
    expect(
      legalActions(state).find((a) => a.type === "ActivateAbility" && a.permanentInstanceId === "p1"),
      "a discard-costed Empower was offered with an empty hand",
    ).toBeUndefined();
  });

  it("READS a self-modifying [Empower] cost, rather than refusing it", () => {
    // **This pin used to assert `toBeUndefined()`, and it was right about its
    // BLOCKER and wrong about its fix** — the shape `triage-a-refusal` warns is
    // the most common here. Its note said, correctly, that 827.1.c.3 makes cost-
    // altering text "taken into account when determining a card's Empower cost
    // for any reason", so honouring the printed number ALONE is too EXPENSIVE and
    // the card is unplayable at the price it actually means. Refusing was the safe
    // direction while nothing could express the discount. `EnergyDiscountRule` is
    // that expression, so the sentence is read now and the three cards that print
    // one are finished.
    //
    // The plain case is kept unchanged beside it — a cost with no such sentence
    // must not grow a rule.
    expect(parseEmpowerCost("[Empower] :rb_energy_2::rb_rune_fury: (reminder)")).toEqual({
      energy: 2,
      powerCost: 1,
      powerDomain: "Fury",
    });

    // Baccai Sandspinner's shape: a flat discount behind a threshold.
    expect(
      parseEmpowerCost("[Empower] :rb_energy_5:. This ability costs :rb_energy_3: less if you control 4 or fewer runes."),
    ).toEqual({
      energy: 5,
      powerCost: 0,
      powerDomain: null,
      energyDiscount: { kind: "ifRunesAtMost", amount: 3, max: 4 },
    });

    // Frostcoat Mother's and Grumpy Rockbear's: one per rune, no ceiling.
    expect(
      parseEmpowerCost("[Empower] :rb_energy_12:. This ability costs :rb_energy_1: less for each rune you control."),
    ).toEqual({
      energy: 12,
      powerCost: 0,
      powerDomain: null,
      energyDiscount: { kind: "perRuneControlled", amount: 1 },
    });
  });

  it("...and still refuses a self-modifying sentence it does NOT recognise", () => {
    // **The half of the old pin that is still true, and the half worth keeping.**
    // Reading the pips and dropping a modifier nobody understood is exactly the
    // mis-pricing the original refusal existed to prevent — `parseEquipCost`'s
    // rule, applied here: an unrecognised shape refuses the WHOLE cost.
    //
    // Written against a synthetic sentence rather than a real card's, so no future
    // set can implement this control out from under it: if the pool ever prints
    // "costs [2] less while I'm at a battlefield", the right response is to teach
    // the parser that shape and leave this one alone.
    expect(
      parseEmpowerCost("[Empower] :rb_energy_9:. This ability costs :rb_energy_2: less while the moon is full."),
      "an unreadable modifier was dropped and the pips charged alone",
    ).toBeUndefined();
    // Not "costs N less" at all, but still self-modifying in shape — the anchored
    // regex must not half-match it into a discount of nothing.
    expect(
      parseEmpowerCost("[Empower] :rb_energy_9:. This ability costs :rb_rune_fury: more if you control a Poro."),
      "a cost-INCREASING sentence was read as a discount",
    ).toBeUndefined();
  });

  it("refuses an [Empowered] payload that is a trigger or an ability", () => {
    expect(parseEmpoweredGrant("[Empowered][>] I have +2 :rb_might:.")).toEqual({ might: 2, keywords: {} });
    expect(parseEmpoweredGrant("[Empowered][>] I have [Deflect] and [Assault 2].")).toEqual({
      might: 0,
      keywords: { Deflect: 1, Assault: 2 },
    });
    expect(
      parseEmpoweredGrant("[Empowered][>] When I conquer, you score 1 point."),
      "a trigger payload must not be granted as a static bonus",
    ).toBeUndefined();
    expect(
      parseEmpoweredGrant("[Empowered][>] Your spells and abilities can't be countered."),
      "a payload about OTHER objects is not a self-grant",
    ).toBeUndefined();
  });

  it("reports a card whose Empower cost is unreadable as PARTIAL, not implemented", () => {
    // **The coverage lie this subsystem opened and had to close.** Punching Poro's
    // `[Empowered][>]` payload parses, which registers him in granted-keywords —
    // so the registry check called him implemented while his printed way of
    // BECOMING Empowered does not exist. Derived rather than listed, so the next
    // unreadable cost cannot slip through by nobody adding a row.
    // **SYNTHETIC subject, and the reason is that the real one was implemented
    // out from under this test within the day.** It named Punching Poro, whose
    // "— Discard 1" cost this file now reads — so the pin measured nothing the
    // moment the compound parser landed. The five cards still refused today
    // (self-modifying costs, "Discard a spell", "[1] or [Body]") are all
    // implementable in principle and would do the same thing again.
    //
    // A definition built here cannot be finished by anyone, so the invariant
    // survives every card that lands: prints `[Empower]`, has no readable cost,
    // must not report implemented.
    // `empowerCost` is DESTRUCTURED away rather than set to `undefined`:
    // `exactOptionalPropertyTypes` makes an explicit `undefined` a different type
    // from an absent key, and the absent key is what a card with no readable cost
    // actually has.
    const { empowerCost: _noCost, ...withoutCost } = registry.get(MOURNFUL_WITNESS);
    const synthetic = {
      ...withoutCost,
      id: "VEN-000",
      text: "[Empower] — Sacrifice a rune (Pay the cost: Empower me.)[Empowered][>] I have +2 :rb_might:.",
    };
    expect(partialImplementationNote(synthetic), "no partial note for a half-written card").toBeDefined();
    expect(isCardImplemented(synthetic), "a card with no way to Empower itself reported implemented").toBe(false);

    // **The real-card half was retired on 2026-08-19, because the list emptied.**
    // It asserted `stillUnreadable.length > 0` and said, in as many words, "every
    // [Empower] cost now parses — retire this half of the test". That is exactly
    // what happened: the five it was watching (three self-modifying costs,
    // "Discard a spell", "[1] or [Body]") are all written.
    //
    // An emptied `for` loop over a refusals list asserts NOTHING, so it is
    // replaced by the positive sweep — every card that prints `[Empower]` now has
    // a readable cost. A regression to unreadable would otherwise pass in silence,
    // which is the whole failure this pin existed to prevent.
    const unreadable = registry
      .all()
      .filter((d) => (d.text ?? "").includes("[Empower]") && d.empowerCost === undefined)
      .map((d) => `${d.id} ${d.name}`);
    expect(unreadable, "an [Empower] cost stopped parsing").toEqual([]);

    // Not vacuous: there really are cards being swept, and they really do print
    // the keyword.
    const empowerCards = registry.all().filter((d) => (d.text ?? "").includes("[Empower]"));
    expect(empowerCards.length, "no card prints [Empower] — this sweep measures nothing").toBeGreaterThan(10);

    // **A readable cost is not the same as a finished card**, and this line named
    // VEN-069 Mel, Newly Awakened until her second sentence landed later the same
    // day — her `[Empower] [3]` had always parsed and she was partial for a
    // replacement effect on -Might instead.
    //
    // Kept, EMPTY, rather than deleted: the distinction it draws is the one this
    // whole `describe` is about, and an Empower card that becomes partial for some
    // other reason is exactly what should show up here rather than being absorbed
    // by the readable-cost sweep above.
    const stillPartial = empowerCards.filter((d) => partialImplementationNote(d) !== undefined).map((d) => d.id);
    expect(stillPartial, "an Empower card became partial for a reason this sweep cannot see").toEqual([]);
  });
});
