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

### A THIRD derivation was tried on 2026-08-16 and also fails — do not retry it

Collector-number and name-matching are refuted above. The obvious next idea is
**structural identity**: a record is an alternate printing iff some other card
matches it on type, cost, Might, domains and rules text (reminder text stripped).
That is how `VEN-194` was shown to be Jayce's Overnumbered print by hand, and it
is what `printingsMatchTheirTwin` already asserts for known aliases.

Validated against the **43 reconciled records outside the main-set band**, where
the answer is known, it looks excellent:

| structural twin | is a printing | is genuine |
|---|---|---|
| in the SAME set's main band | **26** | 0 |
| in an OLDER set | 1 | **7** |
| none found | 0 | **9** |

35 of 43 classified with zero errors. Cross-set twins are inherently ambiguous —
`VEN-168 Jinx, Demolitionist (Overnumbered)` and `VEN-175 Jayce, Man of Progress`
are structurally identical situations with opposite answers, because a set can
REPRINT an older card as a genuine new card.

**And it still fails, because it is validated on the wrong population.** The 43
records it was tested against are the RECONCILED ones — the half whose text is
clean and current. The 18 it must classify are all UNRECONCILED, and their text
is pre-release: differently worded, and mojibaked. Two of the first three
verdicts checked by hand were wrong, both in the worst direction (calling a
printing a genuine card, which inflates the pool):

- `VEN-177 Renekton, Brute` vs `VEN-092` — same stats, same abilities, but the
  clause reads `[Ganking] and [Deflect]` against `[Deflect] and [Ganking]`.
  **Different ORDER**, same card.
- `VEN-185 Kayle, Justified` vs `VEN-134` — identical but for a **mojibaked
  apostrophe**, `I<?>m` against `I'm`. The same latin-1 class `CLAUDE.md` records
  for `ogn.json`.

So the honest summary is narrower than "it works": structural identity can
**positively identify a printing** (an exact same-set match, 26/26) but can never
**certify a record as genuine**, because on stale text an absent match is
evidence of nothing. Five records remain ambiguous even in principle. The gate
does not clear, no code changed, and the next person to have this idea can stop
here.

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

### LANDED 2026-08-16 at `988db6e` — Phase 1 is DONE

The section below was written when the first attempt was reverted; it is kept
because its list is what the landing then worked through, and because the
blocker it names is the one worth remembering. **All 16 flips are repaired and
the tree is green: 5021 engine / 311 files + 174 web, all eight probes OK,
`walkout` unmoved at 190/113/29.**

What actually landed: 209 records → **178 playable definitions + 10
battlefields**. Coverage reports `needing=176, implemented=3, unimplemented=173,
partial=63`. `COMPLETE_SETS` is untouched, and `test/ven-partial-set.test.ts`
pins both that and the 18 ids the generator still drops.

Three things cost more than the file list predicted, all one root cause — the
champion-name convention — and two of them were SILENT:

1. `isEligibleChampion` (no legal deck could be built at all)
2. `printingBaseName` (a cross-set reprint's printing lost its alias and would
   have shipped with no implementation)
3. `decklist-text-parser`'s retry-collision pin (harmless, but the pin was
   measuring the wrong thing and was retired)

**Phase 2 is also done** — the keyword scoping below is implemented: Empower,
Empowered and Flow are in both keyword lists; Burn joins Stun and Predict in
`NON_KEYWORD_BRACKETS`. **Phase 3, the card waves, is what remains**, against 173
unimplemented cards.

### The first attempt, 2026-08-16, REVERTED — what it measured

`ven.json` (209 cards) and `tools/card-data/fetch-set.mjs` are committed; the
`CARD_FILES` wiring is **not**. Wiring it produced **16 failures across 13 files**
and four of them are decisions rather than counts, so the tree was returned to
green rather than left red. Re-do this with the list below in hand.

**The coverage gates are HONEST about the set, which was the main risk and is
settled**: VEN reports `needing=176, implemented=3, unimplemented=173,
partial=63, finishedButUndeclared=false`. No coverage lie. (The three that
already report implemented are carried by generic mechanisms; `set-coverage`'s
failure is only the set-list premise, 4 sets → 5.)

**THE BLOCKER, and it is not in the file list above: Vendetta changed the
champion-unit naming convention, and no legal VEN deck can be built.**

| set | champions | `" - "` | `", "` |
|---|---|---|---|
| OGN / OGS / SFD / UNL | 128 | **128** | 0 |
| VEN | 38 | 0 | **38** |

