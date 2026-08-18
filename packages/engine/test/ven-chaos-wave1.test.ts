import { describe, expect, it } from "vitest";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { effectForCard } from "../src/engine/card-effects.js";
import { modifiedEnergyCost } from "../src/engine/cost-modifiers.js";
import { holdEventTrigger, holdSelfTrigger } from "../src/engine/triggers.js";
import { optionsFor } from "../src/engine/decisions.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { forceMoveToBase, forceMoveToBattlefield } from "../src/engine/effect-helpers.js";
import {
  answerDecisions,
  makeState,
  makeUnit,
  realGearInstance,
  realUnitInstance,
  resolveHeldTriggers,
  spellInstance,
} from "./fixtures.js";

/**
 * **Vendetta's Chaos cards — the first wave**, the ten that needed no new
 * targeting axis.
 *
 * Two rules do most of the work here and both are worth stating once:
 *
 *  - **427.2.a, "Banish is not a subset of Kill."** Wind and Ghosts and Ravenbloom
 *    Prefect both banish rather than kill, so no `[Deathknell]` fires and nothing
 *    that prices off deaths pays out. That is why `banishUnitFromPlay` exists
 *    beside `destroyUnit` rather than as a flag on it.
 *  - **A decline-only offer is executed SILENTLY** by `advanceDecisions`, so a
 *    test that reads `pendingDecisions` to prove something was NOT offered is
 *    vacuous. Those assertions read outcomes or chain placement instead.
 */

const registry = defaultCardRegistry();

const MASK_MOTHER = "VEN-094";
const DISCIPLE = "VEN-095";
const LURKER = "VEN-096";
const SPIDERLING = "VEN-097";
const PREFECT = "VEN-102";
const SHADOWS_OF_THE_PAST = "VEN-103";
const TWILIGHT_STEP = "VEN-105";
const WIND_AND_GHOSTS = "VEN-106";
const FORGOTTEN_RELIC = "VEN-108";
const MINAH = "VEN-111";

function onBoard(state: GameState, instanceId: string): UnitInstance | undefined {
  for (const player of state.players) {
    const found =
      player.baseUnits.find((u) => u.instanceId === instanceId) ??
      state.battlefields.flatMap((bf) => bf.units[player.id] ?? []).find((u) => u.instanceId === instanceId);
    if (found) return found;
  }
  return undefined;
}

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

const mightAt = (state: GameState, unit: UnitInstance, ownerIndex: 0 | 1, battlefieldId?: string): number =>
  effectiveMight(state, unit, ownerIndex, battlefieldId === undefined ? { isCombat: false } : { isCombat: false, battlefieldId });

describe("Mask Mother (VEN-094): pay 1 on discard to pump a friendly unit", () => {
  function board(energy: number): { state: GameState; ally: UnitInstance; mother: UnitInstance } {
    const mother = realUnitInstance(MASK_MOTHER);
    const ally = makeUnit({ instanceId: "ally" });
    const state = makeState();
    state.players[0]!.baseUnits = [ally];
    state.players[0]!.trash = [mother];
    state.players[0]!.floatingEnergy = energy;
    return { state, ally, mother };
  }

  const discarded = (state: GameState, mother: UnitInstance): GameState =>
    resolveHeldTriggers(holdSelfTrigger(state, "discarded", mother, 0));

  it("pays and pumps", () => {
    const { state, ally, mother } = board(1);
    const after = answerDecisions(discarded(state, mother), (options) =>
      options.find((o) => o.instanceId === ally.instanceId)!.id,
    );
    expect(onBoard(after, ally.instanceId)?.mightThisTurn).toBe(2);
    expect(after.players[0]!.floatingEnergy, "the Energy was never spent").toBe(0);
  });

  it("offers only FRIENDLY units", () => {
    // "A FRIENDLY unit" is her controller's. Asserted on the OPTION LIST, because
    // a test that picks the ally by id passes just as well against a list that
    // also offers the enemy — measured, that mutant survived every other
    // assertion in this block.
    const { state, ally, mother } = board(1);
    const enemy = makeUnit({ instanceId: "enemy" });
    state.battlefields[0]!.units = { p2: [enemy] };

    const held = discarded(state, mother);
    const decision = held.pendingDecisions.find((d) => d.kind === "VEN-094-pump");
    expect(decision, "nothing was parked").toBeDefined();

    const offered = optionsFor(held, decision!).map((o) => o.instanceId);
    expect(offered, "the friendly unit was not offered").toContain(ally.instanceId);
    expect(offered, "an ENEMY unit was offered").not.toContain(enemy.instanceId);
  });

  it("declining costs nothing", () => {
    const { state, ally, mother } = board(1);
    const after = answerDecisions(discarded(state, mother), (options) => options[0]!.id);
    expect(onBoard(after, ally.instanceId)?.mightThisTurn).toBe(0);
    expect(after.players[0]!.floatingEnergy).toBe(1);
  });

  it("asks NOTHING with no Energy — 416.3", () => {
    // **The trigger is still PLACED, and it cannot be otherwise**:
    // `SelfTriggerDefinition` is `{ on, resolve }` with no `applies` hook, so a
    // self-trigger has no way to refuse the chain slot the way an event trigger
    // does. Flame Chompers — the pool's only other "when you discard me, you may
    // pay" — has exactly this shape and the same consequence.
    //
    // So the affordability gate lives in the RESOLVER, and what it buys is that no
    // question is asked and nothing is spent. The cost is one PassFocus for an
    // ability that resolves to nothing, which is recorded in
    // docs/rules-conformance.md rather than worked around.
    const { state, mother } = board(0);
    const after = answerDecisions(discarded(state, mother));

    expect(after.pendingDecisions, "an unaffordable offer was asked").toEqual([]);
    expect(after.players[0]!.floatingEnergy, "it spent Energy it did not have").toBe(0);
    expect(onBoard(after, "ally")?.mightThisTurn, "it pumped without paying").toBe(0);
  });
});

