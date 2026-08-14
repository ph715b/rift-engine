import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { cardEffectDefIds, grantedRepeatCostOf, optionalXpCostDefIds } from "../src/engine/card-effects.js";
import { findUnitAnywhere } from "../src/engine/target-lookup.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { loadCardDefinitions } from "../src/cards/card-loader.js";
import type { GameState, PlayerState } from "../src/model/game-state.js";
import type { CardInstance, UnitInstance } from "../src/model/card.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { Domain } from "../src/model/domain.js";
import { makeState, makeUnit, realGearInstance, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * Wave 8b (Chaos) REFUSED all six of its cards. This file is the MEASUREMENT
 * behind each refusal, not a description of one.
 *
 * Two of the six already carry a `coverage.PARTIALLY_IMPLEMENTED` row and a pin
 * elsewhere (UNL-144 in `unl-chaos-wave4.test.ts`, UNL-150 in
 * `unl-chaos-wave5.test.ts`); nothing here duplicates those. What is here is the
 * set of claims wave 7 made from a READING that this wave re-checked against the
 * code, plus the seams nobody had pinned.
 *
 * **Three wave-7 verdicts moved when they were measured:**
 *   - UNL-122's "I enter ready needs `deploy.conditionalEntersReady`" is WRONG.
 *     `optionalPowerPaid` reaches an on-play unit trigger and `readyUnit` works
 *     from there — Pyke - Dockside Butcher (UNL-028) does exactly that today,
 *     through the real path, and is the positive control below.
 *   - UNL-140's registered comment claimed "there is no XP equivalent of
 *     `OPTIONAL_POWER_COSTS`". There is now (`OPTIONAL_XP_COSTS`, live on
 *     UNL-164), so the note was stale and the real blocker is a different one.
 *   - UNL-144's refusal named `runAwaken` and `mayReadyPermanent`. Only the
 *     first was pinned; the second door is exercised here for the first time.
 *
 * Every block carries a POSITIVE CONTROL, because "the card does nothing" and
 * "my fixture does nothing" are the same observation.
 */

const CRESCENT_GUARDIAN = "UNL-122";
const THE_LIST = "UNL-138";
const CONSCRIPTION = "UNL-140";
const MADULI = "UNL-144";
const SYNDRA_TRANSCENDENT = "UNL-146";

/** Pyke - Dockside Butcher — "You may pay [Fury] as an additional cost to play
 *  me. When you play me, if you paid the additional cost, READY ME and give me
 *  +2 [Might] this turn." The one card in the pool that already does what
 *  Crescent Guardian's second sentence asks for, by the route wave 7 said did
 *  not exist. */
const PYKE_BUTCHER = "UNL-028";
/** Safety Inspector — the pool's only live `OPTIONAL_XP_COSTS` row, and so the
 *  control that says the XP mechanism is reachable at all. */
const SAFETY_INSPECTOR = "UNL-164";
/** Called Shot — the pool's ONLY 0-Energy Spell. Measured: 1 of 192. */
const CALLED_SHOT = "SFD-122";
/** Confront — Body, 2 Energy, no Power, no target. */
const CONFRONT = "OGN-129";
/** Upstage Comedy — Fury, 2 Energy, "Ready a unit" with `scope: "anywhere"`.
 *  The second door into a ready, the one `runAwaken` is not. */
const UPSTAGE_COMEDY = "UNL-009";
/** Chaos, 3 Energy, 3 Might, printed blank — deck and board filler. */
const VANILLA_UNIT = "OGN-175";

const runes = (domain: Domain, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

/** Pops whatever is on the chain, then settles the held triggers behind it. */
function resolveChain(state: GameState): GameState {
  let next = state;
  for (let guard = 0; guard < 8 && next.spellChain.length > 0; guard += 1) {
    const pass = legalActions(next).find((a) => a.type === "PassFocus");
    if (!pass) break;
    next = accept(next, pass);
  }
  return resolveHeldTriggers(next);
}

const live = (state: GameState, instanceId: string): UnitInstance => {
  const found = findUnitAnywhere(state, instanceId);
  expect(found, "the unit left the board").toBeDefined();
  return found!.unit;
};

/** A board where player 0 can pay for anything in this file. */
function richState(): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  for (const player of state.players) {
    player.floatingEnergy = 20;
    player.channeled = [
      ...runes("Chaos", 6),
      ...runes("Fury", 4),
      ...runes("Order", 4),
      ...runes("Body", 4),
      ...runes("Calm", 4),
      ...runes("Mind", 4),
    ];
    // An empty deck is a loss condition rather than a no-op, and two of the
    // spells below draw. Filler so nothing under test ends the game mid-run.
    player.deck = Array.from({ length: 6 }, () => spellInstance(CONFRONT));
  }
  return state;
}

