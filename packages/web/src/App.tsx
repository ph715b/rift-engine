import { useState } from "react";
import type { DeckList } from "@rift-engine/engine";
import { MainMenu } from "./components/MainMenu.js";
import { Lobby } from "./components/Lobby.js";
import { DeckBuilder } from "./components/DeckBuilder.js";
import { GameBoard } from "./components/GameBoard.js";
import { HoverPreviewProvider } from "./hover-preview.js";
import { DragGhostProvider } from "./drag-ghost.js";
import type { MatchConfig } from "./game-setup.js";

type Screen =
  | { type: "menu" }
  | { type: "lobby" }
  // returnTo: the deck builder is reachable both from the main menu (build
  // in isolation, no match being set up) and from Lobby's inline "Edit"
  // button (tweak a deck while setting up a match) — it needs to know which
  // one to bounce back to on Save/Cancel rather than assuming either.
  | { type: "deckBuilder"; initialDeck?: DeckList; unresolvedNames?: string[]; returnTo: "menu" | "lobby" }
  | { type: "game"; config: MatchConfig };

function CurrentScreen({ screen, setScreen }: { screen: Screen; setScreen: (s: Screen) => void }) {
  switch (screen.type) {
    case "menu":
      return (
        <MainMenu
          onNewGame={() => setScreen({ type: "lobby" })}
          onBuildDeck={() => setScreen({ type: "deckBuilder", returnTo: "menu" })}
        />
      );
    case "lobby":
      return (
        <Lobby
          onBack={() => setScreen({ type: "menu" })}
          onStartMatch={(config) => setScreen({ type: "game", config })}
          onOpenDeckBuilder={(initialDeck) => setScreen({ type: "deckBuilder", initialDeck, returnTo: "lobby" })}
          onImportDecklistText={(deckList, unresolvedNames) =>
            setScreen({ type: "deckBuilder", initialDeck: deckList, unresolvedNames, returnTo: "lobby" })
          }
        />
      );
    case "deckBuilder":
      return (
        <DeckBuilder
          initialDeck={screen.initialDeck}
          unresolvedNames={screen.unresolvedNames}
          onSaved={() => setScreen({ type: screen.returnTo })}
          onCancel={() => setScreen({ type: screen.returnTo })}
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
