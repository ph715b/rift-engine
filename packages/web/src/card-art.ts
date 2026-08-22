import { loadAlternateArt, type CardPrinting } from "@rift-engine/engine";

/**
 * Which PRINTING of a card this player wants to look at.
 *
 * Reported from playtesting: there is no way to pick a card's alternate art. The
 * pool prints 99 of them and `shouldSkip` drops every one from the registry —
 * correctly, since an alternate art is the same card and a pool holding both
 * would double it in deckbuilding and in every coverage count. So the art
 * existed, was loadable, and was unreachable.
 *
 * # Why this is a PROFILE preference and not part of the DeckList
 *
 * A DeckList is the engine's own type: `validateDeckList` reads it, the `.deck`
 * importer produces it, and its shape is asserted by the import tests and the
 * decklist text parser. Art is cosmetic — it changes no legality, no cost and no
 * card identity — so putting it there would mean widening a validated type for a
 * preference, and exporting a deck would carry one machine's taste to another.
 *
 * Kept beside `profile.ts`'s decks and for the same stated reason: this is a
 * personal, one-machine app with no accounts and no sync, so `localStorage` is
 * the whole persistence layer. It is a SEPARATE key rather than a field on the
 * profile's decks, because the choice is per CARD and applies wherever that card
 * appears — in the builder, in a hand, on a battlefield, in the hover preview —
 * including in a preset deck the profile does not store at all.
 *
 * # What it does NOT cover, deliberately
 *
 * **The six domain RUNES.** They print alternates too, but a rune's art comes
 * from `loadRuneArt` keyed by DOMAIN rather than from a CardDefinition — runes
 * are not in the registry at all — so the rune zone reads a different path
 * entirely and nothing here would reach it. Measured: 93 of the 99 cards with an
 * alternate are real definitions; the other 6 are exactly those runes.
 */
const STORAGE_KEY = "rift-engine.cardArt";

/** base defId -> the chosen printing's id. Absent means the default printing. */
type ArtChoices = Record<string, string>;

const ALTERNATES = loadAlternateArt();

let choices: ArtChoices | null = null;
const listeners = new Set<() => void>();

function read(): ArtChoices {
  if (choices) return choices;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    choices = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ArtChoices) : {};
  } catch {
    // Corrupted storage behaves like no preference, exactly as `getProfileDecks`
    // treats it — a taste setting must never be able to stop the app booting.
    choices = {};
  }
  return choices;
}

/** The printings of a card, DEFAULT FIRST — the printing the registry ships is
 *  always index 0, so "which am I on" is a position in one list rather than a
 *  flag plus a list. */
export function printingsFor(defId: string, defaultName: string, defaultImageUrl: string): CardPrinting[] {
  const alternates = ALTERNATES.get(defId) ?? [];
  if (alternates.length === 0) return [];
  return [{ id: defId, name: defaultName, imageUrl: defaultImageUrl }, ...alternates];
}

/** Does this card have anything to choose between? The picker renders only when
 *  it does, so 93 cards get a control and the rest are unchanged. */
export function hasAlternateArt(defId: string): boolean {
  return (ALTERNATES.get(defId)?.length ?? 0) > 0;
}

/**
 * The art url to paint for this card, or `undefined` to use the printed default.
 *
 * `undefined` rather than the default url, so the ONE place that knows how a
 * card's default art is found stays `CardView` — a token's comes from
 * `loadTokenArt` and a card's from the registry, and this must not learn the
 * difference.
 */
export function chosenArt(defId: string): string | undefined {
  const chosenId = read()[defId];
  if (!chosenId || chosenId === defId) return undefined;
  return ALTERNATES.get(defId)?.find((p) => p.id === chosenId)?.imageUrl;
}

/** Records a choice. Passing the card's own defId clears it back to the default. */
export function chooseArt(defId: string, printingId: string): void {
  const next = { ...read() };
  if (printingId === defId) delete next[defId];
  else next[defId] = printingId;
  choices = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // A full or unavailable localStorage must not lose the choice for this
    // session — the in-memory copy above is already updated.
  }
  for (const notify of listeners) notify();
}

/** The currently chosen printing id for a card — its own defId when none is. */
export function chosenPrintingId(defId: string): string {
  return read()[defId] ?? defId;
}

/** `useSyncExternalStore` plumbing, so a card repaints the moment the picker is
 *  used rather than on the next unrelated render. */
export function subscribeToArt(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The whole choice map as one immutable value — the store SNAPSHOT.
 *
 *  It must be reference-stable between changes or `useSyncExternalStore` loops
 *  forever, which is why `chooseArt` above replaces the object rather than
 *  mutating it. */
export function artSnapshot(): ArtChoices {
  return read();
}

/** Test seam: drops the in-memory copy so a test can set storage and re-read.
 *  Not used by the app. */
export function resetArtCacheForTests(): void {
  choices = null;
  for (const notify of listeners) notify();
}
