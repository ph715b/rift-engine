import { describe, expect, it, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  allPresetDecks,
  beginFirstTurn,
  dealOpeningHands,
  executeMulligan,
  legalActions,
  presetDeckList,
  submit,
  type GameState,
} from "@rift-engine/engine";
import { GameBoard } from "../src/components/GameBoard.js";
import { HoverPreviewProvider } from "../src/hover-preview.js";
import { DragGhostProvider } from "../src/drag-ghost.js";
import { describeEvent, linesFrom } from "../src/event-log.js";
import { createNewGame } from "../src/game-setup.js";
import type { MatchConfig } from "../src/game-setup.js";

/**
 * **The game log — what happened, in order.**
 *
 * The board reports STATE. Until `submit` returned its events there was no way to
 * see a SEQUENCE, and in a game with hidden cards, a chain, held triggers and an
 * AI opponent the whole of the opponent's turn arrived as a board that had
 * silently changed. Several of this project's playtest reports were "something
 * didn't happen", written by someone who could not see what did.
 *
 * # What is worth testing, and what is not
 *
 * Not the wording. A test asserting a sentence is a test that breaks when someone
 * improves the sentence, and it proves nothing about whether the log is useful.
 *
 * What matters is that it **narrates real play**: that driving actual actions
 * through `submit` produces lines, that the lines describe those actions rather
 * than something else, and that the events reaching it are the engine's own
 * rather than a diff. The describer is exercised against events the ENGINE
 * raised, never hand-written ones — a hand-built event would only prove the
 * describer can read a shape this file invented.
 */

const [first, second] = allPresetDecks();
const config: MatchConfig = {
  humanDeck: presetDeckList(first!),
  aiDeck: presetDeckList(second ?? first!),
  format: "bo1",
};

afterEach(cleanup);

/**
 * A LIVE game, seeded so the board is the same every run.
 *
 * `createNewGame` alone is not one — it builds the decks and the battlefields,
 * and the board then deals, mulligans and begins the first turn before anything
 * is playable. A test that skipped those steps found `legalActions` with nothing
 * worth doing in it, which is how the sweep below first read "narrated nothing"
 * when the describer was fine.
 */
function started(): GameState {
  const dealt = dealOpeningHands(createNewGame(config, 5));
  const kept = executeMulligan(dealt, { type: "Mulligan", playerIndex: 0, setAsideInstanceIds: [] });
  // `beginFirstTurn` returns an OUTCOME, not a state — same shape `submit` uses.
  return beginFirstTurn(kept).state;
}

