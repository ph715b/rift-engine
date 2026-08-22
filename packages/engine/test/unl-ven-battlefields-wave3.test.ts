import { describe, expect, it } from "vitest";
import { runBeginning } from "../src/engine/turn-manager.js";
import { loadBattlefieldDefinitions } from "../src/cards/card-loader.js";
import { optionsFor, pendingDecision, answerDecision } from "../src/engine/decisions.js";
import type { GameState } from "../src/model/game-state.js";
import type { UnitInstance } from "../src/model/card.js";
import { answerDecisions, makeState, makeUnit, resolveHeldTriggers } from "./fixtures.js";

/**
 * **UNL/VEN battlefields, wave 3 — the two BEGINNING PHASE ones.**
 *
 *   UNL-212 Frozen Fortress — at the start of EACH player's Beginning Phase,
 *                             deal 1 to each unit here
 *   UNL-209 Dusk Rose Lab   — at the start of YOUR Beginning Phase, you may kill
 *                             a unit you control here to draw 1
 *
 * Both go through `runBattlefieldBeginningPhase`, which resolves INLINE rather
 * than as a Chain Pending Item — the deliberate exception this module already
 * made for Obelisk of Power and The Arena's Greatest, and the reason both cards'
 * reminder text says "(This happens before scoring.)". `turn-manager.runBeginning`
 * already calls it ahead of `scoreHolds`.
 *
 * # The guard that had to MOVE
 *
 * `runBattlefieldBeginningPhase` opened with `if (state.turnNumber !== 1) return
 * state;`, because both existing entries print "each player's FIRST Beginning
 * Phase". That was right while they were the only two and would have made both of
 * these fire exactly once per game. The guard now belongs to the cards that print
 * it — which is why this file asserts the OGN pair still fires only on turn 1.
 */

const FROZEN_FORTRESS = "UNL-212";
const DUSK_ROSE_LAB = "UNL-209";
const OBELISK_OF_POWER = "OGN-284";

/** bf1 IS the named battlefield, with the given units, on `playerIndex`'s
 *  Beginning Phase at `turnNumber`. */
function beginningAt(
  defId: string,
  units: { p1?: UnitInstance[]; p2?: UnitInstance[] },
  opts: { turnNumber?: number; controllerId?: string | null; activePlayerIndex?: 0 | 1 } = {},
): GameState {
  const state = makeState({ phase: "Beginning", activePlayerIndex: opts.activePlayerIndex ?? 0 });
  state.battlefields[0] = {
    ...state.battlefields[0]!,
    defId,
    units: { ...(units.p1 ? { p1: units.p1 } : {}), ...(units.p2 ? { p2: units.p2 } : {}) },
    controllerId: opts.controllerId === undefined ? "p1" : opts.controllerId,
  };
  return { ...state, turnNumber: opts.turnNumber ?? 2 };
}

const settle = (state: GameState) => answerDecisions(resolveHeldTriggers(runBeginning(state)));
const damageAt = (state: GameState, side: "p1" | "p2") =>
  (state.battlefields[0]!.units[side] ?? []).map((u) => `${u.instanceId}:${u.damage}`);

describe("every name in this wave is a battlefield that really prints that text", () => {
  it("matches the printed cards", () => {
    const byId = new Map(loadBattlefieldDefinitions().map((d) => [d.id, d]));
    for (const [defId, name, phrase] of [
      [FROZEN_FORTRESS, "Frozen Fortress", "each player's Beginning Phase"],
      [DUSK_ROSE_LAB, "Dusk Rose Lab", "your Beginning Phase"],
    ] as const) {
      const def = byId.get(defId);
      expect(def?.name, `${defId} is not the card this wave thinks it is`).toBe(name);
      expect(def?.text, `${name}'s text has changed under the implementation`).toContain(phrase);
    }
  });
});

describe("Frozen Fortress (UNL-212): 1 damage to each unit here, every Beginning Phase", () => {
  const mine = () => makeUnit({ instanceId: "m", name: "Mine", might: 3 });
  const theirs = () => makeUnit({ instanceId: "t", name: "Theirs", might: 3 });

  it("damages BOTH sides — 'each unit here'", () => {
    const settled = settle(beginningAt(FROZEN_FORTRESS, { p1: [mine()], p2: [theirs()] }));
    expect(damageAt(settled, "p1"), "the active player's own unit was spared").toEqual(["m:1"]);
    expect(damageAt(settled, "p2"), "the opponent's unit was spared").toEqual(["t:1"]);
  });

  it("fires on a LATER turn, not only the first", () => {
    // The regression this wave's refactor is about: the shared hook used to
    // return early on any turn but 1, which would make this card fire once per
    // game rather than every Beginning Phase.
    const settled = settle(beginningAt(FROZEN_FORTRESS, { p1: [mine()] }, { turnNumber: 7 }));
    expect(damageAt(settled, "p1"), "it did not fire outside turn 1").toEqual(["m:1"]);
  });

  it("kills a 1-Might unit outright, through the real death funnel", () => {
    const settled = settle(beginningAt(FROZEN_FORTRESS, { p1: [makeUnit({ instanceId: "frail", name: "Frail", might: 1 })] }));
    expect(damageAt(settled, "p1"), "the frail unit survived 1 damage").toEqual([]);
    expect(settled.players[0]!.trash.map((c) => c.instanceId), "it did not reach the trash").toEqual(["frail"]);
  });

  it("does not reach units at another battlefield", () => {
    const state = beginningAt(FROZEN_FORTRESS, { p1: [mine()] });
    state.battlefields[1] = { ...state.battlefields[1]!, units: { p1: [makeUnit({ instanceId: "far", name: "Far", might: 3 })] } };
    const settled = settle(state);
    expect((settled.battlefields[1]!.units.p1 ?? []).map((u) => u.damage), "a unit elsewhere was damaged").toEqual([0]);
  });
});

