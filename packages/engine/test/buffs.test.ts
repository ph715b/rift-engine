import { describe, expect, it } from "vitest";
import { addBuff, giveMightThisTurn, isBuffed, returnUnitToHand, spendBuff } from "../src/engine/effect-helpers.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { destroyUnit } from "../src/engine/effect-helpers.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type UnitInstance } from "../src/model/card.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";

/**
 * A Buff and "+N Might this turn" were the same field until now, which made
 * eight cards in the pool unimplementable: "While I'm buffed…", "spend a buff
 * to…", "Other buffed friendly units…" all need to READ a buffed state, and a
 * number that gets zeroed every End of Turn can't answer them.
 *
 * The rules make them clearly distinct objects, and each test below pins the
 * specific clause that forced the split.
 */

const noCombat = { isCombat: false } as const;
const mightOf = (state: GameState, unit: UnitInstance, ownerIndex: 0 | 1 = 0) =>
  effectiveMight(state, unit, ownerIndex, noCombat);

function withBaseUnit(unit: UnitInstance): GameState {
  const state = makeState();
  state.players[0]!.baseUnits = [unit];
  return state;
}

describe("a Buff is a game object (rules 701-705)", () => {
  it("is worth +1 Might (703)", () => {
    const unit = makeUnit({ might: 3 });
    const state = addBuff(withBaseUnit(unit), unit.instanceId);
    expect(mightOf(state, state.players[0]!.baseUnits[0]!)).toBe(4);
  });

  it("caps at one per unit — a second buff is not placed (702.3/702.3.a)", () => {
    const unit = makeUnit({ might: 3 });
    let state = addBuff(withBaseUnit(unit), unit.instanceId);
    state = addBuff(state, unit.instanceId);
    state = addBuff(state, unit.instanceId);
    // The reminder text on every buffing card — "(If it doesn't have a buff, it
    // gets a +1 Might buff.)" — is describing exactly this no-op.
    expect(mightOf(state, state.players[0]!.baseUnits[0]!)).toBe(4);
  });

  it("survives End of Turn, unlike +N Might this turn", () => {
    const buffedUnit = makeUnit({ might: 3 });
    const boostedUnit = makeUnit({ might: 3 });
    let state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [buffedUnit, boostedUnit];
    state = addBuff(state, buffedUnit.instanceId);
    state = giveMightThisTurn(state, boostedUnit.instanceId, 1);
    expect(state.players[0]!.baseUnits.map((u) => mightOf(state, u))).toEqual([4, 4]);

    state = runEnd(state);

    // Same Might before the turn ended, different after: the Buff is still
    // there (rule 705 removes it only when the unit leaves play), the this-turn
    // modifier is gone.
    expect(state.players[0]!.baseUnits.map((u) => mightOf(state, u))).toEqual([4, 3]);
    expect(state.players[0]!.baseUnits[0]!.buffed).toBe(true);
    expect(state.players[0]!.baseUnits[1]!.mightThisTurn).toBe(0);
  });

  it("stacks freely as a this-turn modifier, which is what a Buff does not do", () => {
    const unit = makeUnit({ might: 3 });
    let state = withBaseUnit(unit);
    state = giveMightThisTurn(state, unit.instanceId, 2);
    state = giveMightThisTurn(state, unit.instanceId, 2);
    expect(mightOf(state, state.players[0]!.baseUnits[0]!)).toBe(7);
  });

  it("is removed when the unit leaves play (705)", () => {
    const unit = makeUnit({ might: 3 });
    let state = addBuff(withBaseUnit(unit), unit.instanceId);
    state = returnUnitToHand(state, unit.instanceId);
    const inHand = state.players[0]!.hand[0]!;
    expect(inHand.kind === "Unit" && inHand.buffed).toBe(false);
  });

  it("does not survive a trip through the trash", () => {
    const unit = makeUnit({ might: 3 });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [unit] };
    state = addBuff(state, unit.instanceId);
    state = destroyUnit(state, unit.instanceId);
    // The trashed copy keeps `buffed` (nothing clears it on the way out yet —
    // Phase 3's kill funnel is where that lands), but it is out of play, so the
    // board no longer sees a buff anywhere.
    const anyBuffedInPlay =
      state.players.some((p) => p.baseUnits.some((u) => u.buffed)) ||
      state.battlefields.some((bf) => Object.values(bf.units).some((list) => list.some((u) => u.buffed)));
    expect(anyBuffedInPlay).toBe(false);
  });

  it("addBuff no-ops rather than throwing on a unit that isn't in play", () => {
    const state = makeState();
    expect(addBuff(state, "nonexistent")).toBe(state);
  });
});

