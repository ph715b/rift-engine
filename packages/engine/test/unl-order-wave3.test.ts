import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { implementingModule, isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { destroyUnit, grantTemporary } from "../src/engine/effect-helpers.js";
import { runBeginning } from "../src/engine/turn-manager.js";
import { optionalUnitCostOf } from "../src/engine/card-effects.js";
import type { Domain } from "../src/model/domain.js";
import type { RuneCard } from "../src/model/rune.js";
import type { MoveUnitAction, PlayCardAction, PlayerAction } from "../src/actions/player-action.js";
import type { GameState, PendingDecision } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { beginCombatAt, makeState, makeUnit, playUnitTrigger, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * Wave 3's Unleashed Order cards — five written, three refused, and one of those
 * three (Galio - Indefatigable) written in wave 6. Its pin is DELETED rather than
 * amended, which is what a pin is for: it failed the moment the card landed, and
 * `unl-order-wave6.test.ts` now owns the card. Two refusals remain.
 *
 * Every reachable path goes through `legalActions` -> `submit` or through the
 * real dispatch funnel it feeds (`runBeginning`, `beginCombatAt`,
 * `playUnitTrigger`), never a resolver closure. Three of these five are only
 * reachable across a hop a direct call would clear for free: a `[Deathknell]`'s
 * capture happens at the death and resolves a chain-pop later, an Attack Trigger
 * crosses the designation check in `applies`, and a Spell's parked question
 * crosses `advanceDecisions`.
 *
 * Each card has a NEGATIVE control, because the failure this repo keeps paying
 * for is a card that is registered, enumerated, paid for and inert — and a
 * happy-path assertion passes just as well when the condition is never checked.
 *
 * The refusals are pinned as tests for the same reason wave 2 pinned Bandle
 * Soldier: a refusal recorded only in prose goes stale silently, while one
 * recorded as an assertion fails the moment someone implements the card. That is
 * exactly what happened to Galio's — see the note above.
 */

const registry = defaultCardRegistry();

const SAFETY_INSPECTOR = "UNL-164";
const SHADOWS_CALL = "UNL-165";
const UNDYING_LOYALTY = "UNL-168";
const ASHE_FOCUSED = "UNL-169";
const ATAKHAN = "UNL-170";
const LEBLANC_FRAGMENTED = "UNL-172";
const SACRIFICE = "UNL-173";

/** Enough Ready runes of a card's own Power domain to pay for it outright.
 *  Energy is domain-agnostic, so one colour covers both halves. */
function runesFor(defId: string, count = 24): RuneCard[] {
  const domain: Domain = registry.get(defId).powerDomain ?? "Order";
  return Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));
}

function accept(state: GameState, action: PlayerAction | undefined, what: string): GameState {
  expect(action, `${what} was never enumerated`).toBeDefined();
  const { state: next, result } = submit(state, action!);
  expect(result, `${what} was refused: ${JSON.stringify(result)}`).toEqual({ type: "Ok" });
  return next;
}

