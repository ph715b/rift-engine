import { describe, expect, it } from "vitest";
import {
  deathTriggerDefIds,
  eventTriggerDefIds,
  eventTriggerFor,
  selfTriggerDefIds,
} from "../src/engine/triggers.js";
import { unitTriggerDefIds } from "../src/engine/unit-triggers.js";
import { defaultCardRegistry } from "../src/cards/card-registry.js";
import {
  legendInlineTriggerDefIds,
  legendTriggerDefIds,
  legendTriggerKeysInUse,
} from "../src/engine/legend-abilities.js";

/**
 * **How many cards have a triggered ability, and how many of those still resolve
 * at their source instead of on the Chain?**
 *
 * `docs/rules-conformance.md` has carried "110 held / 3 inline" since 2026-08-04
 * with nothing recomputing it. `CLAUDE.md` names this exact figure as having been
 * **wrong four times, always by hand-copying one of the registries** — and the
 * 2026-08-07 audit of that table found the number undated and unverifiable, which
 * is how it earned a test.
 *
 * # It asks the SOURCE, and that is the whole design
 *
 * Every population here comes from the registry's own accessor
 * (`eventTriggerDefIds`, `unitTriggerDefIds`, …) and every classification comes
 * from the definition itself (`eventTriggerFor(id).on`). Nothing below restates a
 * list of cards, because a restated list is what was wrong all four times.
 *
 * The two censuses that follow are the guard on that: they assert the SHAPES in
 * use — the event kinds, the Legend hook keys — so a new one fails here and
 * forces a decision about which side of the held/inline line it falls on, rather
 * than being silently absorbed into a count.
 *
 * # Held vs inline reduces to one question
 *
 * `InlineEvent` is `Exclude<GameEvent, { kind: HeldEventKind }>`, and it is
 * `beginningPhase` alone — the compiler enforces that, not this file. So an event
 * trigger is inline exactly when it registers `beginningPhase`, and every other
 * trigger family (on-play, attack, on-move, self, Deathknell, death-watch) is
 * held outright. The Legend side is asked of `legend-abilities.ts`, whose
 * `onBeginningPhase` never reaches the held adapter at all.
 *
 * **`beginningPhase` stays inline deliberately**: holding it would resolve
 * Beginning-Phase abilities after `scoreHolds`, breaking an ordering
 * `runBeginning`'s own comment calls load-bearing.
 */

/** Event triggers that register the one inline kind. */
function inlineEventTriggerDefIds(): string[] {
  return eventTriggerDefIds().filter((defId) => {
    const on = eventTriggerFor(defId)?.on;
    const kinds = on === undefined ? [] : Array.isArray(on) ? on : [on];
    return kinds.includes("beginningPhase");
  });
}

/** Every key in any trigger registry — cards AND the synthetic granted-trigger
 *  keys below. Deduped: 27 cards are in two registries, so summing the five is
 *  one of the ways a hand count went wrong (239 raw against 212 distinct). */
function allTriggerKeys(): Set<string> {
  return new Set([
    ...eventTriggerDefIds(),
    ...unitTriggerDefIds(),
    ...deathTriggerDefIds(),
    ...selfTriggerDefIds(),
    ...legendTriggerDefIds(),
  ]);
}

/**
 * Keys that are not cards.
 *
 * `holdEventTrigger` matches `UnitInstance.grantedTriggersThisTurn` alongside
 * `card.defId`, so a GRANTED ability is registered under a synthetic key in the
 * same table — `SFD-184-conquer-home` is Relentless Pursuit's granted "move me to
 * my base". It is a real trigger and it is not a card, so counting it as one
 * inflates the census by exactly the number of granted abilities.
 *
 * **This was found by the census disagreeing with the card registry, not by
 * reading the code** — which is the argument for asking two sources and
 * comparing rather than trusting one.
 */
function syntheticKeys(known: ReadonlySet<string>): string[] {
  return [...allTriggerKeys()].filter((key) => !known.has(key)).sort();
}

/** Every CARD carrying a trigger of any family. */
function allTriggerCards(known: ReadonlySet<string>): Set<string> {
  return new Set([...allTriggerKeys()].filter((key) => known.has(key)));
}

