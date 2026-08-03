import { describe, expect, it } from "vitest";
import { createCardInstance, defaultCardRegistry } from "@rift-engine/engine";
import type { PlayCardAction } from "@rift-engine/engine";
import { matchesPendingChoices, xAmountOf } from "../src/pending-match.js";

/**
 * An X-cost card's variants differ ONLY by `xAmount`.
 *
 * Reported from playtesting: "I recycled 5 runes when casting Bullet Time but it
 * didn't seem to do any damage." The engine fans out one candidate per
 * affordable X and prices each correctly — the BOARD could not tell them apart,
 * because the field was never in `matchesPending`'s comparison. With several
 * candidates looking identical it resolved to the first, which is X = 0: the
 * card cast, the runes went, and it dealt nothing.
 *
 * The sixth dropped-field incident in this project, and the same shape every
 * time — a field that exists on the action, is enumerated and is validated, but
 * gets lost on one hop.
 */

const registry = defaultCardRegistry();
const BULLET_TIME = "OGN-268";

const action = (xAmount: number | undefined): PlayCardAction => ({
  type: "PlayCard",
  playerIndex: 0,
  card: createCardInstance(registry.get(BULLET_TIME)),
  payment: { energyRunes: [], powerRunes: [] },
  ...(xAmount === undefined ? {} : { xAmount }),
});

describe("matching an armed play against its candidates", () => {
  it("tells two X variants apart", () => {
    // The bug, stated directly: without an xAmount comparison these two are
    // indistinguishable and the board takes whichever came first.
    expect(matchesPendingChoices(action(5), { xAmount: 5 })).toBe(true);
    expect(matchesPendingChoices(action(0), { xAmount: 5 })).toBe(false);
  });

  it("treats a chosen X of 0 as a real choice, not as 'unset'", () => {
    // "Any amount" includes none, so 0 is a legal X and must not be confused
    // with "the player has not chosen yet".
    expect(matchesPendingChoices(action(0), { xAmount: 0 })).toBe(true);
    expect(matchesPendingChoices(action(3), { xAmount: 0 })).toBe(false);
  });

  it("ignores X for a card that has none", () => {
    // Every other card in the pool has no xAmount on either side; the comparison
    // must be a no-op there rather than refusing everything.
    expect(matchesPendingChoices(action(undefined), {})).toBe(true);
  });

  it("reads the chosen X back for the payment step", () => {
    expect(xAmountOf({ xAmount: 4 })).toBe(4);
    expect(xAmountOf({})).toBeUndefined();
  });
});
