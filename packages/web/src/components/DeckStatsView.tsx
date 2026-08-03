import { useMemo, useState } from "react";
import { defaultCardRegistry } from "@rift-engine/engine";
import { DOMAIN_COLORS } from "../domain-colors.js";
import { deckRows } from "../deck-rows.js";
import { OPENING_HAND_SIZE, deckStats, sampleHand } from "../deck-stats.js";

interface DeckStatsViewProps {
  cardIds: readonly string[];
}

/** What the deck is MADE of — the numbers a list of names cannot show. */
export function DeckStatsView({ cardIds }: DeckStatsViewProps) {
  const registry = useMemo(() => defaultCardRegistry(), []);
  const stats = useMemo(() => deckStats(deckRows(cardIds, registry), registry), [cardIds, registry]);

  if (stats.total === 0) return <p className="deck-list-empty">Add some cards and the numbers will show up here.</p>;

  return (
    <div className="deck-stats">
      <div className="deck-stats-figures">
        <div className="deck-stat">
          <span className="deck-stat-value">{stats.averageEnergy}</span>
          <span className="deck-stat-label">avg Energy</span>
        </div>
        <div className="deck-stat">
          <span className="deck-stat-value">{stats.powerCards}</span>
          <span className="deck-stat-label">need Power</span>
        </div>
        {stats.inertCopies > 0 && (
          <div className="deck-stat warn">
            <span className="deck-stat-value">{stats.inertCopies}</span>
            <span className="deck-stat-label">inert</span>
          </div>
        )}
      </div>

      <div className="zone-label">By type</div>
      <ul className="deck-stats-bars">
        {stats.byType.map(({ type, count }) => (
          <li key={type}>
            <span className="deck-stats-bar-label">{type}</span>
            <span className="deck-stats-bar" style={{ width: `${(count / stats.total) * 100}%` }} />
            <span className="deck-stats-bar-count">{count}</span>
          </li>
        ))}
      </ul>

      {/* Domains deliberately do NOT sum to the deck size — a dual-domain card
          counts for both, because "how much Fury is in here" is a question
          about pips rather than about slices of a pie. */}
      <div className="zone-label">By domain (cards may count twice)</div>
      <ul className="deck-stats-bars">
        {stats.byDomain.map(({ domain, count }) => (
          <li key={domain}>
            <span className="deck-stats-bar-label" style={{ color: DOMAIN_COLORS[domain as keyof typeof DOMAIN_COLORS] }}>
              {domain}
            </span>
            <span
              className="deck-stats-bar"
              style={{ width: `${(count / stats.total) * 100}%`, background: DOMAIN_COLORS[domain as keyof typeof DOMAIN_COLORS] }}
            />
            <span className="deck-stats-bar-count">{count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the deck OPENS with — the only stat that answers "is this castable". */
export function SampleHandView({ cardIds }: DeckStatsViewProps) {
  const registry = useMemo(() => defaultCardRegistry(), []);
  // The seed IS the re-roll counter, so "Draw again" is a different hand and the
  // same counter always deals the same one — see deck-stats.sampleHand.
  const [seed, setSeed] = useState(1);
  const hand = useMemo(() => sampleHand(cardIds, registry, seed), [cardIds, registry, seed]);

  if (cardIds.length === 0) return <p className="deck-list-empty">Add some cards to draw a hand.</p>;

  return (
    <div className="sample-hand">
      <div className="sample-hand-actions">
        <button onClick={() => setSeed((s) => s + 1)}>Draw again</button>
        <span className="deck-panel-cost">
          {hand.length} of {OPENING_HAND_SIZE}
        </span>
      </div>
      <div className="sample-hand-cards">
        {hand.map((def, i) => (
          // eslint-disable-next-line react/no-array-index-key -- a hand can hold
          // two copies of one card, so the defId is not unique within it.
          <div key={`${def.id}-${i}`} className="card-tile sample-hand-card" title={def.name}>
            <img className="card-tile-art" src={def.imageUrl} alt={def.name} draggable={false} loading="lazy" />
          </div>
        ))}
      </div>
    </div>
  );
}
