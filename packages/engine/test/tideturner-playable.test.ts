import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { createCardInstance } from "../src/model/card.js";
import { legalActions } from "../src/engine/legal-actions.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit } from "./fixtures.js";

/**
 * **Tideturner (OGN-199) must be playable like any other unit.**
 *
 * Reported from play 2026-08-22: "I am unable to play Tideturner regularly if I
 * control a battlefield. Only options are to pass, cancel the cast or hide."
 *
 * "You MAY choose a unit you control at another location" — the swap is
 * optional, so a board with no eligible unit elsewhere must still offer the
 * plain play, to base and to any battlefield the caster controls. The card's own
 * entry in `effects/chaos.ts` records that this exact question has been wrong in
 * BOTH directions already, which is why it is pinned here on the board shape the
 * report names rather than on the one that happens to work.
 */

const TIDETURNER = "OGN-199";
const registry = defaultCardRegistry();

/** Tideturner in hand, plenty of resources, and `controlled` battlefields under
 *  the caster with a garrison so a reinforce has presence. */
function board(controlled: string[], extraOwnUnits: { at: string; id: string }[] = []): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.battlefields = state.battlefields.map((bf) =>
    controlled.includes(bf.id)
      ? { ...bf, controllerId: "p1", units: { p1: [makeUnit({ instanceId: `g-${bf.id}`, name: "Garrison" })] } }
      : bf,
  );
  for (const { at, id } of extraOwnUnits) {
    const i = state.battlefields.findIndex((bf) => bf.id === at);
    const bf = state.battlefields[i]!;
    state.battlefields[i] = { ...bf, units: { ...bf.units, p1: [...(bf.units.p1 ?? []), makeUnit({ instanceId: id, name: id })] } };
  }
  state.players[0]!.hand = [createCardInstance(registry.get(TIDETURNER))];
  state.players[0]!.channeled = Array.from({ length: 14 }, (_, i) => ({
    id: `r${i}`,
    domain: (["Calm", "Fury", "Mind", "Body", "Chaos", "Order"] as const)[i % 6]!,
    state: "Ready" as const,
  }));
  return state;
}

/** Every enumerated play of Tideturner, by destination. `undefined` is base. */
const playsOf = (state: GameState) =>
  legalActions(state)
    .filter((a) => a.type === "PlayCard" && a.card.defId === TIDETURNER)
    .map((a) => (a.type === "PlayCard" ? (a.destinationBattlefieldId ?? "base") : ""));

describe("Tideturner is playable on the board the report names", () => {
  it("offers a plain play while the caster controls a battlefield", () => {
    // The reported board: a controlled battlefield, and no friendly unit anywhere
    // else for the optional swap to name.
    const plays = playsOf(board(["bf1"]));
    expect(plays.length, "Tideturner could not be played at all — the reported bug").toBeGreaterThan(0);
  });

  it("offers BASE as a destination", () => {
    expect(playsOf(board(["bf1"])), "no play to base was offered").toContain("base");
  });

  it("offers the controlled BATTLEFIELD as a destination", () => {
    expect(playsOf(board(["bf1"])), "no play to the controlled battlefield was offered").toContain("bf1");
  });

  it("is playable with no controlled battlefield at all — the control", () => {
    // If this also failed, the bug would not be about controlling one.
    expect(playsOf(board([])).length, "Tideturner is unplayable even with no battlefield controlled").toBeGreaterThan(0);
  });

  it("offers an UNTARGETED play — the fact the board's decline button reads", () => {
    // **The engine half of the Tideturner report.** `packages/web` derives "may
    // this target be declined?" from whether a no-target variant was enumerated
    // (`src/target-optionality.ts`), so if this stops being offered the board
    // silently goes back to hiding the "Choose no targets" button and the card
    // becomes uncastable through the UI again.
    //
    // Asserted on the board that HAS an eligible swap target, because that is the
    // only board where it matters: with nothing eligible the target step never
    // opens and the decline is never needed.
    const state = board(["bf1"], [{ at: "bf2", id: "elsewhere" }]);
    const untargeted = legalActions(state).filter(
      (a) => a.type === "PlayCard" && a.card.defId === TIDETURNER && a.targetUnitInstanceId === undefined,
    );
    expect(untargeted.length, "no untargeted Tideturner play was offered — 'you MAY choose' became mandatory").toBeGreaterThan(
      0,
    );
  });

  it("still offers the swap when a friendly unit IS elsewhere", () => {
    // The card's actual trick must survive whatever fixes the plain play.
    const state = board(["bf1"], [{ at: "bf2", id: "elsewhere" }]);
    const swaps = legalActions(state).filter(
      (a) => a.type === "PlayCard" && a.card.defId === TIDETURNER && a.targetUnitInstanceId === "elsewhere",
    );
    expect(swaps.length, "the optional swap disappeared").toBeGreaterThan(0);
  });

  it("does NOT offer a swap with a unit at the destination — 'at ANOTHER location'", () => {
    // The narrowing that must not be lost: a target standing where Tideturner
    // lands makes the swap a no-op, and an ineligible target must never be
    // offered (355.9.b).
    const state = board(["bf1"], [{ at: "bf1", id: "sameplace" }]);
    const bad = legalActions(state).filter(
      (a) =>
        a.type === "PlayCard" &&
        a.card.defId === TIDETURNER &&
        a.targetUnitInstanceId === "sameplace" &&
        (a.destinationBattlefieldId ?? "base") === "bf1",
    );
    expect(bad, "a same-location swap was offered").toHaveLength(0);
  });
});
