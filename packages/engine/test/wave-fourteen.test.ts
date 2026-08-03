import { describe, expect, it } from "vitest";
import { resolveCardEffect } from "../src/engine/card-effect-resolution.js";
import { dispatchOnAttack } from "../src/engine/unit-triggers.js";
import { answerDecision, optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance } from "../src/model/card.js";
import type { GameState, SpellChainEntry } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { answerDecisions, makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";
import type { DecisionOption } from "../src/engine/decisions.js";

/**
 * Wave 14 — the four cards that each needed a NEW way to ask a question:
 * Divine Judgment (eight of them), Promising Future (four, in two different
 * orders), Ava Achiever (one carrying a payment and a battlefield) and Nocturne
 * - Horrifying (one raised by the act of LOOKING at a card).
 */

const registry = defaultCardRegistry();
const DIVINE_JUDGMENT = "OGN-244";
const PROMISING_FUTURE = "OGN-115";
const AVA_ACHIEVER = "OGN-107";
const NOCTURNE_HORRIFYING = "OGN-194";
const STACKED_DECK = "OGN-183"; // "Look at the top 3 ... put 1 into your hand"
const TEEMO_STRATEGIST = "OGN-121"; // a [Hidden] card for Ava to play
const ENERGY_CONDUIT = "OGN-098"; // an ordinary gear
const HEXTECH_RAY = "OGN-009"; // Fury 1E/1P — a cheap spell to fill a deck with

const rune = (id: string, domain: RuneCard["domain"], state: RuneCard["state"] = "Ready"): RuneCard => ({ id, domain, state });

const choose = (id: string) => (options: DecisionOption[]) => options.find((o) => o.id === id)?.id ?? options[0]!.id;

const gear = (defId: string, instanceId: string): GearInstance =>
  ({ ...createCardInstance(registry.get(defId)), instanceId }) as GearInstance;

/** Resolves a spell straight out of its caster's hand, the way a popped chain
 *  entry would — these four are all "no targets, ask at resolution" cards. */
function castSpell(state: GameState, defId: string, playerIndex: 0 | 1 = 0): GameState {
  const entry: SpellChainEntry = {
    card: spellInstance(defId),
    playerIndex,
    payment: { energyRunes: [], powerRunes: [] },
  } as SpellChainEntry;
  return resolveCardEffect(state, entry);
}

/** The KINDS of every question a state asks, in the order it asks them —
 *  answering each with its first option as it goes. The order is what several of
 *  these cards are about, and it is invisible to `answerDecisions`. */
function askedKinds(state: GameState): string[] {
  const kinds: string[] = [];
  let current = state;
  for (let guard = 0; guard < 40; guard += 1) {
    const decision = pendingDecision(current);
    if (!decision) return kinds;
    kinds.push(decision.kind);
    const answered = answerDecision(current, decision.id, optionsFor(current, decision)[0]!.id);
    if (!answered) throw new Error(`askedKinds: refused for ${decision.kind}`);
    current = answered;
  }
  throw new Error("askedKinds: the queue never emptied");
}

describe("Divine Judgment (OGN-244): each player keeps 2 of each", () => {
  /** Both players with 4 units, 4 gear, 4 runes and 4 cards in hand. */
  function judgmentState(): GameState {
    const state = makeState({ phase: "Action" });
    for (const index of [0, 1] as const) {
      const tag = index === 0 ? "a" : "b";
      state.players[index]!.baseUnits = Array.from({ length: 4 }, (_, i) => makeUnit({ instanceId: `${tag}-u${i}`, might: 2 }));
      state.players[index]!.activeGear = Array.from({ length: 4 }, (_, i) => gear(ENERGY_CONDUIT, `${tag}-g${i}`));
      state.players[index]!.channeled = Array.from({ length: 4 }, (_, i) => rune(`${tag}-r${i}`, "Order"));
      state.players[index]!.hand = Array.from({ length: 4 }, () => spellInstance(HEXTECH_RAY));
    }
    return state;
  }

  it("cuts every category of BOTH players down to exactly 2", () => {
    const settled = answerDecisions(castSpell(judgmentState(), DIVINE_JUDGMENT));

    for (const index of [0, 1] as const) {
      const player = settled.players[index]!;
      expect(player.baseUnits, `player ${index} units`).toHaveLength(2);
      expect(player.activeGear, `player ${index} gear`).toHaveLength(2);
      expect(player.channeled, `player ${index} runes`).toHaveLength(2);
      expect(player.hand, `player ${index} hand`).toHaveLength(2);
    }
  });

  it("RECYCLES rather than kills — nothing reaches a trash", () => {
    // The difference decides whether a [Deathknell] fires and whether the cards
    // can come back, and it is the one thing the card's wording settles.
    const settled = answerDecisions(castSpell(judgmentState(), DIVINE_JUDGMENT));
    expect(settled.players[0]!.trash, "something died instead of being recycled").toHaveLength(0);
    // 4 units + 4 gear + 4 hand cards, 2 of each kept: 6 to the bottom of the deck.
    expect(settled.players[0]!.deck).toHaveLength(6);
    expect(settled.players[0]!.runeDeck.length, "the runes went to the wrong deck").toBe(2);
  });

  it("keeps what the ANSWERING player chose, not what the caster wanted", () => {
    // Each player's own cut: p0 keeps its last two units, p1 its first two.
    const state = judgmentState();
    const settled = answerDecisions(castSpell(state, DIVINE_JUDGMENT), (options, decision) =>
      decision.playerIndex === 0 ? options[0]!.id : options[options.length - 1]!.id,
    );

    expect(settled.players[0]!.baseUnits.map((u) => u.instanceId)).toEqual(["a-u2", "a-u3"]);
    expect(settled.players[1]!.baseUnits.map((u) => u.instanceId)).toEqual(["b-u0", "b-u1"]);
  });

  it("asks NOTHING of a category already at or under 2 (422)", () => {
    const state = judgmentState();
    state.players[0]!.activeGear = [gear(ENERGY_CONDUIT, "a-g0")];
    state.players[1]!.activeGear = [];

    const kinds = askedKinds(castSpell(state, DIVINE_JUDGMENT));
    expect(kinds, "a gear question was asked with 1 and with 0 gear").not.toContain("OGN-244-cut-gear");
    expect(kinds, "the unit question vanished too").toContain("OGN-244-cut-units");
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(DIVINE_JUDGMENT))).toBe(true);
  });
});

