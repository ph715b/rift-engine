import type { CardDefinition } from "../model/card-definition.js";
import { keywordFromBracketText, type Keyword } from "../model/keyword.js";
import { activatedAbilityDefIds, borrowedAbilityDefIds } from "./activated-abilities.js";
import { loaderHandledDefIds } from "../cards/card-loader.js";
import { playCardDefIds } from "./deploy.js";
import { cardEffectDefIds } from "./card-effects.js";
import { costModifierDefIds } from "./cost-modifiers.js";
import { damageModifierDefIds } from "./damage-modifiers.js";
import { effectiveMightDefIds } from "./effective-might.js";
import { grantedKeywordDefIds } from "./granted-keywords.js";
import { deathTriggerDefIds, deathknellModifierDefIds, eventTriggerDefIds, selfTriggerDefIds } from "./triggers.js";
import { decisionDefIds } from "./decisions.js";
import { unitTriggerDefIds } from "./unit-triggers.js";
import { legendAbilityDefIds } from "./legend-abilities.js";
import { deathReplacementDefIds } from "./death-ward.js";
import { combatAssignmentDefIds } from "./combat.js";
import { boardRestrictionDefIds } from "./board-restrictions.js";
import { hideCostDefIds } from "./hidden.js";
import { topOfDeckDefIds } from "./top-of-deck.js";

/**
 * Which cards actually DO something, and which only look like they do.
 *
 * This exists because a card whose printed text has no implementation is
 * indistinguishable from a working one during a game: it costs runes, goes to the
 * trash, and quietly changes nothing. That is how most of a deck can be inert
 * without anyone noticing — measured at the time of writing, 211 of the 255
 * OGN+OGS cards carrying real rules text had no implementation, and three of the
 * seven preset decks were majority-inert.
 *
 * The measurement has to be trustworthy in BOTH directions. Under-reporting
 * hides inert cards from a playtest; over-reporting greys out cards that work and
 * invites re-implementing them. registeredDefIds below asks every implementing
 * module rather than a curated list, and test/coverage-drift.test.ts enforces
 * that by scanning the source.
 *
 * The point of surfacing it is honesty about scope, the same reason
 * docs/rules-conformance.md distinguishes "Conformant" from "Unverified": a deck
 * builder that shows which cards are implemented lets you draw correct
 * conclusions from a playtest. One that doesn't invites wrong ones.
 */

/**
 * Keywords the rules engine does NOT implement, each with what is missing.
 *
 * `implementableText` below strips every bracketed keyword on the assumption
 * that a keyword is implemented in the rules engine (combat, timing, exhaustion)
 * rather than in an effect registry. That assumption is load-bearing — it is what
 * keeps a vanilla-with-a-keyword card from reporting inert — but it was
 * ASSUMED rather than checked, and it is false for exactly one of the thirteen
 * entries in KEYWORDS.
 *
 * Measured 2026-08-01 by asking, per keyword, which engine modules consult it:
 * twelve have a real consumer (combat.ts, timing.ts, hidden.ts, legal-actions.ts,
 * effective-might.ts…). `[Deflect]`'s only two mentions are the table that GRANTS
 * it and a doc comment in rune-payment.ts recording that the surcharge is absent.
 * Nothing reads it, so a spell targeting a Deflect unit pays the printed price.
 *
 * The cost of leaving that unstated was a measure that lied in the direction this
 * module's own doc comment calls the worse one. Pouty Poro's entire printed text
 * is `[Deflect]`, so the strip left nothing, `needsImplementation` said no, and it
 * reported as implemented while doing nothing — in a precon deck, twice.
 * Fiora - Victorious granted it and reported finished on the strength of the two
 * keywords that do work.
 *
 * Listing it here rather than fixing those two cards by hand is the point: the
 * next unimplemented keyword ([Backline]/[Hunt]/[Level]/[Ambush] are already
 * named in KEYWORDS' own doc comment as pending sets) cannot silently reopen the
 * same hole, and when Deflect lands, DELETING one entry flips all seven cards
 * that carry it at once.
 */
