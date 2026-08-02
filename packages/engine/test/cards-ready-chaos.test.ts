import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { destroyUnit } from "../src/engine/effect-helpers.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type CardInstance, type GearInstance, type SpellInstance, type UnitInstance } from "../src/model/card.js";
import type { Domain } from "../src/model/domain.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { makePlayer, makeState, makeUnit } from "./fixtures.js";

/**
 * The Chaos half of the "READY" cluster in docs/dead-card-survey.md — cards that
 * needed nothing but a registry entry and a resolver.
 *
 * Everything here is driven through `submit`, not by calling a resolver. That is
 * not ceremony: this codebase has repeatedly shipped a card that was written,
 * typechecked and unreachable at the same time, because a dispatch hop dropped
 * it. A test that calls `effectForCard(...).resolve` cannot tell the difference,
 * and a silently-inert card is indistinguishable from a working one in play.
 *
 * Every assertion is that the effect FIRED — a board that moved, a hand that
 * changed size, a question that was asked — never merely that a resolver
 * returned a state.
 */

const registry = defaultCardRegistry();
const card = (defId: string): CardInstance => createCardInstance(registry.get(defId));
const spell = (defId: string) => card(defId) as SpellInstance;
const unit = (defId: string) => card(defId) as UnitInstance;

const ACCEPTABLE_LOSSES = "OGN-179";
const WHIRLWIND = "OGN-187";
const INVERT_TIMELINES = "OGN-201";
const ZAUNITE_BOUNCER = "OGN-188";
const KOGMAW_CAUSTIC = "OGN-190";
const SOULGORGER = "OGN-196";
const INCINERATE = "OGS-003"; // Fury, 2 Energy: "Deal 2 to a unit at a battlefield"
const MAGMA_WURM = "OGN-011"; // Fury unit, 8 Energy + 1 FURY Power — the domain mismatch below
const TREASURE_TROVE = "OGN-186"; // Chaos gear: "When this leaves the board, draw 1 and channel 1 rune exhausted"

/** A card's cost as Ready runes, in whatever domain its Power demands (Energy
 *  takes any domain, so one pile covers both halves). */
function funded(state: GameState, playerIndex: 0 | 1, priced: { energyCost: number; powerCost: number; powerDomain: Domain | null }) {
  const domain = priced.powerDomain ?? "Chaos";
  state.players[playerIndex]!.channeled = Array.from({ length: priced.energyCost + priced.powerCost }, (_, i) => ({
    id: `${playerIndex}-r${i}`,
    domain,
    state: "Ready" as const,
  }));
}

function paymentFor(state: GameState, playerIndex: 0 | 1, priced: { energyCost: number; powerCost: number }) {
  const ids = state.players[playerIndex]!.channeled.map((r) => r.id);
  return { energyRunes: ids.slice(0, priced.energyCost), powerRunes: ids.slice(priced.energyCost, priced.energyCost + priced.powerCost) };
}

/** Plays a card for real and, for a Spell, walks the chain to resolution.
 *  Asserts the play was accepted, so a card the validator refuses fails loudly
 *  here rather than silently doing nothing later. */
function play(state: GameState, played: CardInstance, extra: Partial<PlayCardAction> = {}, playerIndex: 0 | 1 = 0): GameState {
  const priced = played as unknown as { energyCost: number; powerCost: number };
  const result = submit(state, {
    type: "PlayCard",
    playerIndex,
    card: played,
    payment: paymentFor(state, playerIndex, priced),
    ...extra,
  });
  expect(result.result, `playing ${played.name}`).toEqual({ type: "Ok" });
  let current = result.state;
  // A Spell sits on a closed chain until both players pass; a Unit is already in
  // play. Guarding on `chainOpen` rather than on card kind keeps this honest if
  // a Unit ever starts a chain.
  while (!current.chainOpen && current.pendingDecisions.length === 0) {
    const pass = submit(current, { type: "PassFocus", playerIndex: current.chainPriority });
    expect(pass.result).toEqual({ type: "Ok" });
    current = pass.state;
  }
  return current;
}

