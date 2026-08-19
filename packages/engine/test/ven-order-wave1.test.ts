import { describe, expect, it } from "vitest";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { RuneCard } from "../src/model/rune.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { effectiveKeywords } from "../src/engine/granted-keywords.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { modifiedEnergyCost, scaledPowerDiscount } from "../src/engine/cost-modifiers.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { dealDamage, empowerPermanent } from "../src/engine/effect-helpers.js";
import { effectForCard } from "../src/engine/card-effects.js";
import { eventTriggerFor, holdEventTrigger } from "../src/engine/triggers.js";
import type { GameEvent } from "../src/engine/triggers.js";
import { optionsFor } from "../src/engine/decisions.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { runEnd } from "../src/engine/turn-manager.js";
import {
  answerDecisions,
  beginCombatAt,
  makeState,
  makeUnit,
  playUnitTrigger,
  realGearInstance,
  realUnitInstance,
  resolveHeldTriggers,
  spellInstance,
} from "./fixtures.js";

/**
 * **Vendetta's Order cards — the first wave, and the set's defining motif.**
 *
 * Four of these cards turn on a formation: "exactly one other unit you control
 * here" (Disciple of Shen, Sacred Protector, Shen) and "exactly two units there"
 * (Keeper of Law). EXACTLY is the whole design — two allies is as dead as none —
 * and it is the boundary no board built with a single ally can ever see. Every
 * one of them is therefore asserted at the boundary in BOTH directions.
 *
 * The wave also lands three engine-level pieces, each tested on its own before
 * the card that needed it: rule 477's layer order (Dragon Form assigns base
 * Might, and everything else still adds on top), an amount-based damage
 * prevention pool (Ki Barrier), and owner/domain narrowings on `unitOrGear`
 * targeting that BOTH the enumerator and the validator now read (Decree of
 * Unity).
 */

const registry = defaultCardRegistry();

const DRAGON_FORM = "VEN-116";
const DISCIPLE_OF_SHEN = "VEN-117";
const KEEPER_OF_LAW = "VEN-119";
const MASA = "VEN-120";
const RELUCTANT_LEADER = "VEN-121";
const HUNGRY_WOLF = "VEN-125";
const KI_BARRIER = "VEN-126";
const LACERATE = "VEN-127";
const SACRED_PROTECTOR = "VEN-129";
const DECREE_OF_UNITY = "VEN-131";
const KENNEN = "VEN-135";
const SHEN = "VEN-138";

/** Lacerate's ORDER test needs a unit that is out of range while [Empowered] and
 *  in range once stripped. VEN-124 Escaped Grayback is 3 Might with a +2 grant —
 *  5 while Empowered, 3 without. Its numbers are asserted in the test rather than
 *  assumed, so a data change fails loudly instead of going vacuous. */
const EMPOWERED_FIXTURE = "VEN-124";
const EMPOWERED_FIXTURE_MIGHT = 3;
const EMPOWERED_FIXTURE_GRANT = 2;

/** The `cardPlayed` arm of the event union, for the fixture below. */
type CardPlayedEvent = Extract<GameEvent, { kind: "cardPlayed" }>;

const order = (id: string): RuneCard => ({ id, domain: "Order", state: "Ready" });
const runes = (count: number, prefix = "o"): RuneCard[] =>
  Array.from({ length: count }, (_, i) => order(`${prefix}${i}`));

function onBoard(state: GameState, instanceId: string): UnitInstance | undefined {
  for (const player of state.players) {
    const found =
      player.baseUnits.find((u) => u.instanceId === instanceId) ??
      state.battlefields.flatMap((bf) => bf.units[player.id] ?? []).find((u) => u.instanceId === instanceId);
    if (found) return found;
  }
  return undefined;
}

/** Runs a Spell's registered effect with a chosen target and settles anything it
 *  holds — what `playSpellImmediately` does, minus the payment. */
function castSpell(state: GameState, defId: string, casterIndex: 0 | 1, event: Record<string, unknown> = {}): GameState {
  const card = spellInstance(defId);
  const effect = effectForCard(card);
  expect(effect, `${defId} has no registered card effect`).toBeDefined();
  return resolveHeldTriggers(
    effect!.resolve!(
      state,
      { casterIndex, opponentIndex: casterIndex === 0 ? 1 : 0 },
      { type: "PlayCard", playerIndex: casterIndex, card, ...event } as never,
    ),
  );
}

/**
 * Everything HELD or already on the chain, by the defId of whatever placed it.
 *
 * The instrument that separates "the ability resolved to nothing" from "the
 * ability was never placed" — the difference an `applies` filter makes and the
 * one a resolver guard alone cannot show. Read BEFORE `resolveHeldTriggers`
 * drains the pen.
 */
const heldDefIds = (state: GameState): string[] => [
  ...state.pendingTriggers.map((e) => e.listenerDefId),
  ...state.spellChain.map((e) => ("listenerDefId" in e ? e.listenerDefId : e.card.defId)),
];

/** Non-combat effective Might at a named battlefield — the context every Might
 *  threshold in this pool is measured in. */
const mightAt = (state: GameState, unit: UnitInstance, ownerIndex: 0 | 1, battlefieldId?: string): number =>
  effectiveMight(state, unit, ownerIndex, battlefieldId === undefined ? { isCombat: false } : { isCombat: false, battlefieldId });

