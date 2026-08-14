import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { optionalPowerCostOf } from "../src/engine/card-effects.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { giveMightThisTurn } from "../src/engine/effect-helpers.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * SFD's three "you may pay X as an additional cost" units, and the reason they
 * are one file: between them they are why `OPTIONAL_POWER_COSTS` stopped being
 * Power-only.
 *
 * Clockwork Keeper, the card that table was built for, pays a rune and nothing
 * else. **Blast Corps Cadet pays [1][Fury], and Sea Monkey pays [1] with no rune
 * at all** — so a table with a required `domain` and `count` could express
 * neither, and pricing that read only the rune would have sold the Cadet's bonus
 * for the rune alone.
 *
 * Each card gets the same three questions, which are the three ways this shape
 * breaks: is the extra actually CHARGED, does the payoff need the cost to have
 * been PAID, and is the cheap play still on offer.
 */

const registry = defaultCardRegistry();
const BLAST_CORPS_CADET = "SFD-013"; // [1][Fury] — deal 2 to a unit at a battlefield
const FROSTCOAT_CUB = "SFD-067"; // [Mind] — give a unit -2 Might this turn
const SEA_MONKEY = "SFD-098"; // [1] — buff me

const runes = (domain: RuneCard["domain"], n: number, from = 0): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${domain}${from + i}`, domain, state: "Ready" as const }));

/** `defId` in hand with `pool` channeled, plus a victim at bf1 to aim at. */
function board(defId: string, pool: RuneCard[]): { state: GameState; cardId: string } {
  const card = realUnitInstance(defId);
  const state = makeState({ phase: "Action" });
  state.players[0]!.hand = [card];
  state.players[0]!.channeled = pool;
  state.battlefields[0]!.units = { [state.players[1]!.id]: [makeUnit({ instanceId: "victim", might: 6 })] };
  return { state, cardId: card.instanceId };
}

const playsOf = (state: GameState, cardId: string) =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === cardId);

const victim = (state: GameState) =>
  state.battlefields[0]!.units[state.players[1]!.id]!.find((u) => u.instanceId === "victim");

describe("the table can express all three shapes", () => {
  it("Energy AND a rune, a rune alone, and Energy alone", () => {
    expect(optionalPowerCostOf(makeState({}), 0, BLAST_CORPS_CADET)).toEqual({ energy: 1, domain: "Fury", count: 1 });
    expect(optionalPowerCostOf(makeState({}), 0, FROSTCOAT_CUB)).toEqual({ domain: "Mind", count: 1 });
    expect(optionalPowerCostOf(makeState({}), 0, SEA_MONKEY)).toEqual({ energy: 1 });
    // Clockwork Keeper, the card the table was built for, is unchanged.
    expect(optionalPowerCostOf(makeState({}), 0, "OGN-044")).toEqual({ domain: "Calm", count: 1 });
  });

  it("all three report implemented", () => {
    for (const id of [BLAST_CORPS_CADET, FROSTCOAT_CUB, SEA_MONKEY]) {
      expect(isCardImplemented(registry.get(id)), `${id}`).toBe(true);
    }
  });
});

describe("Blast Corps Cadet (SFD-013): [1][Fury] to deal 2", () => {
  /** The Cadet is 2 Energy printed, so a paid play owes 3 Energy and 1 Fury. */
  const stocked = () => board(BLAST_CORPS_CADET, runes("Fury", 6));

  it("charges the Energy AND the rune", () => {
    const { state, cardId } = stocked();
    const plain = playsOf(state, cardId).find((a) => !a.optionalPowerPaid)!;
    const paid = playsOf(state, cardId).find((a) => a.optionalPowerPaid);

    expect(paid, "the paid variant was not offered").toBeDefined();
    // The extra Energy is the half a Power-only table could not charge.
    expect(paid!.payment!.energyRunes.length, "the extra Energy was not charged").toBe(
      plain.payment!.energyRunes.length + 1,
    );
    expect(paid!.payment!.powerRunes.length, "the extra rune was not charged").toBe(plain.payment!.powerRunes.length + 1);
  });

  it("deals 2 when the cost was paid", () => {
    const { state, cardId } = stocked();
    const paid = playsOf(state, cardId).find((a) => a.optionalPowerPaid && a.targetUnitInstanceId === "victim")!;
    const after = resolveHeldTriggers(submit(state, paid).state);

    expect(victim(after)!.damage, "the paid-for hit did not land").toBe(2);
  });

  it("deals NOTHING when it was not", () => {
    const { state, cardId } = stocked();
    const plain = playsOf(state, cardId).find((a) => !a.optionalPowerPaid && a.targetUnitInstanceId === "victim")!;
    const after = resolveHeldTriggers(submit(state, plain).state);

    expect(victim(after)!.damage, "the cheap play still hit").toBe(0);
  });

  /** The validator does not trust the flag: claiming the discount is refused. */
  it("refuses the paid flag at the plain price", () => {
    const { state, cardId } = stocked();
    const plain = playsOf(state, cardId).find((a) => !a.optionalPowerPaid)!;

    expect(validatePlayCard(state, { ...plain, optionalPowerPaid: true }).ok, "the bonus was sold cheap").toBe(false);
  });

  /** Too poor for the extra, the cheap play survives — an additional cost is
   *  never a reason a card becomes unplayable. */
  it("still offers the cheap play when the extra is unaffordable", () => {
    // Two runes cover the printed 2 Energy exactly and leave nothing for the
    // extra — the narrowest pool where the cheap play is still legal.
    const { state, cardId } = board(BLAST_CORPS_CADET, runes("Fury", 2));
    const offered = playsOf(state, cardId);

    expect(offered.length, "the card became unplayable").toBeGreaterThan(0);
    expect(offered.some((a) => a.optionalPowerPaid), "an unaffordable extra was offered").toBe(false);
  });
});

describe("Frostcoat Cub (SFD-067): [Mind] to give -2 Might", () => {
  const stocked = () => board(FROSTCOAT_CUB, runes("Mind", 6));

  it("debuffs when paid, and floors at 1", () => {
    const { state, cardId } = stocked();
    const paid = playsOf(state, cardId).find((a) => a.optionalPowerPaid && a.targetUnitInstanceId === "victim")!;
    const after = resolveHeldTriggers(submit(state, paid).state);

    expect(effectiveMight(after, victim(after)!, 1, { isCombat: false }), "the debuff was the wrong size").toBe(4);
  });

  it("does NOT floor the stored modifier — a later buff climbs from the real value", () => {
    // **The rules call, settled by the project owner 2026-08-08 and confirmed
    // against the PDF here.** The Might property says a unit below 0 "is treated
    // as 0 WHEN REFERENCED by spells and abilities... Although the unit's Might
    // is treated as 0, it is not 0. **Effects that calculate Might increases and
    // decreases use the ACTUAL value.**"
    //
    // So `effectiveMight`'s `Math.max(0, m)` is right — that is the reference —
    // and passing a `floor` to `giveMightThisTurn` was wrong, because that
    // clamps the STORED modifier and so digs the unit out of a hole it should
    // still be in.
    //
    // The card's own entry cited "707.2, since Might cannot fall below 1". No
    // such rule exists: the ONLY "minimum of 1" in the whole PDF is inside a
    // card's printed text in an example — Blastcone Fae's "give a unit -2 Might
    // this turn, TO A MINIMUM OF 1 MIGHT" — which proves the opposite, since a
    // card that floors says so and this one does not. Same defect class as the
    // recorded "rule 1678" line-number citation.
    //
    // Observable only through a later buff, because the debuffed value itself
    // reads as 0 either way. A 1-Might victim at -2 is really -1, so +3 leaves
    // 2 — not the 4 a floor at 1 would give.
    const { state, cardId } = board(FROSTCOAT_CUB, runes("Mind", 6));
    const weak: GameState = {
      ...state,
      battlefields: state.battlefields.map((bf, i) =>
        i === 0 ? { ...bf, units: { [state.players[1]!.id]: [makeUnit({ instanceId: "victim", might: 1 })] } } : bf,
      ),
    };
    const paid = playsOf(weak, cardId).find((a) => a.optionalPowerPaid && a.targetUnitInstanceId === "victim")!;
    const debuffed = resolveHeldTriggers(submit(weak, paid).state);

    // Referenced: treated as 0, never negative.
    expect(effectiveMight(debuffed, victim(debuffed)!, 1, { isCombat: false })).toBe(0);
    // Calculated: the actual value is -1, so +3 gives 2.
    const buffed = giveMightThisTurn(debuffed, "victim", 3);
    expect(
      effectiveMight(buffed, victim(buffed)!, 1, { isCombat: false }),
      "a floored modifier let the victim climb out of a hole it should still be in",
    ).toBe(2);
  });

  it("does nothing when the rune was not paid", () => {
    const { state, cardId } = stocked();
    const plain = playsOf(state, cardId).find((a) => !a.optionalPowerPaid && a.targetUnitInstanceId === "victim")!;
    const after = resolveHeldTriggers(submit(state, plain).state);

    expect(effectiveMight(after, victim(after)!, 1, { isCombat: false })).toBe(6);
  });

  /**
   * **The offered-then-refused regression, and the suite could not have caught
   * it.** The optional-cost branch priced no `[Deflect]` surcharge, because
   * Clockwork Keeper — the only card in that branch before these three — targets
   * nothing and so can never owe one. The Cub targets a unit; against a
   * `[Deflect]` unit the enumerator offered a play the validator refused.
   *
   * Found by `DECKS=sfd`, the fifth offered-then-refused split found by a probe
   * rather than by a test. So this asserts the pairing directly: every optional
   * play the enumerator offers must survive the validator.
   */
  it("prices [Deflect] on its target, so every offer is accepted", () => {
    const { state, cardId } = board(FROSTCOAT_CUB, [...runes("Mind", 6), ...runes("Body", 3, 6)]);
    const warded: GameState = {
      ...state,
      battlefields: state.battlefields.map((bf, i) =>
        i === 0
          ? { ...bf, units: { [state.players[1]!.id]: [makeUnit({ instanceId: "victim", might: 6, keywords: { Deflect: 1 } })] } }
          : bf,
      ),
    };
    const offers = playsOf(warded, cardId).filter((a) => a.optionalPowerPaid && a.targetUnitInstanceId === "victim");
    expect(offers.length, "the paid variant was not offered at a [Deflect] unit").toBeGreaterThan(0);

    for (const offer of offers) {
      expect(validatePlayCard(warded, offer).ok, `offered then refused: ${JSON.stringify(offer.payment)}`).toBe(true);
      // And the tax is really being paid, not merely tolerated.
      expect((offer.payment?.rainbowRunes ?? []).length, "no [Deflect] tax was charged").toBe(1);
    }
  });

  /** The rune must be a MIND one — the cost names its own domain. */
  it("is not offered off runes of the wrong domain", () => {
    const { state, cardId } = board(FROSTCOAT_CUB, runes("Fury", 6));
    expect(playsOf(state, cardId).some((a) => a.optionalPowerPaid), "a Fury rune paid a Mind pip").toBe(false);
  });
});

describe("Sea Monkey (SFD-098): [1] and no rune at all", () => {
  const stocked = () => board(SEA_MONKEY, runes("Body", 6));

  it("charges Energy and nothing else", () => {
    const { state, cardId } = stocked();
    const plain = playsOf(state, cardId).find((a) => !a.optionalPowerPaid)!;
    const paid = playsOf(state, cardId).find((a) => a.optionalPowerPaid);

    expect(paid, "the paid variant was not offered").toBeDefined();
    expect(paid!.payment!.energyRunes.length).toBe(plain.payment!.energyRunes.length + 1);
    expect(paid!.payment!.powerRunes.length, "a rune was charged for a cost that names none").toBe(
      plain.payment!.powerRunes.length,
    );
  });

  it("buffs ITSELF when paid, and not otherwise", () => {
    const { state, cardId } = stocked();
    const paid = playsOf(state, cardId).find((a) => a.optionalPowerPaid)!;
    const plain = playsOf(state, cardId).find((a) => !a.optionalPowerPaid)!;

    const buffed = resolveHeldTriggers(submit(state, paid).state).players[0]!.baseUnits[0]!;
    expect(buffed.buffed, "the paid Monkey was not buffed").toBe(true);
    expect(resolveHeldTriggers(submit(state, plain).state).players[0]!.baseUnits[0]!.buffed).toBe(false);
  });
});
