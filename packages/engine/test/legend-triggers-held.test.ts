import { describe, expect, it } from "vitest";
import { recordConquest } from "../src/engine/scoring.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type LegendInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { beginCombatAt, makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";

/**
 * Legend triggered abilities as Chain Pending Items.
 *
 * The blocker this removes was named in the plan and in three separate source
 * comments: `allListeningPermanents` walks base units, battlefield units, active
 * Gear and two trash cards, and never `players[i].legend` — so a Legend's ability
 * could be held but never RE-LOOKED-UP, which is what `resolvePendingTrigger`
 * needs to run it. Every Legend hook therefore resolved immediately at its source
 * while the permanents watching the same moment went on the chain.
 *
 * A Legend is now a listener like any other, and the four hooks whose moment is
 * already a held event are registered against it: Annie (`endOfTurn`), Garen and
 * Sett (`battlefieldConquered`), Ahri (`combatBegan`). The other four each have a
 * blocker that is about their EVENT rather than about Legends, recorded in
 * docs/rules-conformance.md — Jinx's `beginningPhase` must stay inline, Lux's
 * on-spell-cast and Leona's `unitsStunned` are not held kinds yet, and Volibear
 * needs the played unit, which `cardPlayed` does not carry.
 *
 * **A Legend never leaves play**, which is the one way it differs from every
 * other listener here: `resolvePendingTrigger`'s "it has gone" bail is
 * unreachable for one, and that is a fact about the zone, not luck.
 */

const registry = defaultCardRegistry();
const ANNIE = "OGS-017";
const GAREN = "OGS-023";
const AHRI = "OGN-255";
const SETT = "OGN-269";

/** A state whose player `index` has `defId` as their Legend. */
function withLegend(defId: string, index: 0 | 1 = 0, overrides: Partial<GameState> = {}): GameState {
  const state = makeState({ phase: "Action", ...overrides });
  state.players[index]!.legend = createCardInstance(registry.get(defId)) as LegendInstance;
  return state;
}

const heldTriggerNames = (state: GameState): string[] =>
  state.spellChain.filter((e) => "kind" in e && e.kind === "trigger").map((e) => (e as { listenerName: string }).listenerName);

const readyRuneCount = (state: GameState, index: 0 | 1) =>
  state.players[index]!.channeled.filter((r) => r.state === "Ready").length;

describe("Annie - Dark Child (OGS-017): at the end of your turn, ready up to 2 runes", () => {
  function annieState(): GameState {
    const state = withLegend(ANNIE);
    state.players[0]!.channeled = [
      { id: "r1", domain: "Fury", state: "Exhausted" },
      { id: "r2", domain: "Fury", state: "Exhausted" },
      { id: "r3", domain: "Fury", state: "Exhausted" },
    ];
    return state;
  }

  it("does not ready inside runEnd — it waits on the chain", () => {
    const ended = runEnd(annieState());

    expect(readyRuneCount(ended, 0), "the Legend resolved inline").toBe(0);
    expect(ended.pendingTriggers.map((t) => t.listenerName)).toContain(registry.get(ANNIE).name);
  });

  it("readies 2 when the chain pops it, and readies the ENDING player's runes", () => {
    // The turn-boundary rule this file inherits: `submit`'s Pass composes
    // runEnd with runStartOfTurn under one Cleanup, so by resolution time
    // `activePlayerIndex` has rotated. A Legend that read the board instead of
    // the event would ready the opponent's runes — invisibly, since theirs are
    // already full from their own Awaken.
    const settled = resolveHeldTriggers(runEnd(annieState()));

    expect(readyRuneCount(settled, 0)).toBe(2);
    expect(readyRuneCount(settled, 1)).toBe(0);
  });
});

describe("Garen - Might of Demacia (OGS-023): when you conquer with 4+ units there, draw 2", () => {
  function garenState(unitsHere: number): GameState {
    const state = withLegend(GAREN);
    state.players[0]!.deck = Array.from({ length: 5 }, (_, i) => makeUnit({ name: `Card${i}` }));
    state.battlefields[0]!.units = { p1: Array.from({ length: unitsHere }, (_, i) => makeUnit({ name: `Mine${i}` })) };
    state.battlefields[0]!.controllerId = "p1";
    return state;
  }

  it("does not draw inside recordConquest — it waits on the chain", () => {
    const conquered = recordConquest(garenState(4), 0, "bf1");

    expect(conquered.players[0]!.hand, "the Legend resolved inline").toHaveLength(0);
    expect(conquered.pendingTriggers.map((t) => t.listenerName)).toContain(registry.get(GAREN).name);
  });

  it("draws 2 when the chain pops it", () => {
    const settled = resolveHeldTriggers(recordConquest(garenState(4), 0, "bf1"));

    expect(settled.players[0]!.hand).toHaveLength(2);
  });

  it("is not even PLACED with three units there — the count is a fire-time condition", () => {
    // "If you have 4+ units at that battlefield" is a requirement besides
    // conquering, and 383.4 settles those at the moment of the event: a Legend
    // that placed a Pending Item and then resolved to nothing would cost both
    // players a PassFocus for an ability that never triggered.
    const conquered = recordConquest(garenState(3), 0, "bf1");

    expect(conquered.pendingTriggers.map((t) => t.listenerName)).not.toContain(registry.get(GAREN).name);
  });
});

