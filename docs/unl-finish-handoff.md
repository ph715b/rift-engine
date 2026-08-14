# Finishing Unleashed — the last 18

Paste-in brief for a fresh session. Written 2026-08-13 at `0a8a9b4`, branch
`feat/unleashed-xp`. **Block 1 was worked on 2026-08-13 and this file was
updated in place** — see that section for what landed, what it cost, and the two
things the block taught that generalise beyond it.

**The verification loop is in `CLAUDE.md` and is NOT restated here.** Six prior
handoffs in this folder each wrote their own copy, they drifted, and the copy in
front of the session beat the correct one. Read it there.

## Before trusting a word of this file

Every card list below was measured from `dist` on 2026-08-13, and the measuring
corrected two things the previous session believed out loud. Re-measure:

```bash
npm run build --workspace=@rift-engine/engine
# then, against dist: defaultCardRegistry() + isCardImplemented + partialImplementationNote
```

Dedup by card NAME, not id — every UNL Legend is printed 3× and the alias
printings carry different names (`Jhin - Virtuoso (Overnumbered)`, `(Signature)`,
`Baron Nashor (Ultimate)`). Counting ids gives 29 for the same 24 cards.

## What actually remains

**As first written: 24 cards, 9 triaged and 15 untouched.** Block 1 finished
three; Maduli, Poppy and Crescent Guardian made six, so **18 remain**: **7
triaged** (a `partialImplementationNote` names the precise shared-file edit) and
**11 untouched**.

The untouched group is no longer unread — see Block 5, which triages every one.
It was never "ordinary card work" as a group: **two of the three it called
"likely small" have since landed** (Poppy, Crescent Guardian) at roughly the
predicted cost, and three of the rest are systemic.

Re-measured 2026-08-13 after Block 1 and Maduli: **25 unimplemented UNL ids = 20
distinct cards** once the alias printings are folded.

### Block 1 — replaced costs — **DONE 2026-08-13 (3 of 4; the 4th is refused)**

Landed as `engine/replaced-costs.ts`. **Rule 356.1.a is the sentence**: "if an
ability or instruction allows you to play a card 'for [Cost]', replace the card's
Base Costs with [Cost]" — so it is the sibling of the existing `ignoresBaseCost`
(356.1.b), not a discount. Tests: `test/replaced-costs.test.ts`.

| card | outcome |
|---|---|
| UNL-089 Jhin - Meticulous Killer | **done** — printed table; needed NO new state (`maxSpellEnergySpentThisTurn` already existed for UNL-004) |
| UNL-025 Undying Legion | **done** — printed table; his trash price is DEARER than his print, which is what proves this is a replacement and not a discount |
| UNL-186 Death from Below | **done** — the GRANTED form, `PlayerState.replacedCostPlays`, keyed by instanceId and spent by use |
| UNL-020 Dancing Grenade | **still refused, for a NEW reason** — see below |

**Two of the four needed no new state at all**, against a prediction that all
four would. Both conditions were already recorded facts. Re-read the code before
believing any note, including this one.

**Dancing Grenade's blocker is not the one that was written.** Its replaced cost
now exists; what blocks it is that "ITS controller may play this spell again"
grants to the DAMAGED unit's controller, and the permission workaround for
419.3.b only reaches the ACTIVE player — `mayPlayCardNow` opens with
`playerIndex !== actingPlayerIndex(state)`, the card is Default-timed, and the
grant clears at `runEnd`. A `fromPlayerIndex` field was built for it and REMOVED
the same day when mutation testing showed it unreachable against all 4748 tests.

**There are THREE cost sites, not two**: `legal-actions`, `validate-play-card`
and **`execute-play-card`**, which re-prices from raw cost to decide floating
spend. All three now swap the base through `replacedCostFor`. Missing the third
shipped a real bug this month (recorded against Irelia - Graceful in
`rules-conformance.md`) — it was found by an agent, not by the suite.

**Two things this block taught that the rest of the set will hit:**

