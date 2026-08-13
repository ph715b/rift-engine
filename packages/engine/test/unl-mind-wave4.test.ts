import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { runBeginning } from "../src/engine/turn-manager.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type GearInstance, type UnitInstance } from "../src/model/card.js";
import type { Domain } from "../src/model/domain.js";
import type { RuneCard } from "../src/model/rune.js";
import type { ActivateAbilityAction, PlayCardAction } from "../src/actions/player-action.js";
import type { GameState } from "../src/model/game-state.js";
import { beginCombatAt, makeState, makeUnit, realUnitInstance, resolveHeldTriggers, spellInstance } from "./fixtures.js";

/**
 * The Unleashed (UNL) Mind cards of wave 4 — effects/mind.ts.
 *
 * **Everything drives a real entry point**: `legalActions` -> `submit` for the
 * two cards a player plays or activates, and `submit({type:"Pass"})` /
 * `runBeginning` for the four whose moment is a phase or a score. Calling a
 * resolver closure would clear every dispatch hop at once, and the hops are where
 * this engine has actually lost effects before.
 *
 * Each card has a NEGATIVE control, and each negative asserts its own POSITIVE
 * control first — "nothing happened" is exactly what an inert card looks like, so
 * a negative that cannot tell the two apart proves nothing.
 *
 * Three of these tests are PINS on clauses that are deliberately unwritten
 * (Deadly Flourish's delayed Gold token, Blue Sentinel's hold doubling). They
 * assert the WRONG answer on purpose, so closing the gap fails loudly instead of
 * changing behaviour nobody was watching.
 *
 * Helpers are local rather than added to fixtures.ts, which is shared and being
 * edited by other agents in this tree — the call unl-mind-wave2.test.ts records.
 */

const registry = defaultCardRegistry();

const DEADLY_FLOURISH = "UNL-073"; // Spell, 4 Energy — "Deal 3 to an enemy unit. When it dies this turn, ..."
const SPRITE_QUEEN = "UNL-084"; // Unit, 7 Energy 1 Mind — a Temporary Sprite on play and every Beginning Phase
const SUMPWORKS_MAP = "UNL-085"; // Gear, 2 Energy — "[Reaction][Temporary] When an opponent scores, draw 1."
const BLUE_SENTINEL = "UNL-087"; // Unit, 4 Energy 1 Mind — hold doubling (unwritten) + "[Add] rainbow"
const GUTTER_PALACE = "UNL-088"; // Gear, 4 Energy — the alternate win, and a Bird for a discard
const AHRI_ALLURING = "OGN-066"; // "When I hold, you score 1 point" — the hold effect Blue Sentinel should double
const TIME_WARP = "OGN-122"; // filler for decks and hands

/** Enough Ready runes of a card's own Power domain to pay for it outright. */
function runesFor(defId: string, count = 24): RuneCard[] {
  const domain: Domain = registry.get(defId).powerDomain ?? "Mind";
  return Array.from({ length: count }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));
}

const gearInPlay = (defId: string, instanceId: string): GearInstance =>
  ({ ...createCardInstance(registry.get(defId)), instanceId, exhausted: false }) as GearInstance;

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

/** Passes Focus until an open Showdown has CLOSED, then settles the chain. A
 *  walk-in conquest needs both: the Showdown window is what establishes control
 *  (348.2.a), and the conquer trigger it raises is held behind it. */
function closeShowdownAndSettle(state: GameState): GameState {
  let current = state;
  for (let guard = 0; guard < 16 && current.showdownBattlefieldId !== null; guard += 1) {
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) break;
    current = accept(current, pass);
  }
  return passUntilSettled(current);
}

const castsOf = (state: GameState, instanceId: string) =>
  legalActions(state).filter(
    (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId,
  );

const activationsOf = (state: GameState, instanceId: string) =>
  legalActions(state).filter(
    (a): a is ActivateAbilityAction => a.type === "ActivateAbility" && a.permanentInstanceId === instanceId,
  );

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

/** Every unit `playerIndex` has anywhere on the board, base included. */
function ownUnits(state: GameState, playerIndex: 0 | 1): UnitInstance[] {
  const player = state.players[playerIndex]!;
  return [...player.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[player.id] ?? [])];
}

const unitOnBoard = (state: GameState, instanceId: string): UnitInstance | undefined =>
  [...ownUnits(state, 0), ...ownUnits(state, 1)].find((u) => u.instanceId === instanceId);

