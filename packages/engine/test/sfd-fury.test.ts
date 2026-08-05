import { describe, expect, it } from "vitest";
import { effectForCard } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { destroyUnit } from "../src/engine/effect-helpers.js";
import { unitEntersReady } from "../src/engine/deploy.js";
import { hasKeyword } from "../src/engine/granted-keywords.js";
import { holdEventTrigger } from "../src/engine/triggers.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { runBeginning } from "../src/engine/turn-manager.js";
import { pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import {
  answerDecisions,
  beginCombatAt,
  makeState,
  makeUnit,
  playUnitTrigger,
  realUnitInstance,
  resolveHeldTriggers,
  spellInstance,
} from "./fixtures.js";

/**
 * Spiritforged cards owned by src/engine/effects/fury.ts.
 *
 * Everything here goes through a COMPOSED registry or a real dispatcher — never a
 * resolver imported by hand — so a card that is registered but unreachable fails
 * here rather than passing while being dead in a game. Sudden Storm additionally
 * gets a full `submit` cast, which is the hop that carries a chosen target
 * through validation, payment and the chain.
 *
 * Three of these cards are registered for only PART of their printed text. Each
 * one's describe block says which part, and asserts nothing about the missing
 * half — an assertion about text nobody wrote would be the thing that makes a
 * partial look finished.
 */

const registry = defaultCardRegistry();

const AGAINST_THE_ODDS = "SFD-001";
const BUSHWHACK = "SFD-004";
const GEM_JAMMER = "SFD-007";
const SUDDEN_STORM = "SFD-017";
const DRAVEN_VANQUISHER = "SFD-020";
const FERROUS_FORERUNNER = "SFD-021";
const DUNEBREAKER = "SFD-027";
const LUCIAN_GUNSLINGER = "SFD-028";

const fury = (id: string): RuneCard => ({ id, domain: "Fury", state: "Ready" });

type SpellEvent = Parameters<NonNullable<ReturnType<typeof effectForCard>>["resolve"]>[2];

/** Resolves a Spell through the composed effect registry — the same route
 *  `resolveCardEffect` takes, so an unregistered or misfiled defId fails on the
 *  first line rather than silently returning the state unchanged. */
function resolveSpell(defId: string, casterIndex: 0 | 1, state: GameState, event: SpellEvent = {}): GameState {
  const effect = effectForCard(spellInstance(defId));
  expect(effect, `${defId} has no registered effect`).toBeDefined();
  return effect!.resolve(state, contextFor(casterIndex), event);
}

const unitAt = (state: GameState, instanceId: string): ReturnType<typeof makeUnit> | undefined =>
  [
    ...state.players[0]!.baseUnits,
    ...state.players[1]!.baseUnits,
    ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
  ].find((u) => u.instanceId === instanceId);

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

describe("Against the Odds (SFD-001): +2 Might per enemy unit THERE", () => {
  /** A friendly unit at bf1 with `enemiesHere` opposite it, and a decoy stack at
   *  bf2 that must not be counted. */
  function odds(enemiesHere: number, enemiesElsewhere = 0): { state: GameState; targetId: string } {
    const target = makeUnit({ name: "Pantheon", might: 3 });
    const state = makeState();
    state.battlefields[0]!.units = {
      p1: [target],
      p2: Array.from({ length: enemiesHere }, () => makeUnit({ might: 1 })),
    };
    state.battlefields[1]!.units = { p2: Array.from({ length: enemiesElsewhere }, () => makeUnit({ might: 1 })) };
    return { state, targetId: target.instanceId };
  }

  it("scales with the enemies at the target's OWN battlefield", () => {
    const { state, targetId } = odds(3, 4);
    const after = resolveSpell(AGAINST_THE_ODDS, 0, state, { targetUnitInstanceId: targetId });
    // 3 enemies here => +6. The four at bf2 are "not there" and would make it +14.
    expect(unitAt(after, targetId)!.mightThisTurn).toBe(6);
  });

  it("gives nothing when the target stands unopposed", () => {
    const { state, targetId } = odds(0, 2);
    const after = resolveSpell(AGAINST_THE_ODDS, 0, state, { targetUnitInstanceId: targetId });
    expect(unitAt(after, targetId)!.mightThisTurn).toBe(0);
  });

  it("counts the CASTER's enemies, not the target owner's — p2 casting on their own unit", () => {
    // Symmetry check with real teeth: the same board, cast by the other seat on
    // the other side's unit. A resolver that counted "the other list" rather than
    // `ctx.opponentIndex` would read p1's single unit here and answer +2.
    const target = makeUnit({ name: "Theirs" });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [target], p1: [makeUnit(), makeUnit(), makeUnit()] };

    const after = resolveSpell(AGAINST_THE_ODDS, 1, state, { targetUnitInstanceId: target.instanceId });
    expect(unitAt(after, target.instanceId)!.mightThisTurn).toBe(6);
  });

  it("targets a FRIENDLY unit at a battlefield only", () => {
    const targeting = effectForCard(spellInstance(AGAINST_THE_ODDS))!.targeting;
    expect(targeting).toMatchObject({ kind: "unit", owner: "friendly" });
    // No `scope`, i.e. the battlefield default — "at a battlefield" is printed.
    expect(targeting.kind === "unit" ? targeting.scope : "set").toBeUndefined();
  });
});