- **A replaced cost must ride the VARIANT loop in `legal-actions`, not sit beside
  it.** A standalone `actions.push` produced a base play and silently withheld
  every battlefield the card could be reinforced to. Carry the flag on the
  variant and `...variant` spreads it onto each destination.
- **`isCardImplemented` and "seated in a generated deck" are DIFFERENT
  questions**, and a `partialImplementationNote` silently separates them: a
  half-written card reports DONE to coverage and is invisible to `reachability`.
  Retiring UNL-186's note moved the pin by two for one card. Expect that whenever
  a half-card is finished.

### Block 2 — multi-instance `[Repeat]` — **ONE card, not two**

**UNL-182 Curtain Call. UNL-146 Syndra - Transcendent does NOT belong here** —
corrected 2026-08-13 by reading her printed text, which this file and the
project-status memory had both been paraphrasing from the block title:

> "While I'm in a showdown, your spells have [Repeat] :rb_energy_2::rb_rune_chaos:."

She GRANTS a Repeat to other spells. She has no multiple instances of her own,
and `RepeatCostSpec` expressing one instance does not block her. The
granted-Repeat machinery already exists and is already fanned out in
`legal-actions` (`grantedRepeatCostOf`, `action.grantedRepeatPaid`, crossed with
the printed instance). Two things separate her from Temporal Portal, which uses
it today:

- `grantedRepeatCostOf` prices the grant at **the spell's own cost** (Temporal
  Portal's "repeat it, paying its cost again"); hers is a FIXED `[2][Chaos]`.
- It is gated on a COUNTER (`nextSpellRepeatGrants`); hers is a continuous,
  positional condition — while she is in a showdown.

**Measured further on 2026-08-13, and she is NOT cheap after all** — the
correction above stands (she is not multi-instance) but the replacement
conclusion was wrong. Her real blocker is that **her pip is in a domain the
card does not print**:

- `RepeatCostSpec.domain` is DEAD DATA — grep it; neither pricing site reads
  it. Both fold the repeat's Power into `card.powerCost` and pay the total in
  `card.powerDomain`. That works only because all fourteen printed Repeats
  are in their own card's domain.
- She grants `[2][Chaos]` to **"your spells"**, so beside a Fury spell the
  play owes a Fury pip AND a Chaos pip. `RunePayment` has three buckets —
  `energyRunes`, domain-checked `powerRunes`, any-domain `rainbowRunes` — and
  none is "a pip in another named domain".
- Folding it into `powerRunes` refuses legal plays; routing it through
  `rainbowRunes` accepts any rune for a Chaos pip.

So she needs a FOURTH payment bucket mirroring `rainbowRunes` — 17 sites
across 10 files. The tractable subset (spells with no printed pip, plus Chaos
spells) is a coverage LIE: it reports her DONE while silently withholding the
grant everywhere else. Refused, with the full note at `effects/chaos.ts`.

`RepeatCostSpec` expresses exactly one instance and its own comment says so.
Curtain Call needs: a LIST payable individually, the action carrying WHICH
instances were paid rather than a boolean, and a per-EXECUTION mode re-choice
(`modeId` is currently chosen once per action), plus "choose one you haven't
already chosen" ACROSS executions.

**The rulings are settled — do not re-derive them.** 820.3, 820.1.c.2,
820.1.c.3, 820.2.a, 820.3.a, all in `docs/rules-conformance.md`. The project
owner confirmed a Repeat may be used more than once.

`UNL-017 Square Up` already landed a Repeat priced in CARDS — read
`test/square-up-repeat-discard.test.ts` first; it documents the seam and says
explicitly where it stops short of this block.

### Block 3 — death and damage modification (2 cards)

- **UNL-007 Smite** — "if it would die this turn, banish it instead": a turn-long
  death REPLACEMENT. Needs a `GameState` list, a `killUnit` branch, a `runEnd`
  sweep.
- **UNL-118 Elder Dragon** — "any amount of your damage kills": 142.4.c needs
  per-marker damage attribution, and `UnitInstance.damage` is one unattributed
  number. Plus a Lethal Damage override.

Adjacent, not identical — don't merge them into one edit.