/** Answers every outstanding question through `submit`, the same door a human
 *  and the AI use — not `answerDecision`, which would skip the validator and the
 *  pending-decision gate in `submit`. */
function answerAll(state: GameState, pick: (options: { id: string; label: string }[]) => string = (o) => o[0]!.id): GameState {
  let current = state;
  for (let guard = 0; guard < 16; guard += 1) {
    const decision = pendingDecision(current);
    if (!decision) return current;
    const answered = submit(current, {
      type: "AnswerDecision",
      playerIndex: decision.playerIndex,
      decisionId: decision.id,
      optionId: pick(optionsFor(current, decision)),
    });
    expect(answered.result, `answering ${decision.kind}`).toEqual({ type: "Ok" });
    current = answered.state;
  }
  throw new Error("answerAll: the queue never emptied");
}

/** Picks the option about a named instance when it is offered, else the first. */
const pickInstance = (instanceId: string) => (options: { id: string; label: string }[]) =>
  options.find((o) => o.id === instanceId)?.id ?? options[0]!.id;

/** A caster on turn, holding `hand`, funded for `funds`. */
function tableWith(hand: CardInstance[], funds: { energyCost: number; powerCost: number; powerDomain: Domain | null }): GameState {
  const state = makeState({ phase: "Action", players: [makePlayer("p1", { hand }), makePlayer("p2")] });
  funded(state, 0, funds);
  return state;
}

describe("Acceptable Losses (OGN-179): each player kills one of their gear", () => {
  /** A real Treasure Trove renamed, so each option is distinguishable AND the
   *  gear carries a real self-trigger (see the last case in this block). */
  const gearNamed = (name: string): GearInstance => ({ ...(card(TREASURE_TROVE) as GearInstance), name });

  function withGear(mine: string[], theirs: string[]): { state: GameState; losses: SpellInstance } {
    const losses = spell(ACCEPTABLE_LOSSES);
    const state = tableWith([losses], losses);
    state.players[0]!.activeGear = mine.map(gearNamed);
    state.players[1]!.activeGear = theirs.map(gearNamed);
    // Both decks stocked because the Trove draws on the way out, and drawing from
    // an EMPTY deck triggers Burn Out (431) — which recycles the trash back into
    // the deck and would take the freshly killed gear straight back out of the
    // trash these tests are inspecting. Found by the assertion failing.
    for (const player of state.players) player.deck = [makeUnit(), makeUnit()];
    return { state, losses };
  }

  it("asks each player about their OWN gear, turn player first (894)", () => {
    const { state, losses } = withGear(["A1", "A2"], ["B1", "B2"]);

    const asked = play(state, losses);

    expect(asked.pendingDecisions.map((d) => d.kind)).toEqual(["OGN-179-kill", "OGN-179-kill"]);
    expect(asked.pendingDecisions.map((d) => d.playerIndex)).toEqual([0, 1]);
    expect(optionsFor(asked, asked.pendingDecisions[0]!).map((o) => o.label)).toEqual(["A1", "A2"]);
    expect(optionsFor(asked, asked.pendingDecisions[1]!).map((o) => o.label)).toEqual(["B1", "B2"]);
  });

  it("kills the gear each player named, and only that one", () => {
    const { state, losses } = withGear(["A1", "A2"], ["B1", "B2"]);

    const after = answerAll(play(state, losses), (options) => options[1]!.id);

    expect(after.players[0]!.activeGear.map((g) => g.name)).toEqual(["A1"]);
    expect(after.players[1]!.activeGear.map((g) => g.name)).toEqual(["B1"]);
    expect(after.players[0]!.trash.map((c) => c.name)).toContain("A2");
    expect(after.players[1]!.trash.map((c) => c.name)).toContain("B2");
  });

  it("kills a lone gear without asking, and skips a player with none", () => {
    // Two different reasons not to ask — one option is not a choice, and no
    // options is a moot question — and both must still resolve correctly.
    const { state, losses } = withGear(["Only"], []);

    const after = play(state, losses);

    expect(after.pendingDecisions).toHaveLength(0);
    expect(after.players[0]!.activeGear).toHaveLength(0);
    expect(after.players[0]!.trash.map((c) => c.name)).toContain("Only");
  });

  it("routes through killGear, so the dying gear's own trigger still fires", () => {
    // Treasure Trove is "when this leaves the board, draw 1 and channel 1 rune
    // exhausted". A hand-rolled removal would have taken it to the trash in
    // silence, which is the exact shape of the bug killGear exists to prevent.
    const losses = spell(ACCEPTABLE_LOSSES);
    const state = tableWith([losses], losses);
    state.players[0]!.activeGear = [card(TREASURE_TROVE) as GearInstance];
    state.players[0]!.deck = [makeUnit(), makeUnit()];
    state.players[0]!.runeDeck = [{ id: "rd1", domain: "Chaos", state: "Ready" }];

    const after = play(state, losses);

    expect(after.players[0]!.activeGear).toHaveLength(0);
    expect(after.players[0]!.hand).toHaveLength(1); // drew 1
    expect(after.players[0]!.channeled.some((r) => r.state === "Exhausted")).toBe(true);
  });
});

