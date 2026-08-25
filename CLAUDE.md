# Rift-Engine — the things a session must not re-derive

Read `docs/SESSION_KICKOFF.md` for what this project is and `docs/PRD.md` for
scope. This file is only the operational rules that have cost real time when a
session got them wrong.

## The verification loop, in this order, every time

```bash
npm test                                          # ROOT — BOTH workspaces
npm run build --workspace=@rift-engine/engine     # BEFORE the typecheck AND any probe
npm run typecheck                                 # both workspaces; COUNT the errors
npm run build
cd packages/engine
node probes/{ai-health,passive-human,chain-depth,walkout,reachability,hunt-xp,battlefield-reach}.ts
```

**`hunt-xp` is here because `reachability` CANNOT see XP.** A keyword is not a
registered card effect, so nothing in the exercise log records one firing —
`reachability` did not move at all when `[Hunt]` landed, which is neither
evidence for nor against it. XP has one writer (`gainXp`), so "did any player's
XP ever rise in a real game" is the only question that settles whether the
keyword is live or inert in play. Expect every XP keyword to need this probe
rather than the coverage gates.

**`first-player` is NOT in that list, on purpose.** It answers "does going first
win more?" — a question about the GAME, asked so the AI can make tournament rule
407.4's turn-order choice on evidence. It is an instrument for a design decision
rather than a regression gate, it costs minutes, and its answer only moves when
the AI does. Run it when that choice is revisited; do not put it in the loop.

**And `ai-ab` cannot answer that question, which is why it exists.** That harness
pairs every game with itself and the labels swapped, and pins `firstPlayerIndex`
to 0 in both halves — deliberately cancelling the seat, which is the whole
variable here. Mirroring would have produced a guaranteed 50% and looked like a
result. Reach for a new probe when the existing one's controls are designed to
remove your variable.

**`battlefield-reach` is here for the same reason one level up: NOTHING ELSE CAN
SEE A BATTLEFIELD IN PLAY.** `card-loader`'s `shouldSkip` keeps Battlefield cards
out of the registry, so `reachability` never counts one and `isCardImplemented`
is never asked about one; `walkout`, `chain-depth` and `reachability` all pin
`legacyBattlefields()` on purpose, and the preset decks name a few more. **Only
eight of the 64 were ever in play in any instrument here, and all eight are
OGN.** SFD's 15, UNL's 15 and VEN's 10 had never been on a board at all, so a
battlefield that was correct, tested, hard-gated and completely inert in play was
indistinguishable from one that fires every game.

It is a NEW probe rather than a change to the pinned ones, deliberately: making
`walkout` roll real battlefields would move 190/113/29 and making `reachability`
do it would move every per-set figure.

Pinned at **132 games, 64 in play, 34 of 38 triggered ones firing, 0 invalid**,
with fired/triggered per set OGN 14/16, SFD 10/10, UNL 8/9, VEN 2/3. The silent
ones are conditional rather than broken and are named in the probe's own header;
a name appearing there that the header does not explain is the finding to chase.

**It went 35 -> 34 and UNL 9/9 -> 8/9 on 2026-08-24, and the FOURTH silent name
is UNL-215 Star Spring — which is pure TRAJECTORY, not a break.** Star Spring
reads "the first time a player plays a non-token unit here each turn"; it has no
connection to what changed, which was the ability-timing gate (310.1.a). The AI
is offered fewer actions inside Showdowns, so it decides differently, and across
these 132 fixed seeds nobody played a non-token unit at Star Spring.

Decomposed by CONTROL, three runs, same machine: **at HEAD, 35 fired / UNL 9/9 /
3 silent; with the same change's `killSelf` fix ALONE, identical; with the timing
gate, 34 / UNL 8/9 / 4 silent.** So the gate is the sole cause and the second fix
in that commit moves nothing.

**Expect this probe to move for any change to what the AI may DO**, exactly as
`walkout` and `reachability` do, and re-derive it by control rather than reading
a drop as a regression. This is the same shape as `reachability`'s SFD 188 -> 186
note further down: the ACTION SPACE, not the rules the cards implement.

**It went 36 -> 35 and OGN 15/16 -> 14/16 on 2026-08-23, and the THIRD silent
name is OGN-293 The Grand Plaza — which the probe is now RIGHT about.** "When you
hold here, if you have 7+ units here, you win the game": 383.2.a.1 makes a
conditional immediately after the Condition part of the Trigger Condition, so the
count is asked at the hold and the ability does not trigger below 7. It used to
place a Pending Item at every hold and find fewer than 7 at resolution — which
this probe counted as FIRING, because placing a chain item is all it can see.

