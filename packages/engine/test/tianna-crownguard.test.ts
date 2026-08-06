import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { mayGainPoints } from "../src/engine/board-restrictions.js";
import { gainPoints } from "../src/engine/effect-helpers.js";
import { recordConquest, scoreHolds } from "../src/engine/scoring.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, realUnitInstance } from "./fixtures.js";

/**
 * Tianna Crownguard (SFD-060) — "While I'm at a battlefield, opponents can't
 * gain points."
 *
 * # Why this needed a choke point rather than a check
 *
 * Points were written at NINE separate sites: two in `scoring.ts`, Burn Out in
 * `effect-helpers.ts`, one battlefield, and five cards doing a plain
 * `points + 1` inline. A card that forbids gaining points cannot be bolted onto
 * any one of them — `scoring.ts`'s own doc comment already named her as a known
 * omission. All nine now go through `gainPoints`.
 *
 * # The ruling this pins
 *
 * **Blocking a point does NOT unrecord the scoring** (project-owner call,
 * 2026-08-06). The scoring event still happened and simply paid nothing, so
 * 471.1.b's once-per-battlefield-per-turn lockout still fires and the opponent
 * cannot retry that battlefield this turn. That is the half a naive "return
 * early before scoring" implementation would get wrong, and it is what the
 * lockout test below exists for.
 */
const TIANNA = "SFD-060";
const registry = defaultCardRegistry();

/** p1 holds bf1 with a unit; p0 optionally has Tianna somewhere. */
function board(tiannaAt: "battlefield" | "base" | "none"): GameState {
  const state = makeState({ phase: "Beginning", activePlayerIndex: 1 });
  state.battlefields[0] = {
    ...state.battlefields[0]!,
    units: { p2: [makeUnit({ name: "Holder" })] },
    controllerId: "p2",
  };
  if (tiannaAt === "base") state.players[0]!.baseUnits = [realUnitInstance(TIANNA)];
  if (tiannaAt === "battlefield") {
    state.battlefields[1] = { ...state.battlefields[1]!, units: { p1: [realUnitInstance(TIANNA)] } };
  }
  return state;
}

describe("Tianna Crownguard blocks her opponents' points", () => {
  it("is POSITIONAL — she does nothing from base", () => {
    // "While I'm AT A BATTLEFIELD" is printed, and it is the line that separates
    // her from Miss Fortune - Buccaneer, whose grant works from anywhere.
    expect(mayGainPoints(board("battlefield"), 1), "she failed to block from a battlefield").toBe(false);
    expect(mayGainPoints(board("base"), 1), "she blocked from BASE").toBe(true);
    expect(mayGainPoints(board("none"), 1)).toBe(true);
  });

  it("blocks OPPONENTS, not everybody", () => {
    // Asked of the player about to gain, so her own controller is untouched.
    const state = board("battlefield");
    expect(mayGainPoints(state, 0), "she blocked her own controller").toBe(true);
    expect(mayGainPoints(state, 1)).toBe(false);
  });

  it("stops a HOLD from paying", () => {
    const blocked = scoreHolds(board("battlefield"), 1);
    const free = scoreHolds(board("none"), 1);
    expect(free.players[1]!.points, "the control board scored nothing — the fixture is wrong").toBe(1);
    expect(blocked.players[1]!.points, "the hold paid through Tianna").toBe(0);
  });

  it("stops a CONQUEST from paying", () => {
    const blocked = recordConquest(board("battlefield"), 1, "bf1");
    const free = recordConquest(board("none"), 1, "bf1");
    expect(free.players[1]!.points).toBe(1);
    expect(blocked.players[1]!.points, "the conquest paid through Tianna").toBe(0);
  });

  it("STILL RECORDS the battlefield as scored — the ruling's other half", () => {
    // The half a "return before scoring" implementation gets wrong. The scoring
    // event happened and paid nothing, so 471.1.b's lockout fires and the
    // opponent cannot come back for it this turn once she leaves.
    const blocked = scoreHolds(board("battlefield"), 1);
    expect(blocked.players[1]!.points).toBe(0);
    expect(blocked.players[1]!.scoredBattlefieldsThisTurn, "the lockout was not recorded").toContain("bf1");

    // And it really does lock out: scoring the same battlefield again pays
    // nothing even with Tianna gone, because it is already recorded.
    const again = scoreHolds({ ...blocked, players: [makeState().players[0]!, blocked.players[1]!] }, 1);
    expect(again.players[1]!.points, "the lockout did not hold").toBe(0);
  });

  it("reaches a plain `points + 1` card too, not just scoring.ts", () => {
    // The reason `gainPoints` exists at all: five cards awarded points inline,
    // and a check living only in scoring.ts would have missed every one.
    const state = board("battlefield");
    expect(gainPoints(state, 1, 1).players[1]!.points, "an inline award slipped past her").toBe(0);
    expect(gainPoints(board("none"), 1, 1).players[1]!.points).toBe(1);
  });

  it("is reported implemented, with no partial note", () => {
    expect(isCardImplemented(registry.get(TIANNA))).toBe(true);
    expect(partialImplementationNote(registry.get(TIANNA))).toBeUndefined();
  });
});
