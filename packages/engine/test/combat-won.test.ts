import { describe, expect, it } from "vitest";
import { resolveShowdown } from "../src/engine/combat.js";
import { GOLD_TOKEN_DEF_ID } from "../src/engine/token.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import { answerDecisions, makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";
import { destroyUnit } from "../src/engine/effect-helpers.js";

/**
 * `combatWon` — rule 466.3.a, the event three SFD cards read and nothing in this
 * engine produced.
 *
 * It is NOT a conquest, which is why it had to be its own event rather than the
 * cards reusing `battlefieldConquered`. A conquest also fires when a unit walks
 * into an empty battlefield with no combat at all, and a combat can be won at a
 * battlefield the winner already controlled, which establishes no new control
 * and conquers nothing. Paying out on a conquest would do both wrong.
 *
 * **Only one side left is a win.** 466.3.d makes the other two shapes a No
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

describe("a combat is WON when exactly one side is left (466.3.a)", () => {
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

  it("pays NOBODY on a mutual wipe — 466.3.d's No Result", () => {
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

  it("plain units cannot reach the both-sides-survive No Result, and here is why", () => {
    // 466.3.d has TWO No Result shapes. The mutual wipe above is reachable; the
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
    // **That prediction came true the same day.** This comment used to end "the
    // next card that adds real damage absorption makes it live" — and Ezreal -
    // Dashing (SFD-082) does exactly that from the other side: he DEALS no
    // combat damage, so the defenders survive while he does too, and 466 step
    // 3d recalls him. `combatWinner`'s both-survive branch is a live path now,
    // not a guard, and the test below is the one that exercises it.
    //
    // The claim kept here is the narrower true one: PLAIN units cannot do it.
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
    // damage step, and 466.3.a still applies — the comment on that early return
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

/**
 * Ezreal - Dashing (SFD-082) — "I don't deal combat damage."
 *
 * His DRAWBACK, and it was written the moment the rest of his card was. His
 * attack trigger deals damage equal to his Might; without this he would deal
 * that AND his Might in the damage step, i.e. strictly stronger than printed —
 * the one direction this codebase does not ship. The agent that wrote the
 * trigger flagged the over-strength rather than leaving it to be discovered.
 */
describe("Ezreal - Dashing deals no combat damage", () => {
  const EZREAL_DASHING = "SFD-082";

  it("contributes NOTHING to the damage step, so a lone Ezreal kills nobody", () => {
    const ezreal = realUnitInstance(EZREAL_DASHING);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    // A 9-Might Ezreal against a 1-Might defender: without the drawback the
    // defender is obliterated. With it, nothing is dealt at all.
    state.battlefields[0]!.units = { p1: [{ ...ezreal, might: 9 }], p2: [makeUnit({ might: 1 })] };

    const after = resolveShowdown(state, "bf1", 0);

    expect(after.battlefields[0]!.units.p2 ?? [], "the defender took Ezreal's Might").toHaveLength(1);
  });

  it("is no EASIER to kill for it — remainingMight is untouched", () => {
    // The half the Stun rule gets right and a naive "set his Might to 0" would
    // get wrong: he hits for nothing and still takes his full Might to kill.
    const ezreal = realUnitInstance(EZREAL_DASHING);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0]!.units = { p1: [{ ...ezreal, might: 5 }], p2: [makeUnit({ might: 4 })] };

    const after = resolveShowdown(state, "bf1", 0);

    // He SURVIVES — but he is not standing at the battlefield, because both
    // sides survived and 466 step 3d recalls the attackers. Asserting on the
    // battlefield alone would read that as a death; the first draft of this
    // test did exactly that and reported him killed by 4 damage at 5 Might.
    expect(after.players[0]!.baseUnits, "4 damage killed a 5-Might Ezreal").toHaveLength(1);
    expect(after.battlefields[0]!.units.p2 ?? [], "he dealt damage after all").toHaveLength(1);
  });

  it("does not silence anyone else", () => {
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0]!.units = { p1: [makeUnit({ might: 9 })], p2: [makeUnit({ might: 1 })] };
    expect(resolveShowdown(state, "bf1", 0).battlefields[0]!.units.p2 ?? []).toHaveLength(0);
  });
});

