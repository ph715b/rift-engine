import { describe, expect, it } from "vitest";
import { destroyUnit, withSimultaneousDeaths } from "../src/engine/effect-helpers.js";
import { resolveShowdown } from "../src/engine/combat.js";
import { killGear } from "../src/engine/triggers.js";
import { HOURGLASS_SAVE, ZHONYAS_HOURGLASS } from "../src/engine/death-ward.js";
import { answerDecision, optionsFor, pendingDecision } from "../src/engine/decisions.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, realGearInstance } from "./fixtures.js";

/**
 * **Zhonya's Hourglass and rule 373 — the rules work this exact card and this
 * exact situation.**
 *
 * > **373.** "If more than one event occurs simultaneously that Replacement
 * > Effects could apply to, each event is treated separately and individually for
 * > the purposes of Replacement Effects, and Replacement Effects with the same
 * > controller are applied IN THE ORDER OF THEIR CONTROLLER'S CHOOSING."
 * >
 * > *Example: Two units controlled by the same player die in the same cleanup.
 * > That player also controls Zhonya's Hourglass. They must decide which event to
 * > apply Zhonya's Hourglass to first.*
 *
 * Reported from playtesting: *"i think i should be able to choose which unit gets
 * saved if multiple units die at the same time with the hourglass gear."* The
 * engine spent it on whichever death the kill loop reached first.
 *
 * # The three properties this file holds apart
 *
 * **A LONE death asks nothing.** The card is mandatory ("kill this instead", no
 * "you may"), so with one candidate there is no choice: it is spent on the spot,
 * inside `killUnit`, exactly as it always was. That is why the ~40 existing
 * Hourglass assertions did not move.
 *
 * **SIMULTANEITY is a fact about the CALLER.** Every mass kill in this engine is
 * a loop of single `destroyUnit` calls, so nothing inside the death funnel can
 * tell a board wipe from two unrelated kills. `withSimultaneousDeaths` is the
 * marker, wrapped around the eight sites that produce a batch; a bare loop of
 * `destroyUnit` is still eight separate deaths and still asks nothing, which the
 * negative control below pins.
 *
 * **There is no veto.** 373 hands the controller the ORDER, not a choice about
 * whether to use it — so the question is "which one", with one option per dying
 * unit and no way to decline.
 */

const A_GEAR = ZHONYAS_HOURGLASS;

/** `count` friendly units at bf1, with an Hourglass in play unless told otherwise. */
function board(count: number, withHourglass = true): GameState {
  const state = makeState({ phase: "Action" });
  state.battlefields[0]!.units = {
    p1: Array.from({ length: count }, (_, i) => makeUnit({ instanceId: `u${i}`, name: `Unit ${i}`, might: 1 })),
  };
  if (withHourglass) state.players[0]!.activeGear = [{ ...realGearInstance(A_GEAR), instanceId: "hg" }];
  return state;
}

/** Kills every named unit as ONE simultaneous batch — the shape every mass-kill
 *  site now has: a loop of `destroyUnit` inside `withSimultaneousDeaths`. */
const wipe = (state: GameState, ids: string[]) =>
  withSimultaneousDeaths(state, (inBatch) => ids.reduce((next, id) => destroyUnit(next, id), inBatch));

const onBoard = (state: GameState) => (state.battlefields[0]!.units.p1 ?? []).map((u) => u.instanceId);
const inBase = (state: GameState) => state.players[0]!.baseUnits.map((u) => u.instanceId);
const trashed = (state: GameState) => state.players[0]!.trash.map((c) => c.instanceId);
const hourglassGone = (state: GameState) => !state.players[0]!.activeGear.some((g) => g.defId === A_GEAR);
/** The units a question is offering to save, by name — the option ids are the
 *  dying units' instanceIds. */
const offered = (state: GameState) =>
  optionsFor(state, pendingDecision(state)!)
    .map((o) => o.id)
    .sort();

