import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { Domain } from "../src/model/domain.js";
import { makeState, makeUnit, spellInstance } from "./fixtures.js";

/**
 * Ride The Wind (OGN-173) and Stormbringer (OGN-250) — the two cluster-1 cards
 * that MOVE their target and therefore need a destination as well as one.
 *
 * That destination rides on `destinationBattlefieldId`, which `legal-actions`
 * only fans out for cards named in card-effects.ts's MOVE_TARGET_SPELL_DEF_IDS.
 * Registering a resolver without that entry is worse than leaving the card dead:
 * the card is castable, the destination always arrives `undefined`, the resolver
 * returns the state untouched, and coverage reports it as done. So the first
 * assertion for each card is that the enumerator OFFERS a destination — a
 * resolver test alone could not tell the two apart.
 *
 * Both also exercise the destination filter, which was written for Charm's
 * "an enemy unit" and looked the target up under the OPPONENT's id. That did
 * nothing for a friendly target, and was invisible while Showstopper (whose
 * target is base-scoped, so never at a battlefield) was the only other card in
 * the set.
 */

const registry = defaultCardRegistry();
const RIDE_THE_WIND = "OGN-173";
const STORMBRINGER = "OGN-250";

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `action was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** Passes focus until the chain empties — a Spell takes effect on resolution,
 *  not on being played. */
function resolveChain(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 8 && current.spellChain.length > 0; guard += 1) {
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    expect(pass, "no focus pass was offered while the chain was non-empty").toBeDefined();
    current = accept(current, pass);
  }
  expect(current.spellChain, "the chain never resolved").toHaveLength(0);
  return current;
}

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

const runes = (domain: Domain, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

const unitsAt = (state: GameState, battlefieldId: string, playerId: string) =>
  state.battlefields.find((b) => b.id === battlefieldId)!.units[playerId] ?? [];

describe("Ride The Wind (OGN-173): move a friendly unit and ready it", () => {
  /** A friendly exhausted unit in base, plus enough runes to cast. */
  function state(): { state: GameState; spellId: string } {
    const spell = spellInstance(RIDE_THE_WIND);
    const s = makeState({ phase: "Action" });
    s.players[0]!.hand = [spell];
    s.players[0]!.channeled = runes("Chaos", 8);
    s.players[0]!.baseUnits = [makeUnit({ name: "Rider", instanceId: "rider", exhausted: true })];
    return { state: s, spellId: spell.instanceId };
  }

  it("is OFFERED with a destination — the enumerator fans one out per battlefield", () => {
    // The assertion that separates "implemented" from "registered and inert".
    const { state: s, spellId } = state();
    const plays = playsOf(s, spellId);

    expect(plays.length, "no play of Ride The Wind was enumerated at all").toBeGreaterThan(0);
    for (const play of plays) {
      expect(play.destinationBattlefieldId, "a variant carried no destination").toBeDefined();
    }
    // One per battlefield, since the unit is in base and so at none of them.
    expect(new Set(plays.map((p) => p.destinationBattlefieldId))).toEqual(new Set(["bf1", "bf2"]));
  });

  it("moves the unit to the chosen battlefield and readies it", () => {
    const { state: s, spellId } = state();
    const play = playsOf(s, spellId).find((p) => p.destinationBattlefieldId === "bf1");
    expect(play).toBeDefined();

    const after = resolveChain(accept(s, play));

    expect(after.players[0]!.baseUnits).toHaveLength(0);
    const moved = unitsAt(after, "bf1", "p1");
    expect(moved.map((u) => u.name)).toEqual(["Rider"]);
    expect(moved[0]!.exhausted, "the unit was moved but not readied").toBe(false);
  });

  it("applies Contested, so moving in actually opens a Showdown", () => {
    // The reason this goes through `forceMoveToBattlefield` rather than splicing
    // the unit into a list: a move onto a battlefield the caster does not control
    // is what stages the Showdown.
    const { state: s, spellId } = state();
    s.battlefields[0]!.units = { p2: [makeUnit({ name: "Holder", might: 4 })] };
    s.battlefields[0]!.controllerId = "p2";

    const play = playsOf(s, spellId).find((p) => p.destinationBattlefieldId === "bf1");
    const after = resolveChain(accept(s, play!));

    expect(after.turnState, "no Showdown was staged by the spell's move").toBe("Showdown");
  });

  it("never offers the battlefield the unit is ALREADY standing at", () => {
    // The filter that was silently inert for a friendly target. Rider is at bf1,
    // so only bf2 is a real destination — offering bf1 would be a no-op move the
    // caster paid full price for.
    const { state: s, spellId } = state();
    s.players[0]!.baseUnits = [];
    s.battlefields[0]!.units = { p1: [makeUnit({ name: "Rider", instanceId: "rider", exhausted: true })] };

    const destinations = playsOf(s, spellId).map((p) => p.destinationBattlefieldId);

    expect(destinations.length, "no play was enumerated — the fixture is wrong, not the filter").toBeGreaterThan(0);
    expect(destinations).not.toContain("bf1");
    expect(new Set(destinations)).toEqual(new Set(["bf2"]));
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(RIDE_THE_WIND))).toBe(true);
  });
});

describe("Stormbringer (OGN-250): bombard a battlefield, then deploy into it", () => {
  /** A 5-Might friendly in base, enemies holding bf1. */
  function state(baseMight = 5, enemyMights: number[] = [9]): { state: GameState; spellId: string } {
    const spell = spellInstance(STORMBRINGER);
    const s = makeState({ phase: "Action" });
    s.players[0]!.hand = [spell];
    s.players[0]!.channeled = [...runes("Fury", 6), ...runes("Body", 6)];
    s.players[0]!.baseUnits = [makeUnit({ name: "Caller", instanceId: "caller", might: baseMight })];
    s.battlefields[0]!.units = { p2: enemyMights.map((m, i) => makeUnit({ name: `E${i}`, might: m })) };
    s.battlefields[0]!.controllerId = "p2";
    return { state: s, spellId: spell.instanceId };
  }

  const playAt = (s: GameState, spellId: string, battlefieldId: string) =>
    playsOf(s, spellId).find((p) => p.destinationBattlefieldId === battlefieldId);

  it("is OFFERED with a destination", () => {
    const { state: s, spellId } = state();
    const plays = playsOf(s, spellId);
    expect(plays.length, "no play of Stormbringer was enumerated at all").toBeGreaterThan(0);
    for (const play of plays) expect(play.destinationBattlefieldId).toBeDefined();
  });

  it("deals the chosen unit's Might to EVERY enemy at the battlefield, then moves it there", () => {
    const { state: s, spellId } = state(5, [9, 9]);
    const after = resolveChain(accept(s, playAt(s, spellId, "bf1")!));

    expect(unitsAt(after, "bf1", "p2").map((u) => u.damage)).toEqual([5, 5]);
    expect(unitsAt(after, "bf1", "p1").map((u) => u.name)).toEqual(["Caller"]);
    expect(after.players[0]!.baseUnits).toHaveLength(0);
  });

  it("takes nothing back — the unit is still in BASE while it bombards", () => {
    // Damage first, then move, and this is what the order buys: the caller is not
    // among "all enemy units at a battlefield" from either side, and it arrives
    // undamaged into the fight it just started. Moving first would deploy it into
    // its own bombardment's blast radius.
    const { state: s, spellId } = state(5, [9]);
    const after = resolveChain(accept(s, playAt(s, spellId, "bf1")!));

    expect(unitsAt(after, "bf1", "p1")[0]!.damage).toBe(0);
  });

  it("still deploys when the bombardment killed everything", () => {
    // "THEN move your unit there" is unconditional. With the battlefield emptied
    // the destination is uncontested, which is the card's best case, not a case
    // where it fizzles.
    const { state: s, spellId } = state(5, [3, 4]);
    const after = resolveChain(accept(s, playAt(s, spellId, "bf1")!));

    expect(unitsAt(after, "bf1", "p2")).toHaveLength(0);
    expect(after.players[1]!.trash).toHaveLength(2);
    expect(unitsAt(after, "bf1", "p1").map((u) => u.name)).toEqual(["Caller"]);
  });

  it("reads EFFECTIVE Might, so a this-turn pump is included", () => {
    const { state: s, spellId } = state(5, [20]);
    s.players[0]!.baseUnits = [makeUnit({ name: "Caller", instanceId: "caller", might: 5, mightThisTurn: 3 })];

    const after = resolveChain(accept(s, playAt(s, spellId, "bf1")!));
    expect(unitsAt(after, "bf1", "p2")[0]!.damage).toBe(8);
  });

  it("hits only enemies — a friendly already there is untouched", () => {
    const { state: s, spellId } = state(5, [9]);
    s.battlefields[0]!.units["p1"] = [makeUnit({ name: "Ally", might: 9 })];

    const after = resolveChain(accept(s, playAt(s, spellId, "bf1")!));
    expect(unitsAt(after, "bf1", "p1").find((u) => u.name === "Ally")!.damage).toBe(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(STORMBRINGER))).toBe(true);
  });
});
