import { isCardImplemented, type CardDefinition, type Domain } from "@rift-engine/engine";

/**
 * The card browser's filter and sort model.
 *
 * Pure, and tested away from the component, for the reason `target-hint.ts` and
 * `card-destination.ts` both record: a predicate inside a 600-line screen is
 * where a wrong answer survives unnoticed. It is also the piece most likely to
 * grow — every new filter is one more clause here and nothing else.
 *
 * The browser lists ~120 cards for a two-domain legend. A search box alone means
 * you can find a card you can already name and nothing else; the whole point of
 * a filter row is answering "what are my 3-drops" and "what removal do I have",
 * which are the questions you actually build a deck with.
 */

export type CardTypeFilter = "Unit" | "Spell" | "Gear";
export const CARD_TYPE_FILTERS: CardTypeFilter[] = ["Unit", "Spell", "Gear"];

/** Energy buckets, with the top one open-ended — the same shape the deck panel's
 *  curve uses, so the two agree about what "7+" means. */
export const COST_BUCKETS = [0, 1, 2, 3, 4, 5, 6, 7] as const;
export const COST_BUCKET_MAX = 7;

export type SortKey = "curve" | "name" | "cost-desc";

export interface CardFilters {
  search: string;
  /** Empty means "all" — an empty set reads as no filter rather than as
   *  "nothing matches", which is what a naive `has()` check would produce. */
  types: ReadonlySet<CardTypeFilter>;
  costs: ReadonlySet<number>;
  domains: ReadonlySet<Domain>;
  /** Hide cards whose text does nothing yet. Off by default: an inert card is
   *  still legal to deck, and hiding them by default would quietly narrow the
   *  pool without saying so. */
  implementedOnly: boolean;
  sort: SortKey;
}

export const EMPTY_FILTERS: CardFilters = {
  search: "",
  types: new Set(),
  costs: new Set(),
  domains: new Set(),
  implementedOnly: false,
  sort: "curve",
};

/** Is any narrowing active? Drives the "Clear" affordance and the count line —
 *  "121 cards" means something different when a filter is on. */
export function hasActiveFilters(f: CardFilters): boolean {
  return (
    f.search.trim().length > 0 || f.types.size > 0 || f.costs.size > 0 || f.domains.size > 0 || f.implementedOnly
  );
}

const energyOf = (def: CardDefinition): number => ("energyCost" in def ? def.energyCost : 0);
const powerOf = (def: CardDefinition): number => ("powerCost" in def ? def.powerCost : 0);

/** Which bucket a card's Energy cost falls in — everything at or above the cap
 *  lands in the top one, matching the curve. */
export function costBucket(def: CardDefinition): number {
  return Math.min(energyOf(def), COST_BUCKET_MAX);
}

const TYPE_ORDER: Record<string, number> = { Unit: 0, Spell: 1, Gear: 2 };

/**
 * Applies every filter, then sorts.
 *
 * Each filter dimension is INDEPENDENT and ANDed: picking Unit + 3 means
 * "3-cost units", not "units or 3-drops". Within a dimension the values are
 * ORed, which is what makes the chips behave the way a filter row is expected to
 * — clicking Unit and Spell shows both rather than nothing.
 */
export function filterAndSortCards(cards: readonly CardDefinition[], f: CardFilters): CardDefinition[] {
  const query = f.search.trim().toLowerCase();
  const matched = cards.filter((def) => {
    // Search covers NAME and TEXT: "when you play me" and "deal 3" are how a
    // player looks for an effect, and a name-only search cannot answer either.
    if (query) {
      const haystack = `${def.name} ${"text" in def ? (def.text ?? "") : ""}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (f.types.size > 0 && !f.types.has(def.type as CardTypeFilter)) return false;
    if (f.costs.size > 0 && !f.costs.has(costBucket(def))) return false;
    if (f.domains.size > 0 && !def.domains.some((d) => f.domains.has(d))) return false;
    if (f.implementedOnly && !isCardImplemented(def)) return false;
    return true;
  });

  const sorted = [...matched];
  switch (f.sort) {
    case "name":
      sorted.sort((a, b) => a.name.localeCompare(b.name));
      break;
    case "cost-desc":
      sorted.sort((a, b) => energyOf(b) - energyOf(a) || powerOf(b) - powerOf(a) || a.name.localeCompare(b.name));
      break;
    case "curve":
    default:
      // Energy, then Power, then name — the order a curve is read in, and the
      // one the reference builders default to.
      sorted.sort(
        (a, b) =>
          energyOf(a) - energyOf(b) ||
          powerOf(a) - powerOf(b) ||
          (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) ||
          a.name.localeCompare(b.name),
      );
      break;
  }
  return sorted;
}

export const SORT_LABELS: Record<SortKey, string> = {
  curve: "Energy > Power > Name",
  name: "Name",
  "cost-desc": "Most expensive first",
};
