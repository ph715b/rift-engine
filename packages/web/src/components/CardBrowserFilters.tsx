import { sortByDomainOrdinal, type Domain } from "@rift-engine/engine";
import { DOMAIN_COLORS } from "../domain-colors.js";
import {
  CARD_TYPE_FILTERS,
  COST_BUCKETS,
  COST_BUCKET_MAX,
  EMPTY_FILTERS,
  SORT_LABELS,
  hasActiveFilters,
  type CardFilters,
  type CardTypeFilter,
  type SortKey,
} from "../card-filters.js";

interface CardBrowserFiltersProps {
  filters: CardFilters;
  onChange: (next: CardFilters) => void;
  /** The legend's two domains — the only ones worth offering, since the browser
   *  is already narrowed to cards legal for it. */
  domains: readonly Domain[];
  resultCount: number;
  poolCount: number;
}

/** Toggles one value in a set without mutating it. */
function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

/**
 * The filter row above the card grid.
 *
 * A two-domain legend browses ~120 cards. With only a search box you can find a
 * card you can already name and nothing else — which is the wrong way round,
 * because building a deck is asking "what are my 3-drops" and "what removal do I
 * have" long before it is asking for a specific card.
 *
 * Chips rather than dropdowns: every filter's state is readable without opening
 * anything, which is what makes "why am I only seeing 9 cards" answerable at a
 * glance. The result count sits beside them for the same reason.
 */
export function CardBrowserFilters({ filters, onChange, domains, resultCount, poolCount }: CardBrowserFiltersProps) {
  const set = (patch: Partial<CardFilters>) => onChange({ ...filters, ...patch });
  const orderedDomains = sortByDomainOrdinal([...domains]);

  return (
    <div className="browser-filters">
      <div className="browser-filters-row">
        <input
          className="deck-builder-search-input browser-search"
          value={filters.search}
          onChange={(e) => set({ search: e.target.value })}
          placeholder="Search name or rules text..."
        />
        <label className="browser-sort">
          Sort
          <select value={filters.sort} onChange={(e) => set({ sort: e.target.value as SortKey })}>
            {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
              <option key={key} value={key}>
                {SORT_LABELS[key]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="browser-filters-row">
        <div className="chip-group" role="group" aria-label="Card type">
          {CARD_TYPE_FILTERS.map((type: CardTypeFilter) => (
            <button
              key={type}
              className={`filter-chip${filters.types.has(type) ? " on" : ""}`}
              aria-pressed={filters.types.has(type)}
              onClick={() => set({ types: toggled(filters.types, type) })}
            >
              {type}
            </button>
          ))}
        </div>

        <div className="chip-group" role="group" aria-label="Energy cost">
          {COST_BUCKETS.map((cost) => (
            <button
              key={cost}
              className={`filter-chip cost${filters.costs.has(cost) ? " on" : ""}`}
              aria-pressed={filters.costs.has(cost)}
              onClick={() => set({ costs: toggled(filters.costs, cost) })}
              title={`${cost}${cost === COST_BUCKET_MAX ? " or more" : ""} Energy`}
            >
              {cost}
              {cost === COST_BUCKET_MAX ? "+" : ""}
            </button>
          ))}
        </div>

        <div className="chip-group" role="group" aria-label="Domain">
          {orderedDomains.map((domain) => (
            <button
              key={domain}
              className={`filter-chip${filters.domains.has(domain) ? " on" : ""}`}
              aria-pressed={filters.domains.has(domain)}
              style={filters.domains.has(domain) ? { borderColor: DOMAIN_COLORS[domain], color: DOMAIN_COLORS[domain] } : undefined}
              onClick={() => set({ domains: toggled(filters.domains, domain) })}
            >
              {domain}
            </button>
          ))}
        </div>

        <button
          className={`filter-chip${filters.implementedOnly ? " on" : ""}`}
          aria-pressed={filters.implementedOnly}
          onClick={() => set({ implementedOnly: !filters.implementedOnly })}
          title="Hide cards whose text does nothing yet"
        >
          Implemented only
        </button>

        {hasActiveFilters(filters) && (
          <button className="filter-chip clear" onClick={() => onChange({ ...EMPTY_FILTERS, sort: filters.sort })}>
            Clear
          </button>
        )}

        {/* The count is a filter's only honest feedback: without it, a narrowing
            that matches nothing looks identical to an empty pool. */}
        <span className="browser-count">
          {resultCount === poolCount ? `${poolCount} cards` : `${resultCount} of ${poolCount} cards`}
        </span>
      </div>
    </div>
  );
}
