import { describe, expect, it } from "vitest";
import { modifiedEnergyCost } from "../src/engine/cost-modifiers.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { giveMightThisTurn } from "../src/engine/effect-helpers.js";
import { MECH_TOKEN, createToken } from "../src/engine/token.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * SFD's three self-scaling costs, and they are one file because they are three
 * different SHAPES of the same question — what the printed cost is reduced BY:
 *
 *  - **Battering Ram** scales with a per-turn counter, and prints its own
 *    minimum;
 *  - **Jaull-Fish** scales with a BOARD READING that is recomputed on every look,
 *    so an aura or a pump moves its price;
 *  - **Production Surge** is a flat conditional, and is half a card — its effect
 *    lives in a different module from its discount.
 *
 * All three go through `modifiedEnergyCost`, which is the one door every price
 * in this engine comes through. The tests are written against the DOOR and
 * against a real play, because a discount that the enumerator applies and the
 * validator does not is this repo's most repeated bug.
 */

const registry = defaultCardRegistry();
const BATTERING_RAM = "SFD-012";
const JAULL_FISH = "SFD-103";
const PRODUCTION_SURGE = "SFD-076";

const runes = (domain: RuneCard["domain"], n: number): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${domain}${i}`, domain, state: "Ready" as const }));

const printed = (defId: string) => (registry.get(defId) as { energyCost: number }).energyCost;

const priceOf = (state: GameState, defId: string, kind: "Unit" | "Spell" = "Unit") =>
  modifiedEnergyCost(state, 0, kind, printed(defId), defId);

describe("Battering Ram (SFD-012): [1] less per card played, minimum [1]", () => {
  const board = (played: number): GameState => {
    const state = makeState({ phase: "Action" });
    state.players[0]!.cardsPlayedThisTurn = played;
    return state;
  };

  it("costs its printed price before anything is played", () => {
    expect(priceOf(board(0), BATTERING_RAM)).toBe(printed(BATTERING_RAM));
  });

  it("drops by exactly one per card", () => {
    expect(priceOf(board(1), BATTERING_RAM)).toBe(printed(BATTERING_RAM) - 1);
    expect(priceOf(board(2), BATTERING_RAM)).toBe(printed(BATTERING_RAM) - 2);
  });

  /**
   * **The printed minimum, which is the whole reason this is not the shared
   * floor of 0.** Ten cards played does not make it free.
   */
  it("never goes below [1], however many cards were played", () => {
    expect(priceOf(board(10), BATTERING_RAM)).toBe(1);
    expect(priceOf(board(100), BATTERING_RAM)).toBe(1);
  });

  /** And the price the ENUMERATOR quotes matches, which is the half a
   *  door-only test cannot see. */
  it("is offered at the reduced price and accepted at it", () => {
    const state = board(2);
    const ram = realUnitInstance(BATTERING_RAM);
    state.players[0]!.hand = [ram];
    state.players[0]!.channeled = runes("Fury", 8);

    const play = legalActions(state).find(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === ram.instanceId,
    );
    expect(play, "the Ram was not playable").toBeDefined();
    expect(play!.payment!.energyRunes.length, "the enumerator quoted a different price").toBe(printed(BATTERING_RAM) - 2);
    expect(submit(state, play!).result).toMatchObject({ type: "Ok" });
  });
});

describe("Jaull-Fish (SFD-103): [2] less per [Mighty] unit", () => {
  /** `mights` are the printed Mights of the units in p0's base. */
  const board = (...mights: number[]): GameState => {
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = mights.map((might, i) => makeUnit({ instanceId: `u${i}`, might }));
    return state;
  };

  it("costs its printed price with no Mighty units", () => {
    expect(priceOf(board(1, 4), JAULL_FISH)).toBe(printed(JAULL_FISH));
  });

  it("drops by 2 for each unit at 5+ Might", () => {
    expect(priceOf(board(5), JAULL_FISH)).toBe(printed(JAULL_FISH) - 2);
    expect(priceOf(board(5, 6), JAULL_FISH)).toBe(printed(JAULL_FISH) - 4);
  });

  /** 711's threshold is 5, so a 4-Might unit is not Mighty — the off-by-one
   *  that a `>` for a `>=` would introduce. */
  it("counts 5 and not 4", () => {
    expect(priceOf(board(4), JAULL_FISH)).toBe(printed(JAULL_FISH));
    expect(priceOf(board(5), JAULL_FISH)).toBeLessThan(printed(JAULL_FISH));
  });

  /**
   * **Read through `effectiveMight`, so a PUMP moves the price.** A version
   * reading printed Might would pass every test above and fail this one.
   */
  it("counts a unit made Mighty by a this-turn pump", () => {
    const pumped = giveMightThisTurn(board(4), "u0", 1);
    expect(priceOf(pumped, JAULL_FISH), "a pumped unit did not count").toBe(printed(JAULL_FISH) - 2);
  });

  /** "YOUR [Mighty] units" — the opponent's giants do not discount it. */
  it("does not count the OPPONENT's Mighty units", () => {
    const state = board();
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "theirs", might: 9 })];
    expect(priceOf(state, JAULL_FISH), "an enemy unit discounted it").toBe(printed(JAULL_FISH));
  });

  /** The floor is the shared 0, not 1 — this card prints no minimum. */
  it("can be reduced to nothing", () => {
    expect(priceOf(board(5, 5, 5, 5, 5), JAULL_FISH)).toBe(0);
  });
});

describe("Production Surge (SFD-076): [2] less with a Mech, then a Mech and a draw", () => {
  function board(withMech: boolean): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.channeled = runes("Mind", 8);
    state.players[0]!.deck = Array.from({ length: 4 }, () => spellInstance(PRODUCTION_SURGE));
    if (withMech) state.players[0]!.baseUnits = [createToken(MECH_TOKEN)];
    return state;
  }

  it("is cheaper only while you control a Mech", () => {
    expect(priceOf(board(false), PRODUCTION_SURGE, "Spell")).toBe(printed(PRODUCTION_SURGE));
    expect(priceOf(board(true), PRODUCTION_SURGE, "Spell")).toBe(printed(PRODUCTION_SURGE) - 2);
  });

  /** A non-Mech body is not a Mech — the tag is the whole condition. */
  it("a plain unit does not make it cheaper", () => {
    const state = board(false);
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "plain", might: 3 })];
    expect(priceOf(state, PRODUCTION_SURGE, "Spell")).toBe(printed(PRODUCTION_SURGE));
  });

  it("plays a 3-Might Mech to your base and draws 1", () => {
    const state = board(false);
    const surge = spellInstance(PRODUCTION_SURGE);
    state.players[0]!.hand = [surge];
    const before = state.players[0]!.hand.length;

    const play = legalActions(state).find(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === surge.instanceId,
    )!;
    let after = submit(state, play).state;
    for (let guard = 0; guard < 6 && !after.chainOpen; guard += 1) {
      const pass = legalActions(after).find((a) => a.type === "PassFocus");
      if (!pass) break;
      after = submit(after, pass).state;
    }
    after = resolveHeldTriggers(after);

    const mechs = after.players[0]!.baseUnits.filter((u) => u.name === "Mech");
    expect(mechs, "no Mech token arrived").toHaveLength(1);
    expect(mechs[0]!.might).toBe(3);
    // -1 for the Surge itself, +1 for the draw.
    expect(after.players[0]!.hand.length).toBe(before - 1 + 1);
  });

  /**
   * **The token carries the `Mech` tag**, which is not flavour: four keyword
   * auras read it, so a tagless Mech would be the only one on the board they did
   * not reach. Asserted through the discount, which is the cheapest reader of
   * the same tag.
   */
  it("the Mech it makes is a Mech for everything that asks", () => {
    expect(createToken(MECH_TOKEN).tags).toContain("Mech");
    expect(priceOf(board(true), PRODUCTION_SURGE, "Spell")).toBeLessThan(printed(PRODUCTION_SURGE));
  });
});

describe("all three report implemented", () => {
  it("and their text is claimed by a module", () => {
    for (const id of [BATTERING_RAM, JAULL_FISH, PRODUCTION_SURGE]) {
      expect(isCardImplemented(registry.get(id)), `${id}`).toBe(true);
    }
  });
});
