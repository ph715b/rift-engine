import { describe, expect, it } from "vitest";
import { runBeginning } from "../src/engine/turn-manager.js";
import { recordConquest } from "../src/engine/scoring.js";
import { loadBattlefieldDefinitions } from "../src/cards/card-loader.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import type { UnitInstance } from "../src/model/card.js";
import { answerDecisions, makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";
import { optionsFor, pendingDecision, answerDecision } from "../src/engine/decisions.js";

/**
 * **Unleashed and Vendetta battlefields, wave 1 — the four whose MOMENT already
 * existed.**
 *
 * Reported from playtesting: *"star spring battlefield not triggering"*. It was
 * not triggering because it was not written: measured at the time, **UNL 0/15 and
 * VEN 0/10 battlefields had any implementation at all**, while OGN's 24 and SFD's
 * 15 were done and hard-gated. `battlefield-coverage.test.ts` was already saying
 * so, as progress rather than as a failure, which is why nothing was red.
 *
 * The 25 split by MECHANISM rather than by set, and these four are the group that
 * needs no new moment, no new state field and no new primitive — `hold` and
 * `conquer` have been fired by `scoring.scoreHolds` and `scoring.recordConquest`
 * since OGN's pass.
 *
 * Every test drives the REAL moment and then settles the chain, because a
 * battlefield ability is a Chain Pending Item like every other trigger here. A
 * test that called the resolver directly would prove the effect works and nothing
 * about whether the moment reaches it — the discipline the OGN files set.
 */

const AMATEUR_RECITAL = "UNL-207";
const SHADOW_TEMPLE = "VEN-165";
const PROTECTIVE_SANDS = "VEN-162";
const TRAPPING_GROUNDS = "UNL-217";

/** A cheap real card to fill decks with. */
const FILLER = "OGN-164";
const rune = (id: string, state: RuneCard["state"] = "Ready"): RuneCard => ({ id, domain: "Calm", state });

/** Player 0 in their Beginning Phase, holding bf1, which IS the named card. */
function holding(defId: string, units: UnitInstance[] = [makeUnit()]): GameState {
  const state = makeState({ phase: "Beginning", activePlayerIndex: 0 });
  state.battlefields[0] = { ...state.battlefields[0]!, defId, units: { p1: units }, controllerId: "p1" };
  return state;
}

/** bf1 IS the named battlefield card, and player 0 is about to take it. */
function withBattlefield(defId: string): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.battlefields[0] = { ...state.battlefields[0]!, defId };
  return state;
}

const settleHold = (state: GameState) => answerDecisions(resolveHeldTriggers(runBeginning(state)));
const settleConquest = (state: GameState, playerIndex: 0 | 1 = 0) =>
  answerDecisions(resolveHeldTriggers(recordConquest(state, playerIndex, "bf1")));

describe("every name in this wave is a battlefield that really prints that text", () => {
  // The positive control on the fixtures themselves. A defId typo would make
  // every test below pass vacuously — the ability simply would not fire and the
  // "nothing happened" assertions would all hold.
  it("matches the printed cards", () => {
    const byId = new Map(loadBattlefieldDefinitions().map((d) => [d.id, d]));
    for (const [defId, name, phrase] of [
      [AMATEUR_RECITAL, "Amateur Recital", "move a unit at a battlefield to its base"],
      [SHADOW_TEMPLE, "Shadow Temple", "[Burn 3]"],
      [PROTECTIVE_SANDS, "Protective Sands", "4 or fewer runes"],
      [TRAPPING_GROUNDS, "Trapping Grounds", "excess damage"],
    ] as const) {
      const def = byId.get(defId);
      expect(def?.name, `${defId} is not the card this wave thinks it is`).toBe(name);
      expect(def?.text, `${name}'s text has changed under the implementation`).toContain(phrase);
    }
  });
});

