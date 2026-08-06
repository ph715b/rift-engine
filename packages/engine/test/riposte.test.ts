import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isSpellChainEntry, type GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, spellInstance } from "./fixtures.js";

/**
 * Riposte (SFD-206) — "[Reaction] Choose a friendly unit and a spell. Counter
 * that spell and give that unit +[Might] equal to that spell's Energy cost this
 * turn."
 *
 * # What this file is really pinning
 *
 * The card names TWO targets in one sentence and `TargetingSpec` carries only
 * one. The spell is a real announce-time target; the unit is asked at
 * resolution, the same shape Mystic Reversal's re-aim question uses.
 *
 * **The divergence that buys is castability** (355.8): printed Riposte cannot be
 * cast with no friendly unit on the board, and this one can. That is tested
 * BELOW as a divergence rather than left to be discovered — a test asserting the
 * printed behaviour would be red, and a test asserting nothing would let the
 * divergence widen unnoticed. Recorded in docs/rules-conformance.md.
 *
 * Everything else is as printed, and the Energy-vs-Power distinction is worth a
 * deliberate fixture: Thermo Beam is 5 Energy / 2 Power, so a +5 says the right
 * number was read and a +2 says the wrong field was.
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
 * The pass at the end is rule 345 and not a formality — the caster of the newest
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

/** Casts Riposte at the waiting spell and passes until it has resolved. Stops on
 *  a parked question, since while one is pending an answer is the only legal move. */
function riposteAt(state: GameState, victimInstanceId: string): GameState {
  const play = playsFor(state, RIPOSTE).find((a) => a.targetChainCardInstanceId === victimInstanceId);
  expect(play, "Riposte could not be aimed at the waiting spell").toBeDefined();
  let current = accept(state, play!);
  for (let guard = 0; guard < 8; guard += 1) {
    if (current.pendingDecisions.length > 0) return current;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) return current;
    current = accept(current, pass!);
    if (current.spellChain.length === 0) return current;
  }
  return current;
}

const waitingSpell = (state: GameState) => state.spellChain.filter(isSpellChainEntry)[0]!;
const mightBonus = (state: GameState, id: string) =>
  state.players[0]!.baseUnits.find((u) => u.instanceId === id)?.mightThisTurn;

describe("Riposte (SFD-206): counter a spell, buff a friendly unit", () => {
  it("counters the spell and gives the chosen unit +Might equal to its ENERGY cost", () => {
    const chained = chainWith(THERMO_BEAM, ["Fiora", "Garen"]);
    const victim = waitingSpell(chained).card.instanceId;
    const resolved = riposteAt(chained, victim);

    // Two friendlies, so it stops and asks — one option would auto-resolve.
    const question = pendingDecision(resolved);
    expect(question, "Riposte never asked which unit to buff").toBeDefined();
    expect(optionsFor(resolved, question!).map((o) => o.instanceId)).toEqual(["Fiora", "Garen"]);

    const answered = accept(resolved, {
      type: "AnswerDecision",
      playerIndex: 0,
      decisionId: question!.id,
      optionId: "Garen",
    });

    // Thermo Beam is 5 Energy / 2 Power. A 2 here means the POWER cost was read.
    expect(mightBonus(answered, "Garen"), "the buff did not read the spell's Energy cost").toBe(5);
    expect(mightBonus(answered, "Fiora"), "the unbuffed unit was touched").toBe(0);
    expect(answered.spellChain.filter(isSpellChainEntry), "the spell survived the counter").toHaveLength(0);
  });

  it("reads each spell's own cost, not a constant", () => {
    // Hextech Ray is 1 Energy where Thermo Beam is 5 — the pair is what stops a
    // hardcoded number passing the test above. It is NOT the field discriminator:
    // its Energy and Power are both 1, so only the Thermo Beam case above can tell
    // the two apart. (counter-spell.test.ts called this card 2E/1P; measured, it
    // is 1E/1P, and that comment has been corrected.)
    const chained = chainWith(HEXTECH_RAY, ["Fiora"]);
    const resolved = riposteAt(chained, waitingSpell(chained).card.instanceId);
    expect(mightBonus(resolved, "Fiora")).toBe(1);
  });

  it("does not prompt when there is only one friendly unit", () => {
    // A decision with a single option auto-resolves and never reaches the player.
    // Asserting this pins the behaviour rather than leaving the one-unit case to
    // be discovered as a hung prompt.
    const chained = chainWith(THERMO_BEAM, ["Fiora"]);
    const resolved = riposteAt(chained, waitingSpell(chained).card.instanceId);
    expect(pendingDecision(resolved), "a lone candidate was still put to the player").toBeUndefined();
    expect(mightBonus(resolved, "Fiora")).toBe(5);
  });

  it("DIVERGENCE (355.8): castable with no friendly unit, where printed it is not", () => {
    // Printed, "choose a friendly unit and a spell" has no legal target set with
    // an empty board, so the card cannot be cast at all. Here the chain spell
    // alone satisfies the announce and the buff half finds nobody.
    //
    // The counter still happens, which is the reason this is a divergence worth
    // shipping rather than a bug: the card is WIDER than printed by exactly one
    // board state, and does the right thing in it.
    const chained = chainWith(THERMO_BEAM, []);
    expect(playsFor(chained, RIPOSTE).length, "the divergence has closed — update the conformance row").toBeGreaterThan(0);

    const resolved = riposteAt(chained, waitingSpell(chained).card.instanceId);
    expect(pendingDecision(resolved), "it asked about a unit with none on the board").toBeUndefined();
    expect(resolved.spellChain.filter(isSpellChainEntry), "the counter half did not happen").toHaveLength(0);
  });

  it("is reported implemented, with no partial note", () => {
    expect(isCardImplemented(registry.get(RIPOSTE))).toBe(true);
    expect(partialImplementationNote(registry.get(RIPOSTE))).toBeUndefined();
  });
});
