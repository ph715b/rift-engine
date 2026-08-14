import { describe, expect, it } from "vitest";
import { isCardImplemented, partialImplementationNote, unimplementedKeywordsOn } from "../src/engine/coverage.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { CardInstance, UnitInstance } from "../src/model/card.js";
import type { PlayCardAction, PlayerAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * Unleashed cards owned by src/engine/effects/fury.ts — wave 4.
 *
 * Three of the wave's eight cards were written. The other five were REFUSED, and
 * naming them here is the point: a card written against a mechanism that does not
 * exist reports DONE and does nothing, so the refusals are asserted as wrong
 * answers on purpose at the bottom of this file.
 *
 *  - **UNL-002 Inferna** and **UNL-012 Lord Broadmane** wait on `[Ambush]`, a play
 *    PERMISSION (unit-triggers.ts's PLACEMENT_GRANTS + timing.ts). Broadmane's own
 *    clause was written in wave 2. Both already pinned by waves 2 and 3.
 *  - **UNL-013 Lotus Trap** ("choose a unit; double all damage that would be dealt
 *    to it this turn") needs a per-unit multiplier on `UnitInstance` read at BOTH
 *    damage choke points — `dealDamage` (effect-helpers.ts) and combat's
 *    `applyDamage` (combat.ts). `damage-modifiers.ts` is keyed off the CASTER and
 *    the target's battlefield and has no notion of the target unit at all.
 *  - **UNL-016 Scorchclaw**'s "and enter ready" is `deploy.conditionalEntersReady`;
 *    **UNL-017 Square Up**'s `[Repeat] — Discard 1` is a `RepeatCostSpec` widening.
 *    Both were refused in wave 3, both carry a PARTIALLY_IMPLEMENTED entry, and
 *    unl-fury-wave3.test.ts pins each.
 *
 * Everything below goes through a real funnel — `legalActions` and `submit` — and
 * never a resolver imported by hand, because a card that is registered but
 * unreachable has to fail here rather than pass while being dead in a game.
 */

const registry = defaultCardRegistry();

const SMITE = "UNL-007"; // Spell, 2 Energy 1 Fury — deal 3, and a banish rider that is unwritten
const GRIM_APOTHECARY = "UNL-021"; // Unit, 3 Energy 3 Might — on play, you may bounce a friendly unit
const JHIN = "UNL-022"; // Unit, 4 Energy 4 Might — [Ganking], and [Add] on every move

/** Wave 4's refusals and wave 3's, asserted at the bottom. */
const INFERNA = "UNL-002";
const LOTUS_TRAP = "UNL-013";
const SCORCHCLAW = "UNL-016";
const SQUARE_UP = "UNL-017";

const fury = (id: string): RuneCard => ({ id, domain: "Fury", state: "Ready" });
const runes = (count: number): RuneCard[] => Array.from({ length: count }, (_, i) => fury(`f${i}`));

function accept(state: GameState, action: PlayerAction | undefined): GameState {
  expect(action, "the action was never enumerated").toBeDefined();
  const { state: next, result } = submit(state, action!);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** Passes Focus until the chain and the holding pen are empty — what the two
 *  players do to let a held Chain Pending Item resolve (340). */
function settle(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 24; guard += 1) {
    if (current.spellChain.length === 0 && current.pendingTriggers.length === 0) return current;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) return current;
    current = accept(current, pass);
  }
  throw new Error("settle: the chain never emptied");
}

/** The unit as the BOARD holds it, wherever it stands. */
function unitOnBoard(state: GameState, instanceId: string): UnitInstance | undefined {
  for (const player of state.players) {
    const found =
      player.baseUnits.find((u) => u.instanceId === instanceId) ??
      state.battlefields.flatMap((bf) => bf.units[player.id] ?? []).find((u) => u.instanceId === instanceId);
    if (found) return found;
  }
  return undefined;
}

const castsOf = (state: GameState, defId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === defId);

/** Everything currently ON the chain or waiting to be finalized onto it, by the
 *  defId that raised it — `submit` runs a Cleanup, so a trigger held by an action
 *  is usually already a Chain Item by the time the action returns. */
const chainDefIds = (state: GameState): string[] => [
  ...state.pendingTriggers.map((e) => e.listenerDefId),
  ...state.spellChain.map((e) => ("listenerDefId" in e ? e.listenerDefId : e.card.defId)),
];

const moveTo = (state: GameState, unit: UnitInstance, battlefieldId: string): PlayerAction | undefined =>
  legalActions(state).find(
    (a) =>
      a.type === "MoveUnit" && a.destinationBattlefieldId === battlefieldId && a.unitInstanceIds.includes(unit.instanceId),
  );

// ---------------------------------------------------------------------------

describe("Smite (UNL-007): deal 3 to a unit at a battlefield", () => {
  /**
   * A fat enemy at bf1 with a friendly bystander beside it, and a unit in each
   * BASE — so "at a battlefield" has somewhere to fail to reach.
   *
   * The enemy is printed big enough to survive 3, because a dead target and an
   * untouched one both read as "no damage on the board".
   */
  function board(enemyMight = 9): GameState {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = {
      p1: [makeUnit({ instanceId: "bystander" })],
      p2: [makeUnit({ instanceId: "enemy", might: enemyMight })],
    };
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "myHomebody" })];
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "theirHomebody" })];
    state.players[0]!.hand = [spellInstance(SMITE)];
    state.players[0]!.channeled = runes(8);
    return state;
  }

  function castAt(state: GameState, targetInstanceId: string): GameState {
    const play = castsOf(state, SMITE).find((a) => a.targetUnitInstanceId === targetInstanceId);
    expect(play, `Smite was not castable at ${targetInstanceId}`).toBeDefined();
    return settle(accept(state, play));
  }

  it("marks 3 on a unit at a battlefield, through a REAL cast", () => {
    const state = board();
    expect(unitOnBoard(state, "enemy")!.damage, "the fixture was already damaged").toBe(0);

    const after = castAt(state, "enemy");
    expect(unitOnBoard(after, "enemy")!.damage, "the spell resolved but the damage never landed").toBe(3);
  });

  it("NEGATIVE CONTROL: the unit standing beside the target takes nothing", () => {
    const after = castAt(board(), "enemy");
    expect(unitOnBoard(after, "bystander")!.damage).toBe(0);
  });

  it("'AT A BATTLEFIELD' is load-bearing — neither base is reachable", () => {
    // 355.9.b's narrowing, "it meets all targeting restrictions" — NOT 355.9.a.1,
    // which is the widening a bare "a unit" would take.
    const state = board();
    const targets = castsOf(state, SMITE).map((a) => a.targetUnitInstanceId);

    // POSITIVE CONTROL first: the enumerator DOES offer battlefield units here, so
    // the two absences below are a measurement rather than an empty list.
    expect(targets, "the spell is not castable at all — this test measures nothing").toContain("enemy");
    expect(targets).toContain("bystander");
    expect(targets, "a unit in the caster's base was offered").not.toContain("myHomebody");
    expect(targets, "a unit in the opponent's base was offered").not.toContain("theirHomebody");
  });

  it("'if it would die this turn, banish it instead' — the spell's own kill BANISHES", () => {
    // **This was a PIN asserting the wrong answer on purpose, and it flipped on
    // the day the rider landed** — which is what it was for. Its scoping was
    // exactly right: "a model field, a `killUnit` branch and a sweep", and that is
    // `GameState.banishOnDeathUnitInstanceIds`, a branch below the death ward, and
    // a `runEnd` clear.
    //
    // Kept and inverted rather than deleted, because it drives the SPELL through
    // `castAt` — the turn-scoped half and the ordering against the ward are
    // covered in `test/smite-banish-replacement.test.ts`, but neither of those
    // proves the cast path arms anything.
    //
    // It matters rather than being cosmetic: 808.1.d.1 makes a replaced death not
    // a death, so a banished unit fires no [Deathknell] and reaches no
    // trash-recursion.
    const after = castAt(board(3), "enemy");

    expect(unitOnBoard(after, "enemy"), "the 3 was not lethal — this test is measuring nothing").toBeUndefined();
    expect(after.players[1]!.trash.map((c) => c.instanceId), "it reached the trash — the rider did not fire").not.toContain(
      "enemy",
    );
    expect(after.players[1]!.banished.map((c) => c.instanceId), "it was not banished").toContain("enemy");
  });

  it("coverage names the half that is missing", () => {
    // **This was a pin, and its own message said how to flip it.** Registration is
    // per defId, so the damage half claimed the whole card; the agent could not
    // edit `coverage.ts` (six were writing at once), so it named the owed entry in
    // its report and pinned the over-report here. The entry landed at integration.
    //
    // Inverted rather than deleted: the note going missing again would mean the
    // card had silently gone back to claiming a clause it does not have.
    // **Inverted a second time, on 2026-08-13.** It was a pin (the note is
    // missing), then inverted to "the note is present", and now the card is WHOLE
    // so the note is correctly gone again. The assertion tracks the card rather
    // than the note's mere existence, which is what lets it mean something in
    // both directions.
    expect(
      partialImplementationNote(registry.get(SMITE)),
      "a PARTIAL entry came back — Smite is whole",
    ).toBeUndefined();
    expect(isCardImplemented(registry.get(SMITE))).toBe(true);
  });
});

