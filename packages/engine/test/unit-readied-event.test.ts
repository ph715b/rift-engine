import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { runAwaken } from "../src/engine/turn-manager.js";
import { readyPermanent, readyUnit } from "../src/engine/effect-helpers.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";

/**
 * The `unitReadied` event and Pirate's Haven (OGN-143), the card it exists for.
 *
 * Two things make this event unlike the others held as Chain Pending Items:
 *
 *  - **It fires from the AWAKENING PHASE**, once per exhausted unit. Rule 415
 *    makes the Awaken a readying performed by the player, so "when you ready a
 *    friendly unit" covers it — settled in docs/rules-calls-resolved.md, and it
 *    is the difference between a combo trigger and +1 Might to a whole board
 *    every turn. It is also the first thing in this engine that makes the chain
 *    deep by routine play, which is why probes/chain-depth.ts gained an Awaken
 *    control alongside these tests.
 *  - **It must NOT fire for a unit that was already Ready** (415 again). That
 *    guard lives in `readyUnit`/`runAwaken` rather than in the card, so it is
 *    tested at both ends.
 */

const registry = defaultCardRegistry();
const PIRATES_HAVEN = "OGN-143";

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const haven = (instanceId = "haven"): GearInstance =>
  ({ ...createCardInstance(registry.get(PIRATES_HAVEN)), instanceId }) as GearInstance;

/** The Might the board actually shows for a unit — printed plus this-turn,
 *  through the same function combat reads, so a test cannot pass on a field the
 *  game never consults. */
function mightOf(state: GameState, instanceId: string, ownerIndex: 0 | 1 = 0): number {
  const owner = state.players[ownerIndex]!;
  const unit =
    owner.baseUnits.find((u) => u.instanceId === instanceId) ??
    state.battlefields.flatMap((bf) => bf.units[owner.id] ?? []).find((u) => u.instanceId === instanceId);
  expect(unit, `${instanceId} is not in play for player ${ownerIndex}`).toBeDefined();
  return effectiveMight(state, unit!, ownerIndex, { isCombat: false });
}

/** Player 0 holds a Pirate's Haven; `units` describes their board. */
function withHaven(units: UnitInstance[], overrides: Partial<GameState> = {}): GameState {
  const state = makeState({ phase: "Action", ...overrides });
  state.players[0]!.activeGear = [haven()];
  state.players[0]!.baseUnits = units;
  return state;
}

describe("Pirate's Haven (OGN-143): +1 Might to every unit you ready", () => {
  it("pays out for a card effect that readies a unit", () => {
    const sleeper = makeUnit({ instanceId: "sleeper", might: 3, exhausted: true });
    const state = withHaven([sleeper]);

    const after = resolveHeldTriggers(readyUnit(state, "sleeper"));
    expect(after.players[0]!.baseUnits[0]!.exhausted).toBe(false);
    expect(mightOf(after, "sleeper"), "the readied unit got no Might").toBe(4);
  });

  it("pays out through readyPermanent too — Miss Fortune's 'something else that's exhausted'", () => {
    // `readyPermanent` is the wider helper (unit, gear or Legend) and had its own
    // copy of the readying. It now routes units back through `readyUnit`, without
    // which this one card's ready would have been the only silent one in the pool
    // — a gap that shows up as nothing at all happening.
    const sleeper = makeUnit({ instanceId: "sleeper", might: 3, exhausted: true });
    const state = withHaven([sleeper]);

    const after = resolveHeldTriggers(readyPermanent(state, 0, "sleeper"));
    expect(mightOf(after, "sleeper")).toBe(4);
  });

  it("does NOTHING for a unit that was already Ready (rule 415)", () => {
    // "A Unit that is already Ready cannot be Readied again. If a Unit is
    // instructed to be Readied while it is already Ready, nothing additional
    // happens." So the +1 must not be a way to pump a standing board for free.
    const awake = makeUnit({ instanceId: "awake", might: 3, exhausted: false });
    const state = withHaven([awake]);

    const readied = readyUnit(state, "awake");
    expect(readied.pendingTriggers).toHaveLength(0);
    expect(mightOf(resolveHeldTriggers(readied), "awake")).toBe(3);
  });

  it("does NOT pay out for an ENEMY unit being readied — 'a FRIENDLY unit'", () => {
    const enemy = makeUnit({ instanceId: "enemy", might: 3, exhausted: true });
    const state = withHaven([]);
    state.players[1]!.baseUnits = [enemy];

    const readied = readyUnit(state, "enemy");
    expect(readied.pendingTriggers.map((t) => t.listenerDefId)).not.toContain(PIRATES_HAVEN);
    expect(mightOf(resolveHeldTriggers(readied), "enemy", 1)).toBe(3);
  });

  it("is HELD — it reaches the chain, and the Might is not granted at the ready", () => {
    // Asserted on `spellChain` after a real `submit`, never on `pendingTriggers`:
    // `runCleanup` drains the pen every time, so a post-submit pen is always
    // empty and reading it proves nothing.
    const sleeper = makeUnit({ instanceId: "sleeper", might: 3, exhausted: true });
    const state = withHaven([sleeper]);

    const held = readyUnit(state, "sleeper");
    expect(held.pendingTriggers.map((t) => t.listenerDefId)).toEqual([PIRATES_HAVEN]);
    expect(mightOf(held, "sleeper"), "resolved inline instead of being held").toBe(3);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(PIRATES_HAVEN))).toBe(true);
  });
});

