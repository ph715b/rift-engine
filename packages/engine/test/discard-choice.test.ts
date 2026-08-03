import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { submit } from "../src/engine/game-engine.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type CardInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";

/**
 * A discard the CASTER chooses, carried on the action.
 *
 * Every other discard in this engine takes the front of hand, because a trigger
 * has no action to carry a choice on. These two cards do have one, and for both
 * of them which card is discarded genuinely matters:
 *
 *  - Get Excited! deals damage equal to the discarded card's Energy cost, so the
 *    choice IS the effect. Mandatory.
 *  - Brazen Buccaneer buys a 2-Energy discount with it. Optional, so declining
 *    has to stay available.
 */

const registry = defaultCardRegistry();
const GET_EXCITED = "OGN-008"; // 2 Energy + 1 Fury Power
const BRAZEN_BUCCANEER = "OGN-002"; // 6 Energy, discard 1 -> 4
const card = (defId: string) => createCardInstance(registry.get(defId));

function caster(played: CardInstance, hand: CardInstance[], runes: number): GameState {
  const state = makeState({
    phase: "Action",
    players: [
      makePlayer("p1", {
        hand: [played, ...hand],
        channeled: Array.from({ length: runes }, (_, i) => ({ id: `r${i}`, domain: "Fury" as const, state: "Ready" as const })),
      }),
      makePlayer("p2"),
    ],
  });
  return state;
}

const playsOf = (state: GameState, c: CardInstance) =>
  legalActions(state).filter((a) => a.type === "PlayCard" && a.card.instanceId === c.instanceId);

describe("Get Excited! (OGN-008): the discard IS the effect, so it's mandatory", () => {
  /** A caster with two very differently-priced cards to discard, and a target. */
  function excitedState(): { state: GameState; spell: CardInstance; cheap: CardInstance; pricey: CardInstance; target: UnitInstance } {
    const spell = card(GET_EXCITED);
    const cheap = card("OGN-210"); // Daring Poro, 2 Energy
    const pricey = card("OGN-011"); // Magma Wurm, 8 Energy
    const target = makeUnit({ might: 9 });
    const state = caster(spell, [cheap, pricey], 6);
    state.battlefields[0]!.units = { p2: [target] };
    return { state, spell, cheap, pricey, target };
  }

  it("offers one candidate per card in hand, and never a no-discard one", () => {
    const { state, spell, cheap, pricey } = excitedState();
    const plays = playsOf(state, spell);

    const discards = new Set(plays.map((a) => (a.type === "PlayCard" ? a.discardCardInstanceId : undefined)));
    expect(discards.has(undefined)).toBe(false); // mandatory: no declining
    expect(discards).toContain(cheap.instanceId);
    expect(discards).toContain(pricey.instanceId);
  });

  it("never offers discarding ITSELF", () => {
    const { state, spell } = excitedState();
    const plays = playsOf(state, spell);
    expect(plays.some((a) => a.type === "PlayCard" && a.discardCardInstanceId === spell.instanceId)).toBe(false);
  });

  it("deals damage equal to the DISCARDED card's Energy cost", () => {
    const { state, spell, cheap, pricey, target } = excitedState();

    const damageAfter = (discardId: string) => {
      const play = playsOf(state, spell).find(
        (a) => a.type === "PlayCard" && a.discardCardInstanceId === discardId && a.targetUnitInstanceId === target.instanceId,
      )!;
      let next = submit(state, play).state;
      next = submit(next, { type: "PassFocus", playerIndex: 0 }).state;
      next = submit(next, { type: "PassFocus", playerIndex: 1 }).state;
      return next.battlefields[0]!.units["p2"]?.[0]?.damage ?? Infinity;
    };

    // The whole point of making it a real choice: the same spell does 2 or 8.
    expect(damageAfter(cheap.instanceId)).toBe(2);
    expect(damageAfter(pricey.instanceId)).toBe(8);
  });

  it("is not playable at all with nothing else in hand", () => {
    const spell = card(GET_EXCITED);
    const state = caster(spell, [], 6);
    state.battlefields[0]!.units = { p2: [makeUnit()] };
    expect(playsOf(state, spell)).toHaveLength(0);
  });

  it("is refused when submitted with no discard named", () => {
    const { state, spell, target } = excitedState();
    const play = playsOf(state, spell)[0]!;
    const forged = { ...play, discardCardInstanceId: undefined, targetUnitInstanceId: target.instanceId };
    expect(validatePlayCard(state, forged as never).ok).toBe(false);
  });

  it("is refused when the named card isn't in hand", () => {
    const { state, spell } = excitedState();
    const play = playsOf(state, spell)[0]!;
    expect(validatePlayCard(state, { ...play, discardCardInstanceId: "nowhere" } as never).ok).toBe(false);
  });
});

