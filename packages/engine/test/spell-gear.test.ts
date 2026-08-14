import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import {
  createCardInstance,
  type GearInstance,
  type LegendInstance,
  type SpellInstance,
  type UnitInstance,
} from "../src/model/card.js";
import type { GameState, PlayerState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { validatePass } from "../src/actions/validate-pass.js";
import { validateMoveUnit } from "../src/actions/validate-move-unit.js";
import { validateRecallUnit } from "../src/actions/validate-recall-unit.js";
import { validatePassFocus } from "../src/actions/validate-pass-focus.js";
import { executePassFocus } from "../src/actions/execute-pass-focus.js";
import { legalActions } from "../src/engine/legal-actions.js";
import type { PlayCardAction } from "../src/actions/player-action.js";

function readyRune(id: string, domain: RuneCard["domain"] = "Order"): RuneCard {
  return { id, domain, state: "Ready" };
}

function emptyPlayer(id: string, name: string, legend: LegendInstance): PlayerState {
  return {
    id,
    name,
    legend,
    championZone: null,
    chosenChampionDefId: "TEST-CHAMPION",
    readyRunesAtEndOfTurn: 0,
    spellChoiceDrawnBattlefieldIds: [],
    deck: [],
    hand: [],
    trash: [],
    banished: [],
    activeGear: [],
    runeDeck: [],
    channeled: [],
    baseUnits: [],
    points: 0,
    xp: 0,
    floatingEnergy: 0,
    floatingPower: {},
    floatingRainbowPower: 0,
    cardsPlayedThisTurn: 0,
    firstFriendlyDeathUsedThisTurn: false,
    extraMightPerBuffThisTurn: 0,
    discardedThisTurn: false,
    xpGainedThisTurn: false,
    scoredBattlefieldsThisTurn: [],
    unitsEnterReadyThisTurn: false,
    restrictedSpellEnergy: 0,
    restrictedSpellPower: 0,
    restrictedGearPower: 0,
    gearPlayedThisTurn: 0,
    enemyChoicesThisTurn: 0,
    nextSpellRepeatGrants: 0,
    equipmentPlayedThisTurn: 0,
    nextUnitsEnterReady: 0,
    freeGearPlaysThisTurn: 0,
    trashUnitPlaysThisTurn: 0,
    replacedCostPlays: [],
    pointsFromHoldingThisTurn: 0,
    powerSpentThisTurn: 0,
    maxSpellEnergySpentThisTurn: 0,
    buffUnitsPlayedThisTurn: 0,
    conqueredBattlefieldsThisTurn: [],
    unitsLostThisTurn: 0,
    nextSpellEnergyDiscount: 0,
    nextSpellBonusDamage: 0,
    cannotPlayCardsThisTurn: false,
    cannotPlaySpellsThisTurn: false,
    unitsLostInBeginningPhaseThisTurn: 0,
    hideIgnoresCostThisTurn: false,
    preventsSpellDamageThisTurn: false,
  };
}

/**
 * Mobilize (OGN-134): a real, untagged (no [Action]/[Reaction]) Spell — 2
 * Energy, 0 Power. Deliberately untagged to prove isAction/isReaction don't
 * gate a normal-turn cast (they only matter for Showdown/reaction timing,
 * out of scope here).
 */
function buildSpellFixture() {
  const registry = defaultCardRegistry();
  const legend = createCardInstance(registry.get("OGS-023")) as LegendInstance;
  const spell = createCardInstance(registry.get("OGN-134")) as SpellInstance;
  expect(spell.kind).toBe("Spell");
  expect(spell.energyCost).toBe(2);
  expect(spell.powerCost).toBe(0);

  const player: PlayerState = emptyPlayer("p1", "Alice", legend);
  player.hand = [spell];
  player.channeled = [readyRune("rune-1"), readyRune("rune-2")];

  const opponent: PlayerState = emptyPlayer("p2", "Bob", createCardInstance(registry.get("OGS-021")) as LegendInstance);

  const state: GameState = {
    players: [player, opponent],
    battlefields: [],
    activePlayerIndex: 0,
    firstPlayerIndex: 0,
    turnNumber: 1,
    phase: "Action",
    turnState: "Neutral",
    focusHolder: 0,
    showdownBattlefieldId: null,
    showdownKind: null,
    consecutiveFocusPasses: 0,
    chainOpen: true,
    chainPriority: 0,
    chainPasses: 0,
    chainOpenedByTrigger: false,
    spellChain: [],
    pendingTriggers: [],
    declaredWinnerIndex: null,
    killDamagedUnitsThisTurn: false,
    movementLockedUnitInstanceIds: [],
    spellResolvingForIndex: null,
    markedForDeathOnDamageInstanceIds: [],
    damagePreventedOnceInstanceIds: [],
    extraTurns: 0,
    extraTurnsForIndex: 0,
    lastShowdownExcessDamage: null,
    deathWardedUnitInstanceIds: [],
    paidDeathWardUnitInstanceIds: [],
      unitsAwaitingDeathReplacement: [],
      unitsAwaitingFreePlacement: [],
    pendingDecisions: [],
  };

  return { state, spell };
}

/** Iron Ballista (OGN-017): a real Gear card — 3 Energy, 0 Power. */
function buildGearFixture() {
  const registry = defaultCardRegistry();
  const legend = createCardInstance(registry.get("OGS-023")) as LegendInstance;
  const gear = createCardInstance(registry.get("OGN-017")) as GearInstance;
  expect(gear.kind).toBe("Gear");
  expect(gear.energyCost).toBe(3);
  expect(gear.powerCost).toBe(0);

  const player: PlayerState = emptyPlayer("p1", "Alice", legend);
  player.hand = [gear];
  player.channeled = [readyRune("rune-1"), readyRune("rune-2"), readyRune("rune-3")];

  const opponent: PlayerState = emptyPlayer("p2", "Bob", createCardInstance(registry.get("OGS-021")) as LegendInstance);

  const state: GameState = {
    players: [player, opponent],
    battlefields: [],
    activePlayerIndex: 0,
    firstPlayerIndex: 0,
    turnNumber: 1,
    phase: "Action",
    turnState: "Neutral",
    focusHolder: 0,
    showdownBattlefieldId: null,
    showdownKind: null,
    consecutiveFocusPasses: 0,
    chainOpen: true,
    chainPriority: 0,
    chainPasses: 0,
    chainOpenedByTrigger: false,
    spellChain: [],
    pendingTriggers: [],
    declaredWinnerIndex: null,
    killDamagedUnitsThisTurn: false,
    movementLockedUnitInstanceIds: [],
    spellResolvingForIndex: null,
    markedForDeathOnDamageInstanceIds: [],
    damagePreventedOnceInstanceIds: [],
    extraTurns: 0,
    extraTurnsForIndex: 0,
    lastShowdownExcessDamage: null,
    deathWardedUnitInstanceIds: [],
    paidDeathWardUnitInstanceIds: [],
      unitsAwaitingDeathReplacement: [],
      unitsAwaitingFreePlacement: [],
    pendingDecisions: [],
  };

  return { state, gear };
}

describe("PlayCard: casting a Spell", () => {
  it("removes the card from hand and adds it to trash immediately, before it ever resolves", () => {
    const { state, spell } = buildSpellFixture();
    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: spell,
      payment: { energyRunes: ["rune-1", "rune-2"], powerRunes: [] },
    };

    expect(validatePlayCard(state, action)).toEqual({ ok: true });

    const next = executePlayCard(state, action);
    const actor = next.players[0]!;

    expect(actor.hand).toHaveLength(0);
    expect(actor.trash).toHaveLength(1);
    expect(actor.trash[0]!.instanceId).toBe(spell.instanceId);
    expect(actor.cardsPlayedThisTurn).toBe(1);

    // Input state is untouched — the engine stays (state, action) -> nextState.
    expect(state.players[0]!.hand).toHaveLength(1);
    expect(state.players[0]!.trash).toHaveLength(0);
  });

  it("opens the chain: chainOpen false, chainPriority the caster, one spellChain entry", () => {
    const { state, spell } = buildSpellFixture();
    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: spell,
      payment: { energyRunes: ["rune-1", "rune-2"], powerRunes: [] },
    };

    const next = executePlayCard(state, action);

    expect(next.chainOpen).toBe(false);
    expect(next.chainPriority).toBe(0);
    expect(next.chainPasses).toBe(0);
    expect(next.spellChain).toHaveLength(1);
    // `toMatchObject`, not `toEqual`: the entry gained `energySpent` on
    // 2026-08-12 (what the play actually cost after discounts, for Revna the
    // Lorekeeper's "if you spent [N] or more"), and this assertion is about the
    // chain being opened with the right card by the right player — not about the
    // entry having exactly two fields forever.
    expect(next.spellChain[0]).toMatchObject({ playerIndex: 0, card: spell });
    // The new field is asserted deliberately rather than waved through, so a
    // future change that stops recording it fails here as well as in
    // `wave8-primitives.test.ts`.
    const entry = next.spellChain[0]!;
    expect("card" in entry ? entry.energySpent : undefined, "the chain entry stopped recording what was spent").toBeDefined();
  });

  it("is castable even though it carries no [Action]/[Reaction] tag — those only gate Showdown/reaction timing, not a normal-turn cast", () => {
    const { state, spell } = buildSpellFixture();
    const registry = defaultCardRegistry();
    const def = registry.get("OGN-134");
    if (def.type === "Spell") {
      expect(def.isAction).toBe(false);
      expect(def.isReaction).toBe(false);
    }

    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: spell,
      payment: { energyRunes: ["rune-1", "rune-2"], powerRunes: [] },
    };
    expect(validatePlayCard(state, action)).toEqual({ ok: true });
  });
});

