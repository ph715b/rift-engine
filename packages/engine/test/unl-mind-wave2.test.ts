import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { effectiveKeywords } from "../src/engine/granted-keywords.js";
import { runBeginning } from "../src/engine/turn-manager.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { Domain } from "../src/model/domain.js";
import type { RuneCard } from "../src/model/rune.js";
import type { PlayCardAction, PlayerAction } from "../src/actions/player-action.js";
import type { CardInstance, UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * The Unleashed (UNL) Mind cards of wave 2 — effects/mind.ts.
 *
 * **Everything drives `legalActions` -> `submit`, never a resolver closure.** A
 * card is registered in one table and reached through several dispatch hops
 * (enumeration, the chain, and for three of these a question raised
 * mid-resolution); every hop is somewhere the effect can be dropped without the
 * card looking broken, and calling `cardEffects["UNL-072"].resolve` directly
 * would clear all of them at once.
 *
 * Each card has a NEGATIVE control beside its happy path — a unit the effect
 * must not touch, a card that must not be offered, a deck that must not move —
 * because an assertion that only proves "something happened" passes just as
 * happily for a card that hits everything.
 *
 * Helpers are local rather than added to fixtures.ts, which is shared and being
 * edited by other agents in this tree — the call unl-mind.test.ts already records.
 */

const registry = defaultCardRegistry();

const DOWNSTAGE_DRAMATICS = "UNL-061"; // Spell, 2 Energy — "[Reaction][Repeat][2] Draw 1."
const ECLIPSE = "UNL-063"; // Spell, 3 Energy — "-4 Might this turn. [Predict]."
const FATE_WEAVER = "UNL-064"; // Unit, 5 Energy 4 Might — look 4, may draw a 4+ spell
const MOONLIGHT_AFFLICTION = "UNL-066"; // Spell, 7 Energy — "-10 Might this turn."
const SPRITE_BURST = "UNL-069"; // Spell, 5 Energy — two ready 3-Might Temporary Sprites
const CHAKRAM_DANCER = "UNL-071"; // Unit, 3 Energy 3 Might — "give your other units here [Shield]"
const CRESCENT_STRIKE = "UNL-072"; // Spell, 3 Energy + 1 Mind — 4 to one enemy, 1 to the others

/** A cheap real Spell for the deck-manipulation tests to look at — 2 Energy, so
 *  it is BELOW Fate Weaver's "[4] or more" and is the negative control there.
 *  (Consult the Past, the obvious filler, is 4 Energy and QUALIFIES — measured,
 *  after it turned this filter test green for the wrong reason.) */
const TURN_TO_DUST = "UNL-070"; // Spell, 2 Energy — BELOW the floor, and the negative control for the filter
const PROMISING_FUTURE = "OGN-115"; // Spell, 6 Energy — comfortably over Fate Weaver's floor
const TIME_WARP = "OGN-122"; // Spell, 10 Energy — the dearest thing in the pool

/** Enough Ready runes of a card's own Power domain to pay for it outright.
 *  Energy is domain-agnostic, so one colour covers both halves. */
function runesFor(defId: string, count = 24): RuneCard[] {
  const domain: Domain = registry.get(defId).powerDomain ?? "Mind";
  return Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));
}

