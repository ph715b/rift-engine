import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { executePassFocus } from "../src/actions/execute-pass-focus.js";
import { makeState, makeUnit, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * **UNL-181 Jhin - Virtuoso — "When you play a spell, if you spent [4] or more,
 * you may banish it. Then, if there are four spells banished with me, put each
 * in its trash, channel 4 runes, and draw 1."**
 *
 * Refused in waves 5, 7 and 8 on two blockers, both real and both closed:
 *
 *   1. **`spellCast` carried no card identity.** True, and the reason is worth
 *      keeping: every listener on that event before him reads only a PRICE
 *      (Lux's "costs 5 or more", Revna's "you spent 4 or more"), so nothing had
 *      ever needed to know WHICH card. He acts on it. `spellInstanceId`.
 *   2. **No "banished with me" zone.** True, and wave 5 was precise about why a
 *      count off `PlayerState.banished` would be wrong — Arcane Shift, Void Rush
 *      and Time Warp all write that flat list and would poison it.
 *      `LegendInstance.banishedInstanceIds`, the field `GearInstance` already
 *      carries for The Zero Drive.
 *
 * A third was named in wave 7 and was never a blocker: "Jhin is additionally a
 * Legend (legend-abilities.ts)". `listeningPermanents` has ended with
 * `owner.legend` since long before he was refused — it is how Lux - Illuminated
 * hears this very event — so being a Legend cost him nothing.
 *
 * # What is deliberately NOT re-argued here
 *
 * The `energySpent` reading. Revna the Lorekeeper prints the same clause, landed
 * first, and `unl-fury-wave7.test.ts` plus her own registry entry carry the whole
 * argument for why `totalCost` and `maxSpellEnergySpentThisTurn` are both wrong.
 * One boundary case is asserted below to prove he is wired to the same figure,
 * not to restate her case.
 */

const registry = defaultCardRegistry();
const JHIN = "UNL-181";
/** 4 Energy, 0 Power — spending exactly the printed threshold. */
const BIG_SPELL = "OGN-085"; // Sunburst — "Deal 6 to a unit at a battlefield."
/**
 * **2 Energy + 2 Fury Power** — Falling Star. Chosen precisely because its
 * PRINTED total is 4 while the Energy spent on it is 2, which is the exact case
 * `spellCast.totalCost` gets wrong and Revna's entry warns about. A plain cheap
 * spell reads under 4 on both figures and cannot tell the two apart.
 */
const POWER_HEAVY_SPELL = "OGN-029";
/** 1 Energy, 1 Fury Power — under the threshold on every reading. */
const SMALL_SPELL = "OGN-009"; // Hextech Ray

const fury = (n: number): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `f${i}`, domain: "Fury" as const, state: "Ready" as const }));

/** Jhin as player 0's Legend, with runes, a target for the spells to point at,
 *  and a rune deck deep enough for his channel to be measurable. */
function jhinState(hand: string[]): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0, turnState: "Neutral", chainOpen: true });
  state.players[0]!.legend = { ...state.players[0]!.legend, defId: JHIN, name: "Jhin - Virtuoso" };
  state.players[0]!.hand = hand.map((id) => spellInstance(id));
  // Deep enough for FIVE casts at 4 Energy each. Twenty is exactly five casts'
  // worth and ran dry on the fifth, which surfaces as "not playable" and reads
  // identically to Jhin failing to fire — so the pool is oversized on purpose.
  state.players[0]!.channeled = fury(30);
  state.players[0]!.runeDeck = fury(12).map((r, i) => ({ ...r, id: `deck${i}` }));
  state.players[0]!.deck = [spellInstance(SMALL_SPELL), spellInstance(SMALL_SPELL)];
  // Big enough to survive four Sunbursts. Damage accumulates across casts, so a
  // target that dies partway through simply stops the spell being playable — and
  // "not playable" would then be mistaken for Jhin not firing.
  state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "target", might: 99 })] };
  return state;
}

const accept = (state: GameState, action: unknown): GameState => {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
};

/** Plays the first copy of `defId` from hand and settles to whatever Jhin asks. */
function castSpell(state: GameState, defId: string): GameState {
  return castWatching(state, defId).settled;
}

/**
 * `castSpell`, plus every trigger defId that was ever seen waiting on the chain
 * while it settled.
 *
 * **The chain has to be watched rather than inspected at the end**, because a
 * trigger that fires and then declines to do anything is indistinguishable from
 * one that never fired once the chain has drained. That distinction is exactly
 * where Jhin's two guards live: `applies` decides whether an item is placed, and
 * `resolve` re-checks the same conditions in case the board moved underneath it.
 * Mutating `applies` alone leaves `resolve` refusing, so the ability does nothing
 * either way — and an end-state assertion cannot tell the two apart. It is still
 * a real difference: a spurious item opens a response window and shows in the
 * chain viewer.
 */
