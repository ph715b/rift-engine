import { describe, expect, it } from "vitest";
import { unitChooseableBy } from "../src/engine/target-lookup.js";
import { isCardImplemented, partialImplementationNote, implementingModules } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { makeState, makeUnit, realUnitInstance } from "./fixtures.js";

/**
 * **"Can't be chosen by enemy spells and abilities", when it is CONDITIONAL.**
 *
 * Ruin Runner's version is unconditional and was the only one in the pool, so
 * `unitChooseableBy` was a pure function of the unit and `UNCHOOSEABLE_BY_ENEMIES`
 * a bare `Set<defId>`. Unleashed prints two that are not:
 *
 *   - **UNL-059 Master Yi - Unstoppable** — `[Level 16][>] I can't be chosen`.
 *     A fact about the CONTROLLER's XP, which a defId cannot answer.
 *   - **UNL-057 Alpha Wildclaw** — "your units HERE with less Might than me
 *     can't be chosen". An aura over OTHER units, keyed by the protector rather
 *     than the protected.
 *
 * Both were refused across two waves for the same measured reason: the function
 * took no `state`. All four of its call sites already had one in scope, which is
 * why it stayed a pure function so long — nothing needed the board until a
 * conditional prohibition arrived.
 *
 * # The two live in different places, and that is the point
 *
 * Master Yi is a row in the per-defId table, because the prohibition is about
 * HIM. Alpha Wildclaw cannot be, because the table is keyed by the defId of the
 * unit being PROTECTED and he protects others — so he is a board query beside it,
 * the same split `deploy.unitEntersReady` makes between its per-card switch and
 * Magma Wurm's aura. Getting that backwards is the mistake this file guards.
 *
 * # Why this matters beyond two cards
 *
 * A prohibition is a PURE NEGATIVE: a missed site does not look wrong, it just
 * quietly allows a play that should have been impossible. `unitChooseableBy` is
 * the one question both the enumerator and the validator ask, which is what stops
 * that becoming an offered-then-refused crash.
 */

const registry = defaultCardRegistry();
const ALPHA_WILDCLAW = "UNL-057";
const MASTER_YI_UNSTOPPABLE = "UNL-059";
const RUIN_RUNNER = "SFD-105";

/** `units` standing together at bf1 as player 0's, with `xp` on that player. */
function atBf1(units: UnitInstance[], xp = 0): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.xp = xp;
  state.battlefields[0] = { ...state.battlefields[0]!, units: { p1: units } };
  return state;
}

describe("Master Yi - Unstoppable (UNL-059): [Level 16] makes HIM unchooseable", () => {
  const yi = () => realUnitInstance(MASTER_YI_UNSTOPPABLE);

  it("is unchooseable by an enemy at exactly 16 XP", () => {
    const unit = yi();
    expect(unitChooseableBy(atBf1([unit], 16), unit, 0, 1), "an enemy could still choose him at 16 XP").toBe(false);
  });

  it("...and choosable at 15 — the boundary, 824.1.b.1's 'N or more'", () => {
    const unit = yi();
    expect(unitChooseableBy(atBf1([unit], 15), unit, 0, 1), "the gate is not >=").toBe(true);
  });

  it("his OWN controller may always choose him — 'ENEMY spells and abilities'", () => {
    // The half that makes the card playable at all: buffing your own Master Yi is
    // an ordinary play, at any XP.
    const unit = yi();
    expect(unitChooseableBy(atBf1([unit], 20), unit, 0, 0), "his own side was refused").toBe(true);
  });

  it("the XP read is the OWNER's — proved with Yi on the OTHER seat", () => {
    // **This test was weaker than it looked, and mutation said so.** It used to
    // put Yi on player 0 and give player 1 no XP — which a build reading
    // `players[0].xp` passes just as happily, because every other fixture in this
    // file also seats him at 0. Substituting `players[0]` for `unitOwnerIndex`
    // SURVIVED.
    //
    // Owned by player 1, with the XP on player 1 and none on player 0: now only a
    // read of the unit's actual owner gives the right answer.
    const unit = yi();
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.xp = 0;
    state.players[1]!.xp = 16;
    state.battlefields[0] = { ...state.battlefields[0]!, units: { p2: [unit] } };

    expect(unitChooseableBy(state, unit, 1, 0), "it read a hardcoded seat rather than the owner").toBe(false);

    // And the mirror, so the assertion above cannot pass on a build that simply
    // refuses everything once ANY player has 16 XP.
    const swapped = makeState({ phase: "Action", activePlayerIndex: 0 });
    swapped.players[0]!.xp = 16;
    swapped.players[1]!.xp = 0;
    const theirs = yi();
    swapped.battlefields[0] = { ...swapped.battlefields[0]!, units: { p2: [theirs] } };
    expect(unitChooseableBy(swapped, theirs, 1, 0), "the OPPONENT's XP shielded him").toBe(true);
  });
});

