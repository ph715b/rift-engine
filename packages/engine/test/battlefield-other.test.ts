import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { runBeginning } from "../src/engine/turn-manager.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { battlefieldDefIdFor } from "../src/decks/battlefield-setup.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * The last four battlefields — the two whose moment is a player's FIRST
 * Beginning Phase, and the two that watch something no other battlefield does.
 *
 * The Beginning-Phase pair are the only battlefield abilities in the pool that
 * do NOT go on the chain, and that is the same deliberate exception
 * `beginningPhase` already is for Dr. Mundo, Mushroom Pouch and Jinx's Legend.
 */

const OBELISK_OF_POWER = "OGN-284";
const THE_ARENAS_GREATEST = "OGN-290";
const BACK_ALLEY_BAR = "OGN-277";
const THE_DREAMING_TREE = "OGN-292";

/** Retreat — `[Reaction]`, 1 Energy, "return a FRIENDLY unit to its owner's
 *  hand". The cheapest spell in the pool that chooses a friendly unit, which is
 *  the whole of what The Dreaming Tree watches. */
const RETREAT = "OGN-104";

const rune = (id: string): RuneCard => ({ id, domain: "Calm", state: "Ready" });

function withBattlefield(defId: string, overrides: Partial<GameState> = {}): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0, ...overrides });
  state.battlefields[0] = { ...state.battlefields[0]!, defId };
  return state;
}

describe("the last four are the cards they claim to be", () => {
  it("every name in the table is a battlefield that really prints that text", () => {
    for (const [defId, name] of [
      [OBELISK_OF_POWER, "Obelisk of Power"],
      [THE_ARENAS_GREATEST, "The Arena's Greatest"],
      [BACK_ALLEY_BAR, "Back-Alley Bar"],
      [THE_DREAMING_TREE, "The Dreaming Tree"],
    ] as const) {
      expect(battlefieldDefIdFor(name), `${name} resolves to a different card`).toBe(defId);
    }
  });
});

describe("Obelisk of Power (OGN-284): each player channels 1 on their first Beginning Phase", () => {
  function beginning(defId: string, turnNumber: number, activePlayerIndex: 0 | 1 = 0): GameState {
    const state = withBattlefield(defId, { phase: "Beginning", turnNumber, activePlayerIndex });
    for (const i of [0, 1] as const) state.players[i]!.runeDeck = [rune(`r${i}`)];
    return state;
  }

  it("channels one READY rune — not exhausted, unlike Startipped Peak", () => {
    const after = runBeginning(beginning(OBELISK_OF_POWER, 1));
    expect(after.players[0]!.channeled.map((r) => r.state)).toEqual(["Ready"]);
  });

  it("fires for the SECOND player's first Beginning Phase too, which is still turn 1", () => {
    // `runEnd` only advances the counter when play wraps back to the FIRST
    // player (118), so both opening turns are turn 1 and each player gets one.
    const after = runBeginning(beginning(OBELISK_OF_POWER, 1, 1));
    expect(after.players[1]!.channeled).toHaveLength(1);
    expect(after.players[0]!.channeled, "the wrong player channelled").toHaveLength(0);
  });

  it("does nothing on a later turn", () => {
    const after = runBeginning(beginning(OBELISK_OF_POWER, 2));
    expect(after.players[0]!.channeled).toHaveLength(0);
  });

  it("resolves INLINE rather than on the chain", () => {
    // The deliberate exception the whole `beginningPhase` family is: holding it
    // would put it after `scoreHolds`.
    const held = runBeginning(beginning(OBELISK_OF_POWER, 1));
    expect(held.players[0]!.channeled, "the Obelisk waited for a response window").toHaveLength(1);
    expect(held.pendingTriggers.filter((e) => e.source === "battlefield")).toHaveLength(0);
  });
});

describe("The Arena's Greatest (OGN-290): 1 point on each player's first Beginning Phase", () => {
  it("gains the point BEFORE holds score, so both land in the same phase", () => {
    const state = withBattlefield(THE_ARENAS_GREATEST, { phase: "Beginning", turnNumber: 1 });
    // Player 0 also holds bf2, which is worth its own point.
    state.battlefields[1] = { ...state.battlefields[1]!, units: { p1: [makeUnit()] }, controllerId: "p1" };
    const after = runBeginning(state);
    expect(after.players[0]!.points, "the Arena's point and the hold point did not both land").toBe(2);
  });

  it("does nothing on a later turn", () => {
    const after = runBeginning(withBattlefield(THE_ARENAS_GREATEST, { phase: "Beginning", turnNumber: 3 }));
    expect(after.players[0]!.points).toBe(0);
  });
});

