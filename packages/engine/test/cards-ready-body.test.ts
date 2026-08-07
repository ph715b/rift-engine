import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { effectForCard, cardModeOf } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { Domain } from "../src/model/domain.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayerAction } from "../src/actions/player-action.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * The Body cards landed from docs/dead-card-survey.md's cluster 1.
 *
 * Everything that CAN go through `submit` does, and each test asserts the effect
 * FIRED rather than that the call returned. That is not belt-and-braces here: a
 * card registered in a per-domain effects file has already once been reachable by
 * name and never dispatched, and a test calling the resolver closure would have
 * passed throughout. Where a resolver is called directly below it is said so
 * explicitly, with the reason.
 */

const registry = defaultCardRegistry();
const WALLOP = "OGN-146"; // Body spell, 2 Energy
const OVERT_OPERATION = "OGN-153"; // Body spell, 5 Energy + 2 Body Power
const SNAPVINE = "OGN-149"; // Body unit, 5 Energy + 2 Body Power, 6 Might

/** `count` Ready runes of one domain — Energy pays from any domain, Power does not. */
const runes = (domain: Domain, count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

/**
 * Plays `action` and drives the game to a settled board through `submit` alone —
 * passing Focus until the chain empties, and answering every question `pick`
 * decides on the way.
 *
 * Both loops are needed together and interleaved: Overt Operation parks its
 * questions DURING chain resolution, and `submit` refuses a PassFocus while one
 * is outstanding (323.2.a), so a helper that drained the chain first and the
 * questions afterwards would deadlock on exactly the card it is here for.
 */
function playThrough(
  state: GameState,
  action: PlayerAction,
  pick: (options: { id: string; label: string }[]) => string = (options) => options[0]!.id,
): GameState {
  const first = submit(state, action);
  expect(first.result, `the play itself was rejected: ${JSON.stringify(first.result)}`).toEqual({ type: "Ok" });
  let current = first.state;

  for (let guard = 0; guard < 32; guard += 1) {
    const decision = pendingDecision(current);
    if (decision) {
      const answer = submit(current, {
        type: "AnswerDecision",
        playerIndex: decision.playerIndex,
        decisionId: decision.id,
        optionId: pick(optionsFor(current, decision)),
      });
      expect(answer.result, `answering ${decision.kind} was rejected`).toEqual({ type: "Ok" });
      current = answer.state;
      continue;
    }
    if (current.spellChain.length === 0) return current;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) break;
    current = submit(current, pass).state;
  }
  expect(current.spellChain, "the chain never resolved").toHaveLength(0);
  expect(current.pendingDecisions, "a question was never answered").toHaveLength(0);
  return current;
}

/** The PlayCard action for `instanceId` that `legalActions` actually offers,
 *  narrowed by `where` — going through the enumerator rather than hand-building
 *  an action is what makes these tests prove the card is REACHABLE. */
function playOf(state: GameState, instanceId: string, where: (a: PlayerAction) => boolean = () => true): PlayerAction {
  const action = legalActions(state).find(
    (a) => a.type === "PlayCard" && a.card.instanceId === instanceId && where(a),
  );
  expect(action, `no legal play of ${instanceId} was enumerated`).toBeDefined();
  return action!;
}

/**
 * Wallop (OGN-146): "[Action] As you play this, you may spend a buff as an
 * additional cost. If you do, ignore this spell's cost. Ready a unit."
 *
 * HALF-LANDED. The "Ready a unit" clause is live and tested through `submit`
 * below. The optional additional cost is not: it needs a one-line entry in
 * card-effects.ts's OPTIONAL_UNIT_COSTS, which this test file's author did not
 * own. The two tests at the end of this block pin exactly where the seam is.
 */
