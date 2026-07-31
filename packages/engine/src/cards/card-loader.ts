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

/**
 * Cards whose printed Power pip is VISUALLY split between two domains
 * (confirmed by direct inspection of the card art), as opposed to merely
 * listing two raw domains in classification.domain — the ordinary
 * multi-domain-identity case (e.g. Decisive Strike's Body+Order, whose pip
 * is a solid single color and is NOT hybrid; that raw list is a Signature
 * card's inherited Legend color identity, used for deckbuilding, not a
 * dual Power cost). Hardcoded rather than derived from card data — precise
 * and safe for a handful of confirmed cases, mirroring CARD_EFFECTS
 * (engine/card-effects.ts)'s identical "not worth a parsing scheme until
 * there are enough registered cases" reasoning. Add another entry here
 * ONLY after the same visual confirmation, never by assuming every
 * multi-domain card is hybrid.
 */
const POWER_DOMAIN_ALT_OVERRIDES: Record<string, Domain> = {
  "OGS-018": "Chaos", // Tibbers — Fury/Chaos split pip; lowestOrdinalDomain already yields "Fury" as the primary domain below
};

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

/**
 * Cards whose printed text grants "enters ready" as plain prose ("I enter
 * ready.") rather than the bracketed `[Quick]` keyword tag `parseKeywords`
 * looks for — confirmed by direct inspection of both cards' raw text
 * (Vanguard Attendant: "I enter ready."; Master Yi - Honed: "[Ganking] I
 * enter ready."). Mechanically identical to Quick (execute-play-card.ts's
 * `exhausted: !("Quick" in card.keywords)`), so reuse that existing,
 * already-correct mechanism rather than adding a redundant on-play
 * un-exhaust effect for the same outcome.
 */
const QUICK_TEXT_OVERRIDES = new Set(["OGS-016", "OGS-009"]); // Vanguard Attendant, Master Yi - Honed

/**
 * Cards whose bracketed keywords are CONDITIONAL, so parsing them as printed
 * keywords makes the card strictly better than it reads.
 *
 * "While I'm buffed, I have [Ganking]" and "If you've discarded a card this
 * turn, I have [Assault] and [Ganking]" both put a real keyword inside a
 * condition, and the parser can only see the brackets. All three of these were
 * shipping with their keywords permanently on — Bilgewater Bully could move
 * battlefield-to-battlefield with no buff, Raging Soul attacked at +1 having
 * discarded nothing.
 *
 * The keywords are granted at runtime instead, under the real condition, by
 * engine/granted-keywords.ts. A named per-card set rather than a parser that
 * tries to understand conditions — the same choice, for the same reason, as
 * HIDDEN_KEYWORD_FALSE_POSITIVES above.
 */
const CONDITIONAL_KEYWORD_DEF_IDS = new Set([
  "OGN-019", // Raging Soul — [Assault] and [Ganking] only once you've discarded
  "OGN-125", // Bilgewater Bully — [Ganking] only while buffed
  "OGN-232", // Fiora - Victorious — [Deflect]/[Ganking]/[Shield] only while Mighty
]);

/**
 * The cards whose printed text the LOADER implements, by turning it into a
 * keyword the rules engine already honors.
 *
 * These are genuinely implemented — "I enter ready." is fully handled — but the
 * implementation is a parse-time keyword rather than a registered effect, so
 * coverage.ts has no other way to know. POWER_DOMAIN_ALT_OVERRIDES is
 * deliberately NOT included: a split Power pip is card data, not rules text, so
 * it never made the card look inert in the first place.
 */
export function loaderHandledDefIds(): string[] {
  return [...QUICK_TEXT_OVERRIDES];
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
  const powerDomainAlt = powerCost > 0 ? POWER_DOMAIN_ALT_OVERRIDES[id] : undefined;

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
        // Was omitted, which made every Legend's printed ability invisible to
        // coverage.ts — see CardDefinitionBase.text.
        text: plain,
      };
    case "Unit": {
      const legionMatch = LEGION_DISCOUNT_PATTERN.exec(plain);
      return {
        type: "Unit",
        id,
        name,
        domains,
        powerDomain,
        ...(powerDomainAlt !== undefined ? { powerDomainAlt } : {}),
        imageUrl,
        energyCost,
        powerCost,
        might: card.attributes.might ?? 0,
        isChampion: card.classification.supertype === "Champion",
        keywords: {
          ...(CONDITIONAL_KEYWORD_DEF_IDS.has(id) ? {} : parseKeywords(plain)),
          ...(QUICK_TEXT_OVERRIDES.has(id) ? { Quick: 1 } : {}),
        },
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
        ...(powerDomainAlt !== undefined ? { powerDomainAlt } : {}),
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
        ...(powerDomainAlt !== undefined ? { powerDomainAlt } : {}),
        imageUrl,
        energyCost,
        powerCost,
        keywords: CONDITIONAL_KEYWORD_DEF_IDS.has(id) ? {} : parseKeywords(plain),
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

/**
 * Art for the runtime-only tokens this engine creates, keyed by the defId
 * token.ts stamps on them. Token-supertype cards are filtered out of the
 * loaded pool entirely (they're never playable cards, and the printed
 * "Recruit (271) // Buff" entries are three near-identical copies), so a
 * created token has no CardDefinition to look art up from and would otherwise
 * render as a blank fallback frame. Same presentation-only side-lookup
 * pattern as loadRuneArt above, and the same one CardLoader.java:677 uses for
 * exactly this card's tokens.
 */
export function loadTokenArt(): Partial<Record<string, string>> {
  const art: Partial<Record<string, string>> = {};
  for (const raw of CARD_FILES) {
    for (const item of extractCardItems(raw)) {
      if (item.classification.supertype !== "Token") continue;
      if (item.metadata.alternate_art) continue;
      if (!/^Recruit\b/.test(item.name)) continue;
      const imageUrl = item.media.image_url;
      if (imageUrl && !art["TOKEN-RECRUIT"]) art["TOKEN-RECRUIT"] = imageUrl;
    }
  }
  return art;
}

export interface BattlefieldDefinition {
  id: string;
  name: string;
  imageUrl: string;
  text: string;
  domains: Domain[];
}

/**
 * Real Battlefield-type cards (name, art, rules text) — like Rune-type
 * cards, Battlefields are deliberately excluded from `loadCardDefinitions`
 * (`shouldSkip` above; `BattlefieldState` carries no per-name ability yet,
 * so there's no playable CardDefinition to build), but a deck builder
 * still wants to offer real, named battlefields to pick from rather than
 * only free text. Same "presentation-only side lookup, not a real
 * CardDefinition" pattern as `loadRuneArt`.
 */
export function loadBattlefieldDefinitions(): BattlefieldDefinition[] {
  const seen = new Set<string>();
  const defs: BattlefieldDefinition[] = [];
  for (const raw of CARD_FILES) {
    for (const item of extractCardItems(raw)) {
      if (item.classification.type !== "Battlefield") continue;
      if (item.metadata.alternate_art) continue;
      if (seen.has(item.name)) continue;
      const imageUrl = item.media.image_url;
      if (!imageUrl) continue;
      seen.add(item.name);
      defs.push({
        id: deriveId(item.riftbound_id),
        name: item.name,
        imageUrl,
        text: item.text.plain ?? "",
        domains: parseDomains(item.classification.domain),
      });
    }
  }
  return defs;
}