/** Every enumerated way to play one card instance. */
function castsOf(state: GameState, instanceId: string): PlayCardAction[] {
  return legalActions(state).filter(
    (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId,
  );
}

/** Passes Focus until the chain and the holding pen are both empty, stopping on
 *  a pending question (`submit` refuses a PassFocus while one is outstanding). */
function passUntilSettled(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 24; guard += 1) {
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
  const decision: PendingDecision | undefined = pendingDecision(state);
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

/** The option ids currently on offer, and who is being asked. */
function offered(state: GameState): { playerIndex: 0 | 1; ids: string[]; labels: string[] } {
  const decision = pendingDecision(state);
  expect(decision, "no question was pending").toBeDefined();
  const options = optionsFor(state, decision!);
  return { playerIndex: decision!.playerIndex, ids: options.map((o) => o.id), labels: options.map((o) => o.label) };
}

function unitAnywhere(state: GameState, instanceId: string): UnitInstance | undefined {
  for (const index of [0, 1] as const) {
    const player = state.players[index]!;
    const found = [...player.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[player.id] ?? [])].find(
      (u) => u.instanceId === instanceId,
    );
    if (found) return found;
  }
  return undefined;
}

const names = (cards: readonly { name: string }[]) => cards.map((c) => c.name);

describe("LeBlanc - Fragmented (UNL-172): [Deathknell] draw 1, or 2 in your Beginning Phase", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(LEBLANC_FRAGMENTED))).toBe(true);
  });

  /** Two cards in the deck, so 1 and 2 are distinguishable and neither is capped
   *  by an empty deck. */
  function leblancState(overrides: Partial<GameState> = {}): { state: GameState; leblanc: UnitInstance } {
    const leblanc = realUnitInstance(LEBLANC_FRAGMENTED);
    const state = makeState({ phase: "Action", ...overrides });
    state.players[0]!.deck = [makeUnit({ name: "First" }), makeUnit({ name: "Second" })];
    state.battlefields[0]!.units = { p1: [leblanc] };
    return { state, leblanc };
  }

  it("draws ONE outside the Beginning Phase", () => {
    const { state, leblanc } = leblancState();
    // Killed by player 1, so paying the DYING unit's controller is separated from
    // paying the killer.
    const after = resolveHeldTriggers(destroyUnit(state, leblanc.instanceId, 1));

    expect(names(after.players[0]!.hand), "the Deathknell never drew").toEqual(["First"]);
    expect(after.players[1]!.hand, "the killer was paid instead of the owner").toHaveLength(0);
  });

  it("draws TWO when she dies in her own controller's Beginning Phase", () => {
    const { state, leblanc } = leblancState({ phase: "Beginning", activePlayerIndex: 0 });
    const after = resolveHeldTriggers(destroyUnit(state, leblanc.instanceId, 1));

    expect(names(after.players[0]!.hand), "the Beginning-Phase branch never fired").toEqual(["First", "Second"]);
  });

  it("draws ONE in the OPPONENT's Beginning Phase — 'YOUR' is load-bearing", () => {
    // The negative control on the second half of the condition. Without it the
    // card would pay double on a turn that is not hers, which is a different and
    // much better card.
    const { state, leblanc } = leblancState({ phase: "Beginning", activePlayerIndex: 1 });
    const after = resolveHeldTriggers(destroyUnit(state, leblanc.instanceId, 1));

    expect(names(after.players[0]!.hand), "someone else's Beginning Phase counted as hers").toEqual(["First"]);
  });

  it("the phase is captured at the DEATH, not re-read at resolution", () => {
    // The half `capture` exists for, and the whole reason this card is not a
    // one-liner. Kill her in the Beginning Phase, then let the turn advance to
    // Action BEFORE the held Deathknell is resolved: a `resolve` that asked
    // `state.phase` would find "Action" and quietly draw 1.
    //
    // This is not a contrived ordering — it is the ONLY one a real game produces.
    // See the end-to-end [Temporary] test below, which drives the same thing
    // through `runBeginning`.
    const { state, leblanc } = leblancState({ phase: "Beginning", activePlayerIndex: 0 });
    const killed = destroyUnit(state, leblanc.instanceId, 1);
    expect(killed.pendingTriggers.length + killed.spellChain.length, "the Deathknell resolved inline — the fixture proves nothing").toBeGreaterThan(0);

    const later = resolveHeldTriggers({ ...killed, phase: "Action" });
    expect(names(later.players[0]!.hand), "the phase was re-read at resolution instead of captured").toEqual([
      "First",
      "Second",
    ]);
  });

  it("end to end: a [Temporary] LeBlanc dies to runBeginning and draws 2", () => {
    // The real board this clause is printed for. 816.1.b kills her "at the start
    // of this permanent's controller's Beginning Phase, before scoring", which
    // `killTemporaryPermanents` runs inside `runBeginning` — and `runBeginning`
    // returns with the phase already advanced to Channel, so the Deathknell that
    // is still sitting on the chain resolves in a phase that is no longer
    // Beginning. Nothing but the capture can get this right.
    const { state, leblanc } = leblancState({ phase: "Beginning", activePlayerIndex: 0 });
    const doomed = grantTemporary(state, leblanc.instanceId);

    const begun = runBeginning(doomed);
    expect(begun.phase, "runBeginning left the phase alone — this test's premise is gone").toBe("Channel");
    expect(unitAnywhere(begun, leblanc.instanceId), "[Temporary] did not kill her").toBeUndefined();

    const settled = resolveHeldTriggers(begun);
    expect(names(settled.players[0]!.hand), "she drew the Action-phase amount for a Beginning-Phase death").toEqual([
      "First",
      "Second",
    ]);
  });
});