Decomposed by CONTROL, same machine, rebuilt between runs: with `applies` forced
true, **36 fired / 2 silent / 1012 chain items**; with the rule's reading,
**35 / 3 / 995**. The whole 17-item delta is Grand Plaza items that used to do
nothing, and nothing else moved. **So this probe cannot tell "fired" from "was
placed and did nothing"** — the same blind spot in miniature that it exists to
cover one level up, and worth knowing before reading a future drop here as a
regression.

**It earned its keep on the first run** - OGN-292 The Dreaming Tree had been
implemented and hard-gated for the life of the engine with no behavioural test at
all, and `battlefield-coverage` could not see it, because that gate asks whether
an entry exists and the entry does. **Silent in play AND pinned by nothing is the
pair that matters**; either half alone is fine, which is why this probe reports
the list rather than gating on it.

**Its own first run was wrong before the engine was**, in the way this file keeps
recording: 22 invalid actions in 22 games, which was the probe playing on after
someone had won rather than any offered-then-refused. `legalActions` keeps
enumerating once a winner exists; `walkout` breaks on the `GameOver` result and
that is why it reports 0.

`reachability` REPLACES the two `exercised` lines that used to sit here — it runs
the preset decks and one covering run per set in a single 10-second process, and
gates every instrument control both of those lines gated, per run. `exercised.ts`
is still the per-mode drill-down (`DECKS=sfd node probes/exercised.ts`, plus
`mostPlayed` and the offered/taken split); it is no longer the thing that has to
be remembered twice.

**Step 1 is the ROOT `npm test`, not `npx vitest run` in `packages/engine`.**
This has now bitten twice, both times the same way: an ENGINE change breaks a
WEB test and nothing else can see it. The typecheck passes (the change is
well-typed), the build passes, and the probes never load the web package.
`packages/web` has ~100 tests and they are the only thing that reads the engine
the way the app does.

- 2026-08-06: an engine validation message broke `auto-payment.test.ts`, which
  asserts on that exact string. Red across several commits.
- 2026-08-07: finishing SFD broke `card-filters.test.ts`, whose premise was that
  the pool HAS unimplemented cards to hide. Red for a whole session, and the
  session shipped a set-completion milestone on top of it.

**Step 2 is not optional.** `@rift-engine/web` resolves `@rift-engine/engine`
from `dist`, and so do the probes. An engine fix is invisible to both until the
engine is rebuilt — a source change that "does not work" has usually just not
been built.

**Step 3 has its own trap.** The engine's `build` tsconfig EXCLUDES tests;
`typecheck` includes them. So `typecheck` can sit red for months while the build
stays green. Read it to the END (`tail` shows a misleading subset), and when it
is red, diff the error list against HEAD before assuming the errors are yours.

**Pinned probe figures.** `walkout` is **190 walkouts / 113 points / 29 closed
with nobody present**. A change to combat, timing or Might math that moves these
needs the new number explained, not accepted.

**It moved for the first time on 2026-08-14, from 191/107/32, and the cause was
not in that list — it was the ACTION SPACE.** `legal-actions` began enumerating
every subset of the units that can reach a battlefield (144.3's simultaneous
move), so the AI commits several units in one action instead of dribbling them in
one per action. It arrives in force, and fewer showdowns close empty.

Decomposed by CONTROL, not by argument: making `nonEmptySubsets` return
singletons and rebuilding reproduces 191/107/32 exactly. **That control was run
twice and the first time it was worthless** — the probes load from `dist`, so a
src edit without `npm run build` measures the PREVIOUS build. It agreed with the
unmutated run to four figures, which is exactly what a working control looks
like. Step 2 of the loop above is not optional for probes either.

It then moved again in the same session, 191/115/29 → 190/113/29, when
`MAX_GROUPED_MOVERS` was lowered from 8 to 4 for runtime. **That is the lesson
worth keeping: this probe is sensitive to how wide the fan-out is, not only to
what the rules do.** Expect it to move for any enumerator change and re-derive it
by control, exactly as above.

**`walkout` IS deterministic — five runs, same figures — and `reachability` is
NOT.** Do not carry an assumption from one to the other; see the pin note below.

