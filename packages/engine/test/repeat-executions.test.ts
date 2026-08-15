import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { repeatExecutionsOf, type GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { Domain } from "../src/model/domain.js";
import { makeState, makeUnit, spellInstance } from "./fixtures.js";

/**
 * `PlayCardAction.repeatExecutions` — the multi-instance `[Repeat]` action model.
 *
 * 820.1.c.2 ("if a spell or ability has more than one instance of Repeat, each
 * Cost may be paid or not paid individually") and 820.1.c.3 ("each Repeat Cost
 * can be paid only a single time") had no card to exercise them in this pool
 * until UNL-182 Curtain Call, which prints three at three different prices. A
 * boolean `repeatPaid` plus one `repeatChoices` cannot say which of three
 * instances was bought, and 820.2 gives every execution its own Make Relevant
 * Choices step, so the announcement carries a LIST.
 *
 * **This file is about the MODEL, deliberately measured on a card that prints
 * ONE instance.** Every card in the pool is single-instance while this lands, so
 * the thing worth pinning first is that the new spelling is exactly the old one:
 * a play naming instance 0 costs, validates and resolves identically to
 * `repeatPaid: true`. The multi-instance behaviour itself belongs to Curtain
 * Call's own tests, and is worth nothing if this half is wrong.
 *
 * The refusals below are the other half. An action arrives from outside the
 * engine, so the validator re-derives the instance list rather than trusting it:
 * an out-of-range index, a repeated index (820.1.c.3), a `repeatPaid` flag that
 * disagrees with the list, and the two spellings arriving together are each
 * refused by name.
 */

const FERAL_STRENGTH = "SFD-034"; // [Repeat] [2]; give a unit +2 [Might] this turn

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

/** A caster holding Feral Strength with two allies to point it at. */
function caster() {
  const spell = spellInstance(FERAL_STRENGTH);
  const state = makeState({ phase: "Action" });
  state.players[0]!.hand = [spell];
  state.players[0]!.channeled = runes("Calm", 8);
  state.players[0]!.baseUnits = [
    makeUnit({ name: "Ally0", instanceId: "ally0", might: 3 }),
    makeUnit({ name: "Ally1", instanceId: "ally1", might: 3 }),
  ];
  return { state, spellId: spell.instanceId };
}

/** The enumerated repeat-paying play, which is still emitted in the ONE-INSTANCE
 *  spelling — the enumerator migrates with Curtain Call, not with this model. */
function enumeratedRepeat(state: GameState, spellId: string): PlayCardAction {
  const play = playsOf(state, spellId).find((a) => a.repeatPaid && a.targetUnitInstanceId === "ally0");
  expect(play, "no repeat-paying play was offered").toBeDefined();
  return play!;
}

const mightOf = (state: GameState, instanceId: string) =>
  effectiveMight(state, state.players[0]!.baseUnits.find((u) => u.instanceId === instanceId)!, 0, { isCombat: false });

describe("repeatExecutionsOf normalises both spellings of the same list", () => {
  it("an unpaid play has no executions", () => {
    expect(repeatExecutionsOf({})).toEqual([]);
    expect(repeatExecutionsOf({ repeatChoices: { targetUnitInstanceId: "u1" } })).toEqual([]);
  });

  it("the one-instance spelling IS a one-entry list naming instance 0", () => {
    expect(repeatExecutionsOf({ repeatPaid: true })).toEqual([{ instance: 0 }]);
    expect(repeatExecutionsOf({ repeatPaid: true, repeatChoices: { targetUnitInstanceId: "u1" } })).toEqual([
      { instance: 0, choices: { targetUnitInstanceId: "u1" } },
    ]);
  });

  it("and the list, when present, wins — it is the canonical field", () => {
    expect(repeatExecutionsOf({ repeatPaid: true, repeatExecutions: [{ instance: 2 }] })).toEqual([{ instance: 2 }]);
  });
});

describe("a play spelled with repeatExecutions is the play spelled with repeatPaid", () => {
  it("validates, and gives the same +2 twice", () => {
    const { state, spellId } = caster();
    const enumerated = enumeratedRepeat(state, spellId);
    const { repeatPaid: _p, repeatChoices: _c, ...rest } = enumerated;
    const migrated: PlayCardAction = { ...rest, repeatPaid: true, repeatExecutions: [{ instance: 0 }] };

    expect(validatePlayCard(state, migrated)).toMatchObject({ ok: true });
    const after = resolveChain(accept(state, migrated));
    // Base 3, +2 twice — the same figure the one-instance spelling produces.
    expect(mightOf(after, "ally0")).toBe(7);
  });

  it("carries the execution's OWN choices, so the two halves can hit different units", () => {
    const { state, spellId } = caster();
    const enumerated = enumeratedRepeat(state, spellId);
    const { repeatPaid: _p, repeatChoices: _c, ...rest } = enumerated;
    const split: PlayCardAction = {
      ...rest,
      repeatPaid: true,
      repeatExecutions: [{ instance: 0, choices: { targetUnitInstanceId: "ally1" } }],
    };

    expect(validatePlayCard(state, split)).toMatchObject({ ok: true });
    const after = resolveChain(accept(state, split));
    expect(mightOf(after, "ally0")).toBe(5);
    expect(mightOf(after, "ally1")).toBe(5);
  });

  it("and an empty list is a play that declined the repeat — +2 once", () => {
    const { state, spellId } = caster();
    const plain = playsOf(state, spellId).find((a) => !a.repeatPaid && a.targetUnitInstanceId === "ally0")!;
    const migrated: PlayCardAction = { ...plain, repeatExecutions: [] };

    expect(validatePlayCard(state, migrated)).toMatchObject({ ok: true });
    const after = resolveChain(accept(state, migrated));
    expect(mightOf(after, "ally0")).toBe(5);
  });
});

describe("the validator re-derives the instance list rather than trusting it", () => {
  const refusal = (build: (base: PlayCardAction) => PlayCardAction) => {
    const { state, spellId } = caster();
    const enumerated = enumeratedRepeat(state, spellId);
    const { repeatPaid: _p, repeatChoices: _c, ...rest } = enumerated;
    return validatePlayCard(state, build({ ...rest, repeatPaid: true } as PlayCardAction));
  };

  /** 820.1.c.3 — "each Repeat Cost can be paid only a single time." Naming
   *  instance 0 twice would otherwise buy two executions for one price. */
  it("refuses the same instance paid twice", () => {
    expect(
      refusal((base) => ({ ...base, repeatExecutions: [{ instance: 0 }, { instance: 0 }] })),
    ).toMatchObject({ ok: false, error: expect.stringContaining("paid more than once") });
  });

  it("refuses an instance the card does not print", () => {
    expect(refusal((base) => ({ ...base, repeatExecutions: [{ instance: 1 }] }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("no [Repeat] instance 1"),
    });
  });

  it("refuses a fractional or negative index outright", () => {
    expect(refusal((base) => ({ ...base, repeatExecutions: [{ instance: -1 }] }))).toMatchObject({ ok: false });
    expect(refusal((base) => ({ ...base, repeatExecutions: [{ instance: 0.5 }] }))).toMatchObject({ ok: false });
  });

  /** The derived boolean and the list it is derived FROM must agree, or the 26
   *  `repeatPaid` readers and the resolution loop are reading two different
   *  plays. */
  it("refuses a repeatPaid flag that disagrees with the list", () => {
    expect(refusal((base) => ({ ...base, repeatExecutions: [] }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("disagrees"),
    });
    const { state, spellId } = caster();
    const plain = playsOf(state, spellId).find((a) => !a.repeatPaid && a.targetUnitInstanceId === "ally0")!;
    expect(validatePlayCard(state, { ...plain, repeatExecutions: [{ instance: 0 }] })).toMatchObject({
      ok: false,
      error: expect.stringContaining("disagrees"),
    });
  });

  /** Both spellings at once describes the play twice, and `repeatExecutionsOf`
   *  would silently believe one of them. */
  it("refuses the two spellings arriving together", () => {
    expect(
      refusal((base) => ({
        ...base,
        repeatChoices: { targetUnitInstanceId: "ally1" },
        repeatExecutions: [{ instance: 0 }],
      })),
    ).toMatchObject({ ok: false, error: expect.stringContaining("both") });
  });

  /** The pre-existing message, which the new index check must not shadow: a card
   *  with no printed [Repeat] at all fails on the keyword, not on the index. */
  it("still reports a card that has no [Repeat] as having none", () => {
    const spell = spellInstance("SFD-001");
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runes("Fury", 8);
    const play = playsOf(state, spell.instanceId)[0];
    if (play === undefined) return; // the card is unplayable in this fixture; nothing to assert
    expect(validatePlayCard(state, { ...play, repeatPaid: true })).toMatchObject({
      ok: false,
      error: expect.stringContaining("does not have [Repeat]"),
    });
  });
});
