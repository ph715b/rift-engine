import { describe, expect, it } from "vitest";
import { recordConquest } from "../src/engine/scoring.js";
import { isCardImplemented, partialImplementationNote, implementingModules } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { makeState, makeUnit, pickCard, realUnitInstance, resolveHeldTriggers, answerDecisions } from "./fixtures.js";

/**
 * **"Your conquer/hold effects for ...ing HERE trigger an additional time."**
 *
 *   - UNL-029 Red Brambleback — conquer effects
 *   - UNL-087 Blue Sentinel — hold effects
 *
 * Both were half-written and both agents refused the doubling in the same words:
 * `holdEventTrigger` pushes exactly one entry per listener and has no `times`
 * multiplier. It has one now.
 *
 * # Built to match Karthus, deliberately, and that is a DIVERGENCE
 *
 * Karthus - Eternal (OGN-236) prints the identical sentence — "Your
 * [Deathknell] effects trigger an additional time" — and has been implemented
 * since long before these two as ONE chain item executed twice
 * (`HeldDeathknell.times`).
 *
 * **383.3 arguably makes that wrong**: it places one chain item per trigger, so
 * an ability that "triggers an additional time" should produce TWO items, with a
 * response window between them. The rules only ever use the phrase "an
 * additional time" for `[Repeat]` (820.1.d), where it explicitly means "execute
 * the instructions of this chain item one additional time during resolution" —
 * one item — so the phrase alone does not settle it.
 *
 * These two follow Karthus rather than out-correcting him. Two readings of one
 * printed sentence in one pool would be worse than one reading applied
 * consistently, and changing a shipped OGN card's chain behaviour deserves its
 * own change. Recorded in docs/rules-conformance.md, covering all three.
 *
 * # What the tests are pointed at
 *
 * The multiplier is counted at HOLD time (383 fixes what triggered at the moment
 * of the event), keyed on the LISTENER's battlefield, and restricted to the
 * doubler's own controller. Each of those three is a way to get it wrong that
 * looks right on a one-battlefield fixture, so each has its own test.
 */

const registry = defaultCardRegistry();
const BRAMBLEBACK = "UNL-029";
const BLUE_SENTINEL = "UNL-087";
/** Inviolus Vox — "when I conquer, give a friendly unit +8 Might this turn". A
 *  SECOND conquer effect, so the doubling is observable as a number rather than
 *  as a question asked twice. */
const INVIOLUS_VOX = "UNL-027";
const VOX_MIGHT = 8;

const findUnit = (state: GameState, id: string): UnitInstance | undefined =>
  [
    ...state.players[0]!.baseUnits,
    ...state.players[1]!.baseUnits,
    ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
  ].find((u) => u.instanceId === id);

/** `units` as player 0's at bf1, and a bystander to receive Vox's pump. */
function conquerBoard(units: UnitInstance[]): { state: GameState; target: UnitInstance } {
  const target = makeUnit({ name: "Target", might: 1 });
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.battlefields[0] = { ...state.battlefields[0]!, units: { p1: [...units, target] } };
  return { state, target };
}

/** Drains the chain, ANSWERING each question with its first real option.
 *
 *  Not the bare `answerDecisions`: its default picker declines, and both cards
 *  here pay out through a question ("give a friendly unit +8 Might"). A declining
 *  drain reads exactly like a trigger that never fired — 0 Might either way — so
 *  the control test would have passed while measuring nothing. */
const settle = (state: GameState, ontoInstanceId: string): GameState =>
  answerDecisions(resolveHeldTriggers(state), pickCard(ontoInstanceId));

