import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validateRecallUnit } from "../src/actions/validate-recall-unit.js";
import { validateHideCard } from "../src/actions/validate-hide-card.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { effectiveKeywords } from "../src/engine/granted-keywords.js";
import { dealDamage, recallUnitToBase } from "../src/engine/effect-helpers.js";
import { victoryScore, opponentNearVictory } from "../src/engine/constants.js";
import { winner } from "../src/engine/win-condition.js";
import { recordConquest } from "../src/engine/scoring.js";
import { battlefieldDefIdFor } from "../src/decks/battlefield-setup.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, spellInstance } from "./fixtures.js";

/**
 * The six battlefields whose ability is CONTINUOUS.
 *
 * Nothing here goes on the chain: a continuous ability is read at a GATE, which
 * is why the table lives in `battlefield-continuous.ts` beside the same split
 * `board-restrictions.ts` already makes. What each test therefore drives is the
 * READ SITE — `effectiveMight`, `effectiveKeywords`, the recall validator AND
 * the enumerator, `dealDamage`, `winner`, the hide validator — because a
 * continuous ability that only one of a pair of readers knows about is exactly
 * how this codebase produces an action that is offered and then refused.
 */

const ASPIRANTS_CLIMB = "OGN-276";
const BANDLE_TREE = "OGN-278";
const TRIFARIAN_WAR_CAMP = "OGN-294";
const VILEMAWS_LAIR = "OGN-295";
const VOID_GATE = "OGN-296";
const WINDSWEPT_HILLOCK = "OGN-297";

/** A [Hidden] card, so the hide tests have something legal to hide. */
const HIDDEN_SPELL = "OGN-213";

const rune = (id: string): RuneCard => ({ id, domain: "Calm", state: "Ready" });

/** bf1 IS the named battlefield, with `units` of player 0 standing there. */
function at(defId: string, units: UnitInstance[] = []): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.battlefields[0] = { ...state.battlefields[0]!, defId, units: { p1: units }, controllerId: "p1" };
  return state;
}

describe("the six continuous battlefields are the cards they claim to be", () => {
  it("every name in the table is a battlefield that really prints that text", () => {
    for (const [defId, name] of [
      [ASPIRANTS_CLIMB, "Aspirant's Climb"],
      [BANDLE_TREE, "Bandle Tree"],
      [TRIFARIAN_WAR_CAMP, "Trifarian War Camp"],
      [VILEMAWS_LAIR, "Vilemaw's Lair"],
      [VOID_GATE, "Void Gate"],
      [WINDSWEPT_HILLOCK, "Windswept Hillock"],
    ] as const) {
      expect(battlefieldDefIdFor(name), `${name} resolves to a different card`).toBe(defId);
    }
  });
});

