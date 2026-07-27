import ognRaw from "./ogn.json" with { type: "json" };
import ogsRaw from "./ogs.json" with { type: "json" };
import type { Domain } from "../model/domain.js";
import { isDomain, lowestOrdinalDomain } from "../model/domain.js";
import { keywordFromBracketText, type Keyword } from "../model/keyword.js";
import type { CardDefinition } from "../model/card-definition.js";
import { extractCardItems, type RawCard } from "./raw-card-schema.js";

/**
 * Card pool in scope: Origins (OGN) + Proving Grounds (OGS) only — see PRD
 * open-question #1's resolution. sfd.json/unl.json exist in the oracle
 * repos but are out of scope until their own milestone; add them here the
 * same way, when that happens.
 *
 * Statically imported (not read via `fs` at runtime) so this module works
 * unmodified in both Node and a bundled browser build (e.g. packages/web) —
 * a real constraint discovered building the web board, not a preference:
 * `fs`/`node:path` can't be bundled for the browser at all, and Rollup
 * fails the build outright if anything in the module graph imports them
 * unconditionally, even if the function that uses them is never called
 * client-side.
 */
const CARD_FILES: readonly unknown[] = [ognRaw, ogsRaw];

const KW_PATTERN = /\[([A-Za-z][a-zA-Z]*)(?: (\d+))?\]/g;

/**
 * Playtesting fix ported from CardLoader.java:188-213 — Guerilla Warfare,
 * Ava Achiever, Ember Monk, and Noxus Saboteur each MENTION "[Hidden]" in
 * reference to other cards, rather than carrying the keyword themselves.
 * Confirmed present in the OGN/OGS pool (checked directly against both
 * files); every genuine [Hidden] card's text starts with "[Hidden] (Hide
 * now for...".
 */
const HIDDEN_KEYWORD_FALSE_POSITIVES = new Set(["Guerilla Warfare", "Ava Achiever", "Ember Monk", "Noxus Saboteur"]);

const LEGION_DISCOUNT_PATTERN = /\[Legion\].*?cost\s*:rb_energy_(\d+):\s*less/i;

/** Rune/Battlefield/Token-supertype/Showcase-rarity/alternate-art entries never become playable
 *  CardDefinitions. Mirrors CardLoader.java's `skip()` (registry/CardLoader.java:274-282). */
function shouldSkip(card: RawCard): boolean {
  const { classification, metadata } = card;
  if (classification.type === "Rune" || classification.type === "Battlefield") return true;
  if (classification.supertype === "Token") return true;
  if (classification.rarity === "Showcase") return true;
  return metadata.alternate_art;
}

/** "ogn-001-298" -> "OGN-001". Mirrors CardLoader.java's `deriveId` (registry/CardLoader.java:668-671). */
function deriveId(riftboundId: string): string {
  const parts = riftboundId.split("-");
  return `${parts[0]!.toUpperCase()}-${parts[1]}`;
}

function parseDomains(raw: string[]): Domain[] {
  return raw.map((d) => {
    const capitalized = d.charAt(0).toUpperCase() + d.slice(1).toLowerCase();
    if (!isDomain(capitalized)) throw new Error(`Unknown domain in card data: ${d}`);
    return capitalized;
  });
}

function parseKeywords(text: string): Partial<Record<Keyword, number>> {
  const result: Partial<Record<Keyword, number>> = {};
  for (const match of text.matchAll(KW_PATTERN)) {
    const keyword = keywordFromBracketText(match[1]!);
    if (!keyword) continue; // not one of our modeled keywords (e.g. a later-set keyword, or reminder-text noise)
    const magnitude = match[2] ? Number.parseInt(match[2], 10) : 1;
    result[keyword] = Math.max(result[keyword] ?? 0, magnitude);
  }
  return result;
}

function isGenuinelyHidden(plain: string, name: string): boolean {
  return plain.includes("[Hidden]") && !HIDDEN_KEYWORD_FALSE_POSITIVES.has(name);
}

function parseCardDefinition(card: RawCard): CardDefinition {
  const id = deriveId(card.riftbound_id);
  const name = card.name.replace(" (Starter)", "");
  const domains = parseDomains(card.classification.domain);
  const plain = card.text.plain ?? "";
  const imageUrl = card.media.image_url ?? "";
  const energyCost = card.attributes.energy ?? 0;
  const powerCost = card.attributes.power ?? 0;
  const powerDomain = powerCost > 0 ? lowestOrdinalDomain(domains) : null;

  switch (card.classification.type) {
    case "Legend":
      return {
        type: "Legend",
        id,
        name,
        domains,
        powerDomain: null,
        imageUrl,
        championTag: name.split(/\s+/)[0]!.toUpperCase(),
      };
    case "Unit": {
      const legionMatch = LEGION_DISCOUNT_PATTERN.exec(plain);
      return {
        type: "Unit",
        id,
        name,
        domains,
        powerDomain,
        imageUrl,
        energyCost,
        powerCost,
        might: card.attributes.might ?? 0,
        isChampion: card.classification.supertype === "Champion",
        keywords: parseKeywords(plain),
        legionDiscount: legionMatch ? Number.parseInt(legionMatch[1]!, 10) : 0,
        hidden: isGenuinelyHidden(plain, name),
        isReaction: plain.includes("[Reaction]"),
        tags: card.tags ?? [],
        text: plain,
      };
    }
    case "Spell":
      return {
        type: "Spell",
        id,
        name,
        domains,
        powerDomain,
        imageUrl,
        energyCost,
        powerCost,
        isReaction: plain.includes("[Reaction]"),
        isAction: plain.includes("[Action]"),
        hidden: isGenuinelyHidden(plain, name),
        text: plain,
      };
    case "Gear":
      return {
        type: "Gear",
        id,
        name,
        domains,
        powerDomain,
        imageUrl,
        energyCost,
        powerCost,
        keywords: parseKeywords(plain),
        isReaction: plain.includes("[Reaction]"),
        hidden: isGenuinelyHidden(plain, name),
        text: plain,
      };
    case "Rune":
    case "Battlefield":
      throw new Error(`${card.classification.type} cards should have been filtered out by shouldSkip()`);
  }
}

/** Every non-skipped CardDefinition from the in-scope card files (Origins + Proving Grounds). */
export function loadCardDefinitions(): CardDefinition[] {
  const defs: CardDefinition[] = [];
  for (const raw of CARD_FILES) {
    for (const item of extractCardItems(raw)) {
      if (shouldSkip(item)) continue;
      defs.push(parseCardDefinition(item));
    }
  }
  return defs;
}

/**
 * One real (non-alternate-art) rune image per domain — Rune-type cards are
 * deliberately excluded from `loadCardDefinitions` (they're never a
 * playable CardDefinition), but their art is still needed for display.
 * Mirrors CardLoader.loadRuneArt (registry/CardLoader.java:224-238), the
 * same "presentation-only side lookup, not a real CardDefinition" pattern.
 */
export function loadRuneArt(): Partial<Record<Domain, string>> {
  const art: Partial<Record<Domain, string>> = {};
  for (const raw of CARD_FILES) {
    for (const item of extractCardItems(raw)) {
      if (item.classification.type !== "Rune") continue;
      if (item.metadata.alternate_art) continue;
      const domains = parseDomains(item.classification.domain);
      const domain = domains[0];
      const imageUrl = item.media.image_url;
      if (domain && imageUrl && !art[domain]) art[domain] = imageUrl;
    }
  }
  return art;
}
