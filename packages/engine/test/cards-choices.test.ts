import { describe, expect, it } from "vitest";
import { effectForCard } from "../src/engine/card-effects.js";
import { contextFor } from "../src/engine/effect-context.js";
import { dispatchOnMove, dispatchOnPlayUnit } from "../src/engine/unit-triggers.js";
import { executeActivateAbility } from "../src/actions/execute-activate-ability.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { recordConquest } from "../src/engine/scoring.js";
import { runBeginning } from "../src/engine/turn-manager.js";
import { modifiedEnergyCost } from "../src/engine/cost-modifiers.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { unitEntersReady } from "../src/engine/deploy.js";
import { discardCards, destroyUnit } from "../src/engine/effect-helpers.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { GearInstance, UnitInstance } from "../src/model/card.js";
import { answerDecisions, makeState, makeUnit, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * The batch whose cards each needed one new mechanism: a decision over a zone
 * the chooser does not own, a per-turn or per-unit memory, or a new event.
 *
 * Everything goes through the composed registries and the real executors, never
 * a resolver closure.
 */

const registry = defaultCardRegistry();

const SUN_DISC = "OGN-021";
const SHAKEDOWN = "OGN-033";
const KAISA_SURVIVOR = "OGN-039";
const PARTY_FAVORS = "OGN-071";
const DR_MUNDO = "OGN-109";
const EKKO_RECURRENT = "OGN-110";
const SPOILS_OF_WAR = "OGN-144";
const SABOTAGE = "OGN-156";
const MISS_FORTUNE_CAPTAIN = "OGN-162";
const STACKED_DECK = "OGN-183";
const MINDSPLITTER = "OGN-192";
const JINX_REBEL = "OGN-202";
const FORGE_OF_THE_FUTURE = "OGN-212";

const BATCH = [
  SUN_DISC, SHAKEDOWN, KAISA_SURVIVOR, PARTY_FAVORS, DR_MUNDO, EKKO_RECURRENT, SPOILS_OF_WAR,
  SABOTAGE, MISS_FORTUNE_CAPTAIN, STACKED_DECK, MINDSPLITTER, JINX_REBEL, FORGE_OF_THE_FUTURE,
];

type SpellEvent = Parameters<NonNullable<ReturnType<typeof effectForCard>>["resolve"]>[2];
const resolveSpell = (defId: string, casterIndex: 0 | 1, state: GameState, event: SpellEvent = {}): GameState => {
  const effect = effectForCard(spellInstance(defId));
  expect(effect, `${defId} has no registered effect`).toBeDefined();
  return effect!.resolve(state, contextFor(casterIndex), event);
};

function playUnit(defId: string, state: GameState, extra: Parameters<typeof dispatchOnPlayUnit>[4] = {}): {
  state: GameState;
  unit: UnitInstance;
} {
  const unit = realUnitInstance(defId);
  const actor = state.players[0]!;
  const withUnit: GameState = {
    ...state,
    players: [{ ...actor, baseUnits: [...actor.baseUnits, unit], cardsPlayedThisTurn: actor.cardsPlayedThisTurn + 1 }, state.players[1]!],
  };
  return { state: dispatchOnPlayUnit(withUnit, unit, 0, "base", extra), unit };
}

function gear(defId: string, instanceId: string): GearInstance {
  const def = registry.get(defId);
  return {
    instanceId, defId, name: def.name, domains: def.domains, exhausted: false, isToken: false,
    kind: "Gear", energyCost: 0, powerCost: 0, powerDomain: null, keywords: {},
  } as GearInstance;
}

const pick = (id: string) => (options: { id: string }[]) => options.find((o) => o.id === id)!.id;

describe("Stacked Deck (OGN-183): look at the top 3, keep 1, recycle the rest", () => {
  function deckState(): GameState {
    const state = makeState();
    state.players[0]!.deck = ["a", "b", "c", "d"].map((n) => makeUnit({ name: n }));
    return state;
  }

  it("offers exactly the top 3", () => {
    const asked = resolveSpell(STACKED_DECK, 0, deckState());
    expect(optionsFor(asked, pendingDecision(asked)!).map((o) => o.label)).toEqual(["a", "b", "c"]);
  });

  it("puts the chosen one in hand and sends the other two to the BOTTOM", () => {
    const asked = resolveSpell(STACKED_DECK, 0, deckState());
    const chosen = optionsFor(asked, pendingDecision(asked)!).find((o) => o.label === "b")!;
    const after = answerDecisions(asked, () => chosen.id);

    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["b"]);
    expect(after.players[0]!.deck.map((c) => c.name)).toEqual(["d", "a", "c"]);
  });

  it("cannot be answered with a card from deeper in the deck", () => {
    const asked = resolveSpell(STACKED_DECK, 0, deckState());
    const deep = asked.players[0]!.deck[3]!.instanceId;
    expect(optionsFor(asked, pendingDecision(asked)!).some((o) => o.id === deep)).toBe(false);
  });
});

