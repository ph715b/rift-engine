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
import { battlefieldAbilityDefIds, beginningPhaseBattlefieldDefIds } from "./battlefield-abilities.js";
import { continuousBattlefieldDefIds, moveRestrictionDefIds } from "./battlefield-continuous.js";
import { chooseRestrictionDefIds } from "./target-lookup.js";
import { accelerateGrantDefIds, playRestrictionDefIds } from "./timing.js";

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
  [
    "UNL-016",
    "half written: the [Level 3] +1 Might works; 'and enter ready' is unwritten — needs a case in deploy.conditionalEntersReady",
  ],
  [
    "UNL-017",
    "half written: the [Assault 4] works; its [Repeat] — Discard 1 is inert — RepeatCostSpec carries energy/power/rainbow only, so this is the pool's first NON-RESOURCE repeat cost and no table row can fix it",
  ],
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
  [
    "UNL-168",
    "half written: the free play works; its '-[2] if you choose a Bird/Cat/Dog/Poro' discount is unwritten, so it always costs the printed 2 Energy + 1 rainbow",
  ],
  [
    "UNL-170",
    "half written: the combat-began kill works; its kill-a-friendly cost and the scaled discount that cost buys are unwritten, so it always costs 10 Energy + 3 Order",
  ],
  [
    "UNL-188",
    "art-only: its conquer-with-3-excess-damage draw is unwritten (only the [Equip] cost and +3 badge work)",
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
  [
    "UNL-073",
    "half written: the 3 damage works; 'when it dies this turn, play a Gold gear token exhausted' is unwritten — a delayed trigger must outlive its subject, and the victim leaves the board before completeDeath fires unitDied",
  ],
  [
    "UNL-087",
    "half written: the [Add] rainbow on hold works; 'your hold effects for holding here trigger an additional time' is unwritten — holdEventTrigger has no `times` multiplier and the doubling would also have to reach holdBattlefieldTrigger",
  ],
  [
    "UNL-118",
    "half written: the on-play 'up to one enemy unit at each location, deal 1' works; 'Any amount of your damage is enough to kill enemy units' is unwritten — 142.4.c needs per-marker damage (UnitInstance.damage is one unattributed number) and a Lethal Damage override",
  ],
  [
    "UNL-144",
    "half written: the [Chaos] move ability works; 'I can't be readied' is unwritten — runAwaken readies by an inline map and readyUnit's only lock is per-player, so he readies every Awaken and is STRONGER than printed",
  ],
  [
    "UNL-095",
    "half written: the +3 Might works; 'when it wins a combat this turn, gain 2 XP' is unwritten — a resolved Spell sits in its caster's trash and reaches no listener walk",
  ],
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
  [
    "UNL-023",
    "only the second clause is written — 'when you hide a card, ready me' is unimplemented",
  ],
  // **Wave 5, 2026-08-10.** One card, and its shape is worth reading because the
  // refusal behind it was argued rather than assumed. Vilemaw prints three
  // clauses; the hold-draw is written, `[Ambush]` is the loader's, and the third
  // is a conditional aura over the OPPONENT's units.
  //
  // `combat.ts`'s `DEALS_NO_COMBAT_DAMAGE_DEF_IDS` is keyed by the defId of the
  // unit that is silenced, which fits Ezreal - Dashing (who silences himself) and
  // cannot express "enemy units HERE with less Might than me". The agent also
  // considered and REJECTED routing it through `mightModifiers` as an
  // outgoing-Might floor, on two grounds worth keeping: it recurses (the enemy's
  // own Might is the input to the comparison that would modify it) and it would
  // strip Mightiness through `isMighty`'s outgoing branch. Both are right.
  // **UNL-028 Pyke - Dockside Butcher is deliberately NOT here.** The agent that
  // wrote him reported him as owed a row, and he would have been: his on-play
  // trigger reads `optionalPowerPaid`, which nothing could ever set. The blocker
  // was one `OPTIONAL_POWER_COSTS` row in `card-effects.ts` — a shared file the
  // agent could not touch — so the row went in with this wave instead and the
  // card is whole. Recorded because the alternative was a partial entry that
  // would have gone stale the same day.
  [
    "UNL-029",
    "half written: 'when I conquer, [Buff] a friendly unit' works; 'your conquer effects for conquering here trigger an additional time' is unwritten — holdEventTrigger has no `times` multiplier and the doubling must also reach holdBattlefieldTrigger, since a battlefield's own 'when you conquer here' is one too",
  ],
  // **The four signature cards from wave 5, 2026-08-10.** All four report DONE on
  // their first clause, which is this map's whole reason to exist. UNL-191 is the
  // one to read twice: a `mightModifiers` aura and a deploy-time replacement are
  // different tables, so half a Legend is the natural failure here rather than an
  // unusual one.
  [
    "UNL-182",
    "the four modes work; its THREE [Repeat]s are not modelled — RepeatCostSpec expresses exactly one Repeat instance (its own comment says so), and 820.1.c.2 needs each payable individually with a per-EXECUTION mode re-choice, where modeId is currently chosen once per action",
  ],
  [
    "UNL-186",
    "half written: the kill works; 'play this from your trash for [rainbow]' is unwritten — timing.mayPlayFromTrash is per-player, Units-only, and charges the printed price, so a per-instance permission with a REPLACED cost needs timing.ts plus a PlayerState field",
  ],
  [
    "UNL-190",
    "half written: the counter works; 'its controller can't play spells this turn' is unwritten — PlayerState.cannotPlayCardsThisTurn stops CARDS, which is wider than printed, and a spells-only twin needs game-state.ts, board-restrictions.ts, player-setup.ts and turn-manager.ts",
  ],
  [
    "UNL-191",
    "half written: the [Level 6] +1 Might aura works; [Level 11] 'your units enter ready' is unwritten — only deploy.unitEntersReady answers it, and deploy.ts's own comment rules out faking it as an on-play readyUnit (a held trigger leaves the unit exhausted through the response window, fires unitReadied, and is blockable by Mageseeker Warden)",
  ],
  // Vex's missing clause is NARROWER than it reads, and the narrowing is the
  // reason this note says "rarely" rather than "never": a played unit arrives
  // exhausted, and an exhausted unit cannot move. The gap only bites once
  // something has readied it — `unitsEnterReadyThisTurn`, `[Accelerate]`, or an
  // "I enter ready" clause.
  [
    "UNL-150",
    "half written: the [Stun] works; 'they can't move it this turn' is unwritten — no per-unit movement lock exists, so a unit readied after arriving can still be moved",
  ],
  [
    "UNL-060",
    "one of three clauses: 'when I hold, draw 1' works and [Ambush] is the loader's; 'enemy units here with less Might than me don't deal combat damage' is unwritten — DEALS_NO_COMBAT_DAMAGE_DEF_IDS is keyed by the silenced unit's own defId and cannot express a conditional aura over enemies",
  ],
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
  if (PARTIALLY_IMPLEMENTED.has(def.id)) return false;
  // An unimplemented keyword is the same kind of partial, derived rather than
  // listed. Fiora - Victorious is the case that needs it: her grant IS registered
  // (granted-keywords), and [Ganking] and [Shield] really do work, so the registry
  // check below says yes while the [Deflect] third of her text does nothing.
  if (unimplementedKeywordsOn(def).length > 0) return false;
  return registeredDefIds().has(def.id);
}
