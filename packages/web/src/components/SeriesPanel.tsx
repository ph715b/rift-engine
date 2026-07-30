interface SeriesPanelProps {
  didHumanWinGame: boolean;
  humanGameWins: number;
  aiGameWins: number;
  /** How many game wins take the match — 2 in a Best of 3. */
  winsNeeded: number;
  onNextGame: () => void;
  onMainMenu: () => void;
}

/**
 * Shown between games of a Best of 3, when a GAME has been decided but the
 * MATCH hasn't. Rule 487.4: "The winner of that game earns One Game Win.
 * Players then reset the game state, remove the Battlefields in play from the
 * game, choose new Battlefields from those set aside, and play again."
 *
 * Deliberately a separate surface from RematchPanel rather than a mode of it:
 * RematchPanel's whole job is offering to start something new (rematch, swap
 * decks), and none of that applies mid-match — the only forward move here is the
 * next game of the match you're already in. Offering "Rematch (same decks)" at
 * 1–0 would quietly discard the series.
 */
export function SeriesPanel({
  didHumanWinGame,
  humanGameWins,
  aiGameWins,
  winsNeeded,
  onNextGame,
  onMainMenu,
}: SeriesPanelProps) {
  const leader =
    humanGameWins === aiGameWins
      ? "The match is level"
      : humanGameWins > aiGameWins
        ? "You lead the match"
        : "The AI leads the match";

  return (
    <div className="rematch-panel">
      <div className="banner">
        {didHumanWinGame ? "You win the game." : "The AI wins the game."}
        <span className="series-score">
          {" "}
          {humanGameWins}–{aiGameWins}
        </span>
      </div>
      <div className="series-note">
        {leader}. First to {winsNeeded} game wins takes it. The battlefields just played are out for the rest of the match.
      </div>
      <div className="actions">
        <button onClick={onMainMenu}>Main Menu</button>
        <button className="menu-primary-button" onClick={onNextGame}>
          Next game
        </button>
      </div>
    </div>
  );
}
