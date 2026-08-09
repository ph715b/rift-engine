import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { holdEventTrigger } from "../src/engine/triggers.js";
import { pendingDecision } from "../src/engine/decisions.js";
import { discountedOptionalCosts } from "../src/engine/cost-modifiers.js";
import { isSpellChainEntry } from "../src/model/game-state.js";
import type { GameState } from "../src/model/game-state.js";
import type { ActivateAbilityAction, PlayCardAction } from "../src/actions/player-action.js";
import type { Domain } from "../src/model/domain.js";
import type { RuneCard } from "../src/model/rune.js";
import {
  answerDecisions,
  beginCombatAt,
  makeState,
  makeUnit,
  realGearInstance,
  realUnitInstance,
  spellInstance,
} from "./fixtures.js";

/**
 * Ezreal - Prodigy (SFD-149) — "Optional additional costs you pay cost [1] or
 * [rainbow] less."
 *
 * Reported from playtesting 2026-08-08: a `[Repeat]` paid under Ezreal was not
 * getting cheaper. It was not — his discount reached only two of the four
 * optional additional costs the engine prices, and even those were unreachable,
 * because the axis the discount rides was refused by a guard that asked only
 * whether Irelia - Graceful (who shares the field) had been chosen.
 *
 * The old tests for this card called `optionalCostDiscount` directly and were
 * green throughout. So everything here goes through `legalActions` and `submit`:
 * the whole defect lived in the hop between the discount function and the play.
 *
 * `[Repeat]` is an Optional Additional Cost by name — rule 820's "Repeat is an
 * Optional Additional Cost keyword", and 356.4.c's worked example is *Ezreal
 * discounting a Frigid Touch's Repeat*, which is the second case below.
 *
 * **2026-08-08, project-owner ruling: ONCE PER QUALIFYING OPTIONAL ADDITIONAL
 * COST, not once per play.** The engine shipped the conservative summed reading
 * that morning; the ruling settles it the other way. Nothing in the single-cost
 * cases below moves — one cost is still one pip — so no assertion here was
 * weakened to accommodate it. What changes is the two-cost board, and it has its
 * own describe at the bottom of this file, along with the three scope claims the
 * ruling makes beside the count (mandatory costs, in-effect payments, and
 * `[Repeat]` referencing the PRINTED cost).
 */

const EZREAL_PRODIGY = "SFD-149";
const CALLED_SHOT = "SFD-122"; // [0][Chaos]; [Repeat] [Chaos] — the reported card
const FRIGID_TOUCH = "SFD-066"; // [2]; [Repeat] [2] — 356.4.c's own worked example
const PIERCING_LIGHT = "SFD-023"; // [2][Fury]; [Repeat] [2][Fury] — both axes bite
const DRAVEN_VANQUISHER = "SFD-020";

const runes = (domain: Domain, count: number): RuneCard[] =>
  Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

/** A caster holding one spell, with `count` runes of `domain`, and Ezreal in
 *  base or not. His clause names no location, so base is where he goes. */
function caster(defId: string, domain: Domain, count: number, withEzreal: boolean) {
  const spell = spellInstance(defId);
  const state = makeState({ phase: "Action" });
  state.players[0]!.hand = [spell];
  state.players[0]!.channeled = runes(domain, count);
  state.players[0]!.deck = [makeUnit(), makeUnit(), makeUnit(), makeUnit()];
  if (withEzreal) state.players[0]!.baseUnits = [{ ...realUnitInstance(EZREAL_PRODIGY), instanceId: "ezreal" }];
  return { state, spellId: spell.instanceId };
}

const repeatPlaysOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter(
    (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId && a.repeatPaid === true,
  );

/** Runes a play actually spends — Energy and Power both, since the two axes are
 *  the whole point and a discount on one must not be read off the other. */
const spend = (play: PlayCardAction) => ({
  energy: play.payment.energyRunes.length,
  power: play.payment.powerRunes.length + (play.payment.rainbowRunes ?? []).length,
});

describe("Ezreal - Prodigy discounts a [Repeat] cost (820: Repeat IS an optional additional cost)", () => {
  /**
   * Called Shot is the reported card and the sharpest instrument: it prints
   * [0][Chaos] and its Repeat is a bare [Chaos], so one Chaos rune is the exact
   * boundary between "repeat is free" and "repeat is unaffordable". A board with
   * ONE rune therefore cannot report a false pass — there is no cheaper payment
   * for the enumerator to have found by accident.
   */
  it("makes Called Shot's [Repeat] free — offered on one rune only with him out", () => {
    const withEzreal = caster(CALLED_SHOT, "Chaos", 1, true);
    const without = caster(CALLED_SHOT, "Chaos", 1, false);

    expect(repeatPlaysOf(without.state, without.spellId), "one Chaos cannot pay the card AND its Repeat").toHaveLength(0);
    const offered = repeatPlaysOf(withEzreal.state, withEzreal.spellId);
    expect(offered.length, "no discounted [Repeat] was offered").toBeGreaterThan(0);
    expect(spend(offered[0]!)).toEqual({ energy: 0, power: 1 });
  });

  /** 356.4.c's worked example, in the rules' own words: "When playing a Frigid
   *  Touch and choosing to pay the additional cost ... Ezreal, Prodigy's discount
   *  is applied to it." Frigid Touch is [2] with a [Repeat] [2], so four Energy
   *  becomes three. */
  it("makes Frigid Touch's [Repeat] [2] cost [1] — the rules' own example", () => {
    const withEzreal = caster(FRIGID_TOUCH, "Mind", 3, true);
    const without = caster(FRIGID_TOUCH, "Mind", 3, false);

    expect(repeatPlaysOf(without.state, without.spellId), "three Energy cannot pay 2 + 2").toHaveLength(0);
    const offered = repeatPlaysOf(withEzreal.state, withEzreal.spellId);
    expect(offered.length, "no discounted [Repeat] was offered").toBeGreaterThan(0);
    expect(spend(offered[0]!).energy).toBe(3);
  });

  /** The axis is a real choice, not a spelling: Piercing Light's Repeat is
   *  [2][Fury], so one pip comes off the Energy or off the Power and the two are
   *  different payments. Both must be on offer. */
  it("offers BOTH axes when the additional cost has both pips", () => {
    const { state, spellId } = caster(PIERCING_LIGHT, "Fury", 8, true);
    // It deals damage to a unit AT A BATTLEFIELD, so an empty board makes it
    // untargetable and the enumerator offers nothing at all — which would read
    // as "the axis is missing" rather than as "the card was never enumerated".
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "victim", might: 9 })] };
    const offered = repeatPlaysOf(state, spellId);
    const shapes = new Set(offered.map((p) => `${spend(p).energy}/${spend(p).power}`));
    // Printed [2][Fury] plus Repeat [2][Fury] is 4 Energy and 2 Power undiscounted.
    expect(shapes.has("3/2"), `energy axis missing, saw ${[...shapes].join(" ")}`).toBe(true);
    expect(shapes.has("4/1"), `power axis missing, saw ${[...shapes].join(" ")}`).toBe(true);
  });

  /**
   * The offered play must survive the validator and `submit` — this engine's
   * recorded failure mode is the enumerator and the validator pricing the same
   * play differently, and an offered-then-refused discount would look exactly
   * like a working one from `legalActions` alone.
   */
  it("the discounted play validates and is accepted by submit", () => {
    const { state, spellId } = caster(CALLED_SHOT, "Chaos", 1, true);
    const play = repeatPlaysOf(state, spellId)[0]!;

    expect(validatePlayCard(state, play)).toMatchObject({ ok: true });
    const { result, state: after } = submit(state, play);
    expect(result, `the discounted play was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
    expect(after.spellChain.length, "the spell never reached the chain").toBeGreaterThan(0);
  });

  /** The discount is bought by PAYING an optional additional cost, so a play that
   *  pays none of them may not claim the axis (356.4.f.1's "was paid if the player
   *  made the decision to pay it"). */
  it("refuses the axis on a play that pays no optional additional cost", () => {
    const { state, spellId } = caster(CALLED_SHOT, "Chaos", 2, true);
    const plain = legalActions(state).find(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === spellId && a.repeatPaid !== true,
    )!;

    const claimed = { ...plain, targetDiscountAxis: "power" as const, payment: { energyRunes: [], powerRunes: [] } };
    expect(validatePlayCard(state, claimed)).toMatchObject({ ok: false });
  });

  /** Without him on the board the axis buys nothing and the same claim is refused
   *  — the negative control for the guard above. */
  it("refuses the axis while he is not in play", () => {
    const { state, spellId } = caster(CALLED_SHOT, "Chaos", 2, false);
    const repeatPlay = repeatPlaysOf(state, spellId)[0]!;
    const claimed = {
      ...repeatPlay,
      targetDiscountAxis: "power" as const,
      payment: { energyRunes: [], powerRunes: [repeatPlay.payment.powerRunes[0]!] },
    };
    expect(validatePlayCard(state, claimed)).toMatchObject({ ok: false });
  });
});

/**
 * The other three optional additional costs the engine prices. The report named
 * `[Repeat]`; the card says "optional additional costs", and 805/805.2 and 820.1.c.2
 * put `[Accelerate]` and Temporal Portal's granted instance under the same
 * heading. All four were unreachable in a real game for the same two reasons, so
 * all four get a positive control that counts the new path being taken.
 */
describe("Ezreal - Prodigy reaches the other optional additional costs too", () => {
  /**
   * Legion Rearguard is [2] with `[Accelerate]` [1][Fury] — 356.1.b.3's own worked
   * example of an additional cost surviving a cost-ignoring effect, and the
   * cheapest accelerable body in the pool.
   *
   * TWO runes, not three: 164.2's double duty lets one Ready rune recycled for
   * Power also pay an Energy, so three runes already cover 3 Energy + [Fury] and
   * the control would have passed against the unfixed engine. It did — that is
   * why the number is written down.
   */
  it("makes [Accelerate] one pip cheaper", () => {
    const accelerated = (withEzreal: boolean) => {
      const unit = spellInstance("OGN-010"); // a real CardInstance; kind is Unit
      const state = makeState({ phase: "Action" });
      state.players[0]!.hand = [unit];
      state.players[0]!.channeled = runes("Fury", 2);
      if (withEzreal) state.players[0]!.baseUnits = [{ ...realUnitInstance(EZREAL_PRODIGY), instanceId: "ezreal" }];
      return {
        state,
        plays: legalActions(state).filter(
          (a): a is PlayCardAction =>
            a.type === "PlayCard" && a.card.instanceId === unit.instanceId && a.acceleratePaid === true,
        ),
      };
    };

    expect(accelerated(false).plays, "two Fury cannot pay [2] plus [1][Fury]").toHaveLength(0);
    const { state, plays } = accelerated(true);
    expect(plays.length, "no discounted [Accelerate] was offered").toBeGreaterThan(0);
    for (const play of plays) expect(validatePlayCard(state, play), JSON.stringify(play.payment)).toMatchObject({ ok: true });
  });

  /** Clockwork Keeper's "you may pay [Calm] as an additional cost ... draw 1" —
   *  the OPTIONAL_POWER_COSTS shape. On a pool with no Calm rune at all the paid
   *  variant is impossible; Ezreal's [rainbow] axis erases the pip, and 356.4.f.1
   *  is explicit that the cost still counts as PAID, so the draw still happens. */
  it("makes an optional Power cost payable with no rune of its domain", () => {
    const keeperPlays = (withEzreal: boolean) => {
      const keeper = spellInstance("OGN-044");
      const state = makeState({ phase: "Action" });
      state.players[0]!.hand = [keeper];
      state.players[0]!.channeled = runes("Chaos", 2);
      state.players[0]!.deck = [makeUnit()];
      if (withEzreal) state.players[0]!.baseUnits = [{ ...realUnitInstance(EZREAL_PRODIGY), instanceId: "ezreal" }];
      return {
        state,
        plays: legalActions(state).filter(
          (a): a is PlayCardAction =>
            a.type === "PlayCard" && a.card.instanceId === keeper.instanceId && a.optionalPowerPaid === true,
        ),
      };
    };

    expect(keeperPlays(false).plays, "there is no Calm rune to pay with").toHaveLength(0);
    const { state, plays } = keeperPlays(true);
    expect(plays.length, "no discounted optional Power cost was offered").toBeGreaterThan(0);
    const { result } = submit(state, plays[0]!);
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  });
});

/**
 * The sweep, and the reason this change is four branches rather than one.
 *
 * Every one of those branches now writes `targetDiscountAxis` onto an action, and
 * this file's standing bug is the enumerator and the validator pricing the same
 * play differently — an offered-then-refused split, shipped three times before.
 * So: enumerate everything on a board where all four costs are live, and validate
 * every candidate. Gated on the counts, because "0 refused out of 0" reads
 * exactly like a pass.
 */
describe("everything the enumerator offers under Ezreal, the validator accepts", () => {
  it("prices every discounted candidate identically at both ends", () => {
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [
      spellInstance(CALLED_SHOT),
      spellInstance(FRIGID_TOUCH),
      spellInstance(PIERCING_LIGHT),
      spellInstance("SFD-182"), // Danger Zone — [Repeat] [1][rainbow], the rainbow bucket
      spellInstance("OGN-010"), // Legion Rearguard — [Accelerate]
      spellInstance("OGN-044"), // Clockwork Keeper — an optional Power cost
    ];
    state.players[0]!.channeled = [...runes("Chaos", 4), ...runes("Fury", 4), ...runes("Mind", 4)];
    state.players[0]!.deck = Array.from({ length: 8 }, () => makeUnit());
    state.players[0]!.baseUnits = [{ ...realUnitInstance(EZREAL_PRODIGY), instanceId: "ezreal" }];
    state.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "mine" })], p2: [makeUnit({ instanceId: "theirs" })] };

    const plays = legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard");
    const discounted = plays.filter((p) => p.targetDiscountAxis !== undefined);

    expect(plays.length, "nothing was enumerated at all").toBeGreaterThan(0);
    expect(discounted.length, "no candidate carried Ezreal's axis — the sweep proved nothing").toBeGreaterThan(0);
    const refused = plays
      .map((p) => ({ p, v: validatePlayCard(state, p) }))
      .filter(({ v }) => !v.ok);
    expect(
      refused.map(({ p, v }) => `${p.card.name} ${p.targetDiscountAxis ?? "-"}: ${"error" in v ? v.error : ""}`),
      "the enumerator offered a play the validator refused",
    ).toEqual([]);
  });
});

/**
 * The OTHER half of the playtest report, and it is a rules question rather than a
 * defect.
 *
 * Draven - Vanquisher reads "When I attack or defend, you may pay [Fury]. If you
 * do, give me +2 [Might] this turn." Rule 205's own worked example is that exact
 * sentence — *"When I attack, you may pay [4][C]. If you do, kill a unit here."*
 * — and rules that it "is not a cost of the ability, base or otherwise, but a
 * game action being performed by a player". Not a cost at all, so not an OPTIONAL
 * ADDITIONAL cost, so Ezreal does not touch it.
 *
 * Pinned rather than left implicit: "it did not get cheaper" is indistinguishable
 * from "the discount never ran" unless something asserts the price is meant to
 * stand.
 */
describe("Draven - Vanquisher's [Fury] is NOT an additional cost, so Ezreal leaves it alone (205)", () => {
  function fighting(furyRunes: number, withEzreal: boolean) {
    const draven = realUnitInstance(DRAVEN_VANQUISHER);
    const state = makeState({ phase: "Action" });
    state.players[0]!.channeled = runes("Fury", furyRunes);
    if (withEzreal) state.players[0]!.baseUnits = [{ ...realUnitInstance(EZREAL_PRODIGY), instanceId: "ezreal" }];
    state.battlefields[0]!.units = { p1: [draven], p2: [makeUnit({ might: 20 })] };
    return { state, draven };
  }

  it("does not trigger on an empty pool even with Ezreal out", () => {
    const { state } = fighting(0, true);
    const held = holdEventTrigger(state, { kind: "combatBegan", battlefieldId: "bf1", designated: [] });
    expect(held.pendingTriggers.map((t) => t.listenerDefId)).not.toContain(DRAVEN_VANQUISHER);
  });

  it("still spends the whole [Fury] when it is paid with Ezreal out", () => {
    const { state, draven } = fighting(1, true);
    const begun = beginCombatAt(state, "bf1", 0);
    expect(pendingDecision(begun)?.kind).toBe("SFD-020-pump");

    const paid = answerDecisions(begun, (options) => options.find((o) => o.id === "pay")!.id);

    expect(paid.players[0]!.channeled, "Ezreal must not have made the Fury free").toHaveLength(0);
    const dravenAfter = paid.battlefields[0]!.units.p1!.find((u) => u.instanceId === draven.instanceId)!;
    expect(dravenAfter.mightThisTurn).toBe(2);
  });
});

/* ------------------------------------------------------------------------- *
 * The 2026-08-08 ruling: ONCE PER QUALIFYING OPTIONAL ADDITIONAL COST.
 * ------------------------------------------------------------------------- */

const PORTAL = "SFD-078"; // Temporal Portal — grants [Repeat] "equal to its cost"
const DESERTS_CALL = "SFD-031"; // Calm [2]; [Repeat] [2] — 820.1.d's own worked example
const FIND_YOUR_CENTER = "OGN-047"; // Calm [3]; "this costs [2] less if..."
const CLOCKWORK_KEEPER = "OGN-044"; // Calm [2]; "you may pay [Calm] as an additional cost"
const CRUEL_PATRON = "OGN-208"; // Order [4]; a MANDATORY "kill a friendly unit"
const HARD_BARGAIN = "SFD-136"; // Chaos; "counter a spell unless its controller pays [2]"
const WIND_WALL = "OGN-064"; // any spell will do as Hard Bargain's victim

/** A Portal on the board, a spell in hand, and enough runes that affordability is
 *  never what is being measured. `withEzreal` is the whole experiment. */
function portalBoard(spellDefId: string, withEzreal: boolean, runeCount = 20) {
  const spell = spellInstance(spellDefId);
  const state = makeState({ phase: "Action" });
  state.players[0]!.hand = [spell];
  state.players[0]!.activeGear = [realGearInstance(PORTAL)];
  state.players[0]!.channeled = runes("Calm", runeCount);
  state.players[0]!.deck = Array.from({ length: 10 }, () => makeUnit());
  if (withEzreal) state.players[0]!.baseUnits = [{ ...realUnitInstance(EZREAL_PRODIGY), instanceId: "ezreal" }];
  return { state, spellId: spell.instanceId };
}

/** Arms the grant through the REAL activation path, not by writing the counter —
 *  the same discipline the rest of this file keeps about `submit`. Note that the
 *  Portal's rainbow pip recycles a Ready rune, which banks 1 floating Energy;
 *  every figure below is quoted after that. */
function armPortal(state: GameState): GameState {
  const use = legalActions(state).find(
    (a): a is ActivateAbilityAction =>
      a.type === "ActivateAbility" && a.permanentInstanceId === state.players[0]!.activeGear[0]!.instanceId,
  );
  expect(use, "the Portal offered no activation").toBeDefined();
  const { state: after, result } = submit(state, use!);
  expect(result, `arming refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  expect(after.players[0]!.nextSpellRepeatGrants, "nothing was armed").toBe(1);
  return after;
}

/** Resolves the chain so a Spell's tokens actually land. */
function settle(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 10 && current.spellChain.length > 0; guard += 1) {
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) break;
    current = submit(current, pass).state;
  }
  return current;
}

