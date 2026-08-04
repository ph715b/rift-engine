# Prompt — implement Spiritforged (SFD)

Paste the block below into a fresh session. Everything in it was measured on
2026-08-04 at `8a8af5d`, not recalled.

---

Read `docs/handoff-2026-08-04.md` first — it is the whole brief for the state you
are inheriting. Then read the memory files it names, and `docs/rules-conformance.md`'s
**Divergent** table plus the **Log**'s top ten rows. Then read
`docs/sfd-readiness-brief.md`'s DONE section, which records what the set-readiness
work actually put in place.

Your job is to bring **Spiritforged (SFD)** into the engine.

## Before anything else: check the data is here

Adding a set is one JSON file in `packages/engine/src/cards/` plus one entry in
`CARD_FILES` (`card-loader.ts:23`). `deriveId` already turns `"sfd-001-298"` into
`"SFD-001"` unchanged.

**As of 2026-08-04 there is no SFD data in the repo** — `CARD_FILES` is
`[ognRaw, ogsRaw]` and the only match for "sfd" anywhere is the readiness brief.

The set itself is NOT unreleased, which matters for how you source that file:
**Spiritforged shipped on 2026-02-13, uses the set code SFD, and has 221 cards**
(excluding Overnumber cards). It has six months of tournament results behind it. So
the missing JSON is a data-sourcing task with a known answer, not a wait. Match the
shape of the existing `ogn.json` / `ogs.json` — note their `imageUrl` fields point
at `cmsassets.rgpub.io`, i.e. Riot's own CMS, which is worth chasing before any
community scrape. **Do not hand-transcribe 221 cards**; get the data, then let the
censuses tell you what is wrong with it.

## The finding that should shape your plan

**The risk in Spiritforged is not 250 card bodies. It is the subsystems the cards
will need and the engine does not have.** Measured by cross-referencing
`docs/Riftbound Core Rules Updated 2026-07-16.pdf` (39MB, gitignored, extract with
`pdftotext -q "<file>" -`) against `model/keyword.ts` and the current pool:

**Keywords the rules define that the engine does not model, and that ZERO cards in
OGN+OGS print** — so they are almost certainly SFD's:

| keyword | what it is | what it needs |
|---|---|---|
| `[Ambush]` | Passive. "I may be played to a battlefield where you control Units", and gains `[Reaction]` while being played there | See the framing question below — this one is not additive |
| `[Hunt X]` | Triggered. "When I Conquer or Hold, my controller gains X XP" | **The whole XP resource (rule 728)**, which does not exist |
| `[Weaponmaster]` | Triggered, on play. Choose a Card you control with the Equipment tag, pay its Equip ability's cost reduced by X, attach it | **The whole Equipment/attachment subsystem** |
| `[Quick-Draw]` | "`[Reaction]`" + "when you play this, attach it to a Unit you control" | Equipment/attachment again |
| `[Backline]` | Passive. "must be assigned lethal damage after any other unit with the same controller that does not have `[Backline]`" | Already implemented per-card as `combat.ASSIGNED_LAST_DEF_IDS`, because Caitlyn prints it as PROSE. If SFD prints it bracketed, promote it to a real keyword |

**Two subsystems, neither of which exists:**

- **XP (rule 728)** — a per-player resource that is gained and spent, and is Public
  Information. `PlayerState` has no such field. `[Hunt]` alone requires it.
- **Equipment / attachment** — the rules have a Gear "Equipment tag", `Equip`
  abilities, attaching to a unit, and a Cleanup rule that recalls an Equipment when
  its unit dies (an Equipment attached to a unit is "present at that battlefield").
  This engine has `activeGear` as a flat per-player list with no attachment concept
  at all, and `Listener.battlefieldId`'s own comment says "Gear is never at a
  battlefield in this pool" — which SFD may falsify.

**A framing question worth settling early, because it may already be a
divergence.** `[Ambush]` is defined as "I may be played to a battlefield where you
control Units", and the rules say it "adds options to locations that are valid for
a Unit to be played to during the Make Relevant Choices step". This engine treats
reinforce-by-presence as a UNIVERSAL permission (`validate-play-card`'s presence
check, and `free-play.destinationsFor`). If the newer rules make that
Ambush-gated, the engine is currently too permissive for every unit in the pool.
Settle it from the PDF before writing any SFD card that touches placement, and
record the answer either way.

## The sequence — this is the order that worked for OGN

1. **Load the data and let the censuses fire.** Add the JSON and the `CARD_FILES`
   entry, run the suite, and expect several tests to go red at once: the supertype
   and rarity censuses, the `DOMAINS` order pin, the split-Power-pip census, the
   "I enter ready" guard, and the bracketed-token sweep if SFD prints a keyword the
   engine does not model. **Each red is a decision, not a bug.** Work through them
   one at a time and record what you decided.
