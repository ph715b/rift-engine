import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { makeState, makeUnit, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * **Skyward Strike (UNL-038) — "Move an enemy unit. [Level 6][>] [Stun] an enemy
 * unit."**
 *
 * Refused across two Calm waves for a reason that turned out to be exactly
 * right and exactly two table rows: the card needs a chosen DESTINATION, and
 * `cardMovesTarget` / `cardMayMoveToBase` are hand-listed tables in the shared
 * `card-effects.ts`.
 *
 * # Two slots that are not interchangeable
 *
 * Slot 0 moves, slot 1 is stunned, and `asymmetricSlots` is what makes (move A,
 * stun B) and (move B, stun A) both offered — for two same-role slots the
 * enumerator otherwise prunes one ordering as a duplicate, which is right for
 * every other such card and wrong here.
 *
 * Dragon's Rage is the precedent for a `unitSlots` card carrying a destination
 * at all: the slot enumeration writes slot 0 to `targetUnitInstanceId`, which is
 * the field `withDestinations` reads.
 *
 * # The recorded gap
 *
 * `[Level 6]` cannot be asked by a `TargetingSpec`, which is static, so the stun
 * slot is optional and the RESOLVER gates it on XP. Below 6 XP a caster may name
 * a second target and it does nothing — an over-OFFER, never an over-reach.
 */

const registry = defaultCardRegistry();
const SKYWARD_STRIKE = "UNL-038";
const LEVEL = 6;

/** Two enemy units at bf1, the spell in hand, and `xp` on the caster. */
function board(xp: number): { state: GameState; a: UnitInstance; b: UnitInstance } {
  const a = makeUnit({ instanceId: "a", name: "A" });
  const b = makeUnit({ instanceId: "b", name: "B" });
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.hand = [spellInstance(SKYWARD_STRIKE)];
  state.players[0]!.floatingEnergy = 20;
  state.players[0]!.floatingPower = { Fury: 9, Calm: 9, Mind: 9, Body: 9, Chaos: 9, Order: 9 };
  state.players[0]!.xp = xp;
  state.battlefields[0]!.units = { p2: [a, b] };
  return { state, a, b };
}

const playsOf = (state: GameState): PlayCardAction[] =>
  legalActions(state).filter((x): x is PlayCardAction => x.type === "PlayCard" && x.card.defId === SKYWARD_STRIKE);

const shapes = (state: GameState): string[] =>
  playsOf(state)
    .map((p) => `${p.targetUnitInstanceId ?? "-"}/${p.secondTargetUnitInstanceId ?? "-"}->${p.destinationBattlefieldId ?? "base"}`)
    .sort();

function play(state: GameState, action: PlayCardAction): GameState {
  const { state: next, result } = submit(state, action);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return resolveHeldTriggers(next);
}

const whereIs = (state: GameState, id: string): string => {
  for (const bf of state.battlefields) {
    if (Object.values(bf.units).flat().some((u) => u.instanceId === id)) return bf.id;
  }
  return "base";
};
const unitOf = (state: GameState, id: string): UnitInstance =>
  [...state.players[0]!.baseUnits, ...state.players[1]!.baseUnits, ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat())].find(
    (u) => u.instanceId === id,
  )!;

describe("Skyward Strike: the move, and the destinations it is offered", () => {
  /**
   * **The self-pairs joined this list on 2026-08-23.** The card's two slots are
   * two SEPARATE INSTRUCTIONS — "Move an enemy unit" and "[Level 6] Stun an enemy
   * unit" — each choosing independently, so moving a unit and then stunning that
   * same unit is a line it allows. `legal-actions` excluded every same-unit pair
   * for every slot card; `TargetingSpec.slotsMayCoincide` is the opt-in, and this
   * is the only card in the pool that takes it.
   *
   * Left as an EXHAUSTIVE list rather than loosened to a `toContain`: the point
   * of this assertion is the whole offered set, and a widening that also dropped
   * or duplicated a distinct pairing would slip past a subset check.
   */
  it("offers both orderings of the pair, and the self-pairs — the slots are NOT interchangeable", () => {
    expect(shapes(board(LEVEL).state)).toEqual([
      "a/-->base", "a/-->bf2", "a/a->base", "a/a->bf2", "a/b->base", "a/b->bf2",
      "b/-->base", "b/-->bf2", "b/a->base", "b/a->bf2", "b/b->base", "b/b->bf2",
    ].sort());
  });

  it("never offers the moved unit's OWN battlefield — 355.4.a", () => {
    // Both units stand at bf1, so a bf1 destination would be a no-op move the
    // caster paid for.
    expect(shapes(board(LEVEL).state).some((s) => s.endsWith("->bf1")), "a no-op move was offered").toBe(false);
  });

  it("offers BASE, because the card names no battlefield (198.1 / 355.4.a)", () => {
    expect(shapes(board(LEVEL).state).some((s) => s.endsWith("->base")), "base was not a legal destination").toBe(true);
  });

  it("every enumerated play is accepted by the validator", () => {
    // The offered-then-refused split, which is this engine's most repeated bug
    // and which a card with a destination AND two slots is a fresh chance at.
    const { state } = board(LEVEL);
    const plays = playsOf(state);
    expect(plays.length, "nothing was enumerated").toBeGreaterThan(0);
    for (const p of plays) {
      const verdict = validatePlayCard(state, p);
      expect(verdict.ok, verdict.ok ? "" : verdict.error).toBe(true);
    }
  });

  it("moves the named unit to the named destination", () => {
    const { state, a } = board(0);
    const action = playsOf(state).find((p) => p.targetUnitInstanceId === "a" && p.destinationBattlefieldId === "bf2")!;
    const after = play(state, action);
    expect(whereIs(after, a.instanceId), "it did not move").toBe("bf2");
  });
});

