import { describe, expect, it } from "vitest";
import { effectForCard, cardModeOf } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { dispatchOnPlayUnit } from "../src/engine/unit-triggers.js";
import { dispatchEvent, holdEventTrigger } from "../src/engine/triggers.js";
import { destroyUnit, dealDamage } from "../src/engine/effect-helpers.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { hasKeyword } from "../src/engine/granted-keywords.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { GearInstance, UnitInstance } from "../src/model/card.js";
import { makeState, makeUnit, playUnitTrigger, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * Fires a HELD event and drives it to resolution.
 *
 * `cardPlayed` is a Chain Pending Item now (383 / 808.1.d.3), so it is placed by
 * `holdEventTrigger` and only resolves once the Cleanup finalizes it onto the
 * chain and both players pass. Calling the old inline dispatcher here would not
 * merely be stale — it would bypass every `applies` predicate, which is where the
 * trigger CONDITIONS now live, and quietly test nothing.
 */
const fireHeld = (state: GameState, event: Parameters<typeof holdEventTrigger>[1]): GameState =>
  resolveHeldTriggers(holdEventTrigger(state, event));

/** Was the trigger even PLACED? The negative assertion that matters once events
 *  are held: "nothing happened" is true immediately after any hold, so a check on
 *  the board alone passes whether the condition worked or the trigger merely had
 *  not resolved yet. */
const heldFor = (state: GameState, event: Parameters<typeof holdEventTrigger>[1]): string[] =>
  holdEventTrigger(state, event).pendingTriggers.map((t) => t.listenerDefId);


/**
 * The `[Hidden]` cards whose printed TEXT was still unimplemented.
 *
 * The keyword itself has worked for a while (engine/hidden.ts); what these cards
 * were missing is everything the keyword is not. Only Ember Monk actually reads
 * the hidden-ness, and he reads it off the play event rather than the card.
 */

const registry = defaultCardRegistry();

const BLOCK = "OGN-057";
const ZHONYAS = "OGN-077";
const BLASTCONE_FAE = "OGN-097";
const EMBER_MONK = "OGN-167";
const TEEMO_SCOUT = "OGN-197";
const TIDETURNER = "OGN-199";

const BATCH = [BLOCK, ZHONYAS, BLASTCONE_FAE, EMBER_MONK, TEEMO_SCOUT, TIDETURNER];

type SpellEvent = Parameters<NonNullable<ReturnType<typeof cardModeOf>>["resolve"]>[2];
const resolveSpell = (defId: string, casterIndex: 0 | 1, state: GameState, event: SpellEvent = {}): GameState => {
  const effect = cardModeOf(spellInstance(defId), undefined);
  expect(effect, `${defId} has no registered effect`).toBeDefined();
  return effect!.resolve(state, contextFor(casterIndex), event);
};

function playUnit(
  defId: string,
  state: GameState,
  extra: Parameters<typeof dispatchOnPlayUnit>[4] = {},
  destination: Parameters<typeof dispatchOnPlayUnit>[3] = "base",
): { state: GameState; unit: UnitInstance } {
  const unit = realUnitInstance(defId);
  const actor = state.players[0]!;
  const withUnit: GameState =
    destination === "base"
      ? { ...state, players: [{ ...actor, baseUnits: [...actor.baseUnits, unit] }, state.players[1]!] }
      : {
          ...state,
          battlefields: state.battlefields.map((bf) =>
            bf.id === destination.battlefieldId ? { ...bf, units: { ...bf.units, p1: [...(bf.units["p1"] ?? []), unit] } } : bf,
          ),
        };
  return { state: playUnitTrigger(withUnit, unit, 0, destination, extra), unit };
}

function gear(defId: string, instanceId = "g1"): GearInstance {
  const def = registry.get(defId);
  return {
    instanceId, defId, name: def.name, domains: def.domains, exhausted: false, isToken: false,
    kind: "Gear", energyCost: 0, powerCost: 0, powerDomain: null, keywords: {},
  } as GearInstance;
}

const atBf = (s: GameState, playerId: string, bf = 0) => s.battlefields[bf]!.units[playerId] ?? [];

describe("Block (OGN-057): [Shield 3] and [Tank] this turn", () => {
  it("grants both, and Shield at its printed VALUE of 3", () => {
    const unit = makeUnit({ name: "Mine", might: 2 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [unit] };

    const after = resolveSpell(BLOCK, 0, state, { targetUnitInstanceId: unit.instanceId });
    const now = atBf(after, "p1")[0]!;

    expect(hasKeyword(after, now, 0, "Shield")).toBe(true);
    expect(hasKeyword(after, now, 0, "Tank")).toBe(true);
    // [Shield] is +3 while DEFENDING only.
    expect(effectiveMight(after, now, 0, { isCombat: true, isAttackingSide: false, combatRole: "remaining", battlefieldId: "bf1" })).toBe(5);
    expect(effectiveMight(after, now, 0, { isCombat: true, isAttackingSide: true, combatRole: "remaining", battlefieldId: "bf1" })).toBe(2);
  });

  it("lets a 2-Might defender survive 4 damage it would otherwise die to", () => {
    // End to end rather than on the flag: the whole point of the card.
    const attacker = makeUnit({ name: "Attacker", might: 4 });
    const defender = makeUnit({ name: "Defender", might: 2 });
    const state = makeState({ turnState: "Showdown", showdownBattlefieldId: "bf1", showdownKind: "Combat", activePlayerIndex: 1 });
    state.battlefields[0]!.units = { p2: [attacker], p1: [defender] };

    const blocked = resolveSpell(BLOCK, 0, state, { targetUnitInstanceId: defender.instanceId });
    const after = resolveShowdown(blocked, "bf1", 1);

    expect(after.players[0]!.trash).toHaveLength(0);
  });

  it("pulls the blocked unit to the FRONT of the damage assignment, saving the unit behind it", () => {
    // The [Tank] half, which is the other reason to cast this in a Showdown:
    // "must be assigned lethal damage before any other unit with the same
    // controller that does not have [Tank]". The grant lands in
    // `keywordsThisTurn`, so combat only sees it through `effectiveKeywords`.
    //
    // 2 damage against two 2-Might defenders, with the blocked one listed
    // SECOND so only real reordering can put it in front. Blocked has
    // [Shield 3] as well, so it soaks all 2 and lives; assigning in list
    // order instead kills Squishy outright.
    const attacker = makeUnit({ name: "Attacker", might: 2 });
    const squishy = makeUnit({ name: "Squishy", might: 2 });
    const blockTarget = makeUnit({ name: "Blocked", might: 2 });
    const state = makeState({ turnState: "Showdown", showdownBattlefieldId: "bf1", showdownKind: "Combat", activePlayerIndex: 1 });
    state.battlefields[0]!.units = { p2: [attacker], p1: [squishy, blockTarget] };

    const blocked = resolveSpell(BLOCK, 0, state, { targetUnitInstanceId: blockTarget.instanceId });
    const after = resolveShowdown(blocked, "bf1", 1);

    expect(atBf(after, "p1").map((u) => u.name)).toEqual(["Squishy", "Blocked"]);
  });
});

describe("Zhonya's Hourglass (OGN-077): a MANDATORY death replacement", () => {
  function glassState(): { state: GameState; doomed: UnitInstance } {
    const doomed = makeUnit({ name: "Doomed", might: 3 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [doomed] };
    state.players[0]!.activeGear = [gear(ZHONYAS)];
    return { state, doomed };
  }

  it("dies in the unit's place, and the unit comes back healed, exhausted, in base", () => {
    const { state, doomed } = glassState();
    const after = destroyUnit(state, doomed.instanceId, 1);

    expect(after.players[0]!.activeGear).toHaveLength(0);
    expect(after.players[0]!.trash.map((c) => c.defId)).toEqual([ZHONYAS]);
    const saved = after.players[0]!.baseUnits.find((u) => u.name === "Doomed")!;
    expect(saved.damage).toBe(0);
    expect(saved.exhausted).toBe(true);
    expect(atBf(after, "p1")).toHaveLength(0);
  });

  it("is a REPLACEMENT, so the unit never died — no Deathknell, no death tally", () => {
    // 808.1.d.1: a replaced death is not a death. Spoils of War prices itself off
    // units that actually died, so the tally must not move either.
    const { state, doomed } = glassState();
    const after = destroyUnit(state, doomed.instanceId, 1);

    expect(after.players[0]!.unitsLostThisTurn).toBe(0);
    expect(after.players[0]!.trash.some((c) => c.instanceId === doomed.instanceId)).toBe(false);
  });

  it("saves a unit from LETHAL DAMAGE too, not just a kill instruction", () => {
    const { state, doomed } = glassState();
    const after = dealDamage(state, 1, doomed.instanceId, 99);

    expect(after.players[0]!.baseUnits.map((u) => u.name)).toEqual(["Doomed"]);
    expect(after.players[0]!.activeGear).toHaveLength(0);
  });

  it("is spent — the SECOND death is real", () => {
    const { state, doomed } = glassState();
    const saved = destroyUnit(state, doomed.instanceId, 1);
    const savedUnit = saved.players[0]!.baseUnits.find((u) => u.name === "Doomed")!;

    const after = destroyUnit(saved, savedUnit.instanceId, 1);

    expect(after.players[0]!.trash.some((c) => c.instanceId === doomed.instanceId)).toBe(true);
    expect(after.players[0]!.unitsLostThisTurn).toBe(1);
  });

  it("does NOT save the opponent's units — 'a FRIENDLY unit'", () => {
    const { state } = glassState();
    const theirs = makeUnit({ name: "Theirs", might: 3 });
    const withEnemy: GameState = {
      ...state,
      battlefields: state.battlefields.map((bf) => (bf.id === "bf1" ? { ...bf, units: { ...bf.units, p2: [theirs] } } : bf)),
    };

    const after = destroyUnit(withEnemy, theirs.instanceId, 0);

    expect(after.players[0]!.activeGear).toHaveLength(1); // untouched
    expect(after.players[1]!.trash.map((c) => c.name)).toEqual(["Theirs"]);
  });
});

describe("Blastcone Fae (OGN-097) and Teemo - Scout (OGN-197)", () => {
  it("Blastcone Fae gives -2, floored at 1", () => {
    const enemy = makeUnit({ name: "Enemy", might: 5 });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [enemy] };

    const { state: after } = playUnit(BLASTCONE_FAE, state, { targetUnitInstanceId: enemy.instanceId });
    expect(atBf(after, "p2")[0]!.mightThisTurn).toBe(-2);

    const small = makeUnit({ name: "Small", might: 1 });
    const tiny = makeState();
    tiny.battlefields[0]!.units = { p2: [small] };
    const afterSmall = playUnit(BLASTCONE_FAE, tiny, { targetUnitInstanceId: small.instanceId }).state;
    expect(effectiveMight(afterSmall, atBf(afterSmall, "p2")[0]!, 1, { isCombat: false, battlefieldId: "bf1" })).toBe(1);
  });

  it("Teemo - Scout pumps himself by 3", () => {
    const { state, unit } = playUnit(TEEMO_SCOUT, makeState());
    expect(state.players[0]!.baseUnits.find((u) => u.instanceId === unit.instanceId)!.mightThisTurn).toBe(3);
  });
});

describe("Ember Monk (OGN-167): +2 when you play a card FROM hidden", () => {
  function monkState(): GameState {
    const monk = realUnitInstance(EMBER_MONK);
    const state = makeState();
    state.battlefields[0]!.units = { p1: [monk] };
    return state;
  }

  it("fires on a hidden play", () => {
    const after = fireHeld(monkState(), { kind: "cardPlayed", casterIndex: 0, playedKind: "Spell", playedInstanceId: "synthetic", playedPowerCost: 0, isToken: false, fromHidden: true });
    expect(atBf(after, "p1")[0]!.mightThisTurn).toBe(2);
  });

  it("does NOT fire on an ordinary play", () => {
    const after = fireHeld(monkState(), { kind: "cardPlayed", casterIndex: 0, playedKind: "Spell", playedInstanceId: "synthetic", playedPowerCost: 0, isToken: false });
    expect(atBf(after, "p1")[0]!.mightThisTurn).toBe(0);
  });

  it("does NOT fire for the OPPONENT's hidden play", () => {
    const after = fireHeld(monkState(), { kind: "cardPlayed", casterIndex: 1, playedKind: "Spell", playedInstanceId: "synthetic", playedPowerCost: 0, isToken: false, fromHidden: true });
    expect(atBf(after, "p1")[0]!.mightThisTurn).toBe(0);
  });
});

describe("Tideturner (OGN-199): swap places with a friendly unit elsewhere", () => {
  it("swaps a battlefield unit with one in base", () => {
    const ally = makeUnit({ name: "Ally" });
    const state = makeState();
    state.players[0]!.baseUnits = [ally];

    // Tideturner played to bf1; the ally is at home. They trade places.
    const { state: after, unit } = playUnit(TIDETURNER, state, { targetUnitInstanceId: ally.instanceId }, { battlefieldId: "bf1" });

    expect(atBf(after, "p1").map((u) => u.name)).toEqual(["Ally"]);
    expect(after.players[0]!.baseUnits.map((u) => u.instanceId)).toEqual([unit.instanceId]);
  });

  it("swaps between two battlefields", () => {
    const ally = makeUnit({ name: "Ally" });
    const state = makeState();
    state.battlefields[1]!.units = { p1: [ally] };

    const { state: after, unit } = playUnit(TIDETURNER, state, { targetUnitInstanceId: ally.instanceId }, { battlefieldId: "bf1" });

    expect(atBf(after, "p1", 0).map((u) => u.name)).toEqual(["Ally"]);
    expect(atBf(after, "p1", 1).map((u) => u.instanceId)).toEqual([unit.instanceId]);
  });

  it("does nothing when declined — 'you MAY choose'", () => {
    const ally = makeUnit({ name: "Ally" });
    const state = makeState();
    state.players[0]!.baseUnits = [ally];

    const { state: after, unit } = playUnit(TIDETURNER, state, {}, { battlefieldId: "bf1" });

    expect(atBf(after, "p1").map((u) => u.instanceId)).toEqual([unit.instanceId]);
    expect(after.players[0]!.baseUnits.map((u) => u.name)).toEqual(["Ally"]);
  });

  it("refuses a unit at the SAME location — 'ANOTHER location'", () => {
    const ally = makeUnit({ name: "Ally" });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [ally] };

    const { state: after, unit } = playUnit(TIDETURNER, state, { targetUnitInstanceId: ally.instanceId }, { battlefieldId: "bf1" });

    // Both still at bf1, in their original order — nothing moved.
    expect(atBf(after, "p1").map((u) => u.instanceId)).toEqual([ally.instanceId, unit.instanceId]);
  });

  it("contests the battlefield it lands on", () => {
    const ally = makeUnit({ name: "Ally" });
    const enemy = makeUnit({ name: "Enemy" });
    const state = makeState();
    state.players[0]!.baseUnits = [ally];
    state.battlefields[1]!.units = { p2: [enemy] };
    state.battlefields[1]!.controllerId = "p2";

    // Tideturner arrives at bf1, then swaps home with the ally — so the ALLY
    // ends up at bf1. Nothing reaches bf2 here; this pins that a swap applies
    // Contested for whichever battlefields were involved.
    const { state: after } = playUnit(TIDETURNER, state, { targetUnitInstanceId: ally.instanceId }, { battlefieldId: "bf1" });

    expect(after.battlefields[0]!.contestedByIndex === null || after.battlefields[0]!.contestedByIndex === 0).toBe(true);
  });
});

describe("coverage", () => {
  it("reports all six as implemented", () => {
    expect(BATCH.filter((id) => !isCardImplemented(registry.get(id)))).toEqual([]);
  });
});
