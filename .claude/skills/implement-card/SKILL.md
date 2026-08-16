---
name: implement-card
description: Implement or finish a Riftbound card in packages/engine — the ordered procedure plus the fixture and pin traps that have each cost a build cycle. Use when writing a card effect, trigger, keyword or cost, when finishing a card previously refused by an agent wave, or when a card is reported not working in playtesting.
---

# Implementing a card

This is procedure and traps only. **It deliberately does not describe how any
subsystem works** — CLAUDE.md's own warning is that "notes about this codebase's
own mechanisms have been wrong or stale ten times out of eleven", and a skill
file rots exactly as fast as a handoff doc. Read the code for mechanism; read
this for the order of operations and for the things that have gone wrong before.

## The order, and why it is this order

1. **Measure the card.** `registry.get(id)` for its real type, domains, cost,
   tags and keywords, and its `text`. Do not work from the card name or from a
   refusal note's paraphrase.
2. **Read the rule with `pdftotext -q -raw`, never `-layout`.** Then read the
   sentence the number lands on and confirm it says the thing you are about to
   rely on. A number that resolves is not yet a number that is right.
3. **Find the seam before writing anything.** Most refusals in this repo were
   one table row, one field, or one predicate — not a subsystem. Grep for a card
   that already prints a similar sentence and copy where it lives. If a note
   calls the card blocked, systemic or structural, run the `triage-a-refusal`
   skill first: four consecutive refusals on the last set were exactly right
   about their blocker and exactly wrong about their fix.
4. **Implement.**
5. **Write the test.**
6. **Mutation-test it** — see the `mutation-test` skill. Do this BEFORE the full
   verification loop: the loop is slow, and a surviving mutant means the test is
   wrong, so running the loop first wastes the cycle.
7. **Hunt the stale premise-pin** (see below). Finishing a card breaks tests
   whose premise was that it was unfinished.
8. **Update the pins** the change moves: trigger census, reachability.
9. **Record any divergence** in `docs/rules-conformance.md`, in the same change.
10. **Run the full verification loop** from CLAUDE.md, then commit.

## Traps that have each cost a cycle

**Registry table arity.** A Spell's effect and a Unit's trigger live in different
tables with different `resolve` signatures. Putting a Spell in the unit-triggers
table type-checks as far as the editor is concerned and fails at build with a
confusing error about a property on `string`. Check `implementingModules(defId)`
after building — if it says the wrong source, you are in the wrong table.

**Nothing resolves on `submit`.** A `[Reaction]` spell goes on the Chain; a
Unit's on-play trigger is HELD (383). Reading the board straight after `submit`
measures a card that has not happened yet. Use `resolveHeldTriggers` from
`test/fixtures.ts`. This has been missed twice in one session, once for each
shape.

**`ValidationResult` is `{ ok }`**, not `{ type }`. `.type` reads `undefined`
and every assertion against it fails in the same confusing way.

**Fixture field names.** It is `deck`, not `mainDeck`. `spellInstance` takes only
a defId. A wrong field name on a `PlayerState` assignment is dead code that makes
a test silently measure `makeState`'s defaults instead — caught only by
`npm run typecheck`, which is why that step includes tests where the build
excludes them.

**Other fixture traps, all previously recorded and all still live:**
`answerDecisions` defaults to **Decline**, so a card that pays out through a
question reads exactly like a trigger that never fired. `placeToken` no-ops on
`"base"`. Assert `pendingTriggers` BEFORE `resolveHeldTriggers` drains them.
**Rule 466 step 3c heals every unit at end of combat**, so `damage` after
`resolveShowdown` is always 0 — read combat through DEATHS.

**The enumerate/execute split.** Any new restriction on what may be chosen must
land in BOTH `legal-actions` (which variants exist) and `validate-play-card`
(which submitted ones are legal). Five crashes here have had exactly this shape,
and all five were found by probes rather than tests. Assert both directions
separately: every enumerated action validates, and a forged illegal one is
refused.

## Finishing a card breaks tests that pinned it as unfinished

Agent waves leave `describe` blocks asserting a card is unimplemented, often with
a behavioural half ("it is castable and does NOTHING"). Finishing the card turns
them red. **Fix the premise, never weaken the assertion.**

**See the `fix-a-premise-pin` skill** — there are four distinct repairs and
picking the wrong one is how a pin comes back. Briefly: INVERT is the default,
especially for a NEGATIVE or a continuous effect, because something that silently
stops being registered looks like nothing at all. Deleting the block and leaving
a tombstone is right only when the fact has genuinely moved to a new file; a pin
that was measuring the WRONG THING gets retired and replaced with an invariant
instead, and one that borrowed a real unfinished card as its subject gets a
synthetic one.

Either way, keep whatever the refusal note got RIGHT: those notes have repeatedly
named the real blocker precisely, and the sharpest sentence in them is often what
the new tests should be built around — see `triage-a-refusal`.

Search for them by defId across `test/` before running the full suite; they are
usually in `unl-*-wave*.test.ts`.

## Pins that move

**Trigger census** (`test/trigger-census.test.ts`) — fails loudly with the exact
delta. Update the three figures AND the `it(...)` title, and write down what the
delta is attributable to. CLAUDE.md records that this census "was wrong four
times, always by hand-copying one of them", so re-derive rather than transcribe.

Note the census counts TRIGGER cards, not finished ones. A Spell's kill is a card
effect, not a trigger, so finishing two cards can move it by one or by zero.

**Reachability** (`GAMES=500 node probes/reachability.ts`) — does NOT fail on a
rise; it prints a line asking for the pin to be bumped, which is easy to miss.
Bump `PINNED_UNION` in the probe AND the figure and per-set breakdown in
CLAUDE.md. A DROP is red and must be decomposed against the old sha before being
called a regression — implementing a card displaces another from a fixed-size
covering deck, which has produced three non-regression drops.

**Coverage** — check `partialImplementationNote(def)` is gone if the card is now
whole, and retire any `PARTIALLY_IMPLEMENTED` row.

## Editing

Never bulk-edit with PowerShell. Use the Edit tool, or Python with explicit
`utf-8` and `newline=""`.

If using Python: the repo is CRLF, so a search string joined with `\n` will not
match — and converting a string that is ALREADY CRLF produces `\r\r\n`, which is
invisible to the compiler, the tests and `git diff`. Convert exactly once. Assert
every replacement landed and that `"\r\r\n" not in` the result. When a multi-line
match keeps failing, stop fighting it and use the Edit tool.

Back a file up to the scratchpad before mutating it.
