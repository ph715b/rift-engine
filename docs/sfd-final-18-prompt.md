# SFD — the final 18 (SUPERSEDED)

> **SUPERSEDED 2026-08-07 by `docs/sfd-final-11-prompt.md`.**
>
> The (A)/(B) question below is ANSWERED: the human chose **(A) — finish all 18
> and hard-gate SFD**. Seven of the eighteen are done (SFD-150, 175, 011, 042,
> 073, 050, 024) and the set is at **187/198**, so every count in this file is
> stale by construction.
>
> Two of its five "recommended NOT to do" cards were **mis-priced** and are now
> written: Brutalizer needed one flag at one site, and `tags` was never
> printed-only. Read the new file for what is actually left.


**This is the prompt for the session that finishes Spiritforged.** It supersedes
`docs/sfd-continuation-prompt.md`, whose six phases are done and whose numbers
are stale by construction.

Written 2026-08-07 at `ce09875`, and **every figure below was measured at that
commit, not carried forward**. Re-measure anyway before planning. This repo's
handoffs have gone stale faster than they have gone wrong, and a stale number has
changed the plan every time it was believed — including twice in the session that
wrote this one.

## Read first, in this order

1. `docs/rules-conformance.md` — the Divergent and Verified tables, and the Log's
   top ~20 entries, which are all from the previous session and are where the
   traps below are recorded in full.
2. `docs/Riftbound Core Rules Updated 2026-07-16.pdf` — the authority. Extract it
   to text once and grep it; it repeatedly uses the card in question as its own
   worked example.
3. `docs/sfd-equipment-abilities.md` — the art-only transcriptions. Nothing in it
   is in the card JSON, and re-deriving it costs 31 image fetches.
4. The memory index at `~/.claude/projects/a--Projects-Rift-Engine/memory/`.

## Measured state at `ce09875`

| | |
|---|---|
| OGN | **248/248** (complete, hard-gated) |
| OGS | **22/22** (complete, hard-gated) |
| SFD cards | **180/198** |
| SFD battlefields | 15/15 — complete and hard-gated |
| SFD legends | 12/12 — complete |

Engine **2942 tests across 180 files**, web 100. Typecheck 0 errors across both
workspaces, both builds green, all five probes green with walkout pinned at
**191/107/32**, `DECKS=sfd` 0 invalid.

## READ THIS FIRST — the definition of done contains a contradiction

The old prompt said two things that cannot both be true:

> - The five NOT-to-do cards are the only ones left, and `docs/rules-conformance.md` records why.
> - When SFD's cards are complete, add `"SFD"` to `coverage.COMPLETE_SETS`.

**`isCardImplemented` returns FALSE for any card carrying a
`PARTIALLY_IMPLEMENTED` note** (coverage.ts, checked before the registry lookup —
"a card whose registration covers only some of its text is NOT implemented").
`coverageBySet` counts those as unimplemented, and `finishedButUndeclared` only
fires at 198/198. So **while any partial note remains, SFD cannot be declared
complete and the gate will never protect it.**

That is a decision for the human, not for you. Ask it early:

- **(A) Finish all 18**, including the five the old plan recommended against, and
  declare SFD in `COMPLETE_SETS`. Costs five subsystems nobody has priced.
- **(B) Finish the 13, leave the five**, and accept SFD sits permanently at
  193/198 with no hard gate. Record it in `docs/rules-conformance.md` as the
  deliberate end state.

Do not silently pick one. Everything below is written for **(B)** because that is
what the previous plan recommended, and it flags where (A) would differ.

## The 18, measured mechanically

Checked against `isCardImplemented` / `partialImplementationNote`, not by eye —
the last plan's first draft silently dropped six cards doing it by eye.

### Ten fully open (no note)

