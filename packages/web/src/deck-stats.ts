import { mulberry32, type CardDefinition, type CardRegistry } from "@rift-engine/engine";
import type { DeckRow } from "./deck-rows.js";

/**
 * The two things a builder can tell you about a deck that a list cannot: what
 * it is MADE of, and what it OPENS with.
 *
 * Both pure and seeded, so a "Sample Hand" can be re-rolled deterministically
 * and the numbers can be asserted in a test rather than eyeballed.
 */

export interface DeckStats {
  total: number;
  byType: { type: string; count: number }[];
  byDomain: { domain: string; count: number }[];
  /** Average printed Energy across every COPY — the figure a curve is a picture
   *  of. Copies, not distinct cards, for the reason the inert note counts
   *  copies: three 5-drops is three 5-drops. */
  averageEnergy: number;
  /** How many copies print a Power pip at all. A deck's Power requirement is
   *  what decides whether its rune split is wrong, and it is invisible in a
   *  list sorted by Energy. */
  powerCards: number;
  inertCopies: number;
}

const TYPE_ORDER = ["Unit", "Spell", "Gear"];

export function deckStats(rows: readonly DeckRow[], registry: CardRegistry): DeckStats {
  let total = 0;
  let energySum = 0;
  let powerCards = 0;
  let inertCopies = 0;
  const byType = new Map<string, number>();
  const byDomain = new Map<string, number>();

  for (const row of rows) {
    total += row.count;
    energySum += row.energyCost * row.count;
    if (row.powerCost > 0) powerCards += row.count;
    if (row.isInert) inertCopies += row.count;
    byType.set(row.type, (byType.get(row.type) ?? 0) + row.count);
    // A card can carry two domains; it counts once for EACH, so the domain
    // totals deliberately do not sum to the deck size. That is the honest
    // shape — "how much Fury is in here" is a question about pips, not slices.
    for (const domain of registry.tryGet(row.defId)?.domains ?? []) {
      byDomain.set(domain, (byDomain.get(domain) ?? 0) + row.count);
    }
  }

  return {
    total,
    byType: [...byType].sort((a, b) => TYPE_ORDER.indexOf(a[0]) - TYPE_ORDER.indexOf(b[0])).map(([type, count]) => ({ type, count })),
    byDomain: [...byDomain].sort((a, b) => b[1] - a[1]).map(([domain, count]) => ({ domain, count })),
    averageEnergy: total === 0 ? 0 : Math.round((energySum / total) * 10) / 10,
    powerCards,
    inertCopies,
  };
}

export const OPENING_HAND_SIZE = 4;

/**
 * A seeded opening hand.
 *
 * Uses the ENGINE's own `mulberry32` rather than `Math.random`, for the reason
 * every shuffle in this project takes an explicit seeded Rng: a sample hand you
 * cannot reproduce is a sample hand you cannot show anyone or assert on. The
 * seed is the re-roll counter, so "Draw again" is a different hand and the same
 * counter always gives the same one.
 *
 * Draws by Fisher-Yates over a COPY of the deck's card ids — sampling with
 * replacement would happily deal you four of a card you own three of.
 */
export function sampleHand(cardIds: readonly string[], registry: CardRegistry, seed: number): CardDefinition[] {
  const pool = [...cardIds];
  const rng = mulberry32(seed);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool
    .slice(0, OPENING_HAND_SIZE)
    .map((id) => registry.tryGet(id))
    .filter((def): def is CardDefinition => def !== undefined);
}
