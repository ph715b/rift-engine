import { describe, expect, it } from "vitest";
import { effectForCard } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { dispatchOnPlayUnit } from "../src/engine/unit-triggers.js";
import { modifiedEnergyCost } from "../src/engine/cost-modifiers.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { legionActive } from "../src/engine/effect-helpers.js";
import { opponentNearVictory } from "../src/engine/constants.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { answerDecisions, makeState, makeUnit, playUnitTrigger, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * The [Legion], [Accelerate] and draw/discard batch.
 *
 * Everything goes through the COMPOSED registries — effectForCard and
 * dispatchOnPlayUnit — never a resolver closure, for the reason
 * effect-registry.test.ts records: a per-domain card that is reachable by name
 * but never fires has shipped here before, and calling the closure would pass.
 */

const registry = defaultCardRegistry();

const NOXUS_HOPEFUL = "OGN-012";
const DANGEROUS_DUO = "OGN-016";
const SCRAPYARD_CHAMPION = "OGN-020";
const TRIFARIAN_GLORYSEEKER = "OGN-217";
const VANGUARD_CAPTAIN = "OGN-218";
const DARIUS_EXECUTIONER = "OGN-243";
const TASTY_FAEFOLK = "OGN-075";
const THOUSAND_TAILED = "OGN-116";
const PROGRESS_DAY = "OGN-114";
const SALVAGE = "OGN-224";
const CATALYST = "OGN-138";
const FIND_YOUR_CENTER = "OGN-047";

const BATCH = [
  NOXUS_HOPEFUL, DANGEROUS_DUO, SCRAPYARD_CHAMPION, TRIFARIAN_GLORYSEEKER, VANGUARD_CAPTAIN,
  DARIUS_EXECUTIONER, TASTY_FAEFOLK, THOUSAND_TAILED, PROGRESS_DAY, SALVAGE, CATALYST, FIND_YOUR_CENTER,
];

type SpellEvent = Parameters<NonNullable<ReturnType<typeof effectForCard>>["resolve"]>[2];
const resolveSpell = (defId: string, casterIndex: 0 | 1, state: GameState, event: SpellEvent = {}): GameState => {
  const effect = effectForCard(spellInstance(defId));
  expect(effect, `${defId} has no registered effect`).toBeDefined();
  return effect!.resolve(state, contextFor(casterIndex), event);
};

/** Plays a real Unit to base through the composed dispatch, as
 *  execute-play-card does — including the cardsPlayedThisTurn increment it
 *  performs BEFORE the trigger fires, which [Legion] depends on. */
function playUnit(
  defId: string,
  state: GameState,
  extra: Parameters<typeof dispatchOnPlayUnit>[4] = {},
): { state: GameState; unit: UnitInstance } {
  const unit = realUnitInstance(defId);
  const actor = state.players[0]!;
  const withUnit: GameState = {
    ...state,
    players: [
      { ...actor, baseUnits: [...actor.baseUnits, unit], cardsPlayedThisTurn: actor.cardsPlayedThisTurn + 1 },
      state.players[1]!,
    ],
  };
  // Settled, because an on-play trigger is now a Chain Pending Item: the
  // dispatcher HOLDS it and it resolves a chain-pop later. Every test here is
  // about what the card does rather than when, so the helper absorbs the timing
  // — `test/on-play-chain.test.ts` is where the timing itself is asserted.
  return { state: (playUnitTrigger(withUnit, unit, 0, "base", extra)), unit };
}

const ownUnits = (s: GameState) => s.players[0]!.baseUnits;

/** A card's printed Energy cost. Narrowed rather than asserted, because
 *  `CardDefinition` is a union and a Legend genuinely has no cost. */
function printedEnergyCost(defId: string): number {
  const def = registry.get(defId);
  if (!("energyCost" in def)) throw new Error(`${defId} has no printed Energy cost`);
  return def.energyCost;
}

