import { describe, expect, it } from "vitest";
import { addBuff, destroyUnit, dealDamage, discardCards, killUnit } from "../src/engine/effect-helpers.js";
import { deathTriggerDefIds, listeningPermanents } from "../src/engine/triggers.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { answerDecisions, makePlayer, makeState, makeUnit, pickCard, resolveHeldTriggers } from "./fixtures.js";
import { optionsFor } from "../src/engine/decisions.js";

/**
 * [Deathknell] — rule 808, "functionally short for 'When I die, [Effect]'."
 *
 * Three separate places used to trash a dead unit (dealDamage's lethal branch,
 * destroyUnit, combat's processDefeated), each deciding independently what dying
 * meant. Deathknell is what forced them into one funnel: a card that fires on
 * death has to fire on EVERY death, and a missed site is invisible — the unit
 * still dies, its ability just never happens.
 */

const registry = defaultCardRegistry();
const card = (defId: string) => createCardInstance(registry.get(defId)) as UnitInstance;

const UNDERCOVER_AGENT = "OGN-178"; // [Deathknell] Discard 2, then draw 2.
const SOARING_SCOUT = "OGN-216"; // [Deathknell] Channel 1 rune exhausted.

/** A player with a stocked hand, deck and rune deck, so every Deathknell in the
 *  pool has something to act on. */
function stockedState(unit: UnitInstance, zone: "base" | "battlefield" = "battlefield"): GameState {
  const state = makeState({
    players: [
      makePlayer("p1", {
        hand: [card("OGN-002"), card("OGN-002"), card("OGN-002")],
        deck: [card("OGN-003"), card("OGN-003"), card("OGN-003")],
        runeDeck: [
          { id: "rd1", domain: "Order", state: "Ready" },
          { id: "rd2", domain: "Order", state: "Ready" },
        ],
      }),
      makePlayer("p2"),
    ],
  });
  if (zone === "base") state.players[0]!.baseUnits = [unit];
  else state.battlefields[0]!.units = { p1: [unit] };
  return state;
}

describe("a Deathknell fires however the unit died (808)", () => {
  it("fires on lethal direct damage", () => {
    const scout = card(SOARING_SCOUT);
    const state = stockedState(scout);
    const before = state.players[0]!.channeled.length;

    const after = resolveHeldTriggers(dealDamage(state, 1, scout.instanceId, 99));

    expect(after.players[0]!.channeled).toHaveLength(before + 1);
    expect(after.players[0]!.channeled.at(-1)!.state).toBe("Exhausted");
  });

  it("fires on a kill instruction with no damage involved", () => {
    // destroyUnit skips the lethal math entirely, which is exactly the path that
    // would silently drop the trigger if each site decided for itself.
    const scout = card(SOARING_SCOUT);
    const state = stockedState(scout);

    const after = resolveHeldTriggers(destroyUnit(state, scout.instanceId));

    expect(after.players[0]!.channeled).toHaveLength(state.players[0]!.channeled.length + 1);
  });

  it("fires on death in combat", () => {
    const scout = card(SOARING_SCOUT);
    const attacker = makeUnit({ name: "Attacker", might: 9 });
    const state = stockedState(scout);
    state.battlefields[0]!.units = { p1: [scout], p2: [attacker] };

    // p2 attacks; the scout has no chance.
    const after = resolveHeldTriggers(resolveShowdown(state, "bf1", 1));

    expect(after.battlefields[0]!.units["p1"] ?? []).toHaveLength(0);
    expect(after.players[0]!.channeled).toHaveLength(state.players[0]!.channeled.length + 1);
  });

  it("fires for a unit that died in base, where there is no battlefield", () => {
    const scout = card(SOARING_SCOUT);
    const state = stockedState(scout, "base");

    const after = resolveHeldTriggers(destroyUnit(state, scout.instanceId));

    expect(after.players[0]!.baseUnits).toHaveLength(0);
    expect(after.players[0]!.channeled).toHaveLength(state.players[0]!.channeled.length + 1);
  });

  it("does NOT fire when the death was replaced by a ward (809.1.b.1)", () => {
    // "If the Permanent with the effect is not sent to the Trash, for example
    // because its 'killed' event was replaced with a recall, the triggered
    // ability will be removed from the chain." Here the ward makes the death not
    // happen at all, so there is nothing to remove.
    const scout = card(SOARING_SCOUT);
    const state = stockedState(scout);
    state.deathWardedUnitInstanceIds = [scout.instanceId];

    const after = resolveHeldTriggers(destroyUnit(state, scout.instanceId));

    expect(after.players[0]!.baseUnits.map((u) => u.instanceId)).toEqual([scout.instanceId]); // recalled
    expect(after.players[0]!.channeled).toHaveLength(state.players[0]!.channeled.length); // no channel
    expect(after.players[0]!.trash).toHaveLength(0);
  });
});

