import { describe, expect, it } from "vitest";
import { effectiveMight } from "../src/engine/effective-might.js";
import { effectiveKeywords, isMighty } from "../src/engine/granted-keywords.js";
import { loadBattlefieldDefinitions } from "../src/cards/card-loader.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { makeState, makeUnit, realUnitInstance } from "./fixtures.js";

/**
 * **UNL/VEN battlefields, wave 2 — the CONDITIONAL continuous ones.**
 *
 * Every OGN and SFD entry in `battlefield-continuous.ts` is either flat ("units
 * here have +1 Might") or a board-wide rule. These three read the UNIT — its
 * keywords, or how alone it is — which is why the table grew three fields rather
 * than reusing `mightBonusHere`/`keywordsHere`:
 *
 *   VEN-159 Kinkou Temple     — units here with [Tank] have +1 [Might]
 *   UNL-208 Black Flame Altar — units here with [Temporary] have [Shield]
 *   UNL-210 Forbidding Waste  — a unit here defending ALONE has -2 [Might]
 *
 * # The two things that make this wave delicate
 *
 * **A cycle.** `granted-keywords` imports `effective-might`, so a Might bonus
 * conditioned on a keyword closes a loop. It is threaded through `ctx.mightyCheck`
 * exactly as the existing `[Shield]`/`[Assault]` combat terms are — 476's "each
 * effect applied only a single time", not a recursion guard dressed up as one.
 *
 * **A fast path.** `effectiveKeywords` returns `unit.keywords` untouched when
 * nothing is granting anything, and its guard lists every source it knows about.
 * The Altar's grant had to be added to that list or a `[Temporary]` unit with no
 * other grant would take the fast path and never receive `[Shield]` — implemented
 * and inert, which is this repo's most-repeated defect. The test below stands a
 * unit with NOTHING else going on for exactly that reason.
 */

const KINKOU_TEMPLE = "VEN-159";
const BLACK_FLAME_ALTAR = "UNL-208";
const FORBIDDING_WASTE = "UNL-210";
/** 4 Might, "While I am [Mighty], I have [Deflect], [Ganking], and [Shield]" —
 *  the pool's only unit whose keywords depend on its own Might. */
const FIORA_VICTORIOUS = "OGN-232";

/** bf1 IS the named battlefield, with `units` standing there for p1 and
 *  `enemies` for p2. */
function at(defId: string, units: UnitInstance[], enemies: UnitInstance[] = []): GameState {
  const state = makeState({ phase: "Action" });
  state.battlefields[0] = { ...state.battlefields[0]!, defId, units: { p1: units, p2: enemies } };
  return state;
}

const combat = (isAttackingSide: boolean) =>
  ({ isCombat: true as const, isAttackingSide, combatRole: "remaining" as const, battlefieldId: "bf1" });
const resting = { isCombat: false as const, battlefieldId: "bf1" };

describe("every name in this wave is a battlefield that really prints that text", () => {
  it("matches the printed cards", () => {
    const byId = new Map(loadBattlefieldDefinitions().map((d) => [d.id, d]));
    for (const [defId, name, phrase] of [
      [KINKOU_TEMPLE, "Kinkou Temple", "[Tank]"],
      [BLACK_FLAME_ALTAR, "Black Flame Altar", "[Temporary]"],
      [FORBIDDING_WASTE, "Forbidding Waste", "defending alone"],
    ] as const) {
      const def = byId.get(defId);
      expect(def?.name, `${defId} is not the card this wave thinks it is`).toBe(name);
      expect(def?.text, `${name}'s text has changed under the implementation`).toContain(phrase);
    }
  });
});

