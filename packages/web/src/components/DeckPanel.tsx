import { useMemo } from "react";
import { createCardInstance, defaultCardRegistry } from "@rift-engine/engine";
import { CURVE_MAX, deckCurve, deckRows } from "../deck-rows.js";
import { useCardHover } from "../hover-preview.js";

interface DeckPanelProps {
  cardIds: readonly string[];
  championId: string | null;
  deckSize: number;
  onRemove: (defId: string) => void;
  /** "Deck" unless something else — the sideboard renders the same panel. */
  title?: string;
  /** The sideboard is 8 cards and has no curve worth drawing. */
  showCurve?: boolean;
}

/**
 * The deck as a LIST, beside the card browser.
 *
 * Asked for in playtesting ("some kind of visual representation of our deck, on
 * the right side, like MTG Arena"), and the reason it matters is the same one
 * the inert-copies note already answers in words: a 40-card grid of tiles tells
 * you what is legal to add, and nothing at all about the deck you have built.
 *
 * Three things it shows that the browser cannot:
 *  - **The list in reading order** — units, then spells, then gear, cheap to
 *    expensive. The browser is in registry order, which is nobody's mental model.
 *  - **The curve.** A deck's Energy distribution is the single most useful shape
 *    to see while building, and it is invisible when the cards are scattered
 *    across a grid.
 *  - **Which copies are INERT**, in place, rather than as a sentence listing
 *    names you then have to find.
 *
 * Sticky rather than fixed: `.deck-builder` is the one screen that scrolls
 * (`overflow-y: auto`), so the panel follows the browser down instead of taking
 * a fixed slice of a fixed-height column — the mistake that broke the lobby.
 */
export function DeckPanel({ cardIds, championId, deckSize, onRemove, title = "Deck", showCurve = true }: DeckPanelProps) {
  const registry = useMemo(() => defaultCardRegistry(), []);
  const rows = useMemo(() => deckRows(cardIds, registry), [cardIds, registry]);
  const curve = useMemo(() => deckCurve(rows), [rows]);
  const peak = Math.max(1, ...curve);
  // Hovering a ROW shows the full card, the same escape hatch the browser tiles
  // use — a name and two numbers is not enough to decide what to cut.
  const setHovered = useCardHover();

  return (
    <aside className="deck-panel">
      <div className="zone-label">
        {title} ({cardIds.length}/{deckSize})
      </div>

      {/* The curve. Deliberately tiny and unlabelled beyond the cost digits —
          it is a shape to glance at, not a chart to read. */}
      {showCurve && (
      <div className="deck-curve" aria-label="Energy curve">
        {curve.map((count, cost) => (
          <div key={cost} className="deck-curve-column" title={`${count} card${count === 1 ? "" : "s"} at ${cost} Energy`}>
            <div className="deck-curve-bar" style={{ height: `${(count / peak) * 100}%` }} />
            <span className="deck-curve-cost">
              {cost}
              {cost === CURVE_MAX ? "+" : ""}
            </span>
          </div>
        ))}
      </div>
      )}

      {rows.length === 0 ? (
        <p className="deck-list-empty">Nothing in the deck yet.</p>
      ) : (
        <ul className="deck-panel-rows">
          {rows.map((row) => (
            <li
              key={row.defId}
              className={`deck-panel-row${row.isInert ? " inert" : ""}`}
              onMouseEnter={() => {
                const def = registry.tryGet(row.defId);
                if (def) setHovered({ card: createCardInstance(def), def });
              }}
              onMouseLeave={() => setHovered(null)}
            >
              <span className="deck-panel-count">{row.count}×</span>
              <span className="deck-panel-name">
                {row.name}
                {row.defId === championId && <span className="deck-panel-champion" title="Champion"> ★</span>}
              </span>
              <span className="deck-panel-cost">
                {row.energyCost}
                {row.powerCost > 0 ? `/${row.powerCost}` : ""}
              </span>
              {/* Removing from the list is the whole point of showing it — the
                  browser can only remove a card you can still find in the grid. */}
              <button
                className="deck-panel-remove"
                onClick={() => onRemove(row.defId)}
                title={`Remove one copy of ${row.name}`}
                aria-label={`Remove one copy of ${row.name}`}
              >
                −
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
