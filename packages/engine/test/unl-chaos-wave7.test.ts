import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { effectiveMight, effectiveMightDefIds } from "../src/engine/effective-might.js";
import { unitChooseableBy } from "../src/engine/target-lookup.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * Unleashed wave 7, effects/chaos.ts — **Baron Nashor (UNL-147), and only his
 * THIRD sentence**: "Other friendly units have +2 [Might]."
 *
 * The other six cards in the wave were refused; see the report, and see the
 * entry's own comment in `effects/chaos.ts` for the two clauses of THIS card
 * that are not written and the shared files they each need.
 *
 * # Why this file leads with a control rather than with the effect
 *
 * A board-wide aura is the easiest thing in this engine to ship inert and have
 * pass a happy-path test: `effectiveMight` sums a pile of terms, and a fixture
 * that hands a unit a Might of 5 proves nothing unless the SAME fixture without
 * the source reads 3. Every arithmetic assertion below is therefore paired — the
 * board with Baron and the identical board without him — and the pairs are what
 * the test is, not decoration on it.
 *
 * # And why it also fights a combat
 *
 * `effectiveMight` is a function; a game is not. The combat pair at the foot of
 * the file sizes the damage pool so that the aura is the ONLY thing deciding who
 * dies, which is the check that would have caught the modifier being registered
 * under a key nothing merges.
 */

const BARON = "UNL-147";
/** The `(Ultimate)` reprint. A DISTINCT defId that `printingAliases` redirects to
 *  UNL-147 — so the registry merge finds the modifier, but a bare
 *  `unit.defId === BARON` inside it would not find the unit. */
const BARON_ULTIMATE = "UNL-238";
/** Chaos, 3 Energy, 3 Might, printed blank — deck filler, so a Cleanup can never
 *  read an empty deck as a loss mid-assertion. */
const VANILLA_UNIT = "OGN-175";

/** A board with `p1` units in base and at `bf1`, and `p2` units at `bf1`. */
function board(opts: {
  p1Base?: UnitInstance[];
  p1Field?: UnitInstance[];
  p2Field?: UnitInstance[];
  p1Hand?: UnitInstance[];
}): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.baseUnits = opts.p1Base ?? [];
  state.players[0]!.hand = opts.p1Hand ?? [];
  state.battlefields[0] = {
    ...state.battlefields[0]!,
    units: { p1: opts.p1Field ?? [], p2: opts.p2Field ?? [] },
  };
  return state;
}

const baron = () => realUnitInstance(BARON);
const ultimateBaron = () => realUnitInstance(BARON_ULTIMATE);

/** Non-combat current Might (143.2) of a unit standing at `bf1`. */
const mightAtField = (state: GameState, unit: UnitInstance, ownerIndex: 0 | 1 = 0) =>
  effectiveMight(state, unit, ownerIndex, { isCombat: false, battlefieldId: "bf1" });

/** Non-combat current Might of a unit standing in base — `battlefieldId` omitted,
 *  which is how `effectiveMight` is told the unit is not at a battlefield. */
const mightInBase = (state: GameState, unit: UnitInstance, ownerIndex: 0 | 1 = 0) =>
  effectiveMight(state, unit, ownerIndex, { isCombat: false });

