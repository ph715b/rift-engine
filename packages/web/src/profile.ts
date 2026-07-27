import type { DeckList } from "@rift-engine/engine";

/**
 * The user's local deck library — imported real `.deck` files and (later)
 * in-app-built decks. A single implicit profile (no accounts, no sync):
 * this is a personal, one-machine app, so `localStorage` is the whole
 * persistence layer. Presets (the 4 Proving Grounds precons) are NOT
 * stored here — they're static data the engine already ships; this is only
 * for decks the user has added themselves.
 */
const STORAGE_KEY = "rift-engine.profileDecks";

export function getProfileDecks(): DeckList[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DeckList[]) : [];
  } catch {
    return []; // corrupted storage shouldn't crash the app — just behaves like an empty profile
  }
}

function writeProfileDecks(decks: DeckList[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(decks));
}

/** Adds a deck to the profile, replacing any existing deck with the same name. */
export function saveProfileDeck(deck: DeckList): void {
  const existing = getProfileDecks().filter((d) => d.name !== deck.name);
  writeProfileDecks([...existing, deck]);
}

export function removeProfileDeck(name: string): void {
  writeProfileDecks(getProfileDecks().filter((d) => d.name !== name));
}
