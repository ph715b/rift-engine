import { describe, expect, it } from "vitest";
import { effectForCard, cardModeOf } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { addBuff } from "../src/engine/effect-helpers.js";
import { runBeginning, runEnd } from "../src/engine/turn-manager.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit, spellInstance } from "./fixtures.js";

/**
 * The five `[Hidden]` cards' own effects. The keyword itself is
 * test/hidden.test.ts; this is what each card DOES once it resolves, whether it
 * was played from hand for full price or from facedown for nothing.
 */

const registry = defaultCardRegistry();
const noCombat = { isCombat: false } as const;

function resolve(defId: string, casterIndex: 0 | 1, state: GameState, event: Record<string, unknown> = {}): GameState {
  const effect = cardModeOf(spellInstance(defId), undefined);
  expect(effect, `${defId} has no registered effect`).toBeDefined();
  return effect!.resolve(state, contextFor(casterIndex), event as never);
}

describe("Consult the Past (OGN-083): draw 2", () => {
  it("draws two cards for the caster", () => {
    const state = makeState({
      players: [makePlayer("p1", { deck: [makeUnit(), makeUnit(), makeUnit()] }), makePlayer("p2")],
    });
    const after = resolve("OGN-083", 0, state);
    expect(after.players[0]!.hand).toHaveLength(2);
    expect(after.players[1]!.hand).toHaveLength(0);
  });

  it("draws what it can from a one-card deck rather than throwing", () => {
    const state = makeState({ players: [makePlayer("p1", { deck: [makeUnit()] }), makePlayer("p2")] });
    expect(() => resolve("OGN-083", 0, state)).not.toThrow();
  });
});

describe("Fight or Flight (OGN-168): move a unit from a battlefield to its base", () => {
  it("sends an ENEMY unit home, exhausted — it's a Move, not a Recall", () => {
    // rule 454: a Recall is not a Move. This card says "move", so the unit
    // arrives exhausted; picking relocateToBaseUnchanged instead would silently
    // make the card better than printed.
    const enemy = makeUnit({ name: "Enemy", might: 4, exhausted: false });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [enemy] };

    const after = resolve("OGN-168", 0, state, { targetUnitInstanceId: enemy.instanceId });

    expect(after.battlefields[0]!.units["p2"] ?? []).toHaveLength(0);
    expect(after.players[1]!.baseUnits.map((u) => u.name)).toEqual(["Enemy"]);
    expect(after.players[1]!.baseUnits[0]!.exhausted).toBe(true);
  });

  it("works on your own unit too — the text names no owner", () => {
    const mine = makeUnit({ name: "Mine" });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [mine] };
    const after = resolve("OGN-168", 0, state, { targetUnitInstanceId: mine.instanceId });
    expect(after.players[0]!.baseUnits.map((u) => u.name)).toEqual(["Mine"]);
  });

  it("no-ops when the target is gone", () => {
    const state = makeState();
    expect(resolve("OGN-168", 0, state, { targetUnitInstanceId: "gone" })).toBe(state);
  });
});

describe("Hidden Blade (OGN-213): kill a unit, ITS controller draws 2", () => {
  it("kills the unit and gives the draw to the victim's controller, not the caster", () => {
    // The card's whole balance. Reading "its" as the caster turns a drawback
    // into a bonus.
    const victim = makeUnit({ name: "Victim", might: 5 });
    const state = makeState({
      players: [makePlayer("p1", { deck: [makeUnit(), makeUnit()] }), makePlayer("p2", { deck: [makeUnit(), makeUnit()] })],
    });
    state.battlefields[0]!.units = { p2: [victim] };

    const after = resolve("OGN-213", 0, state, { targetUnitInstanceId: victim.instanceId });

    expect(after.battlefields[0]!.units["p2"] ?? []).toHaveLength(0);
    expect(after.players[1]!.trash.map((c) => c.name)).toEqual(["Victim"]); // owner's trash
    expect(after.players[1]!.hand).toHaveLength(2); // THEY draw
    expect(after.players[0]!.hand).toHaveLength(0); // the caster does not
  });

  it("draws for YOU when you kill your own unit", () => {
    const mine = makeUnit({ name: "Mine" });
    const state = makeState({ players: [makePlayer("p1", { deck: [makeUnit(), makeUnit()] }), makePlayer("p2")] });
    state.battlefields[0]!.units = { p1: [mine] };
    const after = resolve("OGN-213", 0, state, { targetUnitInstanceId: mine.instanceId });
    expect(after.players[0]!.hand).toHaveLength(2);
  });

  it("kills regardless of Might — it is a Kill Instruction, not damage", () => {
    const huge = makeUnit({ name: "Huge", might: 99 });
    const state = makeState({ players: [makePlayer("p1"), makePlayer("p2", { deck: [makeUnit(), makeUnit()] })] });
    state.battlefields[0]!.units = { p2: [huge] };
    const after = resolve("OGN-213", 0, state, { targetUnitInstanceId: huge.instanceId });
    expect(after.battlefields[0]!.units["p2"] ?? []).toHaveLength(0);
  });
});

