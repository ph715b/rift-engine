import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isSpellChainEntry } from "../src/model/game-state.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realGearInstance, spellInstance } from "./fixtures.js";

/**
 * **Vendetta's dual-domain spell block, wave 3 — the two whose first domain in
 * canonical order is Mind.**
 *
 * Two cards, two different relationships with what was already built:
 *
 *   - **Acceleration Gate needed one new axis and a stated model.** "Ready up to
 *     4 units, gear, and/or runes" is one allowance across three kinds, and only
 *     the units are chosen: the remainder spills to gear and then runes. What
 *     makes that a simplification rather than a divergence is that the one line
 *     it cannot express — declining the leftover — is strictly dominated.
 *   - **Rebuttal needed almost nothing, and finding that out corrected a
 *     comment.** `gainControlOfSpell`'s doc said "you may make new choices for
 *     it" was NOT implemented. It has been working since Mystic Reversal shipped,
 *     through `retargetCandidates` and the `OGN-080-retarget` decision, which the
 *     card's own entry in `effects/calm.ts` described the whole time.
 */

const registry = defaultCardRegistry();

const ACCELERATION_GATE = "VEN-150"; // Mind+Body Spell, 3 Energy 1 Power
const REBUTTAL = "VEN-152"; // Mind+Chaos Spell, 1 Energy 1 Power — "[Reaction]"
const HEXTECH_RAY = "OGN-009"; // Fury 1E/1P — "Deal 3 to a unit at a battlefield", inside Rebuttal's filter
const THERMO_BEAM = "OGN-022"; // Fury 5E/2P — over the printed [4] ceiling
const A_GEAR = "OGN-090"; // Orb of Regret, a real Gear

const rune = (id: string, domain: RuneCard["domain"], state: RuneCard["state"] = "Ready"): RuneCard => ({
  id,
  domain,
  state,
});

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const playsFor = (state: GameState, defId: string) =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === defId);

const spellEntries = (state: GameState) => state.spellChain.filter(isSpellChainEntry);

/** Drives a closed chain to empty. A Spell RESOLVES on a chain pop, not when it
 *  is submitted, so a test that read the board straight after `accept` would be
 *  looking a whole response window too early — which is exactly how the first
 *  draft of the Acceleration Gate tests failed. */
function settle(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 12 && current.spellChain.length > 0; guard += 1) {
    if (current.pendingDecisions.length > 0) return current;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    expect(pass, "nobody could pass on the chain").toBeDefined();
    current = accept(current, pass!);
  }
  return current;
}

describe("both report implemented — the premise", () => {
  it("is what the rest of this file is about", () => {
    for (const id of [ACCELERATION_GATE, REBUTTAL]) {
      expect(isCardImplemented(registry.get(id)), `${id} is not implemented`).toBe(true);
    }
  });
});

