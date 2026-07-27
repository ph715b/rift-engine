import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_BATTLEFIELDS, type DeckList } from "./deck-list.js";

/**
 * Parses the `.deck` file format written/read by CustomDeckRegistry
 * (registry/CustomDeckRegistry.java:43-108): plain `KEY=value` lines, no
 * library, prefix-matched. Returns null on anything malformed — mirroring
 * `readDeckFile`'s "skip and log" behavior for corrupted files rather than
 * throwing, since a directory of real decks may contain one bad file.
 */
export function parseDeckFile(contents: string): DeckList | null {
  let name: string | null = null;
  let legendId: string | null = null;
  let championId: string | null = null;
  let runeA: number | null = null;
  let runeB: number | null = null;
  const cardIds: string[] = [];
  const battlefieldNames: string[] = [];
  const sideboardCardIds: string[] = [];

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.replace(/^﻿/, "");
    if (line.startsWith("NAME=")) name = line.slice("NAME=".length);
    else if (line.startsWith("LEGEND=")) legendId = line.slice("LEGEND=".length);
    else if (line.startsWith("CHAMPION=")) championId = line.slice("CHAMPION=".length);
    else if (line.startsWith("RUNE_A=")) runeA = Number.parseInt(line.slice("RUNE_A=".length), 10);
    else if (line.startsWith("RUNE_B=")) runeB = Number.parseInt(line.slice("RUNE_B=".length), 10);
    else if (line.startsWith("CARD=")) cardIds.push(line.slice("CARD=".length));
    else if (line.startsWith("BATTLEFIELD=")) battlefieldNames.push(line.slice("BATTLEFIELD=".length));
    else if (line.startsWith("SIDEBOARD=")) sideboardCardIds.push(line.slice("SIDEBOARD=".length));
  }

  if (
    name === null ||
    legendId === null ||
    championId === null ||
    runeA === null ||
    Number.isNaN(runeA) ||
    runeB === null ||
    Number.isNaN(runeB) ||
    cardIds.length !== 40
  ) {
    return null;
  }

  let battlefields = battlefieldNames;
  if (battlefields.length === 0) battlefields = LEGACY_BATTLEFIELDS;
  else if (battlefields.length !== 3) return null;

  if (sideboardCardIds.length !== 0 && sideboardCardIds.length !== 8) return null;

  return {
    name,
    legendId,
    championId,
    cardIds,
    runeDomainACount: runeA,
    runeDomainBCount: runeB,
    battlefieldNames: battlefields,
    sideboardCardIds,
  };
}

/**
 * Loads every `.deck` file in a directory (e.g. `~/.riftbound/decks`),
 * mirroring `CustomDeckRegistry.loadAllFromDisk` (registry/CustomDeckRegistry.java:61-72).
 * Malformed files are skipped, not thrown — same as the Java original.
 */
export function loadDeckFilesFromDirectory(dir: string): DeckList[] {
  let fileNames: string[];
  try {
    fileNames = readdirSync(dir);
  } catch {
    return []; // no saved decks directory yet
  }

  const decks: DeckList[] = [];
  for (const fileName of fileNames) {
    if (!fileName.endsWith(".deck")) continue;
    const contents = readFileSync(join(dir, fileName), "utf8");
    const deck = parseDeckFile(contents);
    if (deck) decks.push(deck);
  }
  return decks;
}
