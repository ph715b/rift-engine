interface MainMenuProps {
  onNewGame: () => void;
  /** The deck LIBRARY. This was `onBuildDeck` and went straight to the builder;
   *  it opens the manager now, which holds building alongside importing,
   *  editing, exporting and deleting. "Build a Deck" was the only door to any of
   *  those from here, and three of them had no door at all outside the lobby. */
  onManageDecks: () => void;
}

export function MainMenu({ onNewGame, onManageDecks }: MainMenuProps) {
  return (
    <div className="menu-screen">
      <h1>Rift-Engine</h1>
      <p className="menu-subtitle">A Riftbound rules engine, playable against an AI opponent.</p>
      <button className="menu-primary-button" onClick={onNewGame}>
        New Game
      </button>
      <button onClick={onManageDecks}>Manage Decks</button>
    </div>
  );
}
