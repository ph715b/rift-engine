import { describe, expect, it } from "vitest";
import { actingPlayerIndex, mayPlayCardNow, timingTierOf } from "../src/engine/timing.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { submit } from "../src/engine/game-engine.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import type { CardInstance, SpellInstance, UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit } from "./fixtures.js";

const registry = defaultCardRegistry();
const card = (defId: string) => createCardInstance(registry.get(defId));

// Real cards, one per tier, so the tiers are pinned to actual printed text
// rather than to synthetic flags.
const FIRESTORM = "OGS-002"; // no timing keyword
const INCINERATE = "OGS-003"; // [Action]
const GUST = "OGN-169"; // [Reaction] — and isAction FALSE, see trap #2 below
const LUX_CROWNGUARD = "OGS-014"; // a [Reaction] UNIT (4 Energy)

describe("timing tiers come from the printed keywords (159 / 806 / 813)", () => {
  it("reads the three tiers off real cards", () => {
    expect(timingTierOf(card(FIRESTORM))).toBe("Default");
    expect(timingTierOf(card(INCINERATE))).toBe("Action");
    expect(timingTierOf(card(GUST))).toBe("Reaction");
  });

  it("treats a [Reaction] card as Reaction even though its isAction flag is false", () => {
    // Trap #2, and the reason tiers are derived rather than flags being tested at
    // each call site: the loader sets isAction from the literal printed text, so
    // every Reaction-only card in the pool has isAction false. Rule 813 says
    // Reaction "grants all abilities and permissions of Action", so reading
    // isAction alone would bar all 8 Reaction spells from Showdowns.
    const gust = card(GUST) as SpellInstance;
    expect(gust.isReaction).toBe(true);
    expect(gust.isAction).toBe(false);
    expect(timingTierOf(gust)).toBe("Reaction");
  });

  it("reaches the runtime instance at all (trap #1)", () => {
    // isAction lived only on the definition; a PlayCardAction carries the
    // INSTANCE, so printed [Action] was unobservable where it mattered.
    expect((card(INCINERATE) as SpellInstance).isAction).toBe(true);
  });

  it("handles a [Reaction] Unit, not just spells", () => {
    expect(timingTierOf(card(LUX_CROWNGUARD))).toBe("Reaction");
  });
});

describe("mayPlayCardNow: the tier x state matrix", () => {
  /** The four states that matter, all with player 0 as the one who may act. */
  const neutralOpen = (): GameState => makeState({ turnState: "Neutral", chainOpen: true, activePlayerIndex: 0 });
  const showdownOpen = (focusHolder: 0 | 1 = 0): GameState =>
    makeState({ turnState: "Showdown", showdownBattlefieldId: "bf1", showdownKind: "NonCombat", chainOpen: true, focusHolder });
  const closedChain = (chainPriority: 0 | 1 = 0): GameState => makeState({ chainOpen: false, chainPriority });

  const cases: { tier: string; defId: string; neutral: boolean; showdown: boolean; closed: boolean }[] = [
    // Rule 159: Open State, outside Showdowns, controller's turn.
    { tier: "Default", defId: FIRESTORM, neutral: true, showdown: false, closed: false },
    // Rule 806: + during Showdowns, any player's turn.
    { tier: "Action", defId: INCINERATE, neutral: true, showdown: true, closed: false },
    // Rule 813: + all forms of Closed State.
    { tier: "Reaction", defId: GUST, neutral: true, showdown: true, closed: true },
  ];

  for (const c of cases) {
    it(`${c.tier}: neutral=${c.neutral} showdown=${c.showdown} closed=${c.closed}`, () => {
      const subject = card(c.defId);
      expect(mayPlayCardNow(neutralOpen(), 0, subject)).toBe(c.neutral);
      expect(mayPlayCardNow(showdownOpen(0), 0, subject)).toBe(c.showdown);
      expect(mayPlayCardNow(closedChain(0), 0, subject)).toBe(c.closed);
    });
  }

  it("requires holding the relevant token, whoever's turn it nominally is", () => {
    const incinerate = card(INCINERATE);
    // Focus with the opponent: player 0 can't act even with an [Action] card...
    expect(mayPlayCardNow(showdownOpen(1), 0, incinerate)).toBe(false);
    // ...and player 1 CAN, on player 0's turn. That's 806's "any player's turn".
    expect(mayPlayCardNow(showdownOpen(1), 1, incinerate)).toBe(true);

    const gust = card(GUST);
    expect(mayPlayCardNow(closedChain(1), 0, gust)).toBe(false);
    expect(mayPlayCardNow(closedChain(1), 1, gust)).toBe(true);
  });

  it("actingPlayerIndex puts a closed chain ahead of a Showdown (313 over 348)", () => {
    const both: GameState = makeState({
      turnState: "Showdown",
      showdownBattlefieldId: "bf1",
      showdownKind: "Combat",
      focusHolder: 0,
      chainOpen: false,
      chainPriority: 1,
    });
    expect(actingPlayerIndex(both)).toBe(1);
    expect(actingPlayerIndex(makeState({ turnState: "Showdown", focusHolder: 1 }))).toBe(1);
    expect(actingPlayerIndex(makeState({ activePlayerIndex: 1 }))).toBe(1);
  });
});

