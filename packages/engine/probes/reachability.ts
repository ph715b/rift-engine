/**
 * **Of the whole card pool, how much has EVER been observed doing something in a
 * game?** One run, one number, every set.
 *
 *     npm run build --workspace=@rift-engine/engine
 *     node packages/engine/probes/reachability.ts
 *
 * # Why this exists beside `exercised.ts`
 *
 * `exercised.ts` measures ONE deck set per invocation, and the loop only ever ran
 * two of its four modes. So the pool-wide question had no answer anybody could
 * read, and the answer it did report was misleading in a specific direction:
 *
 *  - All seven preset decks are OGN/OGS, so the default run reports **SFD 0%** and
 *    always will. 198 cards shipped in one month had never been in a game unless
 *    somebody typed `DECKS=sfd`.
 *  - `DECKS=ogn` and `DECKS=ogs` both worked and neither was in the loop.
 *  - Nothing reported the UNION, and the union is the actual question. A card
 *    exercised by the OGS covering run is exercised, whatever the SFD run saw.
 *
 * Measured the day this was written: the four runs together exercise far more
 * than any one of them, and what is LEFT is the list this probe exists to print.
 * A count is not actionable, so every card is named — the same rule every gate in
 * this repo already follows.
 *
 * # The reasons a card is on that list are not interchangeable
 *
 * | bucket | meaning | is it a defect? |
 * |---|---|---|
 * | `offeredNeverTaken` | the engine offered it, the AI declined every time | **usually not** — a 1-ply evaluator cannot price a deferred or informational effect |
 * | `drawnNeverOffered` | it reached a hand and `legalActions` never enumerated it | **the real leads** |
 * | `startsInPlayNeverActed` | a Legend or champion: on the board from turn 1, never drawn, never offered | only its trigger/activation can show it — read the card |
 * | `seatedNeverDrawn` | in a deck, never reached a hand in these games | no — sampling |
 * | `neverSeated` | no run could put it in front of a player at all | a deck/pool problem, not an engine one |
 *
 * **The middle three used to be one bucket, and it hid the only actionable one.**
 * A game draws about 10 of a 39-card deck, so a card that never reached a hand
 * could not possibly have been offered — OGS-011 Flash sat in a deck for 10 games,
 * was never drawn once, and read convincingly as an enumeration bug. The README
 * has carried that warning for months as something a reader had to remember;
 * `log.drawn` measures it instead.
 *
 * # What is gated, and what deliberately is not
 *
 * Not gated: any coverage percentage. Any threshold would be a number picked to
 * pass, and this figure is supposed to RISE as the never-exercised list is worked
 * down.
 *
 * Gated:
 *  - **`invalid: 0` in every run** — the offered-then-refused detector.
 *  - Every per-run instrument control (`exercise-run.runControls`).
 *  - **The union is strictly larger than the biggest single run.** The positive
 *    control on the merge itself: if this probe accidentally reported one run's
 *    log as the union, every other number here would still look reasonable.
 *  - **Something is still unexercised** — the negative control, without which an
 *    observer that simply marked every card would report a triumphant 494/494.
 *  - **The union has not gone DOWN** (`PINNED_UNION`), which is the regression
 *    this whole instrument is for.
 *  - **No stale allowlist entry**, i.e. nothing excused that is now exercised.
 *  - **Every set with cards needing code has a run that can reach it.** This is
 *    the SFD-0% failure, generalised: a set arrives, no mode reaches it, and the
 *    report stays cheerfully green about a set nobody has ever played.
 */
import { COMPLETE_SETS, defaultCardRegistry, setCodeOf } from "@rift-engine/engine";
import { report } from "./harness.ts";
import { poolFacts } from "./pool-facts.ts";
import { PRESETS, runControls, runExercise, type ExerciseRun } from "./exercise-run.ts";
import { UNEXERCISED_ALLOWLIST } from "./unexercised-allowlist.ts";

/**
 * **250, not 40, and the difference is the whole point of this instrument.**
 *
 * Measured 2026-08-07, union of cards needing code ever exercised:
 *
 * | games/mode | exercised | never | `drawnNeverOffered` | wall clock |
 * |---|---|---|---|---|
 * | 40 | 367 | 101 | 8 | 10s |
 * | 100 | 417 | 51 | 4 | 25s |
 * | **250** | **429** | **39** | **1** | **60s** |
 * | 500 | 435 | 33 | 0 | 120s |
 *
 * At 40 games the never-exercised list is dominated by SAMPLING, not by defects:
 * 7 of its 8 "the engine never offered this" leads were offered freely once the
 * games were deep enough (Punch First 59 times, Blood Money 71). A gate that
 * names 101 cards of which ~60 are noise manufactures exactly the fake backlog of
 * broken-cards-that-are-not-broken this probe's own header warns about.
 *
 * 250 buys the honest list for a minute. Use `GAMES=40` for a quick regression
 * check and `GAMES=500` when working the list down — but do not read the buckets
 * from a shallow run.
 */
/**
 * **250 -> 500 on 2026-08-11, and this was decided in advance rather than in the
 * moment.**
 *
 * The pin dropped by one on three separate changes, every time for the same
 * structural reason: `deck-generator` seats on `isCardImplemented`, so finishing
 * a card ADDS it to a fixed-size covering deck and DISPLACES another, and at 250
 * games the displaced card sometimes falls below the sampling floor. Each drop
 * decomposed cleanly and each time `GAMES=500` showed an EMPTY
 * `drawnNeverOffered` — four measurements running.
 *
 * CLAUDE.md recorded the rule after the second: "if it drops a third time,
 * re-base the pin at GAMES=500 and accept the 120s, rather than keep explaining a
 * number whose noise floor has grown to the size of the signal." It dropped a
 * third time, so this is that.
 *
 * The table above still describes the trade-off and is still true. What changed
 * is which column the GATE reads: a figure that needs a paragraph of explanation
 * every time it moves is not a regression detector, it is a chore.
 */