describe("Shadow's Call (UNL-165): give a friendly unit [Temporary], draw 2", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(SHADOWS_CALL))).toBe(true);
  });

  function callState(place: (state: GameState) => void): { state: GameState; spellId: string } {
    const spell = spellInstance(SHADOWS_CALL);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runesFor(SHADOWS_CALL);
    state.players[0]!.deck = [makeUnit({ name: "First" }), makeUnit({ name: "Second" }), makeUnit({ name: "Third" })];
    place(state);
    return { state, spellId: spell.instanceId };
  }

  it("grants [Temporary] and draws 2, in one submitted play", () => {
    const { state, spellId } = callState((s) => {
      s.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "mine", name: "Mine" })] };
    });

    const cast = castsOf(state, spellId).find((a) => a.targetUnitInstanceId === "mine");
    const after = passUntilSettled(accept(state, cast, "Shadow's Call on my own unit"));

    expect(unitAnywhere(after, "mine")!.keywords.Temporary, "[Temporary] never landed").toBe(1);
    expect(names(after.players[0]!.hand), "it did not draw 2").toEqual(["First", "Second"]);
  });

  it("reaches a unit in BASE — 'a friendly unit' names no battlefield", () => {
    const { state, spellId } = callState((s) => {
      s.players[0]!.baseUnits = [makeUnit({ instanceId: "home", name: "Home" })];
    });

    const cast = castsOf(state, spellId).find((a) => a.targetUnitInstanceId === "home");
    const after = passUntilSettled(accept(state, cast, "Shadow's Call on a unit at home"));
    expect(unitAnywhere(after, "home")!.keywords.Temporary).toBe(1);
  });

  it("never offers an ENEMY unit, and is uncastable with no friendly unit", () => {
    const { state, spellId } = callState((s) => {
      s.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "theirs", name: "Theirs" })] };
    });

    expect(castsOf(state, spellId), "it was offered against an enemy board").toHaveLength(0);
  });

  it("the [Temporary] it grants really kills the unit, before scoring", () => {
    // The payoff half, driven through the real `runBeginning`. Standing ALONE at
    // a battlefield its controller holds, so a unit that survived the kill step
    // would score — 816's "before scoring" is the whole reason the keyword needs
    // its own step, and a point here would mean the ordering had inverted.
    const { state, spellId } = callState((s) => {
      s.battlefields[0]!.controllerId = "p1";
      s.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "mine", name: "Mine" })] };
    });

    const cast = castsOf(state, spellId).find((a) => a.targetUnitInstanceId === "mine");
    const after = passUntilSettled(accept(state, cast, "Shadow's Call on my own unit"));
    const nextTurn = resolveHeldTriggers(runBeginning({ ...after, phase: "Beginning", activePlayerIndex: 0 }));

    expect(unitAnywhere(nextTurn, "mine"), "the doomed unit survived its controller's Beginning Phase").toBeUndefined();
    expect(nextTurn.players[0]!.points, "it held the battlefield on the way out — 816's 'before scoring' inverted").toBe(0);
  });

  it("kills it in ITS controller's Beginning Phase, not the opponent's", () => {
    // The negative control on 816.1.b's "this permanent's controller's" — a
    // Shadow's Call cast on your own unit is a DELAYED cost, not an instant one,
    // and a unit that died on the opponent's turn would make it much worse.
    const { state, spellId } = callState((s) => {
      s.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "mine", name: "Mine" })] };
    });

    const cast = castsOf(state, spellId).find((a) => a.targetUnitInstanceId === "mine");
    const after = passUntilSettled(accept(state, cast, "Shadow's Call on my own unit"));
    const theirTurn = resolveHeldTriggers(runBeginning({ ...after, phase: "Beginning", activePlayerIndex: 1 }));

    expect(unitAnywhere(theirTurn, "mine"), "it died on the opponent's turn").toBeDefined();
  });

  it("DIVERGENCE: an already-[Temporary] unit is still OFFERED, and the spell then does nothing at all", () => {
    // Two assertions, and the pair IS the recorded divergence.
    //
    // 355.9.b makes the printed "without [Temporary]" a targeting restriction, so
    // 355.8/355.16 forbid the announcement outright. No `TargetingSpec` can say
    // "lacking keyword X", so the enumerator offers it — that is the first
    // assertion, and it fails the day the spec grows the filter.
    //
    // The second is the compensation, and it is deliberately NOT 359.3.e.5's
    // "the instruction is ignored, the draw still happens": obeying that here
    // would turn a 2-Energy "draw 2 and doom a unit" into a 2-Energy "draw 2"
    // whenever a doomed Sprite token is on the board, which UNL prints six ways
    // of making. Refusing the whole spell is never STRONGER than printed;
    // 359.3.e.5's shape would be.
    const { state, spellId } = callState((s) => {
      s.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "doomed", name: "Doomed", keywords: { Temporary: 1 } })] };
    });

    const cast = castsOf(state, spellId).find((a) => a.targetUnitInstanceId === "doomed");
    expect(cast, "the spec now filters [Temporary] out — delete this pin and the divergence note").toBeDefined();

    const after = passUntilSettled(accept(state, cast, "Shadow's Call on an already-doomed unit"));
    expect(after.players[0]!.hand, "it drew off an illegal announcement — the exploit the restriction blocks").toHaveLength(0);
    expect(names(after.players[0]!.trash), "the spell did not resolve at all").toEqual(["Shadow's Call"]);
  });

  it("still draws when the target LEFT PLAY on the chain — 359.3.e.5's real case", () => {
    // The other side of the same coin, and the reason the two cannot share one
    // branch: a target that BECAME illegal is 359.3.e.5's Void Seeker example,
    // where "the unit is not dealt any damage. Void Seeker's controller still
    // draws 1."
    const { state, spellId } = callState((s) => {
      s.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "mine", name: "Mine" })] };
    });

    const cast = castsOf(state, spellId).find((a) => a.targetUnitInstanceId === "mine");
    const announced = accept(state, cast, "Shadow's Call on my own unit");
    const vanished = destroyUnit(announced, "mine", 1);
    const after = passUntilSettled(vanished);

    expect(names(after.players[0]!.hand), "a vanished target swallowed the draw too").toEqual(["First", "Second"]);
  });
});

