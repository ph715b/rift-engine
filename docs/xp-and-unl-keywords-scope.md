# XP and the Unleashed keywords — scoped before the JSON lands

Written 2026-08-08, against the Core Rules PDF (`2026-07-16`), the oracle's
`model/Keyword.java`, and a scan of all 280 entries of `unl.json`. This is the
last item of the readiness gate in `engine-readiness-for-unleashed.md`.

**Do not copy the verification loop into this file.** It is in `CLAUDE.md`.

## The headline: XP is one integer, and the plan over-priced it

The plan called XP "the real subsystem, and the one thing worth scoping properly".
Measured against the rules, **the resource itself is a per-player counter and
nothing more**. The XP section (between 727 Dependent Keywords and 735 Additional
Turns — the numbers in the left column of a `pdftotext -layout` dump are offset
from their text, so it is cited by neighbour rather than by a number this document
would get wrong) says, in full:

- XP is a resource accrued, spent, or otherwise modified by players.
- Its amount is **Public Information**.
- It can be **Gained** (increase) and **Spent** (decrease).
- **XP is not a Game Object** — "cannot be targeted, readied, or exhausted".
- Not shared between allies (no effect in 2-player).
- **No cap.**

So: `PlayerState.xp: number`, a `gainXp`/`spendXp` pair, and it renders. There is
no zone, no object, no timing window, nothing to respond to, and nothing that can
be targeted. `game-state.ts`'s own comment already names `xp` as one of the Java
`Player` fields to add "when the card that needs it is implemented" — that day is
this set.

**The work is not the resource. It is the four things that read and write it.**

## Measured: what UNL actually prints

280 entries scanned. Keyword counts are cards printing the token:

| token | cards | state today |
|---|---|---|
| `[Reaction]` | 39 | implemented |
| `[Deflect]` | 23 | implemented |
| `[Temporary]` | 22 | implemented |
| **`[Level N]`** | **18** | **not modelled** |
| **`[Ambush]`** | **18** | **not modelled** |
| `[Ganking]` | 15 | implemented |
| `[Action]` | 15 | implemented |
| **`[Hunt N]`** | **14** | **not modelled** |
| `[Deathknell]` | 12 | implemented |
| `[Assault]` | 12 | implemented |
| `[Tank]`, `[Hidden]` | 11 each | implemented |
| `[Shield]`, `[Accelerate]` | 9 each | implemented |
| `[Repeat]` | 8 | implemented |
| **`[Predict]`** | **5** | **not modelled, and NOT in the plan's list** |
| **`[Backline]`** | **6** | already implemented, per-card |
| `[Vision]` | 4 | implemented |
| `[Weaponmaster]`, `[Legion]`, `[Mighty]` | 1 each | implemented |

XP text: **51 of 280 cards mention XP** — 35 gain it, 18 pay or spend it.

`[Level N]` thresholds in use: **3 (×6), 6 (×13), 11 (×7), 16 (×2)**. One card
prints four of them (Master Yi - Unstoppable: 3/6/11/16), which is the reason the
oracle hand-writes each threshold rather than reading it back off the keyword.

## The five keywords, smallest first

### `[Backline]` — DONE, but it should stop being a per-card set

`combat.ASSIGNED_LAST_DEF_IDS` is a third tier in `assignmentOrder`, built for
OGN-068 Caitlyn - Patrolling, who prints the effect as plain prose. UNL prints it
as a **real bracketed keyword** on 6 cards. The oracle made the same call and says
so: model it as a keyword "instead of adding 4 more per-name string checks".

**Work:** add `Backline` to `KEYWORDS`, make `assignmentOrder` read
`hasKeyword(u, "Backline") || ASSIGNED_LAST_DEF_IDS.has(u.defId)` so Caitlyn keeps
working, and delete nothing. Half a day. 465.2.c's Tank+Backline conflict is
already reachable and already handled.

### `[Ambush]` — mostly free, one restriction

"You may play me as a `[Reaction]` to a battlefield where you have units."

The oracle's note is the important measurement: **the reminder text literally
embeds the substring `[Reaction]`**, so `card-loader`'s existing
`plain.contains("[Reaction]")` already sets `isReaction` on all 18 with **zero
parser changes**. What is new is one extra placement restriction — the destination
battlefield must already hold a friendly unit — which is a condition on an
existing enumerate/validate pair, not a new mechanism.

**Work:** the keyword, plus one predicate consulted by the play enumerator AND the
play validator. **That pair is the one this repo has split five times**, so it is
one function asked twice, like `moveDestinationAllowed` and `cardMayMoveToBase`.

### `[Predict]` — the one the plan missed

Not in the plan's four, and **not in the oracle's `Keyword.java` either**. Its
printed shape is an **action word**, like `[Buff]`, `[Stun]` and `[Add]`: it
appears as `[Predict].` mid-sentence with reminder text "(Look at the top card of
your Main Deck. You may recycle it.)".

So it belongs in `NON_KEYWORD_BRACKETS`, not `KEYWORDS` — and the behaviour is
**already built**: `engine/top-of-deck.ts` is exactly "look at the top card, may
recycle it" (Void Hatchling's family). 5 cards: Eclipse, Abandon, both Diana -
Lunari printings, and the Forgotten Library battlefield.