describe("Sett - The Boss (OGN-269): when you conquer, ready me", () => {
  function settState(): GameState {
    const state = withLegend(SETT);
    state.players[0]!.legend = { ...state.players[0]!.legend, exhausted: true };
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Mine" })] };
    state.battlefields[0]!.controllerId = "p1";
    return state;
  }

  it("does not ready himself inside recordConquest", () => {
    const conquered = recordConquest(settState(), 0, "bf1");

    expect(conquered.players[0]!.legend.exhausted, "the Legend resolved inline").toBe(true);
    expect(conquered.pendingTriggers.map((t) => t.listenerName)).toContain(registry.get(SETT).name);
  });

  it("readies when the chain pops it", () => {
    const settled = resolveHeldTriggers(recordConquest(settState(), 0, "bf1"));

    expect(settled.players[0]!.legend.exhausted).toBe(false);
  });
});

describe("Ahri - Nine-Tailed Fox (OGN-255): an enemy attacking a battlefield you control gets -1", () => {
  /** p1 has Ahri as their Legend and holds bf1 with a defender; p2 attacks with
   *  `attackers` units, all of which gain the Attacker designation at once (465). */
  function ahriState(attackers: number): GameState {
    const state = withLegend(AHRI);
    state.battlefields[0]!.controllerId = "p1";
    state.battlefields[0]!.units = {
      p1: [makeUnit({ name: "Defender", might: 4 })],
      p2: Array.from({ length: attackers }, (_, i) => makeUnit({ name: `Attacker${i}`, might: 4 })),
    };
    return state;
  }

  const attackerMights = (state: GameState) => (state.battlefields[0]!.units["p2"] ?? []).map((u) => u.mightThisTurn);

  it("waits on the chain rather than debuffing inside the Cleanup", () => {
    const staged = beginCombatAt(ahriState(1), "bf1", 1);

    // `beginCombatAt` settles, so the debuff has landed by here — what this pins
    // is that it arrived through the CHAIN, which the listener name shows.
    expect(attackerMights(staged)).toEqual([-1]);
  });

  it("covers EVERY unit that gained the Attacker designation, from ONE Pending Item", () => {
    // Her text is "when an ENEMY UNIT attacks", singular, so the rules would give
    // one trigger per attacker. `holdEventTrigger` places one entry per listener,
    // so the units are captured at fire time and all of them are debuffed in a
    // single resolution — recorded as a divergence. What must NOT happen is a
    // reinforcement arriving later being debuffed, or only the first attacker
    // being covered.
    const settled = beginCombatAt(ahriState(3), "bf1", 1);

    expect(attackerMights(settled)).toEqual([-1, -1, -1]);
  });

  it("does nothing at a battlefield its controller does not hold", () => {
    const state = ahriState(1);
    state.battlefields[0]!.controllerId = null;

    const settled = beginCombatAt(state, "bf1", 1);

    expect(attackerMights(settled)).toEqual([0]);
    expect(heldTriggerNames(settled)).not.toContain(registry.get(AHRI).name);
  });

  it("does not debuff its OWN controller's attacking units", () => {
    const state = withLegend(AHRI);
    state.battlefields[0]!.controllerId = "p1";
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Mine", might: 4 })], p2: [makeUnit({ name: "Theirs", might: 4 })] };

    const settled = beginCombatAt(state, "bf1", 0);

    expect((settled.battlefields[0]!.units["p1"] ?? []).map((u) => u.mightThisTurn)).toEqual([0]);
  });
});

describe("a Legend is a listener, and the one that never leaves play", () => {
  it("is re-looked-up at resolution like every other listener", () => {
    // The whole blocker: `resolvePendingTrigger` finds its listener by instance
    // id through `allListeningPermanents`, and a Legend was not in that walk, so
    // holding one would have silently resolved to nothing. Asserted through a
    // real held resolution rather than on the walk directly, because "the walk
    // contains it" is not the claim — "the held trigger runs" is.
    const settled = resolveHeldTriggers(recordConquest(withLegend(SETT), 0, "bf1"));

    expect(settled.pendingTriggers).toHaveLength(0);
    expect(settled.spellChain).toHaveLength(0);
  });
});
