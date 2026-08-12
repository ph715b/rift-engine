import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { runBeginning } from "../src/engine/turn-manager.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type LegendInstance, type UnitInstance } from "../src/model/card.js";
import type { Domain } from "../src/model/domain.js";
import type { RuneCard } from "../src/model/rune.js";
import type { ActivateAbilityAction, PlayCardAction } from "../src/actions/player-action.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * The Unleashed dual-domain (champion signature) cards of wave 6 whose first
 * domain is Mind — `effects/signature-mind.ts`.
 *
 * **Everything drives `legalActions` -> `submit`.** Calling a resolver closure
 * directly clears every dispatch hop at once, and the hops are where this engine
 * has lost effects before: a Legend's conquer/hold ability is HELD on the chain
 * (383) and only lands when the chain flushes, so a test that never passed Focus
 * would be green against a Legend that never fires.
 *
 * Each card has a NEGATIVE control that asserts its own POSITIVE control first —
 * "nothing happened" is exactly what an inert card looks like.
 *
 * Three tests are PINS on divergences named in the cards' own entries (Diana's
 * unrestricted Energy, Moonfall's unenforced "where you have units", and the
 * Reflection copy being a snapshot rather than a re-derived layer). They assert
 * the WRONG answer on purpose, so closing the gap fails loudly rather than
 * changing behaviour nobody was watching.
 *
 * Helpers are local rather than added to `fixtures.ts`, which is shared and is
 * being edited by other agents in this tree.
 */

const registry = defaultCardRegistry();

const DIANA_SCORN = "UNL-197"; // Legend, Mind/Chaos — exhaust: add 1 showdown-only Energy
const MOONFALL = "UNL-198"; // Spell, 3 Energy 1 Power — drag one enemy in, shrink enemies there
const LEBLANC_DECEIVER = "UNL-199"; // Legend, Mind/Order — conquer/hold: a Reflection copy
const MIRROR_IMAGE = "UNL-200"; // Spell, 3 Energy 2 Power — a Reflection copy of any unit
const WATCHFUL_SENTRY = "OGN-096"; // 2 Energy, 1 Might, [Deathknell] — Draw 1. The copy subject.
const TIME_WARP = "OGN-122"; // deck filler, so a draw has something to take

/** Enough Ready runes of a card's own Power domain to pay for it outright. */
function runesFor(defId: string, count = 24): RuneCard[] {
  const domain: Domain = registry.get(defId).powerDomain ?? "Mind";
  return Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));
}

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

/** Passes Focus until the chain and the holding pen are empty, or a question is
 *  outstanding (`submit` refuses a PassFocus while one is, 320.1). */
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

/** Answers the outstanding question with a named option, THROUGH `legalActions`
 *  — so an option the enumerator never offers fails here rather than being
 *  applied by a test that reached past it. */
function answerWith(state: GameState, optionId: string): GameState {
  const answer = legalActions(state).find((a) => a.type === "AnswerDecision" && a.optionId === optionId);
  expect(answer, `no AnswerDecision offering "${optionId}"`).toBeDefined();
  return passUntilSettled(accept(state, answer!));
}

/** The option ids on offer right now, for the tests about what is NOT offered. */
function optionIds(state: GameState): string[] {
  return legalActions(state)
    .filter((a) => a.type === "AnswerDecision")
    .map((a) => (a as { optionId: string }).optionId);
}

const castsOf = (state: GameState, instanceId: string) =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

/** Every unit `playerIndex` has anywhere on the board, base included. */
function ownUnits(state: GameState, playerIndex: 0 | 1): UnitInstance[] {
  const player = state.players[playerIndex]!;
  return [...player.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[player.id] ?? [])];
}

function unitById(state: GameState, instanceId: string): UnitInstance | undefined {
  return ([0, 1] as const).flatMap((i) => ownUnits(state, i)).find((u) => u.instanceId === instanceId);
}

/** A real Legend instance, for the two cards whose whole text sits in that zone. */
function legendInstance(defId: string): LegendInstance {
  return createCardInstance(registry.get(defId)) as LegendInstance;
}

/**
 * The two Legends here are each printed three times, and the other two prints
 * carry no registration of their own — `mergeRegistries` fans the canonical one
 * out to its aliases. Asserted per card rather than left to
 * `printing-aliases.test.ts`, which walks all 31 aliases and stops at the first
 * disagreement: a failure over somebody else's card would hide one over these.
 */
