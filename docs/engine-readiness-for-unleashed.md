# Getting the engine ready, before Unleashed

**Do not copy the verification loop into this file.** It is in `CLAUDE.md` at the
repo root, and the reason it lives there is that five docs in this directory each
wrote their own copy, they drifted, and the copy in front of a session beat the
correct one — twice, both times leaving the web suite red. Run the loop from
`CLAUDE.md`.

Written 2026-08-07. **Every figure below was measured with `master` at `362ccf0`,
before Phase 0 landed. Re-measure anyway** — that instruction has been right
every time it was ignored in this repo, including twice in the session that wrote
it. Nothing in Phase 0 touched an engine resolver, so the reachability numbers
should reproduce; if they do not, that is the finding, not a nuisance.

## The goal, stated so it can be checked

Unleashed is 280 entries (`unl.json`, already in the frozen oracle at
`A:\Projects\riftbound-engine\src\main\resources\cards\`) and brings four
keywords — `[Hunt]`, `[Level]`, `[Ambush]`, `[Backline]` — plus XP (rule 728).

**"Ready" here does NOT mean "implement UNL's primitives in advance."** It means
the three sets already shipped are trustworthy enough that a UNL bug is
distinguishable from an old one. Right now they are not, and the measurement
below says why.

---

## What was measured, and the one number that matters

All three sets report 100% implemented and are hard-gated. That gate asserts
**every card has an implementation**. It does not assert that any of them has
ever been observed doing anything in a real game — and that is a different
number.

`probes/exercised.ts` already answers it, per set, through
`generateCoveringDecks`. Nobody has run all three modes together:

| run | cards seated | exercised | of seated |
|---|---|---|---|
| default (7 preset decks) | 105 | 82 | — |
| `DECKS=ogn` | 248 | 173 | 70% |
| `DECKS=ogs` | 23 | 21 | 91% |
| `DECKS=sfd` | 198 | 163 | 82% |

**Union across the three covering runs: ~357 of 468 cards needing code.**
**~111 implemented cards have never been observed acting in a game.**

> **Superseded 2026-08-07 by Phase 1a's actual measurement — the estimate was low.**
> `probes/reachability.ts` reports **367 of 468 exercised, 101 never**. The table
> above and the ~357 under it are a SUM of three runs; the union is bigger because
> the presets and the OGS covering run each reach OGN cards the OGN covering run
> misses (OGN alone 173, union 184). Every figure in the table reproduced exactly.
> See Phase 1a below for the real numbers and the buckets.

Two things make that the top priority rather than a curiosity:

- **The preset decks reach ZERO SFD cards.** All seven are OGN/OGS, so the
  default probe run — the one in the loop — reports `SFD 0%` and always will.
  198 cards shipped this month have never been in a game unless somebody typed
  `DECKS=sfd`.
- **Unit tests systematically cannot see the bug class this catches.** This repo
  has shipped a dropped action field on a dispatch hop **five** times; every one
  was invisible to a suite that calls resolvers directly, and several were found
  only by self-play or a live UI run. 111 cards have had no such run.

### The other measurements

**`docs/rules-conformance.md` has 60 rows in its Divergent table, and at least
one is provably stale.** The "Controller vs owner" row still reads *"Blocks
Hostile Takeover (SFD-202) entirely"* — that card shipped on 2026-08-07. This is
the failure mode `instrument-defects` already records for `PARTIALLY_IMPLEMENTED`
("a note is written when a card is REFUSED, describing the engine as it was that
day; nothing re-reads it"), one document over. The table has never been audited
as a whole.

**`docs/wip/remaining.json`** is 66 entries, **0 of which are still
unimplemented**. A to-do list that is entirely done, sitting where a future
session will find it.

**Four SFD-era prompts plus the battlefields prompt** now carry SUPERSEDED and
DRIFTED-COPY banners, added 2026-08-07. They were left in place for their
surveys; that was deliberate and should stay.

---

## Phase 0 — DONE (2026-08-07, `1cf5db9`)

`fix/verification-loop-and-web-suite` is merged and pushed. `master` was red on
the web suite for the whole SFD session and is now green on both workspaces;
`CLAUDE.md` exists and carries the canonical loop.

**Start at Phase 1.** This heading is kept rather than deleted so that a session
reading top-to-bottom is told the state instead of being sent to redo it — the
stale-instruction failure this repo has recorded against
`PARTIALLY_IMPLEMENTED`, against the Divergent table, and against the loop
itself. **Re-measure before trusting it, like everything else here.**

---

## Phase 1 — close the reachability gap

**This is the bulk of the work and the reason for the whole plan.**

### 1a. DONE (2026-08-07) — `probes/reachability.ts`

One entry point, presets plus one covering run per set, **~10 seconds**. It is in
`CLAUDE.md`'s loop **in place of** the two `exercised.ts` lines (it gates every
instrument control both of those gated, per run); `exercised.ts` remains the
per-mode drill-down.

**Measured, and pinned in `CLAUDE.md`: 429 of 468 cards needing code have ever
been exercised. 39 have not.** OGN 224/248, OGS 20/22, SFD 185/198, at the
probe's default 250 games per mode. The pin is a FLOOR — the number is meant to
rise, and the probe prints a line asking for the pin to be bumped; a DROP is red.

**The plan's ~111 was measured at 40 games per mode, and most of it was
sampling.** The depth is load-bearing:

| games/mode | exercised | never | `drawnNeverOffered` | wall clock |
|---|---|---|---|---|
| 40 | 367 | 101 | 8 | 10s |
| 100 | 417 | 51 | 4 | 25s |
| **250** (default) | **429** | **39** | **1** | **60s** |
| 500 | 435 | 33 | 0 | 120s |

The 39 are all NAMED, partitioned five ways:

| bucket | count | of which |
|---|---|---|
| `offeredNeverTaken` | 33 | the engine offers it, the 1-ply AI declines — the `ai-ab-harness` category |
| `startsInPlayNeverActed` | 5 | Legends: on the board from turn 1, never drawn, never offered |
| `drawnNeverOffered` | 1 | OGN-158 Volibear, 12 Energy — the pool's most expensive card |
| `seatedNeverDrawn` | **0** | |
| `neverSeated` | **0** | the covering runs really do seat all 468 |

Notes for whoever touches it next:

- **The modes are derived from the registry, not listed.** A hardcoded
  `["OGN","OGS","SFD"]` is correct today and silently wrong the day `unl.json`
  lands — which is this exact failure one set earlier.
- The loop, the deck selection and the instrument controls moved to
  `probes/exercise-run.ts` (+ `pool-facts.ts`) and `exercised.ts` was refactored
  onto them rather than keeping a second copy. Verified by its output being
  **byte-identical in all four modes** before and after.
- **All four gates were mutation-proven**: merging only the first run, raising the
  pin past the truth, a stale allowlist entry, and dropping a mode each turn it
  red. The `everySetReachable` control had to be rewritten to read the
  MEASUREMENT (`bySet.seated`) rather than `setCodesWithLegend` — computed from
  the same input `MODES` is, it could not fail.
- `probes/unexercised-allowlist.ts` holds the 5 Legends, each with a reason read
  off the CODE. A card excused there that turns up exercised fails the gate by
  name.
- `probes/why-not-offered.ts` is the follow-up instrument: `CARDS=OGN-158 …` says
  whether a card was ever affordable, ever legal-timed, and ever enumerated. It
  is what dissolved 1b, and it is the tool for any future entry in that bucket.

### 1b. DONE (2026-08-07) — and there was no enumeration backlog

**Nothing to fix.** The 8 leads the 40-game run produced were investigated with
`why-not-offered.ts` and **7 of the 8 were sampling**: at 250 games per mode the
engine offers them freely (Punch First 59 times, Blood Money 71, Dazzling Aurora
14). The eighth is OGN-158 Volibear at 12 Energy — the pool's most expensive card
against a median of 3, affordable twice in 1000 games. At 500 games per mode
`drawnNeverOffered` is **empty**.

So the two categories that remain are both already documented, and both are
allowlisted or explained rather than fixed:

1. **33 cards the engine OFFERS and the AI declines** — Sabotage, Stacked Deck,
   Party Favors, Meditation, Time Warp… exactly the `ai-ab-harness` "structural,
   not a weight" category, plus the `abilityBanksResource` Legends. Reachability
   is PROVEN for every one of them: the enumerator emitted them.
2. **5 Legends the observer cannot see**, each re-read against the code rather
   than taken from `exercise-log.ts`'s header:
   - **OGN-251 Jinx** — `onBeginningPhase`, the one held-trigger conversion
     deliberately left undone, so it resolves inline and never reaches
     `pendingTriggers`.
   - **OGS-019 Master Yi**, **SFD-181 Rumble**, **SFD-183 Lucian** — continuous
     effects (`mightBonus`, granted keywords) read during a calculation. No
     action, no Chain item, no event, so no signal can exist.
   - **OGS-023 Garen** — *not* a blind spot. Its conquer trigger is held and
     `test/legend-triggers-held.test.ts` proves it reaches the chain; its
     condition (4+ friendly units surviving at the conquered battlefield) has
     simply never come up. A deck built to mass units would close it.

**The dispatch-hop bug class this phase was built to catch did not appear.** That
is a real result rather than a null one: `invalid: 0` held across every run at
every depth, and `takenWasOffered` held too.

### 1b (as originally specified). Work the named list down

### 1a (as originally specified). Make the covering runs a gate rather than a thing you can type

Today `DECKS=sfd` is in the loop and `DECKS=ogn` / `DECKS=ogs` are not, though
both already work. There is also no run that reports the UNION, so "how much of
the pool has ever been exercised" is a number nobody can currently read.

Build one entry point that runs all three covering modes and reports:

- the union of exercised cards over all runs, per set and overall;
- **the named list of implemented-but-never-exercised cards**, because a count is
  not actionable and this repo's gates all name their subjects;
- `invalid: 0` per run, which is the offered-then-refused detector.

Then put it in `CLAUDE.md`'s loop and pin the union figure the way `walkout` is
pinned at 191/107/32.

**Watch for the instrument defects this exact family has already had**
(`instrument-defects` memory): a probe that wraps an engine internal also counts
the AI's LOOKAHEAD, and summing two different signals (a Gear PLAYED vs
ACTIVATED) reports unreachable cards as reached. Count from the action/state
stream, and keep a positive control that can actually fail.

### 1b. Work the named list down

Expect three buckets, and **classify before fixing** — they need different work:

1. **Reachable but the AI never chooses it.** Already known and structural: the
   evaluator scores board state, so it never casts a spell that only moves
   information (Sabotage, Stacked Deck, Party Favors…). See the `ai-ab-harness`
   memory — no weight fixes this. These ship verified by unit tests, and the
   right outcome is an explicit allowlist with a reason per card, not a fix.
2. **Never offered at all.** The interesting bucket. A card the enumerator never
   emits is either correctly gated (a Legend is never offerable — the probe
   already reports three) or a real bug.
3. **Offered, taken, and it did nothing.** The dispatch-hop class. This is what
   the whole phase is for.

**This is where agents earn their keep.** Bucket 2 and 3 are per-card
investigations over disjoint subjects, which is exactly what `engine-devs` is
described for: *"Prefer fanning several of these out over disjoint card sets; do
NOT fan out over one shared type or resolver."*

- Split the named list **by domain file** (`effects/fury.ts`, `calm.ts`, …), not
  by set — that is the ownership boundary, so two agents cannot collide.
- **The shared-build constraint is real**: `packages/web` and every probe resolve
  the engine from `dist`, so parallel agents must not all run
  `npm run build --workspace=@rift-engine/engine` against one tree. Give each a
  worktree (`isolation: "worktree"`), or serialise the build and let them run
  only the engine suite.
- Any fix that touches a SHARED type — `TargetingSpec`, the enumerator/validator
  pair, `holdEventTrigger` — comes back to one session. Five offered-then-refused
  bugs in this repo came from one side of such a pair moving alone.

---

## Phase 2 — audit the divergence table, then fix the reachable ones

### 2a. DONE (2026-08-07) — swept as a whole for the first time

Recorded at the top of the Divergent table in `docs/rules-conformance.md`, so it
is next to the rows rather than here. In short:

- **Three rows were stale, all the same way**: something recorded as BLOCKED had
  since shipped. Corrected in place with the correction dated.
  - **Controller vs owner** — the known one. Hostile Takeover (SFD-202) is whole;
    the "missing subsystem" turned out to be **one optional field**
    (`returnControlAtEndOfTurnToIndex`), which is the shape every re-read note in
    this repo has had. The MODEL half of the row is still true and stays.
  - **Legend triggered abilities on the Chain** — said four hooks were blocked.
    All but `onBeginningPhase` are held. Two blockers dissolved when `spellCast`
    and `unitsStunned` became `HeldEventKind`s; **the third was never real**, and
    `legend-abilities.ts` says so in its own comment while the row and that
    file's HEADER both still claimed otherwise. Three notes, one truth, two lost.
  - **"TWELVE event kinds are CONVERTED"** — it is 21 of 22. The load-bearing
    half ("every kind but one") is still true and the compiler enforces it.
- **No row had drifted by RENAME.** Every backticked identifier in all 60 rows
  still exists in `packages/engine/src` — checked mechanically.
- **The absence claims all HOLD**, including the three Phase 2b targets below, so
  2b's premises are verified rather than assumed.
- **One gap left open, deliberately**: the hand-counted card figures ("110 held /
  3 inline", "39 cards", "23 of 72 gear", "17 cards") have no instrument and
  nothing recomputes them — the shape `CLAUDE.md` blames for four wrong censuses.
  The "3 inline" half was re-verified; the rest are undated. **A census
  instrument is the obvious next piece of work here** and is not built.

### 2a (as originally specified). The audit (read-only, and a good agent job)

60 rows, never swept as a whole, and at least one provably stale. For each row
ask only: **is this still true of the code?** Three outcomes — still true, now
CLOSED, or was never right.

`Explore` or read-only `engine-devs` agents over disjoint row ranges. Output is a
list of rows to change, not edits — one session applies them, because the file is
a single table and concurrent edits to it will conflict.

The known-stale one to start from: **"Controller vs owner"**, which claims to
block a card that shipped.

### 2b. DONE (2026-08-07) — all three, one of them only half, and said so

Each is recorded in `docs/rules-conformance.md` in the same change, and each is
pinned by a test. **The rules PDF was read for every one of them**, and it
corrected the plan or the row in all three cases:

1. **A BASE as a spell's move destination — CLOSED.** The row cited "rule 359.3.e.6";
   the worked example is **359.3.e**. It also said "all six move-target spells";
   it is **five** — Showstopper and Stormbringer print "to a battlefield" and
   correctly cannot reach base, and Relentless Pursuit, which the row omitted,
   can. The one example fixes both halves in opposite directions: the destination
   is OFFERED even at Vilemaw's Lair and it is the MOVE that is ignored, so
   gating the enumerator would contradict the rule. **Measured in play:
   reachability 429 → 430, and the card that moved is Temptation**, which prints
   "move an enemy unit to a LOCATION".
2. **Tideturner — CLOSED.** `TargetingSpec.optionalChoice`, read by the
   enumerator AND the validator, with 402.1 as the rule. A census test asserts it
   is still the only card carrying the flag.
3. **`[Deathknell]` reading the board it died on — HALF closed, honestly.** The
   `applies`/`capture` pair exists now and fixes the **Kill Instruction** path
   (808: note "before completing this Kill Instruction"). The **combat wipe is
   still open** and is the reachable one: Cleanup 3a notes for ALL lethally
   damaged units before 3b trashes any, while `processDefeated` interleaves them
   per unit. `capture` fixed the MOMENT and cannot fix the ORDER. **The old pin
   was itself wrong** — labelled "a mutual wipe" while driving two sequential
   `destroyUnit` calls, which are two Kill Instructions where drawing is
   CORRECT. It now drives a real `resolveShowdown`.

**Next piece of work here**: batch Cleanup 3a across all defeated units before
any 3b. It is entangled with the death-replacement rules (373.1/373.2 turn on
simultaneity too), which is why it was not done blind.

### 2b (as originally specified). The fixes worth making, in order

1. **A BASE as a spell's move destination.** The strongest case left: **six cards
   are weaker than printed** — Charm, Showstopper, Ride The Wind, Stormbringer,
   Dragon's Rage, Temptation — and rule 359.3.e.6 works Ride the Wind's case *by name*
   ("Base is a legal move destination"). The fix is a destination field that can
   say "base", the shape `TokenDestination` already has, plus the
   enumerator/validator pair. **One session, no agents** — it is precisely the
   shared pair that must not be split.
2. **Tideturner (OGN-199).** An optional on-play choice that is FORCED whenever a
   legal target exists, in a **declared-complete set**. Swept and confirmed as the
   only card the rule reaches. Needs a per-card "this trigger is optional" marker;
   the resolver already handles an absent target, so only the enumeration is wrong.
3. **`[Deathknell]` reading the board it died on** (Lonely Poro). Needs
   `applies`/`capture` on `DeathknellEffect`, which `EventTriggerDefinition` and
   `DeathWatchDefinition` both already have — so this is bringing a third family
   in line rather than inventing anything.

Leave alone, deliberately: the `[Mighty]`-on-aura row (needs rule 477 layer
snapshotting), Ornn's rainbow paying an ability cost (changes every activation
cost in the game), and Svellsongur's aura doubling (chosen, recorded, pinned).

---

## Phase 3 — what Unleashed will actually need

Do this LAST, and only after Phase 1, so a UNL bug is separable from an old one.

**Measure before building.** The keyword split is authoritative in the oracle's
`model/Keyword.java` doc comment: HUNT / LEVEL / AMBUSH / BACKLINE are UNL.

What is already there, measured today:

- **`[Backline]` is IMPLEMENTED** — `combat.ASSIGNED_LAST_DEF_IDS` is a third
  tier in `assignmentOrder`, built for Caitlyn - Patrolling, who prints it as
  plain prose. One of the four is done before the set arrives.
- **Prevent (rule 437) is NOT modelled**, and the PDF works it by name on an SFD
  card (Counter Strike, SFD-194) — so this is an existing gap, not a UNL one, and
  it is recorded as a divergence rather than a partial.
- **XP / rule 728 has nothing.** This is the real subsystem, and it is the one
  thing worth scoping properly before the JSON is copied in.

> **Scoped 2026-08-08, and it is NOT the real subsystem.**
> `docs/xp-and-unl-keywords-scope.md` has the measurement. XP is a public
> per-player integer, gained and spent, explicitly **not a Game Object** ("cannot
> be targeted, readied, or exhausted"), with no cap — so it is one field plus two
> helpers. The work is the keywords that read it, and **there are five, not
> four**: `[Predict]` appears on 5 UNL cards and is in neither this plan nor the
> oracle's `Keyword.java`. It is an action word, and `top-of-deck.ts` already does
> what it does.

Adding the set itself is one file plus one `CARD_FILES` entry — `deriveId`
already turns `unl-001-…` into `UNL-001` unchanged. **It is never a
data-sourcing problem**, and the SFD prompt was wrong to treat it as one. Check
the file's shape first: `unl.json` is a bare array with no BOM (`ogs.json` is a
paginated envelope, `ogn.json` has a BOM and six mojibaked apostrophes).

---

## Phase 4 — the readiness gate

Do not start UNL until all of these hold:

- [x] `master` green on the full `CLAUDE.md` loop, both workspaces.
      Verified 2026-08-08 at `7909718`: 3192 engine tests across 200 files, 118
      web across 17, typecheck 0 errors both workspaces, both builds, five probes
      with walkout at 191/107/32 and reachability at 430/468 with all 8 controls
      green.
- [x] One command reports whole-pool reachability, and its union figure is pinned.
      `node probes/reachability.ts`, pinned at 367/468 (2026-08-07).
- [x] Every implemented-but-never-exercised card is either exercised, or on an
      allowlist **with a reason** — the `ai-ab-harness` "structural, not a weight"
      category is a legitimate reason; "we did not get to it" is not.
      **Enforced, not just done**: `reachability`'s `everyUnexercisedExplained`
      control is red unless every never-exercised card is either proven reachable
      by the enumerator having OFFERED it (33 of them) or carries a written
      reason (6). Currently 0 unexplained. Mutation-proven by deleting an entry.
- [x] Every Divergent row re-read against the code, with the stale ones corrected.
      All 60 swept 2026-08-07; three were stale, all corrected in place.
- [x] The three Phase 2b fixes landed, each recorded in
      `docs/rules-conformance.md` in the same change and PINNED by a test where
      the gap stays open. Two closed outright; the Deathknell one closed its Kill
      Instruction half and PINS the combat half that remains.
- [x] `docs/wip/remaining.json` deleted — after re-measuring it rather than
      trusting the note: all 66 ids resolve and all 66 are implemented.
- [x] XP / rule 728 scoped in writing, against the rules PDF and the oracle.
      **`docs/xp-and-unl-keywords-scope.md`** (2026-08-08). Headline: **XP is one
      integer** — a public per-player counter, gained and spent, not a Game
      Object, uncapped — so the resource is not the subsystem this plan expected.
      The work is the five keywords that read and write it, and **there are five,
      not four**: `[Predict]` (5 cards) is in neither this plan nor the oracle's
      `Keyword.java`, and is an ACTION WORD whose behaviour `top-of-deck.ts`
      already implements. `[Hunt N]` dispatches generically off two events that
      are already held. `[Ambush]` needs no parser change at all. One real design
      question, with a recommendation: `[Level N]` inline per card, matching
      `[Legion]`, rather than a general Dependent-Ability layer.

## Housekeeping to fold in anywhere

- Delete `docs/wip/remaining.json` (66 entries, 0 still unimplemented).
- The seven preset decks reach no SFD card. Either add SFD starter decks — the
  oracle's `DeckPresets.java` is the source, and the kickoff doc says to use the
  real precons rather than inventing samples — or state in `CLAUDE.md` that the
  default probe run is OGN/OGS-only by construction. **Adding the real precons is
  better**: it makes the default loop mean something again.

## The standing lesson, because it applies to this file too

Notes about this codebase's mechanisms have been **wrong or stale ten times out
of eleven**, and the eleventh over-priced itself. Every "needs subsystem X" note
re-read against the code turned out to be one field, one function, or a table
already built for another card. **Re-read the code before believing anything
above.**