describe("Whirlwind (OGN-187): starting with the next player, each may bounce a unit", () => {
  function whirlwindTable(): { state: GameState; whirlwind: SpellInstance; mine: UnitInstance; theirs: UnitInstance } {
    const whirlwind = spell(WHIRLWIND);
    const state = tableWith([whirlwind], whirlwind);
    const mine = makeUnit({ name: "Mine" });
    const theirs = makeUnit({ name: "Theirs" });
    state.battlefields[0]!.units = { p1: [mine], p2: [theirs] };
    return { state, whirlwind, mine, theirs };
  }

  it("asks the NON-turn player first — the card's explicit override of 894", () => {
    // This is the assertion the whole card turns on. APNAP (the default every
    // other "each player" card here uses) would give [0, 1].
    const { state, whirlwind } = whirlwindTable();

    const asked = play(state, whirlwind);

    expect(asked.pendingDecisions.map((d) => d.kind)).toEqual(["OGN-187-return", "OGN-187-return"]);
    expect(asked.pendingDecisions.map((d) => d.playerIndex)).toEqual([1, 0]);
  });

  it("offers a decline first, and every unit in play — either owner's, base included", () => {
    // "A unit" is 355.9.b's bare noun: no owner and no battlefield named, so a
    // unit at home is as reachable as one at a battlefield. Rebuke, three entries
    // above this card in the same file, prints the narrower wording and gets the
    // narrower reach.
    const { state, whirlwind, mine, theirs } = whirlwindTable();
    const atHome = makeUnit({ name: "AtHome" });
    state.players[1]!.baseUnits = [atHome];

    const asked = play(state, whirlwind);
    const options = optionsFor(asked, asked.pendingDecisions[0]!);

    expect(options[0]!.id).toBe("decline");
    expect(options.map((o) => o.instanceId)).toEqual(
      expect.arrayContaining([mine.instanceId, theirs.instanceId, atHome.instanceId]),
    );
  });

  it("returns the chosen unit to its OWNER's hand, reset", () => {
    const { state, whirlwind, mine } = whirlwindTable();
    state.battlefields[0]!.units["p1"] = [{ ...mine, damage: 2, buffed: true, exhausted: true }];

    // Player 1 answers first and declines; player 0 bounces their own unit.
    const after = answerAll(play(state, whirlwind), pickInstance(mine.instanceId));

    expect(after.battlefields[0]!.units["p1"]).toHaveLength(0);
    const returned = after.players[0]!.hand.find((c) => c.instanceId === mine.instanceId);
    expect(returned, "the bounced unit reached its owner's hand").toBeDefined();
    expect(returned!.kind === "Unit" && returned!.damage).toBe(0);
    expect(returned!.kind === "Unit" && returned!.buffed).toBe(false);
  });

  it("declining is a real answer — nothing moves", () => {
    const { state, whirlwind } = whirlwindTable();

    const after = answerAll(play(state, whirlwind), () => "decline");

    expect(after.battlefields[0]!.units["p1"]).toHaveLength(1);
    expect(after.battlefields[0]!.units["p2"]).toHaveLength(1);
    expect(after.players[0]!.hand).toHaveLength(0);
  });

  it("asks nothing at all with an empty board", () => {
    // Only the decline is on offer, and a question with one answer is not a
    // question — so neither player is interrupted to be told there is nothing to
    // bounce.
    const whirlwind = spell(WHIRLWIND);
    const state = tableWith([whirlwind], whirlwind);

    const after = play(state, whirlwind);

    expect(after.pendingDecisions).toHaveLength(0);
  });

  it("rebuilds the second player's options from the board the first answer left", () => {
    // The options are recomputed when a question reaches the front, so the unit
    // player 1 has already bounced can never be offered to player 0.
    const { state, whirlwind, theirs } = whirlwindTable();

    const asked = play(state, whirlwind);
    const firstAnswered = submit(asked, {
      type: "AnswerDecision",
      playerIndex: 1,
      decisionId: asked.pendingDecisions[0]!.id,
      optionId: theirs.instanceId,
    }).state;

    const remaining = optionsFor(firstAnswered, pendingDecision(firstAnswered)!);
    expect(remaining.map((o) => o.instanceId)).not.toContain(theirs.instanceId);
  });
});