describe("Undying Loyalty (UNL-168): play a cheap unit from your trash, ignoring its cost", () => {
  it("is reported HALF implemented — the partial note is the honest answer", () => {
    // Was `true`, which was a coverage lie: the first clause claimed the whole
    // card. A PARTIALLY_IMPLEMENTED entry was added at integration.
    expect(isCardImplemented(registry.get(UNDYING_LOYALTY))).toBe(false);
  });

  /** A unit card in the trash with a chosen printed cost. `makeUnit` is a
   *  synthetic definition, which is what keeps these fixtures from being
   *  implemented out from under the test by a future card. */
  const trashUnit = (name: string, energyCost: number, powerCost = 0) =>
    makeUnit({ instanceId: name.toLowerCase(), name, energyCost, powerCost });

  function loyaltyState(trash: UnitInstance[], runes = 24): { state: GameState; spellId: string } {
    const spell = spellInstance(UNDYING_LOYALTY);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runesFor(UNDYING_LOYALTY, runes);
    state.players[0]!.trash = trash;
    return { state, spellId: spell.instanceId };
  }

  it("plays the chosen unit out of the trash, for free", () => {
    const { state, spellId } = loyaltyState([trashUnit("Cheap", 2, 1)]);
    const cast = castsOf(state, spellId)[0];
    const asked = accept(state, cast, "Undying Loyalty");

    // One candidate is not a choice, and `advanceDecisions` performs it without a
    // prompt — so the unit is already in play by the time the chain settles.
    const after = passUntilSettled(asked);
    expect(unitAnywhere(after, "cheap"), "the unit never left the trash").toBeDefined();
    expect(after.players[0]!.trash.some((c) => c.instanceId === "cheap"), "it is in two zones at once").toBe(false);
    expect(after.players[0]!.cardsPlayedThisTurn, "a free play did not count as a play").toBeGreaterThan(0);
  });

  it("offers only what is within BOTH halves of the ceiling", () => {
    // TWO legal candidates, so there is a real question to inspect: one is not a
    // choice and `advanceDecisions` performs it without ever showing it. They are
    // also the positive control — "nothing was offered" can never be mistaken for
    // "the filter worked".
    const { state, spellId } = loyaltyState([
      trashUnit("AtTheCeiling", 2, 1),
      trashUnit("WellUnder", 0, 0),
      trashUnit("TooExpensive", 3, 0),
      trashUnit("TooMuchPower", 1, 2),
      spellInstance(SHADOWS_CALL) as unknown as UnitInstance,
    ]);
    const asked = passUntilSettled(accept(state, castsOf(state, spellId)[0], "Undying Loyalty"));

    expect(offered(asked).labels.sort(), "the ceiling let something through, or ate a legal card").toEqual([
      "AtTheCeiling",
      "WellUnder",
    ]);
  });

  it("asks nothing at all when the trash holds nothing playable", () => {
    const { state, spellId } = loyaltyState([trashUnit("TooExpensive", 9, 0)]);
    const after = passUntilSettled(accept(state, castsOf(state, spellId)[0], "Undying Loyalty"));

    expect(after.pendingDecisions, "a question with no answers was parked").toHaveLength(0);
    expect(unitAnywhere(after, "tooexpensive"), "the ceiling was ignored entirely").toBeUndefined();
  });

  it("DIVERGENCE: no discount, whatever is in the trash — the first clause is unwritten", () => {
    // "This costs [2] less if you choose a Bird, Cat, Dog, or Poro." The discount
    // is priced per enumerated variant at announce, in files this wave does not
    // own, so the card always costs its printed [2] and one rainbow.
    //
    // Asserted on the PAYMENT the enumerator built, which is the number that
    // would move the day the clause lands — and against a Poro-tagged trash
    // card, so this is the case the clause is actually about rather than a
    // vacuous one.
    const poro = makeUnit({ instanceId: "poro", name: "Poro", energyCost: 2, powerCost: 1, tags: ["Poro"] });
    const { state, spellId } = loyaltyState([poro]);
    const casts = castsOf(state, spellId);

    expect(casts, "no cast was offered — the fixture is wrong, not the divergence").toHaveLength(1);
    expect(casts[0]!.payment.energyRunes, "the discount clause has landed — update this pin").toHaveLength(2);
    expect(casts[0]!.payment.powerRunes, "the printed Power pip stopped being charged").toHaveLength(1);
    expect(
      optionalUnitCostOf(UNDYING_LOYALTY),
      "an additional cost is registered for it now — this pin needs rewriting",
    ).toBeUndefined();
  });

  it("PARTIAL: coverage names the half that is missing", () => {
    // Registration is per defId, so writing the second clause marks the whole
    // card DONE. The `coverage.PARTIALLY_IMPLEMENTED` entry this wave owes could
    // not be added — coverage.ts is shared — so the over-report is pinned here
    // instead, and closing it fails loudly rather than silently.
    // **This pin did its job.** It asserted the card had NO partial note while
    // being half-written — the over-report that registration-per-defId always
    // produces, and which the agent could not fix because `coverage.ts` is shared.
    // The entry landed at integration and this failed, exactly as designed.
    //
    // Inverted rather than deleted: the note going missing again would mean the
    // card had silently gone back to claiming a half it does not have.
    expect(
      partialImplementationNote(registry.get(UNDYING_LOYALTY)),
      "the PARTIALLY_IMPLEMENTED entry was dropped — this card is claiming a half it does not have",
    ).toBeDefined();
  });
});

