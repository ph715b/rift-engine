import { describe, expect, it } from "vitest";
import { effectForCard, cardModeOf } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { destroyUnit } from "../src/engine/effect-helpers.js";
import { unitEntersReady } from "../src/engine/deploy.js";
import { hasKeyword } from "../src/engine/granted-keywords.js";
import { holdEventTrigger } from "../src/engine/triggers.js";
import { resolveShowdown } from "../src/engine/combat.js";
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
 * ONE of these cards is registered for only PART of its printed text — Rumble -
 * Hotheaded, whose keyword aura is unwritten. It was three (Bushwhack, Draven,
 * Dunebreaker) until the gear-token primitive, the `combatWon` event and the
 * conditional enter-ready in deploy.ts finished those. Its describe block says
 * which half, and asserts nothing about the missing one — an assertion about text
 * nobody wrote would be the thing that makes a partial look finished.
 */

const registry = defaultCardRegistry();

const AGAINST_THE_ODDS = "SFD-001";
const BUSHWHACK = "SFD-004";
const GEM_JAMMER = "SFD-007";
const SUDDEN_STORM = "SFD-017";
const DRAVEN_VANQUISHER = "SFD-020";
const FERROUS_FORERUNNER = "SFD-021";
const RUMBLE_HOTHEADED = "SFD-026";
const DUNEBREAKER = "SFD-027";
const LUCIAN_GUNSLINGER = "SFD-028";
/** Mega-Mech (OGN-088) — 7 Energy, no Power, and NO printed text, so a test that
 *  plays it from a trash is measuring the price and nothing else. */
const MEGA_MECH = "OGN-088";

const fury = (id: string): RuneCard => ({ id, domain: "Fury", state: "Ready" });

type SpellEvent = Parameters<NonNullable<ReturnType<typeof cardModeOf>>["resolve"]>[2];

/** Resolves a Spell through the composed effect registry — the same route
 *  `resolveCardEffect` takes, so an unregistered or misfiled defId fails on the
 *  first line rather than silently returning the state unchanged. */
function resolveSpell(defId: string, casterIndex: 0 | 1, state: GameState, event: SpellEvent = {}): GameState {
  const effect = cardModeOf(spellInstance(defId), undefined);
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
    const targeting = cardModeOf(spellInstance(AGAINST_THE_ODDS), undefined)!.targeting;
    expect(targeting).toMatchObject({ kind: "unit", owner: "friendly" });
    // No `scope`, i.e. the battlefield default — "at a battlefield" is printed.
    expect(targeting.kind === "unit" ? targeting.scope : "set").toBeUndefined();
  });
});

