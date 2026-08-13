import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { sacrificeCostDiscount } from "../src/engine/cost-modifiers.js";
import { isCardImplemented, partialImplementationNote, implementingModules } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * **Atakhan (UNL-170) — "You may kill a friendly unit as an additional cost to
 * play me. If you do, I cost [1] less for each Energy it costs and [Order] less
 * for each Power it costs."**
 *
 * The pool's first additional cost whose DISCOUNT is a function of what was
 * spent. Every other one is a fixed number — Commander Ledros and Kraken Hunter
 * buy a flat 1 Power per unit (`repeatable`), Call to Glory zeroes the cost
 * outright (`ignoresCostWhenPaid`) — so his refusal across two waves was
 * accurate: the kill was expressible and the price was not.
 *
 * # Why this is priced per VARIANT
 *
 * Its size depends on WHICH unit is named, so the same Atakhan is a different
 * price under each variant the enumerator emits. That rules out
 * `modifiedEnergyCost`, where every board-keyed discount lives, because that is
 * computed once per card before any choice exists.
 *
 * Both pricing sites therefore re-run the reduced cost through
 * `computeEffectiveCost` rather than subtracting after it. Subtracting after is
 * a bug this file's neighbours already record making: it skips the
 * floating-Energy reduction the plain path applies, and enumeration then offers
 * a payment the validator prices differently — an offered-then-refused action,
 * which is how five crashes here have surfaced.
 *
 * So the tests below measure the ACTUAL RUNE COUNT of each enumerated variant,
 * not just the discount function. A correct helper wired in wrongly would pass
 * every unit test of the helper alone.
 *
 * # Printed cost, not board state
 *
 * "For each Energy it COSTS" is the sacrifice's printed cost — the rules' Defy
 * example, "always uses its printed or copied cost". A pumped or damaged unit is
 * worth exactly what it prints, and a TOKEN has no printed cost so it buys
 * nothing.
 */

const registry = defaultCardRegistry();
const ATAKHAN = "UNL-170";
const PRINTED_ENERGY = 10;
const PRINTED_POWER = 3;

/** Jinx - Demolitionist: 3 Energy, 1 Power. The ordinary sacrifice. */
const JINX = "OGN-030";
const JINX_ENERGY = 3;
const JINX_POWER = 1;
/** Determined Sentry: 1 Energy, 0 Power — a sacrifice that moves only one axis. */
const SENTRY = "UNL-111";
/** Volibear - Imposing: 12 Energy, 2 Power — more expensive than Atakhan himself. */
const VOLIBEAR = "OGN-158";

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

/**
 * Atakhan in hand with `units` to sacrifice, paid for entirely from CHANNELLED
 * runes — no floating Energy, so the rune count of an enumerated payment IS the
 * price and the assertions below can read it directly.
 */
function board(units: UnitInstance[]): { state: GameState; atakhan: UnitInstance } {
  const atakhan = realUnitInstance(ATAKHAN);
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.hand = [atakhan];
  state.players[0]!.baseUnits = units;
  state.players[0]!.channeled = Array.from({ length: 24 }, (_, i) => rune(`o${i}`, "Order"));
  return { state, atakhan };
}

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

/** What a variant actually costs, counted in runes it names. */
const priceOf = (a: PlayCardAction): { energy: number; power: number } => ({
  energy: a.payment.energyRunes.length,
  power: a.payment.powerRunes.length,
});

const declineOf = (plays: PlayCardAction[]): PlayCardAction =>
  plays.find((a) => a.additionalCostUnitInstanceId === undefined)!;
const paidWith = (plays: PlayCardAction[], instanceId: string): PlayCardAction =>
  plays.find((a) => a.additionalCostUnitInstanceId === instanceId)!;

describe("the cost is OPTIONAL — he is castable with nothing to sacrifice", () => {
  it("is offered at his full printed price on an empty board", () => {
    // "You MAY kill" — unlike Cruel Patron and Stalking Wolf, whose kills are
    // mandatory and who are simply unplayable with no unit to spend.
    const { state, atakhan } = board([]);
    const plays = playsOf(state, atakhan.instanceId);

    expect(plays.length, "he was not offered at all with nothing to kill").toBeGreaterThan(0);
    expect(priceOf(declineOf(plays)), "the undiscounted price is not his printed cost").toEqual({
      energy: PRINTED_ENERGY,
      power: PRINTED_POWER,
    });
  });

  it("still offers the decline variant when a sacrifice IS available", () => {
    // The half that makes "may" mean may. Without it a player is forced to eat a
    // unit to cast him at all.
    const { state, atakhan } = board([realUnitInstance(JINX)]);
    const plays = playsOf(state, atakhan.instanceId);

    expect(declineOf(plays), "declining stopped being offered").toBeDefined();
    expect(priceOf(declineOf(plays)), "the decline variant was discounted anyway").toEqual({
      energy: PRINTED_ENERGY,
      power: PRINTED_POWER,
    });
  });
});

