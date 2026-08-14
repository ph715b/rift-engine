import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { validateActivateAbility } from "../src/actions/validate-activate-ability.js";
import {
  activationCostOf,
  canPayActivationCost,
  exhaustableFriendlyUnits,
  modesOf,
} from "../src/engine/activated-abilities.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { findUnitAnywhere } from "../src/engine/target-lookup.js";
import type { GameState } from "../src/model/game-state.js";
import type { ActivateAbilityAction } from "../src/actions/player-action.js";
import { makeState, makeUnit, realGearInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * **UNL-045 Forgotten Signpost — "[Action][>] Exhaust a unit you control,
 * [Exhaust]: Move a different unit you control to the location of the unit you
 * exhausted to pay for this ability."**
 *
 * Refused in waves 3, 6 and 8. All three named the same first blocker and it was
 * real: `ActivationCost` could not say "exhaust a unit you control", and its
 * nearest neighbour `killFriendlyPermanent` KILLS. That is `exhaustFriendlyUnit`
 * now, riding the same `costPermanentInstanceId` the kill already rides.
 *
 * # What the refusals got wrong, and what this file pins because of it
 *
 * They then priced the SECOND blocker — "the resolver cannot learn WHICH unit
 * paid" — against a design nobody had to choose. Wave 8 read the card
 * DESTINATION-first ("choose a Location, exhaust a friendly unit standing there,
 * move a different unit to it") and concluded it needed `movesTarget`, a base
 * destination on `ActivateAbilityAction` that does not exist, and a
 * payer-at-destination pair check — naming the missing base destination as a
 * blocking THIRD gap.
 *
 * The PAYER-first reading needs none of that. SFD-050 Azir - Ascendant had been
 * the precedent since SFD: he moves between arbitrary locations including a base
 * with no destination field on his action at all, because his destination is
 * another unit's location. Here it is the payer's. One field on
 * `ActivatedAbilityEvent`, one forwarding line, and the base case works because
 * `forceMoveToDestination` already dispatches on it — which is why
 * `pulls a unit HOME when the payer is in base` below is the load-bearing test
 * rather than a completeness one.
 *
 * # The pair constraint, and why it is a function
 *
 * "A DIFFERENT unit" and "to the LOCATION of the payer" constrain the PAIR, not
 * either choice alone — and the cost axis is fanned out per MODE, before any
 * target exists. So the check has to live at the cross, and both the enumerator
 * and the validator call the same `costPayerPairingAllowed`.
 */

const registry = defaultCardRegistry();
const SIGNPOST = "UNL-045";

/** The Signpost in play, with friendly units placed where `at` says: "base", or
 *  a battlefield id. An `exhausted` unit cannot pay. */
function board(
  units: { id: string; at: "base" | "bf1" | "bf2"; exhausted?: boolean }[],
  opts: { enemyAt?: "bf1" | "bf2" } = {},
): { state: GameState; gearId: string } {
  const gear = realGearInstance(SIGNPOST);
  const state = makeState({ phase: "Action", activePlayerIndex: 0, turnState: "Neutral", chainOpen: true });
  state.players[0]!.activeGear = [gear];
  for (const u of units) {
    const unit = makeUnit({ instanceId: u.id, exhausted: u.exhausted === true });
    if (u.at === "base") {
      state.players[0]!.baseUnits = [...state.players[0]!.baseUnits, unit];
    } else {
      const bf = state.battlefields.find((b) => b.id === u.at)!;
      bf.units = { ...bf.units, p1: [...(bf.units.p1 ?? []), unit] };
    }
  }
  if (opts.enemyAt) {
    const bf = state.battlefields.find((b) => b.id === opts.enemyAt)!;
    bf.units = { ...bf.units, p2: [makeUnit({ instanceId: "enemy" })] };
  }
  return { state, gearId: gear.instanceId };
}

const usesOf = (state: GameState, gearId: string): ActivateAbilityAction[] =>
  legalActions(state).filter(
    (a): a is ActivateAbilityAction => a.type === "ActivateAbility" && a.permanentInstanceId === gearId,
  );

/** Every (payer, target) pair offered, as "payer>target" for readable diffs. */
const pairsOf = (state: GameState, gearId: string): string[] =>
  usesOf(state, gearId)
    .map((a) => `${a.costPermanentInstanceId}>${a.targetUnitInstanceId}`)
    .sort();

/** Where a unit stands now — "base" or a battlefield id, or undefined if gone. */
function placeOf(state: GameState, instanceId: string): string | undefined {
  const found = findUnitAnywhere(state, instanceId);
  if (found === undefined) return undefined;
  return found.zone === "base" ? "base" : state.battlefields[found.zone.battlefieldIndex]!.id;
}

const play = (state: GameState, action: ActivateAbilityAction): GameState => {
  const { state: next, result } = submit(state, action);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return resolveHeldTriggers(next);
};

describe("the cost: exhaust a unit you control", () => {
  it("is declared as a cost, not written into the resolver", () => {
    // The distinction the three refusals were about. A resolver that exhausted a
    // unit would take it AFTER the ability was already paid for and on the chain,
    // which is not what a cost line means.
    expect(activationCostOf(SIGNPOST), "the printed cost stopped being a cost").toMatchObject({
      exhaust: true,
      exhaustFriendlyUnit: true,
    });
  });

  it("offers only READY friendly units as payers", () => {
    // 416.3 — a cost that cannot be completed is not one you may choose to pay,
    // and there is nothing to take from a unit already exhausted.
    const { state, gearId } = board([
      { id: "ready", at: "bf1" },
      { id: "spent", at: "bf2", exhausted: true },
      { id: "other", at: "base" },
    ]);

    const payers = new Set(usesOf(state, gearId).map((a) => a.costPermanentInstanceId));
    expect(payers, "no payer was offered at all").toContain("ready");
    expect(payers, "an exhausted unit was offered as a payment").not.toContain("spent");
  });

  it("counts a unit in BASE as a payer, and an enemy as neither payer nor target", () => {
    // 355.9.a.1 widens a bare "a unit you control" to the whole Board, base
    // included. That is not a nicety here: the payer's location IS the
    // destination, so a payer at home is the only way this card pulls anybody back.
    const { state, gearId } = board([{ id: "home", at: "base" }, { id: "away", at: "bf1" }], { enemyAt: "bf1" });
    const offered = usesOf(state, gearId);

    expect(new Set(offered.map((a) => a.costPermanentInstanceId)), "a base unit could not pay").toContain("home");
    expect(exhaustableFriendlyUnits(state, 0).map((u) => u.instanceId).sort(), "the walk saw an enemy").toEqual([
      "away",
      "home",
    ]);
    for (const a of offered) {
      expect(a.costPermanentInstanceId, "an enemy unit was offered as a payment").not.toBe("enemy");
      expect(a.targetUnitInstanceId, "an enemy unit was offered as a target").not.toBe("enemy");
    }
  });

  it("is not offered at all when every friendly unit is exhausted", () => {
    const { state, gearId } = board([
      { id: "a", at: "bf1", exhausted: true },
      { id: "b", at: "bf2", exhausted: true },
    ]);
    expect(usesOf(state, gearId), "an unpayable ability was offered").toHaveLength(0);

    // **Asked of `canPayActivationCost` DIRECTLY as well**, and that is not
    // belt-and-braces. The line above passes with the affordability gate deleted,
    // because an empty payer list makes `activationCostChoices`' flatMap collapse
    // and nothing gets pushed — mutation testing showed exactly that. The gate is
    // still the right place for the answer: it is what the heuristic AI asks, and
    // it is what would still refuse if a mode ever reached the push without going
    // through the cost fan-out, which is how Malzahar lost his kill axis once.
    const gear = state.players[0]!.activeGear[0]!;
    expect(canPayActivationCost(state, 0, gear, SIGNPOST), "an ability with nothing to exhaust said it could pay").toBe(
      false,
    );
  });
});

describe("the PAIR — 'a different unit', 'to the location of' the payer", () => {
  it("never pairs a unit with itself, and never moves a unit to where it already is", () => {
    // Both halves in one measurement, because both are properties of the PAIR and
    // the two axes are fanned out independently. `a` and `b` share bf1: pairing
    // them either way would be a move to the same battlefield, paid for.
    const { state, gearId } = board([
      { id: "a", at: "bf1" },
      { id: "b", at: "bf1" },
      { id: "c", at: "bf2" },
    ]);

    expect(pairsOf(state, gearId), "the pair filter is wrong").toEqual(["a>c", "b>c", "c>a", "c>b"]);
  });

  it("pairs across base and battlefield in BOTH directions", () => {
    // The card moves a unit out to the front OR pulls one home, depending only on
    // which of the two is exhausted — so both directions must be on offer.
    const { state, gearId } = board([
      { id: "home", at: "base" },
      { id: "away", at: "bf1" },
    ]);

    expect(pairsOf(state, gearId), "one of the two directions is missing").toEqual(["away>home", "home>away"]);
  });

  it("offers nothing when the only two friendly units share a location", () => {
    const { state, gearId } = board([
      { id: "a", at: "base" },
      { id: "b", at: "base" },
    ]);
    expect(usesOf(state, gearId), "a move to nowhere was offered").toHaveLength(0);
  });
});

describe("the enumerator and the validator agree", () => {
  it("every offered pair validates", () => {
    const { state, gearId } = board([
      { id: "a", at: "bf1" },
      { id: "b", at: "bf2" },
      { id: "c", at: "base" },
    ]);
    const offered = usesOf(state, gearId);

    expect(offered.length, "nothing was offered — this asserts nothing").toBe(6);
    for (const action of offered) {
      const verdict = validateActivateAbility(state, action);
      expect(verdict.ok, verdict.ok ? "" : `offered but refused: ${verdict.error}`).toBe(true);
    }
  });

  it("REFUSES a forged self-pairing", () => {
    const { state, gearId } = board([{ id: "a", at: "bf1" }, { id: "b", at: "bf2" }]);
    const real = usesOf(state, gearId)[0]!;
    const forged: ActivateAbilityAction = { ...real, costPermanentInstanceId: real.targetUnitInstanceId! };

    expect(validateActivateAbility(state, forged).ok, "a unit exhausted itself to move itself").toBe(false);
  });

  it("REFUSES a forged EXHAUSTED payer", () => {
    const { state, gearId } = board([
      { id: "a", at: "bf1" },
      { id: "b", at: "bf2" },
      { id: "spent", at: "base", exhausted: true },
    ]);
    const real = usesOf(state, gearId).find((a) => a.targetUnitInstanceId === "a")!;
    const forged: ActivateAbilityAction = { ...real, costPermanentInstanceId: "spent" };

    expect(validateActivateAbility(state, forged).ok, "an exhausted unit paid a cost").toBe(false);
  });

  it("REFUSES a forged ENEMY payer", () => {
    const { state, gearId } = board([{ id: "a", at: "bf1" }, { id: "b", at: "bf2" }], { enemyAt: "bf2" });
    const real = usesOf(state, gearId).find((a) => a.targetUnitInstanceId === "a")!;
    const forged: ActivateAbilityAction = { ...real, costPermanentInstanceId: "enemy" };

    expect(validateActivateAbility(state, forged).ok, "an opponent's unit paid the cost").toBe(false);
  });

  it("REFUSES a forged pair whose payer and target already share a location", () => {
    const { state, gearId } = board([
      { id: "a", at: "bf1" },
      { id: "b", at: "bf1" },
      { id: "c", at: "bf2" },
    ]);
    const real = usesOf(state, gearId).find((a) => a.targetUnitInstanceId === "a")!;
    const forged: ActivateAbilityAction = { ...real, costPermanentInstanceId: "b" };

    expect(validateActivateAbility(state, forged).ok, "a unit was moved to where it already stood").toBe(false);
  });
});

describe("resolving it", () => {
  it("moves the target to the payer's battlefield and leaves the payer exhausted where it is", () => {
    const { state, gearId } = board([{ id: "mover", at: "base" }, { id: "anchor", at: "bf2" }]);
    const action = usesOf(state, gearId).find((a) => a.costPermanentInstanceId === "anchor")!;

    const after = play(state, action);

    expect(placeOf(after, "mover"), "the target did not move to the payer").toBe("bf2");
    expect(placeOf(after, "anchor"), "the payer moved — this is not a swap").toBe("bf2");
    expect(findUnitAnywhere(after, "anchor")?.unit.exhausted, "the cost was never taken").toBe(true);
    expect(after.players[0]!.activeGear[0]!.exhausted, "the source's own exhaust was not taken").toBe(true);
  });

  it("pulls a unit HOME when the payer is in base", () => {
    // **The case the third "blocking gap" was about.** A destination-first design
    // would have needed a `destinationIsBase` on `ActivateAbilityAction`, which
    // does not exist; reading the payer's location instead makes it fall out of
    // `forceMoveToDestination`, which has dispatched on base since the Spell path
    // needed it.
    const { state, gearId } = board([{ id: "home", at: "base" }, { id: "away", at: "bf1" }]);
    const action = usesOf(state, gearId).find((a) => a.costPermanentInstanceId === "home")!;

    const after = play(state, action);

    expect(placeOf(after, "away"), "the unit was not pulled home").toBe("base");
    expect(placeOf(after, "home"), "the payer left its base").toBe("base");
  });

  it("re-reads the payer's location at RESOLUTION, not at announce", () => {
    // 383.3 — the chain item is independent of the card that made it, and this
    // card's destination names a unit, so where that unit is NOW is the answer.
    //
    // Driven against `resolve` directly rather than through `submit`, because the
    // window this is about is between the two: the activation goes on the chain,
    // a reaction moves the payer, and only then does this run. Nothing in the
    // action path can stage that, and asserting it through `submit` anyway would
    // have measured the announce-time board and passed either way.
    const { state, gearId } = board([{ id: "mover", at: "base" }, { id: "anchor", at: "bf2" }]);
    const action = usesOf(state, gearId).find((a) => a.costPermanentInstanceId === "anchor")!;
    expect(action, "the fixture never produced the pair").toBeDefined();
    const resolve = modesOf(SIGNPOST)[0]!.resolve;

    // The payer has since walked from bf2 to bf1.
    const moved = structuredClone(state);
    moved.battlefields.find((b) => b.id === "bf2")!.units = {};
    moved.battlefields.find((b) => b.id === "bf1")!.units = { p1: [makeUnit({ instanceId: "anchor" })] };

    const after = resolve(
      moved,
      { casterIndex: 0 } as never,
      { targetUnitInstanceId: "mover", costPermanentInstanceId: "anchor" },
      gearId,
    );

    expect(placeOf(after, "mover"), "the destination was latched at announce").toBe("bf1");
  });

  it("moves nobody when the payer is gone by resolution", () => {
    // The other half of reading it late: a payer that has been killed in the
    // window leaves no location to name, and 055's do-as-much-as-you-can does not
    // invent one. Without the guard `findUnitAnywhere` returns undefined and the
    // `.zone` read throws, which is a crash rather than a fizzle.
    const { state, gearId } = board([{ id: "mover", at: "base" }, { id: "anchor", at: "bf2" }]);
    const resolve = modesOf(SIGNPOST)[0]!.resolve;

    const gone = structuredClone(state);
    gone.battlefields.find((b) => b.id === "bf2")!.units = {};

    const after = resolve(gone, { casterIndex: 0 } as never, { targetUnitInstanceId: "mover", costPermanentInstanceId: "anchor" }, gearId);
    expect(placeOf(after, "mover"), "the target moved to a location nobody was at").toBe("base");
  });
});

describe("coverage", () => {
  it("reports the card finished", () => {
    const def = registry.get(SIGNPOST);
    expect(isCardImplemented(def), "it still reports unfinished").toBe(true);
    expect(partialImplementationNote(def), "it carries a partial note").toBeUndefined();
  });
});