const namedUnits = (state: GameState, playerIndex: 0 | 1, name: string) =>
  ownUnits(state, playerIndex).filter((u) => u.name === name);

describe("Deadly Flourish (UNL-073): deal 3 to an enemy unit", () => {
  /** The spell in hand, one enemy at a battlefield, one enemy in base, and one
   *  FRIENDLY unit that must never be offered. */
  function flourishState(victimMight = 6) {
    const spell = spellInstance(DEADLY_FLOURISH);
    const victim = makeUnit({ instanceId: "victim", name: "Victim", might: victimMight });
    const inBase = makeUnit({ instanceId: "in-base", name: "Enemy At Home", might: 6 });
    const friend = makeUnit({ instanceId: "friend", name: "Friend", might: 6 });
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [spell];
    state.players[0]!.channeled = runesFor(DEADLY_FLOURISH);
    state.players[0]!.baseUnits = [friend];
    state.players[1]!.baseUnits = [inBase];
    state.battlefields[0]!.units = { p2: [victim] };
    return { state, spellId: spell.instanceId };
  }

  it("marks 3 damage on the chosen enemy and nothing on the bystander", () => {
    const { state, spellId } = flourishState();
    const cast = castsOf(state, spellId).find((a) => a.targetUnitInstanceId === "victim");
    expect(cast, "the enemy at a battlefield was never offered").toBeDefined();

    const after = passUntilSettled(accept(state, cast!));

    expect(unitOnBoard(after, "victim")?.damage, "the damage never landed").toBe(3);
    expect(unitOnBoard(after, "in-base")?.damage, "'an enemy unit' is singular").toBe(0);
  });

  it("reaches an enemy standing in BASE — the bare noun is not battlefield-only", () => {
    const { state, spellId } = flourishState();
    const cast = castsOf(state, spellId).find((a) => a.targetUnitInstanceId === "in-base");
    expect(cast, "355.9.a.1's board-wide bare noun was read as battlefield-only").toBeDefined();

    expect(unitOnBoard(passUntilSettled(accept(state, cast!)), "in-base")?.damage).toBe(3);
  });

  it("never offers a FRIENDLY unit — the positive control is that it offers two enemies", () => {
    const { state, spellId } = flourishState();
    const offeredTargets = castsOf(state, spellId).map((a) => a.targetUnitInstanceId);

    expect(offeredTargets, "nothing was offered at all, so 'no friend' proves nothing").toEqual(
      expect.arrayContaining(["victim", "in-base"]),
    );
    expect(offeredTargets).not.toContain("friend");
  });

  /**
   * **The pin that WAS here has been closed.** It asserted the wrong answer on
   * purpose — "the victim dies and NO Gold token arrives" — because no mechanism
   * then carried a delayed trigger past its subject's death.
   *
   * One landed: `TRASH_LISTENER_DEF_IDS` now names this card, so the Flourish
   * watches from its caster's trash for a death carrying a mark it wrote on the
   * victim before the damage. The assertion is flipped rather than deleted, so
   * the shortest path to the clause — a 3-Might victim dying to the printed 3 —
   * stays covered here beside the damage half.
   *
   * The rest of the clause (a later death the same turn, the per-victim and
   * per-spell scoping, the turn stamp, the strip after paying) lives in
   * `unl-mind-wave8.test.ts`.
   */
  it("the victim dies to the 3 and a Gold gear token arrives, exhausted", () => {
    const { state, spellId } = flourishState(3);
    const cast = castsOf(state, spellId).find((a) => a.targetUnitInstanceId === "victim");

    const after = passUntilSettled(accept(state, cast!));

    // The positive control the pin already carried: the death really happened,
    // so the delayed clause had its moment.
    expect(unitOnBoard(after, "victim"), "the victim survived, so this proves nothing").toBeUndefined();
    expect(after.players[1]!.trash.map((c) => c.instanceId)).toContain("victim");
    const gold = after.players[0]!.activeGear;
    expect(gold, "the delayed Gold token never arrived").toHaveLength(1);
    expect(gold[0]!.exhausted, "'play a Gold gear token EXHAUSTED'").toBe(true);
  });

  it("is WHOLE — its second clause landed on 2026-08-12", () => {
    // This pin asserted the card was half-written and that its note named the
    // missing clause. Both were true until the trash-listener row landed, and it
    // is inverted rather than deleted: a delayed clause that silently stopped
    // firing pays no Gold and looks like nothing at all.
    expect(isCardImplemented(registry.get(DEADLY_FLOURISH)), "Deadly Flourish went back to half-written").toBe(true);
    expect(partialImplementationNote(registry.get(DEADLY_FLOURISH)), "a partial note came back").toBeUndefined();
  });
});