describe("Dragon Form (VEN-116): its base Might BECOMES 5 this turn", () => {
  function board(printedMight: number): { state: GameState; target: UnitInstance } {
    const target = makeUnit({ instanceId: "target", might: printedMight });
    const state = makeState();
    state.players[0]!.baseUnits = [target];
    return { state, target };
  }

  it("raises a small unit to 5", () => {
    const { state, target } = board(1);
    const after = castSpell(state, DRAGON_FORM, 0, { targetUnitInstanceId: target.instanceId });
    expect(mightAt(after, onBoard(after, target.instanceId)!, 0)).toBe(5);
  });

  it("...and LOWERS a big one to 5 — it is an assignment, not a pump", () => {
    // The half a delta implementation gets wrong, and the reason this card is
    // removal as often as a buff. 477.1.a.1 quotes this sentence as its worked
    // example of the Trait-Altering layer.
    const { state, target } = board(9);
    const after = castSpell(state, DRAGON_FORM, 0, { targetUnitInstanceId: target.instanceId });
    expect(mightAt(after, onBoard(after, target.instanceId)!, 0), "it added instead of assigning").toBe(5);
  });

  it("everything else still ADDS on top of the 5 — 477.3 is a later layer", () => {
    // A buff (+1, rule 703) and a this-turn pump both survive the assignment,
    // because arithmetic is layer 3 and assignment is layer 1. An implementation
    // that overwrote the total rather than the BASE would read 5 here.
    const { state, target } = board(9);
    state.players[0]!.baseUnits = [{ ...target, buffed: true, mightThisTurn: 2 }];

    const after = castSpell(state, DRAGON_FORM, 0, { targetUnitInstanceId: target.instanceId });

    expect(mightAt(after, onBoard(after, target.instanceId)!, 0), "the later layers were swallowed").toBe(8);
  });

  it("reaches an ENEMY unit — no owner is printed", () => {
    const victim = makeUnit({ instanceId: "victim", might: 9 });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [victim] };

    const after = castSpell(state, DRAGON_FORM, 0, { targetUnitInstanceId: victim.instanceId });

    expect(mightAt(after, onBoard(after, victim.instanceId)!, 1, "bf1")).toBe(5);
  });

  it("expires at end of turn — DELETED, not zeroed", () => {
    // Zeroing would leave every unit the spell ever touched permanently at 0 base
    // Might, which is why the sweep removes the key. Asserted through the Might a
    // 9-Might unit reads afterwards rather than through the field itself.
    const { state, target } = board(9);
    const cast = castSpell(state, DRAGON_FORM, 0, { targetUnitInstanceId: target.instanceId });
    expect(mightAt(cast, onBoard(cast, target.instanceId)!, 0), "positive control failed").toBe(5);

    const ended = runEndOfTurn(cast);

    expect(mightAt(ended, onBoard(ended, target.instanceId)!, 0), "the assignment survived the turn").toBe(9);
  });
});

/** Runs the Ending Phase, which is what expires a this-turn effect. Driven
 *  through the real phase machinery rather than by clearing the field, so a
 *  sweep that forgot the field fails here. */
const runEndOfTurn = (state: GameState): GameState => runEnd({ ...state, phase: "Action" });

describe("Disciple of Shen (VEN-117): [Shield 3] with EXACTLY one other ally here", () => {
  function board(alliesHere: number, inBase = false): { state: GameState; disciple: UnitInstance } {
    const disciple = realUnitInstance(DISCIPLE_OF_SHEN);
    const allies = Array.from({ length: alliesHere }, (_, i) => makeUnit({ instanceId: `ally${i}` }));
    const state = makeState();
    if (inBase) state.players[0]!.baseUnits = [disciple, ...allies];
    else state.battlefields[0]!.units = { p1: [disciple, ...allies] };
    return { state, disciple };
  }

  const shieldOf = (state: GameState, unit: UnitInstance) => effectiveKeywords(state, unit, 0).Shield ?? 0;

  it("has [Shield 3] with exactly one other unit you control here", () => {
    const { state, disciple } = board(1);
    expect(shieldOf(state, onBoard(state, disciple.instanceId)!)).toBe(3);
  });

  it("has NOTHING alone, and nothing with two allies", () => {
    // Both sides of "exactly". The two-ally case is the one a naive `>= 1` would
    // pass, and it is the whole point of the Order motif.
    //
    // Each board is bound ONCE: `realUnitInstance` mints a fresh instanceId per
    // call, so re-calling the factory inside the assertion measures a unit that is
    // not on the board it is being read from.
    const alone = board(0);
    expect(shieldOf(alone.state, onBoard(alone.state, alone.disciple.instanceId)!)).toBe(0);

    const two = board(2);
    expect(shieldOf(two.state, onBoard(two.state, two.disciple.instanceId)!), "two allies still shielded him").toBe(0);
  });

  it("has nothing in BASE, however many friends stand there", () => {
    // "At a battlefield" is printed. `otherOwnUnitsHere` answers `undefined` in
    // base rather than 0, so a caller cannot satisfy the clause at home by
    // accident.
    const { state, disciple } = board(1, true);
    expect(shieldOf(state, onBoard(state, disciple.instanceId)!)).toBe(0);
  });

  /** The card as a UNIT. `CardDefinition` is a union and only some arms carry
   *  `keywords`/`might`, so a bare property read type-checks nowhere — and the
   *  BUILD tsconfig excludes tests, so it only surfaces at step 3 of the loop. */
  const unitDef = (id: string) => {
    const def = registry.get(id);
    expect(def.type, `${id} is not a Unit`).toBe("Unit");
    return def as Extract<typeof def, { type: "Unit" }>;
  };

  it("the printed [Shield 3] is STRIPPED at load — otherwise he has it always", () => {
    // The failure this guards: `KW_PATTERN` sees brackets and not sentences, so a
    // keyword printed inside a condition parses as a flat one. Left in, a 1-Might
    // unit is a permanent 4-Might defender — stronger than printed, which is the
    // direction that ships looking finished.
    expect(unitDef(DISCIPLE_OF_SHEN).keywords?.Shield, "the flat keyword is still on the card").toBeUndefined();
    expect(unitDef(DISCIPLE_OF_SHEN).keywords?.Hidden, "his REAL printed keyword was stripped too").toBeDefined();
  });

  it("counts ALLIES, not enemies — an enemy beside him is not his other unit", () => {
    const { state, disciple } = board(0);
    state.battlefields[0]!.units = { ...state.battlefields[0]!.units, p2: [makeUnit({ instanceId: "enemy" })] };
    expect(shieldOf(state, onBoard(state, disciple.instanceId)!)).toBe(0);
  });
});

