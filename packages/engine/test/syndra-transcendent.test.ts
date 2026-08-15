import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { submit } from "../src/engine/game-engine.js";
import { standingRepeatGrantFor, foreignRepeatPip } from "../src/engine/repeat-grants.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import type { Domain } from "../src/model/domain.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * **UNL-146 Syndra - Transcendent — "While I'm in a showdown, your spells have
 * [Repeat] [2][Chaos]."**
 *
 * Her refusal was re-measured twice and every correction held, which makes it the
 * most-revised note in the repo and the most accurate by the end:
 *
 *   - the two-instance case was NOT the blocker — `legal-actions` already crosses
 *     a granted instance with a printed one, and the action already carries the
 *     two as separate booleans;
 *   - the blocker was the DOMAIN. Her pip is Chaos and she grants it to "your
 *     spells", so the first Fury spell cast beside her owes a Fury pip and a Chaos
 *     pip on one play. `RunePayment` had three buckets and none of them is "a pip
 *     in some other named domain": `powerRunes` is checked against the CARD's
 *     domain (refusing a legal play) and `rainbowRunes` against none (accepting
 *     any rune, which is stronger than printed);
 *   - and riding `nextSpellRepeatGrants` would have been wrong for a third
 *     reason: that counter is SPENT by the next spell played, so she would have
 *     granted one repeatable spell per arming rather than every spell.
 *
 * # What this file is really pinning
 *
 * `RepeatCostSpec.domain` was DEAD DATA before her — both pricing sites folded a
 * Repeat's Power into `card.powerCost` and paid with `card.powerDomain`, correct
 * only because all fourteen printed Repeats are in their own card's domain. The
 * cross-domain test below is the first thing in the repo that would notice.
 */

const registry = defaultCardRegistry();
const SYNDRA = "UNL-146";
/** Hextech Ray — FURY 1 Energy / 1 Fury Power. Its own pip is Fury and Syndra's
 *  grant is Chaos, which is the whole cross-domain case. */
const FURY_SPELL = "OGN-009";
/** A CHAOS spell, so the grant's pip and the card's are the same domain and the
 *  foreign bucket must NOT appear. */
const CHAOS_SPELL = "OGN-172"; // Rebuke — 2 Energy / 2 Chaos Power