describe("one death: the Hourglass asks nothing and simply applies", () => {
  it("saves the unit, kills itself, and raises no question", () => {
    const after = destroyUnit(board(1), "u0");

    expect(pendingDecision(after), "a lone death put a question to the player").toBeUndefined();
    expect(inBase(after), "the unit was not recalled to base").toEqual(["u0"]);
    expect(hourglassGone(after), "the Hourglass was not killed to pay for it").toBe(true);
  });

  it("...and with no Hourglass the unit just dies", () => {
    // The control. Without it "the unit is in base" could be any other effect.
    const after = destroyUnit(board(1, false), "u0");
    expect(inBase(after), "a unit was recalled with no Hourglass in play").toEqual([]);
    expect(trashed(after), "it did not reach the trash").toEqual(["u0"]);
  });

  it("asks nothing for a BATCH of one either", () => {
    // A wipe that catches a single unit is not a choice, and a one-option
    // question is retired by `advanceDecisions` without prompting. This is what
    // keeps wrapping the eight mass-kill sites free for every other card.
    const after = wipe(board(1), ["u0"]);
    expect(pendingDecision(after), "a batch of one put a question to the player").toBeUndefined();
    expect(inBase(after), "the unit was not saved").toEqual(["u0"]);
  });
});

describe("373: two simultaneous deaths, and the controller chooses", () => {
  it("ASKS which one to save", () => {
    const after = wipe(board(2), ["u0", "u1"]);

    const pending = pendingDecision(after);
    expect(pending?.kind, "no question was raised for two simultaneous deaths").toBe(HOURGLASS_SAVE);
    expect(pending?.playerIndex, "the wrong player was asked").toBe(0);
    expect(offered(after), "the question did not offer both dying units").toEqual(["u0", "u1"]);
  });

  it("saves the unit the player names", () => {
    const after = wipe(board(2), ["u0", "u1"]);
    const settled = answerDecision(after, pendingDecision(after)!.id, "u0")!;

    expect(inBase(settled), "the chosen unit was not saved").toEqual(["u0"]);
    expect(trashed(settled).sort(), "the other unit did not die, or the gear was not spent").toEqual(["hg", "u1"]);
    expect(onBoard(settled), "a unit was left on the board").toEqual([]);
  });

  it("...and the OTHER answer saves the other one — the choice is real", () => {
    // The control that makes the test above mean something: without it, "u0 was
    // saved" could just be the order the kill loop happened to run in, which is
    // exactly the bug that was reported.
    const after = wipe(board(2), ["u0", "u1"]);
    const settled = answerDecision(after, pendingDecision(after)!.id, "u1")!;

    expect(inBase(settled), "both answers saved the same unit").toEqual(["u1"]);
    expect(trashed(settled), "the unchosen unit did not die").toContain("u0");
  });

  it("offers no way to DECLINE — the card prints no 'you may'", () => {
    // 373 gives the controller the ORDER, not a veto. Every option on the
    // question is a unit to save, so there is no answer that wastes the gear.
    const after = wipe(board(3), ["u0", "u1", "u2"]);
    expect(offered(after), "an option that is not a unit was offered").toEqual(["u0", "u1", "u2"]);
  });

  it("spends only ONCE across the batch — 370.2", () => {
    // "A Replacement Effect can only be applied once to an event." Three deaths
    // and one Hourglass is one save and two real deaths, settled by the single
    // answer rather than by two more questions.
    const after = wipe(board(3), ["u0", "u1", "u2"]);
    const settled = answerDecision(after, pendingDecision(after)!.id, "u1")!;

    expect(pendingDecision(settled), "a second question survived the Hourglass being spent").toBeUndefined();
    expect(inBase(settled), "more than one unit was saved").toEqual(["u1"]);
    expect(trashed(settled).filter((id) => id.startsWith("u")).sort(), "the unsaved units did not die").toEqual([
      "u0",
      "u2",
    ]);
    expect(onBoard(settled), "a unit was left on the board").toEqual([]);
  });

  it("asks nothing at all when there is no Hourglass, however many die", () => {
    const after = wipe(board(3, false), ["u0", "u1", "u2"]);
    expect(pendingDecision(after), "a question was raised with no Hourglass in play").toBeUndefined();
    expect(inBase(after)).toEqual([]);
    expect(trashed(after).sort()).toEqual(["u0", "u1", "u2"]);
  });

  it("does NOT ask for deaths that merely follow one another", () => {
    // The negative control for the whole mechanism, and the reason
    // `withSimultaneousDeaths` exists as a marker rather than being inferred:
    // two unrelated kills are two events, not one, so the FIRST takes the
    // Hourglass on the spot and the second is a real death. Only a caller that
    // says "these are simultaneous" gets the question.
    const after = ["u0", "u1"].reduce((next, id) => destroyUnit(next, id), board(2));

    expect(pendingDecision(after), "sequential deaths raised a 373 question").toBeUndefined();
    expect(inBase(after), "the first death did not take the Hourglass immediately").toEqual(["u0"]);
    expect(trashed(after).sort(), "the second death was replaced too").toEqual(["hg", "u1"]);
  });
});

