import { useState } from "react";
import type { DeckList } from "@rift-engine/engine";
import { getProfileDecks } from "../profile.js";

interface RematchPanelProps {
  didHumanWin: boolean;
  onRematch: () => void;
  onQuickSwap: (deck: DeckList) => void;
  onMainMenu: () => void;
}

/** Shown once a match ends. "Rematch" replays the exact same two decks,
 *  reshuffled (PRD: "play a bunch of quick games... no re-doing setup from
 *  scratch each game"). "Quick swap" lets you pick a different deck from
 *  your profile without leaving for the full Lobby. */
export function RematchPanel({ didHumanWin, onRematch, onQuickSwap, onMainMenu }: RematchPanelProps) {
  const [showSwap, setShowSwap] = useState(false);
  const profileDecks = getProfileDecks();

  return (
    <div className="rematch-panel">
      <div className="banner">{didHumanWin ? "You win!" : "AI wins."}</div>
      {!showSwap ? (
        <div className="actions">
          <button onClick={onMainMenu}>Main Menu</button>
          {profileDecks.length > 0 && <button onClick={() => setShowSwap(true)}>Quick-swap your deck</button>}
          <button className="menu-primary-button" onClick={onRematch}>
            Rematch (same decks)
          </button>
        </div>
      ) : (
        <div className="deck-list">
          {profileDecks.map((deck) => (
            <button key={deck.name} className="deck-option-button" onClick={() => onQuickSwap(deck)}>
              {deck.name}
            </button>
          ))}
          <button onClick={() => setShowSwap(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
