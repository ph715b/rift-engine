import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { runBeginning } from "../src/engine/turn-manager.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { RuneCard } from "../src/model/rune.js";
import { answerDecisions, makeState, makeUnit, pickCard, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * The `battlefieldHeld` event — the one `scoring.scoreHolds` never fired.
 *
 * Its own doc comment used to end "minus ... hold-trigger dispatch (no cards with
 * onHold effects exist yet)", which was true and is the reason both cards below
 * were dead. A hold is rule 471.1.a's "maintains Control of a Battlefield they did
 * not yet Score this turn", so the event is the SCORING moment rather than mere
 * presence — a battlefield already scored this turn by a Conquer is not held again
 * (471.1.b) and fires nothing.
 *
 * Fired inside the Beginning Phase, which `submit`'s Pass runs as part of
 * `runStartOfTurn`, so like `endOfTurn` these are held across most of a turn's
 * machinery before the single Cleanup finalizes them.
 */

const registry = defaultCardRegistry();
const AHRI_ALLURING = "OGN-066";
const BLITZCRANK_IMPASSIVE = "OGN-067";

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  // NOT settled here, unlike the other card files' `accept` helpers: this file
  // is about WHEN a held trigger resolves, so a helper that quietly resolved it
  // would erase the thing under test. The tests that want the effect call
  // `resolveHeldTriggers` themselves, visibly.
  return next;
}

const calm = (id: string): RuneCard => ({ id, domain: "Calm", state: "Ready" });

/** Player 0 in their Beginning Phase, with `units` alone at bf1 — which is what
 *  `isHeldBy` reads: units present and no opponent's. */
function holdingBf1(units: ReturnType<typeof makeUnit>[]): GameState {
  const state = makeState({ phase: "Beginning", activePlayerIndex: 0 });
  state.battlefields[0]!.units = { p1: units };
  state.battlefields[0]!.controllerId = "p1";
  return state;
}

describe("Ahri - Alluring (OGN-066): when I hold, you score 1 point", () => {
  it("doubles the hold — the ordinary point plus hers", () => {
    const settled = resolveHeldTriggers(runBeginning(holdingBf1([realUnitInstance(AHRI_ALLURING)])));
    expect(settled.players[0]!.points, "the hold scored but Ahri did not").toBe(2);
  });

  it("does NOT fire for a battlefield she is not standing at — 'when I hold'", () => {
    // Two battlefields held, Ahri at only one. Her point is for hers alone, so
    // the total is 2 holds + 1 Ahri, not 2 + 2.
    const state = holdingBf1([realUnitInstance(AHRI_ALLURING)]);
    state.battlefields[1]!.units = { p1: [makeUnit({ name: "Outpost" })] };
    state.battlefields[1]!.controllerId = "p1";

    expect(resolveHeldTriggers(runBeginning(state)).players[0]!.points).toBe(3);
  });

  it("does NOT fire when the OPPONENT is also present — that is not a hold", () => {
    // `isHeldBy` requires no opponent units. Nothing scores at all, so a nonzero
    // reading here would be Ahri firing on a hold that never happened.
    const state = holdingBf1([realUnitInstance(AHRI_ALLURING)]);
    state.battlefields[0]!.units = { ...state.battlefields[0]!.units, p2: [makeUnit({ name: "Intruder" })] };

    const settled = resolveHeldTriggers(runBeginning(state));
    expect(settled.players[0]!.points).toBe(0);
    expect(settled.spellChain.filter((e) => e.kind === "trigger")).toHaveLength(0);
  });

  it("does NOT fire for a battlefield already SCORED this turn (471.1.b)", () => {
    // A Conquer earlier in the turn already scored bf1, so there is no second
    // score from either method — and therefore no hold for Ahri to read.
    const state = holdingBf1([realUnitInstance(AHRI_ALLURING)]);
    state.players[0]!.scoredBattlefieldsThisTurn = ["bf1"];

    const settled = resolveHeldTriggers(runBeginning(state));
    expect(settled.players[0]!.points).toBe(0);
  });

  it("is HELD — it reaches the chain, and the extra point is not awarded at the hold", () => {
    const begun = runBeginning(holdingBf1([realUnitInstance(AHRI_ALLURING)]));

    expect(begun.pendingTriggers.map((t) => t.listenerDefId)).toEqual([AHRI_ALLURING]);
    expect(begun.players[0]!.points, "resolved inline instead of being held").toBe(1);
  });

  it("survives the whole Pass composition — End, rotate, Awaken, score, draw, Cleanup", () => {
    // Player 1 holds bf2 with Ahri; player 0 passes, so her hold happens inside
    // the `runStartOfTurn` half of a single action and her trigger finalizes only
    // at the Cleanup at the end of it.
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.battlefields[1]!.units = { p2: [realUnitInstance(AHRI_ALLURING)] };
    state.battlefields[1]!.controllerId = "p2";

    const passed = accept(state, { type: "Pass", playerIndex: 0 });
    expect(passed.spellChain.filter((e) => e.kind === "trigger").map((e) => e.listenerDefId)).toEqual([AHRI_ALLURING]);
    expect(passed.players[1]!.points, "Ahri resolved before the response window").toBe(1);

    expect(resolveHeldTriggers(passed).players[1]!.points).toBe(2);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(AHRI_ALLURING))).toBe(true);
  });
});

