import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * **`UnitCostSpec.candidate` — an additional cost that names a SUBSET of your
 * units.**
 *
 * Sacrifice (UNL-173) is the first: "As an additional cost to play this, kill a
 * friendly **[Mighty]** unit. Draw 2 and channel 1 rune exhausted." Every cost
 * before it took any unit you controlled that was in the right STATE (ready,
 * buffed, alive), so the `kind` was the whole eligibility rule and a card naming
 * an identity had nowhere to say so.
 *
 * # The thing these tests are really pointed at
 *
 * A candidate filter is exactly the shape that produces this repo's recurring
 * crash: applied in `legal-actions` but not `validate-play-card`, everything
 * looks right until a hand-built or stale action pays a cost the card never
 * offered; applied in `validate-play-card` but not `legal-actions`, the AI
 * enumerates variants that are then refused. Five crashes here have had that
 * shape. So the two sides are asserted SEPARATELY and against each other, rather
 * than only through the happy path that exercises both at once.
 *
 * # Mighty is asked, not computed
 *
 * 708 defines Mighty on CURRENT Might, so the predicate is `isMighty` and a unit
 * pushed to 5 by a this-turn pump qualifies. That has its own test, because a
 * `printedMight >= 5` implementation passes every other test in this file.
 */

const registry = defaultCardRegistry();
const SACRIFICE = "UNL-173";
const MIGHTY_THRESHOLD = 5;

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

/** Player 0 holding a Sacrifice, with `units` in base and resources to cast. */
function board(units: UnitInstance[]): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.baseUnits = units;
  state.players[0]!.hand = [spellInstance(SACRIFICE)];
  state.players[0]!.floatingEnergy = 10;
  state.players[0]!.channeled = Array.from({ length: 8 }, (_, i) => rune(`r${i}`, "Order"));
  // Something to channel — the card's second half, and an empty rune deck would
  // make the draw assertions pass while the channel silently did nothing.
  state.players[0]!.runeDeck = Array.from({ length: 4 }, (_, i) => rune(`d${i}`, "Order"));
  // `deck`, not `mainDeck` — the first spelling type-checked as an excess
  // property on an object literal it never reached, so it was dead and the draw
  // assertions were quietly measuring `makeState`'s default deck instead.
  state.players[0]!.deck = Array.from({ length: 6 }, () => spellInstance("OGN-046"));
  return state;
}

const sacrificeVariants = (state: GameState): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === SACRIFICE);

/** A unit at `might`, printed — nothing dynamic. */
const body = (name: string, might: number): UnitInstance => makeUnit({ name, might });

describe("Sacrifice (UNL-173): the cost may only be paid with a [Mighty] unit", () => {
  it("is not offered at all with no Mighty unit to kill", () => {
    // MANDATORY plus a candidate is how a card becomes conditionally unplayable.
    // Two units, neither of them big enough.
    const state = board([body("Runt", 1), body("Squire", MIGHTY_THRESHOLD - 1)]);

    expect(sacrificeVariants(state), "Sacrifice was offered with nothing legal to pay it with").toEqual([]);
  });

  it("is offered once per Mighty unit, and NOT for the small ones beside them", () => {
    const bigA = body("Colossus", MIGHTY_THRESHOLD);
    const bigB = body("Titan", MIGHTY_THRESHOLD + 3);
    const small = body("Runt", 1);
    const state = board([bigA, small, bigB]);

    const offered = sacrificeVariants(state).map((a) => a.additionalCostUnitInstanceId);
    expect(offered.length, "the fan-out is not one variant per eligible unit").toBe(2);
    expect(new Set(offered), "the wrong units were offered as the price").toEqual(
      new Set([bigA.instanceId, bigB.instanceId]),
    );
    // No decline variant: the cost is not a "you may".
    expect(offered, "a decline variant was offered for a mandatory cost").not.toContain(undefined);
  });

  it("kills the chosen unit, draws 2, and channels 1 EXHAUSTED", () => {
    const big = body("Colossus", MIGHTY_THRESHOLD + 1);
    const state = board([big, body("Runt", 1)]);
    const before = state.players[0]!;

    const action = sacrificeVariants(state)[0]!;
    const { state: played, result } = submit(state, action);
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });

    // Sacrifice is a [Reaction], so submitting only puts it on the Chain — every
    // assertion below is about its RESOLUTION, and reading the board straight
    // after `submit` measured a spell that had not happened yet.
    const after = resolveHeldTriggers(played);
    const me = after.players[0]!;
    expect(me.baseUnits.some((u) => u.instanceId === big.instanceId), "the price was not paid").toBe(false);
    expect(me.hand.length - (before.hand.length - 1), "did not draw 2").toBe(2);

    const gained = me.channeled.length - before.channeled.length;
    expect(gained, "did not channel 1").toBe(1);
    expect(
      me.channeled.slice(-1)[0]!.state,
      "the channelled rune came in READY — it must be exhausted, or the card pays for itself",
    ).toBe("Exhausted");
  });
});

