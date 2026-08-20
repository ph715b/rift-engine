import { describe, expect, it } from "vitest";
import {
  createCardInstance,
  defaultCardRegistry,
  legalActions,
  submit,
  targetingForCard,
  type GameState,
  type PlayCardAction,
  type RuneCard,
  type UnitInstance,
} from "@rift-engine/engine";
import { targetingBlockedReason, whereClause } from "../src/unplayable-target-reason.js";

/**
 * **The board must say the TRUE reason a card cannot be played.**
 *
 * Reported from playtesting: *"cant cast repulse in response to opponent
 * targeting my unit with starcrossed"*. The engine was right the whole way
 * through the repro — Star-Crossed's targets are `scope: "anywhere"` so it
 * reaches a unit in your BASE (355.9.a.1), while Repulse prints "a friendly unit
 * AT A BATTLEFIELD" (355.9.b), and a base unit genuinely cannot be protected.
 *
 * What was broken was the EXPLANATION. Two branches asserted one card's wording
 * for every card of their kind:
 *
 *   - every `unit` spec was described as needing a target "at a battlefield",
 *     including the many with `scope: "anywhere"`;
 *   - every `chainSpellAndUnit` card was said to need "a spell on the chain to
 *     counter and a friendly unit to BUFF" — Riposte's text. Repulse buffs
 *     nothing, and the sentence named two things the player could see they had.
 *
 * That is the same class as the previous playtest round, where all three reports
 * turned out to be web bugs sitting on correct engines. These assertions are on
 * the STRING against a real board, not on a DOM node existing — the vacuous
 * shape that round also produced.
 */

const registry = defaultCardRegistry();

const REPULSE = "UNL-106"; // "[Reaction] Choose a friendly unit AT A BATTLEFIELD. Counter an enemy spell … that chooses it and no other friendly unit."
const STAR_CROSSED = "UNL-128"; // "[Reaction] Return a friendly unit and an enemy unit to their owners' hands." — scope anywhere
const FRIGID_TOUCH = "SFD-066"; // "Give a unit -2 Might this turn" — a `unit` spec with scope "anywhere"
const INCINERATE = "OGS-003"; // a `unit` spec at the DEFAULT battlefield scope, for the contrast
const PLAIN_UNIT = "OGN-219"; // Order Unit, 4 Might, no text at all

const card = (defId: string) => createCardInstance(registry.get(defId));
const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

const reasonFor = (state: GameState, defId: string) =>
  targetingBlockedReason(state, 0, card(defId), targetingForCard(card(defId), undefined));

/** A plain 4-Might body with a known id, for boards where only position matters. */
const makeUnit = (instanceId: string): UnitInstance => ({ ...(createCardInstance(registry.get(PLAIN_UNIT)) as UnitInstance), instanceId });

function player(id: string) {
  return {
    id,
    name: id,
    legend: {
      instanceId: `${id}-legend`,
      defId: "TEST-LEGEND",
      name: "Test Legend",
      domains: [],
      exhausted: false,
      isToken: false,
      kind: "Legend" as const,
      championTag: "TEST",
    },
    championZone: null,
    chosenChampionDefId: "TEST-CHAMPION",
    readyRunesAtEndOfTurn: 0,
    spellChoiceDrawnBattlefieldIds: [],
    deck: [], hand: [], trash: [], banished: [], activeGear: [], runeDeck: [], channeled: [], baseUnits: [],
    points: 0, xp: 0, floatingEnergy: 0, floatingPower: {}, floatingRainbowPower: 0, cardsPlayedThisTurn: 0,
    firstFriendlyDeathUsedThisTurn: false, extraMightPerBuffThisTurn: 0, discardedThisTurn: false,
    scoredBattlefieldsThisTurn: [], unitsEnterReadyThisTurn: false, restrictedSpellEnergy: 0,
    restrictedUnitEnergy: 0,
    restrictedSpellPower: 0, nextUnitsEnterReady: 0, unitsLostThisTurn: 0, nextSpellEnergyDiscount: 0,
    nextCardEnergyDiscount: 0, nextCardPowerDiscount: 0,
    nextSpellBonusDamage: 0, cannotPlayCardsThisTurn: false, hideIgnoresCostThisTurn: false,
    preventsSpellDamageThisTurn: false, replacedCostPlays: [],
  };
}