describe("Bushwhack (SFD-004): friendly units enter ready this turn — HALF the card", () => {
  // The other half, "play a Gold gear token exhausted", is NOT implemented: this
  // engine has no gear tokens at all. Nothing here asserts anything about it.
  it("makes a later unit enter READY, asked through deploy's own predicate", () => {
    const state = makeState();
    const arriving = makeUnit({ name: "Ambusher" });
    expect(unitEntersReady(state, 0, arriving), "the fixture already entered ready").toBe(false);

    const after = resolveSpell(BUSHWHACK, 0, state);

    expect(unitEntersReady(after, 0, arriving)).toBe(true);
    // Only the caster's — "FRIENDLY units".
    expect(unitEntersReady(after, 1, arriving)).toBe(false);
  });
});

describe("Gem Jammer (SFD-007): when you play me, give a unit [Ganking] this turn", () => {
  it("grants Ganking through the real on-play dispatch", () => {
    const jammer = realUnitInstance(GEM_JAMMER);
    const ally = makeUnit({ name: "Runner" });
    const state = makeState();
    state.players[0]!.baseUnits = [ally, jammer];

    const after = playUnitTrigger(state, jammer, 0, "base", { targetUnitInstanceId: ally.instanceId });

    const granted = after.players[0]!.baseUnits.find((u) => u.instanceId === ally.instanceId)!;
    expect(hasKeyword(after, granted, 0, "Ganking")).toBe(true);
    expect(granted.keywordsThisTurn.Ganking).toBe(1); // unnumbered keyword, so 1
  });

  it("can name an ENEMY unit — 'a unit', no owner and no battlefield printed", () => {
    const targeting = effectForCard(spellInstance(AGAINST_THE_ODDS))!.targeting; // sanity: spells differ
    expect(targeting.kind).toBe("unit");

    const jammer = realUnitInstance(GEM_JAMMER);
    const theirs = makeUnit({ name: "Theirs" });
    const state = makeState();
    state.players[1]!.baseUnits = [theirs];
    state.players[0]!.baseUnits = [jammer];

    const after = playUnitTrigger(state, jammer, 0, "base", { targetUnitInstanceId: theirs.instanceId });
    expect(after.players[1]!.baseUnits[0]!.keywordsThisTurn.Ganking).toBe(1);
  });
});

