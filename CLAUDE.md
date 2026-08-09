# Rift-Engine — the things a session must not re-derive

Read `docs/SESSION_KICKOFF.md` for what this project is and `docs/PRD.md` for
scope. This file is only the operational rules that have cost real time when a
session got them wrong.

## The verification loop, in this order, every time

```bash
npm test                                          # ROOT — BOTH workspaces
npm run build --workspace=@rift-engine/engine     # BEFORE the typecheck AND any probe
npm run typecheck                                 # both workspaces; COUNT the errors
npm run build
cd packages/engine
node probes/{ai-health,passive-human,chain-depth,walkout,reachability,hunt-xp}.ts
```

**`hunt-xp` is here because `reachability` CANNOT see XP.** A keyword is not a
registered card effect, so nothing in the exercise log records one firing —
`reachability` did not move at all when `[Hunt]` landed, which is neither
evidence for nor against it. XP has one writer (`gainXp`), so "did any player's
XP ever rise in a real game" is the only question that settles whether the
keyword is live or inert in play. Expect every XP keyword to need this probe
rather than the coverage gates.

`reachability` REPLACES the two `exercised` lines that used to sit here — it runs
the preset decks and one covering run per set in a single 10-second process, and
gates every instrument control both of those lines gated, per run. `exercised.ts`
is still the per-mode drill-down (`DECKS=sfd node probes/exercised.ts`, plus
`mostPlayed` and the offered/taken split); it is no longer the thing that has to
be remembered twice.

**Step 1 is the ROOT `npm test`, not `npx vitest run` in `packages/engine`.**
This has now bitten twice, both times the same way: an ENGINE change breaks a
WEB test and nothing else can see it. The typecheck passes (the change is
well-typed), the build passes, and the probes never load the web package.
`packages/web` has ~100 tests and they are the only thing that reads the engine
the way the app does.

- 2026-08-06: an engine validation message broke `auto-payment.test.ts`, which
  asserts on that exact string. Red across several commits.
- 2026-08-07: finishing SFD broke `card-filters.test.ts`, whose premise was that
  the pool HAS unimplemented cards to hide. Red for a whole session, and the
  session shipped a set-completion milestone on top of it.

**Step 2 is not optional.** `@rift-engine/web` resolves `@rift-engine/engine`
from `dist`, and so do the probes. An engine fix is invisible to both until the
engine is rebuilt — a source change that "does not work" has usually just not
been built.

**Step 3 has its own trap.** The engine's `build` tsconfig EXCLUDES tests;
`typecheck` includes them. So `typecheck` can sit red for months while the build
stays green. Read it to the END (`tail` shows a misleading subset), and when it
is red, diff the error list against HEAD before assuming the errors are yours.

**Pinned probe figures.** `walkout` is **191 walkouts / 107 points / 32 closed
with nobody present**. A change to combat, timing or Might math that moves these
needs the new number explained, not accepted.

`reachability` is pinned at **473 of 693 cards needing code ever exercised**
(OGN 224/248, OGS 20/22, SFD 186/198, UNL 43/225), at its default **250 games
per mode**,
which takes ~60s. A FLOOR, not an equality — it is supposed to rise, and the
probe prints a line asking for the pin to be bumped when it does. A DROP is red.

**Do not read its buckets from a shallow run.** The depth is load-bearing and was
measured: at `GAMES=40` the same probe reports 101 never-exercised and 8 cards
"the engine never offered", and **7 of those 8 are pure sampling** — Punch First
is offered 59 times once the games are deep enough. The pin and the allowlist are
therefore asserted ONLY at 250; at any other `GAMES` they report but do not gate.

## Do not copy this loop into a handoff

Every SFD/battlefield prompt in `docs/` wrote its own copy, they drifted, and the
copy in front of the session won over the correct one. Handoffs link here.

The same rule applies to any list the engine merges from several sources — the
trigger census was wrong four times, always by hand-copying one of them.

## Citing a rule: use `pdftotext -raw`, NEVER `-layout`

