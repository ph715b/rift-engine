import { LEGACY_BATTLEFIELDS, SIDEBOARD_SIZE, type DeckList } from "./deck-list.js";

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

  // Reads SIDEBOARD_SIZE rather than a literal: this line said 8 while the
  // constant said 8 too, so the drift was invisible until the size changed.
  // A CAP rather than an exact count — see the constant's own note.
  if (sideboardCardIds.length > SIDEBOARD_SIZE) return null;

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
 * The mirror of parseDeckFile — writes the same KEY=value format back out.
 * No CardRegistry needed: a DeckList already stores ids for everything
 * except battlefieldNames (which the format itself stores as plain names).
 */
export function serializeDeckFile(deck: DeckList): string {
  const lines = [
    `NAME=${deck.name}`,
    `LEGEND=${deck.legendId}`,
    `CHAMPION=${deck.championId}`,
    `RUNE_A=${deck.runeDomainACount}`,
    `RUNE_B=${deck.runeDomainBCount}`,
    ...deck.cardIds.map((id) => `CARD=${id}`),
    ...deck.battlefieldNames.map((name) => `BATTLEFIELD=${name}`),
    ...deck.sideboardCardIds.map((id) => `SIDEBOARD=${id}`),
  ];
  return lines.join("\n") + "\n";
}
