import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseDeckFile } from "../decks/deck-file-parser.js";
import type { DeckList } from "../decks/deck-list.js";

/**
 * Loads every `.deck` file in a directory (e.g. `~/.riftbound/decks`),
 * mirroring `CustomDeckRegistry.loadAllFromDisk` (registry/CustomDeckRegistry.java:61-72).
 * Malformed files are skipped, not thrown — same as the Java original.
 *
 * Node-only (real filesystem access) — deliberately kept out of the main
 * `@rift-engine/engine` entry point so a browser bundler never has to
 * reason about `node:fs`/`node:path`. Import from `@rift-engine/engine/node`
 * instead, from Node-only contexts (tests, a future CLI/server).
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