describe("Keeper of Law (VEN-119): 2 Energy and 1 Order less at a two-unit battlefield", () => {
  function board(unitsAtControlled: number, controlled = true): GameState {
    const state = makeState();
    state.battlefields[0]!.controllerId = controlled ? "p1" : "p2";
    // Split across both players deliberately: "two UNITS" names no owner.
    const mine = Array.from({ length: Math.ceil(unitsAtControlled / 2) }, (_, i) => makeUnit({ instanceId: `m${i}` }));
    const theirs = Array.from({ length: Math.floor(unitsAtControlled / 2) }, (_, i) => makeUnit({ instanceId: `t${i}` }));
    state.battlefields[0]!.units = { p1: mine, p2: theirs };
    return state;
  }

  const energy = (state: GameState) => modifiedEnergyCost(state, 0, "Unit", 5, KEEPER_OF_LAW);
  const power = (state: GameState) => scaledPowerDiscount(state, 0, KEEPER_OF_LAW);

  it("discounts BOTH axes when the condition holds", () => {
    const state = board(2);
    expect(energy(state), "the Energy half did not apply").toBe(3);
    expect(power(state), "the Power half did not apply").toBe(1);
  });

  it("neither axis at ONE unit or at THREE", () => {
    // The boundary, both sides. A card priced on one reading of a condition and
    // deployed on another is exactly what Monch's shared predicate exists to stop,
    // so both halves are asserted at each end.
    for (const count of [1, 3]) {
      const state = board(count);
      expect(energy(state), `${count} units discounted the Energy`).toBe(5);
      expect(power(state), `${count} units discounted the Power`).toBe(0);
    }
  });

  it("...and neither at a battlefield you do NOT control", () => {
    // "A battlefield YOU CONTROL" is the narrowing half. Standing at one is not
    // controlling it — the distinction Vayne - Hunter's enter-ready draws.
    const state = board(2, false);
    expect(energy(state)).toBe(5);
    expect(power(state)).toBe(0);
  });

  it("counts BOTH players' units at that battlefield", () => {
    // "Two units", bare, so 355.9.a.1's widening applies. One of yours and one of
    // theirs is the commonest way it is satisfied, and a friendly-only count would
    // silently never fire on a contested board.
    const state = makeState();
    state.battlefields[0]!.controllerId = "p1";
    state.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "mine" })], p2: [makeUnit({ instanceId: "theirs" })] };
    expect(energy(state), "it counted only friendly units").toBe(3);
  });

  it("NEGATIVE CONTROL: another card gets neither discount on the same board", () => {
    const state = board(2);
    expect(modifiedEnergyCost(state, 0, "Unit", 5, "OGN-001")).toBe(5);
    expect(scaledPowerDiscount(state, 0, "OGN-001")).toBe(0);
  });
});

describe("Masa, Crashing Thunder (VEN-120): stun only if you paid", () => {
  function board(): { state: GameState; enemy: UnitInstance } {
    const enemy = makeUnit({ instanceId: "enemy" });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [enemy] };
    return { state, enemy };
  }

  it("stuns when the optional Power was paid", () => {
    const { state, enemy } = board();
    const after = playUnitTrigger(state, realUnitInstance(MASA), 0, "base", {
      targetUnitInstanceId: enemy.instanceId,
      optionalPowerPaid: true,
    });
    expect(onBoard(after, enemy.instanceId)?.stunned).toBe(true);
  });

  it("does nothing when it was declined", () => {
    const { state, enemy } = board();
    const after = playUnitTrigger(state, realUnitInstance(MASA), 0, "base", {
      targetUnitInstanceId: enemy.instanceId,
    });
    expect(onBoard(after, enemy.instanceId)?.stunned, "he stunned without paying").toBe(false);
  });
});

