import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isSpellChainEntry, type GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realGearInstance, spellInstance } from "./fixtures.js";

/**
 * **UNL-106 Repulse — "[Reaction] Choose a friendly unit at a battlefield.
 * Counter an enemy spell or ability that chooses it and no other friendly
 * unit."**
 *
 * The pool's only restriction BETWEEN two announced targets, and the PDF uses
 * this card by name as its worked example of announce-time selection.
 *
 * # The refusal was right twice over, and the second half is what this file pins
 *
 * Wave 7 named the mechanism exactly — `chainSpellAndUnit` carried no filter
 * fields, so the constraint had nowhere to live — and it also named, and
 * rejected, the shortcut: approximating Repulse as Not So Fast's
 * `{ kind: "chainSpell", enemyOnly, choosesFriendlyPermanent }`. That is wider
 * than printed in THREE directions, and this file asserts each separately rather
 * than trusting the sentence:
 *
 *   1. a spell choosing the named unit AND a second friendly unit;
 *   2. a spell choosing a friendly GEAR alongside;
 *   3. a friendly unit in BASE (Repulse says "at a battlefield").
 *
 * Only (1) and (3) block the counter. (2) does NOT — the printed word is "unit",
 * and a chosen gear is irrelevant. A test that asserted all three the same way
 * would be describing the shortcut rather than the card.
 */

const registry = defaultCardRegistry();
const REPULSE = "UNL-106";
/** Hextech Ray — 1 Energy 1 Fury, "deal 3 to a unit at a battlefield." A single
 *  unit target, which is the shape Repulse is built to answer. */
const SINGLE_TARGET = "OGN-009";
/** Zenith Blade — chooses an ENEMY unit and may move a FRIENDLY one: the
 *  two-friendly-unit shape lives on `secondTargetUnitInstanceId`. */
const TWO_TARGETS = "OGN-262";

const body = (n: number): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `b${i}`, domain: "Body" as const, state: "Ready" as const }));

/**
 * Player 1 has cast something at player 0's units and it is waiting on the
 * chain; player 0 holds Repulse and can pay for it.
 *
 * The chain entry is hand-built rather than cast, because what Repulse reads is
 * the entry's CHOSEN IDS and building them directly is how each of the three
 * shortcut directions gets its own fixture.
 */
function chainState(chosen: Partial<{
  targetUnitInstanceId: string;
  secondTargetUnitInstanceId: string;
  targetPermanentInstanceId: string;
}>, opts: { casterIndex?: 0 | 1; defId?: string } = {}): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 1, turnState: "Neutral", chainOpen: true });
  state.players[0]!.hand = [spellInstance(REPULSE)];
  state.players[0]!.channeled = body(6);
  state.battlefields[0]!.units = {
    p1: [makeUnit({ instanceId: "mine" }), makeUnit({ instanceId: "ally" })],
    p2: [makeUnit({ instanceId: "theirs" })],
  };
  state.players[0]!.baseUnits = [makeUnit({ instanceId: "homebody" })];
  state.players[0]!.activeGear = [realGearInstance("OGN-143")];
  state.spellChain = [
    {
      card: spellInstance(opts.defId ?? SINGLE_TARGET),
      playerIndex: opts.casterIndex ?? 1,
      ...chosen,
    } as never,
  ];
  state.chainOpen = false;
  state.chainPriority = 0;
  return state;
}

const repulsesOf = (state: GameState): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === REPULSE);

/** The units Repulse is offered as protectable, for a given chain. */
const protectable = (state: GameState) => repulsesOf(state).map((a) => a.targetUnitInstanceId).sort();

describe("what Repulse may be announced against", () => {
  it("offers the unit the enemy spell chose", () => {
    expect(protectable(chainState({ targetUnitInstanceId: "mine" })), "the named unit was not protectable").toEqual([
      "mine",
    ]);
  });

  it("offers NOTHING when the spell chooses a unit it did not name", () => {
    // 355.8 — with no legal pairing there is no legal announcement, so the card
    // is uncastable rather than castable-and-inert.
    const state = chainState({ targetUnitInstanceId: "theirs" });
    expect(repulsesOf(state), "Repulse was castable against a spell aimed at an enemy unit").toHaveLength(0);
  });

  it("DIRECTION 1: refuses a spell that also chooses a SECOND friendly unit", () => {
    // The half that makes this a protection card rather than a general counter,
    // and the first way `choosesFriendlyPermanent` would have been too wide.
    const state = chainState({ targetUnitInstanceId: "mine", secondTargetUnitInstanceId: "ally" }, { defId: TWO_TARGETS });
    expect(repulsesOf(state), "a sweep catching two friendly units was counterable").toHaveLength(0);
  });

  it("DIRECTION 2: a chosen friendly GEAR does NOT block it — the word is 'unit'", () => {
    // The direction that goes the OTHER way, and the reason this file does not
    // simply assert "narrower than Not So Fast" three times. A gear chosen
    // alongside is irrelevant to Repulse.
    const gearId = chainState({}).players[0]!.activeGear[0]!.instanceId;
    const state = chainState({ targetUnitInstanceId: "mine", targetPermanentInstanceId: gearId });

    expect(protectable(state), "a chosen friendly gear wrongly blocked the counter").toEqual(["mine"]);
  });

  it("DIRECTION 3: a friendly unit in BASE is not protectable — 'at a battlefield'", () => {
    // 355.9.b: the printed location word narrows, where a bare noun would have
    // been widened to the whole board by 355.9.a.1.
    const state = chainState({ targetUnitInstanceId: "homebody" });
    expect(repulsesOf(state), "a unit in base was protected by a card that says 'at a battlefield'").toHaveLength(0);
  });

  it("does not counter its controller's OWN spell — 'an ENEMY spell'", () => {
    const state = chainState({ targetUnitInstanceId: "mine" }, { casterIndex: 0 });
    expect(repulsesOf(state), "Repulse countered a friendly spell").toHaveLength(0);
  });

  it("an enemy unit chosen alongside is irrelevant", () => {
    // "No other FRIENDLY unit" — the enemy's own units say nothing about it.
    const state = chainState({ targetUnitInstanceId: "mine", secondTargetUnitInstanceId: "theirs" }, { defId: TWO_TARGETS });
    expect(protectable(state), "an enemy unit chosen alongside blocked the counter").toEqual(["mine"]);
  });
});

