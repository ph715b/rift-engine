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
  it("refuses a compound or self-modifying [Empower] cost", () => {
    // `parseEquipCost`'s rule: half a cost is CHEAPER than printed. 827.1.c.3
    // also makes the self-modifying kind ("costs [1] less for each rune you
    // control") wrong in the other direction if the printed number is taken alone.
    expect(parseEmpowerCost("[Empower] :rb_energy_2::rb_rune_fury: (reminder)")).toEqual({
      energy: 2,
      powerCost: 1,
      powerDomain: "Fury",
    });
    expect(parseEmpowerCost("[Empower] — Discard 1 (reminder)"), "a compound cost is not a price").toBeUndefined();
    expect(
      parseEmpowerCost("[Empower] :rb_energy_5:. This ability costs :rb_energy_3: less if you control 4 or fewer runes."),
      "a self-modifying cost is not the printed number",
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
    const poro = registry.get(PUNCHING_PORO);
    expect(poro.empoweredGrant, "the grant half must still parse, or this measures nothing").toBeDefined();
    expect(poro.empowerCost, "the cost half must still be unreadable, or this measures nothing").toBeUndefined();
    expect(partialImplementationNote(poro), "no partial note for a half-written card").toBeDefined();
    expect(isCardImplemented(poro), "a card with no way to Empower itself reported implemented").toBe(false);
  });
});
