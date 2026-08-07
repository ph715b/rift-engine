# SFD continuation — session prompt

Written 2026-08-06 at `a2916a1` and **updated 2026-08-06 at `250add8`**, when the
whole ordered work list below was finished. **Every figure below was re-measured
at `250add8`, not carried forward.** Re-measure before planning; this repo's handoffs have gone
stale faster than they have gone wrong, and a stale number has changed the plan
every time it was believed.

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

## Measured state at `62d6845`+

| | implemented |
|---|---|
| OGN | **248/248** (complete, hard-gated) |
| OGS | **22/22** (complete, hard-gated) |
| SFD cards | **135/198** |
| SFD battlefields | **15/15 — COMPLETE, and now hard-gated** |
| SFD legends | **12/12 — COMPLETE** |

Engine **2694 tests across 168 files**, web 100. Typecheck 0 errors across both
workspaces, both builds green, all five probes green with walkout pinned at
**191/107/32** and `DECKS=sfd` at 0 invalid.

**13 SFD cards carry a partial note.** `partialImplementationNote(def)` says what
each is missing; that list is the honest backlog and is more useful than the
120/198 headline.

### The battlefield gate now has its OWN completeness list

`COMPLETE_BATTLEFIELD_SETS` (coverage.ts), separate from `COMPLETE_SETS`. A set's
battlefields finish on their own schedule — SFD's last one landed with 78 cards
still open — so gating them on the card list meant either leaving 15 finished
battlefields unprotected or declaring the set complete while it is not. All 39
battlefields in the pool are under a hard gate for the first time.

## What is left — 67 cards, and how to attack them

The ordered list below is DONE through item 6. Since then the work has been
CLUSTERED BY MECHANISM rather than by card, which is what makes it cheap: one
piece of shared work clears three or four cards, and the per-card part is a
registry entry.

Clusters already cleared, for the shape:
- optional additional costs (`OPTIONAL_POWER_COSTS` now carries an Energy half) —
  Blast Corps Cadet, Frostcoat Cub, Sea Monkey;
- gear-touching spells and abilities — Detonate, Heart of Dark Ice;
- one-door restrictions — Minotaur Reckoner, through `mayMoveToBaseFrom`.