2. **Survey and cluster before implementing anything.** Do not start on cards.
   Produce a written survey: how many cards, how many need no code, which need an
   existing primitive, which need a NEW primitive, and which need one of the
   subsystems above. `coverage.coverageBySet` reports per-set progress, and
   `SetCoverage.finishedButUndeclared` is what will tell you when the set is done
   and needs promoting into `COMPLETE_SETS`.
3. **Build the subsystems first, centrally, one at a time.** XP and Equipment are
   each their own piece of work with their own tests. Do not let them arrive
   half-built inside a card wave — a card registered against a primitive that does
   not fully work reports IMPLEMENTED and does nothing, which is the failure mode
   this repo has hit most often.
4. **Then implement cards in waves**, and this is where the team earns its keep —
   see below.
5. **Promote the set** into `COMPLETE_SETS` when `finishedButUndeclared` says so.

## Where to use the agent team, and where not to

Use `engine-devs` subagents, **fanned out over DISJOINT per-domain effect files**
(`effects/fury.ts`, `chaos.ts`, `order.ts`, `mind.ts`, `body.ts`, `calm.ts`,
`signature.ts`). That is exactly how OGN's 29-card cluster-1 wave landed: five
parallel agents over disjoint files, each proving its own tests could fail by
disabling its registry keys and re-running.

**Do NOT fan out over:**

- a shared file — `card-effects.ts`, `unit-triggers.ts`, `triggers.ts`,
  `effective-might.ts`, `cost-modifiers.ts`, `card-loader.ts`, `combat.ts`. Two
  agents editing one of these will conflict, and in the OGN wave the six cards that
  needed a shared file had to be finished centrally afterwards. Identify those
  cards during the survey and keep them for yourself.
- either new subsystem. XP and Equipment are single-owner work.
- the verification loop. The engine build is shared, so agents cannot each run
  `npm run build` safely in parallel; have them run the unit suite and do the full
  loop yourself, centrally, before each commit.

Give each agent: its domain file, its card list, the primitives it may use, and
the standing discipline below. Tell it explicitly that a card whose text needs a
primitive that does not exist must be REPORTED, not faked — two agents in the OGN
wave correctly stopped rather than shipping into that trap.

## One playtest report to settle, with the mechanism already located

**Baited Hook (OGN-242).** Reported: "if I use Hook to sacrifice a lone unit at a
battlefield, the unit I get off the top should be playable to the battlefield that
lone unit was on — I believe a recent rule change allows this."

The symptom is real and the cause is exact. `free-play.destinationsFor` offers a
battlefield only when `hasPresence` — the player has a unit there — and Baited
Hook kills the lone unit *in the same ability*, so by the time the free play
happens presence is gone and base is the only option.

The rules question is genuinely open and you should settle it before changing
anything:

- The 2026-07-16 PDF does **not** support it as written. The permission it defines
  is `[Ambush]`, "a battlefield where you **control Units**" — after the kill you
  control none there.
- But note the engine checks PRESENCE while control of the battlefield has **not
  yet lapsed** (that happens in the next Cleanup, 323.11). "A battlefield you
  control" and "a battlefield where you have units" come apart for exactly one
  window, and this is it. If the newer rule is phrased as control, the report is
  correct and the fix is one predicate.
- The other candidate reading is that the kill and the play are linked
  instructions (359.3), so the destination is judged as the ability began.

Check for a rules document newer than 2026-07-16 first. If none exists, take the
user's reading, implement it, and record it **Unverified** in
`docs/rules-conformance.md` with both alternatives — that is this project's
standing decision for an unguessable call. Either way, pin it with a test that
fails first.

## Standing discipline — non-negotiable

- **Prove every fix by making the check fail first.** A test that passed before the
  change tests nothing. And when you prove something by mutation, **grep for the
  marker to confirm the mutation applied** — twice in the last session a patch
  script missed on indentation and the "mutation" ran against unmutated code.
- **Fix the PREMISE, never weaken the assertion.**
- **Negative controls belong on the PEN (`pendingTriggers`), not the board.** A
  listener whose `applies` is wrong still re-checks in `resolve` and resolves to
  nothing, so the board looks identical either way.
- **Re-read the CODE before believing a note about the code.** Three notes in this
  repo turned out to be false: Noxian Guillotine's PARTIAL note, Volibear's
  "cardPlayed does not carry the unit", and the bystander rule.
- **An instrument gets the same scrutiny as the code** — see the
  `instrument-defects` memory. In particular: measure whether a deck can REACH your
  change before trusting a green probe run.
