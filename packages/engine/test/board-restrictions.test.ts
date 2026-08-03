import { describe, expect, it } from "vitest";
import { submit } from "../src/engine/game-engine.js";
import { legalActions } from "../src/engine/legal-actions.js";
import { runEnd } from "../src/engine/turn-manager.js";
import { readyUnit } from "../src/engine/effect-helpers.js";
import { isCardImplemented } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance, spellInstance } from "./fixtures.js";

/**
 * Three cards whose whole text is a restriction (or a grant) rather than an
 * effect — so they live at GATES rather than in a resolver.
 *
 * The shared hazard is that every one of these is asked by both the enumerator
 * and the validator, and them disagreeing is how an action gets offered and then
 * refused. Each test therefore checks the enumeration, which is what a player
 * sees, rather than the predicate directly.
 */

const registry = defaultCardRegistry();
const BRYNHIR = "OGN-026"; // "When you play me, opponents can't play cards this turn."
const MAGESEEKER_WARDEN = "OGN-070"; // battlefield-only plays, and no readying enemy permanents
const MISS_FORTUNE_BUCCANEER = "OGN-193"; // "Friendly units may be played to open battlefields."
const HEXTECH_RAY = "OGN-009"; // Fury 1E/1P — an ordinary Spell
const GUST = "OGN-047"; // Calm [Reaction] — the card a lock must also stop

const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

function accept(state: GameState, action: unknown): GameState {
  const { state: next, result } = submit(state, action as never);
  expect(result, `refused: ${JSON.stringify(result)}`).toMatchObject({ type: "Ok" });
  return next;
}

const playsFor = (state: GameState, playerIndex: 0 | 1) =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.playerIndex === playerIndex);

describe("Brynhir Thundersong (OGN-026): opponents can't play cards this turn", () => {
  it("locks the opponent out of playing anything", () => {
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.players[1]!.hand = [spellInstance(HEXTECH_RAY)];
    state.players[1]!.channeled = Array.from({ length: 6 }, (_, i) => rune(`f${i}`, "Fury"));
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "victim", might: 9 })] };

    expect(playsFor(state, 1).length, "the control cast was not available to begin with").toBeGreaterThan(0);
    const locked: GameState = { ...state, players: [state.players[0]!, { ...state.players[1]!, cannotPlayCardsThisTurn: true }] };
    expect(playsFor(locked, 1)).toHaveLength(0);
  });

  it("stops a [Reaction] too — a lock a Reaction could step around is not a lock", () => {
    // Read BEFORE the timing tier for exactly this reason, and a Reaction is what
    // an opponent reaches for.
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    state.players[1]!.hand = [spellInstance(GUST)];
    state.players[1]!.channeled = Array.from({ length: 6 }, (_, i) => rune(`c${i}`, "Calm"));
    state.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "target", might: 2 })] };

    expect(playsFor(state, 1).length, "Gust was not castable to begin with").toBeGreaterThan(0);
    const locked: GameState = { ...state, players: [state.players[0]!, { ...state.players[1]!, cannotPlayCardsThisTurn: true }] };
    expect(playsFor(locked, 1)).toHaveLength(0);
  });

  it("survives her DEATH — 'this turn' is a duration, not a continuous ability", () => {
    // Killing her in response must not unlock the turn. The flag lives on the
    // locked player rather than being derived from her presence, which is what
    // makes that true by construction.
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    const locked: GameState = { ...state, players: [state.players[0]!, { ...state.players[1]!, cannotPlayCardsThisTurn: true }] };
    // She is not on the board at all here, and the lock still holds.
    expect(locked.battlefields.flatMap((bf) => Object.values(bf.units).flat())).toHaveLength(0);
    expect(playsFor(locked, 1)).toHaveLength(0);
  });

  it("expires with the turn", () => {
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    const locked: GameState = { ...state, players: [state.players[0]!, { ...state.players[1]!, cannotPlayCardsThisTurn: true }] };
    expect(runEnd(locked).players[1]!.cannotPlayCardsThisTurn).toBe(false);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(BRYNHIR))).toBe(true);
  });
});

