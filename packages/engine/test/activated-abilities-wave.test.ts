import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { addBuff, spendBuff } from "../src/engine/effect-helpers.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * Three activated abilities, plus the assignment tier one of them needed.
 *
 * The shared risk: an ability's restriction has to be asked where the ability is
 * OFFERED, not inside its resolver. A resolver that refuses has already taken the
 * exhaust, so the player pays for nothing — and nothing about the board says so.
 */

const registry = defaultCardRegistry();
const LEE_SIN_ASCETIC = "OGN-078"; // "Exhaust: Buff me. I can have any number of buffs."
const CAITLYN = "OGN-068"; // Backline prose + "Exhaust: deal damage equal to my Might, only while at a battlefield"
const RAVENBORN_TOME = "OGN-032"; // "Exhaust: The next spell you play this turn deals 1 Bonus Damage."
const HEXTECH_RAY = "OGN-009"; // Fury 1E/1P — "Deal 3 to a unit at a battlefield"

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const activationsOf = (state: GameState, instanceId: string) =>
  legalActions(state).filter((a) => a.type === "ActivateAbility" && a.permanentInstanceId === instanceId);

const unitAt = (state: GameState, instanceId: string, owner: string) =>
  [...(state.players[owner === "p1" ? 0 : 1]!.baseUnits ?? []), ...state.battlefields.flatMap((bf) => bf.units[owner] ?? [])].find(
    (u) => u.instanceId === instanceId,
  );

describe("Lee Sin - Ascetic (OGN-078): any number of buffs", () => {
  function ascetic(): { state: GameState; id: string } {
    const lee = realUnitInstance(LEE_SIN_ASCETIC);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [lee] };
    return { state, id: lee.instanceId };
  }

  it("STACKS past rule 708's one-buff cap, and each is worth a point of Might", () => {
    // The second sentence is the whole card. Without it, 708 makes the second
    // activation an exhaust for nothing — and it would look like the ability
    // simply working, since the unit is still buffed.
    const { state, id } = ascetic();
    const once = addBuff(state, id);
    const twice = addBuff(once, id);
    const thrice = addBuff(twice, id);

    const might = (s: GameState) => effectiveMight(s, unitAt(s, id, "p1")!, 0, { isCombat: false, battlefieldId: "bf1" });
    expect(might(twice) - might(once), "the second buff was a no-op").toBe(1);
    expect(might(thrice) - might(twice)).toBe(1);
  });

  it("does NOT let an ordinary unit stack — the exception is his alone", () => {
    const plain = makeUnit({ instanceId: "plain", might: 3 });
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [plain] };

    const twice = addBuff(addBuff(state, "plain"), "plain");
    expect(effectiveMight(twice, unitAt(twice, "plain", "p1")!, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(4);
  });

  it("spending a buff takes an EXTRA first and leaves him buffed", () => {
    // 705 spends ONE buff. With three on him, two spends still leave him buffed —
    // which is what every other reader of that boolean depends on.
    const { state, id } = ascetic();
    const thrice = addBuff(addBuff(addBuff(state, id), id), id);

    const once = spendBuff(thrice, 0, id)!;
    expect(unitAt(once, id, "p1")!.buffed, "spending one unbuffed him entirely").toBe(true);
    const twice = spendBuff(once, 0, id)!;
    expect(unitAt(twice, id, "p1")!.buffed).toBe(true);
    const thrice2 = spendBuff(twice, 0, id)!;
    expect(unitAt(thrice2, id, "p1")!.buffed, "the last buff did not clear the flag").toBe(false);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(LEE_SIN_ASCETIC))).toBe(true);
  });
});

