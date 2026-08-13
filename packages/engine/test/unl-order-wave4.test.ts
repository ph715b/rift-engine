import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented, partialImplementationNote, unimplementedKeywordsOn } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { destroyUnit, forceMoveToBase, forceMoveToBattlefield } from "../src/engine/effect-helpers.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { runBeginning } from "../src/engine/turn-manager.js";
import { timingTierOf } from "../src/engine/timing.js";
import { optionalUnitCostOf } from "../src/engine/card-effects.js";
import type { Domain } from "../src/model/domain.js";
import type { RuneCard } from "../src/model/rune.js";
import type { PlayCardAction, PlayerAction } from "../src/actions/player-action.js";
import type { GameState, PendingDecision } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { beginCombatAt, makeState, makeUnit, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * Wave 4's Unleashed Order cards — four written, four refused.
 *
 * Every reachable path goes through `legalActions` -> `submit`, or through the
 * real dispatch funnel that feeds it (`runCleanup` staging a Showdown,
 * `runBeginning` scoring a hold, a real `MoveUnit` action). None of these tests
 * calls a resolver closure: three of the four written cards are only reachable
 * across a hop a direct call would clear for free — an Attack Trigger crosses the
 * designation check in `applies`, a `[Deathknell]` crosses the death funnel and a
 * chain pop, and a conquer/hold trigger crosses `scoring.ts`.
 *
 * Each card has a NEGATIVE control, and each negative asserts its own POSITIVE
 * control first, because "nothing happened" is exactly what an inert card looks
 * like and a negative on its own cannot tell the two apart.
 *
 * The four refusals are pinned as assertions rather than prose: a refusal recorded
 * only in a comment goes stale silently, while one recorded as a test fails the
 * moment somebody implements the card.
 */

const registry = defaultCardRegistry();

const SAFETY_INSPECTOR = "UNL-164";
const UNDYING_LOYALTY = "UNL-168";
const ATAKHAN = "UNL-170";
const TACTICAL_RETREAT = "UNL-175";
const VI_PEACEKEEPER = "UNL-176";
const IVERN_FRIEND_TO_ALL = "UNL-177";
const POPPY_DEFENDER = "UNL-178";
const RIFT_HERALD = "UNL-179";

/** Enough Ready runes of a card's own Power domain to pay for it outright.
 *  Energy is domain-agnostic, so one colour covers both halves. */
function runesFor(defId: string, count = 24): RuneCard[] {
  const domain: Domain = registry.get(defId).powerDomain ?? "Order";
  return Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));
}

function orderRunes(count: number): RuneCard[] {
  return Array.from({ length: count }, (_, i) => ({ id: `Order-${i}`, domain: "Order" as const, state: "Ready" as const }));
}

function accept(state: GameState, action: PlayerAction | undefined, what: string): GameState {
  expect(action, `${what} was never enumerated`).toBeDefined();
  const { state: next, result } = submit(state, action!);
  expect(result, `${what} was refused: ${JSON.stringify(result)}`).toEqual({ type: "Ok" });
  return next;
}

/** Every enumerated way to play one card instance. */
function castsOf(state: GameState, instanceId: string): PlayCardAction[] {
  return legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);
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

/**
 * Passes Focus until an open SHOWDOWN has closed as well as the chain — what a
 * walk-in needs, and what `passUntilSettled` above deliberately does not do.
 *
 * 348.2.a is why: moving into an empty battlefield opens a Non-Combat Showdown,
 * and control (and therefore the Conquer) is only established when both players
 * have passed in sequence and `closeShowdown` runs. A test that stopped at the
 * empty chain would find the battlefield still uncontrolled and would read a
 * perfectly working conquer trigger as dead.
 */
function settleShowdown(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 24; guard += 1) {
    if (current.pendingDecisions.length > 0) return current;
    if (current.showdownBattlefieldId === null && current.spellChain.length === 0 && current.pendingTriggers.length === 0) {
      return current;
    }
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) return current;
    current = submit(current, pass).state;
  }
  throw new Error("settleShowdown: the showdown never closed");
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

function unitsAt(state: GameState, battlefieldId: string, playerId: string): UnitInstance[] {
  return state.battlefields.find((bf) => bf.id === battlefieldId)?.units[playerId] ?? [];
}

const names = (cards: readonly { name: string }[]) => cards.map((c) => c.name);

// ── Tactical Retreat (UNL-175) ──────────────────────────────────────────────