/** The cheapest Energy any of these plays is offered at — the one number the
 *  ruling moves, and gated on there being a play at all so an empty list can
 *  never read as a pass. */
function cheapestEnergy(plays: PlayCardAction[], what: string): number {
  expect(plays.length, `no ${what} variant was offered — the measurement proved nothing`).toBeGreaterThan(0);
  return Math.min(...plays.map((p) => p.payment.energyRunes.length));
}

/**
 * Temporal Portal's GRANTED `[Repeat]` paid alongside a PRINTED one — the only
 * board in this pool where two optional additional costs meet on a single play,
 * and therefore the only place the two readings of Ezreal's plural subject give
 * different numbers. (`[Accelerate]` is a Unit keyword and every `[Repeat]` card
 * is a Spell, so those two can never coincide.)
 *
 * Desert's Call is Calm [2] with `[Repeat]` [2], and its granted instance is
 * "equal to its cost" — another [2]. So the four prices are 2 / 4 / 4 / 6 Energy,
 * less the 1 floating Energy arming the Portal banked: 1 / 3 / 3 / 5 runes.
 *
 * The number that matters is the SAVING, because it is the ruling stated
 * arithmetically:
 *   - one optional additional cost paid  -> 1 pip off
 *   - two optional additional costs paid -> 2 pips off, not 1.
 * The summed reading this engine shipped in the morning gives 1 in both rows.
 */
