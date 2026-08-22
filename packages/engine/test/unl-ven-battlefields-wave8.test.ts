import { describe, expect, it } from "vitest";
import { loadBattlefieldDefinitions } from "../src/cards/card-loader.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { abilitiesAvailableTo, activationCostFor } from "../src/engine/activated-abilities.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { makeState, makeUnit, realGearInstance } from "./fixtures.js";

/**
 * **UNL/VEN battlefields, wave 8 — the three that touch ACTIVATED abilities.**
 *
 *   UNL-213 Gardens of Becoming — units here have "[Exhaust]: Gain 1 XP"
 *   VEN-163 Risen Altar         — [Empower] costs of your units here cost
 *                                 [1 Energy] or [1 rainbow] less
 *   VEN-161 Piltovan Forge      — while you control this battlefield, the first
 *                                 friendly gear activated ability each turn costs
 *                                 [1 Energy] less
 *
 * # Two widenings, both with the same shape
 *
 * `abilitiesAvailableTo` took a source with no `instanceId`, so it could answer
 * "is this the Legend" (Forge of the Fluft) but not "is this standing HERE"
 * (Gardens). `activationCostFor` took no source at all, so it could not answer
 * "is this a gear of mine" or "is this unit at my Altar". Both gained an optional
 * source; all nine real call sites already held one.
 *
 * **The discount lives inside `activationCostFor`**, which the enumerator, the
 * validator, `canPayActivationCost` and the payer all price through. A discount
 * visible to only some of them is this codebase's offered-then-refused bug, and
 * that is why neither card gets its own path.
 *
 * # …and a SIXTH way a battlefield can be implemented
 *
 * `battlefield-coverage.test.ts` is the only thing that can see a battlefield at
 * all. Gardens is keyed by its own defId in `ACTIVATED_ABILITIES`, like Forge of
 * the Fluft, so the gate found it. Risen Altar and Piltovan Forge modify OTHER
 * abilities' costs and have no entry anywhere, so the gate went on reporting two
 * finished cards as doing nothing until given their own export. That is the same
 * lesson Altar of Blood taught one wave earlier.
 */

const GARDENS_OF_BECOMING = "UNL-213";
const RISEN_ALTAR = "VEN-163";
const PILTOVAN_FORGE = "VEN-161";

const registry = defaultCardRegistry();

/** A real card with a printed `[Empower]` cost, found from the registry rather
 *  than hardcoded — a hardcoded id rots when a set file is regenerated. */
const EMPOWERABLE = registry
  .all()
  .find(
    (d) =>
      d.type === "Unit" &&
      d.empowerCost !== undefined &&
      (d.empowerCost.energy ?? 0) > 1 &&
      // **No `energyDiscount` of its own.** Baccai Sandspinner prints [5] with
      // "costs [3] less if you control 4 or fewer runes", so its PRINTED energy is
      // 5 and `activationCostFor` answers 2 — a fixture picked on the printed
      // field alone compares 5 against 2 and fails for a reason that has nothing
      // to do with Risen Altar.
      d.empowerCost.energyDiscount === undefined &&
      d.empowerCost.alternative === undefined,
  )!;

function board(defId: string, units: UnitInstance[] = [], controller?: string): GameState {
  const state = makeState({ phase: "Action" });
  state.battlefields[0] = {
    ...state.battlefields[0]!,
    defId,
    units: { p1: units },
    ...(controller !== undefined ? { controllerId: controller } : {}),
  };
  return state;
}

describe("every name in this wave is a battlefield that really prints that text", () => {
  it("matches the printed cards", () => {
    const byId = new Map(loadBattlefieldDefinitions().map((d) => [d.id, d]));
    for (const [defId, name, phrase] of [
      [GARDENS_OF_BECOMING, "Gardens of Becoming", "Gain 1 XP"],
      [RISEN_ALTAR, "Risen Altar", "[Empower]"],
      [PILTOVAN_FORGE, "Piltovan Forge", "gear activated ability"],
    ] as const) {
      const def = byId.get(defId);
      expect(def?.name, `${defId} is not the card this wave thinks it is`).toBe(name);
      expect(def?.text, `${name}'s text has changed under the implementation`).toContain(phrase);
    }
  });

  it("the [Empower] fixture is a real card with a real Energy cost", () => {
    // A positive control on the fixture: if the registry stopped carrying an
    // Empower cost with Energy in it, every Risen Altar test below would compare
    // 0 against 0 and pass.
    expect(EMPOWERABLE, "no unit in the pool has a printed [Empower] Energy cost").toBeDefined();
    expect(EMPOWERABLE.empowerCost!.energy ?? 0, "the fixture's Empower cost is free").toBeGreaterThan(0);
  });
});

