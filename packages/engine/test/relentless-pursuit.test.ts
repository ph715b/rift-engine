import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { executePlayCard } from "../src/actions/execute-play-card.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { recordConquest } from "../src/engine/scoring.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
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

describe("Relentless Pursuit: coverage", () => {
  it("reports as implemented", () => {
    expect(isCardImplemented(registry.get(RELENTLESS_PURSUIT))).toBe(true);
  });
});