const GAMES = Number(process.env.GAMES ?? 500);

/**
 * The recorded union, as `walkout` pins 191/107/32.
 *
 * It is a FLOOR, not an equality: the whole point of Phase 1b is to raise it, and
 * a gate that failed on an improvement would just get edited away. Going UP prints
 * a line asking for the pin to be bumped; going DOWN is red.
 *
 * Measured 2026-08-07 at the DEFAULT 250 games per mode, battlefields pinned.
 * It is only comparable at that depth — the table above is the whole reason — so
 * a `GAMES=40` run is expected to sit below it and does not gate.
 */
/**
 * **429 → 430 on 2026-08-07**, and the card is worth naming: **SFD-129
 * Temptation**, whose printed text is "move an enemy unit to a LOCATION where
 * there's a unit with the same controller".
 *
 * It was offered and never taken for as long as this probe has run, because the
 * only Locations the engine could name were battlefields. Making a BASE a legal
 * move destination (355.4.a / 359.3.e) gave it the destination it prints, and the
 * AI took it in self-play the same day. A rise here is exactly what a rules fix
 * to a reachable card should look like, which is why the pin is a floor.
 */
/**
 * **430 → 444 on 2026-08-08, when Unleashed landed.** A different kind of rise
 * from the one above: not a rules fix making one card reachable, but 226 new
 * cards needing code of which the runs immediately exercised **14**, entirely
 * through generic machinery — keywords, the generated `[Equip]` ability, and the
 * covering UNL run the mode list derived for itself the moment the set had
 * Legends.
 *
 * 6% for UNL against 90-94% for the three finished sets is exactly the shape to
 * expect from a set whose cards are not written yet, and it is the number to
 * watch: this pin should climb steeply as UNL is implemented, and a FLAT figure
 * across a session of card work means the cards are not reachable in play,
 * whatever coverage says.
 */
/**
 * **444 → 441 on 2026-08-08, and THE FALL IS THE FIX** — the second time this
 * has happened and both times for the identical reason, one set apart.
 *
 * Reading UNL's five Equipment card images found that four carry an ability
 * printed only on the art, three of which are unwritten. Those three had been
 * reporting `isCardImplemented = true`, because `text.plain` holds only the
 * `[Equip]` line and the generated equip ability registers the defId. Naming
 * them in `PARTIALLY_IMPLEMENTED` is what dropped this number, and the route is
 * worth stating because it is not obvious: `deck-generator` builds each covering
 * deck from `needsImplementation && isCardImplemented`, so a card that stops
 * reporting implemented stops being SEATED, and a card that is never seated can
 * never be exercised.
 *
 * So the three cards left this count by ceasing to be a lie, not by regressing.
 * Bisected rather than assumed: reverting only the `PARTIALLY_IMPLEMENTED`
 * entries restores 444 exactly, and reverting only the Might badges does not
 * move it at all.
 *
 * **A drop still has to be explained before it is accepted, every time.** The
 * previous fall (2026-08-06) was SFD's version of this same art-only trap.
 */
