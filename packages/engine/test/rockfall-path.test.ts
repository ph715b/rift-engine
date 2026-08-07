import { describe, expect, it } from "vitest";
import { legalActions } from "../src/engine/legal-actions.js";
import { validatePlayCard } from "../src/actions/validate-play-card.js";
import { forceMoveToBattlefield } from "../src/engine/effect-helpers.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance, type UnitInstance } from "../src/model/card.js";
import type { GameState } from "../src/model/game-state.js";
import type { PlayCardAction } from "../src/actions/player-action.js";
import { makePlayer, makeState, makeUnit, spellInstance } from "./fixtures.js";

/**
 * Rockfall Path (SFD-216) — "Units can't be played here."
 *
 * **PLAYED, not moved or placed**, and that verb is the whole card. A unit may
 * still MOVE here, be dragged here by Charm or Temptation, or arrive by a Recall
 * — reading it as "no unit may become present" would make it a far stronger card
 * than it prints. The move test below is what holds that line.
 *
 * Symmetric: "units", not "your units", so it binds the controller too.
 *
 * Both gates are asserted for both routes a unit reaches a battlefield by — a
 * Unit card's own destination, and a token-placing Spell's — because they arrive
 * through different code and only one of them is on the `mayPlayUnitToBattlefield`
 * path.
 */

const registry = defaultCardRegistry();
const ROCKFALL = "SFD-216";
/** Recruit the Vanguard — "play a 1 Might Recruit unit token" at a battlefield
 *  you control, which is a unit being PLAYED. */
const RECRUIT_THE_VANGUARD = "OGS-015";
const unit = (defId: string) => createCardInstance(registry.get(defId)) as UnitInstance;

/** `bf1` is Rockfall Path and controlled by the player; `bf2` is ordinary. */
function board(held: unknown): GameState {
  const state = makeState({
    phase: "Action",
    players: [
      makePlayer("p1", {
        hand: [held as never],
        channeled: Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, domain: "Order" as const, state: "Ready" as const })),
      }),
      makePlayer("p2"),
    ],
  });
  state.battlefields[0] = { ...state.battlefields[0]!, defId: ROCKFALL, controllerId: "p1" };
  state.battlefields[1] = { ...state.battlefields[1]!, controllerId: "p1" };
  // A unit of the player's at each, so "reinforce" is otherwise legal at both.
  state.battlefields[0]!.units = { p1: [makeUnit({ name: "Holder", instanceId: "holder" })] };
  state.battlefields[1]!.units = { p1: [makeUnit({ name: "Other", instanceId: "other" })] };
  return state;
}

const destinationsFor = (state: GameState, instanceId: string) =>
  legalActions(state)
    .filter((a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === instanceId)
    .map((a) => a.destinationBattlefieldId);

describe("Rockfall Path refuses a unit PLAYED onto it", () => {
  it("is not offered as a destination for a Unit card", () => {
    const soldier = unit("OGN-001");
    const state = board(soldier);
    const destinations = destinationsFor(state, soldier.instanceId);

    expect(destinations, "an ordinary battlefield stopped being offered").toContain("bf2");
    expect(destinations, "Rockfall Path was offered as a destination").not.toContain("bf1");
  });

  it("and the validator refuses a hand-built action naming it", () => {
    const soldier = unit("OGN-001");
    const state = board(soldier);
    const legal = legalActions(state).find(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.destinationBattlefieldId === "bf2",
    )!;

    const onto: PlayCardAction = { ...legal, destinationBattlefieldId: "bf1" };
    expect(validatePlayCard(state, onto), "the validator allowed what enumeration refused").toMatchObject({ ok: false });
  });

  /** A unit TOKEN played to a battlefield is a unit being played — Recruit the
   *  Vanguard's own text is "play a 1 Might Recruit unit token". */
  it("is not offered as a destination for a token-placing Spell", () => {
    const spell = spellInstance(RECRUIT_THE_VANGUARD);
    const state = board(spell);
    const destinations = destinationsFor(state, spell.instanceId);

    expect(destinations, "an ordinary battlefield stopped being offered").toContain("bf2");
    expect(destinations, "Rockfall Path was offered as a token destination").not.toContain("bf1");
  });

  it("refuses a hand-built token placement too", () => {
    const spell = spellInstance(RECRUIT_THE_VANGUARD);
    const state = board(spell);
    const legal = legalActions(state).find(
      (a): a is PlayCardAction => a.type === "PlayCard" && a.card.instanceId === spell.instanceId && a.destinationBattlefieldId === "bf2",
    )!;

    const onto: PlayCardAction = { ...legal, destinationBattlefieldId: "bf1" };
    expect(validatePlayCard(state, onto)).toMatchObject({ ok: false });
  });
});

/**
 * The line that keeps the card from being read as "no unit may become present".
 * Every one of these is a unit ARRIVING at Rockfall Path by a route that is not
 * playing, and every one must still work.
 */
describe("but it does NOT stop a unit arriving any other way", () => {
  it("a unit may still MOVE here", () => {
    const state = board(unit("OGN-001"));
    const after = forceMoveToBattlefield(state, "other", "bf1");

    const here = after.battlefields[0]!.units["p1"] ?? [];
    expect(here.map((u) => u.instanceId), "a MOVE was blocked — the card says 'played'").toContain("other");
  });

  it("the units already standing here are untouched", () => {
    const state = board(unit("OGN-001"));
    expect(state.battlefields[0]!.units["p1"]).toHaveLength(1);
  });
});

describe("it binds BOTH players — 'units', not 'your units'", () => {
  it("refuses the opponent's play too", () => {
    const soldier = unit("OGN-001");
    const state = board(soldier);
    // Hand the card and the turn to p2, and give them a presence at each.
    const theirs: GameState = {
      ...state,
      activePlayerIndex: 1,
      players: [
        { ...state.players[0]!, hand: [] },
        { ...state.players[1]!, hand: [soldier], channeled: state.players[0]!.channeled },
      ],
      battlefields: state.battlefields.map((bf) => ({
        ...bf,
        controllerId: "p2",
        units: { p2: [makeUnit({ name: "Theirs", instanceId: `theirs-${bf.id}` })] },
      })),
    };

    const destinations = destinationsFor(theirs, soldier.instanceId);
    expect(destinations, "an ordinary battlefield stopped being offered").toContain("bf2");
    expect(destinations, "the opponent could play onto Rockfall Path").not.toContain("bf1");
  });
});
