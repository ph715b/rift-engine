# Kickoff: Rift-Engine (TypeScript Riftbound rules engine)

This is the start of a new project. Paste this whole file as your first message in a new session
(or `@`-reference it) so the session has full context without re-deriving history.

## What this is

A personal project: a TypeScript rewrite of a Riftbound (Riot Games' TCG) rules engine, at
`A:\Projects\Rift-Engine`. Read `docs/PRD.md` in this repo fully before writing any code — it has
the full goals, scope decisions, and open questions. This file is the condensed version for getting
a session started.

**Priority order — don't default to "two-player local game" as the target, that's a prior draft's
assumption and has been explicitly corrected:**

1. **Single-player vs. AI is the near-term primary goal, not a stretch feature.** Build the AI
   opponent (ported/adapted from `HeuristicAI` or built fresh) as soon as the core loop works — the
   full ruleset without a real opponent to play against isn't "done" for this project's purposes.
2. **An interactive board is a near-term requirement, not a "Web UI (stretch)" milestone at the
   end.** The user has said explicitly they will not playtest decks via CLI/text output no matter
   how correct the engine is — so a text-only "playable" milestone doesn't actually get used. A
   CLI may still get built as an internal engine-debugging tool, but it is not the target interface
   and is not a gate the board waits on. Bare-bones styling is fine; it has to be clickable.
3. **Deck playtesting is a first-class use case**, not just "play the full game." The user wants to
   build/edit a hypothetical decklist (including cards they don't own yet) and play a bunch of quick
   games against the AI to feel out whether it's worth building in paper — so deck input can't be
   limited to importing the 8 existing `.deck` files, and rematches need to be fast (no full re-setup
   each game).
4. **Premade decks = the real Origins "Proving Grounds" precons, not invented sample decks.**
   `DeckPresets.java` in the Java oracle already has these four (Annie/Garen/Lux/Master Yi) —
   reuse that data. Add each new set's starter decks the same way as that set gets implemented.
5. **Local hotseat (human vs. human, one machine) is a testing/parity tool only**, not a target UX.
6. **Remote/online play is the actual long-term motivation** (letting people who can't meet in person
   play each other) but is deliberately deferred until the AI and core rules are solid — don't design
   toward it yet, and don't build it early either.

## This is not a rules-unknown greenfield project — read this before guessing at any rule

Two prior, independent, working implementations of the real Riftbound ruleset already exist on this
machine:

- **`A:\Projects\riftbound-engine`** — Java 21/JavaFX. The **frozen oracle**: correct after ~15
  months of card-by-card bugfixing. **Never edit this repo.** Run `mvn -o javafx:run` from inside it
  to check "what should actually happen" in any ambiguous scenario — faster and more reliable than
  guessing from memory of the rules.
- **`A:\Projects\riftbound-engine-cs`** — a C# port, functionally complete (4 sets, 768 cards,
  1103+ tests). Read `CONVENTIONS.md` there for real architecture lessons (sealed-hierarchy
  modeling, effect-registry design, exhaustiveness checking) before designing the TS equivalents —
  TypeScript will hit analogous shape questions with different idiomatic answers (discriminated
  unions + exhaustive `switch`/`never` checks instead of C#'s `abstract record`/sealed-class split).
- **`A:\Projects\riftbound-engine-logs\Core-Rules-Audit\core-rules-audit-mission-prompt.md`** — a
  rules audit that fetched the official Core Rules PDF + patch notes and found six confirmed
  rules-vs-engine gaps (since fixed in the Java engine). Good source for real rules detail and for
  the citation discipline this project expects (cite the actual rule, don't guess).
- **Card data**: `ogn.json` / `ogs.json` / `sfd.json` / `unl.json` exist, identical, in both repos
  (Java: `src/main/resources/cards/`, C#: `src/RiftboundEngine.Registry/Cards/`). Full schema:
  energy/might/power, type, rarity, domain, collector number, set, tags, rich/plain rules text with
  bracketed keywords like `[Accelerate]`. **Copy/reuse these directly.** Do not hand-transcribe card
  data.
- **Real decks to build toward playable with**: `C:\Users\patri\.riftbound\decks\*.deck` (8 decks,
  plain-text format — see PRD for the field layout). These are a starting point and a validation
  target, not the full scope — the user also needs to build/edit decks that don't exist as a file
  yet, for playtesting before buying/building them physically.
- **Premade decks**: `A:\Projects\riftbound-engine\src\main\java\com\riftbound\registry\DeckPresets.java`
  has the four official Origins "Proving Grounds" preconstructed decks (Annie, Garen, Lux, Master
  Yi) — reuse this data directly for Rift-Engine's built-in premade decks rather than inventing
  sample decks. Add each new set's starter/precon decks the same way as that set is implemented.
- A separate, unrelated-to-this-project Unity/C# integration (`A:\Projects\riftbound-unity`) is in
  progress elsewhere. **Rift-Engine is a deliberate, independent rewrite, not a continuation of
  that line** — don't try to reconcile or merge the two.

## First open decisions — resolve with the user (e.g. via AskUserQuestion) before committing code

1. **Full 768-card scope vs. scoped to the user's 8 existing decks first?** The latter is almost
   certainly the faster path to "actually playable" — confirm before building out card coverage.
2. **Strict line-by-line port of the Java rules logic, vs. reimplementation guided by the Java
   engine as a behavioral oracle, with idiomatic TS types designed fresh?** Recommendation: the
   latter — TS's structural typing and discriminated unions don't map cleanly onto a literal port
   of Java's class hierarchy the way C#'s did.
3. **Verification strategy**: adapt real test scenarios from the Java/C# suites (cheap, high-value)
   vs. also building a lightweight cross-engine parity harness (run the same action sequence through
   Java/C# and TS, diff the resulting state) — the C# port explicitly skipped this and got away with
   it via careful code reading, but two agreeing reference engines now exist, making a lightweight
   version more tractable than before. Decide deliberately, don't default to skipping it again.

## Build order — already decided, don't relitigate

Sequential first: core types (Card/GameState/Action) → one real card/action resolved end-to-end
against a known-correct Java-oracle scenario → turn/priority skeleton → then expand. Do **not**
fan this initial work out to parallel agents — there's no stable state/action/effect contract yet
for them to build against consistently. Parallel agentic work (this project has precedent for a
Backend Dev / UI Dev / QA team shape, see the Core-Rules-Audit mission) is a good fit later, once
that contract is stable — e.g. one agent encoding a card set as data, one on UI, one on tests —
not for bootstrapping.

The first real candidate for a parallel split is the interactive-board + AI-opponent work (PRD
milestone M2), once the core loop (M1) lands: a UI-focused pass on the clickable board and a
backend-focused pass on the AI opponent can reasonably run side by side against the same
state/action contract, mirroring this project's own prior Backend/UI/QA mission shape.

## Working conventions to carry forward from this project's history

- Commit only when the user explicitly asks.
- Verify every change with a real build/test run, not assumed-correct code.
- The Java repo (`riftbound-engine`) stays frozen — reference oracle only, never edited.
- Cite the actual rule (rulebook section, or a specific Java file/line) rather than asserting rules
  behavior from memory.
- The user plays this game for real and tracks bugs by feel ("that interaction feels wrong") as
  well as by test failure — take gameplay-feel reports seriously, they've been real bugs before.