describe("the Awakening Phase is a readying (rule 415)", () => {
  it("fires once per EXHAUSTED unit, and not for the ones already standing", () => {
    const tired = makeUnit({ instanceId: "tired", might: 3, exhausted: true });
    const weary = makeUnit({ instanceId: "weary", might: 2, exhausted: true });
    const awake = makeUnit({ instanceId: "awake", might: 4, exhausted: false });
    const state = withHaven([tired, weary, awake], { phase: "Awaken" });

    const awakened = runAwaken(state);
    expect(
      awakened.pendingTriggers.map((t) => (t.event as { unitInstanceId: string }).unitInstanceId),
      "one trigger per readied unit, and none for the unit that was already Ready",
    ).toEqual(["tired", "weary"]);

    const settled = resolveHeldTriggers({ ...awakened, phase: "Action" });
    expect(mightOf(settled, "tired")).toBe(4);
    expect(mightOf(settled, "weary")).toBe(3);
    expect(mightOf(settled, "awake"), "a unit that was never exhausted was pumped").toBe(4);
  });

  it("reaches units at BATTLEFIELDS as well as in base", () => {
    const scout = makeUnit({ instanceId: "scout", might: 3, exhausted: true });
    const state = withHaven([], { phase: "Awaken" });
    state.battlefields[0]!.units = { p1: [scout] };

    const settled = resolveHeldTriggers({ ...runAwaken(state), phase: "Action" });
    expect(mightOf(settled, "scout")).toBe(4);
  });

  it("does not fire for the player whose turn it is NOT", () => {
    // The Awaken readies only the active player's board, so the opponent's
    // exhausted units stay exhausted and their Haven pays nothing.
    const mine = makeUnit({ instanceId: "mine", might: 3, exhausted: true });
    const theirs = makeUnit({ instanceId: "theirs", might: 3, exhausted: true });
    const state = withHaven([mine], { phase: "Awaken" });
    state.players[1]!.activeGear = [haven("their-haven")];
    state.players[1]!.baseUnits = [theirs];

    const awakened = runAwaken(state);
    expect(awakened.pendingTriggers.map((t) => t.playerIndex)).toEqual([0]);
    expect(awakened.players[1]!.baseUnits[0]!.exhausted).toBe(true);
  });

  it("survives a whole turn boundary through the real Pass action", () => {
    // The composed path: `submit`'s Pass runs End then the next Start-of-Turn with
    // a single Cleanup, so these triggers are fired in the Awaken and finalized
    // several phases later. Driven end to end because that composition is exactly
    // where a turn-boundary trigger can be lost — see turn-boundary-triggers.test.ts.
    const sleeper = makeUnit({ instanceId: "sleeper", might: 3, exhausted: true });
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[1]!.activeGear = [haven()];
    state.players[1]!.baseUnits = [sleeper];

    const passed = accept(state, { type: "Pass", playerIndex: 0 });
    expect(passed.spellChain.filter((e) => e.kind === "trigger").map((e) => e.listenerDefId)).toEqual([PIRATES_HAVEN]);

    const settled = resolveHeldTriggers(passed);
    expect(mightOf(settled, "sleeper", 1)).toBe(4);
  });
});
