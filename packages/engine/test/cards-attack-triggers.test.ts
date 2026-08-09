import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * Anivia - Primal (OGN-148) and Warwick - Hunter (OGN-159), the two cluster-1
 * cards whose text lands in `unit-triggers.ts`'s ATTACK_TRIGGERS rather than in a
 * per-domain effects file — there is no per-domain attack-trigger registry, so
 * the pass that implemented the rest of Body could not reach them.
 *
 * **Driven through `submit(MoveUnit)` and then settled.** The move is what starts
 * the fight, but it is not when either of them attacks: an Attack Trigger fires
 * when its unit gains the Attacker designation (383.4.e), which the following
 * Cleanup hands out as the Combat Showdown opens, and it is a Chain Pending Item
 * from that moment — so the effect lands a chain-pop later. `attackWith` below is
 * the whole of that sequence; `test/attack-trigger-moment.test.ts` is where the
 * timing itself is pinned, and it deliberately does not use this.
 *
 * The real action path still matters more than the dispatcher these used to have
 * a sibling for: a trigger can be written, registered and unreachable at the same
 * time, and only `legalActions` -> `submit` rules that out.
 *
 * Warwick's second clause ("I enter ready") is a play-time property and rides
 * card-loader's QUICK_TEXT_OVERRIDES, so it is covered by the play test rather
 * than by a move.
 */

