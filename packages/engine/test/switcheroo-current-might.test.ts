import { describe, expect, it } from "vitest";
import { effectiveMight } from "../src/engine/effective-might.js";
import { effectForCard } from "../src/engine/card-effects.js";
import { spellInstance } from "./fixtures.js";
import { makeState, makeUnit, realGearInstance } from "./fixtures.js";
import type { GameState } from "../src/model/game-state.js";

/**
 * **Switcheroo (SFD-145) swaps CURRENT Might, equipment included.**
 *
 * "Swap the Might of two units at the same battlefield this turn."
 *
 * Reported from play 2026-08-23: "using Switcheroo on a unit with a bunch of
 * equipment attached swapped the original Might instead of the Might after
 * equipment were taken into account. I switcheroo'd my unit and an opponent's
 * base 2-Might unit, but it was ten Might because of equipment."
 *
 * # The rules call, and why the old one was wrong
 *
 * The card's entry made this call explicitly and flagged itself unverified: it
 * swapped printed Might plus the this-turn modifier and deliberately NOT
 * `effectiveMight`, reasoning that baking a temporary source into a delta which
 * survives to end of turn "keeps paying out long after its source stopped
 * applying, which is a worse answer than under-counting it."
 *
 * **432.1's worked example is that exact scenario, decided the other way:**
 *
 *   "A unit with 3 base Might and Shield 2 is in combat as a Defender. Since
 *   Shield applies, its current Might is 5. A player chooses it as the target for
 *   Last Stand, a spell that reads in part 'Double a friendly unit's Might this
 *   turn.' Its current Might is 5, so it gets +5 Might this turn, for a current
 *   Might of 10. After combat, Shield no longer applies, but the +5 Might from
 *   Last Stand does, so the unit's Might is 8."
 *
 * So a spell referencing Might reads CURRENT Might (143.2), a temporary source
 * counts while it applies, and the rules explicitly accept the delta outliving
 * it. The old note was a design preference asserted against a rule that had
 * already answered — and equipment, which is not even temporary, was wrong under
 * it twice over.
 */

const SWITCHEROO = "SFD-145";
/** SFD-022 Long Sword, +2 Might — from `card-loader`'s EQUIP_MIGHT_BONUS. */
const LONG_SWORD = "SFD-022";

/** Two units at bf1, one of them optionally wearing gear or carrying a buff. */
function board(opts: {
  firstMight: number;
  secondMight: number;
  equipFirst?: boolean;
  equipSecond?: boolean;
  buffFirst?: boolean;
}): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  const mine = makeUnit({ instanceId: "mine", name: "Mine", might: opts.firstMight, ...(opts.buffFirst ? { buffed: true } : {}) });
  const theirs = makeUnit({ instanceId: "theirs", name: "Theirs", might: opts.secondMight });
  state.battlefields[0] = { ...state.battlefields[0]!, units: { p1: [mine], p2: [theirs] } };
  if (opts.equipFirst) {
    state.players[0]!.activeGear = [{ ...realGearInstance(LONG_SWORD), attachedToInstanceId: "mine" }];
  }
  if (opts.equipSecond) {
    // The OPPONENT's gear, on the OPPONENT's unit — the orientation the report
    // actually describes.
    state.players[1]!.activeGear = [{ ...realGearInstance(LONG_SWORD), attachedToInstanceId: "theirs" }];
  }
  return state;
}

const nonCombat = (state: GameState, id: string, owner: 0 | 1) => {
  const bf = state.battlefields[0]!;
  const unit = [...(bf.units.p1 ?? []), ...(bf.units.p2 ?? [])].find((u) => u.instanceId === id)!;
  return effectiveMight(state, unit, owner, { isCombat: false, battlefieldId: bf.id });
};

/** Runs the card's resolver on the two units. */
function swap(state: GameState): GameState {
  const effect = effectForCard(spellInstance(SWITCHEROO));
  // Thrown rather than optional-chained: `effect?.resolve(...)` would make every
  // assertion in this file pass vacuously the day the card loses its entry.
  if (effect?.resolve === undefined) throw new Error("Switcheroo has no effect registered");
  return effect.resolve(state, { casterIndex: 0 } as never, {
    targetUnitInstanceId: "mine",
    secondTargetUnitInstanceId: "theirs",
  } as never) as GameState;
}