const UNIMPLEMENTED_KEYWORDS: ReadonlyMap<Keyword, string> = new Map([
  // EMPTY as of 2026-08-02, and that is the shape working: `[Deflect]` lived here
  // while it was parsed and ignored, and DELETING this one entry flipped all five
  // cards whose only remaining gap it was — exactly what this map's doc comment
  // above predicted. Keep it as a map rather than deleting the mechanism: the
  // KEYWORDS doc comment already names [Backline]/[Hunt]/[Level]/[Ambush] as
  // pending sets, and the next one must not be able to reopen the same hole.
]);

/** The keyword a bracket encloses, if it is one this engine does not implement.
 *  Reads `[Deflect]` and `[Deflect 2]` alike, through the model's own parser
 *  rather than a second copy of the bracket grammar. */
function unimplementedKeywordIn(bracketInner: string): Keyword | undefined {
  const keyword = keywordFromBracketText(bracketInner.trim().replace(/\s+\d+$/, ""));
  return keyword !== undefined && UNIMPLEMENTED_KEYWORDS.has(keyword) ? keyword : undefined;
}

/** Which unimplemented keywords a card's printed text carries — whether it HAS
 *  them (Pouty Poro) or GRANTS them (Fiora - Victorious, Spirit's Refuge).
 *
 *  Keyed off the text rather than `def.keywords` deliberately, and the two
 *  disagree in both directions: Fiora's parsed keywords are empty because hers
 *  are conditional, while Spirit's Refuge parses a `Deflect` it does not have and
 *  only grants. The text is what needs implementing, so the text is what's read. */
export function unimplementedKeywordsOn(def: CardDefinition): Keyword[] {
  const raw = "text" in def && typeof def.text === "string" ? def.text : "";
  const found = new Set<Keyword>();
  for (const [, inner] of raw.matchAll(/\[([^\]]*)\]/g)) {
    const keyword = unimplementedKeywordIn(inner!);
    if (keyword !== undefined) found.add(keyword);
  }
  return [...found];
}

/**
 * Rules text with the bracketed keywords and their parenthesised reminder text
 * removed — what's left is text that needs an implementation.
 *
 * Both strips matter. `[Tank] (I must be assigned combat damage first.)` is
 * entirely keyword, and a keyword is implemented in the rules engine (combat,
 * timing, exhaustion) rather than in an effect registry — counting it as missing
 * text would flag every vanilla-with-a-keyword card as broken. Getting this wrong
 * in an earlier ad-hoc audit is exactly what produced a false "5 precon cards are
 * inert" figure, three of which were keyword-only and fine.
 *
 * An UNIMPLEMENTED keyword is deliberately NOT stripped, because for it that
 * justification does not hold — there is no rules-engine implementation to defer
 * to, so the bracket really is text that still needs writing. It survives into
 * the residue so the deck builder can say WHICH keyword is missing rather than
 * just greying the card.
 */
export function implementableText(def: CardDefinition): string {
  const raw = "text" in def && typeof def.text === "string" ? def.text : "";
  const stripped = raw
    .replace(/\[([^\]]*)\]/g, (whole, inner: string) => (unimplementedKeywordIn(inner) !== undefined ? whole : ""))
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Punctuation that only separated the things we just removed is not text that
  // needs implementing. Garen - Rugged reads "[Assault 2], [Shield 2] (reminder)"
  // and left a bare "," behind, so a card whose every ability is a keyword — and
  // which therefore works perfectly through the keyword machinery — reported as
  // inert and greyed out in the deck builder.
  //
  // The test is "does anything alphanumeric survive", not a punctuation
  // blocklist: a real ability always names something, and this way an unforeseen
  // separator can't reopen the same hole.
  return /[\p{L}\p{N}]/u.test(stripped) ? stripped : "";
}

/** Does this card carry printed rules text that needs an implementation at all?
 *  False for vanilla cards and for keyword-only ones. */
export function needsImplementation(def: CardDefinition): boolean {
  return implementableText(def).length > 0;
}

let registered: Set<string> | null = null;

/**
 * Every module that implements a card's printed text, each declaring which
 * cards it covers.
 *
 * The first version of this asked only the three effect registries, and so
 * reported six working cards as inert — Annie - Fiery, Garen - Commander,
 * Eager Apprentice, Wielder of Water, Master Yi - Meditative and
 * Lux - Crownguard, all implemented as continuous modifiers, activated
 * abilities or parse-time keywords rather than as registered effects. That
 * greyed them out in the deck builder and would have sent a per-card
 * implementation pass to rewrite code that already worked.
 *
 * Asking each module rather than keeping a list here is the point: a list would
 * drift silently, and coverage-drift.test.ts asserts by scanning the source that
 * no card is implemented in a module absent from this array.
 */