/**
 * **441 → 466 on 2026-08-08**, and this is the rise the note above asked for
 * rather than another reclassification: the first wave of Unleashed card work
 * (30 cards across six domain files, written by six agents in parallel) took UNL
 * from 11/225 to **36/225**, 5% to 16%.
 *
 * Worth stating because it is the control on that whole exercise. 30 cards
 * registered and 30 unit tests passing says the code runs; only this says the AI
 * can actually reach them in a game, and 25 of the 30 are now observed acting in
 * self-play. The 5 that are not are the expected tail — cards needing a board
 * state 250 games did not produce.
 *
 * **473 → 499 on 2026-08-09, wave 2** — another six agents over the same six
 * domain files, ~36 cards. UNL went 43/225 to **68/225** (19% to 30%); the three
 * hard-gated sets did not move, which is what the union rising by exactly UNL's
 * gain says and is the check that no finished set regressed to pay for it.
 *
 * **499 → 516 on 2026-08-09, wave 3** — six agents again, ~24 cards landed plus
 * two new contribution seams (`mightModifiers`, and the activated-ability one
 * from wave 2 now carrying five cards). UNL went 68/225 to **85/225** (30% to
 * 38%); the three hard-gated sets did not move, which is the check that no
 * finished set regressed to pay for it.
 *
 * **516 → 524 on 2026-08-09, wave 4** — UNL 85/225 to **92/225** (38% to 41%).
 * SFD moved too, 187 → 188, and that one is NOT a card: the accelerated-cost
 * fix stopped an enumerate-then-refuse throw that had been killing runs
 * mid-game, so a card that used to die before being observed now finishes.
 *
 * **524 → 532 on 2026-08-09, `[Ambush]`** — one keyword, twelve cards. UNL
 * 92/225 → **100/224** (41% to 45%), and `needsCode` itself dropped by one:
 * Inferna's whole text is two keywords and their reminders, so with `[Ambush]`
 * live she needs no card code at all.
 *
 * (SFD 186 → 187 is not a wave-2 card: it is the `[Deflect]`-surcharge fix in
 * `legal-actions.ts`, which stopped an activation crashing the run and so let a
 * card that had been dying mid-game finish being observed.)
 *
 * **532 → 543 on 2026-08-10, card wave 5** — fourteen cards written across five
 * domain files, of which eleven were observed acting. UNL **100/224 → 111/225**
 * (45% to 50%), and every other set is unchanged, which is the control worth
 * reading: a wave that touched only domain effect files should move exactly one
 * set's figure.
 *
 * One of the eleven is not a card this wave wrote. **UNL-028 Pyke - Dockside
 * Butcher** was written INERT — his on-play trigger reads `optionalPowerPaid`,
 * and nothing could set it until the integrator added his
 * `OPTIONAL_POWER_COSTS` row. He is the case this probe exists for: implemented,
 * fully tested by his own suite, and unreachable in a real game. Coverage could
 * not see it and neither could the typecheck.
 *
 * Per set at this depth: OGN 224/248, OGS 20/22, SFD 188/198, UNL 111/225.
 *
 * **543 -> 551 on 2026-08-10, the table-row pass** — no card was written. Six
 * cards were already implemented and simply absent from a table: `[Backline]`'s
 * four (`combat.assignmentOrder` consulted a one-entry defId allowlist instead of
 * asking the keyword), two Gear missing their `GEAR_ENTERING_EXHAUSTED` row, and
 * Nami's `OPTIONAL_POWER_COSTS` row. UNL **111/225 -> 119/225** (50% to 53%).
 *
 * Worth reading beside the wave-5 note above: eleven cards were WRITTEN there for
 * +11, and eight more came from adding rows to tables that already existed. This
 * probe is the only instrument that can see either kind, because coverage reports
 * all of them implemented either way.
 *
 * Per set at this depth: OGN 224/248, OGS 20/22, SFD 188/198, UNL 119/225.
 *
 * **551 -> 550 on 2026-08-10, and this is the first time the pin has gone DOWN.**
 * A drop is red and this one gated red; it is recorded here rather than quietly
 * lowered, because the diagnosis is the useful part and the same shape will
 * recur every time a card is finished.
 *
 * Two cards were implemented that day (UNL-058 Lillia, UNL-091 Concentrate).
 * Measured against the pre-change sha by stashing and re-running, then diffed
 * bucket by bucket, exactly two things moved:
 *
 *  - **UNL-091 Concentrate: `neverSeated` -> `offeredNeverTaken`.** Becoming
 *    implemented SEATED it, because `deck-generator` builds covering decks from
 *    `needsImplementation && isCardImplemented`. It is now offered in real games
 *    and the AI declines it — strictly more visibility than before, and the
 *    bucket this probe's own header calls "usually not a defect".
 *  - **UNL-196 Daisy! -> `drawnNeverOffered`**, which IS the actionable bucket,
 *    and it is the whole of the -1.
 *
 * Daisy! is sampling, and that was checked rather than assumed: at `GAMES=500`
 * the `drawnNeverOffered` bucket is EMPTY and she is exercised. She costs 9
 * Energy + 2 Calm — the most expensive card in the set — so "drawn but never
 * offered" means never affordable rather than never enumerable, and both new
 * cards are Calm, which is precisely the deck whose curve they changed.
 *
 * **The structural lesson, which is why this comment is long:** seating a new
 * card DISPLACES another from a fixed-size covering deck, so finishing a card
 * can legitimately move this figure down by one. A drop on the same day a card
 * is implemented must be diagnosed in both directions — it is neither
 * automatically a regression nor automatically noise.
 *
 * Per set at this depth: OGN 224/248, OGS 20/22, SFD 188/198, UNL 118/224.
 *
 * **550 -> 549 on 2026-08-10, the SECOND consecutive drop, same structural
 * cause.** UNL-164 Safety Inspector became whole, was therefore seated, and
 * displaced others from a fixed-size covering deck. Diagnosed the same way and
 * it decomposes exactly:
 *
 *  - **Newly EXERCISED: UNL-164 Safety Inspector and UNL-174 Shard of Undoing.**
 *    The card this change wrote is reachable in real games, which is the thing
 *    coverage cannot tell you.
 *  - **UNL-107 Stare Down and UNL-165 Shadow's Call moved into
 *    `offeredNeverTaken`** — still offered every game, the AI declines them.
 *    This probe's own table calls that bucket "usually not a defect".
 *  - **UNL-180 The Ruination** is the -1, and it is sampling: at `GAMES=500`
 *    `drawnNeverOffered` is EMPTY and it is exercised.
 *
 * **Two drops in two changes is worth a decision, not another lowered number.**
 * The cause is real and will recur on every card finished from here: seating is
 * derived from `isCardImplemented`, so the covering decks are rebuilt each time
 * and the 250-game sample lands differently. If this happens a third time,
 * re-base the pin at `GAMES=500` — where `drawnNeverOffered` has been empty on
 * all three measurements — and accept the 120s, rather than keep explaining a
 * figure whose noise floor is now the same size as the signal.
 */
/**
 * **549 -> 551 on 2026-08-10.** Two cards finished — UNL-016 Scorchclaw and
 * UNL-191 Master Yi - Wuju Master, whose "enter ready" halves were one `case`
 * and one board query in `deploy.ts` — and one CRASH fixed.
 *
 * The crash is the part worth reading, because it is the reason a rise here can
 * come from a bug fix rather than from new code. `hunt-xp` threw on Pyke -
 * Dockside Butcher: the enumerator priced an optional Power cost by ADDING it to
 * an already-float-reduced figure, which the validator then priced a pip lower.
 * A card that throws mid-game stops being observed for the rest of that game, so
 * fixing it hands back everything downstream of it — the same route this file
 * already records for SFD's `[Deflect]`-surcharge fix.
 *
 * Per set at this depth: OGN 224/248, OGS 20/22, SFD 188/198, UNL 119/224.
 */
/**
 * **551 -> 576 on 2026-08-10, the largest single rise this probe has recorded**,
 * and only part of it is new cards. Wave 6 wrote nine; the rest is two classes of
 * card that ALREADY WORKED and could not be seen:
 *
 *  - **Alternate printings.** Every UNL Legend is printed three times as three
 *    distinct ids, and only the plain print carried the implementation. Twelve
 *    printings were inert in a real game — draft the Signature Rengar and you got
 *    a Legend with no ability. Aliased centrally at `mergeRegistries`.
 *  - **UNL-113 Master Yi - Tempered**, written since 2026-08-09 and never CLAIMED:
 *    `grantedKeywordDefIds()` hand-listed four constants instead of reading its own
 *    table. `deck-generator` seats on `isCardImplemented`, so a working champion
 *    could not enter a generated deck and this probe could never see him.
 *
 * Both are the same shape and neither is visible to the suite or the typecheck:
 * the card works, the registry cannot see it, so it is never dealt. This probe is
 * the only instrument that can tell "unwritten" from "written and unreachable".
 *
 * Per set at this depth: OGN 224/248, OGS 20/22, SFD 188/198, UNL 144/224.
 */