describe("the fixture really does what this file needs", () => {
  it("the gear grants Might, so 'after equipment' is a different number", () => {
    // A positive control on the SETUP. If the Long Sword granted nothing, every
    // assertion below would pass against the old, wrong implementation too —
    // which is the vacuous shape this repo keeps rediscovering.
    const state = board({ firstMight: 2, secondMight: 5, equipFirst: true });
    expect(nonCombat(state, "mine", 0), "the equipment grants no Might, so this file measures nothing").toBe(4);
  });
});

describe("the reported game: equipment counts", () => {
  it("swaps the Might AFTER equipment, not the printed figure", () => {
    // The report's shape: a heavily equipped unit and a small enemy one.
    const state = board({ firstMight: 2, secondMight: 5, equipFirst: true });
    const mineBefore = nonCombat(state, "mine", 0); // 2 printed + 2 gear = 4
    const theirsBefore = nonCombat(state, "theirs", 1); // 5

    const after = swap(state);
    expect(nonCombat(after, "mine", 0), "the equipped unit did not take the other's Might").toBe(theirsBefore);
    expect(nonCombat(after, "theirs", 1), "the plain unit did not take the equipped unit's CURRENT Might").toBe(
      mineBefore,
    );
  });

  it("counts equipment on the OPPONENT's unit — the reported orientation", () => {
    // **The report puts the gear on the ENEMY unit**: "I switcheroo'd my unit and
    // an opponent's base 2-Might unit, but it was ten Might because of
    // equipment." The tests above equip the caster's own, so a fix that read
    // `effectiveMight` for one side and a printed figure for the other would
    // pass them and still be wrong in the reported game. `swappableMight` asks
    // each unit's OWN owner, and this is what pins that.
    const state = board({ firstMight: 6, secondMight: 2, equipSecond: true });
    const mineBefore = nonCombat(state, "mine", 0); // 6
    const theirsBefore = nonCombat(state, "theirs", 1); // 2 printed + 2 gear = 4
    expect(theirsBefore, "the enemy gear granted nothing, so this measures nothing").toBeGreaterThan(2);

    const after = swap(state);
    expect(nonCombat(after, "mine", 0), "my unit did not take the enemy's CURRENT Might").toBe(theirsBefore);
    expect(nonCombat(after, "theirs", 1), "the enemy unit did not take mine").toBe(mineBefore);
  });

  it("a BUFF counts too — the same rule, a different source", () => {
    // 703 makes a buff +1 Might, and `effectiveMight` counts it. Included
    // because the old helper missed every continuous source, not just gear.
    const state = board({ firstMight: 3, secondMight: 6, buffFirst: true });
    const mineBefore = nonCombat(state, "mine", 0); // 3 + 1
    const theirsBefore = nonCombat(state, "theirs", 1); // 6
    const after = swap(state);
    expect(nonCombat(after, "mine", 0), "the buffed unit did not take the other's Might").toBe(theirsBefore);
    expect(nonCombat(after, "theirs", 1), "the buff was not part of the swapped figure").toBe(mineBefore);
  });
});

describe("the swap is still a swap", () => {
  it("leaves two EQUAL units alone", () => {
    // A zero delta is a swap nothing can observe, and the resolver returns early
    // rather than writing two cancelling modifiers.
    const state = board({ firstMight: 4, secondMight: 4 });
    const after = swap(state);
    expect(nonCombat(after, "mine", 0)).toBe(4);
    expect(nonCombat(after, "theirs", 1)).toBe(4);
  });

  it("is symmetric — the total Might across the pair is unchanged", () => {
    // The invariant that holds whichever figure is swapped, so it catches a
    // resolver that pumps one side without paying the other.
    const state = board({ firstMight: 2, secondMight: 9, equipFirst: true });
    const before = nonCombat(state, "mine", 0) + nonCombat(state, "theirs", 1);
    const after = swap(state);
    expect(nonCombat(after, "mine", 0) + nonCombat(after, "theirs", 1), "the swap created or destroyed Might").toBe(
      before,
    );
  });

  it("still swaps plain printed Might when nothing is attached — the control", () => {
    // The case that worked before must keep working: this change widens what is
    // counted, it does not change the operation.
    const state = board({ firstMight: 3, secondMight: 8 });
    const after = swap(state);
    expect(nonCombat(after, "mine", 0)).toBe(8);
    expect(nonCombat(after, "theirs", 1)).toBe(3);
  });
});
