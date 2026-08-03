import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, spellInstance } from "./fixtures.js";

const FALLING_STAR = "OGN-029"; // "Deal 3 to a unit. Deal 3 to a unit."
const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

function starState(enemyCount: number): GameState {
  const state = makeState({ phase: "Action" });
  state.players[0]!.hand = [spellInstance(FALLING_STAR)];
  state.players[0]!.channeled = Array.from({ length: 8 }, (_, i) => rune(`f${i}`, "Fury"));
  state.battlefields[0]!.units = {
    p2: Array.from({ length: enemyCount }, (_, i) => makeUnit({ instanceId: `e${i}`, might: 9 })),
  };
  return state;
}

const starPlays = (state: GameState) =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === FALLING_STAR);

describe("Falling Star (OGN-029): the same unit may fill both targets", () => {
  it("is castable with exactly ONE unit on the board, hitting it twice", () => {
    const plays = starPlays(starState(1));
    expect(plays.length, "no cast was offered with one unit on the board").toBeGreaterThan(0);
    expect(plays.map((p) => p.targetUnitInstanceIds)).toContainEqual(["e0", "e0"]);
  });

  it("still offers the DOUBLE-UP when several units are available", () => {
    // The playtest report: picking the same creature twice would not cast. With
    // more than one unit around, the pair [e0, e0] must still be among the
    // candidates or the board has nothing to match the second click against.
    const plays = starPlays(starState(3));
    const lists = plays.map((p) => (p.targetUnitInstanceIds ?? []).join("+"));
    expect(lists, "a repeated target vanished once other units existed").toContain("e0+e0");
  });

  it("accepts a hand-built repeated pair", () => {
    const state = starState(3);
    const play = starPlays(state)[0]!;
    expect(validatePlayCard(state, { ...play, targetUnitInstanceIds: ["e1", "e1"] })).toMatchObject({ ok: true });
  });

  it("offers a friendly unit too — 'a unit' is the bare noun (355.9.b)", () => {
    const state = starState(1);
    state.battlefields[0]!.units = { ...state.battlefields[0]!.units, p1: [makeUnit({ instanceId: "mine", might: 9 })] };
    const lists = starPlays(state).map((p) => (p.targetUnitInstanceIds ?? []).join("+"));
    expect(lists).toContain("mine+mine");
  });
});
