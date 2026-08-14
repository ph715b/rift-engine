import { describe, expect, it } from "vitest";
import { dealDamage } from "../src/engine/effect-helpers.js";
import { resolveCardEffect } from "../src/engine/card-effect-resolution.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState, SpellChainEntry } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { beginCombatAt, makeState, makeUnit, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * **UNL-013 Lotus Trap — "Choose a unit. Double all damage that would be dealt
 * to it this turn."**
 *
 * A Replacement Effect (369.1's "would") armed for the TURN on one unit.
 *
 * # 465.2.c.5 works this card by name, and it makes combat DIFFERENT
 *
 * > "When assigning damage in this way, replacement effects that would apply to
 * > the resulting damage are considered to apply to the assignment instead."
 *
 * The rules' own worked example quotes this card's text: an attacker assigning
 * to a doubled 2-Might unit "assign[s] 2 damage to it; 1 damage that doubles to
 * 2 damage as it is assigned to the unit. When that damage is dealt, it doesn't
 * get doubled again."
 *
 * So the doubling has two homes and they are not the same rule:
 *
 *  - **Out of combat** — `dealDamage` multiplies what it deals. A 1 becomes 2.
 *  - **In combat** — `assignmentNeeded` HALVES what the unit costs to kill
 *    (rounded up) and `applyDamage` restores it. A doubled 4-Might unit costs an
 *    attacker 2, not 4.
 *
 * They cannot compound, because combat never routes through `dealDamage` — and
 * the combat test below would catch it if they did, since a 2-Might attacker
 * would then kill a unit it should only wound.
 */

const registry = defaultCardRegistry();
const LOTUS_TRAP = "UNL-013";

/** Arms the Trap on `targetId`, the way a popped chain entry would. */
const trap = (state: GameState, targetId: string): GameState =>
  resolveHeldTriggers(
    resolveCardEffect(state, {
      card: spellInstance(LOTUS_TRAP),
      playerIndex: 0,
      payment: { energyRunes: [], powerRunes: [] },
      targetUnitInstanceId: targetId,
    } as SpellChainEntry),
  );

function board(might: number): { state: GameState; victim: UnitInstance } {
  const victim = makeUnit({ instanceId: "victim", might });
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.battlefields[0]!.units = { [state.players[1]!.id]: [victim] };
  return { state, victim };
}

const unitAt = (state: GameState, id: string): UnitInstance | undefined =>
  [
    ...state.players.flatMap((p) => p.baseUnits),
    ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
  ].find((u) => u.instanceId === id);

describe("out of combat, the amount doubles as it is dealt", () => {
  it("2 damage becomes 4", () => {
    const { state, victim } = board(9);
    const armed = trap(state, victim.instanceId);
    expect(armed.damageDoubledUnitInstanceIds, "the Trap armed nothing").toContain(victim.instanceId);

    const after = resolveHeldTriggers(dealDamage(armed, 0, victim.instanceId, 2));
    expect(unitAt(after, victim.instanceId)!.damage, "the damage was not doubled").toBe(4);
  });

  it("PAIRED CONTROL: the same 2 stays 2 on an unarmed unit", () => {
    const { state, victim } = board(9);
    const after = resolveHeldTriggers(dealDamage(state, 0, victim.instanceId, 2));
    expect(unitAt(after, victim.instanceId)!.damage, "damage doubled with no Trap").toBe(2);
  });

  it("arms only the unit it named", () => {
    const { state, victim } = board(9);
    const bystander = makeUnit({ instanceId: "bystander", might: 9 });
    state.battlefields[0]!.units[state.players[1]!.id]!.push(bystander);

    const armed = trap(state, victim.instanceId);
    const after = resolveHeldTriggers(dealDamage(armed, 0, "bystander", 2));
    expect(unitAt(after, "bystander")!.damage, "an unarmed unit took doubled damage").toBe(2);
  });

  it("doubles the MODIFIED amount, not the printed one", () => {
    // "All damage that would be dealt to it" is what the hit had become by the
    // time it lands, so the doubling is last. This is measured through the
    // ordering rather than through a bonus card: dealing 3 to a doubled unit
    // gives 6, which a "double the printed number then add" order could not.
    const { state, victim } = board(20);
    const after = resolveHeldTriggers(dealDamage(trap(state, victim.instanceId), 0, victim.instanceId, 3));
    expect(unitAt(after, victim.instanceId)!.damage).toBe(6);
  });

  it("expires with the turn", () => {
    const { state, victim } = board(9);
    const armed = trap(state, victim.instanceId);
    const ended = runEnd({ ...armed, phase: "Action" });

    expect(ended.damageDoubledUnitInstanceIds, "the doubling outlived the turn").toEqual([]);
    const after = resolveHeldTriggers(dealDamage(ended, 0, victim.instanceId, 2));
    expect(unitAt(after, victim.instanceId)!.damage, "it doubled a turn too late").toBe(2);
  });
});

describe("in combat, 465.2.c.5 moves the doubling onto the ASSIGNMENT", () => {
  it("a doubled defender costs HALF the pool, freeing the rest for another target", () => {
    // **Two defenders, and that is the whole point of the fixture.** With one, the
    // halving is unobservable: `distribute` caps each hit at the remaining pool
    // and then dumps any leftover on the last target, so a doubled unit dies
    // either way and mutation testing showed exactly that — removing the halving
    // left a one-defender test green.
    //
    // 6 Might of attacker against two 4-Might defenders, the first doubled:
    //   halved   — A needs 2, doubles to 4, dies; the other 4 kills B.  BOTH die.
    //   unhalved — A is assigned its full 4 (overkilling to 8); only 2 is left
    //              for B, which survives.                                ONE dies.
    const { state, victim } = board(4);
    const second = makeUnit({ instanceId: "second", might: 4 });
    state.battlefields[0]!.units[state.players[1]!.id]!.push(second);
    state.battlefields[0]!.units[state.players[0]!.id] = [makeUnit({ instanceId: "attacker", might: 6 })];
    const armed = trap(state, victim.instanceId);

    const after = resolveHeldTriggers(
      resolveShowdown(beginCombatAt(armed, armed.battlefields[0]!.id, 0), armed.battlefields[0]!.id, 0),
    );
    expect(unitAt(after, victim.instanceId), "the doubled defender survived a lethal assignment").toBeUndefined();
    expect(unitAt(after, "second"), "the halving did not free the rest of the pool").toBeUndefined();
  });

  it("PAIRED CONTROL: undoubled, the same attacker leaves it standing", () => {
    const { state, victim } = board(4);
    state.battlefields[0]!.units[state.players[0]!.id] = [makeUnit({ instanceId: "attacker", might: 2 })];

    const after = resolveHeldTriggers(
      resolveShowdown(beginCombatAt(state, state.battlefields[0]!.id, 0), state.battlefields[0]!.id, 0),
    );
    expect(unitAt(after, victim.instanceId), "a 4-Might unit died to 2 damage with no Trap").toBeDefined();
  });

  it("does NOT compound — combat doubles once, not twice", () => {
    // The bug this card's two homes could produce: if `applyDamage` doubled AND
    // `dealDamage` were somehow in the path, a 1-Might attacker would kill a
    // doubled 3-Might unit (1 -> 2 -> 4). It should not: 1 assigned doubles to 2,
    // and 2 < 3.
    const { state, victim } = board(3);
    state.battlefields[0]!.units[state.players[0]!.id] = [makeUnit({ instanceId: "attacker", might: 1 })];
    const armed = trap(state, victim.instanceId);

    const after = resolveHeldTriggers(
      resolveShowdown(beginCombatAt(armed, armed.battlefields[0]!.id, 0), armed.battlefields[0]!.id, 0),
    );
    expect(unitAt(after, victim.instanceId), "the doubling compounded — 1 became 4").toBeDefined();
  });

  it("rounds the halved assignment UP, so an odd Might is still reachable", () => {
    // A doubled 3-Might unit needs ceil(3/2) = 2 assigned, doubling to 4. Rounding
    // DOWN would ask for 1, double to 2, and leave it alive — the unit would be
    // strictly harder to kill for being Trapped.
    //
    // A second, fat defender is present to soak the remainder. Without it
    // `distribute`'s trailing "dump what is left on the last target" hands the
    // spare point back to the doubled unit and the rounding stops mattering —
    // mutation testing caught that too.
    const { state, victim } = board(3);
    state.battlefields[0]!.units[state.players[1]!.id]!.push(makeUnit({ instanceId: "soak", might: 9 }));
    state.battlefields[0]!.units[state.players[0]!.id] = [makeUnit({ instanceId: "attacker", might: 2 })];
    const armed = trap(state, victim.instanceId);

    const after = resolveHeldTriggers(
      resolveShowdown(beginCombatAt(armed, armed.battlefields[0]!.id, 0), armed.battlefields[0]!.id, 0),
    );
    expect(unitAt(after, victim.instanceId), "the halved assignment rounded down and left it alive").toBeUndefined();
  });
});

describe("coverage", () => {
  it("reports the card finished", () => {
    const def = registry.get(LOTUS_TRAP);
    expect(isCardImplemented(def), "it still reports unfinished").toBe(true);
    expect(partialImplementationNote(def), "it carries a partial note").toBeUndefined();
  });
});
