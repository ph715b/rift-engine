# SFD — finishing the set (SUPERSEDED)

> **SUPERSEDED on 2026-08-07 by `docs/sfd-final-18-prompt.md`.**
> All six phases below are DONE (138/198 -> 180/198, commits `5086879`..`ce09875`).
> Every figure in this file is stale, and two of its premises were measured wrong:
> Phase 3's play-SOURCE field lights up three fewer cards than claimed (every
> non-hand play path already bypasses pricing), and Phase 4's compound-`[Equip]`
> note blamed the regex when the blocker was an em dash. Its "definition of done"
> also contains a contradiction — see the new prompt. Kept for the reasoning in
> its per-phase notes, which is still good; do not trust its numbers.

**This is the prompt for the session that finishes Spiritforged.** It supersedes
every earlier handoff in `docs/`; those numbers are stale by construction.

Written 2026-08-07 at `HEAD`, and **every figure was measured at that commit,
not carried forward**. Re-measure before planning anyway — this repo's handoffs
have gone stale faster than they have gone wrong, and a stale number has changed
the plan every time it was believed.

## Read first, in this order

1. `docs/rules-conformance.md` — the Divergent and Verified tables, and the Log's
   top ~8 entries. **Re-read what it already claims before adding to it.**
2. `docs/Riftbound Core Rules Updated 2026-07-16.pdf` — the authority. Extract it
   to text once and grep it; it repeatedly uses the card in question as its own
   worked example.
3. `docs/sfd-equipment-abilities.md` — the art-only transcriptions. Nothing in it
   is in the card JSON, and re-deriving it costs 31 image fetches.
4. The memory index at `~/.claude/projects/a--Projects-Rift-Engine/memory/`.

Everything else in `docs/` predates today and its numbers are superseded.

## Measured state

| | |
|---|---|
| OGN | **248/248** (complete, hard-gated) |
| OGS | **22/22** (complete, hard-gated) |
| SFD cards | **138/198** |
| SFD battlefields | **15/15 — COMPLETE and hard-gated** |
| SFD legends | **12/12 — COMPLETE** |

Engine **2707 tests across 169 files**, web 100. Typecheck 0 errors across both
workspaces, both builds green, all five probes green with walkout pinned at
**191/107/32**, `DECKS=sfd` 0 invalid.

**60 cards remain: 47 unimplemented and 13 partial**, and every one of them is
named in a phase below — checked mechanically against
`isCardImplemented`/`partialImplementationNote` rather than by eye, because the
first draft of this plan silently dropped six. They are planned out below
in six phases. The phases are ordered by VALUE PER UNIT OF WORK, not by card
number, and each is sized to be one commit.

## How to use this plan

**Work by MECHANISM, never by card.** That is the single thing that made the last
stretch cheap: one piece of shared work clears three or four cards, and the
per-card part collapses to a registry entry. Every phase below names the DOOR —
the one function or table the work goes through — because finding the door is
most of the job and it is already found here.

