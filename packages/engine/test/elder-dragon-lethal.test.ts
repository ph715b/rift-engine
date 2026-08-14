import { describe, expect, it } from "vitest";
import { dealDamage } from "../src/engine/effect-helpers.js";
import { anyDamageIsLethalTo } from "../src/engine/damage-modifiers.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { beginCombatAt, makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * **UNL-118 Elder Dragon — "Any amount of your damage is enough to kill enemy
 * units."**
 *
 * **Rule 142.4.c names this card by hand**, so the reading needs no
 * interpretation: "Some effects may alter this amount... Example: Elder Dragon's
 * passive ability reads 'Any amount of your damage is enough to kill enemy
 * units.' This alters the Lethal Damage value for enemy units that have damage
 * marked by you."
 *
 * It changes LETHAL DAMAGE (142.4.a), not the damage dealt. That is why it lives
 * in the lethal test and in `combat.remainingMight` rather than in
 * `modifiedDamageAmount`: the Dragon does not turn a 1 into a 5, he makes 1
 * enough.
 *
 * # The refusal was half right, and the half it got wrong is worth stating
 *
 * It said 142.4.c "needs per-marker damage (UnitInstance.damage is one
 * unattributed number)". Measured, both sites that ask already know who dealt
 * it: `dealDamage` is handed the `casterIndex`, and combat damage to one side
 * comes from the other by construction. So no model change was needed at all.
 *
 * # Both sites, because one is not the other
 *
 * `combat.remainingMight` is asked TWICE per fight — once by `distribute` to
 * decide how much damage to ASSIGN, and once by `removeDefeated` to decide who
 * DIED. Overriding only the first would hand every enemy exactly 1 damage and
 * then rule them all survivors, which is why the combat test asserts deaths
 * rather than damage.
 */

const registry = defaultCardRegistry();
const ELDER_DRAGON = "UNL-118";

/** The Dragon in player 0's base, and `enemyMight`-Might enemies at bf1. */
function board(enemyMight: number, enemies = 1, dragon = true): { state: GameState; enemies: UnitInstance[] } {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  const units = Array.from({ length: enemies }, (_, i) =>
    makeUnit({ instanceId: `enemy-${i}`, might: enemyMight }),
  );
  if (dragon) state.players[0]!.baseUnits = [realUnitInstance(ELDER_DRAGON)];
  state.battlefields[0]!.units = { [state.players[1]!.id]: units };
  return { state, enemies: units };
}

const alive = (state: GameState, instanceId: string): boolean =>
  [
    ...state.players.flatMap((p) => p.baseUnits),
    ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
  ].some((u) => u.instanceId === instanceId);

describe("spell and ability damage", () => {
  it("1 damage kills a 9-Might enemy while the Dragon is in play", () => {
    const { state, enemies } = board(9);
    const after = resolveHeldTriggers(dealDamage(state, 0, enemies[0]!.instanceId, 1));

    expect(alive(after, enemies[0]!.instanceId), "a 9-Might unit survived 1 damage with a Dragon out").toBe(false);
  });

  it("PAIRED CONTROL: the same 1 damage leaves it standing with no Dragon", () => {
    // One card apart. Without this the test above passes just as well if
    // `dealDamage` had started killing everything.
    const { state, enemies } = board(9, 1, false);
    const after = resolveHeldTriggers(dealDamage(state, 0, enemies[0]!.instanceId, 1));

    expect(alive(after, enemies[0]!.instanceId), "1 damage killed a 9-Might unit with no Dragon").toBe(true);
  });

  it("does NOT make the Dragon's own side easier to kill", () => {
    // "ENEMY units", measured from the Dragon's seat. Asserted because the
    // cheapest wrong implementation — "any damage is lethal while a Dragon is
    // anywhere" — kills his own board too, and would pass every test above.
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.baseUnits = [realUnitInstance(ELDER_DRAGON), makeUnit({ instanceId: "friend", might: 9 })];

    const after = resolveHeldTriggers(dealDamage(state, 1, "friend", 1));
    expect(alive(after, "friend"), "the Dragon made his own unit die to 1 damage").toBe(true);
  });

  it("does not fire on damage the Dragon's controller did not deal", () => {
    // The opponent damaging their OWN unit is not "your damage". `casterIndex`
    // is what says so.
    const { state, enemies } = board(9);
    const after = resolveHeldTriggers(dealDamage(state, 1, enemies[0]!.instanceId, 1));

    expect(alive(after, enemies[0]!.instanceId), "an enemy's own damage killed through the Dragon").toBe(true);
  });

  it("needs a non-zero amount — 142.4.b's own floor", () => {
    // "Any AMOUNT" still means some. A prevented or zeroed hit marks nothing, and
    // 142.4.b makes Lethal Damage "a non-zero amount".
    const { state, enemies } = board(9);
    const after = resolveHeldTriggers(dealDamage(state, 0, enemies[0]!.instanceId, 0));

    expect(alive(after, enemies[0]!.instanceId), "0 damage killed through the Dragon").toBe(true);
  });
});