/**
 * The both-sides-survive No Result, now that a card can produce one.
 *
 * This was asserted UNREACHABLE hours earlier, correctly: a plain unit's
 * outgoing Might is its remaining Might, so surviving needs A < D < A. Ezreal -
 * Dashing breaks the symmetry from the side `[Shield]` could not — he deals
 * nothing while still taking his full Might to kill — and that is precisely the
 * "next card that adds damage absorption" the old comment predicted.
 */
describe("466.3.d's other No Result is reachable now", () => {
  it("nobody wins when Ezreal survives a fight he cannot win", () => {
    const ezreal = realUnitInstance("SFD-082");
    const draven = realUnitInstance(DRAVEN_VANQUISHER);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    // Ezreal attacks a defender too small to kill him. He deals 0, so the
    // defender lives; the defender deals 4, so Ezreal lives. Both sides remain.
    state.battlefields[0]!.units = { p1: [{ ...ezreal, might: 9 }], p2: [makeUnit({ might: 4 })] };
    // Draven sits at the OTHER battlefield, so if a win were wrongly declared
    // for p0 anywhere he would mint a Gold token.
    state.battlefields[1]!.units = { p1: [{ ...draven, might: 4 }] };

    const after = fightAt(state);

    // Both survived — the attacker went home under step 3d, which is what makes
    // it a No Result rather than a defender's victory.
    expect(after.players[0]!.baseUnits, "Ezreal did not survive").toHaveLength(1);
    expect(after.battlefields[0]!.units.p2 ?? [], "the defender did not survive").toHaveLength(1);
    expect(goldOf(after, 0), "a No Result paid out").toHaveLength(0);
    expect(goldOf(after, 1)).toHaveLength(0);
  });
});

/**
 * `DeathContext.diedInCombat` — the flag that separates "died at a battlefield"
 * from "died IN a combat".
 *
 * Draven - Audacious (SFD-148) is the card that needed it: "when I die in
 * combat, choose an opponent. They score 1 point." A `battlefieldId !== undefined`
 * test would have handed the opponent a point for a removal spell, and the
 * Showdown state is no substitute because `execute-pass-focus` nulls
 * `showdownBattlefieldId` the instant the Showdown closes — long before a held
 * death trigger resolves. Both alternatives were measured and rejected by the
 * agent that refused to fake the clause.
 */
describe("dying IN COMBAT is not the same as dying at a battlefield", () => {
  const DRAVEN_AUDACIOUS = "SFD-148";

  it("pays the opponent a point when Draven dies to combat damage", () => {
    // **Asserted as a DELTA against a control board**, because winning a combat
    // also CONQUERS, and a conquest scores its own point. An absolute
    // assertion here reads 2 and looks like a double-payout; the first draft of
    // this test did exactly that. The control is the same board with a plain
    // unit in Draven's place, so the difference is his clause and nothing else.
    const board = (defender: ReturnType<typeof makeUnit>): GameState => {
      const state = makeState({ phase: "Action", activePlayerIndex: 0 });
      state.battlefields[0]!.units = { p1: [defender], p2: [makeUnit({ might: 9 })] };
      return state;
    };
    const draven = realUnitInstance(DRAVEN_AUDACIOUS);

    const withDraven = fightAt(board({ ...draven, might: 1 })).players[1]!.points;
    const control = fightAt(board(makeUnit({ might: 1 }))).players[1]!.points;

    expect(withDraven - control, "Draven's death paid the opponent nothing").toBe(1);
  });

  it("pays NOTHING when a spell kills him at the same battlefield", () => {
    // The case the flag exists for. `destroyUnit` is the spell/effect funnel and
    // passes no `diedInCombat`, so the same board and the same location produce
    // a different — and correct — answer.
    const draven = realUnitInstance(DRAVEN_AUDACIOUS);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0]!.units = { p1: [{ ...draven, might: 1 }] };
    const before = state.players[1]!.points;

    const after = answerDecisions(resolveHeldTriggers(destroyUnit(state, draven.instanceId, 1)));

    expect(after.players[1]!.points, "a removal spell paid the opponent").toBe(before);
  });
});