**Before starting any phase, do the stale-note sweep.** Re-read every
`PARTIALLY_IMPLEMENTED` note in the phase whose text names a MECHANISM ("needs
X", "cannot express Y", "no table models Z") and grep for X. **Four for four have
been wrong so far** — the rainbow `[Equip]` cost, Rumble - Hotheaded's keyword
aura, Forge of the Fluft's "no table models it", and Jax - Unmatched, who worked
in play and reported unimplemented because an orphaned `equipmentDefIds()` was
written for coverage and never called. Notes naming missing CARD TEXT (art-only
clauses) do not rot this way; notes naming missing ENGINE do.

**Run `DECKS=sfd node probes/exercised.ts` after every phase, not at the end.**
It has now found five bugs the suite structurally could not, and the last two
were PRE-EXISTING code made reachable by a new card — a counter that left the
chain closed and empty, and an optional-cost branch that never priced
`[Deflect]`. When it throws, instrument the state; do not assume the card you
just wrote is the author.

---

## Phase 1 — the free ones (9 cards, ~1 commit)

Every card here rides a mechanism that already exists and needs a registry entry
and tests, nothing more. Do this phase first: it is the largest count for the
least risk, and it leaves the count in a good place if the session is cut short.

| Card | Rides |
|---|---|
| **SFD-142 Jae Medarda** — "when you choose me with a spell, draw 1" | `unitChosen`, already fired from both choosing paths |
| **SFD-144 Spirit Wheel** — "when you choose a friendly unit, you may pay [1] and exhaust this to draw 1" | `unitChosen` + a paid decision (Jax - Unrelenting's `SFD-119-draw` is the shape) |
| **SFD-180 Fiora - Worthy** — "when a unit you control becomes [Mighty], you may pay [Order] to ready it" | `unitBecameMighty`, built for Fiora - Grand Duelist |
| **SFD-100 Yordle Explorer** — "when you play a card with Power cost [rainbow][rainbow] or more, draw 1" | `cardPlayed` + the card's printed `powerCost` |
| **SFD-046 Poro Snax** — "when you play this, draw 1. [1][Calm], Exhaust, Kill this: Draw 1" | a Gear self-trigger (Scrapheap) + `killSelf` activation cost, both existing |
| **SFD-074 Pickpocket** — on-play, may kill a gear costing ≤[1], if you do play a Gold | a parked decision + `killGear` + `placeGoldTokens` |
| **SFD-089 Rumble - Scrapper** — "your Mechs have +1 Might (including me). When I hold, play a Mech token" | a tribal Might aura (`isMech`) + a hold trigger + `MECH_TOKEN` |
| **SFD-068 Gearhead** — "each Equipment attached to me gives DOUBLE its base Might bonus" | `equipmentMightBonusFor`, per wearer |
| **SFD-131 Ancient Warmonger** — "[Assault] equal to the number of enemy units here" | the VALUED keyword form (Volibear - Furious prints one) |

**Watch:** Rumble - Scrapper's aura says "INCLUDING me", which is the opposite of
every other aura in `KEYWORD_AURAS` — those print "other friendly units" and
exclude themselves as a class. Sett - Kingpin is the precedent for the inclusive
reading. Gearhead doubles the BASE bonus (the art-only `equipMightBonus` table),
not the total, so a stacked buff is not doubled.

## Phase 2 — the "chosen" cluster (4 cards + 1 mechanism)

**The door:** a chooseability filter, asked in ONE place that both the enumerator
and the validator go through. There is none today. `deflectSurchargeForTargets`
shows where the two ask about a target, and `eligibleTargets` / `unitOrGearTargets`
are the walks the enumerator fans out from.

- **SFD-105 Ruin Runner** — "I can't be chosen by enemy spells and abilities." The
  filter itself. Absolute, not a tax, so it is a different question from
  `[Deflect]` and must not be bolted onto it.
- **SFD-141 Irelia - Graceful** — "your spells that CHOOSE me cost [1] or
  [rainbow] less." A cost modifier keyed on the target, so it needs the price to
  be computed per VARIANT — which `legal-actions` already does for `[Deflect]`.
- **SFD-045 Not So Fast** — "counter an enemy spell or ability that chooses a
  friendly unit or gear." `counter-spell.ts` exists; the new part is the FILTER on
  what may be countered.
- **SFD-049 Aphelios - Exalted** — three modes on a TRIGGER, each usable once per
  turn. `modesOncePerTurn` exists for ACTIVATED abilities (`abilityModesUsedThisTurn`
  on the unit); this wants the same per-source record reached from a trigger.
  Rides `equipmentAttached`, which now exists.

**Watch:** Ruin Runner is the classic enumerator/validator split — one door or it
will be offered and then refused. Write the negative through BOTH.

## Phase 3 — play SOURCE, and playing from elsewhere (6 cards + 1 mechanism)

**The door:** the engine has no concept of WHERE a card is being played from.
`fromHidden` is the only approximation and it is a boolean on one path. Six cards
want it, so it is worth a real field on the play action.

- **SFD-010 Void Drone** and **SFD-164 Drag Under** — "costs [2] less to play from
  anywhere other than your hand."
- **SFD-029 Rek'Sai - Breacher** — "friendly units played from anywhere other than
  a player's hand have [Accelerate]."
- **SFD-140 Fizz - Trickster** — play a spell from your TRASH ignoring its Energy
  cost, then recycle it.
- **SFD-084 Jayce - Man of Progress** — kill a friendly gear, then play a gear from
  HAND ignoring its Energy cost this turn (a lasting permission, not an immediate
  play).
- **SFD-165 Glasc Mixologist** — `[Deathknell]`: play a unit from your trash
  ignoring its cost.

`play-free.ts`'s `playCardIgnoringCost` already exists and already has the
"a SPELL played this way resolves IMMEDIATELY" note. Jayce is the odd one:
his is a permission that lasts the turn, so it wants a `PlayerState` flag, not a
resolution-time play.

## Phase 4 — additional costs and X costs (6 cards + 2 mechanisms)

Two doors, both extensions of tables that exist.

**Play-side additional costs that are not Power** (`OPTIONAL_POWER_COSTS` handles
Energy and runes as of `ac1deac`; these are costs paid in PERMANENTS or cards):
- **SFD-160 Zaun Punk** — "you may kill a friendly gear as an additional cost."
- **SFD-044 Legion Quartermaster** — "as an additional cost, return a friendly
  gear to its owner's hand." Mandatory, not optional, which is a different shape.
- **SFD-079 Bard - Mercurial** — "you may exhaust your LEGEND as an additional
  cost."
- **SFD-109 Akshan - Mischievous** — his `[Body][Body]` half is ordinary optional
  Power and works today; his payoff is Phase 6.

`ActivationCost` already models `killFriendlyPermanent` and `discard` for
ABILITIES, with `activationCostChoices` fanning them out as an axis. The play path
needs the same shape. Read that pair before designing anything.

**X costs on abilities** (`hasXRainbowCost` exists for Bullet Time, a SPELL):
- **SFD-083 Hextech Anomaly** — "pay any amount of [rainbow] to [Add] that much
  Energy."
- **SFD-117 Ancient Henge** — "pay any amount of Energy to [Add] that much
  [rainbow]."

Both are `banksResource`, so the AI will not take them — flag them as such, like
the Seals and Kai'Sa, rather than inventing a heuristic.

**Compound `[Equip]` costs** — the last two the parser deliberately refuses.
`EQUIP_COST_PATTERN` will not half-read them on purpose, because a looser pattern
would hand the card an ability costing only the rune, which is strictly CHEAPER
than printed and is the one direction this codebase never ships:
- **SFD-150 Last Rites** — a rune AND Recycle 2 from your trash. (Its art-only
  "when I conquer or hold, play a unit from your trash" is a separate half, and
  rides `wearerListener` — see Phase 6.)
- **SFD-178 Blade of the Ruined King** — a rune AND kill a friendly unit.

Both extras already exist as ACTIVATION costs (`recycleFromTrash`,
`killFriendlyPermanent`), so this is a parser change plus wiring, not a new cost
model. One change clears both.

**SFD-019 Assembly Rig** belongs here too — "[1][Fury], Recycle a UNIT from your
trash, Exhaust: play a 3 Might Mech token to your base". `recycleFromTrash` exists
but takes a count, not a filter; a unit-only recycle is the extension, and
`MECH_TOKEN` is already shared.

## Phase 5 — the per-turn counters (4 cards)

Each needs one new `PlayerState` field, cleared in `turn-manager.runEnd` beside
the dozen already there. Grouped because the field is the whole job and the shape
is identical.

- **SFD-055 Needlessly Large Yordle** — "costs [2][Calm] less for each point you
  scored FROM HOLDING this turn." Note it reduces Energy AND Power, and
  `modifiedEnergyCost` is Energy-only; the Power half is a separate line in
  `validate-play-card`'s cost computation.
- **SFD-143 Sivir - Mercenary** — "if you've SPENT at least [rainbow][rainbow]
  this turn, +2 Might and [Ganking]." A Power-spent tally.
- **SFD-166 Rally the Troops** (partial) — "when a friendly unit is played this
  turn, buff it." A delayed trigger, so the flag is read at the PLAY site.
- **SFD-149 Ezreal - Prodigy** — "optional additional costs you pay cost [1] or
  [rainbow] less." Not a counter but the same file; it discounts the Phase 4
  work, so do it after.

## Phase 6 — the genuinely new mechanisms (11 cards)

Everything left needs something the engine has never modelled. Each is its own
commit and its own decision about whether it is worth it. Ordered cheapest first.

1. **Prevention** — **SFD-194 Counter Strike** ("the next time that unit would be
   dealt damage this turn, prevent it"). `preventsSpellDamageThisTurn` exists as a
   per-player flag; this is per-UNIT and once.
2. **Death replacement from a non-legend source** — **SFD-173 Soraka - Wanderer**
   and **SFD-051 Guardian Angel** (partial). `death-ward.ts` has both the free and
   the paid shape; these are a unit-sourced and a gear-sourced one.
3. **Multi-destination placement** — **SFD-168 Vanguard Armory** (three Recruit
   tokens, "you may play them to different locations") and **SFD-198 Arise!** (a
   Sand Soldier per Equipment, then ready up to two). Both want a per-token
   destination axis.
4. **Move any number** — **SFD-079 Bard - Mercurial**'s payoff, **SFD-184
   Relentless Pursuit** (move + attach + a granted delayed ability).
5. **Prior controller on a conquer** — **SFD-116 Yone - Blademaster** ("when I
   conquer a battlefield that WAS UNCONTROLLED"). Check whether the conquer event
   carries it before designing; it may be a two-line addition.
6. **Gear control** — **SFD-109 Akshan** ("move an enemy gear to your base. You
   control it until I leave the board"). Control that EXPIRES on a condition;
   `takeControlOfUnit` is permanent and has no expiry.
7. **Play restrictions keyed by CARD** — **SFD-015 Perched Grimwyrm** ("play me
   only to a battlefield you conquered this turn") and **SFD-025 Rengar -
   Pouncing** ("I can be played to a battlefield you're attacking").
   `mayPlayUnitAt` is battlefield-keyed; these are card-keyed, and Grimwyrm also
   needs a per-turn conquered-battlefield list.
8. **Reveal hooks** — **SFD-018 Void Hatchling** ("if you would reveal cards from a
   deck, look at the top card first") and **SFD-175 Undertitan** (partial, "as I'm
   revealed from your deck"). `top-of-deck.ts` is the neighbour.
9. **Location swap** — **SFD-050 Azir - Ascendant** (swap places with a unit you
   control, once per turn).
10. **Take control of a unit mid-combat** — **SFD-202 Hostile Takeover**.
11. **The three art-only Equipment halves.** Their `[Equip]` costs work; the
    ability printed on the ART does not. All three are transcribed in
    `docs/sfd-equipment-abilities.md` — **SFD-190 Forgefire Cape** ("when I attack
    or defend, deal 2 to ALL enemy units here" — rides `wearerListener`, which
    exists and already serves eight cards, so this may be the cheapest card in
    Phase 6), **SFD-191 Rabadon's Deathcrown** ("your spells and abilities deal 3
    Bonus Damage while this is attached" — a `damage-modifiers.ts` entry gated on
    attachment), **SFD-192 Shurelya's Requiem** ("your units HERE have [Ganking]"
    — a positional aura sourced from the gear's WEARER, which `KEYWORD_AURAS`
    cannot express today: its sources are unit, gear and legend, and none of them
    is "wherever my wearer is standing").
12. **The singletons** — **SFD-011 Angle Shot**, **SFD-107 Strike Down**,
    **SFD-024 Rell - Magnetic**, **SFD-075 Prize of Progress**, **SFD-088 Renata
    Glasc - Mastermind**, **SFD-135 Factory Recall**, **SFD-146 Vex - Cheerless**.
    Each wants one small thing: a gear→hand bounce, an `abilityActivated` event, a
    two-target attach/detach spec, an activated ability that SCORES, an asymmetric
    cost aura. None is hard; none shares a door with another, which is why they
    are last rather than first.

## The five recommended NOT to do

These are recorded as PARTIAL with a note, and each needs a subsystem out of
proportion to one card. **Leave them, and say so in the final report** rather than
half-implementing:

- **SFD-059 Svellsongur** — copies a unit's text onto an Equipment. Nothing in the
  engine models text copying.
- **SFD-030 Skyfall of Areion** — "my hold effects are also conquer effects, and
  vice versa." A moment-rewriting layer with no precedent.
- **SFD-090 The Zero Drive** — "play all units banished WITH THIS." Needs
  banish-with-source tracking.
- **SFD-073 Experimental Hexplate** — "I am a Mech" grants a TAG; `tags` is
  printed-only and four auras read it.
- **SFD-042 Brutalizer** — "if this was attached to me THIS TURN" needs a
  per-attachment turn stamp on the gear.

## Definition of done

- `SFD: N/198` from `test/set-coverage.test.ts` reports every card either
  implemented or carrying a partial note that names MISSING CARD TEXT, never
  missing engine.
- The five NOT-to-do cards are the only ones left, and
  `docs/rules-conformance.md` records why.
- Every phase ended with the full loop green and `DECKS=sfd` at 0 invalid.
- When SFD's cards are complete, add `"SFD"` to `coverage.COMPLETE_SETS` — the
  gate demands it, and `SetCoverage.finishedButUndeclared` will fail the suite
  until it is there. (Its battlefields are already in
  `COMPLETE_BATTLEFIELD_SETS`, which is a separate list for a separate schedule.)

## The verification loop — run in this order, every time

```
npx vitest run                      # in packages/engine
npm run build --workspace=@rift-engine/engine   # BEFORE the typecheck
npm run typecheck                   # both workspaces
npm run build
node probes/{ai-health,passive-human,chain-depth,walkout,exercised}.ts
DECKS=sfd node probes/exercised.ts  # for SFD work specifically
```

Step 2 is not optional: `@rift-engine/web` resolves the engine from `dist`, so
skipping it typechecks the web app against a stale engine and passes when it
should not.

**Read the typecheck output to the END.** It sat red with 12 errors for an
unknown period because the engine's `build` tsconfig excludes tests while
`typecheck`'s includes them — the build stayed green and nobody scrolled. If it
is red, diff the error list against HEAD (`git stash`, capture
`grep "error TS" | sort`, restore, capture, `comm -13`) before assuming the
errors are yours.

## Standing constraints

- **Never bulk-edit source with PowerShell.** A python round-trip with explicit
  `utf-8` and `newline=""` is safe. The repo is CRLF, so a multi-line search
  string joined with `\n` will silently not match — normalise to the file's own
  ending and `assert` every replacement.
- **Scratch files go in the session scratchpad, never beside the source.**
- **Prove every fix by making the check fail first**, and when you prove
  something by mutation, **grep for the marker to confirm the mutation applied**.
  A mutation that does not fail has tested nothing.
- **Fix the PREMISE, never weaken the assertion.**
- **Never rebuild an action field by field.**
- **Record divergences in `docs/rules-conformance.md` in the same change.**
- **Re-read the CODE before believing a note about the code** — and, as of today,
  re-read the RULES before believing a note about the rules (see `[Repeat]`).
- Commit per task with a real message, and push.
- Agents must not run `npm run build` / `npm run typecheck` — the `dist` is
  shared. Only the central owner runs the full loop. Fan agents out over
  DISJOINT per-domain effect files (`effects/{fury,chaos,order,mind,body,calm,
  signature}.ts`), which `mergeRegistries` makes parallel-safe by throwing on a
  duplicate defId. Every other file is single-owner.


## Known gap, player-facing

The UI has no way to pick WHICH spell on the chain to counter — it takes the
first matching candidate. Pre-existing and shared with Wind Wall, Defy, Mystic
Reversal and Riposte's spell half. Harmless with one spell waiting; arbitrary
with two or more. Fixing it means making chain items clickable in the viewer.
**Not So Fast (Phase 2) will be the second card to want it** — it counters a
spell chosen by a filter, and with two candidate spells on the chain the UI has
no way to say which.