describe("Acceleration Gate (VEN-150): one allowance over three kinds", () => {
  /**
   * p0 has `units` exhausted units at bf1, `gear` exhausted gear, and `runes`
   * exhausted runes on top of the ready ones the spell is paid with.
   */
  function board(counts: { units?: number; readyUnits?: number; gear?: number; exhaustedRunes?: number } = {}) {
    const gate = spellInstance(ACCELERATION_GATE);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [gate];
    state.players[0]!.channeled = [
      ...Array.from({ length: 8 }, (_, i) => rune(`ready-${i}`, "Mind")),
      ...Array.from({ length: counts.exhaustedRunes ?? 0 }, (_, i) => rune(`spent-${i}`, "Mind", "Exhausted")),
    ];
    state.battlefields[0]!.units = {
      p1: [
        ...Array.from({ length: counts.units ?? 0 }, (_, i) => makeUnit({ instanceId: `tired-${i}`, exhausted: true })),
        ...Array.from({ length: counts.readyUnits ?? 0 }, (_, i) => makeUnit({ instanceId: `fresh-${i}`, exhausted: false })),
      ],
    };
    state.players[0]!.activeGear = Array.from({ length: counts.gear ?? 0 }, (_, i) => ({
      ...realGearInstance(A_GEAR),
      instanceId: `gear-${i}`,
      exhausted: true,
    }));
    return { state, gateId: gate.instanceId };
  }

  const listsOffered = (state: GameState) =>
    playsFor(state, ACCELERATION_GATE).map((a) => a.targetUnitInstanceIds ?? []);

  const readyIds = (state: GameState) =>
    (state.battlefields[0]!.units.p1 ?? []).filter((u) => !u.exhausted).map((u) => u.instanceId);

  const readyRunes = (state: GameState) => state.players[0]!.channeled.filter((r) => r.state === "Ready").length;

  it("readies the units it was pointed at", () => {
    const { state } = board({ units: 3 });
    const play = playsFor(state, ACCELERATION_GATE).find((a) => (a.targetUnitInstanceIds ?? []).length === 3);
    expect(play, "no variant chose all three exhausted units").toBeDefined();

    const after = settle(accept(state, play!));
    expect(readyIds(after).sort(), "the chosen units are still exhausted").toEqual(["tired-0", "tired-1", "tired-2"]);
  });

  it("never offers a unit that is already READY", () => {
    // `exhaustedOnly`, new on `unitList` for this card. Without it the card can
    // spend one of its four on a unit with nothing to do, which is the "paying
    // for nothing is never what the player meant" narrowing Jayce's ready-a-gear
    // states the reason for.
    const { state } = board({ units: 1, readyUnits: 2 });
    const offered = new Set(listsOffered(state).flat());

    expect(offered, "the exhausted unit was not offered at all").toContain("tired-0");
    expect([...offered].filter((id) => id.startsWith("fresh")), "a ready unit was offered").toEqual([]);
  });

  it("...and REFUSES one submitted by hand, which is a different site", () => {
    // **The two halves of `exhaustedOnly` are guarded in two places, and neither
    // is observable without the other** — measured, not assumed. Mutating the
    // POOL filter alone leaves the per-set check to reject the same sets, so
    // nothing is offered either way; mutating the CHECK alone leaves the filter
    // to keep them out of the pool, so nothing is offered either way. Mutating
    // BOTH does fail.
    //
    // The test above drives `legalActions` and so can only ever see the offer.
    // This one hands the validator a set the enumerator would never build, which
    // is the check's own consumer: a client is not obliged to have asked.
    const { state } = board({ units: 1, readyUnits: 1 });
    const play = playsFor(state, ACCELERATION_GATE).find((a) => (a.targetUnitInstanceIds ?? []).length === 1);
    expect(play, "no single-unit variant was offered").toBeDefined();

    const forged = { ...play!, targetUnitInstanceIds: ["fresh-0"] };
    const { result } = submit(state, forged as never);
    expect(result, "a hand-built action readied a unit that was already ready").not.toMatchObject({ type: "Ok" });
  });

  it("never offers an ENEMY unit", () => {
    const { state } = board({ units: 1 });
    state.battlefields[1]!.units = { p2: [makeUnit({ instanceId: "theirs", exhausted: true })] };

    expect(listsOffered(state).flat(), "an enemy unit was offered").not.toContain("theirs");
  });

  it("caps the whole card at four, however many are exhausted", () => {
    const { state } = board({ units: 6 });
    for (const list of listsOffered(state)) {
      expect(list.length, `a variant named ${list.length} units`).toBeLessThanOrEqual(4);
    }
    expect(listsOffered(state).some((l) => l.length === 4), "no variant used the full allowance").toBe(true);
  });

  it("spills the LEFTOVER allowance onto gear, then runes", () => {
    // One unit chosen out of four readies, so three are left: two exhausted gear
    // take two of them and the last goes to a rune.
    const { state } = board({ units: 1, gear: 2, exhaustedRunes: 3 });
    const play = playsFor(state, ACCELERATION_GATE).find((a) => (a.targetUnitInstanceIds ?? []).length === 1);
    expect(play, "no single-unit variant was offered").toBeDefined();

    // **Measured ACROSS THE RESOLUTION, not from the starting board**, and that
    // is not tidiness: paying this card's 3 Energy exhausts three runes of its
    // own, so a before/after taken around the whole cast would report the spill
    // as three runes short. `paid` is the state after the payment and before the
    // chain pop.
    const paid = accept(state, play!);
    const readyBefore = readyRunes(paid);
    const after = settle(paid);

    expect(readyIds(after), "the unit was not readied").toEqual(["tired-0"]);
    expect(
      after.players[0]!.activeGear.filter((g) => g.exhausted),
      "the gear did not take the leftover",
    ).toHaveLength(0);
    expect(readyRunes(after) - readyBefore, "the last of the four did not reach a rune").toBe(1);
  });

  it("...and puts the WHOLE allowance into runes when no unit is chosen", () => {
    // The line that makes the model honest: a player who wants four runes readied
    // chooses no units, and the empty choice is really offered (`min: 0`).
    const { state } = board({ exhaustedRunes: 6 });
    const play = playsFor(state, ACCELERATION_GATE).find((a) => (a.targetUnitInstanceIds ?? []).length === 0);
    expect(play, "the empty choice was not offered").toBeDefined();

    const paid = accept(state, play!);
    const readyBefore = readyRunes(paid);
    expect(readyRunes(settle(paid)) - readyBefore, "the whole allowance did not reach the runes").toBe(4);
  });

  it("does as much as it can with fewer than four things (359.3.e.11)", () => {
    const { state } = board({ units: 1 });
    const play = playsFor(state, ACCELERATION_GATE).find((a) => (a.targetUnitInstanceIds ?? []).length === 1);
    const after = settle(accept(state, play!));
    expect(readyIds(after), "the one thing available was not readied").toEqual(["tired-0"]);
  });

  it("reaches a unit in BASE — no location word is printed", () => {
    const { state } = board();
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "at-home", exhausted: true })];

    expect(listsOffered(state).flat(), "a unit in base was not offered").toContain("at-home");
  });
});

