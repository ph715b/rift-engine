import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { Domain } from "../src/model/domain.js";
import type { RuneCard } from "../src/model/rune.js";
import type { PlayCardAction, PlayerAction } from "../src/actions/player-action.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, realGearInstance, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * The first six Unleashed cards in effects/order.ts.
 *
 * Everything here goes through `legalActions` -> `submit`, never a resolver
 * closure. That is not ceremony: a card is registered in one table and reached
 * through two or three dispatch hops (enumeration, the chain, and for three of
 * these six a question raised mid-resolution), and every hop is somewhere the
 * effect can be dropped without the card looking broken. A test that called
 * `cardEffects["UNL-180"].resolve` would clear all of them at once.
 *
 * Each `describe` also asserts `isCardImplemented`, because registration is per
 * defId and that is the only instrument the coverage report reads.
 *
 * **That coverage assertion is weaker than it looks for the two cards whose
 * implementation is partly a DECISION**, and it was measured rather than
 * assumed: de-registering Starhound's on-play trigger and the Shard's
 * death-watch leaves both still reporting IMPLEMENTED, because
 * `decisionDefIds` peels the defId off `UNL-167-return` / `UNL-174-kill` and
 * `isCardImplemented` is satisfied by ANY source claiming the id. That is the
 * documented behaviour of the instrument, not a defect here — but it means the
 * behavioural tests below are the only thing proving those two cards work, and
 * they are what went red under the same mutation.
 */

const registry = defaultCardRegistry();

const THE_RUINATION = "UNL-180";
const SCRUTINIZING_SERGEANT = "UNL-157";
const SOUL_HARVEST = "UNL-159";
const STARHOUND = "UNL-167";
const SHARD_OF_UNDOING = "UNL-174";
const BLACK_ROSE_DIGNITARY = "UNL-152";

/** Enough Ready runes of a card's own Power domain to pay for it outright.
 *  Energy is domain-agnostic, so one colour covers both halves — the dearest
 *  here is The Ruination at 9 Energy + 3 Power. */
function runesFor(defId: string, count = 24): RuneCard[] {
  const domain: Domain = registry.get(defId).powerDomain ?? "Order";
  return Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));
}

/** A rune deck to channel FROM — Black Rose Dignitary's Deathknell draws on it,
 *  and an empty one channels nothing at all (315.3.b.1), which would read exactly
 *  like the Deathknell never firing. */