describe("Undercover Agent's Deathknell (OGN-178)", () => {
  it("discards 2 then draws 2, in that order", () => {
    const agent = card(UNDERCOVER_AGENT);
    const state = stockedState(agent);
    const originalHandIds = state.players[0]!.hand.map((c) => c.instanceId);
    const deckIds = state.players[0]!.deck.map((c) => c.instanceId);

    // The discard stops to ask now, so the draw is queued behind the two
    // questions rather than wrapped around them. Answering them is what proves
    // the "then" survived that: if the draw had run first, the cards on offer to
    // discard would have included the ones just drawn.
    const after = answerDecisions(resolveHeldTriggers(destroyUnit(state, agent.instanceId)));
    const handIds = after.players[0]!.hand.map((c) => c.instanceId);

    // 3 - 2 discarded + 2 drawn = 3.
    expect(handIds).toHaveLength(3);
    // "then" is load-bearing: the two cards drawn must be from the deck, never
    // one of the cards this effect just discarded.
    expect(handIds).toContain(deckIds[0]);
    expect(handIds).toContain(deckIds[1]);
    expect(handIds).not.toContain(originalHandIds[0]);
    expect(handIds).not.toContain(originalHandIds[1]);
    // The trash holds the two discards plus the Agent itself.
    expect(after.players[0]!.trash).toHaveLength(3);
  });

  it("discards what it can when the hand is shorter than 2", () => {
    const agent = card(UNDERCOVER_AGENT);
    const state = stockedState(agent);
    state.players[0]!.hand = [card("OGN-002")];

    // One card in hand and "discard 2" is not a choice, so nothing is asked —
    // the whole hand goes and the draw follows immediately.
    const after = resolveHeldTriggers(destroyUnit(state, agent.instanceId));

    expect(after.pendingDecisions).toHaveLength(0);
    expect(after.players[0]!.hand).toHaveLength(2); // 1 - 1 + 2 drawn
  });

  it("does not throw on an empty hand and empty deck", () => {
    const agent = card(UNDERCOVER_AGENT);
    const state = stockedState(agent);
    state.players[0]!.hand = [];
    state.players[0]!.deck = [];
    expect(() => destroyUnit(state, agent.instanceId)).not.toThrow();
  });
});

describe("killUnit, the one funnel", () => {
  it("strips the Buff before the card reaches the trash (709)", () => {
    const unit = makeUnit({ might: 3 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [unit] };
    state = addBuff(state, unit.instanceId);

    state = destroyUnit(state, unit.instanceId);

    const trashed = state.players[0]!.trash[0]!;
    expect(trashed.kind === "Unit" && trashed.buffed).toBe(false);
  });

  it("trashes to the OWNER, not whoever killed it", () => {
    const theirs = makeUnit({ might: 3 });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [theirs] };
    state = dealDamage(state, 0, theirs.instanceId, 99); // player 0 casts
    expect(state.players[1]!.trash).toHaveLength(1);
    expect(state.players[0]!.trash).toHaveLength(0);
  });

  it("fires the trigger against a board where the unit is already gone", () => {
    // Kog'Maw - Caustic's "deal 4 to all units at my battlefield" would hit its
    // own corpse if the order were reversed. Asserted via the location the
    // trigger receives rather than that card, which isn't implemented yet.
    const scout = card(SOARING_SCOUT);
    const state = stockedState(scout);
    const removed: GameState = {
      ...state,
      battlefields: state.battlefields.map((bf, i) => (i === 0 ? { ...bf, units: { p1: [] } } : bf)),
    };

    const after = killUnit(removed, scout, 0, "bf1");

    expect(after.battlefields[0]!.units["p1"]).toHaveLength(0);
    expect(after.players[0]!.trash.map((c) => c.instanceId)).toEqual([scout.instanceId]);
  });
});