describe("the alternate printings inherit these implementations", () => {
  for (const [canonical, aliases] of [
    [DIANA_SCORN, ["UNL-234", "UNL-234*"]],
    [LEBLANC_DECEIVER, ["UNL-235", "UNL-235*"]],
  ] as const) {
    it(`${canonical}'s Overnumbered and Signature prints report as it does`, () => {
      expect(isCardImplemented(registry.get(canonical))).toBe(true);
      for (const alias of aliases) {
        expect(isCardImplemented(registry.get(alias)), `${alias} was left inert`).toBe(true);
      }
    });
  }

  it("a Signature-print LeBlanc actually FIRES, not merely reports implemented", () => {
    // The failure this guards is the one the alias mechanism exists for: a deck
    // naming the Signature print used to get a Legend with no ability at all.
    const sentry = realUnitInstance(WATCHFUL_SENTRY);
    const state = makeState({ phase: "Beginning", activePlayerIndex: 0 });
    state.players[0]!.legend = legendInstance("UNL-235*");
    state.battlefields[0]!.units = { p1: [sentry] };
    state.battlefields[0]!.controllerId = "p1";
    state.players[0]!.hand = [spellInstance(TIME_WARP)];

    const asked = resolveHeldTriggers(runBeginning(state));

    expect(asked.pendingDecisions[0]?.kind, "the Signature print's Legend is inert").toBe("UNL-199-copy");
  });
});

describe("Diana - Scorn of the Moon (UNL-197): exhaust for 1 showdown-only Energy", () => {
  /** Player 0 with Diana as their Legend, inside an open Showdown at bf1. */
  function dianaState(overrides: Partial<GameState> = {}): GameState {
    const state = makeState({
      turnState: "Showdown",
      showdownBattlefieldId: "bf1",
      showdownKind: "Combat",
      focusHolder: 0,
      ...overrides,
    });
    state.players[0]!.legend = legendInstance(DIANA_SCORN);
    return state;
  }

  const dianaActivations = (state: GameState) =>
    legalActions(state).filter(
      (a): a is ActivateAbilityAction =>
        a.type === "ActivateAbility" && a.permanentInstanceId === state.players[0]!.legend.instanceId,
    );

  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(DIANA_SCORN))).toBe(true);
  });

  it("adds 1 Energy and exhausts her, inside a Showdown", () => {
    const state = dianaState();
    const activate = dianaActivations(state)[0];
    expect(activate, "her ability was never offered during a Showdown").toBeDefined();
    expect(state.players[0]!.floatingEnergy).toBe(0);

    const after = accept(state, activate!);

    expect(after.players[0]!.floatingEnergy, "[Add] 1 Energy never happened").toBe(1);
    expect(after.players[0]!.legend.exhausted, "the exhaust cost was not taken").toBe(true);
  });

  it("is NOT offered outside a Showdown — the positive control is the same board with one field changed", () => {
    const inShowdown = dianaState();
    expect(dianaActivations(inShowdown), "nothing was offered at all, so 'not offered' proves nothing").toHaveLength(1);

    const neutral = dianaState({ turnState: "Neutral", showdownBattlefieldId: null, showdownKind: null });

    expect(dianaActivations(neutral), "availableWhile is not gating on turnState").toHaveLength(0);
  });

  it("is NOT offered while she is already exhausted — one activation per Awaken", () => {
    const state = dianaState();
    const after = accept(state, dianaActivations(state)[0]!);

    expect(dianaActivations(after), "the exhaust cost is not being read back").toHaveLength(0);
  });

  it("PIN — DIVERGENCE: the Energy is NOT restricted to Showdowns once one closes", () => {
    // Printed: "Spend this Energy only during showdowns." This engine has no such
    // pool (see her entry: it is a field on PlayerState plus seven consumers), so
    // the Energy lands in `floatingEnergy` and is spendable on anything for the
    // rest of the turn. Closing the gap should fail HERE.
    const state = dianaState();
    const after = accept(state, dianaActivations(state)[0]!);
    const neutralAgain: GameState = { ...after, turnState: "Neutral", showdownBattlefieldId: null, showdownKind: null };

    expect(neutralAgain.players[0]!.floatingEnergy, "a restricted pool now exists — update this pin and her entry").toBe(1);
  });
});

