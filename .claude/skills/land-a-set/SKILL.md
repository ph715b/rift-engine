---
name: land-a-set
description: Add a new Riftbound set to the engine — the data gate that must be cleared first, the file list one landing commit touches, and the traps that have caught this repo on every set so far. Use when a new set's cards are being brought into packages/engine, when scoping a set's keywords before its JSON lands, or when declaring a set complete.
---

# Landing a set

This is procedure and traps only. **It deliberately does not describe how the
loader, the coverage gates or the probes work** — CLAUDE.md's warning is that
"notes about this codebase's own mechanisms have been wrong or stale ten times
out of eleven", and a skill file rots exactly as fast as a handoff doc.

Four sets have landed this way (OGN, OGS, SFD, UNL). The mechanics are known and
mechanical; almost all the surprise is in Phase 0 and Phase 4.

## Phase 0 — the data, and it is a real gate now

**Check that the card export exists before planning anything else.** For the
first four sets it always did, in the frozen oracle at
`A:\Projects\riftbound-engine\src\main\resources\cards\`, and the project memory
recorded that adding a set "is never a data-sourcing problem". **That stopped
being true at the fifth set** — re-measured 2026-08-15, that directory holds
ogn/ogs/sfd/unl and nothing else. One `ls` settles it. Do not trust any note on
this, including this one.

`src/cards/raw-card-schema.ts` is the contract. It is deliberately permissive
(`.passthrough()`) and gates only the fields the loader reads. Validate a new
export against it before believing it.

**If no export exists, say so and stop.** Do not hand-author card entries: a
typed pool is a source of truth nothing can re-derive, and coverage, the trigger
census and `reachability` would all be measuring a fiction. Authoring a *token*
from a card's own printed reminder text is a different thing and is fine — the
source card is real, and `token.ts` and `engine/battlefield-tokens.ts` both do
it.

**Do not hand-patch an upstream snapshot.** The four existing files disagree with
each other — bare array vs paginated `{items}` envelope, BOM on two of four,
latin-1 mojibake in one, HTML entities still encoded in another — and every one
of those is absorbed in the loader on purpose, because the next refresh undoes a
hand edit.

## The trap that has caught this repo twice, in Phase 0 specifically

**Measure the POOL, not the FILE.** `unl.json` is 280 raw entries and loads as
**235**: `shouldSkip` drops alternate-art printings and Battlefields, which load
separately. Every count in UNL's scoping document was a raw overcount, and the
landing commit had to correct a confident wrong finding made *while explicitly
re-measuring to avoid exactly that*.

Get counts from the registry, never from `wc` or a JSON length.

## Phase 1 — the landing commit

One commit. The file list is known (UNL's was 40 files):

| what | where |
|---|---|
| the card file, plus one `CARD_FILES` entry | `src/cards/`, `src/cards/card-loader.ts` |
| new keywords into **both** keyword lists | `src/model/keyword.ts` |
| new bracketed tokens that are not keywords | `NON_KEYWORD_BRACKETS`, same file |
| token and bracket censuses | `test/coverage-drift.test.ts` |
| per-set counts | `test/set-coverage.test.ts` |
| trigger census | `test/trigger-census.test.ts` |
| deck import and decklist parser counts | `test/deck-import.test.ts`, `test/decklist-text-parser.test.ts` |
| card filters, payment, submitted play | `packages/web/test/` |

**Both keyword lists, not just one.** A keyword in `KEYWORDS` but absent from
`UNIMPLEMENTED_KEYWORDS` makes every card printing it report IMPLEMENTED and ship
inert. That is the coverage lie this repo rates as worse than a refusal, because
a refusal is visible. SFD's four keywords and UNL's four both used this shape.

**The unimplemented flag is load-bearing beyond labels.** `deck-generator`
filters on `isCardImplemented`, so a keyword in `UNIMPLEMENTED_KEYWORDS` keeps
every card printing it out of generated decks — unreachable in play and invisible
to `reachability`. When the subsystem lands, the flag comes off and the
genuinely-unwritten cards get named individually in `PARTIALLY_IMPLEMENTED`.

Expect **~10 premise flips** in files you did not touch. That is the gates
working — see the `fix-a-premise-pin` skill.

## Phase 2 — scope the keywords before writing any card

Do this against the rules PDF, and do it before or with the landing commit rather
than per-card later. It paid for itself on UNL: the scoping document was written
before the JSON landed and the landing commit implemented it in one pass.

Three questions per keyword, and nothing else:

1. **What rule, read with `pdftotext -q -raw`** — never `-layout`. Then read the
   sentence the number lands on and confirm it says what you are about to rely
   on. A number that resolves is not yet a number that is right: this repo has
   four line-numbers-cited-as-rules and two multi-site swapped sub-rules, and
   every one of them resolved to a real sentence.
2. **Does it need new state, or does something already answer it?** UNL's XP was
   one integer on `PlayerState`. Ten times out of eleven a "needs subsystem X"
   note is one field, one function, or something already built for another card.
3. **Is it a free ride?** UNL's `[Ambush]` needed zero parser changes because
   every card printing it also prints `[Reaction]` — measured over the loaded
   pool, not the file.

`model/Keyword.java` in the frozen oracle carries the authoritative per-set
keyword split and settles questions the PDF leaves looking open. It is not
derivable from this repo.

## Phase 3 — the card waves

Fan `engine-devs` agents over **disjoint domain files**. Never fan out over one
shared type or resolver: `card-effects.ts`, `legal-actions.ts`,
`validate-play-card.ts`, `coverage.ts`, `model/keyword.ts` and
`model/game-state.ts` are integrator-only.

A wave lands ~75% of its cards and **always leaves the same four classes of
shared-file debt.** Budget an integration pass roughly as long as the wave:

1. **Shared counters every agent moves and none can see.** Ask each for its own
   delta, then RECOMPUTE from the registry — shares summing to the total is the
   cross-check that the number is arithmetic rather than typed to make a test
   pass. The trigger census has been wrong four times, every time from
   hand-copying.
2. **Duplicated constants.** No agent is wrong; the fan-out rule keeps them out
   of shared files, so a local copy is all they CAN write. Sweep at integration.
3. **Pins designed to fail**, asserting the WRONG answer against a missing
   shared-file row. Adding the row fails them loudly — that is success.
4. **Coverage lies.** A card whose second clause is unwritable reports DONE,
   because registration is per defId. Ask every agent to name its half-written
   cards and add the `PARTIALLY_IMPLEMENTED` rows yourself.

Refusals will come back with the wave. See the `triage-a-refusal` skill — on the
last set, four refusals in a row were exactly right about their blocker and
exactly wrong about their fix.

## Phase 4 — declaring the set complete, and the gate that turns on

**Do not add the set to `COMPLETE_SETS` early.** `finishedButUndeclared` is what
tells you when: it flags a fully-implemented undeclared set and
`set-coverage.test.ts` goes red naming it. That is the instrument; a note is not.

Declaring it switches on `reachability.everyUnexercisedExplained`, which holds
the set to "every implemented card no run has seen act is either offered by the
enumerator or excused in `probes/unexercised-allowlist.ts`".

**"We did not get to it" is explicitly not a reason there.** Two are:

- a **structural AI limitation** — a 1-ply evaluator cannot price an
  informational or deferred effect;
- an **observer blind spot** — a continuous effect (read during a calculation, so
  no action, no chain item, no event) or `beginningPhase`, still resolved inline.

A stale entry fails the gate too, by design, so an excuse that stops being true
names itself.

Budget a session for this phase alone if the set has many Legends: each is
printed three times and only one printing can be seated per deck. UNL cost three
allowlist entries plus one probe rule here.

## Also expect

- **The set's landing moves `reachability`'s runtime, not just its count.** A
  third battlefield took the run from ~244s to ~290s, because the move fan-out
  loops over destinations. A new mechanic that widens the action space is paid
  for on every probe run afterwards.
- **Probes load from `dist`.** A probe importing from `../src/` dies on module
  resolution rather than telling you anything useful. Import from
  `@rift-engine/engine`.
- **Adding a required `GameState` field breaks ~12 state literals** across both
  workspaces, and only the ROOT `npm test` sees the web half.