describe("Sprite Queen (UNL-084): a Temporary Sprite on play and every Beginning Phase", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(SPRITE_QUEEN))).toBe(true);
  });

  it("mints a ready 3-Might Temporary Sprite in your base when she is played", () => {
    const queen = realUnitInstance(SPRITE_QUEEN);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [queen];
    state.players[0]!.channeled = runesFor(SPRITE_QUEEN);

    const after = passUntilSettled(accept(state, castsOf(state, queen.instanceId)[0]));

    const sprites = namedUnits(after, 0, "Sprite");
    expect(sprites, "no Sprite arrived").toHaveLength(1);
    expect(after.players[0]!.baseUnits.map((u) => u.name), "the Sprite is not in base").toContain("Sprite");
    expect(sprites[0]!.might).toBe(3);
    expect(sprites[0]!.exhausted, "'a READY Sprite' entered exhausted").toBe(false);
    expect(sprites[0]!.keywords.Temporary, "the token lost its [Temporary]").toBe(1);
    expect(namedUnits(after, 1, "Sprite"), "the opponent got one too").toHaveLength(0);
  });

  it("she herself is NOT Temporary — the printed bracket belongs to her token", () => {
    // The negative control for the loader's GRANTED_ONLY_KEYWORDS row: a Queen
    // carrying [Temporary] would kill herself on her controller's next Beginning
    // Phase, which is the opposite of a 7-Energy body.
    expect(realUnitInstance(SPRITE_QUEEN).keywords.Temporary).toBeUndefined();
  });

  it("mints another at the start of HER controller's Beginning Phase", () => {
    // Player 1 passes, so player 0's turn — and Beginning Phase — begins inside
    // that one action.
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.players[0]!.baseUnits = [realUnitInstance(SPRITE_QUEEN)];
    state.players[0]!.deck = [spellInstance(TIME_WARP)];
    state.players[1]!.deck = [spellInstance(TIME_WARP)];

    const after = passUntilSettled(accept(state, { type: "Pass", playerIndex: 1 }));

    expect(namedUnits(after, 0, "Sprite"), "her Beginning-Phase clause never fired").toHaveLength(1);
  });

  it("does NOT fire on the OPPONENT's Beginning Phase — the positive control is her own", () => {
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.baseUnits = [realUnitInstance(SPRITE_QUEEN)];
    state.players[0]!.deck = [spellInstance(TIME_WARP)];
    state.players[1]!.deck = [spellInstance(TIME_WARP)];

    // Player 0 passes: it becomes player 1's turn, so the Beginning Phase that
    // runs is the OPPONENT's.
    const theirTurn = passUntilSettled(accept(state, { type: "Pass", playerIndex: 0 }));
    expect(namedUnits(theirTurn, 0, "Sprite"), "she fired on the wrong player's phase").toHaveLength(0);

    // ...and one more pass brings her own around, which is what makes the line
    // above a real negative rather than a card that never works.
    const herTurn = passUntilSettled(accept(theirTurn, { type: "Pass", playerIndex: 1 }));
    expect(namedUnits(herTurn, 0, "Sprite"), "she never fires at all").toHaveLength(1);
  });

  it("last turn's Sprite has already expired when the new one is made (816, before scoring)", () => {
    // Two full rounds: the Sprite from round one dies in `killTemporaryPermanents`
    // at the start of round two's Beginning Phase, which runs BEFORE the
    // `beginningPhase` dispatch that makes the replacement. So there is never a
    // pile of them.
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.players[0]!.baseUnits = [realUnitInstance(SPRITE_QUEEN)];
    state.players[0]!.deck = [spellInstance(TIME_WARP), spellInstance(TIME_WARP)];
    state.players[1]!.deck = [spellInstance(TIME_WARP), spellInstance(TIME_WARP)];

    let current = passUntilSettled(accept(state, { type: "Pass", playerIndex: 1 }));
    expect(namedUnits(current, 0, "Sprite")).toHaveLength(1);
    current = passUntilSettled(accept(current, { type: "Pass", playerIndex: 0 }));
    current = passUntilSettled(accept(current, { type: "Pass", playerIndex: 1 }));

    expect(namedUnits(current, 0, "Sprite"), "the Sprites accumulated — [Temporary] is not killing them").toHaveLength(1);
  });
});