function runeDeck(prefix: string, count = 4): RuneCard[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-deck-${i}`, domain: "Order" as const, state: "Ready" as const }));
}

/** Every enumerated way to play one card instance. An explicit predicate rather
 *  than leaning on TS 5.5's inferred one, so the narrowing is visible to a
 *  reader and cannot quietly stop working on a compiler bump. */
function castsOf(state: GameState, instanceId: string): PlayCardAction[] {
  return legalActions(state).filter(
    (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId,
  );
}

/**
 * Plays a card and passes Focus until the chain is empty.
 *
 * A Spell takes effect on the chain and a Unit's on-play ability is a Chain
 * Pending Item, so asserting straight after `submit` reads an unresolved chain
 * as a dead card. Stops on a pending question, since `submit` refuses a
 * PassFocus while one is outstanding (320.1).
 */
function castAndResolve(state: GameState, action: PlayerAction | undefined): GameState {
  expect(action, "the card was never enumerated as playable").toBeDefined();
  const submitted = submit(state, action!);
  expect(submitted.result, "the play was refused").toEqual({ type: "Ok" });
  return passUntilSettled(submitted.state);
}

/** Passes Focus until nothing is left on the chain or in the holding pen. */
function passUntilSettled(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 16; guard += 1) {
    if (current.pendingDecisions.length > 0) return current;
    if (current.spellChain.length === 0 && current.pendingTriggers.length === 0) return current;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) return current;
    current = submit(current, pass).state;
  }
  throw new Error("passUntilSettled: the chain never emptied");
}

/** Answers the pending question by option id, through `submit`. */
function answer(state: GameState, optionId: string): GameState {
  const decision = pendingDecision(state);
  expect(decision, "no question was pending").toBeDefined();
  const result = submit(state, { type: "AnswerDecision", playerIndex: decision!.playerIndex, decisionId: decision!.id, optionId });
  expect(result.result, `the answer "${optionId}" was refused`).toEqual({ type: "Ok" });
  return passUntilSettled(result.state);
}

/** The labels currently on offer. */
function offered(state: GameState): string[] {
  const decision = pendingDecision(state);
  expect(decision, "no question was pending").toBeDefined();
  return optionsFor(state, decision!).map((o) => o.label);
}

/** The option with this label, by id. */
function optionLabelled(state: GameState, label: string): string {
  const decision = pendingDecision(state)!;
  const option = optionsFor(state, decision).find((o) => o.label === label);
  expect(option, `"${label}" was not on offer (saw ${offered(state).join(", ")})`).toBeDefined();
  return option!.id;
}

describe("The Ruination (UNL-180): kill all units", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(THE_RUINATION))).toBe(true);
  });

  /** The spell in p1's hand, with bodies scattered across base and battlefields
   *  on both sides. Deliberately never both players at the SAME battlefield —
   *  that would stage a Showdown and this card has nothing to do with combat. */
  function ruinationState() {
    const spell = spellInstance(THE_RUINATION);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runesFor(THE_RUINATION);
    state.players[0]!.baseUnits = [makeUnit({ name: "Mine at home" })];
    state.players[1]!.baseUnits = [makeUnit({ name: "Theirs at home" })];
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Mine forward" })] };
    state.battlefields[1]!.units = { p2: [makeUnit({ name: "Theirs forward" })] };
    return { state, spellId: spell.instanceId };
  }

  it("empties both bases and both battlefields", () => {
    // "Unit" with no location named refers to objects on the Board (355.10.a.1),
    // and a Base is on the Board — so this is NOT the rules' own "kill all units
    // at battlefields" example, and a resolver that only walked
    // `state.battlefields` would leave two units standing.
    const { state, spellId } = ruinationState();

    const after = castAndResolve(state, castsOf(state, spellId)[0]);

    expect(after.players[0]!.baseUnits).toEqual([]);
    expect(after.players[1]!.baseUnits).toEqual([]);
    expect(after.battlefields[0]!.units["p1"] ?? []).toEqual([]);
    expect(after.battlefields[1]!.units["p2"] ?? []).toEqual([]);
    expect(after.players[0]!.trash.map((c) => c.name).sort()).toEqual(["Mine at home", "Mine forward", "The Ruination"]);
    expect(after.players[1]!.trash.map((c) => c.name).sort()).toEqual(["Theirs at home", "Theirs forward"]);
  });

  it("fires EVERY [Deathknell] in the wipe, once each", () => {
    // The mass-death case the batch has to survive: four Black Rose Dignitaries,
    // two per side, all killed by one instruction. Each is held separately (383
    // fixes the whole set at the moment of the event) and each resolves on its
    // own chain pop, so the instrument is the rune count — one exhausted rune
    // channelled per corpse, and NOT one per player or one for the batch.
    const spell = spellInstance(THE_RUINATION);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runesFor(THE_RUINATION);
    state.players[0]!.runeDeck = runeDeck("p1");
    state.players[1]!.runeDeck = runeDeck("p2");
    state.players[0]!.baseUnits = [realUnitInstance(BLACK_ROSE_DIGNITARY), realUnitInstance(BLACK_ROSE_DIGNITARY)];
    state.players[1]!.baseUnits = [realUnitInstance(BLACK_ROSE_DIGNITARY), realUnitInstance(BLACK_ROSE_DIGNITARY)];

    const channeledBefore = state.players[0]!.channeled.length;
    const after = castAndResolve(state, castsOf(state, spell.instanceId)[0]);

    expect(after.players[0]!.baseUnits).toEqual([]);
    expect(after.players[1]!.baseUnits).toEqual([]);
    // Counted by ID PREFIX, not by rune-deck LENGTH. Paying a Power cost recycles
    // the spent rune back into the rune deck (416), so p1's deck ends LONGER than
    // it started and a length assertion would measure the payment rather than the
    // Deathknells. The `-deck-` runes are the only ones a channel can reach.
    expect(after.players[0]!.runeDeck.filter((r) => r.id.startsWith("p1-deck-"))).toHaveLength(runeDeck("p1").length - 2);
    expect(after.players[1]!.runeDeck.filter((r) => r.id.startsWith("p2-deck-"))).toHaveLength(runeDeck("p2").length - 2);
    // Exhausted, not Ready — the whole difference between this and a free rune.
    const channelledBy = (index: 0 | 1, prefix: string) =>
      after.players[index]!.channeled.filter((r) => r.id.startsWith(prefix) && r.state === "Exhausted");
    expect(channelledBy(0, "p1-deck-")).toHaveLength(2);
    expect(channelledBy(1, "p2-deck-")).toHaveLength(2);
    expect(channeledBefore).toBeGreaterThan(0);
  });
});

describe("Black Rose Dignitary (UNL-152): [Deathknell] channel 1 rune exhausted", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(BLACK_ROSE_DIGNITARY))).toBe(true);
  });

  it("channels for its OWN controller when an enemy spell kills it", () => {
    // The attribution that a Deathknell gets wrong most easily: `ctx.casterIndex`
    // is the DYING unit's controller, not whoever killed it. Killed here by the
    // opponent's Soul Harvest, so a resolver reading the killer would hand the
    // rune to the wrong player and this assertion would invert.
    const spell = spellInstance(SOUL_HARVEST);
    const dignitary = realUnitInstance(BLACK_ROSE_DIGNITARY);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runesFor(SOUL_HARVEST);
    state.players[0]!.runeDeck = runeDeck("p1");
    state.players[1]!.runeDeck = runeDeck("p2");
    state.battlefields[0]!.units = { p2: [dignitary] };

    const cast = castsOf(state, spell.instanceId).find((a) => a.targetUnitInstanceId === dignitary.instanceId);
    const after = castAndResolve(state, cast);

    expect(after.battlefields[0]!.units["p2"] ?? []).toEqual([]);
    expect(after.players[1]!.channeled).toHaveLength(1);
    expect(after.players[1]!.channeled[0]!.state).toBe("Exhausted");
    expect(after.players[1]!.channeled[0]!.id).toBe("p2-deck-0");
    // The killer's own channel deck is untouched. By ID rather than by length:
    // the Power this spell cost was recycled INTO p1's rune deck, so its length
    // went up and would report a gain that has nothing to do with the Deathknell.
    expect(
      after.players[0]!.channeled.filter((r) => r.id.startsWith("p1-deck-")),
      "the killer must gain nothing",
    ).toEqual([]);
    expect(after.players[0]!.runeDeck.filter((r) => r.id.startsWith("p1-deck-"))).toHaveLength(runeDeck("p1").length);
  });
});

describe("Soul Harvest (UNL-159): kill a unit at a battlefield with 3 Might or less", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(SOUL_HARVEST))).toBe(true);
  });

  function harvestState() {
    const spell = spellInstance(SOUL_HARVEST);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runesFor(SOUL_HARVEST);
    return { state, spellId: spell.instanceId };
  }

  it("kills the chosen unit at a battlefield", () => {
    const { state, spellId } = harvestState();
    const victim = makeUnit({ name: "Small", might: 3 });
    state.battlefields[0]!.units = { p2: [victim] };

    const cast = castsOf(state, spellId).find((a) => a.targetUnitInstanceId === victim.instanceId);
    const after = castAndResolve(state, cast);

    expect(after.battlefields[0]!.units["p2"] ?? []).toEqual([]);
    expect(after.players[1]!.trash.map((c) => c.name)).toEqual(["Small"]);
  });

  it("never offers a 4-Might unit", () => {
    // A legal victim stands beside the illegal one on purpose: without it this
    // would pass just as happily if the spell were never enumerated at all,
    // which is the shape of a filter test that measures nothing.
    const { state, spellId } = harvestState();
    const big = makeUnit({ name: "Big", might: 4 });
    const small = makeUnit({ name: "Small", might: 3 });
    state.battlefields[0]!.units = { p2: [big, small] };

    const targets = castsOf(state, spellId).map((a) => a.targetUnitInstanceId);
    expect(targets).toContain(small.instanceId);
    expect(targets).not.toContain(big.instanceId);
  });

  it("never offers a unit in BASE — 'at a battlefield' is printed", () => {
    // The one load-bearing word on this card. With scope left at "anywhere" a
    // unit sheltering at home would be a legal target, which is Vengeance's
    // reading of a different sentence. Same live control as above: the forward
    // unit must be offered, so an absent offer cannot pass for a filter.
    const { state, spellId } = harvestState();
    const athome = makeUnit({ name: "At home", might: 1 });
    const forward = makeUnit({ name: "Forward", might: 1 });
    state.players[1]!.baseUnits = [athome];
    state.battlefields[0]!.units = { p2: [forward] };

    const targets = castsOf(state, spellId).map((a) => a.targetUnitInstanceId);
    expect(targets).toContain(forward.instanceId);
    expect(targets).not.toContain(athome.instanceId);
  });

  it("reaches a FRIENDLY unit too — the card names no side", () => {
    const { state, spellId } = harvestState();
    const mine = makeUnit({ name: "Mine", might: 2 });
    state.battlefields[0]!.units = { p1: [mine] };

    const cast = castsOf(state, spellId).find((a) => a.targetUnitInstanceId === mine.instanceId);
    const after = castAndResolve(state, cast);

    expect(after.battlefields[0]!.units["p1"] ?? []).toEqual([]);
    expect(after.players[0]!.trash.map((c) => c.name)).toContain("Mine");
  });
});

describe("Scrutinizing Sergeant (UNL-157): gain 1 XP for each friendly unit", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(SCRUTINIZING_SERGEANT))).toBe(true);
  });

  /** The Sergeant in hand, with `friends` already in play for p1 and one enemy
   *  unit that must NOT be counted. */
  function sergeantState(friends: number) {
    const sergeant = realUnitInstance(SCRUTINIZING_SERGEANT);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [sergeant];
    state.players[0]!.channeled = runesFor(SCRUTINIZING_SERGEANT);
    state.players[0]!.baseUnits = Array.from({ length: friends }, (_, i) => makeUnit({ name: `Friend ${i}` }));
    state.players[1]!.baseUnits = [makeUnit({ name: "Theirs" })];
    return { state, sergeantId: sergeant.instanceId };
  }

  it("counts the friendly board INCLUDING himself", () => {
    // Two friends plus the Sergeant is 3, not 2 — an on-play trigger already has
    // its own card on the board, and he prints no "other".
    const { state, sergeantId } = sergeantState(2);
    expect(state.players[0]!.xp).toBe(0);

    const after = castAndResolve(state, castsOf(state, sergeantId)[0]);

    expect(after.players[0]!.baseUnits).toHaveLength(3);
    expect(after.players[0]!.xp).toBe(3);
    expect(after.players[1]!.xp, "the opponent gains nothing").toBe(0);
  });

  it("gains 1 on an empty board — himself, and nothing else", () => {
    const { state, sergeantId } = sergeantState(0);

    const after = castAndResolve(state, castsOf(state, sergeantId)[0]);

    expect(after.players[0]!.xp).toBe(1);
  });

  it("counts a unit at a battlefield as well as one at home", () => {
    // "Friendly unit" names no battlefield (355.9.b), so a unit in the fight and
    // one asleep at home are worth the same.
    const { state, sergeantId } = sergeantState(1);
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Forward" })] };

    const after = castAndResolve(state, castsOf(state, sergeantId)[0]);

    expect(after.players[0]!.xp).toBe(3);
  });
});

describe("Starhound (UNL-167): return a Bird, Cat, Dog, or Poro from your trash", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(STARHOUND))).toBe(true);
  });

  /** Starhound in hand with `trash` already in p1's trash. */
  function starhoundState(trash: ReturnType<typeof makeUnit>[]) {
    const starhound = realUnitInstance(STARHOUND);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [starhound];
    state.players[0]!.channeled = runesFor(STARHOUND);
    state.players[0]!.trash = trash;
    return { state, starhoundId: starhound.instanceId };
  }

  const poro = () => makeUnit({ name: "Poro Pal", tags: ["Poro"] });
  const bird = () => makeUnit({ name: "Bird Pal", tags: ["Bird", "Noxus"] });
  const untagged = () => makeUnit({ name: "Nobody", tags: ["Noxus"] });

  it("offers only the four tribes, and no decline", () => {
    // "Return", not "you may return" — the absence of a Decline option is the
    // one thing separating this question from Spectral Matron's.
    const { state, starhoundId } = starhoundState([poro(), untagged(), bird()]);

    const asked = castAndResolve(state, castsOf(state, starhoundId)[0]);

    expect(pendingDecision(asked)!.kind).toBe("UNL-167-return");
    expect(offered(asked)).toEqual(["Poro Pal", "Bird Pal"]);
  });

  it("moves the chosen card from trash to hand", () => {
    const { state, starhoundId } = starhoundState([poro(), untagged(), bird()]);
    const asked = castAndResolve(state, castsOf(state, starhoundId)[0]);

    const after = answer(asked, optionLabelled(asked, "Bird Pal"));

    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["Bird Pal"]);
    expect(after.players[0]!.trash.map((c) => c.name)).toEqual(["Poro Pal", "Nobody"]);
  });

  it("asks nothing at all when the trash holds no tribe", () => {
    const { state, starhoundId } = starhoundState([untagged()]);

    const after = castAndResolve(state, castsOf(state, starhoundId)[0]);

    expect(after.pendingDecisions).toHaveLength(0);
    expect(after.players[0]!.hand).toEqual([]);
    expect(after.players[0]!.trash.map((c) => c.name)).toEqual(["Nobody"]);
  });

  it("returns the sole candidate without a prompt", () => {
    const { state, starhoundId } = starhoundState([poro(), untagged()]);

    const after = castAndResolve(state, castsOf(state, starhoundId)[0]);

    expect(after.pendingDecisions).toHaveLength(0);
    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["Poro Pal"]);
  });
});

describe("Shard of Undoing (UNL-174): the first friendly death in your Beginning Phase", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(SHARD_OF_UNDOING))).toBe(true);
  });

  /**
   * A board one Pass away from p1's Beginning Phase, with the Shard in p1's gear
   * row and `doomed` [Temporary] units of p1's about to expire in it.
   *
   * The Pass is the whole point: `runBeginning`'s `killTemporaryPermanents` is
   * the only thing in this engine that kills a unit in that phase (816's "before
   * scoring"), so it is the real firing site rather than a hand-built death.
   * p2 is the active player, so passing rotates the turn to p1 and it is p1's
   * own Beginning Phase that runs.
   */
  function shardState(doomed: number, theirUnits: string[]) {
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.players[0]!.activeGear = [realGearInstance(SHARD_OF_UNDOING)];
    state.players[0]!.baseUnits = Array.from({ length: doomed }, (_, i) =>
      makeUnit({ name: `Fading ${i}`, keywords: { Temporary: 1 } }),
    );
    // A card each to draw, so `runDraw` neither Burns Out nor hands anyone a
    // point in the middle of the measurement.
    state.players[0]!.deck = [makeUnit({ name: "Draw me" })];
    state.players[1]!.deck = [makeUnit({ name: "Draw them" })];
    state.players[1]!.baseUnits = theirUnits.map((name) => makeUnit({ name }));
    return state;
  }

  function pass(state: GameState): GameState {
    const result = submit(state, { type: "Pass", playerIndex: state.activePlayerIndex });
    expect(result.result, "the Pass was refused").toEqual({ type: "Ok" });
    return passUntilSettled(result.state);
  }

  it("makes the opponent kill one of their own units", () => {
    const state = shardState(1, ["Theirs A", "Theirs B"]);

    const asked = pass(state);

    expect(asked.activePlayerIndex, "the turn rotated to the Shard's controller").toBe(0);
    expect(pendingDecision(asked)?.kind).toBe("UNL-174-kill");
    expect(pendingDecision(asked)!.playerIndex, "the OPPONENT answers").toBe(1);
    expect(offered(asked)).toEqual(["Theirs A", "Theirs B"]);

    const after = answer(asked, optionLabelled(asked, "Theirs B"));

    expect(after.players[1]!.baseUnits.map((u) => u.name)).toEqual(["Theirs A"]);
    expect(after.players[1]!.trash.map((c) => c.name)).toEqual(["Theirs B"]);
    // The Shard's controller loses only the [Temporary] unit that expired.
    expect(after.players[0]!.baseUnits).toEqual([]);
  });

  it("fires ONCE when two friendly units die in the same Beginning Phase", () => {
    // "The FIRST TIME ... each turn". Two [Temporary] units expiring together is
    // the reachable version of the condition, and the opponent must lose exactly
    // one unit, not two.
    const state = shardState(2, ["Theirs A", "Theirs B", "Theirs C"]);

    const asked = pass(state);

    expect(pendingDecision(asked)?.kind).toBe("UNL-174-kill");
    const after = answer(asked, optionLabelled(asked, "Theirs A"));

    expect(after.pendingDecisions, "a second demand would be a double-fire").toHaveLength(0);
    expect(after.players[1]!.baseUnits.map((u) => u.name)).toEqual(["Theirs B", "Theirs C"]);
  });

  it("does not fire for a death outside the Beginning Phase", () => {
    // The negative control the phase condition exists for. Same board, same
    // Shard, but the friendly unit dies to a spell in the ACTION phase — where
    // almost every death in a real game happens — so the gear must stay silent.
    const spell = spellInstance(SOUL_HARVEST);
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [realGearInstance(SHARD_OF_UNDOING)];
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runesFor(SOUL_HARVEST);
    const mine = makeUnit({ name: "Mine", might: 2 });
    state.battlefields[0]!.units = { p1: [mine] };
    state.players[1]!.baseUnits = [makeUnit({ name: "Theirs A" }), makeUnit({ name: "Theirs B" })];

    const cast = castsOf(state, spell.instanceId).find((a) => a.targetUnitInstanceId === mine.instanceId);
    const after = castAndResolve(state, cast);

    expect(after.players[0]!.trash.map((c) => c.name)).toContain("Mine");
    expect(after.pendingDecisions).toHaveLength(0);
    expect(after.players[1]!.baseUnits.map((u) => u.name)).toEqual(["Theirs A", "Theirs B"]);
  });

  it("does not fire for an ENEMY death in that phase", () => {
    // "A FRIENDLY unit", measured against the SHARD's controller. p2 is the
    // active player, so it is p2's Beginning Phase and p2's [Temporary] unit
    // that dies — neither half of the condition holds for p1's Shard.
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.activeGear = [realGearInstance(SHARD_OF_UNDOING)];
    state.players[0]!.baseUnits = [makeUnit({ name: "Mine" })];
    state.players[1]!.baseUnits = [makeUnit({ name: "Fading", keywords: { Temporary: 1 } })];
    state.players[0]!.deck = [makeUnit({ name: "Draw me" })];
    state.players[1]!.deck = [makeUnit({ name: "Draw them" })];

    const after = pass(state);

    expect(after.activePlayerIndex).toBe(1);
    expect(after.players[1]!.trash.map((c) => c.name)).toEqual(["Fading"]);
    expect(after.pendingDecisions).toHaveLength(0);
    expect(after.players[0]!.baseUnits.map((u) => u.name)).toEqual(["Mine"]);
  });
});
