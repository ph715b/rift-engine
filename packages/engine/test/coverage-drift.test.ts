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
  implementingModules,
} from "../src/engine/coverage.js";
import { decisionDefIds } from "../src/engine/decisions.js";
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
describe("the unimplemented-keyword mechanism, now that the pool has none", () => {
  const registry = defaultCardRegistry();
  const POUTY_PORO = "OGN-013"; // entire text is "[Deflect] (reminder)"
  const FIORA_VICTORIOUS = "OGN-232"; // grants [Deflect], [Ganking], [Shield] while Mighty
  const VOLIBEAR_FURIOUS = "OGN-041"; // carries the VALUED form, [Deflect 2]
  const GAREN_RUGGED = "OGS-007"; // "[Assault 2], [Shield 2]" — keywords that DO work

  /**
   * `UNIMPLEMENTED_KEYWORDS` is EMPTY as of 2026-08-02: `[Deflect]` was its only
   * entry and the surcharge now has real consumers in the cost pipeline, so
   * deleting the entry flipped every card whose sole remaining gap it was.
   *
   * These tests used Deflect as their subject, so most of them no longer have
   * one. Rewritten to pin what is now TRUE — every keyword has a consumer — plus
   * the structural guards that keep meaning something when the next pending set
   * ([Backline], [Hunt], [Level], [Ambush]) arrives. They are NOT deleted,
   * because the hole they were written for is reopenable by one map entry.
   */
  it("flags nothing, because every keyword in KEYWORDS now has a real consumer", () => {
    const flagged = new Set(registry.all().flatMap((def) => unimplementedKeywordsOn(def)));
    expect([...flagged]).toEqual([]);
  });

  it("a keyword-only card is now genuinely finished — Pouty Poro's whole text is [Deflect]", () => {
    // The card this mechanism was BUILT for. It reported implemented while doing
    // nothing, then reported unimplemented once the lie was fixed, and now
    // reports implemented because the keyword actually works. Its whole text is
    // the keyword, so nothing survives the strip and nothing is left to write.
    const poro = registry.get(POUTY_PORO);
    expect(implementableText(poro)).toBe("");
    expect(needsImplementation(poro)).toBe(false);
    expect(isCardImplemented(poro)).toBe(true);
    expect(partialImplementationNote(poro)).toBeUndefined();
  });

  it("still strips the keywords that ARE implemented", () => {
    // Garen is entirely keyword and entirely working; flagging him is the
    // false-"5 precon cards are inert" bug implementableText exists to prevent.
    const garen = registry.get(GAREN_RUGGED);
    expect(garen.text).toContain("[Assault");
    expect(implementableText(garen)).toBe("");
    expect(needsImplementation(garen)).toBe(false);
    expect(isCardImplemented(garen)).toBe(true);
  });

  it("still reads the VALUED bracket form — [Deflect 2] parses as a value of 2", () => {
    // The value survives even though the keyword is no longer flagged: a
    // value-blind parser would have made Volibear's [Deflect 2] a [Deflect 1]
    // tax, i.e. half price, which nothing else in the pool would have caught.
    const volibear = registry.get(VOLIBEAR_FURIOUS);
    expect(volibear.text).toContain("[Deflect 2]");
    expect(volibear.type).toBe("Unit");
    if (volibear.type !== "Unit") throw new Error("unreachable");
    expect(volibear.keywords.Deflect).toBe(2);
  });

  it("a card whose OTHER text is unwritten is still not finished", () => {
    // Volibear carries the working keyword AND an unwritten attack trigger, so
    // he must stay open — the keyword landing must not sweep him up with the
    // cards it genuinely finished.
    expect(isCardImplemented(registry.get(VOLIBEAR_FURIOUS))).toBe(false);
    expect(implementableText(registry.get(VOLIBEAR_FURIOUS))).toContain("split");
  });

  it("Fiora, who GRANTS it conditionally, is finished now that it has a consumer", () => {
    const fiora = registry.get(FIORA_VICTORIOUS);
    expect(implementingModule(FIORA_VICTORIOUS)).toBe("granted keywords");
    expect(unimplementedKeywordsOn(fiora)).toEqual([]);
    expect(isCardImplemented(fiora)).toBe(true);
  });

  it("the mechanism is still WIRED, so the next pending keyword cannot slip through", () => {
    // The map is empty, not removed. If an entry is ever added it must name a
    // real keyword — this is what stops a typo silently flagging nothing, and
    // what stops a working keyword silently greying a slice of the pool.
    const flagged = new Set(registry.all().flatMap((def) => unimplementedKeywordsOn(def)));
    for (const keyword of flagged) expect(KEYWORDS).toContain(keyword);
    // And the reader is still reachable: a bracket that IS a modelled keyword
    // parses, which is the half that would break silently if the parser rotted.
    expect(KEYWORDS).toContain("Deflect");
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
describe("a partial note says how much is left", () => {
  const registry = defaultCardRegistry();

  /**
   * This block was written the same day `[Deflect]` was implemented, and its
   * subject went with it. It pinned a note that was too OPTIMISTIC — a card
   * carrying an unimplemented keyword AND having no registered module reported
   * "only [Deflect] is missing" when nothing of it worked at all.
   *
   * With `UNIMPLEMENTED_KEYWORDS` empty that branch is unreachable: it needs a
   * flagged keyword to fire. Kept rather than deleted, and rewritten onto the
   * half that IS live — the hand-maintained `PARTIALLY_IMPLEMENTED` map — because
   * the optimistic-note hole reopens the moment the next pending keyword lands.
   */
  it("keeps its two answers consistent: a card with a partial note is never implemented", () => {
    // Spirit's Refuge was the last hand-listed partial and its aura has landed,
    // so `PARTIALLY_IMPLEMENTED` is empty and there is no longer a specific card
    // to point at. The INVARIANT is what survives, and it is the one that matters:
    // `partialImplementationNote` and `isCardImplemented` read the same two
    // sources (the hand-written map and the derived unimplemented keywords), and
    // the whole value of this module is that they cannot disagree.
    //
    // Written as a sweep rather than pinned to one card deliberately — it holds
    // while both lists are empty, and starts doing real work the moment the next
    // two-clause card is written by halves, which is exactly when nobody will
    // remember to add a test.
    for (const def of registry.all()) {
      const note = partialImplementationNote(def);
      if (note === undefined) continue;
      expect(isCardImplemented(def), `${def.id} (${def.name}) has a partial note but reports implemented: ${note}`).toBe(false);
    }
  });

  it("says NOTHING about Spirit's Refuge — the entry was deleted, not reworded", () => {
    // The direction nobody checks. An entry left behind after its gap closed
    // would grey a working card forever, and the map's own doc comment says
    // entries are deleted rather than amended; this is what holds it to that.
    const refuge = registry.get("OGN-063");
    expect(partialImplementationNote(refuge)).toBeUndefined();
    expect(isCardImplemented(refuge)).toBe(true);
  });

  it("says nothing about a card that is genuinely finished", () => {
    // The guard against the map going stale in the other direction: an entry
    // left behind after its gap closed would grey a working card forever.
    for (const id of ["OGN-013", "OGN-155", "OGN-161", "OGN-232"]) {
      const def = registry.get(id);
      expect(partialImplementationNote(def), `${id} (${def.name})`).toBeUndefined();
      expect(isCardImplemented(def), `${id} (${def.name})`).toBe(true);
    }
  });

  it("derives nothing from keywords while every keyword has a consumer", () => {
    // The derived half is inert by construction right now. Asserting it rather
    // than assuming keeps the two halves distinguishable: a note appearing from
    // nowhere would mean a keyword had quietly lost its implementation.
    for (const def of registry.all()) {
      expect(unimplementedKeywordsOn(def), `${def.id} (${def.name})`).toEqual([]);
    }
  });
});

/**
 * A card registered ONLY through a pending decision is not implemented, and
 * coverage must not say otherwise.
 *
 * `decisionDefIds()` regex-peels the defId out of a decision key, so registering
 * `"OGN-242-play"` and nothing else makes `isCardImplemented("OGN-242")` return
 * true — while nothing in the game can ever park that decision, because parking
 * is done by the card's own effect or trigger, which is the registration that is
 * missing. **Two independent agents hit this within an hour of each other**, each
 * by writing half a card and watching coverage claim the whole of it.
 *
 * Nothing in the pool is affected today, which is exactly why this is a test and
 * not a behaviour change: altering `isCardImplemented` would change nothing now
 * and could silently grey a future card that legitimately registers this way. A
 * test states the invariant, fails loudly if it ever stops holding, and catches
 * the next half-written card at review time rather than by an agent's diligence.
 */
describe("a decision registration is a continuation, never a whole implementation", () => {
  it("every card reachable via a decision is also reachable some other way", () => {
    const viaDecision = new Set(decisionDefIds());
    // Every OTHER coverage source, asked directly rather than through a new
    // export on coverage.ts — `implementingModule` already answers "which source
    // claims this defId", so the check reads it back per id below.
    // `implementingModules`, not `implementingModule`: the singular returns the
    // FIRST source in COVERAGE_SOURCES order, so a card claimed by both a
    // decision and a later source (an aura, a cost modifier) would look like an
    // orphan. Asking for all of them makes this order-independent.
    const claimedElsewhere = (defId: string): boolean =>
      implementingModules(defId).some((label) => label !== "pending decisions");

    // Gate on the scan finding anything: an empty decision registry would make
    // this vacuous, which reads exactly like a pass.
    expect(viaDecision.size, "no decisions are registered at all — this proves nothing").toBeGreaterThan(5);

    const orphans = [...viaDecision].filter((defId) => !claimedElsewhere(defId));
    const registry = defaultCardRegistry();
    expect(
      orphans.map((id) => `${id} (${registry.tryGet(id)?.name ?? "unknown"})`),
      "these cards are registered ONLY through a pending decision, so coverage reports them implemented " +
        "while nothing can ever park that decision — write the effect/trigger that parks it, or the card is half-written",
    ).toEqual([]);
  });
});
