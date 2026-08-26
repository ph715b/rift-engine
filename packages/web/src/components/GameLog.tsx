import { useEffect, useRef } from "react";
import type { LogLine } from "../event-log.js";

interface GameLogProps {
  lines: LogLine[];
  open: boolean;
  onToggle: () => void;
  humanIndex: 0 | 1;
}

/**
 * **What just happened, in order.**
 *
 * The board reports STATE. Until the engine's events were surfaced there was no
 * way to see a sequence at all — and in a game with hidden cards, a chain, held
 * triggers and an AI opponent, the whole of the opponent's turn arrived as a
 * board that had silently changed. Several of this project's playtest reports
 * were "something didn't happen" written by someone who could not see what did.
 *
 * # It costs zero layout height, deliberately
 *
 * The board is height-constrained — `use-board-card-size` fits the whole game
 * into the window and a new row would shrink every card. So this is
 * `position: fixed` and mounted over the board rather than beside it, and the
 * toggle lives in the header where there is already a row.
 *
 * # Closed by default
 *
 * A log is a thing you consult, not a thing you watch. Open by default it would
 * cover a third of the board for the many turns where nothing surprising happens.
 * The button carries the line count so there is a reason to open it.
 */
export function GameLog({ lines, open, onToggle, humanIndex }: GameLogProps) {
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Newest is at the bottom, so an open log follows the game. Only while OPEN:
  // scrolling a hidden element is wasted work, and `scrollIntoView` on a
  // display:none node does nothing anyway.
  useEffect(() => {
    // **Feature-detected, not assumed.** `scrollIntoView` is not implemented by
    // jsdom and is absent from more hosts than one would guess; calling it
    // unguarded threw and took the whole board down with it. Following the log is
    // a convenience, and no convenience is worth a crash.
    const bottom = bottomRef.current;
    if (open && typeof bottom?.scrollIntoView === "function") bottom.scrollIntoView({ block: "end" });
  }, [open, lines.length]);

  return (
    <>
      <button
        className={`game-log-toggle${open ? " open" : ""}`}
        onClick={onToggle}
        title="What has happened this game"
        aria-expanded={open}
      >
        Log{lines.length > 0 ? ` (${lines.length})` : ""}
      </button>
      {open && (
        <aside className="game-log" aria-label="Game log">
          <div className="game-log-lines">
            {lines.length === 0 && <p className="game-log-empty">Nothing yet — the log fills as the game is played.</p>}
            {lines.map((line, i) => {
              // The turn number is printed only when it CHANGES, so a busy turn
              // reads as a block rather than as the same number repeated down the
              // margin.
              const showTurn = i === 0 || lines[i - 1]!.turn !== line.turn;
              const mine = line.actorIndex === humanIndex;
              const theirs = line.actorIndex !== null && line.actorIndex !== humanIndex;
              return (
                <div key={line.id} className="game-log-row">
                  <span className="game-log-turn">{showTurn ? `T${line.turn}` : ""}</span>
                  <span className={`game-log-text${mine ? " mine" : ""}${theirs ? " theirs" : ""}`}>{line.text}</span>
                </div>
              );
            })}
            <div ref={bottomRef} />
          </div>
        </aside>
      )}
    </>
  );
}
