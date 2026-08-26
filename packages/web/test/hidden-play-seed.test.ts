import { describe, expect, it } from "vitest";
import {
  allPresetDecks,
  createCardInstance,
  defaultCardRegistry,
  legalActions,
  presetDeckList,
  type GameState,
  type PlayCardAction,
} from "@rift-engine/engine";
import { createNewGame } from "../src/game-setup.js";
import { unanimousPlayFields } from "../src/hidden-play-seed.js";

/**
 * **Tideturner played from hidden did nothing, and the engine was fine.**
 *
 * Reported from playtesting: *"tideturner doesn't seem to be working. Tideturner
 * was hidden at a bf, i click it and the target at the other battlefield then hit
 * pass focus, but the tideturner does not switch places."*
 *
 * Measured first: driven through `submit`, the swap happens exactly as printed —
 * the partner moves to Tideturner's battlefield and Tideturner takes its place.
 * So the board never submitted the play at all.
 *
 * `playHiddenCard` seeded its pending state with `{ card, payment,
 * fromHiddenBattlefieldId }`. **811.1.d.1 forces a hidden PERMANENT to the
 * battlefield it was hidden at**, so every enumerated candidate also carries
 * `destinationBattlefieldId` — and `matchesPending` compares that with
 * `?? BASE_ZONE_ID` on both sides, so it asked `"bf1" === "base"` and matched
 * nothing. The card stayed armed and Pass Focus did what it says.
 *
 * It needs hidden + PERMANENT + a real choice: a hidden Spell has no destination
 * and matches, and a single-candidate hidden card is played outright without ever
 * building a pending state.
 *
 * # Why this file tests unanimity rather than one field
 *
 * `GameBoard`'s own comment records this as the sixth "a dispatch hop dropped a
 * field" bug and names the previous ones. Seeding `destinationBattlefieldId`
 * specifically would fix Tideturner and leave the seventh to be found in play, so
 * the seed carries every field the candidates AGREE on — agreement means the
 * player has nothing to decide, disagreement is exactly what the flow asks about.
 *
 * The Tideturner case below is built from the REAL engine enumeration rather than
 * hand-written actions, because a hand-written pair would have been written to
 * match whatever the fix does. What makes the test worth anything is that the
 * candidate list comes from `legalActions`.
 */

const TIDETURNER = "OGN-199";
const registry = defaultCardRegistry();

/** Tideturner hidden at bf1, a friendly unit at bf2 — the reported board.
 *
 *  Built on a REAL `createNewGame` and then rewritten, the way every other web
 *  test here builds a board: a hand-assembled state would not be one the engine
 *  would ever enumerate against, and the candidate list is this file's whole
 *  point. */
function reportedBoard(): { state: GameState; tideId: string; hiddenAt: string; partnerAt: string } {
  const [first, second] = allPresetDecks();
  const started = createNewGame(
    { humanDeck: presetDeckList(first!), aiDeck: presetDeckList(second ?? first!), format: "bo1" },
    4242,
  );
  const tide = createCardInstance(registry.get(TIDETURNER));
  const body = (instanceId: string) => ({ ...createCardInstance(registry.get("OGN-210")), instanceId });

  const state: GameState = {
    ...started,
    phase: "Action",
    activePlayerIndex: 0,
    turnNumber: 3,
    battlefields: started.battlefields.map((bf, i) =>
      i === 0
        ? // I control bf1 and have a body there, so Cleanup does not remove the
          // facedown card (step 5 drops one at a battlefield its owner no longer
          // controls, which would make this test pass for the wrong reason).
          { ...bf, controllerId: "p1", units: { p1: [body("guard")] }, hiddenCards: [{ ownerIndex: 0, card: tide, hiddenOnTurn: 1 }] }
        : i === 1
          ? { ...bf, units: { p1: [body("partner")] } }
          : bf,
    ) as GameState["battlefields"],
  };
  // Read back rather than hard-coded: `createNewGame` names battlefields from
  // the decks it draws them from, so their ids are not the engine fixtures'.
  return { state, tideId: tide.instanceId, hiddenAt: state.battlefields[0]!.id, partnerAt: state.battlefields[1]!.id };
}

