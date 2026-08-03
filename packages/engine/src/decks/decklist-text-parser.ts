import type { CardRegistry } from "../cards/card-registry.js";
import { isDomain, sortByDomainOrdinal } from "../model/domain.js";
import { BATTLEFIELD_COUNT, LEGACY_BATTLEFIELDS, RUNE_DECK_SIZE, SIDEBOARD_SIZE, type DeckList } from "./deck-list.js";

export interface DecklistTextImportResult {
  deckList: DeckList;
  /** Every pasted name (Legend/Champion/MainDeck/Sideboard) that didn't
   *  resolve to a real card in this build's registry, verbatim, deduped —
   *  surfaced so the UI can show the user exactly what to pick manually
   *  instead of silently dropping it. Non-empty is the COMMON case for a
   *  real community list, not a rare failure: this engine's card pool is
   *  deliberately Origins-only (see docs/PRD.md), so plenty of real decks
   *  reference champions/cards outside that scope. */
  unresolvedNames: string[];
}

const SECTION_KEYS = new Set(["legend", "champion", "maindeck", "battlefields", "runes", "sideboard"]);
type SectionKey = "legend" | "champion" | "maindeck" | "battlefields" | "runes" | "sideboard";

function normalizeHeader(line: string): SectionKey | null {
  const key = line.trim().replace(/:$/, "").replace(/\s+/g, "").toLowerCase();
  return SECTION_KEYS.has(key) ? (key as SectionKey) : null;
}

const DATA_LINE = /^(\d+)\s+(.+)$/;

/** Real copy-paste artifact: web text commonly substitutes curly quotes
 *  for straight apostrophes in names like "Zhonya's Hourglass". */
function normalizeQuotes(s: string): string {
  return s.replace(/[‘’]/g, "'");
}

/**
 * The name key this parser resolves on — quotes normalised, whitespace
 * collapsed, lowercased.
 *
 * Exported because the fold rests on an assumption about the POOL: that no two
 * cards fold to the same key. The test that pins that had its own hand-written
 * copy of this function, and the copy had already drifted — it omitted
 * `normalizeQuotes`, so two cards differing only by a curly versus straight
 * apostrophe would have collided here and passed there. This pool is full of
 * apostrophes (Kai'Sa, Zhonya's Hourglass, Kog'Maw, Spirit's Refuge), and a
 * collision would make one of the pair silently unreachable by name.
 */
export function foldCardName(name: string): string {
  return normalizeQuotes(name).replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Parses the plain-text decklist format sites like piltoverarchive.com and
 * riftdecks.com export — a different, name-based format from this engine's
 * own `.deck` KEY=value format (deck-file-parser.ts). Card names there use
 * "CharacterName, Title" (comma); this engine's registry uses
 * "CharacterName - Title" (confirmed directly against loaded card data,
 * e.g. "Master Yi - Wuju Bladesman") — resolution retries with that
 * separator swapped in before giving up on a name.
 *
 * Returns null only when the Legend line itself can't be resolved (nothing
 * else — champion eligibility, the card browser, rune-domain labels — can
 * be derived without one). Every other resolution gap is non-fatal: it's
 * recorded in unresolvedNames and simply omitted, meant to be completed by
 * hand in the DeckBuilder UI this feeds into.
 */