/** Every enumerated way to play one card instance. */
function castsOf(state: GameState, instanceId: string): PlayCardAction[] {
  return legalActions(state).filter(
    (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId,
  );
}

/** Passes Focus until nothing is left on the chain or in the holding pen, or a
 *  question is outstanding (`submit` refuses a PassFocus while one is, 320.1). */
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

function castAndResolve(state: GameState, action: PlayerAction | undefined): GameState {
  expect(action, "the card was never enumerated as playable").toBeDefined();
  const submitted = submit(state, action!);
  expect(submitted.result, "the play was refused").toEqual({ type: "Ok" });
  return passUntilSettled(submitted.state);
}

/** Answers the pending question by option id, through `submit`. */
function answer(state: GameState, optionId: string): GameState {
  const decision = pendingDecision(state);
  expect(decision, "no question was pending").toBeDefined();
  const result = submit(state, {
    type: "AnswerDecision",
    playerIndex: decision!.playerIndex,
    decisionId: decision!.id,
    optionId,
  });
  expect(result.result, `the answer "${optionId}" was refused`).toEqual({ type: "Ok" });
  return passUntilSettled(result.state);
}

/** The labels currently on offer. */
function offered(state: GameState): string[] {
  const decision = pendingDecision(state);
  expect(decision, "no question was pending").toBeDefined();
  return optionsFor(state, decision!).map((o) => o.label);
}

/** The unit as the BOARD holds it, wherever it stands — never the object handed
 *  to a fixture, which is a snapshot from before the spell ran. */
function unitOnBoard(state: GameState, instanceId: string): UnitInstance | undefined {
  for (const player of state.players) {
    const found =
      player.baseUnits.find((u) => u.instanceId === instanceId) ??
      state.battlefields.flatMap((bf) => bf.units[player.id] ?? []).find((u) => u.instanceId === instanceId);
    if (found) return found;
  }
  return undefined;
}

const deckNames = (state: GameState, playerIndex: 0 | 1): string[] =>
  state.players[playerIndex]!.deck.map((c) => c.name);
const handNames = (state: GameState, playerIndex: 0 | 1): string[] =>
  state.players[playerIndex]!.hand.map((c) => c.name);

/** A deck of real cards, in the given order from the top. */
function deckOf(...defIds: string[]): CardInstance[] {
  return defIds.map((id) => spellInstance(id));
}

describe("Downstage Dramatics (UNL-061): [Reaction] draw 1", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(DOWNSTAGE_DRAMATICS))).toBe(true);
  });

  function dramaticsState() {
    const spell = spellInstance(DOWNSTAGE_DRAMATICS);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runesFor(DOWNSTAGE_DRAMATICS);
    state.players[0]!.deck = deckOf(TIME_WARP, PROMISING_FUTURE, TURN_TO_DUST);
    state.players[1]!.deck = deckOf(TIME_WARP, PROMISING_FUTURE);
    return { state, spellId: spell.instanceId };
  }

  /** The non-repeat candidate, BY NAME. Taking `[0]` was a silent dependency on
   *  there being only one candidate; once the [Repeat] was priced it became
   *  whichever the enumerator emitted first, and this block drew twice. */
  const plainCast = (state: GameState, spellId: string) => {
    const plain = castsOf(state, spellId).find((a) => !a.repeatPaid);
    expect(plain, "no plain variant — 820.1 makes the Repeat OPTIONAL").toBeDefined();
    return plain!;
  };

  it("draws exactly one card, off the caster's own deck", () => {
    const { state, spellId } = dramaticsState();

    const after = castAndResolve(state, plainCast(state, spellId));

    // The spell itself leaves hand and lands in the trash, so the hand is exactly
    // the drawn card — a count assertion alone would be satisfied by drawing
    // nothing and never discarding the spell.
    expect(handNames(after, 0)).toEqual(["Time Warp"]);
    expect(deckNames(after, 0)).toEqual(["Promising Future", "Turn to Dust"]);
  });

  it("the OPPONENT draws nothing", () => {
    const { state, spellId } = dramaticsState();

    const after = castAndResolve(state, plainCast(state, spellId));

    expect(handNames(after, 1)).toEqual([]);
    expect(deckNames(after, 1)).toEqual(["Time Warp", "Promising Future"]);
  });

  /**
   * **The pin here did its job, and is now the positive assertion.**
   *
   * It asserted the WRONG answer on purpose — that no repeat variant was offered,
   * because `REPEAT_COSTS` had no row and the printed "[Repeat] [2]" was inert
   * while coverage reported the card finished. Adding the row on 2026-08-09 failed
   * it loudly, which is exactly what a pin is for: the behaviour change could not
   * happen quietly.
   *
   * Rewritten rather than deleted, so the card keeps a test where the gap was —
   * and this one has teeth the pin could not: it proves the repeat actually DRAWS
   * a second card, not merely that a variant is enumerated.
   */
  it("the [Repeat] is priced, and paying it draws a SECOND card", () => {
    const { state, spellId } = dramaticsState();
    const plays = castsOf(state, spellId);

    expect(plays.length, "the card was never enumerated at all").toBeGreaterThan(0);
    const repeated = plays.find((a) => a.repeatPaid === true);
    expect(repeated, "the [Repeat] is inert again — REPEAT_COSTS lost its row").toBeDefined();

    const after = castAndResolve(state, repeated!);
    expect(handNames(after, 0), "paying the Repeat drew only once").toEqual(["Time Warp", "Promising Future"]);
    expect(deckNames(after, 0)).toEqual(["Turn to Dust"]);
  });
});

