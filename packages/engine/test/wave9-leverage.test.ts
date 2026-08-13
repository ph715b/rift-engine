import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import { unitEntersReady } from "../src/engine/deploy.js";
import { optionsFor, pendingDecision } from "../src/engine/decisions.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * **The two cheapest cards left, taken first because leverage is cards per unit
 * of work rather than cards per mechanism.**
 *
 * Both had been refused for waves, and neither needed a subsystem:
 *
 *   - **Vex - Gloomist (UNL-193)** is Renata Glasc's first clause with the payout
 *     changed — same moment, same optional Legend exhaust, same parked question.
 *     Two rows.
 *   - **Shadow (UNL-194)** was blocked by something genuinely narrow:
 *     `unitEntersReady` was handed no destination, and `playUnitToBattlefield`
 *     and `playUnitToBase` called it identically, so "if you play me TO A
 *     BATTLEFIELD" could not be asked at all.
 */

const registry = defaultCardRegistry();
const VEX_GLOOMIST = "UNL-193";
const SHADOW = "UNL-194";

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

describe("Shadow (UNL-194): 'if you play me to a battlefield, I enter ready'", () => {
  /** Shadow in hand with the runes to cast him, and a unit at bf1 so a
   *  reinforce destination is legal. */
  function board(): { state: GameState; shadowId: string } {
    const shadow = realUnitInstance(SHADOW);
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    state.players[0]!.hand = [shadow];
    state.players[0]!.floatingEnergy = 12;
    state.players[0]!.channeled = Array.from({ length: 10 }, (_, i) => rune(`r${i}`, "Calm"));
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      units: { p1: [realUnitInstance("OGN-052")] },
    };
    return { state, shadowId: shadow.instanceId };
  }

  const playsOf = (state: GameState, instanceId: string): PlayCardAction[] =>
    legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId);

  const find = (state: GameState, instanceId: string): UnitInstance | undefined =>
    [
      ...state.players.flatMap((p) => p.baseUnits),
      ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
    ].find((u) => u.instanceId === instanceId);

  it("enters READY when played to a battlefield", () => {
    const { state, shadowId } = board();
    const toBf = playsOf(state, shadowId).find((a) => a.destinationBattlefieldId !== undefined);
    expect(toBf, "no battlefield play was enumerated — the fixture is wrong").toBeDefined();

    const after = resolveHeldTriggers(submit(state, toBf!).state);
    expect(find(after, shadowId)?.exhausted, "he arrived exhausted at a battlefield").toBe(false);
  });

  it("enters EXHAUSTED when played to base — the control that makes it a condition", () => {
    // 143.4.a is the default, and the clause is a reward for the riskier
    // placement. Without this, "always ready" would pass the test above.
    const { state, shadowId } = board();
    const toBase = playsOf(state, shadowId).find((a) => a.destinationBattlefieldId === undefined);
    expect(toBase, "no base play was enumerated").toBeDefined();

    const after = resolveHeldTriggers(submit(state, toBase!).state);
    expect(find(after, shadowId)?.exhausted, "he arrived ready in base — the destination is not being read").toBe(true);
  });

  it("the predicate itself distinguishes the two, and says nothing without one", () => {
    // Asked directly, because the parameter is OPTIONAL and its absence must mean
    // "unknown" rather than "base" — the inner callers that price a play before a
    // destination exists must not accidentally satisfy a base-only clause.
    const { state } = board();
    const shadow = realUnitInstance(SHADOW);

    expect(unitEntersReady(state, 0, shadow, undefined, "battlefield"), "the battlefield case is not read").toBe(true);
    expect(unitEntersReady(state, 0, shadow, undefined, "base"), "the base case reads as ready").toBe(false);
    expect(unitEntersReady(state, 0, shadow), "an unknown destination satisfied a battlefield-only clause").toBe(false);
  });

  it("does not make OTHER units enter ready at a battlefield", () => {
    // The clause is keyed by defId. A bystander played to the same battlefield
    // must still arrive exhausted, or the parameter has become a blanket grant.
    const { state } = board();
    const poro = realUnitInstance("OGN-052");
    expect(unitEntersReady(state, 0, poro, undefined, "battlefield"), "every unit now enters ready").toBe(false);
  });
});