| Card | Needs | The DOOR |
|---|---|---|
| **SFD-011 Angle Shot** — choose a unit and an Equipment with the same controller; attach OR detach; draw 1 | a two-target attach/detach spec with a MODE | `unitSlots` can't hold a gear; `AbilityMode.attachesEquipment` is the shape, but this is a SPELL. Probably a `unitOrGear` second slot plus `modeId`. |
| **SFD-018 Void Hatchling** — if you would reveal cards from a deck, look at the top card first; you may recycle it | a reveal hook | `top-of-deck.ts` is the neighbour. Find every reveal site first — this replaces a step, so a missed site is silent. |
| **SFD-024 Rell - Magnetic** — when I attack, play an Equipment ≤[2] from hand ignoring its cost, then attach it to me | a play-from-hand-free + attach, on an ATTACK trigger | `playCardIgnoringCost` + `attachEquipment`; the trigger is `combatBegan` with `isAttackingAt`. Closest existing card: Jayce (SFD-084) for the free gear play. |
| **SFD-079 Bard - Mercurial** — exhaust your LEGEND as an additional cost; if you did, move ANY NUMBER of your units to an open battlefield | a legend-exhaust cost kind + a multi-unit move | `OPTIONAL_UNIT_COSTS` gained gear kinds this session (`costNamesGear`); a `exhaustLegend` kind is the same shape and needs no id field. The move is the hard half. |
| **SFD-109 Akshan - Mischievous** — his `[Body][Body]` half already works; move an enemy gear to your base, control it until I leave the board | control that EXPIRES on a condition | `takeControlOfUnit` is permanent and has no expiry, and this is GEAR control, which has no helper at all. |
| **SFD-146 Vex - Cheerless** — while I'm IN COMBAT, friendly spells cost [1][rainbow] less (min [1]), enemy spells cost [1][rainbow] more | an ASYMMETRIC cost aura conditioned on combat | `modifiedEnergyCost` + the Power term. Both halves at all three cost sites; see `scaledPowerDiscount` (added this session) for the two-axis pattern. |
| **SFD-168 Vanguard Armory** — [Exhaust]: play three Recruit tokens, "you may play them to different locations" | a per-token destination axis | `placeRecruitToken` takes one destination. The enumeration is the problem, not the placement. |
| **SFD-184 Relentless Pursuit** — move a friendly unit, may attach an Equipment, and grant it a delayed "when I conquer, you may move me to my base" this turn | a GRANTED delayed ability on a unit | Nothing grants a triggered ability to a unit for a turn. `keywordsThisTurn` is the nearest shape and holds keywords, not abilities. |
| **SFD-198 Arise!** — a Sand Soldier per Equipment you control, then ready up to two of them | multi-destination placement + a bounded ready | Shares Vanguard Armory's axis. `SAND_SOLDIER_TOKEN` already exists in token.ts. |
| **SFD-202 Hostile Takeover** — take control of an enemy unit at a battlefield, ready it, lose control and recall it at end of turn | mid-combat control + a scheduled end-of-turn reversal | `takeControlOfUnit` exists; the REVERSAL does not. Its parenthetical ("start a combat if other enemies are there, otherwise conquer") is the part to read the rules on. |

### Three partial, each note naming missing CARD TEXT

These are honest partials — the note names text, not engine — but under the gate
they still count as unimplemented. Finish them for (A); leave them for (B).

- **SFD-050 Azir - Ascendant** — "the swap works; 'if it's equipped, you may
  attach one of its Equipment to me' is unwritten". Needs an attach axis on the
  ACTIVATION, not a resolver line.
- **SFD-150 Last Rites** — "its art-only 'when I conquer or hold, you may play a
  unit from your trash (still paying costs)' is unwritten; the `[Equip]` cost is
  whole". **Read the note below about this one — it is the highest-leverage card
  left.**
- **SFD-175 Undertitan** — "the on-play pump works; 'As I'm revealed from your
  deck, [Add] 2 Energy' needs a reveal-from-deck hook". Shares Void Hatchling's
  mechanism, so do them together.

### Five recommended NOT to do

Each needs a subsystem out of proportion to one card, and each already carries a
note saying so: **SFD-030 Skyfall of Areion** (a moment-rewriting layer),
**SFD-042 Brutalizer** (a per-attachment turn stamp), **SFD-059 Svellsongur**
(text copying), **SFD-073 Experimental Hexplate** (a granted TAG; `tags` is
printed-only and five auras read it), **SFD-090 The Zero Drive** (banish-with-
source tracking).