- **Record divergences in `docs/rules-conformance.md` in the same change**, and
  re-read what it already claims first.
- **Never bulk-edit source with PowerShell.** A python round-trip with explicit
  `utf-8` and `newline=""` is safe — note the repo is CRLF, so a multi-line search
  string joined with `\n` will silently not match. `assert` every replacement.
- Scratch files go in the session scratchpad, NOT next to the source.
- Commit per task with a real message, and push.

## Verification loop — every time, in this order

1. `npm run test --workspace=@rift-engine/engine`
2. `npm run build --workspace=@rift-engine/engine` — **before** the web typecheck,
   because `@rift-engine/web` resolves the engine from `dist`
3. `npm run typecheck`, then `npm run build`
4. Probes: `npx tsx packages/engine/probes/{ai-health,passive-human,chain-depth,walkout}.ts`
5. Live if a player can see it: `PORT=<port> node tools/ui-probes/live-triggers.mjs`
   with `SPECTATE=1` and `DECK=buff|calm|combat`. Never hardcode 5173.

**Every AI gate is blind to SFD until a deck contains SFD cards** — the presets are
pinned. Expect green gates to prove nothing about the new set, and build a
purpose-built deck when you need to see one work.

## The coverage gap this set will make impossible to ignore

Read the paragraph above again, because for SFD it is not a caveat, it is the
condition: **every card in the set starts unexercised by definition.**

`coverage.ts` measures **implemented** — `isCardImplemented` is a static check that
a `defId` is registered. It says nothing about whether a card has ever run, so
`coverageBySet` will happily report SFD at 100% while most of the set has never
been drawn by any probe. That is the `make-buffdeck.mjs` defect — an instrument
reporting its INPUT as its output — one level up.

**`probes/exercised.ts` now measures the second question, and you should run it
first.** Its baseline on OGN+OGS, at `e107958`, 40 games, battlefields pinned:

| | |
|---|---|
| definitions in the registry | 288 (270 of which `needsImplementation`) |
| reachable — in one of the 7 preset decks | **105** |
| exercised | **96** |
| cards needing code that NO probe can reach | **189** |

Read `exercised` and `inDecks` together or not at all. `exercised / inDecks` was
91% for OGN and 83% for OGS — of what the decks CAN reach, nearly everything runs.
`inDecks / inPool` is 31% for OGN, and that is the real gap. **A low `exercised` is
almost always a deck problem, not an engine problem**, and the two are fixed by
different work.

Note what this means for you concretely: **every SFD card starts in that 189.**
Adding the set will move `inPool` and leave `exercised` flat until a deck contains
SFD cards. Run `exercised.ts` before and after each wave; it is the only figure
that distinguishes "implemented" from "demonstrated".

What is still missing, in order of value:

1. **A coverage-driven deck generator.** Given `exercised.ts`'s
   `inDeckButNeverExercised` and the never-reachable list, build legal decks that
   REACH those cards. This generalises `make-buffdeck.mjs` — and keep its hard-won
   assertion: it throws, naming what did not fit, because it once printed
   "priority present" for cards its 39-card fill loop had silently dropped. Note
   deck validation caps a card at 3 copies across main + sideboard, so a
   "guarantee it gets drawn" deck is built from many subjects, not many copies.
2. **An invariant soak** over those decks. These need no oracle and are the checks
   worth automating: zero invalid actions, zero stranded Chain items, resources
   never negative, no decision with a blank title, and the walkout invariant
   (walkouts == control awarded, exact at every measurement so far).

### If you build a playtest team, this is the shape that works

**Community decklists exist and are worth using — just not for coverage.**
riftDecks, Piltover Archive and riftbound.one all carry SFD tournament lists (an
earlier draft of this document claimed no meta existed for the set; that was
wrong, and it is corrected here rather than quietly dropped). What a real list
gives you is a *realistic* game: plausible curves, the interactions that actually
come up, the cards people actually resolve together. Nothing synthetic reproduces
that, and it is a genuine gap in the generated decks below.

What it cannot give you is COVERAGE, and that part is arithmetic rather than
opinion. A legal deck is 40 cards; SFD is 221. A competitive list is optimised to
WIN, so several of them converge on the same strong cards and deliberately omit
the marginal ones — which are exactly the ones whose code is untested. You would
need many lists to reach what a handful of generated decks reach by construction.