describe("unanimousPlayFields", () => {
  it("carries a field EVERY candidate agrees on", () => {
    const seed = unanimousPlayFields([
      { destinationBattlefieldId: "bf1", targetUnitInstanceId: "a" },
      { destinationBattlefieldId: "bf1" },
    ] as unknown as PlayCardAction[]);

    expect(seed.destinationBattlefieldId, "an agreed field was dropped — the Tideturner bug").toBe("bf1");
  });

  it("does NOT carry a field they disagree on — that is the player's choice", () => {
    const seed = unanimousPlayFields([
      { destinationBattlefieldId: "bf1", targetUnitInstanceId: "a" },
      { destinationBattlefieldId: "bf1" },
    ] as unknown as PlayCardAction[]);

    expect(seed.targetUnitInstanceId, "a choice was made for the player").toBeUndefined();
  });

  it("treats PRESENT-on-one and ABSENT-on-the-other as disagreement", () => {
    // "Aim it, or don't" is a real choice. If undefined counted as agreement the
    // seed would silently commit to the aimed variant.
    const seed = unanimousPlayFields([
      { targetUnitInstanceId: "a" },
      { targetUnitInstanceId: undefined },
    ] as unknown as PlayCardAction[]);

    expect(seed.targetUnitInstanceId).toBeUndefined();
  });

  it("never carries card, payment, type or playerIndex", () => {
    // Not choices, and the caller sets card/payment itself. Carrying `payment`
    // here would seed the FIRST candidate's payment over the resolved one.
    const seed = unanimousPlayFields([
      { type: "PlayCard", playerIndex: 0, card: { instanceId: "c" }, payment: { energyRunes: [] } },
      { type: "PlayCard", playerIndex: 0, card: { instanceId: "c" }, payment: { energyRunes: [] } },
    ] as unknown as PlayCardAction[]);

    expect(Object.keys(seed)).toEqual([]);
  });

  it("compares ARRAY fields by contents, not identity", () => {
    const seed = unanimousPlayFields([
      { targetUnitInstanceIds: ["a", "b"] },
      { targetUnitInstanceIds: ["a", "b"] },
    ] as unknown as PlayCardAction[]);

    expect(seed.targetUnitInstanceIds, "two equal lists read as disagreement").toEqual(["a", "b"]);
  });

  it("is empty for no candidates", () => {
    expect(unanimousPlayFields([])).toEqual({});
  });
});

describe("the reported Tideturner board, from the REAL enumeration", () => {
  it("every from-hidden candidate carries a destination, and they agree", () => {
    // The fact the seed was missing. If this ever goes false — a future card
    // whose from-hidden play really does offer a destination choice — the seed
    // correctly stops carrying it and the flow must ask, which is the behaviour
    // `unanimousPlayFields` already has.
    const { state, tideId, hiddenAt } = reportedBoard();
    const candidates = legalActions(state).filter(
      (a): a is PlayCardAction =>
        a.type === "PlayCard" && a.card.instanceId === tideId && a.fromHiddenBattlefieldId !== undefined,
    );

    expect(candidates.length, "the from-hidden play was not offered at all").toBeGreaterThan(1);
    expect(candidates.every((c) => c.destinationBattlefieldId === hiddenAt), "811.1.d.1 is not forcing one destination").toBe(true);
  });

  it("the seed built from them carries that destination", () => {
    const { state, tideId, hiddenAt } = reportedBoard();
    const candidates = legalActions(state).filter(
      (a): a is PlayCardAction =>
        a.type === "PlayCard" && a.card.instanceId === tideId && a.fromHiddenBattlefieldId !== undefined,
    );

    const seed = unanimousPlayFields(candidates);
    expect(seed.destinationBattlefieldId, "the reported bug: the seed loses the forced destination").toBe(hiddenAt);
    // ...and still leaves the actual choice open.
    expect(seed.targetUnitInstanceId, "the swap target was chosen for the player").toBeUndefined();
  });
});