/** Every numeric/boolean field of a PlayerState that `after` changed. The array
 *  and object fields (hand, trash, channeled, floatingPower) are excluded on
 *  purpose: they move on every play of every kind and say nothing about the
 *  card's KIND, which is the whole question this file asks of them. */
function scalarDelta(before: PlayerState, after: PlayerState): string[] {
  const scalar = (v: unknown) => typeof v === "number" || typeof v === "boolean";
  // Through `unknown` first: `PlayerState` is a structured type and TypeScript
  // refuses a direct cast to an index signature. vitest transpiles without
  // typechecking, so this only surfaced at the integrator's `npm run typecheck`.
  const asRecord = (p: PlayerState) => p as unknown as Record<string, unknown>;
  return Object.keys(before)
    .filter((k) => scalar(asRecord(before)[k]) || scalar(asRecord(after)[k]))
    .filter((k) => asRecord(before)[k] !== asRecord(after)[k])
    .sort();
}

// ---------------------------------------------------------------------------
// UNL-122 Crescent Guardian — "If you've played a spell this turn, you may pay
// [Chaos] as an additional cost to play me. If you do, I enter ready."
//
// Wave 7 named three gaps. This block re-measures two of them and finds one of
// the two false.
// ---------------------------------------------------------------------------
describe("UNL-122 Crescent Guardian: has this player played a spell this turn?", () => {
  /** Player 0 holding `defId`, able to pay for it. */
  function holding(defId: string): { state: GameState; card: CardInstance } {
    const state = richState();
    const card = defaultCardRegistry().get(defId).type === "Spell" ? spellInstance(defId) : realUnitInstance(defId);
    state.players[0]!.hand = [card];
    return { state, card };
  }

  it("POSITIVE CONTROL: an ordinary spell moves `maxSpellEnergySpentThisTurn`", () => {
    // The gate for the refutation below. Without this, "the field stayed 0"
    // could just as well mean the fixture never played anything.
    const { state, card } = holding(CONFRONT);
    const after = accept(state, playsOf(state, card.instanceId)[0]!);

    expect(after.players[0]!.maxSpellEnergySpentThisTurn).toBe(2);
    expect(after.players[0]!.cardsPlayedThisTurn).toBe(1);
  });

  it("but a 0-Energy spell leaves it at 0 — the maximum cannot answer 'did you play one'", () => {
    // Called Shot is the pool's only 0-Energy Spell (1 of 192, counted below),
    // and it is not the only way to reach this state: `[Hidden]` plays cost
    // nothing (811) and a discount can reach 0 from above. The field is a
    // MAXIMUM over single spells — `execute-play-card` takes
    // `Math.max(actor.maxSpellEnergySpentThisTurn, modifiedEnergy)` — so it
    // answers "did you spend N on one spell", never "did you play one".
    const { state, card } = holding(CALLED_SHOT);
    const after = accept(state, playsOf(state, card.instanceId)[0]!);

    expect(after.players[0]!.cardsPlayedThisTurn, "the spell was never played").toBe(1);
    expect(
      after.players[0]!.maxSpellEnergySpentThisTurn,
      "it now moves for a 0-Energy spell — the proxy may be sound, re-read this refusal",
    ).toBe(0);
  });

  it("exactly one Spell in the whole pool costs 0 Energy, so the false negative is narrow but real", () => {
    const zeroEnergySpells = loadCardDefinitions()
      .filter((c) => c.type === "Spell" && c.energyCost === 0)
      .map((c) => c.id);
    expect(zeroEnergySpells).toEqual([CALLED_SHOT]);
  });

  it("PINNED: EVERY spell-named PlayerState field, and not one of them counts plays", () => {
    // The completeness half, and the thing that flips the day somebody adds
    // `spellsPlayedThisTurn`. A census rather than a search that came up empty:
    // `makePlayer` has to name every REQUIRED field of `PlayerState` or the
    // fixture stops typechecking, so this list is the type's, not the fixture's.
    //
    // Read against `-raw`: none of the eight is a play counter. Three are
    // restricted pools, two are one-shot charges, one is a grant counter, one is
    // a per-battlefield list, and `maxSpellEnergySpentThisTurn` is the maximum
    // the two tests above already refute.
    expect(
      Object.keys(makeState().players[0]!)
        .filter((k) => /spell/i.test(k))
        .sort(),
      "a new spell-named PlayerState field exists — if it counts plays, this refusal is closed",
    ).toEqual([
      // **`cannotPlaySpellsThisTurn` joined on 2026-08-13** and does NOT close
      // this refusal — it is Lilting Lullaby's BAN, a fact about what a player
      // may do, not a record of what they have done. Crescent Guardian still
      // needs "have you played a spell this turn", which nothing counts.
      //
      // The census did exactly its job: it noticed a new field and made someone
      // answer the question rather than absorbing it silently.
      "cannotPlaySpellsThisTurn",
      "maxSpellEnergySpentThisTurn",
      "nextSpellBonusDamage",
      "nextSpellEnergyDiscount",
      "nextSpellRepeatGrants",
      "preventsSpellDamageThisTurn",
      "restrictedSpellEnergy",
      "restrictedSpellPower",
      "spellChoiceDrawnBattlefieldIds",
    ]);
  });

  it("...and playing one moves only fields that a Gear or a Unit moves too", () => {
    // The other half of the same claim, driven through `submit`: after a real
    // Spell play the only scalars that moved are the universal card counter and
    // the payment. `floatingEnergy` RISES because paying a Power pip exhausts a
    // rune, which yields Energy as well — nothing about it names a Spell.
    const { state, card } = holding(CALLED_SHOT);
    const after = accept(state, playsOf(state, card.instanceId)[0]!);

    expect(
      scalarDelta(state.players[0]!, after.players[0]!),
      "a new PlayerState field moved on a spell play — check whether it counts spells",
    ).toEqual(["cardsPlayedThisTurn", "floatingEnergy"]);
  });

  it("WAVE-7 CORRECTION: 'I enter ready' needs no deploy.ts change — an on-play trigger readies", () => {
    // Wave 7's third gap was "'I enter ready' needs `deploy.conditionalEntersReady`
    // to see `optionalPowerPaid`". It does not: `optionalPowerPaid` rides the
    // PlayCardAction into `dispatchOnPlayUnit`, and Pyke - Dockside Butcher
    // already readies himself from there. Driven through the real path, because
    // that dispatch hop is exactly where this repo's dead features have died.
    //
    // The DIVERGENCE that route carries is recorded rather than hidden: a unit
    // readied by its own on-play trigger has entered EXHAUSTED and been readied,
    // which is not what "I enter ready" says (it is a replacement, 809-style),
    // so it fires `unitReadied` and Mageseeker Warden could block it. That is
    // Pyke's existing shape, not a new one.
    const state = richState();
    const pyke = realUnitInstance(PYKE_BUTCHER);
    state.players[0]!.hand = [pyke];

    const paid = playsOf(state, pyke.instanceId).filter((a) => a.optionalPowerPaid === true);
    expect(paid.length, "the optional Fury cost is no longer offered — this control is dead").toBeGreaterThan(0);

    const after = resolveChain(accept(state, paid[0]!));
    expect(live(after, pyke.instanceId).exhausted, "he arrived exhausted and stayed there").toBe(false);
  });

  it("...and the unpaid variant leaves him exhausted, so the ready is the FLAG's doing", () => {
    const state = richState();
    const pyke = realUnitInstance(PYKE_BUTCHER);
    state.players[0]!.hand = [pyke];

    const unpaid = playsOf(state, pyke.instanceId).filter(
      (a) => a.optionalPowerPaid !== true && a.fromHiddenBattlefieldId === undefined,
    );
    expect(unpaid.length, "no plain variant to compare against").toBeGreaterThan(0);

    const after = resolveChain(accept(state, unpaid[0]!));
    expect(live(after, pyke.instanceId).exhausted).toBe(true);
  });

  it("Crescent Guardian is offered no paid variant, and a bare table row would be worse than none", () => {
    const state = richState();
    const guardian = realUnitInstance(CRESCENT_GUARDIAN);
    state.players[0]!.hand = [guardian];
    const offered = playsOf(state, guardian.instanceId);

    // The tried>0 gate: he must be PLAYABLE, or "no paid variant" is just "no
    // variant of any kind" and says nothing.
    expect(offered.length, "he is unplayable in this fixture, so the next line is vacuous").toBeGreaterThan(0);

    // No paid variant, because `OPTIONAL_POWER_COSTS` has no row for him — and a
    // row on its own would be WRONG, since the table has no place for "if you've
    // played a spell this turn" and the cost would then be offered on a turn the
    // card forbids it. Stronger than printed is the direction this repo works
    // hardest to avoid.
    expect(offered.some((a) => a.optionalPowerPaid === true)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UNL-140 Conscription — "You may spend 5 XP as an additional cost to play
// this. Choose an enemy unit at a battlefield with 3 [Might] or less. If you
// paid the additional cost, choose any enemy unit at a battlefield instead."
// ---------------------------------------------------------------------------
describe("UNL-140 Conscription: what the XP variant is actually blocked on", () => {
  /** Conscription in player 0's hand, `xp` banked, and a 5-Might enemy plus a
   *  2-Might enemy standing at bf1. */
  function conscriptionState(xp: number): { state: GameState; spell: CardInstance; big: UnitInstance; small: UnitInstance } {
    const state = richState();
    const spell = spellInstance(CONSCRIPTION);
    const big = makeUnit({ name: "Big", might: 5 });
    const small = makeUnit({ name: "Small", might: 2 });
    state.players[0]!.hand = [spell];
    state.players[0]!.xp = xp;
    state.battlefields[0]!.units = { p2: [big, small] };
    return { state, spell, big, small };
  }

  it("POSITIVE CONTROL: the XP additional-cost mechanism is live on Safety Inspector", () => {
    // Without this, "Conscription gets no XP variant" is indistinguishable from
    // "nothing in this engine gets one".
    expect(optionalXpCostDefIds()).toContain(SAFETY_INSPECTOR);

    const state = richState();
    const inspector = realUnitInstance(SAFETY_INSPECTOR);
    state.players[0]!.hand = [inspector];
    state.players[0]!.xp = 5;

    expect(playsOf(state, inspector.instanceId).some((a) => a.optionalXpPaid === true)).toBe(true);
  });

  it("Conscription is not in the table, so no XP variant is offered even with the XP banked", () => {
    expect(optionalXpCostDefIds()).not.toContain(CONSCRIPTION);
    const { state, spell } = conscriptionState(5);
    expect(playsOf(state, spell.instanceId).some((a) => a.optionalXpPaid === true)).toBe(false);
  });

  it("...and the enumerator offers only the 3-Might-capped target — the cap is per CARD, not per variant", () => {
    const { state, spell, big, small } = conscriptionState(5);
    const targets = playsOf(state, spell.instanceId).map((a) => a.targetUnitInstanceId);

    expect(targets, "the 2-Might enemy is not reachable, so this fixture proves nothing").toContain(small.instanceId);
    expect(targets).not.toContain(big.instanceId);
  });

  it("PINNED: the VALIDATOR re-derives the cap independently, so a table row alone cannot lift it", () => {
    // This is the measurement that sharpens wave 7's refusal. A
    // `OPTIONAL_XP_COSTS` row would make `legal-actions` offer a paid variant,
    // but that variant is built by spreading a play whose target was already
    // filtered — and even a hand-built action naming the bigger unit is refused
    // HERE, by a second reading of the same `targetingForAnyCard(card)`.
    //
    // The XP flag is deliberately NOT on this action: the cap is what refuses,
    // and the next two tests separate the two refusals so neither can be
    // mistaken for the other.
    const { state, spell, big } = conscriptionState(5);
    const plain = playsOf(state, spell.instanceId)[0]!;
    const forged: PlayCardAction = { ...plain, targetUnitInstanceId: big.instanceId };

    const { state: unchanged, result } = submit(state, forged);
    expect(result.type, "the validator now accepts the wider target — the refusal is closed").toBe("Invalid");
    expect(JSON.stringify(result)).toContain("3 Might or less");
    expect(unchanged, "a refused action must leave the state alone").toBe(state);
  });

  it("CONTROL: the identical action naming the 2-Might enemy is accepted", () => {
    // Without this, the refusal above could be the forging itself, or any of the
    // dozen other checks in `validate-play-card`. The two actions differ in
    // exactly one field.
    const { state, spell, small } = conscriptionState(5);
    const plain = playsOf(state, spell.instanceId)[0]!;
    const legal: PlayCardAction = { ...plain, targetUnitInstanceId: small.instanceId };

    expect(submit(state, legal).result, "the fixture cannot cast the spell at all").toMatchObject({ type: "Ok" });
  });

  it("...and the flag is refused too, so the row is necessary AND not sufficient", () => {
    // `validate-play-card` refuses `optionalXpPaid` on a card with no
    // `OPTIONAL_XP_COSTS` row ("Enforced HERE rather than trusted from the
    // enumerator, in both directions"). So the row is genuinely required —
    // and the previous test says it is not enough on its own, because the
    // targeting spec is still asked once per CARD.
    //
    // The fix is therefore two files agreeing on a spec that depends on the
    // variant, not one row: `targetingForAnyCard` would have to take the
    // variant's flags in `legal-actions.variantsForTargeting` AND in
    // `validate-play-card.targetingRejection`. `[Ambush]`'s
    // destination-dependent timing tier is the nearest precedent.
    const { state, spell, small } = conscriptionState(5);
    const plain = playsOf(state, spell.instanceId)[0]!;
    const forged: PlayCardAction = { ...plain, optionalXpPaid: true, targetUnitInstanceId: small.instanceId };

    const { result } = submit(state, forged);
    expect(result.type).toBe("Invalid");
    expect(JSON.stringify(result)).toContain("has no optional XP cost to pay");
  });
});

// ---------------------------------------------------------------------------
// UNL-144 Maduli the Gatekeeper — "I can't be readied."
//
// `unl-chaos-wave4.test.ts` pins the `runAwaken` door. This is the OTHER one,
// which nothing pinned: `effect-helpers.readyUnit`, gated only by the
// per-PLAYER `mayReadyPermanent`.
// ---------------------------------------------------------------------------
describe("UNL-144 Maduli: the second ready door, through a real spell", () => {
  /** Maduli exhausted in player 0's base beside an exhausted vanilla unit, with
   *  Upstage Comedy in hand. */
  function maduliState(): { state: GameState; spell: CardInstance; maduli: UnitInstance; other: UnitInstance } {
    const state = richState();
    const maduli = { ...realUnitInstance(MADULI), exhausted: true };
    const other = { ...realUnitInstance(VANILLA_UNIT), exhausted: true };
    const spell = spellInstance(UPSTAGE_COMEDY);
    state.players[0]!.hand = [spell];
    state.players[0]!.baseUnits = [maduli, other];
    return { state, spell, maduli, other };
  }

  const readyWith = (state: GameState, spell: CardInstance, victimId: string): GameState => {
    const play = playsOf(state, spell.instanceId).find((a) => a.targetUnitInstanceId === victimId);
    expect(play, "Upstage Comedy was never offered that unit").toBeDefined();
    return resolveChain(accept(state, play!));
  };

  it("POSITIVE CONTROL: Upstage Comedy readies an ordinary exhausted unit", () => {
    const { state, spell, other } = maduliState();
    expect(readyWith(state, spell, other.instanceId).players[0]!.baseUnits.find((u) => u.instanceId === other.instanceId)!.exhausted).toBe(false);
  });

  it("a real spell does not ready him either — he prints 'I can't be readied'", () => {
    // **FLIPPED 2026-08-13.** This was a PIN OF A KNOWN DIVERGENCE asserting the
    // WRONG answer on purpose, and its instruction — "implementing the clause
    // must flip BOTH this and the wave-4 pin" — is exactly what happened: both
    // went red on the first root run after `board-restrictions.unitMayBeReadied`
    // landed.
    //
    // Its diagnosis was right too, and shaped the fix. `readyUnit`'s only lock
    // was `mayReadyPermanent(state, ownerIndex)` — the Mageseeker Warden's, which
    // is per-PLAYER and "cannot carry a restriction belonging to one body". The
    // new predicate is per-UNIT for that reason and is asked at both doors.
    //
    // Worth keeping pointed the right way rather than deleting, because this one
    // drives a REAL SPELL through `legalActions`/`submit` — the wave-4 pin calls
    // `runAwaken` directly, and `test/maduli-cannot-be-readied.test.ts` calls
    // `readyUnit` directly. This is the only one that proves the lock survives
    // the whole play path.
    const { state, spell, maduli } = maduliState();
    const after = readyWith(state, spell, maduli.instanceId);

    expect(
      after.players[0]!.baseUnits.find((u) => u.instanceId === maduli.instanceId)!.exhausted,
      "a spell readied Maduli",
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UNL-146 Syndra - Transcendent — "While I'm in a showdown, your spells have
// [Repeat] [2][Chaos]."
//
// The Repeat RULING is settled and is not re-derived here (820.3 gives one extra
// execution per instance paid, 820.1.c.3 caps each cost at one payment, 820.2.a
// lets the choices differ per execution, 820.3.a keeps the spell played once).
// What is measured is the SHAPE the engine's granted-Repeat machinery has, and
// why Syndra's grant does not fit it.
// ---------------------------------------------------------------------------
describe("UNL-146 Syndra: why the existing granted-[Repeat] route cannot carry her", () => {
  it("a granted cost is DERIVED from the card, so a fixed [2][Chaos] has nowhere to live", () => {
    // Temporal Portal grants "[Repeat] equal to its cost", so
    // `grantedRepeatCostOf` computes the price from the spell rather than
    // reading one. Syndra's price is a constant that is not the spell's cost and
    // carries a DOMAIN, and the returned record has no domain at all.
    const upstage = spellInstance(UPSTAGE_COMEDY); // 2 Energy, 0 Power
    const granted = grantedRepeatCostOf(upstage, 1);

    expect(granted).toEqual({ energy: 2, power: 0 });
    expect(granted?.domain, "a domain arrived — the derivation may have been replaced").toBeUndefined();

    // Syndra's printed price, for the diff: neither half matches.
    const syndraPrice = { energy: 2, power: 1, domain: "Chaos" as const };
    expect(granted).not.toEqual(syndraPrice);
  });

  it("...and it is asked with no state, so 'while I'm in a showdown' cannot be a condition on it", () => {
    // Both call sites pass `actor.nextSpellRepeatGrants` and nothing else. A
    // conditional aura needs the board, which means a signature change in
    // card-effects.ts plus both callers (legal-actions.ts, validate-play-card.ts).
    expect(grantedRepeatCostOf.length, "it takes state now — re-read this refusal").toBe(2);
  });

  it("PINNED: the grant counter is spent by the NEXT SPELL PLAYED, not held while a unit stands", () => {
    // Riding `nextSpellRepeatGrants` would give Syndra ONE repeatable spell per
    // arming rather than every spell she is in a showdown for. Driven through
    // `submit`, because the clear lives in `execute-play-card` and a direct read
    // of the field would not exercise it.
    const state = richState();
    const spell = spellInstance(CONFRONT);
    state.players[0]!.hand = [spell];
    state.players[0]!.nextSpellRepeatGrants = 2;

    const after = accept(state, playsOf(state, spell.instanceId)[0]!);

    expect(after.players[0]!.cardsPlayedThisTurn, "the spell never resolved, so the clear proves nothing").toBe(1);
    expect(
      after.players[0]!.nextSpellRepeatGrants,
      "the counter survived a spell — it may now be able to model a continuous grant",
    ).toBe(0);
  });

  it("Syndra grants nothing today: a spell played beside her in a showdown has no repeat variant", () => {
    const state = richState();
    const syndra = realUnitInstance(SYNDRA_TRANSCENDENT);
    const spell = spellInstance(CONFRONT);
    state.players[0]!.hand = [spell];
    state.battlefields[0]!.units = { p1: [syndra] };
    const offered = playsOf(state, spell.instanceId);

    // tried>0: the spell must be playable at all, or "no repeat variant" is
    // "no variant".
    expect(offered.length, "the spell is unplayable here, so the next line is vacuous").toBeGreaterThan(0);
    expect(
      offered.some((a) => a.grantedRepeatPaid === true || a.repeatPaid === true),
      "a repeat variant is offered beside Syndra — she is implemented, retire this",
    ).toBe(false);

    // The control that says the enumerator CAN offer one: arm the mechanism that
    // exists, and the same spell grows a second variant.
    const armed = { ...state, players: [{ ...state.players[0]!, nextSpellRepeatGrants: 1 }, state.players[1]!] } as GameState;
    expect(
      playsOf(armed, spell.instanceId).some((a) => a.grantedRepeatPaid === true),
      "the granted-repeat enumerator is dead, so the assertion above measured nothing",
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UNL-138 The List — "As you play this, name a tag. [Exhaust]: Give a unit with
// the named tag -2 [Might] this turn."
// ---------------------------------------------------------------------------
describe("UNL-138 The List: where the named tag would have to live", () => {
  it("the pool has 111 distinct tags, so a mode-per-tag enumeration is not a route", () => {
    // `CardMode` is the one existing shape that carries a per-choice
    // `TargetingSpec`, and `legal-actions` fans every mode out unconditionally
    // — one play of a 1-Energy gear would push 111 actions before targets.
    // A floor rather than an equality: a new set adds tags and must not fail this.
    const tags = new Set(loadCardDefinitions().flatMap((c) => ("tags" in c ? (c.tags ?? []) : [])));
    expect(tags.size).toBeGreaterThanOrEqual(111);
  });

  it("PINNED: a GearInstance has no field that could hold the name", () => {
    // The whole refusal in one assertion. `CardInstanceBase` carries
    // instanceId/defId/name/domains/exhausted/isToken and GearInstance adds the
    // cost fields plus four optional ones, every one of them for a different
    // card. There is no generic bag, so the string chosen at play time has
    // nowhere to be written and nothing for the [Exhaust] ability to read.
    //
    // Flips when someone adds the field — which is the point.
    expect(Object.keys(realGearInstance(THE_LIST)).sort()).toEqual(
      [
        "attachedToInstanceId",
        "defId",
        "domains",
        "energyCost",
        "exhausted",
        "instanceId",
        "isReaction",
        "isToken",
        "keywords",
        "kind",
        "name",
        "powerCost",
        "powerDomain",
      ].sort(),
    );
  });

  it("...and no Gear in the pool has a registered card effect, because playing one resolves nothing", () => {
    // The other half of "as you play this" having no home. A Spell goes on the
    // chain and `card-effect-resolution` runs its registered `resolve`; a Gear
    // goes straight into `activeGear` and never reaches that file at all. So the
    // count is 0 of 91, and it is 0 for a structural reason rather than by
    // coincidence — nothing would call the entry.
    const gearDefIds = new Set(loadCardDefinitions().filter((c) => c.type === "Gear").map((c) => c.id));
    expect(gearDefIds.size, "the pool has no Gear at all, so this measures nothing").toBeGreaterThan(20);
    expect(cardEffectDefIds().filter((id) => gearDefIds.has(id))).toEqual([]);

    // Driven through `submit`, because the registry census above is a statement
    // about what people wrote and this is a statement about what the engine does.
    const state = richState();
    const list = realGearInstance(THE_LIST);
    state.players[0]!.hand = [list];
    const after = accept(state, playsOf(state, list.instanceId)[0]!);

    expect(after.players[0]!.activeGear.map((g) => g.instanceId), "it never landed").toEqual([list.instanceId]);
    expect(after.spellChain, "a Gear reached the chain — there is a resolution step to hang the naming on now").toEqual([]);
  });

  it("POSITIVE CONTROL: a unit instance DOES carry its tags, so only the naming half is missing", () => {
    // Worth separating: the ability's filter is expressible today. It is the
    // "as you play this, name a tag" half — a play-time choice with no action
    // field and no per-instance home — that has nothing behind it.
    const tagged = realUnitInstance(CRESCENT_GUARDIAN); // tags: ["Mount Targon"]
    expect(tagged.tags).toContain("Mount Targon");
  });
});