describe("Mindsplitter (OGN-192): the caster picks what the opponent discards", () => {
  it("discards the chosen card from the OPPONENT's hand", () => {
    const start = makeState();
    start.players[1]!.hand = [makeUnit({ name: "Keep" }), makeUnit({ name: "Lose" })];

    const { state } = playUnit(MINDSPLITTER, start);
    const target = optionsFor(state, pendingDecision(state)!).find((o) => o.label === "Lose")!;
    const after = answerDecisions(state, () => target.id);

    expect(after.players[1]!.hand.map((c) => c.name)).toEqual(["Keep"]);
    expect(after.players[1]!.trash.map((c) => c.name)).toEqual(["Lose"]);
  });

  it("is answered by the CASTER even though the cards are the opponent's", () => {
    // Two cards, because a single option is not a question: advanceDecisions
    // executes it immediately and nothing stays pending to inspect.
    const start = makeState();
    start.players[1]!.hand = [makeUnit({ name: "A" }), makeUnit({ name: "B" })];
    const { state } = playUnit(MINDSPLITTER, start);

    expect(pendingDecision(state)!.playerIndex).toBe(0);
  });

  it("does not stop to ask when the opponent holds exactly one card", () => {
    // The other half of the same rule, asserted rather than assumed: one option
    // is executed, not offered.
    const start = makeState();
    start.players[1]!.hand = [makeUnit({ name: "Only" })];
    const { state } = playUnit(MINDSPLITTER, start);

    expect(state.pendingDecisions).toHaveLength(0);
    expect(state.players[1]!.trash.map((c) => c.name)).toEqual(["Only"]);
  });

  it("sets the opponent's discardedThisTurn — it routes through the discard funnel", () => {
    // Not a hand-rolled move: a discarded card must still fire its own trigger
    // and still arm Raging Soul / Jinx - Rebel for whoever discarded.
    const start = makeState();
    start.players[1]!.hand = [makeUnit({ name: "Lose" })];
    const { state } = playUnit(MINDSPLITTER, start);
    const after = answerDecisions(state);

    expect(after.players[1]!.discardedThisTurn).toBe(true);
  });

  it("asks nothing when the opponent's hand is empty", () => {
    const { state } = playUnit(MINDSPLITTER, makeState());
    expect(state.pendingDecisions).toHaveLength(0);
  });
});

