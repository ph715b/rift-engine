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
export const SIDEBOARD_SIZE = 8;
export const RUNE_DECK_SIZE = 12;
