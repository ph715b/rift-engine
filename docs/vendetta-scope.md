# Vendetta — scoping the fifth set, before the JSON lands

Written 2026-08-15, at `60b47a3`, immediately after Unleashed was completed and
declared. **Do not copy the verification loop into this file.** It is in
`CLAUDE.md`, and six docs in this directory each wrote their own copy, they
drifted, and the copy in front of a session beat the correct one.

**Three skills carry the repeatable parts of this and are the first thing to
reach for**: `land-a-set` (phases 0–4 below, as procedure), `triage-a-refusal`
(phase 3's refusals) and `fix-a-premise-pin` (the flips every phase produces).
They are the durable half; this file is the Vendetta-specific half and dies with
the set.

**Delete this file the day Vendetta is declared complete.** `unl-finish-handoff.md`
was deleted on 2026-08-15 for exactly that reason and its own last line asked for
it; the five older prompts in this directory should have been.

---

## Phase 0 is DATA, and this set is the first one where that is true

**Measured 2026-08-15: there is no Vendetta card file anywhere.**

```
A:\Projects\riftbound-engine\src\main\resources\cards\
  ogn.json  774616
  ogs.json   66798
  sfd.json  456098
  unl.json  375704       <- and nothing else
```

That inverts the standing note in the project memory, which says adding a set
"is never a data-sourcing problem" and names the oracle as the source. **That was
true for all four sets so far and is not true for this one.** The memory has been
corrected; the claim is re-measurable in one `ls`, so re-measure it rather than
trusting either version.

Nothing downstream of this can start. Every later phase is bounded work with
known shape; this one is an unknown, so it is its own gate.

### RE-MEASURED 2026-08-16 — the gate is still CLOSED, for a reason not listed below

The oracle finding above holds: still `ogn/ogs/sfd/unl`, nothing else, and
`model/Keyword.java` has no Vendetta section either — its keyword commentary
stops at UNL.

**The set code is `VEN`, not `VDT`.** Every guess at `vdt.json` in this document
is wrong; the file to write is `ven.json`.

**The data DOES exist upstream, and it is branch (2) — but in a state none of the
three branches below describes.** The Riftcodex API serves Vendetta, and it is
provably the same source the four shipped files came from: fetched live, its UNL
reproduces `packages/engine/src/cards/unl.json` **exactly** — identical 280 ids,
zero differences in `name`, `attributes`, `classification`, `tags`, `text.plain`
or `metadata.alternate_art`. So the fetch route is not in question.

Vendetta is served by **two ingests at once**, and both are live:

```
node tools/card-data/set-audit.mjs VEN     # BLOCKED, exit 1
node tools/card-data/set-audit.mjs UNL     # CLEAR,   exit 0  <- the control
```

| | VEN | UNL (control) |
|---|---|---|
| raw documents | 358 | 280 |
| distinct cards | **227** | 280 |
| reconciled | **131 (58%)** | 280 (100%) |

`/cards` paginates over DOCUMENTS, not cards, so the same `riftbound_id` arrives
twice: an older scrape (2026-07-10) and a newer reconciled one (to 2026-07-21).
The reconciliation populates `tcgplayer_id`, `metadata.clean_name` and
`text.flavour` — and, load-bearing here, it sets `metadata.alternate_art` and
`metadata.overnumbered`. **An unreconciled record reports every printing flag as
false.** Measured on the 131 cards holding both halves, the old half disagreed
with the new one 27 times and always in that direction.

**What is fine.** The main set is complete and clean: all 166 collector numbers
present, no gaps, no duplicate numbers, no duplicate names, 156 playable after
`shouldSkip` drops 10 Battlefields. 78 of those 166 are unreconciled and that
does not matter — their rules text, cost, type and domains are all present, their
printing flags are false and false is CORRECT for a main-set card, and what
reconciliation would add is read by nothing in this engine. **All 9 main-set
Legends are reconciled**, which is the one thing that had to be true: the old
ingest drops a Legend's champion prefix, and `championTag` is the first word of
the name.

**What blocks.** Fourteen unreconciled records sit ABOVE the main-set band, where
genuine additional cards and alternate printings of main-set cards are
INTERLEAVED — VEN has 12 flagged printings and 5 genuine cards between 167 and
197, and only `metadata.overnumbered` separates them. For those fourteen no field
carries the answer. Guess "printing" and the card plays as a different card;
guess "genuine" and a phantom card inflates coverage, the trigger census and
`reachability` alike.

Both tempting derivations were TESTED against the reconciled records, where the
answer is known, and both are false:

- *collector > set size means printing* — **no**, 5 counterexamples (Vi 167,
  Jayce 175, Viktor 176, Rengar 179, Kha'Zix 180 are genuine cards).
- *a duplicate name means printing* — **no**, and the counterexample is the
  clearest single case in the set. `VEN-194 "Defender of Tomorrow"` is provably
  the Overnumbered print of `VEN-149 "Jayce - Defender of Tomorrow"`: same type,
  same Mind/Body domains, same two abilities, differing only by the dropped
  `[Empower]` reminder text — the Baron Nashor shape `PRINTING_SUFFIX` already
  knows. But the stale record carries no `(Overnumbered)` suffix, no flag, and no
  champion prefix, so it matches nothing and would load as a phantom Legend
  tagged `DEFENDER`.

**So the honest move is branch (3)'s, arrived at from branch (2): say so and
stop.** The blocker is narrow and it is upstream's to clear, not ours — the audit
exits 0 by itself the moment the unreconciled count reaches zero. Upstream has
not moved in four weeks (last `updated_on` 2026-07-21; still 131/227 on
2026-08-16), so re-running the audit is the whole of Phase 0 until it does.

**Do not close this by hand**, and note that "it is only fourteen records" is
exactly the argument that makes it tempting. A hand-classified pool is the fifth
source of truth this document already refuses below, and it would be one that
nothing in the repo could re-derive or check.

### What "the data" has to be

`packages/engine/src/cards/raw-card-schema.ts` is the contract, and it is
deliberately permissive (`.passthrough()`) — it gates the fields the loader
reads, not the whole export. The required shape per entry:

`riftbound_id`, `name`, `attributes{energy,might,power}` (nullable),
`classification{type,supertype,rarity,domain[]}` with `type` in
`Unit|Spell|Rune|Gear|Legend|Battlefield`, `text{plain}`, `media{image_url}`,
`tags[]?`, `metadata{alternate_art}`.

It is the Riftcodex API export format. The four existing files differ from each
other in ways the loader already absorbs, and a fifth will differ again —
`extractCardItems` reads both a bare array and a paginated `{items}` envelope,
`ogn`/`ogs` carry a BOM and `sfd`/`unl` do not, `ogn` carries six latin-1
mojibaked apostrophes, and two SFD cards arrive with `&quot;` still encoded.
**Do not hand-patch an upstream snapshot** — the next refresh undoes it, and the
loader is where every one of those is handled.

### The three branches, and what each costs

1. **The oracle gains a `vdt.json`.** Then Phase 0 is a byte-for-byte copy plus
   one `CARD_FILES` entry, exactly as UNL was, and this document's Phase 1 is
   accurate as written.
2. **The export exists elsewhere** (Riftcodex API, a CDN drop like the rules PDF
   at `cmsassets.rgpub.io`). Same as (1) once fetched. **Validate against
   `RawCardSchema` before believing it**, and count the POOL not the FILE — see
   the trap below, which has caught this repo twice.
3. **No export exists yet.** Then the set cannot be implemented and the honest
   move is to say so and stop. Do NOT hand-author card entries: a hand-typed
   pool is a fifth source of truth that nothing can re-derive, and every figure
   this repo pins — coverage, the census, `reachability` — would be measuring a
   fiction. (Authoring a *token* from a card's own printed reminder text is a
   different thing and is fine; `engine/battlefield-tokens.ts` and `token.ts`
   both do it, because the source card is real.)
4. **The export exists but is PARTIAL — the actual case, added 2026-08-16.**
   Neither "fetch it" nor "it isn't there". The cards are all present and their
   rules text is sound; what is missing is the printing metadata that says which
   records are separate cards, and that is exactly what the loader keys on. It
   costs (3)'s outcome for (2)'s reason, and the tell is that the missing half is
   structural rather than per-card — so `RawCardSchema` validates every record
   happily and a `wc -l` looks right. **Validating the schema is not validating
   the pool**; `tools/card-data/set-audit.mjs` is what asks the second question.

### The trap that has caught this repo twice, in Phase 0 specifically

**Measure the POOL, not the FILE.** `unl.json` is 280 raw entries and loads as
**235** — `shouldSkip` drops 30 alternate-art printings and 15 Battlefields
(which load separately through `loadBattlefieldDefinitions`). Every count in the
UNL scoping document was a raw overcount, and the landing commit had to correct
a confident wrong finding made *while explicitly re-measuring to avoid exactly
that*. Get the loaded count from the registry, not from `wc`.

---

## Phase 1 — landing the set

One commit, and UNL's is the template (`58ae5e1`, 40 files, +1422/-167). It is
mechanical and the file list is known:

| what | where |
|---|---|
| the card file + one `CARD_FILES` entry | `src/cards/vdt.json`, `src/cards/card-loader.ts` |
| new keywords into **both** `KEYWORDS` and `UNIMPLEMENTED_KEYWORDS` | `src/model/keyword.ts` |
| new non-keyword bracketed tokens | `NON_KEYWORD_BRACKETS` in the same file |
| the token census, the bracket census | `test/coverage-drift.test.ts` |
| set counts, `finishedButUndeclared` expectations | `test/set-coverage.test.ts` |
| trigger census | `test/trigger-census.test.ts` |
| deck import / decklist parser counts | `test/deck-import.test.ts`, `test/decklist-text-parser.test.ts` |
| card filters, auto-payment, submitted-play | `packages/web/test/` |

**Both keyword lists, not just one.** A keyword in `KEYWORDS` but not
`UNIMPLEMENTED_KEYWORDS` makes every card printing it report IMPLEMENTED and
ship inert. That is the coverage lie this repo rates as worse than a refusal,
because a refusal is visible. SFD's four and UNL's four both used this shape.

**And the flag is load-bearing beyond labels**: `deck-generator` filters on
`isCardImplemented`, so a keyword in `UNIMPLEMENTED_KEYWORDS` keeps every card
printing it out of generated decks — unreachable in play and invisible to
`reachability`. When the keyword's subsystem lands, the flag must come off and
the genuinely-unwritten cards be named individually in `PARTIALLY_IMPLEMENTED`.

Expect **~10 test premise flips** in files you did not touch. That is the gates
working. See the premise-pin taxonomy below.

### Do NOT declare the set complete in Phase 1

`COMPLETE_SETS` is a hard gate and `finishedButUndeclared` is what tells you when
to add a set — it flagged UNL the moment its last card landed, and
`set-coverage.test.ts` went red naming it. Adding a set to that list early turns
on `reachability.everyUnexercisedExplained` against a set that is mostly
unwritten, which is a wall of noise arriving at the moment the instruments most
need to be readable.

---

## Phase 2 — scope the keywords against the rules PDF, before any card

This is `docs/xp-and-unl-keywords-scope.md`'s job for UNL, and it paid for
itself: it was written before the JSON landed and the landing commit implemented
it in one pass.

For each new keyword, answer three questions and nothing else:

1. **What rule number, read with `pdftotext -q -raw`** — never `-layout`, which
   puts the numbers in a column that does not line up with their text. **Then
   read the sentence the number lands on and confirm it says the thing you are
   about to rely on.** A number that resolves is not yet a number that is right:
   this repo has four line-numbers-cited-as-rules and two multi-site swapped
   sub-rules, and every one of them resolved to a real sentence.
2. **Does it need new STATE, or does something already answer it?** UNL's XP was
   one integer on `PlayerState`, deliberately outside `runEnd`'s sweep. Ten times
   out of eleven a "needs subsystem X" note turns out to be one field, one
   function, or already built for another card.
3. **Is it a free ride?** UNL's `[Ambush]` needed zero parser changes because
   every card printing it also prints `[Reaction]` — measured over the loaded
   pool, not the file.

`model/Keyword.java` in the frozen oracle carries the authoritative per-set
keyword split and settles questions the rules PDF leaves looking open. It is not
derivable from this repo. **Checked 2026-08-16: it has NO Vendetta section** —
its keyword commentary stops at UNL. So this set is also the first whose keywords
have to be scoped against the rules PDF alone, with no oracle to settle ties.

### The bracket census, measured 2026-08-16

Off the deduped 227-card pool, not off the file. This survives the Phase 0 block
because it reads `text.plain`, which is the half of the data that IS sound — but
re-measure it when the pool finally lands, since the 14 blocked records are not
in this count.

Brackets appearing in VEN that none of the four shipped sets uses:

| bracket | occurrences | note |
|---|---|---|
| `[Empower]` | 51 | the set's headline mechanic; pairs with `[Empowered]`, which OGN already prints (rule **828**) |
| `[Flow]` | 18 | play from trash for an alternate cost, then banish — printed WITH its cost, e.g. `[Flow] :rb_energy_3::rb_rune_rainbow:` |
| `[Burn N]` | 9 across N=1,2,3,7 | self-mill; reminder text is "put the top card of your Main Deck into your trash" |
| `[Stun]` | 3 | |
| `[Predict N]` | 2 across N=2,5 | |

Already-known brackets recurring here — `[Assault N]`, `[Deflect N]`, `[Shield N]`,
`[Add]`, `[>]` — need nothing new. Two to look at rather than assume: `[>>]`
(2 occurrences, and `[>]` is an existing NON_KEYWORD_BRACKETS entry) and
`[NO TEXT]` (6 occurrences, which is upstream placeholder noise of the same class
as UNL-094's stray lowercase `ambush`, not a keyword).

**`[Empower]` and `[Empowered]` are two different things and the split matters.**
`[Empower]` is a printed COST-and-ability ("`[Empower] 2R R`: Empower me. Use only
if not Empowered."), while `[Empowered][>]` gates a second ability on the
resulting state — so a card prints both and they are not one keyword with two
spellings.

### The rule numbers, read against `-raw` 2026-08-16

**The current rules PDF already covers this set** — `Riftbound Core Rules Updated
2026-07-16.pdf` postdates Vendetta's spoiler season, so Phase 2 needs no new
document. Every number below was read off `pdftotext -q -raw` and the sentence it
lands on was checked to say the thing being relied on, per CLAUDE.md.

| term | rule | what the sentence actually says |
|---|---|---|
| Empower | **827** | "Empower is an Activated Ability keyword." 827.1.c: formatted `Empower [Cost]`; 827.1.c.1 makes it short for "`[Cost]`: Empower this. Play only if not Empowered." |
| Empowered | **828** | 828.1.a: formatted `[Empowered][>] [Text]`; 828.1.b.1 "functionally short for 'While I have the Empowered status…'" — a DEPENDENT ability, the same shape as `[Level]` (824) |
| Flow | **829** | "Flow is a passive ability keyword." 829.1.a: "Flow is present on Spells." 829.1.c: formatted `Flow [Cost]` |
| Burn | **440** | "Burning is the act of moving cards from the top of a player's Main Deck to their trash." 440.3: a Limited Action |
| Burn Out | **431** | **A DIFFERENT RULE** — what happens when a player must move cards and cannot. 431.5 makes it a Replacement Effect. Do not conflate with 440 |
| Predict | **436** | "looking at a single card from the top of the Main Deck and choosing…" 436.2: a Limited Action |
| Stun | **423** | "Stunning is the act of selecting one or more Units… and rendering them Stunned." 423.1.a: a binary state, cleared in step 3d of end-of-turn cleanup |

**Only THREE of these are keywords.** Empower/Empowered/Flow are in the 800
Keyword Glossary; Burn, Predict and Stun are in the 4xx **actions** band, which
means they are action words a card's text *performs*, not properties a card
*has*. That is a Phase 1 decision, not a Phase 2 one: putting `[Burn]` in
`KEYWORDS` would be the wrong table.

This is not a new judgement — `keyword.ts` already made it for two of the three.
Its comment on `[Predict]` reads "NOT among them, and that is a decision rather
than an oversight: it prints as an **action word** (`[Predict].` mid-sentence,
like `[Buff]` and `[Stun]`), not as something a card HAS", and both are already
in `NON_KEYWORD_BRACKETS`. `[Burn N]` is the same shape and belongs beside them;
what is new is that it carries a MAGNITUDE, which neither `[Predict]` nor
`[Stun]` does.

So the Phase 1 line "new keywords into **both** `KEYWORDS` and
`UNIMPLEMENTED_KEYWORDS`" applies to **Empower, Empowered and Flow only**.

---

## Phase 3 — the card waves

~97 commits over seven days took UNL from landing to complete. The shape that
worked: **fan several `engine-devs` agents over DISJOINT domain files**, then an
integration pass roughly as long as the wave.

Fan out over disjoint domain files (`effects/fury.ts`, `effects/calm.ts`, …).
**Never fan out over one shared type or resolver** — `card-effects.ts`,
`legal-actions.ts`, `validate-play-card.ts`, `coverage.ts`, `keyword.ts` and
`model/game-state.ts` are integrator-only, and the whole fan-out rule exists
because two agents editing one table is a merge nobody can review.

A wave lands ~75% of its cards and **always leaves the same four classes of
shared-file debt**. Budget for it:

1. **Shared counters every agent moves and none can see.** Ask each agent to
   report its own delta, then RECOMPUTE from the registry — shares that sum to
   the total is the cross-check that the new number is arithmetic rather than a
   number typed to make a test pass. The trigger census has been wrong four
   times, every time from hand-copying.
2. **Duplicated constants.** No agent is wrong: the fan-out rule keeps them out
   of shared files, so a local copy is the only thing they CAN write. Sweep at
   integration.
3. **Pins designed to fail.** Agents pin a missing shared-file row by asserting
   the WRONG answer. Adding the row fails them loudly — that is success.
4. **Coverage lies.** A card whose second clause is unwritable reports DONE,
   because registration is per defId. Ask every agent to name its half-written
   cards and add the `PARTIALLY_IMPLEMENTED` rows yourself.

### Refusals: expect them, and expect them to be half wrong

Unleashed's last four cards were each refused across multiple waves, and **all
four refusals were exactly right about their blocker and exactly wrong about
their fix.** Every blocking sentence was true; none was the reason the card could
not be written:

| refusal | true | wrong |
|---|---|---|
| "a cross-seat replay permission is unusable — `mayPlayCardNow` refuses a non-acting player" | yes, of the permission path | the answer was to not use a permission: a parked decision is answered by whoever it names |
| "this engine cannot pay mid-resolution" | no — stale since Flame Chompers | `payPowerFromChanneled` has done it for four sets |
| "nothing in this engine can add a battlefield; `battlefieldPair` builds exactly two at setup" | both sentences, literally | an inference from SETUP to ENGINE; `state.battlefields` is a list nothing assumes the length of |
| "no Brush / no Baron Pit card data exists" | yes, re-measured | the token's rules text is printed on the card that makes it |

**The method that broke all four**, and it is worth running on every refusal:

- Split the refusal into a **data claim** and an **engine claim**, and measure
  them separately. Three of the four had a true data claim wrapped around a false
  engine claim.
- Ask whether the blocked path is the ONLY path. Two of the four were blocked on
  a workaround (a play permission, a `PARTIALLY_IMPLEMENTED` note) rather than on
  the rules.
- Re-read the code, not the note. This repo's own rule is ten wrong out of
  eleven, and the refusals *themselves* were re-triaged once and still wrong.

---

## Phase 4 — completion, and the gate that turns on

When the last card lands, `set-coverage.test.ts` goes red naming the set. Add it
to `COMPLETE_SETS`. **That switches on `reachability.everyUnexercisedExplained`**,
which holds the set to "every implemented card no run has seen act is either
offered by the enumerator or excused in `probes/unexercised-allowlist.ts`".

"We did not get to it" is explicitly not a reason there. Two reasons are:

- **A structural AI limitation** — a 1-ply evaluator cannot price an
  informational or deferred effect.
- **An observer blind spot** — a continuous effect (read during a calculation, so
  no action, no chain item, no event) or `beginningPhase`, which still resolves
  inline.

UNL cost five entries' worth of work here: three allowlist entries for a Legend
whose clauses are both continuous, and one probe rule for alternate printings
whose canonical printing was exercised (`mergeRegistries` makes them one registry
entry, so exercising one exercises the other's code — and it is TIGHTER than it
looks, because with no alias `canonicalDefId` returns the id unchanged and the
printing still fails the gate).

Budget one session for this phase alone if the set has many Legends: each is
printed three times, and only one printing can be seated per deck.

---

## The premise-pin taxonomy, which is most of the surprise work

Finishing a card breaks tests whose premise was that it was unfinished — 3–9 per
batch, in files you did not touch. **Fix the PREMISE, never weaken the
assertion.** Four distinct repairs, and picking the wrong one is how a pin comes
back:

1. **INVERT** — the default. A pin asserting "X does not happen" becomes "X
   happens". Prefer this to deletion whenever the clause is a NEGATIVE or a
   continuous effect: something that silently stops being registered looks like
   nothing at all, so the assertion is still worth having pointed the other way.
2. **RETIRE and replace** — when the pin was measuring the wrong thing. UNL's
   "no card prints two instances of `[Repeat]`" counted `[Repeat]` tokens in the
   text, and Curtain Call prints the keyword ONCE with three slash-separated
   costs; it would have passed forever. Replaced with an invariant that cannot go
   vacuous (the table's instance count must agree with the printed reminder
   text).
3. **SYNTHESISE the subject** — when the pin depends on some real card being
   unfinished. A negative control naming a real refusal gets implemented out from
   under itself; UNL's was swapped twice for that reason before being pointed at
   a defId no registry entry can ever claim.
4. **SWEEP positively** — when a refusals list empties. **An empty `describe`
   fails vitest outright**, so an emptied loop must be replaced by a positive
   sweep, not just left.

**And a pin can go VACUOUS before it goes red.** Dancing Grenade's "nothing is
offered to anybody" asserted an empty `pendingDecisions`; against a runeless
opponent the *working* card parks a decline-only question that `advanceDecisions`
executes silently, so it passed against a correct engine. When a pin survives a
change you expected it to catch, that is a finding about the pin.

---

## Figures to check against, as of `60b47a3`

Re-measure rather than trusting these — that instruction has been right every
time it was ignored here.

- Root `npm test`: **5012 engine / 309 files + 174 web**. Typecheck **0** both
  workspaces.
- `walkout` **190 / 113 / 29**, deterministic.
- `reachability` floor **625**, observed **633–639**, ~**290s** at `GAMES=500`.
  It is NOT deterministic. The floor deliberately sits below the observed range —
  do not "correct" it upward.
- Trigger census **319 held / 5 inline of 324**.
- `COMPLETE_SETS` = OGN, OGS, SFD, UNL. Pool 729 across four sets.

## Two live bugs already recorded, which Vendetta will touch

Both are rows in `docs/rules-conformance.md`, pinned by tests that assert the
WRONG answer so closing either fails loudly. Neither is Vendetta's fault and both
will be in its way:

1. **An optional additional cost's Energy is never taken from FLOATING Energy.**
   The validator prices base + additional against the float; `execute-play-card`
   deducts float against the BASE ALONE. Every `[Repeat]`, `[Accelerate]` and
   optional-Power cost is free to a caster with enough banked. Reaches 21
   `[Repeat]` cards plus every `[Accelerate]` unit. `test/optional-cost-float.test.ts`.
   **This is the THIRD time the missed cost site was `execute-play-card`** —
   there are three sites, not two, and it is always the executor.
2. **The Brush swaps back automatically where the card says "can be"** —
   Unverified, narrower than a decision would be.