describe("Eclipse (UNL-063): -4 Might this turn, then [Predict]", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(ECLIPSE))).toBe(true);
  });

  /** The spell in hand, one enemy at a battlefield and one bystander in the
   *  opponent's base — so "a unit" reaching base is testable and so is the
   *  "only the chosen one" half. */
  function eclipseState() {
    const spell = spellInstance(ECLIPSE);
    const victim = makeUnit({ name: "Victim", might: 6 });
    const bystander = makeUnit({ name: "Bystander", might: 6 });
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runesFor(ECLIPSE);
    state.players[0]!.deck = deckOf(TIME_WARP, PROMISING_FUTURE, TURN_TO_DUST);
    state.players[1]!.baseUnits = [bystander];
    state.battlefields[0]!.units = { p2: [victim] };
    return { state, spellId: spell.instanceId, victim, bystander };
  }

  it("takes 4 Might off the chosen unit and nothing off anyone else", () => {
    const { state, spellId, victim, bystander } = eclipseState();

    const cast = castsOf(state, spellId).find((a) => a.targetUnitInstanceId === victim.instanceId);
    const after = castAndResolve(state, cast);

    expect(unitOnBoard(after, victim.instanceId)?.mightThisTurn, "the debuff never landed").toBe(-4);
    expect(unitOnBoard(after, bystander.instanceId)?.mightThisTurn, "'a unit' is singular").toBe(0);
  });

  it("reaches a unit standing in a BASE — the bare noun is not battlefield-only", () => {
    const { state, spellId, bystander } = eclipseState();

    const cast = castsOf(state, spellId).find((a) => a.targetUnitInstanceId === bystander.instanceId);
    const after = castAndResolve(state, cast);

    expect(unitOnBoard(after, bystander.instanceId)?.mightThisTurn).toBe(-4);
  });

  it("has NO floor — a 1-Might unit really goes to -3, not to 1", () => {
    // The clause Smoke Screen prints and this card does not (143.2.b). Observable
    // through the stored modifier: a floored version would read -0 here.
    const { state, spellId } = eclipseState();
    const small = makeUnit({ name: "Small", might: 1 });
    state.battlefields[1]!.units = { p2: [small] };

    const cast = castsOf(state, spellId).find((a) => a.targetUnitInstanceId === small.instanceId);
    const after = castAndResolve(state, cast);

    expect(unitOnBoard(after, small.instanceId)?.mightThisTurn).toBe(-4);
  });

  it("stops to ask the [Predict], and recycling puts the top card on the bottom", () => {
    const { state, spellId, victim } = eclipseState();

    const cast = castsOf(state, spellId).find((a) => a.targetUnitInstanceId === victim.instanceId);
    const asked = castAndResolve(state, cast);

    expect(pendingDecision(asked), "the [Predict] asked nothing at all").toBeDefined();
    expect(offered(asked)).toEqual(["Leave the top card", "Recycle Time Warp"]);

    const after = answer(asked, "recycle");

    expect(deckNames(after, 0)).toEqual(["Promising Future", "Turn to Dust", "Time Warp"]);
    // Nothing was drawn — a Predict looks and recycles, it does not draw.
    expect(handNames(after, 0)).toEqual([]);
  });

  it("declining leaves the deck exactly as it was", () => {
    const { state, spellId, victim } = eclipseState();
    const cast = castsOf(state, spellId).find((a) => a.targetUnitInstanceId === victim.instanceId);
    const asked = castAndResolve(state, cast);

    const after = answer(asked, "decline");

    expect(deckNames(after, 0)).toEqual(["Time Warp", "Promising Future", "Turn to Dust"]);
  });

  it("asks nothing on an empty deck — 436.4's 'as many as possible', and no Burn Out", () => {
    const { state, spellId, victim } = eclipseState();
    state.players[0]!.deck = [];

    const cast = castsOf(state, spellId).find((a) => a.targetUnitInstanceId === victim.instanceId);
    const after = castAndResolve(state, cast);

    expect(pendingDecision(after), "a question with no answer was left standing").toBeUndefined();
    expect(after.players[0]!.deck).toEqual([]);
    expect(after.players[1]!.points, "436.4.a says predicting a short deck is not a Burn Out").toBe(0);
    expect(unitOnBoard(after, victim.instanceId)?.mightThisTurn, "the debuff half was lost").toBe(-4);
  });
});