describe("Safety Inspector (UNL-164): each player must kill one of their units", () => {
  it("is WHOLE as of 2026-08-10 — both clauses are written", () => {
    // Was `false` with a PARTIALLY_IMPLEMENTED entry: the second clause was
    // written and the first ("you may spend 3 XP as an additional cost") had no
    // mechanism at all. That entry is retired and this is inverted rather than
    // deleted, so the card going back to half fails here.
    expect(isCardImplemented(registry.get(SAFETY_INSPECTOR)), "the Inspector is greyed again").toBe(true);
  });

  function inspectorState(place: (state: GameState) => void): { state: GameState; inspector: UnitInstance } {
    const inspector = realUnitInstance(SAFETY_INSPECTOR);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    place(state);
    return { state, inspector };
  }

  it("costs BOTH players a unit, each choosing their own", () => {
    const { state, inspector } = inspectorState((s) => {
      s.players[0]!.baseUnits = [makeUnit({ instanceId: "mine", name: "Mine" }), makeUnit({ instanceId: "mine2", name: "Mine2" })];
      s.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "theirs", name: "Theirs" })] };
    });

    // APNAP: the active player answers first, and the queue is FIFO.
    const asked = playUnitTrigger(state, inspector, 0, "base");
    const first = offered(asked);
    expect(first.playerIndex, "the active player was not asked first").toBe(0);
    expect(first.ids.sort(), "the caster was offered the opponent's units").toEqual(["mine", "mine2"]);

    const afterMine = answer(asked, "mine");
    // The opponent's question follows, and it has one answer, so
    // `advanceDecisions` performs it without prompting.
    expect(unitAnywhere(afterMine, "mine"), "the caster's own unit survived").toBeUndefined();
    expect(unitAnywhere(afterMine, "theirs"), "the opponent kept their unit").toBeUndefined();
    expect(unitAnywhere(afterMine, "mine2"), "it killed more than one of the caster's").toBeDefined();
    // Each unit goes to ITS OWN owner's trash — the two kills are two players'
    // kills, not one player killing twice.
    expect(names(afterMine.players[0]!.trash)).toContain("Mine");
    expect(names(afterMine.players[1]!.trash)).toContain("Theirs");
  });

  it("a player with nothing on the board loses nothing, and is not asked", () => {
    const { state, inspector } = inspectorState((s) => {
      s.players[0]!.baseUnits = [makeUnit({ instanceId: "mine", name: "Mine" })];
    });

    const after = playUnitTrigger(state, inspector, 0, "base");
    expect(after.pendingDecisions, "an empty question was parked for the opponent").toHaveLength(0);
    expect(unitAnywhere(after, "mine"), "the caster's own unit survived — nothing happened at all").toBeUndefined();
  });

  it("fires from a SUBMITTED play, chain and all", () => {
    // The end-to-end control: everything above drives `dispatchOnPlayUnit`, this
    // announces, pays and resolves the Inspector as a real play.
    const inspector = realUnitInstance(SAFETY_INSPECTOR);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.hand = [inspector];
    state.players[0]!.channeled = runesFor(SAFETY_INSPECTOR);
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "mine", name: "Mine" })];
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "theirs", name: "Theirs" })] };

    const asked = passUntilSettled(accept(state, castsOf(state, inspector.instanceId)[0], "Safety Inspector"));
    // The Inspector is on the board by now and is himself a legal victim — he
    // prints no "other" — so his controller has a real choice between him and
    // Mine. The opponent's question has one answer and is performed unprompted.
    expect(offered(asked).ids.sort(), "the caster's question is not the one the card asks").toEqual(
      [inspector.instanceId, "mine"].sort(),
    );

    const after = answer(asked, "mine");
    expect(unitAnywhere(after, "mine"), "the on-play trigger was dropped on the announce->resolve hop").toBeUndefined();
    expect(unitAnywhere(after, "theirs"), "the opponent was never asked").toBeUndefined();
    expect(unitAnywhere(after, inspector.instanceId), "the Inspector died for a choice that named Mine").toBeDefined();
  });

  it("the 3 XP buy-out IS offered, and spares its buyer — was a pin, flipped 2026-08-10", () => {
    // "You may spend 3 XP as an additional cost to play me. ... If you paid my
    // additional cost, you don't kill a unit this way." XP had no place in the
    // PLAY cost pipeline when this was written, so there was exactly one
    // enumerated way to play him and his controller always paid the unit.
    //
    // `OPTIONAL_XP_COSTS` + `optionalXpPaid` closed it. Both variants are
    // asserted here, and the buy-out's EFFECT is asserted in
    // test/optional-xp-cost.test.ts, which also covers the boundary and the
    // enumerate/validate pairing.
    const inspector = realUnitInstance(SAFETY_INSPECTOR);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.hand = [inspector];
    state.players[0]!.channeled = runesFor(SAFETY_INSPECTOR);
    state.players[0]!.xp = 9;
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "mine", name: "Mine" })];

    const casts = castsOf(state, inspector.instanceId);
    expect(casts, "the XP-paid variant is no longer enumerated").toHaveLength(2);

    // The FREE variant still behaves exactly as it did — the half this file
    // originally proved, kept so the new cost cannot have changed it.
    const free = casts.find((c) => (c as { optionalXpPaid?: true }).optionalXpPaid !== true)!;
    const asked = passUntilSettled(accept(state, free, "Safety Inspector, cost declined"));
    expect(asked.players[0]!.xp, "declining the cost still spent XP").toBe(9);
    const after = answer(asked, "mine");
    expect(unitAnywhere(after, "mine"), "the caster was spared without paying").toBeUndefined();
  });

  it("coverage no longer names a missing half — there isn't one", () => {
    // **This assertion has now been inverted TWICE, and both flips were the
    // mechanism working.** As written by the card agent it asserted the card had
    // NO partial note while being half-written — the over-report that
    // registration-per-defId always produces, which the agent could not fix
    // because `coverage.ts` is shared. The entry landed at integration and it
    // went red. It then asserted the note EXISTED, and went red again on
    // 2026-08-10 when the XP cost was built and the entry was retired.
    //
    // Inverted rather than deleted each time. A note reappearing here would mean
    // someone had recorded a gap in this card, which is exactly the moment a
    // reader should be sent to look.
    expect(
      partialImplementationNote(registry.get(SAFETY_INSPECTOR)),
      "a partial note came back — the Inspector has a gap again",
    ).toBeUndefined();
  });
});

