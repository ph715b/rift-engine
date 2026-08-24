interface SeriesPanelProps {
  didHumanWinGame: boolean;
  humanGameWins: number;
  aiGameWins: number;
  /** How many game wins take the match — 2 in a Best of 3. */
  winsNeeded: number;
  /**
   * **Tournament rule 407.4** — "the loser of the previous game gets to choose
   * if they play first or last". True when that loser is the human, so the two
   * turn-order buttons replace the single "Next game".
   *
   * Passed in rather than derived from `didHumanWinGame` here, even though they
   * are the same fact today: the rule is about the LOSER and this panel is about
   * a game result, and a draw (407.4's other branch) is a loss for nobody. One
   * place decides — `game-setup.playFirstDecision` — and this only renders it.
   */
  humanChoosesTurnOrder: boolean;
  /** What the AI chose, when it was the one choosing — shown so the turn order
   *  is never a surprise the player discovers on turn one. */
  aiChoseToPlayFirst?: boolean;
  onNextGame: (humanPlaysFirst?: boolean) => void;
  onMainMenu: () => void;
}

/**
 * Shown between games of a Best of 3, when a GAME has been decided but the
 * MATCH hasn't. Rule 486.6: "The winner of that game earns One Game Win.
 * Players then reset the game state, remove the Battlefields in play from the
 * game, choose new Battlefields from those set aside, and play again."
 *
 * Deliberately a separate surface from RematchPanel rather than a mode of it:
 * RematchPanel's whole job is offering to start something new (rematch, swap
 * decks), and none of that applies mid-match — the only forward move here is the
 * next game of the match you're already in. Offering "Rematch (same decks)" at
 * 1–0 would quietly discard the series.
 *
 * **It is also where tournament rule 407.4's turn-order choice is made**, rather
 * than on a screen of its own. The loser is already looking at this panel and
 * the choice is the same click that starts the next game, so a separate step
 * would be a screen whose only content is one binary question.
 */
export function SeriesPanel({
  didHumanWinGame,
  humanGameWins,
  aiGameWins,
  winsNeeded,
  humanChoosesTurnOrder,
  aiChoseToPlayFirst,
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
      {humanChoosesTurnOrder ? (
        <div className="series-note">
          You lost that game, so you choose the turn order for the next one.
        </div>
      ) : aiChoseToPlayFirst !== undefined ? (
        <div className="series-note">
          The AI lost that game, so it chose to play {aiChoseToPlayFirst ? "first" : "last"}.
        </div>
      ) : null}
      <div className="actions">
        <button onClick={onMainMenu}>Main Menu</button>
        {humanChoosesTurnOrder ? (
          <>
            <button onClick={() => onNextGame(false)}>Play last</button>
            <button className="menu-primary-button" onClick={() => onNextGame(true)}>
              Play first
            </button>
          </>
        ) : (
          <button className="menu-primary-button" onClick={() => onNextGame()}>
            Next game
          </button>
        )}
      </div>
    </div>
  );
}
