import { describe, expect, it } from "vitest";
import { cardMovesTarget, createCardInstance, defaultCardRegistry, type CardInstance } from "@rift-engine/engine";
import { cardHasDestination } from "../src/card-destination.js";

/**
 * A Spell that MOVES its target has to let the player say where.
 *
 * Reported from playtesting against Charm: "I can select a unit I want to move
 * but cannot choose where to move it." `GameBoard.cardHasDestination` — the gate
 * on the whole placement step — answered true only for a **Unit** or a
 * **token-placing Spell**, and Charm is neither. So the destination step never
 * came up, and the play could never be completed: several candidates differ only
 * by `destinationBattlefieldId`, so nothing could auto-resolve either.
 *
 * The predicate lives in the engine (`cardMovesTarget`) and there are FIVE cards
 * on it, so this was never one card's problem.
 */

const registry = defaultCardRegistry();
const card = (defId: string): CardInstance => createCardInstance(registry.get(defId));

const CHARM = "OGN-043";
const MOVE_SPELLS = [CHARM, "OGN-270", "OGN-173", "OGN-250", "OGN-258"];
const HEXTECH_RAY = "OGN-009"; // a targeted Spell that moves nothing

describe("a Spell that moves its target needs a destination step", () => {
  it("Charm asks for one", () => {
    expect(cardMovesTarget(CHARM), "the engine no longer thinks Charm moves its target").toBe(true);
    expect(cardHasDestination(card(CHARM))).toBe(true);
  });

  it("so do the other four move spells — this was never one card", () => {
    for (const defId of MOVE_SPELLS) {
      expect(cardHasDestination(card(defId)), `${registry.get(defId).name} (${defId})`).toBe(true);
    }
  });

  it("an ordinary targeted Spell still asks for NO destination", () => {
    // The control. A gate that said yes to everything would "fix" Charm by
    // stalling every other spell on a placement step it can never satisfy.
    expect(cardHasDestination(card(HEXTECH_RAY))).toBe(false);
  });

  it("a Unit still asks for one, and a Gear still does not", () => {
    expect(cardHasDestination(card("OGN-087"))).toBe(true); // Lecturing Yordle
    expect(cardHasDestination(card("OGN-098"))).toBe(false); // Energy Conduit, a Gear
  });
});