describe("the batch marker's own contract", () => {
  it("a NESTED batch joins the open one rather than closing it early", () => {
    // No card nests these today — every trigger a death fires is HELD onto the
    // chain rather than resolving inline — so this is asserted directly on the
    // wrapper rather than through a card. It is pinned because closing early is
    // silent and worse than the bug being fixed: the inner batch would ask with
    // half the candidates AND the outer's deaths would be stranded in neither
    // play nor a trash, which is the failure `game-engine.ts` measured at 5 units
    // per 300 games the last time a death was left mid-resolution.
    const nested = withSimultaneousDeaths(board(3), (outer) =>
      withSimultaneousDeaths(destroyUnit(outer, "u0"), (inner) =>
        ["u1", "u2"].reduce((next, id) => destroyUnit(next, id), inner),
      ),
    );

    expect(nested.pendingDecisions, "the nested batch raised a question of its own").toHaveLength(1);
    expect(offered(nested), "the outer batch's death was not in the question").toEqual(["u0", "u1", "u2"]);

    const settled = answerDecision(nested, pendingDecision(nested)!.id, "u0")!;
    expect(inBase(settled), "the chosen unit was not saved").toEqual(["u0"]);
    expect(trashed(settled).sort(), "a death was stranded in neither play nor a trash").toEqual(["hg", "u1", "u2"]);
  });
});

describe("the Hourglass killed by the very batch it would have replaced", () => {
  it("saves nobody, and strands nobody", () => {
    // Reachable, not hypothetical: Bottled Constellation's cost eats friendly
    // UNITS and GEAR in one sweep, so the Hourglass can be fodder for the deaths
    // it was going to replace. The question then has nothing to spend, collapses
    // to a single option, and `advanceDecisions` retires it — the units die, and
    // the point of asserting it is that they must not be left in the pen instead.
    const state = board(2);
    const after = withSimultaneousDeaths(state, (inBatch) => {
      const gear = inBatch.players[0]!.activeGear[0]!;
      return killGear(["u0", "u1"].reduce((next, id) => destroyUnit(next, id), inBatch), gear, 0);
    });

    expect(pendingDecision(after), "a question about a gear that is gone was left standing").toBeUndefined();
    expect(after.unitsAwaitingDeathReplacement, "a death was stranded in the pen").toEqual([]);
    expect(inBase(after), "a unit was saved by an Hourglass that had already died").toEqual([]);
    expect(trashed(after).sort(), "the units did not reach the trash").toEqual(["hg", "u0", "u1"]);
  });
});

describe("the site 373 actually names: a Showdown's damage step", () => {
  /** A battlefield where p2 attacks with enough Might to kill both defenders. */
  function showdown(withHourglass = true): GameState {
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = {
      p1: [makeUnit({ instanceId: "u0", name: "Unit 0", might: 1 }), makeUnit({ instanceId: "u1", name: "Unit 1", might: 1 })],
      p2: [makeUnit({ instanceId: "attacker", name: "Attacker", might: 4 })],
    };
    if (withHourglass) state.players[0]!.activeGear = [{ ...realGearInstance(A_GEAR), instanceId: "hg" }];
    return state;
  }

  it("asks after combat damage kills two defenders at once", () => {
    // Combat damage is dealt SIMULTANEOUSLY (466), which is the situation 373's
    // worked example is about — and the one a real game reaches. The wrap sits
    // around BOTH `processDefeated` calls rather than inside one, so a mutual
    // wipe is one batch and not two.
    const settled = resolveShowdown(showdown(), "bf1", 1);

    const pending = pendingDecision(settled);
    expect(pending?.kind, "a Showdown that killed two defenders asked nothing").toBe(HOURGLASS_SAVE);
    expect(offered(settled), "the question did not offer both defenders").toEqual(["u0", "u1"]);
  });

  it("...and with no Hourglass both simply die", () => {
    // The control: without it, "a question was raised" above could be any other
    // combat question, and "both died" here could be the Hourglass failing.
    const settled = resolveShowdown(showdown(false), "bf1", 1);
    expect(pendingDecision(settled), "a question was raised with no Hourglass in play").toBeUndefined();
    expect(trashed(settled).sort(), "the defenders did not both die").toEqual(["u0", "u1"]);
  });

  it("saves the defender the player names, and the other dies", () => {
    const settled = resolveShowdown(showdown(), "bf1", 1);
    const answered = answerDecision(settled, pendingDecision(settled)!.id, "u1")!;

    expect(inBase(answered), "the chosen defender was not recalled").toEqual(["u1"]);
    expect(trashed(answered).sort(), "the other defender lived, or the gear was not spent").toEqual(["hg", "u0"]);
  });
});