describe("Stand United (OGN-053): buff one unit, and make every buff worth more", () => {
  it("buffs the target AND raises what every buff is worth this turn", () => {
    const target = makeUnit({ name: "Target", might: 3 });
    const otherBuffed = makeUnit({ name: "Other", might: 3 });
    let state = makeState();
    state.players[0]!.baseUnits = [target, otherBuffed];
    state = addBuff(state, otherBuffed.instanceId); // already buffed before the spell

    const after = resolve("OGN-053", 0, state, { targetUnitInstanceId: target.instanceId });

    // Each buff is now worth 2, so both buffed units are at 5.
    expect(effectiveMight(after, after.players[0]!.baseUnits[0]!, 0, noCombat)).toBe(5);
    expect(effectiveMight(after, after.players[0]!.baseUnits[1]!, 0, noCombat)).toBe(5);
  });

  it("is worth nothing to an UNbuffed unit — it raises a buff's value, not Might", () => {
    const plain = makeUnit({ name: "Plain", might: 3 });
    const state = makeState();
    state.players[0]!.baseUnits = [plain];

    const after = resolve("OGN-053", 0, state, {}); // no target to buff
    expect(effectiveMight(after, after.players[0]!.baseUnits[0]!, 0, noCombat)).toBe(3);
  });

  it("reaches units buffed LATER in the same turn", () => {
    const late = makeUnit({ name: "Late", might: 3 });
    let state = makeState();
    state.players[0]!.baseUnits = [late];

    state = resolve("OGN-053", 0, state, {});
    state = addBuff(state, late.instanceId); // buffed after the spell resolved

    expect(effectiveMight(state, state.players[0]!.baseUnits[0]!, 0, noCombat)).toBe(5);
  });

  it("does nothing for the OPPONENT's buffed units", () => {
    const theirs = makeUnit({ name: "Theirs", might: 3 });
    let state = makeState();
    state.players[1]!.baseUnits = [theirs];
    state = addBuff(state, theirs.instanceId);

    const after = resolve("OGN-053", 0, state, {});

    expect(effectiveMight(after, after.players[1]!.baseUnits[0]!, 1, noCombat)).toBe(4); // still just +1
  });

  it("expires at end of turn", () => {
    const unit = makeUnit({ might: 3 });
    let state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [unit];
    state = addBuff(state, unit.instanceId);
    state = resolve("OGN-053", 0, state, {});
    expect(effectiveMight(state, state.players[0]!.baseUnits[0]!, 0, noCombat)).toBe(5);

    // runEnd clears it alongside the rest of this turn's state; the BUFF stays.
    const ended = runEnd(state);
    expect(ended.players[0]!.extraMightPerBuffThisTurn).toBe(0);
    expect(effectiveMight(ended, ended.players[0]!.baseUnits[0]!, 0, noCombat)).toBe(4);
  });
});

describe("Sprite Call (OGN-094): a ready 3-Might Sprite with [Temporary]", () => {
  it("makes a token the Recruit spec could not express", () => {
    const state = makeState({ players: [makePlayer("p1"), makePlayer("p2")] });

    const after = resolve("OGN-094", 0, state, {});
    const token = after.players[0]!.baseUnits[0]!;

    expect(token.name).toBe("Sprite");
    expect(token.might).toBe(3); // not the Recruit's 1
    expect(token.exhausted).toBe(false); // "a READY ... token", overriding 143.4.a
    expect("Temporary" in token.keywords).toBe(true);
    expect(token.isToken).toBe(true);
  });

  it("the token dies at the start of its controller's Beginning Phase (816)", () => {
    let state = makeState({ players: [makePlayer("p1"), makePlayer("p2")] });
    state = resolve("OGN-094", 0, state, {});
    expect(state.players[0]!.baseUnits).toHaveLength(1);

    const beginning = runBeginning({ ...state, phase: "Beginning", activePlayerIndex: 0 });

    expect(beginning.players[0]!.baseUnits).toHaveLength(0);
  });

  it("places at a battlefield when one is chosen", () => {
    // Played from Hidden, rule 811 forces that battlefield — legal-actions
    // supplies it as the destination, and the resolver honours it.
    const state = makeState({ players: [makePlayer("p1"), makePlayer("p2")] });
    state.battlefields[0]!.controllerId = "p1";

    const after = resolve("OGN-094", 0, state, { destinationBattlefieldId: "bf1" });

    expect(after.battlefields[0]!.units["p1"]).toHaveLength(1);
    expect(after.players[0]!.baseUnits).toHaveLength(0);
  });
});