describe("Shadow Order Disciple (VEN-095): Burn 1 on move for +1 Might", () => {
  function board(): { state: GameState; disciple: UnitInstance } {
    const disciple = realUnitInstance(DISCIPLE);
    const state = makeState();
    state.players[0]!.baseUnits = [disciple];
    state.players[0]!.deck = [spellInstance("VEN-103"), spellInstance("VEN-105")];
    return { state, disciple };
  }

  it("burns the top card and pumps", () => {
    const { state, disciple } = board();
    const moved = resolveHeldTriggers(forceMoveToBattlefield(state, disciple.instanceId, "bf1"));
    const after = answerDecisions(moved, (options) => options[1]!.id);

    expect(onBoard(after, disciple.instanceId)?.mightThisTurn).toBe(1);
    expect(after.players[0]!.trash.map((c) => c.defId), "nothing was burned").toEqual([SHADOWS_OF_THE_PAST]);
    expect(after.players[0]!.deck.length).toBe(1);
  });

  it("declining burns nothing and pumps nothing", () => {
    const { state, disciple } = board();
    const after = answerDecisions(resolveHeldTriggers(forceMoveToBattlefield(state, disciple.instanceId, "bf1")), (o) => o[0]!.id);

    expect(onBoard(after, disciple.instanceId)?.mightThisTurn).toBe(0);
    expect(after.players[0]!.trash, "declining burned anyway").toEqual([]);
  });

  it("NEGATIVE CONTROL: another unit's move offers nothing", () => {
    const { state } = board();
    const other = makeUnit({ instanceId: "other" });
    state.players[0]!.baseUnits = [...state.players[0]!.baseUnits, other];

    const held = forceMoveToBattlefield(state, other.instanceId, "bf1");

    expect(held.pendingTriggers.map((e) => e.listenerDefId), "he was placed for somebody else's move").not.toContain(DISCIPLE);
  });
});

describe("Shadowblade Lurker (VEN-096): 2 less for each card with my name in your trash", () => {
  const priced = (state: GameState) => modifiedEnergyCost(state, 0, "Unit", 5, LURKER);

  it("scales with the copies in your trash", () => {
    for (const [copies, expected] of [[0, 5], [1, 3], [2, 1], [3, 0]] as const) {
      const state = makeState();
      state.players[0]!.trash = Array.from({ length: copies }, () => realUnitInstance(LURKER));
      expect(priced(state), `${copies} copies`).toBe(expected);
    }
  });

  it("counts by NAME, so a reprint under another defId still counts", () => {
    // The card says "with my name", and those answers come apart in this pool:
    // Vendetta reprints ten earlier cards under plain names.
    const state = makeState();
    state.players[0]!.trash = [{ ...realUnitInstance(LURKER), defId: "SOME-OTHER-PRINTING" }];
    expect(priced(state), "it compared defIds").toBe(3);
  });

  it("counts YOUR trash, not the opponent's", () => {
    const state = makeState();
    state.players[1]!.trash = [realUnitInstance(LURKER), realUnitInstance(LURKER)];
    expect(priced(state)).toBe(5);
  });

  it("NEGATIVE CONTROL: another card is unaffected by the same trash", () => {
    const state = makeState();
    state.players[0]!.trash = [realUnitInstance(LURKER), realUnitInstance(LURKER)];
    expect(modifiedEnergyCost(state, 0, "Unit", 5, "OGN-001")).toBe(5);
  });
});