describe("Tactical Retreat (UNL-175): the next death this turn is a recall instead", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(TACTICAL_RETREAT))).toBe(true);
  });

  it("is a [Reaction] at the timing layer, not merely in its printed text", () => {
    // The keyword is data-driven — `card-loader` sets `isReaction` from the
    // printed bracket and `timingTierOf` is what every timing gate asks. Asserted
    // because a keyword that parses and is read by nothing is exactly how
    // [Deflect] and [Quick-Draw] both shipped inert.
    expect(timingTierOf(spellInstance(TACTICAL_RETREAT))).toBe("Reaction");
  });

  function retreatState(place: (state: GameState) => void): { state: GameState; spellId: string } {
    const spell = spellInstance(TACTICAL_RETREAT);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runesFor(TACTICAL_RETREAT);
    place(state);
    return { state, spellId: spell.instanceId };
  }

  it("sends the warded unit home healed and exhausted instead of to the trash", () => {
    const { state, spellId } = retreatState((s) => {
      s.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "mine", name: "Mine", damage: 2, exhausted: false })] };
    });

    const cast = castsOf(state, spellId).find((a) => a.targetUnitInstanceId === "mine");
    const warded = passUntilSettled(accept(state, cast, "Tactical Retreat on my own unit"));
    expect(warded.deathWardedUnitInstanceIds, "the ward was never recorded").toContain("mine");

    const killed = resolveHeldTriggers(destroyUnit(warded, "mine", 1));
    const survivor = unitAnywhere(killed, "mine");
    expect(survivor, "the ward did not replace the death").toBeDefined();
    expect(names(killed.players[0]!.baseUnits), "it was not recalled to base").toEqual(["Mine"]);
    expect(survivor!.damage, "it was not healed").toBe(0);
    expect(survivor!.exhausted, "it was not exhausted").toBe(true);
    expect(killed.players[0]!.trash.some((c) => c.instanceId === "mine"), "it reached the trash anyway").toBe(false);
  });

  it("NEGATIVE: the same unit, same kill, no Retreat — it dies", () => {
    // The control for the assertion above. Without it "survived" could as easily
    // mean `destroyUnit` never reached it as mean the ward fired.
    const { state } = retreatState((s) => {
      s.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "mine", name: "Mine", damage: 2 })] };
    });

    const killed = resolveHeldTriggers(destroyUnit(state, "mine", 1));
    expect(unitAnywhere(killed, "mine"), "the fixture cannot kill the unit — the positive proves nothing").toBeUndefined();
    expect(names(killed.players[0]!.trash)).toEqual(["Mine"]);
  });

  it("is spent by the death it replaces — 'the NEXT time'", () => {
    const { state, spellId } = retreatState((s) => {
      s.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "mine", name: "Mine" })] };
    });

    const cast = castsOf(state, spellId).find((a) => a.targetUnitInstanceId === "mine");
    const warded = passUntilSettled(accept(state, cast, "Tactical Retreat on my own unit"));
    const once = resolveHeldTriggers(destroyUnit(warded, "mine", 1));
    expect(unitAnywhere(once, "mine"), "the first death was not replaced — this test's premise is gone").toBeDefined();
    expect(once.deathWardedUnitInstanceIds, "the ward was not consumed").not.toContain("mine");

    const twice = resolveHeldTriggers(destroyUnit(once, "mine", 1));
    expect(unitAnywhere(twice, "mine"), "the ward saved it a second time").toBeUndefined();
  });

  it("reaches a unit in BASE — 'a friendly unit' names no battlefield", () => {
    const { state, spellId } = retreatState((s) => {
      s.players[0]!.baseUnits = [makeUnit({ instanceId: "home", name: "Home" })];
    });

    const cast = castsOf(state, spellId).find((a) => a.targetUnitInstanceId === "home");
    const warded = passUntilSettled(accept(state, cast, "Tactical Retreat on a unit at home"));
    expect(warded.deathWardedUnitInstanceIds).toContain("home");
  });

  it("NEGATIVE: never offered against an ENEMY unit, and uncastable with none of your own", () => {
    // Positive control first: the same fixture with a FRIENDLY unit does enumerate,
    // so "no cast was offered" means the owner clause bit rather than that the
    // spell is unplayable for some unrelated reason.
    const { state: friendly, spellId: friendlyId } = retreatState((s) => {
      s.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "mine", name: "Mine" })] };
    });
    expect(castsOf(friendly, friendlyId), "the spell is unplayable outright — the negative below is vacuous").toHaveLength(1);

    const { state, spellId } = retreatState((s) => {
      s.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "theirs", name: "Theirs" })] };
    });
    expect(castsOf(state, spellId)).toHaveLength(0);
  });
});

// ── Vi - Peacekeeper (UNL-176) ──────────────────────────────────────────────

