import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { pendingDecision, optionsFor } from "../src/engine/decisions.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers, answerDecisions } from "./fixtures.js";

/**
 * **Fizz - Trickster plays a spell from the trash, and the spell has to be able
 * to AIM.**
 *
 * Reported from playtesting on 2026-08-11, in these words: *"spells played with
 * fizz dont seem to do anything"*. That was exactly right, and the cause was a
 * deliberate simplification that had outlived its reasoning.
 *
 * `play-free.playSpellImmediately` resolved every freely-played spell with an
 * EMPTY choice set, on the argument that "the choices a spell needs are made when
 * it is ANNOUNCED, and nothing announced this one". That holds for a card played
 * by an effect with no player in the loop — a top-of-deck flip, a Deathknell —
 * where there is genuinely nobody to ask.
 *
 * It does not hold for Fizz. He ASKS which spell to play, so the chooser is
 * already answering a question and can be asked a second one. Without it, Hextech
 * Ray left the trash, dealt 3 damage to nobody, and was recycled: the card did
 * its whole job and the spell did none of its own.
 *
 * # What changed
 *
 * `playCardIgnoringCost` gained an optional `choices` argument — absent means the
 * old do-as-much-as-you-can behaviour (**359.3.e.11**), so every other caller is
 * untouched. Fizz parks a second decision (`SFD-140-target`) and passes what the
 * player picked.
 *
 * # The limit, stated rather than hidden
 *
 * Only the single-unit targeting shape is asked. A multi-slot spell, or one
 * needing a destination, still resolves against nothing — offering half its
 * choices would be worse than offering none, because the player would answer and
 * the rest would still fizzle silently. Recorded in docs/rules-conformance.md.
 */

const registry = defaultCardRegistry();
const FIZZ = "SFD-140";
const HEXTECH_RAY = "OGN-009"; // "Deal 3 to a unit at a battlefield" — 1 Energy, 1 Power

/** Fizz in hand, a targeted spell in the trash, and one unit per side at bf1 so
 *  the target question has a real choice to make rather than a single answer. */
function board(): { state: GameState; spell: ReturnType<typeof createCardInstance>; mine: UnitInstance; theirs: UnitInstance } {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.hand = [realUnitInstance(FIZZ)];
  state.players[0]!.floatingEnergy = 20;
  state.players[0]!.floatingPower = { Fury: 9, Calm: 9, Mind: 9, Body: 9, Chaos: 9, Order: 9 };
  const spell = createCardInstance(registry.get(HEXTECH_RAY));
  state.players[0]!.trash = [spell];
  const mine = makeUnit({ name: "Mine", might: 9 });
  const theirs = makeUnit({ name: "Theirs", might: 9 });
  state.battlefields[0] = { ...state.battlefields[0]!, units: { p1: [mine], p2: [theirs] } };
  return { state, spell, mine, theirs };
}

/** Plays Fizz and answers his questions with `pick`, applied per question. */
function playFizz(state: GameState, pick: (ids: string[]) => string): GameState {
  const play = legalActions(state).find((a) => a.type === "PlayCard");
  expect(play, "Fizz was not playable — the fixture measures nothing").toBeDefined();
  const { state: next, result } = submit(state, play!);
  expect(result).toMatchObject({ type: "Ok" });
  return answerDecisions(resolveHeldTriggers(next), (options) => pick(options.map((o) => o.id)));
}

const damageOn = (state: GameState, id: string): number | undefined =>
  [...(state.battlefields[0]!.units["p1"] ?? []), ...(state.battlefields[0]!.units["p2"] ?? [])].find(
    (u) => u.instanceId === id,
  )?.damage;

describe("Fizz - Trickster: the spell he plays can be aimed", () => {
  it("asks a SECOND question once the spell is chosen", () => {
    // The structural claim. Before the fix there was exactly one question and the
    // spell resolved blind.
    const { state, spell } = board();
    const { state: next } = submit(state, legalActions(state).find((a) => a.type === "PlayCard")!);
    const cur = resolveHeldTriggers(next);

    // `answerDecisions` drains the whole queue, so the SECOND question is
    // observed by its effect in the tests below rather than by pausing here.
    // What this one proves is that the first question exists and offers the trash
    // spell — the precondition for everything else.
    const first = pendingDecision(cur)!;
    expect(first.kind, "the spell-choosing question is gone").toBe("SFD-140-play");
    expect(optionsFor(cur, first).map((o) => o.id), "the trash spell was not offered").toContain(spell.instanceId);
  });

  it("deals its damage to the ENEMY unit when that is the answer", () => {
    const { state, theirs, mine } = board();
    const after = playFizz(state, (ids) => ids.find((i) => i === theirs.instanceId) ?? ids.find((i) => i !== "decline")!);

    expect(damageOn(after, theirs.instanceId), "the spell resolved against nothing — the report's bug is back").toBe(3);
    expect(damageOn(after, mine.instanceId), "it hit the wrong unit").toBe(0);
  });

  it("...and to the FRIENDLY unit when that is the answer — the target is a real choice", () => {
    // The control that separates "the spell fires" from "the spell fires at
    // whatever the engine picked". Hextech Ray prints no owner restriction, so
    // both are legal and the answer decides.
    const { state, theirs, mine } = board();
    const after = playFizz(state, (ids) => ids.find((i) => i === mine.instanceId) ?? ids.find((i) => i !== "decline")!);

    expect(damageOn(after, mine.instanceId), "the answer was ignored").toBe(3);
    expect(damageOn(after, theirs.instanceId)).toBe(0);
  });

  it("recycles the spell to the DECK after playing it, not back to the trash", () => {
    // Fizz's own second sentence, and what stops him replaying one spell forever.
    const { state, spell, theirs } = board();
    const after = playFizz(state, (ids) => ids.find((i) => i === theirs.instanceId) ?? ids.find((i) => i !== "decline")!);

    expect(after.players[0]!.trash.some((c) => c.instanceId === spell.instanceId), "the spell stayed in the trash").toBe(false);
    expect(after.players[0]!.deck.some((c) => c.instanceId === spell.instanceId), "the spell was not recycled to the deck").toBe(true);
  });

  it("declining still plays nothing and leaves the spell where it was", () => {
    // The optional half — "you MAY play a spell" — must survive the new question.
    const { state, spell, theirs } = board();
    const after = playFizz(state, (ids) => ids.find((i) => i === "decline") ?? ids[0]!);

    expect(after.players[0]!.trash.some((c) => c.instanceId === spell.instanceId), "declining still spent the spell").toBe(true);
    expect(damageOn(after, theirs.instanceId), "declining still dealt damage").toBe(0);
  });
});
