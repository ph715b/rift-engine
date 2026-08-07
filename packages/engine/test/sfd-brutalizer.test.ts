import { describe, expect, it } from "vitest";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { isCardImplemented, partialImplementationNote } from "../src/engine/coverage.js";
import { attachEquipment, detachEquipment, equipMightBonusOf } from "../src/engine/equipment.js";
import { effectiveMight } from "../src/engine/effective-might.js";
import { runEnd } from "../src/engine/turn-manager.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, makeUnit, realGearInstance } from "./fixtures.js";

/**
 * Brutalizer (SFD-042) — "**If this was attached to me THIS TURN**, I have an
 * additional +2 Might."
 *
 * **ART-ONLY.** `text.plain` holds the `[Equip]` line and nothing else, which is
 * why this reported `isCardImplemented = true` while doing none of it. See
 * docs/sfd-equipment-abilities.md.
 *
 * # Why this was cheap, against a note that said otherwise
 *
 * The standing note called for "a per-attachment turn stamp on the gear" and the
 * card was on the do-not-do list for two sessions. But `equipment.ts` declares
 * itself the SINGLE WRITER of `attachedToInstanceId` — so a freshness flag is one
 * field written at one site, cleared at the other, and swept at `runEnd`.
 *
 * # The one real design point: a FLAG, not a turn number
 *
 * `turnNumber` counts ROUNDS — `runEnd` bumps it only when play wraps to the
 * first player — so both players' turns share one. A gear stamped with a turn
 * number would still read as fresh on the opponent's turn, which is the bug this
 * file's third test exists to catch.
 */

const registry = defaultCardRegistry();
const BRUTALIZER = "SFD-042";
const FRESH_BONUS = 2;
const GEARHEAD = "SFD-068"; // "your Equipment give double Might"

const combat = { isCombat: false } as const;

/** A wearer in p1's base with an unattached Brutalizer in p1's gear. */
function board(wearerDefId?: string): GameState {
  const state = makeState({ phase: "Action" });
  const wearer = makeUnit({ instanceId: "wearer", name: "Wearer", might: 3, ...(wearerDefId ? { defId: wearerDefId } : {}) });
  state.players[0]!.baseUnits = [wearer];
  state.players[0]!.activeGear = [{ ...realGearInstance(BRUTALIZER), instanceId: "brut", attachedToInstanceId: null }];
  return state;
}

const mightOf = (state: GameState): number =>
  effectiveMight(state, state.players[0]!.baseUnits[0]!, 0, combat);

describe("Brutalizer: +2 more on the turn it was attached", () => {
  it("gives the extra Might the turn it is attached", () => {
    const before = board();
    const bare = mightOf(before);

    const after = attachEquipment(before, 0, "brut", "wearer");

    expect(mightOf(after) - bare, "the fresh bonus is missing").toBe(equipMightBonusOf({ defId: BRUTALIZER }) + FRESH_BONUS);
  });

  it("loses the extra Might at end of turn, keeping the printed badge", () => {
    const attached = attachEquipment(board(), 0, "brut", "wearer");
    const fresh = mightOf(attached);

    const later = runEnd(attached);

    expect(mightOf(later), "the fresh bonus outlived its turn").toBe(fresh - FRESH_BONUS);
    // The printed badge is NOT what expired — it is continuous while attached.
    expect(mightOf(later) - 3, "the printed badge was lost too").toBe(equipMightBonusOf({ defId: BRUTALIZER }));
  });

  /**
   * **The load-bearing negative, and the reason this is a flag rather than a
   * turn number.** `runEnd` sweeps BOTH players, so a gear attached on player
   * 0's turn is stale by the time player 1 acts — even though `turnNumber` has
   * not moved, because it counts rounds.
   */
  it("is stale on the OPPONENT's turn, which shares a turnNumber", () => {
    const attached = attachEquipment(board(), 0, "brut", "wearer");
    const opponentsTurn = runEnd(attached);

    expect(opponentsTurn.turnNumber, "the fixture no longer shares a round").toBe(attached.turnNumber);
    expect(opponentsTurn.activePlayerIndex, "the turn did not pass").not.toBe(attached.activePlayerIndex);
    expect(
      opponentsTurn.players[0]!.activeGear[0]!.attachedThisTurn,
      "freshness survived into the opponent's turn",
    ).toBeUndefined();
  });

  it("clears freshness when detached, so a re-attach next turn is not stale", () => {
    const attached = attachEquipment(board(), 0, "brut", "wearer");
    const detached = detachEquipment(attached, 0, "brut");

    expect(detached.players[0]!.activeGear[0]!.attachedThisTurn, "a detached gear stayed fresh").toBeUndefined();
    expect(mightOf(detached), "detaching left Might behind").toBe(3);
  });

  /** Inside the same reduce as the printed badge, so an aura reading "your
   *  Equipment" reaches it — splitting it out would silently exempt one card. */
  it("is doubled by Gearhead, like every other Equipment bonus", () => {
    const plain = attachEquipment(board(), 0, "brut", "wearer");
    const gearhead = attachEquipment(board(GEARHEAD), 0, "brut", "wearer");

    const plainBonus = mightOf(plain) - 3;
    const doubledBonus = mightOf(gearhead) - 3;
    expect(doubledBonus, "Gearhead did not double the fresh bonus").toBe(plainBonus * 2);
  });

  it("gives nothing to a unit wearing an unattached Brutalizer", () => {
    expect(mightOf(board()), "an unattached gear granted Might").toBe(3);
  });

  it("is claimed by a module and its art-only note is gone", () => {
    expect(isCardImplemented(registry.get(BRUTALIZER)), "SFD-042 is not reported implemented").toBe(true);
    expect(partialImplementationNote(registry.get(BRUTALIZER)), "the note outlived its clause").toBeUndefined();
  });
});
