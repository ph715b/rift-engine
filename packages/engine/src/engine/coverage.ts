import type { CardDefinition } from "../model/card-definition.js";
import { keywordFromBracketText, type Keyword } from "../model/keyword.js";
import { activatedAbilityDefIds, borrowedAbilityDefIds } from "./activated-abilities.js";
import { canonicalDefId, loaderHandledDefIds, printingAliases } from "../cards/card-loader.js";
import { playCardDefIds } from "./deploy.js";
import { cardEffectDefIds, optionalXpCostDefIds } from "./card-effects.js";
import { costModifierDefIds } from "./cost-modifiers.js";
import { damageModifierDefIds } from "./damage-modifiers.js";
import { effectiveMightDefIds } from "./effective-might.js";
import { grantedKeywordDefIds } from "./granted-keywords.js";
import {
  deathTriggerDefIds,
  deathknellModifierDefIds,
  eventTriggerDefIds,
  selfTriggerDefIds,
  triggerDoublerDefIds,
} from "./triggers.js";
import { decisionDefIds } from "./decisions.js";
import { unitTriggerDefIds } from "./unit-triggers.js";
import { legendAbilityDefIds } from "./legend-abilities.js";
import { deathReplacementDefIds } from "./death-ward.js";
import { combatAssignmentDefIds } from "./combat.js";
import { boardRestrictionDefIds } from "./board-restrictions.js";
import { hideCostDefIds } from "./hidden.js";
import { topOfDeckDefIds } from "./top-of-deck.js";
import { battlefieldAbilityDefIds, beginningPhaseBattlefieldDefIds } from "./battlefield-abilities.js";
import { continuousBattlefieldDefIds, moveRestrictionDefIds } from "./battlefield-continuous.js";
import { turnManagerDefIds } from "./turn-manager.js";
import { chooseRestrictionDefIds } from "./target-lookup.js";
import { accelerateGrantDefIds, playRestrictionDefIds } from "./timing.js";
import { replacedCostDefIds } from "./replaced-costs.js";

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
  // Was EMPTY from 2026-08-02 until Spiritforged landed on 2026-08-04, and the
  // mechanism was kept rather than deleted for exactly this: `[Deflect]` lived
  // here while it was parsed and ignored, and DELETING that one entry flipped
  // all five cards whose only remaining gap it was.
  //
  // These four are SFD's, and they are here on the day the JSON arrived rather
  // than after somebody noticed a card doing nothing. Two subsystems sit behind
  // them, neither of which exists in this engine:
  //
  //   Equipment/attachment — `activeGear` is a flat per-player list with no
  //   attachment concept, and `Listener.battlefieldId`'s comment ("Gear is
  //   never at a battlefield in this pool") is falsified by an Equipment
  //   attached to a unit, which the rules place at that unit's battlefield.
  //
  // Each string is what a deck builder shows for a card whose only remaining
  // gap is this keyword, so it says what is missing rather than greying it.
  // `[Equip]`, `[Quick-Draw]`, `[Weaponmaster]` and now `[Repeat]` have all LEFT
  // this map: attachment exists, and 25 of the 31
  // Equipment carry a generated ability that works. The 6 it does not reach are
  // named individually in PARTIALLY_IMPLEMENTED below rather than held here,
  // because a keyword-level flag would wrongly grey the 25 that work.
  //
  // **`[Repeat]` left on 2026-08-06**, and the shape of its removal is worth
  // recording because the note that stood here was wrong TWICE.
  //
  // It first claimed the Java oracle's "resumable choice (pendingRepeatChoice /
  // effectiveRepeatCost / maybeOfferRepeat)" meant the keyword needed a Cleanup
  // that could suspend mid-resolution and continue on an answer — the same shape
  // the turn-advance state machine has, and the reason this sat untouched for
  // weeks. That was the ORACLE's implementation, not what the rules require;
  // 320/321 make Cleanup and resolution mutually exclusive, so nothing can fall
  // between the two executions and none needs resuming.
  //
  // The correction that replaced it was itself incomplete. It said the keyword
  // needed "a FLAG on the chain entry, and a second `effect.resolve` call" — but
  // 820.1.d also says: "When a spell or ability's effect is performed an
  // additional time with Repeat, choices must be made at the usual time during
  // the Make Relevant Choices step of Playing a Card. **Choices made for the
  // additional execution do not have to be the same as the choices made for the
  // initial execution.**" A flag alone would have silently re-run the FIRST
  // execution's targets. Rocket Barrage prints the point in its own reminder
  // text ("and may make different choices"), and the rulebook's worked example
  // for it turns on killing two DIFFERENT gear in a chosen order. So the chain
  // entry carries a second choice SET (`repeatChoices`), not a boolean.
  //
  // Both corrections came from re-reading the PDF rather than the note. A
  // comment is a claim, and claims are checkable.
  //
  // ---- Unleashed (UNL), on the day unl.json landed (2026-08-08) ----
  //
  // All four sit behind ONE thing that does now exist — `PlayerState.xp`, added
  // the same day — and none of them behind a subsystem the size of attachment.
  // They are here because the keyword is PARSED and read by nothing, which is
  // the `[Deflect]`-shipped-inert shape, and each leaves the map the moment its
  // own listener lands rather than when the set is finished.
  //
  // Counts are over the pool that LOADS (235 of 280 raw entries): the raw file's
  // higher numbers count alternate-art printings that `shouldSkip` drops.
  // **`[Hunt]` LEFT this map on 2026-08-08**, the same day it arrived — one
  // keyword-keyed entry in `triggers.ts` (`HUNT_TRIGGER_KEY`) serves all 12
  // cards, because both of its moments were already held events and the only
  // thing that varies between the cards is the magnitude the keyword carries.
  // Deleting the entry is what flips every card whose only remaining gap it was;
  // for UNL-100 Voracious Gromp, whose entire printed text is `[Hunt 3]` and its
  // reminder, that is the whole card.
  // **`[Level]` LEFT on 2026-08-09, and the shape of its removal is [Repeat]'s.**
  //
  // The entry said "[Level] is ignored — its ability is granted unconditionally
  // instead of at an XP threshold". That was true of the ENGINE when written and
  // is not a property of the keyword: wave-2 agents implemented it per card with
  // an `atLevel(state, playerIndex, threshold)` read of `PlayerState.xp`, which is
  // `[Legion]`'s precedent and gates in BOTH directions — 824.1.d makes the
  // ability Inactive again the moment XP drops below N, which is why a one-shot
  // pump was refused by two separate agents as not an acceptable approximation.
  //
  // A keyword-level flag greys every card that prints the word, so it was
  // reporting Combat Experience and Wuju Apprentice — both of which gate
  // correctly — as unimplemented. That is not merely cosmetic: `deck-generator`
  // filters on `isCardImplemented`, so all 16 were excluded from generated decks,
  // unreachable in play, and invisible to `reachability` and `ai-health`. A card
  // cannot be observed working while the gate says it does not work.
  //
  // The cards whose `[Level]` clause is genuinely unwritten are named individually
  // in `PARTIALLY_IMPLEMENTED` below — same as `[Repeat]`, for the same reason its
  // note gives: a keyword-level flag would wrongly grey the ones that work.
  // **`[Ambush]` LEFT on 2026-08-09.** The entry read "[Ambush] is ignored — this
  // can't yet be played as a [Reaction] to a battlefield you hold", and the
  // description was itself slightly wrong: 822.1.b says "a battlefield where you
  // control Units", and holding is a different question — a battlefield can be
  // held by a player with no units standing there.
  //
  // The PLACEMENT half of the keyword needed nothing: the ordinary reinforce rule
  // already allows a Unit into a battlefield where its controller has units. Only
  // the TIMING was missing, and it is conditional on the DESTINATION, which is why
  // it could not be a per-card tier — see `timing.ambushReactionAt`.
  //
  // It was the largest single blocker left in this map: twelve cards, none of
  // which could appear in a generated deck while it stood.
  // **`[Backline]` LEFT this map on 2026-08-10, and its entry was the clearest
  // case yet of a note outliving the thing it described.** The row said the four
  // UNL cards "get nothing from `assignmentOrder` until it learns to ask the
  // keyword" — which was true when written, and stopped being most of the way
  // true when `"Backline"` was added to `model/keyword.ts` with the set. From then
  // on the parser was populating the keyword and `assignmentOrder` simply never
  // asked; the tier logic, including Tank's tie-break, had been sitting in
  // `combat.ts` the whole time for Caitlyn's sake.
  //
  // One line in `assignmentOrder` — `hasKeyword(..., "Backline")` beside the
  // existing allowlist — freed three cards outright. Caitlyn keeps the allowlist
  // because she prints the sentence as prose and carries no bracket at all.
  //
  // UNL-090 LeBlanc - Everywhere At Once is NOT freed by it, and correctly gets
  // no row here. She was never one keyword away — nothing is registered for her
  // at all — so she now reports plainly unimplemented rather than blamed on
  // `[Backline]`. That is the right direction: this map exists for cards that
  // would otherwise look FINISHED, and a card with no implementation already
  // looks unfinished without help. She is the reason `unimplementedKeywordsOn`
  // and `PARTIALLY_IMPLEMENTED` are separate answers.
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
  // The "trigger an additional time" doublers, whose OTHER clause is an ordinary
  // trigger in a domain file — so without this the second sentence claims nothing.
  { label: "trigger doublers", defIds: triggerDoublerDefIds },
  { label: "self triggers", defIds: selfTriggerDefIds },
  { label: "pending decisions", defIds: decisionDefIds },
  { label: "effective-might", defIds: effectiveMightDefIds },
  { label: "granted keywords", defIds: grantedKeywordDefIds },
  { label: "play-card rules", defIds: playCardDefIds },
  { label: "damage-modifiers", defIds: damageModifierDefIds },
  { label: "cost-modifiers", defIds: costModifierDefIds },
  { label: "turn-manager", defIds: turnManagerDefIds },
  { label: "activated abilities", defIds: activatedAbilityDefIds },
  { label: "borrowed abilities", defIds: borrowedAbilityDefIds },
  { label: "card-loader keywords", defIds: loaderHandledDefIds },
  { label: "death replacements", defIds: deathReplacementDefIds },
  { label: "combat assignment", defIds: combatAssignmentDefIds },
  { label: "board restrictions", defIds: boardRestrictionDefIds },
  { label: "hide costs", defIds: hideCostDefIds },
  { label: "top-of-deck looks", defIds: topOfDeckDefIds },
  { label: "deathknell modifiers", defIds: deathknellModifierDefIds },
  // The BATTLEFIELD cards' own abilities. Their ids never reach
  // `needsImplementation` — `card-loader`'s `shouldSkip` keeps Battlefield-type
  // cards out of the loaded pool entirely — so this source claims nothing the
  // deck builder counts. It is here for the other half of coverage's job:
  // `implementingModule` has to be able to say where OGN-275's printed text
  // lives, and the source-scanning drift test flags any id it cannot.
  { label: "battlefield abilities", defIds: battlefieldAbilityDefIds },
  { label: "beginning-phase battlefields", defIds: beginningPhaseBattlefieldDefIds },
  { label: "continuous battlefields", defIds: continuousBattlefieldDefIds },
  // Minotaur Reckoner is a UNIT whose text is a global move restriction, so it
  // lives in battlefield-continuous.ts beside the one door that answers "may
  // this unit go home" — and it needs its own claim, since the battlefield
  // source above lists only battlefields.
  { label: "move restrictions", defIds: moveRestrictionDefIds },
  // Ruin Runner is a UNIT whose text is a pure NEGATIVE — "I can't be chosen
  // by enemy spells and abilities" — so it lives in target-lookup.ts beside the
  // walk that answers "may this be chosen", for the same reason Minotaur
  // Reckoner lives beside the move gate. It needs its own claim, since none of
  // the sources above lists it.
  { label: "choose restrictions", defIds: chooseRestrictionDefIds },
  // Rek'Sai - Breacher grants [Accelerate] by PLAY SOURCE, so his third clause
  // lives in timing.ts beside the one function that answers "does this card
  // have [Accelerate] right now". His printed [Accelerate] and [Assault] are
  // the loader's; only the grant is written by hand.
  { label: "accelerate grants", defIds: accelerateGrantDefIds },
  // Perched Grimwyrm's whole printed text is a play RESTRICTION — "play me only
  // to a battlefield you conquered this turn" — so it lives in timing.ts beside
  // the destination gate, and needs its own claim for the same reason Minotaur
  // Reckoner and Ruin Runner do.
  { label: "play restrictions", defIds: playRestrictionDefIds },
  // UNL-089 Jhin - Meticulous Killer and UNL-025 Undying Legion are cards whose
  // printed text is a PRICE and nothing else — "you may play me for [Cost]"
  // (356.1.a). Neither has an effect, a trigger or a keyword to register, so
  // neither would be claimed by any source above; the replacement itself is the
  // whole card. Same reason Perched Grimwyrm's restriction and Ruin Runner's
  // negative each need their own claim.
  { label: "replaced costs", defIds: replacedCostDefIds },
  // The optional XP additional cost. `optionalXpCostDefIds` has existed since
  // UNL-164 Safety Inspector but was never wired in here — he reports finished
  // through his on-play trigger, so nothing missed it. UNL-178 Poppy - Defender
  // of the Meek has no effect at all: her text is `[Ambush]`, `[Tank]` and the XP
  // cost, so this source is the only thing that can claim her.
  { label: "optional XP costs", defIds: optionalXpCostDefIds },
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
  // **Asked of the CANONICAL printing.** Unleashed prints every Legend three
  // times and reprints five Poros, as distinct ids for the same card. The effect
  // registries alias those at merge time, but two coverage sources report the
  // ids they hold rather than the keys they are reached by — `effectiveMightDefIds`
  // maps each entry's own `defId`, and `playCardDefIds` is a hand-listed array —
  // so an alternate printing would report unimplemented while working perfectly.
  //
  // Resolved HERE, once, rather than in each source: this is the module that
  // answers "is this card implemented", and the answer for a printing is
  // whatever the answer is for the card.
  const canonical = canonicalDefId(defId);
  return COVERAGE_SOURCES.filter(
    (source) => source.defIds().includes(defId) || source.defIds().includes(canonical),
  ).map((source) => source.label);
}