describe("Sabotage (OGN-156): recycle a NON-UNIT from the opponent's hand", () => {
  it("offers only non-units, and sends the choice to the bottom of THEIR deck", () => {
    // Two spells, so the question is a real one and stays pending long enough to
    // inspect — one option would be executed on the spot.
    const state = makeState();
    state.players[1]!.hand = [makeUnit({ name: "Body" }), spellInstance("OGN-114"), spellInstance("OGN-224")];
    state.players[1]!.deck = [makeUnit({ name: "Bottom marker" })];

    const asked = resolveSpell(SABOTAGE, 0, state);
    const options = optionsFor(asked, pendingDecision(asked)!);
    expect(options.map((o) => o.label).sort()).toEqual(["Progress Day", "Salvage"]);

    const after = answerDecisions(asked, (o) => o.find((x) => x.label === "Progress Day")!.id);
    expect(after.players[1]!.hand.map((c) => c.name).sort()).toEqual(["Body", "Salvage"]);
    expect(after.players[1]!.deck.map((c) => c.name)).toEqual(["Bottom marker", "Progress Day"]);
    expect(after.players[1]!.trash).toHaveLength(0); // recycled, not discarded
  });

  it("does nothing against a hand of only units", () => {
    const state = makeState();
    state.players[1]!.hand = [makeUnit({ name: "Body" })];
    const after = answerDecisions(resolveSpell(SABOTAGE, 0, state));

    expect(after.players[1]!.hand).toHaveLength(1);
  });
});

describe("Party Favors (OGN-071): the OPPONENT chooses Cards or Runes, both get it", () => {
  function favorsState(): GameState {
    const state = makeState();
    for (const i of [0, 1] as const) {
      state.players[i]!.deck = [makeUnit({ name: `deck${i}` })];
      state.players[i]!.runeDeck = [{ id: `r${i}`, domain: "Calm", state: "Ready" }];
    }
    return state;
  }

  it("is answered by the opponent, not the caster", () => {
    const asked = resolveSpell(PARTY_FAVORS, 0, favorsState());
    expect(pendingDecision(asked)!.playerIndex).toBe(1);
  });

  it("Cards: both players draw 1", () => {
    const after = answerDecisions(resolveSpell(PARTY_FAVORS, 0, favorsState()), pick("cards"));
    expect(after.players[0]!.hand).toHaveLength(1);
    expect(after.players[1]!.hand).toHaveLength(1);
  });

  it("Runes: both players channel 1 exhausted", () => {
    const after = answerDecisions(resolveSpell(PARTY_FAVORS, 0, favorsState()), pick("runes"));
    expect(after.players[0]!.channeled.map((r) => r.state)).toEqual(["Exhausted"]);
    expect(after.players[1]!.channeled.map((r) => r.state)).toEqual(["Exhausted"]);
  });
});

describe("Shakedown (OGN-033): 6 damage unless its controller gives you 2 cards", () => {
  function shakeState(): { state: GameState; victim: UnitInstance } {
    const victim = makeUnit({ name: "Victim", might: 9 });
    const state = makeState();
    state.battlefields[0]!.units = { p2: [victim] };
    state.players[0]!.deck = [makeUnit({ name: "d1" }), makeUnit({ name: "d2" })];
    return { state, victim };
  }

  it("asks the VICTIM's controller", () => {
    const { state, victim } = shakeState();
    const asked = resolveSpell(SHAKEDOWN, 0, state, { targetUnitInstanceId: victim.instanceId });
    expect(pendingDecision(asked)!.playerIndex).toBe(1);
  });

  it("takes 6 when they choose damage", () => {
    const { state, victim } = shakeState();
    const after = answerDecisions(resolveSpell(SHAKEDOWN, 0, state, { targetUnitInstanceId: victim.instanceId }), pick("damage"));

    expect(after.battlefields[0]!.units["p2"]![0]!.damage).toBe(6);
    expect(after.players[0]!.hand).toHaveLength(0);
  });

  it("gives the CASTER two cards when they choose the draw, and deals nothing", () => {
    const { state, victim } = shakeState();
    const after = answerDecisions(resolveSpell(SHAKEDOWN, 0, state, { targetUnitInstanceId: victim.instanceId }), pick("draw"));

    expect(after.battlefields[0]!.units["p2"]![0]!.damage).toBe(0);
    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["d1", "d2"]);
  });
});