describe("Atakhan (UNL-170): when I attack, the defender must kill one of their units here", () => {
  it("is WHOLE as of 2026-08-12 — his sacrifice cost and its scaled discount landed", () => {
    // **Three pins in this block flipped at once, and all three were right up to
    // the day they flipped.** He reported half-implemented, enumerated no
    // kill-as-a-cost variant, and carried a PARTIALLY_IMPLEMENTED note naming the
    // missing half — which is exactly what a card in that state should look like.
    //
    // The refusal named all three shared files it would take, and was accurate:
    // the KILL was expressible (`killFriendly` is Cruel Patron's row) but the
    // DISCOUNT was not, because `repeatable` buys a flat 1 Power per payment while
    // his scales with the printed cost of whatever was killed, on both axes.
    //
    // Collapsed into ONE assertion rather than three inversions: the behaviour is
    // covered in depth by `atakhan-sacrifice-discount.test.ts`, and three copies
    // of "he is finished now" spread across a wave file is how the premise-flip
    // class restarts. What is kept is the coverage claim, because his THIRD clause
    // — the attack trigger this block actually tests — is registered separately,
    // and a card can report whole on the strength of another module while this
    // one silently stops being registered.
    expect(isCardImplemented(registry.get(ATAKHAN)), "Atakhan went back to being half-written").toBe(true);
    expect(partialImplementationNote(registry.get(ATAKHAN)), "a partial note came back").toBeUndefined();
  });

  /** Atakhan already standing at bf1 for player 0, with whatever the defender
   *  has arranged around him. */
  function atakhanState(place: (state: GameState, atakhan: UnitInstance) => void): { state: GameState; atakhan: UnitInstance } {
    const atakhan = realUnitInstance(ATAKHAN);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    place(state, atakhan);
    return { state, atakhan };
  }

  it("makes the DEFENDER choose, and kills what they name", () => {
    const { state, atakhan } = atakhanState((s, a) => {
      s.battlefields[0]!.units = {
        p1: [a],
        p2: [makeUnit({ instanceId: "big", name: "Big", might: 9 }), makeUnit({ instanceId: "small", name: "Small", might: 1 })],
      };
    });

    const fighting = beginCombatAt(state, "bf1", 0);
    const asked = offered(fighting);
    expect(asked.playerIndex, "the wrong player was asked").toBe(1);
    expect(asked.ids.sort(), "the defender was offered the wrong units").toEqual(["big", "small"]);

    const after = answer(fighting, "big");
    expect(unitAnywhere(after, "big"), "the named unit survived").toBeUndefined();
    expect(unitAnywhere(after, "small"), "it killed more than one").toBeDefined();
    // The defender kills their OWN, so the corpse is in their trash.
    expect(names(after.players[1]!.trash)).toContain("Big");
  });

  it("does NOT fire when Atakhan is the one being attacked", () => {
    // The negative control the designation check exists for: `applies` is
    // `isAttackingAt`, and an Atakhan sitting at a battlefield the OPPONENT
    // contests is a defender (464.2.c.2), not an attacker.
    const { state, atakhan } = atakhanState((s, a) => {
      s.battlefields[0]!.units = { p1: [a], p2: [makeUnit({ instanceId: "theirs", name: "Theirs" })] };
    });

    const fighting = beginCombatAt(state, "bf1", 1);
    expect(fighting.pendingDecisions, "he triggered while defending").toHaveLength(0);
    expect(unitAnywhere(fighting, "theirs"), "the defender lost a unit to a defending Atakhan").toBeDefined();
  });

  it("reaches only the defender's units HERE — base and other battlefields are safe", () => {
    // "Here" is printed, and it is the whole difference between this question and
    // Cull the Weak's. The positive control leads: one unit at bf1 IS offered, so
    // an empty option list cannot be mistaken for the filter working.
    // TWO defenders at bf1, so the question is a real one rather than something
    // `advanceDecisions` performs unseen.
    const { state, atakhan } = atakhanState((s, a) => {
      s.battlefields[0]!.units = {
        p1: [a],
        p2: [makeUnit({ instanceId: "here", name: "Here" }), makeUnit({ instanceId: "alsoHere", name: "AlsoHere" })],
      };
      s.battlefields[1]!.units = { p2: [makeUnit({ instanceId: "far", name: "Far" })] };
      s.players[1]!.baseUnits = [makeUnit({ instanceId: "home", name: "Home" })];
    });

    const fighting = beginCombatAt(state, "bf1", 0);
    expect(offered(fighting).ids.sort(), "'here' reached the whole board").toEqual(["alsoHere", "here"]);
  });

  it("asks nothing when the defender has nothing standing here", () => {
    // No enemy unit at bf1 at all is a Non-Combat Showdown rather than a combat,
    // so no designations are handed out and nothing triggers — which is the
    // correct answer for a different reason, and is asserted so the guard is not
    // mistaken for it.
    const { state, atakhan } = atakhanState((s, a) => {
      s.battlefields[0]!.units = { p1: [a] };
      s.players[1]!.baseUnits = [makeUnit({ instanceId: "home", name: "Home" })];
    });

    const fighting = beginCombatAt(state, "bf1", 0);
    expect(fighting.pendingDecisions, "a question was parked with nothing to answer it with").toHaveLength(0);
    expect(unitAnywhere(fighting, "home"), "a unit at home was killed by 'here'").toBeDefined();
  });

  it("fires from a SUBMITTED move that starts the fight", () => {
    // The end-to-end control. `beginCombatAt` sets `contestedByIndex` directly;
    // this walks Atakhan in from base with a real MoveUnit action, so the whole
    // apply-contested -> Cleanup -> designation -> listener path is exercised.
    const atakhan = realUnitInstance(ATAKHAN);
    const state = makeState({ phase: "Action", activePlayerIndex: 0, focusHolder: 0 });
    state.players[0]!.baseUnits = [atakhan];
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "theirs", name: "Theirs" })] };

    const move = legalActions(state).find(
      (a): a is MoveUnitAction =>
        a.type === "MoveUnit" && a.unitInstanceIds.includes(atakhan.instanceId) && a.destinationBattlefieldId === "bf1",
    );
    const after = passUntilSettled(accept(state, move, "Atakhan moving into bf1"));

    expect(unitAnywhere(after, "theirs"), "the attack trigger never fired on the real move path").toBeUndefined();
  });

  // **The DIVERGENCE and PARTIAL pins that stood here were removed on
  // 2026-08-12.** Both were accurate for as long as the first clause was
  // unwritten: no kill-as-a-cost variant was enumerated, so he always cost the
  // printed 10 and 3, and the PARTIALLY_IMPLEMENTED note said so.
  //
  // Both are now false, and the replacement is not another pin here — it is
  // `atakhan-sacrifice-discount.test.ts`, which measures the enumerated variants'
  // actual rune counts rather than only the discount function, because a correct
  // helper wired in wrongly would pass a function-level test.
  //
  // The one thing worth carrying across: his discount is priced PER VARIANT,
  // since its size depends on which unit is killed. That is what kept it out of
  // `modifiedEnergyCost`, where every board-keyed discount lives.
});

