import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * **"If you've spent [4] or more to play a SPELL this turn."**
 *
 * Two cards print this verbatim — UNL-004 Prepared Neophyte (+4 Might while it
 * holds) and UNL-089 Jhin - Meticulous Killer (an alternative cost) — and both
 * were refused across two waves for the same measured reason: `PlayerState`
 * carried `powerSpentThisTurn` and nothing at all about Energy spent on a spell.
 *
 * # A MAXIMUM, not a total, and that is the card's wording
 *
 * "Spent 4 or more to play A SPELL" asks whether some SINGLE spell cost that
 * much. Two 2-Energy spells do not add up to it. Summing would be the easy
 * implementation and would fire on a turn neither card describes — so the
 * two-small-spells case has its own test, because it is the one a total gets
 * wrong and every other test would still pass.
 *
 * # What is counted
 *
 * The MODIFIED cost — what was actually spent, after discounts — read at the
 * moment of payment. A card played for free from `[Hidden]` spends nothing, and
 * a unit is not a spell however expensive it was.
 */

const registry = defaultCardRegistry();
const NEOPHYTE = "UNL-004";
const NEOPHYTE_PRINTED_MIGHT = 1;
const NEOPHYTE_BONUS = 4;

/** Thermo Beam — a 5-Energy Fury spell that needs no target, so the fixture is
 *  about the COST and not about finding something to point it at. */
const BIG_SPELL = "OGN-022";
const BIG_SPELL_ENERGY = 5;
/** En Garde — 1 Energy, no Power, no target. */
const SMALL_SPELL = "OGN-046";

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

/** The Neophyte in play with `spells` in hand and resources for all of them. */
function board(spellIds: string[]): { state: GameState; neophyte: UnitInstance } {
  const neophyte = realUnitInstance(NEOPHYTE);
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.baseUnits = [neophyte];
  state.players[0]!.hand = spellIds.map((id) => spellInstance(id));
  state.players[0]!.floatingEnergy = 30;
  state.players[0]!.floatingPower = { Fury: 9, Calm: 9, Mind: 9, Body: 9, Chaos: 9, Order: 9 };
  state.players[0]!.channeled = Array.from({ length: 12 }, (_, i) => rune(`r${i}`, i % 2 === 0 ? "Calm" : "Fury"));
  return { state, neophyte };
}

/** Plays the named card out of hand through the real enumerator. */
function play(state: GameState, defId: string): GameState {
  const action = legalActions(state).find((a) => a.type === "PlayCard" && a.card.defId === defId);
  expect(action, `${defId} was not playable — the fixture measures nothing`).toBeDefined();
  const { state: next, result } = submit(state, action!);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const mightOf = (state: GameState, id: string): number => {
  const unit = [...state.players[0]!.baseUnits, ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat())].find(
    (u) => u.instanceId === id,
  )!;
  return effectiveMight(state, unit, 0, { isCombat: false });
};

describe("Prepared Neophyte (UNL-004): +4 Might once a big spell has been paid for", () => {
  it("is his printed Might before any spell is played", () => {
    const { state, neophyte } = board([]);
    expect(mightOf(state, neophyte.instanceId), "he started buffed").toBe(NEOPHYTE_PRINTED_MIGHT);
  });

  it("gains +4 after a spell costing 4 or more", () => {
    const { state, neophyte } = board([BIG_SPELL]);
    const after = play(state, BIG_SPELL);
    expect(mightOf(after, neophyte.instanceId), "the condition never became true").toBe(
      NEOPHYTE_PRINTED_MIGHT + NEOPHYTE_BONUS,
    );
  });

  it("does NOT gain it from a 1-Energy spell — the threshold", () => {
    const { state, neophyte } = board([SMALL_SPELL]);
    const after = play(state, SMALL_SPELL);
    expect(mightOf(after, neophyte.instanceId), "a cheap spell satisfied a 4-Energy condition").toBe(
      NEOPHYTE_PRINTED_MIGHT,
    );
  });

  it("...and TWO cheap spells still do not — it is a MAXIMUM, not a total", () => {
    // The test a summing implementation fails and every other test here passes.
    // "Spent 4 to play A spell" is about one spell.
    const { state, neophyte } = board([SMALL_SPELL, SMALL_SPELL]);
    const once = play(state, SMALL_SPELL);
    const twice = play(once, SMALL_SPELL);

    expect(twice.players[0]!.maxSpellEnergySpentThisTurn, "the counter summed rather than maximised").toBe(1);
    expect(mightOf(twice, neophyte.instanceId), "two cheap spells added up to a big one").toBe(NEOPHYTE_PRINTED_MIGHT);
  });

  it("a big spell keeps the buff on after a later CHEAP one", () => {
    // The other half of "maximum": the counter must not be overwritten downward
    // by the next spell, which a plain assignment would do.
    const { state, neophyte } = board([BIG_SPELL, SMALL_SPELL]);
    const after = play(play(state, BIG_SPELL), SMALL_SPELL);

    expect(after.players[0]!.maxSpellEnergySpentThisTurn, "a cheap spell lowered the maximum").toBe(BIG_SPELL_ENERGY);
    expect(mightOf(after, neophyte.instanceId), "the buff fell off").toBe(NEOPHYTE_PRINTED_MIGHT + NEOPHYTE_BONUS);
  });

  it("is measured from the OWNER — the opponent's big spell does not buff him", () => {
    // Without this, reading `players[0]` or the active player would pass every
    // test above, since the Neophyte is player 0's throughout.
    const { state, neophyte } = board([]);
    state.players[1]!.maxSpellEnergySpentThisTurn = 9;

    expect(mightOf(state, neophyte.instanceId), "the opponent's spending buffed him").toBe(NEOPHYTE_PRINTED_MIGHT);
  });

  it("does not buff any OTHER unit", () => {
    // Every registered modifier is asked about every unit, so a missing defId
    // check buffs the whole board.
    const { state } = board([BIG_SPELL]);
    const bystander = realUnitInstance("OGN-002");
    state.players[0]!.baseUnits = [...state.players[0]!.baseUnits, bystander];
    const after = play(state, BIG_SPELL);

    expect(mightOf(after, bystander.instanceId), "the whole board was buffed").toBe(
      (registry.get("OGN-002") as { might: number }).might,
    );
  });

  it("a UNIT does not count, however expensive", () => {
    // "to play a SPELL". `execute-play-card` gates the counter on `card.kind`.
    const { state, neophyte } = board([]);
    // Magma Wurm — 8 Energy, comfortably over the threshold, and a UNIT.
    state.players[0]!.hand = [spellInstance("OGN-011")];
    const after = play(state, "OGN-011");

    expect(after.players[0]!.maxSpellEnergySpentThisTurn, "a unit counted as a spell").toBe(0);
    expect(mightOf(after, neophyte.instanceId)).toBe(NEOPHYTE_PRINTED_MIGHT);
  });

  it("is reported implemented, and his whole text is this one clause", () => {
    expect(isCardImplemented(registry.get(NEOPHYTE)), "the Neophyte is greyed").toBe(true);
    expect(registry.get(NEOPHYTE).text, "his text changed — re-read the condition").toContain("to play a spell this turn");
  });
});