const COVERAGE_SOURCES: ReadonlyArray<{ label: string; defIds: () => string[] }> = [
  { label: "card-effects", defIds: cardEffectDefIds },
  { label: "unit-triggers", defIds: unitTriggerDefIds },
  { label: "legend-abilities", defIds: legendAbilityDefIds },
  { label: "death triggers", defIds: deathTriggerDefIds },
  { label: "event triggers", defIds: eventTriggerDefIds },
  { label: "self triggers", defIds: selfTriggerDefIds },
  { label: "pending decisions", defIds: decisionDefIds },
  { label: "effective-might", defIds: effectiveMightDefIds },
  { label: "granted keywords", defIds: grantedKeywordDefIds },
  { label: "play-card rules", defIds: playCardDefIds },
  { label: "damage-modifiers", defIds: damageModifierDefIds },
  { label: "cost-modifiers", defIds: costModifierDefIds },
  { label: "activated abilities", defIds: activatedAbilityDefIds },
  { label: "borrowed abilities", defIds: borrowedAbilityDefIds },
  { label: "card-loader keywords", defIds: loaderHandledDefIds },
  { label: "death replacements", defIds: deathReplacementDefIds },
  { label: "combat assignment", defIds: combatAssignmentDefIds },
  { label: "board restrictions", defIds: boardRestrictionDefIds },
  { label: "hide costs", defIds: hideCostDefIds },
  { label: "top-of-deck looks", defIds: topOfDeckDefIds },
  { label: "deathknell modifiers", defIds: deathknellModifierDefIds },
];

/**
 * EVERY source that claims `defId`, not just the first.
 *
 * `implementingModule` below returns the first match in COVERAGE_SOURCES order,
 * which is the right answer for "where do I look" and the wrong one for "is this
 * card implemented by more than a pending decision" — a card claimed by both
 * `decisions` and a later source would report only the decision. Exported for
 * the coverage-drift test that pins exactly that.
 */
export function implementingModules(defId: string): string[] {
  return COVERAGE_SOURCES.filter((source) => source.defIds().includes(defId)).map((source) => source.label);
}

/** Every defId implemented anywhere in the engine. Computed once and lazily —
 *  eagerly would run across the pre-existing card-effects import cycle. */
function registeredDefIds(): Set<string> {
  registered ??= new Set(COVERAGE_SOURCES.flatMap((source) => source.defIds()));
  return registered;
}

/** Which module implements a given card, or undefined if none does. Exists for
 *  the drift test and for diagnosing "why is this card marked implemented?". */
export function implementingModule(defId: string): string | undefined {
  return COVERAGE_SOURCES.find((source) => source.defIds().includes(defId))?.label;
}

/**
 * Cards a module registers for only PART of their printed text.
 *
 * Registration is per defId, so a card with two abilities counts as covered the
 * moment either one is written. That is over-reporting, and this module's own
 * doc comment says why over-reporting is the worse direction: a greyed-out
 * working card wastes an implementer's time, but a card that *looks* finished
 * and silently does half of what it says is a wrong conclusion drawn from a
 * playtest.
 *
 * Each entry names what is missing, and the entry is deleted — not amended —
 * when the rest lands. A card is either finished or it is on this list.
 */
const PARTIALLY_IMPLEMENTED = new Map<string, string>([
  // The list above was EMPTY for a while, and that is the shape working rather
  // than an omission. Entries are DELETED when the rest lands, never reworded: Sett - The
  // Boss lived here while only his on-conquer clause worked, Convergent Mutation
  // for the hours between its enumeration gap being found and `asymmetricSlots`
  // landing, and Spirit's Refuge until `granted-keywords.KEYWORD_AURAS` gave a
  // GEAR-source aura with a per-target condition somewhere to live.
  //
  // Keep the mechanism rather than deleting it, for the reason
  // `UNIMPLEMENTED_KEYWORDS` above keeps its own empty map: registration is per
  // defId, so the next two-clause card written by halves reports DONE on the
  // first half, and this list is the only thing that says otherwise.
]);

