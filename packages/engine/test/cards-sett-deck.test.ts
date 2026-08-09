import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { submit } from "../src/engine/game-engine.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * The buff-payoff cluster from a real community Sett - The Boss list.
 *
 * These were picked by IMPORTING that list rather than by reading the card pool:
 * 12 of its 40 card copies were doing nothing, and 9 of those were this one
 * mechanic. Everything here is driven through `legalActions` -> `executePlayCard`,
 * never a resolver closure — a card that resolves correctly but is never
 * ENUMERATED is unreachable, and only the enumerator can prove that half.
 */

const registry = defaultCardRegistry();
const CITHRIA = "OGN-139"; // "When you play another unit, buff me."
const SHOWSTOPPER = "OGN-270"; // "Buff a friendly unit in your base, then move it to a battlefield."
const PIT_ROOKIE = "OGN-141"; // a plain body from the same deck, used as "another unit"

/** Runes enough to pay for anything in this file, all one domain. */
const runes = (domain: "Body" | "Order", n = 8) =>
  Array.from({ length: n }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

/**
 * Casts a Spell and then RESOLVES it.
 *
 * A Spell does not take effect when it is played: `executePlayCard` puts it on
 * the chain, and it resolves only once focus has been passed. Asserting straight
 * after the play is the dispatch-hop mistake this suite exists to catch — the
 * first version of these tests did exactly that and read "the unit never moved"
 * as a broken card rather than an unresolved chain.
 *
 * Driven through `submit` + `legalActions` rather than by calling the executors
 * directly, so the passes are the ones the game would really accept.
 */
function castAndResolve(state: GameState, action: unknown): GameState {
  let current = submit(state, action as never).state;
  for (let guard = 0; guard < 8 && current.spellChain.length > 0; guard += 1) {
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) break;
    current = submit(current, pass).state;
  }
  expect(current.spellChain, "the chain never resolved").toHaveLength(0);
  return current;
}

describe("Cithria of Cloudfield (OGN-139): buff me when you play another unit", () => {
  /** Cithria in base, `hand` in hand, Body runes to cast with. */
  function cithriaState(hand: UnitInstance[]): { state: GameState; cithria: UnitInstance } {
    const cithria = realUnitInstance(CITHRIA);
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [cithria];
    state.players[0]!.hand = hand;
    state.players[0]!.channeled = runes("Body");
    return { state, cithria };
  }

  const play = (state: GameState, card: UnitInstance) => {
    const action = legalActions(state).find((a) => a.type === "PlayCard" && a.card.instanceId === card.instanceId);
    expect(action, `${card.name} was never enumerated as playable`).toBeDefined();
  // `resolveHeldTriggers` wraps the executor: `cardPlayed` is a Chain Pending
  // Item now, so `executePlayCard` PLACES the trigger and the Cleanup finalizes
  // it. Called on its own, the executor leaves the pen full and every assertion
  // about a `cardPlayed` listener reads as "the card does nothing" — which is
  // what these tests did the moment the event was converted. `submit` does this
  // for free; a direct `execute*` call does not.
    return resolveHeldTriggers(executePlayCard(state, action as never));
  };

  const cithriaIn = (state: GameState, id: string) => state.players[0]!.baseUnits.find((u) => u.instanceId === id)!;

  it("buffs herself when another unit is played", () => {
    const other = realUnitInstance(PIT_ROOKIE);
    const { state, cithria } = cithriaState([other]);

    expect(cithriaIn(state, cithria.instanceId).buffed).toBe(false);
    const after = play(state, other);
    expect(cithriaIn(after, cithria.instanceId).buffed).toBe(true);
  });

  it("is NOT buffed by a SPELL — 'another unit' excludes one", () => {
    // Without the kind check she would grow off Showstopper and Call to Glory,
    // which in her own deck is most of what gets cast.
    const { state, cithria } = cithriaState([]);
    state.players[0]!.hand = [spellInstance("OGN-154")]; // Primal Strength
    state.players[0]!.baseUnits = [cithriaIn(state, cithria.instanceId), makeUnit({ name: "Target" })];

    const spell = state.players[0]!.hand[0]!;
    const action = legalActions(state).find((a) => a.type === "PlayCard" && a.card.instanceId === spell.instanceId);
    expect(action, "the spell was never enumerated").toBeDefined();
    const after = executePlayCard(state, action as never);

    expect(cithriaIn(after, cithria.instanceId).buffed).toBe(false);
  });

  it("is NOT buffed by her OWN arrival — 'another'", () => {
    // The cardPlayed event fires for her too, so without the identity check she
    // would walk onto the board already buffed.
    const cithria = realUnitInstance(CITHRIA);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [cithria];
    state.players[0]!.channeled = runes("Body");

    const after = play(state, cithria);
    expect(cithriaIn(after, cithria.instanceId).buffed).toBe(false);
  });

  it("is NOT buffed when the OPPONENT plays a unit — 'when YOU play'", () => {
    const { state, cithria } = cithriaState([]);
    const theirs = realUnitInstance(PIT_ROOKIE);
    state.players[1]!.hand = [theirs];
    state.players[1]!.channeled = runes("Body");
    state.activePlayerIndex = 1;

    const action = legalActions(state).find((a) => a.type === "PlayCard" && a.card.instanceId === theirs.instanceId);
    expect(action, "the opponent's unit was never enumerated").toBeDefined();
    const after = executePlayCard(state, action as never);

    expect(cithriaIn(after, cithria.instanceId).buffed).toBe(false);
  });
});