describe("Sun Disc (OGN-021): [Legion] — the NEXT unit you play enters ready", () => {
  function discState(cardsPlayed: number): GameState {
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [gear(SUN_DISC, "disc")];
    state.players[0]!.cardsPlayedThisTurn = cardsPlayed;
    return state;
  }

  const activate = (state: GameState) =>
    executeActivateAbility(state, legalActions(state).find((a) => a.type === "ActivateAbility" && a.permanentInstanceId === "disc")! as never);

  it("arms one charge when Legion is met", () => {
    const after = activate(discState(1));
    expect(after.players[0]!.nextUnitsEnterReady).toBe(1);
    expect(after.players[0]!.activeGear[0]!.exhausted).toBe(true);
  });

  it("arms nothing with Legion unmet — but still spends the exhaust", () => {
    const after = activate(discState(0));
    expect(after.players[0]!.nextUnitsEnterReady).toBe(0);
    expect(after.players[0]!.activeGear[0]!.exhausted).toBe(true);
  });

  it("readies the NEXT unit only — it is a charge, not Confront's blanket flag", () => {
    const armed = activate(discState(1));
    const first = makeUnit({ name: "First" });
    const second = makeUnit({ name: "Second" });

    expect(unitEntersReady(armed, 0, first)).toBe(true);
    // Spending it is what deploy.consumeNextUnitEntersReady does on a real play;
    // simulated here by decrementing, which is what the executor stores.
    const spent: GameState = {
      ...armed,
      players: [{ ...armed.players[0]!, nextUnitsEnterReady: 0 }, armed.players[1]!],
    };
    expect(unitEntersReady(spent, 0, second)).toBe(false);
  });
});

describe("Spoils of War (OGN-144): costs 2 less if an ENEMY unit has died this turn", () => {
  it("is full price before anything dies", () => {
    const state = makeState();
    const printed = 4;
    expect(modifiedEnergyCost(state, 0, "Spell", printed, SPOILS_OF_WAR)).toBe(printed);
  });

  it("is discounted once an opponent's unit has died", () => {
    const victim = makeUnit({ name: "Theirs" });
    let state = makeState();
    state.battlefields[0]!.units = { p2: [victim] };
    state = destroyUnit(state, victim.instanceId, 0);

    expect(state.players[1]!.unitsLostThisTurn).toBe(1);
    expect(modifiedEnergyCost(state, 0, "Spell", 4, SPOILS_OF_WAR)).toBe(2);
  });

  it("is NOT discounted by your own unit dying", () => {
    const mine = makeUnit({ name: "Mine" });
    let state = makeState();
    state.battlefields[0]!.units = { p1: [mine] };
    state = destroyUnit(state, mine.instanceId, 1);

    expect(modifiedEnergyCost(state, 0, "Spell", 4, SPOILS_OF_WAR)).toBe(4);
  });

  it("draws 2", () => {
    const state = makeState();
    state.players[0]!.deck = [makeUnit({ name: "a" }), makeUnit({ name: "b" })];
    expect(resolveSpell(SPOILS_OF_WAR, 0, state).players[0]!.hand).toHaveLength(2);
  });
});

