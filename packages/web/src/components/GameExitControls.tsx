import { useState } from "react";

type ExitAction = "restart" | "menu" | "concede";

interface GameExitControlsProps {
  /** Start the match over with the same decks and a fresh seed. */
  onRestart: () => void;
  /** Abandon the match and go back to the main menu. */
  onMainMenu: () => void;
  /**
   * Concede the game in progress — **650**, "A player may concede at any time",
   * and **651.1**, the remaining player wins.
   *
   * Absent when there is nothing to concede: the pregame screens have no game
   * yet, and a finished one is already lost or won. The button is not rendered in
   * that case rather than rendered disabled — a control that is present but inert
   * invites the click it will ignore.
   */
  onConcede?: () => void;
  /**
   * True in a Best of 3 with games still to play, which changes what conceding
   * COSTS and therefore what the prompt must say.
   *
   * **Tournament 410.1 and 410.2 are two different acts** — "any player may
   * concede that game" and "any player may concede that match" — and a prompt
   * that says "this game will be lost" when the whole match ends would be a lie
   * at the one moment a player needs the truth.
   */
  concedeEndsGameOnly?: boolean;
}

/**
 * The ways OUT of a match, available at every point in one.
 *
 * Reported by the project owner: *"I want to be able to restart the game or
 * leave to main menu."* Both existed and neither was reachable until the match
 * was already over — `onMainMenu` was wired only into `RematchPanel` (game over)
 * and `SeriesPanel` (between games of a Best of 3), and "Rematch (same decks)"
 * likewise. A player who started a match was **trapped in it**: the board had no
 * exit, and neither did the two pregame screens (`BattlefieldSelect`,
 * `MulliganScreen`), which return before the board renders at all.
 *
 * **Concede joined them on 2026-08-26**, and it is a different thing from both.
 * Restart and Main Menu abandon a match; conceding LOSES a game, which is a move
 * in it. **650** allows it at any time and **651.1** hands the win to the player
 * remaining, so a conceded game reaches the board's ordinary game-over path with
 * the opponent as winner — the series score, 407.4's loser-goes-first tracking
 * and the between-games panel all work unchanged.
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
 * All three actions destroy something in progress and none can be undone. A modal
 * would be the heavier answer and this board already has one overlay competing
 * for the screen (`ChoiceOverlay`, which deliberately swallows board clicks) —
 * a second one racing it during a pending decision is a worse failure than the
 * one being prevented. The inline two-step needs no new surface, no z-index, and
 * cannot appear over a question the player still has to answer.
 *
 * Cancel is rendered FIRST and the destructive action second, so the pointer
 * does not land on "yes" where it just clicked "Restart".
 */
export function GameExitControls({
  onRestart,
  onMainMenu,
  onConcede,
  concedeEndsGameOnly = false,
}: GameExitControlsProps) {
  const [confirming, setConfirming] = useState<ExitAction | null>(null);

  if (confirming !== null) {
    // Each prompt names what is actually lost. "This game will be lost" is true
    // of a restart and of leaving; for a concession in a Best of 3 it is the
    // whole point, and in a Best of 1 it ends the match — so that one says which.
    const prompt: Record<ExitAction, string> = {
      restart: "Restart the match? This game will be lost.",
      menu: "Leave to the main menu? This game will be lost.",
      concede: concedeEndsGameOnly
        ? "Concede this game? Your opponent wins it, and the match continues."
        : "Concede? Your opponent wins the match.",
    };
    const label: Record<ExitAction, string> = { restart: "Restart", menu: "Main Menu", concede: "Concede" };
    const act: Record<ExitAction, () => void> = { restart: onRestart, menu: onMainMenu, concede: onConcede ?? (() => {}) };

    return (
      <span className="header-exit">
        <span className="header-exit-prompt">{prompt[confirming]}</span>
        <button onClick={() => setConfirming(null)}>Cancel</button>
        <button
          className="header-exit-confirm"
          onClick={() => {
            // Cleared before the callback: `onRestart` keeps this component
            // mounted (the board rebuilds around it), so a confirm state left
            // set would greet the new game already asking to abandon it.
            const chosen = confirming;
            setConfirming(null);
            act[chosen]();
          }}
        >
          {label[confirming]}
        </button>
      </span>
    );
  }

  return (
    <span className="header-exit">
      {/* Concede first: it is the in-game move, and the two that abandon the
          match belong together at the end. */}
      {onConcede && <button onClick={() => setConfirming("concede")}>Concede</button>}
      <button onClick={() => setConfirming("restart")}>Restart</button>
      <button onClick={() => setConfirming("menu")}>Main Menu</button>
    </span>
  );
}
