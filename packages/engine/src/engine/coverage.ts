import type { CardDefinition } from "../model/card-definition.js";
import { activatedAbilityDefIds } from "./activated-abilities.js";
import { loaderHandledDefIds } from "../cards/card-loader.js";
import { playCardDefIds } from "../actions/execute-play-card.js";
import { cardEffectDefIds } from "./card-effects.js";
import { costModifierDefIds } from "./cost-modifiers.js";
import { damageModifierDefIds } from "./damage-modifiers.js";
import { effectiveMightDefIds } from "./effective-might.js";
import { grantedKeywordDefIds } from "./granted-keywords.js";
import { deathTriggerDefIds, eventTriggerDefIds, selfTriggerDefIds } from "./triggers.js";
import { unitTriggerDefIds } from "./unit-triggers.js";
import { legendAbilityDefIds } from "./legend-abilities.js";

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
 * Rules text with the bracketed keywords and their parenthesised reminder text
 * removed — what's left is text that needs an implementation.
 *
 * Both strips matter. `[Tank] (I must be assigned combat damage first.)` is
 * entirely keyword, and a keyword is implemented in the rules engine (combat,
 * timing, exhaustion) rather than in an effect registry — counting it as missing
 * text would flag every vanilla-with-a-keyword card as broken. Getting this wrong
 * in an earlier ad-hoc audit is exactly what produced a false "5 precon cards are
 * inert" figure, three of which were keyword-only and fine.
 */
export function implementableText(def: CardDefinition): string {
  const raw = "text" in def && typeof def.text === "string" ? def.text : "";
  const stripped = raw
    .replace(/\[[^\]]*\]/g, "")
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
  { label: "effective-might", defIds: effectiveMightDefIds },
  { label: "granted keywords", defIds: grantedKeywordDefIds },
  { label: "play-card rules", defIds: playCardDefIds },
  { label: "damage-modifiers", defIds: damageModifierDefIds },
  { label: "cost-modifiers", defIds: costModifierDefIds },
  { label: "activated abilities", defIds: activatedAbilityDefIds },
  { label: "card-loader keywords", defIds: loaderHandledDefIds },
];

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
  return registeredDefIds().has(def.id);
}