## Two cards that unlock others — do these first

**Last Rites (SFD-150) is worth more than one card.** Its art half is "play a unit
from your trash, **still paying costs**". If that is written it becomes the
engine's FIRST full-cost play from a non-hand zone — which is the exact condition
that currently makes three already-written cards inert: Void Drone (SFD-010) and
Drag Under (SFD-164) discount "[2] less to play from anywhere other than your
hand", and Rek'Sai - Breacher (SFD-029) grants `[Accelerate]` on the same
condition. All three rules are written and correct and pay out today only through
the Champion Zone. See the Log entry of 2026-08-07 on Phase 3's premise.

**Void Hatchling (SFD-018) and Undertitan (SFD-175) share one hook.** Build the
reveal hook once.

## Traps that actually bit, in the session that got here

Every one of these cost real time. They are ordered by how silent they are.

1. **A card can WORK and report unimplemented.** Coverage asks which MODULE
   claims a defId. If you write a card and the count does not move, the module
   has not claimed it — add it to the right `*DefIds()`. (Lucian - Purifier, then
   Jax - Unmatched, twice before this session.)
2. **A card can be CLAIMED and do half its text.** The mirror failure. Ezreal -
   Prodigy reported implemented for a few minutes while his on-play half was
   unwritten, because a cost-modifier claim landed first. Registration is per
   defId; `PARTIALLY_IMPLEMENTED` is the only thing that says otherwise.
3. **The bracket false positive — FIVE instances now.** `KW_PATTERN` cannot tell
   a keyword inside a sentence from a keyword line. Ancient Warmonger had a
   printed `[Assault 1]` that `Math.max` made a FLOOR under his computed value;
   Sivir - Mercenary had a free `[Ganking]` all game. Strip per-KEYWORD via
   `GRANTED_ONLY_KEYWORDS` — `CONDITIONAL_KEYWORD_DEF_IDS` returns `{}` and takes
   the card's real keywords with it. **Any new card whose text mentions a keyword
   in a condition needs this check.**
4. **The probes import `@rift-engine/engine`, which resolves to `dist`.** A source
   fix that appears not to work has probably just not been rebuilt. Rebuild
   before running any probe.
5. **Two `GameState` init sites live outside the engine's fixtures** —
   `packages/web/src/game-setup.ts` and `probes/harness.ts`. Adding a required
   field left both broken with 2919 tests GREEN, because every test builds state
   through `test/fixtures.makeState`. Only the cross-workspace typecheck sees it.
6. **A test that hands a trigger its own precondition tests the trigger, not the
   wiring.** Yone's first four tests synthesized `battlefieldConquered` with
   `wasUncontrolled: true` set by hand; hardcoding the CAPTURE site to `false`
   left all four green. Drive the real path for anything the engine has to
   capture.
7. **A one-option decision auto-resolves.** `advanceDecisions` answers a question
   with a single option without asking, so `pendingDecision(state)` is
   `undefined` — which reads identically to "the trigger never fired". Assert on
   the BOARD, or give the fixture a real choice. This bit three times.
8. **`killUnit` detaches Equipment BEFORE any death replacement runs.** A
   live-board lookup for "what was this wearing" finds nothing. Use the
   `wornEquipment` list captured a line earlier — that is what it is for.
9. **Line endings differ per file.** The repo is mostly CRLF but many source
   files are LF. A python round-trip must detect the file's own ending and
   `assert` every replacement — an unasserted `str.replace` that matches nothing
   is silent, and several did.
10. **The `[Equip]` grammar's real blocker was an EM DASH** (U+2014), not the
    regex. Widening the pattern changed nothing and the exclusion test stayed
    green when it should have flipped. When a grammar fix appears to do nothing,
    print the bytes.

## The instrument that keeps finding what the suite cannot

