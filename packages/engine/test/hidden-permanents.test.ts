import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import type { RuneCard } from "../src/model/rune.js";
import { makeState, makeUnit, realUnitInstance } from "./fixtures.js";

/**
 * Rule 811's placement clause for a hidden PERMANENT — "if a hidden card causes
 * you to play a unit, you must choose to play that unit at that battlefield".
 *
 * The conformance doc carried this as "not implemented, unreachable — all five
 * `[Hidden]` cards in the presets are Spells". The PRESET half was true and the
 * POOL half was never checked: there are six `[Hidden]` units and one `[Hidden]`
 * gear, and every one of them is implemented, so a player can hide a unit at a
 * battlefield and then play it into their base for free.
 */

const registry = defaultCardRegistry();
const TEEMO_STRATEGIST = "OGN-121"; // a [Hidden] Unit
const rune = (id: string, domain: RuneCard["domain"]): RuneCard => ({ id, domain, state: "Ready" });

/** Teemo hidden at bf2 since last turn, with no friendly unit standing there. */
function hiddenUnitState(): GameState {
  const state = makeState({ phase: "Action", turnNumber: 3 });
  state.players[0]!.channeled = Array.from({ length: 6 }, (_, i) => rune(`m${i}`, "Mind"));
  state.battlefields[1]!.hiddenCards = [
    { ownerIndex: 0, card: realUnitInstance(TEEMO_STRATEGIST), hiddenOnTurn: 1 },
  ];
  return state;
}

const hiddenPlays = (state: GameState) =>
  legalActions(state).filter((a): a is PlayCardAction => a.type === "PlayCard" && a.fromHiddenBattlefieldId !== undefined);

describe("a hidden PERMANENT is played at its own battlefield (811)", () => {
  it("is offered at all — the card is real and playable from hidden", () => {
    // The positive control. Without it every assertion below passes vacuously,
    // which is exactly how this gap survived: the doc called it unreachable.
    expect(hiddenPlays(hiddenUnitState()).length, "the hidden unit was never offered").toBeGreaterThan(0);
  });

  it("is NEVER offered a base play", () => {
    // "You must choose to play that unit AT THAT BATTLEFIELD." A base play is
    // the one thing 811 forbids, and it was the only candidate on offer.
    const offered = hiddenPlays(hiddenUnitState());
    expect(offered.every((p) => p.destinationBattlefieldId !== undefined), "a base play was offered").toBe(true);
  });

  it("is only ever offered at the battlefield it was hidden at", () => {
    const offered = hiddenPlays(hiddenUnitState());
    expect(new Set(offered.map((p) => p.destinationBattlefieldId))).toEqual(new Set(["bf2"]));
  });

  it("needs no PRESENCE there — 811 overrides the reinforce rule", () => {
    // The ordinary rule is that a unit may only be played to a battlefield you
    // already occupy. A card hidden there is the standing exception, and without
    // it the fix would simply make the card unplayable instead of misplaced.
    const state = hiddenUnitState();
    expect((state.battlefields[1]!.units["p1"] ?? []).length, "the fixture accidentally has presence").toBe(0);
    expect(hiddenPlays(state).length).toBeGreaterThan(0);
  });

  it("REFUSES a hand-built base play of a hidden unit", () => {
    const state = hiddenUnitState();
    const play = hiddenPlays(state)[0]!;
    const { destinationBattlefieldId: _dropped, ...toBase } = play;
    expect(validatePlayCard(state, toBase as PlayCardAction)).toMatchObject({ ok: false });
  });

  it("REFUSES a hand-built play at a DIFFERENT battlefield", () => {
    const state = hiddenUnitState();
    const play = hiddenPlays(state)[0]!;
    expect(validatePlayCard(state, { ...play, destinationBattlefieldId: "bf1" })).toMatchObject({ ok: false });
  });

  it("leaves an ordinary hand play alone — base is still legal from hand", () => {
    // The control that keeps the fix scoped: only a FROM-HIDDEN play is narrowed.
    const state = makeState({ phase: "Action" });
    state.players[0]!.hand = [realUnitInstance(TEEMO_STRATEGIST)];
    state.players[0]!.channeled = Array.from({ length: 6 }, (_, i) => rune(`m${i}`, "Mind"));
    state.battlefields[0]!.units = { p1: [makeUnit({ instanceId: "friend", might: 2 })] };

    const plays = legalActions(state).filter(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.defId === TEEMO_STRATEGIST,
    );
    expect(plays.some((p) => p.destinationBattlefieldId === undefined), "the base play vanished from hand too").toBe(true);
  });

  it("counts the pool this actually reaches", () => {
    // The number that made this worth fixing rather than recording: the doc's
    // "unreachable" was measured against the PRESETS, never against the pool.
    const hiddenPermanents = registry.all().filter((c) => "hidden" in c && c.hidden === true && c.type !== "Spell");
    expect(hiddenPermanents.length).toBeGreaterThan(1);
  });
});
