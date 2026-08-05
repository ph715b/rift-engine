# Spiritforged (SFD) — survey and cluster plan

Written 2026-08-05 at `e6d1e7e`, branch `feat/showdowns-timing-and-chain-viewer`.
**Every figure here was measured at that commit, not recalled.** This is step 2 of
`docs/sfd-implementation-prompt.md`'s sequence — the survey that must exist before
any card is written.

The data landed in the commit above. This document is what to do with it.

---

## The headline, and the one thing the prompt got wrong

| | |
|---|---|
| raw entries in `sfd.json` | 288 |
| kept by `shouldSkip` | **206** |
| needing code (`needsImplementation`) | **204** |
| needing NO code | 2 |
| battlefields (outside every number above) | **15** |
| implemented today | 1 card, 0 battlefields |

206 + 15 = the set's printed 221, which is the arithmetic that says nothing was
dropped on the way in.

**The prompt predicted two missing subsystems, XP and Equipment. XP is not one
of them.** `[Hunt]` and `[Level]` — the whole rule-728 XP resource — are
**Unleashed's**, not Spiritforged's, and so are `[Ambush]` and `[Backline]`.
Measured over `sfd.json`: zero SFD cards print any of the four. The answer was
also sitting in two places nobody had to measure — `model/keyword.ts`'s own doc
comment and the oracle's `Keyword.java`, which both say outright that
EQUIP/WEAPONMASTER/QUICK_DRAW are SFD and HUNT/LEVEL/AMBUSH/BACKLINE are UNL.

So the `[Ambush]` framing question about reinforce-by-presence — which the prompt
flags as a possible existing divergence for every unit in the pool — **is not on
SFD's critical path**. It is real, and it is UNL's problem. Do not spend the
first day of SFD on it.

**What the prompt did not predict is `[Repeat]`**, and it is a second subsystem.

---

## The four clusters, and they are disjoint

Measured, and they sum exactly: 53 + 15 + 136 = 204, with **zero** cards in more
than one subsystem bucket.

| cluster | cards | blocked on |
|---|---|---|
| **Ordinary card bodies** | **136** | nothing — existing primitives |
| **Equipment / attachment** | **53** | a subsystem that does not exist |
| **`[Repeat]`** | **15** | a subsystem that does not exist |
| needs no code at all | 2 | — |

> **Corrected 2026-08-05, after the first version of this table was written.**
> The Equipment bucket was first measured at 43 by asking which cards print a
> blocked KEYWORD. Ten more say "attach an Equipment", "detach", or "each
> Equipment attached to me" **in prose, with no bracket** — Rell - Magnetic,
> Angle Shot, Aphelios - Exalted, Gearhead, Strike Down, Relentless Pursuit,
> Arise! among them. They are blocked exactly as hard as the bracketed ones, and
> the keyword scan could not see them. Re-measured on `implementableText`, which
> strips keywords and reminder text, so the match is against the text that
> actually needs writing. **Sending those ten to a card-wave agent would have
> produced precisely the "registered against a primitive that does not work"
> failure this repo hits most often.**

That disjointness is the plan's whole shape: **136 of 204 cards are not blocked on a KEYWORD
on anything.** The set is far less subsystem-bound than "two missing subsystems"
suggests, and the ordinary bodies can be fanned out over per-domain effect files
on day one without waiting for either subsystem to land.

### Cluster 1 — the 136 ordinary bodies, split into fan-out and central

**The shared-file extraction is DONE** (it was listed here as the wave's first
task, and it is now the table below). The split matters because the seven
per-domain files each own their own `cardEffects` / `unitTriggers` /
`eventTriggers` / `selfTriggers` / `deathTriggers` / `deathWatchTriggers` /
`decisions` registries and are merged by `effects/index.ts` — which **throws on
a duplicate defId** rather than last-write-wins. Those seven registries are the
parallel-safe surface. Everything else is a single-owner shared file.

**105 cards fan out**, one agent per disjoint file:

| file | cards |
|---|---|
| `effects/order.ts` | 20 |
| `effects/chaos.ts` | 18 |
| `effects/fury.ts` | 16 |
| `effects/mind.ts` | 16 |
| `effects/calm.ts` | 15 |
| `effects/body.ts` | 13 |
| `effects/signature.ts` | 7 |

