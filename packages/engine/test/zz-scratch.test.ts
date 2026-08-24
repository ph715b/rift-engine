import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import { makeState, makeUnit } from "./fixtures.js";
import type { GameState } from "../src/model/game-state.js";

const EDGE_OF_NIGHT = "SFD-139";

describe("scratch", () => {
  it("is a hidden gear play offered?", () => {
    const gear = createCardInstance(defaultCardRegistry().get(EDGE_OF_NIGHT));
    const state: GameState = makeState({ phase: "Action", activePlayerIndex: 0, turnNumber: 3 });
    state.players[0]!.channeled = Array.from({ length: 10 }, (_, i) => ({
      id: `r${i}`,
      domain: "Chaos" as const,
      state: "Ready" as const,
    }));
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      controllerId: "p1",
      units: { p1: [makeUnit({ instanceId: "mine", name: "Mine" })] },
      hiddenCards: [{ ownerIndex: 0, card: gear, hiddenOnTurn: 1 }],
    };
    const plays = legalActions(state).filter(
      (a: any) => a.type === "PlayCard" && a.card.defId === EDGE_OF_NIGHT,
    );
    console.log("offered plays:", plays.length);
    for (const p of plays as any[]) {
      console.log("  fromHidden:", p.fromHiddenBattlefieldId, "dest:", p.destinationBattlefieldId, "target:", p.targetUnitInstanceId);
    }
    expect(true).toBe(true);
  });
});
