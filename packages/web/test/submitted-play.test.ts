import { describe, expect, it } from "vitest";
import {
  createCardInstance,
  defaultCardRegistry,
  legalActions,
  submit,
  type GameState,
  type PlayCardAction,
  type RunePayment,
} from "@rift-engine/engine";
import { submittedPlay } from "../src/submitted-play.js";

/**
 * Reported from play: choosing both of Falling Star's targets and then pressing
 * Auto Pay gave **"Falling Star requires 2 targets, got 0"** — and the same when
 * paying by hand.
 *
 * The board rebuilt its `PlayCardAction` field by field from `pendingPlay`, and
 * `targetUnitInstanceIds` had no line. So every `unitList` card was submitted
 * with no targets. Two more were missing the same way: `xAmount` and
 * `fromHiddenBattlefieldId`.
 *
 * The fix is structural rather than three more spreads — see `submitted-play.ts`.
 * These tests pin BOTH directions: the old builder really did drop the list, and
 * the new one really does keep everything.
 */

const FALLING_STAR = "OGN-029"; // unitList, 2 targets, duplicates legal
const PLAIN_UNIT = "OGN-164";

const registry = defaultCardRegistry();
const instance = (defId: string) => createCardInstance(registry.get(defId));

/**
 * The OLD builder, verbatim — the `REGRESS=1` control this repo uses. If this
 * ever stops dropping the list, the bug it reproduces has changed shape and the
 * rest of this file is about nothing.
 */
function oldFieldByFieldBuilder(pending: PlayCardAction, payment: RunePayment): PlayCardAction {
  return {
    type: "PlayCard",
    playerIndex: 0,
    card: pending.card,
    payment,
    ...(pending.targetUnitInstanceId !== undefined ? { targetUnitInstanceId: pending.targetUnitInstanceId } : {}),
    ...(pending.secondTargetUnitInstanceId !== undefined
      ? { secondTargetUnitInstanceId: pending.secondTargetUnitInstanceId }
      : {}),
    ...(pending.targetBattlefieldId !== undefined ? { targetBattlefieldId: pending.targetBattlefieldId } : {}),
    ...(pending.trashCardInstanceId !== undefined ? { trashCardInstanceId: pending.trashCardInstanceId } : {}),
    ...(pending.visionRecycle !== undefined ? { visionRecycle: pending.visionRecycle } : {}),
    ...(pending.additionalCostUnitInstanceId !== undefined
      ? { additionalCostUnitInstanceId: pending.additionalCostUnitInstanceId }
      : {}),
    ...(pending.destinationBattlefieldId !== undefined
      ? { destinationBattlefieldId: pending.destinationBattlefieldId }
      : {}),
    ...(pending.acceleratePaid ? { acceleratePaid: true as const } : {}),
  };
}

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
    starSpringUsedBattlefieldIds: [],
    nonTokenUnitSurchargeThisTurn: 0,
    gearAbilitiesActivatedThisTurn: 0,
    energySpentOnLastPlay: 0,
    deck: [], hand: [], trash: [], banished: [], activeGear: [], runeDeck: [], channeled: [], baseUnits: [],
    points: 0, xp: 0, floatingEnergy: 0, floatingPower: {}, floatingRainbowPower: 0, cardsPlayedThisTurn: 0,
    firstFriendlyDeathUsedThisTurn: false, extraMightPerBuffThisTurn: 0, discardedThisTurn: false,
    scoredBattlefieldsThisTurn: [], unitsEnterReadyThisTurn: false, restrictedSpellEnergy: 0,
    restrictedUnitEnergy: 0,
    restrictedSpellPower: 0, nextUnitsEnterReady: 0, unitsLostThisTurn: 0, nextSpellEnergyDiscount: 0,
    nextCardEnergyDiscount: 0,
    nextCardPowerDiscount: 0,
    nextSpellBonusDamage: 0, cannotPlayCardsThisTurn: false, hideIgnoresCostThisTurn: false,
    preventsSpellDamageThisTurn: false, replacedCostPlays: [],
  };
}

