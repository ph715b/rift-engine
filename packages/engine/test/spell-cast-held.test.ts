import { describe, expect, it } from "vitest";
import { executePassFocus } from "../src/actions/execute-pass-focus.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { pendingDecision } from "../src/engine/decisions.js";
import { holdEventTrigger } from "../src/engine/triggers.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type LegendInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * The last two families: on-spell-cast, and Volibear's "when you play a
 * [Mighty] unit".
 *
 * **on-spell-cast** is the one whose moment is a chain POP. The listeners are
 * ordinary permanents in play, so they need no `source` of their own — what they
 * needed was a held event kind, and `spellCast` is it, carrying the caster and
 * the spell's total cost because by the time it resolves the Spell is in a trash
 * and popped off the chain.
 *
 * **Volibear's blocker was recorded and was wrong.** The note said his hook
 * "needs the played unit, which `cardPlayed` deliberately does not carry" —
 * but `cardPlayed` carries `playedInstanceId`, and his body already looked the
 * unit up on the BOARD by that id rather than reading the instance handed to it
 * (deliberately, so a unit standing under a Garen aura counts as Mighty). He
 * needed nothing new at all. Re-read the code before believing a note about it.
 */

const registry = defaultCardRegistry();
const RAVENBLOOM_STUDENT = "OGN-103"; // when you play a spell, +1 Might this turn
const LUX_ILLUMINATED = "OGS-006"; // ... +3 if it costs 5 or more
const LUX_LEGEND = "OGS-021"; // Lux - Lady of Luminosity: draw 1 on a 5+ spell
const VOLIBEAR_LEGEND = "OGN-249"; // when you play a [Mighty] unit, you may exhaust me to channel
const HEXTECH_RAY = "OGN-009"; // 3 Energy Fury spell, needs a target

const penNames = (state: GameState): string[] => state.pendingTriggers.map((t) => t.listenerName);

const fireSpellCast = (state: GameState, casterIndex: 0 | 1, totalCost: number) =>
  holdEventTrigger(state, { kind: "spellCast", casterIndex, totalCost } as never);

describe("on-spell-cast is a Pending Item, placed at the chain pop", () => {
  /** The student at bf1 for p1, with a real Spell in hand and the runes to cast it. */
  function studentState(): { state: GameState; student: UnitInstance; spell: ReturnType<typeof spellInstance> } {
    const student = realUnitInstance(RAVENBLOOM_STUDENT);
    const spell = spellInstance(HEXTECH_RAY);
    const state = makeState({
      phase: "Action",
      players: [
        makePlayer("p1", {
          hand: [spell],
          floatingEnergy: 9,
          floatingPower: { Fury: 9 },
        }),
        makePlayer("p2"),
      ],
    });
    state.battlefields[0]!.units = { p1: [student], p2: [makeUnit({ name: "Target", might: 9 })] };
    return { state, student, spell };
  }

  const studentAt = (s: GameState) => (s.battlefields[0]!.units["p1"] ?? [])[0]!;

  it("does not resolve inside the chain pop — it waits", () => {
    // The end-to-end path: play the Spell, pass twice to resolve it, and the
    // listener's buff has NOT landed yet. This is the test that proves the
    // producer rather than the event shape.
    const { state, spell } = studentState();
    // Target the ENEMY explicitly. Hextech Ray reads "a unit at a battlefield",
    // not "an enemy unit", so the enumerator offers the Student himself too —
    // and the first version of this test took that action and killed its own
    // listener with 3 damage before it could buff.
    const enemyId = state.battlefields[0]!.units["p2"]![0]!.instanceId;
    const action = legalActions(state).find(
      (a) =>
        a.type === "PlayCard" &&
        a.card.instanceId === spell.instanceId &&
        (a as { targetUnitInstanceId?: string }).targetUnitInstanceId === enemyId,
    );
    expect(action, "Hextech Ray was never enumerated against the enemy").toBeDefined();

    let next = executePlayCard(state, action as never);
    for (let i = 0; i < 2; i += 1) next = executePassFocus(next, { type: "PassFocus", playerIndex: next.chainPriority });

    expect(studentAt(next).mightThisTurn, "the listener resolved inside the pop").toBe(0);
    expect(penNames(next)).toContain(registry.get(RAVENBLOOM_STUDENT).name);

    expect(studentAt(resolveHeldTriggers(next)).mightThisTurn).toBe(1);
  });

  it("is not PLACED for the OPPONENT's spell — 'when YOU play'", () => {
    // On the pen, not the board: his body still re-checks nothing about the
    // caster, so a wrongly placed trigger would buff him anyway.
    const { state } = studentState();

    expect(penNames(fireSpellCast(state, 1, 3))).not.toContain(registry.get(RAVENBLOOM_STUDENT).name);
  });
});