describe("Invert Timelines (OGN-201): each player discards their hand, then draws 4", () => {
  it("empties both hands and refills both to 4", () => {
    const invert = spell(INVERT_TIMELINES);
    const mineA = makeUnit({ name: "MineA" });
    const mineB = makeUnit({ name: "MineB" });
    const theirs = makeUnit({ name: "Theirs" });
    const state = tableWith([invert, mineA, mineB], invert);
    state.players[1]!.hand = [theirs];
    state.players[0]!.deck = Array.from({ length: 6 }, () => makeUnit({ name: "MyDeck" }));
    state.players[1]!.deck = Array.from({ length: 6 }, () => makeUnit({ name: "TheirDeck" }));

    const after = play(state, invert);

    expect(after.pendingDecisions).toHaveLength(0); // discarding a whole hand is not a choice
    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["MyDeck", "MyDeck", "MyDeck", "MyDeck"]);
    expect(after.players[1]!.hand.map((c) => c.name)).toEqual(["TheirDeck", "TheirDeck", "TheirDeck", "TheirDeck"]);
    expect(after.players[0]!.trash.map((c) => c.name)).toEqual(expect.arrayContaining(["MineA", "MineB"]));
    expect(after.players[1]!.trash.map((c) => c.name)).toEqual(["Theirs"]);
    expect(after.players[0]!.deck).toHaveLength(2);
  });

  it("draws 4 for a player who had nothing to discard", () => {
    const invert = spell(INVERT_TIMELINES);
    const state = tableWith([invert], invert);
    state.players[0]!.deck = Array.from({ length: 5 }, () => makeUnit());
    state.players[1]!.deck = Array.from({ length: 5 }, () => makeUnit());

    const after = play(state, invert);

    expect(after.players[0]!.hand).toHaveLength(4);
    expect(after.players[1]!.hand).toHaveLength(4);
  });

  it("discards BEFORE drawing — a card just drawn is never one discarded", () => {
    // The "then" is printed. Written the obvious way round, the four fresh cards
    // would join the hand being discarded from.
    const invert = spell(INVERT_TIMELINES);
    const doomed = makeUnit({ name: "Doomed" });
    const state = tableWith([invert, doomed], invert);
    state.players[0]!.deck = Array.from({ length: 4 }, () => makeUnit({ name: "Fresh" }));
    state.players[1]!.deck = [];

    const after = play(state, invert);

    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["Fresh", "Fresh", "Fresh", "Fresh"]);
    expect(after.players[0]!.trash.map((c) => c.name)).toContain("Doomed");
    expect(after.players[0]!.trash.map((c) => c.name)).not.toContain("Fresh");
  });
});