Clusters still open, biggest first — each is a survey away from being a wave:
- **cost REDUCTION** — half done. Battering Ram, Jaull-Fish and Production Surge
  landed through `modifiedEnergyCost`, which is the door and takes a defId, so a
  self-scaling cost is now a branch and a constant. **Left: Void Drone and Drag
  Under** ("less from anywhere other than your hand" — needs the play SOURCE,
  which that function is not given, and the reachable cases want a survey before
  a guess), **Needlessly Large Yordle** (reduces Energy AND Power, and needs
  points-scored-from-holding-this-turn), **Irelia - Graceful** and **Ezreal -
  Prodigy** (both modify OTHER cards' costs, not their own), **Vex - Cheerless**
  (asymmetric, and conditional on being in combat).
- **`[Weaponmaster]` units** (4): Ornn - Forge God, Yone, Jax - Unrelenting,
  Akshan. The keyword works; each adds one clause.
- **gear activated abilities** (5): Assembly Rig, Poro Snax, Vanguard Armory, and
  the two "pay any amount" X-cost gear (Hextech Anomaly, Ancient Henge).
- **statics on the unit itself** (3 left): Ruin Runner ("can't be chosen by enemy
  spells and abilities" — no chooseability filter exists; it needs one door both
  the enumerator and the validator ask), Perched Grimwyrm (a play restriction —
  `mayPlayUnitAt` is battlefield-keyed and this is card-keyed), Rell - Magnetic.
  Trusty Ramhound landed in `effective-might.ts`'s aura sum.
- **the 13 partials**, which are the honest backlog; `Svellsongur (SFD-059)`
  (text copying) is still the one nothing models.

**The recorded divergences** are unchanged in kind: the per-instance `[Repeat]`
list, the aura-driven "became Mighty", Ornn's gear ability half, a base as a move
destination, and the Deathknell's read moment.

## Two things this stretch proved about the process

- **A partial note that names a MISSING MECHANISM goes stale silently, and every
  one checked was wrong** — the rainbow `[Equip]` cost (freed by Temporal
  Portal's own widening the day before), Rumble - Hotheaded's keyword aura
  (already written AND swept), Forge of the Fluft's "no table models it"
  (`abilitiesAvailableTo` already was the table). Before scoping card work,
  re-read every note whose text names a mechanism and grep for it. Notes naming
  missing CARD TEXT (art-only clauses) do not rot the same way.
- **`DECKS=sfd` is still finding what the suite cannot**, twice more this
  stretch: a counter that left the chain closed and empty, and an optional-cost
  branch that never priced `[Deflect]`. Both were PRE-EXISTING and unreachable
  until a new card reached them. Run it after every wave, not at the end.

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

## What to do next, in order

### 1. `[Repeat]` — 14 cards + Marai Spire. The largest single block.

**It is NOT blocked on a resumable Cleanup.** That was settled 2026-08-06 and the
old note was wrong — it described the Java oracle's design, not the rules.

Rule **820.1.d** is the whole keyword: *"You may pay [Cost] as an additional cost
**as you play this**. If you do, execute the instructions of this chain item one
additional time **during resolution**."* **820.1.c.1** puts the cost at announce.
**320/321** make Cleanup and resolution mutually exclusive, so nothing falls
between the two executions and none needs resuming. The PDF's worked example is
Desert's Call, which is in this set.

Four pieces, all shaped like machinery that exists:

- a per-card cost table — all Energy and/or Power pips except **Temporal Portal
  (SFD-078)**, whose Repeat cost is dynamic ("equal to its cost")
- an optional additional cost on the `PlayCard` action, beside
  `OPTIONAL_POWER_COSTS` and `cardHasOptionalExhaustCost`
- a flag on the chain entry
- a second `effect.resolve` call at resolution

**820.1.c.2/c.3**: a card printing two Repeat instances offers each separately,
and each is payable only once. Marai Spire (SFD-211) discounts friendly Repeat
costs and is unblocked by the same work, taking battlefields to 12/15.

### 2. `legendEventTriggers` — one adapter rework, then Legends flow again

`legend-abilities.ts`'s adapter converts each Legend hook into an
`EventTriggerDefinition`, and **throws if a Legend has two convertible hooks**.
Its own comment says *"None has two today; the throw is so the day one does is
the day it is noticed."*

**Irelia - Blade Dancer (SFD-195) is that day** — she prints "when you choose a
friendly unit" and "when you conquer". The fix has precedent:
`EventTriggerDefinition.on` already accepts a LIST (widened for Corrupt Enforcer
and Draven - Vanquisher, the same one-defId-two-clauses problem). Collect a
Legend's hooks and emit one entry with `on: [...kinds]` branching on
`event.kind`, instead of throwing on the second.

Do it **driven by Irelia**, not as a standalone refactor. She also needs a new
`onUnitChosen` hook — the `unitChosen` event itself already exists and fires from
both choosing paths.

### 3. The rest of the Legends, cheapest first

- **Rek'sai - Void Burrower (SFD-187)** — Void Rush (SFD-188) already implements
  reveal-2 / banish-one / play-it / recycle-the-rest, including its decision.
- **Jax (SFD-193)**, **Renata Glasc - Chem-Baroness (SFD-201)**,
  **Sivir (SFD-203)** — attachment, Gold tokens and the hold moment all exist.
- Needing one new primitive each: **Lucian - Purifier** (Equipment granting
  `[Assault]` to its wearer), **Ornn (SFD-189)** (a gear-only restricted Power
  pool — `restrictedSpellPower` is the precedent), **Azir (SFD-197)** (a "played
  an Equipment this turn" counter).
- Blocked on new events: **Ezreal (SFD-199)** needs a per-turn counter of choices
  that also counts GEAR; **Fiora (SFD-205)** needs a "became Mighty" event.

### 4. The cheap-events batch

`buffSpent` (unblocks Fae Dragon SFD-101's second clause) and
`abilityActivated`. `unitChosen` is done.

### 5. The seven remaining art-only Equipment

No shared mechanism left — each needs its own primitive. Cheapest is **Sacred
Shears (SFD-172)**, a `[Deathknell]` on the wearer sourced from the gear;
most expensive is **Svellsongur (SFD-059)**, text copying, which nothing models.

### 6. Two small battlefields

**Ornn's Forge (SFD-213)** needs a per-turn gear-played counter; **Rockfall Path
(SFD-216)** needs a per-battlefield play restriction. Both touch the
enumerator/validator pair, which is this repo's most reliable source of
offered-then-refused bugs — change one side and re-test the other.

**Forge of the Fluft (SFD-208)** grants an ACTIVATED ABILITY to a friendly
Legend, which no table models. ~~Leave it.~~ **DONE at `250add8`** — and the
advice was wrong: no new table was needed. `abilitiesAvailableTo`, written for
Heimerdinger - Inventor, is already the single answer to "what can this source
activate" and is shared by the enumerator, the validator and the executor. The
Forge is a second entry in that list. Recorded here rather than deleted, because
"no table models it" was a judgement about the code that a look at the code
overturned — the same shape as the two wrong `[Repeat]` notes this file's own
log records.

## Known gap, player-facing

The UI has no way to pick WHICH spell on the chain to counter — it takes the
first matching candidate. Pre-existing and shared with Wind Wall, Defy, Mystic
Reversal and Riposte's spell half. Harmless with one spell waiting; arbitrary
with two or more. Fixing it means making chain items clickable in the viewer.

## What today proved, and what it should change about how you work

Three instrument defects were closed, and all three had the same shape: **the
measurement said the work was done.**

- The typecheck gate had been red for 12 errors behind a green build.
- **Fifteen Equipment reported `isCardImplemented = true`** while doing none of
  what they print, because their whole ability is on the ART and
  `needsImplementation` reads the text. Eight are now written; seven are in
  `PARTIALLY_IMPLEMENTED`. **SFD's count FELL from 100 to 93 as a result, and the
  fall was the fix.** A dropping coverage number can be good news.
- **Three tribal keyword auras granted to every friendly unit**, because
  `auraGrantedKeywords` consulted `appliesTo` but never `appliesToDef`. Every
  test for those three passed — each asserted only that the Mech got the keyword.
  Found by writing the NEGATIVE for a fourth card of the same shape.

The lesson those share: **write the negative.** In all three cases the positive
assertion passed against broken code. The negative is where the information is.

And two notes that were confidently wrong were found today, on top of the three
above: `[Repeat]`'s blocker (described the oracle's design, not the rules) and
`counter-spell.test.ts` calling Hextech Ray "2E/1P" when it is 1E/1P. **A comment
is a claim, and claims are checkable.**