describe("[Legion] — 'you've played ANOTHER card this turn'", () => {
  it("is false at COST time on the turn's first card, true once one has been played", () => {
    const state = makeState();
    expect(legionActive(state, 0, false)).toBe(false);
    state.players[0]!.cardsPlayedThisTurn = 1;
    expect(legionActive(state, 0, false)).toBe(true);
  });

  it("needs TWO at TRIGGER time, because the card asking is already counted", () => {
    // The off-by-one that makes a Legion card work a play too early. Invisible
    // in play: the effect simply happens when it shouldn't.
    const state = makeState();
    state.players[0]!.cardsPlayedThisTurn = 1; // just this card
    expect(legionActive(state, 0, true)).toBe(false);
    state.players[0]!.cardsPlayedThisTurn = 2;
    expect(legionActive(state, 0, true)).toBe(true);
  });

  it("does NOT fire a Legion trigger on the turn's first play", () => {
    // Driven through the same increment execute-play-card performs.
    const { state } = playUnit(TRIFARIAN_GLORYSEEKER, makeState());
    expect(ownUnits(state)[0]!.buffed).toBe(false);
  });

  it("fires it on the second", () => {
    const start = makeState();
    start.players[0]!.cardsPlayedThisTurn = 1;
    const { state } = playUnit(TRIFARIAN_GLORYSEEKER, start);
    expect(ownUnits(state)[0]!.buffed).toBe(true);
  });
});

describe("Noxus Hopeful (OGN-012): [Legion] — I cost 2 Energy less", () => {
  it("costs full price as the turn's first card", () => {
    const state = makeState();
    const printed = printedEnergyCost(NOXUS_HOPEFUL);
    expect(modifiedEnergyCost(state, 0, "Unit", printed, NOXUS_HOPEFUL)).toBe(printed);
  });

  it("costs 2 less once another card has been played", () => {
    const state = makeState();
    state.players[0]!.cardsPlayedThisTurn = 1;
    const printed = printedEnergyCost(NOXUS_HOPEFUL);
    expect(modifiedEnergyCost(state, 0, "Unit", printed, NOXUS_HOPEFUL)).toBe(printed - 2);
  });

  it("reads the discount from the CARD, not from a hardcoded id", () => {
    // legionDiscount is parsed from printed text by card-loader, so the rule
    // works for any future "[Legion] — I cost N less" with no edit.
    const def = registry.get(NOXUS_HOPEFUL);
    expect("legionDiscount" in def && def.legionDiscount).toBe(2);
  });

  it("leaves a card with no Legion discount alone", () => {
    const state = makeState();
    state.players[0]!.cardsPlayedThisTurn = 5;
    expect(modifiedEnergyCost(state, 0, "Unit", 4, DANGEROUS_DUO)).toBe(4);
  });
});

describe("Dangerous Duo (OGN-016): [Legion] — give a unit +2 Might this turn", () => {
  it("pumps the chosen unit when Legion is met", () => {
    const start = makeState();
    start.players[0]!.cardsPlayedThisTurn = 1;
    const ally = makeUnit({ name: "Ally" });
    start.players[0]!.baseUnits = [ally];

    const { state } = playUnit(DANGEROUS_DUO, start, { targetUnitInstanceId: ally.instanceId });

    expect(ownUnits(state).find((u) => u.name === "Ally")!.mightThisTurn).toBe(2);
  });

  it("does nothing with Legion unmet, even though a target was chosen", () => {
    const ally = makeUnit({ name: "Ally" });
    const start = makeState();
    start.players[0]!.baseUnits = [ally];

    const { state } = playUnit(DANGEROUS_DUO, start, { targetUnitInstanceId: ally.instanceId });

    expect(ownUnits(state).find((u) => u.name === "Ally")!.mightThisTurn).toBe(0);
  });
});