describe("Miss Fortune - Captain (OGN-162): the FIRST time I move each turn", () => {
  function captainState(): { state: GameState; captain: UnitInstance; ally: UnitInstance } {
    const captain = realUnitInstance(MISS_FORTUNE_CAPTAIN);
    const ally = makeUnit({ name: "Ally" });
    ally.exhausted = true;
    const state = makeState();
    state.battlefields[0]!.units = { p1: [captain, ally] };
    return { state, captain, ally };
  }

  it("asks on the first move and readies the chosen permanent", () => {
    const { state, captain, ally } = captainState();
    const asked = dispatchOnMove(state, captain, 0, "bf1", true);
    expect(pendingDecision(asked)!.kind).toBe("OGN-162-ready");

    const after = answerDecisions(asked, (o) => o.find((x) => x.id === ally.instanceId)!.id);
    expect(after.battlefields[0]!.units["p1"]!.find((u) => u.name === "Ally")!.exhausted).toBe(false);
  });

  it("does NOT ask on a later move in the same turn", () => {
    const { state, captain } = captainState();
    expect(dispatchOnMove(state, captain, 0, "bf1", false).pendingDecisions).toHaveLength(0);
  });

  it("offers the Legend too — 'something else', not 'a unit'", () => {
    const { state, captain } = captainState();
    state.players[0]!.legend.exhausted = true;

    const asked = dispatchOnMove(state, captain, 0, "bf1", true);
    const labels = optionsFor(asked, pendingDecision(asked)!).map((o) => o.label);

    expect(labels.some((l) => l.includes("Test Legend"))).toBe(true);
  });

  it("never offers HERSELF — 'something ELSE'", () => {
    const { state, captain } = captainState();
    const withExhaustedCaptain: GameState = {
      ...state,
      battlefields: state.battlefields.map((bf) =>
        bf.id === "bf1" ? { ...bf, units: { ...bf.units, p1: bf.units["p1"]!.map((u) => ({ ...u, exhausted: true })) } } : bf,
      ),
    };

    const asked = dispatchOnMove(withExhaustedCaptain, captain, 0, "bf1", true);
    const ids = optionsFor(asked, pendingDecision(asked)!).map((o) => o.instanceId);

    expect(ids).not.toContain(captain.instanceId);
  });

  it("declining costs nothing", () => {
    const { state, captain, ally } = captainState();
    const after = answerDecisions(dispatchOnMove(state, captain, 0, "bf1", true), pick("decline"));
    expect(after.battlefields[0]!.units["p1"]!.find((u) => u.instanceId === ally.instanceId)!.exhausted).toBe(true);
  });

  it("asks nothing when there is nothing exhausted to ready", () => {
    const captain = realUnitInstance(MISS_FORTUNE_CAPTAIN);
    const state = makeState();
    state.battlefields[0]!.units = { p1: [captain] };
    expect(dispatchOnMove(state, captain, 0, "bf1", true).pendingDecisions).toHaveLength(0);
  });
});

/**
 * `battlefieldConquered` is a Chain Pending Item now (383 / 809.1.b.3), so a
 * conquer trigger no longer resolves inside `recordConquest` — it lands in
 * `state.pendingTriggers`, is finalized onto the chain by the Cleanup, and
 * resolves when both players have passed on it.
 *
 * These tests therefore drive `resolveHeldTriggers`, and the NEGATIVE ones assert
 * on the PEN as well as on the outcome. That second half is not belt-and-braces:
 * "the hand is empty" is now true immediately after ANY conquest, so a negative
 * test that only checked the hand would pass whether the condition worked or the
 * trigger simply had not resolved yet. Four Mistfall tests went green for exactly
 * that wrong reason when `unitBuffed` was converted.
 */
describe("Kai'Sa - Survivor (OGN-039): when I conquer, draw 1", () => {
  function kaisaState(): GameState {
    const kaisa = realUnitInstance(KAISA_SURVIVOR);
    const state = makeState();
    state.battlefields[0]!.units = { p1: [kaisa] };
    state.players[0]!.deck = [makeUnit({ name: "Drawn" })];
    return state;
  }

  it("draws when she is AT the conquered battlefield", () => {
    const after = resolveHeldTriggers(recordConquest(kaisaState(), 0, "bf1"));
    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["Drawn"]);
  });

  it("is HELD rather than resolved at the source — the opponent gets a window", () => {
    // The conversion itself. Nothing has been drawn at the moment of the
    // conquest; the trigger is a Pending Item waiting for the Cleanup.
    const conquered = recordConquest(kaisaState(), 0, "bf1");

    expect(conquered.players[0]!.hand).toHaveLength(0);
    expect(conquered.pendingTriggers.map((t) => t.listenerDefId)).toEqual([KAISA_SURVIVOR]);
  });

  it("does NOT draw for a conquest elsewhere — it is 'when I conquer'", () => {
    const conquered = recordConquest(kaisaState(), 0, "bf2");
    expect(conquered.pendingTriggers, "a trigger was held for a conquest that is not hers").toHaveLength(0);
    expect(resolveHeldTriggers(conquered).players[0]!.hand).toHaveLength(0);
  });

  it("does NOT draw when the OPPONENT conquers her battlefield", () => {
    const conquered = recordConquest(kaisaState(), 1, "bf1");
    expect(conquered.pendingTriggers, "a trigger was held for the opponent's conquest").toHaveLength(0);
    expect(resolveHeldTriggers(conquered).players[0]!.hand).toHaveLength(0);
  });
});

