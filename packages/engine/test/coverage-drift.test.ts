import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { implementingModule } from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";

/**
 * coverage.ts answers "does this card's printed text actually do something?",
 * and the deck builder greys out every card it says no to. That answer is only
 * worth showing if it can't quietly go stale.
 *
 * The failure mode this pins is real and has happened twice. First, an audit
 * matched `OGN-127` inside a COMMENT explaining why Cannon Barrage was
 * deliberately unimplemented, and so reported the card as handled. Second,
 * coverage.ts asked only the three effect registries, so six cards implemented
 * as continuous modifiers, activated abilities or parse-time keywords were
 * reported inert although they worked — which greyed them in the UI and would
 * have sent a per-card implementation pass to rewrite working code.
 *
 * Both are the same bug: the set of places a card can be implemented was decided
 * by hand. Here it's decided by reading the source.
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** Directories that hold card DATA or DECK LISTS rather than implementations.
 *  A card id here means "this card exists" or "this deck contains it", never
 *  "its text is implemented", so scanning them would flag the whole pool. */
const EXCLUDED_DIRS = new Set(["data", "decks"]);

/**
 * Card ids that appear in engine source without implementing anything.
 *
 * Each needs a reason, because "add it to the exclusion list" is the easy way to
 * defeat this test. The bar is that the id must not be about the card's printed
 * TEXT at all.
 */
const NOT_TEXT_IMPLEMENTATIONS = new Map<string, string>([
  [
    "OGS-018",
    "Tibbers' split Fury/Chaos Power pip (card-loader's POWER_DOMAIN_ALT_OVERRIDES) — " +
      "that's cost data printed on the card frame, not rules text, so it never made the card look inert.",
  ],
]);

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      out.push(...tsFilesUnder(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Source with comments removed, so prose ABOUT a card can never be mistaken for
 * an implementation OF it — the Cannon Barrage mistake, mechanised.
 *
 * The line-comment strip deliberately skips `//` preceded by `:` so that a URL
 * in a string literal survives intact; over-trimming would hide a real id and
 * turn this test silently permissive.
 */
function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlocks
    .split("\n")
    .map((line) => {
      const at = line.search(/(?<!:)\/\//);
      return at === -1 ? line : line.slice(0, at);
    })
    .join("\n");
}

const CARD_ID = /OG[NS]-\d{3}/g;

interface Occurrence {
  defId: string;
  file: string;
}

function scanForCardIds(): Occurrence[] {
  const found: Occurrence[] = [];
  for (const file of tsFilesUnder(SRC)) {
    const code = stripComments(readFileSync(file, "utf8"));
    for (const match of code.matchAll(CARD_ID)) {
      found.push({ defId: match[0], file: relative(SRC, file).split(sep).join("/") });
    }
  }
  return found;
}

describe("coverage.ts knows about every place a card can be implemented", () => {
  const occurrences = scanForCardIds();

  it("finds card ids in the engine source at all (the scan itself works)", () => {
    // A broken scan would make every assertion below vacuously pass, which is
    // the one way this test could lie.
    expect(occurrences.length).toBeGreaterThan(20);
    expect(new Set(occurrences.map((o) => o.file)).size).toBeGreaterThan(3);
  });

  it("ignores card ids that only appear in comments", () => {
    // Cannon Barrage is now implemented, so pick a synthetic case: prose
    // mentioning an id must not register as an implementation.
    const stripped = stripComments(`// see OGN-999 for why this is unimplemented\nconst x = 1;`);
    expect(stripped).not.toContain("OGN-999");
  });

  it("keeps a URL in a string literal intact while stripping trailing comments", () => {
    const stripped = stripComments(`const u = "https://x.test/OGN-123"; // OGN-456 explained`);
    expect(stripped).toContain("OGN-123");
    expect(stripped).not.toContain("OGN-456");
  });

  it("every card implemented in engine source is one coverage.ts counts", () => {
    const unaccounted = new Map<string, Set<string>>();
    for (const { defId, file } of occurrences) {
      if (implementingModule(defId) !== undefined) continue;
      if (NOT_TEXT_IMPLEMENTATIONS.has(defId)) continue;
      if (!unaccounted.has(defId)) unaccounted.set(defId, new Set());
      unaccounted.get(defId)!.add(file);
    }

    const registry = defaultCardRegistry();
    const report = [...unaccounted]
      .map(([defId, files]) => `  ${defId} (${registry.tryGet(defId)?.name ?? "unknown"}) in ${[...files].join(", ")}`)
      .join("\n");

    expect(
      unaccounted.size,
      `These cards are implemented in engine source but coverage.ts doesn't know it, so the deck builder\n` +
        `greys them out and a per-card pass would rewrite them. Export a defIds() from the module and add\n` +
        `it to COVERAGE_SOURCES in coverage.ts — or, if the id isn't about the card's printed text, add it\n` +
        `to NOT_TEXT_IMPLEMENTATIONS here with a reason:\n${report}`,
    ).toBe(0);
  });

  it("every excluded id is still present in the source (no stale exclusions)", () => {
    const seen = new Set(occurrences.map((o) => o.defId));
    for (const [defId, reason] of NOT_TEXT_IMPLEMENTATIONS) {
      expect(seen.has(defId), `${defId} is excluded ("${reason}") but no longer appears in engine source`).toBe(true);
    }
  });

  it("no module claims a card that isn't real", () => {
    const registry = defaultCardRegistry();
    for (const { defId, file } of occurrences) {
      const module = implementingModule(defId);
      if (module === undefined) continue;
      expect(registry.tryGet(defId), `${module} claims ${defId} (referenced in ${file}) but it is not a real card`).toBeDefined();
    }
  });
});
