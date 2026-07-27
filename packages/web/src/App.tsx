import { useState } from "react";
import { MainMenu } from "./components/MainMenu.js";
import { Lobby } from "./components/Lobby.js";
import { GameBoard } from "./components/GameBoard.js";
import { HoverPreviewProvider } from "./hover-preview.js";
import { DragGhostProvider } from "./drag-ghost.js";
import type { MatchConfig } from "./game-setup.js";

type Screen = { type: "menu" } | { type: "lobby" } | { type: "game"; config: MatchConfig };

function CurrentScreen({ screen, setScreen }: { screen: Screen; setScreen: (s: Screen) => void }) {
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

export function App() {
  const [screen, setScreen] = useState<Screen>({ type: "menu" });

  return (
    <HoverPreviewProvider>
      <DragGhostProvider>
        <CurrentScreen screen={screen} setScreen={setScreen} />
      </DragGhostProvider>
    </HoverPreviewProvider>
  );
}
