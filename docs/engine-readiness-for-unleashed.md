# Getting the engine ready, before Unleashed

**Do not copy the verification loop into this file.** It is in `CLAUDE.md` at the
repo root, and the reason it lives there is that five docs in this directory each
wrote their own copy, they drifted, and the copy in front of a session beat the
correct one — twice, both times leaving the web suite red. Run the loop from
`CLAUDE.md`.

Written 2026-08-07 at `de9ddba`. **Every figure below was measured at that
commit. Re-measure anyway** — that instruction has been right every time it was
ignored in this repo, including twice in the session that wrote it.

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

## Phase 0 — land what is already done

`fix/verification-loop-and-web-suite` (`de9ddba`) fixes the red web suite and
adds `CLAUDE.md`. **`master` is currently red on the web suite**, so this goes
first and alone.

Run the loop, merge, push. No agents.

---

## Phase 1 — close the reachability gap

**This is the bulk of the work and the reason for the whole plan.**

### 1a. Make the covering runs a gate rather than a thing you can type

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

### 2a. The audit (read-only, and a good agent job)

60 rows, never swept as a whole, and at least one provably stale. For each row
ask only: **is this still true of the code?** Three outcomes — still true, now
CLOSED, or was never right.

`Explore` or read-only `engine-devs` agents over disjoint row ranges. Output is a
list of rows to change, not edits — one session applies them, because the file is
a single table and concurrent edits to it will conflict.

The known-stale one to start from: **"Controller vs owner"**, which claims to
block a card that shipped.

### 2b. The fixes worth making, in order

1. **A BASE as a spell's move destination.** The strongest case left: **six cards
   are weaker than printed** — Charm, Showstopper, Ride The Wind, Stormbringer,
   Dragon's Rage, Temptation — and rule 1442 works Ride the Wind's case *by name*
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
- **Prevent (rule 438) is NOT modelled**, and the PDF works it by name on an SFD
  card (Counter Strike, SFD-194) — so this is an existing gap, not a UNL one, and
  it is recorded as a divergence rather than a partial.
- **XP / rule 728 has nothing.** This is the real subsystem, and it is the one
  thing worth scoping properly before the JSON is copied in.

Adding the set itself is one file plus one `CARD_FILES` entry — `deriveId`
already turns `unl-001-…` into `UNL-001` unchanged. **It is never a
data-sourcing problem**, and the SFD prompt was wrong to treat it as one. Check
the file's shape first: `unl.json` is a bare array with no BOM (`ogs.json` is a
paginated envelope, `ogn.json` has a BOM and six mojibaked apostrophes).

---

## Phase 4 — the readiness gate

Do not start UNL until all of these hold:

- [ ] `master` green on the full `CLAUDE.md` loop, both workspaces.
- [ ] One command reports whole-pool reachability, and its union figure is pinned.
- [ ] Every implemented-but-never-exercised card is either exercised, or on an
      allowlist **with a reason** — the `ai-ab-harness` "structural, not a weight"
      category is a legitimate reason; "we did not get to it" is not.
- [ ] Every Divergent row re-read against the code, with the stale ones corrected.
- [ ] The three Phase 2b fixes landed, each recorded in
      `docs/rules-conformance.md` in the same change and PINNED by a test where
      the gap stays open.
- [ ] `docs/wip/remaining.json` deleted.
- [ ] XP / rule 728 scoped in writing, against the rules PDF and the oracle.

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
