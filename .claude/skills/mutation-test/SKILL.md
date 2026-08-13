---
name: mutation-test
description: Prove a test actually tests what it claims, by breaking the code and checking the test notices. Use after writing or changing any test in this repo, before running the full verification loop, and whenever a test passes on the first try against code you just wrote.
---

# Mutation testing

**A mutation that does not fail has proved nothing** — and a mutation that never
applied has proved less than nothing, because it reads as a passing result.

This is cheap here: engine tests run against `src/` directly, so no rebuild is
needed between mutations. Run it before the full verification loop, not after —
the loop is slow, and a surviving mutant means the test is wrong anyway.

## The ritual

For each mutation:

1. **Back up** the file to the scratchpad directory first.
2. **Control run** — the test must pass *before* you break anything. Without
   this a mutant "killing" the test proves nothing, because the test may have
   been red already. Sibling agents mid-write have caused exactly this false
   result.
3. **Apply the mutation**, then **assert the marker is gone from disk**. Grep for
   it. A search string that silently failed to match is the most common way a
   mutation run reports a survivor that never existed.
4. **Run, and gate on the process EXIT CODE**, never on stdout. Vitest prints
   plenty of green while failing.
5. **Restore**, and **verify the restore landed** — grep the marker back.
6. **Control run again** at the end.

A compact shape that satisfies all six:

```bash
run(){ npx vitest run --root packages/engine test/the-file.test.ts >/dev/null 2>&1; echo "$1 exit=$?"; }
run "CONTROL(want 0)"
# apply mutation, assert it applied, then:
run "M1 <what was broken> (want non-zero)"
# restore, then:
run "RESTORED(want 0)"
```

## What to mutate

Mutate the thing the test claims to prove, one claim at a time:

- **Each side of a split separately.** If a restriction lives in both
  `legal-actions` and `validate-play-card`, delete each one on its own. A test
  that only exercises the happy path kills neither.
- **The specific value, not just the presence.** Swap a live lookup for a printed
  field (`isMighty` → `might >= 5`), drop one item from a list of four, replace a
  computed location with a default.
- **Whole registrations.** Delete the table row entirely. This is the one that
  finds dead code.

## When a mutant SURVIVES

It is one of three things, and they need different responses:

1. **The test is weak** — rewrite it. This is the common case.
2. **The code is redundant** — the branch is already covered by an earlier guard.
   Label it measured-redundant in a comment rather than deleting it blindly.
3. **The code is UNREACHABLE** — the branch cannot be entered in any legal play.

The third is the valuable one and it is easy to mistake for the first. Confirm it
by deleting the whole feature and re-running: if everything stays green, the
feature is inert. Then decide deliberately whether to keep it, and if you keep
it, say in `docs/rules-conformance.md` that it is unreachable and why, and pin
what you can by calling the predicate directly as a function.

A real instance: Stalking Wolf's placement waiver survived every mutation because
the engine pays additional costs at resolution rather than on announce, so the
sacrificed unit was still standing and supplied presence itself. The waiver was
correct, printed on the card, and did nothing. Nothing but mutation would have
found that — the tests were green and looked like they proved it worked.

## Tests that pass on the first try

Treat a test that passes immediately against code you just wrote as unproven
until mutated. Two failure shapes recur:

- **Vacuous assertions** — `every` over an empty array, a field name that does
  not exist so the comparison is `undefined ?? 0`, a filter that matched nothing.
- **Passing for the wrong reason** — the assertion is true, but because of
  something other than the mechanism under test. A positive control on the setup
  ("this fixture really did enumerate something") catches most of these.

Add the positive control as an assertion in the test itself, not just as a
one-off check while writing it.