### Block 4 — narrow singles, each already named

- **UNL-144 Maduli** — **DONE 2026-08-13.** `board-restrictions.unitMayBeReadied`,
  asked at THREE sites: `runAwaken`'s two inline maps, `readyUnit`, and the
  `awakened` capture that raises `unitReadied` events (a unit that stayed down
  must not announce a readying). **315.1.b.1 is the rule and it had the answer
  all along** — "the Turn Player readies all Game Objects they control *that are
  able to be readied*". Both divergence pins flipped red on the first root run,
  which is what they were for.
- **UNL-188 Hextech Gauntlets** — `[Equip]` cost reduced by the chosen unit's
  Might. `equipAbilities` builds one static `ActivationCost` per gear; no
  activation cost can depend on the chosen target.
- **UNL-140 Conscription** — the XP-cost mechanism EXISTS (`OPTIONAL_XP_COSTS`).
  The real blocker is that optional costs fan out INSIDE the target loop, so a
  paid variant still carries the 3-Might-capped target and sells the XP for
  nothing. A targeting seam, not an XP seam.

### Block 5 — READ 2026-08-13, and they are not one group

All 13 were measured from the registry (printed text, cost, keywords) and each
was checked against the mechanism it would need. **They split three ways, and the
top group is much cheaper than "untouched, no note" suggests.** This is a triage,
not an implementation plan — re-read the code before believing any line of it.

**Likely small — an existing seam takes them:**

| card | text | the seam |
|---|---|---|
| UNL-178 Poppy | **DONE 2026-08-13.** The table row grew an `energyDiscount` read at all three cost sites, and the XP became a variant DIMENSION — which also fixed a pre-existing gap where a Unit's XP variant reached base and no battlefield. |
| UNL-117 Arachnoid Horror (first clause) | "I can be played to an occupied battlefield if an enemy unit is alone there" | one `PLACEMENT_GRANTS` row + one predicate, beside `openBattlefield` / `occupiedEnemyBattlefield`. **His SECOND clause is the bigger half** — it grants the same to ALL friendly units, which is board-conditional and belongs with Miss Fortune - Buccaneer's `inPlayFor` shape, not in the per-card table. |
| UNL-122 Crescent Guardian | **DONE 2026-08-13.** `spellsPlayedThisTurn` (the ninth spell-named field; the census test that flipped is kept), a `condition` on the cost table so the OFFER itself is gated, and `deploy.unitEntersReady` for the payout — a replacement (369.3), not a trigger. |

**Medium — a real but bounded new mechanism:**

- **UNL-013 Lotus Trap** — "double all damage that would be dealt to it this
  turn". A per-UNIT, this-turn damage multiplier; `damage-modifiers.ts` is the
  home and `dealDamage` already routes through it, but combat ASSIGNMENT is a
  second reader.
- **UNL-074 Frigid Jewel** — "when you draw your SECOND card each turn". Needs a
  per-turn draw counter and a trigger on the boundary, not on every draw.
