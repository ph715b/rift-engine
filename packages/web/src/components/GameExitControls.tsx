import { useState } from "react";

interface GameExitControlsProps {
  /** Start the match over with the same decks and a fresh seed. */
  onRestart: () => void;
  /** Abandon the match and go back to the main menu. */
  onMainMenu: () => void;
}

/**
 * The two ways OUT of a match, available at every point in one.
 *
 * Reported by the project owner: *"I want to be able to restart the game or
 * leave to main menu."* Both existed and neither was reachable until the match
 * was already over — `onMainMenu` was wired only into `RematchPanel` (game over)
 * and `SeriesPanel` (between games of a Best of 3), and "Rematch (same decks)"
 * likewise. A player who started a match was **trapped in it**: the board had no
 * exit, and neither did the two pregame screens (`BattlefieldSelect`,
 * `MulliganScreen`), which return before the board renders at all.
 *
 * # One component, three surfaces
 *
 * All three of those screens draw the same `.header`, so this sits in it and the
 * behaviour cannot drift between them. Putting the buttons inline in each screen
 * would have been three copies of the confirm step — and the confirm step is the
 * part that must be identical, since it is what stands between a misclick and a
 * discarded match.
 *
 * # Why it confirms, and why inline rather than a modal
 *
 * Both actions destroy a match in progress and neither can be undone. A modal
 * would be the heavier answer and this board already has one overlay competing
 * for the screen (`ChoiceOverlay`, which deliberately swallows board clicks) —
 * a second one racing it during a pending decision is a worse failure than the
 * one being prevented. The inline two-step needs no new surface, no z-index, and
 * cannot appear over a question the player still has to answer.
 *
 * Cancel is rendered FIRST and the destructive action second, so the pointer
 * does not land on "yes" where it just clicked "Restart".
 */
export function GameExitControls({ onRestart, onMainMenu }: GameExitControlsProps) {
  const [confirming, setConfirming] = useState<"restart" | "menu" | null>(null);

  if (confirming !== null) {
    const isRestart = confirming === "restart";
    return (
      <span className="header-exit">
        <span className="header-exit-prompt">
          {isRestart ? "Restart the match?" : "Leave to the main menu?"} This game will be lost.
        </span>
        <button onClick={() => setConfirming(null)}>Cancel</button>
        <button
          className="header-exit-confirm"
          onClick={() => {
            // Cleared before the callback: `onRestart` keeps this component
            // mounted (the board rebuilds around it), so a confirm state left
            // set would greet the new game already asking to abandon it.
            setConfirming(null);
            if (isRestart) onRestart();
            else onMainMenu();
          }}
        >
          {isRestart ? "Restart" : "Main Menu"}
        </button>
      </span>
    );
  }

  return (
    <span className="header-exit">
      <button onClick={() => setConfirming("restart")}>Restart</button>
      <button onClick={() => setConfirming("menu")}>Main Menu</button>
    </span>
  );
}