/** What is still missing from a partially-implemented card, or undefined when
 *  the card is whole. Exported so the deck builder can say WHY rather than just
 *  greying it.
 *
 *  Takes the definition, not just the id, so an unimplemented keyword can be
 *  DERIVED rather than transcribed into the hand-maintained map above. That
 *  matters here more than it looks: six of the seven cards carrying `[Deflect]`
 *  have unrelated text of their own, so each would have needed a manual entry the
 *  moment that text landed — six chances to forget, and forgetting reads as
 *  "finished". The same reasoning as COVERAGE_SOURCES asking each module instead
 *  of keeping a list. */
export function partialImplementationNote(def: CardDefinition): string | undefined {
  const listed = PARTIALLY_IMPLEMENTED.get(def.id);
  const missingKeywords = unimplementedKeywordsOn(def).map((k) => UNIMPLEMENTED_KEYWORDS.get(k)!);
  // A card that carries an unimplemented keyword AND has no registered module at
  // all is not "partial" — NOTHING of it works, and saying only "[Deflect] is
  // ignored" understates the gap. Volibear - Furious and Commander Ledros are the
  // two: both read as one keyword away while their own attack trigger and
  // kill-any-number additional cost are equally unwritten, which would make
  // "implement [Deflect]" look like it finishes seven cards when it finishes five.
  //
  // This is the same over-report `UNIMPLEMENTED_KEYWORDS` was added to fix, one
  // level down — and pointed the other way, which is why it survived: nobody
  // checks a note for being too OPTIMISTIC about how little is left.
  // "Has prose of its own" is asked by stripping the unimplemented keywords too
  // and seeing whether anything alphanumeric survives — NOT merely by the card
  // being unregistered. Pouty Poro's entire printed text is `[Deflect]`, so it
  // genuinely IS one keyword away and must not be told it has unwritten prose;
  // the first version of this check said it did, which is the same kind of wrong
  // note in the opposite direction.
  const remainingProse = implementableText(def).replace(/\[[^\]]*\]/g, "");
  const hasOwnProse = /[a-z0-9]/i.test(remainingProse);
  const unregistered =
    missingKeywords.length > 0 && hasOwnProse && implementingModule(def.id) === undefined
      ? "nothing is registered for this card at all — its own text is unwritten too, so this is not one keyword away"
      : undefined;
  return [listed, unregistered, ...missingKeywords].filter((note) => note !== undefined).join("; ") || undefined;
}

/**
 * A defId's set code — "OGN-001" -> "OGN".
 *
 * `card-loader.deriveId` builds every id as `<SET>-<number>` out of the raw
 * `riftbound_id`, and does it for an unseen set with no change at all
 * ("sfd-001-298" -> "SFD-001"), so the prefix IS the set and needs no table.
 */
export function setCodeOf(defId: string): string {
  const dash = defId.indexOf("-");
  return dash === -1 ? defId : defId.slice(0, dash);
}

/**
 * The sets whose implementation is FINISHED, and which the completeness gates
 * therefore hold to zero unimplemented cards, by name.
 *
 * This list is the whole reason those gates are per set. Both of them used to
 * assert over the entire pool, which is correct exactly while the pool is
 * finished — and turns red the day a new set's JSON lands, then stays red for
 * the weeks it takes to implement it. That is a wall of noise arriving at the
 * one moment the suite most needs to say what is left.
 *
 * So: a set NAMED here is a hard gate (a regression in OGN or OGS still fails
 * loudly, naming the cards), and a set absent from here reports PROGRESS
 * instead. Adding a set here is one line, and it is the moment the gate starts
 * protecting it.
 *
 * That moment is not left to anyone's memory either — `coverageBySet` flags a
 * set that is fully implemented but still undeclared (`finishedButUndeclared`),
 * and test/set-coverage.test.ts fails on it. Finishing a set is what tells you
 * to promote it.
 *
 * What did NOT change: the gates still name the cards. A count or a percentage
 * would be cheaper to compute and useless to act on.
 */
export const COMPLETE_SETS: readonly string[] = ["OGN", "OGS"];

/** How much of one set is implemented. `unimplemented`/`partial` hold
 *  "OGN-001 (Name)" strings rather than counts, because naming the cards is
 *  the part of these gates worth keeping. */
