import { describe, expect, it } from "vitest";
import { legendEventTriggers } from "../src/engine/legend-abilities.js";
import { holdEventTrigger } from "../src/engine/triggers.js";
import { optionsFor, pendingDecision, answerDecision } from "../src/engine/decisions.js";
import { runCleanup } from "../src/engine/cleanup.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { submit } from "../src/engine/game-engine.js";
import type { GameState } from "../src/model/game-state.js";
import { makePlayer, makeState, makeUnit } from "./fixtures.js";

/**
 * Irelia - Blade Dancer (SFD-195) — "When you choose a friendly unit, you may
 * exhaust me and pay [rainbow] to ready it. When you conquer, you may pay [1] to
 * ready me."
 *
 * **The first Legend with TWO convertible hooks**, and the card that forced
 * `legendEventTriggers` to stop throwing on the second. Its own comment said the
 * throw existed "so the day one does is the day it is noticed" — this is that
 * day, and Sivir - Battle Mistress is the second.
 *
 * The fold is the risk this file is pointed at: one registry entry per defId now
 * carries N clauses, and the ways that goes wrong are a clause running for
 * another clause's event, a clause silently not firing, and — the one that
 * actually happened — the fold dropping `resolve`'s fourth argument so every
 * Pending Item resolved to nothing.
 */

const IRELIA = "SFD-195";

function board(overrides: Partial<GameState> = {}): GameState {
  const state = makeState({
    phase: "Action",
    players: [
      makePlayer("p1", {
        baseUnits: [makeUnit({ name: "Ally", instanceId: "ally", exhausted: true })],
        channeled: Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, domain: "Fury" as const, state: "Ready" as const })),
      }),
      makePlayer("p2"),
    ],
    ...overrides,
  });
  state.players[0]!.legend = { ...state.players[0]!.legend, defId: IRELIA };
  return state;
}

/** Fires an event, drains the pen onto the chain, and resolves it. */
function fire(state: GameState, event: Parameters<typeof holdEventTrigger>[1]): GameState {
  let current = runCleanup(holdEventTrigger(state, event));
  for (let guard = 0; guard < 8 && current.spellChain.length > 0; guard += 1) {
    if (pendingDecision(current)) break;
    const pass = legalActions(current).find((a) => a.type === "PassFocus");
    if (!pass) break;
    current = submit(current, pass).state;
  }
  return current;
}

describe("the adapter carries BOTH of a Legend's hooks", () => {
  it("registers one entry listening for both moments", () => {
    const entry = legendEventTriggers().entries[IRELIA];
    expect(entry, "Irelia has no registered event trigger").toBeDefined();

    // A LIST, not a bare kind — this is the shape that used to throw.
    const kinds = Array.isArray(entry!.on) ? [...entry!.on] : [entry!.on];
    expect(kinds.sort()).toEqual(["battlefieldConquered", "unitChosen"]);
  });

  /**
   * The negative that matters for a folded entry: each clause must answer only
   * for its OWN event. A fold whose `applies` ignored `event.kind` would place a
   * Pending Item for the wrong moment and then resolve it to nothing.
   */
  it("does not fire the choose clause on a conquest, or the other way round", () => {
    const entry = legendEventTriggers().entries[IRELIA]!;
    const state = board();
    const listener = { card: state.players[0]!.legend, ownerIndex: 0 as const, instanceId: state.players[0]!.legend.instanceId };

    const onChoose = entry.applies!(state, listener as never, {
      kind: "unitChosen",
      chooserIndex: 0,
      unitInstanceId: "ally",
      bySpell: true,
    });
    const onEnemyChoose = entry.applies!(state, listener as never, {
      kind: "unitChosen",
      chooserIndex: 1,
      unitInstanceId: "ally",
      bySpell: true,
    });

    expect(onChoose, "her own clause did not fire for her own choice").toBe(true);
    expect(onEnemyChoose, "she fired on the OPPONENT choosing").toBe(false);
  });
});