describe("Ashe - Focused (UNL-169): REFUSED this wave, and pinned as refused", () => {
  /**
   * "When you play me, choose an opponent. They reveal their hand. Choose a card
   * revealed this way and banish it. **When they hold, return it to their hand
   * (even if I'm no longer on the board).**"
   *
   * The first two sentences are writable today — `banishCard` (effect-helpers) is
   * a real writer of `PlayerState.banished`, and a parked decision over the
   * opponent's hand is both the reveal and the choice. The last sentence is not,
   * and it is the whole card:
   *
   *   - it is a DELAYED trigger, armed by a resolved ability, with no general
   *     mechanism here. Both existing delayed effects are a FIELD on state that
   *     the firing site reads (Imperial Decree's `killDamagedUnitsThisTurn`,
   *     Rally the Troops' `buffUnitsPlayedThisTurn`), which means game-state.ts
   *     and the firing site — shared files;
   *   - it needs PER-INSTANCE MEMORY of WHICH card was banished, which no
   *     registry here can carry: `eventTriggers` is keyed by defId and handed a
   *     `Listener`, not a per-arming record;
   *   - "**even if I'm no longer on the board**" defeats the listener walk
   *     outright. `battlefieldHeld` listeners are found by walking permanents in
   *     play, so a dead Ashe stops listening — which is exactly the case the
   *     card calls out.
   *
   * Implementing only the banish would be strictly STRONGER than printed
   * (permanent exile instead of a loan), which is the one direction this
   * codebase does not ship. So: nothing is registered.
   */
  it("still reports unimplemented, with nothing registered for it", () => {
    const def = registry.get(ASHE_FOCUSED);
    expect(isCardImplemented(def), "someone implemented her — delete this block").toBe(false);
    expect(implementingModule(ASHE_FOCUSED), "an effect is registered now — delete this block").toBeUndefined();
  });

  it("banishes nothing when she is played", () => {
    // The behavioural half, so "unimplemented" is a fact about the board and not
    // just about a coverage table.
    const ashe = realUnitInstance(ASHE_FOCUSED);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[1]!.hand = [makeUnit({ instanceId: "theirs", name: "Theirs" })];

    const after = playUnitTrigger(state, ashe, 0, "base");
    expect(after.players[1]!.banished, "she banished something — the refusal is stale").toHaveLength(0);
    expect(after.players[1]!.hand, "their hand moved").toHaveLength(1);
  });
});

// **Sacrifice (UNL-173) is no longer refused — the pinned block that stood here
// was removed on 2026-08-12, not weakened.**
//
// Its refusal note named the exact blocker and was right about it: "a [Mighty]
// restriction on which friendly units may pay the cost, which exists NOWHERE —
// `TargetingSpec` carries `maxMight` and no minimum, and `UnitCostSpec` carries
// no filter at all." `UnitCostSpec.candidate` is that filter, and Sacrifice is
// the card it was built for.
//
// The note also predicted the failure mode to watch: smuggling the cost onto an
// ordinary friendly-unit target "would let a 1-Might Recruit buy draw 2 and
// channel a rune for one Energy". That is now an assertion rather than a
// warning — see `unit-cost-candidate.test.ts`, which covers the whole card plus
// both sides of the enumerate/execute split the filter had to land on.
//
// Nothing is re-asserted here. A second copy of the coverage check is how the
// premise-flip class starts over: two files claiming the same fact, one of them
// eventually stale.