const registry = defaultCardRegistry();
const ANIVIA = "OGN-148";
const WARWICK = "OGN-159";

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `action was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** Fails loudly when the enumerator never offered the action — a trigger that
 *  fires but can only be reached by a move nobody is allowed to make is not
 *  implemented. */
function offered<T>(state: GameState, match: (a: never) => boolean, what: string): T {
  const action = legalActions(state).find(match as (a: unknown) => boolean);
  expect(action, `${what} was never enumerated`).toBeDefined();
  return action as T;
}

/** Walk `unit` into `battlefieldId` and settle the combat that opens there — a
 *  move, a Cleanup that stages the Showdown and holds the Attack Triggers, and
 *  the two passes that resolve them. */
const attackWith = (state: GameState, unit: UnitInstance, battlefieldId = "bf1") =>
  resolveHeldTriggers(accept(state, moveTo(state, unit, battlefieldId)));

const moveTo = (state: GameState, unit: UnitInstance, battlefieldId = "bf1") =>
  offered(
    state,
    ((a: { type: string; destinationBattlefieldId?: string; unitInstanceIds?: string[] }) =>
      a.type === "MoveUnit" &&
      a.destinationBattlefieldId === battlefieldId &&
      (a.unitInstanceIds ?? []).includes(unit.instanceId)) as never,
    `a move of ${unit.name} to ${battlefieldId}`,
  );

const enemiesAt = (state: GameState, battlefieldId = "bf1") =>
  state.battlefields.find((b) => b.id === battlefieldId)!.units["p2"] ?? [];

/** `attacker` in base, ready to walk into a battlefield the opponent holds with
 *  `defenders`. The controllerId matters: walking into a battlefield the mover
 *  does not control is what applies Contested and stages the Showdown. */
function attackState(attacker: UnitInstance, defenders: UnitInstance[]): GameState {
  const state = makeState({ phase: "Action" });
  state.players[0]!.baseUnits = [attacker];
  state.battlefields[0]!.units = { p2: defenders };
  state.battlefields[0]!.controllerId = "p2";
  return state;
}

describe("Anivia - Primal (OGN-148): when I attack, deal 3 to all enemy units here", () => {
  it("hits EVERY enemy unit at the battlefield she walks into", () => {
    // "All enemy units here" is a sweep, not a chosen target — so unlike
    // Crackshot Corsair and Leona - Determined this card carries none of the
    // auto-selection simplification, and the assertion is on all three at once.
    const anivia = realUnitInstance(ANIVIA);
    const state = attackState(anivia, [makeUnit({ name: "A", might: 9 }), makeUnit({ name: "B", might: 9 }), makeUnit({ name: "C", might: 9 })]);

    const after = attackWith(state, anivia);

    expect(enemiesAt(after).map((u) => u.damage)).toEqual([3, 3, 3]);
  });

  it("kills what 3 damage covers, through the ordinary damage funnel", () => {
    const anivia = realUnitInstance(ANIVIA);
    const state = attackState(anivia, [makeUnit({ name: "Frail", might: 3 }), makeUnit({ name: "Tough", might: 9 })]);

    const after = attackWith(state, anivia);

    expect(enemiesAt(after).map((u) => u.name)).toEqual(["Tough"]);
    expect(after.players[1]!.trash).toHaveLength(1);
  });

  it("never damages her own side", () => {
    // The sweep filters on OWNER, so a friendly standing at the destination is
    // untouched — and so is Anivia herself, which is the case a filter written
    // on instance id rather than owner would get wrong.
    const anivia = realUnitInstance(ANIVIA);
    const ally = makeUnit({ name: "Ally", might: 9 });
    const state = attackState(anivia, [makeUnit({ might: 9 })]);
    state.battlefields[0]!.units["p1"] = [ally];

    const after = attackWith(state, anivia);
    const friendly = after.battlefields[0]!.units["p1"] ?? [];

    expect(friendly.every((u) => u.damage === 0)).toBe(true);
  });

  it("does NOT fire when she is DEFENDING — 'when I ATTACK'", () => {
    // The negative control the whole trigger rests on. Same board reversed: she
    // holds bf1 and the opponent walks in, so the Attacker is player 1.
    const anivia = realUnitInstance(ANIVIA);
    const raider = makeUnit({ name: "Raider", might: 9 });
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.players[1]!.baseUnits = [raider];
    state.battlefields[0]!.units = { p1: [anivia] };
    state.battlefields[0]!.controllerId = "p1";

    // Settled, not asserted straight after the move: a trigger that fired for the
    // wrong side would still be waiting on the chain at that point, and an
    // undamaged board would read exactly like one where nothing triggered.
    const after = resolveHeldTriggers(
      accept(
        state,
        offered(
          state,
          ((a: { type: string; destinationBattlefieldId?: string }) =>
            a.type === "MoveUnit" && a.destinationBattlefieldId === "bf1") as never,
          "the opponent's move into bf1",
        ),
      ),
    );

    expect((after.battlefields[0]!.units["p2"] ?? []).every((u) => u.damage === 0)).toBe(true);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(ANIVIA))).toBe(true);
  });
});

describe("Warwick - Hunter (OGN-159): when I attack, kill all DAMAGED enemy units here", () => {
  it("kills only the enemies already carrying damage", () => {
    // "Damaged" is marked damage — what a unit carries between showdowns until
    // Combat Cleanup heals it (466 step 3c). So an undamaged defender survives a
    // trigger that would otherwise wipe the battlefield, which is the whole
    // reason this card is a follow-up punisher and not a board clear.
    const warwick = realUnitInstance(WARWICK);
    const state = attackState(warwick, [
      makeUnit({ name: "Wounded", might: 9, damage: 2 }),
      makeUnit({ name: "Fresh", might: 9 }),
      makeUnit({ name: "Scratched", might: 9, damage: 1 }),
    ]);

    const after = attackWith(state, warwick);

    expect(enemiesAt(after).map((u) => u.name)).toEqual(["Fresh"]);
    expect(after.players[1]!.trash.map((c) => c.name).sort()).toEqual(["Scratched", "Wounded"]);
  });

  it("kills through the death funnel, so a [Deathknell] still fires", () => {
    // Kog'Maw - Caustic: "[Deathknell] — Deal 4 to all units at my battlefield."
    // A filtered rebuild of the unit list would have removed him silently; going
    // through destroyUnit is what makes his death a death.
    const warwick = realUnitInstance(WARWICK);
    const kogmaw = realUnitInstance("OGN-190");
    const state = attackState(warwick, [{ ...kogmaw, damage: 1 } as UnitInstance]);

    const after = attackWith(state, warwick);

    expect(after.players[1]!.trash.map((c) => c.defId)).toContain("OGN-190");
    // His Deathknell hit everything at his battlefield, Warwick included.
    const warwickNow = (after.battlefields[0]!.units["p1"] ?? []).find((u) => u.defId === WARWICK);
    expect(warwickNow === undefined || warwickNow.damage === 4).toBe(true);
  });

  it("does nothing at a battlefield of undamaged defenders", () => {
    const warwick = realUnitInstance(WARWICK);
    const state = attackState(warwick, [makeUnit({ name: "Fresh", might: 9 })]);

    const after = attackWith(state, warwick);

    expect(enemiesAt(after).map((u) => u.name)).toEqual(["Fresh"]);
    expect(after.players[1]!.trash).toHaveLength(0);
  });

  it("leaves a DAMAGED friendly alone — 'enemy units'", () => {
    const warwick = realUnitInstance(WARWICK);
    const hurtAlly = makeUnit({ name: "Ally", might: 9, damage: 3 });
    const state = attackState(warwick, [makeUnit({ might: 9, damage: 1 })]);
    state.battlefields[0]!.units["p1"] = [hurtAlly];

    const after = attackWith(state, warwick);

    expect((after.battlefields[0]!.units["p1"] ?? []).map((u) => u.name)).toContain("Ally");
  });

  it("enters READY — the other half of his text", () => {
    // Prose "I enter ready.", not the bracketed [Quick] the parser looks for, so
    // it rides card-loader's QUICK_TEXT_OVERRIDES. Asserted on a real PLAY,
    // because that is the only moment the property exists.
    const warwick = realUnitInstance(WARWICK);
    expect(warwick.keywords.Quick, "the loader did not turn his prose into [Quick]").toBe(1);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(WARWICK))).toBe(true);
  });
});