describe("Caitlyn - Patrolling (OGN-068)", () => {
  function caitlyn(at: "bf1" | "base"): { state: GameState; id: string } {
    const cait = realUnitInstance(CAITLYN);
    const state = makeState({ phase: "Action" });
    if (at === "bf1") state.battlefields[0]!.units = { p1: [cait] };
    else state.players[0]!.baseUnits = [cait];
    state.battlefields[1]!.units = { p2: [makeUnit({ instanceId: "victim", might: 9 })] };
    return { state, id: cait.instanceId };
  }

  it("is NOT offered while she stands in base — 'only while I'm at a battlefield'", () => {
    // Asked where the ability is OFFERED. A guard inside the resolver would have
    // taken her exhaust and done nothing.
    expect(activationsOf(caitlyn("base").state, caitlyn("base").id)).toHaveLength(0);
  });

  it("deals damage equal to her EFFECTIVE Might", () => {
    const { state, id } = caitlyn("bf1");
    const pumped: GameState = {
      ...state,
      battlefields: state.battlefields.map((bf, i) =>
        i === 0 ? { ...bf, units: { p1: [{ ...state.battlefields[0]!.units["p1"]![0]!, mightThisTurn: 2 }] } } : bf,
      ),
    };
    const printed = registry.get(CAITLYN);
    const expected = (printed.type === "Unit" ? printed.might : 0) + 2;

    const shot = activationsOf(pumped, id).find((a) => a.type === "ActivateAbility" && a.targetUnitInstanceId === "victim");
    expect(shot, "the shot was not offered").toBeDefined();
    const after = accept(pumped, shot!);
    expect(unitAt(after, "victim", "p2")?.damage ?? "dead", `expected ${expected}`).toBe(expected);
  });

  it("must be assigned combat damage LAST — Backline as printed prose", () => {
    // Her other sentence, and it is combat's assignment order rather than
    // anything `legalActions` can see — so it is driven through a real fight and
    // asserted on who DIES.
    //
    // Caitlyn stands FIRST in board order, so without the Backline tier the
    // attacker's 1 damage lands on her. With it, the 1-Might unit behind her
    // takes it and dies. The two outcomes are different units, which is what
    // makes this discriminating rather than merely green.
    const cait = realUnitInstance(CAITLYN);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = {
      p1: [cait, makeUnit({ instanceId: "chaff", might: 1 })],
      p2: [makeUnit({ instanceId: "attacker", might: 1 })],
    };

    // Asserted on the DEATH, not on marked damage: combat heals its survivors at
    // 466 step 3c, so `damage` is 0 afterwards whoever was hit. Who is left
    // standing is the only thing that survives the heal — and it is exactly what
    // differs between the two orders.
    const settled = resolveShowdown(state, "bf1", 1);
    expect(unitAt(settled, "chaff", "p1"), "the damage did not go to the back — Caitlyn shielded nobody").toBeUndefined();
    expect(unitAt(settled, cait.instanceId, "p1"), "Caitlyn should have survived behind the chaff").toBeDefined();
  });

  it("is still ASSIGNABLE when she is alone — the tier is an order, not immunity", () => {
    // The control. "Last" among one unit is still first, so a lone Caitlyn takes
    // the hit — without this, "Caitlyn survived" above would be equally true of a
    // Backline that excluded her from assignment entirely.
    //
    // A LETHAL attacker, for the same reason the test above asserts a death: a
    // non-lethal hit heals away and leaves nothing to see.
    const cait = realUnitInstance(CAITLYN);
    const printed = registry.get(CAITLYN);
    const lethal = printed.type === "Unit" ? printed.might : 1;
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [cait], p2: [makeUnit({ instanceId: "attacker", might: lethal })] };

    const settled = resolveShowdown(state, "bf1", 1);
    expect(unitAt(settled, cait.instanceId, "p1"), "she was never assigned damage at all").toBeUndefined();
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(CAITLYN))).toBe(true);
  });
});

describe("Ravenborn Tome (OGN-032): the next spell deals 1 Bonus Damage", () => {
  function tomeState(): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [{ ...createCardInstance(registry.get(RAVENBORN_TOME)), instanceId: "tome" } as GearInstance];
    state.players[0]!.hand = [spellInstance(HEXTECH_RAY), spellInstance(HEXTECH_RAY)];
    state.players[0]!.channeled = Array.from({ length: 10 }, (_, i) => rune(`f${i}`, "Fury"));
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "victim", might: 20 })] };
    return state;
  }

  function castRay(state: GameState): GameState {
    const play = legalActions(state).find((a) => a.type === "PlayCard" && a.card.defId === HEXTECH_RAY);
    expect(play, "Hextech Ray was not castable").toBeDefined();
    let current = accept(state, play!);
    for (let guard = 0; guard < 8 && current.spellChain.length > 0; guard += 1) {
      current = accept(current, legalActions(current).find((a) => a.type === "PassFocus")!);
    }
    return current;
  }

  it("adds 1 to the next spell's damage, and only the next one", () => {
    // A charge, not a standing aura — the distinction the card turns on. Hextech
    // Ray deals 3; armed it deals 4, and the second Ray is back to 3.
    const armed = accept(tomeState(), activationsOf(tomeState(), "tome")[0]!);
    expect(armed.players[0]!.nextSpellBonusDamage).toBe(1);

    const first = castRay(armed);
    expect(unitAt(first, "victim", "p2")!.damage, "the bonus never landed").toBe(4);
    expect(first.players[0]!.nextSpellBonusDamage, "the charge survived the spell that used it").toBe(0);

    const second = castRay(first);
    expect(unitAt(second, "victim", "p2")!.damage - 4, "the second spell got the bonus too").toBe(3);
  });

  it("expires with the turn", () => {
    const armed = accept(tomeState(), activationsOf(tomeState(), "tome")[0]!);
    expect(runEnd(armed).players[0]!.nextSpellBonusDamage).toBe(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(RAVENBORN_TOME))).toBe(true);
  });
});