/**
 * Qiyana - Victorious (OGN-155): "When I conquer, draw 1 or channel 1 rune exhausted."
 *
 * Kai'Sa's trigger above with a choice on the end, so the location tests are hers
 * and the interesting ones here are the two answers. Both must actually FIRE
 * through the decision queue — a parked question that resolves to nothing is the
 * dispatch-hop failure this suite exists to catch.
 *
 * Her `[Deflect]` remains unimplemented and she is still correctly reported as
 * partial; that is asserted in coverage-drift.test.ts, not here.
 */
describe("Qiyana - Victorious (OGN-155): when I conquer, draw 1 or channel 1 exhausted", () => {
  const QIYANA_VICTORIOUS = "OGN-155";

  /** Qiyana at bf1 with something to draw AND something to channel, so neither
   *  answer can pass merely because the other pile was empty. */
  function qiyanaState(): GameState {
    const state = makeState();
    state.battlefields[0]!.units = { p1: [realUnitInstance(QIYANA_VICTORIOUS)] };
    state.players[0]!.deck = [makeUnit({ name: "Drawn" })];
    state.players[0]!.runeDeck = [{ id: "rune-x", domain: "Body", state: "Ready" }];
    return state;
  }

  it("asks the question when she conquers, rather than picking for the player", () => {
    const after = resolveHeldTriggers(recordConquest(qiyanaState(), 0, "bf1"));
    const decision = pendingDecision(after);

    expect(decision?.kind).toBe("OGN-155-conquer");
    // Two real answers and no decline — the card offers an either/or, not a "may".
    expect(optionsFor(after, decision!).map((o) => o.id)).toEqual(["draw", "channel"]);
  });

  it("draws when that is the answer, and does NOT channel", () => {
    const before = qiyanaState();
    const after = answerDecisions(resolveHeldTriggers(recordConquest(before, 0, "bf1")), (options) => options.find((o) => o.id === "draw")!.id);

    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["Drawn"]);
    expect(after.players[0]!.runeDeck).toHaveLength(1); // untouched
    expect(after.players[0]!.channeled).toHaveLength(0);
  });

  it("channels one rune EXHAUSTED when that is the answer, and does NOT draw", () => {
    const after = answerDecisions(
      resolveHeldTriggers(recordConquest(qiyanaState(), 0, "bf1")),
      (options) => options.find((o) => o.id === "channel")!.id,
    );

    expect(after.players[0]!.hand).toHaveLength(0); // untouched
    expect(after.players[0]!.runeDeck).toHaveLength(0);
    // Exhausted, not Ready — that is what makes it weaker than a free rune.
    expect(after.players[0]!.channeled.map((r) => r.state)).toEqual(["Exhausted"]);
  });

  it("asks nothing for a conquest she is not at", () => {
    // Asserted on the PEN first: `pendingDecisions` is empty immediately after
    // ANY conquest now that the trigger is held, so checking it alone would pass
    // whether the location condition worked or the trigger merely had not
    // resolved yet.
    const conquered = recordConquest(qiyanaState(), 0, "bf2");
    expect(conquered.pendingTriggers).toHaveLength(0);
    expect(resolveHeldTriggers(conquered).pendingDecisions).toHaveLength(0);
  });

  it("asks nothing when the OPPONENT conquers her battlefield", () => {
    const conquered = recordConquest(qiyanaState(), 1, "bf1");
    expect(conquered.pendingTriggers).toHaveLength(0);
    expect(resolveHeldTriggers(conquered).pendingDecisions).toHaveLength(0);
  });

  it("still asks when a pile is empty — an empty deck is a real choice, not a non-choice", () => {
    // Drawing from an empty deck is what triggers Burn Out (431), so pruning the
    // option would hide a legal and sometimes decisive line. And a one-option
    // question auto-resolves, so pruning would silently choose for the player.
    const state = qiyanaState();
    state.players[0]!.deck = [];
    const after = resolveHeldTriggers(recordConquest(state, 0, "bf1"));

    expect(optionsFor(after, pendingDecision(after)!).map((o) => o.id)).toEqual(["draw", "channel"]);
  });
});