describe("enumeration and validation agree about what's castable", () => {
  /** A state where player 0 holds Focus in a Non-Combat Showdown and has `hand`
   *  plus enough Ready runes to pay for anything in this pool. */
  function showdownWith(hand: CardInstance[]): GameState {
    return makeState({
      players: [
        makePlayer("p1", {
          hand,
          channeled: Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, domain: "Fury" as const, state: "Ready" as const })),
        }),
        makePlayer("p2"),
      ],
      turnState: "Showdown",
      showdownBattlefieldId: "bf1",
      showdownKind: "NonCombat",
      focusHolder: 0,
      activePlayerIndex: 0,
    });
  }

  it("offers [Action] and [Reaction] cards during a Showdown but not plain ones", () => {
    const state = showdownWith([card(FIRESTORM), card(INCINERATE), card(GUST)]);
    // Incinerate targets a unit at a battlefield, so give it something to hit.
    state.battlefields[0]!.units = { p2: [makeUnit()] };

    const offered = new Set(
      legalActions(state)
        .filter((a) => a.type === "PlayCard")
        .map((a) => a.card.name),
    );
    expect(offered.has("Incinerate")).toBe(true);
    expect(offered.has("Gust")).toBe(true);
    expect(offered.has("Firestorm")).toBe(false);
  });

  it("offers only [Reaction] cards onto a closed chain", () => {
    const state = showdownWith([card(FIRESTORM), card(INCINERATE), card(GUST)]);
    state.battlefields[0]!.units = { p2: [makeUnit()] };
    const closed: GameState = { ...state, chainOpen: false, chainPriority: 0 };
    const offered = new Set(
      legalActions(closed)
        .filter((a) => a.type === "PlayCard")
        .map((a) => a.card.name),
    );
    expect([...offered]).toEqual(["Gust"]);
  });

  it("drops MoveUnit/RecallUnit/Pass outside a Neutral Open state", () => {
    const state = showdownWith([]);
    state.players[0]!.baseUnits = [makeUnit()];
    const types = new Set(legalActions(state).map((a) => a.type));
    expect(types.has("MoveUnit")).toBe(false);
    expect(types.has("RecallUnit")).toBe(false);
    expect(types.has("Pass")).toBe(false);
    expect(types.has("PassFocus")).toBe(true);
  });

  it("validatePlayCard rejects a plain Spell during a Showdown with a timing reason", () => {
    const state = showdownWith([card(FIRESTORM)]);
    state.battlefields[0]!.units = { p2: [makeUnit()] };
    const result = validatePlayCard(state, {
      type: "PlayCard",
      playerIndex: 0,
      card: card(FIRESTORM),
      payment: { energyRunes: [], powerRunes: [] },
      targetBattlefieldId: "bf1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/\[Action\] or \[Reaction\]/);
  });

  it("rule 813: a [Reaction] Unit can't be played to a battlefield it doesn't control", () => {
    const lux = card(LUX_CROWNGUARD) as UnitInstance;
    const state = showdownWith([lux]);
    state.battlefields[0]!.units = { p1: [makeUnit()], p2: [makeUnit()] };
    state.battlefields[0]!.controllerId = "p2";

    const result = validatePlayCard(state, {
      type: "PlayCard",
      playerIndex: 0,
      card: lux,
      payment: { energyRunes: ["r0", "r1"], powerRunes: [] },
      destinationBattlefieldId: "bf1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/base or a battlefield you control/);
  });
});

describe("Focus and the chain inside a Showdown (346 / 349)", () => {
  /** Player 0 holds Focus in a Non-Combat Showdown, holding a castable Gust. */
  function windowWithGust(): GameState {
    const state = makeState({
      players: [
        makePlayer("p1", {
          hand: [card(GUST)],
          channeled: [{ id: "r0", domain: "Chaos", state: "Ready" }],
        }),
        makePlayer("p2"),
      ],
      turnState: "Showdown",
      showdownBattlefieldId: "bf1",
      showdownKind: "NonCombat",
      focusHolder: 0,
      activePlayerIndex: 0,
    });
    state.battlefields[0]!.units = { p1: [makeUnit()] };
    state.battlefields[0]!.contestedByIndex = 0;
    return state;
  }

  it("casting during a Showdown resets the all-passed sequence (349)", () => {
    let state = windowWithGust();
    // One pass banked: without the reset, the next pass would close the window.
    state = submit(state, { type: "PassFocus", playerIndex: 0 }).state;
    expect(state.consecutiveFocusPasses).toBe(1);
    expect(state.focusHolder).toBe(1);

    // Hand Gust to the player who now holds Focus and let them cast it.
    state = {
      ...state,
      players: [state.players[0]!, { ...state.players[1]!, hand: [card(GUST)], channeled: [{ id: "x", domain: "Chaos", state: "Ready" }] }],
    };
    const gust = state.players[1]!.hand[0]!;
    state = submit(state, {
      type: "PlayCard",
      playerIndex: 1,
      card: gust,
      payment: { energyRunes: ["x"], powerRunes: [] },
      targetUnitInstanceId: state.battlefields[0]!.units["p1"]![0]!.instanceId,
    }).state;

    expect(state.chainOpen).toBe(false);
    expect(state.consecutiveFocusPasses).toBe(0);
    expect(state.turnState).toBe("Showdown"); // still open
  });

  it("Focus passes when the chain empties during a Showdown (346)", () => {
    let state = windowWithGust();
    const gust = state.players[0]!.hand[0]!;
    state = submit(state, {
      type: "PlayCard",
      playerIndex: 0,
      card: gust,
      payment: { energyRunes: ["r0"], powerRunes: [] },
      targetUnitInstanceId: state.battlefields[0]!.units["p1"]![0]!.instanceId,
    }).state;
    expect(state.chainOpen).toBe(false);
    expect(state.chainPriority).toBe(0);

    // Two chain passes resolve it, and the chain empties inside the Showdown.
    state = submit(state, { type: "PassFocus", playerIndex: 0 }).state;
    state = submit(state, { type: "PassFocus", playerIndex: 1 }).state;

    expect(state.chainOpen).toBe(true);
    expect(state.turnState).toBe("Showdown");
    // Focus moved off the caster — casting is a turn-taking move in the window.
    expect(state.focusHolder).toBe(1);
    expect(state.consecutiveFocusPasses).toBe(0);
  });

  it("a [Reaction] cast onto a closed chain makes a genuinely 2-deep chain, newest first", () => {
    // Previously only reachable by hand-building a GameState (the white-box test
    // in spell-gear.test.ts); this is the real path through public actions.
    let state = windowWithGust();
    state = {
      ...state,
      players: [
        { ...state.players[0]!, hand: [card(GUST)], channeled: [{ id: "a", domain: "Chaos", state: "Ready" }] },
        { ...state.players[1]!, hand: [card(GUST)], channeled: [{ id: "b", domain: "Chaos", state: "Ready" }] },
      ],
    };
    const target = state.battlefields[0]!.units["p1"]![0]!.instanceId;

    state = submit(state, {
      type: "PlayCard",
      playerIndex: 0,
      card: state.players[0]!.hand[0]!,
      payment: { energyRunes: ["a"], powerRunes: [] },
      targetUnitInstanceId: target,
    }).state;
    expect(state.spellChain).toHaveLength(1);
    // Rule 338: finalizing does NOT pass priority, so the caster still holds it
    // and has to decline before anyone can answer. (This test originally
    // asserted the opponent got priority immediately, which is a real rule the
    // engine already had right.)
    expect(actingPlayerIndex(state)).toBe(0);

    state = submit(state, { type: "PassFocus", playerIndex: 0 }).state;
    expect(state.spellChain).toHaveLength(1); // one pass isn't enough to resolve
    expect(actingPlayerIndex(state)).toBe(1);

    state = submit(state, {
      type: "PlayCard",
      playerIndex: 1,
      card: state.players[1]!.hand[0]!,
      payment: { energyRunes: ["b"], powerRunes: [] },
      targetUnitInstanceId: target,
    }).state;

    expect(state.spellChain).toHaveLength(2);
    // Rule 343: the newest resolves first, so priority sits with its controller.
    expect(state.spellChain[1]!.playerIndex).toBe(1);
    expect(state.chainPriority).toBe(1);
  });
});