describe("Moonfall (UNL-198): drag one enemy in, then shrink the enemies there", () => {
  /**
   * Player 0 holding bf1 with one unit, the opponent with a unit at bf1, one at
   * bf2 and one in base — so the "which enemy may be dragged" question has a real
   * answer, an already-there unit to filter out, and a base unit to prove the
   * bare-noun scope.
   */
  function moonfallState() {
    const spell = spellInstance(MOONFALL);
    const mine = makeUnit({ instanceId: "mine", name: "Mine" });
    const squatter = makeUnit({ instanceId: "squatter", name: "Squatter" });
    const roamer = makeUnit({ instanceId: "roamer", name: "Roamer" });
    const homebody = makeUnit({ instanceId: "homebody", name: "Homebody" });
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runesFor(MOONFALL);
    state.battlefields[0]!.units = { p1: [mine], p2: [squatter] };
    state.battlefields[1]!.units = { p2: [roamer] };
    state.players[1]!.baseUnits = [homebody];
    return { state, spellId: spell.instanceId };
  }

  const castAt = (state: GameState, spellId: string, battlefieldId: string) =>
    castsOf(state, spellId).find((a) => a.targetBattlefieldId === battlefieldId);

  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(MOONFALL))).toBe(true);
  });

  it("drags an enemy from another battlefield and shrinks BOTH it and the one already there", () => {
    const { state, spellId } = moonfallState();
    const cast = castAt(state, spellId, "bf1");
    expect(cast, "bf1 was never offered as a target").toBeDefined();

    const asked = passUntilSettled(accept(state, cast!));
    expect(asked.pendingDecisions[0]?.kind, "the move question was never parked").toBe("UNL-198-move");

    const after = answerWith(asked, "roamer");

    expect(after.battlefields[1]!.units.p2 ?? [], "the roamer never left bf2").toHaveLength(0);
    expect(unitById(after, "roamer")?.mightThisTurn, "the dragged unit was not shrunk — 'THEN' ran before the move").toBe(-2);
    expect(unitById(after, "squatter")?.mightThisTurn, "the enemy already there was not shrunk").toBe(-2);
  });

  it("shrinks the enemies there even when the move is declined — the two halves are separate instructions", () => {
    const { state, spellId } = moonfallState();
    const asked = passUntilSettled(accept(state, castAt(state, spellId, "bf1")!));

    const after = answerWith(asked, "decline");

    expect(unitById(after, "roamer")?.mightThisTurn, "declining still moved something").toBe(0);
    expect(unitById(after, "squatter")?.mightThisTurn, "the debuff was wrongly gated on the move").toBe(-2);
  });

  it("never shrinks a FRIENDLY unit there — the positive control is that the enemy beside it was shrunk", () => {
    const { state, spellId } = moonfallState();
    const asked = passUntilSettled(accept(state, castAt(state, spellId, "bf1")!));
    const after = answerWith(asked, "decline");

    expect(unitById(after, "squatter")?.mightThisTurn, "nothing was shrunk, so 'not friendly' proves nothing").toBe(-2);
    expect(unitById(after, "mine")?.mightThisTurn, "'enemy units there' hit the caster's own unit").toBe(0);
  });

  it("offers the enemy in BASE — 'an enemy unit' names no location (355.9.a.1)", () => {
    const { state, spellId } = moonfallState();
    const asked = passUntilSettled(accept(state, castAt(state, spellId, "bf1")!));

    expect(optionIds(asked)).toContain("homebody");
  });

  it("does NOT offer an enemy already standing there — moving it there is not a move (355.4.a)", () => {
    const { state, spellId } = moonfallState();
    const asked = passUntilSettled(accept(state, castAt(state, spellId, "bf1")!));

    expect(optionIds(asked), "nothing was offered, so the exclusion proves nothing").toContain("roamer");
    expect(optionIds(asked)).not.toContain("squatter");
  });

  it("PIN — DIVERGENCE: a battlefield where the caster has NO units is offered, and then does nothing", () => {
    // Printed: "Choose a battlefield WHERE YOU HAVE UNITS", which 355.8 makes a
    // castability requirement. `TargetingSpec`'s battlefield kind carries no
    // filter, so the enumerator offers bf2 as well; the resolver refuses it, so
    // the effect is never wider than printed, only the offer is. Closing the gap
    // should fail on the FIRST of these two.
    const { state, spellId } = moonfallState();
    const cast = castAt(state, spellId, "bf2");
    expect(cast, "bf2 is now correctly withheld — update this pin and Moonfall's entry").toBeDefined();

    const after = passUntilSettled(accept(state, cast!));

    expect(after.pendingDecisions, "the resolver's guard stopped guarding").toHaveLength(0);
    expect(unitById(after, "roamer")?.mightThisTurn, "enemies were shrunk at a battlefield the caster never reached").toBe(0);
  });
});

