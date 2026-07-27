import { useRef, useState } from "react";
import { defaultCardRegistry, parseDeckFile, validateDeckList } from "@rift-engine/engine";
import { saveProfileDeck } from "../profile.js";

interface DeckImportProps {
  onImported: () => void;
}

/**
 * Imports a real `.deck` file (the same format Java's CustomDeckRegistry
 * reads/writes) into the browser profile. Browsers can't read an arbitrary
 * directory like `~/.riftbound/decks` the way the engine's Node-only
 * `loadDeckFilesFromDirectory` does — this is the client-side equivalent:
 * the user picks (or drags in) the file themselves, its text is read via
 * FileReader, and parsed with the exact same `parseDeckFile` the Node path
 * uses. Once imported it's saved to the profile permanently — no
 * re-uploading it every session.
 */
export function DeckImport({ onImported }: DeckImportProps) {
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const registry = defaultCardRegistry();

    for (const file of Array.from(files)) {
      const text = await file.text();
      const deckList = parseDeckFile(text);
      if (!deckList) {
        setError(`${file.name} isn't a valid .deck file`);
        continue;
      }
      const validation = validateDeckList(deckList, registry);
      if (!validation.ok) {
        setError(`${deckList.name}: ${validation.error}`);
        continue;
      }
      saveProfileDeck(deckList);
      setError(null);
    }
    onImported();
  }

  return (
    <div
      className={`deck-import${isDragOver ? " drag-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragOver(false);
        void handleFiles(e.dataTransfer.files);
      }}
    >
      <p>Drop a .deck file here, or</p>
      <button onClick={() => inputRef.current?.click()}>Choose file</button>
      <input
        ref={inputRef}
        type="file"
        accept=".deck"
        multiple
        hidden
        onChange={(e) => void handleFiles(e.target.files)}
      />
      {error && <p className="deck-import-error">{error}</p>}
    </div>
  );
}
