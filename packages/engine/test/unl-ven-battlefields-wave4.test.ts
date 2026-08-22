import { describe, expect, it } from "vitest";
import { runCleanup } from "../src/engine/cleanup.js";
import { loadBattlefieldDefinitions } from "../src/cards/card-loader.js";
import { optionsFor, pendingDecision, answerDecision } from "../src/engine/decisions.js";
import { holdBattlefieldTrigger } from "../src/engine/battlefield-abilities.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";

/**
 * **UNL/VEN battlefields, wave 4 — a NEW moment, and one on an existing one.**
 *
 *   UNL-215 Star Spring          — the FIRST time a player plays a non-token unit
 *                                  here each turn, they may move another unit they
 *                                  control here to its base
 *   UNL-218 Valley of Idols      — when a player plays a unit here, they may pay
 *                                  [1 Energy] to [Buff] it
 *   VEN-166 Threshold of the Gray — when combat starts here, the attacker and
 *                                  defender each [Add] [1 Energy]
 *
 * Star Spring is the card the playtest report named. Both it and Valley of Idols
 * need a moment this module did not have — `unitPlayedHere`, fired by
 * `execute-play-card`'s reinforce branch AFTER the unit is on the board and its
 * own on-play trigger is dispatched.
 *
 * **PLAYED, not "became present".** A unit that MOVES here, is forced here, or
 * arrives by a Recall has not been played — the same distinction Rockfall Path's
 * note already draws, and both cards say "plays".
 *
 * Threshold of the Gray rides the existing `defend` moment, which
 * `cleanup.beginCombatAt` raises once per combat. It is the only entry in the
 * table that pays BOTH seats: the ability is the battlefield's, not a player's.
 */

const STAR_SPRING = "UNL-215";
const VALLEY_OF_IDOLS = "UNL-218";
const THRESHOLD_OF_THE_GRAY = "VEN-166";

/** bf1 IS the named battlefield with `units` there for p1. */
function board(defId: string, units: UnitInstance[] = [], enemies: UnitInstance[] = []): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.battlefields[0] = { ...state.battlefields[0]!, defId, units: { p1: units, p2: enemies } };
  return state;
}

/**
 * Fires the moment DIRECTLY.
 *
 * `execute-play-card`'s reinforce branch is what raises it in a real game, and
 * driving a full play through the engine here would make every assertion depend
 * on a payable board and a legal destination as well as on the battlefield. The
 * WIRING is asserted separately, once, at the bottom of this file — which is the
 * half that would silently rot.
 */
const played = (state: GameState, unitInstanceId: string, playerIndex: 0 | 1 = 0) =>
  holdBattlefieldTrigger(state, "unitPlayedHere", "bf1", playerIndex, unitInstanceId);

describe("every name in this wave is a battlefield that really prints that text", () => {
  it("matches the printed cards", () => {
    const byId = new Map(loadBattlefieldDefinitions().map((d) => [d.id, d]));
    for (const [defId, name, phrase] of [
      [STAR_SPRING, "Star Spring", "first time a player plays a non-token unit here"],
      [VALLEY_OF_IDOLS, "Valley of Idols", "When a player plays a unit here"],
      [THRESHOLD_OF_THE_GRAY, "Threshold of the Gray", "When combat starts here"],
    ] as const) {
      const def = byId.get(defId);
      expect(def?.name, `${defId} is not the card this wave thinks it is`).toBe(name);
      expect(def?.text, `${name}'s text has changed under the implementation`).toContain(phrase);
    }
  });
});

