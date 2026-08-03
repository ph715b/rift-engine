import { describe, expect, it } from "vitest";
import { effectForCard } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { dispatchOnPlayUnit, targetingForUnitTrigger } from "../src/engine/unit-triggers.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit, playUnitTrigger, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * Body-domain card implementations (src/engine/effects/body.ts).
 *
 * Everything here goes through the COMPOSED registries — effectForCard for
 * Spells, dispatchOnPlayUnit for Unit on-play triggers — never the resolver
 * closures directly. That distinction has already caught a real bug once: a
 * Unit registered in a per-domain file was reachable by name but never fired,
 * because dispatch read the inline table instead of the composed one (see
 * effect-registry.test.ts). Calling a resolver directly would have passed.
 */

function resolveSpell(
  defId: string,
  casterIndex: 0 | 1,
  state: ReturnType<typeof makeState>,
  event: Parameters<NonNullable<ReturnType<typeof effectForCard>>["resolve"]>[2] = {},
) {
  const effect = effectForCard(spellInstance(defId));
  expect(effect, `${defId} has no registered effect`).toBeDefined();
  return effect!.resolve(state, contextFor(casterIndex), event);
}

describe("Challenge (OGN-128): a friendly and an enemy unit deal their Mights to each other", () => {
  it("deals the friendly unit's Might to the enemy", () => {
    // Exactly one duellist can survive a Challenge (A survives iff A > B), so
    // the two amounts have to be checked from opposite ends: here the survivor
    // is the enemy, carrying the friendly unit's Might as marked damage.
    const friendly = makeUnit({ might: 2 });
    const enemy = makeUnit({ might: 9 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [friendly], p2: [enemy] };

    state = resolveSpell("OGN-128", 0, state, {
      targetUnitInstanceId: friendly.instanceId,
      secondTargetUnitInstanceId: enemy.instanceId,
    });

    expect(state.battlefields[0]!.units["p2"]![0]!.damage).toBe(2); // the friendly's Might
    expect(state.battlefields[0]!.units["p1"]).toHaveLength(0); // and took 9 back
  });

  it("still deals the dead unit's full Might back — both Mights are snapshotted first", () => {
    // The whole point of the snapshot: a 2-Might enemy killed outright by a
    // 6-Might friendly must STILL land its own 2. Reading Might after the first
    // damage would find the enemy in the trash and deal nothing back, which is
    // the bug this ordering exists to prevent.
    const friendly = makeUnit({ might: 6 });
    const enemy = makeUnit({ might: 2 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [friendly], p2: [enemy] };

    state = resolveSpell("OGN-128", 0, state, {
      targetUnitInstanceId: friendly.instanceId,
      secondTargetUnitInstanceId: enemy.instanceId,
    });

    expect(state.battlefields[0]!.units["p2"]).toHaveLength(0); // enemy died
    expect(state.players[1]!.trash.map((c) => c.instanceId)).toContain(enemy.instanceId);
    expect(state.battlefields[0]!.units["p1"]![0]!.damage).toBe(2); // and hit back anyway
  });

  it("kills both when the exchange is lethal in both directions", () => {
    const friendly = makeUnit({ might: 3 });
    const enemy = makeUnit({ might: 3 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [friendly], p2: [enemy] };

    state = resolveSpell("OGN-128", 0, state, {
      targetUnitInstanceId: friendly.instanceId,
      secondTargetUnitInstanceId: enemy.instanceId,
    });

    expect(state.battlefields[0]!.units["p1"]).toHaveLength(0);
    expect(state.battlefields[0]!.units["p2"]).toHaveLength(0);
  });

  it("reaches units in EITHER player's base — the text names no battlefield", () => {
    const friendly = makeUnit({ might: 4 });
    const enemyAtHome = makeUnit({ might: 1 });
    let state = makeState();
    state.players[0]!.baseUnits = [friendly];
    state.players[1]!.baseUnits = [enemyAtHome];

    state = resolveSpell("OGN-128", 0, state, {
      targetUnitInstanceId: friendly.instanceId,
      secondTargetUnitInstanceId: enemyAtHome.instanceId,
    });

    expect(state.players[1]!.baseUnits).toHaveLength(0); // base is not a safe parking spot
    expect(state.players[0]!.baseUnits[0]!.damage).toBe(1);
    // and the targeting spec says so, which is what legal-actions enumerates from
    const targeting = effectForCard(spellInstance("OGN-128"))!.targeting;
    expect(targeting).toEqual({ kind: "unitSlots", slots: ["friendly", "enemy"], min: 2, scope: "anywhere" });
  });

  it("does nothing when a chosen duellist is no longer in play", () => {
    // Killed earlier on the chain: neither side fights, and the survivor takes
    // no damage from an absent opponent.
    const friendly = makeUnit({ might: 5 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [friendly] };

    const after = resolveSpell("OGN-128", 0, state, {
      targetUnitInstanceId: friendly.instanceId,
      secondTargetUnitInstanceId: "gone-already",
    });

    expect(after).toBe(state); // untouched, not merely equal
    expect(after.battlefields[0]!.units["p1"]![0]!.damage).toBe(0);
  });
});

describe("Wildclaw Shaman (OGN-147): spend a buff to buff me and ready me", () => {
  /** The Shaman as execute-play-card leaves it: already in play, exhausted
   *  (no [Quick]), with its on-play trigger about to fire. */
  function shamanInPlay(): UnitInstance {
    return { ...realUnitInstance("OGN-147"), exhausted: true };
  }

  it("spends the named friendly unit's buff, then buffs and readies itself", () => {
    const donor = makeUnit({ might: 2, buffed: true });
    const shaman = shamanInPlay();
    const state = makeState();
    state.players[0]!.baseUnits = [donor, shaman];

    const after = playUnitTrigger(state, shaman, 0, "base", { additionalCostUnitInstanceId: donor.instanceId });

    expect(after.players[0]!.baseUnits[0]!.buffed).toBe(false); // rule 704.1: the buff is spent
    expect(after.players[0]!.baseUnits[1]!.buffed).toBe(true); // rule 702.3.a: and placed here
    expect(after.players[0]!.baseUnits[1]!.exhausted).toBe(false); // ...and ready
  });

  it("spends a buff off a unit at a battlefield too — the text names no battlefield", () => {
    const donor = makeUnit({ might: 2, buffed: true });
    const shaman = shamanInPlay();
    const state = makeState();
    state.players[0]!.baseUnits = [shaman];
    state.battlefields[0]!.units = { p1: [donor] };

    const after = playUnitTrigger(state, shaman, 0, "base", { additionalCostUnitInstanceId: donor.instanceId });

    expect(after.battlefields[0]!.units["p1"]![0]!.buffed).toBe(false);
    expect(after.players[0]!.baseUnits[0]!.buffed).toBe(true);
    expect(after.players[0]!.baseUnits[0]!.exhausted).toBe(false);
    // Targeting is "none" and the donor rides on the optional-COST field, not on
    // a target. Rule 355.11's "included only as part of a cost" clause is the
    // reason: a cost is not a target. Routing it through the target field is
    // what used to make "you may" collapse into "you must" whenever every
    // friendly unit was already buffed, since the enumeration then had no
    // decline variant to offer.
    expect(targetingForUnitTrigger("OGN-147")).toEqual({ kind: "none" });
  });

  it("gives NOTHING when the named unit has no buff to spend (rule 705)", () => {
    // The spend is a cost. An unpayable cost must not hand over the payoff —
    // this is why spendBuff returns undefined instead of an unchanged state.
    const unbuffed = makeUnit({ might: 2 });
    const shaman = shamanInPlay();
    const state = makeState();
    state.players[0]!.baseUnits = [unbuffed, shaman];

    const after = playUnitTrigger(state, shaman, 0, "base", { additionalCostUnitInstanceId: unbuffed.instanceId });

    // Asserted on the BOARD rather than by object identity: settling a held
    // trigger runs a Cleanup, which always returns a fresh state, so `toBe`
    // stopped meaning "nothing happened" the moment on-play triggers went on
    // the chain. What it was standing in for is asserted directly instead.
    expect(after.players[0]!.baseUnits[1]!.buffed).toBe(false);
    expect(after.players[0]!.baseUnits[1]!.exhausted).toBe(true); // stayed exhausted
    expect(after.players[0]!.baseUnits[0]!.buffed, "the unpayable cost was taken anyway").toBe(false);
  });

  it("cannot spend an ENEMY unit's buff (rule 705.1)", () => {
    const enemyBuffed = makeUnit({ might: 2, buffed: true });
    const shaman = shamanInPlay();
    const state = makeState();
    state.players[0]!.baseUnits = [shaman];
    state.players[1]!.baseUnits = [enemyBuffed];

    const after = playUnitTrigger(state, shaman, 0, "base", { additionalCostUnitInstanceId: enemyBuffed.instanceId });

    expect(after.players[1]!.baseUnits[0]!.buffed).toBe(true); // not touched
    expect(after.players[0]!.baseUnits[0]!.buffed).toBe(false);
    expect(after.players[0]!.baseUnits[0]!.exhausted).toBe(true);
  });

  it("does nothing when no unit was named at all — 'you may' declined, or nothing to name", () => {
    const shaman = shamanInPlay();
    const state = makeState();
    state.players[0]!.baseUnits = [shaman];

    const after = playUnitTrigger(state, shaman, 0, "base", {});

    // Board, not identity — see the note above.
    expect(after.players[0]!.baseUnits[0]!.exhausted).toBe(true);
    expect(after.players[0]!.baseUnits[0]!.buffed, "it buffed itself with nothing named").toBe(false);
  });

  it("still readies itself when it somehow already carries a buff (rule 708 makes the buff a no-op)", () => {
    // The reminder text describes the no-op, it isn't a second mode: adding a
    // buff to an already-buffed unit places nothing (708), but the rest of the
    // ability still happens, so the ready is not lost with it.
    const donor = makeUnit({ might: 2, buffed: true });
    const shaman = { ...shamanInPlay(), buffed: true };
    const state = makeState();
    state.players[0]!.baseUnits = [donor, shaman];

    const after = playUnitTrigger(state, shaman, 0, "base", { additionalCostUnitInstanceId: donor.instanceId });

    expect(after.players[0]!.baseUnits[0]!.buffed).toBe(false); // donor paid
    expect(after.players[0]!.baseUnits[1]!.buffed).toBe(true); // still exactly one buff (707)
    expect(after.players[0]!.baseUnits[1]!.exhausted).toBe(false);
  });
});

/**
 * The reason Wildclaw Shaman's donor rides on `additionalCostUnitInstanceId`
 * rather than on its target field.
 *
 * The first implementation put the choice on the ordinary target, and declining
 * meant "name a unit whose buff can't be spent". That reads fine until every
 * friendly unit IS buffed — then no such unit exists, no decline variant is
 * enumerated, and a card that says "you may" forces the spend. These tests are
 * the ones that fail against that version.
 */
describe("Wildclaw Shaman's 'you may' survives enumeration (rule 355.11: a cost is not a target)", () => {
  const registry = defaultCardRegistry();

  /** A caster holding the Shaman with enough Body runes to pay for it. */
  function shamanInHand(donorBuffed: boolean) {
    const shaman = createCardInstance(registry.get("OGN-147")) as UnitInstance;
    const donor = makeUnit({ might: 2, buffed: donorBuffed });
    const state = makeState({
      players: [
        makePlayer("p1", {
          hand: [shaman],
          baseUnits: [donor],
          channeled: Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, domain: "Body" as const, state: "Ready" as const })),
        }),
        makePlayer("p2"),
      ],
    });
    return { state, shaman, donor };
  }

  const shamanPlays = (state: GameState, shaman: UnitInstance) =>
    legalActions(state).filter((a) => a.type === "PlayCard" && a.card.instanceId === shaman.instanceId);

  it("offers a decline variant AND a spend variant when a buffed unit exists", () => {
    const { state, shaman, donor } = shamanInHand(true);
    const plays = shamanPlays(state, shaman);
    const costs = plays.map((a) => (a.type === "PlayCard" ? a.additionalCostUnitInstanceId : undefined));
    expect(costs).toContain(undefined); // decline
    expect(costs).toContain(donor.instanceId); // spend
  });

  it("STILL offers the decline when every friendly unit is buffed", () => {
    // The regression this whole change exists for.
    const { state, shaman } = shamanInHand(true);
    expect(state.players[0]!.baseUnits.every((u) => u.buffed)).toBe(true);
    const costs = shamanPlays(state, shaman).map((a) => (a.type === "PlayCard" ? a.additionalCostUnitInstanceId : undefined));
    expect(costs).toContain(undefined);
  });

  it("offers only the decline when nothing is buffed — an unpayable cost is not a choice", () => {
    const { state, shaman } = shamanInHand(false);
    const costs = shamanPlays(state, shaman).map((a) => (a.type === "PlayCard" ? a.additionalCostUnitInstanceId : undefined));
    expect([...new Set(costs)]).toEqual([undefined]);
  });

  it("validation rejects naming an unbuffed unit as the cost (rule 705)", () => {
    const { state, shaman, donor } = shamanInHand(false);
    const play = shamanPlays(state, shaman)[0]!;
    expect(play.type).toBe("PlayCard");
    const forged = { ...play, additionalCostUnitInstanceId: donor.instanceId } as typeof play;
    expect(validatePlayCard(state, forged as never).ok).toBe(false);
  });
});
