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
node probes/{ai-health,passive-human,chain-depth,walkout,exercised}.ts
DECKS=sfd node probes/exercised.ts
```

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

## Do not copy this loop into a handoff

Every SFD/battlefield prompt in `docs/` wrote its own copy, they drifted, and the
copy in front of the session won over the correct one. Handoffs link here.

The same rule applies to any list the engine merges from several sources — the
trigger census was wrong four times, always by hand-copying one of them.

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