describe("PlayCard: playing Gear", () => {
  it("moves the card from hand to activeGear, unattached, without touching the chain", () => {
    const { state, gear } = buildGearFixture();
    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: gear,
      payment: { energyRunes: ["rune-1", "rune-2", "rune-3"], powerRunes: [] },
    };

    expect(validatePlayCard(state, action)).toEqual({ ok: true });

    const next = executePlayCard(state, action);
    const actor = next.players[0]!;

    expect(actor.hand).toHaveLength(0);
    expect(actor.activeGear).toHaveLength(1);
    expect(actor.activeGear[0]!.instanceId).toBe(gear.instanceId);
    expect(actor.activeGear[0]!.attachedToInstanceId).toBeNull();
    expect(actor.cardsPlayedThisTurn).toBe(1);

    expect(next.chainOpen).toBe(true);
    expect(next.spellChain).toHaveLength(0);
  });
});

describe("PlayCard: a Legend card is still rejected", () => {
  it("fails validation", () => {
    const { state } = buildSpellFixture();
    const legendCard = state.players[0]!.legend;
    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: legendCard,
      payment: { energyRunes: [], powerRunes: [] },
    };
    expect(validatePlayCard(state, action).ok).toBe(false);
  });
});

describe("chain gating: no other action is legal while a spell is pending resolution", () => {
  function closedChainState(): GameState {
    const { state, spell } = buildSpellFixture();
    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: spell,
      payment: { energyRunes: ["rune-1", "rune-2"], powerRunes: [] },
    };
    return executePlayCard(state, action);
  }

  it("validatePlayCard rejects any further play", () => {
    const state = closedChainState();
    const registry = defaultCardRegistry();
    const anotherSpell = createCardInstance(registry.get("OGN-004")) as SpellInstance;
    state.players[0]!.hand = [anotherSpell];
    state.players[0]!.channeled = [readyRune("extra")];

    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: anotherSpell,
      payment: { energyRunes: ["extra"], powerRunes: [] },
    };
    expect(validatePlayCard(state, action).ok).toBe(false);
  });

  it("validatePass rejects ending the turn", () => {
    const state = closedChainState();
    expect(validatePass(state, { type: "Pass", playerIndex: 0 }).ok).toBe(false);
  });

  it("validateMoveUnit rejects moving units", () => {
    const state = closedChainState();
    const unit = createCardInstance(defaultCardRegistry().get("OGN-210")) as UnitInstance;
    state.players[0]!.baseUnits = [unit];
    state.battlefields = [{ id: "bf1", name: "Battlefield 1", controllerId: null, units: {}, contestedByIndex: null, hiddenCards: [] }];

    expect(
      validateMoveUnit(state, {
        type: "MoveUnit",
        playerIndex: 0,
        unitInstanceIds: [unit.instanceId],
        destinationBattlefieldId: "bf1",
      }).ok,
    ).toBe(false);
  });

  it("validateRecallUnit rejects recalling units", () => {
    const state = closedChainState();
    const unit = createCardInstance(defaultCardRegistry().get("OGN-210")) as UnitInstance;
    state.battlefields = [{ id: "bf1", name: "Battlefield 1", controllerId: "p1", units: { p1: [unit] }, contestedByIndex: null, hiddenCards: [] }];

    expect(
      validateRecallUnit(state, { type: "RecallUnit", playerIndex: 0, unitInstanceIds: [unit.instanceId] }).ok,
    ).toBe(false);
  });

  it("legalActions returns PassFocus for whoever holds chain priority, plus FloatRune (the one action real enough to bypass a closed chain)", () => {
    const state = closedChainState();
    const actions = legalActions(state);
    expect(actions).toContainEqual({ type: "PassFocus", playerIndex: 0 });
    expect(actions.every((a) => a.type === "PassFocus" || a.type === "FloatRune")).toBe(true);
  });

  it("validatePassFocus rejects the wrong player", () => {
    const state = closedChainState();
    expect(validatePassFocus(state, { type: "PassFocus", playerIndex: 1 }).ok).toBe(false);
  });
});

