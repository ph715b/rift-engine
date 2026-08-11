import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { runBeginning } from "../src/engine/turn-manager.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { UnitInstance } from "../src/model/card.js";
import type { Domain } from "../src/model/domain.js";
import type { RuneCard } from "../src/model/rune.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * The Unleashed (UNL) Mind cards of wave 5 — effects/mind.ts.
 *
 * **Everything drives `legalActions` -> `submit`.** Calling a resolver closure
 * directly clears every dispatch hop at once, and the hops are where this engine
 * has actually lost effects before: a unit's on-play trigger is HELD on the chain
 * (383) and only lands when the chain flushes, so a test that never passes Focus
 * would be green against a card that never fires.
 *
 * Each card has a NEGATIVE control that asserts its own POSITIVE control first —
 * "nothing happened" is exactly what an inert card looks like.
 *
 * Two tests are PINS on divergences named in the cards' own entries (Smoke and
 * Mirrors' missing "at a different location" targeting restriction, and the
 * from-Hidden slot exemption 811.1.d.2.a works this card by name). They assert
 * the WRONG answer on purpose, so closing the gap fails loudly rather than
 * changing behaviour nobody was watching.
 *
 * Helpers are local rather than added to fixtures.ts, which is shared and is
 * being edited by other agents in this tree.
 */

const registry = defaultCardRegistry();

const SMOKE_AND_MIRRORS = "UNL-083"; // Spell, 2 Energy — swap two of your units' locations, draw 1
const KEEPER_OF_MASKS = "UNL-081"; // Unit, 2 Energy 1 Might — two Reflection copies of herself "here"
const TIME_WARP = "OGN-122"; // deck filler, so the draw has something to take

/** Enough Ready runes of a card's own Power domain to pay for it outright. */
function runesFor(defId: string, count = 24): RuneCard[] {
  const domain: Domain = registry.get(defId).powerDomain ?? "Mind";
  return Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));
}

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** Passes Focus until the chain and the holding pen are empty, or a question is
 *  outstanding (`submit` refuses a PassFocus while one is, 320.1). */
function passUntilSettled(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 16; guard += 1) {
    if (current.pendingDecisions.length > 0) return current;
    if (current.spellChain.length === 0 && current.pendingTriggers.length === 0) return current;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) return current;
    current = submit(current, pass).state;
  }
  throw new Error("passUntilSettled: the chain never emptied");
}

const castsOf = (state: GameState, instanceId: string) =>
  legalActions(state).filter(
    (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId,
  );

/** Where a unit is standing, as the one string the swap tests compare on — a
 *  battlefield id, "base", or "gone" if it has left play entirely. */
function locationOf(state: GameState, instanceId: string): string {
  for (const playerIndex of [0, 1] as const) {
    if (state.players[playerIndex]!.baseUnits.some((u) => u.instanceId === instanceId)) return "base";
  }
  for (const bf of state.battlefields) {
    if (Object.values(bf.units).some((units) => units.some((u) => u.instanceId === instanceId))) return bf.id;
  }
  return "gone";
}

/** Every unit `playerIndex` has anywhere on the board, base included. */
function ownUnits(state: GameState, playerIndex: 0 | 1): UnitInstance[] {
  const player = state.players[playerIndex]!;
  return [...player.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[player.id] ?? [])];
}

