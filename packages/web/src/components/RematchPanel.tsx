import { useState } from "react";
import type { DeckList } from "@rift-engine/engine";
import { getProfileDecks } from "../profile.js";

interface RematchPanelProps {
  didHumanWin: boolean;
  /** The series score as "2–1", when this ended a Best of 3. Absent in a
   *  single game, where the game result IS the match result and a score line
   *  would be noise. */
  seriesScore?: string;
  onRematch: () => void;
  onQuickSwap: (deck: DeckList) => void;
  onMainMenu: () => void;
}

/** Shown once a MATCH ends — which in a Best of 3 means someone reached two
 *  game wins, not merely that a game finished (see SeriesPanel for that).
 *  "Rematch" replays the exact same two decks, reshuffled (PRD: "play a bunch
 *  of quick games... no re-doing setup from scratch each game"). "Quick swap"
 *  lets you pick a different deck from your profile without leaving for the
 *  full Lobby. */
export function RematchPanel({ didHumanWin, seriesScore, onRematch, onQuickSwap, onMainMenu }: RematchPanelProps) {
  const [showSwap, setShowSwap] = useState(false);
  const profileDecks = getProfileDecks();

  return (
    <div className="rematch-panel">
      <div className="banner">
        {didHumanWin ? "You win!" : "AI wins."}
        {seriesScore && <span className="series-score"> {seriesScore}</span>}
      </div>
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
