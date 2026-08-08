import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { destroyUnit, relocateToBaseUnchanged } from "../src/engine/effect-helpers.js";
import { optionalPowerCostOf } from "../src/engine/card-effects.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { Domain } from "../src/model/domain.js";
import type { RuneCard } from "../src/model/rune.js";
import { makePlayer, makeState, realGearInstance, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * Akshan - Mischievous (SFD-109) — "[Weaponmaster] You may pay [Body][Body] as an
 * additional cost to play me. When you play me, if you paid the additional cost,
 * move an enemy gear to your base. You control it until I leave the board. If
 * it's an Equipment, attach it to me."
 *
 * # The handoff said his `[Body][Body]` half already worked
 *
 * It did not. Nothing was registered for this card at all —
 * `implementingModule("SFD-109")` returned undefined and `OPTIONAL_POWER_COSTS`
 * had no entry for him — so the additional cost lands with the rest of the card
 * rather than beside it. The first test below is that measurement, kept as an
 * assertion so the claim cannot go stale in the other direction either.
 *
 * # What was actually missing
 *
 * Not "gear control": control of a gear is `activeGear` membership, which was
 * always expressible. What did not exist is giving it BACK, and the trigger is a
 * PERMANENT rather than a clock — "until I leave the board", which is wider than
 * "until I die". So the sweep runs in the Cleanup and the tests below check all
 * four ways he can leave that this engine can produce.
 */

const registry = defaultCardRegistry();
const AKSHAN = "SFD-109";
const LONG_SWORD = "SFD-022"; // an Equipment
const VANGUARD_ARMORY = "SFD-168"; // a Gear that is NOT an Equipment

const runes = (domain: Domain, n: number): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

/** p1 holds Akshan and can pay him (4 Energy, no Power printed) plus his two
 *  Body runes; p2 controls `gearDefId`. */
function board(gearDefId = LONG_SWORD): { state: GameState; akshanId: string } {
  const akshan = realUnitInstance(AKSHAN);
  const state = makeState({
    phase: "Action",
    players: [makePlayer("p1", { hand: [akshan], channeled: runes("Body", 8) }), makePlayer("p2")],
  });
  state.players[1]!.activeGear = [{ ...realGearInstance(gearDefId), instanceId: "loot", attachedToInstanceId: null }];
  return { state, akshanId: akshan.instanceId };
}

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

/** Plays Akshan, paying (or declining) his optional cost. */
function play(state: GameState, akshanId: string, paid: boolean): GameState {
  const candidate = playsOf(state, akshanId).find(
    (p) => (p.optionalPowerPaid ?? false) === paid && (paid ? p.targetPermanentInstanceId === "loot" : true),
  );
  expect(candidate, `no ${paid ? "paid" : "unpaid"} Akshan was offered`).toBeDefined();
  return resolveHeldTriggers(executePlayCard(state, candidate!));
}

const gearOf = (state: GameState, playerIndex: 0 | 1) => state.players[playerIndex]!.activeGear;

describe("Akshan - Mischievous: the additional cost that was said to already exist", () => {
  it("has a registered [Body][Body] optional cost", () => {
    expect(optionalPowerCostOf(AKSHAN)).toEqual({ domain: "Body", count: 2 });
  });

  it("is the pool's first optional cost of TWO runes", () => {
    // Every other one is a single pip, which is why `count` had never been
    // exercised above 1 — worth pinning, because a table read as "one rune, a
    // domain" would price him at half.
    expect(optionalPowerCostOf(AKSHAN)!.count).toBe(2);
  });

  it("offers both a paid and a declined variant", () => {
    const { state, akshanId } = board();
    const variants = playsOf(state, akshanId);
    expect(variants.some((p) => p.optionalPowerPaid === true)).toBe(true);
    expect(variants.some((p) => (p.optionalPowerPaid ?? false) === false)).toBe(true);
  });

  it("does nothing at all when the cost is declined", () => {
    const { state, akshanId } = board();
    const after = play(state, akshanId, false);
    expect(gearOf(after, 1).map((g) => g.instanceId), "an unpaid Akshan stole the gear").toEqual(["loot"]);
    expect(gearOf(after, 0)).toHaveLength(0);
  });

  it("the validator accepts every variant the enumerator offers", () => {
    const { state, akshanId } = board();
    for (const candidate of playsOf(state, akshanId)) {
      const result = validatePlayCard(state, candidate);
      expect(result.ok, result.ok ? "" : result.error).toBe(true);
    }
  });
});

describe("Akshan - Mischievous: taking the gear", () => {
  it("moves an enemy gear into the caster's list", () => {
    const { state, akshanId } = board();
    const after = play(state, akshanId, true);
    expect(gearOf(after, 0).map((g) => g.instanceId)).toEqual(["loot"]);
    expect(gearOf(after, 1)).toHaveLength(0);
  });

  it("attaches it to HIM when it is an Equipment", () => {
    const { state, akshanId } = board(LONG_SWORD);
    const after = play(state, akshanId, true);
    expect(gearOf(after, 0)[0]!.attachedToInstanceId).toBe(akshanId);
  });

  it("leaves a NON-Equipment gear unattached", () => {
    // "IF it's an Equipment" — Vanguard Armory is a Gear and carries no Equipment
    // tag, so it arrives loose. The mutation that separates the two halves.
    const { state, akshanId } = board(VANGUARD_ARMORY);
    const after = play(state, akshanId, true);
    expect(gearOf(after, 0).map((g) => g.instanceId)).toEqual(["loot"]);
    expect(gearOf(after, 0)[0]!.attachedToInstanceId).toBeNull();
  });

  it("cannot target FRIENDLY gear — 'an ENEMY gear' is printed", () => {
    const { state, akshanId } = board();
    state.players[0]!.activeGear = [{ ...realGearInstance(LONG_SWORD), instanceId: "mine", attachedToInstanceId: null }];
    const targeted = playsOf(state, akshanId).map((p) => p.targetPermanentInstanceId);
    expect(targeted).toContain("loot");
    expect(targeted, "his own side's gear was offered").not.toContain("mine");
  });

  it("records where the gear came from", () => {
    const { state, akshanId } = board();
    const after = play(state, akshanId, true);
    expect(gearOf(after, 0)[0]!.borrowedControl).toEqual({ fromIndex: 1, whileInPlayInstanceId: akshanId });
  });
});

describe("Akshan - Mischievous: 'until I leave the board'", () => {
  /** A board where Akshan holds the loot. */
  function holding(): { state: GameState; akshanId: string } {
    const { state, akshanId } = board();
    return { state: play(state, akshanId, true), akshanId };
  }

  it("keeps the gear while he stands there", () => {
    const { state } = holding();
    const after = runCleanup(state);
    expect(gearOf(after, 0).map((g) => g.instanceId)).toEqual(["loot"]);
    expect(gearOf(after, 1)).toHaveLength(0);
  });

  it("gives it back when he DIES", () => {
    const { state, akshanId } = holding();
    const after = runCleanup(resolveHeldTriggers(destroyUnit(state, akshanId)));
    expect(gearOf(after, 1).map((g) => g.instanceId)).toEqual(["loot"]);
    expect(gearOf(after, 0)).toHaveLength(0);
  });

  it("gives it back when he is BANISHED — leaving is wider than dying", () => {
    // The reason the sweep is a Cleanup rather than a death-watch. A death-watch
    // catches one of the four ways off the board, and looks completely correct
    // until somebody plays the other three.
    const { state, akshanId } = holding();
    const removed = {
      ...state,
      players: [
        { ...state.players[0]!, baseUnits: state.players[0]!.baseUnits.filter((u) => u.instanceId !== akshanId) },
        state.players[1]!,
      ] as GameState["players"],
    };
    expect(gearOf(runCleanup(removed), 1).map((g) => g.instanceId)).toEqual(["loot"]);
  });

  it("does NOT give it back for a mere move to base", () => {
    // He is still on the board. The control-lapse question is about presence, not
    // about location, and `relocateToBaseUnchanged` keeps him present.
    const { state, akshanId } = holding();
    const after = runCleanup(relocateToBaseUnchanged(state, akshanId));
    expect(gearOf(after, 0).map((g) => g.instanceId)).toEqual(["loot"]);
  });

  it("returns it DETACHED and unmarked, so it cannot be handed back twice", () => {
    const { state, akshanId } = holding();
    const after = runCleanup(resolveHeldTriggers(destroyUnit(state, akshanId)));
    const returned = gearOf(after, 1)[0]!;
    expect(returned.attachedToInstanceId).toBeNull();
    expect(returned.borrowedControl).toBeUndefined();
  });

  it("leaves gear that was never borrowed alone", () => {
    // The control. `returnLapsedGearControl` walks both players' whole gear
    // lists, so a sweep reading the flag wrongly would shuffle the board.
    const { state } = board();
    state.players[0]!.activeGear = [{ ...realGearInstance(LONG_SWORD), instanceId: "mine", attachedToInstanceId: null }];
    const after = runCleanup(state);
    expect(gearOf(after, 0).map((g) => g.instanceId)).toEqual(["mine"]);
    expect(gearOf(after, 1).map((g) => g.instanceId)).toEqual(["loot"]);
  });
});

describe("Akshan - Mischievous: coverage", () => {
  it("reports as implemented", () => {
    expect(isCardImplemented(registry.get(AKSHAN))).toBe(true);
  });
});
