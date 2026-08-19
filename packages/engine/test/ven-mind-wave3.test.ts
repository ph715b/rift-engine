import { describe, expect, it } from "vitest";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { cardModeOf } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { eventTriggerFor } from "../src/engine/triggers.js";
import { answerDecision, optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { runDraw } from "../src/engine/turn-manager.js";
import {
  answerDecisions,
  makeState,
  makeUnit,
  realGearInstance,
  realUnitInstance,
  resolveHeldTriggers,
  spellInstance,
} from "./fixtures.js";

/**
 * **Vendetta's Mind cards — wave 3, the three that needed real mechanism.**
 *
 * `[Predict 5]` is a subset choice PLUS an ordering, and `effects/chaos.ts`'s bare
 * `[Predict]` says outright that the valued form "is not" built. Temporal Breach
 * is a blink to the SAME location rather than to base. Bottled Constellation
 * names a phase moment that no other card in 907 names.
 *
 * # What these tests are really guarding
 *
 * All three are QUEUE cards: they park questions that re-park themselves, and a
 * question that re-parks is the one place this engine can silently loop, drop a
 * card, or resolve against a board that moved. So the assertions are about the
 * queue's arithmetic — how many cards ended up where, in what order, and whether
 * anything was created or lost on the way.
 *
 * The card-count invariant does most of that work: five cards looked at must
 * still be five cards afterwards, wherever they ended up.
 */

const registry = defaultCardRegistry();

const CLAIRVOYANCE = "VEN-056";
const TEMPORAL_BREACH = "VEN-066";
const BOTTLED_CONSTELLATION = "VEN-067";
const A_SPELL = "OGN-004";
const A_GEAR = "OGN-017";

/** Five distinguishable cards on top of the deck, in a known order. */
function deckOf(n: number) {
  return Array.from({ length: n }, (_, i) => ({ ...spellInstance(A_SPELL), instanceId: `d${i}`, name: `Card ${i}` }));
}

const resolveSpell = (state: GameState, defId: string, casterIndex: 0 | 1, event: Record<string, unknown> = {}) =>
  cardModeOf(spellInstance(defId), undefined)!.resolve(state, contextFor(casterIndex, "src"), event as never);

const deckIds = (state: GameState, index: 0 | 1) => state.players[index]!.deck.map((c) => c.instanceId);

describe("Clairvoyance (VEN-056): the pool's first VALUED Predict", () => {
  function board(deckSize = 8): GameState {
    const state = makeState();
    state.players[0]!.deck = deckOf(deckSize);
    return state;
  }

  it("asks about the top FIVE", () => {
    const asked = resolveSpell(board(), CLAIRVOYANCE, 0);
    const question = pendingDecision(asked);

    expect(question?.kind).toBe("VEN-056-recycle");
    expect(question?.cardInstanceIds, "it looked at the wrong window").toEqual(["d0", "d1", "d2", "d3", "d4"]);
  });

  it("looks at what it HAS on a short deck (422)", () => {
    const asked = resolveSpell(board(3), CLAIRVOYANCE, 0);
    expect(pendingDecision(asked)?.cardInstanceIds).toEqual(["d0", "d1", "d2"]);
  });

  it("recycles the chosen cards to the BOTTOM and keeps the rest", () => {
    // Answered with a NON-default pick — Done is offered first, so the default
    // would recycle nothing and prove nothing.
    const asked = resolveSpell(board(), CLAIRVOYANCE, 0);
    const recycleD0ThenDone = (options: { id: string }[]) =>
      options.find((o) => o.id === "d0")?.id ?? options[0]!.id;

    const after = answerDecisions(asked, recycleD0ThenDone as never);
    const deck = deckIds(after, 0);

    expect(deck.at(-1), "the recycled card is not on the bottom").toBe("d0");
    // Eight in the deck, minus the two drawn at the end of the predict.
    expect(deck, "a card went missing").toHaveLength(6);
    expect(after.players[0]!.hand, "the draw did not happen").toHaveLength(2);
  });

  it("draws AFTER the predict, not before it", () => {
    // **The bug this pins is one the first draft shipped.** Parking the draw up
    // front to put it at the BACK of the queue does not work: `parkDecision` runs
    // `advanceDecisions`, and a `draw` question has exactly ONE option, so it
    // executed on the spot — two cards came off the top before the predict had
    // asked anything, and the looked-at window then named two cards that were no
    // longer in the deck.
    //
    // The observable consequence: the cards DRAWN must be ones the player had a
    // chance to order, so they come from the reordered top rather than from the
    // original top.
    const asked = resolveSpell(board(), CLAIRVOYANCE, 0);
    expect(asked.pendingDecisions.map((q) => q.kind), "the draw was queued up front").not.toContain("draw");

    // Recycle d0, keep the rest, then order them — the two drawn are whatever the
    // ordering put on top, and d0 (recycled to the bottom) can never be one.
    const after = answerDecisions(asked, (options) => options.find((o) => o.id === "d0")?.id ?? options[0]!.id);
    expect(after.players[0]!.hand.map((c) => c.instanceId), "a recycled card was drawn").not.toContain("d0");
  });

  it("keeps every card — nothing is created or lost, whatever is answered", () => {
    // The invariant that covers the whole queue. Five looked at, some recycled,
    // the rest reordered: the multiset of cards must be unchanged, and the two
    // DRAWN cards must come out of the same deck rather than from nowhere.
    const before = board();
    const asked = resolveSpell(before, CLAIRVOYANCE, 0);
    const after = answerDecisions(asked, (options) => options.at(-1)!.id);

    const all = [...deckIds(after, 0), ...after.players[0]!.hand.map((c) => c.instanceId)];
    expect(new Set(all), "the card set changed").toEqual(new Set(deckIds(before, 0)));
    expect(all.length, "a card was duplicated or dropped").toBe(8);
  });

  it("draws 2 — AFTER the predict, never from among the cards being ordered", () => {
    // "Predict 5. Draw 2" is sequential. The draw is parked at the BACK of the
    // queue so the ordering finishes first; a draw run inline could hand the
    // player a card they were still deciding the position of.
    const asked = resolveSpell(board(), CLAIRVOYANCE, 0);
    const after = answerDecisions(asked);

    expect(after.players[0]!.hand, "it did not draw 2").toHaveLength(2);
  });

  it("puts the survivors back in the ORDER the player chose", () => {
    // **The assertion that was missing, and a mutant walked through the gap.**
    // The first draft of this test checked only that the cards were all still
    // there — so an ordering step that moved NOTHING passed it untouched. An
    // ordering is only under test when a different answer produces a different
    // deck.
    //
    // Each answer places one card, and the placed cards stack UPWARD: the card
    // answered LAST ends up on top. Answering d0, d1, d2, d3, d4 in that order
    // therefore leaves d4 on top and d0 under the four placed after it — which is
    // the opposite of what a naive prepend-as-you-go would produce, and is what
    // the prompt describes.
    const asked = resolveSpell(board(), CLAIRVOYANCE, 0);
    const sequence = ["d0", "d1", "d2", "d3", "d4"];
    let nextPick = 0;
    const answered = answerDecisions(asked, (options, decision) => {
      if (decision.kind === "VEN-056-recycle") return "done";
      const wanted = sequence[nextPick];
      nextPick += 1;
      return options.find((o) => o.id === wanted)?.id ?? options[0]!.id;
    });

    // d4 and d3 were on top and are the two DRAWN; the rest sit in the order the
    // answers put them.
    expect(answered.players[0]!.hand.map((c) => c.instanceId), "the top two were not the last placed").toEqual([
      "d4",
      "d3",
    ]);
    expect(deckIds(answered, 0), "the deck is not in the chosen order").toEqual([
      "d2",
      "d1",
      "d0",
      "d5",
      "d6",
      "d7",
    ]);
  });

  it("is a [Reaction], which is what a 7-Energy draw spell is bought for", () => {
    expect(registry.get(CLAIRVOYANCE)).toMatchObject({ isReaction: true });
  });
});

describe("Temporal Breach (VEN-066): a blink to the SAME location", () => {
  it("returns a battlefield unit to THAT battlefield, fresh", () => {
    const state = makeState();
    const hurt = makeUnit({ damage: 3, buffed: true, mightThisTurn: 2, exhausted: true });
    state.battlefields[1]!.units = { p1: [hurt] };

    const after = resolveSpell(state, TEMPORAL_BREACH, 0, { targetUnitInstanceId: hurt.instanceId });
    const back = after.battlefields[1]!.units.p1!.find((u) => u.instanceId === hurt.instanceId);

    expect(back, "it did not come back to the same battlefield").toBeDefined();
    expect(after.battlefields[0]!.units.p1 ?? [], "it came back to the WRONG battlefield").toEqual([]);
    expect(after.players[0]!.baseUnits, "it came back to base instead").toEqual([]);
    // Leaving play is the point: 705 strips the Buff, damage and this-turn Might
    // belong to the body that left.
    expect(back!.damage).toBe(0);
    expect(back!.buffed).toBe(false);
    expect(back!.mightThisTurn).toBe(0);
  });

  it("returns a BASE unit to base", () => {
    const state = makeState();
    const home = makeUnit({ damage: 2 });
    state.players[0]!.baseUnits = [home];

    const after = resolveSpell(state, TEMPORAL_BREACH, 0, { targetUnitInstanceId: home.instanceId });

    expect(after.players[0]!.baseUnits.map((u) => u.instanceId)).toContain(home.instanceId);
    expect(after.players[0]!.baseUnits[0]!.damage).toBe(0);
  });

  it("hits EITHER side — 'a unit', bare", () => {
    // The difference from Portal Rescue, which prints "a FRIENDLY unit". Against
    // an enemy this is removal-by-reset rather than a rescue.
    const spec = cardModeOf(spellInstance(TEMPORAL_BREACH), undefined)!.targeting;
    expect(spec, "it was narrowed to friendly units").toMatchObject({ kind: "unit", scope: "anywhere" });
    expect((spec as { owner?: string }).owner, "an owner narrowing was added").toBeUndefined();

    const state = makeState();
    const theirs = makeUnit({ damage: 4, buffed: true });
    state.battlefields[0]!.units = { p2: [theirs] };

    const after = resolveSpell(state, TEMPORAL_BREACH, 0, { targetUnitInstanceId: theirs.instanceId });
    const back = after.battlefields[0]!.units.p2!.find((u) => u.instanceId === theirs.instanceId)!;
    expect(back.buffed, "an enemy's buff survived").toBe(false);
    expect(back.damage).toBe(0);
  });

  it("returns it to ITS OWNER, not to the caster", () => {
    const state = makeState();
    const theirs = makeUnit();
    state.players[1]!.baseUnits = [theirs];

    const after = resolveSpell(state, TEMPORAL_BREACH, 0, { targetUnitInstanceId: theirs.instanceId });

    expect(after.players[1]!.baseUnits.map((u) => u.instanceId), "it changed sides").toContain(theirs.instanceId);
    expect(after.players[0]!.baseUnits).toEqual([]);
  });
});

describe("Bottled Constellation (VEN-067): the pool's only Main Phase card", () => {
  function board(fodder: number): { state: GameState; bottle: ReturnType<typeof realGearInstance> } {
    const state = makeState({ phase: "Draw" });
    const bottle = realGearInstance(BOTTLED_CONSTELLATION);
    state.players[0]!.activeGear = [bottle];
    state.players[0]!.baseUnits = Array.from({ length: fodder }, () => makeUnit());
    state.players[0]!.deck = deckOf(3);
    return { state, bottle };
  }

  const trigger = () => eventTriggerFor(BOTTLED_CONSTELLATION)!;
  const listenerFor = (bottle: { instanceId: string }) => ({
    card: bottle,
    ownerIndex: 0 as const,
    defId: BOTTLED_CONSTELLATION,
  });
  const mainPhase = (playerIndex: 0 | 1) => ({ kind: "mainPhaseStarted" as const, playerIndex });

  it("fires at the start of the MAIN phase, which runDraw hands over to", () => {
    // The seam. `mainPhaseStarted` is a different moment from `beginningPhase`
    // three steps earlier, and this is the only card in 907 that can tell.
    const { state } = board(3);
    const after = resolveHeldTriggers(runDraw(state));

    expect(after.phase).toBe("Action");
    expect(pendingDecision(after)?.kind, "it did not ask at the start of the Main Phase").toBe("VEN-067-pick");
  });

  it("is not asked at all with fewer than three others (416.3)", () => {
    const { state, bottle } = board(2);
    expect(trigger().applies!(state, listenerFor(bottle) as never, mainPhase(0) as never)).toBe(false);

    const enough = board(3);
    expect(trigger().applies!(enough.state, listenerFor(enough.bottle) as never, mainPhase(0) as never)).toBe(true);
  });

  it("does not count ITSELF among the three", () => {
    // It is a gear, so without the "other" filter it would be its own third.
    const { state, bottle } = board(2);
    const options = trigger().applies!(state, listenerFor(bottle) as never, mainPhase(0) as never);
    expect(options, "the Constellation counted itself").toBe(false);
  });

  it("ignores the OPPONENT's Main Phase", () => {
    const { state, bottle } = board(3);
    expect(trigger().applies!(state, listenerFor(bottle) as never, mainPhase(1) as never)).toBe(false);
  });

  it("kills THREE and scores 1 when all three picks are made", () => {
    // Answered with the first NON-decline option each time — the default is the
    // decline, and answering with it would prove nothing.
    const { state } = board(3);
    const asked = resolveHeldTriggers(runDraw(state));
    const after = answerDecisions(asked, (options) => options[1]!.id);

    expect(after.players[0]!.baseUnits, "the three were not killed").toHaveLength(0);
    expect(after.players[0]!.points, "the point was not scored").toBe(1);
  });

  it("kills NOTHING after one or two picks — the cost is all-or-nothing", () => {
    // 355.10.c.1: the kills are the COST of the point. A resolver that killed as
    // the picks came in would leave a player two permanents down with no point if
    // the queue stopped, and no rule provides for that. Driven one answer at a
    // time through the real `answerDecision`.
    const { state } = board(3);
    let current = resolveHeldTriggers(runDraw(state));

    for (let picked = 1; picked <= 2; picked += 1) {
      const question = pendingDecision(current)!;
      expect(question.kind, `the queue ended after ${picked - 1} picks`).toBe("VEN-067-pick");
      const target = optionsFor(current, question).find((o) => o.id !== "decline")!;
      current = answerDecision(current, question.id, target.id)!;

      expect(current.players[0]!.baseUnits, `a unit died after ${picked} pick(s)`).toHaveLength(3);
      expect(current.players[0]!.points, `it scored after ${picked} pick(s)`).toBe(0);
      expect(pendingDecision(current)?.cardInstanceIds, "the picks were not accumulated").toHaveLength(picked);
    }
  });

  it("kills NOTHING when declined", () => {
    const { state } = board(3);
    const asked = resolveHeldTriggers(runDraw(state));
    const after = answerDecisions(asked);

    expect(after.players[0]!.baseUnits, "declining still killed").toHaveLength(3);
    expect(after.players[0]!.points).toBe(0);
  });

  it("can pay with GEAR as well as units", () => {
    const { state } = board(1);
    state.players[0]!.activeGear = [...state.players[0]!.activeGear, realGearInstance(A_GEAR), realGearInstance(A_GEAR)];

    const asked = resolveHeldTriggers(runDraw(state));
    const question = pendingDecision(asked);
    expect(question?.kind, "a board of two gear and a unit was not asked").toBe("VEN-067-pick");

    const offered = optionsFor(asked, question!).filter((o) => o.id !== "decline");
    expect(offered, "gear was not offered as fodder").toHaveLength(3);
  });
});

describe("coverage sees the wave", () => {
  it("all three report implemented", () => {
    for (const id of [CLAIRVOYANCE, TEMPORAL_BREACH, BOTTLED_CONSTELLATION]) {
      expect(isCardImplemented(registry.get(id)), `${id} ${registry.get(id).name} still reports unimplemented`).toBe(
        true,
      );
    }
  });
});