describe("Promising Future (OGN-115): both look, then both play", () => {
  /** Both players with a 6-card deck and enough Power to pay for what they keep. */
  function futureState(): GameState {
    const state = makeState({ phase: "Action" });
    for (const index of [0, 1] as const) {
      state.players[index]!.deck = Array.from({ length: 6 }, () => spellInstance(HEXTECH_RAY));
      state.players[index]!.channeled = Array.from({ length: 3 }, (_, i) => rune(`${index}-f${i}`, "Fury"));
    }
    return state;
  }

  it("banishes one of the top 5 for EACH player and recycles the other four", () => {
    const state = futureState();
    const before = state.players[0]!.deck.map((c) => c.instanceId);
    const settled = answerDecisions(castSpell(state, PROMISING_FUTURE));

    // Banished-then-played, so the card is out of the deck entirely; the four
    // recycled ones went to the bottom, behind the sixth card.
    expect(settled.players[0]!.deck).toHaveLength(5);
    expect(settled.players[0]!.deck[0]!.instanceId, "the untouched sixth card is not on top").toBe(before[5]);
  });

  it("PLAYS what was banished, ignoring the Energy but paying the Power", () => {
    const state = futureState();
    const settled = answerDecisions(castSpell(state, PROMISING_FUTURE));

    // Hextech Ray is 1 Energy, 1 Fury Power. Each player played one: their
    // banished zone is empty again and exactly one Fury rune is gone.
    for (const index of [0, 1] as const) {
      expect(settled.players[index]!.banished, `player ${index} never played it`).toHaveLength(0);
      expect(settled.players[index]!.channeled.length, `player ${index} paid no Power`).toBe(2);
    }
  });

  it("LEAVES it banished when the Power cannot be paid (422)", () => {
    // The one branch that distinguishes this from every other ignoring-its-cost
    // card in the pool: the Power is still a real price.
    const state = futureState();
    state.players[0]!.channeled = [rune("c0", "Calm"), rune("c1", "Calm")];
    const settled = answerDecisions(castSpell(state, PROMISING_FUTURE));

    expect(settled.players[0]!.banished, "a Calm pool paid a Fury pip").toHaveLength(1);
    expect(settled.players[1]!.banished, "the other player was blocked too").toHaveLength(0);
  });

  it("asks BOTH players to look before either plays", () => {
    // The card's whole ordering: neither player chooses against a board the
    // other has already changed.
    //
    // Only the two BANISH questions are ever put to a player: the play step is a
    // one-option decision, which `advanceDecisions` resolves without prompting,
    // so it exists purely to be sequenced behind both looks.
    const kinds = askedKinds(castSpell(futureState(), PROMISING_FUTURE));
    expect(kinds).toEqual(["OGN-115-banish", "OGN-115-banish"]);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(PROMISING_FUTURE))).toBe(true);
  });
});