describe("Scrapyard Champion (OGN-020): [Legion] — discard 2, then draw 2", () => {
  it("discards first and draws after — a drawn card is never discarded", () => {
    const start = makeState();
    start.players[0]!.cardsPlayedThisTurn = 1;
    start.players[0]!.hand = [makeUnit({ name: "H1" }), makeUnit({ name: "H2" }), makeUnit({ name: "H3" })];
    start.players[0]!.deck = [makeUnit({ name: "D1" }), makeUnit({ name: "D2" })];

    const { state } = playUnit(SCRAPYARD_CHAMPION, start);
    const after = answerDecisions(state);

    expect(after.players[0]!.trash.map((c) => c.name).sort()).toEqual(["H1", "H2"]);
    expect(after.players[0]!.hand.map((c) => c.name).sort()).toEqual(["D1", "D2", "H3"]);
  });

  it("does nothing at all with Legion unmet", () => {
    const start = makeState();
    start.players[0]!.hand = [makeUnit({ name: "H1" }), makeUnit({ name: "H2" })];
    start.players[0]!.deck = [makeUnit({ name: "D1" })];

    const { state } = playUnit(SCRAPYARD_CHAMPION, start);

    expect(state.pendingDecisions).toHaveLength(0);
    expect(state.players[0]!.trash).toHaveLength(0);
    expect(state.players[0]!.hand.map((c) => c.name)).toEqual(["H1", "H2"]);
  });
});

describe("Vanguard Captain (OGN-218): [Legion] — play TWO Recruit tokens here", () => {
  it("makes two separate tokens", () => {
    const start = makeState();
    start.players[0]!.cardsPlayedThisTurn = 1;
    const { state, unit } = playUnit(VANGUARD_CAPTAIN, start);

    const tokens = ownUnits(state).filter((u) => u.isToken);
    expect(tokens).toHaveLength(2);
    expect(new Set(tokens.map((t) => t.instanceId)).size).toBe(2); // two objects, not one twice
    expect(tokens.every((t) => t.might === 1)).toBe(true);
    void unit;
  });

  it("makes none with Legion unmet", () => {
    const { state } = playUnit(VANGUARD_CAPTAIN, makeState());
    expect(ownUnits(state).filter((u) => u.isToken)).toHaveLength(0);
  });
});