const knownCardIds = new Set(defaultCardRegistry().all().map((def) => def.id));

describe("trigger census: held vs inline, recomputed from the registries", () => {
  it("finds the registries at all", () => {
    // Without this the censuses below would all pass on empty input — the `tried
    // > 0` rule, which exists because a check that never ran reports as a pass.
    expect(allTriggerCards(knownCardIds).size).toBeGreaterThan(100);
    expect(eventTriggerDefIds().length).toBeGreaterThan(10);
    expect(legendTriggerDefIds().length).toBeGreaterThan(0);
  });

  it("the registry keys that are NOT cards, by name", () => {
    // Granted abilities, registered under a synthetic key beside the real
    // defIds. Named rather than counted so a second one is a decision: it either
    // belongs in this list or something is registering a malformed id.
    //
    // **There are two KINDS of synthetic key now, and the difference matters to
    // anyone reading a census that counts cards:**
    //
    //   `SFD-184-conquer-home` is a GRANTED ability — one card's clause, handed
    //   to another unit for a turn. It inflates a card count by one if counted.
    //
    //   `KEYWORD-HUNT` is a KEYWORD's ability, and it deflates one instead: it
    //   is a single registry entry standing in for the 12 UNL cards that print
    //   `[Hunt N]`. Counting registry keys as cards would report those twelve as
    //   one, which is the opposite error and the reason this census asks the
    //   card registry rather than the trigger tables.
    //   `UNL-095-combat-xp` joined them on 2026-08-12 and is the GRANTED kind,
    //   exactly as SFD-184's is. Grim Resolve's "when it wins a combat this turn,
    //   gain 2 XP" is written onto the buffed UNIT via `grantTriggerThisTurn` and
    //   swept by `runEnd` — which is what makes "this turn" true. The card whose
    //   clause it is contributes nothing to the count above, and should not: the
    //   Spell itself carries no trigger.
    //   `TOKEN-SHADOW CLONE` is a THIRD kind, added 2026-08-17: a TOKEN's own
    //   printed ability. Like `KEYWORD-HUNT` it deflates a card count rather than
    //   inflating one — two printed cards create the token (VEN-023 Zed and
    //   VEN-144 Death Mark) and neither carries this trigger itself, so counting
    //   registry keys as cards would report the ability as a card that does not
    //   exist while the two that DO print it went uncounted.
    //
    //   It is registered in `engine/triggers.ts` rather than a domain file
    //   because a token has no `CardDefinition` and no domain, and
    //   `effect-registry.test.ts` refuses a non-card defId in a domain file. The
    //   Gold token's activated ability sits in the shared table for the same
    //   reason.
    expect(syntheticKeys(knownCardIds)).toEqual([
      "KEYWORD-HUNT",
      "SFD-184-conquer-home",
      "TOKEN-SHADOW CLONE",
      "UNL-095-combat-xp",
    ]);
  });

  it("the only event kind still resolved inline is beginningPhase", () => {
    // Asserted by NAME rather than by count. This is the structural claim the
    // whole census rests on, and the one the doc row states as "every kind but
    // one" — if a second inline kind ever appears, every number below changes
    // meaning and this says so first.
    const inlineCards = inlineEventTriggerDefIds();
    for (const defId of inlineCards) {
      const on = eventTriggerFor(defId)!.on;
      const kinds = Array.isArray(on) ? on : [on];
      expect(kinds).toEqual(["beginningPhase"]);
    }
  });

  it("the cards still resolving INLINE, by name", () => {
    // Named, not counted, because this is the actionable half: each of these is a
    // card whose ability an opponent cannot respond to. Two `beginningPhase`
    // event triggers (Dr. Mundo, Mushroom Pouch) plus Jinx's Legend hook.
    const inline = [...inlineEventTriggerDefIds(), ...legendInlineTriggerDefIds()].sort();
    // **Two UNL cards joined on 2026-08-09, and the invariant HELD.** The list
    // going from three to five is the thing this file warns about — "a new set
    // adding to it would be the ordering regression rather than a number to
    // update" — so it was checked before it was bumped: Sprite Queen and Gutter
    // Palace are both `beginningPhase` listeners, which is the ONE inline event
    // kind, and the test above asserting exactly that still passes. Inline means
    // no response window; a card printing anything else must not appear here.
    // **Two VEN cards joined on 2026-08-16, and the invariant HELD again.**
    // Forsaken Baccai (VEN-005) and Oasis Raider (VEN-006) print the same
    // sentence — "at the start of your Beginning Phase, if you control fewer
    // runes than an opponent, give me +Might" — so both are `beginningPhase`
    // listeners, the one inline kind, and the test above asserting exactly that
    // still passes.
    //
    // Checked before it was bumped, the way the UNL pair above were. A Vendetta
    // card printing any OTHER moment must not appear here: inline means no
    // response window, and it is a deliberate exception for a phase ability
    // rather than a licence.
    expect(inline).toEqual(["OGN-101", "OGN-109", "OGN-251", "UNL-084", "UNL-088", "VEN-005", "VEN-006"]);
  });

  it("348 held / 7 inline of 355 trigger cards", () => {
    const all = allTriggerCards(knownCardIds);
    const inline = new Set([...inlineEventTriggerDefIds(), ...legendInlineTriggerDefIds()]);
    const held = [...all].filter((defId) => !inline.has(defId));

    // **The figure this replaces was "110 held / 3 inline, 113 cards", and it
    // was measured before SFD finished.** SFD alone carries 96 trigger cards and
    // none of them were in it; OGN+OGS together are 116, which is where a number
    // near 113 came from. Nothing re-measured it when the set landed, which is
    // why it is a test now and not a sentence.
    //
    // A change here is a real change in how much of the pool is respondable, so
    // it should be a decision rather than a silent edit. If this fails because a
    // card was ADDED, update these numbers and the doc row in the same change —
    // that is the thing this test exists to make impossible to forget.
    // **208/3/211 → 231/3/234 on 2026-08-08**, when the first wave of Unleashed
    // card work landed: 23 more cards carrying a trigger, every one of them held.
    //
    // **285/5/290 → 286/5/291 on 2026-08-10**, and the +1 is UNL-058 Lillia -
    // Protector of Dreams, whose "when you play a token unit" had been refused
    // twice for want of an event `placeToken` never fired. She is the pool's
    // only POSITIVE reader of `cardPlayed.isToken`; the three card-reading
    // listeners are all negative on it.
    //
    // **312 → 315 cards on 2026-08-13**, +3 held, from ONE registration — and the
    // factor of three is the interesting part rather than a surprise.
    //
    // Vex - Gloomist is a LEGEND, and every UNL Legend is printed three times
    // (plain, (Overnumbered), (Signature)). `mergeRegistries` expands an alias
    // after merging, so registering `UNL-193` registers `UNL-232` and `UNL-232*`
    // with it — and this census counts CARDS, so all three are counted. That is
    // the printing-alias machinery behaving, and the same +3 will appear for every
    // Legend finished from here.
    //
    // Shadow (UNL-194) landed the same day and contributes NOTHING here: his
    // enter-ready clause is a `deploy` predicate, not a trigger.
    //
    // **311 → 312 cards on 2026-08-13 (wave 8b)**, +1 held, and it is UNL-005
    // Revna the Lorekeeper — a `spellCast` listener whose condition is the ENERGY
    // actually spent, which needed a new field on the chain entry and the event.
    // The wave's other finished cards contribute nothing here: Katarina was
    // already counted (her `on` widened to include `cardHidden` rather than adding
    // a card), and Tricksy Tentacles is a card EFFECT, not a trigger.
    //
    // Measured by the agent deleting its own entry and re-running — the census
    // went green at 306/5/311 — rather than inferred from the diff.
    //
    // **316 → 317 cards on 2026-08-13**, +1 held, and this one IS a trigger:
    // UNL-074 Frigid Jewel, on a new `cardDrawn` event. She is the pool's first
    // listener on drawing at all — the event had no producer before, and
    // `drawCards` is the single funnel every draw in the engine goes through,
    // including the Draw Phase's.
    //
    // Contrast the entry immediately below, which moved this number for a card
    // carrying no trigger whatever. Both are correct; the census counts what
    // these registries CLAIM, not what triggers.
    //
    // **315 → 316 cards on 2026-08-13**, +1 held, and it is UNL-117 Arachnoid
    // Horror — who carries NO trigger at all.
    //
    // He is here because `unitTriggerDefIds` deliberately includes
    // `PLACEMENT_GRANTS` alongside the three dispatch tables, so a card whose
    // whole contribution is "I may be played to a battlefield of this shape"
    // counts as a trigger CARD for this census even though nothing about it
    // triggers. That is worth stating rather than quietly bumping: the number
    // measures "cards this file's registries claim", and a reader who takes it
    // as "cards with a triggered ability" will be off by however many placement
    // grants exist.
    //
    // **321 → 324 cards on 2026-08-14**, +3 held, from ONE registration — and the
    // factor of three is the printing-alias machinery again, exactly as Vex -
    // Gloomist's entry above predicted it would be for "every Legend finished from
    // here". UNL-195 Ivern - Green Father is a Legend, so registering him
    // registers UNL-233 and UNL-233* with him.
    //
    // He is the LAST card of Unleashed, and the set is declared complete in the
    // same change.
    //
    // Re-derived by running the test and reading the actual figures, not by
    // adding one to the old ones — CLAUDE.md records this census being wrong
    // four times, every time from hand-copying.
    //
    // **310 → 311 cards on 2026-08-12 (wave 8)**, +1 held, and it is UNL-073
    // Deadly Flourish — a `deathWatchTriggers` entry that fires from the CASTER'S
    // TRASH. A Spell is trashed at play time, so by the moment its victim dies the
    // card is already there; `TRASH_LISTENER_DEF_IDS` is what lets the walk find
    // it, and a wave-3 note had recorded that route as closed without checking.
    //
    // The wave's other finished card, UNL-201 Kha'Zix, contributes nothing here:
    // his third clause is an activated-ability MODE, not a trigger.
    //
    // **308 → 310 cards on 2026-08-12 (wave 7)**, +2 held, and the split is the
    // usual one: six agents finished or half-finished eight cards, and only two of
    // them register a TRIGGER. UNL-086 Zilean - Time Mage (a `cardPlayed` listener
    // for the token-doubling replacement) and UNL-188 Hextech Gauntlets (a
    // `battlefieldConquered` listener on the wearer) are the two.
    //
    // The other six moved coverage without touching this census: Baron Nashor's
    // aura and Vilemaw's silencing are `mightModifiers`, Shadow's stun is an
    // `activatedAbilities` entry, Void Assault and Dancing Grenade are card
    // effects, and Grim Resolve's delayed XP rides a GRANTED key rather than a
    // card — it appears in `syntheticKeys` below, not in this count.
    //
    // **307 → 308 cards on 2026-08-12**, +1 held, and it is UNL-166 Stalking
    // Wolf. He registers a unit trigger for one job only — paying his additional
    // cost by killing the pet named on the action — the same shape Cruel Patron
    // has carried since OGN. His other two clauses register nothing here:
    // `[Ambush]` is timing, and his placement waiver is a PLACEMENT_GRANTS row.
    //
    // Sacrifice (UNL-173) landed in the same change and does NOT appear, which is
    // the contrast this file keeps making: it is a Spell, so its kill is a card
    // effect rather than a trigger. Two cards finished, the census moves by one.
    //
    // **306 → 307 cards on 2026-08-11**, and this one is fully attributable —
    // unlike the wave above it, which is worth the contrast.
    //
    // FOUR cards were finished that day, each by a single shared-table row a
    // wave-6 agent had located precisely: UNL-041 Allay (a KEYWORD_AURAS row),
    // UNL-120 Rengar - Trophy Hunter (PLACEMENT_GRANTS), UNL-151 Bandle Soldier
    // (a `conditionalEntersReady` case) and UNL-142 Heedless Resurrection
    // (OPTIONAL_UNIT_COSTS). Only ONE of the four registers a trigger — Rengar's
    // placement grant rides `unit-triggers` — so the census moves by exactly +1
    // while the implemented count moves by 4.
    //
    // That gap is the useful thing to notice: this census counts TRIGGER cards,
    // not finished ones, and three of those four are finished without appearing
    // here at all.
    //
    // **291 → 306 cards on 2026-08-10**, wave 6 plus two integrator fixes.
    // Fifteen more trigger cards, all held; the inline count did not move.
    //
    // **Attribution is INCOMPLETE, and that is stated rather than papered over.**
    // Four of the seven agents measured their own share by swapping in `git show
    // HEAD`'s copy of their file and re-running: **+1 Calm** (UNL-050 Iascylla),
    // **+1 Chaos** (UNL-148's self trigger), **+1 signature-mind** (UNL-199) and
    // **+2 signature-body** (UNL-201, UNL-203). The remaining +10 were decomposed
    // by nobody: seven files moved at once and each agent could see only its own.
    //
    // That is a weaker basis than the previous four waves, whose per-agent shares
    // summed exactly to the total. Recorded as a known gap rather than dressed up.
    // If this figure is ever disputed, settle it with a per-file `git stash` and
    // re-run — what the earlier waves did, and what a smaller fan-out makes cheap.
    //
    // **A large part of the rise is NOT new cards.** The printing-alias pass makes
    // every alternate print inherit its twin's registry entry, so one Legend with
    // a trigger now contributes three census rows — its plain, `(Overnumbered)`
    // and `(Signature)` ids. That is correct: each is a distinct defId a listener
    // walk can reach, and before the alias two of the three were inert.
    //
    // **276/5/281 → 285/5/290 on 2026-08-10**, wave 5: nine more trigger cards,
    // every one of them held, and the inline count did not move.
    //
    // Attribution, summed from what each agent measured rather than inferred from
    // the total: **+2 Fury** (UNL-029 Red Brambleback's conquer, UNL-028 Pyke's
    // on-play), **+2 Calm** (UNL-056 Yuumi, UNL-060 Vilemaw), **+1 Mind**
    // (UNL-081 Keeper of Masks), **+2 Chaos** (UNL-149 Diana, UNL-150 Vex) and
    // **+2 signature** (UNL-183 Rengar, UNL-187 Vi). They sum to exactly the +9
    // the registries report.
    //
    // Two of the five measured their own share the stronger way this file asked
    // for last wave — by reverting their own domain file and re-running the census
    // against `HEAD` — rather than by counting their registrations. That is now
    // the method to ask for, and it is what makes this arithmetic.
    //
    // **The Rengar and Vi entries are the first LEGEND abilities in the census.**
    // Worth knowing before the next wave: no seam had to be built for them.
    // `listeningPermanents` already ends with `owner.legend` and `Listener.zone`
    // already carries `"legend"`, so a Legend's triggered ability has always been
    // registrable from a domain file and nobody had tried.
    //
    // **261/3/264 → 276/5/281 on 2026-08-09**, wave 4: seventeen more trigger
    // cards. TWO of them are INLINE, which is the first time that number has
    // moved — see the note on the inline list above for why it is legitimate
    // here and would not be for any other event kind.
    //
    // Recomputed, not incremented, on the same rule as before: each agent
    // reported only its own share and none was permitted to bump the pin.
    //
    // **245/3/248 → 261/3/264 on 2026-08-09**, wave 3: sixteen more, again all
    // held. Recomputed on the same rule as wave 2 — each of the six agents
    // reported only its own share (+2 Fury, +2 Calm, +3 Body, +2 Chaos, +3 Order,
    // +4 Mind) and none was permitted to bump the pin. They sum to exactly the +16
    // the registries report, which is what makes this arithmetic rather than a
    // number typed to make a test pass. Two agents measured their share by
    // reverting their own file and re-running, which is the stronger method and
    // the one to ask for next time.
    //
    // **231/3/234 → 245/3/248 on 2026-08-09**, wave 2: fourteen more trigger
    // cards, again every one held. RECOMPUTED, not incremented — six agents wrote
    // to six domain files at once and none could see the others, so each measured
    // only its own share (+2 Fury, +2 Calm, +2 Mind, +4 Chaos, +4 Order; Body
    // added none). Five separate self-measurements summing to exactly the +14 the
    // registries report is the cross-check that this is arithmetic rather than a
    // number typed to make a test pass — which is the failure this file exists to
    // prevent, and the reason none of the six was permitted to bump it.
    //
    // **312/5/317 → 313/5/318 on 2026-08-14**, one card: UNL-169 Ashe - Focused's
    // on-play trigger. Her card has TWO abilities and only this one is counted
    // here, which is correct rather than an undercount — the second is a DELAYED
    // ability with no listener and no registry entry (`source: "delayed"`, armed
    // on `PlayerState.banishedUntilHold`), so there is nothing keyed by defId for
    // this census to walk. It is still HELD on the chain; it is simply not a
    // registered trigger card.
    //
    // Worth stating because the next delayed ability will move the two numbers
    // apart again, and a census that silently missed a chain item would be the
    // instrument defect this file exists to prevent.
    //
    // **313/5/318 → 316/5/321 the same day, and it is ONE card: UNL-181 Jhin -
    // Virtuoso.** The other two are UNL-226 and UNL-226*, his Overnumbered and
    // Signature printings, which `printingAliases` maps onto his defId — so a
    // single registry entry legitimately becomes three keys here.
    //
    // Recorded because +3 for one card looks exactly like a miscount, and the
    // first reading of it was that something had gone wrong. It was diagnosed by
    // diffing `eventTriggerDefIds()` against the previous sha rather than by
    // reasoning about it, which is the same method the reachability probe's notes
    // insist on. **Any future Legend or reprinted card will move this by more
    // than one for the same reason.**
    //
    // **319/5/324 → 320/5/325 on 2026-08-16, when Vendetta's JSON landed, and
    // the +1 is NOT a Vendetta card.** No VEN card has an implementation yet, so
    // a set of 178 definitions moved this by one — which looks exactly like the
    // miscount this file exists to prevent, and was diagnosed by FAMILY rather
    // than by reasoning about it, the method the Jhin note above insists on:
    //
    //     event 192 VEN=0   death 31 VEN=0   legend 15 VEN=0
    //     unit  120 VEN=1 -> VEN-168, canonical OGN-030
    //
    // `VEN-168 Jinx, Demolitionist (Overnumbered)` is a printing of `OGN-030
    // Jinx - Demolitionist`, so it inherits his on-play trigger through
    // `printingAliases` and legitimately becomes a second key for one registry
    // entry — the same shape as Jhin's +3 above, across sets this time.
    //
    // It only counts at all because `printingBaseName` now normalises the title
    // SEPARATOR: Vendetta prints `Character, Title` where the first four print
    // `Character - Title`, so without that the two base names differ, no
    // canonical twin is found, and the printing ships with no implementation.
    // **A reprint that silently loses its alias would move this number DOWN, and
    // that is the regression to watch for here.**
    //
    // `inline` did not move and must not — it is `beginningPhase` alone, three
    // OGN cards, and a new set adding to it would be the ordering regression the
    // note above describes rather than a number to update.
    // **320/5/325 → 322/5/327 on 2026-08-16: two cards, and both are real.**
    // VEN-046 Nasus, Ascended ("when I conquer, you score 1 point") and VEN-057
    // Covert Informant ("when I move, draw 1"), the first two `[Empowered][>]`
    // clauses whose payload is a TRIGGER rather than the static Might/keyword
    // grant `parseEmpoweredGrant` reads.
    //
    // **VEN-130 Aurok General landed in the same change and is correctly NOT
    // here**: his clause is an AURA, so it lives in `effective-might.ts` and this
    // census has nothing to count. Worth stating, because "three cards, +2" looks
    // like a miscount and is the shape this file's own notes keep warning about.
    // **322/5/327 → 323/5/328, one card: VEN-128 Noxian Emissary's Deathknell**
    // — the first `[Empowered][>]` clause whose payload is a DEATH trigger, and
    // the third dependent-ability shape after Nasus's conquer and the Informant's
    // move.
    //
    // VEN-055 Applied Researchers landed in the same stretch and is correctly NOT
    // here: his clause is a COST MODIFIER, so it lives in `cost-modifiers.ts` and
    // this census has nothing to count for him. Same reason Aurok General is
    // absent one note up. Two cards, +1, and both halves of that are right.
    // **323/5/328 → 324/5/329, one card: VEN-079 Dame the Despoiler's
    // attack-or-defend trigger** — the fourth `[Empowered][>]` payload shape to
    // land, after a conquer, a move and a Deathknell.
    //
    // **324/5/329 → 331/5/336 on 2026-08-16, and NOT ONE of the seven is a new
    // implementation.** `printingAliases` stopped requiring a printing to carry
    // `(Overnumbered)`/`(Signature)`/`(Ultimate)` in its NAME, which is what
    // Vendetta's ten plain-name reprints of earlier cards needed; seven of the
    // ten have a trigger, so seven registry entries each legitimately gained a
    // second key. Exactly the shape of Jhin's +3 and Jinx's +1 above, at scale.
    //
    // The stale `it(...)` title said 319 while this asserted 324 — five apart,
    // and nobody could have noticed, since only the assertion runs. Corrected in
    // the same change; if the two ever disagree again, the ASSERTION is the one
    // that has been recomputed.
    //
    // Diagnosed by FAMILY and by NAME rather than by reasoning about the total,
    // the method every note above insists on:
    //
    //     event  200  VEN-176 VEN-180 VEN-sp2 VEN-sp3 VEN-sp4
    //     unit   123  VEN-175 VEN-sp4 VEN-sp5
    //     death   32  -    self 12  -    legend 15  -
    //     distinct: 7 (VEN-sp4 is in two registries and counts once)
    //
    // The other three reprints are correctly absent: VEN-167 (Vi, Destructive)
    // and VEN-sp6 (Lux, Crownguard) are ACTIVATED abilities and VEN-179 (Rengar,
    // Trophy Hunter) is not a trigger card either — ten aliases, seven cards, and
    // both halves of that are right.
    //
    // **331/5/336 → 337/7/344 on 2026-08-16: Vendetta's first Fury wave, eight
    // trigger cards out of fourteen implemented, and the split is the check.**
    // Recomputed by family and by name rather than transcribed:
    //
    //     inline (+2)  VEN-005 Forsaken Baccai, VEN-006 Oasis Raider
    //                  — both `beginningPhase`, both named in the inline test above
    //     held   (+6)  VEN-009 Baccai Reaper, VEN-019 Renekton, VEN-020 Twilight
    //                  Reveler (combatBegan); VEN-016 Eclipse Dragon, VEN-002
    //                  Blade Twirler (unitMoved); VEN-017 Morgana (on-play)
    //
    // **`inline` moved for the first time since UNL, and that IS the ordering
    // regression this file warns about unless it is checked — so it was.** Both
    // additions print "at the start of your Beginning Phase", which is the one
    // event kind `InlineEvent` admits; the compiler enforces the kind and the
    // by-name test above enforces the membership.
    //
    // The other six cards in the same wave are correctly absent: VEN-003 Brittle
    // Steel, VEN-008 Ruthless Strike, VEN-010 Consuming Curse and VEN-012 Perfect
    // Execution are SPELL effects, which are not triggers at all, and VEN-013
    // Shadow Assassin is a deploy-time replacement in `deploy.ts`. Fourteen cards,
    // +8, and every one of the six absences is a card that has no trigger to
    // count rather than one that was missed.
    //
    // **337/7/344 -> 341/7/348 on 2026-08-17: Vendetta's Order wave, four trigger
    // cards out of twelve implemented.** Recomputed by family and by name:
    //
    //     event (+3)  VEN-121 Reluctant Leader (cardPlayed), VEN-135 Kennen
    //                 (combatBegan), VEN-138 Shen (battlefieldHeld)
    //     unit  (+2)  VEN-120 Masa, VEN-135 Kennen (on-play)
    //     distinct: 4 — Kennen is in BOTH registries and counts once
    //
    // `inline` did not move and should not have: nothing in this wave reads the
    // Beginning Phase.
    //
    // The other eight cards in the wave are correctly absent, and between them
    // they name six different homes — which is the point worth keeping, because
    // "twelve cards, +4" reads like a miscount otherwise. VEN-116 Dragon Form,
    // VEN-126 Ki Barrier, VEN-127 Lacerate and VEN-131 Decree of Unity are SPELL
    // effects; VEN-117 Disciple of Shen is a `DYNAMIC_KEYWORD_VALUES` grant;
    // VEN-119 Keeper of Law is a cost modifier; VEN-125 Hungry Wolf is an
    // ACTIVATED ability, which this census does not count; and VEN-129 Sacred
    // Protector is a continuous rule inside `combat.outgoingMight`.
    //
    // **341/7/350 -> 343/7/350 on 2026-08-17: Vendetta's Fury remainder, and the
    // +2 is ONE card.** VEN-023 Zed, From the Shadows gets a `unitTriggers` entry,
    // and `VEN-169` — his `(Overnumbered)` print — inherits it through
    // `printingAliases`, so one registry entry legitimately becomes two keys.
    // Jhin's +3 and Jinx's +1 are the same shape; this file's own note says to
    // expect it from any reprinted card.
    //
    // **The Shadow Clone's ability is NOT in this count**, and that is the
    // synthetic-key test above doing its job: `TOKEN-SHADOW CLONE` is a registry
    // key that is not a card, so it is excluded here and named there.
    //
    // VEN-004 Dune Surfer is correctly absent too — his ignore is a continuous
    // rule inside `combat.assignmentOrder`, not a trigger.
    //
    // **343/7/350 -> 348/7/355 on 2026-08-17: Vendetta's Body wave, five trigger
    // cards out of twelve implemented.** By family and by name:
    //
    //     event (+4)  VEN-071 Fretful Feline, VEN-088 Jayce Hammer in Hand
    //                 (both `unitReadied`); VEN-080 Noxian Demolitionist
    //                 (battlefieldConquered); VEN-091 Corrupted Dragon (combatBegan)
    //     unit  (+1)  VEN-082 Profiteer
    //
    // `unitReadied` gains its first CARD listeners here — the event has existed
    // since Pirate's Haven read it, so "becoming ready" already had one
    // definition and these two could not disagree with it.
    //
    // The other seven are correctly absent, across four different homes: VEN-072,
    // VEN-081, VEN-083, VEN-085, VEN-089 and VEN-090 are SPELL effects; VEN-076
    // Repair Specialist is a `DYNAMIC_KEYWORD_VALUES` grant. Corrupted Dragon is
    // counted ONCE despite also being a `conditionalEntersReady` case in
    // deploy.ts, which is right — this census counts trigger cards, not clauses.
    expect({ held: held.length, inline: inline.size, cards: all.size }).toEqual({
      held: 348,
      inline: 7,
      cards: 355,
    });
  });

  it("the Legend hook keys in use, so a new one forces a decision", () => {
    // `legendTriggerDefIds` treats any unrecognised key as a TRIGGER, so a new
    // hook is counted the day it is written. The risk runs the other way: a new
    // CONTINUOUS entry would be miscounted as a trigger until it is named in
    // `NON_TRIGGER_KEYS`. This census is what catches that.
    expect(legendTriggerKeysInUse()).toEqual([
      "conquerCondition",
      "mightBonus",
      "onBattlefieldHeld",
      "onBeginningPhase",
      "onCombatWon",
      "onConquer",
      "onEndOfTurn",
      "onEnemyUnitAttacks",
      "onEnemyUnitDied",
      "onRunesRecycled",
      "onSpellCast",
      "onUnitBecameMighty",
      "onUnitChosen",
      "onUnitPlayed",
      "onUnitsStunned",
    ]);
  });

  it("a Legend with only a continuous mightBonus is not a trigger card", () => {
    // OGS-019 Master Yi. Counting `LEGEND_ABILITIES`' keys reports him as a
    // Legend trigger and gives the wrong answer to "how many cards are held" —
    // the mistake docs/rules-conformance.md records against its own earlier
    // figures ("9 is the size of LEGEND_ABILITIES, which includes Master Yi").
    expect(legendTriggerDefIds()).not.toContain("OGS-019");
    expect(allTriggerCards(knownCardIds).has("OGS-019")).toBe(false);
  });
});
