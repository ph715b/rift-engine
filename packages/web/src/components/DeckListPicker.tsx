import type { DeckList } from "@rift-engine/engine";

export interface DeckListPickerProps {
  label: string;
  decks: DeckList[];
  /** Which deck reads as chosen. `null` in the deck manager, where the list is
   *  a library rather than a choice — nothing is "selected" there, so no row
   *  should be highlighted. */
  selectedName: string | null;
  onSelect: (deck: DeckList) => void;
  onRemove?: (name: string) => void;
  onEdit?: (deck: DeckList) => void;
  onExport?: (deck: DeckList) => void;
  /** Shown in place of the list when it is empty. The lobby and the manager want
   *  different sentences: one is picking for a match, the other is looking at a
   *  library it can add to. */
  emptyNote?: string;
}

/**
 * A list of decks with optional per-row edit / export / remove buttons.
 *
 * **Extracted from `Lobby.tsx` on 2026-08-26**, when the deck manager needed the
 * same list. It was lifted rather than copied: this repo's own notes record the
 * cost of a hand-copied list drifting from its original, and a picker whose row
 * buttons differ between two screens is exactly that shape.
 *
 * The row's own name button is always present; everything else is opt-in, so the
 * lobby (pick a deck for a match, with management alongside) and the manager
 * (edit a library, no match in progress) render the same rows with different
 * affordances rather than two different components.
 */
export function DeckListPicker({
  label,
  decks,
  selectedName,
  onSelect,
  onRemove,
  onEdit,
  onExport,
  emptyNote = "No decks yet.",
}: DeckListPickerProps) {
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
        {decks.length === 0 && <p className="deck-list-empty">{emptyNote}</p>}
      </div>
    </div>
  );
}