/**
 * The two Reflection-copy cards share one body (`playReflectionCopy`), so the
 * copy's SHAPE is asserted once here and each card then proves its own framing.
 */
function reflectionAmong(units: UnitInstance[], exclude: Set<string>): UnitInstance | undefined {
  return units.find((u) => u.isToken && !exclude.has(u.instanceId));
}

describe("Mirror Image (UNL-200): a Reflection copy of any unit, to your base", () => {
  /** Player 0 with the spell, and an ENEMY Watchful Sentry at bf2 to copy. */
  function mirrorState() {
    const spell = spellInstance(MIRROR_IMAGE);
    const sentry = realUnitInstance(WATCHFUL_SENTRY);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runesFor(MIRROR_IMAGE);
    state.players[0]!.deck = [spellInstance(TIME_WARP), spellInstance(TIME_WARP)];
    state.battlefields[1]!.units = { p2: [sentry] };
    return { state, spellId: spell.instanceId, sentry };
  }

  const castAt = (state: GameState, spellId: string, targetId: string) =>
    castsOf(state, spellId).find((a) => a.targetUnitInstanceId === targetId);

  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(MIRROR_IMAGE))).toBe(true);
  });

  it("copies the seven copyable traits (477.1.b.1.a) and NOT Might", () => {
    const { state, spellId, sentry } = mirrorState();
    const cast = castAt(state, spellId, sentry.instanceId);
    expect(cast, "an ENEMY unit was never offered — 'a unit' names no owner").toBeDefined();

    const after = passUntilSettled(accept(state, cast!));
    const copy = reflectionAmong(after.players[0]!.baseUnits, new Set());
    expect(copy, "no Reflection token reached the caster's base").toBeDefined();

    // Rules Text is the defId in this engine — every trigger, ability and aura
    // table is keyed by it, so this single field is the whole of the copy's text.
    expect(copy!.defId, "the token kept its blank TOKEN-REFLECTION text").toBe(WATCHFUL_SENTRY);
    expect(copy!.name).toBe(sentry.name);
    expect(copy!.tags).toEqual(sentry.tags);
    expect(copy!.domains).toEqual(sentry.domains);
    expect(copy!.energyCost).toBe(sentry.energyCost);
    expect(copy!.isChampion).toBe(sentry.isChampion);
    // 477.1.b.1.a does not list Might, and 477.1.a.1 gives it its own clause in
    // the sibling layer; 187.6 names the token "a 0 [M] Reflection token".
    expect(sentry.might, "the subject is no longer a 1-Might body, so 0 proves nothing").toBe(1);
    expect(copy!.might, "Might was copied — it is not a copyable trait").toBe(0);
    // "Play a READY Reflection unit token", overriding 143.4.a.
    expect(copy!.exhausted, "the token entered exhausted despite 'ready'").toBe(false);
    expect(copy!.keywords.Temporary, "[Temporary] was never granted").toBe(1);
    expect(copy!.isToken).toBe(true);
  });

  it("leaves the SUBJECT untouched — a copy is made, not moved", () => {
    const { state, spellId, sentry } = mirrorState();
    const after = passUntilSettled(accept(state, castAt(state, spellId, sentry.instanceId)!));

    expect(after.battlefields[1]!.units.p2 ?? [], "the copied unit left the board").toHaveLength(1);
    expect(after.battlefields[1]!.units.p2![0]!.might).toBe(1);
  });

  it("the copied RULES TEXT is live: [Temporary] kills it and its copied [Deathknell] draws for the COPY's controller", () => {
    const { state, spellId, sentry } = mirrorState();
    const cast = passUntilSettled(accept(state, castAt(state, spellId, sentry.instanceId)!));
    const copy = reflectionAmong(cast.players[0]!.baseUnits, new Set())!;
    const deckBefore = cast.players[0]!.deck.length;
    const handBefore = cast.players[0]!.hand.length;

    // The copy's controller's Beginning Phase — 816's "at the start of ITS
    // CONTROLLER's Beginning Phase, before scoring".
    const begun = resolveHeldTriggers(runBeginning({ ...cast, phase: "Beginning", activePlayerIndex: 0 }));

    expect(unitById(begun, copy.instanceId), "[Temporary] did not kill the copy").toBeUndefined();
    // A draw moves a card OUT of the deck and INTO the hand; both ends are
    // asserted so a deck that merely shrank cannot pass for one that was drawn
    // from. The Sentry it copied is the OPPONENT's, so this also proves the
    // Deathknell paid the copy's controller (`death.ownerIndex`) rather than the
    // original's.
    expect(begun.players[0]!.deck.length, "the copied [Deathknell] never fired — the defId carries no text").toBe(
      deckBefore - 1,
    );
    expect(begun.players[0]!.hand.length, "a card left the deck but never reached the hand").toBe(handBefore + 1);
    expect(begun.players[1]!.hand, "the ORIGINAL's controller drew instead of the copy's").toHaveLength(0);
    expect(unitById(begun, sentry.instanceId), "the ORIGINAL died too — [Temporary] leaked onto the subject").toBeDefined();
  });

  it("PIN — DIVERGENCE: the copy is a SNAPSHOT, not a re-derived layer", () => {
    // 477.1.b is a LAYER, so a later change to the original's copyable traits
    // should propagate. This engine writes the traits once, at creation. Nothing
    // in the pool can move a unit's copyable traits, so the gap is unreachable in
    // play — this pin makes it fail loudly if a layer pass ever lands. Forged by
    // renaming the ORIGINAL after the copy exists.
    const { state, spellId, sentry } = mirrorState();
    const after = passUntilSettled(accept(state, castAt(state, spellId, sentry.instanceId)!));
    const copy = reflectionAmong(after.players[0]!.baseUnits, new Set())!;

    const renamed: GameState = {
      ...after,
      battlefields: after.battlefields.map((bf) =>
        bf.id === "bf2" ? { ...bf, units: { ...bf.units, p2: (bf.units.p2 ?? []).map((u) => ({ ...u, name: "Renamed" })) } } : bf,
      ),
    };

    expect(unitById(renamed, copy.instanceId)!.name, "a copy layer now re-derives — update this pin").toBe(sentry.name);
  });

  it("plays the token but copies NOTHING when the subject left in the response window (359.3.e.5)", () => {
    const { state, spellId, sentry } = mirrorState();
    const cast = accept(state, castAt(state, spellId, sentry.instanceId)!);
    // The subject vanishes while the spell is on the chain.
    const vanished: GameState = {
      ...cast,
      battlefields: cast.battlefields.map((bf) => (bf.id === "bf2" ? { ...bf, units: {} } : bf)),
    };

    const after = passUntilSettled(vanished);
    const copy = reflectionAmong(after.players[0]!.baseUnits, new Set());

    expect(copy, "the unrelated 'play a token' instruction was skipped too").toBeDefined();
    expect(copy!.defId, "a dead subject was still copied").toBe("TOKEN-REFLECTION");
    expect(copy!.keywords.Temporary, "the grant is a separate instruction and still applies").toBe(1);
  });
});

