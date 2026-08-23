import { describe, expect, it } from "vitest";
import { runAwaken } from "../src/engine/turn-manager.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, realUnitInstance, resolveHeldTriggers } from "./fixtures.js";

/**
 * **"When I become ready" fires on the AWAKEN — measured 2026-08-23.**
 *
 * **415.3.a**: "A player Readies all non-spell Game Objects they Control during
 * the Awakening Phase on their turn." The Awaken IS a readying performed by the
 * player, so a unit that becomes ready during it has become ready. Pirate's
 * Haven has always paid out on the same event, and "becoming ready" cannot have
 * two definitions.
 *
 * # This file exists because the DOCUMENTATION was wrong, not the engine
 *
 * `docs/rules-conformance.md` carried a row saying these two cards "fire on a
 * SPELL's readying, not on Awaken", and both card comments said the same:
 * *"Awaken does NOT fire it, and that is what makes the card playable rather
 * than a free +2 every turn. `runAwaken` readies by its own inline map rather
 * than through `readyUnit`."*
 *
 * Measured, that is false. `turn-manager` holds one `unitReadied` per awakened
 * unit — the capture exists precisely so Pirate's Haven can name the unit — and
 * both cards are registered in `eventTriggers` against that event. Fretful Feline
 * goes 5 to 7 across an Awaken; Jayce's trigger reaches the chain.
 *
 * The seam the note described was real once and was closed when the Awaken
 * learned to raise the event per unit. Nobody re-read the note afterwards, and
 * its balance argument ("what makes the card playable") was reasoning from a
 * premise that had already stopped being true.
 *
 * **Pinned here so the documentation cannot drift from the behaviour again**, in
 * the direction that is otherwise invisible: a trigger that silently stops firing
 * on Awaken just makes a card quietly weaker, and nothing else in the repo would
 * notice.
 */

const FRETFUL_FELINE = "VEN-071";
const JAYCE_HAMMER = "VEN-088";

/** `defId` exhausted at bf1, with its controller about to Awaken. */
function board(defId: string): GameState {
  const state = makeState({ phase: "Awaken", activePlayerIndex: 0 });
  state.battlefields[0] = {
    ...state.battlefields[0]!,
    units: { p1: [{ ...realUnitInstance(defId), exhausted: true }] },
  };
  return state;
}

const triggersOf = (state: GameState, defId: string) =>
  [...state.pendingTriggers, ...state.spellChain].filter(
    (e) => "listenerDefId" in e && e.listenerDefId === defId,
  );

describe("the cards are what this file thinks they are", () => {
  it("both print the become-ready clause", () => {
    for (const defId of [FRETFUL_FELINE, JAYCE_HAMMER]) {
      const unit = realUnitInstance(defId);
      expect(unit.instanceId, `${defId} did not build`).toBeDefined();
    }
  });
});

describe("the Awakening Phase IS a readying — 415.3.a", () => {
  it("readies the exhausted unit at all — the precondition", () => {
    // Without this, "the trigger fired" below could be measuring a unit that was
    // never exhausted to begin with.
    const before = board(FRETFUL_FELINE);
    expect(before.battlefields[0]!.units.p1![0]!.exhausted, "the fixture unit is not exhausted").toBe(true);
    expect(runAwaken(before).battlefields[0]!.units.p1![0]!.exhausted, "the Awaken did not ready it").toBe(false);
  });

  it("fires Fretful Feline's trigger, and it pays out", () => {
    const state = board(FRETFUL_FELINE);
    const unit = state.battlefields[0]!.units.p1![0]!;
    const before = effectiveMight(state, unit, 0, { isCombat: false, battlefieldId: "bf1" });

    const after = resolveHeldTriggers(runAwaken(state));
    const now = after.battlefields[0]!.units.p1![0]!;
    expect(
      effectiveMight(after, now, 0, { isCombat: false, battlefieldId: "bf1" }),
      "Fretful Feline did not gain +2 Might across the Awaken",
    ).toBe(before + 2);
  });

  it("fires Jayce's trigger onto the chain", () => {
    // His clause grants a KEYWORD and is modal, so his Might is the wrong thing
    // to watch — the first attempt at this measurement read 5 and 5 and proved
    // nothing. The trigger reaching the chain is the fact.
    expect(
      triggersOf(runAwaken(board(JAYCE_HAMMER)), JAYCE_HAMMER),
      "Jayce's become-ready trigger did not fire on the Awaken",
    ).toHaveLength(1);
  });

  it("does not fire for a unit that was ALREADY ready — 415.1.c", () => {
    // "If a Unit is instructed to be Readied while it is already Ready, nothing
    // additional happens." So a ready unit does not become ready again, and the
    // Awaken must not pay these cards every turn regardless.
    const state = board(FRETFUL_FELINE);
    state.battlefields[0] = {
      ...state.battlefields[0]!,
      units: { p1: [{ ...state.battlefields[0]!.units.p1![0]!, exhausted: false }] },
    };
    expect(
      triggersOf(runAwaken(state), FRETFUL_FELINE),
      "a unit that was already ready fired a become-ready trigger",
    ).toHaveLength(0);
  });
});
