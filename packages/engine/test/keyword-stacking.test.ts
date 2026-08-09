import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { deflectSurcharge, effectiveKeywords } from "../src/engine/granted-keywords.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { attachEquipment } from "../src/engine/equipment.js";
import { grantKeywordThisTurn } from "../src/engine/effect-helpers.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { Domain } from "../src/model/domain.js";
import { makeState, makeUnit, realGearInstance, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * **Two sources of one keyword: does the value SUM or is the second redundant?**
 *
 * The rules answer per keyword and there is no general rule either way — see
 * src/engine/keyword-stacking.ts for the full citation list and for the false
 * "817.1.a" that ~28 `Math.max` merges in this engine used to rest on.
 *
 * This file is built on 807.2's OWN WORKED EXAMPLE, which is reproducible in this
 * pool card for card:
 *
 *   *"Example: Petty Officer has Assault. It is chosen as the target of Cleave,
 *   which says 'Give a unit [Assault 3] this turn.' After Cleave resolves, Petty
 *   Officer has Assault 4 this turn."*
 *
 * Petty Officer is OGN-215 (5 Might, `[Assault]`) and Cleave is OGN-004. So the
 * number this asserts is not a reading of the rule — it is printed in it.
 *
 * Three things have to hold together, and only the third is hard to fake:
 *
 *  1. the map reads 4;
 *  2. an UNVALUED keyword still does not stack — without this a blanket sum is
 *     indistinguishable from a correct fix;
 *  3. **combat damage changes.** A map holding a 4 is worth nothing if
 *     `effectiveMight` or `resolveShowdown` never sees it, which is exactly the
 *     failure mode a resolver-level test cannot detect. The defender below is
 *     tuned so that the old max merge leaves it ALIVE and the summed value kills
 *     it.
 */

const PETTY_OFFICER = "OGN-215"; // 5 Might, prints [Assault] — the rules' own example unit
const CLEAVE = "OGN-004"; // 1 Energy Fury Action: "Give a unit [Assault 3] this turn."
const CLOTH_ARMOR = "SFD-064"; // [Shield 2] — a VALUED keyword from an Equipment
const BOOTS_OF_SWIFTNESS = "SFD-133"; // [Ganking] — an UNVALUED one, the negative control
const DORANS_SHIELD = "SFD-033"; // [Tank] — a second unvalued control

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `action was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** Passes focus until the chain empties — a Spell takes effect on resolution. */
function resolveChain(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 8 && current.spellChain.length > 0; guard += 1) {
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    expect(pass, "no focus pass was offered while the chain was non-empty").toBeDefined();
    current = accept(current, pass);
  }
  expect(current.spellChain, "the chain never resolved").toHaveLength(0);
  return current;
}

const runes = (domain: Domain, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

/**
 * The rules' example board: a real Petty Officer contesting bf1 against a
 * defender, and a real Cleave in hand with the Fury to cast it.
 *
 * `defenderMight` is the dial the combat assertion turns.
 */
function pettyOfficerVs(defenderMight: number) {
  const officer = realUnitInstance(PETTY_OFFICER);
  const defender = makeUnit({ name: "Defender", instanceId: "defender", might: defenderMight });
  const cleave = spellInstance(CLEAVE);
  const state = makeState({ phase: "Action" });
  state.players[0]!.hand = [cleave];
  state.players[0]!.channeled = runes("Fury", 4);
  state.battlefields[0]!.units = { p1: [officer], p2: [defender] };
  return { state, officerId: officer.instanceId, cleaveId: cleave.instanceId };
}

/** Plays Cleave at the Officer through the REAL submit path and resolves it. A
 *  direct call to the effect's `resolve` would pass even if the enumerator never
 *  offered the target — the dispatch hop is the part worth exercising. */
function castCleaveAt(state: GameState, cleaveId: string, targetInstanceId: string): GameState {
  const play = legalActions(state).find(
    (a): a is PlayCardAction =>
      a.type === "PlayCard" && a.card.instanceId === cleaveId && a.targetUnitInstanceId === targetInstanceId,
  );
  expect(play, "Cleave was never offered against the Petty Officer").toBeDefined();
  return resolveChain(accept(state, play));
}

const officerAt = (state: GameState, officerId: string) =>
  state.battlefields[0]!.units["p1"]!.find((u) => u.instanceId === officerId)!;

describe("807.2's worked example: Petty Officer + Cleave is [Assault 4]", () => {
  it("reads 4, not 3 — the printed instance and the granted one SUM", () => {
    const { state, officerId, cleaveId } = pettyOfficerVs(9);
    const after = castCleaveAt(state, cleaveId, officerId);

    // The old max merge answers 3 here (Cleave's value alone), which is also what
    // it answers for a unit with NO printed Assault — so a test that asserted
    // "greater than 1" would have passed against the bug.
    expect(effectiveKeywords(after, officerAt(after, officerId), 0).Assault, "the printed [Assault] was swallowed").toBe(4);
  });

  it("the printed instance is really there — the control for the 4", () => {
    const { state, officerId } = pettyOfficerVs(9);
    expect(effectiveKeywords(state, officerAt(state, officerId), 0).Assault).toBe(1);
  });

  /**
   * **The measurement that matters.** `[Assault]` is only worth anything through
   * `effectiveMight`'s combat terms, so this drives a real `resolveShowdown` and
   * asserts a unit LIVES or DIES.
   *
   * 5 Might + Assault 4 = 9 outgoing, which is exactly lethal to a 9-Might
   * defender. Under the old `Math.max` merge the Officer swings 8 and the
   * defender walks away with 8 damage marked — so this pair of tests is the
   * before/after, and the second is the negative control that keeps the first
   * from being a tautology about a big number.
   */
  it("swings 9 — the summed value reaches effectiveMight's outgoing term", () => {
    const { state, officerId, cleaveId } = pettyOfficerVs(9);
    const armed = castCleaveAt(state, cleaveId, officerId);

    expect(
      effectiveMight(armed, officerAt(armed, officerId), 0, {
        isCombat: true,
        isAttackingSide: true,
        combatRole: "outgoing",
        battlefieldId: "bf1",
      }),
      "outgoing Might did not carry the summed [Assault]",
    ).toBe(9);
  });

  /** Its own test, so the DEATH is mutation-proved independently of the Might
   *  number above — an assertion that never runs because an earlier one threw is
   *  an assertion nobody has measured. */
  it("KILLS a 9-Might defender it could not scratch at [Assault 3]", () => {
    const { state, officerId, cleaveId } = pettyOfficerVs(9);
    const fought = resolveShowdown(castCleaveAt(state, cleaveId, officerId), "bf1", 0);

    expect(fought.battlefields[0]!.units["p2"] ?? [], "the defender survived a lethal swing").toHaveLength(0);
    expect(fought.players[1]!.trash, "the defender did not reach its owner's trash").toHaveLength(1);
  });

  it("and does NOT kill a 10-Might one — the swing is 9, not 'lots'", () => {
    const { state, officerId, cleaveId } = pettyOfficerVs(10);
    const armed = castCleaveAt(state, cleaveId, officerId);
    const fought = resolveShowdown(armed, "bf1", 0);

    expect(fought.battlefields[0]!.units["p2"] ?? []).toHaveLength(1);
  });

  it("without Cleave the same board leaves the 9-Might defender alive", () => {
    // The before-picture, off the identical board: 5 + printed [Assault 1] = 6.
    const { state } = pettyOfficerVs(9);
    const fought = resolveShowdown(state, "bf1", 0);

    expect(fought.battlefields[0]!.units["p2"] ?? [], "the Officer killed it with no Cleave at all").toHaveLength(1);
  });
});

/**
 * The negative control, and the reason a blanket sum would not pass this file.
 *
 * Each of these keywords has its OWN redundancy rule — 810.2 Ganking, 815.2 Tank
 * — and none of them is 817.1.a, which is Vision's "It is present on Permanents".
 */
describe("an UNVALUED keyword is still redundant across two sources", () => {
  /** A bare unit wearing `gearDefIds`. */
  function wearing(...gearDefIds: string[]): { state: GameState; unitId: string } {
    const unit = makeUnit({ name: "Wearer", might: 3 });
    const state = makeState();
    state.players[0]!.baseUnits = [unit];
    state.players[0]!.activeGear = gearDefIds.map((id) => realGearInstance(id));
    let next = state;
    for (const gear of state.players[0]!.activeGear) {
      next = attachEquipment(next, 0, gear.instanceId, unit.instanceId);
    }
    return { state: next, unitId: unit.instanceId };
  }

  const keywordsOf = (state: GameState, unitId: string) =>
    effectiveKeywords(state, state.players[0]!.baseUnits.find((u) => u.instanceId === unitId)!, 0);

  it("two Boots of Swiftness are still [Ganking] (810.2)", () => {
    const { state, unitId } = wearing(BOOTS_OF_SWIFTNESS, BOOTS_OF_SWIFTNESS);
    expect(keywordsOf(state, unitId).Ganking, "[Ganking] accumulated").toBe(1);
  });

  it("two Doran's Shields are still [Tank] (815.2)", () => {
    const { state, unitId } = wearing(DORANS_SHIELD, DORANS_SHIELD);
    expect(keywordsOf(state, unitId).Tank, "[Tank] accumulated").toBe(1);
  });

  it("but two Cloth Armors ARE [Shield 4] (814.2) — the same merge, opposite answer", () => {
    // The two assertions above and this one go through ONE code path
    // (`equipmentKeywordsFor`), which is what makes the pair a control rather
    // than two unrelated facts.
    const { state, unitId } = wearing(CLOTH_ARMOR, CLOTH_ARMOR);
    expect(keywordsOf(state, unitId).Shield).toBe(4);
  });

  /**
   * The other two summed keywords, each through the reader that gives it meaning.
   * Neither is [Assault], so neither is covered by the combat assertions above,
   * and both were merged by the same `Math.max`.
   */
  it("[Deflect] sums and the SURCHARGE moves with it (809.2)", () => {
    // Volibear - Furious prints [Deflect 2]; Hexdrinker grants [Deflect 1].
    const volibear = realUnitInstance("OGN-041");
    const state = makeState();
    state.players[0]!.baseUnits = [volibear];
    state.players[0]!.activeGear = [realGearInstance("SFD-102")];
    const worn = attachEquipment(state, 0, state.players[0]!.activeGear[0]!.instanceId, volibear.instanceId);

    expect(deflectSurcharge(worn, worn.players[0]!.baseUnits[0]!, 0, 1), "the opponent was undercharged").toBe(3);
    // And the tax is still on OPPONENTS only — the control that keeps the 3 from
    // being "any number bigger than before".
    expect(deflectSurcharge(worn, worn.players[0]!.baseUnits[0]!, 0, 0)).toBe(0);
  });

  it("[Hunt] sums (823.2) — a printed [Hunt 2] under Hunter's Machete is 3", () => {
    // Hunter's Machete grants [Hunt] on its ART, and it is the only card in four
    // sets that grants the keyword at all — so this merge is the whole of 823.2's
    // reachability today.
    const scorchclaw = realUnitInstance("UNL-016"); // [Hunt 2]
    const state = makeState();
    state.players[0]!.baseUnits = [scorchclaw];
    state.players[0]!.activeGear = [realGearInstance("UNL-096")];
    const worn = attachEquipment(state, 0, state.players[0]!.activeGear[0]!.instanceId, scorchclaw.instanceId);

    expect(effectiveKeywords(state, scorchclaw, 0).Hunt, "the printed [Hunt 2] is not there to add to").toBe(2);
    expect(effectiveKeywords(worn, worn.players[0]!.baseUnits[0]!, 0).Hunt).toBe(3);
  });

  it("and a repeated this-turn grant splits the same way", () => {
    // `grantKeywordThisTurn` is the other merge site, reached by every "give a
    // unit [X] this turn" spell and by two battlefield abilities.
    const unit = makeUnit({ instanceId: "u", might: 3 });
    const state = makeState();
    state.players[0]!.baseUnits = [unit];

    const twice = grantKeywordThisTurn(grantKeywordThisTurn(state, "u", "Assault", 2), "u", "Assault", 2);
    expect(twice.players[0]!.baseUnits[0]!.keywordsThisTurn.Assault, "[Assault] did not sum").toBe(4);

    const ganked = grantKeywordThisTurn(grantKeywordThisTurn(state, "u", "Ganking"), "u", "Ganking");
    expect(ganked.players[0]!.baseUnits[0]!.keywordsThisTurn.Ganking, "[Ganking] accumulated").toBe(1);
  });
});
