import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { holdEventTrigger } from "../src/engine/triggers.js";
import { pendingDecision } from "../src/engine/decisions.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { Domain } from "../src/model/domain.js";
import type { RuneCard } from "../src/model/rune.js";
import { answerDecisions, beginCombatAt, makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

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
   *  pays none of them may not claim the axis (356.4.d.1's "was paid if the player
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
 * `[Repeat]`; the card says "optional additional costs", and 805/3233 and 3509
 * put `[Accelerate]` and Temporal Portal's granted instance under the same
 * heading. All four were unreachable in a real game for the same two reasons, so
 * all four get a positive control that counts the new path being taken.
 */
describe("Ezreal - Prodigy reaches the other optional additional costs too", () => {
  /**
   * Legion Rearguard is [2] with `[Accelerate]` [1][Fury] — 356.3's own worked
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
   *  variant is impossible; Ezreal's [rainbow] axis erases the pip, and 356.4.d.1
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
 * do, give me +2 [Might] this turn." Rule 204's own worked example is that exact
 * sentence — *"When I attack, you may pay [4][C]. If you do, kill a unit here."*
 * — and rules that it "is not a cost of the ability, base or otherwise, but a
 * game action being performed by a player". Not a cost at all, so not an OPTIONAL
 * ADDITIONAL cost, so Ezreal does not touch it.
 *
 * Pinned rather than left implicit: "it did not get cheaper" is indistinguishable
 * from "the discount never ran" unless something asserts the price is meant to
 * stand.
 */
describe("Draven - Vanquisher's [Fury] is NOT an additional cost, so Ezreal leaves it alone (204)", () => {
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