Every earlier champion is `Akali - Silent`; every VEN champion is
`Akali, Silent`. `deck-validation.isEligibleChampion` requires the champion's
name to start with `"{character} - "`, so it matches **no** VEN champion to
**any** VEN legend, and `validateDeckList` needs an eligible designated champion.
The sweep "every legend in the pool has an eligible champion" named all 14.

**Its own pin has to flip with it, and deliberately so.** `deck-validation.test.ts`
asserts `isEligibleChampion(champion("Garen, Spiritforged"), "Garen - …")` is
**false** — correct while no set used commas, and a false premise now. INVERT it
per the taxonomy below; do not weaken it, and keep the en-dash case rejected.

**One legend does not fit either convention.** `VEN-155` / `VEN-197`
"Yordle, Kennen - Heart of the Tempest" yields character `"Yordle, Kennen"` and
`championTag` `"YORDLE,"`, matching nothing. Its champion is `Kennen, Storm of
Shuriken`. Every other VEN legend is plain `Champion - Title`, so this is a
one-card shape needing a ruling, not a convention.

**The other decisions behind a number:**

- **`[Burn]` never appears bare** — the pool prints `[Burn 1|2|3|7]` only, so
  `coverage-drift`'s "each entry is a token the pool really prints" fails on a
  `NON_KEYWORD_BRACKETS` entry that is genuinely printed. That check compares the
  RAW token; `[Stun]` and `[Predict]` happen to appear bare and never exposed it.
  Strip the magnitude there, the way `isKnownBracketToken` already does.
- **~21 cards print `Empower`/`Empowered` bare**, with no bracketed form on that
  card — 827.1.c.1's "Empower this" is a VERB and 828's status is a NOUN, so
  these are almost certainly `BARE_KEYWORD_NOT_HELD`, not `PROSE_KEYWORD_DEF_IDS`
  (which would BRACKET the word and grant the keyword). Confirm per card; the two
  tables point in opposite directions and `keyword-prose.test.ts` cannot infer
  which.
- **Four "I enter ready" cards, and NONE is unconditional** — VEN-013 and VEN-091
  are `if`-gated, VEN-016 and VEN-019 print it only inside `[Accelerate]`'s
  reminder. So `QUICK_TEXT_OVERRIDES` gets nothing and all four go in
  `card-loader.test.ts`'s CONDITIONAL map. An override here would hand each an
  unconditional readiness it does not print.
- **Ten cards need ART inspection**, which is the standing per-set cost of the two
  tables whose data is in the picture. `POWER_DOMAIN_ALT_OVERRIDES` candidates are
  VEN-140/144/148/150/152/154 (all dual-domain, 1 Power); `EQUIP_MIGHT_BONUS`
  needs VEN-011/027/073/137. **The pipeline works** — `curl` the `media.image_url`,
  crop the pip, read it — and VEN-140 Shuriken Flip was confirmed a Fury|Calm
  SPLIT capsule this way, so the 35/35 "alt = higher-ordinal domain" pattern
  holds at 36. Confirm the rest rather than deriving them.

**Pure count updates** (the gates working as designed, no decision in any):
`ambush-keyword` 12→15, `hunt-keyword` 12→13, `battlefield-coverage` 54→64,
`equipment`/`equipment-wearer-moments` 36→40, `printing-aliases` 31→43,
`the-list` 111→124, `coverage-drift`'s token census 27→31 and its
unimplemented-keyword list `[]`→`[Empower, Empowered, Flow]`, `card-loader`'s
"I enter ready" scan 17→19 and its split-pip census 35→41, `set-coverage`'s set
list. `decklist-text-parser`'s fold-collision sweep reported 10 and was not
diagnosed — note there are **no** case-folded name collisions in the pool, so it
is the comma/dash RETRY that collides, which VEN's comma names are new for.

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

## STATE AS OF 2026-08-16, measured — start here

Re-measure rather than trusting this; it is one `coverageBySet` call, and this
document's own advice has been right every time it was ignored.

```
VEN: needing=176  implemented=124 unimplemented=52   partial=6      (2026-08-18, after the alias fix, seven card waves, Fallen Feline and Endless Riches)
```

**Phases 0–2 are done except for one upstream gate.** The set is landed, all
three keywords are implemented, and `UNIMPLEMENTED_KEYWORDS` is empty again.
`COMPLETE_SETS` still cannot take VEN — records remain unclassifiable upstream,
and all THREE derivations have been refuted (collector band, name matching,
structural identity). `node tools/card-data/set-audit.mjs VEN` is the gate and
opens by itself.