describe("Sudden Storm (SFD-017): 2, or 4 to an attacker", () => {
  it("deals 2 through a REAL cast — legalActions, submit, chain", () => {
    // The hop that a composed-registry call cannot prove: the chosen target has
    // to survive validation, payment and the chain to reach the resolver.
    const victim = makeUnit({ instanceId: "victim", might: 20 });
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spellInstance(SUDDEN_STORM)];
    state.players[0]!.channeled = Array.from({ length: 6 }, (_, i) => fury(`f${i}`));
    state.battlefields[0]!.units = { p2: [victim] };

    const play = legalActions(state).find((a) => a.type === "PlayCard" && a.card.defId === SUDDEN_STORM);
    expect(play, "Sudden Storm was not castable").toBeDefined();
    let current = accept(state, play!);
    for (let guard = 0; guard < 8 && current.spellChain.length > 0; guard += 1) {
      current = accept(current, legalActions(current).find((a) => a.type === "PassFocus")!);
    }

    expect(unitAt(current, "victim")!.damage, "the spell resolved but the damage never landed").toBe(2);
  });

  it("deals 4 when the target is on the side that applied Contested", () => {
    const victim = makeUnit({ instanceId: "attacker", might: 20 });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [victim], p1: [makeUnit()] };
    state.battlefields[0]!.contestedByIndex = 1; // p2 is the Attacker (465 Step 1)

    const after = resolveSpell(SUDDEN_STORM, 0, state, { targetUnitInstanceId: victim.instanceId });
    expect(unitAt(after, "attacker")!.damage).toBe(4);
  });

  it("deals 2 to a DEFENDER at the very same contested battlefield", () => {
    // The discrimination the card is bought for. Same board, other side.
    const defender = makeUnit({ instanceId: "defender", might: 20 });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [makeUnit()], p1: [defender] };
    state.battlefields[0]!.contestedByIndex = 1;

    const after = resolveSpell(SUDDEN_STORM, 1, state, { targetUnitInstanceId: defender.instanceId });
    expect(unitAt(after, "defender")!.damage).toBe(2);
  });

  it("deals 2 at an UNcontested battlefield", () => {
    const victim = makeUnit({ instanceId: "quiet", might: 20 });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [victim] };

    const after = resolveSpell(SUDDEN_STORM, 0, state, { targetUnitInstanceId: victim.instanceId });
    expect(unitAt(after, "quiet")!.damage).toBe(2);
  });
});

describe("Ferrous Forerunner (SFD-021): [Deathknell] — two 3-Might Mech tokens to your base", () => {
  it("mints both tokens when he dies at a battlefield", () => {
    const forerunner = realUnitInstance(FERROUS_FORERUNNER);
    const state = makeState();
    state.battlefields[0]!.units = { p1: [forerunner] };

    const after = resolveHeldTriggers(destroyUnit(state, forerunner.instanceId));

    const tokens = after.players[0]!.baseUnits;
    expect(tokens, "the Deathknell never fired").toHaveLength(2);
    expect(tokens.map((t) => t.might)).toEqual([3, 3]);
    expect(tokens.every((t) => t.tags.includes("Mech")), "the Mech tag is what Rumble's aura reads").toBe(true);
    expect(new Set(tokens.map((t) => t.instanceId)).size, "one object minted twice").toBe(2);
    // 143.4.a's default — the card says nothing that overrides it.
    expect(tokens.every((t) => t.exhausted)).toBe(true);
    // "TO YOUR BASE", so they go home rather than to where he fell.
    expect(after.battlefields[0]!.units["p1"] ?? []).toHaveLength(0);
  });

  it("sends them to the DYING unit's controller, not the killer", () => {
    const forerunner = realUnitInstance(FERROUS_FORERUNNER);
    const state = makeState();
    state.players[1]!.baseUnits = [forerunner];

    const after = resolveHeldTriggers(destroyUnit(state, forerunner.instanceId, 0));

    expect(after.players[1]!.baseUnits.filter((u) => u.isToken)).toHaveLength(2);
    expect(after.players[0]!.baseUnits).toHaveLength(0);
  });
});

