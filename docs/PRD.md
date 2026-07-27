# Rift-Engine — PRD
### A TypeScript rewrite of the Riftbound rules engine

## Summary
A deliberate, from-scratch **TypeScript** rewrite of a Riftbound (Riot Games'
TCG) rules engine, at `A:\Projects\Rift-Engine`. This is a personal project,
separate from — and not a continuation of — the existing Java and C#/Unity
lines described below. It exists to get a browser-playable, single-codebase
(engine + UI) version of the game, built with the lessons and reference
material those earlier projects already produced.

Two concrete motivations drive the priority order below:
1. **Deck playtesting before physical purchase.** Being able to build a
   hypothetical decklist and actually feel how it plays against a
   reasonably good AI, before spending money/time building it in paper,
   is a primary use case — not just an end-state "play the full game"
   goal. This means deck input can't be limited to the 8 decks already in
   `~/.riftbound/decks`; the user needs to be able to construct/edit
   arbitrary decks (including ones they don't own yet) and play repeated
   games against them quickly. **Critically, this use case won't get used
   at all until there's an interactive board to play on** — the user has
   said outright they won't playtest via text output, no matter how
   correct the rules are underneath. A CLI-only milestone is not
   "playable" for this project's actual purpose; see Functional
   Requirement 8 and the Milestones section, both restructured around
   this.
2. **Eventual remote play** with people who can't meet up in person (see
   Non-Goals — deferred until the AI is solid).

## This is not a rules-unknown greenfield project
Two prior, independent implementations of the real Riftbound ruleset already
exist on this machine and should be treated as reference assets, not
reinvented from scratch:

- **`A:\Projects\riftbound-engine`** — Java 21/JavaFX. ~15 months of
  card-by-card bugfixing against the real rules. Documented elsewhere as the
  **frozen oracle**: never edit it, but it's runnable (`mvn -o javafx:run`)
  as a fast way to check "what should actually happen" in any ambiguous
  scenario.
- **`A:\Projects\riftbound-engine-cs`** — a C# port of the Java engine,
  functionally complete (all 4 sets, 768 cards, a heuristic AI, 1103+
  passing tests as of commit `ae6742b`). Its `CONVENTIONS.md` documents real
  architecture decisions worth learning from (sealed-hierarchy modeling,
  effect-registry design, exhaustiveness checking, cyclic-dependency
  handling) — a TS equivalent will hit analogous shape questions.
  - **A known, accepted gap**: the C# port skipped building a real
    differential-testing harness against the Java oracle. Correctness was
    verified by direct code reading + fresh tests instead. Now that *two*
    independent, agreeing reference engines exist, a lightweight
    scenario-based parity check for the TS engine is more feasible than it
    was for the C# port — worth deciding deliberately rather than repeating
    the same skip by default.
- **`A:\Projects\riftbound-engine-logs\Core-Rules-Audit\core-rules-audit-mission-prompt.md`**
  — a rules audit that fetched the official Core Rules PDF (2026-03-30) and
  patch notes and cross-referenced them against the Java engine, finding six
  confirmed gaps (win-condition strict inequality, Conquer-sweep draw
  compensation, Prevent, Burn Out, etc.), since fixed. Read this for real
  rules detail and citation style before guessing at edge cases.
- **Card data** already exists in a clean, complete form:
  `ogn.json` / `ogs.json` / `sfd.json` / `unl.json`, identical in both the
  Java (`src/main/resources/cards/`) and C# (`src/RiftboundEngine.Registry/Cards/`)
  repos. Each entry has energy cost, might/power, type, rarity, domain
  (color, e.g. "Fury"), collector number, set, tags, and rules text (rich +
  plain, with bracketed keyword references like `[Accelerate]`). **Reuse
  these files directly** — do not re-transcribe card data by hand.
- **Real decks to test against**: `C:\Users\patri\.riftbound\decks\*.deck`
  (plain-text format: `NAME=`, `LEGEND=<code>`, `CHAMPION=<code>`,
  `RUNE_A=<n>`, `RUNE_B=<n>`, repeated `CARD=<code>`, repeated
  `BATTLEFIELD=<name>`).