describe("Moonlight Affliction (UNL-066): -10 Might this turn", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(MOONLIGHT_AFFLICTION))).toBe(true);
  });

  function afflictionState() {
    const spell = spellInstance(MOONLIGHT_AFFLICTION);
    const victim = makeUnit({ name: "Victim", might: 8 });
    const bystander = makeUnit({ name: "Bystander", might: 8 });
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runesFor(MOONLIGHT_AFFLICTION);
    state.battlefields[0]!.units = { p2: [victim, bystander] };
    return { state, spellId: spell.instanceId, victim, bystander };
  }

  it("takes 10 off the chosen unit, past 0 and with no floor", () => {
    const { state, spellId, victim, bystander } = afflictionState();

    const cast = castsOf(state, spellId).find((a) => a.targetUnitInstanceId === victim.instanceId);
    const after = castAndResolve(state, cast);

    expect(unitOnBoard(after, victim.instanceId)?.mightThisTurn).toBe(-10);
    expect(unitOnBoard(after, bystander.instanceId)?.mightThisTurn, "it hit the neighbour too").toBe(0);
  });

  it("does not KILL — 143.2.a needs nonzero damage, not zero Might", () => {
    // Worth pinning: -10 looks like removal and is not. The unit is still on the
    // board and still in nobody's trash.
    const { state, spellId, victim } = afflictionState();

    const cast = castsOf(state, spellId).find((a) => a.targetUnitInstanceId === victim.instanceId);
    const after = castAndResolve(state, cast);

    expect(unitOnBoard(after, victim.instanceId), "the debuff killed it").toBeDefined();
    expect(after.players[1]!.trash.map((c) => c.name)).toEqual([]);
  });
});

describe("Sprite Burst (UNL-069): two ready 3-Might Temporary Sprites", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(SPRITE_BURST))).toBe(true);
  });

  function burstState() {
    const spell = spellInstance(SPRITE_BURST);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runesFor(SPRITE_BURST);
    return { state, spellId: spell.instanceId };
  }

  it("makes TWO separate tokens in the caster's base, ready and Temporary", () => {
    const { state, spellId } = burstState();

    const after = castAndResolve(state, castsOf(state, spellId)[0]);

    const sprites = after.players[0]!.baseUnits;
    expect(sprites, "the tokens never arrived").toHaveLength(2);
    // Two OBJECTS (714), not one with a count — distinct instance ids.
    expect(new Set(sprites.map((u) => u.instanceId)).size).toBe(2);
    for (const sprite of sprites) {
      expect(sprite.name).toBe("Sprite");
      expect(sprite.might).toBe(3);
      expect(sprite.exhausted, "'ready' overrides 143.4.a").toBe(false);
      expect(sprite.keywords.Temporary).toBe(1);
    }
  });

  it("pays the opponent nothing", () => {
    const { state, spellId } = burstState();

    const after = castAndResolve(state, castsOf(state, spellId)[0]);

    expect(after.players[1]!.baseUnits).toEqual([]);
  });

  it("both die in the caster's own Beginning Phase — 816, which is the whole price", () => {
    const { state, spellId } = burstState();
    const cast = castAndResolve(state, castsOf(state, spellId)[0]);

    const theirTurn = runBeginning({ ...cast, phase: "Beginning", activePlayerIndex: 1 });
    expect(theirTurn.players[0]!.baseUnits, "they died on the wrong player's turn").toHaveLength(2);

    const ourTurn = runBeginning({ ...cast, phase: "Beginning", activePlayerIndex: 0 });
    expect(ourTurn.players[0]!.baseUnits, "816 never swept them").toHaveLength(0);
  });
});