describe("Rebuttal (VEN-152): pay to steal, or counter", () => {
  /** p1 has cast `castDefId`; p0 holds a Rebuttal with runes and has passed to
   *  them (345 gives the caster priority on their own spell first). */
  function chainWith(castDefId: string, casterPower = 8): GameState {
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "victim", might: 9 })] };
    state.players[1]!.hand = [spellInstance(castDefId)];
    state.players[1]!.channeled = Array.from({ length: 14 }, (_, i) => rune(`e${i}`, "Fury"));
    state.players[0]!.hand = [spellInstance(REBUTTAL)];
    state.players[0]!.channeled = Array.from({ length: casterPower }, (_, i) => rune(`c${i}`, "Chaos"));

    const cast = playsFor(state, castDefId)[0];
    expect(cast, `${castDefId} was not castable`).toBeDefined();
    const chained = accept(state, cast!);
    const pass = legalActions(chained).find((a) => a.type === "PassFocus" && a.playerIndex === 1);
    expect(pass, "the caster was not offered a pass on their own spell").toBeDefined();
    return accept(chained, pass!);
  }

  /** Passes until a question is parked or the chain shrinks — the Rebuttal's own
   *  resolution is what raises the question, so a test that looked before this
   *  would be looking a whole chain pop too early. */
  function resolveTop(state: GameState): GameState {
    const before = state.spellChain.length;
    let current = state;
    for (let guard = 0; guard < 8; guard += 1) {
      if (current.pendingDecisions.length > 0 || current.spellChain.length < before) return current;
      const pass = legalActions(current).find((a) => a.type === "PassFocus");
      expect(pass, "nobody could pass on the chain").toBeDefined();
      current = accept(current, pass!);
    }
    return current;
  }

  const answer = (state: GameState, optionId: string): GameState => {
    const pending = pendingDecision(state);
    expect(pending, "no question was parked").toBeDefined();
    const option = optionsFor(state, pending!).find((o) => o.id === optionId);
    expect(option, `option ${optionId} was not offered — got ${optionsFor(state, pending!).map((o) => o.id).join(",")}`).toBeDefined();
    return accept(state, {
      type: "AnswerDecision",
      playerIndex: pending!.playerIndex,
      decisionId: pending!.id,
      optionId,
    });
  };

  it("names a spell inside the printed [4] ceiling", () => {
    const chained = chainWith(HEXTECH_RAY);
    const play = playsFor(chained, REBUTTAL)[0];
    expect(play, "Rebuttal was not offered against a 1-Energy spell").toBeDefined();
    expect(play!.targetChainCardInstanceId).toBe(spellEntries(chained)[0]!.card.instanceId);
  });

  it("...and is UNCASTABLE against one over it", () => {
    // Thermo Beam is 5 Energy. `maxPrintedEnergy` reads the PRINTED cost, which
    // is what the rules say every cost check uses.
    const chained = chainWith(THERMO_BEAM);
    expect(chained.spellChain, "the fixture never put a spell on the chain").toHaveLength(1);
    expect(playsFor(chained, REBUTTAL), "Rebuttal reached a spell over its ceiling").toEqual([]);
  });

  it("counters the spell when the caster declines to pay", () => {
    const chained = chainWith(HEXTECH_RAY);
    const target = spellEntries(chained)[0]!.card.instanceId;
    const asked = resolveTop(accept(chained, playsFor(chained, REBUTTAL)[0]!));

    const settled = answer(asked, "counter");
    expect(
      settled.spellChain.filter(isSpellChainEntry).some((e) => e.card.instanceId === target),
      "the spell survived a declined Rebuttal",
    ).toBe(false);
    // The countered spell's effect never happened.
    expect(
      settled.battlefields.flatMap((bf) => bf.units.p2 ?? []).find((u) => u.instanceId === "victim")?.damage,
      "the countered spell still dealt its damage",
    ).toBe(0);
  });

  it("takes control of it when the caster pays [rainbow]", () => {
    const chained = chainWith(HEXTECH_RAY);
    const target = spellEntries(chained)[0]!.card.instanceId;
    const asked = resolveTop(accept(chained, playsFor(chained, REBUTTAL)[0]!));
    const powerBefore = asked.players[0]!.channeled.length;

    const stolen = answer(asked, "steal");
    const entry = stolen.spellChain.filter(isSpellChainEntry).find((e) => e.card.instanceId === target);
    expect(entry, "the spell was countered instead of stolen").toBeDefined();
    expect(entry!.playerIndex, "control did not move to the Rebuttal's caster").toBe(0);
    // One rainbow pip, recycled out of the channeled pool (416).
    expect(stolen.players[0]!.channeled.length, "the [rainbow] was not paid").toBe(powerBefore - 1);
  });

  it("...and then offers the re-choice, which was NOT unimplemented", () => {
    // `gainControlOfSpell`'s own doc claimed this half did not exist. It has
    // worked since Mystic Reversal shipped; this is the assertion that says so
    // for a second card.
    const chained = chainWith(HEXTECH_RAY);
    // A second friendly body for the stolen spell to be re-aimed at — with only
    // the original target on the board there is no choice to make and the
    // question is correctly not asked.
    chained.battlefields[0]!.units = { ...chained.battlefields[0]!.units, p1: [makeUnit({ instanceId: "other" })] };
    const asked = resolveTop(accept(chained, playsFor(chained, REBUTTAL)[0]!));

    const stolen = answer(asked, "steal");
    const retarget = pendingDecision(stolen);
    expect(retarget, "no re-choice was offered after the steal").toBeDefined();
    expect(
      optionsFor(stolen, retarget!).map((o) => o.id),
      "the re-choice did not offer the other unit",
    ).toContain("other");
  });

  it("asks NOTHING extra when there is nothing to re-choose", () => {
    // The control beside the test above, sharing its setup minus the second body.
    // Without it "a question was asked" proves nothing about what asked it.
    const chained = chainWith(HEXTECH_RAY);
    const asked = resolveTop(accept(chained, playsFor(chained, REBUTTAL)[0]!));

    const stolen = answer(asked, "steal");
    expect(pendingDecision(stolen), "a re-choice was raised with no alternative target").toBeUndefined();
  });

  it("just counters, ASKING NOTHING, when the caster cannot pay", () => {
    // 416.3's shape applied to a rule-205 "you may pay": an option that cannot be
    // paid is not offered — and with the steal gone the question has ONE option,
    // which `advanceDecisions` retires without prompting anybody.
    //
    // **That is the assertion, and the first draft got it wrong**: it expected a
    // parked question whose only option was "counter", and a one-option question
    // is precisely what this engine never shows a player. The observable fact is
    // the OUTCOME.
    const chained = chainWith(HEXTECH_RAY, 2);
    const target = spellEntries(chained)[0]!.card.instanceId;
    // Spend the pool down to nothing after the Rebuttal is cast, so the offer is
    // asked of a caster who genuinely has no Power left.
    const cast = accept(chained, playsFor(chained, REBUTTAL)[0]!);
    cast.players[0]!.channeled = [];
    const settled = resolveTop(cast);

    expect(pendingDecision(settled), "a one-option question was put to the player").toBeUndefined();
    expect(
      settled.spellChain.filter(isSpellChainEntry).some((e) => e.card.instanceId === target),
      "the spell was not countered",
    ).toBe(false);
    expect(
      settled.battlefields.flatMap((bf) => bf.units.p2 ?? []).find((u) => u.instanceId === "victim")?.damage,
      "the countered spell still dealt its damage",
    ).toBe(0);
  });
});