describe("resolving the chain via PassFocus", () => {
  it("a single pass flips chain priority without resolving", () => {
    const { state, spell } = buildSpellFixture();
    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: spell,
      payment: { energyRunes: ["rune-1", "rune-2"], powerRunes: [] },
    };
    let next = executePlayCard(state, action);

    next = executePassFocus(next, { type: "PassFocus", playerIndex: 0 });

    expect(next.chainOpen).toBe(false);
    expect(next.chainPriority).toBe(1);
    expect(next.chainPasses).toBe(1);
    expect(next.spellChain).toHaveLength(1);
  });

  it("two consecutive passes resolve the chain (no-op effect) and reopen it, leaving the rest of the board untouched", () => {
    const { state, spell } = buildSpellFixture();
    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: spell,
      payment: { energyRunes: ["rune-1", "rune-2"], powerRunes: [] },
    };
    let next = executePlayCard(state, action);
    const afterCast = next;

    next = executePassFocus(next, { type: "PassFocus", playerIndex: 0 });
    next = executePassFocus(next, { type: "PassFocus", playerIndex: 1 });

    expect(next.chainOpen).toBe(true);
    expect(next.chainPasses).toBe(0);
    expect(next.spellChain).toHaveLength(0);

    // This assertion used to read "player state must be byte-for-byte
    // unchanged", on the premise that no effect registry existed yet. Both
    // halves of that premise have since expired: the fixture's spell is
    // Mobilize ("Channel 1 rune exhausted. If you can't, draw 1"), which IS
    // implemented, and the fixture has an empty rune deck — so it draws.
    //
    // The draw then finds an empty Main Deck with the just-cast Mobilize in the
    // trash, which is Burn Out (431): the trash becomes the deck, the OPPONENT
    // gains a point, and the draw completes. Asserted rather than dodged,
    // because a fixture that quietly hid the rule is what let it stay missing.
    expect(next.battlefields).toEqual(afterCast.battlefields);
    expect(next.players[1]!.points).toBe(afterCast.players[1]!.points + 1); // Burn Out's point
    expect(next.players[0]!.trash).toHaveLength(0); // recycled into the deck
    expect(next.players[0]!.hand.map((c) => c.name)).toEqual(["Mobilize"]); // and drawn back
  });

  it("white-box: a 2-entry spellChain resolves top-first, handing priority to the next entry's caster instead of reopening", () => {
    const { state, spell } = buildSpellFixture();
    const secondSpell: SpellInstance = { ...spell, instanceId: "spell-2" };

    const twoEntryState: GameState = {
      ...state,
      chainOpen: false,
      chainPriority: 1,
      chainPasses: 0,
      chainOpenedByTrigger: false,
      spellChain: [
        { playerIndex: 0, card: spell },
        { playerIndex: 1, card: secondSpell },
      ],
    };

    let next = executePassFocus(twoEntryState, { type: "PassFocus", playerIndex: 1 });
    next = executePassFocus(next, { type: "PassFocus", playerIndex: 0 });

    // Only the top (last-pushed) entry — secondSpell/player 1 — popped.
    expect(next.spellChain).toEqual([{ playerIndex: 0, card: spell }]);
    // Chain stays closed; priority hands to the remaining entry's caster.
    expect(next.chainOpen).toBe(false);
    expect(next.chainPriority).toBe(0);
    expect(next.chainPasses).toBe(0);
  });
});