describe("Ava Achiever (OGN-107): a [Hidden] card out of hand when she attacks", () => {
  /** Ava attacking bf1 with a [Hidden] card in hand and a Mind pool. */
  function avaState(mindRunes = 1): GameState {
    const state = makeState({ phase: "Action" });
    const ava = { ...realUnitInstance(AVA_ACHIEVER), instanceId: "ava" };
    state.battlefields[0]!.units = { p1: [ava], p2: [makeUnit({ instanceId: "foe", might: 2 })] };
    state.players[0]!.hand = [spellInstance(TEEMO_STRATEGIST), spellInstance(HEXTECH_RAY)];
    state.players[0]!.channeled = Array.from({ length: mindRunes }, (_, i) => rune(`m${i}`, "Mind"));
    return state;
  }

  const attack = (state: GameState) =>
    dispatchOnAttack(state, state.battlefields[0]!.units["p1"]![0]!, 0, "bf1");

  it("offers only the [Hidden] card, never the rest of the hand", () => {
    const asked = attack(avaState());
    const decision = pendingDecision(asked)!;
    expect(decision.kind).toBe("OGN-107-play");

    const offered = optionsFor(asked, decision);
    expect(offered.map((o) => o.id)).toContain("decline");
    expect(offered.length, "a non-[Hidden] card was offered, or the [Hidden] one was not").toBe(2);
  });

  it("plays it HERE — the battlefield she attacked, not her base", () => {
    const asked = attack(avaState());
    const hidden = asked.players[0]!.hand.find((c) => c.defId === TEEMO_STRATEGIST)!;
    const settled = answerDecisions(asked, choose(hidden.instanceId));

    expect(settled.players[0]!.baseUnits, "it landed at base instead").toHaveLength(0);
    expect(
      (settled.battlefields[0]!.units["p1"] ?? []).map((u) => u.defId),
      "it never reached the battlefield",
    ).toContain(TEEMO_STRATEGIST);
  });

  it("takes the Mind Power for it", () => {
    const asked = attack(avaState());
    const hidden = asked.players[0]!.hand.find((c) => c.defId === TEEMO_STRATEGIST)!;
    const settled = answerDecisions(asked, choose(hidden.instanceId));
    expect(settled.players[0]!.channeled, "the Mind rune was not spent").toHaveLength(0);
  });

  it("is not asked at all with no Mind Power", () => {
    // One option ("decline") is no question, and advanceDecisions retires it —
    // so an unpayable trigger never reaches the player.
    const state = avaState(0);
    state.players[0]!.channeled = [rune("c0", "Calm")];
    expect(attack(state).pendingDecisions).toHaveLength(0);
  });

  it("does nothing when declined", () => {
    const asked = attack(avaState());
    const settled = answerDecisions(asked, choose("decline"));
    expect(settled.players[0]!.hand, "the card left hand anyway").toHaveLength(2);
    expect(settled.players[0]!.channeled, "it paid for nothing").toHaveLength(1);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(AVA_ACHIEVER))).toBe(true);
  });
});