describe("Spiderling (VEN-097): +1 Might per OTHER Spiderling here", () => {
  function board(count: number, atBase = false): { state: GameState; first: UnitInstance } {
    const spiders = Array.from({ length: count }, () => realUnitInstance(SPIDERLING));
    const state = makeState();
    if (atBase) state.players[0]!.baseUnits = spiders;
    else state.battlefields[0]!.units = { p1: spiders };
    return { state, first: spiders[0]! };
  }

  it("scales with the siblings beside it", () => {
    const printed = registry.get(SPIDERLING);
    expect(printed.type).toBe("Unit");
    const base = (printed as Extract<typeof printed, { type: "Unit" }>).might;

    for (const count of [1, 2, 3]) {
      const { state, first } = board(count);
      expect(mightAt(state, onBoard(state, first.instanceId)!, 0, "bf1"), `${count} spiderlings`).toBe(base + (count - 1));
    }
  });

  it("never counts ITSELF", () => {
    const printed = registry.get(SPIDERLING) as Extract<ReturnType<typeof registry.get>, { type: "Unit" }>;
    const { state, first } = board(1);
    expect(mightAt(state, onBoard(state, first.instanceId)!, 0, "bf1"), "it counted itself").toBe(printed.might);
  });

  it("gets nothing in BASE — 'here' is positional", () => {
    const printed = registry.get(SPIDERLING) as Extract<ReturnType<typeof registry.get>, { type: "Unit" }>;
    const { state, first } = board(3, true);
    expect(mightAt(state, state.players[0]!.baseUnits.find((u) => u.instanceId === first.instanceId)!, 0)).toBe(printed.might);
  });

  it("does not count ENEMY Spiderlings at the same battlefield", () => {
    const printed = registry.get(SPIDERLING) as Extract<ReturnType<typeof registry.get>, { type: "Unit" }>;
    const { state, first } = board(1);
    state.battlefields[0]!.units = { ...state.battlefields[0]!.units, p2: [realUnitInstance(SPIDERLING), realUnitInstance(SPIDERLING)] };
    expect(mightAt(state, onBoard(state, first.instanceId)!, 0, "bf1")).toBe(printed.might);
  });
});

describe("Wind and Ghosts (VEN-106): banish it if small, bounce it if big", () => {
  function board(might: number): { state: GameState; victim: UnitInstance } {
    const victim = makeUnit({ instanceId: "victim", might });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [victim] };
    return { state, victim };
  }

  it("BANISHES a unit with 3 Might or less", () => {
    const { state, victim } = board(3);
    const after = castSpell(state, WIND_AND_GHOSTS, 0, { targetUnitInstanceId: victim.instanceId });

    expect(onBoard(after, victim.instanceId)).toBeUndefined();
    expect(after.players[1]!.banished.map((c) => c.instanceId), "it was not banished").toContain(victim.instanceId);
    expect(after.players[1]!.hand, "it went to hand instead").toEqual([]);
  });

  it("...and a banish is NOT a kill — 427.2.a", () => {
    // No `[Deathknell]`, no death-watch, and nothing that prices off deaths pays
    // out. `unitsLostThisTurn` is the readable half of that.
    const { state, victim } = board(3);
    const after = castSpell(state, WIND_AND_GHOSTS, 0, { targetUnitInstanceId: victim.instanceId });
    expect(after.players[1]!.unitsLostThisTurn, "the banish counted as a death").toBe(0);
    expect(after.players[1]!.trash, "it went to the trash").toEqual([]);
  });

  it("BOUNCES a unit above the ceiling", () => {
    const { state, victim } = board(4);
    const after = castSpell(state, WIND_AND_GHOSTS, 0, { targetUnitInstanceId: victim.instanceId });

    expect(onBoard(after, victim.instanceId)).toBeUndefined();
    expect(after.players[1]!.hand.map((c) => c.instanceId), "it was not returned to hand").toContain(victim.instanceId);
    expect(after.players[1]!.banished, "it was banished instead").toEqual([]);
  });

  it("reads EFFECTIVE Might, so a pump changes which half applies", () => {
    const victim = makeUnit({ instanceId: "victim", might: 3, mightThisTurn: 1 });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [victim] };

    const after = castSpell(state, WIND_AND_GHOSTS, 0, { targetUnitInstanceId: victim.instanceId });

    expect(after.players[1]!.hand.map((c) => c.instanceId), "it read printed Might and banished").toContain(victim.instanceId);
  });
});