- **Premade/bundled decks already exist too**:
  `A:\Projects\riftbound-engine\src\main\java\com\riftbound\registry\DeckPresets.java`
  has the four official Origins "Proving Grounds" preconstructed decks
  (Annie, Garen, Lux, Master Yi), decklists sourced from riftmana.com and
  cross-referenced with riftDecks.com. **Reuse this data directly** rather
  than re-sourcing it. These — not made-up sample decks — are what
  Rift-Engine should ship with as its built-in premade decks; add each
  new set's starter/precon decks the same way as that set gets
  implemented.
- **A separate, in-progress `A:\Projects\riftbound-unity`** line exists on
  top of the C# port. Rift-Engine is intentionally independent of it.

## Goals
1. Reach the same rules fidelity as the Java oracle, using it (and the C#
   port) as ground truth rather than re-deriving Riftbound's rules from
   scratch or from possibly-incomplete model memory.
2. Get a solid single-player experience against an AI opponent working
   end-to-end first — this is a near-term primary goal, not a stretch
   item. Two things point at this same near-term target: (a) it's the
   fastest way to get real games in without needing a second player, and
   (b) it directly serves the deck-playtesting motivation — an AI weak or
   buggy enough to lose to bad decks makes "should I build this deck"
   unanswerable. Longer-term, the real motivation for this project is
   letting players who can't physically meet still play each other, which
   points toward eventual remote/online play — but that's explicitly
   sequenced after the AI opponent is good, not pursued in parallel.
3. Let the user build/edit arbitrary decklists — including decks they
   don't physically own yet — and quickly play repeated games against
   them, so a deck can be playtested before any money or time goes into
   building it in paper.
4. Keep the engine headless and pure (`(state, action) -> {legalMoves,
   nextState}`) so rules logic is unit-testable independent of any UI.
5. Be data-driven for cards: adding/enabling a card should mostly mean
   wiring up the existing JSON data, not writing new engine primitives,
   except for genuinely novel effect logic.

## Non-Goals (for now)
- Continuing or replacing the `riftbound-unity` / C# line — that stays a
  separate, parallel effort.
- **Local hotseat as the target UX.** Two-players-on-one-machine isn't
  what this project is for — the point is letting people who *can't* be
  in the same place play each other. A hotseat mode may still show up as
  an internal testing/parity tool (e.g. a human driving both sides to
  compare against the Java oracle), but it's not a goal in its own right.
