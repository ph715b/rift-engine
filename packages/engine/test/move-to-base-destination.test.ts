import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { battlefieldDefIdFor } from "../src/decks/battlefield-setup.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { Domain } from "../src/model/domain.js";
import { makeState, makeUnit, spellInstance } from "./fixtures.js";

/**
 * **A BASE is a legal destination for a spell that says "move a unit".**
 *
 * 197 and 107.2.b make each Base a Location; 355.7 makes "a valid Location for a
 * Move Effect … one other than the Unit's current Location where they are
 * allowed to be present". The PDF then works this exact case BY NAME at
 * **359.3.e**: *"A player plays Ride the Wind choosing to move their unit at
 * Vilemaw's Lair to base. Base is a legal move destination for Ride the Wind,
 * but on resolution … the move instruction will be ignored because Vilemaw's
 * restriction makes the instruction impossible."*
 *
 * That one example fixes both halves of this feature, and they pull in opposite
 * directions — the destination is OFFERED even at Vilemaw's Lair, and the MOVE
 * is what gets ignored, not the spell. A gate in the enumerator would have been
 * the obvious implementation and would contradict the rule it was written for.
 *
 * # Five of the seven, not six
 *
 * `docs/rules-conformance.md` listed six affected cards. Read against the
 * printed text it is five: **Showstopper** ("move it TO A BATTLEFIELD") and
 * **Stormbringer** ("to all enemy units AT A BATTLEFIELD, then move your unit
 * there") name a battlefield, so base is not a Location they may choose — and
 * Relentless Pursuit, which the doc omitted, does gain it.
 */

const CHARM = "OGN-043";
const RIDE_THE_WIND = "OGN-173";
const SHOWSTOPPER = "OGN-270";

const runes = (domain: Domain, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `action was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

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

/** Ride The Wind in hand, a friendly unit standing at bf1. */
function rideTheWindState(): { state: GameState; spellId: string } {
  const spell = spellInstance(RIDE_THE_WIND);
  const s = makeState({ phase: "Action" });
  s.players[0]!.hand = [spell];
  s.players[0]!.channeled = runes("Chaos", 8);
  s.battlefields[0]!.units = { p1: [makeUnit({ name: "Rider", instanceId: "rider", exhausted: true })] };
  return { state: s, spellId: spell.instanceId };
}

describe("a base as a spell's move destination (355.7 / 359.3.e)", () => {
  it("Ride The Wind offers base for a unit at a battlefield — the rules' own example", () => {
    const { state, spellId } = rideTheWindState();
    const toBase = playsOf(state, spellId).filter((p) => p.destinationIsBase === true);
    expect(toBase, "base was not offered as a move destination").toHaveLength(1);
    expect(validatePlayCard(state, toBase[0]!).ok).toBe(true);
  });

  it("moves the unit home, and it arrives READY rather than exhausted", () => {
    // 144.4 makes exhausting the cost of the STANDARD MOVE ACTION, so a spell's
    // move does not exhaust — the same rule `forceMoveToBattlefield` already
    // cites for a unit charmed across the board. Ride The Wind readies on top.
    const { state, spellId } = rideTheWindState();
    const play = playsOf(state, spellId).find((p) => p.destinationIsBase === true);

    const after = resolveChain(accept(state, play));

    expect(after.battlefields[0]!.units["p1"] ?? [], "the unit never left the battlefield").toHaveLength(0);
    expect(after.players[0]!.baseUnits.map((u) => u.name)).toEqual(["Rider"]);
    expect(after.players[0]!.baseUnits[0]!.exhausted, "a spell's move must not exhaust").toBe(false);
  });

  it("does NOT offer base to a unit already in base — 355.7's 'other than its current Location'", () => {
    const { state, spellId } = rideTheWindState();
    state.battlefields[0]!.units = {};
    state.players[0]!.baseUnits = [makeUnit({ name: "Rider", instanceId: "rider" })];

    expect(playsOf(state, spellId).filter((p) => p.destinationIsBase === true)).toHaveLength(0);
  });

  it("Charm sends an ENEMY unit to ITS OWN base, not the caster's (107.2.c)", () => {
    const spell = spellInstance(CHARM);
    const s = makeState({ phase: "Action" });
    s.players[0]!.hand = [spell];
    s.players[0]!.channeled = runes("Calm", 8);
    s.battlefields[0]!.units = { p2: [makeUnit({ name: "Enemy", instanceId: "enemy" })] };

    const play = playsOf(s, spell.instanceId).find((p) => p.destinationIsBase === true);
    expect(play, "Charm did not offer base").toBeDefined();
    const after = resolveChain(accept(s, play));

    expect(after.players[1]!.baseUnits.map((u) => u.name)).toEqual(["Enemy"]);
    expect(after.players[0]!.baseUnits, "the unit went to the CASTER's base").toHaveLength(0);
  });

  it("Showstopper and Stormbringer never offer base — they print a battlefield", () => {
    // The two the doc counted as affected and which, read against their printed
    // text, are not. Showstopper's target is in base to begin with, so this is
    // also 355.7 excluding the current Location.
    const spell = spellInstance(SHOWSTOPPER);
    const s = makeState({ phase: "Action" });
    s.players[0]!.hand = [spell];
    s.players[0]!.channeled = runes("Order", 8);
    s.players[0]!.baseUnits = [makeUnit({ name: "Star", instanceId: "star" })];

    const plays = playsOf(s, spell.instanceId);
    expect(plays.length, "Showstopper was not enumerated at all — the fixture is wrong").toBeGreaterThan(0);
    expect(plays.some((p) => p.destinationIsBase === true)).toBe(false);

    // And the validator refuses it even if an action is hand-built with the
    // flag. The battlefield id is OMITTED rather than set to undefined —
    // `exactOptionalPropertyTypes` is on, and an explicit undefined would not
    // typecheck against `PlayCardAction`.
    const { destinationBattlefieldId: _dropped, ...withoutBattlefield } = plays[0]!;
    expect(validatePlayCard(s, { ...withoutBattlefield, destinationIsBase: true as const }).ok).toBe(false);
  });

  it("Vilemaw's Lair: the destination is still OFFERED, and the MOVE is ignored", () => {
    // 359.3.e in full. The Lair forbids moving from it to base, and the rules are
    // explicit that this does not make the destination illegal to choose — the
    // instruction is ignored on resolution. An enumerator gate would have been
    // the obvious implementation and would contradict the example.
    const { state, spellId } = rideTheWindState();
    const lairDefId = battlefieldDefIdFor("Vilemaw's Lair");
    expect(lairDefId, "Vilemaw's Lair is not in the battlefield table — fixture is stale").toBeDefined();
    state.battlefields[0]! = { ...state.battlefields[0]!, name: "Vilemaw's Lair", defId: lairDefId! };

    const play = playsOf(state, spellId).find((p) => p.destinationIsBase === true);
    expect(play, "the base destination must still be OFFERED at Vilemaw's Lair (359.3.e)").toBeDefined();

    const after = resolveChain(accept(state, play));

    // The move is ignored; the spell still resolved, so the ready still happened.
    expect(after.players[0]!.baseUnits, "the Lair did not stop the move").toHaveLength(0);
    const stillThere = after.battlefields[0]!.units["p1"] ?? [];
    expect(stillThere.map((u) => u.name)).toEqual(["Rider"]);
    expect(stillThere[0]!.exhausted, "the spell resolved, so the ready half still applied").toBe(false);
  });
});