/** Every defId implemented anywhere in the engine. Computed once and lazily —
 *  eagerly would run across the pre-existing card-effects import cycle. */
function registeredDefIds(): Set<string> {
  // Alternate printings count as registered when their canonical print is —
  // same reasoning as `implementingModules` above.
  registered ??= new Set([
    ...COVERAGE_SOURCES.flatMap((source) => source.defIds()),
    ...[...printingAliases()].filter(([, canonical]) =>
      COVERAGE_SOURCES.some((source) => source.defIds().includes(canonical)),
    ).map(([alias]) => alias),
  ]);
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
  // **Keep the mechanism even when this list empties**, for the reason
  // `UNIMPLEMENTED_KEYWORDS` above keeps its own empty map: registration is per
  // defId, so the next two-clause card written by halves reports DONE on the
  // first half, and this list is the only thing that says otherwise. It has been
  // empty before and refilled the same week.
  //
  // **The Equipment whose printed ability exists ONLY on the card art**, and the
  // worst blind spot this file has had. `needsImplementation` reads the card
  // text; for every one of these `text.plain` holds the `[Equip]` line and
  // nothing else, so the generated equip ability made them report
  // `isCardImplemented = true` — a card that looks finished while doing NONE of
  // what it prints, which this map's own doc comment calls the wrong direction to
  // err in.
  //
  // **Fifteen cards read that way until 2026-08-06.** The eight wearer's-moments
  // ones left first; Guardian Angel, Last Rites, Brutalizer and Experimental
  // Hexplate followed on 2026-08-07. Two of those four were held here on notes
  // that turned out to be MIS-PRICED rather than blocked — see this file's git
  // history and the log in docs/rules-conformance.md.
  //
  // **The list is EMPTY as of 2026-08-07, and SFD is complete.** The last three
  // out were The Zero Drive, Skyfall of Areion and Svellsongur, and all three
  // notes had over-priced their own mechanism:
  //
  //  - The Drive's "banish-with-source tracking" is one optional field on
  //    `GearInstance` plus the death-watch that fills it.
  //  - The Skyfall's "moment-rewriting layer, which has no precedent here" is one
  //    function handing a trigger's own `applies` the OTHER moment — small only
  //    because every hold and conquer trigger in this pool already decides for
  //    itself against `event.kind`.
  //  - **Svellsongur's was the closest to right and is still not a note this file
  //    should carry.** Copying the wearer's text DOUBLES that unit's abilities,
  //    and what is implemented is every table where an ability can be doubled at
  //    all: event triggers, their decision continuations, `[Deathknell]`s and
  //    activated abilities. The two tables left — continuous Might auras and cost
  //    modifiers — are a recorded DIVERGENCE in docs/rules-conformance.md rather
  //    than a partial, because the card's text IS implemented and the gap is in
  //    how far a doubling reaches. A note here would say the card does nothing,
  //    which is the over-report this map exists to prevent, pointed the other way.
  //
  // **AND IT REFILLED ON 2026-08-08, with UNL's Equipment, in exactly the same
  // way.** The list was empty for one day. All five UNL Equipment carry art-only
  // content — a Might badge on all five, and a whole ability on four — and three
  // of them reported `isCardImplemented = true` while doing NONE of that
  // ability, because the generated `[Equip]` ability registers the defId and
  // `text.plain` holds only the Equip line. That is the identical blind spot
  // this section was written for, one set later, found the same way: by reading
  // the card images rather than the data.
  //
  // Transcriptions in docs/unl-equipment-abilities.md. Two of the five are NOT
  // here and the difference is worth stating, because "carries art-only content"
  // and "is missing an implementation" are different claims:
  //
  //   UNL-096 Hunter's Machete grants `[Hunt]` on its art, and that IS
  //   implemented — as an `EQUIP_GRANTED_KEYWORDS` entry, which is the same
  //   mechanism Doran's Shield's `[Tank]` uses. Nothing about it is missing.
  //
  //   UNL-158 Shepherd's Heirloom is FULLY WRITTEN as of 2026-08-09 and needs no
  //   entry. **This paragraph used to say the opposite** — that it "already
  //   reports unimplemented on its own, because its `[Equip] — Spend 1 XP` cost
  //   is the one `ActivationCost` cannot price". That was true when written and
  //   is not now: a wave-2 agent wrote both clauses, taking the XP through
  //   `availableWhile: canSpendXp` + `spendXp` in `resolve` rather than through
  //   `ActivationCost`, which still has no `xp` field. The cost is real and paid;
  //   only its PLACEMENT diverges (204.1.b makes it a base cost), and that is
  //   unobservable while activations resolve inline. Recorded in
  //   docs/rules-conformance.md rather than here, because this map is for cards
  //   that would otherwise look finished — and this one now IS finished.
  // **UNL-019 and UNL-039 LEFT this map on 2026-08-09**, both written in wave 3.
  // Recorded because a stale entry here fails in the direction this file is least
  // watchful about: it makes a FINISHED card report unfinished, which is quiet
  // (nobody chases a card that claims to be incomplete) and which also keeps it
  // out of every generated deck, since `deck-generator` filters on
  // `isCardImplemented`. Both agents flagged their own row as owed for deletion;
  // neither could delete it.
  //
  // **Cards written by HALVES in wave 3.** Every one reports DONE without an entry
  // here, because registration is per defId and the first clause claims the card.
  // Each was named by the agent that wrote it and each is pinned by a test in that
  // agent's file asserting the wrong answer, so closing the gap fails loudly.
  // **UNL-017 Square Up LEFT this map on 2026-08-13.** Its `[Repeat]` is priced
  // in CARDS — "Discard 1" — and `RepeatCostSpec` held Energy, Power and a
  // domain, nothing else. Every other Repeat in the pool is a resource cost,
  // which is why the interface had never needed anything more.
  //
  // 820.1.c.1 makes a Repeat cost "an Additional Cost to be paid during the
  // steps of playing" and says nothing about what KIND of cost it is, so the
  // spec gained a `discard` and the action carries WHICH card — unlike Energy,
  // one card in hand is not interchangeable with another.
  //
  // This is NOT the multi-instance Repeat work that Curtain Call and Syndra
  // still wait on. Those need `REPEAT_COSTS` to hold a LIST payable
  // individually (820.3); this is one instance whose price is a card.
  // **STRONGER than printed, which is the worse direction of the two.** Every other
  // entry here under-reaches; this one lets the gear be cracked the turn it lands.
  [
    "UNL-140",
    "half written: the take-control works; its optional 'spend 5 XP' cost is deliberately not offered — the XP cost mechanism now exists (OPTIONAL_XP_COSTS), but this card's cost buys a WIDER TARGET and optional costs are fanned out inside the target loop, so a paid variant would still carry a 3-Might-capped target and sell the XP for nothing",
  ],
  // **UNL-164 Safety Inspector LEFT this map on 2026-08-10.** Its note named
  // four shared files and was right about all four; `OPTIONAL_XP_COSTS` plus
  // `optionalXpPaid` is what they became. Worth recording that the refusal
  // OVERestimated the work in one specific way: it expected the pricing
  // fan-out an optional POWER cost needs, and XP needs none of it — 731 makes
  // XP not a Game Object, so there is no domain, no [Deflect] tax and no
  // discount axis, and the paid variant is the plain play plus a flag.
  // **UNL-168 Undying Loyalty LEFT this map on 2026-08-12.** Its refusal was
  // accurate for three waves and the blocker was never a table: the discount is
  // '-[2] if you CHOOSE a Bird, Cat, Dog, or Poro', and a cost must be known when
  // the card is paid for, while the card named its trash unit at RESOLUTION
  // through a parked question. Moving that choice to an announce-time target
  // (355.4 / 355.9.a.4) is what made the discount expressible at all.
  // **UNL-170 Atakhan LEFT this map on 2026-08-12.** His refusal was accurate and
  // named all three shared files it would take: the KILL was expressible
  // (`killFriendly` is Cruel Patron's row) but the DISCOUNT was not, because
  // `repeatable` buys a flat 1 Power per payment while his scales with the
  // printed cost of whatever was killed, on both axes at once.
  //
  // That is `sacrificeCostDiscount`, and the thing that made it more than a
  // number is that its size depends on WHICH unit a variant kills — so unlike
  // every board-keyed discount it is priced per enumerated variant, and both
  // pricing sites re-run it through `computeEffectiveCost` rather than
  // subtracting after it.
  // **UNL-188's note was REWRITTEN on 2026-08-12, not retired**, and the reason
  // is the interesting part: a wave-7 agent wrote the art-only band the old note
  // named — the conquer-with-3-excess-damage draw — and then found the card is
  // STILL unfinished for a reason nobody had recorded anywhere.
  //
  // Its printed text carries a rider: "This ability's Energy cost is reduced by
  // the Might of the unit you choose." `equipAbilities` builds ONE static
  // `ActivationCost` per gear out of `def.equipCost`, so a cost that depends on
  // the activation's chosen target has nowhere to live — the same shape
  // `sacrificeCostDiscount` had to be invented for on the play path.
  //
  // Nothing noticed because the direction is safe: the gear is always dearer than
  // printed, never cheaper. Verified against the card's own `text` in the
  // registry rather than taken from the agent's report.
  [
    "UNL-188",
    "half written: the conquer-with-3-excess-damage draw works; its PRINTED '[Equip] cost is reduced by the Might of the unit you choose' does not — equipAbilities builds one static ActivationCost per gear and no activation cost can depend on the chosen target",
  ],
  // **UNL-147 Baron Nashor, written by a THIRD in wave 7.** His "other friendly
  // units have +2 [Might]" landed as this engine's first `mightModifiers` entry;
  // his other two sentences did not, and both leave him weaker than printed.
  //
  // The first is systemic rather than a card gap, and was checked rather than
  // assumed: **nothing in the engine can add a battlefield at all.**
  // `battlefieldPair` builds exactly two at setup with ids stable for the game's
  // lifetime, no writer appends to `state.battlefields`, and the Baron Pit has no
  // card data in unl.json — 187.9 would have to be transcribed. 172 makes the
  // battlefield count a property of the Mode of Play, so a third one is a third
  // scoring location and would move `walkout`'s pinned figures.
  [
    "UNL-147",
    "two of three clauses: the +2 Might aura and 'I can't be chosen by enemy spells and abilities' both work; 'add the Baron Pit battlefield token to the board' is unwritten, and is SYSTEMIC rather than a card gap — nothing in this engine can add a battlefield at all, battlefieldPair builds exactly two at setup with ids stable for the game, and the Pit has no card data in unl.json",
  ],
  // **UNL-020 Dancing Grenade, written by HALVES in wave 7.** "Deal 2 to a unit"
  // works; "its controller may play this spell again for [rainbow]" does not.
  //
  // Registration is per defId, so the half that landed would otherwise claim the
  // whole card — and `unl-fury-wave3.test.ts` pins it as unimplemented, which is
  // the assertion this row exists to keep true rather than to weaken.
  [
    "UNL-020",
    // **Re-triaged 2026-08-13**: the replaced-cost half of the old note is BUILT
    // (356.1.a, engine/replaced-costs.ts) and no longer the blocker. What remains
    // is the grantee's timing, which is structural.
    "half written: the 2 damage works; 'its controller may play this spell again for [rainbow]' is unwritten — the replay is granted to the DAMAGED unit's controller, and a permission is only usable by the ACTIVE player (mayPlayCardNow refuses a non-acting player, this card is Default-timed, and the grant clears at runEnd), so a cross-seat replay needs the mid-resolution play 419.3.b describes and this engine lacks; the escalating bonus additionally needs a per-instance tally of one spell's damage instances this turn",
  ],
  // **Two cards written by HALVES in wave 2, 2026-08-09.** Both report finished
  // without these, which is this map's whole reason to exist. Neither agent could
  // add its own entry — coverage.ts is shared and six of them were writing at
  // once — so both named the missing clause in their report and I placed it here.
  //
  // Their refusals were CORRECT: each declined to write the second clause against
  // a mechanism that does not exist, rather than registering something that would
  // report DONE and never fire.

  // **Three rows LEFT this map on 2026-08-10** — UNL-049 and UNL-136 to a
  // `GEAR_ENTERING_EXHAUSTED` entry each, UNL-052 Nami to an
  // `OPTIONAL_POWER_COSTS` row. All three notes named the exact table that
  // was missing them and all three tables already existed; the waves that
  // wrote the cards simply could not edit a shared file. **Two of the three
  // were STRONGER than printed** while they sat here, which is the direction
  // this map's own comment calls the worse one.
  // **UNL-016 Scorchclaw and UNL-191 Master Yi - Wuju Master LEFT this map on
  // 2026-08-10.** Both were half-written in the same shape — a `[Level N]`
  // Might aura in a domain file, and an 'enter ready' clause that only
  // `deploy.ts` can answer — and both agents refused that half by name rather
  // than fake it as an on-play `readyUnit`. Those refusals were RIGHT, and
  // deploy.ts's own header gives the three measured reasons the workaround is
  // wrong. The fix was one `case` and one board query, beside the ones already
  // there for Leona, Vayne and Magma Wurm.
  // **Wave 6, 2026-08-10.** One card written by halves — two of three clauses.
  // **UNL-201 Kha'Zix - Voidreaver LEFT this map on 2026-08-12**, and his note is
  // the cleanest example in this file of a refusal that named its own price and
  // then got paid. It said two abilities on one defId must be modes of one entry,
  // and that `canPayActivationCost` received `modeId` and dropped it — so one
  // predicate could not price both.
  //
  // `ActivationCost` gained an `xp` field, checked in `canPayActivationCost` and
  // paid in `payActivationCost` through `spendXp`. His entry became a two-mode
  // ability and the wave-8 agent found a live double-bill while doing it: the buff
  // mode's `resolve` still spent the XP the cost layer now takes.
  // **UNL-059 Master Yi - Unstoppable LEFT this map on 2026-08-12.** He was the
  // example this map's own header used — one card written by a quarter, with the
  // clause that landed being the LAST of four, so the first three were what a
  // reader would assume works.
  //
  // His note named the seam exactly ("a tiered lookup in cost-modifiers.ts
  // applied in BOTH modifiedEnergyCost and scaledPowerDiscount, since the deepest
  // tier replaces the shallower ones") and that is what was built. Concentrate's
  // table was already the same shape; what Yi added was a tier discounting both
  // halves at once, which is why the tier is now chosen by one shared helper
  // instead of by a `find` in each function.
  // **UNL-029 Red Brambleback and UNL-087 Blue Sentinel LEFT this map on
  // 2026-08-11.** Both were half-written for the same missing mechanism — "your
  // conquer/hold effects for ...ing here trigger an additional time" — and both
  // agents refused it in the same words: `holdEventTrigger` had no `times`
  // multiplier. It has one now, built to match Karthus - Eternal's, who prints
  // the identical sentence.
  // **Wave 4, 2026-08-09.** Seven more cards written by halves, every one of
  // which reported DONE on its first clause before these rows landed. Each was
  // named by the agent that wrote it and pinned by a test in that agent's file.
  //
  // UNL-144 is the one to read twice: it is STRONGER than printed, not weaker.
  // Every other entry here under-reaches.
  [
    "UNL-007",
    "half written: the 3 damage works; 'if it would die this turn, banish it instead' is unwritten — a turn-long death replacement needs a GameState list, a killUnit branch and a runEnd sweep",
  ],
  // **UNL-073 Deadly Flourish LEFT this map on 2026-08-12.** Its second clause
  // needed one line in a shared file — `TRASH_LISTENER_DEF_IDS` — and a wave-3
  // note had recorded that route as CLOSED. It was not: `execute-play-card`
  // trashes a Spell at play time, so the card is already in its caster's trash
  // when its victim dies. Nothing had checked.
  //
  // The wave-8 agent that wrote it found the brief's own design wrong in one
  // detail worth keeping: `turnNumber` counts ROUNDS, not turns, so a
  // this-turn marker stamped with it alone survives into the opponent's turn.
  // The mark carries the active player as well.
  [
    "UNL-118",
    "half written: the on-play 'up to one enemy unit at each location, deal 1' works; 'Any amount of your damage is enough to kill enemy units' is unwritten — 142.4.c needs per-marker damage (UnitInstance.damage is one unattributed number) and a Lethal Damage override",
  ],
  // **UNL-144 Maduli the Gatekeeper LEFT this map on 2026-08-13, and it was the
  // only entry that had to be fixed rather than merely finished** — the note
  // says so in its own last clause: he was STRONGER than printed, so this was a
  // live divergence in shipped behaviour, not an absence.
  //
  // The refusal named both halves of the fix exactly. `runAwaken` readies by
  // inline maps (415.3.a) and `readyUnit`'s only lock was per-player (415.3.b),
  // so "I can't be readied" needed a per-UNIT predicate asked at both —
  // `board-restrictions.unitMayBeReadied`. The third site the note did NOT name
  // is the `awakened` capture that raises `unitReadied` events, and it matters
  // for the same reason: a unit that did not ready must not announce that it did.
  // **UNL-095 Grim Resolve LEFT this map on 2026-08-12, and its note had been
  // wrong about the ENGINE rather than about the card.** It argued the listener
  // had to be the resolved Spell, which sits in its caster's trash and reaches no
  // walk — a true observation with a false conclusion. The listener rides on the
  // UNIT: `grantTriggerThisTurn` writes a key onto `grantedTriggersThisTurn`,
  // `triggerKeysOn` hands it to the walk beside the card's defId, and `runEnd`
  // sweeps it — which is exactly what "this turn" means. Relentless Pursuit
  // (SFD-184) already worked this way.
  //
  // Worth keeping as the counter-example to this file's usual pattern: a refusal
  // note that names a real mechanism can still reach the wrong verdict, so the
  // notes are leads rather than rulings.
  // **UNL-133 Blast Cone left this map on 2026-08-09.** Its second clause was
  // refused twice, and the gap was never the clause: no effect-driven move
  // emitted an event, and `unitMoved.moverIndex` names the moved unit's
  // controller rather than the mover. Both are fixed — 446.1/449 gave the event,
  // and the new `causedByIndex` says who did the moving — so it is written now.
  // **Exposed by removing the `[Level]` keyword flag above**, which had been
  // greying this card for the wrong reason. Its draw is written; its two
  // `[Level]` COST reductions are not — those are a `modifiedEnergyCost` entry in
  // `cost-modifiers.ts`, not something a domain effect file can express. Worth
  // noting for whoever writes it: `[Level 11]` says "instead", so the deeper tier
  // REPLACES the shallower one — the reduction is −4, not −6.
  // **UNL-091 Concentrate LEFT this map on 2026-08-10.** Its note said "no
  // cost-modifiers entry", which was exactly right and exactly as small as it
  // sounds: `modifiedEnergyCost` already takes `state`, so reading XP needed no
  // plumbing at all. The only thing worth care was the printed "instead" — the
  // [Level 11] tier REPLACES [Level 6], so the discount is -4 and never -6.
  // **UNL-023 Katarina - Reckless is HALF written**, and she is the first card in
  // this pool to make the decision-key over-report REAL rather than theoretical.
  //
  // Her second clause ("when you play a card from face down, deal 2") is
  // implemented; her first ("when you hide a card, ready me") is not. That alone
  // would be an ordinary partial. What makes her worth this comment is that
  // `decisionDefIds()` peels a defId off every decision KEY, so her
  // `UNL-023-shot` handler claims the whole card on its own — measured: with her
  // event trigger deleted, `isCardImplemented("UNL-023")` still returns true.
  //
  // `coverage-drift.test.ts` already documents that mechanism, and its stated
  // reason for being a TEST rather than a fix was "nothing in the pool is
  // affected today". **Three cards from this wave affect it** (UNL-023, and
  // UNL-121/UNL-137 whose decisions likewise claim them), so that premise has
  // expired. Tightening `isCardImplemented` is the real fix and it is a
  // behaviour change to a shared instrument — deliberately NOT taken here, in
  // the same change as 30 new cards. This entry is the honest stopgap: it makes
  // the one card that is genuinely half report as half.
  // **UNL-023 Katarina - Reckless LEFT this map on 2026-08-13.** Her missing
  // clause needed an EVENT that did not exist — nothing raised "a card was
  // hidden" — and the `cardHidden` arm landed as a wave-8 primitive.
  //
  // 811 says hiding opens no chain, which is not a reason the event cannot
  // exist: a trigger CAUSED by hiding still goes on the chain under 383.3,
  // exactly as `runesRecycled` already does from that same action handler.
  //
  // The mechanism note above is deliberately KEPT — it also records
  // `decisionDefIds()` over-reporting for UNL-121 and UNL-137, which survives
  // this card being finished.
  // **Wave 5, 2026-08-10.** One card, and its shape is worth reading because the
  // refusal behind it was argued rather than assumed. Vilemaw prints three
  // clauses; the hold-draw is written, `[Ambush]` is the loader's, and the third
  // is a conditional aura over the OPPONENT's units.
  //
  // `combat.ts`'s `DEALS_NO_COMBAT_DAMAGE_DEF_IDS` is keyed by the defId of the
  // unit that is silenced, which fits Ezreal - Dashing (who silences himself) and
  // cannot express "enemy units HERE with less Might than me". The agent also
  // considered and REJECTED routing it through `mightModifiers` as an
  // outgoing-Might floor, on two grounds: that it recurses, and that it would
  // strip Mightiness through `isMighty`'s outgoing branch. This note used to end
  // "Both are right."
  //
  // **Wave 7 measured both, on 2026-08-12, and neither survives as stated.**
  //   - The RECURSION is real only if the comparison is made at
  //     `isCombat: true`. At `{ isCombat: false }` `effectiveMight` never reads
  //     keywords, so the modifier returns 0 on its first line and the depth is 2.
  //     (The unbounded cycle it feared is genuine at `isCombat: true`:
  //     `effectiveKeywords` -> a Might-dependent grant -> `isMighty` -> the
  //     outgoing role -> back in.)
  //   - The MIGHTINESS claim is simply false: `isMighty` takes `.some()` over
  //     BOTH combat roles, so a penalty in one can never lower the maximum. It
  //     now has a dedicated test saying so.
  //
  // Kept rather than deleted because the correction is the useful part: a
  // refusal can name a real mechanism, reason carefully about it, and still reach
  // the wrong verdict — which is why these notes are leads, not rulings.
  // **UNL-028 Pyke - Dockside Butcher is deliberately NOT here.** The agent that
  // wrote him reported him as owed a row, and he would have been: his on-play
  // trigger reads `optionalPowerPaid`, which nothing could ever set. The blocker
  // was one `OPTIONAL_POWER_COSTS` row in `card-effects.ts` — a shared file the
  // agent could not touch — so the row went in with this wave instead and the
  // card is whole. Recorded because the alternative was a partial entry that
  // would have gone stale the same day.
  // **The four signature cards from wave 5, 2026-08-10.** All four report DONE on
  // their first clause, which is this map's whole reason to exist. UNL-191 is the
  // one to read twice: a `mightModifiers` aura and a deploy-time replacement are
  // different tables, so half a Legend is the natural failure here rather than an
  // unusual one.
  [
    "UNL-182",
    "the four modes work; its THREE [Repeat]s are not modelled — RepeatCostSpec expresses exactly one Repeat instance (its own comment says so), and 820.1.c.2 needs each payable individually with a per-EXECUTION mode re-choice, where modeId is currently chosen once per action",
  ],
  // **UNL-186 Death from Below LEFT this map on 2026-08-13**, and its note named
  // the price exactly: "a per-instance permission with a REPLACED cost needs
  // timing.ts plus a PlayerState field". Both landed — `engine/replaced-costs.ts`
  // for the cost (356.1.a), `PlayerState.replacedCostPlays` for the grant, and
  // `mayPlayFromTrash` split from `mayPlayFromTrashOnCharge` so a Spell can be
  // reached in the trash without the Units-only charge.
  // **UNL-190 Lilting Lullaby LEFT this map on 2026-08-13.** Its refusal named
  // the shape exactly: `cannotPlayCardsThisTurn` stops CARDS, which is wider
  // than printed, and a spells-only twin was needed.
  //
  // A separate field rather than a mode on the existing one, because a player
  // may be under BOTH bans — Brynhir Thundersong stops everything and this
  // stops one kind, and folding them together would make the wider ban
  // unreadable once the narrower was set.
  // Vex's missing clause is NARROWER than it reads, and the narrowing is the
  // reason this note says "rarely" rather than "never": a played unit arrives
  // exhausted, and an exhausted unit cannot move. The gap only bites once
  // something has readied it — `unitsEnterReadyThisTurn`, `[Accelerate]`, or an
  // "I enter ready" clause.
  // **UNL-150 Vex - Apathetic LEFT this map on 2026-08-13.** Her missing half
  // needed a per-UNIT movement lock, and the refusal was exact: nothing in
  // `validate-move-unit` was per-unit at all, and `UnitInstance.movesThisTurn`
  // is a COUNT rather than a lock.
  //
  // `GameState.movementLockedUnitInstanceIds` is that lock, swept by `runEnd`
  // like every other this-turn effect. It is deliberately NOT folded into the
  // Stun beside it: a Stun is about combat damage (423), and this is about the
  // MOVE action — a unit readied by something else is still locked, which is
  // the case that made exhaustion an insufficient stand-in.
  // **UNL-060 Vilemaw LEFT this map on 2026-08-12** — his silencing clause landed
  // as a `mightModifiers` entry, the very route the note above had rejected.
  //
  // **UNL-194 Shadow, written by HALVES in wave 7.** His activated ability works;
  // "if you play me to a battlefield, I enter ready" does not, and the blocker is
  // narrow and real: `deploy.unitEntersReady` is handed no destination at all, and
  // `playUnitToBattlefield` and `playUnitToBase` call it identically — so the
  // condition cannot even be asked without threading a parameter from both.
  // **UNL-194 Shadow LEFT this map on 2026-08-13.** His enter-ready clause was
  // blocked by a genuinely narrow thing: `deploy.unitEntersReady` was handed no
  // destination at all, and `playUnitToBattlefield` and `playUnitToBase` called
  // it identically — so "if you play me TO A BATTLEFIELD" could not be asked,
  // never mind answered. The parameter is threaded now.
  //
  // His clause lives in `destinationEntersReady` rather than beside the others
  // in `conditionalEntersReady`: those read the game, and this one cannot be
  // answered from the game at all — only from which deploy path is running.
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
  // **Asked of the CANONICAL printing**, for the same reason `implementingModules`
  // is — and this one is the direction that BITES. Kha'Zix - Voidreaver (UNL-201)
  // is written by halves and carries a row here; without this, his
  // `(Overnumbered)` and `(Signature)` prints found no row, reported WHOLE, and
  // would have been seated in generated decks as finished cards while two thirds
  // of one clause was missing.
  //
  // Caught by `printing-aliases.test.ts`'s partition assertion ("no printing
  // disagrees with its canonical print") within an hour of the row landing —
  // which is exactly what that test is for, since nothing else compares the two.
  const listed = PARTIALLY_IMPLEMENTED.get(canonicalDefId(def.id));
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
export const COMPLETE_SETS: readonly string[] = ["OGN", "OGS", "SFD"];

/**
 * Sets whose BATTLEFIELDS are all implemented — a separate list, and it has to
 * be.
 *
 * A set's battlefields finish on their own schedule: SFD prints 15 of them
 * against 198 cards needing code, and the last battlefield (Forge of the Fluft)
 * landed while 78 cards were still open. Gating them on `COMPLETE_SETS` would
 * mean either leaving 15 finished battlefields unprotected until the whole set
 * lands, or declaring the set complete while it is not — and the second turns
 * the CARD gate red for the wrong reason.
 *
 * So: one list per thing being gated. `test/battlefield-coverage.test.ts` reads
 * this one, and it starts protecting a set the moment it is added.
 */
export const COMPLETE_BATTLEFIELD_SETS: readonly string[] = ["OGN", "SFD"];

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
  // Canonical, like `partialImplementationNote` above — an alternate printing of
  // a half-written card is half-written.
  if (PARTIALLY_IMPLEMENTED.has(canonicalDefId(def.id))) return false;
  // An unimplemented keyword is the same kind of partial, derived rather than
  // listed. Fiora - Victorious is the case that needs it: her grant IS registered
  // (granted-keywords), and [Ganking] and [Shield] really do work, so the registry
  // check below says yes while the [Deflect] third of her text does nothing.
  if (unimplementedKeywordsOn(def).length > 0) return false;
  return registeredDefIds().has(def.id);
}