describe("Alpha Wildclaw (UNL-057): an aura over the smaller units beside him", () => {
  const wildclaw = (might: number) => ({ ...realUnitInstance(ALPHA_WILDCLAW), might }) as UnitInstance;

  it("shields a friendly unit HERE with less Might", () => {
    const claw = wildclaw(6);
    const cub = makeUnit({ name: "Cub", might: 2 });
    expect(unitChooseableBy(atBf1([claw, cub]), cub, 0, 1), "the smaller unit was not shielded").toBe(false);
  });

  it("does NOT shield one with equal or greater Might — 'LESS Might than me' is strict", () => {
    const claw = wildclaw(6);
    const equal = makeUnit({ name: "Equal", might: 6 });
    const bigger = makeUnit({ name: "Bigger", might: 7 });
    const state = atBf1([claw, equal, bigger]);

    expect(unitChooseableBy(state, equal, 0, 1), "an equal-Might unit was shielded").toBe(true);
    expect(unitChooseableBy(state, bigger, 0, 1), "a bigger unit was shielded").toBe(true);
  });

  it("does not shield a unit at ANOTHER battlefield — 'here' is his own", () => {
    const claw = wildclaw(6);
    const cub = makeUnit({ name: "Cub", might: 2 });
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0] = { ...state.battlefields[0]!, units: { p1: [claw] } };
    state.battlefields[1] = { ...state.battlefields[1]!, units: { p1: [cub] } };

    expect(unitChooseableBy(state, cub, 0, 1), "his aura reached another battlefield").toBe(true);
  });

  it("does not shield a unit in BASE", () => {
    const claw = wildclaw(6);
    const cub = makeUnit({ name: "Cub", might: 2 });
    const state = atBf1([claw]);
    state.players[0]!.baseUnits = [cub];

    expect(unitChooseableBy(state, cub, 0, 1), "his aura reached the base").toBe(true);
  });

  it("does not shield HIMSELF — nothing has less Might than itself", () => {
    // **The explicit `instanceId` guard in `shieldedByWildclaw` is
    // MEASURED-REDUNDANT, and this test does not prove it.** Removing that guard
    // survived mutation on 2026-08-11, for the reason the title gives: the
    // comparison is a strict `>`, so a Wildclaw compared against himself yields
    // `might > might` — false — and he is unshielded either way.
    //
    // The guard is kept and labelled at its definition rather than deleted,
    // because it becomes load-bearing the moment that `>` is ever relaxed to
    // `>=`. Said here so nobody reads this test as covering it.
    const claw = wildclaw(6);
    expect(unitChooseableBy(atBf1([claw]), claw, 0, 1), "he shielded himself").toBe(true);
  });

  it("does not shield the OPPONENT's units standing with him", () => {
    // "YOUR units here" — measured from his controller. An enemy unit at the same
    // battlefield is not his to protect, and this is the assertion that separates
    // "units here" from "your units here".
    const claw = wildclaw(6);
    const theirs = makeUnit({ name: "Theirs", might: 2 });
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0] = { ...state.battlefields[0]!, units: { p1: [claw], p2: [theirs] } };

    expect(unitChooseableBy(state, theirs, 1, 0), "he shielded an enemy unit").toBe(true);
  });

  it("reads CURRENT Might, so a buff on the shielded unit lifts the shield", () => {
    // 143.2 — `effectiveMight`, not the printed number. A cub buffed past him
    // stops being protected, live.
    const claw = wildclaw(6);
    const cub = makeUnit({ name: "Cub", might: 2, mightThisTurn: 5 });
    expect(unitChooseableBy(atBf1([claw, cub]), cub, 0, 1), "the buff was ignored — printed Might was read").toBe(true);
  });
});

describe("the unconditional case is untouched, and coverage is honest", () => {
  it("Ruin Runner still refuses an enemy and allows its own side", () => {
    // The regression guard: the table went from a Set to a predicate map, and the
    // one card that was already in it must behave identically.
    const runner = realUnitInstance(RUIN_RUNNER);
    const state = atBf1([runner]);
    expect(unitChooseableBy(state, runner, 0, 1), "Ruin Runner became choosable").toBe(false);
    expect(unitChooseableBy(state, runner, 0, 0), "Ruin Runner refused its own side").toBe(true);
  });

  it("an ordinary unit is choosable with none of these on the board", () => {
    const plain = makeUnit({ name: "Plain", might: 3 });
    expect(unitChooseableBy(atBf1([plain]), plain, 0, 1)).toBe(true);
  });

  it("Alpha Wildclaw is WHOLE; Master Yi is a quarter and says so", () => {
    // Wildclaw's other line is `[Tank]`, a keyword, so the aura is his whole
    // remaining text. Master Yi's three [Level] COST reductions are unwritten and
    // the clause that landed is the LAST of four — exactly the over-report
    // `PARTIALLY_IMPLEMENTED` exists to catch.
    expect(isCardImplemented(registry.get(ALPHA_WILDCLAW)), "Wildclaw is greyed").toBe(true);
    expect(implementingModules(ALPHA_WILDCLAW)).toContain("choose restrictions");

    expect(isCardImplemented(registry.get(MASTER_YI_UNSTOPPABLE)), "Master Yi claims to be finished").toBe(false);
    expect(partialImplementationNote(registry.get(MASTER_YI_UNSTOPPABLE)), "his missing cost tiers are unrecorded").toMatch(
      /COST reductions/,
    );
  });
});