describe("Trifarian War Camp (OGN-294): units here have +1 Might", () => {
  it("adds 1 to a unit standing there and nothing to one in base", () => {
    const here = makeUnit({ might: 3 });
    const state = at(TRIFARIAN_WAR_CAMP, [here]);
    state.players[0]!.baseUnits = [makeUnit({ might: 3 })];
    expect(effectiveMight(state, here, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(4);
    expect(effectiveMight(state, state.players[0]!.baseUnits[0]!, 0, { isCombat: false })).toBe(3);
  });

  it("includes ATTACKERS — the parenthetical the card prints", () => {
    const here = makeUnit({ might: 3 });
    const state = at(TRIFARIAN_WAR_CAMP, [here]);
    const outgoing = effectiveMight(state, here, 0, {
      isCombat: true,
      isAttackingSide: true,
      combatRole: "outgoing",
      battlefieldId: "bf1",
    });
    expect(outgoing, "the War Camp did not reach outgoing combat damage").toBe(4);
  });

  it("helps BOTH sides — 'units here', not 'friendly units here'", () => {
    const theirs = makeUnit({ might: 2 });
    const state = at(TRIFARIAN_WAR_CAMP, [makeUnit()]);
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      units: { ...state.battlefields[0]!.units, p2: [theirs] },
    };
    expect(effectiveMight(state, theirs, 1, { isCombat: false, battlefieldId: "bf1" })).toBe(3);
  });

  it("adds nothing at a battlefield that is not the War Camp", () => {
    const there = makeUnit({ might: 3 });
    const state = at(TRIFARIAN_WAR_CAMP, []);
    state.battlefields[1] = { ...state.battlefields[1]!, units: { p1: [there] } };
    expect(effectiveMight(state, there, 0, { isCombat: false, battlefieldId: "bf2" })).toBe(3);
  });
});

describe("Windswept Hillock (OGN-297): units here have [Ganking]", () => {
  it("grants it to a unit standing there, and to the opponent's too", () => {
    const mine = makeUnit();
    const theirs = makeUnit();
    const state = at(WINDSWEPT_HILLOCK, [mine]);
    state.battlefields[0] = { ...state.battlefields[0]!, units: { p1: [mine], p2: [theirs] } };
    expect(effectiveKeywords(state, mine, 0)["Ganking"]).toBe(1);
    expect(effectiveKeywords(state, theirs, 1)["Ganking"]).toBe(1);
  });

  it("is what lets that unit actually move battlefield-to-battlefield", () => {
    // The point of folding it into `effectiveKeywords` rather than teaching the
    // move rules about battlefields: every reader gets it for free.
    const mine = makeUnit();
    const state = at(WINDSWEPT_HILLOCK, [mine]);
    const moves = legalActions(state).filter(
      (a) => a.type === "MoveUnit" && a.unitInstanceIds[0] === mine.instanceId && a.destinationBattlefieldId === "bf2",
    );
    expect(moves, "a unit at the Hillock was not offered a battlefield-to-battlefield move").toHaveLength(1);
    const { result } = submit(state, moves[0]!);
    expect(result).toMatchObject({ type: "Ok" });
  });

  it("grants nothing to a unit at another battlefield", () => {
    const there = makeUnit();
    const state = at(WINDSWEPT_HILLOCK, []);
    state.battlefields[1] = { ...state.battlefields[1]!, units: { p1: [there] } };
    expect(effectiveKeywords(state, there, 0)["Ganking"]).toBeUndefined();
  });
});

describe("Vilemaw's Lair (OGN-295): units can't move from here to base", () => {
  it("is neither offered nor accepted", () => {
    const mine = makeUnit();
    const state = at(VILEMAWS_LAIR, [mine]);
    const recalls = legalActions(state).filter((a) => a.type === "RecallUnit");
    expect(recalls, "the Lair offered a retreat").toHaveLength(0);
    const refused = validateRecallUnit(state, { type: "RecallUnit", playerIndex: 0, unitInstanceIds: [mine.instanceId] });
    expect(refused.ok, "the validator allowed a retreat the enumerator refuses to offer").toBe(false);
  });

  it("still allows a retreat from a different battlefield", () => {
    const elsewhere = makeUnit();
    const state = at(VILEMAWS_LAIR, [makeUnit()]);
    state.battlefields[1] = { ...state.battlefields[1]!, units: { p1: [elsewhere] } };
    const recalls = legalActions(state).filter(
      (a) => a.type === "RecallUnit" && a.unitInstanceIds[0] === elsewhere.instanceId,
    );
    expect(recalls).toHaveLength(1);
  });

  it("stops a card-driven 'move to base' too — those say MOVE", () => {
    const mine = makeUnit();
    const state = at(VILEMAWS_LAIR, [mine]);
    const after = recallUnitToBase(state, mine.instanceId);
    expect(after.players[0]!.baseUnits, "Flash walked a unit out of Vilemaw's Lair").toHaveLength(0);
    expect(after.battlefields[0]!.units["p1"]).toHaveLength(1);
  });
});

describe("Void Gate (OGN-296): spells and abilities deal 1 Bonus Damage to units here", () => {
  it("adds 1 to each instance of spell damage dealt here", () => {
    const here = makeUnit({ might: 5 });
    const state = at(VOID_GATE, [here]);
    const after = dealDamage(state, 1, here.instanceId, 2);
    expect(after.battlefields[0]!.units["p1"]![0]!.damage).toBe(3);
  });

  it("adds nothing to a unit in base", () => {
    const inBase = makeUnit({ might: 5 });
    const state = at(VOID_GATE, []);
    state.players[0]!.baseUnits = [inBase];
    const after = dealDamage(state, 1, inBase.instanceId, 2);
    expect(after.players[0]!.baseUnits[0]!.damage).toBe(2);
  });

  it("can be what makes the damage LETHAL", () => {
    // The bonus is applied before the lethal test, which is the whole reason it
    // has to go through `modifiedDamageAmount` rather than being added after.
    const here = makeUnit({ might: 3 });
    const state = at(VOID_GATE, [here]);
    const after = dealDamage(state, 1, here.instanceId, 2);
    expect(after.battlefields[0]!.units["p1"], "a 3-Might unit survived 2+1").toHaveLength(0);
  });
});

describe("Aspirant's Climb (OGN-276): the points needed to win go up by 1", () => {
  it("raises the Victory Score for both players", () => {
    const state = at(ASPIRANTS_CLIMB);
    expect(victoryScore(state)).toBe(9);
    expect(victoryScore(makeState())).toBe(8);
  });

  it("means 8 points is no longer a win", () => {
    const state = at(ASPIRANTS_CLIMB);
    state.players[0]!.points = 8;
    expect(winner(state)).toBeNull();
    state.players[0]!.points = 9;
    expect(winner(state)).toBe(0);
  });

  it("moves 474's Final Point rule with it", () => {
    // At 7 points and an incomplete sweep the ordinary board withholds the point
    // and draws instead; with the Climb in play 7 is two short, so the point is
    // simply awarded.
    const climb = at(ASPIRANTS_CLIMB);
    climb.players[0]!.points = 7;
    climb.players[0]!.deck = [spellInstance("OGN-164")];
    expect(recordConquest(climb, 0, "bf1").players[0]!.points).toBe(8);

    const ordinary = makeState({ phase: "Action" });
    ordinary.players[0]!.points = 7;
    ordinary.players[0]!.deck = [spellInstance("OGN-164")];
    const withheld = recordConquest(ordinary, 0, "bf1");
    expect(withheld.players[0]!.points, "the final-point rule stopped biting").toBe(7);
    expect(withheld.players[0]!.hand).toHaveLength(1);
  });

  it("moves the comeback clause with it — 'within 3 of the Victory Score'", () => {
    const state = at(ASPIRANTS_CLIMB);
    state.players[1]!.points = 6;
    expect(opponentNearVictory(state, 0)).toBe(true);
    state.players[1]!.points = 5;
    expect(opponentNearVictory(state, 0), "6 of 9 still counted as within 3").toBe(false);
  });
});

describe("Bandle Tree (OGN-278): you may hide an additional card here", () => {
  /** A player who controls bf1 and can afford to hide. */
  function hider(defId: string): GameState {
    const state = at(defId, [makeUnit()]);
    state.players[0]!.channeled = [rune("r1"), rune("r2")];
    state.players[0]!.hand = [spellInstance(HIDDEN_SPELL), spellInstance(HIDDEN_SPELL)];
    return state;
  }

  /** The state with `count` facedown cards already sitting at bf1. */
  function withHidden(state: GameState, count: number): GameState {
    return {
      ...state,
      battlefields: state.battlefields.map((bf) =>
        bf.id === "bf1"
          ? {
              ...bf,
              hiddenCards: Array.from({ length: count }, () => ({
                card: spellInstance(HIDDEN_SPELL),
                ownerIndex: 0 as const,
                hiddenOnTurn: 1,
              })),
            }
          : bf,
      ),
    };
  }

  it("allows a SECOND facedown card where an ordinary battlefield allows one", () => {
    const tree = withHidden(hider(BANDLE_TREE), 1);
    const offered = legalActions(tree).filter((a) => a.type === "HideCard" && a.battlefieldId === "bf1");
    expect(offered.length, "the Tree's second hide was never offered").toBeGreaterThan(0);
    expect(validateHideCard(tree, offered[0] as never).ok).toBe(true);
  });

  it("still stops at two", () => {
    const tree = withHidden(hider(BANDLE_TREE), 2);
    expect(legalActions(tree).filter((a) => a.type === "HideCard" && a.battlefieldId === "bf1")).toHaveLength(0);
  });

  it("an ordinary battlefield still stops at one", () => {
    const plain = withHidden(hider(TRIFARIAN_WAR_CAMP), 1);
    expect(legalActions(plain).filter((a) => a.type === "HideCard" && a.battlefieldId === "bf1")).toHaveLength(0);
  });
});