**`-layout` puts the rule numbers in a column that does not line up with their
text, and every wrong citation in this repo came from reading it anyway.** Three
were found in a single day: "rule 1678" (a line number), Frostcoat Cub's "707.2"
(a rule that does not exist, justifying a Might floor that should not exist), and
"rule 2701" (another line number, which I then passed into an agent brief).

`-raw` emits the document in reading order with each number attached to its own
text, and it settles these instantly:

```bash
pdftotext -q -raw "docs/Riftbound Core Rules Updated 2026-07-16.pdf" - | grep -n "the sentence you mean"
```

Measured against it, citations this repo had been carrying:

| claim | was cited as | actually |
|---|---|---|
| a unit "is Mighty" at 5+ Might | 711 *and* 812, in two files | **708** |
| a unit "becomes Mighty" crossing 5 | 715 | **709** |
| "you may pay X. If you do…" is not a cost | 204 | **205** |
| Might below 0 is treated as 0 when referenced | (cited by neighbour) | **143.2.b** |

The current PDF is downloadable from Riot's CDN — the project owner supplied
`https://cmsassets.rgpub.io/sanity/files/dsfx7636/news_live/e9ac8e3d33e0f78cef296f5945aba7bc1313b086.pdf`.
**Cite by neighbour only when `-raw` genuinely cannot resolve it**, which is now
rare. The one scope doc that hedged this way was tightened on 2026-08-09 and
`-raw` resolved every claim in it exactly (XP **728–733**, `[Hunt]` **823**,
`[Level]` **824**) — so treat a surviving "cited by neighbour" as a to-do, not as
a limit of the tooling.

**And the swapped-subrule failure is the one `-raw` does NOT catch.** Found
2026-08-09 by a wave-2 agent: **72 comments in `src/` cite `355.9.b` for "a bare
noun includes units in base".** That is the wrong half. `355.9.a.1` is the
WIDENING — "'Unit,' 'gear,' and 'rune' refer to objects on the Board unless
specified otherwise" — while `355.9.b` is the NARROWING, "It meets all targeting
restrictions", which is what makes a printed "at a battlefield" load-bearing.
Both sub-rules are real and both matter, which is exactly why this survived: the
citation resolves to a genuine sentence, just not the one being relied on. When
checking a number, read the sentence it lands on and confirm it says the thing
the comment claims — a number that resolves is not yet a number that is right.

## Measure before planning

It has changed the plan every single time. Ask the instruments, not the notes:

- `coverage.coverageBySet` / `isCardImplemented` for what is actually written.
- `docs/rules-conformance.md` for what is written but DIVERGENT — 350+ rows, and
  "complete" means every card has an implementation, not that every card does
  what it prints.
- `probes/exercised.ts` for what is reachable in play, which is not the same as
  implemented.

**Notes about this codebase's own mechanisms have been wrong or stale ten times
out of eleven.** Every "needs subsystem X" note that was re-read against the code
turned out to be one field, one function, or already built for another card.
Re-read the code before believing any note, including a handoff's and including
this file's.

## Recording a divergence

A divergence recorded only in a commit message is lost. Write it into
`docs/rules-conformance.md` in the same change, and PIN it with a test that
asserts the wrong answer where the gap is reachable — so closing it fails loudly
instead of silently changing behaviour nobody was watching.

## Tests whose premise was that something was unfinished

Finishing a card, or a set, breaks them. **Fix the PREMISE, never weaken the
assertion**, and prefer rewriting the check so it cannot flip again: assert the
invariant (a filter PARTITIONS the pool) and prove the "it does something" half
on a SYNTHETIC subject that cannot be implemented out from under it.
`set-coverage.test.ts`, `coverage-drift.test.ts` and `card-filters.test.ts` all
do this now, each after flipping at least once.

## Editing source

Never bulk-edit with PowerShell — it mojibakes every em-dash and adds a BOM. Use
the Edit tool, or a Python round-trip with explicit `utf-8` and `newline=""`;
the repo is CRLF, so a multi-line search string joined with `\n` silently will
not match. `assert` every replacement landed.

Back a file up to the scratchpad before mutation-testing: `git checkout <file>`
on a file that has only been written, never committed, destroys the work.

**A mutation that does not fail has proved nothing — and check it APPLIED.**
Grep for the marker before believing a green mutation run.
