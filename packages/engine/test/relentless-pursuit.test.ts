import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { submit } from "../src/engine/game-engine.js";
import { recordConquest } from "../src/engine/scoring.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { optionsFor, pendingDecision, promptFor } from "../src/engine/decisions.js";
import { triggerKeysOn } from "../src/engine/triggers.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { Domain } from "../src/model/domain.js";
import type { RuneCard } from "../src/model/rune.js";
import {
  answerDecisions,
  makePlayer,
  makeState,
  makeUnit,
  realGearInstance,
  resolveHeldTriggers,
  spellInstance,
} from "./fixtures.js";

/**
 * Relentless Pursuit (SFD-184) — "[Action] Move a friendly unit. You may attach
 * an Equipment with the same controller to it. This turn, that unit has 'When I
 * conquer, you may move me to my base.'"
 *
 * Three instructions and one of them is a first for this engine.
 *
 * # The grant
 *
 * Nothing here has ever given a unit a TRIGGERED ABILITY. `keywordsThisTurn` was
 * the nearest shape and it holds keywords; what this needed was one sibling field
 * holding a REGISTRY KEY, so the granted ability is written in the very table a
 * printed one is and is placed, ordered and resolved by the same walk. The tests
 * below therefore check the grant at three points — it lands, it FIRES, and it
 * EXPIRES — because a this-turn grant that never expires is invisible in a single
 * turn and wrong in every later one.
 *
 * # The optional attach
 *
 * `unitAndEquipment` gained `optionalEquipment` and `owner` for this card. The
 * load-bearing negatives are that declining stays legal WITH a legal Equipment on
 * the board, and that an Equipment-less board leaves the card castable — Angle
 * Shot, the spec's only other user, is uncastable in exactly that state and must
 * stay so.
 */

const registry = defaultCardRegistry();
const RELENTLESS_PURSUIT = "SFD-184";
const LONG_SWORD = "SFD-022"; // a plain Equipment, no ability of its own
/** The registry key the spell grants. Spelled out here rather than imported: the
 *  card names it and this test names it, and if the two ever disagree the grant
 *  silently points at nothing — which is the failure the constant exists for. */
const GRANT_KEY = "SFD-184-conquer-home";