describe("the discount scales with the sacrifice's PRINTED cost, on both axes", () => {
  it("killing a 3-Energy 1-Power unit takes 3 and 1 off", () => {
    const jinx = realUnitInstance(JINX);
    const { state, atakhan } = board([jinx]);
    const plays = playsOf(state, atakhan.instanceId);

    expect(priceOf(paidWith(plays, jinx.instanceId)), "the discount did not scale with the sacrifice").toEqual({
      energy: PRINTED_ENERGY - JINX_ENERGY,
      power: PRINTED_POWER - JINX_POWER,
    });
  });

  it("a 1-Energy 0-Power sacrifice moves only the Energy axis", () => {
    // The test a discount that applied one number to both axes would fail, and
    // that the Jinx case above cannot catch on its own.
    const sentry = realUnitInstance(SENTRY);
    const { state, atakhan } = board([sentry]);
    const plays = playsOf(state, atakhan.instanceId);

    expect(priceOf(paidWith(plays, sentry.instanceId)), "a 0-Power sacrifice moved the Power axis").toEqual({
      energy: PRINTED_ENERGY - 1,
      power: PRINTED_POWER,
    });
  });

  it("one variant per friendly unit, each priced for its own sacrifice", () => {
    const jinx = realUnitInstance(JINX);
    const sentry = realUnitInstance(SENTRY);
    const { state, atakhan } = board([jinx, sentry]);
    const plays = playsOf(state, atakhan.instanceId);

    expect(priceOf(paidWith(plays, jinx.instanceId)).energy).toBe(PRINTED_ENERGY - JINX_ENERGY);
    expect(priceOf(paidWith(plays, sentry.instanceId)).energy).toBe(PRINTED_ENERGY - 1);
  });

  it("the two axes floor INDEPENDENTLY — surplus on one does not spill onto the other", () => {
    // Volibear prints 12 Energy and 2 Power against Atakhan's 10 and 3. So the
    // Energy axis overshoots by 2 and floors at free, while the Power axis is an
    // ordinary 3 - 2 = 1.
    //
    // **The expectation here was wrong on the first run** — it asserted both went
    // to zero, on the assumption that an over-sized sacrifice pays for everything.
    // Nothing in the card says that: the two clauses are counted separately, and
    // the surplus Energy is simply wasted. That is the behaviour worth pinning,
    // since a implementation that summed the sacrifice's cost into one number, or
    // that let the overshoot carry, would look right on every other test here.
    const voli = realUnitInstance(VOLIBEAR);
    const { state, atakhan } = board([voli]);
    const plays = playsOf(state, atakhan.instanceId);

    expect(priceOf(paidWith(plays, voli.instanceId)), "the axes did not floor independently").toEqual({
      energy: 0,
      power: PRINTED_POWER - 2,
    });
  });

  it("a TOKEN buys nothing — it has no printed cost to count", () => {
    // `makeUnit` produces an instance with no registry definition behind it,
    // which is exactly a token's shape.
    const token = makeUnit({ instanceId: "tok", name: "Recruit", might: 1 });
    const { state, atakhan } = board([token]);
    const plays = playsOf(state, atakhan.instanceId);

    expect(priceOf(paidWith(plays, "tok")), "a token discounted him").toEqual({
      energy: PRINTED_ENERGY,
      power: PRINTED_POWER,
    });
  });
});