describe("Darius - Executioner (OGN-243): [Legion] ready me; others here have +1 Might", () => {
  it("readies himself only when Legion is met", () => {
    const met = makeState();
    met.players[0]!.cardsPlayedThisTurn = 1;
    // A unit enters exhausted by default (143.4.a), which is what the ready undoes.
    const started = playUnit(DARIUS_EXECUTIONER, met);
    expect(started.state.players[0]!.baseUnits.find((u) => u.defId === DARIUS_EXECUTIONER)!.exhausted).toBe(false);
  });

  it("gives OTHER friendly units at his battlefield +1, and not himself", () => {
    const darius = realUnitInstance(DARIUS_EXECUTIONER);
    const ally = makeUnit({ name: "Ally", might: 3 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [darius, ally] };

    expect(effectiveMight(state, ally, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(4);
    expect(effectiveMight(state, darius, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(darius.might);
  });

  it("does NOT reach a unit at another battlefield, or an enemy", () => {
    const darius = realUnitInstance(DARIUS_EXECUTIONER);
    const elsewhere = makeUnit({ name: "Elsewhere", might: 3 });
    const enemy = makeUnit({ name: "Enemy", might: 3 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [darius], p2: [enemy] };
    state.battlefields[1]!.units = { p1: [elsewhere] };

    expect(effectiveMight(state, elsewhere, 0, { isCombat: false, battlefieldId: "bf2" })).toBe(3);
    expect(effectiveMight(state, enemy, 1, { isCombat: false, battlefieldId: "bf1" })).toBe(3);
  });

  it("stacks with Garen - Commander, who prints the same sentence", () => {
    const darius = realUnitInstance(DARIUS_EXECUTIONER);
    const garen = realUnitInstance("OGS-013");
    const ally = makeUnit({ name: "Ally", might: 3 });
    const state = makeState();
    state.battlefields[0]!.units = { p1: [darius, garen, ally] };

    expect(effectiveMight(state, ally, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(5);
  });

  it("the aura is NOT gated on Legion — the keyword sits before his first sentence only", () => {
    const darius = realUnitInstance(DARIUS_EXECUTIONER);
    const ally = makeUnit({ name: "Ally", might: 3 });
    const state = makeState(); // cardsPlayedThisTurn is 0
    state.battlefields[0]!.units = { p1: [darius, ally] };

    expect(effectiveMight(state, ally, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(4);
  });
});

describe("Tasty Faefolk (OGN-075): [Accelerate] — channel 2 exhausted and draw 1", () => {
  function faefolkState(): GameState {
    const state = makeState();
    state.players[0]!.runeDeck = [
      { id: "r1", domain: "Calm", state: "Ready" },
      { id: "r2", domain: "Calm", state: "Ready" },
    ];
    state.players[0]!.deck = [makeUnit({ name: "Drawn" })];
    return state;
  }

  it("fires when the Accelerate cost was PAID", () => {
    const { state } = playUnit(TASTY_FAEFOLK, faefolkState(), { acceleratePaid: true });

    expect(state.players[0]!.channeled.map((r) => r.state)).toEqual(["Exhausted", "Exhausted"]);
    expect(state.players[0]!.hand.map((c) => c.name)).toEqual(["Drawn"]);
  });

  it("does nothing when it was declined — Accelerate is a 'you may' cost (805)", () => {
    const { state } = playUnit(TASTY_FAEFOLK, faefolkState(), { acceleratePaid: false });

    expect(state.players[0]!.channeled).toHaveLength(0);
    expect(state.players[0]!.hand).toHaveLength(0);
  });

  it("does nothing when the field is absent entirely", () => {
    const { state } = playUnit(TASTY_FAEFOLK, faefolkState(), {});
    expect(state.players[0]!.channeled).toHaveLength(0);
  });
});

describe("Thousand-Tailed Watcher (OGN-116): enemy units get -3 Might, minimum 1", () => {
  it("hits every enemy unit, at battlefields AND in their base", () => {
    const atField = makeUnit({ name: "Field", might: 6 });
    const atHome = makeUnit({ name: "Home", might: 6 });
    const start = makeState();
    start.battlefields[0]!.units = { p2: [atField] };
    start.players[1]!.baseUnits = [atHome];

    const { state } = playUnit(THOUSAND_TAILED, start);

    expect(state.battlefields[0]!.units["p2"]![0]!.mightThisTurn).toBe(-3);
    expect(state.players[1]!.baseUnits[0]!.mightThisTurn).toBe(-3);
  });

  it("floors PER UNIT, so a small unit stops at 1 while a big one loses the full 3", () => {
    const small = makeUnit({ name: "Small", might: 2 });
    const big = makeUnit({ name: "Big", might: 7 });
    const start = makeState();
    start.battlefields[0]!.units = { p2: [small, big] };

    const { state } = playUnit(THOUSAND_TAILED, start);
    const after = state.battlefields[0]!.units["p2"]!;

    expect(effectiveMight(state, after[0]!, 1, { isCombat: false, battlefieldId: "bf1" })).toBe(1);
    expect(effectiveMight(state, after[1]!, 1, { isCombat: false, battlefieldId: "bf1" })).toBe(4);
  });

  it("leaves the caster's own units alone", () => {
    const mine = makeUnit({ name: "Mine", might: 6 });
    const start = makeState();
    start.battlefields[0]!.units = { p1: [mine] };

    const { state } = playUnit(THOUSAND_TAILED, start);

    expect(state.battlefields[0]!.units["p1"]!.find((u) => u.name === "Mine")!.mightThisTurn).toBe(0);
  });
});

describe("Progress Day (OGN-114): draw 4", () => {
  it("draws four", () => {
    const state = makeState();
    state.players[0]!.deck = ["a", "b", "c", "d", "e"].map((n) => makeUnit({ name: n }));

    const after = resolveSpell(PROGRESS_DAY, 0, state);

    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["a", "b", "c", "d"]);
    expect(after.players[0]!.deck).toHaveLength(1);
  });

  it("takes what is there on a short deck rather than throwing", () => {
    const state = makeState();
    state.players[0]!.deck = [makeUnit({ name: "only" })];
    expect(resolveSpell(PROGRESS_DAY, 0, state).players[0]!.hand).toHaveLength(1);
  });
});

describe("Salvage (OGN-224): you may kill up to one gear, draw 1", () => {
  function gearState(): GameState {
    const state = makeState();
    state.players[0]!.deck = [makeUnit({ name: "Drawn" })];
    state.players[1]!.activeGear = [
      { instanceId: "g1", defId: "OGN-090", name: "Orb of Regret", domains: [], exhausted: false, isToken: false, kind: "Gear", energyCost: 0, powerCost: 0, powerDomain: null, keywords: {} } as never,
    ];
    return state;
  }

  it("kills the chosen gear and draws", () => {
    const after = resolveSpell(SALVAGE, 0, gearState(), { targetPermanentInstanceId: "g1" });

    expect(after.players[1]!.activeGear).toHaveLength(0);
    expect(after.players[1]!.trash.map((c) => c.instanceId)).toContain("g1");
    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["Drawn"]);
  });

  it("still draws when no gear is chosen — 'up to one' means zero is fine", () => {
    const after = resolveSpell(SALVAGE, 0, gearState());

    expect(after.players[1]!.activeGear).toHaveLength(1);
    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["Drawn"]);
  });

  it("is castable with no gear on the board at all — a 1-card cantrip", () => {
    const state = makeState();
    state.players[0]!.deck = [makeUnit({ name: "Drawn" })];
    expect(resolveSpell(SALVAGE, 0, state).players[0]!.hand).toHaveLength(1);
  });
});

describe("Catalyst of Aeons (OGN-138): channel 2 exhausted; if you couldn't, draw 1", () => {
  function catalystState(runes: number): GameState {
    const state = makeState();
    state.players[0]!.runeDeck = Array.from({ length: runes }, (_, i) => ({ id: `r${i}`, domain: "Body" as const, state: "Ready" as const }));
    state.players[0]!.deck = [makeUnit({ name: "Drawn" })];
    return state;
  }

  it("channels two exhausted and does NOT draw", () => {
    const after = resolveSpell(CATALYST, 0, catalystState(3));

    expect(after.players[0]!.channeled.map((r) => r.state)).toEqual(["Exhausted", "Exhausted"]);
    expect(after.players[0]!.hand).toHaveLength(0);
  });

  it("channels the one it can AND draws — 'couldn't channel 2' is fewer than 2", () => {
    const after = resolveSpell(CATALYST, 0, catalystState(1));

    expect(after.players[0]!.channeled).toHaveLength(1);
    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["Drawn"]);
  });

  it("draws on an empty rune deck", () => {
    const after = resolveSpell(CATALYST, 0, catalystState(0));
    expect(after.players[0]!.hand).toHaveLength(1);
  });
});

describe("Find Your Center (OGN-047)", () => {
  it("costs 2 less only while an opponent is within 3 of the Victory Score", () => {
    const state = makeState();
    const printed = printedEnergyCost(FIND_YOUR_CENTER);

    expect(modifiedEnergyCost(state, 0, "Spell", printed, FIND_YOUR_CENTER)).toBe(printed);
    state.players[1]!.points = 5; // 8 - 5 = 3, inclusive
    expect(modifiedEnergyCost(state, 0, "Spell", printed, FIND_YOUR_CENTER)).toBe(printed - 2);
  });

  it("shares one definition of 'within 3' with Leona - Zealot", () => {
    const state = makeState();
    state.players[1]!.points = 5;
    expect(opponentNearVictory(state, 0)).toBe(true);
    state.players[1]!.points = 4;
    expect(opponentNearVictory(state, 0)).toBe(false);
  });

  it("draws 1 and channels 1 exhausted", () => {
    const state = makeState();
    state.players[0]!.deck = [makeUnit({ name: "Drawn" })];
    state.players[0]!.runeDeck = [{ id: "r1", domain: "Calm", state: "Ready" }];

    const after = resolveSpell(FIND_YOUR_CENTER, 0, state);

    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["Drawn"]);
    expect(after.players[0]!.channeled.map((r) => r.state)).toEqual(["Exhausted"]);
  });
});

describe("coverage", () => {
  it("reports all twelve of this batch as implemented", () => {
    expect(BATCH.filter((id) => !isCardImplemented(registry.get(id)))).toEqual([]);
  });
});
