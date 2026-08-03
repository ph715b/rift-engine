import { useState } from "react";
import { defaultCardRegistry, parseDecklistText, type DeckList } from "@rift-engine/engine";

interface DecklistTextImportProps {
  onParsed: (deckList: DeckList, unresolvedNames: string[]) => void;
  /** Would parsing THROW AWAY work in progress? Used from inside the deck
   *  builder, where the paste replaces whatever is already there — the button
   *  label is the warning, since a confirm dialog for a reversible-by-undo
   *  action is worse than a clear verb. From the lobby there is nothing to lose
   *  and the label stays "Parse". */
  replaces?: boolean;
}

/**
 * Imports the plain-text decklist format sites like piltoverarchive.com and
 * riftdecks.com export — a different, name-based format from the `.deck`
 * KEY=value files DeckImport.tsx already handles. Unlike that importer,
 * this deliberately does NOT validate-then-save directly: a real pasted
 * list commonly references cards outside this engine's Origins-only pool
 * (see parseDecklistText's own doc comment), so a partial result is the
 * normal case, not a failure — Parse hands the (possibly incomplete)
 * DeckList to the DeckBuilder screen for the user to review/complete,
 * rather than rejecting the whole paste over a few unresolved names.
 */
export function DecklistTextImport({ onParsed, replaces = false }: DecklistTextImportProps) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleParse() {
    const result = parseDecklistText(text, defaultCardRegistry());
    if (!result) {
      setError("Couldn't find a recognizable Legend/Champion/MainDeck section, or the Legend name didn't match a known card.");
      return;
    }
    setError(null);
    onParsed(result.deckList, result.unresolvedNames);
  }

  return (
    <div className="decklist-text-import">
      <div className="zone-label">Paste a decklist (piltoverarchive/riftdecks text export)</div>
      <textarea
        className="decklist-text-import-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"Legend:\n1 Master Yi, Wuju Bladesman\n\nChampion:\n..."}
      />
      <button onClick={handleParse} disabled={!text.trim()}>
        {replaces ? "Replace deck" : "Parse"}
      </button>
      {error && <p className="deck-import-error">{error}</p>}
    </div>
  );
}
