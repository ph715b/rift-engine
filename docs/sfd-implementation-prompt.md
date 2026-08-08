> **SUPERSEDED — SFD IS COMPLETE (2026-08-07, `970eedd`).**
> All 198 SFD cards are implemented and `"SFD"` is in
> `coverage.COMPLETE_SETS`, so the set is hard-gated alongside OGN and OGS.
> `PARTIALLY_IMPLEMENTED` is empty. **Nothing in this file is still to do.**
> It is kept for the surveys and the reasoning; every card list and every
> price in it is historical. See `docs/rules-conformance.md`'s Log for what
> the finish cost and what it left as divergences.

# Prompt — implement Spiritforged (SFD)

Paste the block below into a fresh session. Everything in it was re-measured on
2026-08-04 at `e8e6383`, branch `feat/showdowns-timing-and-chain-viewer`, not
recalled. Figures that moved since the previous revision are marked.

---

Read `docs/handoff-2026-08-04.md` first for the state you are inheriting — but
know that it is **27 commits stale** (it was written at `4c64c39`), and the
previous revision of this prompt was **26 commits stale** (`8a8af5d`). The eight
that change your job are summarised below; **no handoff has been written for
them**, so this section is the only place they are collected. Then read the memory
files it names (`battlefield-abilities` is new), and `docs/rules-conformance.md`'s
**Divergent** table plus the **Log**'s top twelve rows. Then read
`docs/sfd-readiness-brief.md`'s DONE section, which records what the set-readiness
work actually put in place.

`docs/battlefields-and-ui-prompt.md` is **finished** — all 24 battlefield
abilities are implemented. Read it only for the reasoning, never as a task list.

Your job is to bring **Spiritforged (SFD)** into the engine.

## What changed since — the eight commits nothing else records

1. **All 24 BATTLEFIELD abilities are implemented** (`397efa4`..`f6bc2e0`). They
   were never broken; they did not exist, because `card-loader`'s `shouldSkip`
   keeps Battlefield-type cards out of `loadCardDefinitions`. They now live in
   three tables — `engine/battlefield-abilities.ts` (triggered, held as Chain
   Pending Items under a new `TriggerChainEntry.source: "battlefield"`),
   `engine/battlefield-continuous.ts` (read at gates), and
   `runBattlefieldBeginningPhase` (inline, the `beginningPhase` exception).
   **This is on your critical path: see "if SFD prints battlefields" below.**
2. **`[Deflect]` was audited per CHOOSING PATH and three paths paid nothing**
   (`9a1d525`). Target lists, unit-or-gear slots and ACTIVATED ABILITIES — the
   "or ability" half of the keyword had no implementation at all. All closed, via
   `chosenUnitsOfPlay` / `chosenUnitsOfActivation`. **If SFD prints `[Deflect]`,
   it works now; before this it was routable-around.**
3. **The board could not pay a rainbow surcharge at all**, and an `Invalid`
   submit was rendered nowhere (`ee39145`, `9a1d525`, `e8e6383`). Three separate
   UI defects, all of which presented as "the card just does not cast". They are
   fixed, and the third one matters to you as a TOOL: **a refusal is now visible,
   so any refusal in a live run is a hard failure signal** — `legal-actions` is
   shared with the validator, so nothing offered should ever be refused.

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