describe("Wallop (OGN-146): ready a unit", () => {
  /** Wallop in hand, `runeCount` Body runes, and an exhausted unit to ready. */
  function wallopState(runeCount = 4): { state: GameState; spell: ReturnType<typeof spellInstance> } {
    const spell = spellInstance(WALLOP);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runes("Body", runeCount);
    state.players[0]!.baseUnits = [
      makeUnit({ name: "Tired", instanceId: "tired", exhausted: true }),
      makeUnit({ name: "Buffed", instanceId: "buffed", buffed: true }),
    ];
    return { state, spell };
  }

  it("readies the chosen unit, cast and resolved through submit", () => {
    const { state, spell } = wallopState();

    const after = playThrough(
      state,
      playOf(state, spell.instanceId, (a) => a.type === "PlayCard" && a.targetUnitInstanceId === "tired"),
    );

    expect(after.players[0]!.baseUnits.find((u) => u.instanceId === "tired")!.exhausted).toBe(false);
    expect(after.players[0]!.trash.map((c) => c.defId)).toEqual([WALLOP]); // it really resolved
  });

  it("reaches a unit in EITHER base — 'a unit' names no battlefield (355.9.b)", () => {
    const { state, spell } = wallopState();
    state.players[1]!.baseUnits = [makeUnit({ name: "Theirs", instanceId: "theirs", exhausted: true })];

    // Enumerated at all is the assertion: readying an enemy unit is a bad play,
    // not an illegal one, and a "battlefield"-scoped spec would never offer it.
    const after = playThrough(
      state,
      playOf(state, spell.instanceId, (a) => a.type === "PlayCard" && a.targetUnitInstanceId === "theirs"),
    );

    expect(after.players[1]!.baseUnits[0]!.exhausted).toBe(false);
  });

  it("readies a unit standing at a battlefield too", () => {
    const { state, spell } = wallopState();
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Forward", instanceId: "forward", exhausted: true })] };

    const after = playThrough(
      state,
      playOf(state, spell.instanceId, (a) => a.type === "PlayCard" && a.targetUnitInstanceId === "forward"),
    );

    expect(after.battlefields[0]!.units["p1"]![0]!.exhausted).toBe(false);
  });

  /**
   * The cost half, which was a TRIPWIRE for the missing OPTIONAL_UNIT_COSTS entry
   * and is now the real thing: `"OGN-146": { kind: "spendBuffFriendly",
   * ignoresCostWhenPaid: true }` landed in card-effects.ts, so the paid variant is
   * enumerated and the branch below is reachable through `submit`.
   *
   * "Ignore this spell's cost" is Call to Glory's shape (811): the payment is
   * EMPTY, not merely small, which is why the no-runes fixture is the honest test
   * — a discount would still need runes and this must not.
   */
  it("is castable with NO runes at all once a buff is spent for it", () => {
    const { state, spell } = wallopState(0); // no runes: only the free-cast mode can exist
    const plays = legalActions(state).filter((a) => a.type === "PlayCard" && a.card.instanceId === spell.instanceId);

    expect(plays.length, "the buff-spending variant is not enumerated").toBeGreaterThan(0);
    for (const play of plays) {
      expect(play.type === "PlayCard" && play.additionalCostUnitInstanceId).toBe("buffed");
      expect(play.type === "PlayCard" && play.payment).toEqual({ energyRunes: [], powerRunes: [] });
    }
  });

  it("spends the buff and readies the target, through the real submit path", () => {
    // Previously reachable only through `effectForCard(...).resolve` — the branch
    // had no legal action that could carry the field. It has one now, so this
    // drives the dispatch hop rather than the resolver.
    const { state, spell } = wallopState(0);

    const after = playThrough(
      state,
      playOf(state, spell.instanceId, (a) => a.type === "PlayCard" && a.targetUnitInstanceId === "tired"),
    );

    expect(after.players[0]!.baseUnits.find((u) => u.instanceId === "buffed")!.buffed).toBe(false); // 704.1
    expect(after.players[0]!.baseUnits.find((u) => u.instanceId === "tired")!.exhausted).toBe(false);
    expect(after.players[0]!.channeled).toEqual([]); // nothing was there to spend, and nothing was needed
    expect(after.players[0]!.trash.map((c) => c.defId)).toEqual([WALLOP]); // it really resolved
  });

  it("is not castable at all with no unit anywhere to ready", () => {
    // A SPELL's targeting is its effect, so "no legal target" means "can't cast"
    // — the opposite of a Unit's on-play trigger, which is allowed to fizzle
    // rather than hold the body hostage (legal-actions' `card.kind === "Unit"`
    // fallback). Wallop has no other clause, so there is nothing left to do.
    const { state, spell } = wallopState();
    state.players[0]!.baseUnits = [];

    const plays = legalActions(state).filter((a) => a.type === "PlayCard" && a.card.instanceId === spell.instanceId);
    expect(plays).toEqual([]);
  });
});