`DECKS=sfd node probes/exercised.ts` has now found **six** bugs the suite
structurally could not, most recently a deck-generator failure that only appeared
once coverage grew past 161 cards. **Run it after every card, not at the end**,
and rebuild first (trap 4). When it throws, instrument the state — do not assume
the card you just wrote is the author. Twice it was pre-existing code made
reachable by a new card.

## The verification loop — run in this order, every time

```
npx vitest run                                   # in packages/engine
npm run build --workspace=@rift-engine/engine    # BEFORE the typecheck AND before any probe
npm run typecheck                                # both workspaces
npm run build
node probes/{ai-health,passive-human,chain-depth,walkout,exercised}.ts
DECKS=sfd node probes/exercised.ts
```

Step 2 is not optional and now has two reasons: `@rift-engine/web` resolves the
engine from `dist`, and so do the probes.

**Read the typecheck output to the END**, and count the errors rather than eyeballing
them — `npm run typecheck 2>&1 | grep -c "error TS"`. The engine's `build`
tsconfig excludes tests while `typecheck`'s includes them, so the build can stay
green over a red typecheck.

**Walkout is pinned at 191/107/32.** If it moves, that is a real behaviour change
and needs explaining, not re-pinning.

## Standing constraints

- **Never bulk-edit source with PowerShell.** A python round-trip with explicit
  `utf-8` and `newline=""` is safe — see trap 9 about line endings, and assert
  every replacement.
- **Scratch files go in the session scratchpad, never beside the source.**
- **Prove every fix by making the check fail first**, and when you prove
  something by mutation, **grep for the marker to confirm the mutation applied
  and that it is gone afterwards**. A mutation that does not fail has tested
  nothing — this caught two worthless tests and one worthless guard in the last
  session.
- **Fix the PREMISE, never weaken the assertion.** When an existing test pins
  behaviour you have deliberately changed, REPLACE it and say so in the comment;
  several tests in this repo were written as negative controls explicitly asking
  to be replaced the day their clause was implemented.
- **A partial note is DELETED when the rest lands, never reworded** — with one
  recorded exception, SFD-150, where half genuinely landed and the old text had
  become false. If you reword one, say why in the note itself.
- **Never rebuild an action field by field.**
- **Record divergences in `docs/rules-conformance.md` in the same change.**
- **Re-read the CODE before believing a note about the code.** Six for six of the
  mechanism-naming notes have now been wrong or stale.
- Commit per card or per mechanism with a real message, and push.
- Agents must not run `npm run build` / `npm run typecheck` — the `dist` is
  shared. Only the central owner runs the loop. Fan agents out over DISJOINT
  per-domain effect files (`effects/{fury,chaos,order,mind,body,calm,signature}.ts`),
  which `mergeRegistries` makes parallel-safe by throwing on a duplicate defId.
  Every other file is single-owner — and note that most of the remaining 13 cards
  touch shared files, so parallelism buys less here than it did earlier.

## Definition of done

- Answer the (A)/(B) question above and record the answer.
- `SFD: N/198` from `test/set-coverage.test.ts` reports every remaining card
  either implemented or carrying a partial note that names MISSING CARD TEXT,
  never missing engine.
- Every card ended with the full loop green and `DECKS=sfd` at 0 invalid.
- **Under (A) only:** add `"SFD"` to `coverage.COMPLETE_SETS`.
  `SetCoverage.finishedButUndeclared` fails the suite until it is there. Its
  battlefields are already in `COMPLETE_BATTLEFIELD_SETS`, a separate list on a
  separate schedule.
- **Under (B):** record in `docs/rules-conformance.md` that SFD's end state is
  193/198 by decision, naming the five and why, and that it is deliberately not
  hard-gated.

## Known gap, player-facing (unchanged)

The UI has no way to pick WHICH spell on the chain to counter — it takes the
first matching candidate. Shared with Wind Wall, Defy, Mystic Reversal, Riposte's
spell half, and now Not So Fast (SFD-045), which counters by a FILTER and is the
card most likely to have two legal candidates. Harmless with one spell waiting;
arbitrary with two. Fixing it means making chain items clickable in the viewer.
