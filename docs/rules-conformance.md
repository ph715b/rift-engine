# Rules conformance

Where this engine's behaviour stands against the **official Riftbound Core
Rules**, and — just as importantly — which behaviours have never been checked.

**Reviewed through:** Core Rules `2026-07-16` · Core Rules Patch Notes
`2025-10-24` · Origins card errata (first batch, 31 cards)

## How to use this file

- Cite **rule numbers**, never pasted rules text. The Core Rules PDF lives in
  `docs/` but is git-ignored (Riot's content, ~39 MB) — `pdftotext -layout` it
  to a scratch file to grep.
- `Status` is the point of the whole document:
  - **Conformant** — checked against a rule, and we match. The rule number is
    the evidence.
  - **Divergent** — checked, and we don't match. Must say why (deliberate
    scope cut, or an open bug).
  - **Unverified** — the behaviour exists and works, but nobody has confirmed
    it against the rules. **This is the default and there is a lot of it.**
- **Never upgrade a row to Conformant without a rule number.** A file that
  implies conformance it hasn't earned is worse than no file — that is exactly
  how end-of-turn healing stayed wrong through 372 passing tests.

### On the Java oracle

`A:\Projects\riftbound-engine` remains the best *implementation* reference in
this project — resolver structure, ordering, edge cases someone already hit.
It is **not** a rules authority: it has been wrong at least twice (Master Yi's
aura, which its own audit comment admits, and the combat-cleanup healing scope
this engine inherited). A grep of our source found **93** "Mirrors <the Java
oracle>" claims against **5** citations of an actual rules section. Those 93
are `Unverified`, not `Conformant`.

## Verified