describe("Star Spring (UNL-215): the reported card", () => {
  const newcomer = () => makeUnit({ instanceId: "new", name: "Newcomer", might: 3 });
  const other = () => makeUnit({ instanceId: "other", name: "Other", might: 2 });

  it("offers to move ANOTHER unit you control here — not the one just played", () => {
    const held = resolveHeldTriggers(played(board(STAR_SPRING, [newcomer(), other()]), "new"));
    const pending = pendingDecision(held);
    expect(pending?.kind, "the reported card still raised nothing").toBe(`${STAR_SPRING}-move`);
    expect(optionsFor(held, pending!).map((o) => o.id).sort(), "it offered the unit just played").toEqual([
      "decline",
      "other",
    ]);
  });

  it("moves the chosen unit to base, exhausted", () => {
    const held = resolveHeldTriggers(played(board(STAR_SPRING, [newcomer(), other()]), "new"));
    const settled = answerDecision(held, pendingDecision(held)!.id, "other")!;
    expect((settled.battlefields[0]!.units.p1 ?? []).map((u) => u.instanceId), "it did not leave").toEqual(["new"]);
    expect(settled.players[0]!.baseUnits.find((u) => u.instanceId === "other")?.exhausted, "treated as a Recall").toBe(true);
  });

  it("asks nothing for a TOKEN — 'a non-token unit'", () => {
    const token = { ...makeUnit({ instanceId: "tok", name: "Recruit", might: 1 }), isToken: true };
    const held = resolveHeldTriggers(played(board(STAR_SPRING, [token, other()]), "tok"));
    expect(pendingDecision(held), "a token play triggered it").toBeUndefined();
  });

  it("places NO PENDING ITEM with no other unit of yours here", () => {
    // **Asserted on the Pending Item, not on the question.** `options` filters the
    // just-played unit out too, so a version whose `applies` said "any unit here"
    // would still show no question — `advanceDecisions` drops one with no options
    // — and the mutant survived until this looked here. What `applies` buys is
    // that nothing reaches the chain at all: a held trigger closes the chain and
    // costs both players a PassFocus even when it resolves to nothing.
    const raised = played(board(STAR_SPRING, [newcomer()]), "new");
    expect(
      raised.pendingTriggers.filter((e) => e.source === "battlefield"),
      "a Pending Item was placed with nothing to move",
    ).toHaveLength(0);
    expect(pendingDecision(resolveHeldTriggers(raised)), "it asked with nothing to move").toBeUndefined();
  });

  it("...and DOES place one when there is — the control", () => {
    expect(
      played(board(STAR_SPRING, [newcomer(), other()]), "new").pendingTriggers.filter((e) => e.source === "battlefield"),
      "nothing was held at all, so the test above proves nothing",
    ).toHaveLength(1);
  });

  it("fires only the FIRST time each turn — and declining still spends it", () => {
    // "The first TIME a player plays" is about the play, not the move: declining
    // must still spend the turn's offer, or a player could decline twice and take
    // the third.
    const first = resolveHeldTriggers(played(board(STAR_SPRING, [newcomer(), other()]), "new"));
    const declined = answerDecision(first, pendingDecision(first)!.id, "decline")!;

    const second = resolveHeldTriggers(played(declined, "other"));
    expect(pendingDecision(second), "it fired a second time in one turn").toBeUndefined();
  });

  it("is per PLAYER — the opponent still gets their own offer", () => {
    // "A player ... THEY may move" — the limit is per player, which is why the
    // record lives on PlayerState rather than on the battlefield.
    const state = board(STAR_SPRING, [newcomer(), other()], [
      makeUnit({ instanceId: "e1", name: "E1", might: 2 }),
      makeUnit({ instanceId: "e2", name: "E2", might: 2 }),
    ]);
    const first = resolveHeldTriggers(played(state, "new"));
    const mine = answerDecision(first, pendingDecision(first)!.id, "decline")!;
    const theirs = resolveHeldTriggers(played(mine, "e1", 1));
    expect(pendingDecision(theirs)?.kind, "the opponent inherited my spent offer").toBe(`${STAR_SPRING}-move`);
  });
});