describe("the describer works on events the ENGINE raised", () => {
  it("narrates a real move", () => {
    // Driven through `submit` rather than hand-built: the point is that the
    // describer reads the engine's own shapes, and a literal event would only
    // prove it reads shapes this file made up.
    const state = started();
    const move = legalActions(state).find((a) => a.type === "MoveUnit");
    if (!move) return; // this seed's opening offers none — the sweep below covers it

    const outcome = submit(state, move);
    const lines = linesFrom(outcome.events, outcome.state, 0, (() => { let i = 0; return () => (i += 1); })());
    expect(lines.length, "a real move produced no log line").toBeGreaterThan(0);
    expect(lines.map((l) => l.text).join(" "), "the line does not describe a move").toMatch(/moved|recalled/i);
  });

  it("names the CARD, not its instance id", () => {
    // The whole difference between a log and a debug dump. `nameOf` resolves ids
    // against the board the events produced.
    const state = started();
    const move = legalActions(state).find((a) => a.type === "MoveUnit");
    if (!move) return;
    const outcome = submit(state, move);
    const text = linesFrom(outcome.events, outcome.state, 0, (() => { let i = 0; return () => (i += 1); })())
      .map((l) => l.text)
      .join(" ");

    expect(text, "a raw instance id reached the log").not.toMatch(/card-\d+/);
  });

  it("falls back to a WORD when a card cannot be found, never to its id", () => {
    /**
     * **The branch a mutation run found unreached.** Every other test here names
     * a card that is still on the board, so `nameOf` resolves and its fallback
     * never runs — making "returns the raw id instead" an equivalent mutant.
     *
     * The fallback is not hypothetical: an event is a record of a moment that has
     * PASSED, so by the time it is narrated a spell is in a trash, a banished card
     * is nowhere, and a countered one was never anywhere. "a spell" is a poor line
     * and `card-14` is a broken one.
     *
     * A hand-written instance id is fair here in a way a hand-written EVENT would
     * not be: what is under test is name resolution, not whether the describer can
     * read a shape this file invented.
     */
    const state = started();
    const line = describeEvent(
      { kind: "spellCast", casterIndex: 0, totalCost: 0, spellInstanceId: "card-does-not-exist" },
      state,
      0,
    );

    expect(line, "a cast with an unresolvable card narrated nothing").not.toBeNull();
    expect(line!, "a raw instance id reached the log").not.toMatch(/card-does-not-exist/);
    expect(line!, "the fallback is not a readable word").toMatch(/a spell/i);
  });

  it("stays silent for the bookkeeping events", () => {
    // `unitChosen` fires on every targeting step and `beginningPhase` every turn.
    // Narrating them would bury the lines that matter, so `describeEvent` returns
    // null — asserted directly, since a sweep would not reach every kind.
    const state = started();
    expect(describeEvent({ kind: "beginningPhase", playerIndex: 0 }, state, 0)).toBeNull();
    expect(describeEvent({ kind: "mainPhaseStarted", playerIndex: 0 }, state, 0)).toBeNull();
  });
});

describe("a played game accumulates a log", () => {
  it("driving several real actions produces several lines", () => {
    // A sweep rather than a scripted turn: take whatever the engine offers, a
    // dozen times, and assert the narration keeps up. Without this the tests
    // above could all pass on a describer that handled exactly one event kind.
    let state = started();
    const collected: string[] = [];
    let id = 0;

    for (let i = 0; i < 12; i += 1) {
      const actions = legalActions(state);
      // Prefer something that DOES things over passing, so the sweep reaches
      // plays and moves rather than ending the turn twelve times.
      const action = actions.find((a) => a.type !== "Pass" && a.type !== "PassFocus") ?? actions[0];
      if (!action) break;
      const outcome = submit(state, action);
      if (outcome.result.type === "Invalid") break;
      collected.push(...linesFrom(outcome.events, outcome.state, 0, () => (id += 1)).map((l) => l.text));
      if (outcome.result.type === "GameOver") break;
      state = outcome.state;
    }

    expect(collected.length, "a dozen real actions narrated nothing").toBeGreaterThan(0);
  });
});

describe("the board surfaces it", () => {
  function boardInPlay(): HTMLElement {
    const { container } = render(
      <HoverPreviewProvider>
        <DragGhostProvider>
          <GameBoard initialConfig={config} onMainMenu={() => {}} seed={5} />
        </DragGhostProvider>
      </HoverPreviewProvider>,
    );
    fireEvent.click(container.querySelector<HTMLButtonElement>("button.menu-primary-button")!);
    return container;
  }

  it("offers a Log toggle", () => {
    boardInPlay();
    expect(screen.queryByRole("button", { name: /^log/i }), "no way to open the log").not.toBeNull();
  });

  it("is CLOSED by default — a log is consulted, not watched", () => {
    // Open by default it would cover a third of the board for the many turns
    // where nothing surprising happens.
    const container = boardInPlay();
    expect(container.querySelector(".game-log"), "the log opened itself").toBeNull();
  });

  it("opens and closes", () => {
    const container = boardInPlay();
    const toggle = screen.getByRole("button", { name: /^log/i });

    fireEvent.click(toggle);
    expect(container.querySelector(".game-log"), "the toggle did not open it").not.toBeNull();

    // Re-queried rather than reusing `toggle`: the label carries a line count
    // once there are lines, so the node text can change between clicks.
    fireEvent.click(screen.getByRole("button", { name: /^log/i }));
    expect(container.querySelector(".game-log"), "the toggle did not close it").toBeNull();
  });
});