**And check the ENCODING of whatever you get, because the data already in this
repo is wrong.** `ogn.json` carries six mojibaked apostrophes — a UTF-8 curly
quote stored as latin-1 — across two cards: Sigil of the Storm ("This doesn?t
choose anything") and a `[Hidden]` card. Nothing catches it, and it is now
visible in play, because battlefield rules text renders on the board. A scan for
`â€™`, `�` and a stray BOM over the new JSON costs one command and is worth a
census of its own; the existing two cards are left alone deliberately, since
patching a snapshot by hand is undone by the next data refresh.

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
| `[Deflect N]` | "Opponents must pay N rainbow Power to choose me with a spell **or ability**" | **Nothing — this now works on every path**, as of 2026-08-04. It did not before: lists, unit-or-gear slots and abilities all chose a Deflect unit for free |

**Two subsystems, neither of which exists:**

- **XP (rule 728)** — a per-player resource that is gained and spent, and is Public
  Information. `PlayerState` has no such field. `[Hunt]` alone requires it.
- **Equipment / attachment** — the rules have a Gear "Equipment tag", `Equip`
  abilities, attaching to a unit, and a Cleanup rule that recalls an Equipment when
  its unit dies (an Equipment attached to a unit is "present at that battlefield").
  This engine has `activeGear` as a flat per-player list with no attachment concept
  at all, and `Listener.battlefieldId`'s own comment says "Gear is never at a
  battlefield in this pool" — which SFD may falsify.

## If SFD prints BATTLEFIELDS, they are a hard gate — not a nice-to-have

OGN prints 24 battlefields and OGS prints 0. If Spiritforged prints any, they
land in the pool the moment you add the JSON, and **`test/battlefield-coverage.test.ts`
goes red naming each one**, because it asserts every loaded battlefield is
implemented in exactly one of the three tables.

That gate exists precisely because battlefields are invisible to every other
measurement here: `shouldSkip` keeps them out of `loadCardDefinitions`, so
`needsImplementation` never counts one and `isCardImplemented` is never asked
about one. A battlefield with no ability costs nothing, breaks nothing and
reports nothing — which is how all 24 sat inert for the life of this engine.
**Treat that red as a task list, and do not silence it.**

Two things about the tables you will be adding to:

- A battlefield's entry is a **LIST** of abilities, because one card can print
  two at two moments (Targon's Peak arms a counter on conquer and spends it at
  end of turn). A delayed half must **capture** what it needs at fire time —
  `runEnd` clears every "this turn" field before the trigger it fired resolves.
- A battlefield could not be a `Listener`: `Listener.card` is a `CardInstance`,
  and a battlefield has no owner, no zone, no exhaust state, and is not
  controlled by whoever its ability triggers for. That is why it is a `source`
  rather than an entry in `eventTriggers`, and it is the shape to follow.

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
   "I enter ready" guard, the bracketed-token sweep if SFD prints a keyword the
   engine does not model, and **`battlefield-coverage` if SFD prints any
   battlefields**. **Each red is a decision, not a bug.** Work through them one at
   a time and record what you decided.
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

## Playtest reports: three settled since this prompt was written, four bugs

None of these is a task. They are here because each is a way to misread this
engine — and in every one of them, the obvious cause was disproved first.

- **Baited Hook (OGN-242)** — done at `b6365e2`. "The unit off the top should be
  playable to the battlefield the bait died on." Control was tried FIRST and does
  not work: control lapses in `lapseUnoccupiedControl` (323.11) and a Cleanup runs
  between submitting the activation and answering its question, so by then the
  player controls nothing there either. Implemented instead as 359.3's linked
  instructions — the victim's battlefield captured on the parked decision and
  threaded through. Recorded **Unverified**, with all three candidate readings.
- **"Falling Star will not cast"** — done at `ee39145` and `e8e6383`, and it was
  **two independent bugs wearing one symptom**. Auto Pay could not express rule
  164.2's double duty (two Fury runes paying 2 Energy AND 2 Power), so the button
  silently no-opped once the player had claimed those runes for Energy by hand.
  And separately, `GameBoard` rebuilt its `PlayCardAction` field by field and
  never copied `targetUnitInstanceIds`, so every `unitList` card was submitted
  with no targets and refused. **The first diagnosis was announced before the
  second was found** — worth remembering when a report has one symptom and you
  find one cause.
- **"Does `[Deflect]` work?"** — audited per choosing path rather than per card,
  which is the only question that had an honest answer. The keyword itself was
  right; three of five paths never consulted it. See the delta section above.

**The lesson all four share, and it is now standing discipline: when the board
does something a player cannot explain, diff what the UI HOLDS against what it
SENDS.** The dropped-field bug was found that way in one command — comparing the
fields `PendingPlay` declares against the fields the submit path copies — after
reading the same code twice without seeing it.

## The figures you are inheriting — measured at `e8e6383`, not recalled

Anything you do to the engine moves some of these. Re-measure before you claim a
regression, and **re-measure against the OLD SHA** — check it out, rebuild, re-run
— because that check is the only thing separating "the world moved" from "the
instrument broke". It has been needed four times, and once it re-attributed a
delta to a *different* commit than the one in hand.

| instrument | value |
|---|---|
| engine tests | **1934** (129 files) |
| web tests | **96** (14 files) |
| per-set coverage | OGN 248/248, OGS 22/22, both declared complete, 0 partial |
| battlefields | **24/24 implemented**, gated by `battlefield-coverage.test.ts` |
| ai-health | 40/40, 0 invalid |
| passive-human | 16/16 |
| walkout (200 games) | **191 walkouts / 107 points**, 32 closed with nobody present |
| chain-depth | 300/300 terminated, 0 stranded pen; `attackTriggers` 185, other `combatBegan` 209 |
| exercised (40 games) | 105 in decks, 99 exercised, 189 needing code unreachable |

**walkout moved 130/78/9 → 191/107/32 during the battlefield work, and it is the
world**: `Reaver's Row` is one of the three battlefields the probe pins, the AI
takes its "move a friendly unit here to base", and that empties the defending
side. Verified by stashing and rebuilding at the previous commit, which
reproduced 191/107/32 exactly. The invariant (walkouts == control awarded) is
exact at every figure.

## Standing discipline — non-negotiable

- **Prove every fix by making the check fail first.** A test that passed before the
  change tests nothing. And when you prove something by mutation, **grep for the
  marker to confirm the mutation applied** — twice in the last session a patch
  script missed on indentation and the "mutation" ran against unmutated code.
- **Fix the PREMISE, never weaken the assertion.**
- **Negative controls belong on the PEN (`pendingTriggers`), not the board.** A
  listener whose `applies` is wrong still re-checks in `resolve` and resolves to
  nothing, so the board looks identical either way.
- **Re-read the CODE before believing a note about the code.** Four notes in this
  repo turned out to be false: Noxian Guillotine's PARTIAL note, Volibear's
  "cardPlayed does not carry the unit", the bystander rule, and
  `coverage.ts`'s "nothing reads `[Deflect]`". **And a doc comment that says a
  hook does not exist yet is a task, not a fact** — `WIN_THRESHOLD_1V1`'s comment
  named Aspirant's Climb as unimplemented, and `scoreHolds`'s named the hold
  triggers, and both were true until somebody read them.
- **NEVER rebuild an action field by field.** This codebase has now dropped a
  field on a dispatch hop **six times**, most recently `targetUnitInstanceIds`,
  `xAmount` and `fromHiddenBattlefieldId` in one builder. The fix that removes
  the class is to submit the ENUMERATED action — `legal-actions` already produced
  the one that matches every choice — with only the payment substituted. A list
  of fields to copy is a list somebody has to remember to extend.
- **A required new field on `GameState`/`PlayerState` is the right call when the
  alternative is silent.** Four landed this session; the compiler named all 22
  literals, which is the point. An optional field defaults to "the card finds
  nothing", silently, in exactly the states used to test it.
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
4. Probes: `npx tsx packages/engine/probes/{ai-health,passive-human,chain-depth,walkout,exercised}.ts`
   — **five now**, and `exercised` is the one that tells implemented from
   demonstrated. Read its header before quoting its numbers.
5. Live if a player can see it: `PORT=<port> node tools/ui-probes/live-triggers.mjs`
   with `SPECTATE=1` and `DECK=buff|calm|combat`. Never hardcode 5173.
   `ACTIVE=1` is still the only way to check a prompt is answerable BY A PERSON.
   **A rendered refusal is now a hard failure** — the board surfaces `Invalid`,
   and `legal-actions` is shared with the validator, so anything offered and then
   refused is an enumerator/validator disagreement worth stopping for.

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
first.** Its baseline on OGN+OGS, **re-measured at `e8e6383`**, 40 games,
battlefields pinned:

| | |
|---|---|
| definitions in the registry | 288 (270 of which `needsImplementation`) |
| reachable — in one of the 7 preset decks | **105** |
| exercised | **99** |
| cards needing code that NO probe can reach | **189** |

Read `exercised` and `inDecks` together or not at all. `exercised / inDecks` is
**93%** for OGN and **83%** for OGS — of what the decks CAN reach, nearly
everything runs. `inDecks / inPool` is **31%** for OGN, and that is the real gap.

**Battlefields are outside every one of these numbers.** They are not in the
registry, so `pool`, `inDecks` and `exercised` all ignore them; the only thing
that can see one is `battlefield-coverage.test.ts`. Do not read a green
`exercised` as saying anything about a battlefield. **A low `exercised` is
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

**Generated decks do the coverage job, and this is measured, not argued.** Card
legality is machine-checked (`validateDeckList`: 40 cards, max 3 copies across main
+ sideboard, champion must be in the deck and eligible for the Legend, and a card
need only SHARE one domain with the Legend's two), so a generator cannot quietly
produce an illegal deck. Two generation strategies were measured on OGN+OGS:

| strategy | decks | result |
|---|---|---|
| baseline — the 7 preset decks | 7 | 81/270 needing code exercised |
| greedy card-cover | 6 | all 170 unreachable cards covered; 183/217 subjects (84%) run |
| **one deck per Legend** | **16** | **zero cards uncovered anywhere; 197/270 exercised; 47/56 champions** |

**Build one deck per Legend.** It is the better default and the reason is
structural: a minimal card-cover collapses onto whichever Legends happen to hold
the most cards — the 6-deck cover used only 4 distinct Legends of 16, leaving 12
Legends, their abilities and their eligible champions completely unplayed. Legends
are cards too, they are never "played", and a Legend that is nobody's Legend is
exercised by nothing. Do this per SFD Legend as the set's decks come together.

Use real decklists alongside it, for realistic curves and the interactions that
actually arise — not for coverage.

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

### What this actually found — one bug, and four ways to be wrong about a bug

Generated decks turned up five suspicious cards on an engine whose 1822 tests were
green. **Exactly one was a defect.** That ratio is the lesson, and chasing the other
four is what produced the reporting rules now built into `exercised.ts`.

**The real one, since fixed.** `chooseAction` threw on a legal board: *Get Excited!*
at a `[Deflect]` unit raised `"must pay 1 rainbow Power for [Deflect] on its target,
but named 0"` from inside `heuristic-ai`'s lookahead. `legal-actions` prices
`[Deflect]` per variant, but the discard-choice branch emits *before* that
re-pricing — and Get Excited!'s discard is MANDATORY, so the branch that skips the
tax is the only path it has. The AI trusts `legalActions` and calls the executor
directly, so the exception escaped and killed the game. Third instance of the
offered-then-refused shape in that one file, and the second found by a probe rather
than by reading.

**The four that were not defects, and what each teaches:**

1. **Resource abilities are declined ON PURPOSE.** Six `Seal of X`, Kai'Sa and
   Darius read `[Exhaust]: [Add] <resource>` and are offered thousands of times
   without ever being taken — because `heuristic-ai`'s `abilityBanksResource`
   deliberately drops them from the candidate pool. `evaluate` scores board state,
   so a banked resource can only tie with Pass, and this project has a standing rule
   against speculative heuristics with no evaluative basis. Miss Fortune's
   `[Ganking]`, Sun Disc and Ravenborn Tome are not filtered but lose for the same
   reason: their value lands on a turn the 1-ply evaluator cannot see.
2. **"Never played" is not "never offered".** OGN-004 Cleave looked dead at 8 games;
   at 30 games it was offered 265 times and taken once. Small samples manufacture
   certainties.
3. **A card in a deck is usually never SEEN.** A game runs 5–8 turns and draws about
   **10 distinct cards of 39**. OGS-011 Flash sat in a deck for 10 games, was drawn
   in none of them, and read convincingly as an enumeration bug. Check a card was
   drawn before calling it a defect — and to reach one, use the 3-copy maximum and
   vary the seed, because more games alone buys less than it looks like.
4. **Two Legends are structurally invisible to the instrument.** A purely CONTINUOUS
   effect (OGS-019 Master Yi's `mightBonus`) produces no action, Chain item or
   event; and `beginningPhase` is the one trigger family still resolved inline, so
   it never reaches `pendingTriggers` (OGN-251 Jinx - Loose Cannon's Legend). Both
   report unexercised forever. **Unmeasured, not untested** — and do not paper over
   it by marking them exercised, which converts a known blind spot into a silent lie.

`exercised.ts` now separates `inDeckButNeverOffered` from `offeredButNeverTaken` so
these cannot be confused again, and asserts the one invariant that would have caught
the real bug: **everything the AI played must be something `legalActions` offered.**

## What to leave behind — write this before you stop

Whatever you finish, end by writing **`docs/handoff-<the date>.md`** and committing
it with the last change. This repo runs on those handoffs; the one you were told to
read first is the reason you know any of the above — and note that it is now 27
commits stale, which is why the delta had to be written into THIS document
instead. That is the failure mode to avoid, not to copy. Write it from **measurements
taken at the final commit, not from memory of what you did** — say so at the top,
and note the sha and branch. Where a figure contradicts an existing memory note,
say which one is later.

It must carry:

- **What the session actually did**, one line per commit, in order — so a
  regression stays bisectable by reading rather than by guessing.
- **A figures table**, re-run at the end, not copied from mid-session: engine and
  web test counts, per-set coverage from `coverageBySet`, the **five** probe
  results (`exercised` included), the battlefield count if SFD prints any, and any
  live-probe counts. If a probe MOVED, say whether you verified it against
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
