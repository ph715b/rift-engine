import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { unitListCandidates } from "../src/engine/target-lookup.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import type { UnitInstance } from "../src/model/card.js";
import { makeState, makeUnit, spellInstance } from "./fixtures.js";

/**
 * `unitList` — N ordered targets, chosen when the card is ANNOUNCED.
 *
 * The model is settled (docs/dead-card-survey-2.md) and the rules force it: 355
 * requires valid choices for ALL targets before a spell goes on the chain, and
 * Repulse can read another chain item's target set while that item waits there.
 * Resolve-time would make that archetype unimplementable.
 *
 * Two things here are easy to get subtly wrong and are pinned hard:
 *  - **Duplicates are legal** for the "deal X to a unit" repeaters, which the
 *    rules state through their own Rocket Barrage example. Falling Star with ONE
 *    unit on the board is castable and deals it 6 — the survey's premise that it
 *    was dead in that position was simply wrong.
 *  - The enumeration is **exact when small and sampled when large**, and the
 *    validator accepts ANY legal set either way. The web board narrows its
 *    clickable targets against the enumeration, so a permanently-sampled pool
 *    would cap what a human may choose.
 */

const registry = defaultCardRegistry();
const FALLING_STAR = "OGN-029"; // "Deal 3 to a unit. Deal 3 to a unit."
const ICATHIAN_RAIN = "OGN-248"; // "Deal 2 to a unit." x6
const FOX_FIRE = "OGN-256"; // "Kill any number of units at a battlefield with total Might 4 or less."

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

/** Player 0 holding `defId`, with plenty of runes and `units` at bf1. */
function withSpell(defId: string, units: UnitInstance[], forPlayer: 0 | 1 = 0): GameState {
  const state = makeState({ phase: "Action" });
  const def = registry.get(defId);
  state.players[0]!.hand = [spellInstance(defId)];
  state.players[0]!.channeled = [
    ...Array.from({ length: 8 }, (_, i) => rune(`f${i}`, (def.domains?.[0] ?? "Fury") as RuneCard["domain"])),
    ...Array.from({ length: 4 }, (_, i) => rune(`s${i}`, (def.domains?.[1] ?? "Mind") as RuneCard["domain"])),
  ];
  state.battlefields[0]!.units = { [state.players[forPlayer]!.id]: units };
  return state;
}

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const plays = (state: GameState) => legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard");

/** A play built BY HAND rather than taken from the enumeration — the shape a
 *  human clicking targets produces, and the one the validator has to accept
 *  whether or not the sampler happened to emit it. */
function handBuilt(state: GameState, ids: string[]): PlayCardAction {
  const template = plays(state)[0];
  expect(template, "the card was not castable at all").toBeDefined();
  return { ...template!, targetUnitInstanceIds: ids };
}

const unitAt = (state: GameState, instanceId: string) =>
  state.battlefields.flatMap((bf) => Object.values(bf.units).flat()).find((u) => u.instanceId === instanceId);

describe("Falling Star (OGN-029): two mandatory targets, duplicates legal", () => {
  it("is UNCASTABLE with no units — both choices are mandatory (355)", () => {
    expect(plays(withSpell(FALLING_STAR, []))).toHaveLength(0);
  });

  it("is castable with ONE unit, and deals it 6", () => {
    // The reading the whole card turns on. The survey called it dead here; the
    // rules' Repeat example says a caster may choose the same target twice as
    // long as they say which choice is which.
    const solo = makeUnit({ instanceId: "solo", might: 7 });
    const state = withSpell(FALLING_STAR, [solo]);

    const offered = plays(state);
    expect(offered).toHaveLength(1);
    expect(offered[0]!.targetUnitInstanceIds).toEqual(["solo", "solo"]);

    const resolved = resolveChain(accept(state, offered[0]!));
    expect(unitAt(resolved, "solo")!.damage).toBe(6);
  });

  it("deals 3 to each of two different units", () => {
    const a = makeUnit({ instanceId: "a", might: 9 });
    const b = makeUnit({ instanceId: "b", might: 9 });
    const state = withSpell(FALLING_STAR, [a, b]);

    const resolved = resolveChain(accept(state, handBuilt(state, ["a", "b"])));
    expect(unitAt(resolved, "a")!.damage).toBe(3);
    expect(unitAt(resolved, "b")!.damage).toBe(3);
  });

  it("refuses a set of the wrong size", () => {
    const a = makeUnit({ instanceId: "a", might: 9 });
    const state = withSpell(FALLING_STAR, [a]);

    expect(validatePlayCard(state, handBuilt(state, ["a"])).ok, "one target is not two").toBe(false);
    expect(validatePlayCard(state, handBuilt(state, ["a", "a", "a"])).ok, "three targets is not two").toBe(false);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(FALLING_STAR))).toBe(true);
  });
});