describe("the [Level 6] stun", () => {
  it("stuns the second unit at 6 XP", () => {
    const { state } = board(LEVEL);
    const action = playsOf(state).find((p) => p.targetUnitInstanceId === "a" && p.secondTargetUnitInstanceId === "b")!;
    const after = play(state, action);
    expect(unitOf(after, "b").stunned, "the [Level 6] stun did not fire at 6 XP").toBe(true);
  });

  it("...and does NOT at 5 — the boundary", () => {
    // **This test's PREMISE changed on 2026-08-23, and it got stronger.** It used
    // to build the two-target action below the level, submit it, and assert the
    // stun did not fire — which was only expressible because the pair was
    // ENUMERABLE at any XP. It is not any more: 355.8 declares targets at
    // finalization and 824.1.d makes the clause Inactive below the threshold, so
    // the slot is no longer offered (`secondSlotLevel`). See the pin below.
    //
    // Both halves of the original intent survive, and neither is weakened: the
    // stun does not happen, and the move still does — which is what makes this a
    // gate on the second CLAUSE rather than on the card.
    const { state } = board(LEVEL - 1);
    expect(
      playsOf(state).filter((p) => p.secondTargetUnitInstanceId !== undefined),
      "a stun target was offered below the level",
    ).toHaveLength(0);

    const moveOnly = playsOf(state).find((p) => p.targetUnitInstanceId === "a" && p.destinationBattlefieldId === "bf2");
    expect(moveOnly, "the move-only play disappeared below the level").toBeDefined();
    const after = play(state, moveOnly!);
    expect(unitOf(after, "b").stunned, "something stunned the second unit below the level").toBe(false);
    expect(whereIs(after, "a"), "the move stopped happening too").toBe("bf2");
  });

  it("does not stun the unit it MOVED — the slots are distinct", () => {
    const { state } = board(LEVEL);
    const action = playsOf(state).find((p) => p.targetUnitInstanceId === "a" && p.secondTargetUnitInstanceId === "b")!;
    const after = play(state, action);
    expect(unitOf(after, "a").stunned, "it stunned the moved unit instead of the named one").toBe(false);
  });

  it("below 6 XP the second target is NOT offered", () => {
    // **This was a premise pin, and it fired on 2026-08-23 exactly as intended.**
    //
    // It used to assert the opposite — that the stun slot IS offered below the
    // level and does nothing — and its comment read: "A `TargetingSpec` is static
    // and cannot ask the board, so the stun slot is offered at any XP and the
    // resolver gates it. An over-OFFER, never an over-reach — delete this pin if
    // the spec ever learns to ask."
    //
    // **It was right about the blocker and wrong that it was unfixable**, which
    // is this repo's most common refusal shape. The spec OBJECT is static; the
    // walk that reads it is not, and the very loop emitting these pairs already
    // asks the board twice (`sameBattlefield`, `secondMightBelowFirst`).
    // `secondSlotLevel` is the field, asked in `legal-actions` AND in
    // `validate-play-card` so the two cannot drift.
    //
    // Kept pointed the other way rather than deleted: "a slot is not offered" is
    // a NEGATIVE, and a slot that silently starts being offered again looks like
    // nothing at all from the outside.
    const { state } = board(0);
    expect(
      shapes(state).some((s) => s.startsWith("a/b")),
      "the [Level 6] stun slot is being offered below the level again",
    ).toBe(false);
    // Positive control on the same fixture, so this cannot pass by the card
    // becoming unplayable.
    expect(shapes(state).length, "Skyward Strike offers nothing at all below the level").toBeGreaterThan(0);
  });
});

describe("coverage", () => {
  it("is whole, and its text is the two clauses this file tests", () => {
    expect(isCardImplemented(registry.get(SKYWARD_STRIKE)), "Skyward Strike is greyed").toBe(true);
    expect(registry.get(SKYWARD_STRIKE).text).toContain("Move an enemy unit");
    expect(registry.get(SKYWARD_STRIKE).text).toContain("[Level 6]");
  });
});
