> **SUPERSEDED — SFD IS COMPLETE (2026-08-07, `970eedd`).**
> All 198 SFD cards are implemented and `"SFD"` is in
> `coverage.COMPLETE_SETS`, so the set is hard-gated alongside OGN and OGS.
> `PARTIALLY_IMPLEMENTED` is empty. **Nothing in this file is still to do.**
> It is kept for the surveys and the reasoning; every card list and every
> price in it is historical. See `docs/rules-conformance.md`'s Log for what
> the finish cost and what it left as divergences.

> **The verification loop in this file is a DRIFTED COPY.** The canonical one
> is `CLAUDE.md` at the repo root — this file's version omits the ROOT `npm test`
> and so cannot see the web suite, which is how a red web test survived an entire
> session. Use `CLAUDE.md`.

# SFD — the final 11

**This supersedes `docs/sfd-final-18-prompt.md`**, whose (A)/(B) question is now
answered and whose card list is seven shorter.

Written 2026-08-07 at `e31f741`. Every figure below was measured at that commit.
**Re-measure anyway** — that instruction has been right every time it was
ignored, including twice in the session that wrote the previous handoff.

## The decision, and it is made

**(A): finish all 18, then add `"SFD"` to `coverage.COMPLETE_SETS`.** The human
chose it explicitly over (B) (stop at 193/198, ungated). Recorded in
`docs/rules-conformance.md`'s Log.

The overrun instruction was also explicit: **finish everything else in scope
first, then stop and ask** rather than landing a partial note. Under (A) a
partial note forfeits the gate entirely, so "land a note and move on" is not
available.

## Measured state at `e31f741`

| | |
|---|---|
| OGN | 248/248 (complete, hard-gated) |
| OGS | 22/22 (complete, hard-gated) |
| **SFD cards** | **187/198** |
| SFD battlefields | 15/15 — complete and hard-gated |

Engine **3004 tests across 186 files**. Typecheck 0 errors across both
workspaces, both builds green, all five probes green with **walkout pinned at
191/107/32**, `DECKS=sfd` 0 invalid.

## The 11 left

### Eight fully open (no partial note)

| Card | Needs | What is already there |
|---|---|---|
| **SFD-018 Void Hatchling** | a reveal REPLACEMENT | **Read the section below before starting. This is the one that is genuinely expensive, and it is the reason this handoff exists.** |
| **SFD-079 Bard - Mercurial** | legend-exhaust additional cost + multi-unit move | `OPTIONAL_UNIT_COSTS` is the shape; an `exhaustLegend` kind needs no id field. The MOVE (any number of units to one open battlefield) is the hard half — `unitList` targeting is the nearest existing spec. |
| **SFD-109 Akshan - Mischievous** | GEAR control that expires on a condition | `takeControlOfUnit` is permanent, unit-only, and has no expiry. Nothing models gear control. His `[Body][Body]` half already works. |
| **SFD-146 Vex - Cheerless** | an asymmetric cost aura conditioned on combat | `modifiedEnergyCost` + `scaledPowerDiscount` is the two-axis pattern. Both halves at all three cost sites. `isFightingAt` answers "in combat". |
| **SFD-168 Vanguard Armory** | a per-token destination axis | `placeRecruitToken` takes ONE destination. The enumeration is the problem, not the placement. |
| **SFD-184 Relentless Pursuit** | a GRANTED delayed triggered ability, for a turn | Nothing grants a triggered ability to a unit. `keywordsThisTurn` is the nearest shape and holds keywords, not abilities. |
| **SFD-198 Arise!** | shares Vanguard Armory's axis + a bounded ready | `SAND_SOLDIER_TOKEN` already exists in `token.ts`. Do it with SFD-168. |
| **SFD-202 Hostile Takeover** | mid-combat control + a scheduled end-of-turn reversal | `takeControlOfUnit` exists; the REVERSAL does not, and `rules-conformance.md` already carries a row saying control IS which list a unit sits in, so a stolen unit is indistinguishable from an owned one. Read that row first. |

### Three partial, each blocking the gate

- **SFD-030 Skyfall of Areion** — "my hold effects are also conquer effects, and
  vice versa". `battlefieldHeld` and `battlefieldConquered` are distinct kinds in
  the `GameEvent` union; this needs the wearer's triggers to fire on the mirrored
  moment. Not assessed in depth this session.
- **SFD-059 Svellsongur** — "copy that unit's text to this Equipment". **Not
  assessed. Treat as the second expensive one** — effects are registered per
  defId, so "copy text" means the gear resolving another card's registered
  effects, and nothing models that.
- **SFD-090 The Zero Drive** — "play all units banished with this". Needs
  banish-WITH-SOURCE tracking; `banished` is a flat `CardInstance[]` with no
  source. Priced MODERATE this session (a source field plus the activation), not
  hard — but not started.

## Void Hatchling (SFD-018) — priced, and it is the blocker

> "If you would reveal cards from a deck, look at the top card first. You may
> recycle it. Then reveal those cards."

**This REPLACES a step, and the engine cannot pause mid-resolution.** A reveal
site must ask "recycle the top card?" and then perform its own reveal with the
answer already in hand. `parkDecision` returns to a caller that has already run.
So each reveal site has to become a decision CONTINUATION.

**The survey is done and is the useful part.** There are exactly FIVE reveal
sites, all now funnelled through `top-of-deck.revealedFromDeck`:

| site | card | what it does after revealing |
|---|---|---|
| `effects/body.ts` | Dazzling Aurora | reveal until a unit, banish it, play it, recycle the rest — **the big one** |
| `effects/calm.ts` | Apprentice Smith | reveal top; if gear draw it, else recycle |
| `effects/mind.ts` | Bilgewater Dredger | reveal top 5, damage per match |
| `effects/fury.ts` | Blind Fury | opponent reveals top; banish and play it |
| `battlefield-abilities.ts` | Ravenbloom Conservatory | reveal top; spell to hand, else recycle |

Each needs its own continuation decision carrying that site's downstream logic —
five new decision kinds, roughly 300–600 lines, touching five working cards.
**A naive implementation is worse than none**: parking the question and letting
the reveal proceed makes the card a silent no-op, because recycling after the
reveal changes nothing.

Six further sites LOOK without revealing (Reinforce, Stacked Deck, Called Shot,
Baited Hook, Ornn - Blacksmith, the both-players look) and must NOT be touched —
Void Hatchling's clause is reveal-only, and so is Undertitan's.

## What this session added that the remaining cards can use

- **`timing.mayPlayFromTrash`** + `PlayerState.trashUnitPlaysThisTurn` — the
  first full-cost play from a non-hand zone. The trash is now a fourth play
  source, which is what finally made Void Drone, Drag Under and Rek'Sai -
  Breacher pay out.
- **`top-of-deck.revealedFromDeck`** — the REVEAL funnel, distinct from the LOOK
  funnel. Void Hatchling plugs in here.
- **`TargetingSpec` kind `unitAndEquipment`** — a spell naming a unit AND an
  Equipment, with a `relation` of `attachable` / `attachedToIt`.
- **`equipment.equipmentPairedWith`** — the shared walk for "an Equipment with
  the same controller", used by the enumerator, both validators and
  `hasAnyLegalEffectChoice`.
- **`AbilityMode.attachesFromTargetToSelf`** — an activation axis that takes an
  Equipment OFF the target and puts it on the source. Reverse of
  `attachesEquipment`; do not merge them.
- **`GearInstance.attachedThisTurn`** + `equipment.withoutAttachFreshness` — a
  per-attachment freshness flag, swept at `runEnd`.
- **`equipment.effectiveTagsOf` / `isMechUnit`** — printed AND granted tags. Six
  in-play readers route through it.

## Corrections to the previous handoff, all verified in code

1. **`tags` was NOT printed-only.** `card.ts` copies them onto every
   `UnitInstance`; the Mech token depends on that. Hexplate needed no storage,
   only for the readers to ask one function.
2. **Brutalizer needed no "per-attachment turn stamp" subsystem.**
   `equipment.ts` is the declared single writer of `attachedToInstanceId`, so it
   is one flag at one site.
3. **`EventTriggerDefinition.on` already accepts a LIST**, so a two-moment card
   (Last Rites' conquer-or-hold) needs no new machinery.
4. **Two reveal sites called NO funnel at all** — Blind Fury and Ravenbloom
   Conservatory. Nocturne had been missing both since he was written. Fixed.

That is now **eight for eight** on this repo's mechanism-naming notes being wrong
or stale. Re-read the code before believing any note in this file either.

## Traps that bit again this session

Everything in the previous handoff still applies. These three actually recurred:

- **Trap 6 (a test that hands a rule its own precondition).** Two Last Rites
  tests asserted `modifiedEnergyCost(..., false)` — testing the discount, not
  whether the trash reaches pricing as a non-hand play. Rewritten against the
  ENUMERATOR, the same stub went from failing 2 to failing 4, and the rewrite
  immediately exposed two real fixture bugs.
- **Trap 7 (a one-option decision auto-resolves).** Blind Fury cannot be probed
  with Nocturne: it plays the card it revealed, so his options collapse to a lone
  "decline" and `pendingDecision` reads `undefined` — identical to "the funnel
  was never called".
- **A VACUOUS test passes every mutation.** The Hexplate keyword-aura test first
  used Rumble - Scrapper, who is a MIGHT aura granting no keywords, so both sides
  of the comparison were empty. **Always mutate.**
- **The typecheck catches what the suite cannot.** `hasAnyLegalEffectChoice`'s
  switch is exhaustive-by-return-type, so a new `TargetingSpec` kind breaks
  compilation instead of silently defaulting to "castable". And
  `exactOptionalPropertyTypes` makes `x: undefined` a different type from an
  absent key — a set-to-undefined never typechecks.

## The verification loop — unchanged, run in this order every time

```
npx vitest run                                   # in packages/engine
npm run build --workspace=@rift-engine/engine    # BEFORE the typecheck AND any probe
npm run typecheck                                # both workspaces; COUNT the errors
npm run build
node probes/{ai-health,passive-human,chain-depth,walkout,exercised}.ts
DECKS=sfd node probes/exercised.ts
```

`runEnd` runs FROM the Action phase, not the End phase — a fixture that sets
`phase: "End"` throws.

## Definition of done

- Every remaining card either implemented, or carrying a partial note that names
  MISSING CARD TEXT, never missing engine.
- **Add `"SFD"` to `coverage.COMPLETE_SETS`** the moment the count reads 198/198.
  `SetCoverage.finishedButUndeclared` fails the suite until it is there. The
  battlefields are already in `COMPLETE_BATTLEFIELD_SETS`, a separate list.
- Full loop green, walkout still 191/107/32, `DECKS=sfd` 0 invalid.
- Record every divergence in `docs/rules-conformance.md` in the same change.

## Known gap, player-facing (unchanged)

The UI has no way to pick WHICH spell on the chain to counter — it takes the
first matching candidate. Shared with Wind Wall, Defy, Mystic Reversal, Riposte's
spell half and Not So Fast. Fixing it means making chain items clickable.
