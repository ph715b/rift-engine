import { describe, expect, it } from "vitest";
import { unitEntersReady } from "../src/engine/deploy.js";
import { isCardImplemented, partialImplementationNote, implementingModules } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import type { GameState } from "../src/model/game-state.js";
import { makeState, realUnitInstance, makeUnit } from "./fixtures.js";

/**
 * `[Level N][>] ... enter ready` — the second half of two cards whose first half
 * is a continuous Might aura in a domain file.
 *
 *   - **UNL-016 Scorchclaw**: "[Level 3][>] I have +1 Might **and enter ready**."
 *   - **UNL-191 Master Yi - Wuju Master**: "[Level 11][>] **Your units enter
 *     ready**."
 *
 * # Both halves were refused by name, and both refusals were right
 *
 * "I enter ready" is a REPLACEMENT for how a unit arrives (369.3), not a
 * readying. Three separate agents independently rejected faking it as an on-play
 * `readyUnit`, and `deploy.ts`'s own header records the three measured reasons:
 * the trigger is a held Chain Pending Item so the unit would sit EXHAUSTED
 * through the whole response window, it would fire `unitReadied` and pay out
 * Pirate's Haven for a readying the rules say never happened, and it would be
 * blockable by Mageseeker Warden.
 *
 * What none of them could do was edit `deploy.ts`, which is shared. The fix was
 * one `case` in `conditionalEntersReady` and one board query beside Magma Wurm's
 * — both shapes the file already had.
 *
 * # The two are deliberately in DIFFERENT places, and that is asserted here
 *
 * Scorchclaw is a property of the ARRIVING CARD, so it is a case keyed on defId.
 * Master Yi is a property of the CONTROLLER — every unit they play, whatever it
 * is — so keying it on the arrival would have meant one case per card in the
 * pool. Getting that backwards is the mistake this file is pointed at.
 *
 * # Live, not latched
 *
 * **824.1.b.1** makes `[Level N][>]` "functionally short for 'While you have [N]
 * or more XP, this card gains [Text]'", and **824.1.d** turns it Inactive "as
 * soon as the controlling player has less than [N] XP". So the XP is read at the
 * moment the unit arrives, and the boundary is asserted in both directions.
 */

const registry = defaultCardRegistry();

const SCORCHCLAW = "UNL-016";
const SCORCHCLAW_LEVEL = 3;
const MASTER_YI = "UNL-191";
const MASTER_YI_LEVEL = 11;
const PLAIN = "OGN-002"; // no [Level], no [Quick] — the control

/** A board with `xp` on player 0 and, optionally, a named Legend. */
function boardAt(xp: number, legendDefId?: string): GameState {
  const state = makeState({ phase: "Action", activePlayerIndex: 0 });
  state.players[0]!.xp = xp;
  if (legendDefId !== undefined) {
    state.players[0]!.legend = { ...state.players[0]!.legend, defId: legendDefId };
  }
  return state;
}

describe("Scorchclaw (UNL-016): [Level 3] — a property of the ARRIVING card", () => {
  it("enters READY at exactly 3 XP", () => {
    expect(unitEntersReady(boardAt(SCORCHCLAW_LEVEL), 0, realUnitInstance(SCORCHCLAW))).toBe(true);
  });

  it("...and EXHAUSTED at 2 — the boundary, in the other direction", () => {
    // 824.1.b.1 is "N or more", so this is the off-by-one that decides whether
    // the gate is `>=` or `>`.
    expect(unitEntersReady(boardAt(SCORCHCLAW_LEVEL - 1), 0, realUnitInstance(SCORCHCLAW))).toBe(false);
  });

  it("does not ready a DIFFERENT card at the same XP — it is keyed on him", () => {
    // The control that separates "Scorchclaw's clause works" from "high XP
    // readies everything", which would pass every assertion above.
    expect(unitEntersReady(boardAt(20), 0, realUnitInstance(PLAIN))).toBe(false);
  });

  it("reads the ARRIVING player's XP, not the opponent's", () => {
    const state = boardAt(0);
    state.players[1]!.xp = 20;
    expect(unitEntersReady(state, 0, realUnitInstance(SCORCHCLAW)), "he read the opponent's XP").toBe(false);
  });
});

