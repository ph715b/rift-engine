import { useState } from "react";
import type { DeckList } from "@rift-engine/engine";
import { MainMenu } from "./components/MainMenu.js";
import { Lobby } from "./components/Lobby.js";
import { DeckBuilder } from "./components/DeckBuilder.js";
import { DeckManager } from "./components/DeckManager.js";
import { GameBoard } from "./components/GameBoard.js";
import { HoverPreviewProvider } from "./hover-preview.js";
import { DragGhostProvider } from "./drag-ghost.js";
import type { MatchConfig } from "./game-setup.js";

type Screen =
  | { type: "menu" }
  | { type: "lobby" }
  // The deck LIBRARY — build, import, edit, export, delete. Its own screen since
  // 2026-08-26: the lobby was asking "which deck am I playing?" and "what is in
  // my library?" in one zone, and only the first is about the match being set up.
  //
  // `returnTo` for the same reason the builder has one: it is reachable from the
  // main menu and from the lobby, and a deck edited mid-setup must not dump the
  // player back at the title screen.
  | { type: "deckManager"; returnTo: "menu" | "lobby" }
  // returnTo: the deck builder is reachable from the main menu (build in
  // isolation), from the lobby's inline "Edit" button (tweak a deck while
  // setting up a match), and from the deck manager — it needs to know which one
  // to bounce back to on Save/Cancel rather than assuming any of them.
  | {
      type: "deckBuilder";
      initialDeck?: DeckList;
      unresolvedNames?: string[];
      returnTo: "menu" | "lobby" | "deckManager";
      /** Where the MANAGER should return to, when the builder returns to it.
       *  Without this a deck edited from the lobby would save back to a manager
       *  whose own Back button then went to the menu — the return path would
       *  lose a step and strand the player one screen from where they started. */
      managerReturnTo?: "menu" | "lobby";
    }
  | { type: "game"; config: MatchConfig };

function CurrentScreen({ screen, setScreen }: { screen: Screen; setScreen: (s: Screen) => void }) {
  switch (screen.type) {
    case "menu":
      return (
        <MainMenu
          onNewGame={() => setScreen({ type: "lobby" })}
          onManageDecks={() => setScreen({ type: "deckManager", returnTo: "menu" })}
        />
      );
    case "lobby":
      return (
        <Lobby
          onBack={() => setScreen({ type: "menu" })}
          onStartMatch={(config) => setScreen({ type: "game", config })}
          onManageDecks={() => setScreen({ type: "deckManager", returnTo: "lobby" })}
        />
      );
    case "deckManager":
      return (
        <DeckManager
          onBack={() => setScreen({ type: screen.returnTo })}
          onOpenDeckBuilder={(initialDeck) =>
            setScreen({ type: "deckBuilder", initialDeck, returnTo: "deckManager", managerReturnTo: screen.returnTo })
          }
          onImportDecklistText={(deckList, unresolvedNames) =>
            setScreen({
              type: "deckBuilder",
              initialDeck: deckList,
              unresolvedNames,
              returnTo: "deckManager",
              managerReturnTo: screen.returnTo,
            })
          }
        />
      );
    case "deckBuilder": {
      // The manager needs its OWN return target handed back, or the trip
      // menu -> manager -> builder -> manager would leave a manager that thinks
      // it came from the menu when it came from the lobby.
      const back: Screen =
        screen.returnTo === "deckManager"
          ? { type: "deckManager", returnTo: screen.managerReturnTo ?? "menu" }
          : { type: screen.returnTo };
      return (
        <DeckBuilder
          initialDeck={screen.initialDeck}
          unresolvedNames={screen.unresolvedNames}
          onSaved={() => setScreen(back)}
          onCancel={() => setScreen(back)}
        />
      );
    }
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