**Three numbers in the paragraph above were wrong when it was written, which is
this document's own point about itself.** It said "five records remain
unclassifiable"; the audit reports **14** and exits **1**, not 0. Neither figure
is worth chasing — the count is upstream's and moves on its own — but "the audit
exits 0 by itself" is not a thing to plan around, and a session that believed it
would look for a bug in the gate.

**TEN OF THE 134 WERE NEVER UNWRITTEN CARDS — they were INERT REPRINTS.**
`printingAliases` only aliased a printing whose NAME carried
`(Overnumbered)`/`(Signature)`/`(Ultimate)`. Unleashed marks every reprint that
way; Vendetta reprints ten earlier cards under a PLAIN name — `VEN-167 Vi,
Destructive` is `OGN-036 Vi - Destructive`, and likewise Jayce, Viktor, Rengar,
Kha'Zix, Sona, Ahri, Sett, Ezreal and Lux. All ten had an implemented twin and no
implementation of their own, which is the "12 of 31 printings were INERT" bug
arriving through the door the suffix filter left open.

Fixed by dropping the filter (2026-08-16). Three of the ten are RE-TEMPLATED —
same card, Vendetta's newer wording — so the alias test now asserts type and every
printed number unconditionally, and quotes both texts for those three by name.

**What is left is ORDINARY CARD WORK — 52 cards, and the "no subsystems" claim
has now been wrong twice.** Order alone needed rule 477's layer order (an
assignment of base Might, distinct from every pump in the pool), an amount-based
damage prevention pool, and owner/domain narrowings on `unitOrGear` targeting
plumbed through BOTH the enumerator and the validator. None is large; none was in
the list below either. Expect one or two per domain rather than none.

**What the original claim got right is that nothing left is BLOCKED.** The deep end
is finished: `[Flow]`, `[Empower]`/`[Empowered]`, the Empowered status, counter
prevention, damage prevention, a choose-time replacement effect, gear targeting
for activated abilities, and multi-ability cards all exist now. Rule **440**'s
Burn joined them with the Fury wave (`effect-helpers.burnCards`), which is the
one genuinely new primitive the set needed and which six more cards read.

The 6 partial cards are the only ones needing more than a card entry:

| card | what is missing |
|---|---|
| VEN-001, VEN-032, VEN-050 | a SELF-MODIFYING `[Empower]` cost ("costs [1] less for each rune you control") — 827.1.c.3 makes the printed number wrong on its own, so a cost-modifier hook is needed |
| VEN-074 | an ALTERNATIVE Empower cost ("[1] **or** [Body]") — no cost shape expresses a choice |
| VEN-110 | "Discard **a spell**" — `ActivationCost.discard` is a count of any cards, so charging it would be cheaper than printed |
| VEN-069 | Mel's SECOND sentence — "gives an additional -1 [Might]" is a replacement on the giving of Might. **Gangplank's three guards are the nearest seam**; this one needs the amount rewritten rather than the instruction replaced |

**Two recorded simplifications** from the cluster, both in `rules-conformance.md`
and both deliberately not exact: Gangplank's "chooses me" is unchecked (he is
stronger than printed against sweeps), and Jayce's "Ready 2 gear" takes the first
remaining exhausted gear rather than asking.

### Order, wave 1 — done 2026-08-17 (12 of 13 cards)