describe("Smoke and Mirrors (UNL-083): swap two of your units' locations, draw 1", () => {
  /**
   * The spell in hand, one friendly unit at bf1 and one in base, plus an enemy
   * standing at bf2 that must never be offered.
   *
   * The opponent is kept OFF bf1 so the arriving unit contests nothing — a
   * Showdown opening mid-swap would leave `passUntilSettled` with an open chain
   * and turn a targeting test into a combat one.
   */
  function swapState(opts: { temporary?: "atBattlefield" | "atBase" | "neither" } = {}) {
    const temporary = opts.temporary ?? "atBattlefield";
    const spell = spellInstance(SMOKE_AND_MIRRORS);
    const roamer = makeUnit({
      instanceId: "roamer",
      name: "Roamer",
      ...(temporary === "atBattlefield" ? { keywords: { Temporary: 1 } } : {}),
    });
    const homebody = makeUnit({
      instanceId: "homebody",
      name: "Homebody",
      ...(temporary === "atBase" ? { keywords: { Temporary: 1 } } : {}),
    });
    const enemy = makeUnit({ instanceId: "enemy", name: "Enemy" });
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.deck = [spellInstance(TIME_WARP), spellInstance(TIME_WARP)];
    state.players[0]!.channeled = runesFor(SMOKE_AND_MIRRORS);
    state.players[0]!.baseUnits = [homebody];
    state.battlefields[0]!.units = { p1: [roamer] };
    state.battlefields[1]!.units = { p2: [enemy] };
    return { state, spellId: spell.instanceId };
  }

  const swapCast = (state: GameState, spellId: string) =>
    castsOf(state, spellId).find(
      (a) =>
        (a.targetUnitInstanceId === "roamer" && a.secondTargetUnitInstanceId === "homebody") ||
        (a.targetUnitInstanceId === "homebody" && a.secondTargetUnitInstanceId === "roamer"),
    );

  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(SMOKE_AND_MIRRORS))).toBe(true);
  });

  it("swaps a Temporary unit at a battlefield with one in base, and draws 1", () => {
    const { state, spellId } = swapState();
    const cast = swapCast(state, spellId);
    expect(cast, "the base/battlefield pair was never offered").toBeDefined();
    expect(locationOf(state, "roamer")).toBe("bf1");
    expect(locationOf(state, "homebody")).toBe("base");

    const after = passUntilSettled(accept(state, cast!));

    expect(locationOf(after, "roamer"), "the battlefield unit did not go home").toBe("base");
    expect(locationOf(after, "homebody"), "the base unit did not take its place").toBe("bf1");
    // Hand: the spell left it and one card was drawn, so the count is unchanged
    // and the DECK is what proves the draw.
    expect(after.players[0]!.deck, "'Draw 1' never happened").toHaveLength(1);
  });

  it("swaps two units at DIFFERENT battlefields, not just base-to-battlefield", () => {
    const { state, spellId } = swapState();
    // Move the base unit out to bf2 so the pair is battlefield-to-battlefield.
    state.players[0]!.baseUnits = [];
    state.battlefields[1]!.units = { p1: [makeUnit({ instanceId: "homebody", name: "Homebody" })] };

    const cast = swapCast(state, spellId);
    expect(cast, "the two-battlefield pair was never offered").toBeDefined();

    const after = passUntilSettled(accept(state, cast!));

    expect(locationOf(after, "roamer")).toBe("bf2");
    expect(locationOf(after, "homebody")).toBe("bf1");
  });

  it("counts [Temporary] on EITHER of the two, not only on the first", () => {
    const { state, spellId } = swapState({ temporary: "atBase" });
    const after = passUntilSettled(accept(state, swapCast(state, spellId)!));

    expect(locationOf(after, "roamer"), "'at least one of them' was read as 'the first of them'").toBe("base");
    expect(locationOf(after, "homebody")).toBe("bf1");
  });

  it("moves NOTHING when neither has [Temporary] — and still draws", () => {
    const { state, spellId } = swapState({ temporary: "neither" });
    const cast = swapCast(state, spellId);
    expect(cast, "the pair was never offered, so 'nothing moved' proves nothing").toBeDefined();

    const after = passUntilSettled(accept(state, cast!));

    expect(locationOf(after, "roamer"), "the [Temporary] condition was not read").toBe("bf1");
    expect(locationOf(after, "homebody")).toBe("base");
    // The draw is its own instruction (135.2) and is NOT under the condition.
    expect(after.players[0]!.deck, "'Draw 1' was wrongly gated on the swap").toHaveLength(1);
  });

  it("is UNCASTABLE with only one unit on the board — both choices are mandatory (355)", () => {
    const { state, spellId } = swapState();
    state.players[0]!.baseUnits = [];

    expect(castsOf(state, spellId), "min: 2 is not being enforced").toHaveLength(0);
  });

  it("never offers an ENEMY unit in either slot — the positive control is that it offers the friendly pair", () => {
    const { state, spellId } = swapState();
    const offered = castsOf(state, spellId);

    expect(swapCast(state, spellId), "nothing was offered, so 'no enemy' proves nothing").toBeDefined();
    const named = offered.flatMap((a) => [a.targetUnitInstanceId, a.secondTargetUnitInstanceId]);
    expect(named).not.toContain("enemy");
  });

  /**
   * **PIN on the "at a different location" targeting restriction**, which
   * `TargetingSpec.unitSlots` cannot express — it has `sameBattlefield` and no
   * inverse. 355 makes a same-location pair an invalid choice and the spell
   * uncastable with it; here it is offered, cast, and draws while moving nothing.
   *
   * Asserting the WRONG answer on purpose. When `differentLocation` lands in
   * card-effects.ts / legal-actions.ts / validate-play-card.ts, this fails.
   */
  it("PIN: two units at the SAME location are still offered, and cast for a bare draw", () => {
    const { state, spellId } = swapState();
    // Both friendlies at bf1, both Temporary — so ONLY the location rule can be
    // what stops the swap.
    state.players[0]!.baseUnits = [];
    state.battlefields[0]!.units = {
      p1: [
        makeUnit({ instanceId: "roamer", name: "Roamer", keywords: { Temporary: 1 } }),
        makeUnit({ instanceId: "homebody", name: "Homebody", keywords: { Temporary: 1 } }),
      ],
    };

    const cast = swapCast(state, spellId);
    expect(cast, "the same-location pair is refused now — delete this pin").toBeDefined();

    const after = passUntilSettled(accept(state, cast!));

    expect(locationOf(after, "roamer"), "a same-location pair moved something").toBe("bf1");
    expect(locationOf(after, "homebody")).toBe("bf1");
    expect(after.players[0]!.deck, "the draw is the only thing this play does").toHaveLength(1);
  });

  /**
   * **PIN on 811.1.d.2.a, which works THIS CARD by name**: *"the first unit
   * chosen can be chosen at the battlefield Smoke and Mirrors was played from, so
   * it must be. The second unit chosen explicitly restricts targeting in a way
   * that makes this impossible, so it can be chosen from any location."*
   *
   * `legal-actions` applies `atHiddenBattlefield` to BOTH `unitSlots` slots, so
   * the second slot is confined to the hidden battlefield too — which, with a
   * card whose two targets must be at DIFFERENT locations, leaves the from-Hidden
   * mode able to name only pairs that cannot legally swap.
   *
   * Asserting the WRONG answer on purpose, with its own positive control (the
   * from-Hidden play IS offered, so "no base pairing" is not vacuous).
   */
  it("PIN: played from Hidden, the SECOND slot is wrongly confined to the hidden battlefield", () => {
    const spell = spellInstance(SMOKE_AND_MIRRORS);
    const state = makeState({ phase: "Action" });
    state.turnNumber = 3;
    state.players[0]!.deck = [spellInstance(TIME_WARP)];
    state.players[0]!.channeled = runesFor(SMOKE_AND_MIRRORS);
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "homebody", name: "Homebody" })];
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      // A body holding bf1: Cleanup step 5 removes a facedown card from a
      // battlefield its owner no longer controls, so an empty bf1 would lose the
      // hidden spell and this test would pass for the wrong reason.
      controllerId: "p1",
      units: {
        p1: [
          makeUnit({ instanceId: "guard", name: "Guard", might: 9 }),
          makeUnit({ instanceId: "roamer", name: "Roamer", keywords: { Temporary: 1 } }),
        ],
      },
      hiddenCards: [{ ownerIndex: 0, card: spell, hiddenOnTurn: 1 }],
    };

    const hidden = legalActions(state).filter(
      (a): a is PlayCardAction =>
        a.type === "PlayCard" && a.card.instanceId === spell.instanceId && a.fromHiddenBattlefieldId !== undefined,
    );

    // Positive control: the card really is playable from facedown here, and the
    // plays it offers really do fill BOTH slots — otherwise "no base unit named"
    // would just be "no unit named" and the pin would be vacuous.
    expect(hidden.length, "the hidden spell was never offered, so the pin below is vacuous").toBeGreaterThan(0);
    expect(
      hidden.filter((a) => a.targetUnitInstanceId !== undefined && a.secondTargetUnitInstanceId !== undefined).length,
      "no from-Hidden play filled both slots",
    ).toBeGreaterThan(0);
    const named = hidden.flatMap((a) => [a.targetUnitInstanceId, a.secondTargetUnitInstanceId]);
    expect(named, "811.1.d.2.a's second-slot exemption is implemented now — delete this pin").not.toContain(
      "homebody",
    );
  });
});

