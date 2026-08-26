import { useState } from "react";
import { allPresetDecks, presetDeckList, serializeDeckFile, type DeckList } from "@rift-engine/engine";
import { getProfileDecks, removeProfileDeck } from "../profile.js";
import { downloadTextFile } from "../download-file.js";
import { DeckImport } from "./DeckImport.js";
import { DecklistTextImport } from "./DecklistTextImport.js";
import { DeckListPicker } from "./DeckListPicker.js";

const PRESET_DECK_LISTS = allPresetDecks().map(presetDeckList);

interface DeckManagerProps {
  onBack: () => void;
  /** Open the builder — with a deck to edit, or undefined for a new one. */
  onOpenDeckBuilder: (initialDeck?: DeckList) => void;
  /** A pasted decklist that parsed. Goes to the builder rather than straight to
   *  the profile, because a text import routinely leaves names unresolved (this
   *  pool is not every printed card) and the builder is where they get fixed. */
  onImportDecklistText: (deckList: DeckList, unresolvedNames: string[]) => void;
}

/**
 * **Your deck library, on its own screen.**
 *
 * Asked for in playtesting: *"can you also add a manage decks button, the new
 * deck button can probably [be] moved into there"*.
 *
 * The lobby's "Your deck" zone had been doing two unrelated jobs: choosing which
 * deck to play THIS match, and administering the library — build, import a file,
 * import pasted text, edit, export, delete. Six controls, of which exactly one
 * was about the match being set up. That is what made picking a deck feel like
 * paperwork.
 *
 * So the split is by QUESTION rather than by widget:
 *  - the lobby asks "which deck am I playing?" and now shows only the picker;
 *  - this screen asks "what is in my library?" and holds everything that changes
 *    it.
 *
 * Reachable from the main menu (where "Build a Deck" used to be) and from the
 * lobby, and it returns to whichever sent it — a deck edited mid-setup should
 * not dump you back at the title screen.
 *
 * # Presets are listed, and are read-only on purpose
 *
 * They are static data the engine ships (`profile.ts`'s own note says so), not
 * rows in the library — so they get no edit or delete button. They are shown at
 * all because "what can I play?" is the question this screen answers, and a
 * library that hid four playable decks would answer it wrongly. Export is
 * offered: a preset is a perfectly good starting point for a deck of your own,
 * and downloading it is how you get one.
 */
export function DeckManager({ onBack, onOpenDeckBuilder, onImportDecklistText }: DeckManagerProps) {
  const [profileDecks, setProfileDecks] = useState(getProfileDecks);

  function refreshProfile() {
    setProfileDecks(getProfileDecks());
  }

  function handleRemove(name: string) {
    removeProfileDeck(name);
    refreshProfile();
  }

  function handleExport(deck: DeckList) {
    downloadTextFile(`${deck.name}.deck`, serializeDeckFile(deck));
  }

  return (
    <div className="board">
      <div className="header">
        <h1>Manage decks</h1>
        <button onClick={onBack}>Back</button>
      </div>

      <div className="zone">
        <div className="zone-label">Your decks ({profileDecks.length})</div>
        <DeckListPicker
          label=""
          decks={profileDecks}
          // Nothing is "selected" in a library — this screen is not choosing a
          // deck for a match, so highlighting a row would imply a choice that
          // does not exist here.
          selectedName={null}
          // Clicking the NAME edits it. On this screen there is nothing else a
          // click could reasonably mean, and requiring the ✎ for the primary
          // action would make the row's biggest target do nothing.
          onSelect={onOpenDeckBuilder}
          onEdit={onOpenDeckBuilder}
          onExport={handleExport}
          onRemove={handleRemove}
          emptyNote="No decks of your own yet — build one, or import a file or a decklist below."
        />
        <button className="menu-primary-button" onClick={() => onOpenDeckBuilder()}>
          New deck
        </button>
      </div>

      <div className="zone">
        <div className="zone-label">Import</div>
        <DeckImport onImported={refreshProfile} />
        <DecklistTextImport onParsed={onImportDecklistText} />
      </div>

      <div className="zone">
        <div className="zone-label">Preset decks ({PRESET_DECK_LISTS.length})</div>
        <p className="deck-list-empty">
          Built in, and always available in the lobby. Export one to use it as the starting point for a deck of your own.
        </p>
        <DeckListPicker
          label=""
          decks={PRESET_DECK_LISTS}
          selectedName={null}
          // A preset opens in the builder as a STARTING POINT. It saves under
          // its own name into your profile, which shadows nothing: presets are
          // static engine data and are never written back.
          onSelect={onOpenDeckBuilder}
          onExport={handleExport}
        />
      </div>
    </div>
  );
}
