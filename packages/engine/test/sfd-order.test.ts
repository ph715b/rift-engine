import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { destroyUnit } from "../src/engine/effect-helpers.js";
import { holdUnitDied } from "../src/engine/triggers.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance, type UnitInstance } from "../src/model/card.js";
import type { Domain } from "../src/model/domain.js";
import type { RuneCard } from "../src/model/rune.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayerAction } from "../src/actions/player-action.js";
import {
  beginCombatAt,
  makeState,
  makeUnit,
  playUnitTrigger,
  realUnitInstance,
  resolveHeldTriggers,
  spellInstance,
} from "./fixtures.js";

/**
 * The Spiritforged (SFD) cards implemented in `effects/order.ts`.
 *
 * Everything with an action behind it is driven through `legalActions` ->
 * `submit`, never a resolver closure: three of these cards do their work through
 * a pending DECISION raised mid-resolution, which is several dispatch hops from
 * the action, and a test that called the resolver would clear every one of them.
 * The trigger-only cards go through the HOLD path (`playUnitTrigger`,
 * `resolveHeldTriggers`, `beginCombatAt`), which is the same chain a real game
 * runs them on.
 *
 * Each `describe` opens with a coverage assertion — cheap, and it is what catches
 * a card being renamed or re-filed out from under its implementation.
 */

const registry = defaultCardRegistry();

const GUARDS = "SFD-154";
const ROYAL_GUARD = "SFD-157";
const SANDSHIFTER = "SFD-158";
const DEATHGRIP = "SFD-163";
const UNSUNG_HERO = "SFD-167";
const ALTAR_OF_MEMORIES = "SFD-169";
const REKSAI_SWARM_QUEEN = "SFD-170";
const UNDERTITAN = "SFD-175";
const AZIR_SOVEREIGN = "SFD-177";
const CORINA_VERAZA = "SFD-179";

const HEXTECH_RAY = "OGN-009"; // a cheap Spell, for stocking a deck or a hand

function runes(domain: Domain, count: number): RuneCard[] {
  return Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));
}

