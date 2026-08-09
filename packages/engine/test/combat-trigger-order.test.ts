import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type LegendInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";
import { runCleanup } from "../src/engine/cleanup.js";

/**
 * Two things 465 says about a combat that the general trigger rules do not.
 *
 * **Step 4 orders placement by SIDE, not by turn.** "The Attacking player, who
 * has Focus, places Triggered Abilities on the Chain first, followed by all
 * non-Defender players in Turn Order, followed by the Defending Player." Rule 383
 * orders every other simultaneous trigger by TURN order, and the two agree
 * whenever the attacker is the turn player — which is every combat a Move starts,
 * since only the turn player moves. They come apart through Charm, which
 * relocates an ENEMY unit and credits the Contested status to the MOVED unit's
 * controller, so the non-turn player can be the Attacker on the turn player's own
 * turn.
 *
 * Placement order is the opposite of resolution order (340.1, LIFO), so
 * attacker-places-first means **the DEFENDER's combat triggers resolve first**.
 *
 * **Step 1 designates per UNIT.** Ahri - Nine-Tailed Fox's "when an enemy unit
 * attacks a battlefield you control" is singular, so three attackers is three
 * triggered abilities, each responded to separately — not one that debuffs three.
 */

const registry = defaultCardRegistry();
const AHRI_LEGEND = "OGN-255";
const YASUO_REMORSEFUL = "OGN-076"; // "when I attack"
const TEEMO_STRATEGIST = "OGN-121"; // "when I defend"

const chainNames = (state: GameState): string[] =>
  state.spellChain.filter((e) => "kind" in e && e.kind === "trigger").map((e) => (e as { listenerName: string }).listenerName);

const penNames = (state: GameState): string[] => state.pendingTriggers.map((t) => t.listenerName);

describe("465 Step 4: at a combat, the ATTACKER places first — so the defender resolves first", () => {
  /**
   * p1 is the TURN player and holds bf1 with Teemo (who defends); p2 attacks
   * with Yasuo. Contested by p2 makes the non-turn player the Attacker, which is
   * the only shape where 465's order and 383's disagree.
   */
  function crossedState(): GameState {
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0]!.controllerId = "p1";
    state.battlefields[0]!.units = { p1: [realUnitInstance(TEEMO_STRATEGIST)], p2: [realUnitInstance(YASUO_REMORSEFUL)] };
    state.battlefields[0]!.contestedByIndex = 1; // p2 attacks, on p1's turn
    state.players[0]!.deck = Array.from({ length: 6 }, () => makeUnit());
    return state;
  }

  it("places the attacker's trigger BEFORE the defender's", () => {
    // The pen is in placement order. 465 Step 4 wants the attacking player's
    // abilities placed first; 383's turn-order rule would place the turn player's
    // (Teemo's) first, which is the opposite.
    const staged = runCleanup(crossedState());

    expect(penNames(staged).length + chainNames(staged).length, "no combat trigger was placed at all").toBeGreaterThan(0);
    expect(chainNames(staged)).toEqual([registry.get(YASUO_REMORSEFUL).name, registry.get(TEEMO_STRATEGIST).name]);
  });
});

describe("464.2.c Step 1: every attacking unit gains the designation, so Ahri triggers once EACH", () => {
  function ahriState(attackers: number): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.legend = createCardInstance(registry.get(AHRI_LEGEND)) as LegendInstance;
    state.battlefields[0]!.controllerId = "p1";
    state.battlefields[0]!.units = {
      p1: [makeUnit({ name: "Defender", might: 4 })],
      p2: Array.from({ length: attackers }, (_, i) => makeUnit({ name: `Attacker${i}`, might: 4 })),
    };
    state.battlefields[0]!.contestedByIndex = 1;
    return state;
  }

  const attackerMights = (s: GameState) => (s.battlefields[0]!.units["p2"] ?? []).map((u) => u.mightThisTurn);

  it("places THREE Pending Items for three attackers, not one", () => {
    // Her text is "when an ENEMY UNIT attacks", singular. Three attackers gaining
    // the designation simultaneously is three triggered abilities, and an
    // opponent may respond between them — one entry covering all three collapses
    // three response windows into one.
    const staged = runCleanup(ahriState(3));

    const hers = chainNames(staged).filter((n) => n === registry.get(AHRI_LEGEND).name);
    expect(hers).toHaveLength(3);
  });

  it("still debuffs every attacker once", () => {
    const settled = resolveHeldTriggers(ahriState(3));

    expect(attackerMights(settled)).toEqual([-1, -1, -1]);
  });

  it("places one for one attacker", () => {
    const staged = runCleanup(ahriState(1));

    expect(chainNames(staged).filter((n) => n === registry.get(AHRI_LEGEND).name)).toHaveLength(1);
  });
});