| Rule | Behaviour | Rule # | Code |
|---|---|---|---|
| Damage healing timing | Heals at two moments only: end of each player's turn, and Combat Cleanup | 143.3 / 317.2 / 466.1 | `turn-manager.runEnd`, `combat.resolveShowdown` |
| Healing scope | Global — Combat Cleanup step 3c is literally "Heal all Units", not just combatants | 466 step 3c | `effect-helpers.healAllUnits` |
| Uncontested showdown | No Combat Cleanup, so no healing | 352 / 466 | `resolveShowdown` early return |
| "Do as much as you can" | Execute card text as far as possible, ignoring impossible instructions | ~100 | on-play triggers with no target; Back to Back at `min: 0` |
| Scoring: two methods | Hold (Beginning Phase) and Conquer, one score per battlefield per turn | 471.1 / 471.1.b | `scoring.scoreHolds`, `scoring.recordConquest` |
| Final point | Through a Conquer at Victory−1, only if every battlefield was **Scored** this turn (holds count); else draw 1 | 473 / 474 | `scoring.recordConquest` |
| Beginning Phase | Turn Player Holds all Battlefields they Control | 315.2.b.3 | `turn-manager.runBeginning` |
| Victory score | 8 points, and strictly more than the opponent, checked in a cleanup | 194.4 / 198.1 | `win-condition`, `constants` |
| Channel | 2 runes per turn, as many as possible if fewer remain | 315.4.b | `turn-manager.runChannel` |
| Control lapses | No units + Open State → control lost in the following Cleanup, unless a Combat/Showdown is ongoing **there** | 190.6 / 323.11 step 4 | `cleanup.runCleanup`, run after every action by `game-engine.withCleanupAndWinnerCheck`; `combat.resolveShowdown`'s mutual-wipe branch still covers the in-combat case |
| "Open State" | About the CHAIN, not about Showdowns — the four states are Neutral/Showdown × Open/Closed | 310 | `cleanup` gates on `chainOpen`; the Showdown exception is checked per battlefield against `showdownBattlefieldId` |
| Combat cleanup step 3d | Recall Attackers still present if Defenders remain — ordered after the 3c heal, so they arrive healed | 466 step 3d | `combat.resolveShowdown` → `effect-helpers.relocateToBaseUnchanged` |
| Recalls aren't Moves | A Recall relocates to base without being a Move: no move triggers, and damage/statuses untouched unless the source says otherwise | 454 | `relocateToBaseUnchanged` (no exhaust, no `dispatchOnMove`) |
| Post-combat control | Whoever still has units here establishes control if they didn't already; nobody → Uncontrolled; establishing control is a Conquer if unscored this turn | 466.7 / 469.1 | `combat.establishControlAfterCombat` |
| Units enter exhausted | Unless altered (Accelerate etc.) | 143.4.a | `execute-play-card` |
| Move destinations | Chosen when the spell/ability goes on the chain | Patch 2025-10-24 | `execute-play-card` chain entry (Recruit the Vanguard) |
| Chain resolution order | The **newest** finalized item resolves | 343 | `execute-pass-focus.resolveChainPass` pops LIFO |
| Finalizing | Does not pass priority; items finalize in the order appended | 338 | no priority change on `PlayCard` |
| Pass → Resolve | All players passing in sequence with nothing added → resolve | 340 | `chainPasses` reaching 2 (all players, in a 2-player game) |
| Priority after a partial resolution | Chain still non-empty → controller of the **newest** item gains priority | 345 | `resolveChainPass`'s `newTop` branch |
| Units/Gear finalize | Resolve immediately rather than waiting on the chain | 338 | Units/Gear deploy directly in `execute-play-card`, never entering `spellChain` |
| Turn order | Determined by "any fair random method", per game | 117.x | `game-setup.createNewGame` rolls `firstPlayerIndex` from its own rng stream; was hardcoded to player 0, so the human always went first |
| Turn counter | Turn order is a looping queue "starting with the First Player", so a round completes on returning to them | 118 | `turn-manager.runEnd` advances `turnNumber` on wrapping to `firstPlayerIndex` (was: to the literal index 0) |
| First Turn Process (1v1) | The player going **second** channels an extra Rune during their first Channel Phase — and 1v1 has NO first-player draw skip (that's FFA3's) | 486.1 / 487.4 (vs 488.1) | `turn-manager.runChannel` keys off `active !== firstPlayerIndex` (was: `active === 1`, i.e. the compensation went to whoever sat at index 1) |
| Mode: 1v1 Duel | Best of 1; each player's battlefield chosen **at random** from their three | 485.5 / 485.6 | `MatchConfig.format: "bo1"` → `chooseMatchBattlefields` |
| Mode: 1v1 Match | Best of 3, first to two Game Wins; each player **selects** their battlefield | 486.3 / 487.2 / 487.4 | `format: "bo3"` → `BattlefieldSelect` (human) + `rollAiBattlefield` (AI); series tracked in `GameBoard` |
| Match battlefield elimination | Battlefields used in a **decided** game are removed and cannot be presented again that Match | 487.3 | `pickBattlefield`'s `exclude`, fed by `SeriesState.human/aiUsedBattlefields`; per-side, since each player has their own pool |
| Combat damage assignment | Lethal in full to one unit before the next; never more than the minimum for lethal unless no units remain; lethal counts damage already marked | 465.2.c | `combat.distribute` — was already correct here; an earlier version of this file wrongly called it "even distribution" |
| `[Tank]` | "I must be assigned lethal damage before any other unit with the same controller as me that does not have [Tank]" | Tank keyword rule | `combat.assignmentOrder`, applied to both sides' target lists. 3 precon units carry it (Maddened Marauder, Lecturing Yordle, Stormclaw Ursine); it parsed into the model and changed nothing |
| Contested status | A destination becomes Contested if it's an Uncontested Battlefield **not controlled by** the mover; "Moves or otherwise becomes present" also covers played units and created tokens | 458 / 190.4 | `cleanup.applyContested`, called from the move, play-unit and token paths; reinforcing a battlefield you control applies nothing |
| Showdowns are staged in the Cleanup | Contested applies on the action; the Showdown opens in the following Cleanup, from a Neutral Open State, with Focus to whoever applied Contested | 316.9 / 341 / 345 | `cleanup.stageShowdowns`; previously each action opened one inline |
| Non-Combat Showdown | Entering a battlefield with no opposing units is a **stand-alone** Showdown that "does not create a Combat"; closing it establishes Control (a Conquer if unscored) | 317.1 / 352.1 | `showdownKind: "NonCombat"`; `combat.closeShowdown` → `resolveNonCombatShowdown`. Previously a walk-in claimed control instantly and no window ever opened |
| Combat Showdown | Contested between two players opens the Showdown "as the first step of Combat"; closing runs the remaining steps | 341 / 351.1 | `showdownKind: "Combat"` → the existing `resolveShowdown` (463/466 unchanged) |
| Non-Combat → Combat | A Non-Combat Showdown becomes a Combat Showdown in the following Cleanup if another player's units arrive | 317.2 | `cleanup.stageShowdowns`' promotion branch — reachable now that an opponent holding Focus can cast a token-making Spell into the window |
| Open vs Closed State | About the **Chain** only (a Chain exists → Closed), orthogonal to whether a Showdown runs; the four states are Neutral/Showdown × Open/Closed | 310 | `timing.mayPlayCardNow` and `cleanup` both gate on `chainOpen`, never on `turnState` alone |
| Timing permissions | Three tiers, both keywords **pure permission**: no keyword → Open State outside Showdowns, your turn; `[Action]` → **+ Showdowns, on any player's turn**; `[Reaction]` → all of Action **+ all Closed States** | 159 / 806 / 813 | `engine/timing.ts` — `timingTierOf` + `mayPlayCardNow`, used by BOTH `validate-play-card` and `legal-actions`. Covers **18 of 21 precon spells** (8 Reaction, 10 Action) plus one Reaction Unit |
| Reaction Unit destinations | A Unit with Reaction keeps a Unit's own restrictions: only your base or a battlefield you control | 813 | `timing.mayPlayUnitToBattlefield`, shared by the validator and the enumerator so a destination is never offered then refused |
| Who may act | Chain closed → Priority holder; Showdown → Focus holder; else the Turn Player | 313 / 348 | `timing.actingPlayerIndex` — one definition, consumed by `legal-actions`, the AI and the UI |
| Focus after a chain empties | During a Showdown, Focus passes to the next player when the chain empties; a cast is a turn-taking move in the window | 346 / 348 / 344.1 | `execute-pass-focus.resolveChainPass`'s Showdown branch; `execute-play-card` resets `consecutiveFocusPasses` so a cast breaks the all-passed sequence (349) |

