# Finishing Unleashed — the last 21

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
three, so **21 remain** — 7 triaged (a `partialImplementationNote` names the
precise shared-file edit) and 14 untouched, with no note and mostly zero mentions
in `src/`. That second group is ordinary card work, not blocked work; it just has
no handoff and needs the printed text read first.

Re-measured 2026-08-13 after Block 1: **26 unimplemented UNL ids = 21 distinct
cards** once the alias printings are folded.

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

### Block 2 — multi-instance `[Repeat]` (2 cards)

UNL-182 Curtain Call, UNL-146 Syndra - Transcendent.

`RepeatCostSpec` expresses exactly one instance and its own comment says so.
Needs: a LIST payable individually, the action carrying WHICH instances were paid
rather than a boolean, and a per-EXECUTION mode re-choice (`modeId` is currently
chosen once per action). Curtain Call additionally enforces "choose one you
haven't already chosen" ACROSS executions.

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

- **UNL-144 Maduli** — "I can't be readied". `runAwaken` readies by an inline
  map; `readyUnit`'s only lock is per-player. **He is currently STRONGER than
  printed**, so this one is a live divergence, not just an absence.
- **UNL-188 Hextech Gauntlets** — `[Equip]` cost reduced by the chosen unit's
  Might. `equipAbilities` builds one static `ActivationCost` per gear; no
  activation cost can depend on the chosen target.
- **UNL-140 Conscription** — the XP-cost mechanism EXISTS (`OPTIONAL_XP_COSTS`).
  The real blocker is that optional costs fan out INSIDE the target loop, so a
  paid variant still carries the 3-Might-capped target and sells the XP for
  nothing. A targeting seam, not an XP seam.

### Block 5 — untouched, no notes (13, was 15)

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