describe("Reluctant Leader (VEN-121): +2 Might when you play ANOTHER unit", () => {
  function board(): { state: GameState; leader: UnitInstance } {
    const leader = realUnitInstance(RELUCTANT_LEADER);
    const state = makeState();
    state.players[0]!.baseUnits = [leader];
    return { state, leader };
  }

  /** Fires a `cardPlayed` and settles it. `isToken` is REQUIRED on the event —
   *  deliberately, per its own note — so it is defaulted here rather than cast
   *  away: a producer that could omit it is exactly how a listener silently stops
   *  seeing token plays. */
  const played = (state: GameState, event: Partial<CardPlayedEvent> & { playedInstanceId: string }): GameState =>
    resolveHeldTriggers(
      holdEventTrigger(state, {
        kind: "cardPlayed",
        casterIndex: 0,
        playedKind: "Unit",
        playedPowerCost: 0,
        isToken: false,
        ...event,
      }),
    );

  it("pumps on another unit's arrival", () => {
    const { state, leader } = board();
    const after = played(state, { casterIndex: 0, playedKind: "Unit", playedInstanceId: "someone-else" });
    expect(onBoard(after, leader.instanceId)?.mightThisTurn).toBe(2);
  });

  it("...and STACKS, because each play is its own instruction", () => {
    const { state, leader } = board();
    const once = played(state, { casterIndex: 0, playedKind: "Unit", playedInstanceId: "a" });
    const twice = played(once, { casterIndex: 0, playedKind: "Unit", playedInstanceId: "b" });
    expect(onBoard(twice, leader.instanceId)?.mightThisTurn).toBe(4);
  });

  it("never pumps on HIS OWN arrival — 'another'", () => {
    const { state, leader } = board();
    const after = played(state, { casterIndex: 0, playedKind: "Unit", playedInstanceId: leader.instanceId });
    expect(onBoard(after, leader.instanceId)?.mightThisTurn, "he pumped himself").toBe(0);
  });

  it("...and his own arrival does not even PLACE the trigger", () => {
    // **A stronger claim than "pumped nothing", and the line exists because the
    // weaker one let a mutant through.** Loosening `applies` alone SURVIVED the
    // test above: `resolve` re-checks and returns the state unchanged, so the
    // Might reads 0 — while the Pending Item is still placed and still costs both
    // players a PassFocus for an ability that resolves to nothing. Jhin -
    // Murderous Artist's and Blade Twirler's tests record the identical finding.
    const { state, leader } = board();
    const held = holdEventTrigger(state, {
      kind: "cardPlayed",
      casterIndex: 0,
      playedKind: "Unit",
      playedInstanceId: leader.instanceId,
      playedPowerCost: 0,
      isToken: false,
    });

    expect(heldDefIds(held), "his ability was placed for his own arrival").not.toContain(RELUCTANT_LEADER);
    // POSITIVE CONTROL on the same instrument: somebody ELSE's arrival does place it.
    expect(
      heldDefIds(
        holdEventTrigger(state, {
          kind: "cardPlayed",
          casterIndex: 0,
          playedKind: "Unit",
          playedInstanceId: "somebody-else",
          playedPowerCost: 0,
          isToken: false,
        }),
      ),
    ).toContain(RELUCTANT_LEADER);
  });

  it("does not pump on a SPELL", () => {
    const { state, leader } = board();
    const after = played(state, { casterIndex: 0, playedKind: "Spell", playedInstanceId: "a-spell" });
    expect(onBoard(after, leader.instanceId)?.mightThisTurn).toBe(0);
  });

  it("...and the RESOLVER refuses a spell too, not only `applies`", () => {
    // The second route into a resolver: the inline `dispatchEvent` path does not
    // consult `applies` at all, so a condition asserted only there is asserted
    // only on one of the two ways in. Measured — a mutant that dropped the kind
    // check from `resolve` alone survived every other test in this block.
    const { state, leader } = board();
    const definition = eventTriggerFor(RELUCTANT_LEADER);
    expect(definition, "he is not registered as an event trigger").toBeDefined();

    const listener = { card: onBoard(state, leader.instanceId)!, ownerIndex: 0 as const, zone: "board" as const };
    const after = definition!.resolve(state, listener, {
      kind: "cardPlayed",
      casterIndex: 0,
      playedKind: "Spell",
      playedInstanceId: "a-spell",
      playedPowerCost: 0,
      isToken: false,
    });

    expect(onBoard(after, leader.instanceId)?.mightThisTurn, "the resolver pumped for a spell").toBe(0);
  });

  it("...but a TOKEN unit DOES pump him — 185 makes it not a card, not a non-unit", () => {
    // The distinction the event's own note draws, and the reason `isToken` is
    // deliberately unfiltered here: this clause says "another UNIT", not "a card".
    const { state, leader } = board();
    const after = played(state, { casterIndex: 0, playedKind: "Unit", playedInstanceId: "tok", isToken: true });
    expect(onBoard(after, leader.instanceId)?.mightThisTurn, "a token unit did not count").toBe(2);
  });

  it("does not pump on the OPPONENT's unit", () => {
    const { state, leader } = board();
    const after = played(state, { casterIndex: 1, playedKind: "Unit", playedInstanceId: "theirs" });
    expect(onBoard(after, leader.instanceId)?.mightThisTurn).toBe(0);
  });
});

describe("Hungry Wolf (VEN-125): ready me and +1, once, if you've chosen an enemy", () => {
  function board(choices: number): { state: GameState; wolf: UnitInstance } {
    const wolf = { ...realUnitInstance(HUNGRY_WOLF), exhausted: true };
    const state = makeState();
    state.battlefields[0]!.units = { p1: [wolf] };
    state.battlefields[0]!.controllerId = "p1";
    state.players[0]!.channeled = runes(3);
    state.players[0]!.enemyChoicesThisTurn = choices;
    return { state, wolf };
  }

  /** His activations, by the field the action actually carries. Named once
   *  because getting it wrong reads as "the ability is not offered" — which is
   *  exactly what a broken `availableWhile` would look like. */
  const wolfActivations = (state: GameState, wolf: UnitInstance) =>
    legalActions(state).filter((a) => a.type === "ActivateAbility" && a.permanentInstanceId === wolf.instanceId);

  it("is not offered at all until you have chosen an enemy unit", () => {
    const { state, wolf } = board(0);
    expect(wolfActivations(state, wolf), "he was offered with no enemy chosen this turn").toEqual([]);
  });

  it("...and IS offered once you have — the positive control on the same board", () => {
    const { state, wolf } = board(1);
    expect(wolfActivations(state, wolf).length, "the condition is satisfied and he is still not offered").toBeGreaterThan(0);
  });

  it("readies himself AND pumps, with no exhaust to undo it", () => {
    const { state, wolf } = board(1);
    const activate = wolfActivations(state, wolf)[0];
    const { state: after, result } = submit(state, activate!);
    expect(result).toMatchObject({ type: "Ok" });

    const landed = onBoard(after, wolf.instanceId)!;
    expect(landed.exhausted, "he did not ready — or an exhaust cost undid it").toBe(false);
    expect(landed.mightThisTurn).toBe(1);
  });

  it("only ONCE each turn", () => {
    const { state, wolf } = board(1);
    const { state: after } = submit(state, wolfActivations(state, wolf)[0]!);

    expect(wolfActivations(after, wolf), "he was offered a second activation in one turn").toEqual([]);
  });

  it("...and the Power really is spent", () => {
    const { state, wolf } = board(1);
    const { state: after } = submit(state, wolfActivations(state, wolf)[0]!);
    expect(after.players[0]!.channeled.length, "the Order pip was never recycled").toBe(2);
  });
});

