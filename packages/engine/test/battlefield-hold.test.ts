import { describe, expect, it } from "vitest";
import { runBeginning } from "../src/engine/turn-manager.js";
import { winner } from "../src/engine/win-condition.js";
import { battlefieldDefIdFor } from "../src/decks/battlefield-setup.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { answerDecisions, makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * The seven "when you hold here" battlefields.
 *
 * **These abilities did not exist before this file.** A battlefield in play was a
 * name, a controller and a list of units; `card-loader`'s `shouldSkip` keeps
 * Battlefield-type cards out of `loadCardDefinitions` entirely, so there was no
 * `CardDefinition` for any registry to key off and nothing that could have been
 * "broken". `BattlefieldState.defId` is the key that made the table possible.
 *
 * Every test here drives the REAL moment — `runBeginning`, which calls
 * `scoring.scoreHolds`, which is what fires 471.1.a's hold — and then settles the
 * chain, because a battlefield's ability is a Chain Pending Item like every other
 * trigger in this engine. A test that called the resolver directly would prove the
 * effect works and nothing about whether the hold reaches it.
 */

const ALTAR_TO_UNITY = "OGN-275";
const GROVE_OF_THE_GOD_WILLOW = "OGN-280";
const HALLOWED_TOMB = "OGN-281";
const NAVORI_FIGHTING_PIT = "OGN-283";
const RECKONERS_ARENA = "OGN-286";
const STARTIPPED_PEAK = "OGN-288";
const THE_GRAND_PLAZA = "OGN-293";

/** Sett - Brawler — "when I conquer, buff me", the conquer effect Reckoner's
 *  Arena activates without a conquest. */
const SETT_BRAWLER = "OGN-164";

/**
 * Player 0 in their Beginning Phase, holding bf1, which IS the named battlefield
 * card. `isHeldBy` wants units present and none of the opponent's.
 */
function holding(defId: string, units: UnitInstance[] = [makeUnit()]): GameState {
  const state = makeState({ phase: "Beginning", activePlayerIndex: 0 });
  state.battlefields[0] = {
    ...state.battlefields[0]!,
    defId,
    units: { p1: units },
    controllerId: "p1",
  };
  return state;
}

/** The whole moment: hold scoring, then the response window both players pass
 *  on, then whatever question the ability parked. */
function settleHold(state: GameState): GameState {
  return answerDecisions(resolveHeldTriggers(runBeginning(state)));
}

describe("the battlefield card is what carries the ability", () => {
  it("a battlefield with no defId holds for its point and nothing else", () => {
    const state = makeState({ phase: "Beginning", activePlayerIndex: 0 });
    state.battlefields[0] = { ...state.battlefields[0]!, units: { p1: [makeUnit()] }, controllerId: "p1" };
    const settled = settleHold(state);
    expect(settled.players[0]!.points).toBe(1);
    expect(settled.players[0]!.hand).toHaveLength(0);
  });

  it("resolves as a Chain Pending Item, not at the hold", () => {
    // The whole point of the conversion this rides on: the ability is on the
    // chain and respondable BEFORE it does anything.
    const state = holding(GROVE_OF_THE_GOD_WILLOW);
    state.players[0]!.deck = [realUnitInstance(SETT_BRAWLER)];
    const held = runBeginning(state);
    expect(held.players[0]!.hand, "the draw happened at the hold rather than on the chain").toHaveLength(0);
    // Asserted on the PEN, which is the only thing that can tell "was placed" from
    // "was placed and did nothing" — see the standing note on negative controls.
    expect(held.pendingTriggers.filter((e) => e.source === "battlefield")).toHaveLength(1);
    const onChain = resolveHeldTriggers(held);
    expect(onChain.players[0]!.hand).toHaveLength(1);
  });

  it("every name in the table is a battlefield that really prints that text", () => {
    // A defId typo would make an ability silently unreachable — the battlefield
    // in play would carry a name this table has never heard of.
    for (const [defId, name] of [
      [ALTAR_TO_UNITY, "Altar to Unity"],
      [GROVE_OF_THE_GOD_WILLOW, "Grove of the God-Willow"],
      [HALLOWED_TOMB, "Hallowed Tomb"],
      [NAVORI_FIGHTING_PIT, "Navori Fighting Pit"],
      [RECKONERS_ARENA, "Reckoner's Arena"],
      [STARTIPPED_PEAK, "Startipped Peak"],
      [THE_GRAND_PLAZA, "The Grand Plaza"],
    ] as const) {
      expect(battlefieldDefIdFor(name), `${name} resolves to a different card`).toBe(defId);
    }
  });
});