/**
 * Overt Operation (OGN-153): "[Action] For each friendly unit, you may spend its
 * buff to ready it. Then buff all friendly units."
 *
 * Two things are being measured, and neither is visible from the other: that each
 * "you may" is a REAL question the player answers, and that the mass buff lands
 * strictly AFTER every answer.
 */
describe("Overt Operation (OGN-153): spend buffs to ready, then buff everything", () => {
  /** Overt Operation in hand with the runes for it, over a board of `units`. */
  function overtState(units: ReturnType<typeof makeUnit>[]): { state: GameState; spell: ReturnType<typeof spellInstance> } {
    const spell = spellInstance(OVERT_OPERATION);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runes("Body", 8); // 5 Energy + 2 Body Power
    state.players[0]!.baseUnits = units;
    return { state, spell };
  }

  const byId = (state: GameState, instanceId: string) =>
    state.players[0]!.baseUnits.find((u) => u.instanceId === instanceId)!;

  it("asks per buffed unit, readies the ones spent, and buffs everything afterwards", () => {
    const state0 = overtState([
      makeUnit({ name: "Buffed+Tired", instanceId: "a", buffed: true, exhausted: true }),
      makeUnit({ name: "Plain+Tired", instanceId: "b", exhausted: true }),
    ]).state;
    const spellId = state0.players[0]!.hand[0]!.instanceId;

    const after = playThrough(state0, playOf(state0, spellId), (options) => {
      const spend = options.find((o) => o.id === "spend");
      return spend ? spend.id : options[0]!.id;
    });

    // The buff was spent to ready it...
    expect(byId(after, "a").exhausted).toBe(false);
    // ...and the unbuffed one had nothing to spend, so it stayed exhausted.
    expect(byId(after, "b").exhausted).toBe(true);
    // "Then buff ALL friendly units" — including the one whose buff just paid.
    expect(byId(after, "a").buffed).toBe(true);
    expect(byId(after, "b").buffed).toBe(true);
    expect(after.players[0]!.trash.map((c) => c.defId)).toEqual([OVERT_OPERATION]);
  });

  it("declining leaves the unit exhausted — and it keeps the buff it did not spend", () => {
    const state0 = overtState([makeUnit({ name: "Buffed+Tired", instanceId: "a", buffed: true, exhausted: true })]).state;
    const spellId = state0.players[0]!.hand[0]!.instanceId;

    // The counter is what makes this test able to fail. Exhausted-and-buffed is
    // also what an INERT card leaves behind, so without proof that the question
    // was really asked this would go green against a Wallop-shaped no-op.
    let asked = 0;
    const after = playThrough(state0, playOf(state0, spellId), (options) => {
      asked += 1;
      const decline = options.find((o) => o.id === "decline");
      return decline ? decline.id : options[0]!.id;
    });

    expect(asked, "the 'you may' was never put to the player").toBe(1);
    expect(byId(after, "a").exhausted).toBe(true);
    expect(byId(after, "a").buffed).toBe(true); // 708 makes the mass buff a no-op here
  });

  it("offers exactly one question per BUFFED friendly unit and none for the rest", () => {
    // The count is the assertion. An unbuffed unit has no payable side (705), so
    // asking about it would be a fake choice; an enemy buffed unit is not
    // "friendly" and must not be asked about at all (705.1).
    const state0 = overtState([
      makeUnit({ instanceId: "a", buffed: true }),
      makeUnit({ instanceId: "b", buffed: true }),
      makeUnit({ instanceId: "c" }),
    ]).state;
    state0.players[1]!.baseUnits = [makeUnit({ instanceId: "theirs", buffed: true })];

    const resolved = cardModeOf(spellInstance(OVERT_OPERATION), undefined)!.resolve(state0, contextFor(0), {});

    const spends = resolved.pendingDecisions.filter((d) => d.kind === "OGN-153-spend");
    expect(spends.map((d) => d.targetInstanceId)).toEqual(["a", "b"]);
    // ...with the mass buff queued BEHIND them, which is the whole of "then".
    expect(resolved.pendingDecisions[resolved.pendingDecisions.length - 1]!.kind).toBe("OGN-153-buff-all");
  });

  it("reaches units at battlefields, not just base", () => {
    const state0 = overtState([]).state;
    state0.battlefields[0]!.units = {
      p1: [makeUnit({ name: "Forward", instanceId: "fwd", buffed: true, exhausted: true })],
    };
    const spellId = state0.players[0]!.hand[0]!.instanceId;

    const after = playThrough(state0, playOf(state0, spellId), (options) => options[options.length - 1]!.id);

    const forward = after.battlefields[0]!.units["p1"]![0]!;
    expect(forward.exhausted).toBe(false);
    expect(forward.buffed).toBe(true);
  });

  it("asks nothing at all with no buffed units, and still buffs the board", () => {
    // A one-option question is not a question (advanceDecisions), so the player is
    // never interrupted — but the "then" clause must still fire.
    const state0 = overtState([makeUnit({ instanceId: "a" }), makeUnit({ instanceId: "b" })]).state;
    const spellId = state0.players[0]!.hand[0]!.instanceId;

    const after = playThrough(state0, playOf(state0, spellId), () => {
      throw new Error("no question should have been asked");
    });

    expect(byId(after, "a").buffed).toBe(true);
    expect(byId(after, "b").buffed).toBe(true);
  });

  it("never buffs an ENEMY unit", () => {
    const state0 = overtState([makeUnit({ instanceId: "a" })]).state;
    state0.players[1]!.baseUnits = [makeUnit({ instanceId: "theirs" })];
    const spellId = state0.players[0]!.hand[0]!.instanceId;

    const after = playThrough(state0, playOf(state0, spellId));

    expect(byId(after, "a").buffed).toBe(true);
    expect(after.players[1]!.baseUnits[0]!.buffed).toBe(false);
  });
});