describe("Gardens of Becoming (UNL-213): units here may exhaust for XP", () => {
  const here = () => makeUnit({ instanceId: "u", name: "Standing Here", might: 3 });

  it("grants the ability to a unit standing here", () => {
    const state = board(GARDENS_OF_BECOMING, [here()]);
    const granted = abilitiesAvailableTo(state, 0, { defId: here().defId, instanceId: "u" });
    expect(granted.map((g) => g.abilityDefId), "the unit was not granted the ability").toContain(GARDENS_OF_BECOMING);
  });

  it("does NOT grant it to a unit elsewhere — 'units HERE'", () => {
    const state = board(GARDENS_OF_BECOMING, []);
    state.players[0]!.baseUnits = [here()];
    const granted = abilitiesAvailableTo(state, 0, { defId: here().defId, instanceId: "u" });
    expect(granted.map((g) => g.abilityDefId), "a unit in base was granted it").not.toContain(GARDENS_OF_BECOMING);
  });

  it("grants it to the OPPONENT's unit here too — the card names no owner", () => {
    const state = makeState({ phase: "Action" });
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      defId: GARDENS_OF_BECOMING,
      units: { p2: [makeUnit({ instanceId: "e", name: "Theirs", might: 3 })] },
    };
    const granted = abilitiesAvailableTo(state, 1, { defId: "OGN-002", instanceId: "e" });
    expect(granted.map((g) => g.abilityDefId), "the enemy unit was not granted it").toContain(GARDENS_OF_BECOMING);
  });

  it("actually gains XP when used, through the real action path", () => {
    // The half that matters: the grant reaching `abilitiesAvailableTo` is not the
    // same as a player being able to use it and getting the XP.
    const state = board(GARDENS_OF_BECOMING, [here()]);
    // **`viaAbilityDefId`, not `abilityDefId`.** `legal-actions` carries the
    // ability id separately only when it is NOT the source's own — which is
    // exactly the granted case. Looking at the wrong field finds an action whose
    // `abilityDefId` is undefined and reads as "never offered".
    const action = legalActions(state).find(
      (a) => a.type === "ActivateAbility" && a.viaAbilityDefId === GARDENS_OF_BECOMING,
    );
    expect(action, "the ability was never offered as a legal action").toBeDefined();

    const after = submit(state, action!);
    expect(after.result.type, "the activation was refused").toBe("Ok");
    expect(after.state.players[0]!.xp, "no XP was gained").toBe(1);
    expect(
      (after.state.battlefields[0]!.units.p1 ?? [])[0]!.exhausted,
      "the unit did not pay its own exhaust — 414.5",
    ).toBe(true);
  });
});