describe("Icathian Rain (OGN-248): six targets", () => {
  it("puts all 12 into a lone survivor", () => {
    const solo = makeUnit({ instanceId: "solo", might: 20 });
    const state = withSpell(ICATHIAN_RAIN, [solo]);

    const resolved = resolveChain(accept(state, handBuilt(state, Array(6).fill("solo"))));
    expect(unitAt(resolved, "solo")!.damage).toBe(12);
  });

  it("accepts a hand-built spread the SAMPLER never emitted", () => {
    // The point of validating rather than matching: past the exhaustive cap the
    // enumeration is a handful of shapes, and a human clicking six targets must
    // still be able to cast. A pool-matching validator would refuse this.
    const units = Array.from({ length: 4 }, (_, i) => makeUnit({ instanceId: `u${i}`, might: 20 }));
    const state = withSpell(ICATHIAN_RAIN, units);
    const lopsided = ["u0", "u0", "u0", "u1", "u2", "u3"];

    const sampled = plays(state).map((a) => (a.targetUnitInstanceIds ?? []).join(","));
    expect(sampled, "the sampler happened to emit it, so this proves nothing").not.toContain(lopsided.join(","));
    expect(validatePlayCard(state, handBuilt(state, lopsided)).ok).toBe(true);

    const resolved = resolveChain(accept(state, handBuilt(state, lopsided)));
    expect(unitAt(resolved, "u0")!.damage).toBe(6);
    expect(unitAt(resolved, "u1")!.damage).toBe(2);
  });

  it("is UNCASTABLE with no units", () => {
    expect(plays(withSpell(ICATHIAN_RAIN, []))).toHaveLength(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(ICATHIAN_RAIN))).toBe(true);
  });
});