describe("Sumpworks Map (UNL-085): when an opponent scores, draw 1", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(SUMPWORKS_MAP))).toBe(true);
  });

  /** The Map on player 0's board, with decks on both sides so a draw is
   *  observable as a deck that shrank. */
  function mapState(activePlayerIndex: 0 | 1): GameState {
    const state = makeState({ phase: "Action", activePlayerIndex });
    state.players[0]!.activeGear = [gearInPlay(SUMPWORKS_MAP, "map")];
    state.players[0]!.deck = [spellInstance(TIME_WARP), spellInstance(TIME_WARP), spellInstance(TIME_WARP)];
    state.players[1]!.deck = [spellInstance(TIME_WARP), spellInstance(TIME_WARP), spellInstance(TIME_WARP)];
    return state;
  }

  it("draws when the OPPONENT holds a battlefield", () => {
    const state = mapState(0);
    state.battlefields[0]!.units = { p2: [makeUnit({ name: "Squatter" })] };
    state.battlefields[0]!.controllerId = "p2";

    const after = resolveHeldTriggers(accept(state, { type: "Pass", playerIndex: 0 }));

    expect(after.players[1]!.points, "the opponent never scored, so this proves nothing").toBe(1);
    expect(after.players[0]!.deck, "the Map did not draw").toHaveLength(2);
    expect(after.players[0]!.hand.map((c) => c.name)).toEqual(["Time Warp"]);
  });

  it("draws when the OPPONENT conquers, through a real move", () => {
    const state = mapState(1);
    state.players[1]!.baseUnits = [makeUnit({ instanceId: "raider", name: "Raider" })];

    const move = legalActions(state).find(
      (a) => a.type === "MoveUnit" && a.unitInstanceIds.includes("raider") && a.destinationBattlefieldId === "bf1",
    );
    expect(move, "no move to bf1 was offered").toBeDefined();
    // A walk-in onto an uncontrolled battlefield opens a NON-COMBAT Showdown
    // (190.3.a, 316.8.b.1.a); control — and therefore the Conquer — is
    // established only when both players pass and it closes (348.2.a).
    const after = closeShowdownAndSettle(accept(state, move));

    expect(after.players[1]!.points, "the move did not conquer, so this proves nothing").toBe(1);
    expect(after.players[0]!.deck, "the Map did not draw on a conquer").toHaveLength(2);
  });

  /**
   * **The Map can never see its own controller's HOLD**, and it is `[Temporary]`
   * that stops it rather than the "an opponent" test: 816 kills it at the start
   * of its controller's Beginning Phase, BEFORE scoring, so it is already in the
   * trash when their holds score.
   *
   * Measured, not assumed — this test was written as the negative control for the
   * ownership gate, and a mutation that DELETED that gate still passed it. The
   * real gate test is the conquer one below; this one now asserts what it can
   * actually see.
   */
  it("is already dead when its own controller's holds score — [Temporary], before scoring", () => {
    const state = mapState(1);
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Garrison" })] };
    state.battlefields[0]!.controllerId = "p1";

    // Player 1 passes, so player 0 — the Map's controller — takes a turn and
    // holds bf1.
    const after = resolveHeldTriggers(accept(state, { type: "Pass", playerIndex: 1 }));

    expect(after.players[0]!.points, "player 0 never scored, so the negative is vacuous").toBe(1);
    expect(after.players[0]!.activeGear, "[Temporary] did not sweep the Map").toHaveLength(0);
    // Exactly ONE card gone: the Draw Phase's.
    expect(after.players[0]!.deck, "something drew a second card").toHaveLength(2);
  });

  /**
   * The negative control that DOES reach the "an opponent" test: a conquest by
   * the Map's OWN controller, on the opponent's turn — which is the only way the
   * Map is still alive to see its controller score at all.
   *
   * Player 1 attacks into player 0's 6-Might unit with a 1-Might one and loses;
   * 466.5 then gives player 0 control, which is a Conquer (469.1) on somebody
   * else's turn.
   */
  it("draws NOTHING when ITS OWN controller conquers — and the conquest really happened", () => {
    const state = mapState(1);
    state.battlefields[0]!.units = {
      p1: [makeUnit({ instanceId: "holder", name: "Holder", might: 6 })],
      p2: [makeUnit({ instanceId: "attacker", name: "Attacker", might: 1 })],
    };

    const after = closeShowdownAndSettle(beginCombatAt(state, "bf1", 1));

    expect(after.players[0]!.points, "player 0 never conquered, so the negative is vacuous").toBe(1);
    expect(after.players[0]!.activeGear, "the Map left play, so this proves nothing").toHaveLength(1);
    expect(after.players[0]!.deck, "'an OPPONENT scores' fired for its own controller").toHaveLength(3);
  });
});

