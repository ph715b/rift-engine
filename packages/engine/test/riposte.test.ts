import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { pendingDecision } from "../src/engine/decisions.js";
import { isSpellChainEntry, type GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, spellInstance } from "./fixtures.js";

/**
 * Riposte (SFD-206) — "[Reaction] Choose a friendly unit and a spell. Counter
 * that spell and give that unit +[Might] equal to that spell's Energy cost this
 * turn."
 *
 * # Both targets are announced, exactly as in paper
 *
 * The card names TWO targets in one sentence, so it uses the `chainSpellAndUnit`
 * spec rather than countering at announce and asking about the unit later. The
 * difference is not cosmetic and is what the 355.8 test below exists for: a card
 * with no legal target is **uncastable**, so printed Riposte cannot be played
 * with no friendly unit on the board. Choosing the unit at resolution would make
 * it castable in a state the rules forbid — wider than printed.
 *
 * The response window comes with it: because both targets are on the chain entry
 * while Riposte waits, an opponent knows which unit it will grow before it
 * resolves, and can respond to that. Asserted below rather than assumed.
 *
 * The Energy-vs-Power distinction gets a deliberate fixture: Thermo Beam is
 * 5 Energy / 2 Power, so a +5 says the right number was read and a +2 says the
 * wrong field was.
 */
const registry = defaultCardRegistry();
const RIPOSTE = "SFD-206"; // Body + Order, 2 Energy / 2 Power, [Reaction]
const THERMO_BEAM = "OGN-022"; // Fury 5 Energy / 2 Power — the +5 the buff should read
const HEXTECH_RAY = "OGN-009"; // Fury 1 Energy / 1 Power — a second, different number

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const playsFor = (state: GameState, defId: string) =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === defId);

/**
 * Player 1 has cast `castDefId` onto the chain; player 0 holds Riposte with the
 * Order runes to react, and `friendlies` units of their own in base.
 *
 * Base, not a battlefield, and that is load-bearing: "a friendly unit" is a bare
 * noun, so 355.9.b's reading reaches base. A fixture that put them at a
 * battlefield would pass even if the scope were wrong.
 *
 * The trailing pass is rule 345 and not a formality — the caster of the newest
 * chain item holds priority, so without it the opponent is never asked and
 * Riposte looks unofferable. counter-spell.test.ts's fixture notes the same trap.
 */
function chainWith(castDefId: string, friendlies: string[]): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 1 });
  state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "victim", might: 9 })] };

  state.players[1]!.hand = [spellInstance(castDefId)];
  state.players[1]!.channeled = Array.from({ length: 14 }, (_, i) => rune(`f${i}`, "Fury"));

  state.players[0]!.hand = [spellInstance(RIPOSTE)];
  state.players[0]!.channeled = Array.from({ length: 8 }, (_, i) => rune(`o${i}`, "Order"));
  state.players[0]!.baseUnits = friendlies.map((n) => makeUnit({ instanceId: n, name: n, might: 3 }));

  const cast = playsFor(state, castDefId)[0];
  expect(cast, `${castDefId} was not castable — the fixture is wrong`).toBeDefined();
  const chained = accept(state, cast!);

  const pass = legalActions(chained).find((a) => a.type === "PassFocus" && a.playerIndex === 1);
  expect(pass, "the caster was not offered a pass on their own spell").toBeDefined();
  return accept(chained, pass!);
}

/** The Riposte play naming BOTH targets — the only shape the enumerator emits. */
function riposteFor(state: GameState, spellInstanceId: string, unitInstanceId: string) {
  return playsFor(state, RIPOSTE).find(
    (a) => a.targetChainCardInstanceId === spellInstanceId && a.targetUnitInstanceId === unitInstanceId,
  );
}

/** Casts Riposte at both targets and passes until the chain has emptied. */
function riposteAt(state: GameState, spellInstanceId: string, unitInstanceId: string): GameState {
  const play = riposteFor(state, spellInstanceId, unitInstanceId);
  expect(play, `no Riposte play naming ${spellInstanceId} + ${unitInstanceId}`).toBeDefined();
  let current = accept(state, play!);
  for (let guard = 0; guard < 8 && current.spellChain.length > 0; guard += 1) {
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) break;
    current = accept(current, pass!);
  }
  return current;
}

/** A copy of `action` with one field REMOVED rather than set to `undefined` —
 *  under `exactOptionalPropertyTypes` those are different types, and only the
 *  removal is a play a client could send. */
function without(action: PlayCardAction, field: keyof PlayCardAction): PlayCardAction {
  const copy = { ...action } as Record<string, unknown>;
  delete copy[field];
  return copy as unknown as PlayCardAction;
}

const waitingSpell = (state: GameState) => state.spellChain.filter(isSpellChainEntry)[0]!;
const mightBonus = (state: GameState, id: string) =>
  state.players[0]!.baseUnits.find((u) => u.instanceId === id)?.mightThisTurn;