describe("the shared listener walk", () => {
  it("includes base units, battlefield units, active Gear AND the Legend, in that order", () => {
    // Gear was the first gap: none of the four older dispatch tables looked at
    // activeGear, so a gear-only event had nowhere to be heard. The LEGEND was
    // the second, and it blocked the whole Legend-trigger conversion — a held
    // ability is re-looked-up through this walk at resolution, so an ability
    // belonging to a card the walk could not reach would have resolved to
    // nothing, silently.
    //
    // **The order is asserted, not incidental.** The chain resolves LIFO (343),
    // so the last listener placed resolves first: the Legend is last here
    // precisely so it still resolves before its controller's permanents, which
    // is where the old inline Legend dispatches sat.
    const inBase = makeUnit({ name: "Base" });
    const atBf = makeUnit({ name: "Field" });
    const gear = createCardInstance(registry.get("OGN-090")); // Orb of Regret
    const state = makeState({
      players: [makePlayer("p1", { baseUnits: [inBase], activeGear: [gear as never] }), makePlayer("p2")],
    });
    state.battlefields[1]!.units = { p1: [atBf] };

    const listeners = listeningPermanents(state, 0);

    expect(listeners.map((l) => l.card.name)).toEqual(["Base", "Field", "Orb of Regret", "Test Legend"]);
    expect(listeners[0]!.battlefieldId).toBeUndefined();
    expect(listeners[1]!.battlefieldId).toBe("bf2");
    expect(listeners[3]!.zone).toBe("legend");
    expect(listeners[3]!.battlefieldId, "a Legend is in its own zone, at no battlefield").toBeUndefined();
  });

  it("sees only the given player's permanents", () => {
    const mine = makeUnit({ name: "Mine" });
    const theirs = makeUnit({ name: "Theirs" });
    const state = makeState({
      players: [makePlayer("p1", { baseUnits: [mine] }), makePlayer("p2", { baseUnits: [theirs] })],
    });
    // Each player's own Legend rides along, which is the point of it being in the
    // walk — and it is THEIRS, so an event never offers one player's Legend to
    // the other's.
    expect(listeningPermanents(state, 0).map((l) => l.card.instanceId)).toEqual([mine.instanceId, "p1-legend"]);
    expect(listeningPermanents(state, 1).map((l) => l.card.instanceId)).toEqual([theirs.instanceId, "p2-legend"]);
  });
});

describe("coverage counts the Deathknell cards as implemented", () => {
  it("reports both registered cards, and the registry lists them", () => {
    expect(deathTriggerDefIds()).toEqual(expect.arrayContaining([UNDERCOVER_AGENT, SOARING_SCOUT]));
    expect(isCardImplemented(registry.get(UNDERCOVER_AGENT))).toBe(true);
    expect(isCardImplemented(registry.get(SOARING_SCOUT))).toBe(true);
  });
});

describe("discardCards", () => {
  it("ASKS when nobody chose and there is a choice to make", () => {
    // This used to take the front of hand and the test used to assert it. The
    // rules always gave the discarding player that choice; the engine simply had
    // no way to ask until pending decisions existed.
    const state = stockedState(makeUnit());
    const handIds = state.players[0]!.hand.map((c) => c.instanceId);

    const asked = discardCards(state, 0, 2);

    expect(asked.pendingDecisions).toHaveLength(1);
    expect(asked.players[0]!.trash).toHaveLength(0); // nothing has moved yet
    // Every card in hand is on offer, and the answer is honoured.
    expect(optionsFor(asked, asked.pendingDecisions[0]!).map((o) => o.instanceId)).toEqual(handIds);

    const after = answerDecisions(asked, pickCard(handIds[2]!));
    expect(after.players[0]!.trash.map((c) => c.instanceId)).toContain(handIds[2]);
    expect(after.players[0]!.hand).toHaveLength(1);
  });

  it("does not ask when there is no choice — hand no bigger than the count", () => {
    // "Discard 2" holding exactly two cards is not a decision, and a modal to
    // confirm it would be theatre. Also how "discard 2" with one card in hand
    // still discards that one (422).
    const state = stockedState(makeUnit());
    state.players[0]!.hand = state.players[0]!.hand.slice(0, 2);

    const after = discardCards(state, 0, 2);

    expect(after.pendingDecisions).toHaveLength(0);
    expect(after.players[0]!.hand).toHaveLength(0);
    expect(after.players[0]!.trash).toHaveLength(2);
  });

  it("honours an explicit choice", () => {
    const state = stockedState(makeUnit());
    const handIds = state.players[0]!.hand.map((c) => c.instanceId);
    const after = discardCards(state, 0, 1, [handIds[2]!]);
    expect(after.players[0]!.trash.map((c) => c.instanceId)).toEqual([handIds[2]]);
  });

  it("never discards more than `count`, even given more choices than that", () => {
    const state = stockedState(makeUnit());
    const handIds = state.players[0]!.hand.map((c) => c.instanceId);
    const after = discardCards(state, 0, 1, handIds);
    expect(after.players[0]!.trash).toHaveLength(1);
  });

  it("ignores instance ids that aren't in hand", () => {
    const state = stockedState(makeUnit());
    expect(discardCards(state, 0, 1, ["nonexistent"])).toBe(state);
  });

  it("no-ops on a zero or negative count", () => {
    const state = stockedState(makeUnit());
    expect(discardCards(state, 0, 0)).toBe(state);
    expect(discardCards(state, 0, -1)).toBe(state);
  });
});