describe("Blue Sentinel (UNL-087): [Add] rainbow when I hold", () => {
  /** `holder` alone at bf2, so bf2 is held by player 1 on their own turn — the
   *  same shape battlefield-held-event.test.ts uses, one battlefield over so the
   *  "not at this one" negative has somewhere to stand. */
  function sentinelState(units: UnitInstance[]): GameState {
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[1]!.units = { p2: units };
    state.battlefields[1]!.controllerId = "p2";
    state.players[1]!.deck = [spellInstance(TIME_WARP)];
    return state;
  }

  it("is WHOLE as of 2026-08-11 — both clauses are written", () => {
    // The [Add] on hold worked from this wave; "your hold effects for holding
    // here trigger an additional time" landed with `TriggerChainEntry.times`,
    // built to match Karthus - Eternal, who prints the identical sentence.
    expect(isCardImplemented(registry.get(BLUE_SENTINEL)), "the Sentinel is greyed again").toBe(true);
    expect(partialImplementationNote(registry.get(BLUE_SENTINEL)), "a partial note came back").toBeUndefined();
  });

  it("adds TWO rainbow Power when it holds — its own [Add] is a hold effect here", () => {
    const state = sentinelState([realUnitInstance(BLUE_SENTINEL)]);

    const passed = accept(state, { type: "Pass", playerIndex: 0 });
    // The hold itself scored inside the Pass; the trigger is still a Pending Item.
    expect(passed.players[1]!.points, "the hold never happened").toBe(1);
    expect(passed.phase, "the start of turn did not reach the Main Phase").toBe("Action");
    expect(passed.players[1]!.floatingRainbowPower, "it resolved inline, in the Beginning Phase").toBe(0);

    const settled = resolveHeldTriggers(passed);
    // **Was 1 until 2026-08-11.** His own "[Add] rainbow when I hold" IS one of
    // "your hold effects for holding here", so the doubling applies to it — the
    // same way Red Brambleback doubles his own conquer buff. Not a regression: a
    // Sentinel that added only one would mean the second clause had stopped
    // reaching his own first one.
    expect(settled.players[1]!.floatingRainbowPower, "his own [Add] stopped doubling").toBe(2);
    expect(settled.phase, "the Power arrived outside the Main Phase").toBe("Action");
  });

  it("does NOT fire for a battlefield it is not standing at", () => {
    const state = sentinelState([realUnitInstance(BLUE_SENTINEL)]);
    // A second held battlefield with an ordinary body on it: two holds, two
    // points, and only ONE of them is the Sentinel's.
    state.battlefields[0]!.units = { p2: [makeUnit({ name: "Outpost" })] };
    state.battlefields[0]!.controllerId = "p2";

    const settled = resolveHeldTriggers(accept(state, { type: "Pass", playerIndex: 0 }));

    expect(settled.players[1]!.points, "only one battlefield was held, so this proves nothing").toBe(2);
    // TWO, not one: the hold he is standing at doubles his own [Add]. The claim
    // this test makes is that the OTHER held battlefield adds nothing — which is
    // what separates 2 from 4.
    expect(settled.players[1]!.floatingRainbowPower, "it paid for a battlefield it is not at").toBe(2);
  });

  it("gives the opponent nothing", () => {
    const settled = resolveHeldTriggers(accept(sentinelState([realUnitInstance(BLUE_SENTINEL)]), { type: "Pass", playerIndex: 0 }));
    expect(settled.players[0]!.floatingRainbowPower).toBe(0);
  });

  /**
   * **PIN on the unwritten second clause** — "Your hold effects for holding here
   * trigger an additional time."
   *
   * Ahri - Alluring stands beside the Sentinel and reads "when I hold, you score
   * 1 point". Printed, the Sentinel doubles her: the hold's own point, Ahri's,
   * and Ahri's again = 3, and his own `[Add]` doubles to 2 rainbow.
   *
   * This asserts 2 and 1 — the wrong answers — because `holdEventTrigger` pushes
   * exactly one Pending Item per (listener, key) and has no multiplier. When the
   * doubling lands, this fails.
   */
  it("doubles ANOTHER hold effect at its own battlefield — was a pin, flipped 2026-08-11", () => {
    const state = sentinelState([realUnitInstance(BLUE_SENTINEL), realUnitInstance(AHRI_ALLURING)]);

    const settled = resolveHeldTriggers(accept(state, { type: "Pass", playerIndex: 0 }));

    // Positive control: Ahri fired at all. Without this, "2" would also be the
    // reading for a board where nothing but the bare hold scored.
    expect(settled.players[1]!.points, "Ahri did not fire, so the pin measures nothing").toBeGreaterThan(1);
    // Ahri's hold effect scores a point; doubled, she scores twice — so the bare
    // hold's 1 plus her 2 is 3. The pin above predicted this exact number.
    expect(settled.players[1]!.points, "the hold doubling stopped reaching another card's effect").toBe(3);
    expect(settled.players[1]!.floatingRainbowPower, "the doubling stopped reaching his own [Add]").toBe(2);
  });
});