**31 cards stay CENTRAL**, because their text lands in a file two agents would
collide in:

| shared file | cards |
|---|---|
| `cost-modifiers.ts` | 10 — Void Drone, Battering Ram, Needlessly Large Yordle, Production Surge, Yordle Explorer, Jaull-Fish, Irelia - Graceful, Vex - Cheerless, Ezreal - Prodigy, Drag Under |
| `activated-abilities.ts` | 9 — Assembly Rig, Poro Snax, Heart of Dark Ice, Hextech Anomaly, Renata Glasc - Mastermind, Ancient Henge, Vanguard Armory, Ornn - Fire Below the Mountain, Ezreal - Prodigal Explorer |
| `legend-abilities.ts` | 9 — the Legends that are not Equipment-blocked |
| `board-restrictions.ts` | 2 — Minotaur Reckoner, Ruin Runner |
| `effective-might.ts` | 2 — Rumble - Scrapper, Trusty Ramhound |
| `combat.ts` + `death-replacement.ts` | 1 — Soraka - Wanderer, which needs both |

Three cards appear under two shared files (Ornn and Ezreal are Legends with an
activated ability; Soraka needs assigned-last AND a death replacement), so the
row counts sum to more than 31.

**This table is a TRIAGE, not a verdict.** It is pattern-matched over
`implementableText`, and its first version was wrong in both directions —
`[Tank]`'s reminder text scored as a combat rule and "a card with cost no more
than 3" scored as a cost modifier, while ten Equipment cards went unseen.
Confirm per card before handing a list to an agent; the value here is that
nothing lands in a shared file by surprise, not that every row is settled.

### Cluster 2 — Equipment / attachment (53 cards)

The big one, and single-owner work. `[Equip]` alone is on 46 printings.

What the engine has: `activeGear` as a flat per-player list, with **no attachment
concept at all**. `Listener.battlefieldId`'s comment says "Gear is never at a
battlefield in this pool" — SFD falsifies that, because the rules place an
Equipment attached to a unit at that unit's battlefield.

What it needs, from the rules and from the oracle's SFD Round 2:

- an attach relation (Equipment → unit), and the Cleanup that recalls an
  Equipment when its unit dies
- `[Equip] <cost>`: an activated ability that attaches
- `[Weaponmaster]`: on play, may `[Equip]` one of your Equipment to me for 1
  rainbow less — note "even if it's already attached"
- `[Quick-Draw]`: the Gear has `[Reaction]`, and attaches on play

**The oracle has already built all of this** — see `riftbound-engine`'s
`docs/backend-progress.md`, "SFD Round 2", plus `Card.Gear.equipCost`. It is a
behavioural oracle for the exact subsystem, which is a much stronger starting
position than the prompt assumed.

