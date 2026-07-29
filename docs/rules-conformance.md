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
| Control lapses | No units + open turn → control lost in the following cleanup, unless a Combat/Showdown is ongoing | 190.6 | `combat.resolveShowdown` mutual-wipe → uncontrolled |
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

## Divergent

| Rule | Should be | We do | Rule # | Status |
|---|---|---|---|---|
| Combat "No Result" re-stage | If No Result and both players still have units, stage another Showdown + Combat there | Resolve once | 466.5.d | **Out of scope, unreachable in 2-player**: step 3d removes the attackers exactly when defenders remain, so both sides can never still be present. Exists for multiplayer, where a third player's units can be there |
| Burn Out | Draw as many as possible → recycle trash into deck (randomised) → an opponent gains 1 point → finish the draw | Empty deck silently no-ops | 431 | Known gap, pre-dates this file |
| Damage assignment | Mandatory assignment order, Tank ("assigned damage first") / Backline ("last"), and unfulfillable combinations | Even distribution, no ordering | 466.1.a | Known gap (`combat.ts` says so) |
| Timing permissions | Three tiers, both keywords **pure permission**: no keyword → your turn + open state; `[Action]` → **+ showdowns, on any player's turn**; `[Reaction]` → + all of Action **+ closed states** | 806 / 813 | **The largest remaining gap.** `validate-play-card` rejects every cast during a Showdown or closed chain and requires `playerIndex === activePlayerIndex`, which must become "whoever holds priority/focus" since both keywords say *any player's turn*. Affects **18 of 21 precon spells** (8 Reaction, 10 Action) — not the 7 previously claimed here. Also blocks Cannon Barrage entirely |
| Focus after a chain empties | During a Showdown, focus passes to the next player unless the chain was started by a triggered ability or a resource-adding ability | 344.1 | Unreachable today (nothing can be cast into a Showdown); **required** by the timing work above |
| Cleanup loop | Cleanups repeat until one passes with nothing notable; Combat Cleanup is a Special Cleanup | Single pass | 318 / patch 2025-10-24 | Structural; immaterial for the current card pool |

## Traps for the timing work

Found while verifying the chain; each would be an easy, silent mistake:

1. **`isAction` never reaches the runtime.** `card-loader` parses it onto
   `SpellDefinition`, but `SpellInstance` carries only `isReaction` — and a
   `PlayCardAction` holds the *instance*. Action-speed can't even be checked
   until this is plumbed through.
2. **Reaction implies Action** (813: "grants all abilities and permissions of
   Action"), yet the loader sets `isAction: plain.includes("[Action]")`, so a
   `[Reaction]`-only card has `isAction: false`. Any showdown-permission check
   must read `isReaction || isAction`, or all 8 Reaction spells are wrongly
   barred from showdowns.
3. **`legal-actions`' Showdown branch already enumerates for
   `state.focusHolder`**, not the active player. The "whoever may act right
   now" concept exists — extend it rather than inventing one.

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
5. **Does a card-driven recall exhaust?** Rule 454 says a Recall leaves
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
| 2026-07-29 | Implemented cleanup step 3d (recall attackers when defenders remain) and rewrote post-combat control as rule 466.7's single "who remains" question, replacing a three-way survivor branch that had no answer for "both survived". Established that 466.5.d cannot occur in 2-player and closed it as out of scope rather than building an unreachable combat loop. Filed the card-recall exhaust question as Unverified. |