function castWatching(state: GameState, defId: string): { settled: GameState; sawTriggers: string[] } {
  const play = legalActions(state).find((a) => a.type === "PlayCard" && a.card.defId === defId);
  expect(play, `${defId} was not playable — the fixture measures nothing`).toBeDefined();
  const sawTriggers = new Set<string>();
  const record = (s: GameState) => {
    for (const t of s.pendingTriggers) sawTriggers.add(t.listenerDefId);
    for (const e of s.spellChain) if ("kind" in e && e.kind === "trigger") sawTriggers.add(e.listenerDefId);
  };
  // The same loop `fixtures.resolveHeldTriggers` runs, stepped one pop at a time
  // so the chain can be read BETWEEN pops. Calling that helper instead settles
  // all the way in one go and the item is gone before anything can see it, which
  // is how the first version of this watcher came back empty.
  let current = runCleanup(accept(state, play));
  record(current);
  for (let guard = 0; guard < 32; guard += 1) {
    if (current.pendingDecisions.length > 0 || current.chainOpen) break;
    current = runCleanup(executePassFocus(current, { type: "PassFocus", playerIndex: current.chainPriority }));
    record(current);
  }
  return { settled: current, sawTriggers: [...sawTriggers] };
}

/** Answers Jhin's question — `banish` true takes the spell, false declines. */
function answerJhin(state: GameState, banish: boolean): GameState {
  const decision = pendingDecision(state);
  expect(decision?.kind, "Jhin asked nothing").toBe("UNL-181-banish");
  const options = optionsFor(state, decision!);
  const chosen = banish ? options.find((o) => o.id !== "decline") : options.find((o) => o.id === "decline");
  expect(chosen, `no ${banish ? "banish" : "decline"} option was offered`).toBeDefined();
  return resolveHeldTriggers(
    accept(state, {
      type: "AnswerDecision",
      playerIndex: decision!.playerIndex,
      decisionId: decision!.id,
      optionId: chosen!.id,
    }),
  );
}

const withJhin = (state: GameState) => state.players[0]!.legend.banishedInstanceIds ?? [];
const trashIds = (state: GameState) => state.players[0]!.trash.map((c) => c.instanceId).sort();
const banishedIds = (state: GameState) => state.players[0]!.banished.map((c) => c.instanceId).sort();

describe("the offer: when you play a spell, if you spent 4 or more", () => {
  it("asks after a 4-Energy spell", () => {
    expect(pendingDecision(castSpell(jhinState([BIG_SPELL]), BIG_SPELL))?.kind).toBe("UNL-181-banish");
  });

  it("does NOT ask after a spell whose PRINTED total is 4 but whose Energy is 2", () => {
    // **Both wrong readings in one measurement**, which is why this uses Falling
    // Star (2 Energy + 2 Power) rather than a plain cheap spell:
    //
    //   - `totalCost` is 4 here, so a version reading it asks;
    //   - `maxSpellEnergySpentThisTurn` is 4 from the earlier cast, so a version
    //     reading THAT asks too.
    //
    // Only `energySpent` — this spell's own Energy, after discounts — says 2.
    // Revna's registry entry carries the full argument; this is the boundary that
    // proves Jhin is wired to the same figure. A 1-Energy spell reads under 4 on
    // every one of the three and would prove none of it.
    const afterBig = answerJhin(castSpell(jhinState([BIG_SPELL, POWER_HEAVY_SPELL]), BIG_SPELL), false);
    const cheap = castWatching(afterBig, POWER_HEAVY_SPELL);

    expect(pendingDecision(cheap.settled), "a 2-Energy spell was offered to Jhin").toBeUndefined();
    // And it never even reached the chain. Without this the assertion above also
    // holds when only `resolve`'s re-check refuses, which leaves a real chain item
    // and a real response window for an ability that cannot do anything.
    expect(cheap.sawTriggers, "Jhin was placed on the chain for a 2-Energy spell").not.toContain(JHIN);
  });

  it("does not ask the OPPONENT's caster", () => {
    const state = jhinState([]);
    state.players[1]!.hand = [spellInstance(BIG_SPELL)];
    state.players[1]!.channeled = fury(30);
    state.activePlayerIndex = 1;
    state.focusHolder = 1;
    state.chainPriority = 1;

    const enemy = castWatching(state, BIG_SPELL);

    expect(pendingDecision(enemy.settled), "Jhin fired on an enemy spell").toBeUndefined();
    expect(enemy.sawTriggers, "Jhin was placed on the chain for an enemy spell").not.toContain(JHIN);
  });

  it("IS placed on the chain for his own 4-Energy spell — the control for both", () => {
    // Without this, the two "not on the chain" assertions above pass just as well
    // against a watcher that never sees anything.
    expect(castWatching(jhinState([BIG_SPELL]), BIG_SPELL).sawTriggers, "the watcher is dead").toContain(JHIN);
  });
});