describe("Risen Altar (VEN-163): your units' [Empower] costs here cost 1 less", () => {
  const empowerable = () => ({ ...makeUnit({ instanceId: "u", name: EMPOWERABLE.name }), defId: EMPOWERABLE.id });
  /** The engine's OWN undiscounted answer, not the printed field — an
   *  `energyDiscount` rule would make the two differ for reasons unrelated to
   *  this card. */
  const printed = activationCostFor(
    board("OGN-294", [{ ...makeUnit({ instanceId: "u", name: EMPOWERABLE.name }), defId: EMPOWERABLE.id } as UnitInstance]),
    0,
    EMPOWERABLE.id,
    undefined,
    undefined,
    "u",
  ).energy!;

  it("discounts an [Empower] cost for a unit standing here", () => {
    const at = board(RISEN_ALTAR, [empowerable() as UnitInstance]);
    expect(activationCostFor(at, 0, EMPOWERABLE.id, undefined, undefined, "u").energy, "no discount").toBe(printed - 1);
  });

  it("...and not for the same unit elsewhere — the control", () => {
    const away = board("OGN-294", [empowerable() as UnitInstance]);
    expect(activationCostFor(away, 0, EMPOWERABLE.id, undefined, undefined, "u").energy, "discounted anywhere").toBe(
      printed,
    );
  });

  it("does not discount with NO source named", () => {
    // A caller pricing an ability in the abstract has no location, and must get
    // the undiscounted price rather than a guess.
    const at = board(RISEN_ALTAR, [empowerable() as UnitInstance]);
    expect(activationCostFor(at, 0, EMPOWERABLE.id).energy, "an unsourced price was discounted").toBe(printed);
  });

  it("does NOT discount a unit's ORDINARY activated ability — '[Empower] costs'", () => {
    // **The clause that says WHICH costs**, and the only test that can see it: a
    // version discounting every ability of a unit here passed all four tests
    // above, because all four price an Empower cost. UNL-030 Vi - Hotheaded has
    // a printed activated ability and no Empower cost at all.
    const ORDINARY = "UNL-030";
    const vi = { ...makeUnit({ instanceId: "v", name: "Vi - Hotheaded" }), defId: ORDINARY } as UnitInstance;
    const at = board(RISEN_ALTAR, [vi]);
    const away = board("OGN-294", [vi]);

    const baseline = activationCostFor(away, 0, ORDINARY, undefined, undefined, "v").energy;
    expect(baseline, "the fixture ability has no Energy cost to discount").toBeGreaterThan(0);
    expect(
      activationCostFor(at, 0, ORDINARY, undefined, undefined, "v").energy,
      "an ordinary activated ability took the [Empower] discount",
    ).toBe(baseline);
  });

  it("does not discount the OPPONENT's unit here — 'YOUR units'", () => {
    const state = makeState({ phase: "Action" });
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      defId: RISEN_ALTAR,
      units: { p2: [{ ...makeUnit({ instanceId: "e", name: EMPOWERABLE.name }), defId: EMPOWERABLE.id } as UnitInstance] },
    };
    // Priced for p0, whose unit it is not.
    expect(activationCostFor(state, 0, EMPOWERABLE.id, undefined, undefined, "e").energy, "an enemy got the discount").toBe(
      printed,
    );
  });
});

describe("Piltovan Forge (VEN-161): the first gear ability each turn costs 1 less", () => {
  /** A real gear with an Energy-costed activated ability. */
  // The Zero Drive — its activated ability costs [3], so the discount is
  // unambiguous. A 1-Energy ability would read 1 -> 0, which is also what a
  // broken cost of 0 looks like.
  const GEAR_WITH_ENERGY_ABILITY = "SFD-090";

  function forge(controlled: boolean, used: number): GameState {
    const state = board(PILTOVAN_FORGE, [], controlled ? "p1" : "p2");
    state.players[0]!.activeGear = [{ ...realGearInstance(GEAR_WITH_ENERGY_ABILITY), instanceId: "g" }];
    state.players[0]!.gearAbilitiesActivatedThisTurn = used;
    return state;
  }

  const priceOf = (state: GameState) =>
    activationCostFor(state, 0, GEAR_WITH_ENERGY_ABILITY, undefined, undefined, "g").energy;

  it("discounts the FIRST gear ability of the turn", () => {
    const base = activationCostFor(forge(false, 0), 0, GEAR_WITH_ENERGY_ABILITY, undefined, undefined, "g").energy ?? 0;
    expect(base, "the fixture gear has no Energy cost to discount").toBeGreaterThan(0);
    expect(priceOf(forge(true, 0)), "the first gear ability was not discounted").toBe(base - 1);
  });

  it("does NOT discount the second — 'the FIRST ... each turn'", () => {
    const base = activationCostFor(forge(false, 0), 0, GEAR_WITH_ENERGY_ABILITY, undefined, undefined, "g").energy ?? 0;
    expect(priceOf(forge(true, 1)), "it discounted after one had already gone").toBe(base);
  });

  it("does NOT discount while the opponent controls it — 'while YOU control'", () => {
    const base = activationCostFor(forge(false, 0), 0, GEAR_WITH_ENERGY_ABILITY, undefined, undefined, "g").energy ?? 0;
    expect(priceOf(forge(false, 0)), "a battlefield you do not control discounted you").toBe(base);
  });

  it("does NOT discount a UNIT's ability — 'gear activated ability'", () => {
    const state = forge(true, 0);
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      units: { p1: [makeUnit({ instanceId: "u", name: "Unit", might: 3 })] },
    };
    // The unit is not in `activeGear`, so the gear branch cannot match it.
    const unitPrice = activationCostFor(state, 0, GEAR_WITH_ENERGY_ABILITY, undefined, undefined, "u").energy;
    const base = activationCostFor(forge(false, 0), 0, GEAR_WITH_ENERGY_ABILITY, undefined, undefined, "g").energy;
    expect(unitPrice, "a unit's ability took the gear discount").toBe(base);
  });
});