describe("Grim Apothecary (UNL-021): when you play me, you may return a friendly unit at a battlefield to hand", () => {
  /**
   * A friendly unit at bf1, a friendly unit in BASE and an enemy at bf1 — one
   * legal choice and two illegal ones, so the enumerated variant list is itself
   * the assertion about "friendly" and "at a battlefield".
   */
  function board(): { state: GameState; apothecary: UnitInstance } {
    const apothecary = realUnitInstance(GRIM_APOTHECARY);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = {
      p1: [makeUnit({ instanceId: "friend" })],
      p2: [makeUnit({ instanceId: "enemy" })],
    };
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "homebody" })];
    state.players[0]!.hand = [apothecary as unknown as CardInstance];
    state.players[0]!.channeled = runes(8);
    return { state, apothecary };
  }

  const handIds = (state: GameState): string[] => state.players[0]!.hand.map((c) => c.instanceId);

  it("offers exactly one target and a decline — friendly, at a battlefield, and not the enemy", () => {
    const { state } = board();
    const variants = castsOf(state, GRIM_APOTHECARY);

    expect(variants.length, "he is not playable at all — this test measures nothing").toBeGreaterThan(0);
    // DISTINCT targets: the enumerator also fans a unit out by DESTINATION (base,
    // and bf1 as a reinforcement since p1 stands there), so each choice appears
    // once per landing spot and the raw list is 4 long. The question here is which
    // units are offerable at all.
    const targets = [...new Set(variants.map((a) => a.targetUnitInstanceId))].sort();
    expect(targets, "the offered choices are wrong").toEqual(["friend", undefined]);
  });

  it("returns the chosen friendly unit to hand through a REAL play", () => {
    const { state } = board();
    const play = castsOf(state, GRIM_APOTHECARY).find((a) => a.targetUnitInstanceId === "friend");

    const after = settle(accept(state, play));

    expect(unitOnBoard(after, "friend"), "the bounce never happened").toBeUndefined();
    expect(handIds(after), "it did not reach a hand").toContain("friend");
    expect(unitOnBoard(after, "enemy"), "it reached the enemy instead").toBeDefined();
    expect(unitOnBoard(after, "homebody"), "it reached the unit in base").toBeDefined();
  });

  it("'YOU MAY' is real — the decline variant leaves the board alone (402.1)", () => {
    // POSITIVE CONTROL on the same board first: the returning variant DOES empty
    // bf1 of the friend, so the untouched board below is the decline working rather
    // than the card being inert.
    const control = board().state;
    const taken = settle(accept(control, castsOf(control, GRIM_APOTHECARY).find((a) => a.targetUnitInstanceId === "friend")));
    expect(unitOnBoard(taken, "friend")).toBeUndefined();

    const { state } = board();
    const declined = castsOf(state, GRIM_APOTHECARY).find((a) => a.targetUnitInstanceId === undefined);
    const after = settle(accept(state, declined));

    expect(unitOnBoard(after, "friend"), "declining bounced it anyway").toBeDefined();
    expect(handIds(after), "declining bounced it anyway").not.toContain("friend");
  });

  it("resets what leaving play resets — damage and the Buff go (705)", () => {
    const { state } = board();
    state.battlefields[0]!.units.p1 = [makeUnit({ instanceId: "friend", damage: 2, buffed: true, mightThisTurn: 3 })];

    const after = settle(accept(state, castsOf(state, GRIM_APOTHECARY).find((a) => a.targetUnitInstanceId === "friend")));
    const returned = after.players[0]!.hand.find((c) => c.instanceId === "friend") as UnitInstance | undefined;

    expect(returned, "it never reached hand").toBeDefined();
    expect(returned!.damage).toBe(0);
    expect(returned!.buffed, "the Buff survived leaving play").toBe(false);
    expect(returned!.mightThisTurn).toBe(0);
  });

  it("NEGATIVE CONTROL: with nothing friendly at a battlefield he is still playable, and asks nothing", () => {
    const { state } = board();
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "enemy" })] };

    const variants = castsOf(state, GRIM_APOTHECARY);
    expect(variants.length, "he became unplayable with no target — a Unit must not").toBe(1);
    expect(variants[0]!.targetUnitInstanceId).toBeUndefined();

    const after = settle(accept(state, variants[0]!));
    expect(unitOnBoard(after, "enemy"), "it bounced an enemy with no friendly target").toBeDefined();
  });

  it("still reports UNIMPLEMENTED — his [Ambush] is a play permission and is not written", () => {
    // The clause above IS written; the keyword is not, and `isCardImplemented` asks
    // `unimplementedKeywordsOn` before it asks the registry. So no
    // PARTIALLY_IMPLEMENTED entry is owed for him — the keyword row already says it.
    const def = registry.get(GRIM_APOTHECARY);
    expect(unimplementedKeywordsOn(def)).toEqual([]);
    expect(isCardImplemented(def), "[Ambush] landed 2026-08-09 — this card is whole now").toBe(true);
  });
});