describe("banishing WITH him, and the flat banish zone that must not be confused with it", () => {
  it("moves the spell out of the trash and records it on the LEGEND", () => {
    const state = jhinState([BIG_SPELL]);
    const spellId = state.players[0]!.hand[0]!.instanceId;

    const after = answerJhin(castSpell(state, BIG_SPELL), true);

    expect(trashIds(after), "the spell stayed in the trash").not.toContain(spellId);
    expect(banishedIds(after), "it never reached the banish zone").toContain(spellId);
    expect(withJhin(after), "it was not attached to Jhin").toEqual([spellId]);
  });

  it("declining leaves it in the trash and attaches nothing", () => {
    const state = jhinState([BIG_SPELL]);
    const spellId = state.players[0]!.hand[0]!.instanceId;

    const after = answerJhin(castSpell(state, BIG_SPELL), false);

    expect(trashIds(after), "declining banished it anyway").toContain(spellId);
    expect(withJhin(after), "declining still attached it").toEqual([]);
  });

  it("counts only what was banished WITH HIM, not the whole banish zone", () => {
    // **The blocker wave 5 named, asserted directly.** Three cards already sitting
    // in the flat `banished` list — the shape Arcane Shift, Void Rush and Time Warp
    // leave behind — plus one banished with Jhin is FOUR in `PlayerState.banished`
    // and ONE with him. A count off the flat list would pay out here.
    const state = jhinState([BIG_SPELL]);
    state.players[0]!.banished = [spellInstance(SMALL_SPELL), spellInstance(SMALL_SPELL), spellInstance(SMALL_SPELL)];
    const runesBefore = state.players[0]!.channeled.length;

    const after = answerJhin(castSpell(state, BIG_SPELL), true);

    expect(state.players[0]!.banished.length + 1, "the fixture does not reach four in the flat zone").toBe(4);
    expect(withJhin(after), "the flat zone leaked into his count").toHaveLength(1);
    expect(after.players[0]!.channeled.length, "the payout fired on the flat count").toBe(runesBefore);
  });
});

describe("the payout: four spells banished with me", () => {
  /** Casts and banishes `n` big spells, returning the settled state. */
  function banishSpells(n: number): GameState {
    let state = jhinState(Array.from({ length: n }, () => BIG_SPELL));
    for (let i = 0; i < n; i += 1) state = answerJhin(castSpell(state, BIG_SPELL), true);
    return state;
  }

  it("does NOT fire at three", () => {
    const three = banishSpells(3);
    expect(withJhin(three), "three were not banished with him").toHaveLength(3);
    expect(banishedIds(three).length, "they came back early").toBe(3);
  });

  it("at FOUR, returns all four to the trash, channels 4 and draws 1", () => {
    const before = jhinState([]);
    const after = banishSpells(4);

    expect(withJhin(after), "the set was not cleared — a fifth spell would fire it again").toEqual([]);
    expect(after.players[0]!.banished, "the four did not leave the banish zone").toHaveLength(0);
    expect(after.players[0]!.trash, "they did not come back to the trash").toHaveLength(4);
    expect(
      after.players[0]!.channeled.length - before.players[0]!.channeled.length,
      "it did not channel 4 runes",
    ).toBe(4);
    expect(before.players[0]!.deck.length - after.players[0]!.deck.length, "it did not draw 1").toBe(1);
  });

  it("channels them READY, not exhausted", () => {
    // The distinction Obelisk of Power and Startipped Peak exist on either side
    // of. Jhin's card prints a bare "channel 4 runes".
    //
    // Measured on the four runes that ARRIVED, not on the whole pool: casting
    // four spells exhausts sixteen of the twenty the fixture starts with, so a
    // pool-wide "all ready" assertion would be false however Jhin channels.
    const three = banishSpells(3);
    const four = banishSpells(4);
    const arrived = four.players[0]!.channeled.slice(three.players[0]!.channeled.length);

    expect(arrived, "four runes did not arrive").toHaveLength(4);
    expect(arrived.every((r) => r.state === "Ready"), "they arrived exhausted").toBe(true);
  });

  it("starts a FRESH set of four afterwards rather than firing every spell", () => {
    // The bug a payout that did not clear the list would have: the fifth banish
    // would see five, the sixth six, and cash in forever. Driven as five casts
    // from one fixture rather than by rebuilding a hand, so the fifth is played
    // off the same board the fourth left behind.
    let state = jhinState(Array.from({ length: 5 }, () => BIG_SPELL));
    for (let i = 0; i < 4; i += 1) state = answerJhin(castSpell(state, BIG_SPELL), true);
    const trashAfterPayout = state.players[0]!.trash.length;

    const after = answerJhin(castSpell(state, BIG_SPELL), true);

    expect(withJhin(after), "the fifth did not start a new set").toHaveLength(1);
    // The fifth is banished, so it LEAVES the trash — a second payout would put
    // four more cards back into it instead.
    expect(after.players[0]!.trash.length, "the fifth cashed in on its own").toBe(trashAfterPayout);
  });
});

describe("coverage", () => {
  it("reports the card finished", () => {
    const def = registry.get(JHIN);
    expect(isCardImplemented(def), "he still reports unfinished").toBe(true);
    expect(partialImplementationNote(def), "he carries a partial note").toBeUndefined();
  });
});