describe("Ki Barrier (VEN-126): prevent the NEXT 7 damage, as a pool", () => {
  function board(might = 20): { state: GameState; unit: UnitInstance } {
    const unit = makeUnit({ instanceId: "warded", might });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [unit] };
    return { state, unit };
  }

  const barriered = (state: GameState, id: string): GameState =>
    castSpell(state, KI_BARRIER, 0, { targetUnitInstanceId: id });

  it("absorbs a hit smaller than the pool entirely", () => {
    const { state, unit } = board();
    const after = dealDamage(barriered(state, unit.instanceId), 1, unit.instanceId, 4);
    expect(onBoard(after, unit.instanceId)?.damage).toBe(0);
  });

  it("...and keeps absorbing ACROSS instances until it is spent", () => {
    // The half a single-use shield gets wrong. 4 + 3 is exactly 7, so the second
    // hit is still fully absorbed and the third gets through in full.
    const { state, unit } = board();
    let s = barriered(state, unit.instanceId);
    s = dealDamage(s, 1, unit.instanceId, 4);
    s = dealDamage(s, 1, unit.instanceId, 3);
    expect(onBoard(s, unit.instanceId)?.damage, "the pool did not cover 4 + 3").toBe(0);

    s = dealDamage(s, 1, unit.instanceId, 2);
    expect(onBoard(s, unit.instanceId)?.damage, "the pool absorbed more than 7").toBe(2);
  });

  it("lets the REMAINDER through on a hit bigger than the pool", () => {
    // The card's own reminder text: "opponents can assign it extra combat damage
    // to kill it." A shield that stopped the whole instance would read 0 here.
    const { state, unit } = board();
    const after = dealDamage(barriered(state, unit.instanceId), 1, unit.instanceId, 9);
    expect(onBoard(after, unit.instanceId)?.damage).toBe(2);
  });

  it("a FULLY absorbed hit is damage not dealt — a death sentence does not fire", () => {
    // Noxian Guillotine's marker is "kill it the NEXT time it takes damage". With
    // the barrier eating the instance whole, no damage was dealt, so the marker
    // must not execute — otherwise a 7-point barrier turns the sentence into the
    // execution it was bought to stop.
    const { state, unit } = board();
    const armed: GameState = { ...barriered(state, unit.instanceId), markedForDeathOnDamageInstanceIds: [unit.instanceId] };

    const after = dealDamage(armed, 1, unit.instanceId, 3);

    expect(onBoard(after, unit.instanceId), "the absorbed hit still executed the sentence").toBeDefined();
  });

  it("...and a PARTIALLY absorbed one still does", () => {
    // The same rule from the other side, so the guard above cannot be read as
    // "the sentence never fires".
    const { state, unit } = board();
    const armed: GameState = { ...barriered(state, unit.instanceId), markedForDeathOnDamageInstanceIds: [unit.instanceId] };

    const after = dealDamage(armed, 1, unit.instanceId, 9);

    expect(onBoard(after, unit.instanceId), "damage got through and the sentence did not fire").toBeUndefined();
  });

  it("saves a unit from lethal it would otherwise take", () => {
    const { state, unit } = board(5);
    const after = dealDamage(barriered(state, unit.instanceId), 1, unit.instanceId, 5);
    expect(onBoard(after, unit.instanceId), "the barrier did not stop a lethal hit").toBeDefined();
  });

  it("is spent even when the hit KILLS — no refund", () => {
    const { state, unit } = board(3);
    const armed = barriered(state, unit.instanceId);
    const after = dealDamage(armed, 1, unit.instanceId, 10);
    expect(onBoard(after, unit.instanceId), "3 Might survived 10 - 7").toBeUndefined();
    expect(
      after.damagePreventionPoolByInstanceId[unit.instanceId],
      "the barrier was refunded when the unit died",
    ).toBeUndefined();
  });

  it("does not protect a DIFFERENT unit", () => {
    const { state, unit } = board();
    const other = makeUnit({ instanceId: "other", might: 20 });
    state.battlefields[0]!.units = { p1: [unit, other] };

    const after = dealDamage(barriered(state, unit.instanceId), 1, other.instanceId, 4);

    expect(onBoard(after, other.instanceId)?.damage).toBe(4);
  });
});

describe("Lacerate (VEN-127): disempower, THEN kill it if it has 3 Might or less", () => {
  it("kills a small unit outright", () => {
    const target = makeUnit({ instanceId: "target", might: 3 });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [target] };

    const after = castSpell(state, LACERATE, 0, { targetUnitInstanceId: target.instanceId });

    expect(onBoard(after, target.instanceId)).toBeUndefined();
  });

  it("spares a unit above the ceiling", () => {
    const target = makeUnit({ instanceId: "target", might: 4 });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [target] };

    const after = castSpell(state, LACERATE, 0, { targetUnitInstanceId: target.instanceId });

    expect(onBoard(after, target.instanceId), "4 Might was killed by a '3 or less' clause").toBeDefined();
  });

  it("reads EFFECTIVE Might — a this-turn pump lifts a unit out of range", () => {
    const target = makeUnit({ instanceId: "target", might: 3, mightThisTurn: 1 });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [target] };

    const after = castSpell(state, LACERATE, 0, { targetUnitInstanceId: target.instanceId });

    expect(onBoard(after, target.instanceId), "it read printed Might").toBeDefined();
  });

  it("DISEMPOWERS first, and the Might is re-read after — the ORDER is the card", () => {
    // The sequencing that makes it answer the units it is printed against. The
    // fixture is a unit that is 5 Might while Empowered and 3 without it: reading
    // Might BEFORE the strip spares it, reading it after kills it.
    //
    // **The Empowered bonus is applied through `empoweredMightBonus`, which reads
    // the card's own `empoweredGrant`** — so a hand-built instance cannot fake it.
    // A real card is used instead, and the fixture asserts its numbers up front so
    // a data change fails HERE rather than quietly making the test vacuous.
    const raw = registry.get(EMPOWERED_FIXTURE);
    expect(raw.type).toBe("Unit");
    // Narrowed off the `CardDefinition` union: only some arms carry `might` and
    // `empoweredGrant`, and the BUILD tsconfig excludes tests — so a bare read
    // compiles here and fails at step 3 of the verification loop.
    const printed = raw as Extract<typeof raw, { type: "Unit" }>;
    expect(printed.might, "the fixture card's printed Might moved").toBe(EMPOWERED_FIXTURE_MIGHT);
    expect(
      printed.empoweredGrant?.might,
      "the fixture card's Empowered Might grant moved — pick another fixture",
    ).toBe(EMPOWERED_FIXTURE_GRANT);
    expect(
      EMPOWERED_FIXTURE_MIGHT + EMPOWERED_FIXTURE_GRANT,
      "the fixture is no longer out of range while Empowered — the test would be vacuous",
    ).toBeGreaterThan(3);
    expect(EMPOWERED_FIXTURE_MIGHT, "the fixture is no longer in range once stripped").toBeLessThanOrEqual(3);

    const target = realUnitInstance(EMPOWERED_FIXTURE);
    const board = makeState();
    board.battlefields[0]!.units = { p2: [target] };
    const state = empowerPermanent(board, target.instanceId);
    expect(mightAt(state, onBoard(state, target.instanceId)!, 1, "bf1"), "the grant is not applying at all").toBe(
      EMPOWERED_FIXTURE_MIGHT + EMPOWERED_FIXTURE_GRANT,
    );

    const after = castSpell(state, LACERATE, 0, { targetUnitInstanceId: target.instanceId });

    expect(
      onBoard(after, target.instanceId),
      "it survived — the Might was read before the disempower, or the strip never happened",
    ).toBeUndefined();
  });

  it("NEGATIVE CONTROL: the same unit UNEMPOWERED is in range anyway", () => {
    // Proves the test above is about the ORDER rather than about the card being
    // small: without the grant it dies for the ordinary reason.
    const target = realUnitInstance(EMPOWERED_FIXTURE);
    const state = makeState();
    state.battlefields[0]!.units = { p2: [target] };

    const after = castSpell(state, LACERATE, 0, { targetUnitInstanceId: target.instanceId });

    expect(onBoard(after, target.instanceId)).toBeUndefined();
  });

  it("disempowers even when the kill does NOT land", () => {
    // Two instructions, and only the second is conditional. A resolver that
    // returned early on the Might check would leave the unit Empowered.
    const target = makeUnit({ instanceId: "target", might: 9, empowered: true });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [target] };

    const after = castSpell(state, LACERATE, 0, { targetUnitInstanceId: target.instanceId });

    expect(onBoard(after, target.instanceId)?.empowered, "a surviving unit kept its Empowered status").toBeUndefined();
  });
});

