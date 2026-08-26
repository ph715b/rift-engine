# Surfacing the engine's events — measured, 2026-08-26

**Do not copy the verification loop into this file.** It is in `CLAUDE.md`.

The engine computes a rich event stream and throws it away. `submit` returns
`{ type: "Ok" }` and nothing else, so the board recovers "what just happened" by
DIFFING snapshots — `use-zone-flights.ts` says so in its own comment, and there
are two independent differs already (zone counts, chain top).

Surfacing those events is the keystone for four things: a **game log**, **AI turn
narration**, **sound**, and the animations that need events rather than zone
counts (damage, deaths, triggers). This file is the measurement taken before
committing to any of them, so the next session argues with numbers rather than
re-deriving them.

**It was SPIKED and reverted, not estimated.** Every figure below came from
running it.

## What is already there

**29 event kinds**, and they flow through ONE funnel: `holdEventTrigger(state,
event, placesFirst?)` in `engine/triggers.ts`, called from 36 sites. Capturing
them is a single edit inside that function — **the 36 call sites need no change
at all**. That is the finding that makes the whole thing cheap.

```
abilityActivated  battlefieldConquered  battlefieldHeld     becameEmpowered
beginningPhase    buffSpent             cardDrawn           cardHidden
cardPlayed        cardsDiscarded        cardsRecycled       combatBegan
combatEnded       combatWon             endOfTurn           equipmentAttached
mainPhaseStarted  runesRecycled         showdownBegan       spellCast
trigger           unitBecameMighty      unitBuffed          unitChosen
unitDied          unitKilledBySpell     unitMoved           unitReadied
unitsStunned
```

## What the spike cost

| measure | result |
|---|---|
| build errors | **0** |
| typecheck errors, field REQUIRED | **15** — all tests, all hand-built `GameState` literals |
| typecheck errors, field OPTIONAL | **0** |
| test failures | **1** |
| `walkout` figures | **unmoved** at 185 / 108 / 30 |
| `walkout` runtime | 103.3s, 104.3s baseline → 107.6s, 107.7s with capture — **+3.7%** |

Two runs each, same machine, back to back.

## The three findings an estimate would have missed

**1. `GameEvent` lives DOWNSTREAM of `GameState`.** It is declared in
`engine/triggers.ts`, which imports from `model/game-state.ts` — so the state
cannot name the event type without a cycle. A **type-only** import
(`import type { GameEvent } from "../engine/triggers.js"`) is erased at runtime
and builds clean, so this costs one line rather than moving the type to a leaf
module. Worth knowing before someone starts that refactor.

**2. Something asserts REFERENCE IDENTITY on the returned state.**
`event-triggers.test.ts` has `expect(after).toBe(state)` — "nothing happened at
all, not even a copy" — and capturing unconditionally makes `holdEventTrigger`
always return a fresh object. That is the single test failure above. Its
behavioural half (`no token was made`) is already asserted on the line before it,
so the identity assertion is pinning an implementation detail rather than a rule.
**Of 71 identity assertions across the engine tests, exactly one is on a whole
state through this path.**

**3. The +3.7% is mostly the AI, which never reads the events.** The cost is
spreading the array on every capture, and during `ownTurnRollout` the AI applies
thousands of actions through `applyBare` — which does not go through `submit`, so
nothing would ever reset the list and it grows across a rollout. **Two ways out,
neither taken yet:** reset `recentEvents` at the top of `submit` (bounds it to one
action, but the lookahead still pays), or gate capture on a flag the lookahead
does not set (zero AI cost, one more field). Measure before choosing — the split
between "array copying" and "state spreading" was not separated here.

## What this does NOT tell you

- The **web** cost is unmeasured. `GameBoard` re-renders on every state change and
  a growing array on the state is a new dependency surface.
- Whether the log wants the RAW events or a rendered sentence per event. The raw
  stream names instance ids, not card names; something has to resolve them, and
  where that lives is a design question this measurement does not answer.
- Nothing here covers **ordering**. Events reach the funnel as they are raised,
  which is not necessarily the order a player would narrate them in.

## The recommendation

**Additive and affordable.** Make the field optional, capture in the one funnel,
invert the identity assertion (its behavioural half already passes), and decide
the AI-cost question with a second measurement rather than by argument.

The alternative — keeping the board on snapshot diffing — is what produced the
two differs already in `packages/web`, and it cannot express the thing a log needs
most: WHY something happened. A diff can see a unit left a battlefield. It cannot
tell "died in combat" from "was killed by a spell" from "was recalled".
