import type { CardRegistry } from "../cards/card-registry.js";
import type { CardDefinition, UnitDefinition } from "../model/card-definition.js";
import type { Domain } from "../model/domain.js";
import { fail, ok, type ValidationResult } from "../actions/validation-result.js";
import { BATTLEFIELD_COUNT, DECK_SIZE, MAX_COPIES, RUNE_DECK_SIZE, SIDEBOARD_SIZE, type DeckList } from "./deck-list.js";

/**
 * A champion is eligible for a legend when its name shares the legend's
 * leading "CharacterName - " prefix and its domains are a subset of the
 * legend's. Mirrors DeckPresets.championsFor (registry/DeckPresets.java:48-60).
 * Exported (not just used by validateDeckList below) so a deck-builder UI can
 * filter its champion picker with the exact same rule, rather than a second
 * copy of this logic drifting out of sync.
 */
export function isEligibleChampion(champion: UnitDefinition, legendName: string, legendDomains: readonly string[]): boolean {
  const charName = legendName.includes(" - ") ? legendName.slice(0, legendName.indexOf(" - ")) : legendName;
  if (!champion.name.startsWith(`${charName} - `)) return false;
  return champion.domains.every((d) => legendDomains.includes(d));
}

/**
 * Whether `card` can appear in a main deck led by a legend with
 * `legendDomains` — not itself a Legend, and sharing at least one domain
 * with the legend. Mirrors CardRegistry.forLegend (registry/CardRegistry.java:164-169),
 * previously inlined only inside validateDeckList's main-deck loop below;
 * exported so a deck-builder UI's card browser can filter with the same
 * rule the validator enforces.
 */
export function isCardLegalForLegend(card: CardDefinition, legendDomains: readonly Domain[]): boolean {
  if (card.type === "Legend") return false;
  return card.domains.some((d) => legendDomains.includes(d));
}

/**
 * Validates a DeckList against the rules DeckBuilderController enforces
 * (`A:\Projects\riftbound-engine\src\main\java\com\riftbound\ui\DeckBuilderController.java`):
 * 40-card main deck (including the champion's own copy), max 3 copies of any
 * unique card (main deck + sideboard combined), a legal card pool gated by
 * legend-domain overlap (CardRegistry.forLegend, registry/CardRegistry.java:164-169),
 * a 12-rune deck split across the legend's two domains, exactly 3 battlefield
 * names, and an optional 0-or-8-card sideboard. Shared by all three deck
 * sources (presets, imported `.deck` files, user-built decks) — none of them
 * get a validation shortcut.
 */
export function validateDeckList(deckList: DeckList, registry: CardRegistry): ValidationResult {
  const legendDef = registry.tryGet(deckList.legendId);
  if (!legendDef) return fail(`Unknown legend id: ${deckList.legendId}`);
  if (legendDef.type !== "Legend") return fail(`${deckList.legendId} is not a Legend card`);
  if (legendDef.domains.length !== 2) return fail(`Legend ${legendDef.name} must have exactly 2 domains`);

  const championDef = registry.tryGet(deckList.championId);
  if (!championDef) return fail(`Unknown champion id: ${deckList.championId}`);
  if (championDef.type !== "Unit" || !championDef.isChampion) {
    return fail(`${deckList.championId} is not a Champion Unit`);
  }
  if (!isEligibleChampion(championDef, legendDef.name, legendDef.domains)) {
    return fail(`${championDef.name} is not eligible for legend ${legendDef.name}`);
  }

  if (deckList.cardIds.length !== DECK_SIZE) {
    return fail(`Main deck must have exactly ${DECK_SIZE} cards, got ${deckList.cardIds.length}`);
  }
  if (!deckList.cardIds.includes(deckList.championId)) {
    return fail(`Champion ${deckList.championId} must be included in the ${DECK_SIZE}-card deck`);
  }

  const copyCounts = new Map<string, number>();
  for (const id of [...deckList.cardIds, ...deckList.sideboardCardIds]) {
    copyCounts.set(id, (copyCounts.get(id) ?? 0) + 1);
  }

  for (const id of deckList.cardIds) {
    const def = registry.tryGet(id);
    if (!def) return fail(`Unknown card id in deck: ${id}`);
    if (def.type === "Legend") return fail(`${id} is a Legend and cannot be a main-deck card`);
    if (!isCardLegalForLegend(def, legendDef.domains)) {
      return fail(`${def.name} shares no domain with legend ${legendDef.name}`);
    }
  }

  for (const [id, count] of copyCounts) {
    if (count > MAX_COPIES) {
      return fail(`Too many copies of ${id}: ${count} (max ${MAX_COPIES} across main deck + sideboard)`);
    }
  }

  if (deckList.runeDomainACount < 0 || deckList.runeDomainBCount < 0) {
    return fail("Rune domain counts cannot be negative");
  }
  if (deckList.runeDomainACount + deckList.runeDomainBCount !== RUNE_DECK_SIZE) {
    return fail(
      `Rune deck must total ${RUNE_DECK_SIZE} cards, got ${deckList.runeDomainACount} + ${deckList.runeDomainBCount}`,
    );
  }

  if (deckList.battlefieldNames.length !== BATTLEFIELD_COUNT) {
    return fail(`Deck must have exactly ${BATTLEFIELD_COUNT} battlefields, got ${deckList.battlefieldNames.length}`);
  }

  if (deckList.sideboardCardIds.length !== 0 && deckList.sideboardCardIds.length !== SIDEBOARD_SIZE) {
    return fail(`Sideboard must be empty or exactly ${SIDEBOARD_SIZE} cards, got ${deckList.sideboardCardIds.length}`);
  }
  for (const id of deckList.sideboardCardIds) {
    if (!registry.tryGet(id)) return fail(`Unknown card id in sideboard: ${id}`);
  }

  return ok();
}