describe("Crescent Strike (UNL-072): 4 to one enemy, 1 to each other enemy there", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(CRESCENT_STRIKE))).toBe(true);
  });

  /** Three enemies at bf1, one enemy at bf2, and one FRIENDLY unit at bf1 — every
   *  word of "each other ENEMY unit THERE" has something to be wrong about. */
  function strikeState() {
    const spell = spellInstance(CRESCENT_STRIKE);
    const focus = makeUnit({ name: "Focus", might: 9 });
    const neighbourA = makeUnit({ name: "Neighbour A", might: 9 });
    const neighbourB = makeUnit({ name: "Neighbour B", might: 9 });
    const elsewhere = makeUnit({ name: "Elsewhere", might: 9 });
    const ally = makeUnit({ name: "Ally", might: 9 });
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runesFor(CRESCENT_STRIKE);
    state.battlefields[0]!.units = { p1: [ally], p2: [focus, neighbourA, neighbourB] };
    state.battlefields[1]!.units = { p2: [elsewhere] };
    return { state, spellId: spell.instanceId, focus, neighbourA, neighbourB, elsewhere, ally };
  }

  it("deals 4 to the chosen enemy and 1 to each other enemy at that battlefield", () => {
    const { state, spellId, focus, neighbourA, neighbourB } = strikeState();

    const cast = castsOf(state, spellId).find((a) => a.targetUnitInstanceId === focus.instanceId);
    const after = castAndResolve(state, cast);

    expect(unitOnBoard(after, focus.instanceId)?.damage, "the focus damage never landed").toBe(4);
    expect(unitOnBoard(after, neighbourA.instanceId)?.damage).toBe(1);
    expect(unitOnBoard(after, neighbourB.instanceId)?.damage).toBe(1);
  });

  it("touches nothing at another battlefield and nothing FRIENDLY — 'each other ENEMY unit THERE'", () => {
    const { state, spellId, focus, elsewhere, ally } = strikeState();

    const cast = castsOf(state, spellId).find((a) => a.targetUnitInstanceId === focus.instanceId);
    const after = castAndResolve(state, cast);

    expect(unitOnBoard(after, elsewhere.instanceId)?.damage, "the splash crossed battlefields").toBe(0);
    expect(unitOnBoard(after, ally.instanceId)?.damage, "the splash hit our own side").toBe(0);
  });

  it("never offers a FRIENDLY unit as the focus", () => {
    // The enemy standing beside it is what stops this passing for a spell that is
    // never enumerated at all.
    const { state, spellId, focus, ally } = strikeState();

    const targets = castsOf(state, spellId).map((a) => a.targetUnitInstanceId);

    expect(targets, "the enemy was not offered either — nothing is being measured").toContain(focus.instanceId);
    expect(targets).not.toContain(ally.instanceId);
  });
});