describe("Valley of Idols (UNL-218): pay 1 to buff the unit you played", () => {
  const newcomer = () => makeUnit({ instanceId: "new", name: "Newcomer", might: 3 });

  function payable(state: GameState): GameState {
    state.players[0]!.channeled = [{ id: "r1", domain: "Calm", state: "Ready" }];
    return state;
  }

  it("buffs the unit that was played", () => {
    const held = resolveHeldTriggers(played(payable(board(VALLEY_OF_IDOLS, [newcomer()])), "new"));
    const settled = answerDecision(held, pendingDecision(held)!.id, "pay")!;
    expect((settled.battlefields[0]!.units.p1 ?? [])[0]!.buffed, "it was not buffed").toBe(true);
  });

  it("places NO PENDING ITEM when the Energy cannot be paid — 416.3", () => {
    // Same reason as Star Spring's above: `options` re-checks payability, so the
    // question disappears either way and only the Pending Item distinguishes an
    // `applies` that works from one that does not.
    const raised = played(board(VALLEY_OF_IDOLS, [newcomer()]), "new");
    expect(
      raised.pendingTriggers.filter((e) => e.source === "battlefield"),
      "a Pending Item was placed with nothing to pay with",
    ).toHaveLength(0);
    expect(pendingDecision(resolveHeldTriggers(raised)), "asked with nothing to pay with").toBeUndefined();
  });

  it("...and DOES place one when the Energy is there — the control", () => {
    expect(
      played(payable(board(VALLEY_OF_IDOLS, [newcomer()])), "new").pendingTriggers.filter((e) => e.source === "battlefield"),
      "nothing was held even with Energy available",
    ).toHaveLength(1);
  });

  it("declining costs nothing", () => {
    const held = resolveHeldTriggers(played(payable(board(VALLEY_OF_IDOLS, [newcomer()])), "new"));
    const settled = answerDecision(held, pendingDecision(held)!.id, "decline")!;
    expect((settled.battlefields[0]!.units.p1 ?? [])[0]!.buffed ?? false, "declining buffed anyway").toBe(false);
    expect(settled.players[0]!.channeled.filter((r) => r.state === "Ready"), "declining paid anyway").toHaveLength(1);
  });

  it("fires for a TOKEN too — unlike Star Spring, it prints no such clause", () => {
    const token = { ...makeUnit({ instanceId: "tok", name: "Recruit", might: 1 }), isToken: true };
    const held = resolveHeldTriggers(played(payable(board(VALLEY_OF_IDOLS, [token])), "tok"));
    expect(pendingDecision(held)?.kind, "a token play was skipped").toBe(`${VALLEY_OF_IDOLS}-buff`);
  });

  it("fires EVERY time, not once a turn", () => {
    const state = payable(board(VALLEY_OF_IDOLS, [newcomer()]));
    state.players[0]!.channeled = [
      { id: "r1", domain: "Calm", state: "Ready" },
      { id: "r2", domain: "Calm", state: "Ready" },
    ];
    const first = resolveHeldTriggers(played(state, "new"));
    const settled = answerDecision(first, pendingDecision(first)!.id, "decline")!;
    expect(pendingDecision(resolveHeldTriggers(played(settled, "new")))?.kind, "it was once-per-turn").toBe(
      `${VALLEY_OF_IDOLS}-buff`,
    );
  });
});

describe("Threshold of the Gray (VEN-166): both sides [Add] 1 when combat starts", () => {
  it("gives floating Energy to the attacker AND the defender", () => {
    // p0 contests bf1 where p1 stands, so the Cleanup stages a Combat and raises
    // the `defend` moment for p1.
    const state = makeState({ phase: "Action" });
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      defId: THRESHOLD_OF_THE_GRAY,
      controllerId: "p2",
      contestedByIndex: 0,
      units: { p1: [makeUnit({ instanceId: "a", name: "Attacker", might: 3 })], p2: [makeUnit({ instanceId: "d", name: "Defender", might: 3 })] },
    };

    const settled = resolveHeldTriggers(runCleanup(state));
    expect(settled.players[0]!.floatingEnergy, "the attacker was not paid").toBe(1);
    expect(settled.players[1]!.floatingEnergy, "the defender was not paid").toBe(1);
  });

  it("does not fire without a combat", () => {
    const quiet = board(THRESHOLD_OF_THE_GRAY, [makeUnit({ instanceId: "a", name: "A", might: 3 })]);
    const settled = resolveHeldTriggers(runCleanup(quiet));
    expect(settled.players[0]!.floatingEnergy, "it paid out with no combat").toBe(0);
    expect(settled.players[1]!.floatingEnergy, "it paid out with no combat").toBe(0);
  });
});

describe("the `unitPlayedHere` moment is actually WIRED", () => {
  it("is fired by execute-play-card, not only by this test's helper", () => {
    // **The half that rots silently.** Every test above raises the moment
    // directly, so all of them would keep passing if `execute-play-card` stopped
    // firing it and both cards became unreachable in a real game — the "correct,
    // tested, and inert" shape this repo keeps finding. This greps the source for
    // the call rather than driving a full play, which would need a payable board
    // and a legal destination and would fail for reasons unrelated to the wiring.
    //
    // A string check is weak on purpose: it is a smoke alarm for a deletion, and
    // the behaviour is covered above.
    const source = readSource("src/actions/execute-play-card.ts");
    expect(source, "execute-play-card no longer raises the unitPlayedHere moment").toContain('"unitPlayedHere"');
  });
});

function readSource(relative: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node:fs").readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");
}