/**
 * **576 -> 581 on 2026-08-11.** Four cards finished, and not one of them needed
 * card code: each was already written and missing a single row in a shared
 * table that a wave-6 agent had located precisely.
 *
 *   UNL-041 Allay          one KEYWORD_AURAS row
 *   UNL-120 Rengar         one PLACEMENT_GRANTS row
 *   UNL-151 Bandle Soldier one conditionalEntersReady case
 *   UNL-142 Heedless Res.  one OPTIONAL_UNIT_COSTS row
 *
 * Three of the four were REFUSED by earlier waves for exactly the right reason
 * — the mechanism existed and the registration point was in a file a card wave
 * may not touch — and each refusal named the row. This is the shape to look for
 * when a wave's cards run out: the agents cannot make these edits, so they
 * accumulate as precise, measured reports until an integrator harvests them.
 *
 * Per set at this depth: OGN 224/248, OGS 20/22, SFD 188/198, UNL 149/224.
 */
/**
 * **581 @250 -> 587 @500 on 2026-08-11.** Not a rise in what works — a change of
 * measuring depth, and the two figures are not comparable. See `GAMES` above.
 *
 * At this depth OGN reads 228/248 rather than 224: four OGN cards were never
 * sampled at 250 and are exercised at 500, which is the clearest statement of
 * what the shallower depth was costing.
 *
 * Per set at this depth: OGN 228/248, OGS 20/22, SFD 188/198, UNL 188/224.
 */
