---
name: fix-a-premise-pin
description: Repair a test whose premise was that something was unfinished, after finishing it — the four distinct repairs and how to pick, plus the two ways a pin fails without going red. Use whenever a test goes red because a card, keyword or set got implemented, when a refusals list empties, or when a pin you expected to catch a change did not.
---

# Fixing a premise pin

A **premise pin** is a test that asserts the WRONG answer on purpose, so that
closing a known gap fails loudly instead of silently changing behaviour nobody is
watching. This repo is full of them and they work: finishing a card breaks 3–9 of
them per batch, in files you did not touch.

**Fix the PREMISE, never weaken the assertion.** Deleting the assertion or
loosening it to pass is how the gap comes back unwatched.

Search by defId across `test/` before running the full suite — they cluster in
`*-wave*.test.ts` and in per-card files.

## The four repairs, and how to pick

**1. INVERT — the default.** The pin said "X does not happen"; make it say "X
happens". Keep the block, rewrite the assertion, and keep whatever the refusal
note got RIGHT — those notes have repeatedly named the real blocker precisely,
and the sharpest sentence in one is often what the new test should be built
around.

Prefer inverting to deleting whenever the clause is a NEGATIVE or a continuous
effect. Something that silently stops being registered *looks like nothing at
all*: a protection that stops applying just makes an illegal play legal, and an
aura that stops firing just makes a number smaller. The assertion is worth
keeping, pointed the other way.

**2. RETIRE and replace — when the pin was measuring the wrong thing.** Not every
red pin was a correct pin. One asserted "no card prints two instances of
`[Repeat]`" by counting `[Repeat]` tokens in the printed text; the card that
broke the premise prints the keyword ONCE followed by three slash-separated
costs, so it would have passed forever while the pool held a three-instance card.

Replace it with an invariant that cannot go vacuous — that one became "the
table's instance count agrees with the card's printed reminder text", which
fails in both directions and has no way to be trivially true.

**3. SYNTHESISE the subject — when the pin depends on a real card being
unfinished.** A negative control naming a real refusal gets implemented out from
under itself. One was swapped twice for exactly that reason before being pointed
at a defId no registry entry can ever claim. If a control needs an unimplementable
subject, build one rather than borrowing whichever card happens to be unfinished
today.

The same rule applies to a positive control that borrows "whichever set is under
construction" — that assertion was rewritten once per set that finished.

**4. SWEEP positively — when a refusals list empties.** An emptied `for` loop
over a list of refusals asserts nothing. **And an empty `describe` fails vitest
outright**, so leaving it is not an option either. Replace the loop with a
positive sweep naming every card that was on it, asserting each is now whole — a
regression to unimplemented would otherwise pass in silence.

## Two ways a pin fails without going red

**A pin can go VACUOUS before it goes red.** One asserted that a card offered
nothing to anybody by checking `pendingDecisions` was empty. Against a fixture
whose opponent had no runes, the *working* implementation parks a decline-only
question that the decision queue executes without prompting — so the pin passed
against a correct engine, and would have kept passing.

**When a pin survives a change you expected it to catch, that is a finding about
the pin.** Mutate it before believing it. The same check that proves a new test
proves a pin (see the `mutation-test` skill).

**A pin can also be typed against a field that does not exist.** One read
`payment?.energyRuneIds?.length ?? 0` — the field is `energyRunes` — so the
expression was `undefined ?? 0` for every play and the assertion could never
fail. Vitest does not typecheck; `npm run typecheck` includes tests where the
build excludes them, which is the only thing that catches this.

## Leave the history, not just the fix

Every repair above should say, in a comment, what the pin used to assert and why
it was wrong or why it fired. The refusal notes in this repo are its best record
of what was genuinely hard, and a pin that flips is the moment that record is
either kept or lost. Two patterns worth stating explicitly:

- **"This pin fired the same day it was written"** — good. Say so.
- **"This pin was right about its blocker and wrong about its fix"** — the most
  common shape here, and worth writing down at the site so the next reader does
  not re-derive the same wrong conclusion. See `triage-a-refusal`.

## After the repair

The pins that MOVE rather than flip need updating in the same change: the trigger
census, `reachability`'s floor, and any `PARTIALLY_IMPLEMENTED` row. Re-derive
those figures rather than transcribing — the census has been wrong four times,
every time from hand-copying.
