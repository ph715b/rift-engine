import { useState } from "react";
import { MainMenu } from "./components/MainMenu.js";
import { Lobby } from "./components/Lobby.js";
import { GameBoard } from "./components/GameBoard.js";
import type { MatchConfig } from "./game-setup.js";

type Screen = { type: "menu" } | { type: "lobby" } | { type: "game"; config: MatchConfig };

export function App() {
  const [screen, setScreen] = useState<Screen>({ type: "menu" });

  switch (screen.type) {
    case "menu":
      return <MainMenu onNewGame={() => setScreen({ type: "lobby" })} />;
    case "lobby":
      return (
        <Lobby
          onBack={() => setScreen({ type: "menu" })}
          onStartMatch={(config) => setScreen({ type: "game", config })}
        />
      );
    case "game":
      return <GameBoard initialConfig={screen.config} onMainMenu={() => setScreen({ type: "menu" })} />;
  }
}