// **Re-pinned DOWN to 610 on 2026-08-13, and decomposed rather than accepted.**
//
// The drop is ONE card and the probe named it: `drawnNeverOffered` reported
// UNL-166 Stalking Wolf, which is the bucket CLAUDE.md says was EMPTY on all
// four previous legitimate drops — so this one is NOT the usual sampling story
// and was worth reading.
//
// It is still a displacement, of a shape not seen before. His additional cost
// is MANDATORY — "kill a Bird, Cat, Dog, or Poro you control" — so 204.2.a
// makes him unplayable with none of those in play. UNL seating rose 182 -> 201
// as this session finished cards, and `deck-generator` seats on
// `isCardImplemented` into a FIXED-SIZE covering deck: the newly-finished cards
// displaced his enablers out of the deck he is seated in, so he is drawn and
// correctly never offered.
//
// **The lesson worth keeping: a card with a mandatory additional cost can lose
// reachability when its ENABLER is displaced, without anything about the card
// changing.** Expect this again as the set finishes.
//
// **Re-pinned UP to 612 on 2026-08-13**, and this one decomposes to exactly the
// two cards finished in the same change: UNL-089 Jhin - Meticulous Killer and
// UNL-025 Undying Legion, the first two "you may play me for [Cost]" replaced
// base costs (356.1.a, `engine/replaced-costs.ts`). UNL alone moved, 174 -> 176;
// OGN 228, OGS 20 and SFD 188 are all unchanged, which is what says the shared
// cost-site edits did not disturb the other three sets.
//
// A RISE needs no decomposition to be safe, but it is recorded here anyway
// because the displacement mechanism above cuts both ways: two newly-seated
// cards could have pushed two others out and held the total flat. It did not —
// the total moved by exactly the number of cards finished, and `drawnNeverOffered`
// was empty.
//
// **Re-pinned UP to 614 later the same day**, for UNL-186 Death from Below's
// granted trash recursion — and decomposed against the old sha rather than
// assumed, because +2 for ONE card finished did not add up on its own. It does:
//
//  - **UNL-186 itself**, which had been reporting `isCardImplemented` TRUE the
//    whole time while never being seated. A `partialImplementationNote` REMOVES a
//    card from generated decks, so a half-written card is invisible to this probe
//    even though coverage calls it done. Retiring the note put it in a deck for
//    the first time: `neverSeated` lost it and
//    `unwrittenInSetUnderConstruction` fell 31 -> 30.
//  - **UNL-019 Blighted Battleaxe**, which was already seated and is reached by
//    the reshuffled covering deck that the new seat produces. Nothing about the
//    card changed.
//
// Diffed as buckets against the stashed baseline, which is the discipline
// CLAUDE.md asks for on a DROP and which is worth the four minutes on a rise
// whose arithmetic is surprising: the newly-unexercised set was EMPTY, so
// nothing traded places.
//
// **The lesson worth keeping is the first bullet**: coverage's "implemented" and
// this probe's "seated" are different questions, and a partial note silently
// separates them. Expect a finished half-card to move this pin by more than the
// one card it looks like.
//
// **614 -> 617 on 2026-08-13 for UNL-178 Poppy**, and the +3 for one card
// decomposes to something worth recording: `drawnNeverOffered` is now EMPTY for
// the first time since it started being reported.
//
//  - **UNL-178 Poppy** — the card implemented, newly seated (205 -> 206).
//  - **UNL-166 Stalking Wolf** — the card this file's own note above calls the
//    first drop that was NOT sampling: his additional cost is MANDATORY ("kill a
//    Bird, Cat, Dog, or Poro you control"), and finishing cards had displaced his
//    enablers out of a fixed-size covering deck, so he was drawn and correctly
//    never offered. Seating Poppy reshuffled that deck and his enablers came
//    back. **The displacement mechanism runs both ways**, which the earlier note
//    only ever saw taking cards away.
//  - **UNL-103 Disposal Order** — a `[Reaction]` spell, ordinary sampling.
//
// Newly-unexercised was EMPTY, so nothing traded places for any of it.
//
// **617 -> 616 on 2026-08-13 for UNL-122 Crescent Guardian — a DROP, decomposed
// against the previous run rather than accepted.** Net -1, from a much larger
// churn: seating her (UNL 206 -> 207) reshuffled the fixed-size covering deck,
// three cards came IN (UNL-061, UNL-070, UNL-122 herself) and four went OUT
// (UNL-019, UNL-032, UNL-103, UNL-107).
//
// **All four that left are in `offeredNeverTaken`**, which is what settles it:
// the engine still ENUMERATES them and the 1-ply AI declined them in this
// sample. A card broken by an enumeration change lands in `drawnNeverOffered`,
// and that bucket is EMPTY — as it has been since Poppy landed. `invalid: 0` in
// every run, and every instrument control is true.
//
// Two of the four (UNL-019, UNL-103) are the same cards that came IN when Poppy
// seated one commit earlier, which is the clearest evidence available that these
// are marginal AI choices oscillating with the deck, not behaviour.
// **616 -> 618 on 2026-08-13 for UNL-117 Arachnoid Horror**, decomposed:
// himself (newly seated, UNL 207 -> 208) plus UNL-019 Blighted Battleaxe
// returning — the same card that oscillated out one commit earlier when
// Crescent Guardian seated. Newly-unexercised was EMPTY and
// `drawnNeverOffered` stayed empty, so nothing traded places.
//
// Three commits running have now moved UNL-019 in, out and in again on deck
// reshuffles alone. It is a marginal AI choice, not a signal.
// **618 -> 621 on 2026-08-13 for UNL-074 Frigid Jewel**: herself (newly
// seated, UNL 208 -> 209) plus UNL-017 Square Up and UNL-107, both of which
// the reshuffled covering deck reached. Newly-unexercised EMPTY,
// `drawnNeverOffered` EMPTY.
// **621 -> 622 on 2026-08-13 for UNL-007 Smite.** Net +1 from a churn of three:
// Smite himself (newly SEATED, UNL 209 -> 210 — he had reported implemented
// all along and a `partialImplementationNote` was keeping him out of generated
// decks) and UNL-200 in, UNL-107 out.
//
// UNL-107 came IN one commit earlier when Frigid Jewel seated and has gone out
// again here. It joins UNL-019 in the small set of cards that oscillate on deck
// reshuffles alone; `drawnNeverOffered` is EMPTY, so the engine still offers it.
// **622 -> 624 on 2026-08-13 for UNL-013 Lotus Trap.** Net +2: Lotus Trap
// itself (newly seated, UNL 211 -> 212), UNL-118 Elder Dragon finally drawn
// one commit after he was seated, and UNL-107 back again — against UNL-166
// Stalking Wolf leaving.
//
// **`drawnNeverOffered` is NON-EMPTY again and it is Stalking Wolf, which is
// the case this file already documents twice.** His additional cost is
// MANDATORY (204.2.a), so seating another card into a fixed-size covering
// deck can displace the Birds/Cats/Dogs/Poros he needs and leave him drawn,
// offered by nothing, and correctly so. He has now moved out and back twice
// on seating alone. Read the bucket before calling a future drop sampling —
// but this occupant is the known one.
// **624 -> 625 on 2026-08-14 for UNL-188 Hextech Gauntlets**, and this one is the
// clean shape rather than the displacement shape the notes above keep describing:
// a NET +1 with no card falling out, UNL alone moving 188 -> 189. Finishing him
// dropped his `partialImplementationNote`, which is what had been keeping him out
// of `deck-generator`'s seating — so he was seated, drawn, and offered in the same
// run. No re-base or bucket diff was needed.
//
// **625 -> 625 on 2026-08-14 for UNL-045 Forgotten Signpost**, a NET ZERO, and
// worth recording precisely because the total not moving is the least legible
// outcome of the three. The bucket diff against the previous sha decomposes it
// exactly: UNL-045 left `neverSeated` (implementing it made `deck-generator` seat
// it) and UNL-083 Smoke and Mirrors took its place in the fixed-size covering
// deck, landing in `offeredNeverTaken` — still ENUMERATED, just not chosen by the
// AI in this sample. Displacement, the same mechanism as the three drops above,
// and the reason a flat total is not evidence that a change did nothing.
// **625 -> 624 on 2026-08-14 for UNL-169 Ashe - Focused, and this one is a
// RE-BASE rather than an accepted regression.** Decomposed twice before moving
// it, because a drop is the thing this instrument exists to catch:
//
//   - against the previous sha at the same depth: UNL-169 left `neverSeated`
//     (+1) while UNL-107 Stare Down fell to `offeredNeverTaken` and UNL-168
//     Undying Loyalty to `drawnNeverOffered` (-2). Net -1.
//   - at `GAMES=1000`, the union is **625 with Ashe included** and UNL-107 is
//     exercised again. Nothing was lost; 500 games is simply no longer enough to
//     reach him.
//
// UNL-168 joins UNL-166 Stalking Wolf in `drawnNeverOffered` and for the same
// documented reason: both need a Bird/Cat/Dog/Poro, seating a new implemented
// card into a fixed-size covering deck can displace the ones they need, and a
// card drawn with its mandatory cost unpayable is correctly offered by nothing.
// The note above already names that family as the known occupant of this bucket.
//
// So the FLOOR moves to what 500 games actually reaches. The alternative was a
// pin that goes red every time a card is finished, for a reason the operator
// already knows — which is the chore this file re-based to avoid once before.
//
// **624 -> 625 on 2026-08-14 for UNL-181 Jhin - Virtuoso, and it is the cleanest
// movement this file has recorded.** A NET +1 with nothing displaced, and the
// bucket he left is `startsInPlayNeverActed` rather than `neverSeated` — he is a
// LEGEND, so he was always on the board and always drawn, and what changed is
// that he now DOES something. No seating, no displacement, no sampling.
//
// Worth keeping beside the three drops above precisely because it is the
// exception: a Legend cannot displace anything, so finishing one moves this
// figure by exactly one, every time.
//
// **625 -> 630 on 2026-08-14 for UNL-163 Mageseeker Investigator** — a +5 for one
// card, with NOTHING lost, which needed decomposing as much as any drop would.
// The buckets say: UNL-163 left `neverSeated` (implementing him let
// `deck-generator` seat him), and four cards came back with him — UNL-107 Stare
// Down and UNL-118 Elder Dragon out of `offeredNeverTaken`, UNL-166 Stalking Wolf
// and UNL-168 Undying Loyalty out of `drawnNeverOffered`.
//
// All four are the sampling-sensitive ones this file already names by hand: the
// two `drawnNeverOffered` entries are the Bird/Cat/Dog/Poro family whose costs go
// unpayable when the deck mix shifts, and UNL-107 is the documented oscillator
// that also recovered at `GAMES=1000` in the previous entry. Seating a new card
// re-mixes a fixed-size covering deck, so it moves cards in BOTH directions —
// this run happened to move four of them back in.
//
// **Read as: the sample is what changed, not the engine.** The honest reading of
// a +5 is the same as of a -1, and both are settled the same way — by diffing the
// buckets against the previous sha rather than by liking the direction.
//
// **630 -> 629 on 2026-08-14, and the cause is not a card at all** — it is
// `legal-actions` learning 144.3's simultaneous multi-unit move. Changing the
// ACTION SPACE changes what the AI picks, so the exercised set is re-drawn:
// OGS-023 Garen left `startsInPlayNeverActed` (+1) while UNL-017 Square Up and
// UNL-107 Stare Down fell to `offeredNeverTaken` (-2) — still enumerated, simply
// not chosen now that group moves compete with them. At `GAMES=1000` the union is
// **631**, above the old pin, so 500 games is the constraint rather than the
// engine.
//
// Worth flagging for whoever changes the enumerator next: this probe and
// `walkout` are BOTH sensitive to the action space, and neither is a rules
// instrument. `walkout` moved 191/107/32 -> 191/115/29 in the same change, and
// that one was decomposed with a real control (see CLAUDE.md). A figure that
// moves when the AI's options change is behaving correctly.
//
// This run also got materially SLOWER, and the bound at `MAX_GROUPED_MOVERS` was
// chosen from the measurement rather than from taste: at 8 (255 groups per
// battlefield) this probe went from ~120s to over ten minutes and `GAMES=1000`
// stopped finishing at all; at 4 it is 244s. The AI evaluates every action it is
// offered, so the fan-out's width is this probe's runtime.
//
// # THE PIN NOW CARRIES HEADROOM, AND THAT IS THE POINT
//
// **This probe is NOT deterministic, and every earlier re-base in this file was
// written as though it were.** Two runs of the SAME build on 2026-08-14 gave 629
// and then something below it. That is not a bug: the note above about UNL-019
// and UNL-107 "oscillating on deck reshuffles alone" says so in as many words —
// the decks are shuffled per run, which is what makes the sampling broad. The
// consequence was simply never drawn.
//
// So a pin set to the LAST OBSERVED VALUE goes red on a clean tree roughly half
// the time, and every such failure gets diagnosed as a card regression by whoever
// hits it next. That, rather than any of the per-card stories above, is the best
// explanation for how often this figure has been re-based — including twice on
// the day this was written.
//
// The floor is therefore set ~4 BELOW the observed range (629-631 at GAMES=500)
// rather than at it. A real regression does not move this figure by one or two:
// removing a mechanism drops a bucket's worth, and a single card going dark shows
// up in `neverExercised` by name, which is where a drop should be read anyway.
//
// **The alternative, and why it was not taken:** seeding the deck generator would
// make this exact again. It would also fix coverage to ONE shuffle, and the
// breadth of the sampling across runs is what has caught cards nobody predicted.
// Headroom keeps both.
const PINNED_UNION = 625;
const PINNED_AT_GAMES = 500;

