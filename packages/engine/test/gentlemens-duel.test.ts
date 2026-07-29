import { describe, expect, it } from "vitest";
import { effectForCard, targetingForCard } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { legalActions } from "../src/engine/legal-actions.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { makeState, makeUnit, spellInstance } from "./fixtures.js";

describe("Gentlemen's Duel (OGS-008): +3 Might then mutual damage equal to Mights", () => {
  it("has unitPair targeting: first friendly, second enemy", () => {
    expect(targetingForCard(spellInstance("OGS-008"))).toEqual({
      kind: "unitSlots",
      slots: ["friendly", "enemy"],
      min: 2, // a duel needs both participants, unlike the "up to two" cards
      scope: "anywhere", // neither duellist's text names a battlefield
    });
  });

  it("buffs the friendly +3, then deals each unit's (post-buff) Might to the other", () => {
    const duel = effectForCard(spellInstance("OGS-008"))!;
    const friendly = makeUnit({ might: 2 }); // becomes 5 after the buff
    const enemy = makeUnit({ might: 4 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [friendly], p2: [enemy] };

    const result = duel.resolve(state, contextFor(0), {
      targetUnitInstanceId: friendly.instanceId,
      secondTargetUnitInstanceId: enemy.instanceId,
    });

    // enemy (Might 4) takes 5 damage (friendly's post-buff Might) -> lethal, trashed
    expect(result.battlefields[0]!.units["p2"]).toHaveLength(0);
    expect(result.players[1]!.trash).toHaveLength(1);
    // friendly (post-buff Might 5) takes 4 damage (enemy's Might) -> survives with 4 damage
    expect(result.battlefields[0]!.units["p1"]).toHaveLength(1);
    expect(result.battlefields[0]!.units["p1"]![0]!.damage).toBe(4);
  });

  it("both units can die simultaneously if each other's Might is lethal", () => {
    const duel = effectForCard(spellInstance("OGS-008"))!;
    const friendly = makeUnit({ might: 1 }); // becomes 4 after the buff
    const enemy = makeUnit({ might: 4 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [friendly], p2: [enemy] };

    const result = duel.resolve(state, contextFor(0), {
      targetUnitInstanceId: friendly.instanceId,
      secondTargetUnitInstanceId: enemy.instanceId,
    });

    expect(result.battlefields[0]!.units["p1"]).toHaveLength(0);
    expect(result.battlefields[0]!.units["p2"]).toHaveLength(0);
    expect(result.players[0]!.trash).toHaveLength(1);
    expect(result.players[1]!.trash).toHaveLength(1);
  });

  it("validation rejects two friendly units (second target must be an enemy)", () => {
    const duel = spellInstance("OGS-008");
    const friendly1 = makeUnit();
    const friendly2 = makeUnit();
    const state = makeState();
    state.players[0]!.hand = [duel];
    state.battlefields[0]!.units = { p1: [friendly1, friendly2] };
    state.players[0]!.channeled = Array.from({ length: duel.energyCost }, (_, i) => ({
      id: `e${i}`,
      domain: "Body" as const,
      state: "Ready" as const,
    }));
    state.players[0]!.channeled.push({ id: "power-0", domain: "Body", state: "Ready" });

    const action: PlayCardAction = {
      type: "PlayCard",
      playerIndex: 0,
      card: duel,
      payment: { energyRunes: state.players[0]!.channeled.filter((r) => r.id !== "power-0").map((r) => r.id), powerRunes: ["power-0"] },
      targetUnitInstanceId: friendly1.instanceId,
      secondTargetUnitInstanceId: friendly2.instanceId,
    };
    expect(validatePlayCard(state, action).ok).toBe(false);
  });

  it("legalActions fans out the cross product of friendly x enemy units", () => {
    const duel = spellInstance("OGS-008");
    const friendly = makeUnit();
    const enemy1 = makeUnit();
    const enemy2 = makeUnit();
    const state = makeState();
    state.players[0]!.hand = [duel];
    state.battlefields[0]!.units = { p1: [friendly], p2: [enemy1, enemy2] };
    state.players[0]!.channeled = Array.from({ length: duel.energyCost }, (_, i) => ({
      id: `e${i}`,
      domain: "Body" as const,
      state: "Ready" as const,
    }));
    state.players[0]!.channeled.push({ id: "power-0", domain: "Body", state: "Ready" });

    const actions = legalActions(state);
    const matching = actions.filter((a) => a.type === "PlayCard" && a.card.instanceId === duel.instanceId);
    expect(matching).toHaveLength(2); // friendly x {enemy1, enemy2}
    const secondTargets = matching
      .map((a) => (a.type === "PlayCard" ? a.secondTargetUnitInstanceId : undefined))
      .sort();
    expect(secondTargets).toEqual([enemy1.instanceId, enemy2.instanceId].sort());
  });
});