/** An empty Action-phase board with both players holding runes. */
function emptyBoard(): GameState {
  const state = {
    players: [player("p1"), player("p2")],
    battlefields: [
      { id: "bf1", name: "BF1", controllerId: null, units: {}, contestedByIndex: null, hiddenCards: [] },
      { id: "bf2", name: "BF2", controllerId: null, units: {}, contestedByIndex: null, hiddenCards: [] },
    ],
    activePlayerIndex: 0, firstPlayerIndex: 0, turnNumber: 4, phase: "Action", turnState: "Neutral",
    focusHolder: 0, showdownBattlefieldId: null, showdownKind: null, consecutiveFocusPasses: 0,
    chainOpen: true, chainPriority: 0, chainPasses: 0, chainOpenedByTrigger: false, spellChain: [],
    pendingTriggers: [], declaredWinnerIndex: null, killDamagedUnitsThisTurn: false, spellResolvingForIndex: null,
    markedForDeathOnDamageInstanceIds: [], extraTurns: 0, extraTurnsForIndex: 0, lastShowdownExcessDamage: null,
    deathWardedUnitInstanceIds: [], banishOnDeathUnitInstanceIds: [], damageDoubledUnitInstanceIds: [],
    paidDeathWardUnitInstanceIds: [], unitsAwaitingDeathReplacement: [],
    unitsAwaitingFreePlacement: [], pendingDecisions: [], damagePreventedOnceInstanceIds: [],
    damagePreventionPoolByInstanceId: {}, disempowerAtEndOfTurn: [], empowerAtEndOfTurn: [],
    damageInstancesByCardThisTurn: {}, movementLockedUnitInstanceIds: [],
  } as unknown as GameState;
  state.players[0]!.channeled = Array.from({ length: 8 }, (_, i) => rune(`b${i}`, "Body"));
  state.players[1]!.channeled = Array.from({ length: 12 }, (_, i) => rune(`c${i}`, "Chaos"));
  return state;
}

/**
 * The reported board: the opponent has cast Star-Crossed naming a unit of theirs
 * and one of MINE, and the chain is waiting. `inBase` decides whether my unit is
 * somewhere Repulse can reach.
 */
function starCrossedAimedAtMe(inBase: boolean): GameState {
  const state = emptyBoard();
  state.activePlayerIndex = 1;
  const mine = makeUnit("mine");
  const theirs = makeUnit("theirs");
  if (inBase) state.players[0]!.baseUnits = [mine];
  else state.battlefields[0]!.units = { p1: [mine] };
  state.battlefields[0]!.units = { ...state.battlefields[0]!.units, p2: [theirs] };
  state.players[1]!.hand = [card(STAR_CROSSED)];

  const cast = legalActions(state).find(
    (a): a is PlayCardAction =>
      a.type === "PlayCard" && a.card.defId === STAR_CROSSED && a.secondTargetUnitInstanceId === "mine",
  );
  expect(cast, "the fixture could not aim Star-Crossed at my unit").toBeDefined();
  const chained = submit(state, cast!).state;
  // 345 — the caster acts on their own spell first, so pass once to hand the
  // window over. Without this the board being described is the wrong one.
  const pass = legalActions(chained).find((a) => a.type === "PassFocus" && a.playerIndex === 1);
  return pass ? submit(chained, pass).state : chained;
}