describe("373 across BOTH players, and the deaths nobody chose", () => {
  it("asks each controller separately, turn player first", () => {
    // 373 scopes the choice to "Replacement Effects with the same controller",
    // so two players each losing units to one wipe get one question each — and
    // the turn player answers first, the same reading 383.3.d.1 gets for
    // simultaneous triggers.
    const state = board(2);
    state.players[1]!.activeGear = [{ ...realGearInstance(A_GEAR), instanceId: "hg2" }];
    state.battlefields[0]!.units.p2 = [
      makeUnit({ instanceId: "e0", name: "Enemy 0", might: 1 }),
      makeUnit({ instanceId: "e1", name: "Enemy 1", might: 1 }),
    ];

    const after = wipe(state, ["u0", "u1", "e0", "e1"]);
    expect(after.pendingDecisions.map((d) => d.playerIndex), "both players were not asked, in turn order").toEqual([
      0, 1,
    ]);
    expect(after.activePlayerIndex, "the fixture is not on p0's turn — the assertion above means nothing").toBe(0);
    expect(offered(after), "one player's question reached the other's units").toEqual(["u0", "u1"]);
  });

  it("settles the OTHER player's forced save behind the first player's choice", () => {
    // The asymmetric case, and the one where the queue and the auto-resolver
    // meet: p0 has a real choice (two dying units) and p1 has none (one), so p1's
    // question is a single option sitting BEHIND p0's. `advanceDecisions` only
    // ever drains the FRONT, so p1's cannot retire until p0 has answered — and it
    // must retire then, rather than waiting for an answer nobody will give.
    const state = board(2);
    state.players[1]!.activeGear = [{ ...realGearInstance(A_GEAR), instanceId: "hg2" }];
    state.battlefields[0]!.units.p2 = [makeUnit({ instanceId: "e0", name: "Enemy 0", might: 1 })];

    const after = wipe(state, ["u0", "u1", "e0"]);
    expect(after.pendingDecisions, "p1's forced save was retired before p0 answered").toHaveLength(2);

    const settled = answerDecision(after, pendingDecision(after)!.id, "u1")!;
    expect(pendingDecision(settled), "p1 was asked a question with a single answer").toBeUndefined();
    expect(inBase(settled), "p0's chosen unit was not saved").toEqual(["u1"]);
    expect(settled.players[1]!.baseUnits.map((u) => u.instanceId), "p1's unit was not saved").toEqual(["e0"]);
    expect(settled.players[1]!.trash.map((c) => c.instanceId), "p1's Hourglass was not spent").toEqual(["hg2"]);
  });

  it("does not let one player's Hourglass save the other's unit", () => {
    // "a FRIENDLY unit". The enemy pair dies with no Hourglass of their own, and
    // p0's question never lists them.
    const state = board(2);
    state.battlefields[0]!.units.p2 = [makeUnit({ instanceId: "e0", name: "Enemy 0", might: 1 })];

    const after = wipe(state, ["u0", "u1", "e0"]);
    expect(offered(after), "an enemy unit was offered to the Hourglass' controller").toEqual(["u0", "u1"]);
    expect(after.players[1]!.trash.map((c) => c.instanceId), "the enemy unit did not simply die").toEqual(["e0"]);
  });
});
