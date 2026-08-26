import { describe, expect, it, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import {
  allPresetDecks,
  beginFirstTurn,
  createCardInstance,
  dealOpeningHands,
  defaultCardRegistry,
  executeMulligan,
  legalActions,
  presetDeckList,
  submit,
} from "@rift-engine/engine";
import { createNewGame } from "../src/game-setup.js";
import type { MatchConfig } from "../src/game-setup.js";
import { GameBoard } from "../src/components/GameBoard.js";
import { HoverPreviewProvider } from "../src/hover-preview.js";
import { DragGhostProvider } from "../src/drag-ghost.js";
import { FloatingNumbers } from "../src/components/FloatingNumbers.js";
import { announcedPlay, unitsThatDied } from "../src/event-log.js";

/**
 * **The animation pass's DECISIONS.**
 *
 * Not the pixels. An assertion that a transform exists proves nothing about
 * whether the board feels right, and this suite has shipped that mistake before.
 * What is worth pinning is the set of rules that each prevent a specific bad
 * behaviour and all fail silently:
 *
 * - floating a number when a value goes DOWN → every Cleanup rains numbers, since
 *   damage clears and this-turn buffs expire;
 * - floating anything under reduced motion → the one setting that exists to stop
 *   exactly this;
 * - deriving deaths from the board rather than the events → impossible, and the
 *   reason the event stream was built.
 */

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const floaters = (c: HTMLElement) => c.querySelectorAll(".floating-number");

describe("floating numbers announce INCREASES only", () => {
  it("shows nothing when nothing has changed", () => {
    const { container } = render(<FloatingNumbers damage={0} mightThisTurn={0} reduced={false} />);
    expect(floaters(container), "a static card announced something").toHaveLength(0);
  });

  it("floats damage when it goes UP", () => {
    const { container, rerender } = render(<FloatingNumbers damage={0} mightThisTurn={0} reduced={false} />);
    rerender(<FloatingNumbers damage={3} mightThisTurn={0} reduced={false} />);

    expect(floaters(container), "damage was dealt and nothing said so").toHaveLength(1);
    expect(container.textContent, "the number does not read as damage").toContain("−3");
  });

  it("says nothing when damage goes DOWN", () => {
    // Damage clears at end of turn on every unit that has any. Announcing that
    // would put numbers on screen every single Cleanup, which is how a feedback
    // channel teaches a player to ignore it.
    const { container, rerender } = render(<FloatingNumbers damage={4} mightThisTurn={0} reduced={false} />);
    rerender(<FloatingNumbers damage={0} mightThisTurn={0} reduced={false} />);

    expect(floaters(container), "clearing damage announced itself").toHaveLength(0);
  });

  it("says nothing when a this-turn buff EXPIRES", () => {
    // Same shape, and it fires on the same Cleanup — a unit with +2 this turn
    // drops to 0 with nobody having done anything.
    const { container, rerender } = render(<FloatingNumbers damage={0} mightThisTurn={2} reduced={false} />);
    rerender(<FloatingNumbers damage={0} mightThisTurn={0} reduced={false} />);

    expect(floaters(container), "an expiring buff announced itself").toHaveLength(0);
  });

  it("shows damage and a buff TOGETHER when one exchange does both", () => {
    // They arrive from one action and must not hide each other — the component
    // queues rather than replaces, and offsets the second so they do not stack.
    const { container, rerender } = render(<FloatingNumbers damage={0} mightThisTurn={0} reduced={false} />);
    rerender(<FloatingNumbers damage={2} mightThisTurn={3} reduced={false} />);

    expect(floaters(container), "one of the two numbers was swallowed").toHaveLength(2);
  });

  it("does not let a SECOND hit erase the first", () => {
    /**
     * **The mutant that found a real bug.** "A new floater replaces the live
     * ones" survived the test above, because there both numbers arrive in one
     * effect run and are one batch. Two hits in one exchange — combat, then a
     * spell in the response window — are two runs, and the second must not
     * swallow the first; the player would see `−5` and never learn it was `−2`
     * and then `−3`.
     *
     * Writing it also caught the effect cancelling the previous batch's REMOVAL
     * timer on re-run, which parked the first number on the card permanently.
     *
     * **This assertion only means anything because the component dropped
     * `AnimatePresence`.** With it, a removed floater stays mounted while it
     * exits, so the count here was two whether the first number was still LIVE or
     * already discarded — and the replacing mutant survived. The exit was
     * redundant anyway (the rise ends at opacity 0), and without it the DOM is
     * exactly the live set.
     */
    const { container, rerender } = render(<FloatingNumbers damage={0} mightThisTurn={0} reduced={false} />);
    rerender(<FloatingNumbers damage={2} mightThisTurn={0} reduced={false} />);
    rerender(<FloatingNumbers damage={5} mightThisTurn={0} reduced={false} />);

    expect(floaters(container), "the second hit erased the first").toHaveLength(2);
    expect(container.textContent, "the first hit's number is gone").toContain("−2");
    expect(container.textContent, "the second hit read as a total, not as its own hit").toContain("−3");
  });

  it("clears BOTH hits away again, not just the last one", () => {
    // The half of the bug above that the count assertion cannot see: with the
    // effect cancelling the previous batch's removal timer, two floaters appear
    // correctly and then the first one never leaves — a number parked on the card
    // for the rest of the game.
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(<FloatingNumbers damage={0} mightThisTurn={0} reduced={false} />);
      rerender(<FloatingNumbers damage={2} mightThisTurn={0} reduced={false} />);
      rerender(<FloatingNumbers damage={5} mightThisTurn={0} reduced={false} />);
      expect(floaters(container), "nothing to clear — the setup did not float").toHaveLength(2);

      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(floaters(container), "a number was left parked on the card").toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("floats NOTHING under reduced motion", () => {
    const { container, rerender } = render(<FloatingNumbers damage={0} mightThisTurn={0} reduced={true} />);
    rerender(<FloatingNumbers damage={5} mightThisTurn={0} reduced={true} />);

    expect(floaters(container), "reduced motion still threw numbers around").toHaveLength(0);
  });
});

describe("deaths come from the EVENTS, which is the only place they exist", () => {
  it("finds nothing in a batch with no deaths", () => {
    const state = startedGame();
    const move = legalActions(state).find((a) => a.type === "MoveUnit");
    if (!move) return;
    expect(unitsThatDied(submit(state, move).events), "an ordinary move reported a death").toEqual([]);
  });

  it("reads the id off the event's own DeathContext", () => {
    // The unit is gone from the board by the time this is asked — which is the
    // whole reason `DeathContext` carries it (808.1.d.3: note its details before
    // it moves to the trash). A board lookup here would find nothing.
    const unit = createCardInstance(defaultCardRegistry().get("OGN-210"));
    const died = unitsThatDied([
      { kind: "unitDied", death: { unit, ownerIndex: 0 } } as never,
    ]);
    expect(died, "the death's own unit id was not recovered").toEqual([unit.instanceId]);
  });

  it("ignores every other event kind", () => {
    // The filter is the point. Without it a recall or a discard would animate as
    // a death, which is the exact confusion the event stream exists to end.
    expect(
      unitsThatDied([
        { kind: "beginningPhase", playerIndex: 0 },
        { kind: "mainPhaseStarted", playerIndex: 0 },
      ]),
    ).toEqual([]);
  });
});

describe("the opponent's play is held up; your own is not", () => {
  it("announces a play by the OTHER seat", () => {
    const state = startedGame();
    const played = state.players[1]!.hand[0]!;
    const play = announcedPlay(
      [{ kind: "cardPlayed", casterIndex: 1, playedInstanceId: played.instanceId } as never],
      state,
      0,
    );

    expect(play, "the opponent played a card and nothing was held up").not.toBeNull();
    expect(play!.card.instanceId, "a different card was announced").toBe(played.instanceId);
  });

  it("says NOTHING about your own play", () => {
    // You clicked it and watched it leave your hand. Holding it up again puts a
    // card in front of the board you are trying to act on.
    const state = startedGame();
    const mine = state.players[0]!.hand[0]!;
    expect(
      announcedPlay([{ kind: "cardPlayed", casterIndex: 0, playedInstanceId: mine.instanceId } as never], state, 0),
      "your own play was held up in front of you",
    ).toBeNull();
  });

  it("holds up the LAST play in the batch, not the first", () => {
    // One action can raise several — a play that triggers a cast. The most
    // recent is the one whose consequences the board is about to show.
    const state = startedGame();
    const [firstCard, secondCard] = state.players[1]!.hand;
    const play = announcedPlay(
      [
        { kind: "cardPlayed", casterIndex: 1, playedInstanceId: firstCard!.instanceId },
        { kind: "cardPlayed", casterIndex: 1, playedInstanceId: secondCard!.instanceId },
      ] as never,
      state,
      0,
    );

    expect(play!.card.instanceId, "an earlier play in the batch won").toBe(secondCard!.instanceId);
  });

  it("stays silent rather than holding up a BLANK where the card has gone", () => {
    // A countered or banished card can be nowhere by the time this is asked. An
    // empty frame in the middle of the board is worse than saying nothing.
    const state = startedGame();
    expect(
      announcedPlay([{ kind: "spellCast", casterIndex: 1, spellInstanceId: "card-gone" } as never], state, 0),
      "an unresolvable card was still announced",
    ).toBeNull();
  });

  it("finds a SPELL, which is already in the trash by now", () => {
    // The search has to include the trash: a Spell resolves and leaves before
    // anyone can be told about it, so the board it was on no longer holds it.
    const state = startedGame();
    const spell = state.players[1]!.hand[0]!;
    const inTrash: typeof state = {
      ...state,
      players: [
        state.players[0]!,
        { ...state.players[1]!, hand: [], trash: [...state.players[1]!.trash, spell] },
      ] as typeof state.players,
    };

    const play = announcedPlay(
      [{ kind: "spellCast", casterIndex: 1, spellInstanceId: spell.instanceId } as never],
      inTrash,
      0,
    );
    expect(play, "a cast spell could not be found to announce").not.toBeNull();
  });
});

describe("the announcer reaches a real board", () => {
  /**
   * **The unit tests above prove the DECISION; this proves it is wired.**
   * `announcedPlay` returning the right card is worth nothing if the board never
   * calls it, and the two failures look identical from the outside — this suite
   * has shipped exactly that once already.
   *
   * # The step size is load-bearing
   *
   * The announcement clears itself after `ANNOUNCE_MS`, so the 4-second advance
   * the other board drivers use would step straight over it and find nothing. It
   * advances in fractions of that window and checks after each step.
   */
  it("holds up a card once the AI has played one", () => {
    vi.useFakeTimers();
    const [first, second] = allPresetDecks();
    const config: MatchConfig = {
      humanDeck: presetDeckList(first!),
      aiDeck: presetDeckList(second ?? first!),
      format: "bo1",
    };
    const { container } = render(
      <HoverPreviewProvider>
        <DragGhostProvider>
          <GameBoard initialConfig={config} onMainMenu={() => {}} seed={5} />
        </DragGhostProvider>
      </HoverPreviewProvider>,
    );
    fireEvent.click(container.querySelector<HTMLButtonElement>("button.menu-primary-button")!);

    let sawAnnouncement = false;
    let aiPlayed = false;
    for (let i = 0; i < 160 && !sawAnnouncement; i += 1) {
      const pass = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => /^pass/i.test(b.textContent ?? "") && !b.disabled,
      );
      if (pass) fireEvent.click(pass);
      act(() => {
        vi.advanceTimersByTime(400);
      });
      if (container.querySelector(".play-announcer")) sawAnnouncement = true;
      // The control, sampled the same way: the header narrates the AI's latest
      // action, so a play by the AI shows up here whether or not it was
      // announced. Without it, "no announcer" and "the AI never played a card"
      // are the same result.
      if (/The AI (played|cast)/.test(container.querySelector(".header-ai-narration")?.textContent ?? "")) {
        aiPlayed = true;
      }
    }

    expect(aiPlayed, "the AI never played a card, so this test measures nothing").toBe(true);
    expect(sawAnnouncement, "the AI played a card and the board held up nothing").toBe(true);
  });
});

/** A live game, seeded — see game-log.test.tsx for why the pregame steps matter. */
function startedGame() {
  const [first, second] = allPresetDecks();
  const dealt = dealOpeningHands(
    createNewGame(
      { humanDeck: presetDeckList(first!), aiDeck: presetDeckList(second ?? first!), format: "bo1" },
      5,
    ),
  );
  return beginFirstTurn(
    executeMulligan(dealt, { type: "Mulligan", playerIndex: 0, setAsideInstanceIds: [] }),
  ).state;
}