describe("Vi - Peacekeeper (UNL-176): when I attack, stun an enemy unit here", () => {
  it("is whole — her attack trigger was written, and [Ambush] landed", () => {
    // The attack trigger below is real and fires; the play permission is not.
    // "You may play me as a [Reaction] to a battlefield where you have units" is a
    // play permission plus a timing tier, and both live in legal-actions.ts and
    // validate-play-card.ts. `coverage.ts` carries [Ambush] in
    // UNIMPLEMENTED_KEYWORDS, so the card stays greyed whatever is written here.
    //
    // **The keyword landed on 2026-08-09**, and this pin said to delete it that
    // day. Inverted instead: Vi is greyed by nothing now, and a note reappearing
    // would mean the keyword had regressed.
    expect(unimplementedKeywordsOn(registry.get(VI_PEACEKEEPER)), "[Ambush] is greying cards again").toEqual([]);
    expect(isCardImplemented(registry.get(VI_PEACEKEEPER)), "Vi lost a clause — she was whole once [Ambush] landed").toBe(true);
    expect(partialImplementationNote(registry.get(VI_PEACEKEEPER))).toBeUndefined();
  });

  /** Vi attacking at bf1 with `enemies` defending there. */
  function viState(enemies: UnitInstance[], viAt = "bf1"): { state: GameState; vi: UnitInstance } {
    const vi = realUnitInstance(VI_PEACEKEEPER);
    const state = makeState({ phase: "Action" });
    const bfIndex = state.battlefields.findIndex((bf) => bf.id === viAt);
    state.battlefields[bfIndex] = { ...state.battlefields[bfIndex]!, units: { p1: [vi] } };
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      units: { ...state.battlefields[0]!.units, p2: enemies },
    };
    return { state, vi };
  }

  it("stuns the chosen enemy unit at the battlefield she attacks", () => {
    const theirs = makeUnit({ instanceId: "theirs", name: "Theirs" });
    const other = makeUnit({ instanceId: "other", name: "Other" });
    const { state } = viState([theirs, other]);

    const asked = beginCombatAt(state, "bf1", 0);
    expect(offered(asked).playerIndex, "the wrong player was asked").toBe(0);
    expect(offered(asked).ids, "the choice was not offered over both defenders").toEqual(["theirs", "other"]);

    const after = answer(asked, "other");
    expect(unitAnywhere(after, "other")!.stunned, "the chosen unit was not stunned").toBe(true);
    expect(unitAnywhere(after, "theirs")!.stunned, "it stunned the whole battlefield").toBe(false);
  });

  it("NEGATIVE: nothing fires when she DEFENDS — 'when I attack'", () => {
    // ONE enemy, so the question has a single option and `advanceDecisions`
    // performs it without ever showing a prompt — which is why this asserts the
    // STUN rather than the question. (That is also the shape a "no question was
    // pending" assertion would have got wrong in both directions.)
    const theirs = makeUnit({ instanceId: "theirs", name: "Theirs" });
    const { state } = viState([theirs]);

    // Positive control: the same board with Vi as the attacker does stun.
    expect(unitAnywhere(beginCombatAt(state, "bf1", 0), "theirs")!.stunned, "the attacking case is dead too").toBe(true);

    const defending = beginCombatAt(state, "bf1", 1);
    expect(unitAnywhere(defending, "theirs")!.stunned, "she fired on defence").toBe(false);
  });

  it("NEGATIVE: 'HERE' — an enemy at another battlefield is untouched and unoffered", () => {
    const here = makeUnit({ instanceId: "here", name: "Here" });
    const alsoHere = makeUnit({ instanceId: "alsoHere", name: "Also here" });
    const elsewhere = makeUnit({ instanceId: "elsewhere", name: "Elsewhere" });
    // TWO defenders at bf1, so there is a real question to inspect — one option
    // is not a choice and would be executed unprompted.
    const { state } = viState([here, alsoHere]);
    state.battlefields[1] = { ...state.battlefields[1]!, units: { p2: [elsewhere] } };

    const asked = beginCombatAt(state, "bf1", 0);
    expect(offered(asked).ids, "a unit at another battlefield was offered").toEqual(["here", "alsoHere"]);

    const after = answer(asked, "here");
    expect(unitAnywhere(after, "here")!.stunned, "the chosen defender was not stunned").toBe(true);
    expect(unitAnywhere(after, "elsewhere")!.stunned).toBe(false);
  });

  it("NEGATIVE: a Vi standing elsewhere does not fire for someone else's fight", () => {
    const theirs = makeUnit({ instanceId: "theirs", name: "Theirs" });
    const mine = makeUnit({ instanceId: "mine", name: "Mine" });
    const { state } = viState([theirs], "bf2");
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      units: { ...state.battlefields[0]!.units, p1: [mine] },
    };

    const after = beginCombatAt(state, "bf1", 0);
    expect(pendingDecision(after), "she fired from another battlefield").toBeUndefined();
    expect(unitAnywhere(after, "theirs")!.stunned).toBe(false);
  });

  it("a Vi who LEFT during the response window aims at nothing — 359.3.f.2's referent", () => {
    // The hop that a direct resolver call would clear for free: the trigger is
    // held at the designation and resolves a chain pop later, and "here" is read
    // from her at execution.
    const theirs = makeUnit({ instanceId: "theirs", name: "Theirs" });
    const { state, vi } = viState([theirs]);

    const staged = runCleanup({
      ...state,
      battlefields: state.battlefields.map((bf) => (bf.id === "bf1" ? { ...bf, contestedByIndex: 0 as const } : bf)),
    });
    expect(
      staged.spellChain.length + staged.pendingTriggers.length,
      "the trigger resolved inline — this fixture proves nothing",
    ).toBeGreaterThan(0);

    const gone = forceMoveToBattlefield(staged, vi.instanceId, "bf2");
    const settled = resolveHeldTriggers(gone);
    expect(pendingDecision(settled), "the stun was re-aimed from a battlefield she had left").toBeUndefined();
    expect(unitAnywhere(settled, "theirs")!.stunned).toBe(false);
  });

  it("DIVERGENCE-ADJACENT: an already-stunned enemy stays on the list", () => {
    // 423 makes Stun binary, so a second stun does nothing — but "an enemy unit
    // here" is the whole printed restriction and 355.9.b only narrows a target by
    // what is printed. Filtering would turn this into "stun an UNSTUNNED enemy
    // unit here", which differs on exactly this board.
    const stunned = makeUnit({ instanceId: "stunned", name: "Stunned", stunned: true });
    const fresh = makeUnit({ instanceId: "fresh", name: "Fresh" });
    // Two defenders so there IS a prompt to inspect; a lone one would be executed
    // unprompted and the option list would be invisible.
    const { state } = viState([stunned, fresh]);

    const asked = beginCombatAt(state, "bf1", 0);
    expect(pendingDecision(asked), "no question at all — the positive is gone, not just the filter").toBeDefined();
    expect(offered(asked).ids, "the already-stunned defender was filtered out").toEqual(["stunned", "fresh"]);
  });
});