## Divergent

| Rule | Should be | We do | Rule # | Status |
|---|---|---|---|---|
| Combat "No Result" re-stage | If No Result and both players still have units, stage another Showdown + Combat there | Resolve once | 466.5.d | **Out of scope, unreachable in 2-player**: step 3d removes the attackers exactly when defenders remain, so both sides can never still be present. Exists for multiplayer, where a third player's units can be there |
| Burn Out | Draw as many as possible → recycle trash into deck (randomised) → an opponent gains 1 point → finish the draw | Empty deck silently no-ops | 431 | Known gap, pre-dates this file. Its sharpest consequence: rule 474 withholds a Victory−1 Conquer point until every battlefield has been Scored that turn and gives a compensation draw instead — which on an empty deck silently does nothing, so that player gains neither. **Correction:** an earlier version of this row credited Burn Out as the cause of non-terminating games, measured at 2 of 40 self-play. The real cause was the control-lapse gap below (those boards had both battlefields controlled-but-unoccupied); with 190.6 implemented, **40/40 self-play and 16/16 passive games now terminate**. Burn Out remains a genuine gap, just not a demonstrated liveness bug |
| Damage assignment: `[Backline]` | "Assigned last" — the mirror of Tank | Not implemented | — | UNL-set keyword with no card in this pool; slots into `combat.assignmentOrder` as a second sort tier when that set lands |
| Damage assignment choice | The ASSIGNING player chooses freely within the constraints | Natural unit-list order within each Tank tier | 465.2.c | No interactive assignment UI; the order stands in for the choice |
| `[Deflect]` | "Opponents must pay 1 rainbow Power to choose me with a spell or ability" | Parsed into the keyword model, then ignored — spells targeting a Deflect unit cost their printed price | — | **Open, one precon card** (Pouty Poro). Needs a third cost dimension: a rainbow (any-domain) Power component that is NOT float-reduced and depends on the CHOSEN TARGET, so `legal-actions` must compute payment per target variant instead of once per card. Mirrors the oracle's `ActionExecutor.deflectSurcharge` + `beginPaymentExact`'s separate `rainbowPowerCost` |
| Cleanup loop | Cleanups repeat until one passes with nothing notable; Combat Cleanup is a Special Cleanup | Single pass | 318 / patch 2025-10-24 | Structural; immaterial for the current card pool |
| Simultaneous Showdowns | A Showdown is Staged at **each** Contested battlefield (cleanup step 6), so several can be pending | `showdownBattlefieldId` is a single field; the Cleanup opens one and leaves any other battlefield Contested for the next Cleanup | 323 / 341 | Only reachable via an effect that contests two battlefields in one action — none in this pool. The state stays correct (Contested persists and is staged later), it just can't run two windows at once |
| AI lookahead vs. responses | — | `heuristic-ai.settleDeferredResolution` settles each candidate assuming the opponent **passes** rather than responding | — | Not a rules divergence but a direct consequence of the timing work: that assumption was exactly true while nothing could be cast into a Showdown or onto a chain, and is now optimistic. The AI scores attacks and casts as though unopposed and will walk into removal it could have anticipated. Fixing it means modelling the opponent's best response (2-ply) |