describe("Master Yi - Wuju Master (UNL-191): [Level 11] — a property of the CONTROLLER", () => {
  it("readies ANY unit you play at 11 XP, not just one named card", () => {
    // The distinction from Scorchclaw, and the reason this is a board query
    // rather than a case: a plain unit with no [Level] of its own arrives ready.
    expect(unitEntersReady(boardAt(MASTER_YI_LEVEL, MASTER_YI), 0, realUnitInstance(PLAIN))).toBe(true);
  });

  it("...and not at 10 — the boundary", () => {
    expect(unitEntersReady(boardAt(MASTER_YI_LEVEL - 1, MASTER_YI), 0, realUnitInstance(PLAIN))).toBe(false);
  });

  it("needs Yi as the LEGEND — a different Legend at 20 XP readies nothing", () => {
    // Without this, "units enter ready at 11 XP" would pass on a build that had
    // stopped checking whose Legend it is.
    expect(unitEntersReady(boardAt(20, "OGN-001"), 0, realUnitInstance(PLAIN))).toBe(false);
  });

  it("is his CONTROLLER's aura — the opponent's units are unaffected", () => {
    // He sits in player 0's Legend slot; player 1 plays a unit and gets nothing.
    const state = boardAt(20, MASTER_YI);
    state.players[1]!.xp = 20;
    expect(unitEntersReady(state, 1, realUnitInstance(PLAIN)), "Yi readied the opponent's units").toBe(false);
  });

  it("a Legend is never the unit arriving, so there is no self-exclusion to get wrong", () => {
    // Contrast with Magma Wurm, whose aura must exclude the copy being played.
    // `PlayerState.legend` is its own slot and never appears in `baseUnits`, so a
    // second Yi cannot ready the first one's arrival — there is no arrival.
    const state = boardAt(MASTER_YI_LEVEL, MASTER_YI);
    expect(state.players[0]!.baseUnits.some((u) => u.defId === MASTER_YI), "a Legend leaked into baseUnits").toBe(false);
  });
});

describe("the two clauses do not interfere", () => {
  it("Scorchclaw still arrives exhausted below his own level under a sub-11 Yi", () => {
    // Both gates closed: 3 > xp and 11 > xp. A build that OR'd the two thresholds
    // together rather than pairing each with its own source would ready him here.
    expect(unitEntersReady(boardAt(2, MASTER_YI), 0, realUnitInstance(SCORCHCLAW))).toBe(false);
  });

  it("and the ordinary overrides still work — [Quick] needs no XP at all", () => {
    // The regression guard for the file as a whole: these two clauses were added
    // to a predicate that already had six, and an early return in the wrong place
    // would silence them.
    const quick = makeUnit({ name: "Quick One", keywords: { Quick: 1 } });
    expect(unitEntersReady(boardAt(0), 0, quick), "[Quick] stopped working").toBe(true);
  });
});

describe("coverage sees both halves of both cards", () => {
  it("each is whole, and reported by BOTH modules that implement it", () => {
    for (const defId of [SCORCHCLAW, MASTER_YI]) {
      expect(isCardImplemented(registry.get(defId)), `${defId} is still greyed`).toBe(true);
      expect(partialImplementationNote(registry.get(defId)), `${defId} still names a missing half`).toBeUndefined();
      // A card split across two modules must be visible from both, or the deck
      // builder greys something that works.
      expect(implementingModules(defId), `${defId} lost a registration`).toEqual(
        expect.arrayContaining(["effective-might", "play-card rules"]),
      );
    }
  });
});
