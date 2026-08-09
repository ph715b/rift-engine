import { describe, expect, it } from "vitest";
import { cardModeOf } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { addBuff, discardCards, payPowerFromChanneled } from "../src/engine/effect-helpers.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance, type UnitInstance } from "../src/model/card.js";
import type { Domain } from "../src/model/domain.js";
import type { GameState } from "../src/model/game-state.js";
import { answerDecisions, makePlayer, makeState, makeUnit, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * The three cards that needed the engine to be able to stop and ask.
 *
 * Two of them ask off a TRIGGER, which has no action to carry a choice on; the
 * third asks the OPPONENT. Those are the two shapes the fan-out-onto-the-action
 * approach cannot express at all, which is why these three were the last cards
 * in the presets left inert for a structural reason rather than a small one.
 */

const registry = defaultCardRegistry();
const FLAME_CHOMPERS = "OGN-006"; // Fury, 3 Energy / 3 Might
const MISTFALL = "OGN-152"; // Body gear
const CULL_THE_WEAK = "OGN-209"; // Order spell
const unit = (defId: string) => createCardInstance(registry.get(defId)) as UnitInstance;
const gear = (defId: string) => createCardInstance(registry.get(defId)) as GearInstance;

/** `count` Ready runes of one domain. */
const runes = (domain: Domain, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

/** The answer whose id is `optionId`, when it is on offer. */
const hasOption = (state: GameState, optionId: string) =>
  optionsFor(state, pendingDecision(state)!).some((o) => o.id === optionId);

describe("Flame Chompers (OGN-006): when you discard me, you may pay [Fury] to play me", () => {
  /** Chompers plus one other card in hand, so the discard is a real choice. */
  function chompersState(furyRunes: number): { state: GameState; chompers: UnitInstance } {
    const chompers = unit(FLAME_CHOMPERS);
    const state = makeState({
      phase: "Action",
      players: [
        makePlayer("p1", { hand: [chompers, makeUnit()], channeled: runes("Fury", furyRunes) }),
        makePlayer("p2"),
      ],
    });
    return { state, chompers };
  }

  it("offers the play once it has been discarded, from the trash", () => {
    const { state, chompers } = chompersState(2);

    // answerDecisions answers the discard AND would answer this, so stop short:
    // discard by hand and inspect the question that follows.
    const afterDiscard = resolveHeldTriggers(discardCards(state, 0, 1, [chompers.instanceId]));

    expect(afterDiscard.players[0]!.trash.map((c) => c.defId)).toEqual([FLAME_CHOMPERS]);
    expect(pendingDecision(afterDiscard)!.kind).toBe("OGN-006-play");
    expect(hasOption(afterDiscard, "decline")).toBe(true);
    expect(hasOption(afterDiscard, "play")).toBe(true);
  });

  it("declining leaves it in the trash and spends nothing", () => {
    const { state, chompers } = chompersState(2);
    const asked = resolveHeldTriggers(discardCards(state, 0, 1, [chompers.instanceId]));

    const after = answerDecisions(asked, () => "decline");

    expect(after.players[0]!.trash.map((c) => c.defId)).toEqual([FLAME_CHOMPERS]);
    expect(after.players[0]!.baseUnits).toHaveLength(0);
    expect(after.players[0]!.channeled).toHaveLength(2); // the Power was never paid
  });

  it("paying puts it into play from the trash, exhausted (143.4.a)", () => {
    const { state, chompers } = chompersState(2);
    const asked = resolveHeldTriggers(discardCards(state, 0, 1, [chompers.instanceId]));

    const after = answerDecisions(asked, () => "play");

    expect(after.players[0]!.trash).toHaveLength(0);
    const inPlay = after.players[0]!.baseUnits;
    expect(inPlay.map((u) => u.defId)).toEqual([FLAME_CHOMPERS]);
    expect(inPlay[0]!.exhausted).toBe(true);
    // One rune recycled for the Power, banking the Energy it no longer gets to pay.
    expect(after.players[0]!.channeled).toHaveLength(1);
    expect(after.players[0]!.floatingEnergy).toBe(1);
  });

  it("does not charge the printed 3 Energy — the text replaces the cost", () => {
    const { state, chompers } = chompersState(2);
    state.players[0]!.floatingEnergy = 3;
    const asked = resolveHeldTriggers(discardCards(state, 0, 1, [chompers.instanceId]));

    const after = answerDecisions(asked, () => "play");

    expect(after.players[0]!.baseUnits).toHaveLength(1);
    expect(after.players[0]!.floatingEnergy).toBe(3 + 1); // untouched, plus the recycle credit
  });

  it("asks nothing at all with no Fury Power to pay", () => {
    // 416.3's shape: a cost that cannot be completed is not one you may choose.
    // With the play unavailable only the decline is left, and a question with one
    // answer is not a question — so the player is never interrupted to be told
    // they cannot afford something.
    const { state, chompers } = chompersState(0);

    const after = discardCards(state, 0, 1, [chompers.instanceId]);

    expect(after.pendingDecisions).toHaveLength(0);
    expect(after.players[0]!.trash.map((c) => c.defId)).toEqual([FLAME_CHOMPERS]);
    expect(after.players[0]!.baseUnits).toHaveLength(0);
  });

  it("asks per copy when two are discarded together", () => {
    const first = unit(FLAME_CHOMPERS);
    const second = unit(FLAME_CHOMPERS);
    const state = makeState({
      phase: "Action",
      players: [makePlayer("p1", { hand: [first, second], channeled: runes("Fury", 4) }), makePlayer("p2")],
    });

    // Two in hand and "discard 2" is not a choice, so both go at once — and each
    // gets its own offer, because the trigger is keyed to the card, not the act.
    //
    // **They arrive ONE AT A TIME now**, and that is the conversion rather than a
    // regression: each copy places its own Pending Item, the chain resolves LIFO
    // one entry per pass, and a parked question stops the settle. Before, both
    // fired inside the discard and both sat in the queue together. The claim the
    // test is making — one offer per copy — is unchanged; when they are asked is.
    const firstOffer = resolveHeldTriggers(discardCards(state, 0, 2));
    expect(firstOffer.pendingDecisions.filter((d) => d.kind === "OGN-006-play")).toHaveLength(1);

    const secondOffer = resolveHeldTriggers(answerDecisions(firstOffer, () => "play"));
    expect(secondOffer.pendingDecisions.filter((d) => d.kind === "OGN-006-play"), "the second copy never asked").toHaveLength(1);

    const after = answerDecisions(secondOffer, () => "play");
    expect(after.players[0]!.baseUnits).toHaveLength(2);
  });
});

describe("Mistfall (OGN-152): when you buff a friendly unit, you may pay [Body] and exhaust this to ready it", () => {
  function mistfallState(bodyRunes = 2): { state: GameState; mistfall: GearInstance; ally: UnitInstance } {
    const mistfall = gear(MISTFALL);
    const ally = makeUnit({ name: "Ally" });
    ally.exhausted = true;
    const state = makeState({
      players: [makePlayer("p1", { activeGear: [mistfall], channeled: runes("Body", bodyRunes) }), makePlayer("p2")],
    });
    state.players[0]!.baseUnits = [ally];
    return { state, mistfall, ally };
  }

  it("waits on the chain as a Pending Item before it asks (808.1.d.3)", () => {
    // The buff lands immediately; the TRIGGER does not. It is held, finalized onto
    // the chain by the Cleanup, and only resolves once both players have passed —
    // which is the response window this conversion exists to create.
    const { state, ally } = mistfallState();

    const buffed = addBuff(state, ally.instanceId);

    expect(buffed.players[0]!.baseUnits[0]!.buffed).toBe(true); // the buff is not deferred
    expect(buffed.pendingTriggers).toHaveLength(1); // the trigger is
    expect(buffed.pendingTriggers[0]!.listenerDefId).toBe(MISTFALL);
    expect(buffed.pendingDecisions).toHaveLength(0); // nothing asked yet

    const onChain = runCleanup(buffed);
    expect(onChain.pendingTriggers).toHaveLength(0); // finalized...
    expect(onChain.spellChain).toHaveLength(1); // ...onto the chain
    expect(onChain.chainOpen).toBe(false); // which closes it, so PassFocus is the move
    expect(onChain.chainOpenedByTrigger).toBe(true); // 347: Focus will not pass when it empties
  });

  it("asks when a friendly unit is buffed", () => {
    const { state, ally } = mistfallState();

    const asked = resolveHeldTriggers(addBuff(state, ally.instanceId));

    expect(pendingDecision(asked)!.kind).toBe("OGN-152-ready");
    expect(hasOption(asked, "pay")).toBe(true);
    expect(hasOption(asked, "decline")).toBe(true);
  });

  it("paying readies the unit, exhausts Mistfall and spends the Power", () => {
    const { state, ally } = mistfallState();

    const after = answerDecisions(resolveHeldTriggers(addBuff(state, ally.instanceId)), () => "pay");

    expect(after.players[0]!.baseUnits[0]!.exhausted).toBe(false);
    expect(after.players[0]!.baseUnits[0]!.buffed).toBe(true);
    expect(after.players[0]!.activeGear[0]!.exhausted).toBe(true);
    expect(after.players[0]!.channeled).toHaveLength(1);
  });

  it("declining leaves everything as it was but for the buff", () => {
    const { state, ally } = mistfallState();

    const after = answerDecisions(resolveHeldTriggers(addBuff(state, ally.instanceId)), () => "decline");

    expect(after.players[0]!.baseUnits[0]!.exhausted).toBe(true);
    expect(after.players[0]!.baseUnits[0]!.buffed).toBe(true);
    expect(after.players[0]!.activeGear[0]!.exhausted).toBe(false);
    expect(after.players[0]!.channeled).toHaveLength(2);
  });

  it("does NOT fire on re-buffing an already-buffed unit (702.3.a)", () => {
    // "If a Buff is added on a Unit that already has a Buff, it is not placed
    // instead" — so nothing was buffed, and there is nothing to trigger on.
    // Without this, a buff-heavy board would offer the same question forever.
    // Each negative below asserts NOTHING WAS HELD as well as nothing asked. Now
    // that the trigger is deferred, checking `pendingDecisions` alone would pass for
    // the wrong reason — no question is outstanding immediately after ANY buff — so
    // these would go green even if the trigger fired when it must not.
    const { state, ally } = mistfallState();
    const once = answerDecisions(resolveHeldTriggers(addBuff(state, ally.instanceId)), () => "decline");

    const twice = addBuff(once, ally.instanceId);

    expect(twice.pendingTriggers).toHaveLength(0);
    expect(resolveHeldTriggers(twice).pendingDecisions).toHaveLength(0);
  });

  it("does not fire for the OPPONENT's unit being buffed", () => {
    // "A FRIENDLY unit" is measured against Mistfall's controller.
    const { state } = mistfallState();
    const theirs = makeUnit({ name: "Theirs" });
    state.players[1]!.baseUnits = [theirs];

    const buffed = addBuff(state, theirs.instanceId);
    expect(buffed.pendingTriggers).toHaveLength(0);
    expect(resolveHeldTriggers(buffed).pendingDecisions).toHaveLength(0);
  });

  it("offers nothing to pay with when Mistfall is already exhausted", () => {
    const { state, ally } = mistfallState();
    state.players[0]!.activeGear[0]!.exhausted = true;

    // Mistfall still TRIGGERS — being unable to pay is a resolution-time question
    // (its options come out empty and advanceDecisions drops it as moot), not a
    // reason not to trigger. So the assertion is about what is ASKED, after resolving.
    expect(resolveHeldTriggers(addBuff(state, ally.instanceId)).pendingDecisions).toHaveLength(0);
  });

  it("offers only the decline with no Body Power", () => {
    const { state, ally } = mistfallState(0);
    const asked = resolveHeldTriggers(addBuff(state, ally.instanceId));
    // One option left, so it is not a question at all and never reaches the queue.
    expect(asked.pendingDecisions).toHaveLength(0);
    expect(asked.players[0]!.baseUnits[0]!.exhausted).toBe(true); // declined by default
  });
});

describe("Cull the Weak (OGN-209): each player kills one of their units", () => {
  function cullState(mine: string[], theirs: string[]): GameState {
    const state = makeState({ phase: "Action", players: [makePlayer("p1"), makePlayer("p2")] });
    state.players[0]!.baseUnits = mine.map((name) => makeUnit({ name }));
    state.players[1]!.baseUnits = theirs.map((name) => makeUnit({ name }));
    return state;
  }

  const resolveCull = (state: GameState) =>
    cardModeOf(spellInstance(CULL_THE_WEAK), undefined)!.resolve(state, contextFor(0), {});

  it("asks each player about their OWN units, in APNAP order", () => {
    const state = cullState(["A1", "A2"], ["B1", "B2"]);

    const asked = resolveCull(state);

    expect(asked.pendingDecisions.map((d) => d.playerIndex)).toEqual([0, 1]); // active player first
    expect(optionsFor(asked, asked.pendingDecisions[0]!).map((o) => o.label)).toEqual(["A1", "A2"]);
  });

  it("kills the unit each player named, and only that one", () => {
    const state = cullState(["A1", "A2"], ["B1", "B2"]);

    const after = answerDecisions(resolveCull(state), (options) => options[1]!.id);

    expect(after.players[0]!.baseUnits.map((u) => u.name)).toEqual(["A1"]);
    expect(after.players[1]!.baseUnits.map((u) => u.name)).toEqual(["B1"]);
    expect(after.players[0]!.trash.map((c) => c.name)).toEqual(["A2"]);
    expect(after.players[1]!.trash.map((c) => c.name)).toEqual(["B2"]);
  });

  it("skips a player with no units, and asks nothing of a player with one", () => {
    // Two different reasons not to ask, and both must still kill correctly.
    const state = cullState(["Only"], []);

    const after = resolveCull(state);

    expect(after.pendingDecisions).toHaveLength(0);
    expect(after.players[0]!.baseUnits).toHaveLength(0);
    expect(after.players[0]!.trash.map((c) => c.name)).toEqual(["Only"]);
  });

  it("reaches units at battlefields as well as in base", () => {
    // "One of their units" names no battlefield — 355.9.b, the bare noun means
    // objects on the Board, and Bases are Public.
    const state = cullState([], []);
    const atBattlefield = makeUnit({ name: "Forward" });
    state.battlefields[0]!.units = { p1: [atBattlefield] };

    const after = resolveCull(state);

    expect(after.battlefields[0]!.units["p1"]).toHaveLength(0);
  });

  it("asks a second time about a board the first answer changed", () => {
    // The options are rebuilt when the question reaches the front, not captured
    // when it was raised — so a unit killed by the first answer can never be
    // offered to the second.
    const state = cullState(["A1"], ["B1", "B2"]);

    const asked = resolveCull(state);
    // Player 0 has exactly one unit, so their question resolved without asking.
    expect(asked.pendingDecisions.map((d) => d.playerIndex)).toEqual([1]);
    expect(asked.players[0]!.baseUnits).toHaveLength(0);
  });
});

describe("payPowerFromChanneled", () => {
  it("recycles the rune and banks the Energy a Ready rune no longer gets to pay", () => {
    const state = makeState({ players: [makePlayer("p1", { channeled: runes("Fury", 2) }), makePlayer("p2")] });

    const after = payPowerFromChanneled(state, 0, "Fury", 1)!;

    expect(after.players[0]!.channeled).toHaveLength(1);
    expect(after.players[0]!.runeDeck).toHaveLength(1); // 416: to the bottom of the deck
    expect(after.players[0]!.floatingEnergy).toBe(1);
  });

  it("returns undefined rather than a free ride when the domain is short", () => {
    const state = makeState({ players: [makePlayer("p1", { channeled: runes("Body", 3) }), makePlayer("p2")] });
    expect(payPowerFromChanneled(state, 0, "Fury", 1)).toBeUndefined();
  });
});

describe("coverage counts all three", () => {
  it("reports them as implemented", () => {
    for (const id of [FLAME_CHOMPERS, MISTFALL, CULL_THE_WEAK]) {
      expect(isCardImplemented(registry.get(id)), `${id} (${registry.get(id).name})`).toBe(true);
    }
  });
});