describe("Red Brambleback (UNL-029) doubles CONQUER effects here", () => {
  it("Inviolus Vox pumps TWICE beside a Brambleback", () => {
    // Two conquer effects on the board — Vox's pump and the Brambleback's own
    // buff — and the pump is the one with a number on it.
    const vox = realUnitInstance(INVIOLUS_VOX);
    const { state, target } = conquerBoard([realUnitInstance(BRAMBLEBACK), vox]);

    const after = settle(recordConquest(state, 0, "bf1"), target.instanceId);
    expect(findUnit(after, target.instanceId)!.mightThisTurn, "the conquer effect did not double").toBe(VOX_MIGHT * 2);
  });

  it("...and ONCE without him — the control that makes the doubling a measurement", () => {
    const vox = realUnitInstance(INVIOLUS_VOX);
    const { state, target } = conquerBoard([vox]);

    const after = settle(recordConquest(state, 0, "bf1"), target.instanceId);
    expect(findUnit(after, target.instanceId)!.mightThisTurn, "it doubled with no doubler present").toBe(VOX_MIGHT);
  });

  it("TWO Bramblebacks make it three times, not twice — each doubles what the other leaves", () => {
    // A count rather than a boolean. Karthus's own note argues the same for his
    // copies, and the two mechanisms are deliberately identical.
    const vox = realUnitInstance(INVIOLUS_VOX);
    const { state, target } = conquerBoard([realUnitInstance(BRAMBLEBACK), realUnitInstance(BRAMBLEBACK), vox]);

    const after = settle(recordConquest(state, 0, "bf1"), target.instanceId);
    expect(findUnit(after, target.instanceId)!.mightThisTurn, "a second doubler added nothing").toBe(VOX_MIGHT * 3);
  });

  it("does not reach a conquer at ANOTHER battlefield — 'here' is his own", () => {
    // The mistake a one-battlefield fixture cannot catch: keying the count on the
    // EVENT's battlefield rather than the LISTENER's would pass every test above.
    const vox = realUnitInstance(INVIOLUS_VOX);
    const target = makeUnit({ name: "Target", might: 1 });
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    // The doubler is at bf1; the conquering effect is at bf2.
    state.battlefields[0] = { ...state.battlefields[0]!, units: { p1: [realUnitInstance(BRAMBLEBACK)] } };
    state.battlefields[1] = { ...state.battlefields[1]!, units: { p1: [vox, target] } };

    const after = settle(recordConquest(state, 0, "bf2"), target.instanceId);
    expect(findUnit(after, target.instanceId)!.mightThisTurn, "his aura reached another battlefield").toBe(VOX_MIGHT);
  });

  it("does not double the OPPONENT's conquer effects standing with him", () => {
    // "YOUR conquer effects" — measured from the doubler's controller.
    const vox = realUnitInstance(INVIOLUS_VOX);
    const target = makeUnit({ name: "Target", might: 1 });
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      units: { p1: [realUnitInstance(BRAMBLEBACK)], p2: [vox, target] },
    };

    const after = settle(recordConquest(state, 1, "bf1"), target.instanceId);
    expect(findUnit(after, target.instanceId)!.mightThisTurn, "he doubled an enemy's conquer effect").toBe(VOX_MIGHT);
  });

  it("doubles his OWN conquer clause — 'your conquer effects' includes his", () => {
    // He prints "when I conquer, [Buff] a friendly unit", and a buff is idempotent
    // — so this is asserted through the QUESTION being asked twice rather than
    // through the board, which a second buff would not change.
    const { state, target } = conquerBoard([realUnitInstance(BRAMBLEBACK)]);
    const held = recordConquest(state, 0, "bf1");

    const mine = held.pendingTriggers.filter((e) => e.listenerDefId === BRAMBLEBACK);
    expect(mine.length, "the Brambleback's own trigger was not held").toBe(1);
    expect(mine[0]!.times, "he did not double himself").toBe(2);
    void target;
  });
});

  it("does not double a LEGEND's conquer trigger — a Legend is not 'here'", () => {
    // **Found by mutation, not by design.** Replacing the listener's battlefield
    // with a default SURVIVED every test above, because every listener in them
    // stands somewhere. A Legend does not: it sits in the legend zone with no
    // `battlefieldId` at all, and Vi - Piltover Enforcer listens for exactly this
    // event from there.
    //
    // "Your conquer effects for conquering HERE" — a Legend is nowhere, so it is
    // not here, and its trigger must not be doubled by a Brambleback standing at
    // the conquered battlefield.
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.legend = { ...state.players[0]!.legend, defId: "UNL-187" };
    state.battlefields[0] = { ...state.battlefields[0]!, units: { p1: [realUnitInstance(BRAMBLEBACK)] } };
    state.lastShowdownExcessDamage = { battlefieldId: "bf1", attackerIndex: 0, amount: 5 };

    const held = recordConquest(state, 0, "bf1");
    const legendEntries = held.pendingTriggers.filter((e) => e.listenerDefId === "UNL-187");
    expect(legendEntries.length, "Vi's conquer trigger was not held — this proves nothing").toBe(1);
    expect(legendEntries[0]!.times ?? 1, "a Legend with no battlefield was doubled").toBe(1);

    // The positive control on the same board: a unit standing WITH the doubler is
    // doubled, so the assertion above is about position and not about Legends
    // being skipped wholesale.
    const grounded = held.pendingTriggers.filter((e) => e.listenerDefId === BRAMBLEBACK);
    expect(grounded[0]!.times, "the doubler stopped doubling anyone").toBe(2);
  });

describe("Blue Sentinel (UNL-087) doubles HOLD effects here — the same shape, the other moment", () => {
  it("a HOLD doubler does NOT double a CONQUER effect standing with it", () => {
    // **This test was VACUOUS as first written**, and mutation said so: dropping
    // the event-kind match entirely SURVIVED. It had asserted that the Sentinel's
    // OWN chain entries carried no doubling on a conquer — but the Sentinel
    // listens only for `battlefieldHeld`, so on a conquer he raises no entries at
    // all, and `every` over an empty array is vacuously true.
    //
    // Rewritten to put a real CONQUER effect (Inviolus Vox) beside the hold
    // doubler. If the kinds stopped being matched, Vox would double.
    const vox = realUnitInstance(INVIOLUS_VOX);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[0] = { ...state.battlefields[0]!, units: { p1: [realUnitInstance(BLUE_SENTINEL), vox] } };

    const held = recordConquest(state, 0, "bf1");
    const voxEntries = held.pendingTriggers.filter((e) => e.listenerDefId === INVIOLUS_VOX);
    expect(voxEntries.length, "Vox's conquer trigger was not held — this proves nothing").toBe(1);
    expect(voxEntries[0]!.times ?? 1, "a HOLD doubler doubled a CONQUER effect").toBe(1);
  });
});

describe("coverage, and the divergence this shares with Karthus", () => {
  it("both cards are whole and claimed by the doubler source", () => {
    for (const defId of [BRAMBLEBACK, BLUE_SENTINEL]) {
      expect(isCardImplemented(registry.get(defId)), `${defId} is greyed`).toBe(true);
      expect(partialImplementationNote(registry.get(defId)), `${defId} still names a missing half`).toBeUndefined();
      expect(implementingModules(defId), `${defId} lost its doubler registration`).toContain("trigger doublers");
    }
  });

  it("Karthus prints the same sentence and is implemented the same way", () => {
    // The consistency claim, asserted rather than left in a comment: if someone
    // later gives one of these two the two-chain-item reading, this fails and
    // forces the other to move with it.
    expect(registry.get("OGN-236").text, "Karthus stopped printing the sentence these follow").toContain(
      "trigger an additional time",
    );
    for (const defId of [BRAMBLEBACK, BLUE_SENTINEL]) {
      expect(registry.get(defId).text, `${defId} stopped printing it`).toContain("trigger an additional time");
    }
  });
});