describe("Blitzcrank - Impassive (OGN-067)", () => {
  it("returns himself to hand when he holds — after the point has scored", () => {
    const blitz = realUnitInstance(BLITZCRANK_IMPASSIVE);
    const settled = resolveHeldTriggers(runBeginning(holdingBf1([blitz])));

    expect(settled.players[0]!.points, "the hold must still score — the bounce is a drawback, not a cancel").toBe(1);
    expect(settled.battlefields[0]!.units["p1"] ?? []).toHaveLength(0);
    expect(settled.players[0]!.hand.map((c) => c.instanceId)).toContain(blitz.instanceId);
  });

  it("does not bounce off a battlefield he is not at", () => {
    const blitz = realUnitInstance(BLITZCRANK_IMPASSIVE);
    const state = holdingBf1([makeUnit({ name: "Outpost" })]);
    state.battlefields[1]!.units = { p1: [blitz] };
    // bf2 is contested, so it is NOT held — only bf1 is, and Blitzcrank is not
    // there. Without a contest both would be held and this would prove nothing.
    state.battlefields[1]!.units = { ...state.battlefields[1]!.units, p2: [makeUnit({ name: "Rival" })] };

    const settled = resolveHeldTriggers(runBeginning(state));
    expect(settled.battlefields[1]!.units["p1"] ?? []).toHaveLength(1);
    expect(settled.players[0]!.hand).toHaveLength(0);
  });

  it("offers the enemy grab when played TO a battlefield, and honours a decline", () => {
    const blitz = realUnitInstance(BLITZCRANK_IMPASSIVE);
    const anchor = makeUnit({ name: "Anchor", instanceId: "anchor" });
    const prey = makeUnit({ name: "Prey", instanceId: "prey" });
    const state = makeState({ phase: "Action" });
    // Presence is required to play a unit to a battlefield (the reinforce rule),
    // so an anchor has to be standing there already.
    state.battlefields[0]!.units = { p1: [anchor] };
    state.players[0]!.hand = [blitz];
    state.players[0]!.channeled = ["r1", "r2", "r3", "r4", "r5", "r6"].map(calm);
    state.players[1]!.baseUnits = [prey];

    const play = legalActions(state).find((a) => a.type === "PlayCard" && a.destinationBattlefieldId === "bf1");
    expect(play, "playing Blitzcrank to bf1 was never enumerated").toBeDefined();
    // Settled explicitly: his ON-PLAY half is a Chain Pending Item like the hold
    // half, so the question it parks is a chain-pop away rather than immediate.
    const played = resolveHeldTriggers(accept(state, play!));

    const decision = played.pendingDecisions[0];
    expect(decision?.kind, "the 'you may' was never asked").toBe("OGN-067-grab");

    // Declining leaves the enemy where it was — "you MAY", and the default the
    // options list puts first.
    const declined = answerDecisions(played);
    expect(declined.players[1]!.baseUnits.map((u) => u.instanceId)).toEqual(["prey"]);
  });

  it("drags the chosen enemy unit to his battlefield, out of the opponent's base", () => {
    const blitz = realUnitInstance(BLITZCRANK_IMPASSIVE);
    const anchor = makeUnit({ name: "Anchor", instanceId: "anchor" });
    const prey = makeUnit({ name: "Prey", instanceId: "prey" });
    const state = makeState({ phase: "Action" });
    state.battlefields[0]!.units = { p1: [anchor] };
    state.players[0]!.hand = [blitz];
    state.players[0]!.channeled = ["r1", "r2", "r3", "r4", "r5", "r6"].map(calm);
    state.players[1]!.baseUnits = [prey];

    const play = legalActions(state).find((a) => a.type === "PlayCard" && a.destinationBattlefieldId === "bf1");
    const grabbed = answerDecisions(resolveHeldTriggers(accept(state, play!)), pickCard("prey"));

    expect(grabbed.players[1]!.baseUnits, "the enemy unit is still at home").toHaveLength(0);
    expect((grabbed.battlefields[0]!.units["p2"] ?? []).map((u) => u.instanceId)).toEqual(["prey"]);
  });

  it("asks nothing when he is played to BASE — 'to a battlefield'", () => {
    const blitz = realUnitInstance(BLITZCRANK_IMPASSIVE);
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [blitz];
    state.players[0]!.channeled = ["r1", "r2", "r3", "r4", "r5", "r6"].map(calm);
    state.players[1]!.baseUnits = [makeUnit({ name: "Prey", instanceId: "prey" })];

    const play = legalActions(state).find((a) => a.type === "PlayCard" && a.destinationBattlefieldId === undefined);
    expect(play, "playing Blitzcrank to base was never enumerated").toBeDefined();

    expect(accept(state, play!).pendingDecisions).toHaveLength(0);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(BLITZCRANK_IMPASSIVE))).toBe(true);
  });
});