describe("Sacred Protector (VEN-129): deals no combat damage unless exactly one ally is here", () => {
  /**
   * **Read through DEATHS, never through marked damage.** Rule 466 step 3c heals
   * every unit at the end of combat, so `damage` after `resolveShowdown` is
   * always 0 and an assertion on it measures nothing — the fixture trap this
   * project has recorded and which the first draft of this block walked into.
   *
   * The blocker is 7 Might, which is exactly her 6 plus one 1-Might ally: it dies
   * only when she is actually contributing, and survives both the alone case (0
   * damage) and the two-ally case (2, from the allies alone).
   */
  function fight(allies: number): GameState {
    const protector = realUnitInstance(SACRED_PROTECTOR);
    const extra = Array.from({ length: allies }, (_, i) => makeUnit({ instanceId: `ally${i}`, might: 1 }));
    const state = makeState();
    state.battlefields[0]!.units = { p1: [protector, ...extra], p2: [makeUnit({ instanceId: "blocker", might: 7 })] };
    state.battlefields[0]!.contestedByIndex = 0;
    return resolveShowdown(state, "bf1", 0);
  }

  const blockerDied = (state: GameState) => onBoard(state, "blocker") === undefined;

  it("deals its Might with exactly one ally beside it", () => {
    expect(blockerDied(fight(1)), "6 + 1 did not kill a 7-Might blocker").toBe(true);
  });

  it("deals NOTHING alone", () => {
    expect(blockerDied(fight(0)), "she hit without her formation").toBe(false);
  });

  it("...and nothing with TWO allies either — 'exactly' cuts both ways", () => {
    // The allies still deal their 2; she still deals 0. The case a `>= 1` reading
    // passes, and the reason the blocker is 7 rather than 3.
    expect(blockerDied(fight(2)), "three-in-a-row still let her hit").toBe(false);
  });

  it("is no easier to KILL for dealing nothing", () => {
    // The split rule 423 draws for Stun and this clause mirrors: `outgoingMight`
    // is zeroed and `remainingMight` is deliberately untouched. She is 6 Might, so
    // a 5-damage pool leaves her alive.
    const protector = realUnitInstance(SACRED_PROTECTOR);
    const state = makeState();
    state.battlefields[0]!.units = { p1: [protector], p2: [makeUnit({ instanceId: "blocker", might: 5 })] };
    state.battlefields[0]!.contestedByIndex = 1;

    const after = resolveShowdown(state, "bf1", 1);

    expect(onBoard(after, protector.instanceId), "she absorbed as if she had 0 Might").toBeDefined();
  });
});