describe("Zaunite Bouncer (OGN-188): on play, bounce another unit at a battlefield", () => {
  function bouncerTable(): { state: GameState; bouncer: UnitInstance; victim: UnitInstance } {
    const bouncer = unit(ZAUNITE_BOUNCER);
    const victim = makeUnit({ name: "Victim", damage: 1, buffed: true });
    const state = tableWith([bouncer], bouncer);
    state.battlefields[0]!.units = { p2: [victim] };
    return { state, bouncer, victim };
  }

  it("returns the chosen unit to its owner's hand when played", () => {
    const { state, bouncer, victim } = bouncerTable();

    const after = play(state, bouncer, { targetUnitInstanceId: victim.instanceId });

    expect(after.battlefields[0]!.units["p2"] ?? []).toHaveLength(0);
    expect(after.players[1]!.hand.map((c) => c.instanceId)).toEqual([victim.instanceId]);
    const returned = after.players[1]!.hand[0]!;
    expect(returned.kind === "Unit" && returned.damage).toBe(0);
    expect(returned.kind === "Unit" && returned.buffed).toBe(false);
    expect(after.players[0]!.baseUnits.map((u) => u.defId)).toEqual([ZAUNITE_BOUNCER]); // he still deployed
  });

  it("is OFFERED with that target by legal-actions — a scope nothing enumerates is unusable", () => {
    const { state, bouncer, victim } = bouncerTable();

    const offered = legalActions(state).filter(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === bouncer.instanceId,
    );

    expect(offered.map((a) => a.targetUnitInstanceId)).toContain(victim.instanceId);
  });

  it("cannot reach a unit in base — 'at a battlefield' is printed", () => {
    const { state, bouncer } = bouncerTable();
    state.battlefields[0]!.units = {};
    const atHome = makeUnit({ name: "AtHome" });
    state.players[1]!.baseUnits = [atHome];

    const offered = legalActions(state).filter(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === bouncer.instanceId,
    );

    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every((a) => a.targetUnitInstanceId === undefined)).toBe(true);
    expect(play(state, bouncer).players[1]!.baseUnits).toHaveLength(1);
  });

  it("never offers ITSELF — 'another unit'", () => {
    // He is enumerated while still in hand, so his own instanceId cannot appear;
    // asserted rather than assumed, since the whole word "another" rides on it.
    const { state, bouncer, victim } = bouncerTable();

    const offered = legalActions(state).filter(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === bouncer.instanceId,
    );

    expect(offered.map((a) => a.targetUnitInstanceId)).not.toContain(bouncer.instanceId);
    expect(offered.map((a) => a.targetUnitInstanceId)).toContain(victim.instanceId);
  });

  it("still deploys with no unit at any battlefield to bounce", () => {
    const { state, bouncer } = bouncerTable();
    state.battlefields[0]!.units = {};

    const after = play(state, bouncer);

    expect(after.players[0]!.baseUnits.map((u) => u.defId)).toEqual([ZAUNITE_BOUNCER]);
  });
});

