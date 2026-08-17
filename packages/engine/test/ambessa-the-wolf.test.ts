import { describe, expect, it } from "vitest";
import { effectiveMight } from "../src/engine/effective-might.js";
import { takesNoDamage } from "../src/engine/damage-modifiers.js";
import { empowerPermanent, disempowerPermanent, dealDamage } from "../src/engine/effect-helpers.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type UnitInstance } from "../src/model/card.js";
import { makeState } from "./fixtures.js";
import type { GameState } from "../src/model/game-state.js";

/**
 * Ambessa, The Wolf — "[Empowered][>] I have +3 Might and can't be dealt damage
 * unless I'm in combat."
 *
 * **One printed sentence, two engine seams**, and they are deliberately apart:
 * the Might rides `effective-might` beside the other Empowered auras, the
 * protection rides `damage-modifiers.takesNoDamage` where Kayn - Unleashed
 * already lives. The engine asks the two questions at unrelated choke points, so
 * a single home for both would put one of them somewhere it does not belong.
 *
 * She is NOT in `parseEmpoweredGrant`'s derived table. That reader refuses her
 * clause WHOLE because of the second sentence — the right call, since a
 * partially-granted card looks finished — so both halves are hand-written and
 * both are asserted here.
 *
 * **Her protection is INVERTED relative to Kayn's**: his condition grants
 * immunity, hers REMOVES it. An Ambessa in the thick of a fight is the vulnerable
 * one, which is the card — a body that can only be answered by fighting it.
 */

const registry = defaultCardRegistry();
const AMBESSA = "VEN-084";

const ambessa = (instanceId = "a1"): UnitInstance => ({
  ...(createCardInstance(registry.get(AMBESSA)) as UnitInstance),
  instanceId,
});

/** Ambessa in BASE — never in combat, whatever showdown is open. */
function inBase(unit: UnitInstance): GameState {
  const state = makeState({ phase: "Action" });
  state.players[0]!.baseUnits = [unit];
  return state;
}

/** Ambessa standing at a battlefield with an open Combat Showdown there. */
function inCombat(unit: UnitInstance): GameState {
  const state = makeState({ phase: "Action" });
  const bf = state.battlefields[0]!;
  bf.units[state.players[0]!.id] = [unit];
  state.showdownKind = "Combat";
  state.showdownBattlefieldId = bf.id;
  return state;
}

/** Ambessa at a battlefield while the open combat is somewhere ELSE. */
function atQuietBattlefield(unit: UnitInstance): GameState {
  const state = makeState({ phase: "Action" });
  const [here, elsewhere] = state.battlefields;
  here!.units[state.players[0]!.id] = [unit];
  state.showdownKind = "Combat";
  state.showdownBattlefieldId = elsewhere!.id;
  return state;
}

const her = (state: GameState): UnitInstance => {
  const inBaseUnit = state.players[0]!.baseUnits[0];
  if (inBaseUnit) return inBaseUnit;
  for (const bf of state.battlefields) {
    const found = (bf.units[state.players[0]!.id] ?? [])[0];
    if (found) return found;
  }
  throw new Error("Ambessa is nowhere");
};

describe("Ambessa's Might half", () => {
  it("is +3 only while Empowered, and goes on Disempower (828.1.c)", () => {
    const plain = inBase(ambessa());
    const base = effectiveMight(plain, her(plain), 0, { isCombat: false });

    const empowered = empowerPermanent(plain, "a1");
    expect(effectiveMight(empowered, her(empowered), 0, { isCombat: false }) - base, "the +3 was not granted").toBe(3);

    const off = disempowerPermanent(empowered, "a1");
    expect(effectiveMight(off, her(off), 0, { isCombat: false }), "the bonus outlived the status").toBe(base);
  });
});

describe("Ambessa's damage protection is INVERTED — combat is what exposes her", () => {
  it("takes no damage in BASE while Empowered", () => {
    const state = empowerPermanent(inBase(ambessa()), "a1");
    expect(takesNoDamage(state, her(state)), "an Empowered Ambessa in base was damageable").toBe(true);
  });

  it("IS damageable while in the open combat — 'unless I'm in combat'", () => {
    const state = empowerPermanent(inCombat(ambessa()), "a1");
    expect(takesNoDamage(state, her(state)), "she was protected in the fight she is in").toBe(false);
  });

  it("is protected at a battlefield where the fight is somewhere ELSE", () => {
    // "In combat" is a state question about the OPEN Combat Showdown, not about
    // standing anywhere dangerous — Vex - Cheerless's note settles the phrase.
    const state = empowerPermanent(atQuietBattlefield(ambessa()), "a1");
    expect(takesNoDamage(state, her(state)), "a combat elsewhere exposed her").toBe(true);
  });

  it("is damageable un-Empowered, wherever she stands", () => {
    // The control that ties the protection to the status rather than to the card.
    const base = inBase(ambessa());
    expect(takesNoDamage(base, her(base)), "an un-Empowered Ambessa was protected").toBe(false);
  });

  it("actually survives dealDamage in base, and takes it in combat", () => {
    // Through the real choke point, not just the predicate — `dealDamage` is one
    // of the two callers and the one a spell goes through.
    const safe = empowerPermanent(inBase(ambessa()), "a1");
    const afterSafe = dealDamage(safe, 1, her(safe).instanceId, 3);
    expect(her(afterSafe).damage, "damage was marked on a protected Ambessa").toBe(0);

    const exposed = empowerPermanent(inCombat(ambessa()), "a1");
    const afterExposed = dealDamage(exposed, 1, her(exposed).instanceId, 3);
    expect(her(afterExposed).damage, "damage was not marked on an Ambessa in combat").toBe(3);
  });
});

describe("coverage", () => {
  it("claims her, now that BOTH halves are written", () => {
    expect(isCardImplemented(registry.get(AMBESSA)), "Ambessa is written but unclaimed").toBe(true);
  });
});
