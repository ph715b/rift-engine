import type { CardRegistry } from "../cards/card-registry.js";
import type { CardDefinition, UnitDefinition } from "../model/card-definition.js";
import type { Domain } from "../model/domain.js";
import { fail, ok, type ValidationResult } from "../actions/validation-result.js";
import { BATTLEFIELD_COUNT, DECK_SIZE, MAX_COPIES, RUNE_DECK_SIZE, SIDEBOARD_SIZE, type DeckList } from "./deck-list.js";
import { foldCardName } from "./decklist-text-parser.js";

/**
 * A champion is eligible for a legend when its name shares the legend's
 * leading "CharacterName - " prefix and its domains are a subset of the
 * legend's. Mirrors DeckPresets.championsFor (registry/DeckPresets.java:48-60).
 * Exported (not just used by validateDeckList below) so a deck-builder UI can
 * filter its champion picker with the exact same rule, rather than a second
 * copy of this logic drifting out of sync.
 *
 * **The prefix match is FOLDED, not literal, and SFD is why.** Spiritforged
 * ships the same character's name cased two ways: the Legend is `Rek'sai - Void
 * Burrower` while both of its champions are `Rek'Sai - Breacher` and `Rek'Sai -
 * Swarm Queen`. A literal `startsWith` matched neither, which made Rek'Sai the
 * only Legend in the pool with no eligible champion — and since a deck must
 * contain a champion eligible for its Legend, NO legal deck could be built for
 * her at all. The domains were fine; it was one capital S.
 *
 * `foldCardName` is the pool's existing fold (lowercase, collapsed whitespace,
 * normalised quotes) and is reused rather than re-implemented here — the same
 * decision, for the same reason, as the decklist collision check that once
 * carried its own drifted hand-copy of it in a pool holding Kai'Sa and Kog'Maw.
 * It also makes the curly/straight apostrophe difference a non-issue for the
 * next set that ships one.
 */
export function isEligibleChampion(champion: UnitDefinition, legendName: string, legendDomains: readonly string[]): boolean {
  const character = legendCharacter(legendName);
  const championName = championCharacter(champion.name);
  if (championName === undefined) return false;
  if (foldCardName(championName) !== foldCardName(character)) return false;
  return champion.domains.every((d) => legendDomains.includes(d));
}

/**
 * The two separators a printed name uses between a character and their title.
 *
 * **Vendetta changed the convention, wholesale, and it is a set-wide fact rather
 * than noise** — measured over the loaded pool: all 128 champions in
 * OGN/OGS/SFD/UNL are `Akali - Silent`, and all 38 in VEN are `Akali, Silent`,
 * with no set mixing the two.
 *
 * Left unhandled, the old `"{character} - "` prefix matched NO Vendetta champion
 * to ANY Vendetta legend, and `validateDeckList` requires the designated champion
 * to be eligible — so no legal Vendetta deck could be built at all, and nothing
 * said so: the champion picker was simply empty. That is the failure this
 * module's Rek'Sai note describes, one capital S turned into one comma.
 *
 * **Accepting the comma POOL-WIDE rather than per-set is deliberate, and it is
 * measurably a no-op for the first four sets**: zero of their champions contain
 * `", "` at all, and zero of their legends carry a comma in the character half.
 * So there is no pairing this can change except the ones it exists to fix, and a
 * set-scoped branch would be a second rule to keep in step for no benefit.
 *
 * The em dash stays rejected, and so does a name with no separator at all —
 * both are pinned in `deck-validation.test.ts`. This widens the SEPARATOR set,
 * it does not loosen the requirement that there be one.
 */
const TITLE_SEPARATORS = [" - ", ", "] as const;

/** The character a CHAMPION's printed name names, or undefined when the name
 *  carries no title separator — which stays ineligible, since the whole rule is
 *  that a champion's name announces whose champion it is. */
function championCharacter(name: string): string | undefined {
  for (const separator of TITLE_SEPARATORS) {
    const at = name.indexOf(separator);
    if (at > 0) return name.slice(0, at);
  }
  return undefined;
}

/**
 * The character a LEGEND's printed name names.
 *
 * `" - "` is checked first and unconditionally, because every legend in the pool
 * uses it — including Vendetta's, whose CHAMPIONS moved to the comma while its
 * legends did not.
 *
 * **The trailing comma-segment strip is for exactly one card, and it is upstream
 * data noise rather than a naming convention.** `VEN-155` / `VEN-197` arrive as
 * `Yordle, Kennen - Heart of the Tempest`, which yields the character
 * `"Yordle, Kennen"` and matches nothing. The card's own `tags` are
 * `["Yordle", "Kennen"]` — *identical to those of its champion*, `VEN-113
 * Kennen, Storm of Shuriken` — so `Yordle` is the tribal tag leaked into the
 * name and `Kennen` is the character. Every other legend in the pool has no
 * comma in its character half at all (measured), so this strip is inert
 * everywhere else and generalises to the next such leak instead of naming a
 * defId.
 */
function legendCharacter(name: string): string {
  const at = name.indexOf(" - ");
  const character = at > 0 ? name.slice(0, at) : name;
  const lastComma = character.lastIndexOf(", ");
  return lastComma > 0 ? character.slice(lastComma + 2) : character;
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
 * Does this card print `[Unique]` — "Your deck can have only 1 card with this
 * name"? Spiritforged's three legendary Equipment (Forgefire Cape, Rabadon's
 * Deathcrown, Shurelya's Requiem) are the pool's only ones.
 *
 * A deckbuilding restriction rather than a gameplay ability, which is why it is
 * in `NON_KEYWORD_BRACKETS` rather than `KEYWORDS` — and this function is the
 * "what reads it" that entry names. Allow-listing the token without enforcing
 * anything would have made the bracket-sweep gate pass on a bracket that still
 * does nothing, which is the one outcome that gate exists to prevent.
 *
 * Read off the printed text, the same source `coverage.unimplementedKeywordsOn`
 * uses, rather than a new loader field: the restriction is on the CARD, is
 * static, and three cards do not justify widening `CardDefinition` — but note
 * the rule is by NAME and this is enforced by id below, which is exact only
 * while no two ids share a name. `parseDecklistText` already has a test that no
 * two card names collide once folded, so that premise is checked elsewhere.
 */
export function isUniqueCard(def: CardDefinition): boolean {
  return "text" in def && typeof def.text === "string" && /\[Unique\]/i.test(def.text);
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
    const def = registry.tryGet(id);
    // `[Unique]` (SFD) tightens the ordinary 3-copy cap to 1 for this card.
    const cap = def && isUniqueCard(def) ? 1 : MAX_COPIES;
    if (count > cap) {
      return fail(
        cap === 1
          ? `Too many copies of ${id}: ${count} ([Unique] allows only 1 across main deck + sideboard)`
          : `Too many copies of ${id}: ${count} (max ${MAX_COPIES} across main deck + sideboard)`,
      );
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

  if (deckList.sideboardCardIds.length > SIDEBOARD_SIZE) {
    return fail(`Sideboard may hold at most ${SIDEBOARD_SIZE} cards, got ${deckList.sideboardCardIds.length}`);
  }
  for (const id of deckList.sideboardCardIds) {
    if (!registry.tryGet(id)) return fail(`Unknown card id in sideboard: ${id}`);
  }

  return ok();
}