describe("whereClause reads the spec instead of asserting a battlefield", () => {
  it("names each scope the way the rules do", () => {
    // 198.1 puts the Bases on the Board, which is why "anywhere" is not a
    // synonym for "at a battlefield".
    expect(whereClause("battlefield")).toBe("at a battlefield");
    expect(whereClause("anywhere")).toBe("on the board");
    expect(whereClause("base")).toBe("in a base");
    // Absent is the default, and the default is the narrow one.
    expect(whereClause(undefined)).toBe("at a battlefield");
  });

  it("does not tell a wide-scope card it needs a battlefield", () => {
    // **The bug, on the commonest kind.** Frigid Touch reaches a unit in a base;
    // saying otherwise sends the player looking for a problem that is not there.
    const reason = reasonFor(emptyBoard(), FRIGID_TOUCH);
    expect(reason, "a scope: anywhere card was described as battlefield-only").not.toContain("at a battlefield");
    expect(reason).toContain("on the board");
  });

  it("...and still says 'at a battlefield' for one that means it", () => {
    // The control beside it. Without this the fix could have replaced one wrong
    // constant with another.
    expect(reasonFor(emptyBoard(), INCINERATE)).toContain("at a battlefield");
  });
});

describe("Repulse says WHICH half it is missing", () => {
  it("names the unit half when the opponent aimed at a unit in my BASE", () => {
    // **The reported case, and the engine is right to refuse.** What the player
    // needs told is that the unit must be at a battlefield — not that they lack a
    // spell to counter, which they visibly have.
    const state = starCrossedAimedAtMe(true);
    expect(legalActions(state).filter((a) => a.type === "PlayCard" && a.card.defId === REPULSE), "the engine offered Repulse — this fixture no longer reproduces the report").toEqual([]);

    const reason = reasonFor(state, REPULSE);
    expect(reason, "the message did not name the unit half").toContain("friendly unit at a battlefield");
    expect(reason, "the message still claims there is no spell to counter").not.toContain("no legal pairing");
    // The old wording, and the whole reason this test exists.
    expect(reason, "the message still describes Repulse as a buff").not.toMatch(/buff/i);
  });

  it("names the SPELL half when the chain is empty", () => {
    const state = emptyBoard();
    state.battlefields[0]!.units = { p1: [makeUnit("mine")] };
    const reason = reasonFor(state, REPULSE);

    expect(reason, "the message did not name the spell half").toContain("spell on the chain");
    expect(reason, "it blamed the unit half too, which is present").not.toContain("you have none there");
  });

  it("names BOTH when neither exists", () => {
    const reason = reasonFor(emptyBoard(), REPULSE);
    expect(reason).toContain("you have neither");
  });

  it("explains the PAIRING when both halves exist but no pair is legal", () => {
    // The case that looks most like a bug from the player's side: a spell on the
    // chain, a friendly unit at a battlefield, and still no play — because that
    // spell does not choose that unit. Repulse's printed restriction.
    const state = emptyBoard();
    state.activePlayerIndex = 1;
    state.battlefields[0]!.units = { p1: [makeUnit("mine"), makeUnit("other")], p2: [makeUnit("theirs")] };
    state.players[1]!.hand = [card(STAR_CROSSED)];
    const cast = legalActions(state).find(
      (a): a is PlayCardAction =>
        a.type === "PlayCard" && a.card.defId === STAR_CROSSED && a.secondTargetUnitInstanceId === "other",
    );
    expect(cast, "the fixture could not aim Star-Crossed").toBeDefined();
    let chained = submit(state, cast!).state;
    const pass = legalActions(chained).find((a) => a.type === "PassFocus" && a.playerIndex === 1);
    if (pass) chained = submit(chained, pass).state;

    // Repulse IS playable here — against "other". The message is only reached when
    // nothing is legal, so this asserts the branch directly rather than pretending
    // the board is stuck.
    const reason = reasonFor(chained, REPULSE);
    expect(reason, "the pairing branch was not reached").toContain("no legal pairing");
    expect(reason, "the pairing explanation does not say what the restriction is").toMatch(/no other/);
  });
});
