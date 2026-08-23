/**
 * An unresolved decklist — plain card ids, not yet turned into CardInstances
 * or checked against a CardRegistry. Mirrors CustomDeckRegistry.SavedDeck
 * (registry/CustomDeckRegistry.java:9-11), and is the shared shape behind
 * all three deck sources (FR2): Proving Grounds presets, imported `.deck`
 * files, and arbitrary user-built decks all produce/consume this same type.
 */
export interface DeckList {
  name: string;
  legendId: string;
  championId: string;
  /** Exactly 40 ids, including the champion's own copy/copies — matches the
   *  `.deck` file's CARD= lines and DeckBuilderController's DECK_SIZE. */
  cardIds: string[];
  runeDomainACount: number;
  runeDomainBCount: number;
  /** Exactly 3 plain battlefield names (not CardDefinition ids — Battlefield-type
   *  cards are excluded from the gameplay registry entirely, see card-loader.ts). */
  battlefieldNames: string[];
  /** Exactly 0 or 8 ids. */
  sideboardCardIds: string[];
}

/**
 * What every game used before battlefield selection existed, and the fixed
 * default for the Proving Grounds presets (which have no verified real
 * battlefield trio of their own) — registry/CustomDeckRegistry.java:13-19.
 */
export const LEGACY_BATTLEFIELDS = ["Zaun Warrens", "Targon's Peak", "Reaver's Row"];

export const DECK_SIZE = 40;
export const MAX_COPIES = 3;
export const BATTLEFIELD_COUNT = 3;
/**
 * The MAXIMUM sideboard, ten cards as of 2026-08-23 (was eight).
 *
 * **A cap, not an exact size, and that is a deliberate call.** Every check used
 * to read "empty or exactly SIDEBOARD_SIZE", so raising the number would have
 * invalidated every deck built under the old one — six of the eight decks in the
 * app's own store, including archived Regional Qualifier lists that were legal
 * when they were built. A format's card limit going up does not retroactively
 * unmake decks under it.
 *
 * The core rulebook does not mention sideboards at all: this is an
 * organized-play limit, which is exactly the kind of number that moves again.
 * Treating it as a ceiling means the next change costs one line and breaks
 * nobody's saved decks.
 *
 * Every reader goes through this constant. The one place that had hardcoded the
 * number instead — `deck-file-parser` — now reads it too, because a size living
 * in two places is a size that drifts; the two happened to agree only because
 * the number had never changed.
 */
export const SIDEBOARD_SIZE = 10;
export const RUNE_DECK_SIZE = 12;
