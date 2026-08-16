---
name: triage-a-refusal
description: Re-measure a card, keyword or clause that a previous wave refused as impossible — the method that broke four consecutive refusals, each of which was exactly right about its blocker and exactly wrong about its fix. Use before implementing anything a note calls blocked, systemic, or structural.
---

# Triaging a refusal

A **refusal** here is a written note saying a card cannot be implemented, usually
naming a precise blocker. They are good notes: this repo's refusals have named
the real obstacle accurately almost every time.

**They are also wrong about the conclusion almost every time.** On the last set,
the final four cards had each been refused across multiple waves — one of them
re-triaged once already — and **all four refusals were exactly right about their
blocker and exactly wrong about their fix.** Every blocking sentence was true.
None was the reason the card could not be written.

That is a specific enough pattern to have a method.

## Split the refusal into a DATA claim and an ENGINE claim

Three of the four were a TRUE data claim wrapped around a FALSE engine claim, and
the true half made the false half sound measured.

> "nothing in this engine can add a battlefield at all, `battlefieldPair` builds
> exactly two at setup with ids stable for the game, and the Pit has no card data
> in `unl.json`"

The data half is true and stayed true — there is no such card in any set file.
`battlefieldPair` really does build exactly two, and the ids really are stable.
**Neither sentence implies the engine is fixed at two**, and it was not:
`state.battlefields` is a list every site walks without assuming a length, and
the web board already sized its grid from it. What was missing was a function.

Measure each half separately. A data claim is settled by `ls`, by the registry,
or by a JSON scan. An engine claim is settled by reading the code — and only by
reading the code.

## Ask whether the blocked path is the ONLY path

Two of the four were blocked on a WORKAROUND rather than on the rules.

> "a replay has to become a PERMISSION the ordinary play path spends, and
> `mayPlayCardNow` opens with `playerIndex !== actingPlayerIndex(state)`, so a
> cross-seat grant is not merely unwritten but UNUSABLE"

Every word true of the permission path. The answer was to not take it: a parked
decision is answered by whoever it names, active player or not. The refusal had
correctly proved that one route was closed and then stopped.

When a refusal names a mechanism that cannot do the job, ask what else in the
engine already asks a player a question, already pays a cost, already places a
thing. The answer is often a mechanism built for something that looks unrelated.

## Check whether the note has gone stale

The same refusal also said "this engine cannot pay mid-resolution". That had been
false for several sets — the helper that pays a Power cost inside a resolution
predates the note by months, and two other cards use it.

A refusal records the engine **as it was on the day it was written**. Every wave
since then has added primitives. Re-read the code, not the note; this repo's own
rule is ten wrong out of eleven, and the refusals themselves have been re-triaged
and still been wrong.

## Look for the seam, not the subsystem

Most refusals in this repo resolved to one table row, one field, or one
predicate. Grep for a card that already prints a similar sentence and read where
its implementation lives. A "needs subsystem X" note has turned out to be one
field, one function, or something already built for another card ten times out of
eleven.

## What to do with the refusal once it falls

**Keep it.** Do not delete the note — rewrite it in place to say what it got right
and what it got wrong, and why. Four of these in a row is the most useful thing
the last set produced, and it only exists because each was written down rather
than quietly replaced.

The same goes for the pin that guarded it: see `fix-a-premise-pin`, where the
default repair is to invert rather than delete.

## And sometimes a refusal is right

The method above is for testing a refusal, not for overturning it. Two things
genuinely did block work and were left standing:

- **No card data.** Where an export does not exist, hand-authoring the pool is
  not a fix — it is a fiction every instrument would then measure. (A *token*
  authored from a real card's printed reminder text is a different thing.)
- **A shared-file change a fanned-out agent may not make.** That is a scheduling
  refusal, not an impossibility, and the right response is an integrator pass,
  not a workaround.

A refusal that survives this method should be re-recorded with what was
re-measured and when — the next reader deserves to know it was checked rather
than inherited.