describe("Jhin - Murderous Artist (UNL-022): when I move, [Add] 1 Energy and 1 rainbow", () => {
  /** Jhin ready in base with an ordinary unit beside him, so "when I move" has
   *  somebody else's move to ignore. */
  function board(): { state: GameState; jhin: UnitInstance; other: UnitInstance } {
    const jhin = realUnitInstance(JHIN);
    const other = makeUnit({ instanceId: "other" });
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [jhin, other];
    return { state, jhin, other };
  }

  const pools = (state: GameState) => ({
    energy: state.players[0]!.floatingEnergy,
    rainbow: state.players[0]!.floatingRainbowPower,
  });

  it("adds both pips on a real Standard Move, through legalActions and submit", () => {
    const { state, jhin } = board();
    expect(pools(state), "the fixture already had floating resources").toEqual({ energy: 0, rainbow: 0 });

    const after = settle(accept(state, moveTo(state, jhin, "bf1")));

    expect(pools(after), "the move trigger never reached the resolver").toEqual({ energy: 1, rainbow: 1 });
  });

  it("the rainbow lands in floatingRainbowPower, not in a domain-keyed pool", () => {
    // The distinction the Gold token and Malzahar's ritual already rest on: a
    // rainbow rune matches every domain, and `floatingPower` is keyed by one. A
    // resolver that put it there would grant Fury specifically.
    const { state, jhin } = board();
    const after = settle(accept(state, moveTo(state, jhin, "bf1")));

    expect(after.players[0]!.floatingRainbowPower).toBe(1);
    expect(after.players[0]!.floatingPower, "it was banked as a single domain").toEqual({});
    expect(after.players[0]!.restrictedSpellEnergy, "it was banked in Lux's Spells-only pool").toBe(
      state.players[0]!.restrictedSpellEnergy,
    );
  });

  it("NEGATIVE CONTROL: another unit's move pays nothing", () => {
    // POSITIVE CONTROL on the same board first: HIS move does pay, so the zeroes
    // below are the `applies` filter working rather than moves firing nothing.
    const his = board();
    expect(pools(settle(accept(his.state, moveTo(his.state, his.jhin, "bf1")))), "positive control failed").toEqual({
      energy: 1,
      rainbow: 1,
    });

    const theirs = board();
    const moved = accept(theirs.state, moveTo(theirs.state, theirs.other, "bf1"));
    expect(pools(settle(moved)), "he paid out for somebody else's move").toEqual({ energy: 0, rainbow: 0 });

    // **And it must not TRIGGER either, which is a stronger claim than "paid
    // nothing".** `applies` is what decides whether the ability is placed at all;
    // with only the `resolve` guard the pools would still read 0 while every unit's
    // move opened a response window for an ability that resolves to nothing.
    // Measured: a mutation that loosened `applies` alone SURVIVED until this line
    // existed.
    expect(
      chainDefIds(moved),
      "his ability was placed on the chain for another unit's move — `applies` is not filtering",
    ).not.toContain(JHIN);
    // POSITIVE CONTROL on the same instrument: HIS move does place it.
    expect(chainDefIds(accept(his.state, moveTo(his.state, his.jhin, "bf1")))).toContain(JHIN);
  });

  it("NEGATIVE CONTROL: the OPPONENT is not paid", () => {
    const { state, jhin } = board();
    const after = settle(accept(state, moveTo(state, jhin, "bf1")));

    expect(after.players[1]!.floatingEnergy).toBe(0);
    expect(after.players[1]!.floatingRainbowPower).toBe(0);
  });

  it("pays AGAIN on a second move — [Ganking]'s battlefield-to-battlefield step", () => {
    // Also the only assertion in this file that his printed `[Ganking]` is live:
    // without it the enumerator offers no bf1 -> bf2 move at all and `moveTo`
    // returns undefined, which `accept` fails on.
    //
    // **Both battlefields are already this player's, and that is load-bearing.**
    // Walking into an UNcontrolled one applies Contested (450) and stages a
    // Non-Combat Showdown, and `legal-actions` enumerates no move at all while a
    // Showdown is open — so a second move would be untestable for a reason that has
    // nothing to do with this card. Measured: the first draft moved base -> bf1 and
    // then found an empty action list, with `turnState === "Showdown"`.
    const jhin = realUnitInstance(JHIN);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.controllerId = "p1";
    state.battlefields[1]!.controllerId = "p1";
    state.battlefields[0]!.units = { p1: [jhin] };

    const once = settle(accept(state, moveTo(state, jhin, "bf2")));
    expect(pools(once)).toEqual({ energy: 1, rainbow: 1 });

    // A Standard Move exhausts as a cost (414.3.a), so he is readied by hand here —
    // this test is about the trigger firing per move, not about how he gets ready.
    const readied: GameState = {
      ...once,
      battlefields: once.battlefields.map((bf) =>
        bf.id === "bf2" ? { ...bf, units: { ...bf.units, p1: (bf.units.p1 ?? []).map((u) => ({ ...u, exhausted: false })) } } : bf,
      ),
    };
    const twice = settle(accept(readied, moveTo(readied, jhin, "bf1")));

    expect(pools(twice), "the second move paid nothing — is this a one-shot?").toEqual({ energy: 2, rainbow: 2 });
  });

  it("PIN (DIVERGENCE): 429.2 says an Add resolves as soon as it is FINALIZED — here it is held", () => {
    // Asserting the WRONG answer on purpose. "429.2. Triggered and activated
    // abilities that Add resources resolve as soon as they are finalized", and
    // 337.2 repeats it for the Chain Item; his own reminder prints the consequence,
    // "abilities that add resources can't be reacted to". This engine holds every
    // triggered ability as a Chain Pending Item, so a response window sits between
    // the move and the resources.
    //
    // Closing it means teaching `holdEventTrigger`/the Cleanup that a definition
    // resolves on finalization — a shared change to triggers.ts.
    const { state, jhin } = board();
    const moved = accept(state, moveTo(state, jhin, "bf1"));

    // On the CHAIN, not in `pendingTriggers`: `submit` runs a Cleanup, which
    // finalizes the held trigger into a Chain Item (323/337) in the same action.
    // That is exactly the item 337.2 says should have resolved on the spot.
    expect(chainDefIds(moved), "it was not on the chain at all — re-read this pin").toContain(JHIN);
    expect(pools(moved), "it resolved on finalization — delete this pin, the divergence is closed").toEqual({
      energy: 0,
      rainbow: 0,
    });
    // POSITIVE CONTROL: it does arrive once the chain settles, so the zeroes above
    // are a timing measurement rather than an inert card.
    expect(pools(settle(moved))).toEqual({ energy: 1, rainbow: 1 });
  });

  it("is reported implemented — both keywords are the engine's and the [Add] is written", () => {
    expect(unimplementedKeywordsOn(registry.get(JHIN)), "a keyword he prints is unimplemented").toEqual([]);
    expect(isCardImplemented(registry.get(JHIN))).toBe(true);
  });
});

