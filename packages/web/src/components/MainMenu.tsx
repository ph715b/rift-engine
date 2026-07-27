interface MainMenuProps {
  onNewGame: () => void;
}

export function MainMenu({ onNewGame }: MainMenuProps) {
  return (
    <div className="menu-screen">
      <h1>Rift-Engine</h1>
      <p className="menu-subtitle">A Riftbound rules engine, playable against an AI opponent.</p>
      <button className="menu-primary-button" onClick={onNewGame}>
        New Game
      </button>
    </div>
  );
}