describe("Fox-Fire (OGN-256): a GROUP requirement the PDF works by name", () => {
  it("kills a group whose TOTAL Might is within 4", () => {
    const a = makeUnit({ instanceId: "a", might: 2 });
    const b = makeUnit({ instanceId: "b", might: 2 });
    const state = withSpell(FOX_FIRE, [a, b]);

    const resolved = resolveChain(accept(state, handBuilt(state, ["a", "b"])));
    expect(resolved.battlefields[0]!.units["p1"] ?? []).toHaveLength(0);
    // Filtered to Units: the Spell itself is in the trash too, put there when it
    // was cast rather than when it resolved.
    expect(
      resolved.players[0]!.trash.filter((c) => c.kind === "Unit").map((c) => c.instanceId).sort(),
    ).toEqual(["a", "b"]);
  });

  it("refuses a group over the cap, even though each unit is under it", () => {
    // The whole point of a GROUP requirement: three 2-Might units are each a
    // legal single target and are not a legal set.
    const units = Array.from({ length: 3 }, (_, i) => makeUnit({ instanceId: `u${i}`, might: 2 }));
    const state = withSpell(FOX_FIRE, units);

    expect(validatePlayCard(state, handBuilt(state, ["u0", "u1"])).ok).toBe(true);
    expect(validatePlayCard(state, handBuilt(state, ["u0", "u1", "u2"])).ok, "6 total Might is over 4").toBe(false);
  });

  it("reads EFFECTIVE Might, not printed — the PDF's example turns on exactly this", () => {
    // Two 1-Might units are a legal pair; buff one and they are not.
    const a = makeUnit({ instanceId: "a", might: 2 });
    const b = makeUnit({ instanceId: "b", might: 2 });
    const state = withSpell(FOX_FIRE, [a, b]);
    expect(validatePlayCard(state, handBuilt(state, ["a", "b"])).ok).toBe(true);

    const pumped: GameState = {
      ...state,
      battlefields: state.battlefields.map((bf, i) =>
        i === 0 ? { ...bf, units: { p1: [{ ...a, mightThisTurn: 1 }, b] } } : bf,
      ),
    };
    expect(validatePlayCard(pumped, handBuilt(pumped, ["a", "b"])).ok, "a this-turn pump was ignored").toBe(false);
  });

  it("requires every chosen unit at the SAME battlefield", () => {
    const a = makeUnit({ instanceId: "a", might: 1 });
    const b = makeUnit({ instanceId: "b", might: 1 });
    const state = withSpell(FOX_FIRE, [a]);
    state.battlefields[1]!.units = { p1: [b] };

    expect(validatePlayCard(state, handBuilt(state, ["a"])).ok).toBe(true);
    expect(validatePlayCard(state, handBuilt(state, ["a", "b"])).ok, "two battlefields is not 'a battlefield'").toBe(false);
  });

  it("is castable with NO targets — 'any number' includes zero", () => {
    // The rules say so outright, and it is what makes the card castable on an
    // empty board rather than stranded in hand.
    const empty = withSpell(FOX_FIRE, []);
    const offered = plays(empty);
    expect(offered).toHaveLength(1);
    expect(offered[0]!.targetUnitInstanceIds).toEqual([]);
  });

  it("does not choose DUPLICATES — killing a unit twice is not a thing", () => {
    const a = makeUnit({ instanceId: "a", might: 1 });
    const state = withSpell(FOX_FIRE, [a]);
    expect(validatePlayCard(state, handBuilt(state, ["a", "a"])).ok).toBe(false);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(FOX_FIRE))).toBe(true);
  });
});

describe("the enumeration is exact when small and sampled when large", () => {
  it("is EXACT for Falling Star at every realistic board size", () => {
    // n^2 ordered pairs with duplicates. The board narrows clicks against this
    // pool, so exactness here is what lets a player pick any pair they like.
    for (const n of [1, 3, 6]) {
      const units = Array.from({ length: n }, (_, i) => makeUnit({ instanceId: `u${i}`, might: 9 }));
      const state = withSpell(FALLING_STAR, units);
      expect(plays(state), `${n} units`).toHaveLength(n * n);
    }
  });

  it("SAMPLES Icathian Rain once the board passes the cap, and stays legal", () => {
    const units = Array.from({ length: 6 }, (_, i) => makeUnit({ instanceId: `u${i}`, might: 9 }));
    const state = withSpell(ICATHIAN_RAIN, units);
    const offered = plays(state);

    expect(offered.length, "6^6 is 46656 — sampling did not kick in").toBeLessThan(60);
    expect(offered.length, "sampled down to nothing").toBeGreaterThan(0);
    // Every sampled set must itself be legal — a sampler that emits an illegal
    // combination hands the AI an action the validator refuses, which is the
    // offered-then-refused bug this repo has shipped three times.
    for (const play of offered) {
      expect(validatePlayCard(state, play).ok, JSON.stringify(play.targetUnitInstanceIds)).toBe(true);
    }
  });

  it("emits only DISTINCT sets", () => {
    const units = Array.from({ length: 5 }, (_, i) => makeUnit({ instanceId: `u${i}`, might: 9 }));
    const state = withSpell(ICATHIAN_RAIN, units);
    const keys = unitListCandidates(state, 0, { kind: "unitList", min: 6, max: 6, scope: "anywhere", allowsDuplicates: true }).map((ids) =>
      ids.join(","),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

/** Two PassFocus actions resolve the top of a closed chain. */
function resolveChain(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 8 && current.spellChain.length > 0; guard += 1) {
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    expect(pass, "nobody could pass on the chain").toBeDefined();
    current = accept(current, pass!);
  }
  return current;
}
