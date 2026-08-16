import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  COMPLETE_SETS,
  coverageBySet,
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
import { loadBattlefieldDefinitions, loadTokenDefinitions } from "../src/cards/card-loader.js";
import { battlefieldTokenDefIds } from "../src/engine/battlefield-tokens.js";
import {
  KEYWORDS,
  NON_KEYWORD_BRACKETS,
  isKnownBracketToken,
  keywordFromBracketText,
} from "../src/model/keyword.js";
import type { CardDefinition } from "../src/model/card-definition.js";

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
    // **"Real" is not the same as "in the CardRegistry", and that premise was
    // wrong rather than merely narrow.** `card-loader`'s `shouldSkip` keeps
    // Battlefield-type (and Rune-type) cards out of `loadCardDefinitions`, so the
    // registry has never held one — but the 24 printed Battlefields are real
    // cards with real rules text, and `engine/battlefield-abilities.ts`
    // implements them. Asking both sources keeps the check's teeth: a typo'd
    // battlefield id is in NEITHER, and still fails here.
    //
    // **TOKENS are the third source, added 2026-08-05 for the same reason.**
    // SFD's Gold token is a printed Gear (`sfd-t03`) with a printed activated
    // ability, and eleven SFD cards plus two SFD battlefields create one — but
    // `shouldSkip` filters Token-supertype entries out of the pool, so its
    // ability is keyed to a runtime defId (`TOKEN-GOLD`) that the registry has
    // never held. Loosening the check to "ignore ids starting TOKEN-" would
    // have let a typo through; asking `loadTokenDefinitions()` keeps the teeth,
    // because a token id backed by no printed card still fails here.
    // **BATTLEFIELD TOKENS are the FOURTH source, added 2026-08-14.** The Baron
    // Pit and the Brush are battlefields a card puts on the board mid-game, and
    // neither is in any set file at all — measured across all four. Their rules
    // text is printed in the REMINDER TEXT of the cards that make them (UNL-147
    // and UNL-195), so it is quoted in `engine/battlefield-tokens.ts` rather than
    // loaded. Same argument as the Gold token one line up, one step further: the
    // card that names the token is real, and asking the authored list keeps the
    // teeth because a typo'd token id is in none of the four sources.
    const battlefieldIds = new Set(loadBattlefieldDefinitions().map((b) => b.id));
    const tokenIds = new Set(loadTokenDefinitions().map((t) => t.runtimeDefId));
    const battlefieldTokenIds = new Set(battlefieldTokenDefIds());
    for (const { defId, file } of occurrences) {
      const module = implementingModule(defId);
      if (module === undefined) continue;
      const real =
        registry.tryGet(defId) !== undefined ||
        battlefieldIds.has(defId) ||
        tokenIds.has(defId) ||
        battlefieldTokenIds.has(defId);
      expect(real, `${module} claims ${defId} (referenced in ${file}) but it is not a real card`).toBe(true);
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
describe("the unimplemented-keyword mechanism, now that SFD has reopened it", () => {
  const registry = defaultCardRegistry();
  const POUTY_PORO = "OGN-013"; // entire text is "[Deflect] (reminder)"
  const FIORA_VICTORIOUS = "OGN-232"; // grants [Deflect], [Ganking], [Shield] while Mighty
  const VOLIBEAR_FURIOUS = "OGN-041"; // carries the VALUED form, [Deflect 2]
  const GAREN_RUGGED = "OGS-007"; // "[Assault 2], [Shield 2]" — keywords that DO work

  /**
   * `UNIMPLEMENTED_KEYWORDS` was EMPTY from 2026-08-02, when `[Deflect]`'s entry
   * was deleted because the surcharge had real consumers in the cost pipeline,
   * **until Spiritforged landed on 2026-08-04 and put four keywords back in it**
   * — exactly the reopening the previous revision of this comment predicted, and
   * the reason these tests were kept rather than deleted when their subject went
   * away.
   *
   * So the mechanism has real subjects again, and the assertions below are no
   * longer vacuous: `[Equip]`/`[Weaponmaster]`/`[Quick-Draw]` need an
   * Equipment-attachment subsystem this engine does not have, and `[Repeat]`
   * needs a spell to be able to pay an additional cost to repeat itself.
   */
  it("flags UNL's remaining three and nothing from a finished set", () => {
    // Named rather than counted, because a count cannot tell "Equip is still
    // pending" from "Deflect silently regressed".
    //
    // **All four of SFD's keywords have now LEFT this list.** `[Equip]`,
    // `[Quick-Draw]` and `[Weaponmaster]` went on 2026-08-05; the 6 Equipment
    // whose COST this engine cannot price are named individually in
    // PARTIALLY_IMPLEMENTED instead, because a keyword-level flag would have
    // greyed the 25 that work along with them. `[Repeat]` went on 2026-08-06.
    //
    // **An empty list does NOT mean every card carrying those keywords is
    // finished**, and conflating the two is the mistake this file exists to
    // catch. `[Repeat]` the KEYWORD is implemented — the announce-time cost, the
    // second choice set and the doubled resolution all work — while 9 of the 14
    // cards printing it still have no effect registered at all. Those 9 are
    // caught by `isCardImplemented`'s registry check, not by this mechanism,
    // which is exactly the split intended: this flags cards whose gap is a
    // keyword, and a card with no implementation is a different (and louder)
    // kind of missing.
    //
    // **And it reopened a THIRD time when Unleashed landed on 2026-08-08**, with
    // four more — which is the second time this list has gone from empty to full
    // on the day a set's JSON arrived, and the whole argument for keeping the
    // mechanism through its empty periods.
    //
    // **`[Hunt]` left again the same day**, once its keyword-keyed trigger
    // landed. That is the mechanism working as designed rather than churn:
    // deleting one entry is what flips every card whose only remaining gap it
    // was, and this list is the only thing that says which keyword is still
    // pending.
    //
    // **`[Level]` left on 2026-08-09**, and its removal is worth distinguishing
    // from Hunt's. Hunt left because ONE keyword-keyed trigger now serves all 12
    // cards. Level leaves because it is not a keyword-level gap at all — it is
    // implemented PER CARD (`atLevel`, reading `PlayerState.xp`), so the flag was
    // greying cards that gate correctly. It cost more than a wrong label:
    // `deck-generator` filters on `isCardImplemented`, so all 16 Level cards were
    // excluded from generated decks and could never be observed working. The ones
    // whose Level clause really is unwritten are named in `PARTIALLY_IMPLEMENTED`
    // instead — `[Repeat]`'s shape, for the reason its own note gives.
    const flagged = new Set(registry.all().flatMap((def) => unimplementedKeywordsOn(def)));
    // **`[Ambush]` LEFT on 2026-08-09**, and it was the largest entry the map
    // ever held: twelve cards, none of which could reach a generated deck while
    // it stood. Its removal is the same shape as `[Hunt]`'s — one mechanism
    // serving every card that prints it — except that the mechanism turned out to
    // be two halves, one of which (a false flat `[Reaction]` parsed from the
    // keyword's own reminder text) was making the cards STRONGER than printed at
    // the same time as the missing half made them unplayable.
    // **`[Backline]` left on 2026-08-10, and the list is EMPTY for the fifth
    // time.** Its removal is the sharpest instance yet of the shape `[Level]`'s
    // note describes: not a keyword-level gap at all. `combat.assignmentOrder`
    // had sorted three tiers since Caitlyn - Patrolling was written; it simply
    // consulted a one-entry defId allowlist instead of asking `hasKeyword`,
    // because `"Backline"` was not in KEYWORDS on the day it was written. The
    // keyword arrived with Unleashed and nothing connected the two, so for a week
    // the parser populated a keyword nothing read while this list blamed four
    // cards on a mechanism that already existed. One `hasKeyword` call.
    //
    // Empty is the map's normal resting state between sets — it has now emptied
    // and refilled five times, twice on the day a set's JSON arrived. Keep the
    // mechanism.
    //
    // **It refilled for the SIXTH time on 2026-08-16, the day ven.json landed**,
    // and for the third time that is the same day a set's JSON arrived — which is
    // the discipline the map exists to enforce: a keyword declared in `KEYWORDS`
    // without an entry here makes every card printing it report IMPLEMENTED and
    // ship inert.
    //
    // Two of the three are one mechanic in two rules and must be two entries:
    // 827 `[Empower]` is the Activated Ability that CONFERS the status, 828
    // `[Empowered]` is the dependent ability gated ON it, and a card routinely
    // prints both. `[Flow]` (829) is separate again — playing a Spell from the
    // trash for an alternate cost, then banishing it.
    //
    // **`[Burn]`, `[Predict]` and `[Stun]` are deliberately absent**, and that is
    // a decision rather than an omission: they are 4xx ACTIONS (440 / 436 / 423),
    // verbs a card's text performs rather than properties a card has. Flagging an
    // action word here would grey every card that merely instructs you to do it.
    //
    // **`[Flow]` LEFT the same day it arrived (2026-08-16)**, which is the third
    // time a keyword has been declared and freed in one session, and the sharpest
    // instance yet of this repo's "a 'needs subsystem X' note is wrong ten times
    // out of eleven" rule: all three of 829's parts already existed —
    // `replaced-costs.ts` has served an alternate cost from the TRASH since
    // Undying Legion, `banishCard` has been there longer, and the cost is PRINTED
    // on each card so it parses. Fifteen spells, no per-card rows.
    //
    // The two survivors are one mechanic in two rules and stay until the
    // Empowered STATUS exists: 827 confers it, 828 depends on it.
    //
    // **`[Empower]` and `[Empowered]` LEFT on 2026-08-16 too, one day after
    // arriving, and the map is EMPTY for the sixth time.** Both had to go
    // together: 827 confers the status and 828 depends on it, so a card printing
    // both is finished only when both work — and leaving either flag up would
    // grey every card printing it, which is the `[Level]` mistake recorded above.
    //
    // The half-written cards are held by other mechanisms rather than by this
    // one: an unreadable Empower COST produces a derived `PARTIALLY_IMPLEMENTED`
    // note, and an Empowered payload that is a trigger simply registers nothing
    // and fails the registry check. That is the split this map exists to keep.
    expect([...flagged].sort()).toEqual([]);

    // And the direction that matters for OGN/OGS/SFD: a keyword losing its
    // implementation would show up here as a card from a FINISHED set, which is
    // the regression this whole file is pointed at.
    //
    // **This used to require UNL to appear** — "it must appear, an empty set here
    // would mean the four keywords above were declared and then matched nothing".
    // That premise expired with `[Backline]` on 2026-08-10: the map is empty, so
    // nothing is flagged and no set appears. The surviving invariant is the one
    // that was always the point — a COMPLETE set may never be flagged — and the
    // "did the sweep actually reach anything" half now lives in its own test
    // below, asked of the bracket parser rather than of the pool's current state.
    const flaggedSets = new Set(
      registry
        .all()
        .filter((def) => unimplementedKeywordsOn(def).length > 0)
        .map((def) => def.id.split("-")[0]!),
    );
    for (const set of flaggedSets) expect(COMPLETE_SETS, `${set} is complete and yet flagged`).not.toContain(set);

    // **Backline specifically must NOT drag OGN-068 Caitlyn - Patrolling in.**
    // She prints the effect as prose and is implemented per-card in
    // `combat.ASSIGNED_LAST_DEF_IDS`; only UNL prints the bracket. This is the
    // whole reason `unimplementedKeywordsOn` reads the TEXT rather than
    // `def.keywords`, and it would regress silently — she would simply go grey
    // in the deck builder, in a set that is supposed to be hard-gated. Still
    // asserted now that the keyword is implemented, because the risk is the same
    // shape pointed the other way: she must keep her Backline via the allowlist.
    expect(unimplementedKeywordsOn(registry.get("OGN-068"))).toEqual([]);
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

  it("Volibear is finished now that BOTH halves are written", () => {
    // He stood here as the negative control while his split-damage attack trigger
    // was unwritten — the case proving that a working keyword must not sweep up a
    // card with unwritten text of its own. The trigger has since landed, so the
    // premise is fixed rather than the assertion weakened, and the invariant that
    // control existed for is asserted directly below instead.
    expect(isCardImplemented(registry.get(VOLIBEAR_FURIOUS))).toBe(true);
  });

  it("a card is never finished while ANY of its text is unwritten", () => {
    // The invariant, swept rather than pinned to one card — which is what keeps
    // it working as cards land. `partialImplementationNote` is the only thing that
    // can say a REGISTERED card is unfinished, so the two must agree everywhere.
    //
    // **The list is EMPTY now**, so the sweep is vacuous and used to fail on its
    // own "this proves nothing" gate. The gate is replaced rather than deleted:
    // an empty list is the pool being finished, which is worth asserting in its
    // own right, and the agreement below still fails the moment an entry is
    // added for a card that reports implemented.
    //
    // The emptiness half is per SET now, for the reason
    // `coverage.COMPLETE_SETS` records: a set under construction is EXPECTED to
    // accumulate partial notes, and holding the whole pool to zero would make
    // this red for the weeks after a new set lands. A finished set is still held
    // to zero, by name. The agreement below stays pool-wide — a partial note has
    // to make its card report unimplemented wherever that card is from.
    const partial = registry.all().filter((def) => partialImplementationNote(def) !== undefined);
    const declared = coverageBySet(registry.all()).filter((set) => set.declaredComplete);
    expect(declared.length, "no set is declared complete — this gate is checking nothing").toBeGreaterThan(0);
    for (const set of declared) {
      expect(set.partial, `${set.set} is declared finished in COMPLETE_SETS`).toEqual([]);
    }
    for (const def of partial) {
      expect(isCardImplemented(def), `${def.id} (${def.name})`).toBe(false);
    }
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
 * The mirror of the test above, and the half nothing checked: a bracketed token
 * in the card DATA that nothing in the engine knows about.
 *
 * `parseKeywords` reads any `[Word]` into `keywords` and drops the ones it does
 * not recognise — "not one of our modeled keywords", which is true and is also
 * exactly how a card parses, decks, plays and does nothing. `[Deflect]` shipped
 * inert that way for a while. It is the most expensive gap this pool can have,
 * because there is nothing to see: the card costs runes, goes to the trash, and
 * quietly changes nothing.
 *
 * The existing check runs one way — every keyword FLAGGED as unimplemented must
 * be real, so a typo cannot flag nothing. This one runs the other: every token
 * PRINTED on a card must be one the engine has an answer for. The two together
 * are what make a new set's keyword impossible to miss, which matters because
 * `KEYWORDS`' own doc comment already names four the later sets bring
 * (EQUIP/WEAPONMASTER/QUICK_DRAW in SFD, and HUNT/LEVEL/AMBUSH/BACKLINE in UNL).
 */
describe("a bracketed token nothing knows about", () => {
  const registry = defaultCardRegistry();

  /** Every `[...]` in a card's printed text, mapped to the cards printing it.
   *  Deliberately scans ALL brackets rather than `parseKeywords`' narrower
   *  `[A-Za-z][a-zA-Z]*` grammar: a token that grammar cannot even see (`[E]`,
   *  `[1]`, a hyphenated word) is MORE hidden, not less, so it must land here
   *  too. */
  function bracketTokens(defs: readonly CardDefinition[]): Map<string, string[]> {
    const byToken = new Map<string, string[]>();
    for (const def of defs) {
      const text = "text" in def && typeof def.text === "string" ? def.text : "";
      for (const [, inner] of text.matchAll(/\[([^\]]*)\]/g)) {
        const cards = byToken.get(inner!);
        if (cards) cards.push(`${def.id} (${def.name})`);
        else byToken.set(inner!, [`${def.id} (${def.name})`]);
      }
    }
    return byToken;
  }

  it("every bracketed token in the pool is a keyword or an allow-listed non-keyword", () => {
    const unknown = [...bracketTokens(registry.all())]
      .filter(([token]) => !isKnownBracketToken(token))
      .map(([token, cards]) => `[${token}] on ${cards.join(", ")}`);
    expect(
      unknown,
      "a bracketed token nothing consumes — implement it as a keyword, or add it to NON_KEYWORD_BRACKETS with what reads it",
    ).toEqual([]);
  });

  it("NAMES the token and the cards, for a token an unseen set could print", () => {
    // The positive control. The sweep above is vacuous by construction — it is
    // asserting an empty list — so the half that has to be proved is that it can
    // still see something.
    //
    // The subject has now been absorbed by the pool TWICE, which is the pattern
    // worth naming rather than the individual tokens. It was `[Weaponmaster]` on
    // a card called SFD-001 until 2026-08-04, when Weaponmaster became a declared
    // keyword and SFD-001 became a real card (Against the Odds). It was then
    // `[Backline]` until 2026-08-08, when Unleashed landed and modelled it —
    // exactly the replacement the previous revision of this comment predicted.
    //
    // So the subject is now a token no real set can absorb, rather than the next
    // real keyword on the horizon: a control that names a PENDING feature has a
    // shelf life, and twice now it has expired on the day the work happened,
    // failing a test that was doing its job. `[Vorpal]` is not a Riftbound
    // keyword and is not going to become one.
    const invented: CardDefinition = {
      ...registry.get("OGN-024"),
      id: "ZZZ-001",
      name: "Invented Newcomer",
      text: "[Vorpal] (Reminder text nobody has written yet.) Deal 4 to a unit at a battlefield.",
    };
    expect(isKnownBracketToken("Vorpal"), "[Vorpal] is modelled now — this control needs a new subject").toBe(false);
    const unknown = [...bracketTokens([invented])].filter(([token]) => !isKnownBracketToken(token));
    expect(unknown).toEqual([["Vorpal", ["ZZZ-001 (Invented Newcomer)"]]]);
  });

  it("sees a token the keyword parser's own grammar cannot", () => {
    // `parseKeywords`' `[A-Za-z][a-zA-Z-]*` cannot match a token containing a
    // SPACE at all, so `[Quick Draw]` would slip past a guard that reused it —
    // the more hidden a token is, the more this has to catch it.
    //
    // The hyphenated case used to be here too and no longer is: SFD really
    // printed `[Quick-Draw]`, the grammar really did drop it silently, and the
    // fix was to widen the pattern rather than to widen this control. The space
    // form is still unmatched, so the control still has a subject.
    const invented: CardDefinition = {
      ...registry.get("OGN-024"),
      id: "SFD-002",
      name: "Two-Word Keyword",
      text: "[Quick Draw] Deal 4 to a unit at a battlefield.",
    };
    const unknown = [...bracketTokens([invented])].map(([token]) => token).filter((t) => !isKnownBracketToken(t));
    expect(unknown).toEqual(["Quick Draw"]);
  });

  it("accepts the VALUED form of a keyword without a separate entry", () => {
    // `[Assault 2]` and `[Deflect 2]` are the same keyword at a magnitude, and
    // both are read through `keywordFromBracketText` rather than a second copy
    // of the bracket grammar — so the guard cannot come to a different answer
    // than the parser it guards.
    expect(isKnownBracketToken("Assault 2")).toBe(true);
    expect(isKnownBracketToken("Deflect 2")).toBe(true);
    expect(isKnownBracketToken("Assault")).toBe(true);
  });

  it("keeps the allow-list explicit — each entry is a token the pool really prints", () => {
    // An allow-list is the easy way to defeat this check, so an entry that
    // matches nothing is an entry nobody has had to justify. Every one of them is
    // on real cards today.
    //
    // **The MAGNITUDE is stripped, and Vendetta is what forced that.** This
    // compared the raw token, which worked only because every valued allow-list
    // entry so far ALSO appeared bare somewhere in the pool — `[Stun]` and
    // `[Predict]` both do. `[Burn]` does not: it prints only as `[Burn 1]`,
    // `[Burn 2]`, `[Burn 3]` and `[Burn 7]`, so a correctly-justified entry
    // failed this check while nothing was wrong with it.
    //
    // Stripping here matches what `isKnownBracketToken` has always done, so the
    // guard and the thing it guards now agree — which is the same argument the
    // sibling test below makes for reading both through `keywordFromBracketText`
    // rather than a second copy of the grammar.
    const printed = new Set([...bracketTokens(registry.all()).keys()].map((t) => t.replace(/\s+\d+$/, "")));
    for (const token of NON_KEYWORD_BRACKETS) {
      expect(printed.has(token), `${token} is allow-listed but no card in the pool prints [${token}]`).toBe(true);
      expect(keywordFromBracketText(token), `${token} is allow-listed AND a modelled keyword`).toBeUndefined();
    }
  });

  it("the pool's token census, stated rather than assumed", () => {
    // **30 distinct bracketed words** as of 2026-08-08, up from 21 after SFD and
    // 15 when the pool was OGN+OGS: 20 keywords, and 7 allow-listed non-keywords
    // appearing as 8 spellings.
    //
    // Unleashed's nine newcomers are `Ambush`, `Backline`, `Hunt` and `Level`
    // (keywords), and `>`, `>>`, `Buff`, `Predict` and `Stun` (not keywords).
    // Two of those are worth stating for the same reason the SFD notes below are:
    //
    //   `>` and `>>` are PUNCTUATION — the grant arrow and the ability divider.
    //   They are here as bare `>` and not as `&gt;` because `decodeTextEntities`
    //   runs before anything reads the text, and the raw JSON's escaped form
    //   never reaches this sweep. Allow-listing `&gt;` would have matched nothing
    //   while looking deliberate, leaving 38 cards reported unknown.
    //
    //   `Stun` and `Buff` are action words whose MECHANISMS already existed —
    //   OGN and SFD print both as prose. UNL is simply the first set to bracket
    //   them, which is the case this census is best at surfacing: no new
    //   behaviour, but a new token, and a token nothing knows about is
    //   indistinguishable from a keyword nobody implemented.
    //
    // Two of the six newcomers are worth stating outright, because each is a way
    // this census can read as fine while something is wrong:
    //
    //   `ADD` and `Add` are the SAME allow-listed token in two castings — SFD's
    //   Renata Glasc - Chem-Baroness prints it uppercase. They are distinct
    //   STRINGS and so are two entries here, while `isKnownBracketToken`
    //   compares upper-cased and needs only the one allow-list name. A census
    //   that folded case would hide a genuinely new token that differed from a
    //   known one only in case.
    //
    //   `Quick-Draw` is the token `parseKeywords`' own grammar could not match
    //   before its pattern was widened to allow a hyphen. It is in this list
    //   because the sweep scans the wider `\[([^\]]*)\]`, which is the entire
    //   reason the two grammars are deliberately different.
    const words = new Set([...bracketTokens(registry.all()).keys()].map((t) => t.replace(/\s+\d+$/, "")));
    expect([...words].sort()).toEqual([
      ">",
      ">>",
      "ADD",
      "Accelerate",
      "Action",
      "Add",
      "Ambush",
      "Assault",
      "Backline",
      "Buff",
      // **Vendetta's four, 2026-08-16**, in sorted position rather than appended.
      // `Empower`, `Empowered` and `Flow` are real 800-band keywords (827 / 828 /
      // 829), declared in KEYWORDS with entries in UNIMPLEMENTED_KEYWORDS; `Burn`
      // is a 4xx ACTION (440), allow-listed beside `Stun` and `Predict`.
      //
      // `Burn` is worth stating for the reason the `ADD`/`Add` note above states
      // its own: it is the first allow-listed token that NEVER appears bare in the
      // pool — only `[Burn 1|2|3|7]`. That is why the sibling check on this list
      // had to start stripping the magnitude; the two valued tokens seen before it
      // happened to appear unvalued as well, so nothing had ever exercised the path.
      "Burn",
      "Deathknell",
      "Deflect",
      "Empower",
      "Empowered",
      "Equip",
      "Flow",
      "Ganking",
      "Hidden",
      "Hunt",
      "Legion",
      "Level",
      "Mighty",
      "Predict",
      "Quick-Draw",
      "Reaction",
      "Repeat",
      "Shield",
      "Stun",
      "Tank",
      "Temporary",
      "Unique",
      "Vision",
      "Weaponmaster",
    ]);
    // `Quick` is still the one keyword that appears in NO bracket — every card
    // that has it prints it as prose, which is what QUICK_TEXT_OVERRIDES exists
    // for. SFD added four bracketed keywords and did not change that.
    expect(KEYWORDS.filter((k) => !words.has(k))).toEqual(["Quick"]);
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

  it("derives keyword notes only for a set still under construction", () => {
    // Asserting per SET rather than globally keeps the two halves
    // distinguishable: a note on a card from a HARD-GATED set means a keyword
    // quietly lost its implementation, which is a regression; a note on a card
    // from the set currently being built is just work not done yet.
    //
    // **Written against COMPLETE_SETS rather than against a set NAME**, because
    // the named version has now been wrong twice — it said "OGS only" until SFD
    // landed and "SFD only" until UNL did, each time failing on the day the work
    // happened rather than on the day something broke. The invariant is what was
    // meant all along: a finished set is one nothing is allowed to flag.
    for (const def of registry.all()) {
      if (!COMPLETE_SETS.includes(def.id.split("-")[0]!)) continue;
      expect(unimplementedKeywordsOn(def), `${def.id} (${def.name}) is in a hard-gated set`).toEqual([]);
    }
  });

  it("and the sweep above is not vacuous — the bracket parser it rides on still reads", () => {
    // The half that would rot silently: the loop above passes while asserting
    // nothing if `unimplementedKeywordsOn` has stopped SEEING keywords, as opposed
    // to seeing them and finding none unimplemented.
    //
    // **This used to assert that some card, somewhere, carries an unimplemented
    // keyword — and that premise expired on 2026-08-10** when `[Backline]` left
    // and UNIMPLEMENTED_KEYWORDS emptied for the fifth time. Its own note said to
    // DELETE it if that day came "with a note saying the pool is finished". The
    // pool is NOT finished — a hundred UNL cards are unwritten — so deleting it
    // would have been right for the wrong reason and would have removed the only
    // check that the sweep still reaches anything.
    //
    // Rewritten to prove the MECHANISM rather than the pool's current state, on a
    // subject that cannot be implemented out from under it: the bracket parser is
    // the part that would break silently, and it is asked directly. An empty
    // UNIMPLEMENTED_KEYWORDS map is then a real finding rather than a broken sweep.
    expect(keywordFromBracketText("Tank"), "the bracket parser stopped resolving a known keyword").toBe("Tank");
    expect(keywordFromBracketText("Backline"), "Backline fell out of KEYWORDS entirely").toBe("Backline");
    expect(keywordFromBracketText("NotAKeyword"), "the parser now resolves anything").toBeUndefined();

    // The pool really does still print the brackets the sweep walks, so a parser
    // that reads and a pool that prints are both confirmed.
    const bracketed = registry.all().filter((def) => /\[Backline\]/.test(def.text ?? ""));
    expect(bracketed.length, "no card prints [Backline] any more — the fixture drifted").toBe(4);

    // And the invariant the original line was really defending: no card from a
    // COMPLETE set may ever be flagged. Vacuously true while the map is empty,
    // and the thing that must hold the moment it refills.
    const flagged = registry.all().filter((def) => unimplementedKeywordsOn(def).length > 0);
    for (const def of flagged) expect(COMPLETE_SETS).not.toContain(def.id.split("-")[0]!);
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