describe("Kog'Maw - Caustic (OGN-190): [Deathknell] deal 4 to all units at my battlefield", () => {
  function kogmawAt(): { state: GameState; kogmaw: UnitInstance; ally: UnitInstance; enemy: UnitInstance; elsewhere: UnitInstance } {
    const kogmaw = unit(KOGMAW_CAUSTIC);
    const ally = makeUnit({ name: "Ally", might: 9 });
    const enemy = makeUnit({ name: "Enemy", might: 9 });
    const elsewhere = makeUnit({ name: "Elsewhere", might: 9 });
    const state = makeState({ phase: "Action", players: [makePlayer("p1"), makePlayer("p2")] });
    state.battlefields[0]!.units = { p1: [kogmaw, ally], p2: [enemy] };
    state.battlefields[1]!.units = { p2: [elsewhere] };
    return { state, kogmaw, ally, enemy, elsewhere };
  }

  it("hits every unit at HIS battlefield, both sides, and nowhere else", () => {
    // Driven through destroyUnit, the shared kill funnel every card's kill and
    // every lethal damage goes through — so this exercises the real
    // dispatchOnUnitDied hop into the composed Deathknell registry.
    const { state, kogmaw } = kogmawAt();

    const after = destroyUnit(state, kogmaw.instanceId, 1);

    expect(after.battlefields[0]!.units["p1"]!.map((u) => u.damage)).toEqual([4]); // Ally
    expect(after.battlefields[0]!.units["p2"]!.map((u) => u.damage)).toEqual([4]); // Enemy
    expect(after.battlefields[1]!.units["p2"]!.map((u) => u.damage)).toEqual([0]); // Elsewhere
  });

  it("fires when he is killed by a real spell cast through submit", () => {
    // The same effect down the path a game actually takes: Incinerate for 2 kills
    // a 1-Might Kog'Maw, and his Deathknell has to survive the whole
    // dealDamage -> killUnit -> dispatchOnUnitDied chain.
    //
    // The turn player casts it at their OWN Kog'Maw, which is not a contrivance
    // to dodge timing: in a Neutral state only the turn player may act at all
    // (rule 919), and "deal 2 to a unit" names no owner.
    const { state, ally, enemy } = kogmawAt();
    const kogmawOnBoard = state.battlefields[0]!.units["p1"]![0]!;
    const incinerate = spell(INCINERATE);
    state.players[0]!.hand = [incinerate];
    funded(state, 0, incinerate);

    const after = play(state, incinerate, { targetUnitInstanceId: kogmawOnBoard.instanceId });

    expect(after.players[0]!.trash.map((c) => c.defId)).toContain(KOGMAW_CAUSTIC);
    expect(after.battlefields[0]!.units["p1"]!.find((u) => u.instanceId === ally.instanceId)!.damage).toBe(4);
    expect(after.battlefields[0]!.units["p2"]!.find((u) => u.instanceId === enemy.instanceId)!.damage).toBe(4);
  });

  it("does not damage the corpse, and can kill what it hits", () => {
    const { state, kogmaw } = kogmawAt();
    state.battlefields[0]!.units["p2"] = [makeUnit({ name: "Fragile", might: 3 })];

    const after = destroyUnit(state, kogmaw.instanceId, 1);

    expect(after.battlefields[0]!.units["p2"]).toHaveLength(0);
    expect(after.players[1]!.trash.map((c) => c.name)).toEqual(["Fragile"]);
    // He is in his own controller's trash exactly once — the blast did not find
    // him standing there and re-kill him.
    expect(after.players[0]!.trash.map((c) => c.defId)).toEqual([KOGMAW_CAUSTIC]);
  });

  it("does nothing when he dies in BASE — there is no battlefield to blast", () => {
    const kogmaw = unit(KOGMAW_CAUSTIC);
    const neighbour = makeUnit({ name: "Neighbour", might: 9 });
    const state = makeState({ phase: "Action", players: [makePlayer("p1", { baseUnits: [] }), makePlayer("p2")] });
    state.players[0]!.baseUnits = [kogmaw, neighbour];
    state.battlefields[0]!.units = { p2: [makeUnit({ name: "Forward", might: 9 })] };

    const after = destroyUnit(state, kogmaw.instanceId, 1);

    expect(after.players[0]!.baseUnits.map((u) => u.damage)).toEqual([0]);
    expect(after.battlefields[0]!.units["p2"]!.map((u) => u.damage)).toEqual([0]);
  });
});