describe("Brazen Buccaneer (OGN-002): an OPTIONAL discard that buys a discount", () => {
  function buccaneerState(runes: number): { state: GameState; bucc: CardInstance; spare: CardInstance } {
    const bucc = card(BRAZEN_BUCCANEER);
    const spare = card("OGN-210");
    return { state: caster(bucc, [spare], runes), bucc, spare };
  }

  it("offers both declining and discarding", () => {
    const { state, bucc, spare } = buccaneerState(8);
    const plays = playsOf(state, bucc);
    const discards = plays.map((a) => (a.type === "PlayCard" ? a.discardCardInstanceId : undefined));
    expect(discards).toContain(undefined); // "you may" — declining stays available
    expect(discards).toContain(spare.instanceId);
  });

  it("the discarding candidate costs 2 Energy less", () => {
    const { state, bucc } = buccaneerState(8);
    const plays = playsOf(state, bucc);
    const declined = plays.find((a) => a.type === "PlayCard" && a.discardCardInstanceId === undefined)!;
    const paid = plays.find((a) => a.type === "PlayCard" && a.discardCardInstanceId !== undefined)!;

    expect(declined.type === "PlayCard" && declined.payment.energyRunes.length).toBe(6);
    expect(paid.type === "PlayCard" && paid.payment.energyRunes.length).toBe(4);
  });

  it("actually discards the named card when played", () => {
    const { state, bucc, spare } = buccaneerState(8);
    const paid = playsOf(state, bucc).find((a) => a.type === "PlayCard" && a.discardCardInstanceId === spare.instanceId)!;

    const after = resolveHeldTriggers(executePlayCard(state, paid as never));

    expect(after.players[0]!.hand).toHaveLength(0);
    expect(after.players[0]!.trash.map((c) => c.instanceId)).toEqual([spare.instanceId]);
  });

  it("discards nothing when declined", () => {
    const { state, bucc, spare } = buccaneerState(8);
    const declined = playsOf(state, bucc).find((a) => a.type === "PlayCard" && a.discardCardInstanceId === undefined)!;

    const after = executePlayCard(state, declined as never);

    expect(after.players[0]!.hand.map((c) => c.instanceId)).toEqual([spare.instanceId]);
    expect(after.players[0]!.trash).toHaveLength(0);
  });

  it("is playable ONLY via the discount when runes are short — the discount is real", () => {
    // 4 runes: not enough for the printed 6, enough for the discounted 4.
    const { state, bucc } = buccaneerState(4);
    const plays = playsOf(state, bucc);
    expect(plays.length).toBeGreaterThan(0);
    expect(plays.every((a) => a.type === "PlayCard" && a.discardCardInstanceId !== undefined)).toBe(true);
  });

  it("prices the discount AFTER floating Energy, not before", () => {
    // The gap a self-play probe found and the suite did not: the discounted cost
    // was subtracted from the RAW price and stopped there, skipping the
    // floating-Energy reduction the plain path applies. Enumeration then offered
    // a 4-rune payment for a card validation priced at 3, and the AI — which
    // trusts legalActions and calls the executor directly — threw mid-game.
    // 6 printed - 2 discount - 1 floating = 3.
    const { state, bucc } = buccaneerState(8);
    state.players[0]!.floatingEnergy = 1;

    const paid = playsOf(state, bucc).find((a) => a.type === "PlayCard" && a.discardCardInstanceId !== undefined)!;

    expect(paid.type === "PlayCard" && paid.payment.energyRunes.length).toBe(3);
    expect(validatePlayCard(state, paid as never).ok).toBe(true); // enumeration and validation agree
  });

  it("refuses a payment sized to the discount without actually discarding", () => {
    const { state, bucc } = buccaneerState(8);
    const paid = playsOf(state, bucc).find((a) => a.type === "PlayCard" && a.discardCardInstanceId !== undefined)!;
    const cheat = { ...paid, discardCardInstanceId: undefined };
    expect(validatePlayCard(state, cheat as never).ok).toBe(false);
  });
});

describe("coverage counts both", () => {
  it("reports them as implemented", () => {
    for (const id of [GET_EXCITED, BRAZEN_BUCCANEER]) {
      expect(isCardImplemented(registry.get(id)), `${id} (${registry.get(id).name})`).toBe(true);
    }
  });
});