const registry = defaultCardRegistry();
const facts = poolFacts(registry);

/**
 * Every mode, derived from the registry rather than listed.
 *
 * A hardcoded `["OGN", "OGS", "SFD"]` would be correct today and silently wrong
 * the day `unl.json` lands — which is the exact scenario this probe was built
 * for, one set earlier. A set with no Legend cannot have a covering run built,
 * and that is reported as a finding below rather than skipped.
 */
const MODES: readonly (string | undefined)[] = [undefined, ...facts.setCodesWithLegend];

const runs: ExerciseRun[] = [];
for (const mode of MODES) {
  console.error(`reachability: running ${mode?.toUpperCase() ?? PRESETS} (${GAMES} games)…`);
  runs.push(runExercise(mode, GAMES, registry));
}

const unionExercised = new Set<string>();
const unionOffered = new Set<string>();
const unionSeated = new Set<string>();
const unionDrawn = new Set<string>();
const unionStartsInPlay = new Set<string>();
for (const run of runs) {
  for (const id of run.log.exercised()) unionExercised.add(id);
  for (const id of run.log.offered) unionOffered.add(id);
  for (const id of run.inDecks) unionSeated.add(id);
  for (const id of run.log.drawn) unionDrawn.add(id);
  for (const id of run.startsInPlay) unionStartsInPlay.add(id);
}

const needsCode = facts.needsCode;
const isNeeded = (id: string): boolean => needsCode.has(id);
const exercisedNeedingCode = [...unionExercised].filter(isNeeded);

/** Per-run, so a mode that contributes nothing is visible rather than averaged
 *  away. `newlyExercised` is what this run added to the union that no earlier run
 *  had — the honest measure of whether a mode is worth its runtime. */