export interface SetCoverage {
  /** "OGN". */
  readonly set: string;
  /** Named in COMPLETE_SETS, i.e. hard-gated. */
  readonly declaredComplete: boolean;
  /** Cards in this set carrying printed text that needs an implementation. */
  readonly needing: number;
  /** How many of those are implemented — the "270/270" figure, per set. */
  readonly implemented: number;
  /** Every card with real text and nothing registered for it, named. */
  readonly unimplemented: string[];
  /** Every card carrying a partial-implementation note, named. */
  readonly partial: string[];
  /** Fully implemented and NOT declared complete: it has earned its line in
   *  COMPLETE_SETS, and until it gets one nothing guards it against a
   *  regression. */
  readonly finishedButUndeclared: boolean;
}

function describeCard(def: CardDefinition): string {
  return `${def.id} (${def.name})`;
}

/**
 * Per-set coverage over any collection of definitions.
 *
 * Takes the definitions and the complete-set list as arguments rather than
 * reading the shared registry and the constant, so both directions of the gate
 * can be proved on synthetic input: a set under construction cannot otherwise
 * be exercised until one exists, which is exactly the kind of check that is
 * written, never run, and wrong when it finally matters.
 */
export function coverageBySet(
  defs: readonly CardDefinition[],
  completeSets: readonly string[] = COMPLETE_SETS,
): SetCoverage[] {
  const bySet = new Map<string, CardDefinition[]>();
  for (const def of defs) {
    const set = setCodeOf(def.id);
    const cards = bySet.get(set);
    if (cards) cards.push(def);
    else bySet.set(set, [def]);
  }

  return [...bySet.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([set, cards]) => {
      const needing = cards.filter(needsImplementation);
      const unimplemented = needing.filter((def) => !isCardImplemented(def));
      const partial = cards.filter((def) => partialImplementationNote(def) !== undefined);
      const declaredComplete = completeSets.includes(set);
      return {
        set,
        declaredComplete,
        needing: needing.length,
        implemented: needing.length - unimplemented.length,
        unimplemented: unimplemented.map(describeCard),
        partial: partial.map(describeCard),
        finishedButUndeclared:
          !declaredComplete && needing.length > 0 && unimplemented.length === 0 && partial.length === 0,
      };
    });
}

/**
 * One line of progress for a set under construction — what a gate reports
 * INSTEAD of failing while the set is being built.
 *
 * Names the first few cards left rather than only counting them, and says how
 * many it did not name. A silently truncated list reads as "that's all of
 * them", which is the same lie as a bare percentage.
 */
export function setProgressLine(coverage: SetCoverage): string {
  const named = coverage.unimplemented.slice(0, 5);
  const rest = coverage.unimplemented.length - named.length;
  const remaining =
    named.length > 0 ? ` — left: ${named.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}` : "";
  const partial = coverage.partial.length > 0 ? ` — partial: ${coverage.partial.join(", ")}` : "";
  return `${coverage.set}: ${coverage.implemented}/${coverage.needing} implemented${remaining}${partial}`;
}

/**
 * Is this card's printed text actually implemented?
 *
 * True for a card needing no implementation (vanilla or keyword-only) — those
 * aren't missing anything. False only when the card has real rules text and
 * nothing is registered for it, which is the case worth showing a player.
 *
 * Deliberately keyed off the real registries rather than a hand-maintained list:
 * a list would drift the moment someone registered a card without updating it,
 * and the whole value here is that the answer can be trusted.
 */
export function isCardImplemented(def: CardDefinition): boolean {
  if (!needsImplementation(def)) return true;
  // A card whose registration covers only some of its text is NOT implemented.
  // Checked before the registry, since it is registered — that is the whole
  // reason this list has to exist.
  if (PARTIALLY_IMPLEMENTED.has(def.id)) return false;
  // An unimplemented keyword is the same kind of partial, derived rather than
  // listed. Fiora - Victorious is the case that needs it: her grant IS registered
  // (granted-keywords), and [Ganking] and [Shield] really do work, so the registry
  // check below says yes while the [Deflect] third of her text does nothing.
  if (unimplementedKeywordsOn(def).length > 0) return false;
  return registeredDefIds().has(def.id);
}