describe("Baron Nashor — 'Other friendly units have +2 [Might]'", () => {
  it("CONTROL: with no Baron anywhere, a friendly unit is its printed Might", () => {
    // The gate for every figure below. Without this, a modifier that returned a
    // constant 2 for every unit on every board would pass the next four tests.
    const ally = makeUnit({ name: "Ally", might: 3 });
    expect(mightAtField(board({ p1Field: [ally] }), ally)).toBe(3);
  });

  it("a Baron in BASE buffs a friendly unit at a battlefield — his sentence prints no 'here'", () => {
    // 141.1.a.1: "Units are at one of several Locations while on the Board: a
    // Battlefield or their Base." Garen - Commander and Darius - Executioner print
    // "+1 Might HERE" and their shared loop in `continuousAuraBonus` compares
    // locations; Baron prints no such word, so the two zones must not be compared.
    const ally = makeUnit({ name: "Ally", might: 3 });
    expect(mightAtField(board({ p1Base: [baron()], p1Field: [ally] }), ally)).toBe(5);
  });

  it("...and a Baron AT A BATTLEFIELD buffs a friendly unit in base", () => {
    // The same claim from the other end. A modifier that accidentally read
    // `ctx.battlefieldId` would pass one of these two and fail the other.
    const ally = makeUnit({ name: "Ally", might: 3 });
    expect(mightInBase(board({ p1Base: [ally], p1Field: [baron()] }), ally)).toBe(5);
  });

  it("he does not buff HIMSELF — 'OTHER friendly units'", () => {
    const self = baron();
    expect(mightAtField(board({ p1Field: [self] }), self)).toBe(12); // printed
  });

  it("he does not buff ENEMY units standing beside him", () => {
    // "FRIENDLY" is measured from the buffed unit's controller. The enemy unit is
    // at the SAME battlefield, which is the fixture a positional-aura bug would
    // still pass.
    const enemy = makeUnit({ name: "Enemy", might: 3 });
    const state = board({ p1Field: [baron()], p2Field: [enemy] });
    expect(mightAtField(state, enemy, 1)).toBe(3);
  });

  it("a Baron in HAND buffs nothing — the aura needs him on the Board", () => {
    // A continuous ability of a permanent is only active while the permanent is in
    // play. This is the control that separates "counts Barons in play" from
    // "counts Barons the player owns".
    const ally = makeUnit({ name: "Ally", might: 3 });
    expect(mightAtField(board({ p1Field: [ally], p1Hand: [baron()] }), ally)).toBe(3);
  });

  it("TWO Barons stack: each gets +2 from the other, everyone else gets +4", () => {
    // He is not a Champion (`isChampion: false`), so a deck may run three. The
    // exclusion is by INSTANCE, not by defId — a `unit.defId !== BARON` guard, the
    // shape Garen's loop uses, would have read this pair as 12 and 12.
    const first = baron();
    const second = baron();
    const ally = makeUnit({ name: "Ally", might: 3 });
    const state = board({ p1Field: [first, second, ally] });

    expect(mightAtField(state, first), "the first Baron got nothing from the second").toBe(14);
    expect(mightAtField(state, second), "the second Baron got nothing from the first").toBe(14);
    expect(mightAtField(state, ally), "two Barons did not stack").toBe(7);
  });

  it("the (Ultimate) reprint is the same card at BOTH ends of the aura", () => {
    // `mergeRegistries` aliases UNL-238's registry lookup to UNL-147, so the
    // modifier is found either way. What it cannot reach is the defId comparison
    // INSIDE the modifier — `card-loader`'s own note says those are exactly the
    // sites a merge misses, which is why `canonicalDefId` is called there.
    const ally = makeUnit({ name: "Ally", might: 3 });
    expect(
      mightAtField(board({ p1Field: [ultimateBaron(), ally] }), ally),
      "an Ultimate Baron gave no aura — the source side missed the alias",
    ).toBe(5);

    const ult = ultimateBaron();
    expect(
      mightAtField(board({ p1Field: [baron(), ult] }), ult),
      "an Ultimate Baron beside a plain one is buffed by 2 and no more",
    ).toBe(14);
  });

  it("both ZONES are walked by the same predicate — the base half, exercised", () => {
    // **This test exists because a mutation survived.** `otherBaronsControlledBy`
    // was first written as two independent loops, and killing the `canonicalDefId`
    // call in the BASE one changed nothing anywhere in the suite: every alias and
    // exclusion case above stands its Barons at a battlefield. The loops now share
    // one predicate, and these two lines are what say the base path is real.
    const ally = makeUnit({ name: "Ally", might: 3 });
    expect(
      mightAtField(board({ p1Base: [ultimateBaron()], p1Field: [ally] }), ally),
      "an Ultimate Baron in BASE gave no aura",
    ).toBe(5);

    const first = baron();
    const second = baron();
    expect(
      mightInBase(board({ p1Base: [first, second] }), first),
      "a Baron in base counted himself, or missed his twin",
    ).toBe(14);
  });
});

describe("the aura in a real combat, where it decides who dies", () => {
  /** Attacker 3 Might vs defender 4 Might, with `p1Base` whatever the caller puts
   *  there. Sized so the aura is the ONLY thing that changes the outcome: 3 does
   *  not kill a 4, and 3+2 does. Read through DEATHS, never `damage` — rule 466
   *  step 3c heals every survivor, so `damage` is 0 either way. */
  function fight(p1Base: UnitInstance[]): { state: GameState; defenderId: string; attackerId: string } {
    const attacker = makeUnit({ name: "Attacker", might: 3 });
    const defender = makeUnit({ name: "Defender", might: 4 });
    const state = board({ p1Base, p1Field: [attacker], p2Field: [defender] });
    state.battlefields[0] = { ...state.battlefields[0]!, contestedByIndex: 0 };
    return { state, defenderId: defender.instanceId, attackerId: attacker.instanceId };
  }

  const standing = (state: GameState, instanceId: string): boolean => {
    const bf = state.battlefields[0]!;
    return [...(bf.units["p1"] ?? []), ...(bf.units["p2"] ?? [])].some((u) => u.instanceId === instanceId);
  };

  it("CONTROL: with no Baron in base the 3-Might attacker cannot kill a 4-Might defender", () => {
    const { state, defenderId } = fight([]);
    expect(standing(resolveShowdown(state, "bf1", 0), defenderId)).toBe(true);
  });

  it("with Baron in base the same attacker deals 5 and the defender dies", () => {
    // The pair. This is the assertion that fails if the modifier is registered
    // under a key nothing merges, or if it is filtered out of the combat context.
    const { state, defenderId, attackerId } = fight([baron()]);
    const resolved = resolveShowdown(state, "bf1", 0);
    expect(standing(resolved, defenderId), "the aura did not reach the outgoing damage pool").toBe(false);
    expect(standing(resolved, attackerId), "the attacker died to a 4-Might defender at 5 Might").toBe(true);
  });
});