- **Online multiplayer / netcode — deferred, not abandoned.** This is
  actually the long-term motivating goal (see Goals #2), but it's real,
  separate scope (networking, state sync, matchmaking) that shouldn't be
  started until the AI opponent and core rules are solid. Don't design
  the engine *against* this future need, but don't build toward it yet
  either.
- **Visual/production polish** (real card art rendering nicely, animation,
  sound, professional layout). Note this is narrower than "a board" — a
  *functional* interactive board (click a card, see it move, see game
  state at a glance) is a near-term requirement, not deferred; only the
  cosmetic polish on top of it is a non-goal for now.
- A full automated cross-language differential-testing harness on day
  one — worth scoping deliberately (see open questions), not assumed.

## Decisions already made
- **Scope**: full playable simulator, not just a rules validator.
- **Stack**: TypeScript throughout (engine, CLI, and eventual web UI share
  one codebase and types). A schema library (e.g. Zod) for
  runtime-validating the existing card JSON.
- **Build order**: skeleton + core types + one full vertical slice (one
  real card, one action, resolved end-to-end, tested against the Java
  oracle's known behavior) + the turn/priority skeleton, all sequentially,
  before splitting any work across parallel agents.
- **Where agentic teams fit**: not for bootstrapping. This project's own
  history validates that pattern — the Core-Rules-Audit mission used a
  Backend Dev / UI Dev / QA agent team successfully, but only after ~15
  months of solo/sequential foundation work had produced a stable
  state/action/effect model to parallelize against. Rift-Engine should
  reach an equivalent stable contract before adopting the same team shape.

## Open questions — resolved 2026-07-26
1. **Card scope: RESOLVED — Origins only, not the full 768-card catalog.**
   Card pool is the two Origins-era sets: `ogn.json` ("Origins", set id
   `OGN`) + `ogs.json` ("Proving Grounds", set id `OGS` — the precon-exclusive
   legends/champions/signatures for the four `DeckPresets`, e.g. Annie's
   legend `OGS-017` and champion `OGS-010` are OGS, not OGN). Decks in scope:
   the 4 `DeckPresets.java` Proving Grounds precons (Annie/Garen/Lux/Master
   Yi) — these *are* Origins' starter decks, there's no separate "starter
   deck" concept beyond them (confirmed: OGN/OGS card loading only strips a
   `" (Starter)"` name suffix for alternate-art dedup, `CardLoader.java:289`,
   not a distinct deck list). The user's own 8 `.deck` files are explicitly
   **not** being ported — those get rebuilt fresh once the in-app deck
   builder exists. `sfd.json`/`unl.json` (later sets) stay out of scope until
   their own milestone. Expanding later is pure data addition (loader already
   reads the full JSON schema), not new plumbing.
2. **Port strategy: RESOLVED — reference-guided reimplementation**, not a
   strict line-by-line port. The Java engine is the oracle for *behavior*
   (cite file/line per its actual logic); TS types are designed fresh as
   discriminated unions with exhaustive `switch`/`never` checks. This also
   sidesteps a real C# pain point: `CONVENTIONS.md` in `riftbound-engine-cs`
   documents two forced physical-layout deviations (`registry`↔`engine`,
   `model`↔`engine`) purely to satisfy C# project-reference acyclicity while
   preserving Java's namespaces. TS modules tolerate circular imports
   (especially type-only ones) natively, so this whole class of workaround
   doesn't apply — package layout can follow the Java package boundaries
   directly without the C# port's namespace/folder split.
3. **Verification strategy: RESOLVED — adapt existing test scenarios from
   the Java suite only**, not the C# suite (the C# port is in limbo, not
   worth treating as a second reference right now) and not a cross-engine
   parity harness for now. Use the Java engine's source as a manual oracle
   for ambiguous cases; revisit an automated parity harness later if drift
   becomes a real problem.
4. **Why TypeScript over continuing Unity/C#**: browser accessibility and
   shareability (a link beats a Unity build for getting someone to actually
   try a deck), and a single engine+UI codebase/type system instead of
   engine (C#) and client (Unity/C#-but-different-runtime) staying two
   projects that must be kept in sync by hand.

## Functional requirements
1. **Card data model**: discriminated union covering Legend, Champion,
   Unit, Spell, Gear, Battlefield, Rune — mirroring the fields already
   present in `ogn.json`/etc. (energy, might, power, domain, rarity, tags,
   text) rather than inventing a new shape.
2. **Deck import, editing, and validation**: three deck sources, not one —
   (a) the engine's own **premade decks**, which are the Origins "Proving
   Grounds" precons from `DeckPresets.java` (expand with each new set's
   starter decks as that set is implemented), (b) the user's real
   `.deck`-format decks under `~/.riftbound/decks`, and (c) **arbitrary
   user-built/edited decks** (any card in the loaded sets, not limited to
   an existing file) — the playtesting-before-buying use case depends on
   testing decks that don't exist as a saved file yet. Validate deck
   legality against the real rules (rune counts, card limits, etc., per
   the Java oracle) for all three.
3. **Game state model**: players, hands, decks, discard, runes/resources in
   play, units/gear on each battlefield, active battlefields, turn number,
   priority holder, phase, scoring/points — matching the Java `GameState`
   shape where reasonable.
4. **Turn structure & phases**: the real Riftbound phase sequence, ported
   from the Java `GameEngine`, not guessed.
5. **Action & legal-move generation**: enumerate legal actions for the
   player with priority (play card, activate ability, attack/Showdown,
   pass, etc.), matching `ActionValidator`/`ActionExecutor`'s real rules.
6. **Effect/ability resolution**: a resolver for triggered/activated
   abilities (ported from `EffectRegistry`/`OriginEffects`), including
   targeting and keyword mechanics like Accelerate, Prevent, and Burn Out.
7. **Combat & scoring**: Showdown resolution and Conquer/points scoring per
   `ShowdownResolver`/`ScoringSystem`, including the win condition's real
   two-part rule (points ≥ threshold **and** strictly more than every
   opponent — this was itself a confirmed bug in the Java engine's history,
   see the rules audit).