describe("Keeper of Masks (UNL-081): two Reflection copies of herself, here", () => {
  /** Her in hand, with a friendly body already at bf1 so she may be played there
   *  (the ordinary reinforce rule) and "here" can mean a battlefield. */
  function keeperState() {
    const keeper = realUnitInstance(KEEPER_OF_MASKS);
    const anchor = makeUnit({ instanceId: "anchor", name: "Anchor" });
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [keeper];
    state.players[0]!.channeled = runesFor(KEEPER_OF_MASKS);
    state.battlefields[0]!.units = { p1: [anchor] };
    return { state, keeperId: keeper.instanceId };
  }

  const reflections = (state: GameState) =>
    ownUnits(state, 0).filter((u) => u.isToken && u.tags.includes("Reflection"));

  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(KEEPER_OF_MASKS))).toBe(true);
  });

  it("plays TWO Reflection tokens at the battlefield she was played to", () => {
    const { state, keeperId } = keeperState();
    const cast = castsOf(state, keeperId).find((a) => a.destinationBattlefieldId === "bf1");
    expect(cast, "she was never offered a battlefield destination").toBeDefined();

    const after = passUntilSettled(accept(state, cast!));

    expect(locationOf(after, keeperId), "she did not land at bf1").toBe("bf1");
    const made = reflections(after);
    expect(made, "'two Reflection unit tokens' did not arrive as two").toHaveLength(2);
    for (const token of made) {
      expect(locationOf(after, token.instanceId), "'here' was not where she landed").toBe("bf1");
    }
  });

  it("plays them to BASE when she was played to base — 'here' follows her", () => {
    const { state, keeperId } = keeperState();
    const cast = castsOf(state, keeperId).find((a) => a.destinationBattlefieldId === undefined);
    expect(cast, "she was never offered a base play").toBeDefined();

    const after = passUntilSettled(accept(state, cast!));

    expect(reflections(after), "no Reflection arrived in base").toHaveLength(2);
    expect(after.players[0]!.baseUnits.filter((u) => u.tags.includes("Reflection"))).toHaveLength(2);
  });

  it("copies her NAME and carries 0 Might — 477.1.b.1.a's list has no Might in it", () => {
    const { state, keeperId } = keeperState();
    const after = passUntilSettled(accept(state, castsOf(state, keeperId)[0]!));

    const made = reflections(after);
    expect(made).toHaveLength(2);
    for (const token of made) {
      expect(token.name, "the copied Name did not land").toBe("Keeper of Masks");
      expect(token.might, "a copy took her printed Might, which is not a copyable trait").toBe(0);
    }
    // The positive control for the Might assertion: SHE is 1 Might, so 0 is a
    // fact about the copy rather than about an empty stat line everywhere.
    const keeper = ownUnits(after, 0).find((u) => u.instanceId === keeperId);
    expect(keeper?.might, "the printed Keeper is not 1 Might, so the 0 above proves nothing").toBe(1);
  });

  it("the copies carry [Temporary], so all three die at the start of her Beginning Phase", () => {
    const { state, keeperId } = keeperState();
    const played = passUntilSettled(accept(state, castsOf(state, keeperId)[0]!));

    // The positive control: three bodies of hers exist before the phase runs.
    expect(reflections(played)).toHaveLength(2);
    expect(locationOf(played, keeperId)).not.toBe("gone");

    const beginning = runBeginning({ ...played, phase: "Beginning", activePlayerIndex: 0 });

    expect(reflections(beginning), "the copied [Temporary] never expired them").toHaveLength(0);
    expect(locationOf(beginning, keeperId), "her own printed [Temporary] did not fire").toBe("gone");
  });

  it("an OPPONENT's Beginning Phase leaves them alone — 816 names the controller's", () => {
    const { state, keeperId } = keeperState();
    const played = passUntilSettled(accept(state, castsOf(state, keeperId)[0]!));

    const theirs = runBeginning({ ...played, phase: "Beginning", activePlayerIndex: 1 });

    expect(reflections(theirs), "the tokens died on the wrong player's turn").toHaveLength(2);
    expect(locationOf(theirs, keeperId)).not.toBe("gone");
  });
});