const runes = (domain: Domain, n: number, from = 0): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${domain}-${i + from}`, domain, state: "Ready" as const }));

/**
 * A showdown is open at bf1. `syndraPresent` puts Syndra there for player 0;
 * `spell` is what player 0 holds.
 */
function showdown(opts: { syndraPresent?: boolean; spell?: string; fury?: number; chaos?: number } = {}): GameState {
  const { syndraPresent = true, spell = FURY_SPELL, fury = 6, chaos = 6 } = opts;
  const state = makeState({ phase: "Action", activePlayerIndex: 0, turnState: "Showdown", chainOpen: true });
  state.showdownBattlefieldId = "bf1";
  state.battlefields[0]!.contestedByIndex = 0;
  state.battlefields[0]!.units = {
    p1: syndraPresent ? [realUnitInstance(SYNDRA)] : [makeUnit({ instanceId: "filler" })],
    p2: [makeUnit({ instanceId: "theirs", might: 9 })],
  };
  state.players[0]!.hand = [spellInstance(spell)];
  state.players[0]!.channeled = [...runes("Fury", fury), ...runes("Chaos", chaos)];
  return state;
}

const playsOf = (state: GameState, defId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === defId);

const repeated = (state: GameState, defId: string) => playsOf(state, defId).filter((a) => a.grantedRepeatPaid === true);

describe("the grant itself — while she is IN a showdown", () => {
  it("is live while she stands at the showdown's battlefield", () => {
    const state = showdown();
    expect(standingRepeatGrantFor(state, 0, { kind: "Spell" }), "her grant is not live").toEqual({
      energy: 2,
      power: 1,
      domain: "Chaos",
    });
  });

  it("is NOT live with no showdown open", () => {
    const state = showdown();
    state.showdownBattlefieldId = null;
    expect(standingRepeatGrantFor(state, 0, { kind: "Spell" }), "she granted outside a showdown").toBeUndefined();
  });

  it("is NOT live while she stands somewhere else", () => {
    // "While I'm IN a showdown" — being on the board elsewhere is not being in it.
    const state = showdown({ syndraPresent: false });
    state.battlefields[1]!.units = { p1: [realUnitInstance(SYNDRA)] };
    expect(standingRepeatGrantFor(state, 0, { kind: "Spell" }), "a Syndra elsewhere granted anyway").toBeUndefined();
  });

  it("does not reach the OPPONENT's spells — 'YOUR spells'", () => {
    expect(standingRepeatGrantFor(showdown(), 1, { kind: "Spell" }), "she granted to her opponent").toBeUndefined();
  });

  it("does not reach units or gear — 'your SPELLS'", () => {
    expect(standingRepeatGrantFor(showdown(), 0, { kind: "Unit" }), "she granted to a unit").toBeUndefined();
    expect(standingRepeatGrantFor(showdown(), 0, { kind: "Gear" }), "she granted to a gear").toBeUndefined();
  });
});

describe("the FOREIGN pip — the blocker her refusal named", () => {
  it("is foreign for a Fury spell and native for a Chaos one", () => {
    const chaosGrant = { energy: 2, power: 1, domain: "Chaos" as const };
    expect(
      foreignRepeatPip({ powerDomain: "Fury" }, chaosGrant),
      "a Chaos pip on a Fury spell was not treated as foreign",
    ).toEqual({ domain: "Chaos", count: 1 });
    expect(
      foreignRepeatPip({ powerDomain: "Chaos" }, chaosGrant),
      "a Chaos pip on a Chaos spell was treated as foreign",
    ).toBeUndefined();
    // A hybrid-pip card can pay either printed domain from its ordinary bucket.
    expect(
      foreignRepeatPip({ powerDomain: "Fury", powerDomainAlt: "Chaos" }, chaosGrant),
      "a hybrid card's alt domain was treated as foreign",
    ).toBeUndefined();
  });

  it("rides its OWN bucket on a Fury spell, and the card's Fury pip still rides powerRunes", () => {
    // **The case none of the three existing buckets could express.** The play owes
    // one Fury pip (the card's) and one Chaos pip (Syndra's) at once.
    const state = showdown({ spell: FURY_SPELL });
    const paid = repeated(state, FURY_SPELL);
    expect(paid.length, "the granted repeat was never offered").toBeGreaterThan(0);

    const byId = new Map(state.players[0]!.channeled.map((r) => [r.id, r.domain]));
    for (const play of paid) {
      const foreign = play.payment.foreignPowerRunes ?? [];
      expect(foreign.length, "the Chaos pip did not ride the foreign bucket").toBe(1);
      expect(byId.get(foreign[0]!), "a non-Chaos rune paid the Chaos pip").toBe("Chaos");
      // The card's own pip is still domain-checked against Fury.
      for (const id of play.payment.powerRunes) {
        expect(byId.get(id), "the card's own Fury pip was paid with the wrong domain").toBe("Fury");
      }
    }
  });

  it("uses NO foreign bucket on a Chaos spell — the pip is native there", () => {
    const paid = repeated(showdown({ spell: CHAOS_SPELL }), CHAOS_SPELL);
    expect(paid.length, "the granted repeat was never offered on a Chaos spell").toBeGreaterThan(0);
    expect(
      paid.every((p) => (p.payment.foreignPowerRunes ?? []).length === 0),
      "a native pip was routed through the foreign bucket",
    ).toBe(true);
  });

  it("is NOT offered when the pool holds no rune of her domain", () => {
    // 416.3's shape: an additional cost that cannot be paid is not offered, rather
    // than offered and refused.
    const state = showdown({ spell: FURY_SPELL, chaos: 0 });
    expect(playsOf(state, FURY_SPELL).length, "the spell was unplayable at all — this measures nothing").toBeGreaterThan(0);
    expect(repeated(state, FURY_SPELL), "a Chaos pip was offered with no Chaos rune").toHaveLength(0);
  });

  it("is NOT offered when the only rune of her domain is EXHAUSTED", () => {
    // Paying Power RECYCLES the rune (416), so an exhausted one has nothing left
    // to give. Mutation-found: every other fixture here holds only Ready runes, so
    // dropping the readiness check changed nothing.
    const state = showdown({ spell: FURY_SPELL, chaos: 0 });
    state.players[0]!.channeled = [
      ...state.players[0]!.channeled,
      { id: "spent-chaos", domain: "Chaos", state: "Exhausted" },
    ];

    expect(repeated(state, FURY_SPELL), "an exhausted rune paid a Power pip").toHaveLength(0);
  });

  it("RESERVES her rune before the rest of the payment can spend it", () => {
    // **The ordering the reservation exists for**, on the one board where it is
    // observable. A Fury spell owes 1 Energy + 1 Fury pip of its own and Syndra
    // adds 2 Energy + 1 Chaos pip: 3 Energy, one Fury pip, one Chaos pip.
    //
    // The pool is 3 Fury + 1 Chaos. Energy is domain-agnostic, so a payment
    // computed first would spend the lone Chaos rune on Energy and leave the pip
    // unpayable. Reserved first, the Chaos rune pays the pip and the three Fury
    // runes cover the rest — one of them recycling for the Fury pip and banking
    // 1 floating Energy on the way (164.2's double duty).
    //
    // Mutation-found: with a generous pool the general payment never wanted the
    // Chaos rune, so handing it the unreserved pool changed nothing.
    const state = showdown({ spell: FURY_SPELL, fury: 3, chaos: 1 });
    const paid = repeated(state, FURY_SPELL);

    expect(paid.length, "the tight board could not pay the grant at all").toBeGreaterThan(0);
    const byId = new Map(state.players[0]!.channeled.map((r) => [r.id, r.domain]));
    for (const play of paid) {
      const pip = (play.payment.foreignPowerRunes ?? [])[0];
      expect(byId.get(pip ?? ""), "the Chaos rune was spent elsewhere and the pip went unpaid").toBe("Chaos");
      expect(play.payment.energyRunes, "the reserved rune was also spent on Energy").not.toContain(pip);
    }
  });
});

describe("the enumerator and the validator agree", () => {
  it("every offered play validates — including where Energy competes for her domain", () => {
    // **Two pools, and the lopsided one is the load-bearing half.** With runes to
    // spare the Energy payment never wants a Chaos rune, so the reservation is
    // invisible and this test passes whether or not it happens. At 1 Fury / 3
    // Chaos the Energy payment MUST reach for Chaos, and an unreserved pool would
    // name the same rune for Energy and for the pip — offered here, refused by the
    // double-spend check there. Mutation-found.
    for (const pool of [{ fury: 6, chaos: 6 }, { fury: 1, chaos: 3 }, { fury: 2, chaos: 2 }]) {
      const state = showdown({ spell: FURY_SPELL, ...pool });
      const offered = playsOf(state, FURY_SPELL);
      expect(offered.length, `nothing was offered at ${JSON.stringify(pool)}`).toBeGreaterThan(0);
      expect(
        offered.some((p) => p.grantedRepeatPaid === true),
        `the grant was not offered at ${JSON.stringify(pool)}`,
      ).toBe(true);
      for (const play of offered) {
        const verdict = validatePlayCard(state, play);
        expect(verdict.ok, verdict.ok ? "" : `offered but refused at ${JSON.stringify(pool)}: ${verdict.error}`).toBe(true);
      }
    }
  });

  it("REFUSES a forged wrong-domain rune for the pip", () => {
    const state = showdown({ spell: FURY_SPELL });
    const real = repeated(state, FURY_SPELL)[0]!;
    const furyId = state.players[0]!.channeled.find((r) => r.domain === "Fury" && !real.payment.energyRunes.includes(r.id) && !real.payment.powerRunes.includes(r.id))!.id;
    const forged: PlayCardAction = { ...real, payment: { ...real.payment, foreignPowerRunes: [furyId] } };

    expect(validatePlayCard(state, forged).ok, "a Fury rune paid a Chaos pip").toBe(false);
  });

  it("REFUSES a play that claims the repeat and names no pip", () => {
    const state = showdown({ spell: FURY_SPELL });
    const real = repeated(state, FURY_SPELL)[0]!;
    const forged: PlayCardAction = { ...real, payment: { ...real.payment, foreignPowerRunes: [] } };

    expect(validatePlayCard(state, forged).ok, "the granted repeat was taken for free").toBe(false);
  });

  it("REFUSES a pip rune that is also paying the card's own Energy", () => {
    // 164.2's double duty makes a Ready rune produce Energy AND Power for its
    // OWNER's cost; it does not pay two different debts.
    //
    // **Getting this forgery to land on the right check took two tries, both
    // caught by mutation.** Putting an arbitrary Energy rune in the foreign bucket
    // is refused by the DOMAIN check; ADDING the pip rune to `energyRunes` is
    // refused by the exact energy-count check ("payment supplied 4"). Neither
    // reaches the double-spend check, so both passed while it was dead.
    //
    // What reaches it: name a Chaos rune that is ALREADY paying Energy as the pip,
    // leaving every count and domain correct. Needs a board where Energy actually
    // has to reach for Chaos, which is why the pool is lopsided.
    const state = showdown({ spell: FURY_SPELL, fury: 1, chaos: 3 });
    const real = repeated(state, FURY_SPELL)[0]!;
    const byId = new Map(state.players[0]!.channeled.map((r) => [r.id, r.domain]));
    const reusable = real.payment.energyRunes.find((id) => byId.get(id) === "Chaos");
    expect(reusable, "no Chaos rune was paying Energy — the forgery cannot reach the check").toBeDefined();

    const forged: PlayCardAction = {
      ...real,
      payment: { ...real.payment, foreignPowerRunes: [reusable!] },
    };

    expect(validatePlayCard(state, forged).ok, "one rune paid both the Energy and the granted pip").toBe(false);
  });
});

describe("executing it", () => {
  it("recycles the pip's rune out of the pool", () => {
    const state = showdown({ spell: FURY_SPELL });
    const play = repeated(state, FURY_SPELL)[0]!;
    const pipId = (play.payment.foreignPowerRunes ?? [])[0]!;

    const { state: after, result } = submit(state, play);
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });

    expect(
      after.players[0]!.channeled.some((r) => r.id === pipId),
      "the pip's rune was never recycled — the grant was paid for free",
    ).toBe(false);
  });
});

describe("coverage", () => {
  it("reports the card finished", () => {
    const def = registry.get(SYNDRA);
    expect(isCardImplemented(def), "she still reports unfinished").toBe(true);
    expect(partialImplementationNote(def), "she carries a partial note").toBeUndefined();
  });
});