describe("Kinkou Temple (VEN-159): +1 Might to [Tank] units here", () => {
  const tank = () => makeUnit({ instanceId: "t", name: "Tank", might: 3, keywords: { Tank: 1 } });
  const plain = () => makeUnit({ instanceId: "p", name: "Plain", might: 3 });

  it("pumps a [Tank] unit standing here", () => {
    const state = at(KINKOU_TEMPLE, [tank()]);
    expect(effectiveMight(state, tank(), 0, resting), "the Tank was not pumped").toBe(4);
  });

  it("leaves a unit WITHOUT [Tank] alone — the control", () => {
    const state = at(KINKOU_TEMPLE, [plain()]);
    expect(effectiveMight(state, plain(), 0, resting), "a non-Tank was pumped").toBe(3);
  });

  it("pumps the OPPONENT's Tank too — 'units here', no owner named", () => {
    // The same reading Trifarian War Camp takes for the same absence of an owner
    // word. A version filtered to friendly units would be strictly better than
    // printed for whoever holds the battlefield.
    const state = at(KINKOU_TEMPLE, [], [tank()]);
    expect(effectiveMight(state, tank(), 1, resting), "the enemy Tank was not pumped").toBe(4);
  });

  it("does not reach a Tank at ANOTHER battlefield", () => {
    const state = at(KINKOU_TEMPLE, [tank()]);
    expect(effectiveMight(state, tank(), 0, { isCombat: false, battlefieldId: "bf2" }), "the aura is not positional").toBe(3);
  });

  it("applies in combat as well as at rest — the bonus is unconditional on fighting", () => {
    const state = at(KINKOU_TEMPLE, [tank()]);
    expect(effectiveMight(state, tank(), 0, combat(true)), "the Tank shrank while attacking").toBeGreaterThanOrEqual(4);
  });

  it("does not blow the stack on a unit whose keywords depend on being [Mighty]", () => {
    // **The cycle, and the only board that reaches it.** `granted-keywords`
    // imports `effective-might`, so a keyword-conditional Might bonus can loop —
    // and it only loops for a unit whose KEYWORDS are themselves conditional on
    // its MIGHT. Fiora - Victorious ("while I'm [Mighty], I have [Deflect],
    // [Ganking] and [Shield]") is the pool's only such card.
    //
    // A plain Tank never reaches it, which is why the first six mutants for this
    // wave all died while removing the `mightyCheck` suppression SURVIVED. This
    // is the test that kills it.
    const fiora = { ...realUnitInstance(FIORA_VICTORIOUS), instanceId: "f", buffed: true };
    const state = at(KINKOU_TEMPLE, [fiora]);
    expect(() => effectiveMight(state, fiora, 0, combat(false)), "the keyword/might cycle is open again").not.toThrow();
  });

  it("...and a unit lifted to 5 by the Temple IS [Mighty], in combat and at rest", () => {
    // **This test is why the cycle guard is not threaded off `ctx.mightyCheck`.**
    // Gating the whole term on it also terminated the recursion, so it looked
    // right — but `isMighty` asks its FIRST question with no `mightyCheck` (the
    // out-of-combat read) and sets it only for the combat read. The bonus would
    // then count at rest and not while fighting: the same unit, Mighty standing
    // still and not Mighty in a fight.
    //
    // A unit lifted to 5 here is Mighty exactly as one lifted by Trifarian War
    // Camp is. 476's suppression is about a keyword that depends on MIGHT, and
    // `[Tank]` does not.
    const brute = makeUnit({ instanceId: "b", name: "Brute", might: 4, keywords: { Tank: 1 } });
    const state = at(KINKOU_TEMPLE, [brute]);
    expect(effectiveMight(state, brute, 0, resting), "the Temple's bonus did not apply at all").toBe(5);
    expect(isMighty(state, brute, 0), "the Temple's own bonus did not make it Mighty").toBe(true);

    // …and the control: one point lower is not Mighty, so the assertion above is
    // about the bonus rather than about the threshold being met anyway.
    const smaller = makeUnit({ instanceId: "s", name: "Smaller", might: 3, keywords: { Tank: 1 } });
    expect(isMighty(at(KINKOU_TEMPLE, [smaller]), smaller, 0), "a 3-Might Tank read as Mighty").toBe(false);
  });

  it("counts toward [Mighty] on the IN-COMBAT read too, not only at rest", () => {
    // **The test that pins the guard, and it took a mutant to find.** `isMighty`
    // answers from the out-of-combat read FIRST and returns early when that
    // already says yes — so a unit Mighty at rest can never tell you whether the
    // combat read agrees. Gating this term on `ctx.mightyCheck` therefore passed
    // every assertion above while silently making the same unit Mighty standing
    // still and not Mighty in a fight.
    //
    // The discriminating board is a unit that is NOT Mighty at rest and IS in
    // combat: a 3-Might `[Tank]` with `[Shield 1]`, defending. 3 + 1 (Shield,
    // defending, "remaining") + 1 (the Temple) = 5, where at rest it is 4.
    const shieldTank = makeUnit({
      instanceId: "st",
      name: "Shield Tank",
      might: 3,
      keywords: { Tank: 1, Shield: 1 },
    });
    const state: GameState = {
      ...at(KINKOU_TEMPLE, [shieldTank], [makeUnit({ instanceId: "e", name: "Enemy", might: 4 })]),
      turnState: "Showdown",
      showdownKind: "Combat",
      showdownBattlefieldId: "bf1",
      // The attacker is `activePlayerIndex`, which is what `isMighty` reads to
      // decide which side this unit is on — p1 must be DEFENDING for [Shield].
      activePlayerIndex: 1,
    };

    expect(effectiveMight(state, shieldTank, 0, resting), "it is already Mighty at rest — the test proves nothing").toBe(4);
    expect(isMighty(state, shieldTank, 0), "the Temple's bonus did not reach the in-combat Mighty read").toBe(true);
  });
});