describe("Twilight Step (VEN-105): move a unit with 3 Might or less", () => {
  it("moves the chosen unit to the chosen battlefield", () => {
    const victim = makeUnit({ instanceId: "victim", might: 3 });
    const state = makeState();
    state.players[1]!.baseUnits = [victim];

    const after = castSpell(state, TWILIGHT_STEP, 0, {
      targetUnitInstanceId: victim.instanceId,
      destinationBattlefieldId: "bf1",
    });

    expect(after.battlefields[0]!.units.p2?.map((u) => u.instanceId), "it did not arrive").toContain(victim.instanceId);
  });

  it("the ceiling is on the SPEC, so a big unit is never offered", () => {
    // For a Spell the targeting IS the effect, so a board with only big units must
    // make this uncastable rather than castable-and-inert.
    const spec = effectForCard(spellInstance(TWILIGHT_STEP))?.targeting;
    expect(spec).toMatchObject({ kind: "unit", scope: "anywhere", maxMight: 3 });
  });
});

describe("Shadows of the Past (VEN-103): return up to 2 units from TRASHES", () => {
  function board(): GameState {
    const state = makeState();
    state.players[0]!.trash = [realUnitInstance(SPIDERLING), spellInstance(TWILIGHT_STEP)];
    state.players[1]!.trash = [realUnitInstance(DISCIPLE)];
    return state;
  }

  it("returns each unit to ITS OWNER's hand, not the caster's", () => {
    // "Trashes", plural, and "their owners' hands" — so this can hand an opponent
    // their own dead unit back. A version that read only the caster's trash would
    // be a different and better card.
    const state = board();
    const theirs = state.players[1]!.trash[0]!;
    const after = answerDecisions(castSpell(state, SHADOWS_OF_THE_PAST, 0, {}), (options) =>
      options.find((o) => o.instanceId === theirs.instanceId)?.id ?? options[0]!.id,
    );

    expect(after.players[1]!.hand.map((c) => c.instanceId), "it did not reach its owner").toContain(theirs.instanceId);
    expect(after.players[0]!.hand.map((c) => c.instanceId), "the caster took somebody else's unit").not.toContain(
      theirs.instanceId,
    );
  });

  it("offers only UNITS, never a spell in the same trash", () => {
    const state = board();
    const spell = state.players[0]!.trash[1]!;
    const held = castSpell(state, SHADOWS_OF_THE_PAST, 0, {});
    const decision = held.pendingDecisions.find((d) => d.kind === "VEN-103-pick");
    expect(decision, "nothing was parked").toBeDefined();

    expect(optionsFor(held, decision!).map((o) => o.instanceId), "a spell was offered").not.toContain(spell.instanceId);
  });

  it("returns TWO when both are taken, and stops there", () => {
    const state = board();
    const after = answerDecisions(castSpell(state, SHADOWS_OF_THE_PAST, 0, {}), (options) => options[1]?.id ?? options[0]!.id);

    const returned = after.players[0]!.hand.length + after.players[1]!.hand.length;
    expect(returned, "it did not return exactly two").toBe(2);
  });

  it("'UP TO' — declining the first returns nothing", () => {
    const state = board();
    const after = answerDecisions(castSpell(state, SHADOWS_OF_THE_PAST, 0, {}), (options) => options[0]!.id);
    expect(after.players[0]!.hand.length + after.players[1]!.hand.length).toBe(0);
  });
});