describe("Gutter Palace (UNL-088): an alternate win, and a Bird for a discard", () => {
  it("is reported implemented", () => {
    expect(isCardImplemented(registry.get(GUTTER_PALACE))).toBe(true);
  });

  /** Player 0 with the Palace, `hand` cards in hand and `units` units spread over
   *  the two battlefields, in their own Beginning Phase. */
  function palaceBoard(handCount: number, unitCount: number): GameState {
    const state = makeState({ phase: "Beginning", activePlayerIndex: 0 });
    state.players[0]!.activeGear = [gearInPlay(GUTTER_PALACE, "palace")];
    state.players[0]!.hand = Array.from({ length: handCount }, () => spellInstance(TIME_WARP));
    const units = Array.from({ length: unitCount }, (_, i) => makeUnit({ instanceId: `u${i}`, name: `Body ${i}` }));
    state.battlefields[0]!.units = { p1: units.slice(0, 2) };
    state.battlefields[1]!.units = { p1: units.slice(2) };
    return state;
  }

  it("wins at exactly 4 cards in hand and exactly 4 units at battlefields", () => {
    expect(runBeginning(palaceBoard(4, 4)).declaredWinnerIndex).toBe(0);
  });

  it("does NOT win at 5 cards in hand, or at 3 or 5 units — 'exactly' is an equality", () => {
    // Each negative sits beside the positive above, which is what makes it a
    // statement about the count rather than about the trigger never firing.
    expect(runBeginning(palaceBoard(5, 4)).declaredWinnerIndex, "a fifth card still won").toBeNull();
    expect(runBeginning(palaceBoard(3, 4)).declaredWinnerIndex).toBeNull();
    expect(runBeginning(palaceBoard(4, 5)).declaredWinnerIndex, "a fifth unit still won").toBeNull();
    expect(runBeginning(palaceBoard(4, 3)).declaredWinnerIndex).toBeNull();
  });

  it("does not count units in BASE towards the four", () => {
    const state = palaceBoard(4, 3);
    state.players[0]!.baseUnits = [makeUnit({ name: "At Home" })];
    expect(runBeginning(state).declaredWinnerIndex, "'at battlefields' reached base").toBeNull();
  });

  it("does not fire on the OPPONENT's Beginning Phase", () => {
    const state = palaceBoard(4, 4);
    expect(
      runBeginning({ ...state, activePlayerIndex: 1 }).declaredWinnerIndex,
      "the Palace won on someone else's phase",
    ).toBeNull();
  });

  it("ends the game through the real submit path — a Pass returns GameOver", () => {
    // Player 1 passes, so player 0's Beginning Phase runs inside that action and
    // the win is declared before the Cleanup's winner check at the end of it.
    const state = { ...palaceBoard(4, 4), phase: "Action" as const, activePlayerIndex: 1 as const };
    state.players[0]!.deck = [spellInstance(TIME_WARP)];
    state.players[1]!.deck = [spellInstance(TIME_WARP)];

    const { result } = submit(state, { type: "Pass", playerIndex: 1 });

    expect(result).toEqual({ type: "GameOver", winnerId: "p1" });
  });

  it("the same board WITHOUT the Palace does not end the game — the negative control", () => {
    const state = { ...palaceBoard(4, 4), phase: "Action" as const, activePlayerIndex: 1 as const };
    state.players[0]!.activeGear = [];
    state.players[0]!.deck = [spellInstance(TIME_WARP)];
    state.players[1]!.deck = [spellInstance(TIME_WARP)];

    expect(submit(state, { type: "Pass", playerIndex: 1 }).result).toEqual({ type: "Ok" });
  });

  /** The Palace ready, with a hand to pay the discard from, in the Action phase.
   *  DISTINCT cards, because the enumerator de-duplicates discard variants by
   *  defId — two copies of one card are the same discard. */
  function activatableState(handCount = 2): GameState {
    const pool = [TIME_WARP, DEADLY_FLOURISH, SUMPWORKS_MAP];
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.activeGear = [gearInPlay(GUTTER_PALACE, "palace")];
    state.players[0]!.hand = Array.from({ length: handCount }, (_, i) => spellInstance(pool[i % pool.length]!));
    return state;
  }

  it("offers one activation per DISTINCT card it could discard, and NONE with an empty hand", () => {
    const offered = activationsOf(activatableState(2), "palace");
    expect(offered.length, "the ability was never offered").toBe(2);
    for (const a of offered) expect(a.costDiscardCardInstanceId, "no discard was named").toBeDefined();

    expect(activationsOf(activatableState(0), "palace"), "the discard is a cost").toHaveLength(0);
  });

  it("takes the discard, exhausts, and plays a 1-Might Bird with [Deflect]", () => {
    const state = activatableState();
    const discarded = state.players[0]!.hand[0]!.instanceId;
    const activation = activationsOf(state, "palace").find((a) => a.costDiscardCardInstanceId === discarded);
    expect(activation, "no activation named that card").toBeDefined();

    // With no controlled battlefield, "your base" is the ONLY answer to the
    // placement question, and `advanceDecisions` retires a one-option question
    // without ever prompting — so the Bird has already landed here.
    const after = accept(state, activation!);
    expect(after.pendingDecisions, "a one-option question was left for a player to answer").toHaveLength(0);

    const birds = namedUnits(after, 0, "Bird");
    expect(birds, "no Bird arrived").toHaveLength(1);
    expect(birds[0]!.might).toBe(1);
    expect(birds[0]!.keywords.Deflect, "the Bird lost its [Deflect]").toBe(1);
    expect(after.players[0]!.baseUnits.map((u) => u.name)).toContain("Bird");
    expect(after.players[0]!.hand.map((c) => c.instanceId), "the discard was not taken").not.toContain(discarded);
    expect(after.players[0]!.trash.map((c) => c.instanceId)).toContain(discarded);
    expect(after.players[0]!.activeGear[0]!.exhausted, "the exhaust was not paid").toBe(true);
  });

  it("asks where when there is a real choice, and places at the chosen battlefield", () => {
    const state = activatableState();
    state.battlefields[0]!.controllerId = "p1";
    state.battlefields[0]!.units = { p1: [makeUnit({ name: "Anchor" })] };

    const parked = accept(state, activationsOf(state, "palace")[0]!);
    expect(pendingDecision(parked)?.kind, "the placement question was never raised").toBe("UNL-088-place");
    const after = answer(parked, "bf1");

    expect((after.battlefields[0]!.units["p1"] ?? []).map((u) => u.name), "the Bird ignored the chosen battlefield").toContain(
      "Bird",
    );
  });

  it("does not offer a battlefield the OPPONENT controls — it goes to base unasked", () => {
    // The positive control is the test above: with a battlefield of your own the
    // same board raises a two-option question. Here the only legal Location is
    // base, so there is nothing to ask.
    const state = activatableState();
    state.battlefields[0]!.controllerId = "p2";

    const after = accept(state, activationsOf(state, "palace")[0]!);

    expect(after.pendingDecisions, "an enemy battlefield was offered as a destination").toHaveLength(0);
    expect(after.players[0]!.baseUnits.map((u) => u.name)).toContain("Bird");
    expect((after.battlefields[0]!.units["p1"] ?? []), "the Bird landed on the opponent's battlefield").toHaveLength(0);
  });
});