**Work:** an allow-list entry and a shared helper the 5 cards call. Small — but it
must be *decided*, because an unknown bracket token fails
`coverage-drift.test.ts`'s token census on the day the JSON lands. **That census
is what will surface this**, and it is the reason the set is loadable at all
before the cards are written.

### `[Hunt N]` — the XP faucet, and it dispatches generically

"When I conquer or hold, gain N XP." 14 cards, N ∈ {1, 2, 3}.

**Both moments already exist as held events**: `battlefieldConquered` and
`battlefieldHeld` are `HeldEventKind`s with 21 of 22 kinds converted. So Hunt is a
single listener keyed off the keyword's magnitude — the oracle says the same, "no
per-card-name switch needed, unlike almost everything else in this pool".

**Work:** `PlayerState.xp`, `gainXp`, and one generic trigger reading the
magnitude. **This is the piece to build first**, because it is the only source of
the resource everything else consumes, and because a generic dispatch is testable
against all 14 cards at once.

### `[Level N]` — a Dependent Keyword, and the only real design question

"While you have N+ XP, get the effect." 18 cards, four thresholds.

Rule **727** is the general machinery: a **Dependent Keyword** makes its ability
**Inactive until the Condition is met**, when it becomes **Active**. It does NOT
spend XP — it is a gate, not a cost. Three consequences the rules state outright:

- **730.2**: "Triggered Abilities of Dependent Keywords must be Active for their
  trigger to be evaluated." That maps onto the `applies` hooks that already exist
  on `EventTriggerDefinition`, `DeathWatchDefinition` and now
  `DeathknellDefinition` — a `[Level]`ed trigger is one whose `applies` also asks
  `xp >= N`.
- **Passive abilities** begin applying the moment the condition becomes true.
- **An activated ability already on the chain is unaffected** if the condition
  lapses after it was added as a Pending Item.

**`[Legion]` is the same family and is already implemented — inline, per card.**
9 cards check `actor.cardsPlayedThisTurn < 1` at their own site; there is no
general dependent-ability machinery. The oracle takes the same approach for Level
and says why: **each threshold's granted effect differs per card, and one card can
print four thresholds at once**, so a table keyed by keyword magnitude cannot
express it.

**The design question, and it is the only one in this document:** follow the
inline precedent (fastest, matches Legion, 18 cards each asking `xp >= N`), or
build a general Dependent-Ability layer now that Level, Legion and any future
dependent keyword share. **Recommendation: inline, matching Legion.** A general
layer would have to reach every ability type — passive, triggered, activated — and
727's own rules make each behave differently; that is a subsystem justified by
three keywords, not two, and it can be extracted later from 27 working call sites
rather than guessed at from none.

## What XP is spent ON, which is separate from Level

18 cards pay or spend XP, in three shapes that map onto machinery that exists:

- **An activated-ability cost** — "Spend 3 XP, `[Exhaust]`: Draw 1."
  `ActivationCost` already carries energy/power/exhaust; this adds an `xp` field.
- **An additional cost to play** — "You may spend 5 XP as an additional cost to
  play this." That is the optional-additional-cost path Meditation and Kraken
  Hunter already use.
- **A cost inside an instruction** — "You may pay 2 XP to choose a card from
  their hand." The rules are explicit that this is **paid on resolution**, not as
  part of the ability's base cost (383.4 and 204.4 both say so).

That third one is worth flagging: **this engine cannot pay mid-resolution.** The
Divergent table already records it for Last Rites and Jayce — "a play needs a
`RunePayment` and `AnswerDecisionAction` carries only an `optionId`". XP is
different and easier, because spending XP needs no payment object at all: it is a
single integer decrement, so a decision option can carry it. **Worth confirming
against a real card before building**, but it looks like the one place where XP is
*easier* than runes rather than harder.

## Order of work

1. **`PlayerState.xp` + `gainXp`/`spendXp` + the board rendering it.** Nothing
   else can be tested without it.
2. **`[Hunt N]`**, generic off the keyword magnitude against the two existing held
   events. The faucet.
3. **`[Predict]`** into `NON_KEYWORD_BRACKETS` and onto `top-of-deck.ts`. Needed
   before the JSON loads cleanly.
4. **`[Backline]`** as a keyword, keeping Caitlyn's per-card entry working.
5. **`[Ambush]`**, one predicate, enumerator and validator together.
6. **`[Level N]`** inline per card, thresholds hand-written.
7. **XP as a cost** — activation, additional, and the in-instruction case.

Steps 1–2 are the ones that must be right; the rest are ordinary card work.

## What this does NOT need

Named, because the plan expected a subsystem and the measurement says otherwise:

- No new zone, object, or timing window. XP is not a Game Object.
- No targeting changes. XP cannot be targeted.
- No cap or overflow handling.
- No general Dependent-Ability layer (see the recommendation above).
- No parser change for `[Ambush]`'s reaction timing — the reminder text already
  carries `[Reaction]`.

## The standing caveat

Every claim here was checked against the PDF, the oracle, or the engine on
2026-08-08 — but **notes about this codebase's mechanisms have been wrong or stale
ten times out of eleven**, and this document is now one of them. Re-read the code
before believing any line of it. The three Phase 2b fixes each found their own
divergence row wrong in some detail, including a rule number that did not exist.
