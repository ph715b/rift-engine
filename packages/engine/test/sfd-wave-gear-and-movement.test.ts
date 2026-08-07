import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { validateRecallUnit } from "../src/actions/validate-recall-unit.js";
import { recallUnitToBase } from "../src/engine/effect-helpers.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { ActivateAbilityAction, PlayCardAction, RecallUnitAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * Three SFD cards that needed no new mechanism — one per shape, and each is here
 * because the shape is what could go wrong:
 *
 *  - **Detonate** kills a gear and hands the DRAW to its owner, so the test that
 *    matters is whose hand grew;
 *  - **Heart of Dark Ice** is Orb of Regret's mirror, so the test that matters is
 *    the SIGN;
 *  - **Minotaur Reckoner** forbids moving to base, and the test that matters is
 *    that it reaches every WAY home rather than the one the enumerator uses.
 */

const registry = defaultCardRegistry();
const DETONATE = "SFD-005";
const HEART_OF_DARK_ICE = "SFD-052";
const MINOTAUR_RECKONER = "SFD-014";
const DORANS_BLADE = "SFD-095";

const gear = (defId: string): GearInstance => createCardInstance(registry.get(defId)) as GearInstance;
const runes = (domain: RuneCard["domain"], n: number): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${domain}${i}`, domain, state: "Ready" as const }));

function settle(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 8 && !current.chainOpen; guard += 1) {
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) break;
    current = submit(current, pass).state;
  }
  return current;
}

describe("Detonate (SFD-005): kill a gear, its controller draws 2", () => {
  /** p0 holds Detonate; the target gear belongs to `gearOwner`. */
  function board(gearOwner: 0 | 1) {
    const spell = spellInstance(DETONATE);
    const victim = gear(DORANS_BLADE);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runes("Fury", 6);
    state.players[gearOwner]!.activeGear = [victim];
    // Both decks stocked, so "who drew" is a real question rather than one
    // answered by an empty deck.
    for (const p of [0, 1] as const) {
      state.players[p]!.deck = Array.from({ length: 5 }, () => spellInstance(DETONATE));
    }
    return { state, spellId: spell.instanceId, victimId: victim.instanceId };
  }

  const play = (state: GameState, spellId: string, targetId: string) =>
    legalActions(state).find(
      (a): a is PlayCardAction =>
        a.type === "PlayCard" && a.card.instanceId === spellId && a.targetPermanentInstanceId === targetId,
    );

  it("kills an ENEMY gear and the ENEMY draws 2", () => {
    const { state, spellId, victimId } = board(1);
    const before = [state.players[0]!.hand.length, state.players[1]!.hand.length] as const;
    const after = settle(submit(state, play(state, spellId, victimId)!).state);

    expect(after.players[1]!.activeGear, "the gear survived").toHaveLength(0);
    expect(after.players[1]!.hand.length, "the gear's controller did not draw 2").toBe(before[1] + 2);
    // The caster's hand is down by the Detonate it spent and up by nothing.
    expect(after.players[0]!.hand.length, "the CASTER drew — the card pays its victim").toBe(before[0] - 1);
  });

  /** Aimed at your own gear, YOU draw — the same clause read the same way. */
  it("kills a FRIENDLY gear and then the caster draws", () => {
    const { state, spellId, victimId } = board(0);
    const before = state.players[0]!.hand.length;
    const after = settle(submit(state, play(state, spellId, victimId)!).state);

    expect(after.players[0]!.activeGear).toHaveLength(0);
    // -1 for the Detonate itself, +2 for the draw.
    expect(after.players[0]!.hand.length).toBe(before - 1 + 2);
    expect(after.players[1]!.hand.length, "the opponent drew for a gear that was not theirs").toBe(0);
  });

  /** Both sides' gear is a legal target — the card names no owner. */
  it("offers gear on BOTH sides", () => {
    const { state, spellId } = board(1);
    const mine = gear(DORANS_BLADE);
    const withBoth: GameState = {
      ...state,
      players: [{ ...state.players[0]!, activeGear: [mine] }, state.players[1]!],
    };
    const offered = legalActions(withBoth)
      .filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === spellId)
      .map((a) => a.targetPermanentInstanceId);

    expect(offered).toContain(mine.instanceId);
    expect(offered.length, "only one side's gear was offered").toBeGreaterThan(1);
  });
});

describe("Heart of Dark Ice (SFD-052): +3 Might this turn", () => {
  function board() {
    const heart = gear(HEART_OF_DARK_ICE);
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [heart];
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "mine", might: 2 })];
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "theirs", might: 2 })];
    return { state, heartId: heart.instanceId };
  }

  const use = (state: GameState, heartId: string, targetId: string) =>
    legalActions(state).find(
      (a): a is ActivateAbilityAction =>
        a.type === "ActivateAbility" && a.permanentInstanceId === heartId && a.targetUnitInstanceId === targetId,
    );

  /** The SIGN, which is the one thing a mirror of Orb of Regret can get wrong. */
  it("adds 3, and does not subtract", () => {
    const { state, heartId } = board();
    const after = submit(state, use(state, heartId, "mine")!).state;
    const unit = after.players[0]!.baseUnits[0]!;

    expect(effectiveMight(after, unit, 0, { isCombat: false }), "the pump was the wrong sign or size").toBe(5);
    expect(after.players[0]!.activeGear[0]!.exhausted, "the Heart was not exhausted").toBe(true);
  });

  /** "A unit" names no owner, so an enemy unit is a legal — if unwise — target,
   *  the same reading Orb of Regret takes. */
  it("can target either player's unit", () => {
    const { state, heartId } = board();
    expect(use(state, heartId, "theirs"), "an enemy unit was not offered").toBeDefined();
  });
});

describe("Minotaur Reckoner (SFD-014): units can't move to base", () => {
  /** A Minotaur belonging to `owner`, and one of p0's units at bf1 to send home. */
  function board(owner?: 0 | 1): GameState {
    const state = makeState({ phase: "Action" });
    const traveller = makeUnit({ instanceId: "traveller", might: 2 });
    state.battlefields[0]!.units = { [state.players[0]!.id]: [traveller] };
    if (owner !== undefined) state.players[owner]!.baseUnits = [realUnitInstance(MINOTAUR_RECKONER)];
    return state;
  }

  const recall: RecallUnitAction = { type: "RecallUnit", playerIndex: 0, unitInstanceIds: ["traveller"] };

  /** Did the traveller specifically reach base? Counting `baseUnits` would be
   *  wrong: a board WITH a Minotaur already has one unit standing there. */
  const wentHome = (state: GameState) =>
    state.players[0]!.baseUnits.some((u) => u.instanceId === "traveller");

  it("is implemented at all", () => {
    expect(isCardImplemented(registry.get(MINOTAUR_RECKONER))).toBe(true);
  });

  /** The premise: with no Minotaur, going home is legal by all three routes. */
  it("without one, a unit may go home", () => {
    const state = board();
    expect(validateRecallUnit(state, recall).ok).toBe(true);
    expect(legalActions(state).some((a) => a.type === "RecallUnit")).toBe(true);
    expect(wentHome(recallUnitToBase(state, "traveller"))).toBe(true);
  });

  /**
   * **All three routes home, not just the enumerated one.** The card-effect
   * route (`recallUnitToBase`) is the one a Minotaur check placed only in the
   * validator would miss, and it is how Flash and Maddened Marauder move units.
   */
  it("blocks the player's recall, the offer, AND a card effect", () => {
    const state = board(0);

    expect(validateRecallUnit(state, recall).ok, "the RecallUnit action was still legal").toBe(false);
    expect(legalActions(state).some((a) => a.type === "RecallUnit"), "a recall was still offered").toBe(false);
    expect(wentHome(recallUnitToBase(state, "traveller")), "a card effect walked past it").toBe(false);
  });

  /**
   * **Symmetric** — "units", with no owner clause, so the OPPONENT's Minotaur
   * stops your units too. The widest reading, and the printed one.
   */
  it("an ENEMY Minotaur stops your units as well", () => {
    expect(validateRecallUnit(board(1), recall).ok, "an enemy Minotaur was ignored").toBe(false);
  });

  /** And it stops its own controller's units — there is no "your" here either. */
  it("stops the units of the player who controls it", () => {
    const state = board(0);
    expect(wentHome(recallUnitToBase(state, "traveller"))).toBe(false);
  });
});