describe("what this wave did and did not write", () => {
  /** The refusals, each with the mechanism it is waiting on. Asserting the WRONG
   *  answer on purpose: a card written against a mechanism that does not exist
   *  reports DONE and does nothing, and this is what makes the difference
   *  visible. */
  it.each([
    // REFUSED — `[Ambush]` is a play PERMISSION (unit-triggers.ts's
    // PLACEMENT_GRANTS + timing.ts). Inferna is keyword-only besides.
    [INFERNA, true], // [Ambush] landed 2026-08-09
    [GRIM_APOTHECARY, true], // [Ambush] landed 2026-08-09
    // **Flipped 2026-08-13.** The refusal named "a per-unit multiplier read at
    // both `dealDamage` and combat's `applyDamage`", which was right about the two
    // sites and understated the second: 465.2.c.5 puts the doubling on the
    // ASSIGNMENT in combat, so `assignmentNeeded` halves what the unit costs to
    // kill and `applyDamage` restores it. It lives on `GameState`, not on
    // `UnitInstance`.
    [LOTUS_TRAP, true],
    // Wave 3's two halves, each carrying a PARTIALLY_IMPLEMENTED entry.
    // **`true` as of 2026-08-10**, and this row has now been both. It was `true`
    // when only the Might half existed (a coverage lie), `false` once a
    // PARTIALLY_IMPLEMENTED entry recorded the missing 'and enter ready', and
    // `true` again now that the entry is retired and the clause is one `case` in
    // `deploy.conditionalEntersReady`. The value moving twice is the mechanism
    // working; what would be wrong is it moving without the note moving with it.
    [SCORCHCLAW, true],
    // **UNL-017 flipped on 2026-08-13** — its `[Repeat] — Discard 1` is priced
    // now, and `RepeatCostSpec` gained a non-resource cost to hold it.
    [SQUARE_UP, true],
    // Written this wave.
    [JHIN, true],
  ])("%s reports implemented: %s", (defId, implemented) => {
    expect(isCardImplemented(registry.get(defId as string))).toBe(implemented);
  });

  it("Lotus Trap is genuinely WHOLE — not registered-with-a-note", () => {
    // Kept and inverted. The roll-up above would read `true` just as well for a
    // card registered with a PARTIALLY_IMPLEMENTED entry, which for a card whose
    // whole text is one clause would be a coverage lie rather than a finished
    // card. Its coverage is `test/lotus-trap.test.ts`.
    expect(partialImplementationNote(registry.get(LOTUS_TRAP))).toBeUndefined();
    expect(unimplementedKeywordsOn(registry.get(LOTUS_TRAP)), "its keywords are implemented").toEqual([]);
  });
});