describe("LeBlanc - Deceiver (UNL-199): on conquer or hold, a Reflection copy there", () => {
  /**
   * Player 0 in their Beginning Phase holding bf1 with `units` — the same shape
   * `battlefield-held-event.test.ts` uses, because a hold is the SCORING moment
   * and `runBeginning` is the only thing that produces it.
   */
  function holdingBf1(units: UnitInstance[], overrides: { hand?: number; exhausted?: boolean } = {}): GameState {
    const state = makeState({ phase: "Beginning", activePlayerIndex: 0 });
    state.players[0]!.legend = { ...legendInstance(LEBLANC_DECEIVER), exhausted: overrides.exhausted ?? false };
    state.battlefields[0]!.units = { p1: units };
    state.battlefields[0]!.controllerId = "p1";
    state.players[0]!.hand = Array.from({ length: overrides.hand ?? 1 }, () => spellInstance(TIME_WARP));
    state.players[0]!.deck = [spellInstance(TIME_WARP)];
    return state;
  }

  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(LEBLANC_DECEIVER))).toBe(true);
  });

  it("asks on a HOLD, and pays both halves of the cost when answered", () => {
    const sentry = realUnitInstance(WATCHFUL_SENTRY);
    const state = holdingBf1([sentry]);
    const asked = resolveHeldTriggers(runBeginning(state));
    expect(asked.pendingDecisions[0]?.kind, "her hold trigger never reached the chain").toBe("UNL-199-copy");

    const after = answerWith(asked, sentry.instanceId);

    const copy = reflectionAmong(after.battlefields[0]!.units.p1 ?? [], new Set([sentry.instanceId]));
    expect(copy, "no Reflection token was played there").toBeDefined();
    expect(copy!.defId, "the token is not a copy of the unit chosen").toBe(WATCHFUL_SENTRY);
    expect(copy!.might).toBe(0);
    expect(copy!.exhausted, "'a READY Reflection unit token'").toBe(false);
    expect(copy!.keywords.Temporary).toBe(1);
    expect(after.players[0]!.legend.exhausted, "'exhaust me' was not paid").toBe(true);
    expect(after.players[0]!.hand, "'discard 1' was not paid").toHaveLength(0);
    expect(after.players[0]!.trash, "the discarded card did not reach the trash").toHaveLength(1);
  });

  it("puts the copy at the battlefield HELD, not in base — 'there'", () => {
    const sentry = realUnitInstance(WATCHFUL_SENTRY);
    const asked = resolveHeldTriggers(runBeginning(holdingBf1([sentry])));
    const after = answerWith(asked, sentry.instanceId);

    expect(after.players[0]!.baseUnits, "'there' was read as base").toHaveLength(0);
    expect(after.battlefields[0]!.units.p1 ?? [], "the copy did not land at the held battlefield").toHaveLength(2);
  });

  it("is declinable, and declining costs nothing", () => {
    const sentry = realUnitInstance(WATCHFUL_SENTRY);
    const asked = resolveHeldTriggers(runBeginning(holdingBf1([sentry])));

    const after = answerWith(asked, "decline");

    expect(after.battlefields[0]!.units.p1 ?? [], "declining still played a token").toHaveLength(1);
    expect(after.players[0]!.legend.exhausted, "declining still exhausted her").toBe(false);
    expect(after.players[0]!.hand, "declining still discarded").toHaveLength(1);
  });

  it("offers NOTHING but a decline with an empty hand — the positive control is the same board with one card in it", () => {
    const sentry = realUnitInstance(WATCHFUL_SENTRY);
    const withCard = resolveHeldTriggers(runBeginning(holdingBf1([sentry])));
    expect(optionIds(withCard), "nothing was offered at all, so the empty hand proves nothing").toContain(
      sentry.instanceId,
    );

    const empty = resolveHeldTriggers(runBeginning(holdingBf1([sentry], { hand: 0 })));

    // A lone "Decline" is executed by `advanceDecisions` rather than shown, so
    // the question never surfaces at all.
    expect(empty.pendingDecisions, "the discard cost is not being checked").toHaveLength(0);
    expect(empty.battlefields[0]!.units.p1 ?? [], "a token was played without paying").toHaveLength(1);
  });

  it("offers NOTHING but a decline while she is already exhausted", () => {
    const sentry = realUnitInstance(WATCHFUL_SENTRY);
    const exhausted = resolveHeldTriggers(runBeginning(holdingBf1([sentry], { exhausted: true })));

    expect(exhausted.pendingDecisions, "the exhaust cost is not being checked").toHaveLength(0);
    expect(exhausted.battlefields[0]!.units.p1 ?? [], "a token was played without paying").toHaveLength(1);
  });

  it("does NOT fire for the OPPONENT's hold — 'when YOU conquer or hold'", () => {
    const sentry = realUnitInstance(WATCHFUL_SENTRY);
    const mine = resolveHeldTriggers(runBeginning(holdingBf1([sentry])));
    expect(mine.pendingDecisions, "her own hold did not fire, so the opponent's proves nothing").toHaveLength(1);

    // The same LeBlanc, but bf2 is held by the OPPONENT on the opponent's turn.
    const theirs = holdingBf1([sentry]);
    theirs.activePlayerIndex = 1;
    theirs.battlefields[1]!.units = { p2: [makeUnit({ instanceId: "theirs", name: "Theirs" })] };
    theirs.battlefields[1]!.controllerId = "p2";

    const settled = resolveHeldTriggers(runBeginning(theirs));

    expect(settled.pendingDecisions, "she fired on an enemy hold").toHaveLength(0);
  });
});