- **UNL-106 Repulse** — a counter with a targeting CONDITION ("chooses it and no
  other friendly unit"). `counter-spell.ts` exists; the condition needs the chain
  item's chosen set.
- **UNL-045 Forgotten Signpost** — an activated ability whose cost is "exhaust a
  unit you control" AND self-exhaust, whose effect then reads WHICH unit paid.
  `sacrificedUnitsBattlefield` is the nearest precedent for a cost-unit-dependent
  effect.
- **UNL-163 Mageseeker Investigator** — taxes moving MULTIPLE units to her
  battlefield at once. Check first whether the engine has a simultaneous
  multi-unit move at all; if it does not, the card is near-inert and should be
  refused rather than approximated.
- **UNL-169 Ashe - Focused** — banish a card from a revealed hand, return it when
  they hold. A delayed trigger with per-instance memory across zones.

**Systemic — refuse, or scope on purpose:**

- **UNL-195 Ivern - Green Father** — "replace that battlefield with a Brush
  battlefield token". **The same blocker as Baron Nashor**, which is already
  recorded as systemic: nothing in this engine can add or replace a battlefield,
  `battlefieldPair` builds exactly two at setup with ids stable for the game.
  Two cards now want it, which is the argument for scoping it deliberately rather
  than refusing it twice.
- **UNL-181 Jhin - Virtuoso** — a Legend needing a "banished with me" zone and a
  four-card threshold. The energy-spent figure it also needs now EXISTS
  (`SpellChainEntry.energySpent`, added in wave 8), so that half is no longer a
  blocker — the zone is.
- **UNL-138 The List** — "name a tag". `parkDecision` could carry the choice; the
  question is whether an option set of every tag in the pool is acceptable.

### Block 5 — the original list (13, was 15)

UNL-013 Lotus Trap, UNL-045 Forgotten Signpost, UNL-074 Frigid Jewel, UNL-106
Repulse, UNL-117 Arachnoid Horror, UNL-122 Crescent Guardian, UNL-138 The List,
UNL-163 Mageseeker Investigator, UNL-169 Ashe - Focused, UNL-178 Poppy, UNL-181
Jhin - Virtuoso, UNL-195 Ivern - Green Father (+ UNL-146 listed above).

**UNL-025 and UNL-089 left this list on 2026-08-13** — both turned out to be
cards whose entire printed text is a PRICE, which is why neither had an effect to
write and neither needed new state. Worth knowing before reading the remaining
thirteen: "untouched, no note" does not mean "big".

Known from earlier waves: **Crescent Guardian** wants a "played a spell this
turn" counter — and `cannotPlaySpellsThisTurn`, added 2026-08-13, does **NOT**
close it: a BAN is what a player may do, not a record of what they have done.
`test/unl-chaos-wave8-refusals.test.ts` pins this. **Ashe** belongs with the
delayed-trigger family.

### Genuinely blocked (1)

**UNL-147 Baron Nashor** — "add the Baron Pit battlefield token to the board" is
SYSTEMIC: nothing in this engine can add a battlefield at all, `battlefieldPair`
builds exactly two at setup with ids stable for the game, and the Pit has no card
data in `unl.json`. Its other two clauses work. Leave it, or scope it on purpose.

## Traps that have each cost real time

- **A finished card breaks tests whose premise was that it was unfinished** —
  4–9 per batch, in files you did not touch. Fix the PREMISE, never weaken the
  assertion.
- **Adding a required `GameState`/`PlayerState` field breaks ~11 files** that
  build their own state literals — including `packages/web/src/game-setup.ts` and
  `probes/harness.ts`. Expect ~35 red tests, then ~7.
- **vitest does not typecheck.** Tests pass green while `npm run typecheck` is
  red. Union-narrow `CardDefinition`, `ChainEntry`, `CardInstance`.
- **Rule 164.2**: recycling a READY rune for Power credits 1 floating Energy
  back, which masks discount bugs. Measure the DIFFERENCE between variants.
- **Rule 466 step 3c** heals every unit at end of combat — read combat through
  DEATHS, not through remaining damage.
- **`pdftotext -q -raw`, never `-layout`.** A hook denies `-layout`. Four
  line-numbers-cited-as-rules got into this repo from reading the layout column.
  A number that RESOLVES is not yet a number that is RIGHT — read the sentence.
- **CRLF repo.** Agent-authored files are LF; `\r\r\n` is invisible to the
  compiler, the tests and `git diff`. Never bulk-edit with PowerShell.
- **A `reachability` drop is not automatically sampling.** Read
  `drawnNeverOffered` before re-pinning. 2026-08-13's was Stalking Wolf, whose
  MANDATORY additional cost made him unplayable once seating displaced his
  enablers from a fixed-size covering deck.

## Skills

`/implement-card` carries the ordered cycle and the fixture traps.
`/mutation-test` carries the ritual and the three readings of a surviving mutant.
Both were written from failures that actually happened here. **A mutation that
does not fail has proved nothing — grep for the marker to confirm it applied.**

## Delete this file when the set is done

The six older prompts in `docs/` should have been. They are ~180KB of drifted
instructions that outlived their work.
