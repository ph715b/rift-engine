import { describe, expect, it } from "vitest";
import { discardCards, stunUnits } from "../src/engine/effect-helpers.js";
import { answerDecision, optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type LegendInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * `unitsStunned` and `cardsDiscarded` as Chain Pending Items (383).
 *
 * Both were already `GameEvent` kinds with a real listener walk behind them —
 * the only thing inline about them was the `dispatchEvent` at the producer. So
 * this is the plainest form the conversion takes, and the three cards it moves
 * are Eclipse Herald, Jinx - Rebel and Leona - Radiant Dawn's Legend hook, which
 * comes along free now that a Legend is in the listener walk.
 *
 * **What each event's SHAPE is for, and why holding does not change it:**
 * `unitsStunned` is one event per instruction carrying every unit that actually
 * became stunned, because Leona pays out once for "one or more" while Eclipse
 * Herald triggers per unit (423 drops an already-stunned unit before the event
 * exists). `cardsDiscarded` is one per instruction with no count, and the discard
 * DECISION suppresses it until the last card so a "discard 2" answered one card
 * at a time still pays out once. Holding preserves both, because the event is
 * captured on the chain entry exactly as it fired.
 */

const registry = defaultCardRegistry();
const ECLIPSE_HERALD = "OGN-059";
const JINX_REBEL = "OGN-202";
const LEONA_RADIANT_DAWN = "OGN-261";

const heldNames = (state: GameState): string[] =>
  state.spellChain.filter((e) => "kind" in e && e.kind === "trigger").map((e) => (e as { listenerName: string }).listenerName);

const penNames = (state: GameState): string[] => state.pendingTriggers.map((t) => t.listenerName);

describe("Eclipse Herald (OGN-059): when you stun an enemy unit, ready me and +1 Might", () => {
  /** The Herald at bf1 for p1, exhausted, with `enemies` stunnable enemy units. */
  function heraldState(enemies = 1): { state: GameState; herald: UnitInstance; targets: UnitInstance[] } {
    const herald = { ...realUnitInstance(ECLIPSE_HERALD), exhausted: true } as UnitInstance;
    const targets = Array.from({ length: enemies }, (_, i) => makeUnit({ name: `Foe${i}` }));
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [herald], p2: targets };
    return { state, herald, targets };
  }

  const heraldAt = (state: GameState) => (state.battlefields[0]!.units["p1"] ?? [])[0]!;

  it("does not resolve inside stunUnits — it waits on the chain", () => {
    const { state, targets } = heraldState();

    const stunned = stunUnits(state, 0, [targets[0]!.instanceId]);

    expect(stunned.battlefields[0]!.units["p2"]![0]!.stunned, "the stun itself must still happen").toBe(true);
    expect(heraldAt(stunned).exhausted, "the Herald resolved inline").toBe(true);
    expect(penNames(stunned)).toContain(registry.get(ECLIPSE_HERALD).name);
  });

  it("readies and buffs when the chain pops it", () => {
    const { state, targets } = heraldState();

    const settled = resolveHeldTriggers(stunUnits(state, 0, [targets[0]!.instanceId]));

    expect(heraldAt(settled).exhausted).toBe(false);
    expect(heraldAt(settled).mightThisTurn).toBe(1);
  });

  it("pays out PER enemy unit stunned, from one event", () => {
    // "AN enemy unit", singular — deliberately the other shape from Leona's "one
    // or more", and the +1 is not idempotent the way the ready is.
    const { state, targets } = heraldState(2);

    const settled = resolveHeldTriggers(stunUnits(state, 0, targets.map((t) => t.instanceId)));

    expect(heraldAt(settled).mightThisTurn).toBe(2);
  });

  it("is not PLACED when the stunner is the opponent", () => {
    // "When YOU stun" — a fire-time condition, so it decides whether a Pending
    // Item exists at all rather than being re-asked at resolution. Asserted on
    // the pen: after a hold the board has not moved either way, so a board-only
    // check would pass whether the condition worked or the trigger were merely
    // waiting.
    const { state, targets } = heraldState();

    const stunned = stunUnits(state, 1, [targets[0]!.instanceId]);

    expect(penNames(stunned)).not.toContain(registry.get(ECLIPSE_HERALD).name);
  });

  it("is not PLACED when only a FRIENDLY unit was stunned", () => {
    // "an ENEMY unit" — measured against the Herald's controller. A card that
    // stuns your own must not celebrate it.
    const { state, herald } = heraldState();
    const friend = makeUnit({ name: "Mine" });
    state.battlefields[0]!.units["p1"] = [herald, friend];

    const stunned = stunUnits(state, 0, [friend.instanceId]);

    expect(penNames(stunned)).not.toContain(registry.get(ECLIPSE_HERALD).name);
  });
});

