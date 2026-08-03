import { isCardImplemented, type CardDefinition, type CardRegistry } from "@rift-engine/engine";

/** One line of the deck panel: a card, how many copies, and the two facts the
 *  panel colours by. */
export interface DeckRow {
  defId: string;
  name: string;
  count: number;
  energyCost: number;
  powerCost: number;
  type: CardDefinition["type"];
  /** Greyed in the panel exactly as in the browser — an inert 3-of is three
   *  dead draws, and the deck list is where you notice that. */
  isInert: boolean;
}

/** A deck's curve: how many copies sit at each Energy cost, for the little bar
 *  chart. Index IS the cost; the last bucket absorbs everything above it. */
export type CurveBuckets = number[];

export const CURVE_MAX = 7;

/**
 * Groups a flat `cardIds` list into display rows.
 *
 * Sorted by TYPE, then Energy cost, then name — the order a deck is actually
 * read in (units, then spells, then gear, cheap to expensive), rather than the
 * registry order the browser uses. Pure and separate from the component so the
 * ordering can be tested without mounting anything.
 */
const TYPE_ORDER: Record<string, number> = { Unit: 0, Spell: 1, Gear: 2, Legend: 3, Battlefield: 4, Rune: 5 };

export function deckRows(cardIds: readonly string[], registry: CardRegistry): DeckRow[] {
  const counts = new Map<string, number>();
  for (const id of cardIds) counts.set(id, (counts.get(id) ?? 0) + 1);

  const rows: DeckRow[] = [];
  for (const [defId, count] of counts) {
    const def = registry.tryGet(defId);
    // A deck can name a card the pool does not have (a hand-edited .deck file);
    // the row is kept so the copies are still visible and removable rather than
    // silently missing from a count the player is trying to reconcile.
    if (!def) {
      rows.push({ defId, name: defId, count, energyCost: 0, powerCost: 0, type: "Spell", isInert: true });
      continue;
    }
    rows.push({
      defId,
      name: def.name,
      count,
      energyCost: "energyCost" in def ? def.energyCost : 0,
      powerCost: "powerCost" in def ? def.powerCost : 0,
      type: def.type,
      isInert: !isCardImplemented(def),
    });
  }

  return rows.sort(
    (a, b) =>
      (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) ||
      a.energyCost - b.energyCost ||
      a.name.localeCompare(b.name),
  );
}

/** Copies per Energy cost, with everything at or above `CURVE_MAX` in the last
 *  bucket. Counts COPIES rather than distinct cards, for the same reason the
 *  inert note does: three 5-drops is three 5-drops. */
export function deckCurve(rows: readonly DeckRow[]): CurveBuckets {
  const buckets = Array.from({ length: CURVE_MAX + 1 }, () => 0);
  for (const row of rows) {
    const bucket = Math.min(row.energyCost, CURVE_MAX);
    buckets[bucket] = (buckets[bucket] ?? 0) + row.count;
  }
  return buckets;
}
