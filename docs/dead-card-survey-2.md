# The 66 remaining OGN cards, re-surveyed — 2026-08-02

Supersedes the classification in `docs/dead-card-survey.md`, which was written when
88 cards were dead. **All 29 of its READY cards have since landed**, and that added
primitives — so the old SMALL-GAP/SUBSYSTEM tiers were re-measured against the
engine as it now stands, by four read-only agents over disjoint domain sets.

**OGS is complete (22/22).** Every remaining card is OGN: 249 with real text, 183
implemented, **66 open**.

The old survey is not merely out of date — **two of its conclusions were wrong in
the direction that matters**, and both are corrected below.

## The headline: the READY tier is genuinely exhausted, with three exceptions

Of 66 cards, only **three are READY-NOW** — a registry entry and a resolver in a
per-domain file, nothing shared:

| card | why it is free now |
|---|---|
| **OGN-242 Baited Hook** | The blocker was activation Energy+Power, which was BUILT for this card on 2026-08-02 — `activated-abilities.ts` names it in a comment. Everything else is Spectral Matron's shape. |
| **OGN-121 Teemo - Strategist** | "When I defend" needs no new event: Yasuo - Remorseful established `combatBegan` + `bf.contestedByIndex` (464.2.c's own definition of the Attacker) as the precedent. |
| **OGN-198 The Harrowing** | Byte-identical to Soulgorger's trash→`playUnitToBase` decision, in the same file, minus the "you may". |

Two more are one shared-file edit with no new concept: **OGN-181 Pack of Wonders**
(`ACTIVATED_ABILITIES` has no per-domain fan-out) and **OGN-193 Miss Fortune -
Buccaneer** (the smallest gap on the list).

## Corrections to the previous survey and to `rules-conformance.md`

**1. `[Deflect]` now unblocks FIVE cards. The conformance row saying it "unblocks
none" is stale.** That was true on 2026-08-01 and false since: Qiyana's conquer
trigger, Deadbloom's placement grant, Fiora's grant and Spirit's Refuge's buff half
have all landed in the meantime. `[Deflect]` alone now finishes **OGN-013 Pouty
Poro** (a precon card, ×2), **OGN-063 Spirit's Refuge**, **OGN-155 Qiyana -
Victorious**, **OGN-161 Deadbloom Predator** and **OGN-232 Fiora - Victorious**.
Only OGN-041 (split damage) and OGN-231 (kill-N + Power discount) need more.
**This makes `[Deflect]` the single highest-leverage change in the backlog.**

**2. `[Backline]` is NOT a keyword with no card in this pool.** The conformance row
says so; **OGN-068 Caitlyn - Patrolling** prints it as plain prose — *"I must be
assigned combat damage last."* — and the rules name her card explicitly when
defining Backline. Consequences: `parseKeywords` sees no bracket so she honestly
reports unimplemented; "Backline" is absent from `KEYWORDS` so `hasKeyword` would
not typecheck; a per-card `ASSIGNED_LAST_DEF_IDS` set in `combat.ts` is smaller than
adding the keyword. **And `assignmentOrder`'s early return at `tanks.length === 0`
must go** — with a third tier, "no tanks" no longer means "nothing to reorder".
Rule 465.2.c's exclusionary clause (a unit with BOTH Tank and Backline: the
assigner picks one ability, never both) **is reachable in this pool today**,
because Block grants `[Tank]`.

**3. The survey OVERSTATED Mageseeker Warden.** It said the ready-restriction needs
source attribution on `readyUnit`/`readyPermanent` across ~10 call sites "and must
exempt Awaken and combat cleanup". Measured: all 15 call sites are spells,
abilities or triggers; Awaken readies by an inline `.map` in `runAwaken` and combat
never calls either helper. **The exemption is already structural.** The check can
read board state alone.

**4. `DecisionOption.payment` is a dead field** — declared in `decisions.ts`, zero
producers and zero consumers. Two agents found this independently. It reads as
"mid-resolution payment is supported" and it is not; every decision-time payment in
the pool is Power via `payPowerFromChanneled`, which needs no choice. Anything
needing to pay ENERGY inside a decision (OGN-035, OGN-062) has to build it.

## Groups, ranked by cards finished per change