export function parseDecklistText(text: string, registry: CardRegistry): DecklistTextImportResult | null {
  /**
   * Keyed on a FOLDED name — lowercased, whitespace collapsed.
   *
   * Exact-match keying reported false gaps, and they were invisible because a
   * miss is non-fatal by design: a real community list asked for "Ride the Wind"
   * while the registry prints "Ride The Wind", so a card that exists (OGN-173)
   * landed in `unresolvedNames` and was silently dropped from the deck. Since
   * the whole point of that field is to say which names are outside this
   * Origins-only pool, a casing difference reading as "not in the pool" is the
   * measure lying rather than a card missing.
   *
   * Folding cannot introduce a wrong match here: two cards differing only by
   * case or spacing would already be indistinguishable to a human pasting a
   * list, and the assertion below pins that no such collision exists.
   */
  const fold = foldCardName;
  const byName = new Map(registry.all().map((def) => [fold(def.name), def]));

  function resolve(rawName: string) {
    const name = fold(rawName);
    // Community lists write "Character, Title"; this registry prints
    // "Character - Title". Retried folded, so the swap survives casing too.
    return byName.get(name) ?? byName.get(name.replace(", ", " - "));
  }

  const sections: Record<SectionKey, { qty: number; name: string }[]> = {
    legend: [],
    champion: [],
    maindeck: [],
    battlefields: [],
    runes: [],
    sideboard: [],
  };

  let current: SectionKey | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = normalizeQuotes(rawLine.replace(/^﻿/, "")).trim();
    if (!line) continue;
    const header = normalizeHeader(line);
    if (header) {
      current = header;
      continue;
    }
    if (!current) continue;
    const match = DATA_LINE.exec(line);
    if (!match) continue;
    sections[current].push({ qty: Number.parseInt(match[1]!, 10), name: match[2]! });
  }

  const unresolvedNames: string[] = [];
  const unresolvedSet = new Set<string>();
  function markUnresolved(name: string) {
    if (!unresolvedSet.has(name)) {
      unresolvedSet.add(name);
      unresolvedNames.push(name);
    }
  }

  const legendLine = sections.legend[0];
  const legendDef = legendLine ? resolve(legendLine.name) : undefined;
  if (!legendDef || legendDef.type !== "Legend") return null;

  const championLine = sections.champion[0];
  let championId = "";
  if (championLine) {
    const championDef = resolve(championLine.name);
    if (championDef) championId = championDef.id;
    else markUnresolved(championLine.name);
  }

  function expandCardIds(lines: { qty: number; name: string }[]): string[] {
    const ids: string[] = [];
    for (const { qty, name } of lines) {
      const def = resolve(name);
      if (!def) {
        markUnresolved(name);
        continue;
      }
      for (let i = 0; i < qty; i++) ids.push(def.id);
    }
    return ids;
  }

  const mainDeckIds = expandCardIds(sections.maindeck);
  const cardIds = championId ? [...mainDeckIds, championId] : mainDeckIds;

  // All-or-nothing: a partially-resolved sideboard (e.g. 7/8) would fail
  // validateDeckList's exact "0 or 8" check with no in-UI way to complete
  // it (unlike the main deck, which has a full card browser) — an
  // incomplete sideboard becomes empty instead, with the gap surfaced via
  // unresolvedNames like everything else.
  const sideboardExpanded: string[] = [];
  let sideboardComplete = true;
  for (const { qty, name } of sections.sideboard) {
    const def = resolve(name);
    if (!def) {
      markUnresolved(name);
      sideboardComplete = false;
      continue;
    }
    for (let i = 0; i < qty; i++) sideboardExpanded.push(def.id);
  }
  const sideboardCardIds = sideboardComplete && sideboardExpanded.length === SIDEBOARD_SIZE ? sideboardExpanded : [];

  const orderedDomains = sortByDomainOrdinal(legendDef.domains);
  let runeDomainACount = 0;
  let runeDomainBCount = 0;
  for (const { qty, name } of sections.runes) {
    const domainCandidate = name.replace(/\s+Rune$/, "");
    if (!isDomain(domainCandidate) || !legendDef.domains.includes(domainCandidate)) {
      markUnresolved(name);
      continue;
    }
    if (domainCandidate === orderedDomains[0]) runeDomainACount += qty;
    else if (domainCandidate === orderedDomains[1]) runeDomainBCount += qty;
  }
  // Fall back to an even split if nothing in the pasted text resolved to a
  // real rune line — still a legal-shaped default (sums to RUNE_DECK_SIZE)
  // rather than leaving both at 0, which validateDeckList would reject
  // outright with no clue as to why.
  if (runeDomainACount + runeDomainBCount === 0 && sections.runes.length === 0) {
    runeDomainACount = RUNE_DECK_SIZE / 2;
    runeDomainBCount = RUNE_DECK_SIZE / 2;
  }

  // Fall back to LEGACY_BATTLEFIELDS (parseDeckFile's own convention) when
  // the pasted section doesn't yield exactly 3 names — DeckBuilder has no
  // battlefield picker to fix a wrong count in-UI, since LEGACY_BATTLEFIELDS
  // is the only known battlefield-name pool anywhere in the engine yet.
  const parsedBattlefieldNames = sections.battlefields.flatMap(({ qty, name }) => Array(qty).fill(name) as string[]);
  const battlefieldNames = parsedBattlefieldNames.length === BATTLEFIELD_COUNT ? parsedBattlefieldNames : LEGACY_BATTLEFIELDS;

  const championDef = championId ? registry.tryGet(championId) : undefined;
  const deckList: DeckList = {
    name: `${championDef?.name ?? legendDef.name} (imported)`,
    legendId: legendDef.id,
    championId,
    cardIds,
    runeDomainACount,
    runeDomainBCount,
    battlefieldNames,
    sideboardCardIds,
  };

  return { deckList, unresolvedNames };
}