describe("Bushwhack (SFD-004): enter ready this turn, AND a Gold token", () => {
  // Both halves are written now. The second one waited on the gear-token
  // primitive, which was the wave's largest blocker.
  it("makes a later unit enter READY, asked through deploy's own predicate", () => {
    const state = makeState();
    const arriving = makeUnit({ name: "Ambusher" });
    expect(unitEntersReady(state, 0, arriving), "the fixture already entered ready").toBe(false);

    const after = resolveSpell(BUSHWHACK, 0, state);

    expect(unitEntersReady(after, 0, arriving)).toBe(true);
    // Only the caster's — "FRIENDLY units".
    expect(unitEntersReady(after, 1, arriving)).toBe(false);
  });

  it("also plays ONE Gold gear token, exhausted, for the caster only", () => {
    // The second sentence, unwritten until the gear-token primitive existed.
    // Exhausted matters: a ready Gold is a free rainbow Power the turn it is
    // made, because its printed ability costs only a kill and an exhaust.
    const after = resolveSpell(BUSHWHACK, 0, makeState());

    const gear = after.players[0]!.activeGear;
    expect(gear).toHaveLength(1);
    expect(gear[0]!.name).toBe("Gold");
    expect(gear[0]!.kind).toBe("Gear");
    expect(gear[0]!.isToken).toBe(true);
    expect(gear[0]!.exhausted, "a ready Gold is a free rainbow Power this turn").toBe(true);
    expect(after.players[1]!.activeGear, "the opponent got one too").toHaveLength(0);
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
    const targeting = cardModeOf(spellInstance(AGAINST_THE_ODDS), undefined)!.targeting; // sanity: spells differ
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

describe("Dunebreaker (SFD-027): when I hold, draw 2", () => {
  // These cases cover the HOLD clause only. His conditional enter-ready is
  // written now and lives in deploy.ts, so it is tested where it lives — nothing
  // here asserts anything about how he arrives, which is why this block says
  // nothing about the card being partial any more.
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

describe("Rumble - Hotheaded (SFD-026): recycle a friendly unit to play a Mech from your trash — HALF the card", () => {
  // "Your Mechs each have [Assault]" is NOT implemented — a keyword aura lives in
  // granted-keywords.ts's table, a shared file. Nothing below asserts anything
  // about [Assault], on Rumble or on the Mech he pulls back.
  //
  // Every fixture here drives a REAL conquest: `resolveShowdown` wipes the lone
  // defender, the Cleanup establishes control and records the conquest, and the
  // trigger is held and finalized like any other. Nothing calls the resolver by
  // hand, so a registration the dispatcher cannot reach fails on the first
  // assertion rather than passing while the card is dead in a game.

  interface Board {
    /** Decides the discount: Mega-Mech prints 7 Energy, so this is 7 - it. */
    fodderMight?: number;
    runes?: number;
    /** false puts a plain unit in the trash instead — "a MECH from your trash". */
    mechInTrash?: boolean;
    /** false leaves him with no OTHER friendly unit to spend. */
    withFodder?: boolean;
    /** "bf2" makes a stand-in take bf1 while he watches — "when *I* conquer". */
    rumbleAt?: "bf1" | "bf2";
    /** Which Mech waits in the trash. Mega-Mech prints NO Power, so the default
     *  never exercises the Power half of the payment; Ferrous Forerunner does. */
    mechDefId?: string;
  }

  function conquest(opts: Board = {}) {
    const rumble = realUnitInstance(RUMBLE_HOTHEADED);
    const fodder = makeUnit({ name: "Scrap Fodder", might: opts.fodderMight ?? 3 });
    const mech = realUnitInstance(opts.mechDefId ?? MEGA_MECH);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.baseUnits = opts.withFodder === false ? [] : [fodder];
    state.players[0]!.trash = [opts.mechInTrash === false ? makeUnit({ name: "Cardboard" }) : mech];
    state.players[0]!.channeled = Array.from({ length: opts.runes ?? 4 }, (_, i) => fury(`f${i}`));

    const elsewhere = opts.rumbleAt === "bf2";
    state.battlefields[0]!.units = {
      p1: [elsewhere ? makeUnit({ name: "Stand-in", might: 4 }) : rumble],
      p2: [makeUnit({ might: 1 })],
    };
    if (elsewhere) {
      state.battlefields[1]!.units = { p1: [rumble] };
      // Already his, so standing there alone establishes nothing: control is
      // GAINED or not at all ("if that player does not already Control the
      // Battlefield"), and no control means no Conquer (469.1). Otherwise the
      // positional control would fire the trigger for the OTHER battlefield and
      // prove the opposite of what it claims.
      state.battlefields[1]!.controllerId = "p1";
    }
    return { state: resolveHeldTriggers(resolveShowdown(state, "bf1", 0)), rumble, fodder, mech };
  }

  /** Answers the trade with the one pair on offer, and anything else (the free
   *  play's placement question) with its first option. */
  function takeTheTrade(state: GameState, seen?: (labels: string[]) => void): GameState {
    return answerDecisions(state, (options, decision) => {
      if (decision.kind !== "SFD-026-scrap") return options[0]!.id;
      seen?.(options.map((o) => o.label));
      return options.find((o) => o.id !== "decline")!.id;
    });
  }

  it("recycles the unit, pays the DISCOUNTED cost, and puts the Mech in play", () => {
    const { state, fodder, mech } = conquest();
    expect(pendingDecision(state)?.kind, "the conquer trigger never asked").toBe("SFD-026-scrap");

    let offered: string[] = [];
    const done = takeTheTrade(state, (labels) => (offered = labels));

    // Mega-Mech's printed 7, minus a 3-Might Scrap Fodder, priced in the offer
    // itself — the player is choosing a price, not just a card.
    expect(offered, "decline must lead, and exactly one pair was payable").toHaveLength(2);
    expect(offered[1]).toContain("Scrap Fodder");
    expect(offered[1]).toContain("4 Energy");

    expect(unitAt(done, mech.instanceId), "the Mech never reached the board").toBeDefined();
    expect(done.players[0]!.trash.map((c) => c.instanceId)).not.toContain(mech.instanceId);
    // Recycled, so the fodder is on the bottom of the DECK — a Recycle is a zone
    // change and never a death, which is what makes this different from a kill.
    expect(unitAt(done, fodder.instanceId)).toBeUndefined();
    expect(done.players[0]!.deck.at(-1)?.instanceId).toBe(fodder.instanceId);
    expect(done.players[0]!.trash.map((c) => c.instanceId)).not.toContain(fodder.instanceId);
    // All four runes went, which is 7 - 3 and not 7.
    expect(done.players[0]!.channeled.filter((r) => r.state === "Ready"), "the Energy was never paid").toHaveLength(0);
  });

  it("pays a Mech's POWER as well as its Energy — the discount touches Energy only", () => {
    // Ferrous Forerunner prints 6 Energy AND [1 Fury] Power. "Reduce its ENERGY
    // cost" is all Rumble says, so the pip is still owed in full — and this is
    // the only case that reaches the Power half of the payment at all.
    const { state, mech } = conquest({ mechDefId: FERROUS_FORERUNNER });
    expect(pendingDecision(state)?.kind).toBe("SFD-026-scrap");

    const done = takeTheTrade(state);
    expect(unitAt(done, mech.instanceId), "the Mech never reached the board").toBeDefined();
    // Paying Power RECYCLES its rune (416) and banks the Energy that rune could
    // have paid, so of four Fury runes: one goes back to the rune deck for the
    // pip, and 6 - 3 = 3 Energy comes from that 1 banked plus 2 exhausted —
    // leaving three runes channeled, exactly one of them still Ready.
    expect(done.players[0]!.channeled).toHaveLength(3);
    expect(done.players[0]!.channeled.filter((r) => r.state === "Ready")).toHaveLength(1);
    expect(done.players[0]!.floatingEnergy, "the banked Energy was not spent").toBe(0);
  });

  it("does not even ASK when the discount does not cover the Mech — 3 runes, 3 Might, 7 Energy", () => {
    // The negative half of the pair below. 7 - 3 = 4 and there are 3 runes, so
    // 416.3 says the trade is not one you may choose to take.
    expect(pendingDecision(conquest({ runes: 3 }).state)).toBeUndefined();
  });

  it("and DOES ask on the same 3 runes when the fodder is a 4-Might unit", () => {
    // The positive half: the ONLY difference is the recycled unit's Might, so a
    // resolver that ignored the discount would refuse this too, and one that
    // played the Mech for free would have offered the case above.
    const { state } = conquest({ runes: 3, fodderMight: 4 });
    expect(pendingDecision(state)?.kind).toBe("SFD-026-scrap");

    const done = takeTheTrade(state);
    expect(done.players[0]!.channeled.filter((r) => r.state === "Ready"), "7 - 4 = 3, and 3 runes were channeled").toHaveLength(0);
  });

  it("declining leads, and costs nothing", () => {
    const { state, fodder, mech } = conquest();
    const declined = answerDecisions(state); // first option, which is Decline

    expect(unitAt(declined, fodder.instanceId), "the fodder was recycled anyway").toBeDefined();
    expect(declined.players[0]!.trash.map((c) => c.instanceId)).toContain(mech.instanceId);
    expect(declined.players[0]!.channeled.filter((r) => r.state === "Ready")).toHaveLength(4);
  });

  it("does not ask with no Mech in the trash", () => {
    expect(pendingDecision(conquest({ mechInTrash: false }).state)).toBeUndefined();
  });

  it("does not ask with no OTHER friendly unit to recycle", () => {
    // He may not spend himself — "recycle ANOTHER friendly unit".
    expect(pendingDecision(conquest({ withFodder: false }).state)).toBeUndefined();
  });

  it("does not ask when he is not standing at the battlefield conquered", () => {
    // Everything else about this board is payable; the only thing wrong with it
    // is where he is standing, which is what "when I conquer" asks.
    expect(pendingDecision(conquest({ rumbleAt: "bf2" }).state)).toBeUndefined();
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
  for (const defId of [
    AGAINST_THE_ODDS,
    BUSHWHACK,
    DUNEBREAKER,
    GEM_JAMMER,
    SUDDEN_STORM,
    DRAVEN_VANQUISHER,
    FERROUS_FORERUNNER,
    LUCIAN_GUNSLINGER,
  ]) {
    it(`${defId} (${registry.get(defId).name}) is whole`, () => {
      expect(isCardImplemented(registry.get(defId))).toBe(true);
      expect(partialImplementationNote(registry.get(defId))).toBeUndefined();
    });
  }

  // The three written as HALF a card. Each must report NOT implemented, and the
  // note must say which half is missing — a bare `false` would be
  // indistinguishable from a card nobody has started.
  // **Every one of this file's three partials has since been finished**, and
  // each entry was DELETED rather than reworded — a card is either finished or
  // it is on that list. Bushwhack needed the gear-token primitive; Draven
  // needed that AND a combat-WON event AND a list-valued
  // `EventTriggerDefinition.on`; Dunebreaker needed a clause in
  // `deploy.unitEntersReady`, which now carries all four of SFD's conditional
  // enter-readys.
  it("Dunebreaker is WHOLE now — both clauses, and no partial note", () => {
    expect(registry.get(DUNEBREAKER).text).toContain("I enter ready");
    expect(isCardImplemented(registry.get(DUNEBREAKER))).toBe(true);
    expect(partialImplementationNote(registry.get(DUNEBREAKER))).toBeUndefined();
  });
});
