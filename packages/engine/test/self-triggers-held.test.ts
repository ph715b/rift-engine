import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { discardCards } from "../src/engine/effect-helpers.js";
import { killGear } from "../src/engine/triggers.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type CardInstance, type GearInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";

/**
 * Self-triggers as Chain Pending Items (383).
 *
 * The family whose blocker was stated outright in `execute-play-card`'s own
 * comment: "it fires for a card that has just LEFT play or never entered it, so
 * `allListeningPermanents` cannot find it and `resolvePendingTrigger` could not
 * re-look it up". That is the right diagnosis of the wrong mechanism — the
 * on-play conversion had already answered it, by NOT re-looking anything up.
 * `source: "selfTrigger"` carries the card on the entry and resolves from it,
 * which is 809.1.b.3's "note its attributes before the card is moved to the
 * Trash" applied to the whole card.
 *
 * Scrapheap is the card that makes all three moments observable at once, and two
 * of its three fire when it is provably not a permanent in play: discarded, it is
 * in hand on its way to the trash; killed, it is on its way out.
 *
 * **Placement order is chosen to preserve the old resolution order.** A self
 * trigger used to resolve INLINE, i.e. before the `cardPlayed` and on-play
 * triggers held alongside it. The chain is LIFO (343), so it is placed LAST at
 * every site and therefore still resolves first.
 */

const registry = defaultCardRegistry();
const SCRAPHEAP = "OGN-182"; // played, discarded, killed — all three
const TREASURE_TROVE = "OGN-186"; // killed
const gear = (defId: string) => createCardInstance(registry.get(defId)) as GearInstance;

const heldNames = (state: GameState): string[] =>
  state.spellChain.filter((e) => "kind" in e && e.kind === "trigger").map((e) => (e as { listenerName: string }).listenerName);

const penNames = (state: GameState): string[] => state.pendingTriggers.map((t) => t.listenerName);

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

describe("Scrapheap (OGN-182): played", () => {
  it("does not draw inside the play — it waits on the chain", () => {
    const scrap = gear(SCRAPHEAP);
    const state = holder([scrap]);
    const play = legalActions(state).find((a) => a.type === "PlayCard" && a.card.instanceId === scrap.instanceId)!;

    const after = executePlayCard(state, play as never);

    expect(after.players[0]!.activeGear.map((g) => g.defId), "the gear itself must still arrive").toContain(SCRAPHEAP);
    expect(after.players[0]!.deck, "the draw happened inside the play").toHaveLength(5);
    expect(penNames(after)).toContain(registry.get(SCRAPHEAP).name);
  });

  it("draws when the chain pops it", () => {
    const scrap = gear(SCRAPHEAP);
    const state = holder([scrap]);
    const play = legalActions(state).find((a) => a.type === "PlayCard" && a.card.instanceId === scrap.instanceId)!;

    const settled = resolveHeldTriggers(executePlayCard(state, play as never));

    expect(settled.players[0]!.deck).toHaveLength(4);
    expect(settled.players[0]!.hand).toHaveLength(1);
    expect(heldNames(settled)).toEqual([]);
  });
});

describe("Scrapheap (OGN-182): discarded — it is in HAND when it fires", () => {
  it("does not draw inside the discard, and draws when the chain pops it", () => {
    const scrap = gear(SCRAPHEAP);
    const state = holder([scrap]);

    const discarded = discardCards(state, 0, 1, [scrap.instanceId]);

    expect(discarded.players[0]!.trash.map((c) => c.defId), "the discard itself must still happen").toContain(SCRAPHEAP);
    expect(discarded.players[0]!.deck, "the draw happened inside the discard").toHaveLength(5);

    const settled = resolveHeldTriggers(discarded);

    // It resolved from a card sitting in the TRASH — nothing on the board is it,
    // and the entry carries it rather than looking it up.
    expect(settled.players[0]!.deck).toHaveLength(4);
  });
});

describe("Scrapheap (OGN-182): killed — it has LEFT play when it resolves", () => {
  it("draws from the chain, with the gear already in the trash", () => {
    const scrap = gear(SCRAPHEAP);
    const state = { ...holder([]), players: [{ ...holder([]).players[0]!, activeGear: [scrap] }, holder([]).players[1]!] } as GameState;

    const killed = killGear(state, scrap, 0);

    expect(killed.players[0]!.activeGear, "the gear must still be removed").toHaveLength(0);
    expect(killed.players[0]!.deck, "the draw happened inside killGear").toHaveLength(5);

    const settled = resolveHeldTriggers(killed);

    expect(settled.players[0]!.deck).toHaveLength(4);
  });
});

describe("Treasure Trove (OGN-186): when this leaves the board, draw 1 and channel 1", () => {
  it("waits on the chain, then pays out both halves", () => {
    const trove = gear(TREASURE_TROVE);
    const base = holder([]);
    const state: GameState = {
      ...base,
      players: [
        {
          ...base.players[0]!,
          activeGear: [trove],
          channeled: [],
          // "Channel 1 rune exhausted" takes it from the RUNE DECK, so an empty
          // one makes that half of the card unobservable.
          runeDeck: [{ id: "rd1", domain: "Chaos", state: "Ready" }],
        },
        base.players[1]!,
      ],
    };

    const killed = killGear(state, trove, 0);
    expect(killed.players[0]!.deck, "it resolved inside killGear").toHaveLength(5);
    expect(penNames(killed)).toContain(registry.get(TREASURE_TROVE).name);

    const settled = resolveHeldTriggers(killed);

    expect(settled.players[0]!.deck).toHaveLength(4);
    expect(settled.players[0]!.channeled).toHaveLength(1);
    expect(settled.players[0]!.channeled[0]!.state).toBe("Exhausted");
  });
});

describe("a card with no self-trigger holds nothing", () => {
  it("leaves the pen empty when an ordinary gear is killed", () => {
    // Identity still means something here: `holdSelfTrigger` returns the state
    // unchanged for a card with no entry, so nothing was held and no fresh object
    // was made.
    const orb = gear("OGN-090"); // Orb of Regret — no self-trigger
    const base = holder([]);
    const state: GameState = { ...base, players: [{ ...base.players[0]!, activeGear: [orb] }, base.players[1]!] };

    const killed = killGear(state, orb, 0);

    expect(killed.players[0]!.activeGear).toHaveLength(0);
    expect(killed.pendingTriggers).toHaveLength(0);
  });
});