describe("Ekko - Recurrent (OGN-110): [Accelerate] — recycle me to ready your runes", () => {
  function ekkoState(): GameState {
    const state = makeState();
    state.players[0]!.channeled = [
      { id: "r1", domain: "Mind", state: "Exhausted" },
      { id: "r2", domain: "Mind", state: "Exhausted" },
    ];
    return state;
  }

  it("readies every channeled rune and recycles himself to the deck bottom", () => {
    const { state, unit } = playUnit(EKKO_RECURRENT, ekkoState(), { acceleratePaid: true });

    expect(state.players[0]!.channeled.every((r) => r.state === "Ready")).toBe(true);
    expect(state.players[0]!.baseUnits.some((u) => u.instanceId === unit.instanceId)).toBe(false);
    expect(state.players[0]!.deck.at(-1)!.instanceId).toBe(unit.instanceId);
  });

  it("is NOT a death — he never reaches the trash", () => {
    const { state } = playUnit(EKKO_RECURRENT, ekkoState(), { acceleratePaid: true });
    expect(state.players[0]!.trash).toHaveLength(0);
  });

  it("does nothing when Accelerate was declined", () => {
    const { state, unit } = playUnit(EKKO_RECURRENT, ekkoState(), { acceleratePaid: false });

    expect(state.players[0]!.channeled.every((r) => r.state === "Exhausted")).toBe(true);
    expect(state.players[0]!.baseUnits.some((u) => u.instanceId === unit.instanceId)).toBe(true);
  });
});

describe("Jinx - Rebel (OGN-202): when you discard one or more, ready me and +1 Might", () => {
  function jinxState(handSize: number): GameState {
    const jinx = realUnitInstance(JINX_REBEL);
    jinx.exhausted = true;
    const state = makeState();
    state.battlefields[0]!.units = { p1: [jinx] };
    state.players[0]!.hand = Array.from({ length: handSize }, (_, i) => makeUnit({ name: `h${i}` }));
    return state;
  }

  it("fires once for a discard of 2 — 'one or more', not per card", () => {
    const state = jinxState(3);
    const after = answerDecisions(discardCards(state, 0, 2));
    const jinx = after.battlefields[0]!.units["p1"]![0]!;

    expect(jinx.exhausted).toBe(false);
    expect(jinx.mightThisTurn).toBe(1); // once, not twice
  });

  it("does not fire when the OPPONENT discards", () => {
    const state = jinxState(0);
    state.players[1]!.hand = [makeUnit({ name: "theirs" })];

    const after = answerDecisions(discardCards(state, 1, 1));

    expect(after.battlefields[0]!.units["p1"]![0]!.exhausted).toBe(true);
  });

  it("does not fire when nothing was actually discarded", () => {
    const state = jinxState(0);
    expect(discardCards(state, 0, 2).battlefields[0]!.units["p1"]![0]!.exhausted).toBe(true);
  });
});