describe("legalActions: Spell and Gear candidates", () => {
  it("includes a PlayCard candidate for every Spell and Gear in hand, alongside Units", () => {
    const registry = defaultCardRegistry();
    const legend = createCardInstance(registry.get("OGS-023")) as LegendInstance;
    const spell = createCardInstance(registry.get("OGN-004")) as SpellInstance; // 1 Energy
    const gear = createCardInstance(registry.get("OGN-017")) as GearInstance; // 3 Energy
    const unit = createCardInstance(registry.get("OGN-210")) as UnitInstance; // Daring Poro, 2 Energy

    const player: PlayerState = emptyPlayer("p1", "Alice", legend);
    player.hand = [spell, gear, unit];
    player.channeled = [readyRune("r1"), readyRune("r2"), readyRune("r3"), readyRune("r4"), readyRune("r5"), readyRune("r6")];
    // A unit on the board for Cleave to point at. It needed none while Cleave
    // was inert — a spell with no registered effect has no targeting spec and is
    // always enumerable. Now that it grants [Assault 3] to a unit, an empty board
    // means no legal target and therefore no candidate, which is correct and is
    // the opposite of what this test is about. Same stale-fixture shape as the
    // Mobilize case above.
    player.baseUnits = [createCardInstance(registry.get("OGN-210")) as UnitInstance];

    const opponent: PlayerState = emptyPlayer("p2", "Bob", createCardInstance(registry.get("OGS-021")) as LegendInstance);

    const state: GameState = {
      players: [player, opponent],
      battlefields: [],
      activePlayerIndex: 0,
      firstPlayerIndex: 0,
      turnNumber: 1,
      phase: "Action",
      turnState: "Neutral",
      focusHolder: 0,
      showdownBattlefieldId: null,
      showdownKind: null,
      consecutiveFocusPasses: 0,
      chainOpen: true,
      chainPriority: 0,
      chainPasses: 0,
      chainOpenedByTrigger: false,
      spellChain: [],
      pendingTriggers: [],
      declaredWinnerIndex: null,
    killDamagedUnitsThisTurn: false,
    movementLockedUnitInstanceIds: [],
    spellResolvingForIndex: null,
    markedForDeathOnDamageInstanceIds: [],
    damagePreventedOnceInstanceIds: [],
    extraTurns: 0,
    extraTurnsForIndex: 0,
      lastShowdownExcessDamage: null,
      deathWardedUnitInstanceIds: [],
      paidDeathWardUnitInstanceIds: [],
      unitsAwaitingDeathReplacement: [],
      unitsAwaitingFreePlacement: [],
      pendingDecisions: [],
    };

    const actions = legalActions(state);
    const playedKinds = actions.filter((a) => a.type === "PlayCard").map((a) => (a.type === "PlayCard" ? a.card.kind : ""));
    expect(playedKinds.sort()).toEqual(["Gear", "Spell", "Unit"]);
  });
});