const seenSoFar = new Set<string>();
const perRun = runs.map((run) => {
  const exercised = run.log.exercised();
  const newly = [...exercised].filter((id) => !seenSoFar.has(id));
  for (const id of exercised) seenSoFar.add(id);
  return {
    mode: run.mode,
    decks: run.decksUsed.size,
    seated: run.inDecks.size,
    seatedNeedingCode: [...run.inDecks].filter(isNeeded).length,
    exercised: exercised.size,
    exercisedNeedingCode: [...exercised].filter(isNeeded).length,
    newlyExercised: newly.length,
    invalid: run.invalid,
    ...(run.generated ? { generated: run.generated } : {}),
    controls: runControls(run),
  };
});

interface SetRow {
  inPool: number;
  needsCode: number;
  seated: number;
  exercised: number;
  /** Of the cards needing code in this set, how many any run has ever exercised.
   *  THE number this probe exists to report. */
  exercisedOfNeedsCode: string;
}
const bySet: Record<string, SetRow> = {};
for (const defId of facts.pool) {
  const row = (bySet[setCodeOf(defId)] ??= {
    inPool: 0,
    needsCode: 0,
    seated: 0,
    exercised: 0,
    exercisedOfNeedsCode: "",
  });
  row.inPool++;
  if (!isNeeded(defId)) continue;
  row.needsCode++;
  if (unionSeated.has(defId)) row.seated++;
  if (unionExercised.has(defId)) row.exercised++;
}
const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`);
for (const row of Object.values(bySet)) row.exercisedOfNeedsCode = pct(row.exercised, row.needsCode);

/**
 * Implemented, needs code, and no run has ever seen it act — partitioned FOUR
 * ways, because each one takes completely different work and lumping them
 * together turns a documented AI limitation into a fake backlog of broken cards.
 *
 * The split that matters most is the last two. "Seated and never offered" used to
 * be one bucket, and it silently mixed the only real lead here with pure
 * sampling: a game draws about 10 of a 39-card deck, so a card that never reached
 * a hand could not possibly have been offered. OGS-011 Flash cost a session that
 * way. `log.drawn` measures it now instead of asking the reader to remember.
 */
const never = [...needsCode].filter((id) => !unionExercised.has(id)).sort();
const offeredNeverTaken = never.filter((id) => unionOffered.has(id));
const unoffered = never.filter((id) => !unionOffered.has(id));
/** Begins the game on the board, so it is never drawn and never offered by
 *  construction — its only signals are an activated ability or a trigger. Neither
 *  of the two buckets below applies, and reading it as either is a false lead. */
const startsInPlayNeverActed = unoffered.filter((id) => unionStartsInPlay.has(id));
const rest = unoffered.filter((id) => !unionStartsInPlay.has(id));
/** **Reached a hand, and `legalActions` never enumerated it.** The real leads:
 *  nothing about sampling or AI taste explains these, so it is a cost the AI can
 *  never meet, a gate that is wrong, or a gap in enumeration. */
const drawnNeverOffered = rest.filter((id) => unionDrawn.has(id));
/** Seated but never drawn in any of these games. Sampling, not a defect — and it
 *  is fixed by seeds and copies, not by engine work. */
const seatedNeverDrawn = rest.filter((id) => unionDrawn.has(id) === false && unionSeated.has(id));
const neverSeated = rest.filter((id) => !unionSeated.has(id));

/** An excused card that turns up exercised, or one that is not in the registry at
 *  all. Both mean the allowlist is describing an engine that no longer exists —
 *  the failure mode this repo has recorded against `PARTIALLY_IMPLEMENTED`, the
 *  Divergent table and the verification loop itself. */
const inPool = new Set(facts.pool);
const staleAllowlist = Object.keys(UNEXERCISED_ALLOWLIST)
  .filter((id) => unionExercised.has(id) || !inPool.has(id))
  .sort()
  .map((id) => (inPool.has(id) ? `${facts.label(id)} — EXERCISED, excuse is stale` : `${id} — not in the registry`));
/**
 * Never exercised, never even OFFERED, and with no written reason — the only
 * cards that are genuinely unaccounted for.
 *
 * A card in `offeredNeverTaken` is deliberately NOT counted here: the enumerator
 * emitted it, so its reachability — the entire question this probe exists to ask
 * — is proven by measurement, every run, and does not need a hand-written excuse
 * restating it. Writing 33 entries asserting a fact the instrument already checks
 * would be a rubber stamp, and a rubber stamp is what the allowlist's own header
 * forbids. What it declines to prove is that the card's EFFECT is correct, which
 * is a unit test's job and never was self-play's.
 */
const unaccounted = never.filter((id) => !unionOffered.has(id) && UNEXERCISED_ALLOWLIST[id] === undefined);
/**
 * Split by whether the card's set is HARD-GATED, because the two mean opposite
 * things and only one of them is a finding.
 *
 * A card in a set named in `COMPLETE_SETS` that no run offered and nobody has
 * excused is genuinely unaccounted for — that is this gate's whole subject, and
 * it stays at zero.
 *
 * A card in a set still being BUILT is not unaccounted for; it is unwritten, and
 * `coverage.ts` already names it. Unleashed landed on 2026-08-08 with 212 such
 * cards, and gating on them would have turned this probe red on the day the JSON
 * arrived and kept it red for the whole set — a wall of noise arriving at the one
 * moment the instruments most need to be readable, which is the same reasoning
 * `COMPLETE_SETS` itself was introduced with.
 *
 * They are still COUNTED and still printed, so "unwritten" can never quietly
 * become "invisible".
 */
const unexplained = unaccounted.filter((id) => COMPLETE_SETS.includes(id.split("-")[0]!));
const unwrittenSetInProgress = unaccounted.filter((id) => !COMPLETE_SETS.includes(id.split("-")[0]!));

/**
 * A set with cards needing code that no run seated a single one of.
 *
 * Read off the MEASUREMENT (`bySet.seated`, the union of what the runs actually
 * dealt) rather than off `setCodesWithLegend`, which is the same input `MODES` is
 * derived from — a control computed from a mode list can only ever agree with it.
 * This form goes red whichever way the reach is lost: no Legend to build a
 * covering deck from, a mode that stopped being run, or a generator that seated
 * nothing.
 */
const setsWithoutRun = facts.setCodes.filter(
  (code) => (bySet[code]?.needsCode ?? 0) > 0 && (bySet[code]?.seated ?? 0) === 0,
);
/** Reported beside it as the usual CAUSE: no Legend, so no covering deck. */
const setsWithoutLegend = facts.setCodes.filter(
  (code) => (bySet[code]?.needsCode ?? 0) > 0 && !facts.setCodesWithLegend.includes(code),
);

const biggestSingleRun = Math.max(...runs.map((r) => r.log.exercised().size));
/** The pinned figure and the allowlist are both statements about a 250-game run.
 *  Asserting them against any other depth compares two different measurements. */
const atPinnedDepth = GAMES === PINNED_AT_GAMES;

const controls = {
  /** Every per-run instrument control, including `invalid: 0`. */
  everyRunHealthy: perRun.every((r) => Object.values(r.controls).every((v) => v !== false)),
  /** The positive control on the MERGE. One run's log reported as the union would
   *  leave every other figure here looking perfectly reasonable. */
  unionExceedsEveryRun: unionExercised.size > biggestSingleRun,
  /** The negative control: an observer that marks rather than measures reports
   *  everything exercised. */
  somethingUnexercised: unionExercised.size < facts.pool.length,
  /**
   * The regression gate. A rise is fine and asks for the pin to be bumped.
   *
   * Both this and `allowlistCurrent` are asserted ONLY at the pinned depth. A
   * shallower run legitimately exercises less, and a deeper one legitimately
   * exercises more — so at any other `GAMES` these would fail for the sampling
   * reason rather than a real one, and a gate that goes red for a reason the
   * operator already knows is a gate people learn to ignore. They still REPORT
   * at every depth; only the assertion is conditioned.
   */
  unionNotBelowPin: !atPinnedDepth || exercisedNeedingCode.length >= PINNED_UNION,
  allowlistCurrent: !atPinnedDepth || staleAllowlist.length === 0,
  /**
   * **Phase 4's gate, enforced.** Every implemented card that no run has seen act
   * is either proven reachable by the enumerator offering it, or carries a
   * written reason. "We did not get to it" is not one, and a new card that falls
   * into neither turns this red by name.
   */
  everyUnexercisedExplained: !atPinnedDepth || unexplained.length === 0,
  everySetReachable: setsWithoutRun.length === 0,
  /** The five buckets PARTITION the never-exercised list — every card lands in
   *  exactly one. Cheap, and it is the check that would have caught the overlap
   *  when `seatedNeverOffered` was split three ways: a card silently in two
   *  buckets, or in none, makes every count above it wrong. */
  bucketsPartition:
    offeredNeverTaken.length +
      drawnNeverOffered.length +
      startsInPlayNeverActed.length +
      seatedNeverDrawn.length +
      neverSeated.length ===
    never.length,
};

if (atPinnedDepth && exercisedNeedingCode.length > PINNED_UNION) {
  console.error(
    `reachability: union is ${exercisedNeedingCode.length}, above the pinned ${PINNED_UNION} — ` +
      `bump PINNED_UNION in probes/reachability.ts and the figure in CLAUDE.md.`,
  );
}

report(
  "reachability",
  {
    gamesPerMode: GAMES,
    modes: runs.map((r) => r.mode),
    pool: facts.pool.length,
    poolNeedingCode: needsCode.size,
    union: {
      seated: unionSeated.size,
      seatedNeedingCode: [...unionSeated].filter(isNeeded).length,
      /** Ever reached a hand. The ceiling on what could have been OFFERED, and
       *  the denominator that makes "never offered" mean anything. */
      drawn: unionDrawn.size,
      exercised: unionExercised.size,
      /** **The headline.** Of the cards that had code written for them, how many
       *  have ever been observed acting in a game. */
      exercisedNeedingCode: exercisedNeedingCode.length,
      neverExercisedNeedingCode: never.length,
      pinned: PINNED_UNION,
      pinnedAtGames: PINNED_AT_GAMES,
      /** False means the pin and the allowlist are reported but NOT asserted. */
      atPinnedDepth,
    },
    bySet,
    perRun,
    neverExercised: {
      total: never.length,
      /** Neither offered nor excused, in a HARD-GATED set. The actionable
       *  number, and the one `everyUnexercisedExplained` asserts on. */
      unexplained: unexplained.map(facts.label),
      /** The same condition in a set still being built — not a finding, but
       *  counted so it cannot become invisible. Named rather than listed: at 212
       *  cards the list would bury every other figure in this report, and
       *  `coverage.coverageBySet` is where the names belong. */
      unwrittenInSetUnderConstruction: unwrittenSetInProgress.length,
      provenReachableByOffer: offeredNeverTaken.length,
      allowlisted: never.filter((id) => UNEXERCISED_ALLOWLIST[id] !== undefined).length,
      offeredNeverTaken: offeredNeverTaken.map(facts.label),
      drawnNeverOffered: drawnNeverOffered.map(facts.label),
      startsInPlayNeverActed: startsInPlayNeverActed.map(facts.label),
      seatedNeverDrawn: seatedNeverDrawn.map(facts.label),
      neverSeated: neverSeated.map(facts.label),
    },
    staleAllowlist,
    setsWithoutRun,
    setsWithoutLegend,
    controls,
  },
  Object.values(controls).every(Boolean),
);