const runes = (domain: Domain, n: number): RuneCard[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${domain}-${i}`, domain, state: "Ready" as const }));

/**
 * p1 holds Relentless Pursuit, has a unit in base, and can pay (2 Energy + 1
 * Fury Power). `equipment` puts a detached Long Sword in their `activeGear`.
 */
function board(opts: { equipment?: boolean } = {}): { state: GameState; spellId: string; unitId: string } {
  const spell = spellInstance(RELENTLESS_PURSUIT);
  const runner = makeUnit({ instanceId: "runner", name: "Runner" });
  const state = makeState({
    phase: "Action",
    players: [
      makePlayer("p1", { hand: [spell], channeled: runes("Fury", 6), baseUnits: [runner] }),
      makePlayer("p2"),
    ],
  });
  if (opts.equipment) {
    state.players[0]!.activeGear = [{ ...realGearInstance(LONG_SWORD), instanceId: "sword", attachedToInstanceId: null }];
  }
  return { state, spellId: spell.instanceId, unitId: runner.instanceId };
}

const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

/** Casts the variant matching `pick`, through the enumerator. */
function cast(state: GameState, spellId: string, pick: (p: PlayCardAction) => boolean): GameState {
  const play = playsOf(state, spellId).find(pick);
  expect(play, "no matching variant was offered").toBeDefined();
  return resolveHeldTriggers(executePlayCard(state, play!));
}

const unitAt = (state: GameState, bfIndex: number, id = "runner") =>
  (state.battlefields[bfIndex]!.units[state.players[0]!.id] ?? []).find((u) => u.instanceId === id);

describe("Relentless Pursuit: the move", () => {
  it("moves the friendly unit to the chosen battlefield", () => {
    const { state, spellId } = board();
    const after = cast(state, spellId, (p) => p.destinationBattlefieldId === "bf2");
    expect(unitAt(after, 1), "the unit did not arrive").toBeDefined();
    expect(after.players[0]!.baseUnits).toHaveLength(0);
  });

  it("offers every battlefield as a destination", () => {
    const { state, spellId } = board();
    const destinations = new Set(playsOf(state, spellId).map((p) => p.destinationBattlefieldId));
    expect(destinations).toEqual(new Set(["bf1", "bf2"]));
  });

  it("targets only FRIENDLY units — the owner constraint the spec gained", () => {
    const { state, spellId } = board();
    const theirs = makeUnit({ instanceId: "theirs", name: "Theirs" });
    state.players[1]!.baseUnits = [theirs];
    const targets = new Set(playsOf(state, spellId).map((p) => p.targetUnitInstanceId));
    expect(targets).toContain("runner");
    expect(targets, "an enemy unit was offered to a card that says 'a friendly unit'").not.toContain("theirs");
  });
});

describe("Relentless Pursuit: the optional attach", () => {
  it("attaches the named Equipment", () => {
    const { state, spellId } = board({ equipment: true });
    const after = cast(state, spellId, (p) => p.targetPermanentInstanceId === "sword");
    expect(after.players[0]!.activeGear[0]!.attachedToInstanceId).toBe("runner");
  });

  it("offers a DECLINE variant even with a legal Equipment on the board", () => {
    // "You may" has to stay refusable — the rule the optional additional costs
    // keep. Without the decline variant the card would be a mandatory attach.
    const { state, spellId } = board({ equipment: true });
    const declines = playsOf(state, spellId).filter((p) => p.targetPermanentInstanceId === undefined);
    expect(declines.length, "declining the attach was not offered").toBeGreaterThan(0);
  });

  it("attaches nothing on the decline variant", () => {
    const { state, spellId } = board({ equipment: true });
    const after = cast(state, spellId, (p) => p.targetPermanentInstanceId === undefined);
    expect(after.players[0]!.activeGear[0]!.attachedToInstanceId).toBeNull();
    // And the rest of the card still happened.
    expect(unitAt(after, 0) ?? unitAt(after, 1), "the move was skipped along with the attach").toBeDefined();
  });

  it("is castable with NO Equipment in play at all", () => {
    // The negative that separates `optionalEquipment` from Angle Shot's spec,
    // where both halves are required and an Equipment-less board makes the card
    // uncastable (355.8).
    const { state, spellId } = board();
    expect(playsOf(state, spellId).length, "the card went uncastable without an Equipment").toBeGreaterThan(0);
  });

  it("the validator accepts every variant the enumerator offers", () => {
    const { state, spellId } = board({ equipment: true });
    const plays = playsOf(state, spellId);
    expect(plays.length).toBeGreaterThan(1);
    for (const play of plays) {
      const result = validatePlayCard(state, play);
      expect(result.ok, result.ok ? "" : result.error).toBe(true);
    }
  });
});

describe("Relentless Pursuit: the granted 'when I conquer'", () => {
  it("lands on the moved unit as a registry key", () => {
    const { state, spellId } = board();
    const after = cast(state, spellId, (p) => p.destinationBattlefieldId === "bf1");
    expect(unitAt(after, 0)!.grantedTriggersThisTurn).toEqual([GRANT_KEY]);
    expect(triggerKeysOn(unitAt(after, 0)!)).toContain(GRANT_KEY);
  });

  it("goes to the unit that was MOVED, not to every friendly unit", () => {
    const { state, spellId } = board();
    const bystander = makeUnit({ instanceId: "bystander", name: "Bystander" });
    state.players[0]!.baseUnits = [...state.players[0]!.baseUnits, bystander];
    const after = cast(state, spellId, (p) => p.targetUnitInstanceId === "runner");
    expect(after.players[0]!.baseUnits.find((u) => u.instanceId === "bystander")!.grantedTriggersThisTurn).toBeUndefined();
  });

  it("FIRES on a conquest at the unit's battlefield", () => {
    const { state, spellId } = board();
    const moved = cast(state, spellId, (p) => p.destinationBattlefieldId === "bf1");
    const conquered = resolveHeldTriggers(recordConquest(moved, 0, "bf1"));
    const decision = pendingDecision(conquered);
    expect(decision?.kind, "the granted ability did not reach the chain").toBe("SFD-184-home");
    expect(optionsFor(conquered, decision!).map((o) => o.id)).toEqual(["decline", "home"]);
  });

  it("moves the unit home when the answer is yes", () => {
    const { state, spellId } = board();
    const moved = cast(state, spellId, (p) => p.destinationBattlefieldId === "bf1");
    const conquered = resolveHeldTriggers(recordConquest(moved, 0, "bf1"));
    const home = answerDecisions(conquered, (options) => options.find((o) => o.id === "home")!.id);
    expect(home.players[0]!.baseUnits.map((u) => u.instanceId)).toContain("runner");
    expect(unitAt(home, 0)).toBeUndefined();
  });

  it("leaves it standing when the answer is no — declining is a real choice here", () => {
    // Unlike most "you may" in this pool, taking it can be WRONG: leaving means
    // giving up the battlefield you just conquered.
    const { state, spellId } = board();
    const moved = cast(state, spellId, (p) => p.destinationBattlefieldId === "bf1");
    const conquered = resolveHeldTriggers(recordConquest(moved, 0, "bf1"));
    const stayed = answerDecisions(conquered, (options) => options.find((o) => o.id === "decline")!.id);
    expect(unitAt(stayed, 0), "declining sent it home anyway").toBeDefined();
  });

  it("is POSITIONAL — a conquest somewhere else does not fire it", () => {
    const { state, spellId } = board();
    const moved = cast(state, spellId, (p) => p.destinationBattlefieldId === "bf1");
    const elsewhere = resolveHeldTriggers(recordConquest(moved, 0, "bf2"));
    expect(pendingDecision(elsewhere), "it fired for a battlefield the unit was not at").toBeUndefined();
  });

  it("does not fire when the OPPONENT conquers there", () => {
    const { state, spellId } = board();
    const moved = cast(state, spellId, (p) => p.destinationBattlefieldId === "bf1");
    const theirs = resolveHeldTriggers(recordConquest(moved, 1, "bf1"));
    expect(pendingDecision(theirs)).toBeUndefined();
  });

  it("does not fire for a unit that never had the grant", () => {
    // The control. Same board, same conquest, no spell cast.
    const { state } = board();
    const withUnit = { ...state };
    withUnit.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "plain", name: "Plain" })] };
    expect(pendingDecision(resolveHeldTriggers(recordConquest(withUnit, 0, "bf1")))).toBeUndefined();
  });

  it("EXPIRES with the turn", () => {
    // "THIS TURN". A grant that outlives its turn is invisible on the turn it was
    // made and wrong on every turn after — which is why the sweep is asserted
    // rather than assumed. `runEnd` runs from the Action phase, not the End phase.
    const { state, spellId } = board();
    const moved = cast(state, spellId, (p) => p.destinationBattlefieldId === "bf1");
    const nextTurn = runEnd(moved);
    expect(unitAt(nextTurn, 0)!.grantedTriggersThisTurn).toBeUndefined();
    expect(pendingDecision(resolveHeldTriggers(recordConquest(nextTurn, 0, "bf1")))).toBeUndefined();
  });
});

/**
 * The whole card driven the way a player drives it: `submit`, and nothing else.
 *
 * Reported from play as *"unit didn't move to base after relentless pursuit"*.
 * The block above already proved the grant lands, fires and moves the unit — and
 * it kept proving it while the card was unusable, because it calls `recordConquest`
 * and `answerDecisions` directly. What it could not see is the two hops a real game
 * adds: the conquest arriving out of a Cleanup-staged Showdown, and the question
 * being ANSWERED FROM ITS OPTIONS rather than by id.
 *
 * `board()` above puts the unit in p1's base and leaves both battlefields
 * uncontrolled, so casting to bf1 is a walk-in: Contested, staged Showdown,
 * uncontested close, Establish Control, Conquer. Six focus passes end to end.
 */
describe("Relentless Pursuit: through submit, the way it is played", () => {
  /** p2 holds bf1 with nobody standing there, so p1 walking in conquers it. */
  function walkInBoard(): { state: GameState; spellId: string } {
    const { state, spellId } = board();
    state.battlefields[0] = { ...state.battlefields[0]!, controllerId: "p2" };
    return { state, spellId };
  }

  /** Passes Focus through `submit` until the engine stops to ask something.
   *  Every refusal is surfaced — a silent `Invalid` here would leave the loop
   *  spinning on an unchanged state and report "no question was asked". */
  function passUntilAsked(start: GameState): { state: GameState; sawGrantOnChain: boolean } {
    let state = start;
    let sawGrantOnChain = false;
    for (let guard = 0; guard < 24; guard += 1) {
      sawGrantOnChain ||= state.spellChain.some((e) => "listenerDefId" in e && e.listenerDefId === GRANT_KEY);
      if (state.pendingDecisions.length > 0) return { state, sawGrantOnChain };
      const pass = legalActions(state).find((a) => a.type === "PassFocus");
      if (!pass) return { state, sawGrantOnChain };
      const next = submit(state, pass);
      expect(next.result.type, next.result.type === "Invalid" ? next.result.error : "").toBe("Ok");
      state = next.state;
    }
    throw new Error("passUntilAsked: the game never stopped to ask");
  }

  it("conquers on the walk-in and asks, with the grant's own key on the chain", () => {
    const { state, spellId } = walkInBoard();
    const play = playsOf(state, spellId).find((p) => p.destinationBattlefieldId === "bf1");
    expect(play, "no play offered").toBeDefined();
    const cast = submit(state, play!);
    expect(cast.result.type).toBe("Ok");

    const { state: asked, sawGrantOnChain } = passUntilAsked(cast.state);
    // The positive control this file was missing: "did not move" reads identically
    // for "the ability never fired" and "it fired and did nothing".
    expect(sawGrantOnChain, "the granted ability never reached the chain as a Pending Item").toBe(true);
    expect(asked.players[0]!.points, "the walk-in did not score, so nothing conquered").toBe(1);
    expect(pendingDecision(asked)?.kind).toBe("SFD-184-home");
  });

  it("offers the affirmative answer AS A LABEL — the reported bug", () => {
    // `DecisionPrompt` renders any option carrying a findable `instanceId` as that
    // card's ART and DROPS its label, keeping a button only for the options
    // without one. The `home` option used to carry the moved unit's id, so the
    // player was asked "move that unit to your base?" over a picture of the unit
    // and ONE button reading "Stay" — the affirmative answer had no visible text
    // anywhere on screen. See the decision's own note in effects/signature.ts.
    const { state, spellId } = walkInBoard();
    const { state: asked } = passUntilAsked(submit(state, playsOf(state, spellId).find((p) => p.destinationBattlefieldId === "bf1")!).state);
    const decision = pendingDecision(asked);
    expect(decision).toBeDefined();
    const options = optionsFor(asked, decision!);
    expect(options.map((o) => o.label)).toEqual(["Stay", "Move to base"]);
    // The unit is identified where the board actually shows it — the prompt is the
    // overlay's title, and once the option carries no art it is the only text left
    // that can say WHICH unit. Asserted BEFORE the loop below so both halves of
    // the fix are separately proved red rather than one masking the other.
    expect(promptFor(asked, decision!)).toContain("Runner");
    for (const option of options) {
      expect(option.instanceId, `"${option.label}" would render as bare card art with its label thrown away`).toBeUndefined();
    }
  });

  it("moves the unit home when that answer is submitted", () => {
    const { state, spellId } = walkInBoard();
    const { state: asked } = passUntilAsked(submit(state, playsOf(state, spellId).find((p) => p.destinationBattlefieldId === "bf1")!).state);
    const decision = pendingDecision(asked)!;
    const home = optionsFor(asked, decision).find((o) => o.label === "Move to base");
    expect(home, "no affirmative answer was on offer").toBeDefined();
    const answered = submit(asked, {
      type: "AnswerDecision",
      playerIndex: 0,
      decisionId: decision.id,
      optionId: home!.id,
    });
    expect(answered.result.type).toBe("Ok");
    expect(answered.state.players[0]!.baseUnits.map((u) => u.instanceId), "it stayed at the battlefield").toContain("runner");
    expect(unitAt(answered.state, 0), "it is in two places at once").toBeUndefined();
  });

  /**
   * PINNED DIVERGENCE — this asserts the WRONG answer on purpose.
   *
   * The granted ability reads "When I conquer, you may move me to my base." The
   * "you may" is the FIRST part of its effect, which rule 383.3.a places at
   * FINALIZATION: "the controller of its source will choose whether or not to
   * perform the Triggered Ability during finalization." 383.3.a.2 then says that
   * declining "is removed from the chain and considered to have not triggered" —
   * so under the rules a declined trigger never sits on the Chain at all.
   *
   * This engine asks at RESOLUTION, via `parkDecision`, for every "you may" on a
   * triggered ability. 383.3.a.3 is the contrast that makes the split real: a
   * "you may" in ANY LATER part of an effect IS decided on resolution (Ornn,
   * Blacksmith is the rules' own example), so the engine's behaviour is correct
   * for one family and wrong for the other, and it does not distinguish them.
   *
   * OBSERVABLE, which is why this can be pinned at all: the question arrives
   * after Focus has passed, meaning the opponent has already seen and been able
   * to respond to an ability its controller had not yet agreed to perform. Under
   * 383.3.a they would answer first.
   *
   * Recorded in docs/rules-conformance.md. Closing it should flip this test, not
   * delete it — which is the entire reason it asserts the wrong number.
   */
  it("asks at RESOLUTION, not at finalization — divergent from 383.3.a", () => {
    const { state, spellId } = walkInBoard();
    let live = submit(state, playsOf(state, spellId).find((p) => p.destinationBattlefieldId === "bf1")!).state;

    let passes = 0;
    for (let guard = 0; guard < 24 && live.pendingDecisions.length === 0; guard += 1) {
      const pass = legalActions(live).find((a) => a.type === "PassFocus");
      if (!pass) break;
      live = submit(live, pass).state;
      passes += 1;
    }

    expect(pendingDecision(live)?.kind, "the fixture never reached the question").toBe("SFD-184-home");
    // > 0 IS the divergence. Under 383.3.a this is 0: the choice is part of
    // putting the ability on the Chain, before anyone passes anything.
    expect(passes, "383.3.a would have asked before any Focus passed").toBeGreaterThan(0);
  });
});

describe("Relentless Pursuit: coverage", () => {
  it("reports as implemented", () => {
    expect(isCardImplemented(registry.get(RELENTLESS_PURSUIT))).toBe(true);
  });
});