describe("Showstopper (OGN-270): buff a unit in your base, then move it out", () => {
  /** Showstopper in hand with Body runes, and `baseUnits` at home. */
  function showstopperState(baseUnits: UnitInstance[]): { state: GameState; spell: ReturnType<typeof spellInstance> } {
    const spell = spellInstance(SHOWSTOPPER);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runes("Body");
    state.players[0]!.baseUnits = baseUnits;
    return { state, spell };
  }

  const casts = (state: GameState, spellId: string) =>
    legalActions(state).filter((a) => a.type === "PlayCard" && a.card.instanceId === spellId);


  it("buffs the chosen base unit AND moves it to the chosen battlefield", () => {
    const target = makeUnit({ name: "Rookie", instanceId: "rookie" });
    const { state, spell } = showstopperState([target]);

    const action = casts(state, spell.instanceId).find(
      (a) => a.type === "PlayCard" && a.targetUnitInstanceId === "rookie" && a.destinationBattlefieldId === "bf1",
    );
    expect(action, "no candidate targeted the base unit with a destination").toBeDefined();
    const after = castAndResolve(state, action);

    // Gone from base, standing at bf1, and buffed — all three, since any one
    // alone would pass while the card was half-done.
    expect(after.players[0]!.baseUnits).toHaveLength(0);
    const moved = after.battlefields[0]!.units["p1"]!;
    expect(moved.map((u) => u.name)).toEqual(["Rookie"]);
    expect(moved[0]!.buffed).toBe(true);
  });

  it("never offers a unit already AT a battlefield — scope 'base' is the point", () => {
    // Under the ordinary battlefield scope this card would offer a sideways
    // shuffle instead of the deploy it is for.
    const atBattlefield = makeUnit({ name: "Deployed", instanceId: "deployed" });
    const { state, spell } = showstopperState([]);
    state.battlefields[0]!.units = { p1: [atBattlefield] };

    expect(casts(state, spell.instanceId).some((a) => a.type === "PlayCard" && a.targetUnitInstanceId === "deployed")).toBe(false);
  });

  it("never offers an ENEMY unit in their base", () => {
    const { state, spell } = showstopperState([]);
    state.players[1]!.baseUnits = [makeUnit({ name: "Theirs", instanceId: "theirs" })];

    expect(casts(state, spell.instanceId).some((a) => a.type === "PlayCard" && a.targetUnitInstanceId === "theirs")).toBe(false);
  });

  it("the validator refuses a battlefield unit that enumeration never offered", () => {
    // Enumeration and validation reading the scope differently is the drift that
    // has bitten this codebase before, so both halves are pinned.
    const { state, spell } = showstopperState([]);
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Deployed", instanceId: "deployed" })] };

    const result = validatePlayCard(state, {
      type: "PlayCard",
      playerIndex: 0,
      card: spell,
      payment: { energyRunes: ["Body-1"], powerRunes: ["Body-0"] },
      targetUnitInstanceId: "deployed",
      destinationBattlefieldId: "bf2",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/in a base/);
  });

  it("is not castable at all with an empty base", () => {
    const { state, spell } = showstopperState([]);
    expect(casts(state, spell.instanceId)).toEqual([]);
  });
});

describe("the buff cluster composes: Showstopper feeds Sett - Kingpin", () => {
  it("a unit deployed already buffed raises Kingpin's Might the moment it lands", () => {
    // The reason the printed order (buff, THEN move) is load-bearing rather than
    // pedantry — Kingpin counts buffed friendlies AT HIS battlefield.
    const kingpin = realUnitInstance("OGN-240");
    const spell = spellInstance(SHOWSTOPPER);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runes("Body");
    state.players[0]!.baseUnits = [makeUnit({ name: "Rookie", instanceId: "rookie" })];
    state.battlefields[0]!.units = { p1: [kingpin] };

    const before = effectiveMight(state, kingpin, 0, { isCombat: false, battlefieldId: "bf1" });

    const action = legalActions(state).find(
      (a) => a.type === "PlayCard" && a.card.instanceId === spell.instanceId && a.targetUnitInstanceId === "rookie" && a.destinationBattlefieldId === "bf1",
    );
    expect(action, "Showstopper could not be aimed at bf1").toBeDefined();
    const after = castAndResolve(state, action);

    const kingpinAfter = after.battlefields[0]!.units["p1"]!.find((u) => u.defId === "OGN-240")!;
    expect(effectiveMight(after, kingpinAfter, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(before + 1);
  });
});

describe("coverage", () => {
  it("reports the three newly-landed Sett-deck cards as implemented", () => {
    for (const id of [CITHRIA, SHOWSTOPPER, "OGN-240"]) {
      expect(isCardImplemented(registry.get(id)), `${id} ${registry.get(id).name}`).toBe(true);
    }
  });
});

/**
 * Call to Glory (OGN-207): "As you play this, you may spend a buff as an
 * additional cost. If you do, ignore this spell's cost. Give a unit +3 Might
 * this turn."
 *
 * The cost half is the interesting one and it is the first of its shape: paying
 * the additional cost REPLACES the printed cost rather than adding to it, so
 * affordability became a per-VARIANT question instead of one answered once per
 * card. The zero-rune case below is the whole point of the card and was
 * unreachable before — enumeration bailed on the printed 3 Energy long before it
 * ever built the paid variant.
 */
describe("Call to Glory (OGN-207): spend a buff to ignore the cost", () => {
  const CALL_TO_GLORY = "OGN-207"; // 3 Energy, no Power

  /** Call to Glory in hand with `runeCount` Order runes, plus a buffed unit and
   *  an unbuffed one to aim at. */
  function callState(runeCount: number): { state: GameState; spell: ReturnType<typeof spellInstance> } {
    const spell = spellInstance(CALL_TO_GLORY);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runes("Order", runeCount);
    state.players[0]!.baseUnits = [
      makeUnit({ name: "Buffed", instanceId: "buffed", buffed: true, might: 2 }),
      makeUnit({ name: "Plain", instanceId: "plain", might: 2 }),
    ];
    return { state, spell };
  }

  const castsOf = (state: GameState, id: string) =>
    legalActions(state).filter((a) => a.type === "PlayCard" && a.card.instanceId === id);

  it("is castable with NO RUNES AT ALL by spending a buff", () => {
    // The case the card exists for. Before per-variant pricing, enumeration
    // rejected the whole card on its printed cost and never got here.
    const { state, spell } = callState(0);
    const paid = castsOf(state, spell.instanceId).filter((a) => a.type === "PlayCard" && a.additionalCostUnitInstanceId === "buffed");

    expect(paid.length).toBeGreaterThan(0);
    // Priced at nothing — IGNORED, not discounted.
    expect(paid[0]!.type === "PlayCard" && paid[0]!.payment).toEqual({ energyRunes: [], powerRunes: [] });
  });

  it("offers no DECLINED variant when the runes cannot cover the printed cost", () => {
    // "You may" still means may — but declining with 0 runes is simply unpayable,
    // so that variant must not be offered rather than offered and refused.
    const { state, spell } = callState(0);
    const declined = castsOf(state, spell.instanceId).filter(
      (a) => a.type === "PlayCard" && a.additionalCostUnitInstanceId === undefined,
    );
    expect(declined).toEqual([]);
  });

  it("still offers the DECLINE at full price when the runes are there", () => {
    const { state, spell } = callState(6);
    const declined = castsOf(state, spell.instanceId).filter(
      (a) => a.type === "PlayCard" && a.additionalCostUnitInstanceId === undefined,
    );
    expect(declined.length).toBeGreaterThan(0);
    expect(declined[0]!.type === "PlayCard" && declined[0]!.payment.energyRunes).toHaveLength(3);
  });

  it("never offers an UNBUFFED unit as the cost", () => {
    const { state, spell } = callState(6);
    const onPlain = castsOf(state, spell.instanceId).some(
      (a) => a.type === "PlayCard" && a.additionalCostUnitInstanceId === "plain",
    );
    expect(onPlain).toBe(false);
  });

  it("the validator agrees the paid variant costs nothing", () => {
    // Enumeration and validation must re-derive the same surcharge, or the board
    // offers a click validation then refuses.
    const { state, spell } = callState(0);
    const result = validatePlayCard(state, {
      type: "PlayCard",
      playerIndex: 0,
      card: spell,
      payment: { energyRunes: [], powerRunes: [] },
      targetUnitInstanceId: "plain",
      additionalCostUnitInstanceId: "buffed",
    });
    expect(result.ok).toBe(true);
  });

  it("spends the buff and gives +3 Might this turn, not a Buff", () => {
    const { state, spell } = callState(0);
    const action = castsOf(state, spell.instanceId).find(
      (a) => a.type === "PlayCard" && a.additionalCostUnitInstanceId === "buffed" && a.targetUnitInstanceId === "plain",
    );
    expect(action, "no paid variant aimed at the plain unit").toBeDefined();
    const after = castAndResolve(state, action);

    const units = after.players[0]!.baseUnits;
    // The cost was really paid...
    expect(units.find((u) => u.instanceId === "buffed")!.buffed).toBe(false);
    // ...and the payoff is a THIS-TURN pump (317), not a persistent Buff (705).
    const target = units.find((u) => u.instanceId === "plain")!;
    expect(target.mightThisTurn).toBe(3);
    expect(target.buffed).toBe(false);
  });
});

/**
 * Rebuke (OGN-172): "[Action] Return a unit at a battlefield to its owner's hand."
 *
 * From the imported Yasuo list rather than the Sett one, and the cheapest of its
 * six dead copies — `returnUnitToHand` already existed, so the card was one
 * registration away the whole time.
 *
 * The scope is the part worth pinning: "at a battlefield" is printed, so a unit
 * in base is out of reach. Reading that as `scope: "anywhere"` is a mistake this
 * codebase has made before, and it silently makes the card strictly better.
 */
describe("Rebuke (OGN-172): bounce a unit at a battlefield", () => {
  const REBUKE = "OGN-172"; // 2 Energy + 2 Chaos Power

  function rebukeState(): { state: GameState; spell: ReturnType<typeof spellInstance> } {
    const spell = spellInstance(REBUKE);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = Array.from({ length: 6 }, (_, i) => ({
      id: `ch${i}`,
      domain: "Chaos" as const,
      state: "Ready" as const,
    }));
    return { state, spell };
  }

  const casts = (state: GameState, id: string) =>
    legalActions(state).filter((a) => a.type === "PlayCard" && a.card.instanceId === id);

  it("returns an ENEMY unit at a battlefield to its owner's hand", () => {
    const { state, spell } = rebukeState();
    state.battlefields[0]!.units = { p2: [makeUnit({ name: "Intruder", instanceId: "intruder" })] };

    const action = casts(state, spell.instanceId).find((a) => a.type === "PlayCard" && a.targetUnitInstanceId === "intruder");
    expect(action, "Rebuke was never offered the enemy unit").toBeDefined();
    const after = castAndResolve(state, action);

    expect(after.battlefields[0]!.units["p2"] ?? []).toHaveLength(0);
    // Its OWNER's hand, not the caster's.
    expect(after.players[1]!.hand.map((c) => c.name)).toEqual(["Intruder"]);
    expect(after.players[0]!.hand.some((c) => c.name === "Intruder")).toBe(false);
  });

  it("can bounce your OWN unit — 'a unit' carries no side", () => {
    const { state, spell } = rebukeState();
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Mine", instanceId: "mine" })] };

    const action = casts(state, spell.instanceId).find((a) => a.type === "PlayCard" && a.targetUnitInstanceId === "mine");
    expect(action, "Rebuke was never offered a friendly unit").toBeDefined();
    expect(castAndResolve(state, action).players[0]!.hand.some((c) => c.name === "Mine")).toBe(true);
  });

  it("strips a Buff on the way out (705)", () => {
    const { state, spell } = rebukeState();
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Buffed", instanceId: "buffed", buffed: true })] };

    const action = casts(state, spell.instanceId).find((a) => a.type === "PlayCard" && a.targetUnitInstanceId === "buffed");
    const after = castAndResolve(state, action);
    expect(after.players[0]!.hand.find((c) => c.name === "Buffed")).toBeDefined();
    expect((after.players[0]!.hand.find((c) => c.name === "Buffed") as UnitInstance).buffed).toBe(false);
  });

  it("never offers a unit in BASE — 'at a battlefield' is printed", () => {
    const { state, spell } = rebukeState();
    state.players[1]!.baseUnits = [makeUnit({ name: "Homebody", instanceId: "homebody" })];

    expect(casts(state, spell.instanceId).some((a) => a.type === "PlayCard" && a.targetUnitInstanceId === "homebody")).toBe(false);
  });

  it("is not castable with no unit at any battlefield", () => {
    const { state, spell } = rebukeState();
    expect(casts(state, spell.instanceId)).toEqual([]);
  });

  it("reports as implemented", () => {
    expect(isCardImplemented(registry.get(REBUKE))).toBe(true);
  });
});