// ── Ivern - Friend to All (UNL-177) ─────────────────────────────────────────

describe("Ivern - Friend to All (UNL-177): a chosen tag, and a point for the full set", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(IVERN_FRIEND_TO_ALL))).toBe(true);
  });

  /** A real Ivern instance carrying tags he was never printed with — the board a
   *  game reaches after his first clause has been answered, without re-driving
   *  that clause in every scoring test. The end-to-end test below joins the two. */
  function ivernTagged(...tags: string[]): UnitInstance {
    const ivern = realUnitInstance(IVERN_FRIEND_TO_ALL);
    return { ...ivern, tags: [...ivern.tags, ...tags] };
  }

  /** A real, paid-for play of Ivern to base. */
  function playIvern(): GameState {
    const ivern = realUnitInstance(IVERN_FRIEND_TO_ALL);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [ivern];
    state.players[0]!.channeled = runesFor(IVERN_FRIEND_TO_ALL);
    const cast = castsOf(state, ivern.instanceId)[0];
    return passUntilSettled(accept(state, cast, "Ivern - Friend to All"));
  }

  it("asks for one of exactly four tags as he is played, and writes the answer onto him", () => {
    const asked = playIvern();
    expect(offered(asked).ids, "the four tribes were not offered").toEqual(["Bird", "Cat", "Dog", "Poro"]);

    const after = answer(asked, "Poro");
    const ivern = after.players[0]!.baseUnits.find((u) => u.defId === IVERN_FRIEND_TO_ALL);
    expect(ivern, "he never reached the board").toBeDefined();
    expect(ivern!.tags, "the chosen tag was not granted").toContain("Poro");
    expect(ivern!.tags, "a tag he did not choose was granted too").not.toContain("Bird");
    // Printed tags are kept: "I GAIN that tag", not "I become that tag".
    expect(ivern!.tags).toEqual(expect.arrayContaining(["Ivern", "Ionia"]));
  });

  it("writes the tag onto him when he was played to a BATTLEFIELD, not just to base", () => {
    // The other half of the write, and it is a real board rather than a
    // contrivance: a Unit reinforces a battlefield its controller already stands
    // at, and his on-play trigger's question resolves a chain pop after he lands
    // there. A grant that only walked `baseUnits` would silently do nothing here.
    const ivern = realUnitInstance(IVERN_FRIEND_TO_ALL);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [ivern];
    state.players[0]!.channeled = runesFor(IVERN_FRIEND_TO_ALL);
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Holder" })] };

    const cast = castsOf(state, ivern.instanceId).find((a) => a.destinationBattlefieldId === "bf1");
    const asked = passUntilSettled(accept(state, cast, "Ivern reinforcing bf1"));
    const after = answer(asked, "Cat");

    const landed = unitsAt(after, "bf1", "p1").find((u) => u.defId === IVERN_FRIEND_TO_ALL);
    expect(landed, "he did not reinforce the battlefield — this test's premise is gone").toBeDefined();
    expect(landed!.tags, "the grant only reached base units").toContain("Cat");
  });

  it("NEGATIVE: a different answer grants a different tag", () => {
    // The control on the assertion above — a resolver that ignored `optionId` and
    // hard-coded one tag would pass the first test and fail this one.
    const after = answer(playIvern(), "Dog");
    const ivern = after.players[0]!.baseUnits.find((u) => u.defId === IVERN_FRIEND_TO_ALL)!;
    expect(ivern.tags).toContain("Dog");
    expect(ivern.tags).not.toContain("Poro");
  });

  /** Ivern standing alone at bf1, which player 0 controls, in their Beginning
   *  Phase — the board `scoreHolds` scores. `friends` join him there. */
  function holdingWith(ivernTags: string[], friends: UnitInstance[]): GameState {
    const ivern = ivernTagged(...ivernTags);
    const state = makeState({ phase: "Beginning", activePlayerIndex: 0 });
    state.battlefields[0] = { ...state.battlefields[0]!, units: { p1: [ivern, ...friends] }, controllerId: "p1" };
    return state;
  }

  const pet = (tag: string) => makeUnit({ name: tag, tags: [tag] });

  it("scores an EXTRA point on a hold when all four tags are on the board", () => {
    const state = holdingWith(["Poro"], [pet("Bird"), pet("Cat"), pet("Dog")]);
    const after = resolveHeldTriggers(runBeginning(state));
    // 1 for the hold itself (469.2), 1 for Ivern.
    expect(after.players[0]!.points, "Ivern's point never arrived").toBe(2);
  });

  it("NEGATIVE: one tag missing and the hold pays its ordinary single point", () => {
    // Positive control first: the same board WITH the Dog scores 2 above, so a 1
    // here is the condition biting rather than the trigger being dead.
    const state = holdingWith(["Poro"], [pet("Bird"), pet("Cat")]);
    const after = resolveHeldTriggers(runBeginning(state));
    expect(after.players[0]!.points, "it paid out on three tribes").toBe(1);
  });

  it("NEGATIVE: it is POSITIONAL — an Ivern at another battlefield pays nothing", () => {
    const state = holdingWith(["Poro"], [pet("Bird"), pet("Cat"), pet("Dog")]);
    // Move Ivern to bf2, leaving the pets to hold bf1 alone. An ENEMY joins him
    // at bf2 so player 0 does not hold that one as well — `isHeldBy` is presence-
    // based, and without the enemy bf2 would score its own hold point and Ivern
    // would fire there, which is a different (and passing) test.
    const [ivern, ...pets] = state.battlefields[0]!.units.p1!;
    state.battlefields[0] = { ...state.battlefields[0]!, units: { p1: pets } };
    state.battlefields[1] = { ...state.battlefields[1]!, units: { p1: [ivern!], p2: [makeUnit({ name: "Blocker" })] } };

    const after = resolveHeldTriggers(runBeginning(state));
    expect(after.players[0]!.points, "he scored for a hold at a battlefield he was not at").toBe(1);
  });

  it("scores on a CONQUER too, driven by a real MoveUnit action", () => {
    // The other half of "when I conquer or hold", and the half that needs `on` to
    // be a list. bf1 is uncontrolled and empty, so walking in takes it — but only
    // once the Non-Combat Showdown the walk-in opens has CLOSED (348.2.a), which
    // is what `settleShowdown` waits for.
    const ivern = ivernTagged("Poro");
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [ivern, pet("Bird"), pet("Cat"), pet("Dog")];

    const move = legalActions(state).find(
      (a) => a.type === "MoveUnit" && a.destinationBattlefieldId === "bf1" && a.unitInstanceIds.includes(ivern.instanceId),
    );
    const after = settleShowdown(accept(state, move, "Ivern walking into bf1"));
    expect(after.battlefields[0]!.controllerId, "the walk-in did not take the battlefield").toBe("p1");
    // 1 for the conquest (469.1), 1 for Ivern.
    expect(after.players[0]!.points, "the conquer half never fired").toBe(2);
  });

  it("NEGATIVE: the same conquest with only three tribes pays the conquest point alone", () => {
    const ivern = ivernTagged("Poro");
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [ivern, pet("Bird"), pet("Cat")];

    const move = legalActions(state).find(
      (a) => a.type === "MoveUnit" && a.destinationBattlefieldId === "bf1" && a.unitInstanceIds.includes(ivern.instanceId),
    );
    const after = settleShowdown(accept(state, move, "Ivern walking into bf1"));
    expect(after.battlefields[0]!.controllerId, "the walk-in did not take the battlefield").toBe("p1");
    expect(after.players[0]!.points, "it paid out on three tribes").toBe(1);
  });

  it("NEGATIVE: the OPPONENT's hold at the same battlefield pays Ivern nothing", () => {
    // "your units" and "when I ... hold" are both about his controller. A trigger
    // matching on the battlefield alone would pay out here.
    const ivern = ivernTagged("Poro");
    const state = makeState({ phase: "Beginning", activePlayerIndex: 1 });
    state.players[0]!.baseUnits = [ivern, pet("Bird"), pet("Cat"), pet("Dog")];
    state.battlefields[0] = { ...state.battlefields[0]!, units: { p2: [makeUnit({ name: "Theirs" })] }, controllerId: "p2" };

    const after = resolveHeldTriggers(runBeginning(state));
    expect(after.players[0]!.points, "Ivern scored on the opponent's hold").toBe(0);
    expect(after.players[1]!.points, "the opponent's own hold did not score — the fixture is broken").toBe(1);
  });

  it("end to end: the tag he was GIVEN is the one that completes the set", () => {
    // The two clauses joined through the real grant rather than a hand-set tag —
    // the whole card, and the only test here that proves the write is the thing
    // the count reads.
    const played = answer(playIvern(), "Poro");
    const ivern = played.players[0]!.baseUnits.find((u) => u.defId === IVERN_FRIEND_TO_ALL)!;

    const staged: GameState = {
      ...played,
      phase: "Beginning",
      activePlayerIndex: 0,
      players: [
        { ...played.players[0]!, baseUnits: [], points: 0 },
        played.players[1]!,
      ],
      battlefields: played.battlefields.map((bf, i) =>
        i === 0 ? { ...bf, units: { p1: [ivern, pet("Bird"), pet("Cat"), pet("Dog")] }, controllerId: "p1" } : bf,
      ),
    };

    const after = resolveHeldTriggers(runBeginning(staged));
    expect(after.players[0]!.points, "the granted tag did not count toward his own condition").toBe(2);
  });

  it("DIVERGENCE: the granted tag survives into the TRASH, where the rules give a card only its printed characteristics", () => {
    // `completeDeath` files the very instance into `trash`, clearing only `buffed`.
    // A card in a non-Board zone should be a new object with only printed
    // characteristics, so a dead Ivern is not a Poro — but `starhoundCandidates`
    // (UNL-167, in this same file) reads `tags` off the trashed instance and would
    // return him. Undoing the write means a hook in `effect-helpers.completeDeath`,
    // which this change does not own.
    //
    // Pinned as the WRONG answer, so closing it fails loudly.
    const played = answer(playIvern(), "Poro");
    const ivern = played.players[0]!.baseUnits.find((u) => u.defId === IVERN_FRIEND_TO_ALL)!;
    const dead = resolveHeldTriggers(destroyUnit(played, ivern.instanceId, 1));

    const corpse = dead.players[0]!.trash.find((c) => c.instanceId === ivern.instanceId) as UnitInstance | undefined;
    expect(corpse, "he did not reach the trash — this pin's premise is gone").toBeDefined();
    expect(corpse!.tags, "the tag is stripped on leaving play now — delete this pin and the divergence row").toContain("Poro");
  });
});

