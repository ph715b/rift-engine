---
description: Run the canonical verification loop from CLAUDE.md in order, and report each step honestly.
---

Run this repo's full verification loop and report the result of every step.

## Read the loop, do not recall it

**Read the "The verification loop, in this order, every time" section of
`CLAUDE.md` and execute exactly the steps it lists, in the order it lists them.**

Do not run a loop from memory, from a handoff doc, or from this file. CLAUDE.md
is the only copy, deliberately: every doc that wrote its own copy drifted, and
the copy in front of the session won over the correct one. That is also why this
command does not restate the probe list — a restatement here would be the next
stale copy, and `docs-verification-loop.test.ts` exists because of the last ones.

## How to read each result

The steps are not equally informative, and several fail in ways that look like
success:

- **The root `npm test` is step 1 and covers BOTH workspaces.** `npx vitest run`
  inside `packages/engine` is not a substitute — it cannot see the ~100 web tests,
  which are the only thing that reads the engine the way the app does. An engine
  change breaking a web test has shipped red twice.
- **Build before typecheck and before any probe.** Web and the probes resolve the
  engine from `dist`, so an unbuilt change is invisible to them. A fix that "does
  not work" has usually just not been built.
- **COUNT the typecheck errors and read to the END.** `tail` shows a misleading
  subset. The engine's build config excludes tests while typecheck includes them,
  so typecheck can be red while the build is green. If it is red, diff the error
  list against HEAD before assuming the errors are yours.
- **Probes gate themselves** and print `OK` or fail. A probe that prints figures
  without `OK` has not passed.
- **`reachability` does not fail on a RISE** — it prints a line asking for the pin
  to be bumped, which is easy to scroll past. A rise means update `PINNED_UNION`
  in the probe and the figure and per-set breakdown in CLAUDE.md. A DROP is red,
  and must be decomposed against the old sha before being called a regression:
  implementing a card displaces another from a fixed-size covering deck, which has
  produced three non-regression drops.
- **Check the pinned `walkout` figures** against the ones CLAUDE.md records. A
  change to combat, timing or Might math that moves them needs the new number
  explained, not accepted.

## Reporting

Report what actually happened, step by step — including anything skipped and why.
Give the test counts, the typecheck error count, and each probe's verdict. If a
step is red, say so plainly with the output rather than summarising it away.

If everything passes, say so plainly and state the figures, so the next session
can compare against them.