describe("Ezreal's pip lands once per qualifying optional additional cost (ruling 2026-08-08)", () => {
  function offered(withEzreal: boolean) {
    const { state, spellId } = portalBoard(DESERTS_CALL, withEzreal);
    const armed = armPortal(state);
    const plays = legalActions(armed).filter(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === spellId,
    );
    return {
      state: armed,
      plain: plays.filter((p) => !p.repeatPaid && !p.grantedRepeatPaid),
      printedOnly: plays.filter((p) => p.repeatPaid === true && p.grantedRepeatPaid !== true),
      grantedOnly: plays.filter((p) => p.grantedRepeatPaid === true && p.repeatPaid !== true),
      both: plays.filter((p) => p.repeatPaid === true && p.grantedRepeatPaid === true),
    };
  }

  it("takes TWO pips off a play that pays both [Repeat] instances, and ONE off a play that pays one", () => {
    const without = offered(false);
    const with_ = offered(true);

    // The undiscounted baseline, so the saving below is measured against a figure
    // this test also asserts rather than against a remembered one.
    expect(cheapestEnergy(without.plain, "plain"), "Desert's Call is [2], less 1 floating").toBe(1);
    expect(cheapestEnergy(without.printedOnly, "printed-[Repeat]")).toBe(3);
    expect(cheapestEnergy(without.grantedOnly, "granted-[Repeat]")).toBe(3);
    expect(cheapestEnergy(without.both, "pay-both")).toBe(5);

    // One cost paid: one pip. (Unchanged by the ruling — this is the control.)
    expect(cheapestEnergy(with_.printedOnly, "printed-[Repeat]"), "one cost should save one pip").toBe(2);
    expect(cheapestEnergy(with_.grantedOnly, "granted-[Repeat]"), "one cost should save one pip").toBe(2);
    // TWO costs paid: TWO pips. The summed reading offers 4 here.
    expect(cheapestEnergy(with_.both, "pay-both"), "two costs should save two pips, not one").toBe(3);
    // And his pip never reaches the card's own price.
    expect(cheapestEnergy(with_.plain, "plain"), "Ezreal must not discount a play that pays no optional cost").toBe(1);
  });

  it("the twice-discounted play validates, and still executes three times", () => {
    const { state, both } = offered(true);
    const cheapest = both.reduce((a, b) => (a.payment.energyRunes.length <= b.payment.energyRunes.length ? a : b));
    expect(cheapest.payment.energyRunes).toHaveLength(3);

    expect(validatePlayCard(state, cheapest), "the enumerator offered a price the validator refused").toMatchObject({
      ok: true,
    });
    const { result, state: after } = submit(state, cheapest);
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });

    const settled = settle(after);
    const soldiers = [
      ...settled.players[0]!.baseUnits,
      ...settled.battlefields.flatMap((bf) => bf.units[settled.players[0]!.id] ?? []),
    ].filter((u) => u.instanceId !== "ezreal");
    // 820.3: each paid instance adds an execution, so both paid is three Sand
    // Soldiers — bought here two pips under the old price.
    expect(soldiers, "the twice-discounted play did not execute three times").toHaveLength(3);
  });

  /**
   * The same claim at the function, in the two shapes the two readings differ in.
   * Kept because the board above can only ever exercise ONE pair of costs, and
   * this says what the rule is rather than what Desert's Call happens to cost.
   */
  it("discounts a LIST of costs per entry, where the summed bundle got one pip total", () => {
    const { state } = portalBoard(DESERTS_CALL, true);
    const two = [
      { energy: 2, power: 0, rainbow: 0 },
      { energy: 2, power: 0, rainbow: 0 },
    ];
    expect(discountedOptionalCosts(state, 0, "energy", two).energy, "two costs, two pips").toBe(2);
    // The old call shape — the same four Energy arriving as ONE cost — still gets
    // exactly one pip, which is what makes the difference above a reading and not
    // an off-by-one.
    expect(discountedOptionalCosts(state, 0, "energy", [{ energy: 4, power: 0, rainbow: 0 }]).energy).toBe(3);
    // And a cost with nothing on the chosen axis absorbs nothing: there is no
    // shared budget for an unused pip to be carried over from.
    expect(
      discountedOptionalCosts(state, 0, "energy", [
        { energy: 0, power: 1, rainbow: 0 },
        { energy: 2, power: 0, rainbow: 0 },
      ]),
    ).toEqual({ energy: 1, power: 1, rainbow: 0 });
  });
});