describe("combat damage", () => {
  it("a single small attacker kills MULTIPLE big defenders", () => {
    // The shape that only works if the override is in `remainingMight` itself:
    // one 2-Might attacker has 2 damage to spend, each defender needs 1, so both
    // die. Asserted through DEATHS, because rule 466 step 3c heals every unit at
    // the end of combat and reading damage afterwards always shows 0.
    const { state, enemies } = board(9, 2);
    state.battlefields[0]!.units[state.players[0]!.id] = [makeUnit({ instanceId: "attacker", might: 2 })];

    const after = resolveHeldTriggers(resolveShowdown(beginCombatAt(state, state.battlefields[0]!.id, 0), state.battlefields[0]!.id, 0));

    expect(alive(after, enemies[0]!.instanceId), "the first defender survived").toBe(false);
    expect(alive(after, enemies[1]!.instanceId), "the second defender survived — assignment was not 1 each").toBe(
      false,
    );
  });

  it("PAIRED CONTROL: with no Dragon the same attacker kills neither", () => {
    const { state, enemies } = board(9, 2, false);
    state.battlefields[0]!.units[state.players[0]!.id] = [makeUnit({ instanceId: "attacker", might: 2 })];

    const after = resolveHeldTriggers(resolveShowdown(beginCombatAt(state, state.battlefields[0]!.id, 0), state.battlefields[0]!.id, 0));

    expect(alive(after, enemies[0]!.instanceId), "a 9-Might defender died to 2 damage with no Dragon").toBe(true);
    expect(alive(after, enemies[1]!.instanceId)).toBe(true);
  });

  it("the Dragon's own units still need their full Might", () => {
    // The combat mirror of the "not his own side" test above, and the one that
    // catches an override ignoring `ownerIndex`.
    //
    // **Deliberately LOPSIDED.** The first version of this used 9 Might against
    // 9 and proved nothing: an even trade kills both units in ordinary combat, so
    // "his unit died" was true whether or not the override leaked. A 1-Might
    // enemy deals 1, which is lethal to his 9-Might unit ONLY if the override
    // wrongly reaches the Dragon's own side.
    const { state } = board(1, 1);
    state.battlefields[0]!.units[state.players[0]!.id] = [makeUnit({ instanceId: "mine", might: 9 })];

    const after = resolveHeldTriggers(
      resolveShowdown(beginCombatAt(state, state.battlefields[0]!.id, 0), state.battlefields[0]!.id, 0),
    );
    expect(alive(after, "mine"), "1 damage killed the Dragon's own 9-Might unit").toBe(true);
  });
});

describe("the predicate itself", () => {
  it("answers for the seat OPPOSING the Dragon, from either of his zones", () => {
    // A positive control on the mechanism, and on `inPlay` reaching both zones —
    // he grants from base (used by every test above) and from a battlefield.
    const { state } = board(9);
    expect(anyDamageIsLethalTo(state, 1), "an enemy of the Dragon is not covered").toBe(true);
    expect(anyDamageIsLethalTo(state, 0), "the Dragon's own side is covered").toBe(false);

    const atBattlefield = makeState({ phase: "Action", activePlayerIndex: 0 });
    atBattlefield.battlefields[0]!.units = { [atBattlefield.players[0]!.id]: [realUnitInstance(ELDER_DRAGON)] };
    expect(anyDamageIsLethalTo(atBattlefield, 1), "he grants nothing from a battlefield").toBe(true);

    const none = makeState({ phase: "Action", activePlayerIndex: 0 });
    expect(anyDamageIsLethalTo(none, 1), "it answers true with no Dragon anywhere").toBe(false);
  });
});

describe("coverage", () => {
  it("reports him finished, with the damage-modifiers claim merged in", () => {
    const def = registry.get(ELDER_DRAGON);
    expect(isCardImplemented(def), "he still reports unfinished").toBe(true);
    expect(partialImplementationNote(def), "he still carries a partial note").toBeUndefined();
  });
});