describe("Riposte (SFD-206): counter a spell, buff a friendly unit", () => {
  it("counters the spell and gives the NAMED unit +Might equal to its ENERGY cost", () => {
    const chained = chainWith(THERMO_BEAM, ["Fiora", "Garen"]);
    const resolved = riposteAt(chained, waitingSpell(chained).card.instanceId, "Garen");

    // Thermo Beam is 5 Energy / 2 Power. A 2 here means the POWER cost was read.
    expect(mightBonus(resolved, "Garen"), "the buff did not read the spell's Energy cost").toBe(5);
    expect(mightBonus(resolved, "Fiora"), "a unit the play did not name was buffed").toBe(0);
    expect(resolved.spellChain.filter(isSpellChainEntry), "the spell survived the counter").toHaveLength(0);
    // Nothing is asked at resolution any more — both choices were announced.
    expect(pendingDecision(resolved), "Riposte still stopped to ask something").toBeUndefined();
  });

  it("reads each spell's own cost, not a constant", () => {
    // Hextech Ray is 1 Energy where Thermo Beam is 5 — the pair is what stops a
    // hardcoded number passing the test above. It is NOT the field discriminator:
    // its Energy and Power are both 1, so only the Thermo Beam case can tell the
    // two apart. (counter-spell.test.ts called this card 2E/1P; measured, it is
    // 1E/1P, and that comment has been corrected.)
    const chained = chainWith(HEXTECH_RAY, ["Fiora"]);
    const resolved = riposteAt(chained, waitingSpell(chained).card.instanceId, "Fiora");
    expect(mightBonus(resolved, "Fiora")).toBe(1);
  });

  it("355.8: is UNCASTABLE with no friendly unit, as in paper", () => {
    // The rule the combined targeting kind exists for. "Choose a friendly unit
    // and a spell" cannot be satisfied with an empty board, and for a Spell the
    // targeting IS the effect — so the card is not offered at all rather than
    // cast to do half its job.
    const empty = chainWith(THERMO_BEAM, []);
    expect(playsFor(empty, RIPOSTE), "Riposte was castable with no friendly unit").toHaveLength(0);

    // Positive control: the ONLY thing changed is the presence of a unit, so a
    // Riposte that were unplayable for some unrelated reason (cost, timing,
    // an empty chain) would fail here too and the assertion above would be
    // passing for the wrong reason.
    const withUnit = chainWith(THERMO_BEAM, ["Fiora"]);
    expect(playsFor(withUnit, RIPOSTE).length, "the control board could not cast it either").toBeGreaterThan(0);
  });

  it("the validator refuses a half-named play the enumerator never offered", () => {
    // The enumerator and validator disagreeing is this codebase's recurring
    // failure, so the validator is asked directly rather than trusted to agree.
    const chained = chainWith(THERMO_BEAM, ["Fiora"]);
    const good = riposteFor(chained, waitingSpell(chained).card.instanceId, "Fiora")!;
    expect(validatePlayCard(chained, good).ok, "the control play was refused — the fixture is wrong").toBe(true);

    // Fields are OMITTED, not set to `undefined`: `exactOptionalPropertyTypes`
    // makes those two different things, and omission is the shape a real client
    // would actually send.
    expect(validatePlayCard(chained, without(good, "targetUnitInstanceId")).ok,
      "a Riposte naming no unit was accepted").toBe(false);
    expect(validatePlayCard(chained, without(good, "targetChainCardInstanceId")).ok,
      "a Riposte naming no spell was accepted").toBe(false);

    // And an ENEMY unit is not "a friendly unit" — the victim belongs to p2.
    expect(validatePlayCard(chained, { ...good, targetUnitInstanceId: "victim" }).ok,
      "an enemy unit was accepted as friendly").toBe(false);
  });

  it("fans out one play per (spell, unit) pair", () => {
    // Both are separate announced choices, so every pairing is a distinct play.
    // One spell on the chain and two friendlies is two plays, not one.
    const chained = chainWith(THERMO_BEAM, ["Fiora", "Garen"]);
    const spellId = waitingSpell(chained).card.instanceId;
    const offered = playsFor(chained, RIPOSTE);

    expect(offered).toHaveLength(2);
    expect(offered.every((a) => a.targetChainCardInstanceId === spellId)).toBe(true);
    expect(offered.map((a) => a.targetUnitInstanceId).sort()).toEqual(["Fiora", "Garen"]);
  });

  it("carries BOTH targets on the chain while it waits, so the opponent can see them", () => {
    // The half a resolution-time choice would lose: in paper the unit is named
    // when Riposte is announced, so the response window is informed by it.
    const chained = chainWith(THERMO_BEAM, ["Fiora", "Garen"]);
    const spellId = waitingSpell(chained).card.instanceId;
    const announced = accept(chained, riposteFor(chained, spellId, "Garen")!);

    const onChain = announced.spellChain.filter(isSpellChainEntry).find((e) => e.card.defId === RIPOSTE);
    expect(onChain, "Riposte is not waiting on the chain").toBeDefined();
    expect(onChain!.targetChainCardInstanceId).toBe(spellId);
    expect(onChain!.targetUnitInstanceId, "the unit was not announced with it").toBe("Garen");
  });

  it("is reported implemented, with no partial note", () => {
    expect(isCardImplemented(registry.get(RIPOSTE))).toBe(true);
    expect(partialImplementationNote(registry.get(RIPOSTE))).toBeUndefined();
  });
});
