import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Domain } from "../model/domain.js";
import { isDomain, lowestOrdinalDomain } from "../model/domain.js";
import { keywordFromBracketText, type Keyword } from "../model/keyword.js";
import type { CardDefinition } from "../model/card-definition.js";
import { extractCardItems, type RawCard } from "./raw-card-schema.js";

const CARDS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Card pool in scope: Origins (OGN) + Proving Grounds (OGS) only — see PRD
 * open-question #1's resolution. sfd.json/unl.json exist in the oracle
 * repos but are out of scope until their own milestone; add them to this
 * list the same way, when that happens.
 */
const CARD_FILES = ["ogn.json", "ogs.json"];

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

function readJsonFile(filePath: string): unknown {
  const raw = readFileSync(filePath, "utf8").replace(/^﻿/, "");
  return JSON.parse(raw);
}

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

/** Loads every non-skipped CardDefinition from the in-scope card files (Origins + Proving Grounds). */
export function loadCardDefinitions(): CardDefinition[] {
  const defs: CardDefinition[] = [];
  for (const file of CARD_FILES) {
    const raw = readJsonFile(join(CARDS_DIR, file));
    for (const item of extractCardItems(raw)) {
      if (shouldSkip(item)) continue;
      defs.push(parseCardDefinition(item));
    }
  }
  return defs;
}