## Traps that were filed for the timing work — all resolved

Kept as a record of what the trap list was for, since all four were real and
each would have been a silent mistake. Traps 1–3 are fixed; trap 4 came true
exactly as predicted and is now a tracked Divergent row rather than a warning.

1. ~~`isAction` never reaches the runtime~~ — `createCardInstance` now copies it
   onto `SpellInstance`. Pinned by a test that reads it off a real instance.
2. ~~Reaction implies Action, but the loader sets `isAction: false` for a
   `[Reaction]`-only card~~ — the tier is now *derived* (`timing.timingTierOf`)
   rather than the flags being tested at each call site. Pinned by a test
   asserting Gust is `{isReaction: true, isAction: false}` and still tier
   `Reaction`; reading `isAction` alone would have barred all 8 Reaction spells
   from Showdowns.
3. ~~`legal-actions`' Showdown branch already enumerates for `focusHolder` —
   extend that concept~~ — extended and extracted: `timing.actingPlayerIndex` is
   now the single definition, replacing three copies. It also fixed a latent
   ordering bug: the old code tested `turnState === "Showdown"` *before*
   `!chainOpen`, which would have enumerated for the Focus holder when rule 313
   gives priority to the chain.
4. **The AI's lookahead assumes the opponent doesn't respond** — came true. Now
   a Divergent row above, with the 2-ply fix named as its own piece of work.

Two more worth recording, both found only by running the thing:

- **Enumeration and validation must share every gate, not just the tier.** The
  813 destination rule lived only in the validator at first, so `legalActions`
  offered a `[Reaction]` Unit a reinforce destination the validator then refused
  — and the AI, which trusts `legalActions` and calls executors directly, threw
  mid-game. Both now call `timing.mayPlayUnitToBattlefield`.
- **Anything that applies actions outside `submit` must run the Cleanup too.**
  `heuristic-ai.applyAction` called executors bare, so once Showdowns were
  staged in the Cleanup the AI could no longer see one open — it would have
  stopped walking onto empty battlefields entirely, and looked like a bad
  evaluator rather than a missing cleanup.

## Unverified (the honest bulk)

Everything else, including all 93 oracle-mirrored behaviours. Highest-value
targets for the next pass, by blast radius:

1. **Showdown/Combat step order** — rule 463's steps, HOT FEPR, and when the
   Attacker/Defender designations attach. Two divergences already found here.
2. **Costs and payment** — floating resources, rune recycling, exhaust-vs-recycle
   (rule 430 and neighbours).
4. **Triggered abilities** — the patch notes changed Attack/Defend triggers to
   *once per combat, the first time* (a change from prior FAQ guidance). We
   fire per unit on move/play into a contested battlefield; unverified.