describe("Lucian - Gunslinger (SFD-028): when I attack, deal my [Assault] to an enemy here", () => {
  /** Lucian attacking bf1 against one enemy body, driven through the real
   *  Cleanup so the Attacker designation is handed out by 465 Step 1 rather than
   *  asserted by the fixture. */
  function attacking(lucian = realUnitInstance(LUCIAN_GUNSLINGER)) {
    const victim = makeUnit({ instanceId: "victim", might: 20 });
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [lucian], p2: [victim] };
    return { state, lucian };
  }

  it("deals his printed 1", () => {
    const { state } = attacking();
    const after = beginCombatAt(state, "bf1", 0);
    expect(unitAt(after, "victim")!.damage, "the attack trigger never fired").toBe(1);
  });

  it("READS the keyword — a granted [Assault 3] makes it a 3", () => {
    // The whole reason this is not a hardcoded 1. Cleave grants exactly this.
    const buffed = realUnitInstance(LUCIAN_GUNSLINGER);
    buffed.keywordsThisTurn = { Assault: 3 };
    const { state } = attacking(buffed);

    const after = beginCombatAt(state, "bf1", 0);
    expect(unitAt(after, "victim")!.damage).toBe(3);
  });

  it("does NOT fire when he is the DEFENDER", () => {
    const { state } = attacking();
    const after = beginCombatAt(state, "bf1", 1); // p2 applied Contested
    expect(unitAt(after, "victim")!.damage).toBe(0);
  });

  it("hits nobody when he attacks into an empty battlefield", () => {
    const lucian = realUnitInstance(LUCIAN_GUNSLINGER);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [lucian] };
    // No defender, so no combat and no designations — nothing to assert but that
    // it does not throw and leaves him alone.
    const after = beginCombatAt(state, "bf1", 0);
    expect(unitAt(after, lucian.instanceId)!.damage).toBe(0);
  });
});

describe("Draven - Vanquisher (SFD-020): pay [Fury] for +2 Might when he fights — HALF the card", () => {
  // "When I win a combat, play a Gold gear token exhausted" is NOT implemented —
  // there is no combat-won event and no gear tokens. Nothing here touches it.
  function fighting(channeled: RuneCard[], attackerIndex: 0 | 1 = 0) {
    const draven = realUnitInstance(DRAVEN_VANQUISHER);
    const state = makeState({ phase: "Action" });
    state.players[0]!.channeled = channeled;
    state.battlefields[0]!.units = { p1: [draven], p2: [makeUnit({ might: 20 })] };
    return { state: beginCombatAt(state, "bf1", attackerIndex), draven };
  }

  it("asks, and pays for +2 Might when he ATTACKS", () => {
    const { state, draven } = fighting([fury("f1")]);
    expect(pendingDecision(state)?.kind, "no question was raised").toBe("SFD-020-pump");

    const paid = answerDecisions(state, (options) => options.find((o) => o.id === "pay")!.id);

    expect(unitAt(paid, draven.instanceId)!.mightThisTurn).toBe(2);
    expect(paid.players[0]!.channeled, "the Fury was never spent").toHaveLength(0);
  });

  it("asks when he DEFENDS too — 'attack or defend'", () => {
    const { state, draven } = fighting([fury("f1")], 1);
    expect(pendingDecision(state)?.kind).toBe("SFD-020-pump");
    const paid = answerDecisions(state, (options) => options.find((o) => o.id === "pay")!.id);
    expect(unitAt(paid, draven.instanceId)!.mightThisTurn).toBe(2);
  });

  it("declining leads, and costs nothing", () => {
    const { state, draven } = fighting([fury("f1")]);
    const declined = answerDecisions(state); // first option
    expect(declined.players[0]!.channeled).toHaveLength(1);
    expect(unitAt(declined, draven.instanceId)!.mightThisTurn).toBe(0);
  });

  it("does not even TRIGGER when the Fury cannot be paid (416.3)", () => {
    // The negative that matters: "nothing on the board changed" is true for a
    // trigger that fired and resolved to nothing too, so this asks whether the
    // Pending Item was ever placed.
    const draven = realUnitInstance(DRAVEN_VANQUISHER);
    const state = makeState({ phase: "Action" });
    state.players[0]!.channeled = [{ id: "c1", domain: "Calm", state: "Ready" }];
    state.battlefields[0]!.units = { p1: [draven], p2: [makeUnit({ might: 20 })] };

    const held = holdEventTrigger(state, { kind: "combatBegan", battlefieldId: "bf1", designated: [draven.instanceId] });
    expect(held.pendingTriggers.map((t) => t.listenerDefId)).not.toContain(DRAVEN_VANQUISHER);
  });
});

