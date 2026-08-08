import { describe, expect, it } from "vitest";
import { payPowerFromChanneled } from "../src/engine/effect-helpers.js";
import type { GameState } from "../src/model/game-state.js";
import type { Domain } from "../src/model/domain.js";
import type { RuneCard } from "../src/model/rune.js";
import { makePlayer, makeState } from "./fixtures.js";

/**
 * Paying an ability's Power cost with FLOATING Power — a Seal's output.
 *
 * Reported from playtesting against Draven - Vanquisher ("When I attack or
 * defend, you may pay [Fury]"): *"I want to be able to pay manually as I may
 * have Seals or Treasures I want to use instead of recycling."*
 *
 * A Seal's whole text is "[Exhaust]: Add 1 <domain> Power", which lands in
 * `floatingPower`. `payPowerFromChanneled` — the single funnel EVERY Power
 * payment in this engine goes through, 49 call sites across 12 files — read only
 * the CHANNELED pool, so that Power was not merely awkward to spend on an
 * ability, it was unreachable. Recorded in docs/rules-conformance.md as "Ornn's
 * rainbow Power paying a gear ABILITY's cost": *"the two cost pipelines simply
 * do not meet."*
 *
 * # Why no choice is offered, and why that is not a shortcut
 *
 * Floating-first is not one of two defensible orders:
 *
 *  - a CARD's Power cost already spends floating first (`powerAfterFloat`), so
 *    an ability ignoring it was an asymmetry between two paths for one resource;
 *  - floating Power EXPIRES at `runEnd` while a rune recycled here goes to the
 *    bottom of the deck and comes back, so spending the perishable one first is
 *    strictly better for the payer, every time.
 *
 * A "which do you want to spend?" prompt would therefore have exactly one right
 * answer, on every board, forever.
 */

const runes = (domain: Domain, n: number): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

/** A player with `floating` Fury Power banked and `channeled` Fury runes. */
function board(floating: number, channeled: number, rainbow = 0): GameState {
  return makeState({
    phase: "Action",
    players: [
      makePlayer("p1", {
        channeled: runes("Fury", channeled),
        floatingPower: floating > 0 ? { Fury: floating } : {},
        floatingRainbowPower: rainbow,
      }),
      makePlayer("p2"),
    ],
  });
}

const furyRunesLeft = (s: GameState) => s.players[0]!.channeled.length;
const furyFloating = (s: GameState) => s.players[0]!.floatingPower.Fury ?? 0;

describe("floating Power pays an ability's cost", () => {
  it("spends the Seal's Power and recycles NO rune — the playtest report", () => {
    const paid = payPowerFromChanneled(board(1, 3), 0, "Fury", 1);
    expect(paid, "1 Fury was not payable with 1 floating Fury banked").toBeDefined();
    expect(furyFloating(paid!), "the floating Power was not spent").toBe(0);
    expect(furyRunesLeft(paid!), "a rune was recycled although floating covered it").toBe(3);
  });

  it("falls back to runes for the remainder", () => {
    // 2 owed, 1 floating: the floating goes first and ONE rune covers the rest.
    const paid = payPowerFromChanneled(board(1, 3), 0, "Fury", 2);
    expect(furyFloating(paid!)).toBe(0);
    expect(furyRunesLeft(paid!)).toBe(2);
  });

  it("still pays entirely from runes when nothing is floating — the control", () => {
    // The behaviour every existing card relied on, unchanged.
    const paid = payPowerFromChanneled(board(0, 3), 0, "Fury", 2);
    expect(furyRunesLeft(paid!)).toBe(1);
  });

  it("is still unpayable when neither pool can cover it", () => {
    // 416.3 — a cost that cannot be completed is not one you may choose to pay,
    // and `undefined` is how every caller learns not to offer it.
    expect(payPowerFromChanneled(board(1, 1), 0, "Fury", 3)).toBeUndefined();
  });

  it("counts the FULL cost toward Sivir, not just the runes recycled", () => {
    // The tally is "have you spent [rainbow][rainbow] this turn". Power paid from
    // floating is Power spent, so counting only recycled runes would silently
    // stop paying her out the moment a Seal covered a cost.
    const paid = payPowerFromChanneled(board(2, 3), 0, "Fury", 2);
    expect(paid!.players[0]!.powerSpentThisTurn).toBe(2);
    expect(furyRunesLeft(paid!), "runes were spent although floating covered it all").toBe(3);
  });
});

describe("which pool, and which domain", () => {
  it("takes only the MATCHING domain's floating Power", () => {
    // A Calm Seal cannot pay a Fury cost. Without the domain check the funnel
    // would let any Seal pay any ability, which is looser than any card prints.
    const state = board(0, 1);
    state.players[0]!.floatingPower = { Calm: 5 };
    const paid = payPowerFromChanneled(state, 0, "Fury", 1);
    expect(paid!.players[0]!.floatingPower.Calm, "a Calm pool paid a Fury cost").toBe(5);
    expect(furyRunesLeft(paid!), "the rune should have paid it instead").toBe(0);
  });

  it("a RAINBOW cost takes floating of any domain", () => {
    // `domain: null` is rainbow — rule 811's pip and Sett - The Boss's — which is
    // exactly what `matchesPowerDomain` already means for the runes.
    const state = board(0, 0);
    state.players[0]!.floatingPower = { Calm: 1 };
    const paid = payPowerFromChanneled(state, 0, null, 1);
    expect(paid, "a rainbow cost could not use a Calm pool").toBeDefined();
    expect(paid!.players[0]!.floatingPower.Calm).toBe(0);
  });

  it("uses Malzahar's unrestricted rainbow pool after the domain one", () => {
    const paid = payPowerFromChanneled(board(0, 0, 2), 0, "Fury", 2);
    expect(paid, "Malzahar's rainbow could not pay an ability cost").toBeDefined();
    expect(paid!.players[0]!.floatingRainbowPower).toBe(0);
  });

  it("leaves the RESTRICTED pools alone — Ornn's row stays open, and narrower", () => {
    // `restrictedSpellPower` and `restrictedGearPower` carry a card-KIND gate
    // ("Spells only", "gear or gear abilities") and this funnel is not told the
    // kind. Spending them here would be wider than the cards print. Asserted so
    // the remaining half of the divergence is pinned rather than forgotten.
    const state = board(0, 1);
    state.players[0]!.restrictedGearPower = 3;
    const paid = payPowerFromChanneled(state, 0, "Fury", 1);
    expect(paid!.players[0]!.restrictedGearPower, "a restricted pool paid without a kind check").toBe(3);
    expect(furyRunesLeft(paid!)).toBe(0);
  });
});