describe("Leona - Radiant Dawn (OGN-261): a Legend that stops to ask, from the chain", () => {
  /**
   * `friendlies` of p1's units at bf1, opposite one enemy.
   *
   * TWO by default, and that is not padding: a decision with ONE option is
   * auto-resolved and never prompts, so a board with a single friendly unit
   * makes "buff a friendly unit" a foregone conclusion and `pendingDecision`
   * never sees it. The first version of this fixture had one, and the question
   * it was written to assert had already been answered.
   */
  function leonaState(friendlies = 2): { state: GameState; foe: UnitInstance } {
    const foe = makeUnit({ name: "Foe" });
    const state = makeState({ phase: "Action" });
    state.players[0]!.legend = createCardInstance(registry.get(LEONA_RADIANT_DAWN)) as LegendInstance;
    state.battlefields[0]!.units = {
      p1: Array.from({ length: friendlies }, (_, i) => makeUnit({ name: `Mine${i}` })),
      p2: [foe],
    };
    return { state, foe };
  }

  it("does not ask inside stunUnits — the question comes a chain-pop later", () => {
    const { state, foe } = leonaState();

    const stunned = stunUnits(state, 0, [foe.instanceId]);

    expect(stunned.pendingDecisions, "the Legend resolved inline").toHaveLength(0);
    expect(penNames(stunned)).toContain(registry.get(LEONA_RADIANT_DAWN).name);
  });

  it("parks its buff question when the chain pops it", () => {
    const { state, foe } = leonaState();

    const settled = resolveHeldTriggers(stunUnits(state, 0, [foe.instanceId]));

    expect(pendingDecision(settled)?.kind).toBe("OGN-261-buff");
  });

  it("pays out ONCE for two enemies — 'one or more'", () => {
    // The whole reason `unitsStunned` is a batch event, and the distinction from
    // Eclipse Herald above. One Pending Item, one question.
    const { state } = leonaState();
    const second = makeUnit({ name: "Foe2" });
    state.battlefields[0]!.units["p2"] = [...state.battlefields[0]!.units["p2"]!, second];
    const ids = state.battlefields[0]!.units["p2"]!.map((u) => u.instanceId);

    const stunned = stunUnits(state, 0, ids);

    expect(penNames(stunned).filter((n) => n === registry.get(LEONA_RADIANT_DAWN).name)).toHaveLength(1);
  });

  it("is not PLACED for the opponent's stun, nor for stunning your own", () => {
    // Asserted on the PEN, not on `pendingDecisions`. Her body still re-checks
    // both conditions, so a Legend placed wrongly resolves to nothing and leaves
    // a board indistinguishable from one where she never triggered — which is
    // exactly what the pre-existing board-level version of this test could not
    // tell, and what a mutation of `applies` slipped past.
    const { state, foe } = leonaState();
    const mine = state.battlefields[0]!.units["p1"]![0]!;
    const name = registry.get(LEONA_RADIANT_DAWN).name;

    expect(penNames(stunUnits(state, 1, [foe.instanceId]))).not.toContain(name);
    expect(penNames(stunUnits(state, 0, [mine.instanceId]))).not.toContain(name);
  });
});

describe("Jinx - Rebel (OGN-202): when you discard one or more cards, ready me and +1 Might", () => {
  function jinxState(handSize = 2): { state: GameState; jinx: UnitInstance } {
    const jinx = { ...realUnitInstance(JINX_REBEL), exhausted: true } as UnitInstance;
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [jinx] };
    state.players[0]!.hand = Array.from({ length: handSize }, (_, i) => makeUnit({ name: `Card${i}` }));
    return { state, jinx };
  }

  const jinxAt = (state: GameState) => (state.battlefields[0]!.units["p1"] ?? [])[0]!;

  it("does not resolve inside discardCards — it waits on the chain", () => {
    const { state } = jinxState();
    // The card is NAMED, so this is a plain discard rather than a question — the
    // choosing path has its own test at the bottom of this describe.
    const discarded = discardCards(state, 0, 1, [state.players[0]!.hand[0]!.instanceId]);

    expect(discarded.players[0]!.trash, "the discard itself must still happen").toHaveLength(1);
    expect(jinxAt(discarded).exhausted, "she resolved inline").toBe(true);
    expect(penNames(discarded)).toContain(registry.get(JINX_REBEL).name);
  });

  it("readies and buffs when the chain pops it", () => {
    const { state } = jinxState();

    const settled = resolveHeldTriggers(discardCards(state, 0, 1, [state.players[0]!.hand[0]!.instanceId]));

    expect(jinxAt(settled).exhausted).toBe(false);
    expect(jinxAt(settled).mightThisTurn).toBe(1);
  });

  it("is not PLACED when the OPPONENT discards", () => {
    // "YOU discard" — Mindsplitter making the opponent discard must not ready
    // their Jinx. A fire-time condition, so it is asked before placing.
    const { state } = jinxState();
    state.players[1]!.hand = [makeUnit({ name: "Theirs" })];

    const discarded = discardCards(state, 1, 1);

    expect(penNames(discarded)).not.toContain(registry.get(JINX_REBEL).name);
  });

  it("pays out ONCE for a 'discard 2' answered one card at a time", () => {
    // The discard DECISION suppresses the event until the last card, so the
    // funnel sees one instruction. Holding must not undo that: two Pending Items
    // would ready her twice and give +2.
    // With more cards in hand than the count and none named, `discardCards`
    // parks the question rather than taking the front of hand.
    const { state } = jinxState(3);
    let current: GameState = discardCards(state, 0, 2);
    expect(pendingDecision(current)?.kind, "the discard never became a question").toBe("discard");

    for (let guard = 0; guard < 4; guard += 1) {
      const decision = pendingDecision(current);
      if (!decision) break;
      const answered = answerDecision(current, decision.id, optionsFor(current, decision)[0]!.id);
      if (!answered) throw new Error("the discard option was refused");
      current = answered;
    }

    const settled = resolveHeldTriggers(current);

    expect(settled.players[0]!.trash, "two cards should have gone").toHaveLength(2);
    expect(jinxAt(settled).mightThisTurn, "she paid out twice for one instruction").toBe(1);
    expect(heldNames(settled)).toEqual([]);
  });
});
