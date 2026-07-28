interface MainMenuProps {
  onNewGame: () => void;
  onBuildDeck: () => void;
}

export function MainMenu({ onNewGame, onBuildDeck }: MainMenuProps) {
  return (
    <div className="menu-screen">
      <h1>Rift-Engine</h1>
      <p className="menu-subtitle">A Riftbound rules engine, playable against an AI opponent.</p>
      <button className="menu-primary-button" onClick={onNewGame}>
        New Game
      </button>
      <button onClick={onBuildDeck}>Build a Deck</button>
    </div>
  );
}