describe("Dusk Rose Lab (UNL-209): kill one of yours here to draw 1", () => {
  const mine = () => makeUnit({ instanceId: "m", name: "Mine", might: 3 });

  function withDeck(state: GameState): GameState {
    state.players[0]!.deck = [{ ...makeUnit({ instanceId: "top", name: "Top" }), defId: "OGN-164" }] as never;
    return state;
  }

  it("offers only YOUR OWN units here", () => {
    const state = withDeck(
      beginningAt(DUSK_ROSE_LAB, { p1: [mine()], p2: [makeUnit({ instanceId: "t", name: "Theirs", might: 3 })] }),
    );
    const held = runBeginning(state);
    const pending = pendingDecision(held);
    expect(pending?.kind, "no question was raised").toBe(`${DUSK_ROSE_LAB}-kill`);
    expect(optionsFor(held, pending!).map((o) => o.id).sort(), "it offered the enemy's unit").toEqual(["decline", "m"]);
  });

  it("kills the chosen unit and draws", () => {
    const held = runBeginning(withDeck(beginningAt(DUSK_ROSE_LAB, { p1: [mine()] })));
    const settled = answerDecision(held, pendingDecision(held)!.id, "m")!;
    expect(settled.players[0]!.trash.map((c) => c.instanceId), "the unit was not killed").toContain("m");
    expect(settled.players[0]!.hand.map((c) => c.instanceId), "the draw never happened").toEqual(["top"]);
  });

  it("declining kills nobody and draws nothing", () => {
    const held = runBeginning(withDeck(beginningAt(DUSK_ROSE_LAB, { p1: [mine()] })));
    const settled = answerDecision(held, pendingDecision(held)!.id, "decline")!;
    expect((settled.battlefields[0]!.units.p1 ?? []).map((u) => u.instanceId), "declining killed it anyway").toEqual(["m"]);
    expect(settled.players[0]!.hand, "declining drew anyway").toHaveLength(0);
  });

  it("asks nothing with no units of yours here", () => {
    const settled = settle(withDeck(beginningAt(DUSK_ROSE_LAB, { p2: [makeUnit({ instanceId: "t", name: "Theirs", might: 3 })] })));
    expect(pendingDecision(settled), "a question was asked with nothing to kill").toBeUndefined();
  });

  it("asks only the CONTROLLER — 'your', where Frozen Fortress says 'each player's'", () => {
    // Two cards in one set, printed differently on purpose. Read as the
    // battlefield's controller, or the two phrasings would mean the same thing.
    // Recorded in docs/rules-conformance.md as Unverified — it is the reading that
    // makes the contrast meaningful rather than one the rules settle outright.
    const notMine = withDeck(beginningAt(DUSK_ROSE_LAB, { p1: [mine()] }, { controllerId: "p2" }));
    expect(pendingDecision(runBeginning(notMine)), "a non-controller was offered the choice").toBeUndefined();
  });
});

describe("the OGN pair still fires only on the FIRST Beginning Phase", () => {
  it("Obelisk of Power channels on turn 1 and not on turn 2", () => {
    // The control for the refactor. Moving the turn-1 guard off the function and
    // onto the two cards that print it must not have loosened them.
    const runes = [{ id: "r1", domain: "Calm" as const, state: "Ready" as const }];

    const first = beginningAt(OBELISK_OF_POWER, { p1: [makeUnit()] }, { turnNumber: 1 });
    first.players[0]!.runeDeck = runes;
    expect(settle(first).players[0]!.channeled.length, "it did not channel on the first Beginning Phase").toBe(1);

    const later = beginningAt(OBELISK_OF_POWER, { p1: [makeUnit()] }, { turnNumber: 2 });
    later.players[0]!.runeDeck = runes;
    expect(settle(later).players[0]!.channeled.length, "it channelled again after turn 1").toBe(0);
  });
});