| # | change | finishes | also advances |
|---|---|---|---|
| 1 | **`[Deflect]` in the cost pipeline** (per-target pricing, third `RunePayment` bucket, Power dimension on activations) | **5** | 041, 231 |
| 2 | **`unitMoved` event + `movesThisTurn` counter** (one edit to `execute-move-unit`) | **2** (177, 205) | 189, 158 |
| 3 | ~~**Four new permanent events**, each `holdEventTrigger`: `unitReadied`, `endOfTurn`, `battlefieldHeld`~~ **DONE 2026-08-02** — all three landed, finishing **143, 073, 066 and 067** (Blitzcrank's on-play grab was written too, so he is whole rather than partial). `cardsRecycled` is NOT built: 235 is one of the nine unguessed rules calls. **160 Dazzling Aurora still needs the banish helper (#7) and play-from-banished-ignoring-cost**, which is the only remaining `endOfTurn` card | **4** (143, 073, 066, 067) | 160, 235 |
| 4 | **Chain-item targeting spine** (`counterSpell`) | **2** (064, 045) | 080 |
| 5 | ~~**Keyword auras from another source**~~ **DONE 2026-08-02** — one `KEYWORD_AURAS` table keyed by the SOURCE, which finished **all four**: the GEAR-source variant with a per-target predicate landed with the rest rather than separately, so 063 is whole and `PARTIALLY_IMPLEMENTED` is now empty | **4** (015, 074, 100, 063) | — |
| 6 | **Per-variant payment restructure** (X-costs, `modifiedPowerCost`) | **3** (150, 231, 268) | converges with #1 |
| 7 | **Banish helper** (`banished` still has zero writers) | **1** (102) | 115, 122, 194 |
| 8 | **Computed Hide cost** | **1** (264) | 263 |
| 9 | **N-target announce-time selection** | 029, 248, 256, 258, 244 | the cluster-4 model decision |

**The selection-model decision (#9) is still the one to make once**, and the
re-survey sharpens it: the Albus Ferros idiom (a decision with `count` that re-parks
itself) means a resolve-time model needs **zero shared change** — Icathian Rain's
six questions could be written today. The cost is a rules divergence, and the rules
are explicit that targeting is announce-time. Note `repeatDecision` is
module-private in `decisions.ts`, so a domain file re-parks at the BACK of the
queue unless it is exported.

## Live interaction created by this session's own work

**A counter must also remove held `cardPlayed` triggers.** `cardPlayed` became a
Chain Pending Item today, and the rules say *"A card that is Countered is not
considered to have been played for abilities that trigger on cards being played"*.
So `counterSpell` has to strip matching entries from **both** `spellChain` and
`pendingTriggers`. Conversely `[Legion]` and cost-counting are explicitly
unaffected, so `cardsPlayedThisTurn` must NOT be decremented. Getting this wrong is
invisible in play.

## Rules questions the PDF does not answer

See `docs/rules-calls-resolved.md`. Six of the original seven are answered there —
three because the rules use the card as their own worked example. The re-survey
surfaced nine more genuine ambiguities, all recorded in that file, none guessed.

## Method note

Four agents, read-only, disjoint sets, no build or test run. Their findings are a
high-quality map and were spot-checked, not trusted: one flagged that a claim in
`rules-calls-resolved.md` cited a keyword-value rule to settle a COST question, and
it was right — that entry is corrected and the question reopened.

---

# The selection-model decision: ANNOUNCE-TIME

Settled 2026-08-02. The survey framed this as a trade-off between rules-correctness
and enumeration cost. It is not — the rules force it, and the enumeration cost is
a misattribution.

## Why the rules force it

**Cards exist that read another chain item's target set.** The PDF's Volibear
example:

> *"Volibear's attack trigger goes on the chain targeting three of the units at that
> battlefield. In reaction, the defending player plays Flash moving two of the three
> units back. That player cannot then target the attack trigger with **Repulse**,
> which reads 'Choose a friendly unit at a battlefield. Counter an enemy spell or
> ability that chooses it and no other friendly unit.'"*

Repulse asks *which units is that item choosing* while the item sits on the chain.
Under resolve-time selection there is no answer, because nothing has been chosen
yet. So resolve-time does not merely diverge on timing — it makes a whole card
archetype unimplementable, and it hollows out the response window the entire Chain
conversion has been built for. Holding triggers so an opponent can respond, and
then not telling them what the trigger is aimed at, is the worst of both.

**And the engine already does announce-time.** `unitSlots` with one and two targets
is announce-time today. Choosing resolve-time for three or more would mean the same
printed phrase — "a unit" — means different things depending on how many times it
appears on the card, and two targeting models would coexist permanently. That is
worse than either model chosen consistently.

The rules also require BOTH halves for Fox-Fire: announce-time group targeting AND
a resolution-time legal-subset re-choice when the group stops qualifying.
Resolve-time-only gets neither.

## Why the enumeration cost is a misattribution

The survey's objection was ~10^5 variants for a six-slot card swamping
`legal-actions` and the AI. That conflates two consumers that need different
things:

- **The UI never needed the enumeration.** It builds a play interactively —
  `pendingPlay` plus a target step plus the existing `Done (N)` / `Choose no
  targets` button, driven by `pendingChosenTargetCount()` and `pendingMinTargets()`.
  It asks "what may I click next", not "give me every combination". The N-target
  picker is **already built**; it is only capped because `pendingChosenTargetCount`
  reads exactly two fields.
- **`validate-play-card` is what actually gates legality**, and it can accept any
  legal set without anyone enumerating it.
- **Only the AI wants candidates**, and it does not need the powerset — it needs a
  bounded, sensible sample.

So the shape is: carry `targetUnitInstanceIds: string[]` on the action, validate the
whole set (including group requirements like Fox-Fire's total Might), let the UI
fill it with the picker it already has, and have `legal-actions` emit a **bounded
heuristic sample** for the AI rather than every combination.

**The divergence that leaves is narrow and honest:** "the AI considers a bounded
subset of target combinations." That is a search limitation, in the same family as
the existing one-ply lookahead — not a rules divergence, and it does not change what
is legal or what a human can do. Resolve-time would instead have been a permanent
rules divergence affecting what the game *is*.

## What it costs

`unitSlots.slots` is a fixed 2-tuple and `PlayCardAction`/`SpellChainEntry` carry
exactly two target fields, so the widening touches the spec, the action, the
validator, the enumerator and the UI's two-field counter. Bounded, mechanical, and
it subsumes `asymmetricSlots` and `allowsDuplicateTargets` as special cases of an
ordered list.

Cards it governs: OGN-029 Falling Star, OGN-248 Icathian Rain, OGN-256 Fox-Fire,
OGN-258 Dragon's Rage, OGN-244 Divine Judgment, plus OGN-041 Volibear's split
damage — which the rules already specify as announce-time targeting with a cap
equal to the damage.