describe("Irelia's choose clause", () => {
  it("offers to exhaust her and pay [rainbow] to ready the chosen unit", () => {
    const after = fire(board(), { kind: "unitChosen", chooserIndex: 0, unitInstanceId: "ally", bySpell: true });

    const decision = pendingDecision(after);
    expect(decision?.kind, "no offer was made").toBe("SFD-195-ready-chosen");
    expect(optionsFor(after, decision!).map((o) => o.id).sort()).toEqual(["decline", "ready"]);
  });

  it("readies the unit, exhausts her, and spends the Power", () => {
    const offered = fire(board(), { kind: "unitChosen", chooserIndex: 0, unitInstanceId: "ally", bySpell: true });
    const decision = pendingDecision(offered)!;
    const after = answerDecision(offered, decision.id, "ready")!;

    expect(after.players[0]!.baseUnits[0]!.exhausted, "the chosen unit was not readied").toBe(false);
    expect(after.players[0]!.legend.exhausted, "Irelia was not exhausted as the cost").toBe(true);
    // A Power payment RECYCLES its rune, so the pool shrinks rather than exhausting.
    expect(after.players[0]!.channeled.length, "no rune was spent").toBeLessThan(6);
  });

  /** Declining costs nothing — the negative that proves the cost is tied to the
   *  answer rather than charged when the question is asked. */
  it("declining leaves her ready and the unit exhausted", () => {
    const offered = fire(board(), { kind: "unitChosen", chooserIndex: 0, unitInstanceId: "ally", bySpell: true });
    const after = answerDecision(offered, pendingDecision(offered)!.id, "decline")!;

    expect(after.players[0]!.legend.exhausted).toBe(false);
    expect(after.players[0]!.baseUnits[0]!.exhausted).toBe(true);
    expect(after.players[0]!.channeled).toHaveLength(6);
  });

  /** An exhausted Irelia cannot pay the exhaust, so she is never asked — the
   *  "never offer what cannot be paid" rule this file applies to Volibear. */
  it("is not offered at all while she is already exhausted", () => {
    const state = board();
    state.players[0]!.legend = { ...state.players[0]!.legend, exhausted: true };
    const after = fire(state, { kind: "unitChosen", chooserIndex: 0, unitInstanceId: "ally", bySpell: true });

    expect(pendingDecision(after), "an unpayable offer was made").toBeUndefined();
  });
});

describe("Irelia's conquer clause", () => {
  it("offers to pay [1] to ready her — and DOES offer it while she is exhausted", () => {
    const state = board();
    state.players[0]!.legend = { ...state.players[0]!.legend, exhausted: true };
    state.players[0]!.floatingEnergy = 2;
    const after = fire(state, { kind: "battlefieldConquered", conquerorIndex: 0, battlefieldId: "bf1" });

    const decision = pendingDecision(after);
    expect(decision?.kind, "the conquer clause did not fire").toBe("SFD-195-ready-me");
    // The whole point of this clause is readying her, so being exhausted must
    // NOT bar it — unlike the choose clause, where the exhaust is the cost.
    expect(optionsFor(after, decision!).map((o) => o.id).sort()).toEqual(["decline", "ready"]);

    const readied = answerDecision(after, decision!.id, "ready")!;
    expect(readied.players[0]!.legend.exhausted, "she was not readied").toBe(false);
    expect(readied.players[0]!.floatingEnergy, "the Energy was not spent").toBe(1);
  });

  /** Already ready — the payment would buy nothing, so it is not offered. */
  it("offers nothing when she is already ready", () => {
    const state = board();
    state.players[0]!.floatingEnergy = 2;
    const after = fire(state, { kind: "battlefieldConquered", conquerorIndex: 0, battlefieldId: "bf1" });

    const decision = pendingDecision(after);
    if (decision) {
      expect(optionsFor(after, decision).map((o) => o.id)).toEqual(["decline"]);
    }
    expect(state.players[0]!.legend.exhausted).toBe(false);
  });
});