describe("Nocturne - Horrifying (OGN-194): a trigger on being LOOKED at", () => {
  /** Nocturne on top of a deck, with a Stacked Deck about to look at it. */
  function nocturneState(runeCount = 1): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.deck = [
      realUnitInstance(NOCTURNE_HORRIFYING),
      spellInstance(HEXTECH_RAY),
      spellInstance(HEXTECH_RAY),
      spellInstance(HEXTECH_RAY),
    ];
    state.players[0]!.channeled = Array.from({ length: runeCount }, (_, i) => rune(`x${i}`, "Chaos"));
    return state;
  }

  it("is offered when a look reaches him, BEFORE the looking card's own question", () => {
    const asked = castSpell(nocturneState(), STACKED_DECK);
    expect(pendingDecision(asked)?.kind, "the looking card asked first").toBe("OGN-194-banish");
  });

  it("is NOT offered when he is deeper than the look reaches", () => {
    // The whole condition: "from the TOP of your deck". Stacked Deck sees 3.
    const state = nocturneState();
    const [nocturne, ...rest] = state.players[0]!.deck;
    state.players[0]!.deck = [...rest, nocturne!];

    const asked = castSpell(state, STACKED_DECK);
    expect(pendingDecision(asked)?.kind).toBe("OGN-183-keep");
  });

  it("banishes and PLAYS him for 1 rainbow Power", () => {
    const asked = castSpell(nocturneState(), STACKED_DECK);
    const settled = answerDecisions(asked, choose("play"));

    expect(settled.players[0]!.baseUnits.map((u) => u.defId), "he never arrived").toContain(NOCTURNE_HORRIFYING);
    expect(settled.players[0]!.banished, "he is in play AND banished").toHaveLength(0);
    expect(settled.players[0]!.channeled, "the rainbow Power was not paid").toHaveLength(0);
  });

  it("can banish him WITHOUT playing him — two separate 'you may's", () => {
    const asked = castSpell(nocturneState(), STACKED_DECK);
    const settled = answerDecisions(asked, choose("banish"));

    expect(settled.players[0]!.banished.map((c) => c.defId)).toEqual([NOCTURNE_HORRIFYING]);
    expect(settled.players[0]!.baseUnits, "banishing alone put him in play").toHaveLength(0);
    expect(settled.players[0]!.channeled, "banishing alone cost Power").toHaveLength(1);
  });

  it("offers no PLAY option with no Power to pay for it", () => {
    const asked = castSpell(nocturneState(0), STACKED_DECK);
    const decision = pendingDecision(asked)!;
    expect(optionsFor(asked, decision).map((o) => o.id)).toEqual(["decline", "banish"]);
  });

  it("leaves him in the deck when declined", () => {
    const asked = castSpell(nocturneState(), STACKED_DECK);
    // Declining Nocturne leaves Stacked Deck's own question behind, and its
    // first option is the top card — which is HIM. Taking the last option
    // instead keeps the assertion about the decline rather than about which
    // card a follow-up question happened to draw.
    const settled = answerDecisions(asked, (options) =>
      options.some((o) => o.id === "decline") ? "decline" : options[options.length - 1]!.id,
    );
    expect(settled.players[0]!.deck.some((c) => c.defId === NOCTURNE_HORRIFYING)).toBe(true);
    expect(settled.players[0]!.banished).toHaveLength(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(NOCTURNE_HORRIFYING))).toBe(true);
  });
});