describe("Lux - Illuminated (OGS-006) and her Legend both read the 5+ threshold", () => {
  function luxState(): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.legend = createCardInstance(registry.get(LUX_LEGEND)) as LegendInstance;
    state.players[0]!.deck = [makeUnit({ name: "Drawn" })];
    state.battlefields[0]!.units = { p1: [realUnitInstance(LUX_ILLUMINATED)] };
    return state;
  }

  it("both wait on the chain, then pay out for a 5-cost spell", () => {
    const state = luxState();

    const held = fireSpellCast(state, 0, 5);
    expect(held.players[0]!.hand, "the Legend resolved inline").toHaveLength(0);
    expect(penNames(held)).toContain(registry.get(LUX_ILLUMINATED).name);
    expect(penNames(held)).toContain(registry.get(LUX_LEGEND).name);

    const settled = resolveHeldTriggers(held);

    expect((settled.battlefields[0]!.units["p1"] ?? [])[0]!.mightThisTurn).toBe(3);
    expect(settled.players[0]!.hand).toHaveLength(1);
  });

  it("neither is PLACED below 5 — the threshold is a fire-time condition", () => {
    const held = fireSpellCast(luxState(), 0, 4);

    expect(penNames(held)).not.toContain(registry.get(LUX_ILLUMINATED).name);
    expect(penNames(held)).not.toContain(registry.get(LUX_LEGEND).name);
  });
});

describe("Volibear - Relentless Storm (OGN-249): when you play a [Mighty] unit", () => {
  /** Volibear ready, with a rune deck to channel from, and a Mighty unit in play. */
  function voliState(might: number): { state: GameState; played: UnitInstance } {
    const played = makeUnit({ name: "Big", might });
    const state = makeState({ phase: "Action" });
    state.players[0]!.legend = createCardInstance(registry.get(VOLIBEAR_LEGEND)) as LegendInstance;
    state.players[0]!.runeDeck = [{ id: "rd1", domain: "Body", state: "Ready" }];
    state.players[0]!.baseUnits = [played];
    return { state, played };
  }

  const cardPlayed = (state: GameState, played: UnitInstance) =>
    holdEventTrigger(state, { kind: "cardPlayed", casterIndex: 0, playedKind: "Unit", playedInstanceId: played.instanceId, playedPowerCost: 0, isToken: false });

  it("waits on the chain, then asks", () => {
    const { state, played } = voliState(5);

    const held = cardPlayed(state, played);
    expect(held.pendingDecisions, "the Legend resolved inline").toHaveLength(0);
    expect(penNames(held)).toContain(registry.get(VOLIBEAR_LEGEND).name);

    expect(pendingDecision(resolveHeldTriggers(held))?.kind).toBe("OGN-249-channel");
  });

  it("is not PLACED for a unit under 5 Might — [Mighty] is the trigger condition", () => {
    const { state, played } = voliState(4);

    expect(penNames(cardPlayed(state, played))).not.toContain(registry.get(VOLIBEAR_LEGEND).name);
  });

  it("is not PLACED while he is already exhausted — the cost cannot be paid", () => {
    const { state, played } = voliState(5);
    state.players[0]!.legend = { ...state.players[0]!.legend, exhausted: true };

    expect(penNames(cardPlayed(state, played))).not.toContain(registry.get(VOLIBEAR_LEGEND).name);
  });
});