describe("Forgotten Relic (VEN-108): Burn 1, and pay out only for a UNIT", () => {
  function board(top: UnitInstance | ReturnType<typeof spellInstance>): { state: GameState; relic: ReturnType<typeof realGearInstance>; ally: UnitInstance } {
    const relic = realGearInstance(FORGOTTEN_RELIC);
    const ally = makeUnit({ instanceId: "ally" });
    const state = makeState({ phase: "Beginning" });
    state.players[0]!.activeGear = [relic];
    state.players[0]!.baseUnits = [ally];
    state.players[0]!.deck = [top as never, spellInstance(TWILIGHT_STEP)];
    return { state, relic, ally };
  }

  const beginningPhase = (state: GameState): GameState =>
    resolveHeldTriggers(runCleanup(holdEventTrigger(state, { kind: "beginningPhase", playerIndex: 0 } as never)));

  it("burns, and gives the burned UNIT's Might to a friendly unit", () => {
    const { state, ally } = board(makeUnit({ instanceId: "fodder", might: 4 }));
    const after = answerDecisions(beginningPhase(state), (options) => options[0]!.id);

    expect(after.players[0]!.trash.length, "nothing was burned").toBe(1);
    expect(onBoard(after, ally.instanceId)?.mightThisTurn, "the payout did not match the burned Might").toBe(4);
  });

  it("burns and ASKS NOTHING when the burned card is a spell", () => {
    // **Asserted on the question, not the amount.** A spell has no `might`, so a
    // resolver that paid out for it would carry `undefined` and grant +0 — the
    // same board as not asking at all. Measured: that mutant survived an
    // outcome-only assertion. "When you burn A UNIT this way" means the
    // instruction does not happen, so no question is raised.
    // TWO friendly units, for the same reason the positive control below has
    // them: with ONE the question has a single option and `advanceDecisions`
    // executes it silently, so an incorrectly-raised question is invisible.
    // Measured — the mutant survived until this board had a second ally.
    const { state, ally } = board(spellInstance(TWILIGHT_STEP));
    state.players[0]!.baseUnits = [...state.players[0]!.baseUnits, makeUnit({ instanceId: "ally2" })];
    const held = runCleanup(holdEventTrigger(state, { kind: "beginningPhase", playerIndex: 0 } as never));
    const settled = resolveHeldTriggers(held);

    expect(settled.pendingDecisions.map((d) => d.kind), "a spell raised the give-Might question").not.toContain(
      "VEN-108-give",
    );
    expect(settled.players[0]!.trash.length, "the burn did not happen").toBe(1);
    expect(onBoard(settled, ally.instanceId)?.mightThisTurn, "a spell paid out").toBe(0);
  });

  it("...and the POSITIVE control on that instrument: a unit DOES raise it", () => {
    // TWO friendly units, deliberately: with one there is a single option and
    // `advanceDecisions` executes the question silently, so it is never visible
    // in `pendingDecisions` however correct the card is. The negative assertion
    // above is only meaningful against a control that CAN be seen.
    const { state } = board(makeUnit({ instanceId: "fodder", might: 4 }));
    state.players[0]!.baseUnits = [...state.players[0]!.baseUnits, makeUnit({ instanceId: "ally2" })];

    const settled = resolveHeldTriggers(runCleanup(holdEventTrigger(state, { kind: "beginningPhase", playerIndex: 0 } as never)));

    expect(settled.pendingDecisions.map((d) => d.kind)).toContain("VEN-108-give");
  });
});

