import { useState } from "react";
import { allPresetDecks, presetDeckList, type DeckList } from "@rift-engine/engine";
import { getProfileDecks, removeProfileDeck } from "../profile.js";
import { DeckImport } from "./DeckImport.js";
import type { MatchConfig } from "../game-setup.js";

const PRESET_DECK_LISTS = allPresetDecks().map(presetDeckList);

interface DeckListPickerProps {
  label: string;
  decks: DeckList[];
  selectedName: string | null;
  onSelect: (deck: DeckList) => void;
  onRemove?: (name: string) => void;
  onEdit?: (deck: DeckList) => void;
}

function DeckListPicker({ label, decks, selectedName, onSelect, onRemove, onEdit }: DeckListPickerProps) {
  return (
    <div>
      {label && <div className="zone-label">{label}</div>}
      <div className="deck-list">
        {decks.map((deck) => (
          <div key={deck.name} className={`deck-option${selectedName === deck.name ? " selected" : ""}`}>
            <button className="deck-option-button" onClick={() => onSelect(deck)}>
              {deck.name}
            </button>
            {onEdit && (
              <button className="deck-option-edit" onClick={() => onEdit(deck)} title="Edit this deck">
                ✎
              </button>
            )}
            {onRemove && (
              <button className="deck-option-remove" onClick={() => onRemove(deck.name)} title="Remove from profile">
                ✕
              </button>
            )}
          </div>
        ))}
        {decks.length === 0 && <p className="deck-list-empty">No decks yet.</p>}
      </div>
    </div>
  );
}

interface LobbyProps {
  onStartMatch: (config: MatchConfig) => void;
  onBack: () => void;
  onOpenDeckBuilder: (initialDeck?: DeckList) => void;
}

/**
 * Setup screen: pick your deck (a Proving Grounds preset or anything in
 * your profile) and the AI's deck (presets only — the AI plays a fixed
 * built-in role, not your own collection), then start the match. This is
 * the ONE place deck selection happens (per the user's own framing) —
 * rematch either reuses this exact config or jumps straight back here for
 * a quick swap, it never re-litigates the choice mid-game.
 */
export function Lobby({ onStartMatch, onBack, onOpenDeckBuilder }: LobbyProps) {
  const [profileDecks, setProfileDecks] = useState(getProfileDecks);
  const [humanDeck, setHumanDeck] = useState<DeckList | null>(null);
  const [aiDeck, setAiDeck] = useState<DeckList | null>(PRESET_DECK_LISTS[0] ?? null);

  function refreshProfile() {
    setProfileDecks(getProfileDecks());
  }

  function handleRemove(name: string) {
    removeProfileDeck(name);
    refreshProfile();
    setHumanDeck((prev) => (prev?.name === name ? null : prev));
  }

  return (
    <div className="board">
      <div className="header">
        <h1>Rift-Engine</h1>
        <button onClick={onBack}>Back</button>
      </div>

      <div className="zone">
        <div className="zone-label">Your deck</div>
        <DeckListPicker label="" decks={PRESET_DECK_LISTS} selectedName={humanDeck?.name ?? null} onSelect={setHumanDeck} />
        <DeckListPicker
          label="Your saved decks"
          decks={profileDecks}
          selectedName={humanDeck?.name ?? null}
          onSelect={setHumanDeck}
          onRemove={handleRemove}
          onEdit={onOpenDeckBuilder}
        />
        <DeckImport onImported={refreshProfile} />
        <button onClick={() => onOpenDeckBuilder()}>Build a deck</button>
      </div>

      <div className="zone">
        <DeckListPicker
          label="Opponent's deck"
          decks={PRESET_DECK_LISTS}
          selectedName={aiDeck?.name ?? null}
          onSelect={setAiDeck}
        />
      </div>

      <div className="actions">
        <button
          className="menu-primary-button"
          disabled={!humanDeck || !aiDeck}
          onClick={() => humanDeck && aiDeck && onStartMatch({ humanDeck, aiDeck })}
        >
          Start Match
        </button>
      </div>
    </div>
  );
}