describe("the two pricing sites agree", () => {
  it("every enumerated variant validates at the price it was offered at", () => {
    // The offered-then-refused crash, and the reason both sites re-run the
    // reduced cost through `computeEffectiveCost` instead of subtracting after.
    const { state, atakhan } = board([realUnitInstance(JINX), realUnitInstance(SENTRY), realUnitInstance(VOLIBEAR)]);
    const plays = playsOf(state, atakhan.instanceId);

    expect(plays.length, "nothing was enumerated — this test would be vacuous").toBeGreaterThan(3);
    for (const play of plays) {
      expect(validatePlayCard(state, play).ok, `an offered variant was refused: ${JSON.stringify(play.payment)}`).toBe(
        true,
      );
    }
  });

  it("the validator REFUSES a variant that underpays for its sacrifice", () => {
    // A hand-built action claiming the big discount while naming the small
    // sacrifice. Only reachable directly, and without the validator computing the
    // discount itself it would be accepted.
    const jinx = realUnitInstance(JINX);
    const sentry = realUnitInstance(SENTRY);
    const { state, atakhan } = board([jinx, sentry]);
    const plays = playsOf(state, atakhan.instanceId);

    const cheap = paidWith(plays, jinx.instanceId); // priced at -3 Energy
    const forged: PlayCardAction = { ...cheap, additionalCostUnitInstanceId: sentry.instanceId }; // only worth -1

    expect(validatePlayCard(state, forged).ok, "he was bought at a discount his sacrifice did not pay for").toBe(false);
  });
});

describe("the sacrifice is actually killed", () => {
  it("the named unit dies when he resolves; the declined variant kills nothing", () => {
    const jinx = realUnitInstance(JINX);
    const { state, atakhan } = board([jinx]);
    const plays = playsOf(state, atakhan.instanceId);

    const { state: played, result } = submit(state, paidWith(plays, jinx.instanceId));
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
    // He is a Unit, so the kill is his on-play trigger resolving off the Chain.
    const after = resolveHeldTriggers(played);
    expect(after.players[0]!.baseUnits.some((u) => u.instanceId === jinx.instanceId), "the price went unpaid").toBe(
      false,
    );

    const declined = resolveHeldTriggers(submit(state, declineOf(plays)).state);
    expect(
      declined.players[0]!.baseUnits.some((u) => u.instanceId === jinx.instanceId),
      "declining the cost killed something anyway",
    ).toBe(true);
  });
});

describe("the discount function itself", () => {
  it("is his and nobody else's, and needs a unit actually named", () => {
    const jinx = realUnitInstance(JINX);
    const { state } = board([jinx]);

    expect(sacrificeCostDiscount(state, 0, ATAKHAN, jinx.instanceId)).toEqual({ energy: JINX_ENERGY, power: JINX_POWER });
    expect(sacrificeCostDiscount(state, 0, ATAKHAN, undefined), "it discounted with nothing named").toEqual({
      energy: 0,
      power: 0,
    });
    expect(sacrificeCostDiscount(state, 0, "OGN-208", jinx.instanceId), "Cruel Patron got Atakhan's discount").toEqual({
      energy: 0,
      power: 0,
    });
  });

  it("does not reach the OPPONENT's units", () => {
    // Looked up under the caster's own board, so an enemy instance id finds
    // nothing — which is the right answer for a cost paid with YOUR unit.
    const theirs = realUnitInstance(JINX);
    const { state } = board([]);
    state.players[1]!.baseUnits = [theirs];

    expect(sacrificeCostDiscount(state, 0, ATAKHAN, theirs.instanceId), "an enemy unit paid his cost").toEqual({
      energy: 0,
      power: 0,
    });
  });
});

describe("coverage", () => {
  it("is whole, with all four of his registrations intact", () => {
    expect(isCardImplemented(registry.get(ATAKHAN)), "Atakhan is greyed").toBe(true);
    expect(partialImplementationNote(registry.get(ATAKHAN)), "he still names a missing half").toBeUndefined();

    const modules = implementingModules(ATAKHAN);
    expect(modules, "the sacrifice cost stopped being claimed").toContain("unit-triggers");
    expect(modules, "the scaled discount stopped being claimed").toContain("cost-modifiers");
    expect(modules, "his attack trigger stopped being claimed").toContain("event triggers");
  });

  it("his printed cost still matches the numbers here", () => {
    const def = registry.get(ATAKHAN) as { energyCost: number; powerCost: number; text?: string };
    expect(def.energyCost, "his printed Energy changed").toBe(PRINTED_ENERGY);
    expect(def.powerCost, "his printed Power changed").toBe(PRINTED_POWER);
    expect(def.text ?? "", "he stopped printing the optional sacrifice").toContain("You may kill a friendly unit");
  });
});