describe("Decree of Unity (VEN-131): kill an ENEMY CHAOS unit or gear", () => {
  /** A real Chaos unit and a real Order one, so the domain filter is measured
   *  against card data rather than against a hand-built instance. */
  const chaosUnit = () => realUnitInstance("VEN-094");
  const orderUnit = () => realUnitInstance(SACRED_PROTECTOR);

  function board(): GameState {
    const state = makeState();
    state.players[0]!.hand = [spellInstance(DECREE_OF_UNITY)];
    state.players[0]!.channeled = runes(6);
    return state;
  }

  const targetsOffered = (state: GameState): string[] =>
    legalActions(state)
      .filter((a) => a.type === "PlayCard" && a.card.defId === DECREE_OF_UNITY)
      .map((a) => (a as { targetPermanentInstanceId?: string }).targetPermanentInstanceId ?? "")
      .filter(Boolean);

  it("offers an enemy Chaos unit", () => {
    const state = board();
    const enemy = chaosUnit();
    state.battlefields[0]!.units = { p2: [enemy] };
    expect(registry.get(enemy.defId).domains, "the fixture card is not Chaos").toContain("Chaos");

    expect(targetsOffered(state)).toContain(enemy.instanceId);
  });

  it("does NOT offer a friendly Chaos unit", () => {
    const state = board();
    const mine = chaosUnit();
    state.battlefields[0]!.units = { p1: [mine] };
    expect(targetsOffered(state), "it offered a friendly target").not.toContain(mine.instanceId);
  });

  it("does NOT offer an enemy unit of another domain", () => {
    const state = board();
    const enemy = orderUnit();
    state.battlefields[0]!.units = { p2: [enemy] };
    expect(targetsOffered(state), "the domain filter is not applied").not.toContain(enemy.instanceId);
  });

  it("the VALIDATOR refuses a target the enumerator never offered", () => {
    // The enumerate/execute split, asserted in the direction probes keep finding:
    // a forged action naming an ineligible permanent must be refused, not
    // silently resolved. Both halves go through one walk, and this is what proves
    // the walk reached the validator too.
    const state = board();
    const mine = chaosUnit();
    const enemy = chaosUnit();
    state.battlefields[0]!.units = { p1: [mine], p2: [enemy] };

    const legal = legalActions(state).find(
      (a) => a.type === "PlayCard" && a.card.defId === DECREE_OF_UNITY,
    );
    expect(legal, "the card was not castable at all — this test measures nothing").toBeDefined();

    const forged = { ...legal!, targetPermanentInstanceId: mine.instanceId };
    const { result } = submit(state, forged);

    expect(result, "a friendly Chaos unit was accepted").not.toMatchObject({ type: "Ok" });
  });

  it("kills the chosen enemy unit", () => {
    const state = board();
    const enemy = chaosUnit();
    state.battlefields[0]!.units = { p2: [enemy] };

    const after = castSpell(state, DECREE_OF_UNITY, 0, { targetPermanentInstanceId: enemy.instanceId });

    expect(onBoard(after, enemy.instanceId)).toBeUndefined();
  });

  it("kills a GEAR through killGear, so its own trigger still fires", () => {
    const state = board();
    const gear = realGearInstance("OGN-017");
    state.players[1]!.activeGear = [gear];

    const after = castSpell(state, DECREE_OF_UNITY, 0, { targetPermanentInstanceId: gear.instanceId });

    expect(after.players[1]!.activeGear).toEqual([]);
  });
});

describe("Kennen, Keeper of Balance (VEN-135): three clauses", () => {
  function board(energy: number): { state: GameState; kennen: UnitInstance; enemy: UnitInstance } {
    const kennen = realUnitInstance(KENNEN);
    const enemy = makeUnit({ instanceId: "enemy" });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [kennen], p2: [enemy] };
    state.players[0]!.floatingEnergy = energy;
    return { state, kennen, enemy };
  }

  it("offers the stun ON PLAY, and paying it stuns", () => {
    const { state, enemy } = board(2);
    const held = playUnitTrigger(state, realUnitInstance(KENNEN), 0, "base", {});
    const after = answerDecisions(held, (options) => {
      const pick = options.find((o) => o.instanceId === enemy.instanceId);
      expect(pick, "the enemy was not among the stun targets").toBeDefined();
      return pick!.id;
    });

    expect(onBoard(after, enemy.instanceId)?.stunned).toBe(true);
    expect(after.players[0]!.floatingEnergy, "the 2 Energy was never spent").toBe(0);
  });

  it("...and ON ATTACK, from the same question", () => {
    const { state, enemy } = board(2);
    const held = beginCombatAt(state, "bf1", 0);
    expect(held.pendingDecisions.map((d) => d.kind), "the attack half parked nothing").toContain("VEN-135-stun");

    const after = answerDecisions(held, (options) => options.find((o) => o.instanceId === enemy.instanceId)!.id);
    expect(onBoard(after, enemy.instanceId)?.stunned).toBe(true);
  });

  it("is not asked at all with the Energy unpayable — 416.3", () => {
    const { state } = board(1);
    expect(beginCombatAt(state, "bf1", 0).pendingDecisions.map((d) => d.kind)).not.toContain("VEN-135-stun");
  });

  it("declining costs nothing", () => {
    const { state, enemy } = board(2);
    const after = answerDecisions(beginCombatAt(state, "bf1", 0), (options) => options[0]!.id);
    expect(onBoard(after, enemy.instanceId)?.stunned).toBe(false);
    expect(after.players[0]!.floatingEnergy, "declining still charged him").toBe(2);
  });

  it("has +2 Might while a stunned ENEMY is here, and loses it when the stun ends", () => {
    const { state, kennen, enemy } = board(0);
    const base = mightAt(state, onBoard(state, kennen.instanceId)!, 0, "bf1");

    const stunned: GameState = {
      ...state,
      battlefields: state.battlefields.map((bf) =>
        bf.id === "bf1" ? { ...bf, units: { ...bf.units, p2: [{ ...enemy, stunned: true }] } } : bf,
      ),
    };

    expect(mightAt(stunned, onBoard(stunned, kennen.instanceId)!, 0, "bf1")).toBe(base + 2);
  });

  it("...but NOT for a stunned FRIENDLY unit", () => {
    const { state, kennen } = board(0);
    const withAlly: GameState = {
      ...state,
      battlefields: state.battlefields.map((bf) =>
        bf.id === "bf1"
          ? { ...bf, units: { ...bf.units, p1: [onBoard(state, kennen.instanceId)!, makeUnit({ instanceId: "ally", stunned: true })] } }
          : bf,
      ),
    };
    const base = mightAt(state, onBoard(state, kennen.instanceId)!, 0, "bf1");

    expect(mightAt(withAlly, onBoard(withAlly, kennen.instanceId)!, 0, "bf1"), "his own stunned unit paid him").toBe(base);
  });

  it("...and NOT while he is in BASE, where there is no 'here' at all", () => {
    // "HERE" is positional, so a Kennen at home takes nothing however many
    // stunned enemies stand on the board.
    //
    // **This test is what deleted a guard rather than what pins one.** The
    // resolver carried an explicit `ctx.battlefieldId === undefined` check; a
    // mutant removing it SURVIVED, and the diagnosis was that the check is
    // unreachable — a context with no battlefield makes the battlefield lookup
    // return `undefined` and the `?? []` already answers 0. The guard went, and
    // this assertion stayed, because the BEHAVIOUR is the card's and is worth
    // holding whichever line implements it.
    const { state, kennen, enemy } = board(0);
    const inBase: GameState = {
      ...state,
      players: [
        { ...state.players[0]!, baseUnits: [onBoard(state, kennen.instanceId)!] },
        state.players[1]!,
      ] as GameState["players"],
      battlefields: state.battlefields.map((bf) =>
        bf.id === "bf1" ? { ...bf, units: { p2: [{ ...enemy, stunned: true }] } } : bf,
      ),
    };

    const landed = inBase.players[0]!.baseUnits[0]!;
    const printedKennen = registry.get(KENNEN);
    expect(printedKennen.type).toBe("Unit");
    expect(mightAt(inBase, landed, 0), "he took the bonus with no battlefield to take it at").toBe(
      (printedKennen as Extract<typeof printedKennen, { type: "Unit" }>).might,
    );
  });

  it("...and NOT for a stunned enemy at ANOTHER battlefield — 'here'", () => {
    const { state, kennen } = board(0);
    const elsewhere: GameState = {
      ...state,
      battlefields: state.battlefields.map((bf) =>
        bf.id === "bf2" ? { ...bf, units: { p2: [makeUnit({ instanceId: "far", stunned: true })] } } : bf,
      ),
    };
    const base = mightAt(state, onBoard(state, kennen.instanceId)!, 0, "bf1");

    expect(mightAt(elsewhere, onBoard(elsewhere, kennen.instanceId)!, 0, "bf1")).toBe(base);
  });
});