/**
 * Carnivorous Snapvine (OGN-149): "When you play me, choose an enemy unit at a
 * battlefield. We deal damage equal to our Mights to each other."
 *
 * Played through `submit` so the on-play dispatch hop is exercised, not just the
 * resolver — that hop is precisely where a per-domain Unit once silently died.
 */
describe("Carnivorous Snapvine (OGN-149): duel an enemy unit at a battlefield", () => {
  // Read off a real instance rather than hardcoded, so a data change moves the
  // expectation instead of leaving a stale number that happens to still pass.
  const SNAPVINE_MIGHT = realUnitInstance(SNAPVINE).might;

  /** The Snapvine in hand with the runes for it, and `enemy` standing at bf1. */
  function snapvineState(enemyMight: number): { state: GameState; snapvineId: string; enemyId: string } {
    const snapvine = realUnitInstance(SNAPVINE);
    const enemy = makeUnit({ name: "Prey", instanceId: "prey", might: enemyMight });
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [snapvine];
    state.players[0]!.channeled = runes("Body", 8); // 5 Energy + 2 Body Power
    state.battlefields[0]!.units = { p2: [enemy] };
    return { state, snapvineId: snapvine.instanceId, enemyId: enemy.instanceId };
  }

  it("marks the enemy with the Snapvine's Might when it survives", () => {
    expect(SNAPVINE_MIGHT).toBe(6); // the card data this test's numbers are read off
    const { state, snapvineId, enemyId } = snapvineState(9);

    const after = playThrough(
      state,
      playOf(state, snapvineId, (a) => a.type === "PlayCard" && a.targetUnitInstanceId === enemyId),
    );

    expect(after.battlefields[0]!.units["p2"]![0]!.damage).toBe(SNAPVINE_MIGHT);
    // ...and took 9 back, which killed it on the way in.
    expect(after.players[0]!.baseUnits).toHaveLength(0);
    expect(after.players[0]!.trash.map((c) => c.defId)).toEqual([SNAPVINE]);
  });

  it("still takes the dead enemy's full Might back — both Mights are snapshotted first", () => {
    // The ordering the shared `unitsDuel` exists to protect: a 2-Might victim
    // killed outright by the Snapvine's 6 must STILL land its own 2. Reading Might
    // after the first damage would find it in the trash and deal nothing back.
    const { state, snapvineId, enemyId } = snapvineState(2);

    const after = playThrough(
      state,
      playOf(state, snapvineId, (a) => a.type === "PlayCard" && a.targetUnitInstanceId === enemyId),
    );

    expect(after.battlefields[0]!.units["p2"] ?? []).toHaveLength(0); // the prey died
    expect(after.players[0]!.baseUnits[0]!.damage).toBe(2); // and bit back anyway
  });

  it("cannot be aimed at a unit in the opponent's BASE — 'at a battlefield' is printed", () => {
    // The distinction this codebase gets wrong in the widening direction: reading
    // the scope as "anywhere" silently makes the card strictly better.
    const { state, snapvineId } = snapvineState(4);
    state.players[1]!.baseUnits = [makeUnit({ name: "AtHome", instanceId: "athome", might: 4 })];

    const targets = legalActions(state)
      .filter((a) => a.type === "PlayCard" && a.card.instanceId === snapvineId)
      .map((a) => (a.type === "PlayCard" ? a.targetUnitInstanceId : undefined));

    expect(targets).toContain("prey");
    expect(targets).not.toContain("athome");
  });

  it("never offers a FRIENDLY unit — 'an enemy unit' is printed", () => {
    const { state, snapvineId } = snapvineState(4);
    state.battlefields[1]!.units = { p1: [makeUnit({ name: "Mine", instanceId: "mine" })] };

    const targets = legalActions(state)
      .filter((a) => a.type === "PlayCard" && a.card.instanceId === snapvineId)
      .map((a) => (a.type === "PlayCard" ? a.targetUnitInstanceId : undefined));

    expect(targets).not.toContain("mine");
  });

  it("deploys and fights nobody when the board offers no enemy at a battlefield", () => {
    // targetOmissionAllowed: the Unit is still playable, and its trigger must
    // no-op rather than throw.
    const { state, snapvineId } = snapvineState(4);
    state.battlefields[0]!.units = {};

    const after = playThrough(state, playOf(state, snapvineId));

    expect(after.players[0]!.baseUnits.map((u) => u.defId)).toEqual([SNAPVINE]);
    expect(after.players[0]!.baseUnits[0]!.damage).toBe(0);
  });
});