describe("Back-Alley Bar (OGN-277): a unit moving FROM here gets +1 Might this turn", () => {
  /** A ready unit of player 0's standing at bf1, free to walk to bf2 — which
   *  needs `[Ganking]`, since a battlefield-to-battlefield move is the only kind
   *  of move that can leave a battlefield at all. */
  function mover(): { state: GameState; unit: UnitInstance } {
    const unit = makeUnit({ name: "Mover", might: 3, keywords: { Ganking: 1 } });
    const state = withBattlefield(BACK_ALLEY_BAR);
    state.battlefields[0] = { ...state.battlefields[0]!, units: { p1: [unit] }, controllerId: "p1" };
    return { state, unit };
  }

  /** The unit wherever it now is. */
  function find(state: GameState, instanceId: string): UnitInstance | undefined {
    return [...state.players[0]!.baseUnits, ...state.battlefields.flatMap((bf) => bf.units["p1"] ?? [])].find(
      (u) => u.instanceId === instanceId,
    );
  }

  it("gives it +1 after it has already left", () => {
    const { state, unit } = mover();
    const { state: moved, result } = submit(state, {
      type: "MoveUnit",
      playerIndex: 0,
      unitInstanceIds: [unit.instanceId],
      destinationBattlefieldId: "bf2",
    });
    expect(result).toMatchObject({ type: "Ok" });
    const settled = resolveHeldTriggers(moved);
    expect(find(settled, unit.instanceId)!.mightThisTurn, "the Bar paid nothing for the departure").toBe(1);
  });

  it("does NOT fire for a Recall — 456 says a Recall is not a Move", () => {
    // The same line `movesThisTurn` and the `unitMoved` event already draw, and
    // the Bar rides that site precisely so the three cannot disagree.
    const { state, unit } = mover();
    const { state: recalled, result } = submit(state, {
      type: "RecallUnit",
      playerIndex: 0,
      unitInstanceIds: [unit.instanceId],
    });
    expect(result).toMatchObject({ type: "Ok" });
    const settled = resolveHeldTriggers(recalled);
    expect(find(settled, unit.instanceId)!.mightThisTurn, "a Recall paid the Bar's +1").toBe(0);
  });

  it("does not fire for a unit moving INTO it", () => {
    const unit = makeUnit({ name: "Arriver" });
    const state = withBattlefield(BACK_ALLEY_BAR);
    state.battlefields[1] = { ...state.battlefields[1]!, units: { p1: [unit] }, controllerId: "p1" };
    const { state: moved } = submit(state, {
      type: "MoveUnit",
      playerIndex: 0,
      unitInstanceIds: [unit.instanceId],
      destinationBattlefieldId: "bf1",
    });
    const settled = resolveHeldTriggers(moved);
    expect(find(settled, unit.instanceId)!.mightThisTurn).toBe(0);
  });

  it("does not fire for a unit leaving BASE", () => {
    // `originId` is "base" for a base-to-battlefield move, which matches no
    // battlefield and so reaches no battlefield ability.
    const unit = makeUnit({ name: "From base" });
    const state = withBattlefield(BACK_ALLEY_BAR);
    state.players[0]!.baseUnits = [unit];
    const { state: moved } = submit(state, {
      type: "MoveUnit",
      playerIndex: 0,
      unitInstanceIds: [unit.instanceId],
      destinationBattlefieldId: "bf2",
    });
    const settled = resolveHeldTriggers(moved);
    expect(find(settled, unit.instanceId)!.mightThisTurn).toBe(0);
  });
});

describe("The Dreaming Tree (OGN-292): the first friendly unit chosen here each turn draws", () => {
  /** Player 0 holds bf1 (the Tree) with `here`, holds a Retreat and a rune, and
   *  has something to draw. */
  function chooser(defId: string, here: UnitInstance[]): GameState {
    const state = withBattlefield(defId);
    state.battlefields[0] = { ...state.battlefields[0]!, units: { p1: here }, controllerId: "p1" };
    state.players[0]!.hand = [spellInstance(RETREAT), spellInstance(RETREAT)];
    state.players[0]!.channeled = [rune("r1"), rune("r2")];
    state.players[0]!.deck = [makeUnit({ name: "d1" }), makeUnit({ name: "d2" })];
    return state;
  }

  /** Plays a Retreat naming `unitInstanceId`, through the real enumerator so the
   *  action is one the engine actually offers. */
  function retreat(state: GameState, unitInstanceId: string): GameState {
    const action = legalActions(state).find(
      (a) => a.type === "PlayCard" && a.card.defId === RETREAT && a.targetUnitInstanceId === unitInstanceId,
    );
    expect(action, `no Retreat targeting ${unitInstanceId} was offered`).toBeDefined();
    const { state: played, result } = submit(state, action!);
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
    return resolveHeldTriggers(played);
  }

  it("draws when a spell chooses a friendly unit standing here", () => {
    const here = makeUnit({ name: "Chosen" });
    const settled = retreat(chooser(THE_DREAMING_TREE, [here]), here.instanceId);
    // One card drawn by the Tree; the Retreat returned the unit to hand, so the
    // hand is the remaining Retreat + the drawn card + the returned unit.
    expect(settled.players[0]!.deck, "the Tree drew nothing").toHaveLength(1);
  });

  it("draws only ONCE per turn", () => {
    const a = makeUnit({ name: "A" });
    const b = makeUnit({ name: "B" });
    const first = retreat(chooser(THE_DREAMING_TREE, [a, b]), a.instanceId);
    expect(first.players[0]!.deck).toHaveLength(1);
    const second = retreat(first, b.instanceId);
    expect(second.players[0]!.deck, "the Tree drew a second time in one turn").toHaveLength(1);
  });

  it("does not fire for a unit in BASE — 'a friendly unit HERE'", () => {
    const inBase = makeUnit({ name: "In base" });
    const state = chooser(THE_DREAMING_TREE, []);
    state.players[0]!.baseUnits = [inBase];
    const settled = retreat(state, inBase.instanceId);
    expect(settled.players[0]!.deck).toHaveLength(2);
  });

  it("does not fire at a battlefield that is not the Tree", () => {
    const there = makeUnit({ name: "Elsewhere" });
    const state = chooser(THE_DREAMING_TREE, []);
    state.battlefields[1] = { ...state.battlefields[1]!, units: { p1: [there] }, controllerId: "p1" };
    const settled = retreat(state, there.instanceId);
    expect(settled.players[0]!.deck).toHaveLength(2);
  });
});