describe("Vex - Gloomist (UNL-193): when you hold, you may exhaust her to draw 1", () => {
  /** Player 0 about to score a hold at bf2 with Vex as their Legend. */
  function holding(): GameState {
    const state = makeState({ phase: "Action", activePlayerIndex: 0 });
    const owner = state.players[1]!;
    state.players[1] = { ...owner, legend: { ...owner.legend, defId: VEX_GLOOMIST, name: "Vex - Gloomist" } };
    state.battlefields[1] = { ...state.battlefields[1]!, units: { p2: [realUnitInstance("OGN-052")] }, controllerId: "p2" };
    // Something to draw. `drawCards` on an empty deck draws nothing and the
    // assertion reads exactly like a Legend that never fired.
    state.players[1] = { ...state.players[1]!, deck: [realUnitInstance("OGN-052"), realUnitInstance("OGN-052")] };
    return state;
  }

  const askedOf = (state: GameState) => pendingDecision(state);

  it("asks, and drawing exhausts her", () => {
    const settled = resolveHeldTriggers(submit(holding(), { type: "Pass", playerIndex: 0 }).state);
    const decision = askedOf(settled);
    expect(decision?.kind, "Vex never asked — the Legend hook did not fire").toBe("UNL-193-draw");

    const options = optionsFor(settled, decision!);
    const draw = options.find((o) => o.id === "draw");
    expect(draw, "the draw option was not offered").toBeDefined();

    const before = settled.players[1]!.hand.length;
    const after = submit(settled, {
      type: "AnswerDecision",
      playerIndex: decision!.playerIndex,
      decisionId: decision!.id,
      optionId: "draw",
    }).state;

    expect(after.players[1]!.hand.length - before, "she did not draw").toBe(1);
    expect(after.players[1]!.legend.exhausted, "the price was not paid").toBe(true);
  });

  it("DECLINE leads, and declining costs nothing", () => {
    // "You MAY" — a mis-click and the AI's tie-break both land on doing nothing.
    const settled = resolveHeldTriggers(submit(holding(), { type: "Pass", playerIndex: 0 }).state);
    const decision = askedOf(settled)!;
    expect(optionsFor(settled, decision)[0]!.id, "decline is not the first option").toBe("decline");

    const before = settled.players[1]!.hand.length;
    const after = submit(settled, {
      type: "AnswerDecision",
      playerIndex: decision.playerIndex,
      decisionId: decision.id,
      optionId: "decline",
    }).state;

    expect(after.players[1]!.hand.length, "declining drew anyway").toBe(before);
    expect(after.players[1]!.legend.exhausted, "declining exhausted her").toBe(false);
  });

  it("offers no draw when she is already exhausted — the cost must be payable", () => {
    // **Exhausted AFTER the hold, not before.** Passing runs the opponent's whole
    // start of turn, and Awaken readies their permanents — so a Legend exhausted
    // in the fixture is ready again by the time the question is asked, and the
    // first version of this test failed with "an unpayable option was offered"
    // while the option list was correct.
    const settled = resolveHeldTriggers(submit(holding(), { type: "Pass", playerIndex: 0 }).state);
    const decision = askedOf(settled)!;
    const spent: GameState = {
      ...settled,
      players: settled.players.map((p, i) =>
        i === decision.playerIndex ? { ...p, legend: { ...p.legend, exhausted: true } } : p,
      ) as GameState["players"],
    };

    expect(optionsFor(spent, decision).map((o) => o.id), "an unpayable option was offered").toEqual(["decline"]);
  });
});

describe("coverage", () => {
  it("both cards are whole, with no partial note left", () => {
    for (const id of [VEX_GLOOMIST, SHADOW]) {
      expect(isCardImplemented(registry.get(id)), `${id} is greyed`).toBe(true);
      expect(partialImplementationNote(registry.get(id)), `${id} still names a missing half`).toBeUndefined();
    }
  });
});