describe("coverage counts the newly-landed Body cards", () => {
  // Wallop is in this list on the strength of its "Ready a unit" clause alone —
  // registration is per defId, so a half-written card reports as whole. The right
  // fix is a coverage.ts PARTIALLY_IMPLEMENTED entry for OGN-146 ("the optional
  // buff-spending cost that ignores the printed cost is not registered"), which
  // this file's author did not own. Adding it will turn this test red: move
  // OGN-146 down into the block below when you do.
  it("reports Wallop, Overt Operation and Carnivorous Snapvine as implemented", () => {
    for (const id of [WALLOP, OVERT_OPERATION, SNAPVINE]) {
      expect(isCardImplemented(registry.get(id)), `${id} (${registry.get(id).name})`).toBe(true);
    }
  });

  it("reports Anivia and Warwick as implemented too, now their attack triggers have landed", () => {
    // Both needed unit-triggers.ts, outside effects/body.ts, so they were pinned
    // as NOT landed while this file was written. They have since landed (Warwick
    // also needed card-loader.ts for his "I enter ready" half); the behaviour is
    // covered by cards-attack-triggers.test.ts, and this only guards the count.
    for (const id of ["OGN-148", "OGN-159"]) {
      expect(isCardImplemented(registry.get(id)), `${id} (${registry.get(id).name})`).toBe(true);
    }
  });

  it("reports Herald of Scales as implemented, now the cost modifier has landed", () => {
    // The last of the six, and the one that needed cost-modifiers.ts: "your
    // Dragons' Energy costs are reduced by 2, to a minimum of 1" is continuous,
    // so it cannot live in an effect registry. Behaviour is covered by
    // cost-modifiers.test.ts; this only guards the count.
    expect(isCardImplemented(registry.get("OGN-140"))).toBe(true);
  });
});