describe("Mageseeker Warden (OGN-070): two restrictions, both positional", () => {
  /** The Warden for player 0, at a battlefield or in base; player 1 has a unit
   *  to play and a friend to reinforce. */
  function wardenState(at: "bf1" | "base"): GameState {
    const state = makeState({ phase: "Action", activePlayerIndex: 1 });
    const warden = realUnitInstance(MAGESEEKER_WARDEN);
    if (at === "bf1") state.battlefields[0]!.units = { p1: [warden] };
    else state.players[0]!.baseUnits = [warden];
    state.battlefields[1]!.units = { p2: [makeUnit({ instanceId: "anchor", might: 3 })] };
    state.players[1]!.hand = [makeUnit({ instanceId: "recruit", might: 2 })];
    state.players[1]!.channeled = Array.from({ length: 6 }, (_, i) => rune(`f${i}`, "Fury"));
    return state;
  }

  it("bars every BATTLEFIELD destination and leaves base alone", () => {
    const restricted = playsFor(wardenState("bf1"), 1);
    expect(restricted.length, "the opponent could not play at all — too strong").toBeGreaterThan(0);
    expect(restricted.every((p) => p.destinationBattlefieldId === undefined), "a battlefield destination was still offered").toBe(true);

    // The control: from BASE she restricts nothing, so the reinforce is back.
    const free = playsFor(wardenState("base"), 1);
    expect(free.some((p) => p.destinationBattlefieldId !== undefined), "she restricted from base — she should not").toBe(true);
  });

  it("stops a spell or ability readying an ENEMY unit, and not a friendly one", () => {
    const state = wardenState("bf1");
    state.battlefields[1]!.units = {
      p1: [makeUnit({ instanceId: "mine", might: 3, exhausted: true })],
      p2: [makeUnit({ instanceId: "theirs", might: 3, exhausted: true })],
    };

    const enemyOfWarden = readyUnit(state, "theirs");
    expect(
      enemyOfWarden.battlefields[1]!.units["p2"]![0]!.exhausted,
      "the Warden's controller's opponent was readied anyway",
    ).toBe(true);

    // Her OWN side readies normally — the restriction is on enemies.
    const herOwn = readyUnit(state, "mine");
    expect(herOwn.battlefields[1]!.units["p1"]![0]!.exhausted).toBe(false);
  });

  it("does NOT stop the Awakening Phase — the exemption is structural", () => {
    // `runAwaken` readies by its own inline map and never calls `readyUnit`, so
    // the restriction cannot reach it. The survey said this needed source
    // attribution across ~10 call sites; measured, it does not, and this is what
    // holds that measurement in place.
    const state = wardenState("bf1");
    state.battlefields[1]!.units = {
      ...state.battlefields[1]!.units,
      p2: [makeUnit({ instanceId: "theirs", might: 3, exhausted: true })],
    };
    const awakened = accept({ ...state, activePlayerIndex: 0, phase: "Action" }, { type: "Pass", playerIndex: 0 });

    expect(awakened.battlefields[1]!.units["p2"]![0]!.exhausted, "Awaken was blocked by the Warden").toBe(false);
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(MAGESEEKER_WARDEN))).toBe(true);
  });
});

describe("Miss Fortune - Buccaneer (OGN-193): friendly units may take open battlefields", () => {
  function buccaneerState(inPlay: boolean): GameState {
    const state = makeState({ phase: "Action" });
    if (inPlay) state.players[0]!.baseUnits = [realUnitInstance(MISS_FORTUNE_BUCCANEER)];
    state.players[0]!.hand = [makeUnit({ instanceId: "recruit", might: 2 })];
    state.players[0]!.channeled = Array.from({ length: 6 }, (_, i) => rune(`c${i}`, "Chaos"));
    return state;
  }

  it("lets an ORDINARY unit be played straight to an open battlefield", () => {
    // bf1 and bf2 are unoccupied and uncontrolled — open (170.11.c) — and without
    // her the reinforce rule bars both.
    const without = playsFor(buccaneerState(false), 0);
    expect(without.some((p) => p.destinationBattlefieldId !== undefined), "the control already allowed it").toBe(false);

    const withHer = playsFor(buccaneerState(true), 0);
    expect(withHer.some((p) => p.destinationBattlefieldId !== undefined), "her grant never reached another unit").toBe(true);
  });

  it("grants from BASE — her text names no battlefield for herself", () => {
    // Unlike the Warden's two sentences, which are positional. She is in base in
    // the fixture above, so that test already proves it; asserted separately so
    // the distinction is not incidental.
    const state = buccaneerState(true);
    expect(state.players[0]!.baseUnits.some((u) => u.defId === MISS_FORTUNE_BUCCANEER)).toBe(true);
    expect(playsFor(state, 0).some((p) => p.destinationBattlefieldId !== undefined)).toBe(true);
  });

  it("does not grant an OCCUPIED battlefield — 'open' is unoccupied AND uncontrolled", () => {
    const state = buccaneerState(true);
    state.battlefields[0]!.units = { p2: [makeUnit({ instanceId: "squatter", might: 3 })] };

    const offered = playsFor(state, 0).map((p) => p.destinationBattlefieldId);
    expect(offered, "she opened an occupied battlefield").not.toContain("bf1");
    expect(offered, "she should still open the empty one").toContain("bf2");
  });

  it("is reported as implemented by coverage", () => {
    expect(isCardImplemented(registry.get(MISS_FORTUNE_BUCCANEER))).toBe(true);
  });
});