5. **Does Hold mean Control, or occupation?** Rules 315.2.b.3 ("The Turn
   Player Holds all Battlefields they **Control**") and 471.1.a ("maintains
   Control of a Battlefield they did not yet Score this turn") both define Hold
   by *Control*. `scoring.isHeldBy` instead requires the player to have units
   present AND no opponent units there. Implementing the control lapse (323.11
   step 4) closed most of the gap — in an Open State, Control now implies
   occupation — but the "no opponent units" half is still a real potential
   divergence: a contested battlefield you control but that an enemy unit is
   standing on scores under the rules' wording and not under ours. Left alone
   deliberately rather than changed on judgment: `isHeldBy` mirrors the Java
   oracle, switching it to read `controllerId` would let an abandoned
   battlefield score, and the lingering-contested state may simply be
   unreachable (Contested stages a Showdown, which re-establishes control).
   Needs a reachability check before anyone touches it.
6. **Does a card-driven recall exhaust?** Rule 454 says a Recall leaves
   statuses untouched, and Highlander spells out "exhaust it" precisely because
   the recall alone wouldn't. But `effect-helpers.recallUnitToBase` force-
   exhausts, and it backs **Flash** ("Move up to 2 friendly units to base") and
   **Maddened Marauder** ("move a unit from a battlefield to its base") — both
   of which say *move*, not *recall*, and neither mentions exhaustion. Combat
   cleanup's own recall was given a separate state-preserving helper rather
   than changing these on a guess. Also covers the player-initiated
   `RecallUnit` action (`execute-recall-unit.ts`), which exhausts too.

## Card errata

Origins first batch: **31 cards**, of which **3** are in the four Proving
Grounds precons. Our card-data snapshot (`packages/engine/src/cards/*.json`)
was confirmed **post-errata** for all three on 2026-07-29:

| Card | Errata | Ours |
|---|---|---|
| Disintegrate | "If this kills it, **do this:** draw 1" | post-errata; implementation checks whether it actually died |
| Dune Drake | "+2 **this turn**" | post-errata; `bonus` is turn-scoped |
| Highlander | "the next time it **would** die … **heal it, exhaust it,** and recall it" | post-errata; `death-ward.ts` does heal → exhaust → recall |

The other 28 are outside our pool. Spiritforged has its own errata — not
applicable, our card base is OGN + OGS.

## Log

| Date | Event |
|---|---|
| 2026-07-29 | Core Rules 2026-07-16 added locally; this file created. Confirmed healing (both moments, global). Found and fixed the final-point rule counting conquests instead of scores, and conquests re-scoring the same battlefield. Filed combat steps 3d / 466.5 as open bugs. Corrected an earlier wrong claim that mutual-wipe control was divergent — rule 190.6 makes our end state right. |
| 2026-07-29 | Audited the chain against rules 337-345: FEPR is conformant in every essential (LIFO resolution, finalize doesn't pass priority, all-passed → resolve, priority to the newest item's controller, Units/Gear resolving immediately) — no code changes needed. So reaction-speed is blocked by *permission checks*, not by chain machinery. Pinned the timing model (806/813) and corrected the affected-spell count from 7 to **18 of 21**. Filed three implementation traps. |
| 2026-07-29 | Built the chain viewer (`ChainView` + the engine's `describeChain`), so rule 343's LIFO order is now *shown* rather than inferred — `state.spellChain` previously reached the UI nowhere at all. No rules behaviour changed. |
| 2026-07-29 | Randomized turn order per game (rule 117.x — it was hardcoded to player 0, so the human always went first) and added the Best-of-1 / Best-of-3 lobby option, which is really the choice between the two sanctioned 1v1 modes: Duel (485.3-486.1) and Match (486.3-487.4). Randomizing required a real `firstPlayerIndex` on GameState first: BOTH the going-second Channel bonus and the turn counter tested against literal indices, so without it the compensation rune would have gone to the player going *first* and `turnNumber` would have miscounted. Implemented 487.2's per-game battlefield selection and 487.3's elimination across a Match. Six new tests fail against the old literal-index code. |
| 2026-07-30 | Taught the AI's evaluator to see marked damage (`DAMAGE_WEIGHT`), from a playtest report that it aimed Singularity at its own unit. Root cause: `effectiveMight` ignores `damage`, so only LETHAL damage scored — every non-lethal hit was exactly 0, making all four target choices a tie, and ties fall to enumeration order, which lists base units before battlefield ones. Weighted **below** a point of Might on purpose, so damage breaks ties but can never outbid a kill (chip 6 onto an 8-Might unit = +1.5; killing a 4-Might unit = +4) — full weight would prefer chip damage that heals at end of turn over permanent removal. Third instance of one family: `Pass` winning ties, attacks scoring 0, now targets tying. Spell casts 264 → 313, termination still 40/40. |
| 2026-07-30 | Fixed 3 of the 4 precon card gaps: Lecturing Yordle's "draw 1" and Stormclaw Ursine's "channel 1 rune exhausted" (both silently doing nothing — new `channelRunesExhausted` helper, since the Channel *Phase* always reveals Ready), and `[Tank]`'s damage-assignment order. `[Deflect]` deliberately left open — see its Divergent row; it needs a target-dependent rainbow-Power cost dimension, which is a bigger change than the other three combined. Also **corrected this file**: the damage-assignment row claimed "even distribution, no ordering", but `combat.distribute` already implemented 465.2.c's lethal-first-and-capped model correctly — only the Tank ordering was missing. 5 of the 8 new tests fail without the fixes. |
| 2026-07-30 | Audited card-effect coverage: of 288 playable OGN+OGS cards, 255 carry real rules text (33 are keyword-only), **40 implemented and 215 silently inert** — of which **210 are outside the precons**. The four precon decks are near-complete: only Lecturing Yordle's "draw 1" and Stormclaw Ursine's "channel 1 rune exhausted" don't fire (both verified by simulation), plus the unimplemented `[Tank]` (3 precon units) and `[Deflect]` (1). Note a silently-inert card is indistinguishable from a working one in play — the honesty problem this file exists for, one level down. |
| 2026-07-29 | Implemented Non-Combat Showdowns and `[Action]`/`[Reaction]` timing — one epic, because they're one mechanism: rule 317.2.d makes a Showdown "a structured Window of Opportunity where Players may play cards with Action or Reaction", so the empty-battlefield Showdown IS the venue Action speed needs. Contested became real state (458/190.4) applied by the move, play-unit and token paths; the Cleanup stages the Showdown (316.9/341) and decides its kind; closing dispatches to Combat (351.1) or to 352.1's control establishment. Timing collapsed three hard gates in `validate-play-card` into `engine/timing.ts`, now shared with `legal-actions`. Measured: AI spell casts **102 → 264** per 40 games, and chain depth **1 → 4** — genuinely stacked chains, which the chain viewer was built for and had never had to render. Termination held at 40/40 self-play and 16/16 passive. All four filed traps resolved or promoted; two new ones recorded. |
| 2026-07-29 | Implemented the Cleanup's control-lapse step (`engine/cleanup.ts`, rule 323.11 step 4 / 190.6) after hitting the resulting freeze live. Control was previously only ever lost through combat's mutual-wipe branch, so moving or recalling your last unit away left a battlefield controlled-but-unoccupied — a state the rules don't allow, and a scoring dead end (its controller can't Hold it, since `isHeldBy` needs units present, and can't Conquer it, since they already control it). Two battlefields in that state plus empty rune decks froze the game. Fixed: **passive games 6/16 stalled → 0/16; self-play 38/40 → 40/40 terminating**, 0 invalid actions. Confirmed beforehand that it was NOT an AI regression — reproduced identically with and without the lookahead fix, same seeds and turn numbers. Four of the ten new tests fail without the lapse. Also corrected the Burn Out row, which this had been wrongly blamed on. |
| 2026-07-29 | Fixed the AI's blindness to deferred resolution, found while verifying the chain viewer (the AI-cast case needed a throwaway patch to demo at all). Both of this engine's payoffs land behind PassFocus, so scoring the state produced by applying ONE action rated a winning attack at a median of **0** and a Spell at **exactly 0** — and ties fall to `Pass`, which `legal-actions` pushes first. `chooseAction` now settles each candidate's chain/Showdown before `evaluate`. Measured over the same self-play seeds: Spell casts **0 → 87** per 40 games (13 distinct cards); Showdowns opened **3 → 41** per 12 games; winning attacks taken **0 → 25** of 41 offered. It cuts both ways by design — a losing attack settles as low as −7, so the AI now declines bad fights. Three engine tests added that each fail without the change. |
| 2026-07-29 | Implemented cleanup step 3d (recall attackers when defenders remain) and rewrote post-combat control as rule 466.7's single "who remains" question, replacing a three-way survivor branch that had no answer for "both survived". Established that 466.5.d cannot occur in 2-player and closed it as out of scope rather than building an unreachable combat loop. Filed the card-recall exhaust question as Unverified. |