describe("Fate Weaver (UNL-064): look 4, maybe draw a spell costing [4]+", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(FATE_WEAVER))).toBe(true);
  });

  /** Fate Weaver in hand over a known top 4: one dear spell, one cheap spell and
   *  two more, so both the filter and "the rest" have something to prove. */
  function weaverState(deck = deckOf(TURN_TO_DUST, PROMISING_FUTURE, TURN_TO_DUST, TURN_TO_DUST, TIME_WARP)) {
    const weaver = realUnitInstance(FATE_WEAVER);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [weaver];
    state.players[0]!.channeled = runesFor(FATE_WEAVER);
    state.players[0]!.deck = deck;
    return { state, weaverId: weaver.instanceId };
  }

  it("offers ONLY the spell costing [4] or more from among the top four", () => {
    const { state, weaverId } = weaverState();

    const asked = castAndResolve(state, castsOf(state, weaverId)[0]);

    expect(pendingDecision(asked), "her on-play trigger asked nothing").toBeDefined();
    // Time Warp is 10 Energy and would qualify — it is FIFTH, so it is not among
    // the four looked at, which is what makes this a look and not a search.
    expect(offered(asked)).toEqual(["Recycle all four", "Draw Promising Future"]);
  });

  it("draws the chosen spell and recycles the other three to the bottom", () => {
    const { state, weaverId } = weaverState();
    const asked = castAndResolve(state, castsOf(state, weaverId)[0]);
    const promising = optionsFor(asked, pendingDecision(asked)!).find((o) => o.label === "Draw Promising Future")!;

    const after = answer(asked, promising.id);

    expect(handNames(after, 0), "the reveal-and-draw never happened").toEqual(["Promising Future"]);
    // The three that were not taken go to the BOTTOM in looked order (416), and
    // the fifth card is untouched on top.
    expect(deckNames(after, 0)).toEqual([
      "Time Warp",
      "Turn to Dust",
      "Turn to Dust",
      "Turn to Dust",
    ]);
  });

  it("declining still recycles all four — 'recycle the rest' is its own instruction", () => {
    const { state, weaverId } = weaverState();
    const asked = castAndResolve(state, castsOf(state, weaverId)[0]);

    const after = answer(asked, "decline");

    expect(handNames(after, 0), "declining drew something anyway").toEqual([]);
    expect(deckNames(after, 0)).toEqual([
      "Time Warp",
      "Turn to Dust",
      "Promising Future",
      "Turn to Dust",
      "Turn to Dust",
    ]);
  });

  it("with no qualifying spell it never prompts, and still recycles all four", () => {
    // The negative control for the filter AND for the mandatory half: a top four
    // of cheap spells and units offers nothing to take, so `advanceDecisions`
    // retires the one-option question unshown — but the recycle must still run.
    const { state, weaverId } = weaverState(
      deckOf(TURN_TO_DUST, TURN_TO_DUST, TURN_TO_DUST, TURN_TO_DUST, TIME_WARP),
    );

    const after = castAndResolve(state, castsOf(state, weaverId)[0]);

    expect(pendingDecision(after), "a question with only a decline was shown").toBeUndefined();
    expect(handNames(after, 0)).toEqual([]);
    expect(deckNames(after, 0)).toEqual([
      "Time Warp",
      "Turn to Dust",
      "Turn to Dust",
      "Turn to Dust",
      "Turn to Dust",
    ]);
  });

  it("a UNIT of 4+ Energy is not a candidate — the card says 'a spell'", () => {
    const { state, weaverId } = weaverState();
    // Fate Weaver herself is 5 Energy; put a copy on top of the deck.
    state.players[0]!.deck = [realUnitInstance(FATE_WEAVER), ...state.players[0]!.deck.slice(0, 3)];

    const asked = castAndResolve(state, castsOf(state, weaverId)[0]);

    expect(pendingDecision(asked)).toBeDefined();
    expect(offered(asked)).toEqual(["Recycle all four", "Draw Promising Future"]);
  });

  it("an empty deck does nothing at all rather than parking a dead question", () => {
    const { state, weaverId } = weaverState([]);

    const after = castAndResolve(state, castsOf(state, weaverId)[0]);

    expect(pendingDecision(after)).toBeUndefined();
    expect(after.players[0]!.deck).toEqual([]);
    expect(handNames(after, 0)).toEqual([]);
  });
});