**Generated decks do the coverage job, and this is measured, not argued.** A greedy
set-cover over the 170 cards no preset deck contains — pick the Legend that legally
holds the most uncovered cards, fill 40 slots, repeat — produced **6 decks covering
all 170**, and 12 games each exercised **183 of 217 subjects (84%)** with no
deckbuilding judgement applied at all. Card legality is machine-checked
(`validateDeckList`: 40 cards, max 3 copies across main + sideboard, champion must
be in the deck and eligible for the Legend, and a card need only SHARE one domain
with the Legend's two), so a generator cannot quietly produce an illegal deck.

Use both. Generated decks to reach every card; real lists to make sure the game
those cards are reached in resembles one somebody would actually play.

The real difficulty is the **oracle**. A game that does not crash proves nothing
about a card being correct, and a check that cannot fail first tests nothing. So
split the job:

- Everything decidable without knowing the right answer → the invariants above,
  as plain deterministic code. No agents.
- **"Did this card do what its printed text says?" → an agent.** Give it the card
  text plus the state diff from the moment the card resolved, and have it report
  SUSPECTS. Deterministic code cannot make that judgement and nothing else in this
  repo does. This is the one place a playtest team earns its cost.

Fan those agents out over **disjoint card batches**, drawn from `exercised.ts`'s
never-exercised list rather than from a decklist. Treat every suspect as a lead,
not a finding: confirm it by hand with a test that fails first, exactly as with
any other bug. And make the report lead with **reachability, not pass/fail** — "96
cards resolved, 189 never reachable" is the honest headline; "200 games, no
failures" is the same sentence with the important half deleted.

### Two defects this found before any agent was involved

Both came out of pointing generated decks at never-exercised cards, within minutes,
on an engine whose 1822 tests were green. Neither is fixed. Both are good first
subjects.

1. **`chooseAction` throws on a legal board.** Playing *Get Excited!* at a unit with
   `[Deflect]` raises `"Get Excited! must pay 1 rainbow Power for [Deflect] on its
   target, but named 0"` from inside `heuristic-ai`'s own lookahead — the AI
   enumerates a play whose executor then rejects it, and the exception escapes
   `chooseAction` rather than the candidate being scored badly and skipped. It is
   unreachable from any preset deck, which is why 40-game self-play never saw it.
   There is a `deflect-surcharge.test.ts` already; the surcharge is understood, the
   *enumeration* is not.
2. **OGN-004 Cleave is never played.** A 1-energy in-domain Fury `[Action]`, "Give
   a unit [Assault 3] this turn", never played across 8 games holding the legal
   maximum of 3 copies while dearer cards beside it in the same deck were played
   repeatedly. Either an AI valuation gap or an enumeration gap.

Note what both imply about a green suite: they are reachability failures, not logic
failures. No assertion was wrong. The cards were simply never in front of the AI.

## What to leave behind — write this before you stop

Whatever you finish, end by writing **`docs/handoff-<the date>.md`** and committing
it with the last change. This repo runs on those handoffs; the one you were told to
read first is the reason you know any of the above. Write it from **measurements
taken at the final commit, not from memory of what you did** — say so at the top,
and note the sha and branch. Where a figure contradicts an existing memory note,
say which one is later.

It must carry:

- **What the session actually did**, one line per commit, in order — so a
  regression stays bisectable by reading rather than by guessing.
- **A figures table**, re-run at the end, not copied from mid-session: engine and
  web test counts, per-set coverage from `coverageBySet`, the four probe results,
  and any live-probe counts. If a probe MOVED, say whether you verified it against
  the previous sha by checking out, rebuilding and re-running — that check is the
  only thing separating "the world moved" from "the instrument broke", and an
  unverified delta is worth nothing to the next session.
- **What you decided and why**, especially every census red you resolved and every
  rules call you took. If you recorded anything **Unverified**, name it here too,
  not only in `docs/rules-conformance.md`.
- **What is left, and what it is blocked on.** Distinguish "not started" from
  "blocked on X" — the current handoff's "the one big thing left" section is the
  shape to copy: it explains why 402 steps 2-4 are unstarted, which saves the next
  session from discovering the blocker for itself.
- **Suggestions for what to do next**, as a short **"Pick one"** list of
  independent options, each with enough context to choose between them: what it
  unblocks, roughly how big it is, and whether it is speculative. Mark anything
  speculative as such — the current brief's option B says outright that nothing in
  the pool can tell the difference yet, which is more useful than a confident
  recommendation would have been.
- **Anything a note told you that turned out to be FALSE.** Correct it at the
  source in the same change — the doc, the conformance table, or the memory file —
  and record the correction. Stale guidance is this project's most expensive defect:
  `docs/sfd-readiness-brief.md`'s card-authoring section is itself stale on trigger
  timing, written at `017752e` when the conversion was 80/30 rather than 110/3.

Then update the memory files under
`~/.claude/projects/a--Projects-Rift-Engine/memory/` that the new work
contradicts, and add a one-line pointer to the new handoff from `project_status.md`.
Do not duplicate the handoff into memory — memory holds what is not derivable from
the repo.