describe("Dr. Mundo - Expert (OGN-109)", () => {
  it("gains Might equal to the cards in his OWNER's trash", () => {
    const mundo = realUnitInstance(DR_MUNDO);
    const state = makeState();
    state.battlefields[0]!.units = { p1: [mundo] };
    state.players[0]!.trash = [makeUnit({ name: "t1" }), makeUnit({ name: "t2" })];
    state.players[1]!.trash = [makeUnit({ name: "theirs" })];

    expect(effectiveMight(state, mundo, 0, { isCombat: false, battlefieldId: "bf1" })).toBe(mundo.might + 2);
  });

  it("recycles up to 3 from his trash at the start of his controller's Beginning Phase", () => {
    const mundo = realUnitInstance(DR_MUNDO);
    const state = makeState({ phase: "Beginning", activePlayerIndex: 0 });
    state.battlefields[0]!.units = { p1: [mundo] };
    state.players[0]!.trash = ["t1", "t2", "t3", "t4"].map((n) => makeUnit({ name: n }));

    const after = runBeginning(state);

    expect(after.players[0]!.trash.map((c) => c.name)).toEqual(["t4"]);
    expect(after.players[0]!.deck.map((c) => c.name)).toEqual(["t1", "t2", "t3"]);
  });

  it("recycles what it can from a short trash — it is an effect, not a cost", () => {
    const mundo = realUnitInstance(DR_MUNDO);
    const state = makeState({ phase: "Beginning", activePlayerIndex: 0 });
    state.battlefields[0]!.units = { p1: [mundo] };
    state.players[0]!.trash = [makeUnit({ name: "only" })];

    const after = runBeginning(state);

    expect(after.players[0]!.trash).toHaveLength(0);
    expect(after.players[0]!.deck.map((c) => c.name)).toEqual(["only"]);
  });

  it("shrinks him — the two clauses fight each other, which is the card", () => {
    const mundo = realUnitInstance(DR_MUNDO);
    const state = makeState({ phase: "Beginning", activePlayerIndex: 0 });
    state.battlefields[0]!.units = { p1: [mundo] };
    state.players[0]!.trash = ["t1", "t2", "t3"].map((n) => makeUnit({ name: n }));

    const before = effectiveMight(state, mundo, 0, { isCombat: false, battlefieldId: "bf1" });
    const after = runBeginning(state);
    const now = effectiveMight(after, mundo, 0, { isCombat: false, battlefieldId: "bf1" });

    expect(before).toBe(mundo.might + 3);
    expect(now).toBe(mundo.might);
  });
});

describe("Forge of the Future (OGN-212): a token on play, then kill it to recycle", () => {
  it("kills itself to pay, and recycles up to 4 taking the OPPONENT's trash first", () => {
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [gear(FORGE_OF_THE_FUTURE, "forge")];
    state.players[0]!.trash = [makeUnit({ name: "mine1" }), makeUnit({ name: "mine2" })];
    state.players[1]!.trash = ["t1", "t2", "t3"].map((n) => makeUnit({ name: n }));

    const action = legalActions(state).find((a) => a.type === "ActivateAbility" && a.permanentInstanceId === "forge")!;
    const after = executeActivateAbility(state, action as never);

    // Three from theirs, then one from mine — four total.
    expect(after.players[1]!.trash).toHaveLength(0);
    // The Forge is dead, not merely exhausted...
    expect(after.players[0]!.activeGear).toHaveLength(0);
    // ...and it is in the caster's trash by the time the effect resolves, because
    // the cost is paid FIRST. So its own trash reads [mine1, mine2, Forge], one
    // is taken, and the Forge can legitimately be recycled by its own ability if
    // the count reaches it. Asserted rather than avoided: this is what paying a
    // cost before resolving an effect means, and a test that dodged it would be
    // hiding the interaction rather than pinning it.
    expect(after.players[0]!.trash.map((c) => c.name)).toEqual(["mine2", "Forge of the Future"]);
  });

  it("recycles what is there when the trashes hold fewer than 4", () => {
    const state = makeState({ phase: "Action" });
    state.players[0]!.activeGear = [gear(FORGE_OF_THE_FUTURE, "forge")];
    state.players[1]!.trash = [makeUnit({ name: "only" })];

    const action = legalActions(state).find((a) => a.type === "ActivateAbility" && a.permanentInstanceId === "forge")!;
    const after = executeActivateAbility(state, action as never);

    expect(after.players[1]!.deck.map((c) => c.name)).toEqual(["only"]);
  });
});

describe("coverage", () => {
  it("reports all thirteen of this batch as implemented", () => {
    expect(BATCH.filter((id) => !isCardImplemented(registry.get(id)))).toEqual([]);
  });
});
