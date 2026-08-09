import { describe, expect, it } from "vitest";
import { battlefieldDefIdFor } from "../src/decks/battlefield-setup.js";
import { effectiveKeywords } from "../src/engine/granted-keywords.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { answerDecisions, beginCombatAt, makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";

/**
 * The two "when you defend here" battlefields.
 *
 * The moment is 464.2.c's Combat Step 1 — `cleanup.beginCombatAt`, the same instant
 * every Attack Trigger fires — and the `beginCombatAt` fixture drives it through
 * the real Cleanup rather than hand-building a `combatBegan`, so a card that
 * fires for the wrong SIDE fails here.
 */

const FORTIFIED_POSITION = "OGN-279";
const REAVERS_ROW = "OGN-285";

/**
 * bf1 is the named battlefield, with `defenders` (player 0's) already standing
 * there and `attackers` (player 1's) walking in — so player 1 is the Attacker
 * and player 0 defends.
 */
function contestedAt(defId: string, defenders: UnitInstance[], attackers: UnitInstance[]): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 1 });
  state.battlefields[0] = {
    ...state.battlefields[0]!,
    defId,
    controllerId: "p1",
    units: { p1: defenders, p2: attackers },
  };
  return state;
}

describe("the defend moment", () => {
  it("every name in the table is a battlefield that really prints that text", () => {
    expect(battlefieldDefIdFor("Fortified Position")).toBe(FORTIFIED_POSITION);
    expect(battlefieldDefIdFor("Reaver's Row")).toBe(REAVERS_ROW);
  });

  it("fires for the DEFENDER, not the attacker or the turn player", () => {
    const mine = makeUnit({ name: "Defender" });
    const theirs = makeUnit({ name: "Attacker" });
    const opened = beginCombatAt(contestedAt(FORTIFIED_POSITION, [mine], [theirs]), "bf1", 1);
    const decision = opened.pendingDecisions[0];
    expect(decision, "no defend trigger fired at all").toBeDefined();
    expect(decision!.playerIndex, "the ability was handed to the attacker").toBe(0);
  });

  it("does NOT fire again when a reinforcement arrives mid-combat", () => {
    // 383.4.f's "for the first time during a combat", applied to the SIDE: a
    // player already defending does not begin to defend again.
    const opened = answerDecisions(
      beginCombatAt(contestedAt(REAVERS_ROW, [makeUnit({ name: "A" })], [makeUnit()]), "bf1", 1),
      (options) => options.find((o) => o.id === "decline")!.id,
    );
    const reinforced: GameState = {
      ...opened,
      battlefields: opened.battlefields.map((bf) =>
        bf.id === "bf1" ? { ...bf, units: { ...bf.units, p1: [...(bf.units["p1"] ?? []), makeUnit({ name: "B" })] } } : bf,
      ),
    };
    const settled = resolveHeldTriggers(reinforced);
    expect(settled.pendingDecisions, "Reaver's Row asked a second time for an arrival").toHaveLength(0);
  });

  it("fires nothing when the defending side has no units — there is no defender", () => {
    // A Non-Combat Showdown: player 1 walks into an empty battlefield. Nobody
    // gains a Defender designation, so nothing defends.
    const state = contestedAt(FORTIFIED_POSITION, [], [makeUnit()]);
    const opened = beginCombatAt(state, "bf1", 1);
    expect(opened.pendingDecisions).toHaveLength(0);
    expect(opened.pendingTriggers.filter((e) => e.source === "battlefield")).toHaveLength(0);
  });
});

describe("Fortified Position (OGN-279): a unit gains [Shield 2] this combat", () => {
  it("grants [Shield 2], not [Shield 1]", () => {
    const mine = makeUnit({ name: "Defender" });
    const settled = answerDecisions(
      beginCombatAt(contestedAt(FORTIFIED_POSITION, [mine], [makeUnit()]), "bf1", 1),
      (options) => options.find((o) => o.instanceId === mine.instanceId)!.id,
    );
    const shielded = settled.battlefields[0]!.units["p1"]![0]!;
    expect(effectiveKeywords(settled, shielded, 0)["Shield"]).toBe(2);
  });

  it("offers every unit here, on BOTH sides — the card names no owner", () => {
    const mine = makeUnit({ name: "Mine" });
    const theirs = makeUnit({ name: "Theirs" });
    const inBase = makeUnit({ name: "In base" });
    const state = contestedAt(FORTIFIED_POSITION, [mine], [theirs]);
    state.players[0]!.baseUnits = [inBase];
    const settled = answerDecisions(beginCombatAt(state, "bf1", 1), (options) => {
      expect(options.map((o) => o.label).sort()).toEqual(["Mine", "Theirs"]);
      return options.find((o) => o.instanceId === theirs.instanceId)!.id;
    });
    expect(effectiveKeywords(settled, settled.battlefields[0]!.units["p2"]![0]!, 1)["Shield"]).toBe(2);
  });

  it("never lowers a bigger printed Shield", () => {
    // 817.1.a makes duplicate instances redundant rather than cumulative, and
    // taking the larger is what "redundant" means for a number.
    const tanky = makeUnit({ name: "Tanky", keywords: { Shield: 3 } });
    const settled = answerDecisions(
      beginCombatAt(contestedAt(FORTIFIED_POSITION, [tanky], [makeUnit()]), "bf1", 1),
      (options) => options.find((o) => o.instanceId === tanky.instanceId)!.id,
    );
    expect(effectiveKeywords(settled, settled.battlefields[0]!.units["p1"]![0]!, 0)["Shield"]).toBe(3);
  });
});

describe("Reaver's Row (OGN-285): you may move a friendly unit here to base", () => {
  it("moves the chosen unit to base without exhausting it — it is a MOVE, not a Recall", () => {
    const mine = makeUnit({ name: "Retreater" });
    const settled = answerDecisions(
      beginCombatAt(contestedAt(REAVERS_ROW, [mine], [makeUnit()]), "bf1", 1),
      (options) => options.find((o) => o.instanceId === mine.instanceId)!.id,
    );
    expect(settled.battlefields[0]!.units["p1"]).toHaveLength(0);
    const moved = settled.players[0]!.baseUnits[0]!;
    expect(moved.instanceId).toBe(mine.instanceId);
    expect(moved.exhausted, "a move exhausted the unit — that is what a Recall does").toBe(false);
    expect(moved.movesThisTurn, "the retreat counted as one of the unit's moves").toBe(0);
  });

  it("offers only FRIENDLY units, and can be declined", () => {
    const mine = makeUnit({ name: "Mine" });
    const theirs = makeUnit({ name: "Theirs" });
    const opened = beginCombatAt(contestedAt(REAVERS_ROW, [mine], [theirs]), "bf1", 1);
    expect(opened.pendingDecisions, "Reaver's Row never asked").toHaveLength(1);
    const settled = answerDecisions(opened, (options) => {
      expect(options.map((o) => o.label).sort()).toEqual(["Decline", "Retreat Mine"]);
      return options.find((o) => o.id === "decline")!.id;
    });
    expect(settled.battlefields[0]!.units["p1"]).toHaveLength(1);
    expect(settled.players[0]!.baseUnits).toHaveLength(0);
  });
});