describe("Soulgorger (OGN-196): on play, you may play a unit from your trash for its Power only", () => {
  /** Soulgorger in hand and funded, with `trash` already in the caster's trash
   *  and `spare` extra Ready Chaos runes on top of his own cost. */
  function soulgorgerTable(trash: CardInstance[], spare = 0): { state: GameState; soulgorger: UnitInstance } {
    const soulgorger = unit(SOULGORGER);
    const state = tableWith([soulgorger], soulgorger);
    state.players[0]!.channeled = [
      ...state.players[0]!.channeled,
      ...Array.from({ length: spare }, (_, i) => ({ id: `spare-${i}`, domain: "Chaos" as const, state: "Ready" as const })),
    ];
    state.players[0]!.trash = trash;
    return { state, soulgorger };
  }

  it("offers a decline and each affordable unit in the trash", () => {
    const corpse = unit(KOGMAW_CAUSTIC); // 3 Energy / 1 Chaos Power
    const { state, soulgorger } = soulgorgerTable([corpse], 1);

    const asked = play(state, soulgorger);

    expect(pendingDecision(asked)!.kind).toBe("OGN-196-play");
    const options = optionsFor(asked, pendingDecision(asked)!);
    expect(options[0]!.id).toBe("decline");
    expect(options.map((o) => o.instanceId)).toContain(corpse.instanceId);
  });

  it("plays the chosen unit from the trash, paying its Power and NOT its Energy", () => {
    // Kog'Maw is 3 Energy + 1 Chaos Power, and after Soulgorger's own cast the
    // pool holds exactly ONE Ready rune (his 8 Energy runes are Exhausted, and an
    // Exhausted rune cannot pay Energy). So his arriving at all is the proof the
    // Energy was ignored: 3 Energy is unpayable from this pool.
    const corpse = unit(KOGMAW_CAUSTIC);
    const { state, soulgorger } = soulgorgerTable([corpse], 1);

    const cast = play(state, soulgorger);
    const channeledBefore = cast.players[0]!.channeled.length;
    const runeDeckBefore = cast.players[0]!.runeDeck.length;

    const after = answerAll(cast, pickInstance(corpse.instanceId));

    expect(after.players[0]!.trash).toHaveLength(0);
    expect(after.players[0]!.baseUnits.map((u) => u.defId)).toEqual([SOULGORGER, KOGMAW_CAUSTIC]);
    // Exactly one rune left the pool, and it went to the BOTTOM of the rune deck
    // rather than being exhausted — 416, which is what paying Power does.
    expect(after.players[0]!.channeled).toHaveLength(channeledBefore - 1);
    expect(after.players[0]!.runeDeck).toHaveLength(runeDeckBefore + 1);
    expect(after.players[0]!.baseUnits[1]!.exhausted).toBe(true); // 143.4.a
  });

  it("declining leaves the trash alone and spends nothing", () => {
    const corpse = unit(KOGMAW_CAUSTIC);
    const { state, soulgorger } = soulgorgerTable([corpse], 1);

    const cast = play(state, soulgorger);
    const channeledBefore = cast.players[0]!.channeled.length;
    const runeDeckBefore = cast.players[0]!.runeDeck.length;

    const after = answerAll(cast, () => "decline");

    expect(after.players[0]!.trash.map((c) => c.defId)).toEqual([KOGMAW_CAUSTIC]);
    expect(after.players[0]!.baseUnits.map((u) => u.defId)).toEqual([SOULGORGER]);
    expect(after.players[0]!.channeled).toHaveLength(channeledBefore);
    expect(after.players[0]!.runeDeck).toHaveLength(runeDeckBefore);
  });

  it("does not offer a unit whose Power is in a domain the pool cannot pay (416.3)", () => {
    // Magma Wurm's Power pip is Fury and this pool is all Chaos, so the option
    // must be WITHHELD rather than offered and then refused. With only the
    // decline left there is no question at all, and nobody is interrupted to be
    // told they cannot afford something.
    //
    // Note what this deliberately does NOT test: an EXHAUSTED rune of the right
    // domain still pays Power (416 recycles it whatever its state), so "spent all
    // my runes on the Soulgorger" is not a reason the option disappears. An
    // earlier version of this test assumed it was and passed for the wrong reason.
    const wurm = unit(MAGMA_WURM);
    const { state, soulgorger } = soulgorgerTable([wurm], 0);

    const after = play(state, soulgorger);

    expect(after.pendingDecisions).toHaveLength(0);
    expect(after.players[0]!.trash.map((c) => c.defId)).toEqual([MAGMA_WURM]);
  });

  it("...and DOES offer it once one rune of that domain is in the pool", () => {
    // The positive control for the case above: without it, an option list that
    // was empty for some unrelated reason would read exactly the same.
    const wurm = unit(MAGMA_WURM);
    const { state, soulgorger } = soulgorgerTable([wurm], 0);
    state.players[0]!.channeled = [
      ...state.players[0]!.channeled,
      { id: "fury-1", domain: "Fury", state: "Ready" },
    ];

    const after = play(state, soulgorger);

    expect(pendingDecision(after)!.kind).toBe("OGN-196-play");
    expect(optionsFor(after, pendingDecision(after)!).map((o) => o.instanceId)).toContain(wurm.instanceId);
    const played = answerAll(after, pickInstance(wurm.instanceId));
    expect(played.players[0]!.baseUnits.map((u) => u.defId)).toEqual([SOULGORGER, MAGMA_WURM]);
  });

  it("ignores SPELLS in the trash — 'a unit'", () => {
    const trashedSpell = spell(INCINERATE);
    const { state, soulgorger } = soulgorgerTable([trashedSpell], 3);

    const after = play(state, soulgorger);

    expect(after.pendingDecisions).toHaveLength(0); // decline only
    expect(after.players[0]!.trash.map((c) => c.defId)).toEqual([INCINERATE]);
  });

  it("asks nothing with an empty trash, and still deploys", () => {
    const { state, soulgorger } = soulgorgerTable([], 3);

    const after = play(state, soulgorger);

    expect(after.pendingDecisions).toHaveLength(0);
    expect(after.players[0]!.baseUnits.map((u) => u.defId)).toEqual([SOULGORGER]);
  });

  it("the unit it plays is a real PLAY — its own on-play trigger fires", () => {
    // Zaunite Bouncer's trigger arrives with no target (playUnitToBase carries
    // none), so the observable proof is the OTHER half of a real play: Lecturing
    // Yordle's "when you play me, draw 1".
    const yordle = unit("OGN-087"); // [Tank] "When you play me, draw 1." — 0 Power
    const { state, soulgorger } = soulgorgerTable([yordle], 0);
    state.players[0]!.deck = [makeUnit({ name: "Drawn" })];

    const after = answerAll(play(state, soulgorger), pickInstance(yordle.instanceId));

    expect(after.players[0]!.baseUnits.map((u) => u.defId)).toEqual([SOULGORGER, "OGN-087"]);
    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["Drawn"]);
    expect(after.players[0]!.cardsPlayedThisTurn).toBe(2); // the Soulgorger and the Yordle
  });
});

describe("coverage sees all six", () => {
  it("reports them as implemented", () => {
    for (const id of [ACCEPTABLE_LOSSES, WHIRLWIND, INVERT_TIMELINES, ZAUNITE_BOUNCER, KOGMAW_CAUSTIC, SOULGORGER]) {
      expect(isCardImplemented(registry.get(id)), `${id} (${registry.get(id).name})`).toBe(true);
    }
  });
});
