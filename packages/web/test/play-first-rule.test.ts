import { describe, expect, it } from "vitest";
import {
  chosenFirstPlayer,
  createNewGame,
  playFirstDecision,
  PREFERS_TO_PLAY_FIRST,
  type MatchConfig,
  type PreviousGame,
} from "../src/game-setup.js";
import { allPresetDecks, presetDeckList } from "@rift-engine/engine";

/**
 * **Tournament rule 407, the "Play First Rule".**
 *
 * The Tournament Rules are a SECOND source and win where they differ — **104.1**:
 * "In some cases, information in this document may contradict, or provide
 * information not contained in, the Riftbound Core Rules. In all such cases,
 * this document takes precedence." Core Rules 115 offers only "determine Turn
 * Order using any fair random method", and this app rolled for every game of a
 * match, including games 2 and 3 of a Best of 3.
 *
 * **407.4**: "For games after the first game of a match, the loser of the
 * previous game gets to choose if they play first or last. If the previous game
 * was a draw, the starting play from the previous game is maintained."
 *
 * # Why these tests live here and not against GameBoard
 *
 * `GameBoard` builds its own game from a `MatchConfig` and cannot be handed a
 * prepared state, and a previous attempt at render tests against it measured
 * nothing. So the RULE lives in `game-setup.ts` as pure functions and the
 * component only renders their answer — which is what makes it testable at all.
 */

const [first, second] = allPresetDecks();
const config: MatchConfig = {
  humanDeck: presetDeckList(first!),
  aiDeck: presetDeckList(second ?? first!),
  format: "bo3",
};

const HUMAN = 0 as const;
const AI = 1 as const;

describe("407.1: the first game of a match", () => {
  it("has no chooser — the turn order is rolled", () => {
    expect(playFirstDecision(undefined)).toEqual({ chooser: null });
  });

  it("so createNewGame still rolls, and the same seed still replays identically", () => {
    // The compatibility guarantee. Every existing seed, every Best of 1, and
    // game 1 of every match must produce exactly the board they did before 407
    // existed — the override is absent on all of those paths.
    const a = createNewGame(config, 12345);
    const b = createNewGame(config, 12345);
    expect(a.firstPlayerIndex).toBe(b.firstPlayerIndex);
  });

  it("and the roll really can produce EITHER seat — otherwise 'rolled' is a lie", () => {
    // The positive control. A roll hardcoded to 0 would pass every other test in
    // this file, and that is exactly the bug the roll itself was added to fix.
    const seen = new Set<number>();
    for (let seed = 0; seed < 40; seed += 1) seen.add(createNewGame(config, seed).firstPlayerIndex);
    expect(seen, "the turn-order roll never produced one of the two seats").toEqual(new Set([0, 1]));
  });
});

describe("407.4: the loser of the previous game chooses", () => {
  it("names the HUMAN when the human lost", () => {
    const previous: PreviousGame = { loserIndex: HUMAN, firstPlayerIndex: AI };
    expect(playFirstDecision(previous)).toEqual({ chooser: HUMAN });
  });

  it("names the AI when the AI lost", () => {
    const previous: PreviousGame = { loserIndex: AI, firstPlayerIndex: HUMAN };
    expect(playFirstDecision(previous)).toEqual({ chooser: AI });
  });

  it("reads the LOSER, not the previous turn order", () => {
    // The two fields are independent, and a implementation that returned
    // `firstPlayerIndex` — or its opposite — would pass both tests above by
    // coincidence on the fixtures they use. Here the loser and the previous
    // first player are the SAME seat, so the two readings come apart.
    const previous: PreviousGame = { loserIndex: HUMAN, firstPlayerIndex: HUMAN };
    expect(playFirstDecision(previous).chooser).toBe(HUMAN);
  });
});

describe("407.4: a DRAW maintains the previous game's starting play", () => {
  it("has no chooser and carries the order forward", () => {
    expect(playFirstDecision({ loserIndex: null, firstPlayerIndex: AI })).toEqual({
      chooser: null,
      carriedFirstPlayerIndex: AI,
    });
  });

  it("carries the OTHER order too — it is the previous game's, not a constant", () => {
    expect(playFirstDecision({ loserIndex: null, firstPlayerIndex: HUMAN }).carriedFirstPlayerIndex).toBe(HUMAN);
  });

  it("is distinguishable from game 1, which carries nothing", () => {
    // Both have `chooser: null`, and the caller branches on the carried value —
    // so "no chooser" alone must not be read as "roll it".
    expect(playFirstDecision(undefined).carriedFirstPlayerIndex).toBeUndefined();
    expect(playFirstDecision({ loserIndex: null, firstPlayerIndex: AI }).carriedFirstPlayerIndex).toBeDefined();
  });
});

describe("what a chooser takes", () => {
  it("gives the chooser the seat the measurement prefers", () => {
    // Asserted against the constant rather than against a hardcoded seat, so
    // this test states the RULE (the chooser gets what they want) and stays
    // correct if the measurement ever flips it.
    expect(chosenFirstPlayer(HUMAN)).toBe(PREFERS_TO_PLAY_FIRST ? HUMAN : AI);
    expect(chosenFirstPlayer(AI)).toBe(PREFERS_TO_PLAY_FIRST ? AI : HUMAN);
  });

  it("is symmetric — the two seats get mirror answers", () => {
    expect(chosenFirstPlayer(HUMAN)).not.toBe(chosenFirstPlayer(AI));
  });
});

describe("the decision reaches the board", () => {
  it("createNewGame honours an explicit first player, both ways", () => {
    // The half that matters: a decision the setup ignores is a decision that
    // does not exist. Both values, because a function that returned its
    // argument's seat only for 0 would pass a single-value check.
    expect(createNewGame(config, 777, undefined, HUMAN).firstPlayerIndex).toBe(HUMAN);
    expect(createNewGame(config, 777, undefined, AI).firstPlayerIndex).toBe(AI);
  });

  it("and the override drives the whole opening, not just the field", () => {
    // `firstPlayerIndex` is read by the turn rotation, focus and chain priority.
    // Asserting only the field would pass on a state that stamped it and then
    // opened the game on the other seat.
    const game = createNewGame(config, 888, undefined, AI);
    expect(game.activePlayerIndex).toBe(AI);
    expect(game.focusHolder).toBe(AI);
    expect(game.chainPriority).toBe(AI);
  });

  it("overrides the roll even on a seed that would have rolled the other way", () => {
    // Without this the tests above could pass by agreeing with the roll.
    const rolled = createNewGame(config, 12345).firstPlayerIndex;
    const other: 0 | 1 = rolled === 0 ? 1 : 0;
    expect(createNewGame(config, 12345, undefined, other).firstPlayerIndex).toBe(other);
  });
});