/** Falling Star in hand, one enemy unit to point it at, runes to spare. */
function fallingStarBoard(): GameState {
  const state = {
    players: [player("p1"), player("p2")],
    battlefields: [
      {
        id: "bf1",
        name: "BF1",
        controllerId: null,
        units: { p2: [instance(PLAIN_UNIT)] },
        contestedByIndex: null,
        hiddenCards: [],
      },
      { id: "bf2", name: "BF2", controllerId: null, units: {}, contestedByIndex: null, hiddenCards: [] },
    ],
    activePlayerIndex: 0, firstPlayerIndex: 0, turnNumber: 4, phase: "Action", turnState: "Neutral",
    focusHolder: 0, showdownBattlefieldId: null, showdownKind: null, consecutiveFocusPasses: 0,
    chainOpen: true, chainPriority: 0, chainPasses: 0, chainOpenedByTrigger: false, spellChain: [],
    pendingTriggers: [], declaredWinnerIndex: null, killDamagedUnitsThisTurn: false, spellResolvingForIndex: null,
    markedForDeathOnDamageInstanceIds: [], extraTurns: 0, extraTurnsForIndex: 0, lastShowdownExcessDamage: null,
    deathWardedUnitInstanceIds: [], banishOnDeathUnitInstanceIds: [], damageDoubledUnitInstanceIds: [], paidDeathWardUnitInstanceIds: [], unitsAwaitingDeathReplacement: [],
    unitsAwaitingFreePlacement: [], pendingDecisions: [],
  } as unknown as GameState;
  state.players[0].hand = [instance(FALLING_STAR)];
  state.players[0].channeled = Array.from({ length: 8 }, (_, i) => ({
    id: `f${i}`,
    domain: "Fury" as const,
    state: "Ready" as const,
  }));
  return state;
}

/** The enumerated Falling Star play — what the board's choices resolve to. */
function enumeratedFallingStar(state: GameState): PlayCardAction {
  const play = legalActions(state).find(
    (a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === FALLING_STAR,
  );
  if (!play) throw new Error("Falling Star was not enumerated — the fixture is wrong");
  return play;
}

describe("the reported failure: a unitList card submitted with no targets", () => {
  it("the enumerated action really does carry two targets", () => {
    // The premise. Without it, "the builder dropped them" is unfalsifiable.
    const resolved = enumeratedFallingStar(fallingStarBoard());
    expect(resolved.targetUnitInstanceIds).toHaveLength(2);
  });

  it("the OLD builder dropped them, and the engine said exactly what the player saw", () => {
    const state = fallingStarBoard();
    const resolved = enumeratedFallingStar(state);
    const rebuilt = oldFieldByFieldBuilder(resolved, resolved.payment);
    expect(rebuilt.targetUnitInstanceIds, "the old builder no longer drops the list").toBeUndefined();
    const { result } = submit(state, rebuilt);
    expect(result.type).toBe("Invalid");
    expect((result as { error: string }).error).toBe("Falling Star requires 2 targets, got 0");
  });

  it("the NEW builder keeps them, and the play is accepted", () => {
    const state = fallingStarBoard();
    const resolved = enumeratedFallingStar(state);
    const built = submittedPlay(resolved, resolved.payment);
    expect(built.targetUnitInstanceIds).toEqual(resolved.targetUnitInstanceIds);
    expect(submit(state, built).result, "the board's own action was refused").toMatchObject({ type: "Ok" });
  });
});

describe("no field can be dropped on this hop again", () => {
  it("carries EVERY field of the resolved action through, changing only the payment", () => {
    // The structural guarantee, asserted structurally: a future field added to
    // PlayCardAction survives without anyone remembering to add a line.
    const state = fallingStarBoard();
    const resolved = enumeratedFallingStar(state);
    const payment: RunePayment = { energyRunes: ["f4", "f5"], powerRunes: ["f4", "f5"] };
    const built = submittedPlay(resolved, payment);
    expect(built).toEqual({ ...resolved, payment });
    expect(built.payment).toBe(payment);
  });

  it("keeps a synthetic field the old builder had never heard of", () => {
    // A stand-in for whatever gets added next. The old builder loses it; this
    // one cannot, because it never enumerates fields at all.
    const state = fallingStarBoard();
    const resolved = { ...enumeratedFallingStar(state), someFutureChoice: "kept" } as PlayCardAction & {
      someFutureChoice: string;
    };
    expect((submittedPlay(resolved, resolved.payment) as { someFutureChoice?: string }).someFutureChoice).toBe("kept");
    expect(
      (oldFieldByFieldBuilder(resolved, resolved.payment) as { someFutureChoice?: string }).someFutureChoice,
      "the control no longer demonstrates the failure",
    ).toBeUndefined();
  });
});
