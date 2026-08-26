import type { CardRegistry } from "../cards/card-registry.js";
import { loadBattlefieldDefinitions } from "../cards/card-loader.js";
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
  const key = line
    .trim()
    // A trailing count, which several exporters add — "Battlefields (3):",
    // "Main Deck (40)". The colon is stripped on BOTH sides of the parenthetical
    // because either order occurs, and stripping it only once (before the count,
    // as this first did) leaves "battlefields(3)" unrecognised — which is exactly
    // the silent miss this whole change is about.
    .replace(/[:\s]*$/, "")
    .replace(/\s*\(\s*\d+\s*\)\s*$/, "")
    .replace(/[:\s]*$/, "")
    .replace(/\s+/g, "")
    .toLowerCase();
  if (SECTION_KEYS.has(key)) return key as SectionKey;
  // **Singular headers.** "Battlefield:" and "Rune:" are both in the wild, and a
  // header this parser does not recognise is not an error it can see: the
  // section simply never opens, its lines are skipped as orphans, and the deck
  // imports with the default battlefields and no warning. That silence is what
  // the reported bug actually was.
  const pluralised = `${key}s`;
  return SECTION_KEYS.has(pluralised) ? (pluralised as SectionKey) : null;
}

/** "3 Card Name" and "3x Card Name" — the `x` is optional and may be attached to
 *  the digits or spaced. */
const DATA_LINE = /^(\d+)\s*x?\s+(.+)$/i;

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
    if (match) {
      sections[current].push({ qty: Number.parseInt(match[1]!, 10), name: match[2]! });
      continue;
    }
    // **A bare name, with no quantity — accepted in the BATTLEFIELDS section
    // only, and that restriction is principled rather than cautious.**
    //
    // A battlefield list is always exactly three battlefields, one copy each, so
    // a quantity carries no information and plenty of exporters omit it. A main
    // deck line without one is genuinely ambiguous — it could be a comment, a
    // site footer, or a card — and guessing 1 there would turn "Deck built with
    // Piltover Archive" into a card name.
    if (current === "battlefields") sections.battlefields.push({ qty: 1, name: line });
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
  // `<=` rather than `===`: a community export listing eight is a legal deck
  // under a ten-card cap, and dropping its sideboard on the floor silently is
  // how an imported list quietly loses cards.
  const sideboardCardIds = sideboardComplete && sideboardExpanded.length <= SIDEBOARD_SIZE ? sideboardExpanded : [];

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

  /**
   * **Battlefield names are RESOLVED now, and a name that does not resolve is
   * REPORTED rather than silently swapped.**
   *
   * Reported from playtesting: *"parser for deck import is not getting the
   * battlefields"*. Four shapes fell through — a singular `Battlefield:` header,
   * a `Battlefields (3):` header, bare names with no quantity, and an `Nx`
   * prefix — and every one of them landed here, took the fallback, and imported
   * a deck with three battlefields the player never chose. The header and
   * quantity forms are fixed above; this is the part that made those failures
   * INVISIBLE.
   *
   * The old note said `LEGACY_BATTLEFIELDS` "is the only known battlefield-name
   * pool anywhere in the engine yet". That stopped being true when the last of
   * the 64 landed: `loadBattlefieldDefinitions()` is a real pool, so a pasted
   * name can be checked rather than trusted, and a typo or an out-of-pool
   * battlefield now surfaces in `unresolvedNames` exactly as an unknown CARD
   * does — which is the whole reason that field exists.
   *
   * The fallback stays, because `DeckBuilder` still has no battlefield picker
   * and an import that produced an invalid deck would be worse than one that
   * produced a playable default. What changes is that it is no longer silent.
   */
  const parsedBattlefieldNames = sections.battlefields.flatMap(({ qty, name }) => Array(qty).fill(name) as string[]);
  const battlefieldByName = new Map(loadBattlefieldDefinitions().map((def) => [fold(def.name), def.name]));
  // Resolved to the pool's OWN spelling, so a list pasted with different casing
  // or a curly apostrophe still names the battlefield the rest of the engine
  // knows — the same normalisation `resolve` does for cards.
  const resolvedBattlefieldNames: string[] = [];
  for (const name of parsedBattlefieldNames) {
    const canonical = battlefieldByName.get(fold(name));
    if (canonical === undefined) unresolvedNames.push(name);
    else resolvedBattlefieldNames.push(canonical);
  }
  const battlefieldNames =
    resolvedBattlefieldNames.length === BATTLEFIELD_COUNT ? resolvedBattlefieldNames : LEGACY_BATTLEFIELDS;

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