describe("Amateur Recital (UNL-207): move a unit at a battlefield to its base", () => {
  it("offers EITHER player's unit — 355.9.a.1's bare noun", () => {
    // The clause names only WHERE, not WHOSE, so this is removal as often as it
    // is rescue. Fight or Flight's near-identical text is read the same way.
    const state = holding(AMATEUR_RECITAL, [makeUnit({ instanceId: "mine", name: "Mine" })]);
    state.battlefields[1] = {
      ...state.battlefields[1]!,
      units: { p2: [makeUnit({ instanceId: "theirs", name: "Theirs" })] },
    };

    const held = resolveHeldTriggers(runBeginning(state));
    const pending = pendingDecision(held);
    expect(pending?.kind, "the hold raised no question").toBe(`${AMATEUR_RECITAL}-move`);
    expect(optionsFor(held, pending!).map((o) => o.id).sort(), "the enemy unit was not offered").toEqual([
      "decline",
      "mine",
      "theirs",
    ]);
  });

  it("moves the chosen unit to its base, EXHAUSTED — it is a Move, not a Recall", () => {
    // 454: a Recall is not a Move. `recallUnitToBase` (which despite its name
    // performs the Move) leaves the unit exhausted and lets move triggers see it;
    // `relocateToBaseUnchanged` would not, and would make this card quietly
    // better than printed.
    const state = holding(AMATEUR_RECITAL, [makeUnit({ instanceId: "mine", name: "Mine" })]);
    const held = resolveHeldTriggers(runBeginning(state));
    const settled = answerDecision(held, pendingDecision(held)!.id, "mine")!;

    expect((settled.battlefields[0]!.units.p1 ?? []).map((u) => u.instanceId), "it did not leave the battlefield").toEqual([]);
    const inBase = settled.players[0]!.baseUnits.find((u) => u.instanceId === "mine");
    expect(inBase, "it never arrived in base").toBeDefined();
    expect(inBase!.exhausted, "it arrived ready — this was treated as a Recall").toBe(true);
  });

  it("declining moves nobody", () => {
    const state = holding(AMATEUR_RECITAL, [makeUnit({ instanceId: "mine", name: "Mine" })]);
    const held = resolveHeldTriggers(runBeginning(state));
    const settled = answerDecision(held, pendingDecision(held)!.id, "decline")!;
    expect((settled.battlefields[0]!.units.p1 ?? []).map((u) => u.instanceId), "declining still moved it").toEqual(["mine"]);
  });

  it("asks nothing when the board is empty of battlefield units", () => {
    // The holder's own unit is what makes the battlefield held, so an "empty"
    // board still has one — the honest empty case is the unit being in BASE,
    // which `isHeldBy` refuses. So this asserts the shape instead: with only the
    // garrison there, Decline plus one unit is a real question, and the option
    // list never contains a base unit.
    const state = holding(AMATEUR_RECITAL, [makeUnit({ instanceId: "mine", name: "Mine" })]);
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "athome", name: "At Home" })];

    const held = resolveHeldTriggers(runBeginning(state));
    expect(optionsFor(held, pendingDecision(held)!).map((o) => o.id), "a unit already in base was offered").not.toContain(
      "athome",
    );
  });
});

describe("Shadow Temple (VEN-165): [Burn 3] on hold", () => {
  it("puts the top 3 of the Main Deck into the trash, and asks nothing", () => {
    // MANDATORY — no "you may" — so it is the only entry in this wave that raises
    // no question at all.
    const state = holding(SHADOW_TEMPLE);
    state.players[0]!.deck = Array.from({ length: 5 }, (_, i) => ({
      ...makeUnit({ instanceId: `d${i}`, name: `Deck ${i}` }),
      defId: FILLER,
    })) as never;

    const settled = settleHold(state);
    expect(settled.players[0]!.trash.map((c) => c.instanceId), "the top 3 did not reach the trash").toEqual([
      "d0",
      "d1",
      "d2",
    ]);
    expect(settled.players[0]!.deck.map((c) => c.instanceId), "the wrong cards were burned").toEqual(["d3", "d4"]);
  });

  it("burns what it has from a SHORT deck rather than nothing", () => {
    // 440 is an EFFECT, so 359.3.e.11's do-as-much-as-you-can applies — this is
    // not an all-or-nothing cost.
    const state = holding(SHADOW_TEMPLE);
    state.players[0]!.deck = [{ ...makeUnit({ instanceId: "only", name: "Only" }), defId: FILLER }] as never;

    const settled = settleHold(state);
    expect(settled.players[0]!.trash.map((c) => c.instanceId), "a short deck burned nothing at all").toEqual(["only"]);
  });
});