describe("Black Flame Altar (UNL-208): [Temporary] units here have [Shield]", () => {
  const temp = () => makeUnit({ instanceId: "t", name: "Temp", might: 3, keywords: { Temporary: 1 } });
  const plain = () => makeUnit({ instanceId: "p", name: "Plain", might: 3 });

  it("grants [Shield] to a bare [Temporary] unit — the FAST PATH case", () => {
    // **The unit has nothing else going on**, deliberately: no aura, no
    // Equipment, no this-turn grant, no Empowered clause. That is exactly the
    // state `effectiveKeywords`' fast path returns early for, so this is the test
    // that would fail against a version that added the fold and forgot the guard.
    const state = at(BLACK_FLAME_ALTAR, [temp()]);
    expect(effectiveKeywords(state, temp(), 0).Shield, "a bare Temporary unit got no [Shield]").toBe(1);
  });

  it("leaves a unit without [Temporary] alone", () => {
    const state = at(BLACK_FLAME_ALTAR, [plain()]);
    expect(effectiveKeywords(state, plain(), 0).Shield ?? 0, "a non-Temporary unit got [Shield]").toBe(0);
  });

  it("SUMS with a printed [Shield] rather than replacing it — 814.2", () => {
    // The grant is an additional source, so a unit that already prints [Shield]
    // reads 2. Folding it as an assignment would silently weaken such a unit.
    const both = makeUnit({ instanceId: "b", name: "Both", might: 3, keywords: { Temporary: 1, Shield: 1 } });
    const state = at(BLACK_FLAME_ALTAR, [both]);
    expect(effectiveKeywords(state, both, 0).Shield, "the two sources did not sum").toBe(2);
  });

  it("does not reach a [Temporary] unit at another battlefield", () => {
    const state = at(BLACK_FLAME_ALTAR, [temp()]);
    const elsewhere = { ...state, battlefields: state.battlefields.map((b, i) => (i === 0 ? { ...b, units: {} } : { ...b, units: { p1: [temp()] } })) };
    expect(effectiveKeywords(elsewhere, temp(), 0).Shield ?? 0, "the grant is not positional").toBe(0);
  });

  it("reaches the opponent's [Temporary] unit too", () => {
    const state = at(BLACK_FLAME_ALTAR, [], [temp()]);
    expect(effectiveKeywords(state, temp(), 1).Shield, "the enemy's Temporary unit got no [Shield]").toBe(1);
  });
});

describe("Forbidding Waste (UNL-210): -2 Might while defending alone", () => {
  const lone = () => makeUnit({ instanceId: "l", name: "Lone", might: 5 });
  const friend = () => makeUnit({ instanceId: "f", name: "Friend", might: 2 });

  it("shrinks a lone DEFENDER", () => {
    const state = at(FORBIDDING_WASTE, [lone()], [makeUnit({ instanceId: "e", name: "Enemy", might: 4 })]);
    expect(effectiveMight(state, lone(), 0, combat(false)), "the lone defender was not shrunk").toBe(3);
  });

  it("does NOT shrink it while ATTACKING — the card says defending", () => {
    const state = at(FORBIDDING_WASTE, [lone()], [makeUnit({ instanceId: "e", name: "Enemy", might: 4 })]);
    expect(effectiveMight(state, lone(), 0, combat(true)), "an attacker was shrunk").toBe(5);
  });

  it("does NOT shrink it outside combat at all", () => {
    const state = at(FORBIDDING_WASTE, [lone()]);
    expect(effectiveMight(state, lone(), 0, resting), "a unit at rest was shrunk").toBe(5);
  });

  it("does not shrink it with a FRIEND here — 'no other friendly units here'", () => {
    const state = at(FORBIDDING_WASTE, [lone(), friend()], [makeUnit({ instanceId: "e", name: "Enemy", might: 4 })]);
    expect(effectiveMight(state, lone(), 0, combat(false)), "it was shrunk with company").toBe(5);
  });

  it("an ENEMY standing opposite is not company", () => {
    // The reminder text says "no other FRIENDLY units here", so the whole enemy
    // side does not count — which is the reading that makes the card do anything
    // at all, since a defender always has an attacker opposite.
    const state = at(FORBIDDING_WASTE, [lone()], [
      makeUnit({ instanceId: "e1", name: "E1", might: 4 }),
      makeUnit({ instanceId: "e2", name: "E2", might: 4 }),
    ]);
    expect(effectiveMight(state, lone(), 0, combat(false)), "enemies were counted as company").toBe(3);
  });

  it("floors at 0 rather than going negative", () => {
    const tiny = makeUnit({ instanceId: "t", name: "Tiny", might: 1 });
    const state = at(FORBIDDING_WASTE, [tiny], [makeUnit({ instanceId: "e", name: "Enemy", might: 4 })]);
    expect(effectiveMight(state, tiny, 0, combat(false)), "Might went below zero").toBe(0);
  });
});