// ── Rift Herald (UNL-179) ───────────────────────────────────────────────────

describe("Rift Herald (UNL-179): a look on arrival, and a free body when he dies", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(RIFT_HERALD))).toBe(true);
  });

  const deckOf = () => [
    makeUnit({ instanceId: "top", name: "Top" }),
    spellInstance(TACTICAL_RETREAT),
    makeUnit({ instanceId: "third", name: "Third" }),
    makeUnit({ instanceId: "fourth", name: "Fourth" }),
  ];

  function heraldInBase(): { state: GameState; herald: UnitInstance } {
    const herald = realUnitInstance(RIFT_HERALD);
    const state = makeState({ phase: "Action" });
    state.players[0]!.baseUnits = [herald];
    state.players[0]!.deck = deckOf();
    return { state, herald };
  }

  function walkTo(state: GameState, instanceId: string, battlefieldId: string): GameState {
    const move = legalActions(state).find(
      (a) => a.type === "MoveUnit" && a.destinationBattlefieldId === battlefieldId && a.unitInstanceIds.includes(instanceId),
    );
    return resolveHeldTriggers(accept(state, move, `a move to ${battlefieldId}`));
  }

  it("looks at the top 3, draws the chosen unit and recycles the other two", () => {
    const { state, herald } = heraldInBase();
    const asked = walkTo(state, herald.instanceId, "bf1");

    expect(offered(asked).ids, "the Spell among the top 3 was offered as a draw").toEqual(["decline", "top", "third"]);

    const after = answer(asked, "third");
    expect(names(after.players[0]!.hand), "the chosen unit was not drawn").toEqual(["Third"]);
    // The other two go to the BOTTOM, under the card that was already fourth.
    expect(names(after.players[0]!.deck)).toEqual(["Fourth", "Top", "Tactical Retreat"]);
  });

  it("NEGATIVE: declining draws nothing but STILL recycles all three", () => {
    // "Recycle the rest" is its own instruction (135.2.b) and runs on every answer.
    // The positive control is the test above: the same board with a unit chosen
    // draws one, so an empty hand here is the decline branch rather than a dead
    // trigger.
    const { state, herald } = heraldInBase();
    const after = answer(walkTo(state, herald.instanceId, "bf1"), "decline");

    expect(after.players[0]!.hand, "declining drew something").toHaveLength(0);
    expect(names(after.players[0]!.deck)).toEqual(["Fourth", "Top", "Tactical Retreat", "Third"]);
  });

  it("NEGATIVE: 'TO A BATTLEFIELD' — a move to BASE looks at nothing", () => {
    // `unitMoved` gained effect-driven emitters on 2026-08-09, and
    // `forceMoveToBase` fires it with `to: "base"`. Without the guard the Herald
    // would look at three cards for free every time an opponent Charmed him home.
    const { state, herald } = heraldInBase();
    const atBattlefield = answer(walkTo(state, herald.instanceId, "bf1"), "decline");
    expect(atBattlefield.players[0]!.deck, "the fixture never moved him — the guard below is untested").toHaveLength(4);

    const home = resolveHeldTriggers(forceMoveToBase(atBattlefield, herald.instanceId, 1));
    expect(unitAnywhere(home, herald.instanceId), "he did not go home — this negative proves nothing").toBeDefined();
    expect(home.players[0]!.baseUnits.some((u) => u.instanceId === herald.instanceId)).toBe(true);
    expect(pendingDecision(home), "a move to base opened the look").toBeUndefined();
    expect(names(home.players[0]!.deck), "the deck was disturbed by a move to base").toEqual([
      "Fourth",
      "Top",
      "Tactical Retreat",
      "Third",
    ]);
  });

  it("NEGATIVE: someone ELSE's move opens nothing — 'when I move'", () => {
    const { state, herald } = heraldInBase();
    const other = makeUnit({ instanceId: "other", name: "Other" });
    state.players[0]!.baseUnits = [herald, other];

    const after = walkTo(state, "other", "bf1");
    expect(pendingDecision(after), "another unit's move fired his look").toBeUndefined();
    expect(after.players[0]!.deck).toHaveLength(4);
  });

  it("[Deathknell]: plays a unit from HAND to base, paying its Power but not its Energy", () => {
    const herald = realUnitInstance(RIFT_HERALD);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [herald] };
    // 9 Energy is far beyond anything payable here; the Power pip is one Order.
    state.players[0]!.hand = [makeUnit({ instanceId: "big", name: "Big", energyCost: 9, powerCost: 1, powerDomain: "Order" })];
    state.players[0]!.channeled = orderRunes(1);

    const asked = resolveHeldTriggers(destroyUnit(state, herald.instanceId, 1));
    // One option is not a choice — `advanceDecisions` performs it unprompted.
    expect(pendingDecision(asked), "a single mandatory option was left as a question").toBeUndefined();

    expect(names(asked.players[0]!.baseUnits), "the unit never left hand").toEqual(["Big"]);
    expect(asked.players[0]!.hand, "it is in two zones at once").toHaveLength(0);
    expect(asked.players[0]!.baseUnits[0]!.exhausted, "it did not enter exhausted (143.4.a)").toBe(true);
    expect(asked.players[0]!.cardsPlayedThisTurn, "a free play did not count as a play").toBe(1);
    // The Power WAS paid: the rune left the channeled pool.
    expect(asked.players[0]!.channeled, "the Power cost was ignored as well as the Energy").toHaveLength(0);
  });

  it("NEGATIVE: a hand whose only unit's POWER cannot be paid asks nothing", () => {
    // Positive control: the same hand WITH the rune plays it, above. Here the
    // pool is empty, so the mandatory instruction has no legal answer at all.
    const herald = realUnitInstance(RIFT_HERALD);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [herald] };
    state.players[0]!.hand = [makeUnit({ instanceId: "big", name: "Big", energyCost: 9, powerCost: 1, powerDomain: "Order" })];

    const after = resolveHeldTriggers(destroyUnit(state, herald.instanceId, 1));
    expect(after.pendingDecisions, "a question with no payable answer was parked").toHaveLength(0);
    expect(after.players[0]!.baseUnits, "an unpayable unit was played for free").toHaveLength(0);
    expect(names(after.players[0]!.hand)).toEqual(["Big"]);
  });

  it("NEGATIVE: a hand of SPELLS asks nothing — 'play a UNIT'", () => {
    const herald = realUnitInstance(RIFT_HERALD);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [herald] };
    state.players[0]!.hand = [spellInstance(TACTICAL_RETREAT)];
    state.players[0]!.channeled = orderRunes(4);

    const after = resolveHeldTriggers(destroyUnit(state, herald.instanceId, 1));
    expect(after.pendingDecisions).toHaveLength(0);
    expect(names(after.players[0]!.hand)).toEqual(["Tactical Retreat"]);
  });

  it("[Deathknell]: with two payable units it is a real question, and the answer chooses", () => {
    const herald = realUnitInstance(RIFT_HERALD);
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [herald] };
    state.players[0]!.hand = [
      makeUnit({ instanceId: "free", name: "Free", energyCost: 4 }),
      makeUnit({ instanceId: "priced", name: "Priced", energyCost: 4, powerCost: 1, powerDomain: "Order" }),
    ];
    state.players[0]!.channeled = orderRunes(1);

    const asked = resolveHeldTriggers(destroyUnit(state, herald.instanceId, 1));
    expect(offered(asked).ids, "the mandatory question offered a decline").toEqual(["free", "priced"]);
    expect(offered(asked).labels[1], "the Power price is not shown in the label").toMatch(/1 Order Power/);

    const after = answer(asked, "priced");
    expect(names(after.players[0]!.baseUnits)).toEqual(["Priced"]);
    expect(names(after.players[0]!.hand)).toEqual(["Free"]);
  });
});

