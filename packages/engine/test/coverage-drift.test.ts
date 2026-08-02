import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  implementableText,
  implementingModule,
  isCardImplemented,
  needsImplementation,
  partialImplementationNote,
  unimplementedKeywordsOn,
} from "../src/engine/coverage.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import { KEYWORDS } from "../src/model/keyword.js";

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

/**
 * Coverage can only be trusted if every card TYPE reaches it.
 *
 * `implementableText` reads `def.text`, and `text` used to be declared
 * separately on Unit, Spell and Gear and simply omitted from Legend — so every
 * Legend in the pool looked textless, `needsImplementation` said no, and all 7
 * preset legends reported as implemented. Three of them (Jinx - Loose Cannon,
 * Lee Sin - Blind Monk, Viktor - Herald of the Arcane) did nothing at all.
 *
 * That is the opposite direction from the drift the rest of this file guards —
 * this one reported working cards as inert, that one reported inert cards as
 * working — and over-reporting is the worse half, because nothing looks wrong.
 */
describe("every card type reaches the coverage measure", () => {
  const registry = defaultCardRegistry();

  it("gives every type a text field, so none can be invisible to it", () => {
    const byType = new Map<string, number>();
    for (const def of registry.all()) {
      if (typeof def.text !== "string") byType.set(def.type, (byType.get(def.type) ?? 0) + 1);
    }
    expect([...byType.entries()], "these card types carry no printed text at all").toEqual([]);
  });

  it("sees a LEGEND's printed ability", () => {
    // Named because it is the case that was wrong, and a generic assertion over
    // the pool would pass again the moment Legends were the only textless type.
    const leeSin = registry.get("OGN-257"); // "1 Energy, exhaust: Buff a friendly unit."
    expect(leeSin.type).toBe("Legend");
    expect(implementableText(leeSin)).toContain("Buff a friendly unit");
    expect(needsImplementation(leeSin)).toBe(true);
  });

  it("still treats a text-free card as needing nothing", () => {
    // The guard must not have become "everything needs an implementation".
    const vanilla = registry.all().find((d) => d.text === "");
    expect(vanilla, "the pool has no text-free card — this test needs a new subject").toBeDefined();
    expect(needsImplementation(vanilla!)).toBe(false);
  });
});

/**
 * A keyword the rules engine does not implement must not read as implemented.
 *
 * `implementableText` strips bracketed keywords because a keyword lives in the
 * rules engine rather than an effect registry — true for twelve of the thirteen
 * in KEYWORDS, and ASSUMED rather than checked for the thirteenth. `[Deflect]` is
 * parsed and then read by nothing, so the strip made Pouty Poro — whose entire
 * printed text is `[Deflect]` — report as implemented while doing nothing, in a
 * precon deck. That is the over-reporting direction coverage.ts calls the worse
 * one: a card that looks finished and silently isn't.
 *
 * Pinned per CARD rather than per keyword-name, so this keeps meaning something
 * when Deflect lands and the next pending keyword takes its place.
 */