describe("Shen, Leader of the Kinkou Order (VEN-138): score on hold with exactly one ally", () => {
  function board(allies: number): { state: GameState; shen: UnitInstance } {
    const shen = realUnitInstance(SHEN);
    const extra = Array.from({ length: allies }, (_, i) => makeUnit({ instanceId: `ally${i}` }));
    const state = makeState();
    state.battlefields[0]!.units = { p1: [shen, ...extra] };
    state.battlefields[0]!.controllerId = "p1";
    return { state, shen };
  }

  const held = (state: GameState, holderIndex: 0 | 1 = 0, battlefieldId = "bf1"): GameState =>
    resolveHeldTriggers(runCleanup(holdEventTrigger(state, { kind: "battlefieldHeld", holderIndex, battlefieldId })));

  it("scores 1 with exactly one other unit you control here", () => {
    const { state } = board(1);
    expect(held(state).players[0]!.points).toBe(1);
  });

  it("scores nothing alone, and nothing with two allies", () => {
    expect(held(board(0).state).players[0]!.points, "he scored alone").toBe(0);
    expect(held(board(2).state).players[0]!.points, "three-in-a-row still scored").toBe(0);
  });

  it("re-reads the count at RESOLUTION — an ally arriving in the window turns it off", () => {
    // **The re-read is not decoration, and this is the only test that can see
    // it.** `applies` settles whether the trigger is placed; the count is a
    // condition on the INSTRUCTION, and 359.3.f.2 checks a referent on execution.
    // A mutant that loosened the resolver's check alone survived every other test
    // in this block, because `applies` had already refused the board.
    //
    // Driven by holding the trigger on a legal board, then adding a second ally
    // before the chain settles — which is exactly what a response window is for.
    const { state } = board(1);
    const heldOnChain = runCleanup(holdEventTrigger(state, { kind: "battlefieldHeld", holderIndex: 0, battlefieldId: "bf1" }));
    expect(heldDefIds(heldOnChain), "the trigger was never placed — this test measures nothing").toContain(SHEN);

    const crowded: GameState = {
      ...heldOnChain,
      battlefields: heldOnChain.battlefields.map((bf) =>
        bf.id === "bf1"
          ? { ...bf, units: { ...bf.units, p1: [...(bf.units.p1 ?? []), makeUnit({ instanceId: "latecomer" })] } }
          : bf,
      ),
    };

    expect(resolveHeldTriggers(crowded).players[0]!.points, "it scored off a count taken when it triggered").toBe(0);
  });

  it("scores nothing when the OPPONENT holds", () => {
    const { state } = board(1);
    const after = held(state, 1);
    expect(after.players[0]!.points).toBe(0);
    expect(after.players[1]!.points).toBe(0);
  });

  it("scores nothing for a hold at ANOTHER battlefield", () => {
    const { state } = board(1);
    expect(held(state, 0, "bf2").players[0]!.points).toBe(0);
  });
});

describe("coverage sees every card in this wave", () => {
  it("all twelve report implemented", () => {
    for (const id of [
      DRAGON_FORM,
      DISCIPLE_OF_SHEN,
      KEEPER_OF_LAW,
      MASA,
      RELUCTANT_LEADER,
      HUNGRY_WOLF,
      KI_BARRIER,
      LACERATE,
      SACRED_PROTECTOR,
      DECREE_OF_UNITY,
      KENNEN,
      SHEN,
    ]) {
      expect(isCardImplemented(registry.get(id)), `${id} ${registry.get(id).name} still reports unimplemented`).toBe(true);
    }
  });

  it("Fallen Feline (VEN-132) was the wave's one refusal, and it was ANSWERED", () => {
    // **The pin that stood here asserted `false`, and it fired the day she was
    // written — which is what an invertible pin is for.** It recorded a refusal:
    // "when you play me, name a spell" would offer 233 options, the AI runs a full
    // `applyAction` + `evaluate` per option, and the probes already took ~340s. The
    // restriction half was never the blocker; that is Lilting Lullaby's shape.
    //
    // The refusal named the trade and refused to guess it, and the owner chose
    // FAITHFUL and asked for the cost to be measured rather than estimated. It
    // was: see docs/vendetta-scope.md for the before/after probe figures. The
    // narrow alternatives the note rejected are still rejected for the same
    // reasons — naming from the opponent's hand or deck reads PRIVATE information
    // (108.7.c), and naming from the trash alone withholds the whole point of the
    // card, which is pre-empting a spell you have not seen.
    //
    // Kept as an assertion rather than deleted, inverted rather than weakened: the
    // premise changed, so the premise is what moved.
    expect(
      isCardImplemented(registry.get("VEN-132")),
      "Fallen Feline reports unimplemented again — she is a whole commit, so this is a regression",
    ).toBe(true);
    // ...and the note is only worth anything if the text still says what it says.
    expect(registry.get("VEN-132").text ?? "").toContain("name a spell");
  });
});