describe("Altar to Unity (OGN-275): play a 1 Might Recruit token in your base", () => {
  it("puts the token in BASE, not at the battlefield", () => {
    const settled = settleHold(holding(ALTAR_TO_UNITY));
    expect(settled.players[0]!.baseUnits.map((u) => u.name)).toEqual(["Recruit"]);
    expect(settled.players[0]!.baseUnits[0]!.might).toBe(1);
    // The battlefield still holds only the unit that was standing there — a token
    // arriving here would change what the next Showdown fights over.
    expect(settled.battlefields[0]!.units["p1"]).toHaveLength(1);
  });
});

describe("Grove of the God-Willow (OGN-280): draw 1", () => {
  it("draws for the holder", () => {
    const state = holding(GROVE_OF_THE_GOD_WILLOW);
    state.players[0]!.deck = [realUnitInstance(SETT_BRAWLER)];
    const settled = settleHold(state);
    expect(settled.players[0]!.hand).toHaveLength(1);
    expect(settled.players[1]!.hand, "the opponent drew from a battlefield they do not hold").toHaveLength(0);
  });
});

describe("Hallowed Tomb (OGN-281): return your Chosen Champion", () => {
  it("returns the CHOSEN champion from the trash to an empty Champion Zone", () => {
    const state = holding(HALLOWED_TOMB);
    const champion = realUnitInstance(SETT_BRAWLER);
    state.players[0]!.chosenChampionDefId = SETT_BRAWLER;
    state.players[0]!.championZone = null;
    state.players[0]!.trash = [champion];
    const settled = settleHold(state);
    expect(settled.players[0]!.championZone?.instanceId).toBe(champion.instanceId);
    expect(settled.players[0]!.trash).toHaveLength(0);
  });

  it("asks nothing when the Champion Zone is occupied — 'if it is empty'", () => {
    const state = holding(HALLOWED_TOMB);
    state.players[0]!.chosenChampionDefId = SETT_BRAWLER;
    state.players[0]!.championZone = realUnitInstance(SETT_BRAWLER);
    state.players[0]!.trash = [realUnitInstance(SETT_BRAWLER)];
    const settled = settleHold(state);
    expect(settled.players[0]!.trash, "the champion was pulled out of the trash anyway").toHaveLength(1);
  });

  it("does NOT return a champion card that is not YOUR Chosen Champion", () => {
    // The reason `chosenChampionDefId` exists: OGN prints 56 champions against 16
    // legends, so a champion in your trash need not be the one you chose.
    const state = holding(HALLOWED_TOMB);
    state.players[0]!.chosenChampionDefId = "OGN-999";
    state.players[0]!.championZone = null;
    state.players[0]!.trash = [realUnitInstance(SETT_BRAWLER)];
    const settled = settleHold(state);
    expect(settled.players[0]!.championZone).toBeNull();
    expect(settled.players[0]!.trash).toHaveLength(1);
  });

  it("can be declined — it is a 'you may'", () => {
    const state = holding(HALLOWED_TOMB);
    const champion = realUnitInstance(SETT_BRAWLER);
    state.players[0]!.chosenChampionDefId = SETT_BRAWLER;
    state.players[0]!.championZone = null;
    state.players[0]!.trash = [champion];
    const asked = resolveHeldTriggers(runBeginning(state));
    // Asserted before answering: without it this test passes vacuously against a
    // battlefield whose ability never fired at all, since declining and never
    // being asked leave the same board.
    expect(asked.pendingDecisions, "the Tomb never asked").toHaveLength(1);
    const settled = answerDecisions(asked, (options) => {
      const decline = options.find((o) => o.id === "decline");
      expect(decline, "no decline was offered for a 'you may'").toBeDefined();
      return decline!.id;
    });
    expect(settled.players[0]!.championZone).toBeNull();
    expect(settled.players[0]!.trash).toHaveLength(1);
  });
});