describe("an unimplemented keyword is text that still needs writing", () => {
  const registry = defaultCardRegistry();
  const POUTY_PORO = "OGN-013"; // entire text is "[Deflect] (reminder)"
  const FIORA_VICTORIOUS = "OGN-232"; // grants [Deflect], [Ganking], [Shield] while Mighty
  const VOLIBEAR_FURIOUS = "OGN-041"; // carries the VALUED form, [Deflect 2]
  const GAREN_RUGGED = "OGS-007"; // "[Assault 2], [Shield 2]" — keywords that DO work

  it("keeps a keyword-only card that does nothing OUT of the implemented count", () => {
    const poro = registry.get(POUTY_PORO);
    // The exact shape of the old lie: nothing survived the strip, so nothing
    // needed implementing, so the card was "done".
    expect(needsImplementation(poro)).toBe(true);
    expect(isCardImplemented(poro)).toBe(false);
    // And it says WHICH keyword, rather than just greying the card.
    expect(implementableText(poro)).toContain("[Deflect]");
    expect(partialImplementationNote(poro)).toContain("[Deflect]");
  });

  it("still strips the keywords that ARE implemented", () => {
    // The other half of the guard. Garen is entirely keyword and entirely
    // working; flagging him is the false-"5 precon cards are inert" bug that
    // implementableText's own doc comment exists to prevent.
    const garen = registry.get(GAREN_RUGGED);
    expect(garen.text).toContain("[Assault");
    expect(implementableText(garen)).toBe("");
    expect(needsImplementation(garen)).toBe(false);
    expect(isCardImplemented(garen)).toBe(true);
  });

  it("reads the VALUED bracket form too", () => {
    // "[Deflect 2]" must match as readily as "[Deflect]" — a value-blind matcher
    // would let exactly one card in the pool slip back through.
    const volibear = registry.get(VOLIBEAR_FURIOUS);
    expect(volibear.text).toContain("[Deflect 2]");
    expect(unimplementedKeywordsOn(volibear)).toEqual(["Deflect"]);
  });

  it("catches a card that GRANTS the keyword and is otherwise registered", () => {
    // Fiora is the case a hand-maintained list would have missed: her grant IS
    // implemented (granted-keywords), and [Ganking]/[Shield] really work, so the
    // registry check alone says "finished" for a card doing two thirds of its text.
    const fiora = registry.get(FIORA_VICTORIOUS);
    expect(implementingModule(FIORA_VICTORIOUS)).toBe("granted keywords");
    expect(unimplementedKeywordsOn(fiora)).toEqual(["Deflect"]);
    expect(isCardImplemented(fiora)).toBe(false);
    expect(partialImplementationNote(fiora)).toBeDefined();
  });

  it("detects a grant from TEXT, not from the parsed keyword map", () => {
    // The two disagree in both directions, so reading def.keywords would be wrong
    // twice over: Fiora's map is empty (hers are conditional, stripped at parse
    // time), and Spirit's Refuge parses a Deflect it does not have and only grants.
    const fiora = registry.get(FIORA_VICTORIOUS);
    // Narrowed rather than cast: `keywords` lives on Unit/Gear and not on Legend,
    // and asserting the type here is what keeps this test honest if Fiora's
    // definition kind ever changes underneath it.
    expect(fiora.type).toBe("Unit");
    if (fiora.type !== "Unit") throw new Error("unreachable");
    expect(fiora.keywords).toEqual({});
    expect(unimplementedKeywordsOn(fiora)).toContain("Deflect");
  });

  it("flags no card for a keyword that has a real consumer", () => {
    // Guards the opposite failure: if UNIMPLEMENTED_KEYWORDS ever grew an entry
    // for a working keyword, a large slice of the pool would silently go inert.
    const flagged = new Set(registry.all().flatMap((def) => unimplementedKeywordsOn(def)));
    for (const keyword of flagged) {
      expect(KEYWORDS).toContain(keyword);
    }
    expect([...flagged]).toEqual(["Deflect"]);
  });
});

/**
 * A partial-implementation note can mislead by being too OPTIMISTIC, and that
 * direction is the one nobody checks.
 *
 * `UNIMPLEMENTED_KEYWORDS` fixed the over-report where a keyword-only card read
 * as finished. The mirror of it survived: a card carrying `[Deflect]` AND having
 * no registered module at all reported "only [Deflect] is missing", when in fact
 * nothing of it works. Volibear - Furious's attack trigger and Commander Ledros's
 * kill-any-number additional cost are both unwritten, so "implement [Deflect]"
 * looked like it would finish seven cards when it finishes five.
 *
 * Pinned in BOTH directions, because the first attempt at this check fixed the
 * pessimistic case and broke the optimistic one: Pouty Poro's entire printed text
 * IS `[Deflect]`, so it genuinely is one keyword away and must not be told
 * otherwise.
 */
describe("a partial note says how much is left, not just which keyword", () => {
  const registry = defaultCardRegistry();
  const NOT_ONE_AWAY = /not one keyword away/;

  it("warns when a keyword-carrying card has unwritten text of its own", () => {
    // Both have real prose beyond the keyword and no implementing module.
    for (const id of ["OGN-041", "OGN-231"]) {
      const def = registry.get(id);
      expect(implementingModule(id), `${id} is registered — pick a different subject`).toBeUndefined();
      expect(partialImplementationNote(def), `${id} (${def.name})`).toMatch(NOT_ONE_AWAY);
    }
  });

  it("does NOT warn for a card whose entire text is the keyword", () => {
    // Pouty Poro is unregistered too, so a check keyed on registration alone
    // gets this wrong — the question is whether any PROSE survives the strip.
    const poro = registry.get("OGN-013");
    expect(implementingModule("OGN-013")).toBeUndefined();
    expect(partialImplementationNote(poro)).not.toMatch(NOT_ONE_AWAY);
  });

  it("does NOT warn for a card whose other clauses ARE implemented", () => {
    // Fiora's grant works and her [Ganking]/[Shield] work; only [Deflect] is out.
    const fiora = registry.get("OGN-232");
    expect(implementingModule("OGN-232")).toBeDefined();
    expect(partialImplementationNote(fiora)).not.toMatch(NOT_ONE_AWAY);
  });

  it("still names the keyword in every case", () => {
    for (const id of ["OGN-013", "OGN-041", "OGN-231", "OGN-232"]) {
      expect(partialImplementationNote(registry.get(id)), id).toContain("[Deflect]");
    }
  });
});