Three SFD battlefields also touch it (Forge of the Fluft, Ornn's Forge, Veiled
Temple's "if it's an Equipment, you may detach it"), so the detach direction is
required, not optional.

### Cluster 3 — `[Repeat]` (15 cards, 14 spells + 1 gear)

"You may pay the additional cost to repeat this spell's effect."

Not a unit keyword. In the oracle it is a resumable choice —
`pendingRepeatChoice`, `effectiveRepeatCost`, `maybeOfferRepeat` — with one
canonical cost computation shared by the eligibility check, the validator and
the payment, explicitly so the three cannot drift.

**This is the cluster to read `docs/rules-conformance.md` about before starting**,
because "offer a choice while a spell is resolving" is adjacent to the Pending
vs Finalized work (rule 402 steps 2-4) that the previous handoff records as
blocked on the Cleanup not being a resumable state machine. Whether `[Repeat]`
can be built without that machine is the first question to answer, and it is
worth answering before writing any of the 15.

Marai Spire (SFD-211) reduces `[Repeat]` costs, so the cost computation has to be
a single function from the start rather than a constant — the oracle's note says
its own version reads "[Repeat] costs", not "printed [Repeat] costs".

### Cluster 4 — the 15 battlefields

Gated by `test/battlefield-coverage.test.ts`, now scoped per set so they report
`0/15` as progress instead of failing. Three of the three tables already exist.

Sorted by what they need:

- **Need nothing new (9)** — Emperor's Dais, Forgotten Monument, Hall of Legends,
  Minefield, Power Nexus, Ravenbloom Conservatory, Rockfall Path, Seat of Power,
  The Papertree. Conquer/hold/defend triggers and two continuous restrictions.
- **Need Equipment (3)** — Forge of the Fluft, Ornn's Forge (gear cost), Veiled
  Temple (detach).
- **Need `[Repeat]` (1)** — Marai Spire.
- **Need a token (2)** — Treasure Hoard and Emperor's Dais play Gold / Sand
  Soldier tokens.

Two shapes to respect, both learned the hard way in the OGN battlefield work: a
battlefield's entry is a **list** of abilities, and a delayed half must
**capture** what it needs at fire time because `runEnd` clears every "this turn"
field before the trigger it fired resolves.

---

## The 12 Legends, and the coverage plan that follows from them

SFD prints 12 Legends, one for each of 12 of the 15 possible domain pairs
(Fury+Calm, Mind+Body and Chaos+Order are absent):

Rumble - Mechanized Menace (Fury+Mind) · Lucian - Purifier (Fury+Body) · Draven -
Glorious Executioner (Fury+Chaos) · Rek'sai - Void Burrower (Fury+Order) · Ornn -
Fire Below the Mountain (Calm+Mind) · Jax - Grandmaster At Arms (Calm+Body) ·
Irelia - Blade Dancer (Calm+Chaos) · Azir - Emperor of the Sands (Calm+Order) ·
Ezreal - Prodigal Explorer (Mind+Chaos) · Renata Glasc - Chem-Baroness
(Mind+Order) · Sivir - Battle Mistress (Body+Chaos) · Fiora - Grand Duelist
(Body+Order)

**Build one deck per Legend.** That is the measured result from OGN+OGS, not a
preference: one-deck-per-Legend reached zero uncovered cards where a minimal
greedy card-cover collapsed onto 4 Legends of 16 and left 12 Legends, their
abilities and their eligible champions completely unplayed. Twelve SFD decks is
the target.

**Rek'sai is the reason this matters immediately.** She was the only Legend in
the pool with no eligible champion — the data cases her name `Rek'sai` while both
her champions are `Rek'Sai` — so no legal deck could be built for her at all.
Fixed in `e6d1e7e`. That defect was invisible to every measurement except the
one test that asks whether each Legend has a champion, and a per-Legend deck plan
is what would have caught it in play.

---

## What the instruments say today, and what they will not tell you

| instrument | SFD |
|---|---|
| `coverageBySet` | **1/204 implemented**, 58 partial |
| battlefield gate | **0/15** |
| `exercised` | `inDecks` **0**, `exercised` **0** |

`exercised`'s totals moved exactly as predicted and in only one direction:
`inDecks`/`exercised` are flat at **105/99**, while `neverExercisedNeedingCode`
went **189 → 393** — a rise of exactly 204, SFD's `needsCode`. Every SFD card
starts unreachable by construction, because the seven preset decks are pinned.

**So every AI gate is blind to SFD until a deck contains an SFD card**, and a
green probe run says nothing about this set. The 12 Legend decks above are what
makes the probes able to see it; until they exist, `coverageBySet` measuring
"implemented" is the only signal, and it is the weaker of the two questions.

---

## Order of work

1. **Cluster 1, the 136 ordinary bodies.** Not blocked on anything, fans out over
   seven disjoint per-domain effect files (105 of them; the other 31 are shared-file
   work and are listed above), and is 67% of the set. Extract the
   shared-file cards first and keep them central.
2. **The 9 unblocked battlefields**, which need no new primitive and close most
   of a hard gate.
3. **Equipment**, single-owner, with the oracle's Round 2 as the reference. The
   3 remaining battlefields fall out of it.
4. **`[Repeat]`**, single-owner, after settling whether it needs the resumable
   Cleanup. Marai Spire falls out of it.
5. **The 12 Legend decks**, so `exercised` can see any of the above. Worth
   starting earlier than this position suggests — a deck per Legend can be built
   for cards that are already done.
6. **Promote SFD into `COMPLETE_SETS`** when `finishedButUndeclared` says so.
   Both the card gate and the battlefield gate read that one list.

---

## Wave 1 result — measured 2026-08-05 at `c964783`, and it corrects this document

Seven agents over the seven files above wrote **46 whole cards and 6 halves**.
SFD went **1/204 -> 47/203** (the denominator moved because Laurent Bladekeeper's
prose keyword was bracketed, so he needs no code). Per file: calm 11, order 10,
chaos 9, fury 8, body 6, mind 4, signature 4.

**Of the 105 cards handed out, 52 were registered and 53 were refused.** That is
the number this document got wrong, and the reason is worth stating plainly.

### The "blocked on nothing" figure was wrong, and no pattern could have found it

The triage above detects **shared-file** needs by matching text. It cannot detect
a **missing primitive**, because "kill a gear", "prevent it", "play a Gold gear
token" and "lose control of that unit at end of turn" look exactly like ordinary
card text. So "136 ordinary bodies blocked on nothing" was really *"136 cards
that do not print a blocked keyword and do not obviously land in a shared file"*
— a much weaker claim than it read as.

**The refusals are the deliverable here.** They are far more specific than
anything derivable by reading, and every one names the file that owns the gap.

### The largest finding: there is no GEAR TOKEN, and it was not predicted

`token.ts` mints `UnitInstance` only. The Gold token (`sfd-t03`) is dropped from
the pool by `shouldSkip`'s Token-supertype rule, so it has no `CardDefinition` to
reference at all. **Four agents hit this independently, across eleven cards** —
Bushwhack, Draven - Vanquisher, Chemtech Cask, Plundering Poro, Wages of Pain,
Card Sharp, Fae Dragon, Eminent Benefactor, Honest Broker, Trove Golem, Blood
Money — plus the two battlefields (Treasure Hoard, Emperor's Dais) already known
to need it. It is a subsystem, and it is the highest-value single piece of work
the wave produced.

### The other primitives the refusals named

| primitive | owns it | blocks |
|---|---|---|
| gear token + Gold's ability | `token.ts`, `activated-abilities.ts` | 11 cards, 2 battlefields |
| a combat-WON event (466.5.a) | `triggers.ts`, `combat.ts` | Corrupt Enforcer, Draven - Vanquisher, Draven - Audacious |
| `unitChosen` event (Targeting Effects) | `triggers.ts`, `execute-play-card.ts` | Irelia - Fervent, Jae Medarda, Spirit Wheel |
| rule 438 Prevent | 4 shared files | Counter Strike |
| controller vs owner | `model/game-state.ts`, `turn-manager.ts` | Hostile Takeover |
| gear-shaped targeting and costs | `card-effects.ts` + enumerator/validator | Detonate, Factory Recall, Legion Quartermaster, Zaun Punk |
| optional ENERGY additional cost | `card-effects.ts` + enumerator/validator | Sea Monkey, Blast Corps Cadet |
| conditional enter-ready | `deploy.ts` | Direwing, Xin Zhao - Vigilant, Dunebreaker |
| a guarded `gainPoints` | `scoring.ts` + 7 other sites | Tianna Crownguard |
| `unitList` on a UNIT trigger | `unit-triggers.ts` | Fae Dragon |
| dynamic keyword VALUE | `granted-keywords.ts`, `effective-might.ts` | Ancient Warmonger |
| `KEYWORD_AURAS` with a tag predicate | `granted-keywords.ts` | Forecaster, Petricite Monument, Rumble - Hotheaded, Breakneck Mech |

### Six cards are written as halves

All six reported `impl=true` with **no** partial note before the entries were
written — measured. Each was flagged by the agent that wrote the other half;
none could add the entry, because `coverage.ts` is shared. They are SFD-004,
SFD-020, SFD-027, SFD-057, SFD-123 and SFD-175, and each entry names the missing
half. Three test files asserting "coverage reports these as implemented" then
went red — TRUE when written, correctly false after — and were split into
whole-cards and partials rather than weakened.

### What this changes about the order of work

The 9 unblocked battlefields and the gear token are now the two cheapest real
advances. **Do the gear token first**: it unblocks eleven cards and two of the
fifteen battlefields, and nothing else in the set has that leverage.

## What NOT to do

- Do not build the XP resource. It is Unleashed's.
- Do not settle the `[Ambush]` placement question as SFD work.
- Do not fan agents out over `card-effects.ts`, `unit-triggers.ts`, `triggers.ts`,
  `effective-might.ts`, `cost-modifiers.ts`, `card-loader.ts` or `combat.ts`, or
  over either subsystem.
- Do not read a green `exercised` as saying anything about SFD until a deck
  contains one of its cards.
