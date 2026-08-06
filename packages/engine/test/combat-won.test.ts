import { describe, expect, it } from "vitest";
import { resolveShowdown } from "../src/engine/combat.js";
import { GOLD_TOKEN_DEF_ID } from "../src/engine/token.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import { answerDecisions, makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * `combatWon` — rule 466.5.a, the event three SFD cards read and nothing in this
 * engine produced.
 *
 * It is NOT a conquest, which is why it had to be its own event rather than the
 * cards reusing `battlefieldConquered`. A conquest also fires when a unit walks
 * into an empty battlefield with no combat at all, and a combat can be won at a
 * battlefield the winner already controlled, which establishes no new control
 * and conquers nothing. Paying out on a conquest would do both wrong.
 *
 * **Only one side left is a win.** 466.5.d makes the other two shapes a No
 * Result: both sides still standing after the damage step (precisely when 466
 * step 3d recalls the attackers) and neither side standing. Those two are the
 * negative controls below, and they are the whole reason the event is not simply
 * "a combat happened".
 */

const registry = defaultCardRegistry();
const DRAVEN_VANQUISHER = "SFD-020";
const CORRUPT_ENFORCER = "SFD-123";

const goldOf = (state: GameState, index: 0 | 1) =>
  state.players[index]!.activeGear.filter((g) => g.defId === GOLD_TOKEN_DEF_ID);

/** p0 attacks into bf1, which p1 defends. `resolveShowdown` is the real entry. */
function fightAt(state: GameState): GameState {
  return answerDecisions(resolveHeldTriggers(resolveShowdown(state, "bf1", 0)));
}

describe("a combat is WON when exactly one side is left (466.5.a)", () => {
  it("pays the winner when the loser's units are wiped", () => {
    const draven = realUnitInstance(DRAVEN_VANQUISHER);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    // A 9-Might Draven against a 1-Might defender: the defender dies, Draven does
    // not, so exactly one side remains.
    state.battlefields[0]!.units = { p1: [{ ...draven, might: 9 }], p2: [makeUnit({ might: 1 })] };

    const after = fightAt(state);

    expect(goldOf(after, 0), "Draven won and made no Gold token").toHaveLength(1);
    expect(goldOf(after, 0)[0]!.exhausted).toBe(true);
  });

  it("pays NOBODY on a mutual wipe — 466.5.d's No Result", () => {
    // A combat plainly happened and was won by nobody.
    //
    // **This control is WEAK by construction, and measured to be so.** Widening
    // `combatWinner` to hand the attacker the win regardless still leaves it
    // passing, because in a mutual wipe Draven is dead — he is not a listener,
    // so nothing observes the event either way. No "when I win a combat" card
    // can ever witness a mutual wipe, for the same reason.
    //
    // Kept anyway: it pins that the mutual wipe does not somehow pay a SURVIVING
    // card elsewhere, and it documents the hole. The load-bearing negative
    // control is "pays the DEFENDER", which the same mutation does fail.
    const draven = realUnitInstance(DRAVEN_VANQUISHER);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0]!.units = { p1: [{ ...draven, might: 3 }], p2: [makeUnit({ might: 3 })] };

    const after = fightAt(state);

    expect(after.battlefields[0]!.units.p1 ?? [], "Draven survived — the fixture is not a mutual wipe").toHaveLength(0);
    expect(goldOf(after, 0), "a mutual wipe paid the attacker").toHaveLength(0);
    expect(goldOf(after, 1)).toHaveLength(0);
  });

  it("cannot reach the both-sides-survive No Result at all, and here is why", () => {
    // 466.5.d has TWO No Result shapes. The mutual wipe above is reachable; the
    // other one — both sides still standing, which is when step 3d recalls the
    // attackers — **is not reachable in this pool**, and that is arithmetic
    // rather than an accident of the fixtures.
    //
    // A plain unit's outgoing Might IS its remaining Might, so each side's
    // damage pool equals its own total Might. Defenders survive iff D > A;
    // attackers survive iff A > D. Both at once needs A < D < A.
    //
    // `[Shield]` does not break it either, and that was the obvious guess:
    // it reads "+N Might while I'm a defender", so it raises the defending
    // side's POOL by exactly as much as its survivability. `[Assault]` breaks
    // the symmetry the wrong way, raising the attacker's pool without raising
    // what it takes to kill them.
    //
    // Asserted rather than left as prose, because `combatWinner`'s
    // both-survive branch is a GUARD on an unreachable state, and the next
    // card that adds real damage absorption makes it live. This is what will
    // say so.
    for (const [a, d] of [
      [3, 3],
      [9, 1],
      [1, 9],
      [4, 5],
    ] as const) {
      const state = makeState({ phase: "Action", activePlayerIndex: 0 });
      state.battlefields[0]!.units = { p1: [makeUnit({ might: a })], p2: [makeUnit({ might: d })] };
      const after = resolveShowdown(state, "bf1", 0);
      const atBf = [...(after.battlefields[0]!.units.p1 ?? []), ...(after.battlefields[0]!.units.p2 ?? [])];
      const bothSides =
        (after.battlefields[0]!.units.p1 ?? []).length > 0 && (after.battlefields[0]!.units.p2 ?? []).length > 0;
      expect(bothSides, `both sides survived at ${a} vs ${d} — the guard is live now`).toBe(false);
      expect(atBf.length, `${a} vs ${d}`).toBeLessThanOrEqual(1);
    }
  });

  it("pays the DEFENDER when the attack is wiped out", () => {
    // The win is not the attacker's to claim: whoever is the only side left has
    // won, which for a failed attack is the defender.
    const enforcer = realUnitInstance(CORRUPT_ENFORCER);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0]!.units = { p1: [makeUnit({ might: 1 })], p2: [{ ...enforcer, might: 9 }] };
    state.players[1]!.deck = [realUnitInstance("OGN-164")];

    const after = fightAt(state);

    expect(after.players[1]!.hand, "the defender won and drew nothing").toHaveLength(1);
    expect(after.players[0]!.hand, "the losing attacker drew").toHaveLength(0);
  });

  it("pays a WALKOUT winner too — the shape the probe counts 191 of", () => {
    // One side simply is not there. `resolveShowdown` returns early without a
    // damage step, and 466.5.a still applies — the comment on that early return
    // already read it that way for establishing control.
    const draven = realUnitInstance(DRAVEN_VANQUISHER);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0]!.units = { p1: [{ ...draven, might: 4 }], p2: [] };

    const after = fightAt(state);

    expect(goldOf(after, 0), "a walkout won nothing").toHaveLength(1);
  });

  it("pays nobody when the battlefield is empty on both sides", () => {
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0]!.units = { p1: [], p2: [] };
    expect(() => fightAt(state)).not.toThrow();
    expect(goldOf(fightAt(state), 0)).toHaveLength(0);
  });

  it("does not pay a winner standing somewhere ELSE", () => {
    // Positional: the trigger is "I win a combat", not "a combat was won".
    const draven = realUnitInstance(DRAVEN_VANQUISHER);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0]!.units = { p1: [makeUnit({ might: 9 })], p2: [makeUnit({ might: 1 })] };
    state.battlefields[1]!.units = { p1: [{ ...draven, might: 4 }] };

    const after = fightAt(state);

    expect(goldOf(after, 0), "Draven paid out for a fight he was not in").toHaveLength(0);
  });
});