describe("the enumerator and the validator agree", () => {
  it("every offered Repulse validates", () => {
    const state = chainState({ targetUnitInstanceId: "mine" });
    const offered = repulsesOf(state);
    expect(offered.length, "nothing was offered — this asserts nothing").toBeGreaterThan(0);
    for (const play of offered) {
      const verdict = validatePlayCard(state, play);
      expect(verdict.ok, verdict.ok ? "" : `offered but refused: ${verdict.error}`).toBe(true);
    }
  });

  it("REFUSES a forged pair the enumerator never offered", () => {
    // The pair check is the validator's to enforce, not something it may take on
    // trust: a client could otherwise protect a unit the spell never chose.
    const state = chainState({ targetUnitInstanceId: "mine" });
    const real = repulsesOf(state)[0]!;
    const forged: PlayCardAction = { ...real, targetUnitInstanceId: "ally" };

    expect(validatePlayCard(state, forged).ok, "a unit the spell never chose was protected").toBe(false);
  });

  it("REFUSES a forged pair against a two-friendly-unit sweep", () => {
    const state = chainState({ targetUnitInstanceId: "mine", secondTargetUnitInstanceId: "ally" }, { defId: TWO_TARGETS });
    const clean = chainState({ targetUnitInstanceId: "mine" });
    const real = repulsesOf(clean)[0]!;
    // Same shape of action, aimed at the sweeping chain.
    // The sweeping entry is a Spell by construction here; narrowed rather than
    // cast, because `ChainEntry` is a union and only its Spell arm has a `card`.
    const sweeping = state.spellChain[0]!;
    const forged: PlayCardAction = {
      ...real,
      targetChainCardInstanceId: isSpellChainEntry(sweeping) ? sweeping.card.instanceId : "",
    };

    expect(validatePlayCard(state, forged).ok, "the sweep was counterable by a forged play").toBe(false);
  });
});

describe("resolving it", () => {
  /** Passes focus until the chain is empty. */
  function drain(state: GameState): GameState {
    let settled = state;
    for (let guard = 0; guard < 12 && settled.spellChain.length > 0; guard += 1) {
      const pass = legalActions(settled).find((a) => a.type === "PassFocus");
      if (!pass) break;
      settled = submit(settled, pass).state;
    }
    return settled;
  }

  const stillStanding = (state: GameState, id: string) =>
    (state.battlefields[0]!.units.p1 ?? []).some((u) => u.instanceId === id);

  it("stops the countered spell's EFFECT, measured against an uncountered control", () => {
    // **The first version of this test asserted the spell was gone from the chain
    // and was VACUOUS** — a spell that RESOLVES also leaves the chain, so it read
    // the same either way. Mutation caught it: deleting the counter entirely left
    // it green.
    //
    // What distinguishes the two is whether the effect happened. Hextech Ray deals
    // 3 to the unit it chose and the fixture's units are 3 Might, so uncountered
    // it KILLS — survival is the measurement, and the control is the identical
    // board with no Repulse cast.
    const state = chainState({ targetUnitInstanceId: "mine" });

    const uncountered = drain(state);
    expect(stillStanding(uncountered, "mine"), "the CONTROL failed — the enemy spell killed nothing anyway").toBe(false);

    const { state: cast, result } = submit(state, repulsesOf(state)[0]!);
    expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
    const countered = drain(cast);

    expect(stillStanding(countered, "mine"), "the countered spell still killed its target").toBe(true);
  });
});

describe("coverage", () => {
  it("reports the card finished", () => {
    const def = registry.get(REPULSE);
    expect(isCardImplemented(def), "it still reports unfinished").toBe(true);
    expect(partialImplementationNote(def), "it carries a partial note").toBeUndefined();
  });
});