8. **Interfaces — revised: an interactive board is a near-term
   requirement, not a later stretch.** The user won't actually playtest
   decks against text output, so pushing the board to a late "Web UI
   (stretch)" milestone would mean the engine never gets used for its main
   purpose. The target for "playable" is a minimal but genuinely
   interactive web board (click a card to play it, see hand/board/points
   at a glance) driving a single human player against the AI — bare-bones
   styling is fine, but it must be clickable, not text-in/text-out. A raw
   CLI may still get built alongside this as an internal engine-debugging
   tool (fast to script, good for automated sanity checks), but it is not
   the user-facing target and isn't a prerequisite gate before UI work
   starts. Local hotseat/two-controller mode remains a secondary testing
   tool, not the target UX. Remote/online play comes later still.
9. **AI opponent — primary near-term requirement, not a stretch goal.**
   Port or adapt `HeuristicAI`, or build a fresh heuristic against the new
   engine, so there's a real opponent to play against as soon as the core
   loop works. Getting this good is the priority before anything
   online-play-related is even scoped.
10. **Fast rematch loop**: replaying the same or a tweaked deck against
    the AI repeatedly (new shuffle, same or edited decklist) should be
    quick — no re-doing setup from scratch each game. This directly
    serves "play a bunch of games to feel out a deck," not just "play one
    game to completion."

## Non-functional requirements
- **Testability**: every rule has a unit test; prefer adapting a real test
  scenario from the Java/C# suites over inventing one from scratch.
- **Determinism**: seeded RNG for shuffling so games are replayable.
- **Extensibility**: new cards should mostly be data, not new engine code.

## Milestones
- **M0 — Skeleton**: project scaffold, core types (Card, GameState, Action),
  the existing card JSON loading + validating, one real card + one action
  resolved end-to-end with a passing test, checked against the Java
  oracle's actual behavior for that scenario. Headless — no UI yet, this
  is pure engine plumbing.
- **M1 — Core loop**: full turn/phase/priority skeleton ported from
  `GameEngine`, deck import/validation covering all three deck sources
  (Proving Grounds presets, the user's real `.deck` files, and
  user-built decks), a full turn playable with real (not placeholder)
  cards. Still headless — this is the stable contract the next milestone
  builds on.
- **M2 — Playable v1: interactive board + AI opponent.** The main event.
  Enough of the real ruleset plus a working AI opponent (ported/adapted
  from `HeuristicAI` or freshly built) to play a full game to a real win
  or loss, through a minimal but genuinely clickable web board (not a
  CLI) — bare-bones styling is fine, but it has to be a board the user
  can actually interact with, since that's the condition for the
  deck-playtesting use case getting used at all. Once M1's state/action
  contract is stable, the board and the AI are plausible candidates for
  parallel work (a UI-focused pass and a backend/AI-focused pass) rather
  than doing both solo/sequentially — this project has direct precedent
  for that split (the Core-Rules-Audit mission's Backend/UI/QA team). A
  raw CLI may exist alongside this purely as an internal debugging tool;
  it is not a gate M2 waits on.
- **M3 — Hotseat mode (optional/testing)**: human vs. human on one
  machine, primarily useful for parity-testing the engine (one person
  driving both sides) rather than as an end-user feature.
- **M4 — Board polish (stretch)**: real card art rendering well, better
  layout, animation, sound — cosmetic improvements on top of the M2 board,
  not new interactivity.
- **M5 — Remote/online play (future, after AI is solid)**: real, separate
  scope — two players connecting from different machines. Deserves its
  own design pass (networking model, state sync) when it's actually time;
  not to be pulled forward or designed against prematurely.

## Success criteria
- A single human player can play a legal, rules-correct game of Riftbound
  against the AI opponent, on an interactive board they can click through
  (not text output), using either a Proving Grounds preset, one of their
  real decks, or a deck they built in the app, through to a win or loss.
- Core rules (resources/runes, combat, scoring, priority, win condition)
  are covered by unit tests adapted from or checked against the Java
  oracle's known-correct behavior.
- Adding a new card requires adding data, not rewriting engine logic, for
  the vast majority of cards.
- Remote/online play is not attempted until the AI opponent is solid
  enough to be the primary way people actually play.