function accept(state: GameState, action: PlayerAction | undefined, what: string): GameState {
  expect(action, `${what} was never enumerated`).toBeDefined();
  const { state: next, result } = submit(state, action!);
  expect(result, `${what} was refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** Plays a Spell and passes Focus until it RESOLVES — a Spell takes effect on the
 *  chain, so asserting straight after `submit` reads an unresolved chain as a
 *  broken card. Stops at a question, since `submit` refuses a PassFocus while one
 *  is pending (323.2.a). */
function castAndResolve(state: GameState, action: PlayerAction | undefined, what: string): GameState {
  let current = accept(state, action, what);
  for (let guard = 0; guard < 8 && current.spellChain.length > 0; guard += 1) {
    if (current.pendingDecisions.length > 0) break;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) break;
    current = accept(current, pass, "PassFocus");
  }
  return current;
}

/** Answers the pending question through `submit`, so the answer is one the game
 *  would really accept rather than a direct call into decisions.ts. */
function answer(state: GameState, optionId: string): GameState {
  const decision = pendingDecision(state);
  expect(decision, "no question was pending").toBeDefined();
  return accept(
    state,
    { type: "AnswerDecision", playerIndex: decision!.playerIndex, decisionId: decision!.id, optionId },
    `the answer "${optionId}"`,
  );
}

/** The option ids currently on offer. */
function offeredIds(state: GameState): string[] {
  const decision = pendingDecision(state);
  expect(decision, "no question was pending").toBeDefined();
  return optionsFor(state, decision!).map((o) => o.id);
}

/** Every unit `playerIndex` has in play, base and battlefields alike. */
function unitsOf(state: GameState, playerIndex: 0 | 1): UnitInstance[] {
  const actor = state.players[playerIndex]!;
  return [...actor.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[actor.id] ?? [])];
}

const unitsAt = (state: GameState, battlefieldId: string, playerId: string): UnitInstance[] =>
  state.battlefields.find((bf) => bf.id === battlefieldId)!.units[playerId] ?? [];

// ── Guards! (SFD-154) ────────────────────────────────────────────────────────

describe("Guards! (SFD-154): a Sand Soldier token, and an optional Order to ready it", () => {
  /** Guards! in hand with `orderRunes` channeled — 3 pay the Energy, the rest are
   *  what the ready costs. */
  function guardsState(orderRunes: number): { state: GameState; spellId: string } {
    const spell = spellInstance(GUARDS);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runes("Order", orderRunes);
    return { state, spellId: spell.instanceId };
  }

  const castGuards = (state: GameState, spellId: string) =>
    castAndResolve(
      state,
      legalActions(state).find((a) => a.type === "PlayCard" && a.card.instanceId === spellId),
      "Guards!",
    );

  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(GUARDS))).toBe(true);
  });

  it("plays a 2-Might Sand Soldier, exhausted, into the caster's base", () => {
    const { state, spellId } = guardsState(4);
    const after = castGuards(state, spellId);
    const tokens = after.players[0]!.baseUnits.filter((u) => u.isToken);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.name).toBe("Sand Soldier");
    expect(tokens[0]!.might).toBe(2);
    // 143.4.a — a token enters exhausted like any other unit; the card's second
    // sentence is what buys its readiness.
    expect(tokens[0]!.exhausted).toBe(true);
  });

  it("offers the [Order] payment and readies the token when it is paid", () => {
    const { state, spellId } = guardsState(4);
    const asked = castGuards(state, spellId);
    expect(pendingDecision(asked)?.kind).toBe("SFD-154-ready");
    expect(offeredIds(asked)).toEqual(["decline", "pay"]);

    const runesBefore = asked.players[0]!.channeled.length;
    const paid = answer(asked, "pay");
    expect(paid.players[0]!.baseUnits.find((u) => u.isToken)!.exhausted).toBe(false);
    // The Power payment RECYCLES the rune (416), so the channeled pool shrinks.
    expect(paid.players[0]!.channeled.length).toBe(runesBefore - 1);
  });

  it("leaves the token exhausted when the payment is declined, and takes nothing", () => {
    const { state, spellId } = guardsState(4);
    const asked = castGuards(state, spellId);
    const runesBefore = asked.players[0]!.channeled.length;
    const declined = answer(asked, "decline");
    expect(declined.players[0]!.baseUnits.find((u) => u.isToken)!.exhausted).toBe(true);
    expect(declined.players[0]!.channeled.length).toBe(runesBefore);
  });

  it("does not offer a payment there are no runes for — and still makes the token", () => {
    // Exactly the Energy and nothing over: the three runes are spent paying for
    // the spell... but a Power cost recycles a rune whatever its state, so the
    // real "cannot pay" case is an empty pool. Floating Energy pays the 3 instead.
    const spell = spellInstance(GUARDS);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.floatingEnergy = 3;
    const after = castGuards(state, spell.instanceId);
    // No question at all: the only answer would have been "decline", and
    // advanceDecisions retires a one-option question without prompting.
    expect(pendingDecision(after)).toBeUndefined();
    expect(after.players[0]!.baseUnits.filter((u) => u.isToken)).toHaveLength(1);
  });
});

// ── Royal Guard (SFD-157) ────────────────────────────────────────────────────

describe("Royal Guard (SFD-157): a Sand Soldier where HE landed", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(ROYAL_GUARD))).toBe(true);
  });

  it("makes the token at the battlefield he was played to", () => {
    const guard = realUnitInstance(ROYAL_GUARD);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units["p1"] = [guard];
    const after = playUnitTrigger(state, guard, 0, { battlefieldId: "bf1" });

    const here = unitsAt(after, "bf1", "p1").filter((u) => u.isToken);
    expect(here).toHaveLength(1);
    expect(here[0]!.name).toBe("Sand Soldier");
    expect(here[0]!.might).toBe(2);
    expect(unitsAt(after, "bf2", "p1")).toHaveLength(0);
  });

  it("makes it in BASE when he was played to base", () => {
    const guard = realUnitInstance(ROYAL_GUARD);
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [guard];
    const after = playUnitTrigger(state, guard, 0, "base");
    expect(after.players[0]!.baseUnits.filter((u) => u.isToken)).toHaveLength(1);
    expect(unitsAt(after, "bf1", "p1")).toHaveLength(0);
  });
});

// ── Sandshifter (SFD-158) ────────────────────────────────────────────────────

describe("Sandshifter (SFD-158): kill an enemy unit with 3 Might or less", () => {
  /** Sandshifter in hand, with `enemyMights` worth of enemy units in the
   *  opponent's BASE — the scope the card's silence about battlefields implies. */
  function shifterState(enemyMights: number[]): { state: GameState; unitId: string } {
    const shifter = realUnitInstance(SANDSHIFTER);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [shifter];
    state.players[0]!.channeled = runes("Order", 8);
    state.players[1]!.baseUnits = enemyMights.map((might) => makeUnit({ might, name: `Enemy ${might}` }));
    return { state, unitId: shifter.instanceId };
  }

  const castsOf = (state: GameState, instanceId: string) =>
    legalActions(state).filter((a) => a.type === "PlayCard" && a.card.instanceId === instanceId);

  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(SANDSHIFTER))).toBe(true);
  });

  it("kills the chosen enemy — through the real play, not the resolver", () => {
    const { state, unitId } = shifterState([3]);
    const victimId = state.players[1]!.baseUnits[0]!.instanceId;
    const play = castsOf(state, unitId).find((a) => a.type === "PlayCard" && a.targetUnitInstanceId === victimId);
    const after = resolveHeldTriggers(accept(state, play, "Sandshifter"));
    expect(after.players[1]!.baseUnits).toHaveLength(0);
    expect(after.players[1]!.trash.map((c) => c.instanceId)).toContain(victimId);
  });

  it("does not offer a 4-Might enemy as a target", () => {
    const { state, unitId } = shifterState([4]);
    const targeted = castsOf(state, unitId).filter((a) => a.type === "PlayCard" && a.targetUnitInstanceId !== undefined);
    expect(targeted).toHaveLength(0);
  });

  it("offers the 3-Might one and not the 5-Might one when both are there", () => {
    const { state, unitId } = shifterState([3, 5]);
    const offered = castsOf(state, unitId)
      .flatMap((a) => (a.type === "PlayCard" && a.targetUnitInstanceId ? [a.targetUnitInstanceId] : []))
      .map((id) => state.players[1]!.baseUnits.find((u) => u.instanceId === id)!.might);
    expect(offered).toEqual([3]);
  });
});

// ── Deathgrip (SFD-163) ─────────────────────────────────────────────────────

describe("Deathgrip (SFD-163): kill a friendly unit, pass its Might on, draw 1", () => {
  /** Deathgrip in hand with two friendly units of the given Mights in base. */
  function gripState(mights: number[]): { state: GameState; spellId: string; units: UnitInstance[] } {
    const spell = spellInstance(DEATHGRIP);
    const units = mights.map((might, i) => makeUnit({ might, name: `Friend ${i}` }));
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runes("Order", 4);
    state.players[0]!.baseUnits = units;
    state.players[0]!.deck = [spellInstance(HEXTECH_RAY), spellInstance(HEXTECH_RAY)];
    return { state, spellId: spell.instanceId, units };
  }

  const castsOf = (state: GameState, instanceId: string) =>
    legalActions(state).filter((a) => a.type === "PlayCard" && a.card.instanceId === instanceId);

  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(DEATHGRIP))).toBe(true);
  });

  it("kills the first target and gives the second its Might this turn", () => {
    const { state, spellId, units } = gripState([6, 2]);
    const play = castsOf(state, spellId).find(
      (a) =>
        a.type === "PlayCard" &&
        a.targetUnitInstanceId === units[0]!.instanceId &&
        a.secondTargetUnitInstanceId === units[1]!.instanceId,
    );
    const after = castAndResolve(state, play, "Deathgrip");

    expect(after.players[0]!.baseUnits.map((u) => u.instanceId)).toEqual([units[1]!.instanceId]);
    // +6, the victim's Might read before it died.
    expect(after.players[0]!.baseUnits[0]!.mightThisTurn).toBe(6);
    expect(after.players[0]!.hand).toHaveLength(1); // the draw
  });

  it("reads the victim's EFFECTIVE Might, not its printed one", () => {
    const { state, spellId, units } = gripState([6, 2]);
    // A buff (+1, rule 710) and a pump: 6 printed becomes 9.
    state.players[0]!.baseUnits[0] = { ...units[0]!, buffed: true, mightThisTurn: 2 };
    const play = castsOf(state, spellId).find(
      (a) =>
        a.type === "PlayCard" &&
        a.targetUnitInstanceId === units[0]!.instanceId &&
        a.secondTargetUnitInstanceId === units[1]!.instanceId,
    );
    const after = castAndResolve(state, play, "Deathgrip");
    expect(after.players[0]!.baseUnits[0]!.mightThisTurn).toBe(9);
  });

  it("enumerates BOTH orderings — the two slots are opposites, not interchangeable", () => {
    // Without `asymmetricSlots` the enumerator prunes (B,A) once it has offered
    // (A,B) for two same-role slots, and half of this card is unreachable: the
    // player could kill the big unit but never the small one.
    const { state, spellId, units } = gripState([6, 2]);
    const pairs = castsOf(state, spellId)
      .flatMap((a) => (a.type === "PlayCard" ? [[a.targetUnitInstanceId, a.secondTargetUnitInstanceId]] : []))
      .filter(([first, second]) => first !== undefined && second !== undefined);
    expect(pairs).toContainEqual([units[0]!.instanceId, units[1]!.instanceId]);
    expect(pairs).toContainEqual([units[1]!.instanceId, units[0]!.instanceId]);
  });

  it("is not playable with only one friendly unit — both targets are required (355)", () => {
    const { state, spellId } = gripState([4]);
    expect(castsOf(state, spellId)).toHaveLength(0);
  });
});

// ── Unsung Hero (SFD-167) ───────────────────────────────────────────────────

describe("Unsung Hero (SFD-167): [Deathknell] — if I WAS Mighty, draw 2", () => {
  /** The Hero dying with `mightThisTurn` on him, and a deck to draw from. */
  function heroDeath(mightThisTurn: number): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.deck = Array.from({ length: 5 }, () => spellInstance(HEXTECH_RAY));
    const hero: UnitInstance = { ...realUnitInstance(UNSUNG_HERO), mightThisTurn };
    return resolveHeldTriggers(holdUnitDied(state, { unit: hero, ownerIndex: 0 }));
  }

  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(UNSUNG_HERO))).toBe(true);
  });

  it("draws 2 when he died at 5+ Might", () => {
    // Printed 2 Might, +3 this turn = 5. The card's "was" is what makes this
    // readable at all: the copy in the trash is evaluated at its PRINTED 2.
    expect(heroDeath(3).players[0]!.hand).toHaveLength(2);
  });

  it("draws NOTHING at 4 Might — the control", () => {
    expect(heroDeath(2).players[0]!.hand).toHaveLength(0);
  });
});

// ── Altar of Memories (SFD-169) ─────────────────────────────────────────────

describe("Altar of Memories (SFD-169): exhaust to draw, then put a card back", () => {
  function altarState(): { state: GameState; altar: GearInstance; victim: UnitInstance } {
    const altar = createCardInstance(registry.get(ALTAR_OF_MEMORIES)) as GearInstance;
    const victim = makeUnit({ name: "Doomed" });
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [altar];
    state.players[0]!.baseUnits = [victim];
    state.players[0]!.deck = Array.from({ length: 4 }, () => spellInstance(HEXTECH_RAY));
    return { state, altar, victim };
  }

  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(ALTAR_OF_MEMORIES))).toBe(true);
  });

  it("asks, draws, exhausts, and puts the chosen card on TOP of the deck", () => {
    const { state, victim } = altarState();
    const asked = resolveHeldTriggers(destroyUnit(state, victim.instanceId));
    expect(pendingDecision(asked)?.kind).toBe("SFD-169-draw");

    const drawn = answer(asked, "exhaust");
    expect(drawn.players[0]!.hand).toHaveLength(1);
    expect(drawn.players[0]!.activeGear[0]!.exhausted).toBe(true);
    // The card just drawn is on offer — "draw 1, THEN put a card from your hand
    // back" — which is the whole reason the second question is parked after it.
    expect(pendingDecision(drawn)?.kind).toBe("SFD-169-place");
    const drawnCardId = drawn.players[0]!.hand[0]!.instanceId;
    expect(offeredIds(drawn)).toContain(`top:${drawnCardId}`);

    const placed = answer(drawn, `top:${drawnCardId}`);
    expect(placed.players[0]!.hand).toHaveLength(0);
    expect(placed.players[0]!.deck[0]!.instanceId).toBe(drawnCardId);
  });

  it("puts it on the BOTTOM when that is the answer", () => {
    const { state, victim } = altarState();
    const drawn = answer(resolveHeldTriggers(destroyUnit(state, victim.instanceId)), "exhaust");
    const drawnCardId = drawn.players[0]!.hand[0]!.instanceId;
    const placed = answer(drawn, `bottom:${drawnCardId}`);
    expect(placed.players[0]!.deck.at(-1)!.instanceId).toBe(drawnCardId);
    expect(placed.players[0]!.deck[0]!.instanceId).not.toBe(drawnCardId);
  });

  it("declining costs nothing", () => {
    const { state, victim } = altarState();
    const declined = answer(resolveHeldTriggers(destroyUnit(state, victim.instanceId)), "decline");
    expect(declined.players[0]!.hand).toHaveLength(0);
    expect(declined.players[0]!.activeGear[0]!.exhausted).toBe(false);
    expect(pendingDecision(declined)).toBeUndefined();
  });

  it("does NOT trigger on an ENEMY unit's death", () => {
    const { state } = altarState();
    const theirs = makeUnit({ name: "Theirs" });
    state.players[1]!.baseUnits = [theirs];
    const after = resolveHeldTriggers(destroyUnit(state, theirs.instanceId));
    expect(pendingDecision(after)).toBeUndefined();
    expect(after.players[0]!.hand).toHaveLength(0);
  });

  it("asks nothing while it is already exhausted — the cost cannot be paid", () => {
    const { state, victim } = altarState();
    state.players[0]!.activeGear = [{ ...state.players[0]!.activeGear[0]!, exhausted: true }];
    const after = resolveHeldTriggers(destroyUnit(state, victim.instanceId));
    expect(pendingDecision(after)).toBeUndefined();
    expect(after.players[0]!.hand).toHaveLength(0);
  });
});

// ── Rek'Sai - Swarm Queen (SFD-170) ─────────────────────────────────────────

describe("Rek'Sai - Swarm Queen (SFD-170): reveal 2, banish and play one, recycle the rest", () => {
  /** Rek'Sai attacking at bf1 with `topTwo` on top of her controller's deck. */
  function swarmState(topTwo: UnitInstance[]): GameState {
    const reksai = realUnitInstance(REKSAI_SWARM_QUEEN);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units["p1"] = [reksai];
    state.battlefields[0]!.units["p2"] = [makeUnit({ name: "Defender" })];
    state.players[0]!.deck = [...topTwo, spellInstance(HEXTECH_RAY)];
    return beginCombatAt(state, "bf1", 0);
  }

  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(REKSAI_SWARM_QUEEN))).toBe(true);
  });

  it("asks when she attacks, and offers both revealed cards", () => {
    const first = makeUnit({ name: "First" });
    const second = makeUnit({ name: "Second" });
    const asked = swarmState([first, second]);
    expect(pendingDecision(asked)?.kind).toBe("SFD-170-reveal");
    expect(offeredIds(asked)).toEqual(["decline", "none", first.instanceId, second.instanceId]);
  });

  it("plays the banished unit HERE and recycles the other", () => {
    const first = makeUnit({ name: "First" });
    const second = makeUnit({ name: "Second" });
    const asked = swarmState([first, second]);

    const played = answer(asked, first.instanceId);
    // A free unit play parks the shared placement question, and "here" is on it.
    expect(pendingDecision(played)?.kind).toBe("free-play-placement");
    const landed = answer(played, "bf1");

    expect(unitsAt(landed, "bf1", "p1").map((u) => u.name)).toContain("First");
    // The other revealed card went to the BOTTOM (416), behind the third card.
    expect(landed.players[0]!.deck.map((c) => c.instanceId)).toEqual([
      asked.players[0]!.deck[2]!.instanceId,
      second.instanceId,
    ]);
  });

  it("plays a banished SPELL too — 'play it' names no card type", () => {
    // "If it is a unit, you may play it here" is the only clause that cares what
    // the card is; a Spell is played (and, having been announced by nobody, does
    // as much as it can with no targets) and ends in the trash.
    const spell = spellInstance(HEXTECH_RAY);
    const second = makeUnit({ name: "Second" });
    const reksai = realUnitInstance(REKSAI_SWARM_QUEEN);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units["p1"] = [reksai];
    state.battlefields[0]!.units["p2"] = [makeUnit({ name: "Defender" })];
    state.players[0]!.deck = [spell, second];

    const played = answer(beginCombatAt(state, "bf1", 0), spell.instanceId);
    expect(played.players[0]!.trash.map((c) => c.instanceId)).toContain(spell.instanceId);
    expect(played.players[0]!.deck.map((c) => c.instanceId)).toEqual([second.instanceId]);
  });

  it("recycles BOTH when nothing is banished", () => {
    const first = makeUnit({ name: "First" });
    const second = makeUnit({ name: "Second" });
    const asked = swarmState([first, second]);
    const revealed = answer(asked, "none");
    expect(revealed.players[0]!.deck.map((c) => c.instanceId)).toEqual([
      asked.players[0]!.deck[2]!.instanceId,
      first.instanceId,
      second.instanceId,
    ]);
    expect(unitsOf(revealed, 0).map((u) => u.name)).not.toContain("First");
  });

  it("touches nothing at all when the reveal is declined", () => {
    const first = makeUnit({ name: "First" });
    const second = makeUnit({ name: "Second" });
    const asked = swarmState([first, second]);
    const declined = answer(asked, "decline");
    expect(declined.players[0]!.deck.map((c) => c.instanceId)).toEqual(asked.players[0]!.deck.map((c) => c.instanceId));
  });

  it("does not fire for the DEFENDING side", () => {
    const reksai = realUnitInstance(REKSAI_SWARM_QUEEN);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units["p1"] = [reksai];
    state.battlefields[0]!.units["p2"] = [makeUnit({ name: "Attacker" })];
    state.players[0]!.deck = [makeUnit({ name: "First" }), makeUnit({ name: "Second" })];
    // Contested BY THE OPPONENT: she is defending, and "when I attack" is silent.
    const after = beginCombatAt(state, "bf1", 1);
    expect(pendingDecision(after)).toBeUndefined();
  });
});

// ── Undertitan (SFD-175) ────────────────────────────────────────────────────

describe("Undertitan (SFD-175): your OTHER units get +2 Might this turn", () => {
  it("is reported implemented", () => {
    // HALF a card: the on-play pump is written, "As I'm revealed from your deck,
    // [Add] 2 Energy" is not, and there is no reveal-from-deck hook to hang it on.
    // He now carries a coverage.PARTIALLY_IMPLEMENTED entry, so "implemented" is
    // exactly what he must NOT report.
    expect(isCardImplemented(registry.get(UNDERTITAN))).toBe(false);
    expect(partialImplementationNote(registry.get(UNDERTITAN))).toContain("reveal-from-deck");
  });

  it("pumps every other friendly unit, in base and at battlefields, but not itself", () => {
    const titan = realUnitInstance(UNDERTITAN);
    const atHome = makeUnit({ name: "At home" });
    const outThere = makeUnit({ name: "Out there" });
    const theirs = makeUnit({ name: "Theirs" });
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [titan, atHome];
    state.battlefields[0]!.units["p1"] = [outThere];
    state.battlefields[0]!.units["p2"] = [theirs];

    const after = playUnitTrigger(state, titan, 0, "base");
    const mightOf = (name: string) => unitsOf(after, 0).concat(unitsOf(after, 1)).find((u) => u.name === name)!.mightThisTurn;
    expect(mightOf("At home")).toBe(2);
    expect(mightOf("Out there")).toBe(2);
    expect(mightOf("Theirs")).toBe(0);
    expect(after.players[0]!.baseUnits.find((u) => u.instanceId === titan.instanceId)!.mightThisTurn).toBe(0);
  });
});

// ── Azir - Sovereign (SFD-177) ──────────────────────────────────────────────

describe("Azir - Sovereign (SFD-177): move any number of your tokens to the fight", () => {
  /** Azir attacking at bf1, with `tokens` of his controller's elsewhere. */
  function sovereignState(tokens: UnitInstance[], elsewhere: "base" | "bf2" = "base"): GameState {
    const azir = realUnitInstance(AZIR_SOVEREIGN);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units["p1"] = [azir];
    state.battlefields[0]!.units["p2"] = [makeUnit({ name: "Defender" })];
    if (elsewhere === "base") state.players[0]!.baseUnits = tokens;
    else state.battlefields[1]!.units["p1"] = tokens;
    return beginCombatAt(state, "bf1", 0);
  }

  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(AZIR_SOVEREIGN))).toBe(true);
  });

  it("moves a token from base to the battlefield he is attacking", () => {
    const token = makeUnit({ name: "Sand Soldier", isToken: true, might: 2 });
    const asked = sovereignState([token]);
    expect(pendingDecision(asked)?.kind).toBe("SFD-177-move");

    const moved = answer(asked, token.instanceId);
    expect(unitsAt(moved, "bf1", "p1").map((u) => u.instanceId)).toContain(token.instanceId);
    expect(moved.players[0]!.baseUnits).toHaveLength(0);
  });

  it("keeps asking — 'any number' — and stops on demand", () => {
    const first = makeUnit({ name: "Token A", isToken: true });
    const second = makeUnit({ name: "Token B", isToken: true });
    const asked = sovereignState([first, second]);
    const once = answer(asked, first.instanceId);
    expect(pendingDecision(once)?.kind).toBe("SFD-177-move");
    expect(offeredIds(once)).toEqual(["stop", second.instanceId]);
    const stopped = answer(once, "stop");
    expect(unitsAt(stopped, "bf1", "p1").map((u) => u.name)).toContain("Token A");
    expect(unitsAt(stopped, "bf1", "p1").map((u) => u.name)).not.toContain("Token B");
    expect(pendingDecision(stopped)).toBeUndefined();
  });

  it("offers only TOKENS, and not one already standing there", () => {
    const token = makeUnit({ name: "Token", isToken: true });
    const person = makeUnit({ name: "Not a token" });
    const alreadyHere = makeUnit({ name: "Already here", isToken: true });
    const azir = realUnitInstance(AZIR_SOVEREIGN);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units["p1"] = [azir, alreadyHere];
    state.battlefields[0]!.units["p2"] = [makeUnit({ name: "Defender" })];
    state.players[0]!.baseUnits = [token, person];
    const asked = beginCombatAt(state, "bf1", 0);
    expect(offeredIds(asked)).toEqual(["stop", token.instanceId]);
  });

  it("asks nothing when there is no token to move", () => {
    const after = sovereignState([makeUnit({ name: "Not a token" })]);
    expect(pendingDecision(after)).toBeUndefined();
  });
});

// ── Corina Veraza (SFD-179) ─────────────────────────────────────────────────

describe("Corina Veraza (SFD-179): three Recruits where she moved to", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(CORINA_VERAZA))).toBe(true);
  });

  it("makes three 1-Might Recruit tokens at the battlefield she moved to", () => {
    const corina = realUnitInstance(CORINA_VERAZA);
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [corina];

    const move = legalActions(state).find(
      (a) => a.type === "MoveUnit" && a.destinationBattlefieldId === "bf1" && a.unitInstanceIds.includes(corina.instanceId),
    );
    const after = resolveHeldTriggers(accept(state, move, "Corina's move to bf1"));

    const tokens = unitsAt(after, "bf1", "p1").filter((u) => u.isToken);
    expect(tokens).toHaveLength(3);
    expect(tokens.every((t) => t.name === "Recruit" && t.might === 1)).toBe(true);
    expect(unitsAt(after, "bf2", "p1")).toHaveLength(0);
  });

  it("does not fire for a DIFFERENT unit's move — 'when I move'", () => {
    const corina = realUnitInstance(CORINA_VERAZA);
    const other = makeUnit({ name: "Someone else" });
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [corina, other];

    const move = legalActions(state).find(
      (a) => a.type === "MoveUnit" && a.destinationBattlefieldId === "bf1" && a.unitInstanceIds.includes(other.instanceId) && !a.unitInstanceIds.includes(corina.instanceId),
    );
    const after = resolveHeldTriggers(accept(state, move, "the other unit's move to bf1"));
    expect(unitsAt(after, "bf1", "p1").filter((u) => u.isToken)).toHaveLength(0);
  });
});
