import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { discardCards, grantTemporary } from "../src/engine/effect-helpers.js";
import { killGear } from "../src/engine/triggers.js";
import { runBeginning } from "../src/engine/turn-manager.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type CardInstance, type GearInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { answerDecisions, makePlayer, makeState, makeUnit, pickCard, resolveHeldTriggers } from "./fixtures.js";

/**
 * Scrapheap (OGN-182) — "When this is played, discarded, or killed, draw 1."
 *
 * The card that made self-triggers a separate family. Every other trigger in the
 * engine is found by walking the permanents in play, and two of Scrapheap's three
 * branches fire at a moment when it is not one: discarded, it is in hand going to
 * the trash; killed, it is on its way out. So it is dispatched by its OWN defId,
 * the same shape `[Deathknell]` already uses for units.
 *
 * It also forced gear to have a death funnel at all. Until now a gear could only
 * leave play via the Temporary sweep, which put it straight in the trash — fine
 * while nothing watched, invisibly wrong the moment something did.
 *
 * **Self-triggers are Chain Pending Items since 2026-08-03**, so every test here
 * settles the chain before asking what happened: the play, discard or kill only
 * PLACES the ability now. These tests are about WHAT each branch does;
 * `test/self-triggers-held.test.ts` pins the waiting itself and deliberately does
 * not settle.
 */

const registry = defaultCardRegistry();
const SCRAPHEAP = "OGN-182"; // 2 Energy, no Power
const ORB_OF_REGRET = "OGN-090"; // a gear with no self-trigger, for the negatives
const gear = (defId: string) => createCardInstance(registry.get(defId)) as GearInstance;

/** A caster holding `hand`, with runes to spare and a stocked deck to draw from. */
function holder(hand: CardInstance[], deckSize = 5): GameState {
  return makeState({
    phase: "Action",
    players: [
      makePlayer("p1", {
        hand,
        deck: Array.from({ length: deckSize }, () => makeUnit()),
        channeled: Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, domain: "Chaos" as const, state: "Ready" as const })),
      }),
      makePlayer("p2", { deck: Array.from({ length: deckSize }, () => makeUnit()) }),
    ],
  });
}

describe("played", () => {
  it("draws 1 when Scrapheap is played", () => {
    const scrap = gear(SCRAPHEAP);
    const state = holder([scrap]);
    const play = legalActions(state).find((a) => a.type === "PlayCard" && a.card.instanceId === scrap.instanceId)!;

    const after = resolveHeldTriggers(executePlayCard(state, play as never));

    expect(after.players[0]!.activeGear.map((g) => g.defId)).toContain(SCRAPHEAP);
    expect(after.players[0]!.hand).toHaveLength(1); // played the only card, drew one back
    expect(after.players[0]!.deck).toHaveLength(4);
  });

  it("does not draw for a gear without the trigger", () => {
    const orb = gear(ORB_OF_REGRET);
    const state = holder([orb]);
    const play = legalActions(state).find((a) => a.type === "PlayCard" && a.card.instanceId === orb.instanceId)!;

    expect(resolveHeldTriggers(executePlayCard(state, play as never)).players[0]!.deck).toHaveLength(5);
  });
});

describe("discarded", () => {
  it("draws 1 when Scrapheap is discarded from hand", () => {
    // The branch a listener walk could never see: at this moment the card is in
    // hand, not in play.
    const scrap = gear(SCRAPHEAP);
    const state = holder([scrap]);

    const after = resolveHeldTriggers(discardCards(state, 0, 1));

    expect(after.players[0]!.trash.map((c) => c.defId)).toEqual([SCRAPHEAP]);
    expect(after.players[0]!.hand).toHaveLength(1); // the discard left, the draw arrived
    expect(after.players[0]!.deck).toHaveLength(4);
  });

  it("draws once per copy discarded", () => {
    const state = holder([gear(SCRAPHEAP), gear(SCRAPHEAP)]);

    const after = resolveHeldTriggers(discardCards(state, 0, 2));

    expect(after.players[0]!.hand).toHaveLength(2);
    expect(after.players[0]!.deck).toHaveLength(3);
  });

  it("draws nothing when a different card is discarded", () => {
    const scrap = gear(SCRAPHEAP);
    const other = createCardInstance(registry.get(ORB_OF_REGRET));
    const state = holder([other, scrap]);

    // Two cards and "discard 1" is a real choice now, so name the card: the
    // point is that discarding something ELSE leaves Scrapheap unfired.
    const after = answerDecisions(resolveHeldTriggers(discardCards(state, 0, 1)), pickCard(other.instanceId));

    expect(after.players[0]!.trash.map((c) => c.defId)).toEqual([ORB_OF_REGRET]);
    expect(after.players[0]!.deck).toHaveLength(5);
    expect(after.players[0]!.hand.map((c) => c.defId)).toEqual([SCRAPHEAP]); // still held, still unfired
  });

  it("draws for the card's OWNER, not whoever caused the discard", () => {
    const state = holder([gear(SCRAPHEAP)]);

    const after = resolveHeldTriggers(discardCards(state, 0, 1));

    expect(after.players[1]!.deck).toHaveLength(5); // the opponent drew nothing
  });
});

describe("killed", () => {
  it("draws 1, and the gear lands in its owner's trash", () => {
    const scrap = gear(SCRAPHEAP);
    const state = makeState({
      players: [makePlayer("p1", { activeGear: [scrap], deck: [makeUnit(), makeUnit()] }), makePlayer("p2")],
    });

    const after = resolveHeldTriggers(killGear(state, scrap, 0));

    expect(after.players[0]!.activeGear).toHaveLength(0);
    expect(after.players[0]!.trash.map((c) => c.instanceId)).toEqual([scrap.instanceId]);
    expect(after.players[0]!.hand).toHaveLength(1);
  });

  it("fires through the [Temporary] sweep — the only way a gear dies today", () => {
    // Fading Memories can hand a gear [Temporary] (816), and before this that
    // sweep put the gear in the trash without firing anything. This is the
    // end-to-end version of the branch: grant, then let the Beginning Phase run.
    const scrap = gear(SCRAPHEAP);
    const state = makeState({
      phase: "Beginning",
      activePlayerIndex: 0,
      players: [makePlayer("p1", { activeGear: [scrap], deck: [makeUnit(), makeUnit()] }), makePlayer("p2")],
    });

    const after = resolveHeldTriggers(runBeginning(grantTemporary(state, scrap.instanceId)));

    expect(after.players[0]!.activeGear).toHaveLength(0);
    expect(after.players[0]!.trash.map((c) => c.defId)).toContain(SCRAPHEAP);
    // The Beginning Phase itself draws nothing (the turn's draw belongs to the
    // Draw Phase), so this one card is the trigger's and only the trigger's.
    expect(after.players[0]!.deck).toHaveLength(1);
    expect(after.players[0]!.hand).toHaveLength(1);
  });

  it("is a no-op on a gear that has already left play", () => {
    const scrap = gear(SCRAPHEAP);
    const state = makeState({ players: [makePlayer("p1", { deck: [makeUnit()] }), makePlayer("p2")] });

    expect(killGear(state, scrap, 0)).toBe(state);
  });
});

describe("coverage", () => {
  it("counts Scrapheap as implemented", () => {
    expect(isCardImplemented(registry.get(SCRAPHEAP))).toBe(true);
  });
});