`reachability` is pinned at **796, against an observed 796** of 868 cards needing
code ever exercised, at its default **500 games per mode**.

**The observed figure fell 800 -> 796 on 2026-08-24 and the pin HELD, so the
headroom described below is now ZERO.** The cause is the ability-timing gate
(310.1.a): a Default-speed activated ability can no longer be used in a Showdown,
on the opponent's turn, or onto a chain, and 148 of the 184 registered abilities
are Default. Repeating across two independent runs of the gated build.

Diagnosed BY NAME off `neverExercised`, per the rule further down: six cards left
and two arrived. **Four of the six are the change working** — UNL-185 Pyke -
Bloodharbor Ripper in all three printings (a Legend never offerable as a card, so
its ability is the only route to it) and VEN-087 Hextech Disc. The rest is
trajectory: VEN-191 Zed is `[Action]`-timed and kept its window, and VEN-066
Temporal Breach and VEN-126 Ki Barrier have no activated ability at all.

**So a red here is now as likely to be noise as regression** — diff
`neverExercised` against those names before believing it. Buying the margin back
by lowering the floor is a call for the project owner: the probe's own note
argues against it in as many words, "a floor that follows a drop downwards stops
being able to catch the next one".

**The observed figure went 798 -> 800 on 2026-08-19 and the pin did NOT move,
deliberately.** The probe PRINTS "bump PINNED_UNION" whenever observed exceeds
the pin; the paragraph further down says the pin sits ~4 BELOW observed on
purpose, because this probe is not deterministic. Those two contradict each
other and the paragraph wins — 796 against 800 is exactly the intended gap.
Reconcile the probe's printed advice with this file rather than acting on it. Its runtime with
Vendetta in the pool has been measured between **292s and 496s on the same
machine**, so treat any single timing as noise unless it is decomposed by
control.

**Read the PER-SET figures, not only the union.** OGN **228**, OGS **21**, SFD
**187**, UNL **204**, VEN **156** — SFD +1, UNL -3 and VEN -2 on 2026-08-24, all
from the ability-timing gate described above. OGN and OGS did not move. **VEN joined `COMPLETE_SETS` on 2026-08-19** —
all five sets are declared, and `everyUnexercisedExplained` now covers the whole
pool.

**UNL moved 205 -> 207 on 2026-08-19 and it is an AI change, not a card change.**
`BASELINE_WEIGHTS.bankAbilities` flipped to true, so `candidateActions` now offers
the `ActivateAbility` candidates that only BANK a resource. Both cards are
**UNL-234 Diana - Scorn of the Moon** (Overnumbered and Signature) — a Legend,
never drawn and never offered, whose only ability is `[Exhaust]: [Add] 1 Energy`.
That flag is the only mechanism in the engine that can exercise her. Decomposed by
control (flag off -> 798/UNL 205, on -> 800/UNL 207), `walkout` unmoved at
190/113/29, win rate exactly 50.0% over 400 games. See `docs/ai-improvement-plan.md`
and the `tune-the-ai` skill.

**The AI now has TWO policies and the probes run the cheaper one.**
`BASELINE_WEIGHTS` is what every figure in this file was measured with;
`HUMAN_OPPONENT_WEIGHTS` adds `ownTurnRollout` (worth 69.5%/58.8% head to head,
~11.8x runtime) and is what `GameBoard.tsx` passes, so **these pins describe the
probe policy, not the opponent a person plays.** The bias runs the safe way — the
stronger policy plays MORE cards and abilities, so a probe on the cheap one
understates a real game, and this is a floor.

**SFD moved for the FIRST time on 2026-08-20, 188 -> 186, and it is not a card
regression.** It had held exactly across twenty-one Vendetta waves. The cause is
the same one `walkout`'s note records: **the ACTION SPACE**, not the rules the
cards implement. Gating an attached Equipment's own `[Equip]` (718.2 — an
attached card's printed Rules Text is Inactive) removed a class of AI action, and
the trajectories that followed reached two fewer SFD cards.

Decomposed by CONTROL, twice, same machine: with the gate OFF, SFD **188** and
union **800**; with it ON, SFD **186** and union **798**, both figures repeating.
The two cards named by diffing `neverExercised` are **SFD-139 Edge of Night** and
**SFD-168 Vanguard Armory**. Only the first is explained by the change — its
`[Equip]` is correctly Inactive once it attaches itself, so the AI's repeated
re-equip is gone. **Vanguard Armory is a plain Gear the gate cannot touch**, and
its ability was verified still offered; it is pure trajectory.

