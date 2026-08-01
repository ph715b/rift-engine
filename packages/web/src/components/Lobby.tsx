import { useState } from "react";
import { allPresetDecks, presetDeckList, serializeDeckFile, type DeckList } from "@rift-engine/engine";
import { getProfileDecks, removeProfileDeck } from "../profile.js";
import { downloadTextFile } from "../download-file.js";
import { DeckImport } from "./DeckImport.js";
import { DecklistTextImport } from "./DecklistTextImport.js";
import type { MatchConfig, MatchFormat } from "../game-setup.js";

const PRESET_DECK_LISTS = allPresetDecks().map(presetDeckList);

interface DeckListPickerProps {
  label: string;
  decks: DeckList[];
  selectedName: string | null;
  onSelect: (deck: DeckList) => void;
  onRemove?: (name: string) => void;
  onEdit?: (deck: DeckList) => void;
  onExport?: (deck: DeckList) => void;
}

function DeckListPicker({ label, decks, selectedName, onSelect, onRemove, onEdit, onExport }: DeckListPickerProps) {
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
            {onExport && (
              <button className="deck-option-export" onClick={() => onExport(deck)} title="Download as a .deck file">
                ⬇
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
  onImportDecklistText: (deckList: DeckList, unresolvedNames: string[]) => void;
}

/**
 * Setup screen: pick your deck and the AI's, each from the Proving Grounds
 * presets or anything in your profile (imported, built, or pasted from a
 * community list), then start the match. This is
 * the ONE place deck selection happens (per the user's own framing) —
 * rematch either reuses this exact config or jumps straight back here for
 * a quick swap, it never re-litigates the choice mid-game.
 */
export function Lobby({ onStartMatch, onBack, onOpenDeckBuilder, onImportDecklistText }: LobbyProps) {
  const [profileDecks, setProfileDecks] = useState(getProfileDecks);
  const [humanDeck, setHumanDeck] = useState<DeckList | null>(null);
  const [aiDeck, setAiDeck] = useState<DeckList | null>(PRESET_DECK_LISTS[0] ?? null);
  // Best of 1 is the default because it's the shorter commitment, and because
  // it's what every match up to now has implicitly been.
  const [format, setFormat] = useState<MatchFormat>("bo1");

  function refreshProfile() {
    setProfileDecks(getProfileDecks());
  }

  function handleRemove(name: string) {
    removeProfileDeck(name);
    refreshProfile();
    setHumanDeck((prev) => (prev?.name === name ? null : prev));
  }

  function handleExport(deck: DeckList) {
    downloadTextFile(`${deck.name}.deck`, serializeDeckFile(deck));
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
          onExport={handleExport}
        />
        <DeckImport onImported={refreshProfile} />
        <DecklistTextImport onParsed={onImportDecklistText} />
        <button onClick={() => onOpenDeckBuilder()}>Build a deck</button>
      </div>

      <div className="zone">
        <DeckListPicker
          label="Opponent's deck"
          decks={PRESET_DECK_LISTS}
          selectedName={aiDeck?.name ?? null}
          onSelect={setAiDeck}
        />
        {/* The AI plays your own decks too. It used to be presets only, on the
            reasoning that the opponent is a fixed built-in role — but the AI and
            the UI consume the same `legalActions` contract, and game-setup takes
            any pair of DeckLists, so the restriction was never an engine one.
            Testing a deck against itself, or against the list you actually
            expect to face, is the point of building one.

            Deliberately a SECOND picker rather than one merged list: which decks
            are yours stays visible, and it mirrors the human side above. */}
        <DeckListPicker
          label="Your saved decks"
          decks={profileDecks}
          selectedName={aiDeck?.name ?? null}
          onSelect={setAiDeck}
        />
      </div>

      {/* The two sanctioned 1v1 modes (rules 485.3-487.4). Labelled by game
          count first, since that's what a player is actually choosing, with the
          rules' own mode name and the consequences underneath — the battlefield
          rule genuinely differs between them, so it isn't just match length. */}
      <div className="zone">
        <div className="zone-label">Match format</div>
        <div className="format-picker">
          {(
            [
              {
                value: "bo1" as const,
                title: "Best of 1",
                mode: "1v1 Duel",
                detail: "One game decides it. Battlefields are rolled at random.",
              },
              {
                value: "bo3" as const,
                title: "Best of 3",
                mode: "1v1 Match",
                detail: "First to 2 game wins. You pick your battlefield each game, and used ones are out for the rest of the match.",
              },
            ] satisfies { value: MatchFormat; title: string; mode: string; detail: string }[]
          ).map((option) => (
            <button
              key={option.value}
              className={`format-option${format === option.value ? " selected" : ""}`}
              aria-pressed={format === option.value}
              onClick={() => setFormat(option.value)}
            >
              <span className="format-option-title">{option.title}</span>
              <span className="format-option-mode">{option.mode}</span>
              <span className="format-option-detail">{option.detail}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="actions">
        <button
          className="menu-primary-button"
          disabled={!humanDeck || !aiDeck}
          onClick={() => humanDeck && aiDeck && onStartMatch({ humanDeck, aiDeck, format })}
        >
          Start Match
        </button>
      </div>
    </div>
  );
}