describe("spending a Buff (rules 702.2.b / 702.2.b.1 / 702.2.b.2)", () => {
  it("removes the buff, dropping the unit's Might back", () => {
    const unit = makeUnit({ might: 3 });
    const buffed = addBuff(withBaseUnit(unit), unit.instanceId);
    const spent = spendBuff(buffed, 0, unit.instanceId);
    expect(spent).toBeDefined();
    expect(mightOf(spent!, spent!.players[0]!.baseUnits[0]!)).toBe(3);
    expect(isBuffed(spent!.players[0]!.baseUnits[0]!)).toBe(false);
  });

  it("refuses an unbuffed unit (702.2.b.1) rather than silently succeeding", () => {
    // This has to be a refusal, not a no-op: spending a buff is a COST on cards
    // that pay out ("spend a buff to buff me and ready me"). A no-op state would
    // hand over the payoff for free.
    const unit = makeUnit({ might: 3 });
    expect(spendBuff(withBaseUnit(unit), 0, unit.instanceId)).toBeUndefined();
  });

  it("refuses a unit another player controls (702.2.b.2)", () => {
    const theirs = makeUnit({ might: 3 });
    let state = makeState();
    state.players[1]!.baseUnits = [theirs];
    state = addBuff(state, theirs.instanceId);
    expect(state.players[1]!.baseUnits[0]!.buffed).toBe(true);
    expect(spendBuff(state, 0, theirs.instanceId)).toBeUndefined();
    expect(spendBuff(state, 1, theirs.instanceId)).toBeDefined();
  });

  it("refuses a unit that isn't in play at all", () => {
    expect(spendBuff(makeState(), 0, "nonexistent")).toBeUndefined();
  });
});

describe("giveMightThisTurn's floor clause", () => {
  it("stops a debuff at the stated minimum Might", () => {
    // Smoke Screen: "Give a unit -4 Might this turn, to a minimum of 1 Might."
    const unit = makeUnit({ might: 3 });
    const state = giveMightThisTurn(withBaseUnit(unit), unit.instanceId, -4, 1);
    expect(mightOf(state, state.players[0]!.baseUnits[0]!)).toBe(1);
  });

  it("takes nothing further off an already-floored unit", () => {
    const unit = makeUnit({ might: 3 });
    let state = giveMightThisTurn(withBaseUnit(unit), unit.instanceId, -4, 1);
    state = giveMightThisTurn(state, unit.instanceId, -4, 1);
    // Not -8 hidden below the floor: a later buff must not have to climb out of
    // a hole this effect dug.
    expect(state.players[0]!.baseUnits[0]!.mightThisTurn).toBe(-2);
    expect(mightOf(state, state.players[0]!.baseUnits[0]!)).toBe(1);
  });

  it("leaves an unfloored debuff free to go below the floor", () => {
    const unit = makeUnit({ might: 3 });
    const state = giveMightThisTurn(withBaseUnit(unit), unit.instanceId, -5);
    // effectiveMight clamps the RESULT at 0; the stored modifier is untouched.
    expect(state.players[0]!.baseUnits[0]!.mightThisTurn).toBe(-5);
    expect(mightOf(state, state.players[0]!.baseUnits[0]!)).toBe(0);
  });
});

describe("the first two cards that use Buffs", () => {
  const registry = defaultCardRegistry();

  it("Pit Rookie buffs another friendly unit when played (OGN-136)", () => {
    const rookie = createCardInstance(registry.get("OGN-136")) as UnitInstance;
    const ally = makeUnit({ might: 2 });
    const state = makeState({
      players: [
        makePlayer("p1", {
          hand: [rookie],
          baseUnits: [ally],
          channeled: Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, domain: "Body" as const, state: "Ready" as const })),
        }),
        makePlayer("p2"),
      ],
    });

    const after = resolveHeldTriggers(executePlayCard(state, {
      type: "PlayCard",
      playerIndex: 0,
      card: rookie,
      payment: {
        energyRunes: state.players[0]!.channeled.slice(0, rookie.energyCost).map((r) => r.id),
        powerRunes: state.players[0]!.channeled.slice(rookie.energyCost, rookie.energyCost + rookie.powerCost).map((r) => r.id),
      },
      targetUnitInstanceId: ally.instanceId,
    }));

    const buffedAlly = after.players[0]!.baseUnits.find((u) => u.instanceId === ally.instanceId)!;
    expect(buffedAlly.buffed).toBe(true);
    expect(mightOf(after, buffedAlly)).toBe(3);
    // Pit Rookie itself is not buffed — "another friendly unit".
    expect(after.players[0]!.baseUnits.find((u) => u.defId === "OGN-136")!.buffed).toBe(false);
  });

  it("Wizened Elder gets an ADDITIONAL +1 while buffed, so +2 in total (OGN-065)", () => {
    const elder = createCardInstance(registry.get("OGN-065")) as UnitInstance;
    let state = withBaseUnit(elder);
    const printed = mightOf(state, state.players[0]!.baseUnits[0]!);

    state = addBuff(state, elder.instanceId);

    // +1 for the Buff (703) and +1 more for its own text — reading the card as
    // "+1 total" would make its printed ability do nothing.
    expect(mightOf(state, state.players[0]!.baseUnits[0]!)).toBe(printed + 2);
  });
});