// ── The four refusals ───────────────────────────────────────────────────────

describe("wave 4's refusals, pinned so they cannot go stale silently", () => {
  it("Poppy - Defender of the Meek (UNL-178) has NOTHING written: its only text is an XP additional cost", () => {
    // "You may spend 3 XP as an additional cost to play me. If you do, I cost [3]
    // less." `PlayCardAction` has no XP field and `OPTIONAL_POWER_COSTS` /
    // `OPTIONAL_UNIT_COSTS` are paid with runes and with permanents respectively —
    // all in card-effects.ts, actions/player-action.ts, legal-actions.ts and
    // validate-play-card.ts. 204.1.b/204.2.a make it a real cost, and 205 names XP
    // among the things an instruction can require be spent.
    //
    // [Tank] and [Ambush] both work now — the keyword landed 2026-08-09 — so the
    // ONLY thing still greying this card is its unwritten XP additional cost,
    // which is what this pin is actually about. That is a stronger pin than it
    // was: it can no longer pass on the strength of an unrelated keyword.
    expect(optionalUnitCostOf(POPPY_DEFENDER), "an additional cost is registered now — rewrite this pin").toBeUndefined();
    expect(unimplementedKeywordsOn(registry.get(POPPY_DEFENDER)), "a keyword is greying it instead of the cost").toEqual([]);
    expect(isCardImplemented(registry.get(POPPY_DEFENDER)), "the XP cost landed — rewrite this pin").toBe(false);
    expect(isCardImplemented(registry.get(POPPY_DEFENDER))).toBe(false);

    // The discount is the observable half: he costs his printed 6 Energy and one
    // Order however much XP his controller is sitting on.
    const poppy = realUnitInstance(POPPY_DEFENDER);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [poppy];
    state.players[0]!.channeled = runesFor(POPPY_DEFENDER);
    state.players[0]!.xp = 9;

    const casts = castsOf(state, poppy.instanceId);
    expect(casts, "no cast was offered — the fixture is wrong, not the refusal").toHaveLength(1);
    expect(casts[0]!.payment.energyRunes, "the XP discount has landed — update this pin").toHaveLength(6);
    expect(casts[0]!.payment.powerRunes).toHaveLength(1);
  });

  it("Safety Inspector (UNL-164) CAN buy out of his own kill — this refusal expired 2026-08-10", () => {
    // **Was a refusal pin, and it is inverted rather than deleted.** Wave 3 wrote
    // the kill and refused the "spend 3 XP" additional cost; wave 4 re-checked and
    // agreed. Both were right at the time — the mechanism genuinely did not exist
    // — and the refusal named the four shared files it would take. That is what
    // was built: `OPTIONAL_XP_COSTS`, `optionalXpPaid`, an enumerated variant, a
    // validator check, and the spend in execute-play-card.
    //
    // What both refusals OVERestimated is worth keeping: they expected the rune
    // pricing fan-out an optional POWER cost needs. 731 makes XP not a Game
    // Object, so there is no domain, no [Deflect] tax and no discount axis — the
    // paid variant is the plain play plus a flag, and its payment is identical.
    //
    // `optionalUnitCostOf` is still undefined for him and that is still correct:
    // his cost is XP, not a chosen permanent. Kept so the two tables cannot be
    // confused for one another.
    expect(optionalUnitCostOf(SAFETY_INSPECTOR)).toBeUndefined();
    expect(partialImplementationNote(registry.get(SAFETY_INSPECTOR)), "he is being blamed for a half he now has").toBeUndefined();

    const inspector = realUnitInstance(SAFETY_INSPECTOR);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [inspector];
    state.players[0]!.channeled = runesFor(SAFETY_INSPECTOR);
    state.players[0]!.xp = 9;
    state.players[0]!.baseUnits = [makeUnit({ instanceId: "mine", name: "Mine" })];

    const casts = castsOf(state, inspector.instanceId);
    expect(casts, "the paid/unpaid fan-out is gone").toHaveLength(2);

    // The DECLINED variant still behaves exactly as this pin proved it did — kept
    // so that adding the option cannot have changed the option-less path.
    const free = casts.find((c) => (c as { optionalXpPaid?: true }).optionalXpPaid !== true)!;
    const asked = passUntilSettled(accept(state, free, "Safety Inspector, cost declined"));
    expect(offered(asked).ids.sort(), "declining stopped asking the caster to kill").toEqual(
      [inspector.instanceId, "mine"].sort(),
    );
    const after = answer(asked, "mine");
    expect(unitAnywhere(after, "mine"), "declining no longer costs a unit").toBeUndefined();
  });

  it("Undying Loyalty (UNL-168) now plays a Poro FREE — this pin EXPIRED on 2026-08-12", () => {
    // The pin that stood here charged the printed 2 Energy for a Poro and was
    // right for three waves. Its fixture is kept and only the expectation
    // inverted, because it already built exactly the board the clause is about.
    //
    // The blocker was never a table: "[2] less if you CHOOSE a Bird, Cat, Dog, or
    // Poro" needs the choice made when the card is PAID for, and this card named
    // its trash unit at resolution through a parked question. Moving that to an
    // announce-time target (355.4 / 355.9.a.4) is what made the discount
    // expressible — and is the rules-correct timing besides.
    expect(partialImplementationNote(registry.get(UNDYING_LOYALTY)), "a partial note came back").toBeUndefined();

    const spell = spellInstance(UNDYING_LOYALTY);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runesFor(UNDYING_LOYALTY);
    state.players[0]!.trash = [makeUnit({ instanceId: "poro", name: "Poro", energyCost: 2, powerCost: 1, tags: ["Poro"] })];

    const casts = castsOf(state, spell.instanceId);
    expect(casts, "the trash unit stopped being fanned out as a target").toHaveLength(1);
    expect(casts[0]!.trashCardInstanceId, "the choice is not riding the action").toBe("poro");
    // 2 printed Energy minus the 2 the Poro buys — free on the Energy axis.
    expect(casts[0]!.payment.energyRunes, "the -[2] discount did not apply").toHaveLength(0);
    // "[2] less" names Energy only; the printed rainbow pip is still owed.
    expect(casts[0]!.payment.powerRunes, "the Power pip stopped being charged").toHaveLength(1);
  });

  it("Atakhan (UNL-170) now trades a friendly unit for a scaled discount — this pin EXPIRED on 2026-08-12", () => {
    // The pin that stood here asserted the opposite of every line below, and it
    // was correct for as long as the clause was unwritten. It described the card
    // precisely, right down to the sacrifice it built ("5 Energy and 2 Power,
    // which the printed clause would turn into a 5-Energy 1-Order Atakhan") —
    // which is exactly what now happens, so it is kept as the fixture and
    // inverted rather than deleted.
    //
    // Full behaviour lives in `atakhan-sacrifice-discount.test.ts`. What is
    // asserted here is only what this wave file was pinning: that the cost is
    // registered at all and that the fan-out reaches the board.
    expect(optionalUnitCostOf(ATAKHAN), "the kill-a-friendly cost stopped being registered").toMatchObject({
      kind: "killFriendly",
    });
    expect(partialImplementationNote(registry.get(ATAKHAN)), "a partial note came back").toBeUndefined();

    const atakhan = realUnitInstance(ATAKHAN);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [atakhan];
    state.players[0]!.channeled = runesFor(ATAKHAN, 32);
    // The same juicy sacrifice the old pin built: 5 Energy and 2 Power.
    state.players[0]!.baseUnits = [
      makeUnit({ instanceId: "fodder", name: "Fodder", energyCost: 5, powerCost: 2, powerDomain: "Order" }),
    ];

    const casts = castsOf(state, atakhan.instanceId);
    // Two now: the decline, and the sacrifice. "You MAY kill" — so the printed
    // play must survive alongside the discounted one.
    expect(casts, "the sacrifice variant is not being fanned out").toHaveLength(2);

    const declined = casts.find((c) => c.additionalCostUnitInstanceId === undefined)!;
    expect(declined.payment.energyRunes, "declining stopped costing the printed price").toHaveLength(10);
    expect(declined.payment.powerRunes).toHaveLength(3);

    const paid = casts.find((c) => c.additionalCostUnitInstanceId === "fodder")!;
    expect(paid.payment.energyRunes, "the scaled Energy discount did not apply").toHaveLength(5);
    expect(paid.payment.powerRunes, "the scaled Power discount did not apply").toHaveLength(1);
  });
});