describe("the two sides of the filter agree — the enumerate/execute split", () => {
  it("validate REFUSES a non-Mighty unit that enumeration never offered", () => {
    // The half that only a directly-built action can reach. Without the check in
    // `validate-play-card` this action succeeds and Sacrifice becomes "kill any
    // unit, draw 2".
    const big = body("Colossus", MIGHTY_THRESHOLD + 1);
    const small = body("Runt", 1);
    const state = board([big, small]);

    const offered = sacrificeVariants(state)[0]!;
    const forged: PlayCardAction = { ...offered, additionalCostUnitInstanceId: small.instanceId };

    const verdict = validatePlayCard(state, forged);
    expect(verdict.ok, "a non-Mighty unit was accepted as the price").toBe(false);
  });

  it("...and ACCEPTS every variant enumeration does offer", () => {
    // The other direction, and the one that catches a filter tightened on only
    // the validate side: an offered action that is then refused is a live AI
    // crash, which is how all five of this repo's mismatches surfaced.
    const state = board([body("Colossus", MIGHTY_THRESHOLD), body("Titan", MIGHTY_THRESHOLD + 4), body("Runt", 1)]);

    const variants = sacrificeVariants(state);
    expect(variants.length, "nothing was enumerated — this test would be vacuous").toBeGreaterThan(0);
    for (const action of variants) {
      expect(validatePlayCard(state, action).ok, `an offered variant was refused: ${JSON.stringify(action)}`).toBe(true);
    }
  });

  it("does not reach the OPPONENT's Mighty units", () => {
    // "A FRIENDLY [Mighty] unit". The candidate runs after the kind's own filter,
    // which is what scopes it to your board — so a candidate that ignored
    // ownership would still be caught here rather than silently working.
    const enemyBig = body("Their Colossus", MIGHTY_THRESHOLD + 2);
    const state = board([body("Runt", 1)]);
    state.players[1]!.baseUnits = [enemyBig];

    expect(sacrificeVariants(state), "an enemy unit was offered as the price").toEqual([]);
  });
});

describe("Mighty is CURRENT Might (708), not printed", () => {
  it("a unit pumped to the threshold this turn becomes a legal price", () => {
    // The test a `printedMight >= 5` implementation fails and no other test here
    // does. `isMighty` is the one function that answers this, and it has already
    // taken two fixes — positional auras, and Might read during a showdown —
    // that an inline comparison would re-introduce.
    const pumped = { ...body("Squire", MIGHTY_THRESHOLD - 2), mightThisTurn: 2 };
    const state = board([pumped]);

    const offered = sacrificeVariants(state).map((a) => a.additionalCostUnitInstanceId);
    expect(offered, "a unit at 5 CURRENT Might was not offered — printed Might is being read").toEqual([
      pumped.instanceId,
    ]);
  });

  it("...and one pumped to just under it is still not", () => {
    // The boundary from the other side, so the test above cannot be satisfied by
    // an implementation that simply counts any pumped unit as Mighty.
    const pumped = { ...body("Squire", MIGHTY_THRESHOLD - 3), mightThisTurn: 1 };
    const state = board([pumped]);

    expect(sacrificeVariants(state), "a unit below the threshold was offered").toEqual([]);
  });
});

describe("coverage", () => {
  it("Sacrifice is whole and claimed by the card-effects source", () => {
    expect(isCardImplemented(registry.get(SACRIFICE)), "Sacrifice is greyed").toBe(true);
  });

  it("no OTHER card's cost gained a candidate by accident", () => {
    // Every existing unit-valued cost takes any unit in the right state, and a
    // predicate accidentally applied to all of them would quietly narrow six
    // shipped cards. Cruel Patron is the one with the identical `kind`.
    const patron = realUnitInstance("OGN-208");
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.baseUnits = [body("Runt", 1)];
    state.players[0]!.hand = [patron];
    state.players[0]!.floatingEnergy = 10;
    state.players[0]!.channeled = Array.from({ length: 8 }, (_, i) => rune(`r${i}`, "Order"));

    const offered = legalActions(state).filter(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === "OGN-208",
    );
    expect(offered.length, "Cruel Patron stopped accepting an ordinary 1-Might unit as his price").toBeGreaterThan(0);
  });
});