/**
 * The ruling's three SCOPE claims, each checked against the engine rather than
 * against this file's comments.
 */
describe("what Ezreal's discount may NOT reach", () => {
  /**
   * **Claim 1 — the pip lands on the additional cost as it is ADDED, never on the
   * card's own price.**
   *
   * Clockwork Keeper is the instrument because its optional additional cost is a
   * bare [Calm] with NO Energy at all, while the card itself costs [2]. So an
   * Energy pip has nothing to bite on, and the only way a play can come out at
   * 1 Energy is if the reduction was applied to the play's TOTAL instead of to
   * the cost it was added by. Asserted from both ends: the enumerator must never
   * offer that shape, and a hand-built action claiming it must be refused.
   */
  it("never takes the pip off the printed cost when the additional cost has none on that axis", () => {
    const keeper = spellInstance(CLOCKWORK_KEEPER);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [keeper];
    state.players[0]!.channeled = [...runes("Calm", 4)];
    state.players[0]!.deck = [makeUnit(), makeUnit()];
    state.players[0]!.baseUnits = [{ ...realUnitInstance(EZREAL_PRODIGY), instanceId: "ezreal" }];

    const paid = legalActions(state).filter(
      (a): a is PlayCardAction =>
        a.type === "PlayCard" && a.card.instanceId === keeper.instanceId && a.optionalPowerPaid === true,
    );
    expect(paid.length, "the optional-cost variant was not offered at all").toBeGreaterThan(0);
    const shapes = new Set(paid.map((p) => `${p.payment.energyRunes.length}/${spend(p).power}`));
    // [2] printed plus a [Calm]: undiscounted 2/1, and 2/0 once the rainbow axis
    // erases the rune. There is no 1/1 — the Energy axis buys nothing here.
    expect(shapes.has("2/1"), `undiscounted shape missing, saw ${[...shapes].join(" ")}`).toBe(true);
    expect(shapes.has("2/0"), `power axis missing, saw ${[...shapes].join(" ")}`).toBe(true);
    expect(shapes.has("1/1"), `Ezreal discounted the CARD, saw ${[...shapes].join(" ")}`).toBe(false);

    const undiscounted = paid.find((p) => p.targetDiscountAxis === undefined)!;
    const forged: PlayCardAction = {
      ...undiscounted,
      targetDiscountAxis: "energy",
      payment: { ...undiscounted.payment, energyRunes: undiscounted.payment.energyRunes.slice(1) },
    };
    expect(validatePlayCard(state, forged).ok, "the validator sold a pip off the printed cost").toBe(false);
  });

  /**
   * **Claim 2 — MANDATORY additional costs are excluded.**
   *
   * The engine does distinguish them: `UnitCostSpec.mandatory` marks Cruel
   * Patron's kill, Legion Quartermaster's bounce and Stalking Wolf's (UNL-166,
   * unimplemented) kill, and every one of those is paid with a PERMANENT rather
   * than with a pip — there is nothing on them for "[1] or [rainbow] less" to
   * reduce. So the exclusion is structural, and what is pinned here is that a
   * mandatory-cost play is never even offered the axis and cannot claim it.
   */
  it("leaves a mandatory additional cost alone (Cruel Patron)", () => {
    const patronBoard = (withEzreal: boolean) => {
      const patron = spellInstance(CRUEL_PATRON);
      const state = makeState({ phase: "Action" });
      state.players[0]!.hand = [patron];
      state.players[0]!.channeled = runes("Order", 8);
      state.players[0]!.baseUnits = [
        makeUnit({ instanceId: "fodder", name: "Fodder" }),
        ...(withEzreal ? [{ ...realUnitInstance(EZREAL_PRODIGY), instanceId: "ezreal" }] : []),
      ];
      return {
        state,
        plays: legalActions(state).filter(
          (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === patron.instanceId,
        ),
      };
    };

    const without = patronBoard(false);
    const with_ = patronBoard(true);
    expect(without.plays.length, "Cruel Patron was not playable at all").toBeGreaterThan(0);
    expect(with_.plays.length).toBeGreaterThan(0);
    expect(with_.plays.some((p) => p.targetDiscountAxis !== undefined), "a mandatory cost was offered a discount").toBe(
      false,
    );
    // Printed [4], and it stays [4] with him on the board.
    expect(new Set(without.plays.map((p) => p.payment.energyRunes.length))).toEqual(new Set([4]));
    expect(new Set(with_.plays.map((p) => p.payment.energyRunes.length)), "Ezreal cheapened a mandatory cost").toEqual(
      new Set([4]),
    );

    const forged: PlayCardAction = {
      ...with_.plays[0]!,
      targetDiscountAxis: "energy",
      payment: { ...with_.plays[0]!.payment, energyRunes: with_.plays[0]!.payment.energyRunes.slice(1) },
    };
    expect(validatePlayCard(with_.state, forged).ok, "the axis was accepted on a mandatory cost").toBe(false);
  });

  /**
   * **Claim 3 — a payment made while an effect RESOLVES is not an additional
   * cost.**
   *
   * Hard Bargain's "counter a spell unless its controller pays [2]" is the pool's
   * one in-effect payment, and it is asked of the VICTIM's controller — so Ezreal
   * goes on their side, which is the only seat where a discount could plausibly
   * be argued for. The ransom is `payEnergyFromPool(..., 2)` in effects/chaos.ts
   * and consults no cost modifier at all; this asserts the consequence rather
   * than the implementation, so the pin survives a rewrite of either.
   */
  it("leaves Hard Bargain's in-effect ransom at [2] even for a controller with Ezreal out", () => {
    const bargain = spellInstance(HARD_BARGAIN);
    const victim = spellInstance(WIND_WALL);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [bargain];
    state.players[0]!.channeled = runes("Chaos", 12);
    state.players[1]!.channeled = runes("Calm", 8);
    // The RANSOM PAYER's board — Ezreal belongs to the seat being asked to pay.
    state.players[1]!.baseUnits = [{ ...realUnitInstance(EZREAL_PRODIGY), instanceId: "ezreal-p2" }];
    state.spellChain = [{ playerIndex: 1, card: victim }];

    const play = legalActions(state).find(
      (a): a is PlayCardAction =>
        a.type === "PlayCard" &&
        a.card.instanceId === bargain.instanceId &&
        a.repeatPaid !== true &&
        a.targetChainCardInstanceId === victim.instanceId,
    );
    expect(play, "Hard Bargain was never offered against the victim").toBeDefined();
    const { result, state: cast } = submit(state, play!);
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });

    let parked = cast;
    for (let guard = 0; guard < 8 && pendingDecision(parked) === undefined && parked.spellChain.length > 0; guard += 1) {
      const pass = legalActions(parked).find((a) => a.type === "PassFocus");
      if (!pass) break;
      parked = submit(parked, pass).state;
    }
    expect(pendingDecision(parked)?.kind, "the ransom was never asked").toBe("SFD-136-ransom");

    const after = answerDecisions(parked, (options) => options.find((o) => o.id === "pay")!.id);
    expect(
      after.players[1]!.channeled.filter((r) => r.state === "Exhausted"),
      "Ezreal discounted a payment made during resolution",
    ).toHaveLength(2);
    expect(
      after.spellChain.some((e) => isSpellChainEntry(e) && e.card.instanceId === victim.instanceId),
      "paying the ransom did not save the spell",
    ).toBe(true);
  });
});