describe("Ravenbloom Prefect (VEN-102): banish me to banish an opponent's gear", () => {
  function board(): { state: GameState; prefect: UnitInstance; gear: ReturnType<typeof realGearInstance> } {
    const prefect = realUnitInstance(PREFECT);
    const gear = realGearInstance("OGN-017");
    const state = makeState();
    state.players[0]!.baseUnits = [prefect];
    state.players[1]!.activeGear = [gear];
    return { state, prefect, gear };
  }

  const opponentPlayedGear = (state: GameState, gearInstanceId: string): GameState =>
    resolveHeldTriggers(
      runCleanup(
        holdEventTrigger(state, {
          kind: "cardPlayed",
          casterIndex: 1,
          playedKind: "Gear",
          playedInstanceId: gearInstanceId,
          playedPowerCost: 0,
          isToken: false,
        }),
      ),
    );

  it("banishes BOTH when taken", () => {
    const { state, prefect, gear } = board();
    const after = answerDecisions(opponentPlayedGear(state, gear.instanceId), (options) => options[1]?.id ?? options[0]!.id);

    expect(onBoard(after, prefect.instanceId), "he survived his own cost").toBeUndefined();
    expect(after.players[1]!.activeGear, "the gear survived").toEqual([]);
    expect(after.players[1]!.banished.map((c) => c.instanceId), "the gear was not banished").toContain(gear.instanceId);
  });

  it("...and neither is a KILL — 427.2.a", () => {
    const { state, gear } = board();
    const after = answerDecisions(opponentPlayedGear(state, gear.instanceId), (options) => options[1]?.id ?? options[0]!.id);

    expect(after.players[0]!.trash, "he went to a trash").toEqual([]);
    expect(after.players[0]!.unitsLostThisTurn, "his banish counted as a death").toBe(0);
    expect(after.players[1]!.trash, "the gear went to a trash").toEqual([]);
  });

  it("declining keeps both", () => {
    const { state, prefect, gear } = board();
    const after = answerDecisions(opponentPlayedGear(state, gear.instanceId), (options) => options[0]!.id);

    expect(onBoard(after, prefect.instanceId)).toBeDefined();
    expect(after.players[1]!.activeGear.map((g) => g.instanceId)).toContain(gear.instanceId);
  });

  it("NEGATIVE CONTROL: HIS OWN controller playing a gear offers nothing", () => {
    const { state, gear } = board();
    const held = runCleanup(
      holdEventTrigger(state, {
        kind: "cardPlayed",
        casterIndex: 0,
        playedKind: "Gear",
        playedInstanceId: gear.instanceId,
        playedPowerCost: 0,
        isToken: false,
      }),
    );
    expect(
      [...held.pendingTriggers.map((e) => e.listenerDefId), ...held.spellChain.map((e) => ("listenerDefId" in e ? e.listenerDefId : ""))],
      "he was placed for his own side's gear",
    ).not.toContain(PREFECT);
  });

  it("NEGATIVE CONTROL: an opponent's UNIT offers nothing", () => {
    const { state } = board();
    const held = runCleanup(
      holdEventTrigger(state, {
        kind: "cardPlayed",
        casterIndex: 1,
        playedKind: "Unit",
        playedInstanceId: "some-unit",
        playedPowerCost: 0,
        isToken: false,
      }),
    );
    expect(
      [...held.pendingTriggers.map((e) => e.listenerDefId), ...held.spellChain.map((e) => ("listenerDefId" in e ? e.listenerDefId : ""))],
      "he was placed for a unit",
    ).not.toContain(PREFECT);
  });
});

describe("Minah Swiftfoot (VEN-111): on moving to a battlefield, choose one", () => {
  function board(): { state: GameState; minah: UnitInstance } {
    const minah = realUnitInstance(MINAH);
    const state = makeState();
    state.players[0]!.baseUnits = [minah];
    for (const index of [0, 1] as const) {
      state.players[index]!.hand = [spellInstance(TWILIGHT_STEP)];
      state.players[index]!.deck = [spellInstance(WIND_AND_GHOSTS)];
    }
    return { state, minah };
  }

  it("EACH player discards, when that mode is taken", () => {
    const { state, minah } = board();
    const after = answerDecisions(resolveHeldTriggers(forceMoveToBattlefield(state, minah.instanceId, "bf1")), (options) =>
      options.find((o) => o.id === "discard")!.id,
    );

    expect(after.players[0]!.hand.length, "the caster did not discard").toBe(0);
    expect(after.players[1]!.hand.length, "the opponent did not discard").toBe(0);
  });

  it("EACH player draws, when that mode is taken", () => {
    const { state, minah } = board();
    const after = answerDecisions(resolveHeldTriggers(forceMoveToBattlefield(state, minah.instanceId, "bf1")), (options) =>
      options.find((o) => o.id === "draw")!.id,
    );

    expect(after.players[0]!.hand.length).toBe(2);
    expect(after.players[1]!.hand.length, "only the caster drew").toBe(2);
  });

  it("does NOT fire on a walk home — 'to a battlefield' is printed", () => {
    // `unitMoved.to` is not always a battlefield: 455/456 make a walk home a Move,
    // and the event's own note records two cards being caught paying out for one.
    const minah = realUnitInstance(MINAH);
    const state = makeState();
    state.battlefields[0]!.units = { p1: [minah] };

    const held = forceMoveToBase(state, minah.instanceId);

    expect(held.pendingTriggers.map((e) => e.listenerDefId), "she fired on a walk home").not.toContain(MINAH);
  });
});

describe("coverage sees the wave", () => {
  it("all ten report implemented", () => {
    for (const id of [
      MASK_MOTHER,
      DISCIPLE,
      LURKER,
      SPIDERLING,
      PREFECT,
      SHADOWS_OF_THE_PAST,
      TWILIGHT_STEP,
      WIND_AND_GHOSTS,
      FORGOTTEN_RELIC,
      MINAH,
    ]) {
      expect(isCardImplemented(registry.get(id)), `${id} ${registry.get(id).name} still reports unimplemented`).toBe(true);
    }
  });
});