Expect this pin to move for any change that narrows or widens what the AI may
DO, and re-derive it by control exactly as above rather than accepting it.

**A wide DECISION costs this probe far less than the arithmetic suggests, and
that was measured rather than argued.** Fallen Feline offers all 233 spell names
and `legal-actions` fans a pending decision into one action per option, so she
was refused twice on the estimate that the AI would then score 233 states per
play. Decomposed by control, same machine, back to back: **488s without her, 478s
and 496s with** — inside the noise. Over 200 VEN-deck games she named 15 times
across 12 games, 3,495 of 268,742 evaluated actions, **1.30%**. The per-play
arithmetic was right and the conclusion was wrong: nobody had asked how OFTEN the
card gets played. Ask for the frequency before pricing a fan-out. A finished set's figure changing is a displacement in a covering
deck rather than new coverage, and is the thing to explain.

**It was 625 against 692 until 2026-08-16, and that was a stale figure rather
than a low one.** Vendetta landed 178 cards and the pin was never bumped, so a
floor about a 692-card pool was being asserted against a 907-card one with ~79
cards of slack — the whole of Unleashed could have gone dark and it would still
have been green. **Expect to bump it once per Vendetta batch** while the set is
being written; that is new, since the earlier four sets were finished before this
probe existed.

The paragraphs below are the history of the 625-era figure and the reasoning
behind the headroom, which is unchanged:

it was **~290s** at 692 cards (and ~120s before `legal-actions` learned 144.3's group move, and
~244s before UNL-147 Baron Nashor put a THIRD battlefield on the board — the
move fan-out loops over destinations, so a third one widens every turn's action
space. The AI evaluates every action it is offered, so that fan-out's width is
this probe's runtime, and `MAX_GROUPED_MOVERS` is the dial).

A FLOOR, not an equality — it is supposed to rise, and the probe prints a line
asking for the pin to be bumped when it does.

**The pin deliberately sits ~4 BELOW the observed range, and do not "correct" it
upward.** This probe is NOT deterministic: it reshuffles decks per run, which is
what the note below about cards "oscillating on deck reshuffles alone" is
describing. Two runs of the same build on 2026-08-14 gave 629 and then less. A
pin set to the last observed value therefore goes red on a clean tree about half
the time, and each of those gets diagnosed as a card regression by whoever hits
it next — which is the likeliest explanation for how often this figure has been
re-based, including twice on the day this paragraph was written.

So a one-or-two drop is NOISE. Read a real one off `neverExercised` BY NAME
rather than off the total; removing a mechanism moves a whole bucket.

**It dropped for the first time on 2026-08-10, by one, and it was NOT a
regression** — worth knowing because the same shape recurs whenever a card is
finished. `deck-generator` seats cards on `isCardImplemented`, so implementing
one ADDS it to a fixed-size covering deck and DISPLACES another; the displaced
card here (Daisy!, the set's most expensive at 9 Energy + 2 Calm) stopped being
affordable rather than stopping being enumerable, and `GAMES=500` exercised her
again with an EMPTY `drawnNeverOffered`. Diagnose a same-day drop by stashing,
re-running against the old sha and diffing the BUCKETS — the movement, not the
total, is what says which it is.

**It then dropped a SECOND time, the next change, for the same reason**, and a
THIRD on 2026-08-11 — so the rule this file wrote after the second was applied:
**the pin is now re-based at `GAMES=500`, and the default depth is 500.** All
three drops decomposed cleanly (the newly-finished card became reachable; a
displaced card fell to sampling), and all four times `GAMES=500` had an EMPTY
`drawnNeverOffered`. A figure needing a paragraph of explanation every time it
moves is a chore, not a regression detector.

**The re-base changed what the instrument can see, not just its patience.** OGN
went 224/248 → **228/248** at the deeper sample: four OGN cards were never drawn
at 250 and are exercised at 500. It also expired an allowlist entry that had
predicted exactly this — OGN-158 Volibear - Imposing was excused as "priced out
of the format, affordable in 2 states out of 1000 games", which was a claim
about the SAMPLE rather than the card, and twice the games found the states.
**Treat every allowlist excuse as depth-dependent for the same reason.**

**Do not read its buckets from a shallow run.** The depth is load-bearing and was
measured: at `GAMES=40` the same probe reports 101 never-exercised and 8 cards
"the engine never offered", and **7 of those 8 are pure sampling** — Punch First
is offered 59 times once the games are deep enough. The pin and the allowlist are
therefore asserted ONLY at 250; at any other `GAMES` they report but do not gate.

## Do not copy this loop into a handoff

Every SFD/battlefield prompt in `docs/` wrote its own copy, they drifted, and the
copy in front of the session won over the correct one. Handoffs link here.

The same rule applies to any list the engine merges from several sources — the
trigger census was wrong four times, always by hand-copying one of them.

## Citing a rule: use `pdftotext -raw`, NEVER `-layout`

**`-layout` puts the rule numbers in a column that does not line up with their
text, and every wrong citation in this repo came from reading it anyway.** Three
were found in a single day: "rule 1678" (a line number), Frostcoat Cub's "707.2"
(a rule that does not exist, justifying a Might floor that should not exist), and
"rule 2701" (another line number, which I then passed into an agent brief).

**A FOURTH line-number-as-rule surfaced on 2026-08-09** — "2236", cited four times
in `chaos.ts` for "current Might", three of them pre-existing. So this is a
recurring class rather than one bad day, and it keeps being found by whoever next
needs the sentence rather than by any instrument.

`-raw` emits the document in reading order with each number attached to its own
text, and it settles these instantly:

```bash
pdftotext -q -raw "docs/Riftbound Core Rules Updated 2026-07-16.pdf" - | grep -n "the sentence you mean"
```

Measured against it, citations this repo had been carrying:

| claim | was cited as | actually |
|---|---|---|
| a unit "is Mighty" at 5+ Might | 711 *and* 812, in two files | **708** |
| a unit "becomes Mighty" crossing 5 | 715 | **709** |
| "you may pay X. If you do…" is not a cost | 204 | **205** |
| Might below 0 is treated as 0 when referenced | (cited by neighbour) | **143.2.b** |
| a unit's "current Might" | "2236" ×4 in `chaos.ts` — a LINE NUMBER, found 2026-08-09 | **143.2** (plus **432.1**'s worked Shield example) |
| "an ability on the Chain is independent of the card that made it" | **809.1.b** ×3 in `triggers.ts` — which is `[Deflect]`'s FORMATTING rule, "It is formatted as `Deflect [X]`". Found 2026-08-10 | **383.3** ("a Triggered Ability behaves like an Activated Ability and is placed on the Chain") with **377.3.a.1** ("the ability goes on the chain but has no card to represent it") |
| "this-turn effects are fixed amounts" | 317 — the **Ending Phase** | **432.1.a** |
| "tokens cannot exist off the board; a token put elsewhere ceases to exist" | **714/715** in `effect-helpers.ts`, with both sentences quoted VERBATIM and correctly — 714/715 are **Bonus Damage**. Found 2026-08-10 | **186** and **186.1** |
| "each token is its own game object" | 714 in `effects/mind.ts` | **185.1** |
| "a battlefield already scored this turn is not held again" | **471.1.b** in `triggers.ts` — which is the FINAL POINT's restrictions | **470** ("A player may only Score, from either method, once per Battlefield per turn") |
| "a check on something no longer available returns null" | a bare 359.3 | **359.3.e.12** |

## Grep the rules for the CARD NAME before reasoning about a card

**The PDF names 100 cards from this pool by name, in worked examples, and this
repo had never used that.** Everything above is about verifying a citation you
already have; this is how to FIND the sentence, and it is faster and far more
certain than reading a rule and arguing about whether it reaches your card:

```bash
pdftotext -q -raw "docs/Riftbound Core Rules Updated 2026-07-16.pdf" - | grep -n -B3 -A8 "Reckoner's Arena"
```

Six of the seven findings in the 2026-08-23 battlefield sweep came out of a rule
that named the card. Each one had a carefully-reasoned comment in the code taking
the opposite view, and each of those comments was plausible:

| card | rule that names it | what the engine had reasoned instead |
|---|---|---|
| Reckoner's Arena | **383.4.g.1** — an activated conquer effect "is placed on the chain as if it had just triggered", and non-conquer conditions ARE checked | "the Arena is one triggered ability… the same way a spell that kills three units is one chain item", and "nothing here triggered, so there is no trigger condition to test" |
| Sigil of the Storm | **355.10.f** quotes its sentence verbatim — "'You must recycle one of your runes' doesn't target anything. **You choose from among your runes as the spell or ability resolves**" | the printed "(This doesn't choose anything.)" meant no selection, so pool order |
| Void Gate | **715.4.a** — bonus damage is in the total before Prevent | correct, but justified as "structural rather than chosen" |
| Targon's Peak | **355.5.b** — choices are made when the delayed trigger finalizes | `readyRunes` picks in pool order and calls it a non-decision |
| Navori Fighting Pit | **438.1.a** — a player orders a Legend's conquer effect against the battlefield's | "this engine fixes the order", which had stopped being true |
| Wraith of Echoes | **383.1.b** — "that ability hasn't triggered yet this turn", and simultaneous instances "trigger only once" | cited AS the precedent for the opposite reading, on The Dreaming Tree |

**Two of the brief's blocked divergences are on that list.** `Last Stand`
(432.1's worked example) was already known; **`Smoke and Mirrors` is answered
outright by 811.1.d.2.a**, which names it and rules that the second unit "can be
chosen from any location" — so the rules half of that row is settled and only the
`unitSlots` field is still missing.

The full list is worth regenerating rather than transcribing — match every
`name` in `src/cards/*.json` against the `-raw` dump. Cards on it with open
readings today include Deathgrip, Hidden Blade, Eager Apprentice, Sky Splitter,
Ezreal - Prodigy, Sona - Harmonious, Baron Nashor, Baited Hook, Promising Future,
Immortal Phoenix, Hostile Takeover, Counter Strike, Lotus Trap and Time Warp.

The current PDF is downloadable from Riot's CDN — the project owner supplied
`https://cmsassets.rgpub.io/sanity/files/dsfx7636/news_live/e9ac8e3d33e0f78cef296f5945aba7bc1313b086.pdf`.
**Cite by neighbour only when `-raw` genuinely cannot resolve it**, which is now
rare. The one scope doc that hedged this way was tightened on 2026-08-09 and
`-raw` resolved every claim in it exactly (XP **728–733**, `[Hunt]` **823**,
`[Level]` **824**) — so treat a surviving "cited by neighbour" as a to-do, not as
a limit of the tooling.

**And the swapped-subrule failure is the one `-raw` does NOT catch.** Found
2026-08-09 by a wave-2 agent: **72 comments in `src/` cite `355.9.b` for "a bare
noun includes units in base".** That is the wrong half. `355.9.a.1` is the
WIDENING — "'Unit,' 'gear,' and 'rune' refer to objects on the Board unless
specified otherwise" — while `355.9.b` is the NARROWING, "It meets all targeting
restrictions", which is what makes a printed "at a battlefield" load-bearing.
Both sub-rules are real and both matter, which is exactly why this survived: the
citation resolves to a genuine sentence, just not the one being relied on. When
checking a number, read the sentence it lands on and confirm it says the thing
the comment claims — a number that resolves is not yet a number that is right.

**It happened again a week later, in a different shape.** Nine comments cited
**828** for "Locations include the Battlefields and the Bases". 828 is
`[Empowered]`; the sentence they were quoting is **198.1**, verbatim. Corrected
2026-08-09, found by a wave-4 agent working nearby — the same way the 355.9 swap
was found, and the same way the next one will be.

So this class has now produced two multi-site sweeps and four line-numbers-as-
rules. Nothing in the repo can detect it: the number resolves, the prose reads
plausibly, and the compiler has no opinion. Treat a citation you did not
personally read against `-raw` as unverified, however confident the comment
around it sounds.

## THERE ARE TWO PDFs, and the Tournament one silently EATS f-ligatures

`docs/Riftbound Tournament Rules.pdf` (added 2026-08-23) is the second source,
and **104.1 makes it take precedence over the Core Rules for competitions**: "In
some cases, information in this document may contradict, or provide information
not contained in, the Riftbound Core Rules. In all such cases, this document
takes precedence." So a Core Rules answer is not automatically the final answer —
check whether the Tournament document speaks to it.

**Every f-ligature is DROPPED from its `-raw` extraction, with nothing left
behind — not even the letters.** Measured across the whole document:

| you search for | hits | what is actually in the text |
|---|---|---|
| `first` | **0** | `rst` (27) |
| `official` / `officials` | **0** | `ocial` (25) / `ocials` (18) |
| `effect` / `effects` | **0** | `eect` (2) / `eects` (2) |
| `defined` / `definition` | **0** | `dened` (21) / `denition` |
| `shuffle` / `shuffling` | **0** | `shue` (12) / `shuing` (9) |
| `different` / `difficult` / `final` / `finish` | **0** | `dierent` (13) / `dicult` / `nal` (11) / `nish` |

**A grep for "first player" in that document returns nothing, and the rule
exists.** That is how this was nearly missed: 407 is the *Play First Rule* and
none of the words "Play First" survive as typed. `-enc UTF-8` does not help; the
glyphs are absent rather than mis-encoded, leaving a bare space. **The Core Rules
PDF is NOT affected** — `first` appears 87 times there — so this is a property of
the one file, not of the tooling.

**How to search it:** drop the ligature from your search term too (`rst`,
`ocial`, `eect`, `nal`), or grep a fragment that contains no f-ligature at all
and read around the hit. When quoting from it into a comment or a doc, restore
the letters by hand and say you did.

## The CARD DATA mojibakes em-dashes, in OGN and OGS only

`ogn.json` carries **102 of them on 96 lines** and `ogs.json` **3** — the byte
sequence U+00E2 U+0080 U+0094, an em-dash's UTF-8 bytes decoded as Latin-1 —
while `sfd/unl/ven.json` carry a clean **U+2014** (90 / 39 / 42). It is in the
source JSON, not introduced by `card-loader`. Six more OGN entries carry
U+00E2 U+0080 U+0099, the same damage done to a right single quote.

**It reads as a per-SET finding, which is what makes it dangerous.** Found
2026-08-24 while classifying activated-ability speed keywords: OGN, OGS and SFD
all print `[Exhaust]: [Reaction] — [Add] ...`, and a predicate matching the real
dash kept the four SFD cards and dropped all ten OGN/OGS ones. That looks exactly
like "the older sets don't print this keyword" and it is an encoding bug. Ten
abilities — every rune Seal, Energy Conduit, Kai'Sa, Darius, Lux - Crownguard and
Malzahar — would have been silently demoted to Default speed.

Match both, or normalise before matching. The three characters are literal in
the file, so quoting them into a shell is what goes wrong. Write the escapes and
let node resolve them — this prints 102:

```bash
node -e "const t=require('fs').readFileSync('packages/engine/src/cards/ogn.json','utf8');
console.log((t.match(/\u00e2\u0080\u0094/g)||[]).length)"
```

In a regex the alternation is `/(?:\u2014|\u00e2\u0080\u0094)/`, and
`ability-timing.test.ts` uses exactly that. It is the difference between finding
39 of the pool's speed-tagged abilities and finding 20.

## Measure before planning

It has changed the plan every single time. Ask the instruments, not the notes:

- `coverage.coverageBySet` / `isCardImplemented` for what is actually written.
- `docs/rules-conformance.md` for what is written but DIVERGENT — 350+ rows, and
  "complete" means every card has an implementation, not that every card does
  what it prints.
- `probes/exercised.ts` for what is reachable in play, which is not the same as
  implemented.

**Notes about this codebase's own mechanisms have been wrong or stale ten times
out of eleven.** Every "needs subsystem X" note that was re-read against the code
turned out to be one field, one function, or already built for another card.
Re-read the code before believing any note, including a handoff's and including
this file's.

## Recording a divergence

A divergence recorded only in a commit message is lost. Write it into
`docs/rules-conformance.md` in the same change, and PIN it with a test that
asserts the wrong answer where the gap is reachable — so closing it fails loudly
instead of silently changing behaviour nobody was watching.

## Tests whose premise was that something was unfinished

Finishing a card, or a set, breaks them. **Fix the PREMISE, never weaken the
assertion**, and prefer rewriting the check so it cannot flip again: assert the
invariant (a filter PARTITIONS the pool) and prove the "it does something" half
on a SYNTHETIC subject that cannot be implemented out from under it.
`set-coverage.test.ts`, `coverage-drift.test.ts` and `card-filters.test.ts` all
do this now, each after flipping at least once.

## Editing source

Never bulk-edit with PowerShell — it mojibakes every em-dash and adds a BOM. Use
the Edit tool, or a Python round-trip with explicit `utf-8` and `newline=""`;
the repo is CRLF, so a multi-line search string joined with `\n` silently will
not match. `assert` every replacement landed.

Back a file up to the scratchpad before mutation-testing: `git checkout <file>`
on a file that has only been written, never committed, destroys the work.

**A mutation that does not fail has proved nothing — and check it APPLIED.**
Grep for the marker before believing a green mutation run.