describe("Dunebreaker (SFD-027): when I hold, draw 2 — HALF the card", () => {
  // "If you have two or fewer cards in your hand, I enter ready" is NOT
  // implemented: a conditional enter-ready lives in deploy.ts. Nothing here
  // asserts anything about how he arrives.
  function holdingBf1(units: ReturnType<typeof makeUnit>[]): GameState {
    const state = makeState({ phase: "Beginning", activePlayerIndex: 0 });
    state.players[0]!.deck = [makeUnit(), makeUnit(), makeUnit()];
    state.battlefields[0]!.units = { p1: units };
    state.battlefields[0]!.controllerId = "p1";
    return state;
  }

  it("draws 2 on the hold", () => {
    const settled = resolveHeldTriggers(runBeginning(holdingBf1([realUnitInstance(DUNEBREAKER)])));
    expect(settled.players[0]!.hand, "the hold trigger never fired").toHaveLength(2);
    expect(settled.players[0]!.points).toBe(1); // the ordinary hold point is untouched
  });

  it("does NOT fire for a battlefield he is not standing at — 'when I hold'", () => {
    const state = holdingBf1([realUnitInstance(DUNEBREAKER)]);
    state.battlefields[1]!.units = { p1: [makeUnit({ name: "Outpost" })] };
    state.battlefields[1]!.controllerId = "p1";

    const settled = resolveHeldTriggers(runBeginning(state));
    expect(settled.players[0]!.points).toBe(2); // both held
    expect(settled.players[0]!.hand, "he drew for someone else's battlefield").toHaveLength(2);
  });
});

describe("coverage reports these as implemented", () => {
  // The registrations, seen the way the deck builder sees them.
  //
  // This started as ONE list asserting all eight read as implemented, with a
  // comment saying the three partials were in it deliberately — "registration is
  // per defId, so they DO read as implemented, and that over-report is exactly
  // what coverage.PARTIALLY_IMPLEMENTED exists to correct... here to make the
  // over-report visible rather than to bless it."
  //
  // The entries have since been written, so the over-report is gone and the
  // list has to split. Keeping the old assertion would have meant asserting
  // that three half-written cards still read as finished — the premise changed,
  // and this is the premise being fixed rather than the assertion weakened.
  for (const defId of [AGAINST_THE_ODDS, GEM_JAMMER, SUDDEN_STORM, FERROUS_FORERUNNER, LUCIAN_GUNSLINGER]) {
    it(`${defId} (${registry.get(defId).name}) is whole`, () => {
      expect(isCardImplemented(registry.get(defId))).toBe(true);
      expect(partialImplementationNote(registry.get(defId))).toBeUndefined();
    });
  }

  // The three written as HALF a card. Each must report NOT implemented, and the
  // note must say which half is missing — a bare `false` would be
  // indistinguishable from a card nobody has started.
  for (const [defId, missing] of [
    [BUSHWHACK, "Gold gear token"],
    [DRAVEN_VANQUISHER, "Gold gear token"],
    [DUNEBREAKER, "deploy.unitEntersReady"],
  ] as const) {
    it(`${defId} (${registry.get(defId).name}) is PARTIAL, and says why`, () => {
      expect(isCardImplemented(registry.get(defId))).toBe(false);
      expect(partialImplementationNote(registry.get(defId))).toContain(missing);
    });
  }
});