describe("the two cards this event unblocked are whole", () => {
  it("both report implemented with no partial note", () => {
    // Both carried a PARTIALLY_IMPLEMENTED entry naming this exact missing event.
    // The entries were DELETED when it landed, not reworded.
    for (const defId of [DRAVEN_VANQUISHER, CORRUPT_ENFORCER]) {
      expect(isCardImplemented(registry.get(defId)), defId).toBe(true);
      expect(partialImplementationNote(registry.get(defId)), defId).toBeUndefined();
    }
  });

  it("both print the clause this event exists for", () => {
    // Guards against the entries having been deleted because somebody decided the
    // clause did not matter, rather than because it now works.
    expect(registry.get(DRAVEN_VANQUISHER).text).toContain("win a combat");
    expect(registry.get(CORRUPT_ENFORCER).text).toContain("win a combat");
  });
});

/**
 * Draven - Glorious Executioner (SFD-185) — "When you win a combat, draw 1."
 *
 * A LEGEND, which is why this needed its own hook rather than an event-trigger
 * entry: a Legend is not on the board, so no listener walk reaches it. He is
 * also the card that shows why `combatWon` had to exist at all — on a conquer
 * hook he would draw for walk-ins that never fought, and miss combats won at a
 * battlefield he already controlled.
 */
describe("Draven - Glorious Executioner: the Legend side of combatWon", () => {
  const DRAVEN_EXECUTIONER = "SFD-185";

  /** p0's legend IS Draven, and p0 is about to fight at bf1. */
  function withDraven(): GameState {
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    const legend = registry.get(DRAVEN_EXECUTIONER);
    state.players[0]!.legend = { ...state.players[0]!.legend, defId: legend.id, name: legend.name };
    state.players[0]!.deck = [realUnitInstance("OGN-164"), realUnitInstance("OGN-164")];
    return state;
  }

  it("draws when his side wins the fight", () => {
    const state = withDraven();
    state.battlefields[0]!.units = { p1: [makeUnit({ might: 9 })], p2: [makeUnit({ might: 1 })] };
    expect(fightAt(state).players[0]!.hand, "Draven won and drew nothing").toHaveLength(1);
  });

  it("draws nothing on a mutual wipe — a No Result is not a win", () => {
    const state = withDraven();
    state.battlefields[0]!.units = { p1: [makeUnit({ might: 3 })], p2: [makeUnit({ might: 3 })] };
    expect(fightAt(state).players[0]!.hand).toHaveLength(0);
  });

  it("draws nothing when the OPPONENT wins", () => {
    const state = withDraven();
    state.battlefields[0]!.units = { p1: [makeUnit({ might: 1 })], p2: [makeUnit({ might: 9 })] };
    expect(fightAt(state).players[0]!.hand, "Draven drew off a loss").toHaveLength(0);
  });

  it("draws on a WALKOUT too — winning is not fighting", () => {
    // The shape the probe counts 191 of in 200 games, and the one a conquer hook
    // would also catch — but for the wrong reason, since a walk-in onto an
    // already-controlled battlefield conquers nothing.
    const state = withDraven();
    state.battlefields[0]!.units = { p1: [makeUnit({ might: 4 })], p2: [] };
    expect(fightAt(state).players[0]!.hand).toHaveLength(1);
  });
});
