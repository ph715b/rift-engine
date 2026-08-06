import { describe, expect, it } from "vitest";
import { unitEntersReady } from "../src/engine/deploy.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";
/**
 * SFD's four CONDITIONAL enter-readys.
 *
 * "I enter ready IF ..." is a replacement, not a readying, so all four live in
 * `unitEntersReady` beside Leona - Zealot's and Vayne - Hunter's rather than as
 * on-play `readyUnit` triggers. **Three separate agents refused to fake them
 * that way**, each giving the same three observable reasons: the trigger is a
 * held Chain Pending Item, so the unit would sit exhausted through the whole
 * response window; it would fire `unitReadied`, paying out Pirate's Haven for a
 * readying the rules say never happened; and it would be blockable by Mageseeker
 * Warden.
 *
 * The predicate is asked BEFORE the unit is inserted into its zone, so every
 * "other units" count here needs no self-exclusion — which is exactly the sort
 * of off-by-one that reads correct, hence the paired near-miss cases.
 */
describe("SFD's conditional enter-readys", () => {
  const DUNEBREAKER = "SFD-027";
  const DIREWING = "SFD-094";
  const BREAKNECK_MECH = "SFD-071";
  const XIN_ZHAO = "SFD-176";

  it("Dunebreaker enters ready at two or fewer cards in hand, and not at three", () => {
    const state = makeState();
    const dune = realUnitInstance(DUNEBREAKER);
    state.players[0]!.hand = [spellInstance("OGN-164"), spellInstance("OGN-164")];
    expect(unitEntersReady(state, 0, dune)).toBe(true);

    state.players[0]!.hand = [spellInstance("OGN-164"), spellInstance("OGN-164"), spellInstance("OGN-164")];
    expect(unitEntersReady(state, 0, dune), "three cards should NOT ready him").toBe(false);
  });

  it("Direwing needs ANOTHER Dragon, and is not his own", () => {
    // The self-exclusion case. He is not in a zone when this is asked, so an
    // implementation that counted him would have to work at it — but a later
    // refactor that asks after insertion would silently make him always ready.
    const alone = makeState();
    expect(unitEntersReady(alone, 0, realUnitInstance(DIREWING)), "he readied himself").toBe(false);

    const withDragon = makeState();
    withDragon.players[0]!.baseUnits = [makeUnit({ tags: ["Dragon"] })];
    expect(unitEntersReady(withDragon, 0, realUnitInstance(DIREWING))).toBe(true);

    // A Dragon at a BATTLEFIELD counts too — the card says "you control", not "in base".
    const atBf = makeState();
    atBf.battlefields[0]!.units = { p1: [makeUnit({ tags: ["Dragon"] })] };
    expect(unitEntersReady(atBf, 0, realUnitInstance(DIREWING))).toBe(true);

    // And the OPPONENT's Dragon does not.
    const theirs = makeState();
    theirs.players[1]!.baseUnits = [makeUnit({ tags: ["Dragon"] })];
    expect(unitEntersReady(theirs, 0, realUnitInstance(DIREWING))).toBe(false);
  });

  it("Breakneck Mech needs another Mech", () => {
    const alone = makeState();
    expect(unitEntersReady(alone, 0, realUnitInstance(BREAKNECK_MECH))).toBe(false);
    const withMech = makeState();
    withMech.players[0]!.baseUnits = [makeUnit({ tags: ["Mech"] })];
    expect(unitEntersReady(withMech, 0, realUnitInstance(BREAKNECK_MECH))).toBe(true);
  });

  it("Xin Zhao counts BASE units only, and needs two", () => {
    const one = makeState();
    one.players[0]!.baseUnits = [makeUnit()];
    expect(unitEntersReady(one, 0, realUnitInstance(XIN_ZHAO)), "one is not two").toBe(false);

    const two = makeState();
    two.players[0]!.baseUnits = [makeUnit(), makeUnit()];
    expect(unitEntersReady(two, 0, realUnitInstance(XIN_ZHAO))).toBe(true);

    // "in your BASE" is printed, so units at a battlefield do not count — the
    // line that separates him from Direwing above.
    const atBattlefields = makeState();
    atBattlefields.battlefields[0]!.units = { p1: [makeUnit(), makeUnit()] };
    expect(unitEntersReady(atBattlefields, 0, realUnitInstance(XIN_ZHAO)), "battlefield units counted").toBe(false);
  });

  it("none of the four readies an ordinary unit", () => {
    // The negative control on the switch itself: a defId that is not one of the
    // four must fall through to `false`.
    const state = makeState();
    state.players[0]!.baseUnits = [makeUnit({ tags: ["Dragon"] }), makeUnit({ tags: ["Mech"] })];
    expect(unitEntersReady(state, 0, makeUnit())).toBe(false);
  });
});