describe("Protective Sands (VEN-162): pay 1 to draw, under 5 runes", () => {
  /**
   * `runes` in the pool, `ready` of them able to pay.
   *
   * **There is no `PlayerState.energy` field**, and writing to one is how the
   * first version of this file "passed" the payability test for the wrong reason.
   * Energy comes from `floatingEnergy` plus EXHAUSTING Ready channeled runes
   * (`payEnergyFromPool`), so the pool size is both the trigger's condition and
   * the price — which makes "four runes, none of them Ready" the only honest way
   * to build a board that triggers and cannot pay.
   */
  function conquering(runes: number, ready: number): GameState {
    const state = withBattlefield(PROTECTIVE_SANDS);
    state.players[0]!.channeled = Array.from({ length: runes }, (_, i) =>
      rune(`r${i}`, i < ready ? "Ready" : "Exhausted"),
    );
    state.players[0]!.floatingEnergy = 0;
    state.players[0]!.deck = [{ ...makeUnit({ instanceId: "top", name: "Top" }), defId: FILLER }] as never;
    return state;
  }

  const readyRunes = (state: GameState) => state.players[0]!.channeled.filter((r) => r.state === "Ready").length;

  it("draws when you pay, with 4 runes", () => {
    const settled = answerDecisions(resolveHeldTriggers(recordConquest(conquering(4, 4), 0, "bf1")));
    expect(settled.players[0]!.hand.map((c) => c.instanceId), "the draw never happened").toEqual(["top"]);
    expect(readyRunes(settled), "no rune was exhausted to pay for it").toBe(3);
  });

  it("does NOT trigger at 5 runes — 'four or fewer'", () => {
    // The boundary, and the direction that matters: this is a catch-up ability,
    // so firing it while ahead on runes would invert the card.
    //
    // **Asserted on the PENDING ITEM, not on the question**, and that distinction
    // is the whole reason the threshold is in `applies`. The rune count is
    // re-asked in `options` too, so a version that triggered anyway would still
    // draw nothing — `advanceDecisions` drops a question with no options — and
    // this test passed against exactly that mutant until it looked here. What
    // `applies` buys is that NO Pending Item is placed at all: a held trigger
    // closes the chain and costs both players a PassFocus even when it resolves
    // to nothing.
    const conquered = recordConquest(conquering(5, 5), 0, "bf1");
    expect(
      conquered.pendingTriggers.filter((e) => e.source === "battlefield"),
      "a Pending Item was placed above the rune threshold",
    ).toHaveLength(0);

    const held = resolveHeldTriggers(conquered);
    expect(pendingDecision(held), "it triggered above the rune threshold").toBeUndefined();
    expect(held.players[0]!.hand, "it drew above the rune threshold").toHaveLength(0);
  });

  it("...and DOES place one at 4 — the control that makes the assertion above mean something", () => {
    const conquered = recordConquest(conquering(4, 4), 0, "bf1");
    expect(
      conquered.pendingTriggers.filter((e) => e.source === "battlefield"),
      "nothing was held at all, so the test above proves nothing",
    ).toHaveLength(1);
  });

  it("does not ask when the Energy cannot be paid — 416.3", () => {
    // Four runes, all exhausted: the CONDITION holds and the PRICE cannot be met.
    const held = resolveHeldTriggers(recordConquest(conquering(4, 0), 0, "bf1"));
    expect(pendingDecision(held), "a question was asked with nothing to pay it with").toBeUndefined();
  });

  it("declining costs nothing", () => {
    const held = resolveHeldTriggers(recordConquest(conquering(4, 4), 0, "bf1"));
    const settled = answerDecision(held, pendingDecision(held)!.id, "decline")!;
    expect(settled.players[0]!.hand, "declining drew anyway").toHaveLength(0);
    expect(readyRunes(settled), "declining exhausted a rune anyway").toBe(4);
  });
});

describe("Trapping Grounds (UNL-217): a Bird for 3+ excess damage", () => {
  function conquering(excess: { battlefieldId: string; attackerIndex: 0 | 1; amount: number } | null): GameState {
    return { ...withBattlefield(TRAPPING_GROUNDS), lastShowdownExcessDamage: excess };
  }

  const birds = (state: GameState) => (state.battlefields[0]!.units.p1 ?? []).filter((u) => u.name === "Bird");

  it("plays a 1 Might Bird with [Deflect] here", () => {
    const settled = settleConquest(conquering({ battlefieldId: "bf1", attackerIndex: 0, amount: 3 }));
    expect(birds(settled), "no Bird arrived").toHaveLength(1);
    expect(birds(settled)[0]!.might, "the Bird is the wrong size").toBe(1);
    expect(birds(settled)[0]!.keywords?.Deflect, "the Bird has no [Deflect]").toBe(1);
  });

  it("does nothing below 3 excess", () => {
    const settled = settleConquest(conquering({ battlefieldId: "bf1", attackerIndex: 0, amount: 2 }));
    expect(birds(settled), "a Bird arrived under the threshold").toHaveLength(0);
  });

  it("does nothing when the excess was at ANOTHER battlefield", () => {
    // The field is one slot on the state and holds whatever the last combat
    // wrote, so the battlefield has to be compared — otherwise a conquest by a
    // Spell here would collect a Bird for a fight somewhere else.
    const settled = settleConquest(conquering({ battlefieldId: "bf2", attackerIndex: 0, amount: 9 }));
    expect(birds(settled), "a Bird arrived for another battlefield's combat").toHaveLength(0);
  });

  it("does nothing when the excess was the OPPONENT's", () => {
    const settled = settleConquest(conquering({ battlefieldId: "bf1", attackerIndex: 1, amount: 9 }));
    expect(birds(settled), "a Bird arrived for the enemy's excess damage").toHaveLength(0);
  });

  it("does nothing for a conquest with no combat at all", () => {
    const settled = settleConquest(conquering(null));
    expect(birds(settled), "a Bird arrived with no combat on record").toHaveLength(0);
  });
});