VEN-116, 117, 119, 120, 121, 125, 126, 127, 129, 131, 135, 138. Across
`effects/order.ts`, `granted-keywords.ts` (Disciple of Shen's conditional
`[Shield 3]`, with the printed keyword stripped in `card-loader`),
`cost-modifiers.ts` (Keeper of Law, both axes off one predicate), `combat.ts`
(Sacred Protector), `card-effects.ts` (Masa's optional Power row, and the
`unitOrGear` spec's new `owner`/`domain` narrowings), `effective-might.ts` and
`model/card.ts` (base-Might assignment) and `model/game-state.ts` (the prevention
pool). Tests in `test/ven-order-wave1.test.ts`; **25 mutants, 25 killed.**

**Four cards share ONE printed clause** — "exactly one other unit you control
here" (VEN-117, VEN-129, VEN-138) and "exactly two units there" (VEN-119) — so
the count lives once, in `granted-keywords.otherOwnUnitsHere`. It returns
`undefined` for a unit in BASE rather than 0, which is what stops a caller
satisfying an "at a battlefield" clause at home by accident. Keeper of Law's is
deliberately NOT that function: his counts ALL units, either player's, at a
battlefield he is not standing at, asked while he is still in hand.

**The mutation run found four real gaps in the tests and one in the CODE.** Three
were the same shape twice over — an assertion on the OUTCOME passes when only
`applies` is loosened, because the resolver re-checks and returns the state
unchanged, while the Pending Item is still placed and still costs both players a
PassFocus. The fix is a chain-PLACEMENT assertion, which is the identical finding
Jhin - Murderous Artist's and Blade Twirler's tests already record; this is now
three waves running, so **write the placement assertion first**. The fifth was a
guard in Kennen's Might modifier that no mutant could kill because it was
unreachable, and it was DELETED.

**The probe found a live crash the whole suite could not see, and it was
LATENT since `[Flow]` landed.** `legal-actions` re-prices a variant when its
target carries `[Deflect]`, and that re-pricing used the card's PRINTED cost
unconditionally — right for a printed-price play, wrong for the two alternative
pricings beside it (a replaced cost, and an XP-discounted one). So the enumerator
offered a Flow play at the printed price and the validator refused it, and
`execute-play-card` THROWS on a refusal rather than returning one, which crashed
`reachability` outright instead of showing as a refusal.

It is the **sixth** instance of this file's offered-then-refused class, after
Maddened Marauder, Brazen Buccaneer, Get Excited!, Kraken Hunter and Call to
Glory — every one a per-variant price computed from the wrong base. It needed
three things at once to fire (a Flow spell in the trash, a `[Deflect]` target,
and enough runes for the untaxed play to look affordable), and Lacerate is the
pool's only Flow cost with TWO pips of a NAMED domain, which is what made the
mispricing large enough to be refused rather than coincidentally equal.

Pinned in `test/flow-deflect-pricing.test.ts` as an INVARIANT — every action the
enumerator offers must validate — rather than as one action's price. **No test
in the repo enumerated and then validated the same action for this card class,
which is why it took a probe.** Write that pairing for any new alternative
pricing.

**VEN-132 Fallen Feline is the one card left**, and it is a design call rather
than card work: "name a spell" over a pool of **233 distinct Spell names**, where
the AI answers a pending decision by running a full `applyAction` + `evaluate`
per option. Every narrower option list either leaks PRIVATE information (the
opponent's deck and hand, 108.7.c) or withholds the card's main use (naming a
spell you have not seen). Pinned as an invertible assertion in
`ven-order-wave1.test.ts`. The restriction half is easy and is not the blocker —
it is Lilting Lullaby's shape, a predicate in `board-restrictions.ts`.

### Mind, wave 1 — done 2026-08-18 (10 of the domain's 19)

VEN-048 Cloud Drake, 049 Dredge Up, 051 Iterative Design, 052 Mesmerize, 058
Patched Porobot, 059 Shock Blast, 062 Hextech Formula, 063 Nasus Guardian of
Knowledge, 064 Plaza Guardian, 065 Swain Visionary. VEN 114 -> 124. Tests in
`test/ven-mind-wave1.test.ts` (34); **33 mutants, 33 killed.**

**The wave's shape is "a printed condition, asked in the right place"** — six of
the ten do nothing unconditionally — so nearly every test is a PAIR: the
condition met, and the condition one short of met. That boundary is the thing a
fixture built only at the happy end can never see, and this wave has six chances
to get it wrong.

**Two traps, both worth keeping:**

| trap | what happened |
|---|---|
| coverage cannot see a HALF-written card | Shock Blast and Hextech Formula both reported implemented the moment their effect half landed, while the printed cost discount and the enters-exhausted clause were still missing. Both gaps make the card STRONGER than printed, which is the direction that looks finished. Each is now pinned directly rather than left to `isCardImplemented` |
| PARENTHESES decide whether a sentence is a clause | Patched Porobot's "(I enter exhausted.)" is reminder text on a unit, which enters exhausted anyway. Hextech Formula's "This enters exhausted." is a real replacement on a GEAR, which does not. Same words, same wave, and only one of them owes a `deploy.ts` row |

**One engine seam and one new field**, both small:

- `excludesSelf` on the `gear` targeting spec — the axis `unitOrGear` has carried
  since Pack of Wonders, arriving on its narrower neighbour for Hextech Formula's
  "empower ANOTHER gear". Filtered in `activatableGearTargets`, which the
  enumerator and the validator both go through, so it can never be a resolver
  refusal after the exhaust cost is paid.
- `nonTokenUnitsPlayedThisTurn` for Swain. **Only ONE of his three facts needed
  new state** — `spellsPlayedThisTurn` already existed, and `gearPlayedThisTurn`
  already answers "non-token gear" WITHOUT a qualifier because it is bumped in
  `execute-play-card` and a gear token is minted by `placeToken`, which never goes
  through it.

**A survivor worth recording.** The first draft of the "another gear" test passed
`{ excludesSelf: true }` to the walk LITERALLY, so it asserted only that the walk
honours a flag — a mutant that dropped the flag from Hextech Formula's own
targeting survived untouched. The spec is now read off the CARD. Same shape as
the decision-queue survivors from Chaos wave 2: **assert against what the card
declares, never against a value the test supplies.**

Reachability pin 743 -> 750 against 754; VEN 105 -> 112, and the four finished
sets held EXACTLY for the NINTH consecutive wave.

### Endless Riches (VEN-022) — done 2026-08-18, the set's second refusal answered

One Gear, four clauses, its own commit. "When you play this, banish your hand and
trash, then [Burn 7]. Skip your Draw Phase. You may play cards from your trash.
If a card would go to your trash from anywhere other than your Main Deck, banish
it instead." VEN 113 -> 114. Tests in `test/ven-endless-riches.test.ts` (26);
**21 mutants, 21 killed on the first pass.**

**The card is a LOOP, and every clause is load-bearing in it**: the opening
banish empties both private zones, the Burn refills the trash FROM THE DECK —
the one source clause four exempts — clause three turns that trash into a hand,
and clause four stops anything ever accumulating there again. Implementing any
three of them gives a card that does nothing.

| clause | where it lives |
|---|---|
| "when you play this…" | a `played` SELF trigger in `effects/fury.ts` — the route all ten other gears printing that take, and the split VEN-108 was refused for mixing |
| "skip your Draw Phase" | `turn-manager.runDraw`. The PHASE still happens; only the draw does not — which also skips the Burn Out (431) an empty deck would have caused, and a card bought to survive an empty deck must not lose to one |
| "you may play cards from your trash" | a THIRD permission in `timing.mayPlayFromTrash` — continuous rather than banked, every card kind rather than Units, at the PRINTED price rather than a replaced one |
| "banish it instead" | `effect-helpers.fileIntoTrash`, one funnel every trash write now goes through |

**The refusal's analysis was right about the shape and wrong about one number.**
It said the trash is written from "~15 sites". Measured, it is NINE — the rest of
the `trash:` writes in `src/` are REMOVALS — and seven of the nine had to change.
That estimate is what made this look like a refactor when it was a funnel, and it
is left in place in the inverted pin rather than corrected silently.

**The one thing that could quietly have been wrong, and the reason the tests are
shaped the way they are:** "banish it instead" replaces the RESTING PLACE, not
the event. A unit under Endless Riches still DIES — its `[Deathknell]` fires and
`unitsLostThisTurn` counts it — where UNL-007 Smite's "if it would die this turn,
banish it instead" replaces the death itself and returns before any of that.
Getting those two the same way round is the whole risk, so it is asserted
directly rather than left to where the funnel happens to sit.

**A second offered-then-refused shape, with its halves swapped.** The first draft
passed every predicate assertion while the enumerator silently dropped the card:
`mayPlayFromTrash` permitted the zone, but `printedPriceAvailable` was still
asking `mayPlayFromTrashOnCharge`, so a permitted card was unpriceable in every
variant. Permitted, then refused — and nothing anywhere was "wrong". Closed by
`mayPlayFromTrashAtPrintedPrice`, which the enumerator and the validator now both
ask.

Reachability pin 742 -> 743 against 747; VEN 104 -> 105, four finished sets held
EXACTLY for the EIGHTH wave — the check that matters most here, since this change
touched every trash write in the engine.

### Fallen Feline (VEN-132) — done 2026-08-18, and the refusal it answers

One card, its own commit, because the question it raised was not a card-authoring
one. "When you play me, name a spell. While I'm at a battlefield, opponents can't
play spells with that name." VEN 112 -> 113. Tests in
`test/ven-fallen-feline.test.ts` (19) and `packages/web/test/wide-decision-filter.test.tsx`
(8); **20 mutants, 20 killed.**

**She had been refused twice, and the refusal was pinned as an invertible test
that fired the day she was written** — which is the whole point of writing one.
The pin's reasoning: 233 distinct spell names in the pool (762 bounds a naming to
"a card that is legal in the Format being played"), `legal-actions` fans a pending
decision into one action PER OPTION, and the AI runs a full `applyAction` +
`evaluate` on each — so a faithful offer costs 233 lookahead simulations every
time she is played, inside a probe that already took ~340s.

**The owner chose FAITHFUL and asked for the cost to be measured rather than
estimated. Measured, it is null.** Decomposed by control, same machine, back to
back:

| | reachability | union |
|---|---|---|
| without her (stash, rebuild) | **488s** | 745 |
| with her | **478s**, then **496s** | 746 |

She sits INSIDE the run-to-run noise, and the reason is a number nobody had
asked for. Over 200 VEN-deck games she named **15 times across 12 games** —
3,495 of 268,742 evaluated actions, or **1.30%**. The per-play arithmetic in the
refusal was exactly right (3495 / 15 = 233 on the nose); what it never asked was
how often a 2-Energy Order common with a naming ability actually gets played.

**`walkout` cannot see her at all, and that is structural rather than lucky**:
it runs the Annie preset, she is in none of the 7 preset decks, and the figures
are identical at 190/113/29. A timing difference there (77s vs 107s) is the
machine, not the card.

**The lesson worth keeping: ask for the FREQUENCY before pricing a fan-out.**
The cost of a wide decision is (options x how often it is asked), and this repo
had twice computed only the first factor.

# What she needed

| piece | where |
|---|---|
| the name itself | `UnitInstance.namedSpell` — on the INSTANCE, because two Felines name independently and the name must DIE WITH HER. "While I'm at a battlefield" is continuous, unlike Brynhir's and Lilting Lullaby's this-turn bans, which are armed on resolution and deliberately survive their caster |
| the offer | a decision in `effects/order.ts` listing every Spell name in the registry, memoised. 762.2 excludes token names and the registry gives that for free |
| the ban | `board-restrictions.mayPlaySpellNamed`, read at `timing.mayPlayCardNow` BEFORE the tier switch — a ban a `[Reaction]` walks past would be the card's whole failure mode |
| the ban, again | `playCardIgnoringCost`, so the ~48 "play it ignoring its cost" sites are not a way around it. A card played by an effect is still played |
| a rejection MESSAGE | `timingRejection` had none for a banned spell and fell through to the tier text, which names `[Action]`/`[Reaction]` at a card that has them. Lilting Lullaby's ban had been doing the same thing since it was written |
| a CONTROL a human can use | 233 buttons in one un-wrapped flex row. See below |

**The web half is not optional and nearly was.** `.choice-overlay-actions` is a
single un-wrapped row, so the engine would have been asking a question the board
could not show — this repo's single most-repeated failure, with four playtest
reports in one day and its own note in memory: the mechanic is correct, tested and
reported EXERCISED while the human has nothing to click. Past 20 options the
buttons now get a filter box and a wrapped scrolling grid, and the filter text is
tied to the decision id so the NEXT question does not open already narrowed by a
word typed at the last one.

One divergence recorded: a free play still OFFERS a banned spell (choosing it
plays nothing). The outcome is right and only the offer is wide — Zed's shape,
and closing it means teaching ~48 per-card option builders about a restriction
none of them takes an argument for.

### Chaos, wave 2 — done 2026-08-18 (the other 10; Chaos is finished but for its partial)

VEN-098, 099, 100, 101, 107, 109, 112, 113, 115, and VEN-182 through the alias.
VEN 102 -> 112. Tests in `test/ven-chaos-wave2.test.ts`; **25 mutants, 25
killed.**

**Four engine seams, and three are shapes this session has already hit:**

| seam | the shape |
|---|---|
| `fromHidden` on a unit's own on-play trigger | a fact the engine ALREADY KNEW that had never reached the resolver wanting it — the third instance, after `optionalPowerPaid` for Spells and the cost tables not canonicalising |
| `domain` on `unitList` targeting | an axis one targeting kind had and its neighbour did not; `unitOrGear` got the same field two waves ago |
| a discount on a REPLACED cost (Stargazer) | every other entry in `cost-modifiers` reduces a PRINTED price; this reduces the Flow price, which is a different number arriving at the same function |
| a delayed end-of-turn disempower | genuinely new. `runEnd` strips what `disempowerAtEndOfTurn` names — Ashe - Focused's `banishedUntilHold` is the same armed-state shape, and it is deliberately NOT `[Temporary]`, which KILLS what it expires on |

**FIVE mutants survived the first pass, and four were one habit**: answering a
question with `answerDecisions`' DEFAULT pick, which is the decline — so a card
that wrongly RAISED a question produced a board identical to one that correctly
did not. The fix is to answer with the first non-decline option and to assert the
question's absence separately. The fifth was reading `pendingTriggers` alone
where the Cleanup had already finalized the trigger ONTO the chain.

**That is now four distinct ways this session has been fooled by the decision
queue.** All four reduce to one rule: **a question you are asserting about must
be observable — two answers if you want to see it raised, and a non-default pick
if you want to see it taken.**

### Chaos, wave 1 — done 2026-08-18 (10 of 21 cards)

VEN-094, 095, 096, 097, 102, 103, 105, 106, 108, 111 — the ten needing no new
TARGETING axis. VEN 92 -> 102. Tests in `test/ven-chaos-wave1.test.ts`;
**23 mutants, 23 killed.**

**One new primitive: `banishUnitFromPlay`.** 427.2.a says outright that "Banish
is not a subset of Kill", so it is deliberately not `destroyUnit` with another
destination — no `[Deathknell]`, no death-watch, no `unitsLostThisTurn`. Wind and
Ghosts and Ravenbloom Prefect both need it, and it is what makes the small half
of Wind and Ghosts the stronger one.

**The trigger census refused a card, and was right to.** Forgotten Relic prints
two moments, and a first draft registered them on ONE definition as
`["cardPlayed", "beginningPhase"]` — half held, half inline. The census's
structural claim (an inline trigger's `on` is exactly `["beginningPhase"]`) is
the thing that caught it. Split into an event trigger and a `played` SELF
trigger, which is the route all nine other gears printing "when you play this"
already take. **Check that claim before registering a mixed `on` list.**

**Three mutants survived the first pass and all three were the same blind spot**
— a question with ONE option is executed silently by `advanceDecisions`, so a
test that reads `pendingDecisions` sees nothing whether the card is right or
wrong. Two of them needed a second friendly unit on the board before the question
was observable at all. That is the third distinct way this session has hit the
silent-single-option shape; **when asserting that a question was or was not
raised, make sure it would have TWO answers if raised.**

**Chaos's remaining 11** need machinery rather than card work: a Tentacle token
(VEN-100, VEN-109/182), granted `[Flow]` (VEN-113), a delayed end-of-turn
disempower (VEN-099), a discount on a REPLACED cost (VEN-098), an "open
battlefield" play permission (VEN-115), a domain filter on `unitList` targeting
(VEN-107), a second Shadow Clone maker with a swap ability (VEN-112), and an
optional Energy-only additional cost (VEN-101). VEN-110 is one of the six
partials.

### Body, wave 1 — done 2026-08-17 (12 of 13 cards)

VEN-071, 072, 076, 080, 081, 082, 083, 085, 088, 089, 090, 091. VEN 80 -> 92.
Tests in `test/ven-body-wave1.test.ts`; **25 mutants, 25 killed.**

**One engine seam, and it is the third instance of one failure shape.** Rampage
is the pool's first SPELL with an optional Power cost, and `optionalPowerPaid`
rode only the on-play TRIGGER event — so the card would have been enumerated at
two prices and resolved identically at both. `OPTIONAL_POWER_COSTS` already
records the mirror of this TWICE (Pyke and Nami shipped with the trigger written
and the table row missing, so the flag could never be true). Now threaded onto
`SpellChainEntry` and `ResolveEvent`.

**Both surviving mutants were the same class of test gap**: an assertion that
never reaches the second half of a two-part card. Wild Claw's Empower step is
only asked when the banish was taken, so a test that declines the FIRST question
cannot see it; and every Rampage test called the resolver directly, which proves
it READS the flag and says nothing about anything WRITING it. **A card with a
chained question needs a test that answers the first and refuses the second, and
a card with a new action field needs one end-to-end test through `submit`.**

Cataclysmic Duel is the first card here where a player controlling NOTHING still
has to answer: an empty option list makes a question moot, `advanceDecisions`
drops it, and the chain to the other player's question breaks — turning "kill the
rest" into "kill nothing". The explicit "you control no units" answer is what
keeps it alive.

**VEN-074 Legion Marauder is Body's only remainder**, and it is one of the six
partials: `[Empower] — [1] or [Body]` is an ALTERNATIVE cost, and no cost shape
in this engine expresses a choice.

### Fury, wave 2 — done 2026-08-17 (3 cards, and the token subsystem)

VEN-004 Dune Surfer, VEN-023 Zed (and VEN-169 with him through the alias).
VEN 77 -> 80.

**Dune Surfer's ignore is the ASSIGNER's permission**, which is what made it a
parameter rather than a table lookup: `assignmentOrder` receives the units being
assigned TO, so their owner is the victim and the Surfer belongs to the other
seat. He prints `[Tank]` himself and that is the design — enemies must assign to
him first, and his controller need not.

**The Shadow Clone is the pool's second token with a printed ABILITY**, and it
repeated the Gold token's initialisation trap in a louder form. `token.ts`
imports `holdEventTrigger`, so deriving `SHADOW_CLONE_TOKEN_DEF_ID` there and
reading it at MODULE SCOPE in `triggers.ts` threw a temporal-dead-zone
ReferenceError at import. The Gold token hit the silent half of this — its
ability was registered "under the key `undefined`" and nothing failed. Both are
fixed the same way: the id lives in the LEAF `constants.ts`.

Its question is a `tokenDecisions` merge source exported from `triggers.ts`,
beside `legendDecisions` and `battlefieldDecisions` and for the same reason —
nothing about a token has a domain to file it under, and its two MAKERS
(VEN-023 in `effects/fury.ts`, VEN-144 in `effects/signature-fury.ts`) are in
different files, so either home would be arbitrary and only one could hold it.

**A COST TABLE keyed by raw defId let a printing play CHEAPER than printed, and
the guard caught it one commit after being written.** Zed's discard row made
`VEN-169` — his `(Overnumbered)` print — a Zed who inherits the effect through
the alias and could never be offered the cost. The five tables in
`card-effects.ts` now canonicalise in their ACCESSORS rather than hand-listing
prints, which is the same reasoning that makes `printingAliases` derived at all.
Watch for this shape on every future card with an additional cost.

**Endless Riches (VEN-022) is the one Fury card left**, and it is deliberately
its own change rather than a card entry. Four clauses, of which only the first
is card work:

| clause | what it needs |
|---|---|
| "banish your hand and trash, then `[Burn 7]`" | nothing new — `banishCard` and `burnCards` both exist |
| "Skip your Draw Phase" | `turn-manager.runDraw` |
| "You may play cards from your trash" | a THIRD trash permission: continuous, board-derived, EVERY card kind, at the PRINTED price. Neither Last Rites' spent charge (Units only) nor a card's own replaced cost is it, and `mayPlayFromTrash`'s own comment says why the two existing ones are deliberately not merged |
| "If a card would go to your trash from anywhere other than your Main Deck, banish it instead" | a replacement on TRASHING. Nothing in this engine replaces that today, and the trash is written from ~15 sites |

### Fury, wave 1 — done 2026-08-16 (13 cards)

VEN-002, 003, 005, 006, 008, 009, 010, 012, 013, 016, 017, 019, 020. Registered
across `effects/fury.ts` (card effects, one unit trigger, five event triggers,
two decisions), `deploy.ts` (Shadow Assassin's conditional enter-ready),
`card-effects.ts` (Ruthless Strike's discard row) and `effect-helpers.ts` (Burn).
Tests in `test/ven-fury-wave1.test.ts`; **14 mutants, 14 killed**, one of which
(loosening Blade Twirler's `applies`) survived the first pass and needed a
chain-placement assertion rather than an outcome one — the identical finding
Jhin - Murderous Artist's test already records.

**Fury's remainder, and why each is not in that list:**

| card | what it needs |
|---|---|
| VEN-004 Dune Surfer | "You ignore `[Tank]` while assigning combat damage here" — a per-player exemption inside `combat.ts`'s assignment order, not a card registry entry |
| VEN-022 Endless Riches | FOUR continuous clauses on one gear: skip your Draw Phase, play cards from your trash, and a trash→banish replacement, plus an on-play banish-and-Burn-7. Three of the four are different subsystems |
| VEN-023 Zed, From the Shadows | A Shadow Clone TOKEN with its own printed attack trigger. The token spec belongs in `token.ts` (shared — VEN-144 Death Mark makes the same one from `signature-fury.ts`), and its ability keys off the runtime `TOKEN-` defId the way the Gold token's does. **VEN-169 lands with it through the alias** |
| VEN-001 Baccai Sandspinner | Partial — the self-modifying `[Empower]` cost above. Left until last with the other five |

**One thing to know about `DISCARD_CHOICE_CARDS` before the next batch:** it is
keyed by raw defId with no `canonicalDefId`, so a PRINTING of a card with a
discard cost would not get one. Not reachable today (no alias's twin is in that
table) and the same shape as the literal-comparison class `printing-aliases.test.ts`
already describes. `REPEAT_COSTS`, `OPTIONAL_UNIT_COSTS` and
`TOKEN_PLACEMENT_SPELL_DEF_IDS` are keyed the same way — check them when a
Vendetta reprint lands in one.

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