describe("Chakram Dancer (UNL-071): your other units here get [Shield] this turn", () => {
  it("is NOT reported implemented — [Ambush] is still unwritten", () => {
    // Registration is per defId, so this is the one assertion that says the card
    // is half done: coverage flags it through `UNIMPLEMENTED_KEYWORDS`, and when
    // [Ambush] lands this flips and the expectation has to be updated with it.
    expect(isCardImplemented(registry.get(CHAKRAM_DANCER))).toBe(false);
  });

  /** The Dancer in hand, an ally already at bf1 (which is also what lets her be
   *  played there at all), an enemy at bf1, an ally at bf2 and an ally at home. */
  function dancerState() {
    const dancer = realUnitInstance(CHAKRAM_DANCER);
    const here = makeUnit({ name: "Here", might: 4 });
    const enemyHere = makeUnit({ name: "Enemy Here", might: 4 });
    const there = makeUnit({ name: "There", might: 4 });
    const atHome = makeUnit({ name: "At Home", might: 4 });
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [dancer];
    state.players[0]!.channeled = runesFor(CHAKRAM_DANCER);
    state.players[0]!.baseUnits = [atHome];
    state.battlefields[0]!.units = { p1: [here], p2: [enemyHere] };
    state.battlefields[1]!.units = { p1: [there] };
    return { state, dancerId: dancer.instanceId, here, enemyHere, there, atHome };
  }

  const shieldOf = (state: GameState, instanceId: string): number | undefined =>
    unitOnBoard(state, instanceId)?.keywordsThisTurn.Shield;

  it("gives [Shield] to a friendly unit at the battlefield she was played to", () => {
    const { state, dancerId, here } = dancerState();

    const cast = castsOf(state, dancerId).find((a) => a.destinationBattlefieldId === "bf1");
    const after = castAndResolve(state, cast);

    expect(shieldOf(after, here.instanceId), "the grant never landed").toBe(1);
    // And it is a real keyword for everything that reads one, not just a field.
    const granted = unitOnBoard(after, here.instanceId)!;
    expect(effectiveKeywords(after, granted, 0).Shield).toBe(1);
  });

  it("gives it to NOBODY else — not the enemy here, not a friendly elsewhere, not herself", () => {
    const { state, dancerId, enemyHere, there, atHome } = dancerState();

    const cast = castsOf(state, dancerId).find((a) => a.destinationBattlefieldId === "bf1");
    const after = castAndResolve(state, cast);

    expect(shieldOf(after, enemyHere.instanceId), "'YOUR units' reached the opponent").toBeUndefined();
    expect(shieldOf(after, there.instanceId), "'HERE' reached another battlefield").toBeUndefined();
    expect(shieldOf(after, atHome.instanceId), "'HERE' reached the base").toBeUndefined();
    // "OTHER" — she prints [Shield 1] on the frame and must not stack a second on
    // herself, which `keywordsThisTurn` is where a self-grant would show.
    const dancerOnBoard = state.battlefields[0]!.units["p1"] ?? [];
    expect(dancerOnBoard).toBeDefined();
    const dancerNow = (after.battlefields[0]!.units["p1"] ?? []).find((u) => u.defId === CHAKRAM_DANCER);
    expect(dancerNow, "she never arrived at the battlefield").toBeDefined();
    expect(dancerNow!.keywordsThisTurn.Shield, "'OTHER units' included herself").toBeUndefined();
  });

  it("played to BASE, 'here' is the base — the ally at home gets it and the front line does not", () => {
    const { state, dancerId, here, atHome } = dancerState();

    const cast = castsOf(state, dancerId).find((a) => a.destinationBattlefieldId === undefined);
    const after = castAndResolve(state, cast);

    expect(shieldOf(after, atHome.instanceId), "'here' did not follow her home").toBe(1);
    expect(shieldOf(after, here.instanceId), "the battlefield got it from a base play").toBeUndefined();
  });

  it("sums with a printed [Shield] rather than replacing it (814.2)", () => {
    const { state, dancerId } = dancerState();
    const shielded = makeUnit({ name: "Already Shielded", might: 4, keywords: { Shield: 1 } });
    state.battlefields[0]!.units = { ...state.battlefields[0]!.units, p1: [shielded] };

    const cast = castsOf(state, dancerId).find((a) => a.destinationBattlefieldId === "bf1");
    const after = castAndResolve(state, cast);

    expect(effectiveKeywords(after, unitOnBoard(after, shielded.instanceId)!, 0).Shield).toBe(2);
  });
});
