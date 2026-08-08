import { describe, expect, it } from "vitest";
import { canSpendXp, gainXp, spendXp } from "../src/engine/effect-helpers.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { buildPlayerFromDeckList } from "../src/decks/player-setup.js";
import { allPresetDecks, presetDeckList } from "../src/decks/deck-presets.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { mulberry32 } from "../src/util/rng.js";
import { makeState } from "./fixtures.js";

/**
 * XP, Unleashed's resource, pinned against the rules rather than against the
 * shape of the code that implements it.
 *
 * The section between 727 (Dependent Keywords) and 735 (Additional Turns) is
 * short enough to test in full, and every clause below is one of its sentences:
 * gained and spent, public, per-player, uncapped, and not a Game Object. The
 * whole of the Unleashed pool reads or writes this one integer — 51 of its 280
 * cards mention XP, measured — so a defect here is a defect in 51 cards at once,
 * and the four that follow it (`[Hunt]`, `[Level]`, the XP costs) have nothing
 * to stand on until this is right.
 */
describe("XP, the resource", () => {
  it("is gained and spent", () => {
    const state = makeState();
    const gained = gainXp(state, 0, 3);
    expect(gained.players[0]!.xp).toBe(3);
    expect(spendXp(gained, 0, 2)!.players[0]!.xp).toBe(1);
  });

  it("refuses a spend it cannot afford, rather than flooring at zero", () => {
    // The failure mode this exists to stop: an underpaid cost that reports as
    // paid, so a card's "if you paid the additional cost" half takes the
    // upgraded branch for free. Four UNL cards print that sentence.
    const state = gainXp(makeState(), 0, 2);
    expect(canSpendXp(state, 0, 3)).toBe(false);
    expect(spendXp(state, 0, 3)).toBeUndefined();
    expect(state.players[0]!.xp, "the failed spend still moved the counter").toBe(2);
  });

  it("affords exactly its own total", () => {
    // The off-by-one either way: `>` would refuse a spend of everything, which
    // is what Conscription's "spend 5 XP" does at exactly 5.
    const state = gainXp(makeState(), 0, 5);
    expect(canSpendXp(state, 0, 5)).toBe(true);
    expect(spendXp(state, 0, 5)!.players[0]!.xp).toBe(0);
  });

  it("has no cap", () => {
    // Stated outright by the rules, and the reason nothing clamps. A cap that
    // crept in would be invisible until a long game reached it.
    const state = gainXp(makeState(), 0, 999);
    expect(gainXp(state, 0, 999).players[0]!.xp).toBe(1998);
  });

  it("is not shared — one player's XP is not the other's", () => {
    // "Not shared between allies", which in a 2-player game means the counters
    // are simply independent. A single game-level counter would pass every test
    // above and fail this one.
    const gained = gainXp(makeState(), 0, 4);
    expect(gained.players[0]!.xp).toBe(4);
    expect(gained.players[1]!.xp).toBe(0);
  });

  it("SURVIVES the end of the turn", () => {
    // The load-bearing one. Every counter added to PlayerState lately has been
    // "this turn" state that `runEnd` sweeps to 0, and XP sitting among them is
    // a one-line mistake with no visible symptom until a game runs long: the
    // `[Level 11]` and `[Level 16]` thresholds — nine UNL cards — would simply
    // never switch on, and every test above would still pass.
    //
    // Asserted through a REAL `runEnd` rather than by reading the sweep's field
    // list, so it cannot be satisfied by a comment.
    const armed = gainXp(makeState(), 0, 7);
    expect(runEnd(armed).players[0]!.xp, "the turn cleared XP").toBe(7);
  });

  it("ignores a gain of zero or less instead of running the counter backwards", () => {
    const state = gainXp(makeState(), 0, 5);
    expect(gainXp(state, 0, 0).players[0]!.xp).toBe(5);
    expect(gainXp(state, 0, -3).players[0]!.xp, "a negative gain spent XP").toBe(5);
  });
});

/**
 * The half that has to be checked separately. `makeState` is a fixture and can
 * default to anything, so nothing above it proves the PRODUCTION setup path
 * says 0 — and that path is the one an actual game starts through.
 */
describe("XP at game start", () => {
  it("is zero on a player built the way the app builds one", () => {
    const registry = defaultCardRegistry();
    const garen = presetDeckList(allPresetDecks().find((d) => d.name.startsWith("Garen"))!);
    const player = buildPlayerFromDeckList("p1", "Alice", garen, registry, mulberry32(42));
    expect(player.xp).toBe(0);
  });
});