/**
 * **Claim 4 — a `[Repeat]` cost references the card's PRINTED cost.**
 *
 * Find Your Center is Calm [3] with "if an opponent's score is within 3 points of
 * the Victory Score, this costs [2] less", and Temporal Portal grants `[Repeat]`
 * "equal to its cost". So it is the one card in the pool that can ask the
 * question the ruling answers: does the base-cost reduction shrink the Repeat
 * cost a second time?
 *
 * It must not. With the comeback clause live the play owes 1 (reduced base) + 3
 * (PRINTED, granted Repeat) = 4, less the 1 floating Energy arming the Portal
 * banked, so 3 runes. A version reading the reduced cost would quote 1 + 1 = 2,
 * less the float, so 1 rune. The saving from the comeback clause must therefore
 * be exactly 2 — one application, not two.
 */
describe("[Repeat] equal to its cost is equal to its PRINTED cost", () => {
  function grantedOnly(opponentPoints: number) {
    const { state, spellId } = portalBoard(FIND_YOUR_CENTER, false, 12);
    state.players[1]!.points = opponentPoints;
    const armed = armPortal(state);
    const plays = legalActions(armed).filter(
      (a): a is PlayCardAction =>
        a.type === "PlayCard" && a.card.instanceId === spellId && a.grantedRepeatPaid === true,
    );
    return { state: armed, plays };
  }

  it("does not shrink when the card's base cost does", () => {
    const full = grantedOnly(0); // no comeback clause: [3] + [3], less 1 float
    const reduced = grantedOnly(5); // within 3 of 8: [1] + [3], less 1 float

    expect(cheapestEnergy(full.plays, "granted-[Repeat] at full price")).toBe(5);
    expect(
      cheapestEnergy(reduced.plays, "granted-[Repeat] under the comeback clause"),
      "the base discount was applied to the [Repeat] cost as well",
    ).toBe(3);

    // Stated as the ruling states it: ONE application of a 2-Energy reduction.
    expect(
      cheapestEnergy(full.plays, "full") - cheapestEnergy(reduced.plays, "reduced"),
      "a [2] base discount took more than [2] off the play",
    ).toBe(2);
  });

  /** And the discounted play is really playable at that price — the offered-then-
   *  refused split this file exists to catch. */
  it("prices the same at both ends and executes twice", () => {
    const { state, plays } = grantedOnly(5);
    const cheapest = plays.reduce((a, b) => (a.payment.energyRunes.length <= b.payment.energyRunes.length ? a : b));
    expect(validatePlayCard(state, cheapest)).toMatchObject({ ok: true });

    const { result, state: after } = submit(state, cheapest);
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
    // "Draw 1 and channel 1 rune exhausted", twice.
    const settled = settle(after);
    expect(settled.players[0]!.hand, "the granted execution did not happen").toHaveLength(2);
  });
});