describe("what is NOT written on Baron Nashor — pinned, so closing it fails loudly", () => {
  /** He costs 10 Energy and 3 Chaos, so the fixture pays out of floating. */
  function richState(): GameState {
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    for (const player of state.players) {
      player.floatingEnergy = 20;
      player.floatingPower = { Chaos: 9, Body: 9, Fury: 9, Mind: 9, Order: 9, Calm: 9 };
      player.deck = [spellInstance("OGN-198"), spellInstance("OGN-198")];
    }
    state.players[0]!.deck = [makeUnit({ defId: VANILLA_UNIT }), makeUnit({ defId: VANILLA_UNIT })];
    return state;
  }

  it("his SECOND sentence LANDED — this pin fired the same day it was written", () => {
    // It asserted the WRONG answer on purpose: "one row in
    // `target-lookup.UNCHOOSEABLE_BY_ENEMIES` — the table Ruin Runner (SFD-105)
    // and Master Yi - Unstoppable (UNL-059) already sit in — and that file is
    // shared. Adding the row must flip this line."
    //
    // The integrator added exactly that row, so it flipped. Inverted rather than
    // deleted for the reason Alpha Wildclaw's own pin gives: this clause is a pure
    // NEGATIVE, and if it silently stopped being registered nothing would look
    // wrong — a play that should be impossible would simply become legal.
    const b = baron();
    const state = board({ p1Field: [b] });
    expect(unitChooseableBy(state, b, 0, 1), "an enemy can choose Baron Nashor again").toBe(false);
    // ...and the half that is already right, so this pin cannot pass vacuously
    // through a `unitChooseableBy` that returns true for everything.
    expect(unitChooseableBy(state, b, 0, 0), "his own controller could not choose him").toBe(true);
  });

  it("his FIRST sentence is unwritten: playing him adds no battlefield, and he lands where he was played", () => {
    // "As you play me, add the Baron Pit battlefield token to the board if it's not
    // there already. If you do, I enter there." **187.9** defines the token
    // ("Units can move here from anywhere") and **369.3** makes the last sentence a
    // replacement effect on his entry location; **172** makes the number of
    // battlefields a property of the Mode of Play, and this engine builds exactly
    // two at setup with no writer that appends one.
    //
    // A REAL play through `legalActions` + `submit`, not a resolver call: the whole
    // point of the pin is that nothing in the live play path creates the token.
    const state = richState();
    const b = baron();
    state.players[0]!.hand = [b];

    const play = legalActions(state).find(
      (a): a is PlayCardAction =>
        a.type === "PlayCard" && a.card.instanceId === b.instanceId && a.destinationBattlefieldId === undefined,
    );
    expect(play, "Baron Nashor had no legal base play at 20 Energy and 9 Chaos").toBeDefined();

    const { state: next, result } = submit(state, play!);
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
    const settled = resolveHeldTriggers(next);

    expect(settled.battlefields.length, "a third battlefield appeared — retire this pin").toBe(2);
    expect(settled.battlefields.map((bf) => bf.name)).not.toContain("Baron Pit");
    expect(
      settled.players[0]!.baseUnits.some((u) => u.instanceId === b.instanceId),
      "he did not land in the base he was played to",
    ).toBe(true);
  });

  it("coverage sees him through the Might-modifier seam", () => {
    // He is reported by `effectiveMightDefIds`, so the registered clause is not
    // counted inert. **He still owes a `coverage.PARTIALLY_IMPLEMENTED` row** for
    // the two sentences above — he has no unimplemented keyword to grey him, so
    // without one he reports finished. That row is in a shared file this wave may
    // not edit; adding it flips `isCardImplemented(UNL-147)` to false, which is why
    // this test asserts the seam membership rather than the coverage verdict.
    expect(effectiveMightDefIds()).toContain(BARON);
  });
});