describe("Navori Fighting Pit (OGN-283): buff a unit here", () => {
  it("buffs the only unit there without prompting — one option is not a question", () => {
    const settled = settleHold(holding(NAVORI_FIGHTING_PIT));
    expect(settled.battlefields[0]!.units["p1"]![0]!.buffed).toBe(true);
  });

  it("offers each of the holder's units there, and only those", () => {
    const mine = [makeUnit({ name: "A" }), makeUnit({ name: "B" })];
    const state = holding(NAVORI_FIGHTING_PIT, mine);
    // A unit of the holder's standing somewhere ELSE is not "here".
    state.players[0]!.baseUnits = [makeUnit({ name: "In base" })];
    const settled = answerDecisions(resolveHeldTriggers(runBeginning(state)), (options) => {
      expect(options.map((o) => o.label).sort()).toEqual(["A", "B"]);
      return options.find((o) => o.label === "B")!.id;
    });
    const here = settled.battlefields[0]!.units["p1"]!;
    expect(here.find((u) => u.name === "B")!.buffed).toBe(true);
    expect(here.find((u) => u.name === "A")!.buffed).toBe(false);
    expect(settled.players[0]!.baseUnits[0]!.buffed).toBe(false);
  });
});

describe("Startipped Peak (OGN-288): you may channel 1 rune exhausted", () => {
  it("channels one rune, EXHAUSTED", () => {
    const state = holding(STARTIPPED_PEAK);
    state.players[0]!.runeDeck = [{ id: "r1", domain: "Calm", state: "Ready" }];
    const settled = settleHold(state);
    expect(settled.players[0]!.channeled).toHaveLength(1);
    expect(settled.players[0]!.channeled[0]!.state, "channelled READY — the card says exhausted").toBe("Exhausted");
    expect(settled.players[0]!.runeDeck).toHaveLength(0);
  });

  it("asks nothing at all with an empty rune deck", () => {
    const state = holding(STARTIPPED_PEAK);
    state.players[0]!.runeDeck = [];
    const settled = resolveHeldTriggers(runBeginning(state));
    expect(settled.pendingDecisions).toHaveLength(0);
  });
});

describe("Reckoner's Arena (OGN-286): activate the conquer effects of units here", () => {
  it("runs a unit's 'when I conquer' with no conquest at all", () => {
    const sett = realUnitInstance(SETT_BRAWLER);
    const settled = settleHold(holding(RECKONERS_ARENA, [sett]));
    expect(settled.battlefields[0]!.units["p1"]![0]!.buffed, "Sett's conquer effect never ran").toBe(true);
    // No battlefield changed hands, so no conquest point was scored — only the
    // ordinary hold point.
    expect(settled.players[0]!.points).toBe(1);
  });

  it("reaches only the units standing HERE", () => {
    const here = realUnitInstance(SETT_BRAWLER);
    const elsewhere = realUnitInstance(SETT_BRAWLER);
    const state = holding(RECKONERS_ARENA, [here]);
    state.players[0]!.baseUnits = [elsewhere];
    const settled = settleHold(state);
    expect(settled.battlefields[0]!.units["p1"]![0]!.buffed).toBe(true);
    expect(settled.players[0]!.baseUnits[0]!.buffed, "a unit in base had its conquer effect activated").toBe(false);
  });

  it("is a no-op for units with no conquer effect", () => {
    const settled = settleHold(holding(RECKONERS_ARENA, [makeUnit()]));
    expect(settled.battlefields[0]!.units["p1"]![0]!.buffed).toBe(false);
  });
});

describe("The Grand Plaza (OGN-293): 7+ units here wins the game", () => {
  const seven = () => Array.from({ length: 7 }, (_, i) => makeUnit({ name: `U${i}` }));

  it("wins on 7, with nothing like enough points to", () => {
    const settled = settleHold(holding(THE_GRAND_PLAZA, seven()));
    expect(settled.players[0]!.points, "this must not be a win by points").toBeLessThan(8);
    expect(winner(settled)).toBe(0);
  });

  it("does not win on 6", () => {
    const settled = settleHold(holding(THE_GRAND_PLAZA, seven().slice(0, 6)));
    expect(winner(settled)).toBeNull();
  });

  it("counts at RESOLUTION, so the seventh unit can be answered", () => {
    // The response window is real: the ability is on the chain, and killing a
    // unit standing there before it resolves means there is no longer a 7.
    const held = runBeginning(holding(THE_GRAND_PLAZA, seven()));
    const oneFewer: GameState = {
      ...held,
      battlefields: held.battlefields.map((bf) =>
        bf.id === "bf1" ? { ...bf, units: { p1: (bf.units["p1"] ?? []).slice(1) } } : bf,
      ),
    };
    expect(winner(resolveHeldTriggers(oneFewer))).toBeNull();
  });
});
