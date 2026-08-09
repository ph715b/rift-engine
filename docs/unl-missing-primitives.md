# Unleashed wave 1 — the 18 refusals, and the 7 primitives behind them

Six agents took 48 UNL cards across six disjoint domain files on 2026-08-08.
**30 landed, 18 were refused.** This file is the refusals, because they are the
more useful half: each names a missing mechanism, and they cluster hard.

**Do not copy the verification loop into this file.** It is in `CLAUDE.md`.

## Why refusals were the instruction

Every agent was told to refuse rather than guess, and never to add a shared
helper. That is the precedent from the SFD waves, where 53 of 105 cards were
refused and **the refusals are what found four new primitives**. A card written
against a mechanism that does not exist reports DONE and does nothing.

## The seven primitives, by how many cards they unblock

| # | primitive | file(s) | cards |
|---|---|---|---|
| 1 | **A per-domain hook for continuous Might.** `effective-might.ts` has no registry the domain files can contribute to; every conditional/scaling Might card must be hand-added there AND to `effectiveMightDefIds()` or coverage reports it inert. | `effective-might.ts` | UNL-077, UNL-076, UNL-004, UNL-154 |
| 2 | **Conditional "enters ready".** `deploy.ts`'s own comment rejects faking it as an on-play `readyUnit`, with three observable reasons: the unit sits exhausted through the response window, it fires a spurious `unitReadied` (paying Pirate's Haven), and it is blockable by Mageseeker Warden. Needs a case in `unitEntersReady` + a `playCardDefIds()` entry. | `deploy.ts` | UNL-037, UNL-035, UNL-008, UNL-122 |
| 3 | **`ACTIVATED_ABILITIES` is module-private.** No domain file can register an activated ability at all. | `activated-abilities.ts` | UNL-026, UNL-093 |
| 4 | **"Energy actually spent" is not recorded anywhere.** No `PlayerState` field, and `SpellChainEntry` does not carry the payment. `spellCast.totalCost` is **not** a substitute: it is printed `energyCost + powerCost`, so it folds in Power and ignores discounts — a 3-Energy/1-Power spell would falsely satisfy "spent 4+". Six UNL cards print this clause, so it is one shared primitive. | `game-state.ts`, `execute-play-card.ts`, `turn-manager.ts` | UNL-004, UNL-005 (+4 more not in this wave) |
| 5 | **A per-unit move restriction.** `mayMoveToBaseFrom(state, battlefieldId)` takes no unit. Precedent inside it: Minotaur Reckoner (SFD-014) is the *global* version of the same sentence. Four callers. | `battlefield-continuous.ts` + 4 call sites | UNL-111 |
| 6 | **`unitChooseableBy` takes no `GameState`**, so it cannot express a conditional "can't be chosen" aura. All four call sites already have `state` in scope, so this is a one-file change. | `target-lookup.ts` | UNL-057 |
| 7 | **`placeToken` fires no `cardPlayed` event.** Verified: the only four producers are `execute-play-card`, `deploy` ×2 and `play-free`. So "when you play a token unit" is currently unwritable — a listener registered today would be **dead code that made the card report DONE**. Rules-wise a token IS played (820.1.d's worked example says "play a … unit token"). | `token.ts` | UNL-058 |

## Three that are bigger than a primitive

- **UNL-050 Iascylla** — "at the start of your next Main Phase" needs BOTH a
  `mainPhaseBegan` event (none exists; the engine's `Action` phase is the rules'
  Main Phase and fires nothing) AND a general delayed-ability store. The one
  existing delayed effect (Targon's Peak) is a this-turn flag swept by `runEnd`;
  this must survive to the NEXT turn carrying a captured battlefield.
- **UNL-054 Tricksy Tentacles** — `unitList` can express the group constraint
  (`maxTotalMight`) but **not the destination**: `legal-actions`' move fan-out
  reads singular `targetUnitInstanceId` to compute the origin, and a `unitList`
  variant carries only `targetUnitInstanceIds`. The two features do not compose.
- **UNL-163 Mageseeker Investigator** — unreachable regardless of cost.
  `legal-actions` only ever emits ONE unit per `MoveUnitAction`, so "move
  multiple units at the same time" is a state this engine cannot produce.
  `player-action.ts` lines 246-248 already name this card as unmodelled.

## A forward-looking gap found while ruling on Ezreal

**UNL-166 Stalking Wolf's mandatory additional cost is unmodelled — it has no
entry anywhere in `src/`.** Its text is "As an additional cost to play me, kill a
Bird, Cat, Dog, or Poro you control", with no "you may", so it is MANDATORY.

That matters beyond the card itself. Ezreal - Prodigy's discount must never reach
a mandatory cost, and today it does not — but only because the cost does not
exist, which is the right answer for the wrong reason. When Stalking Wolf is
implemented it needs `UnitCostSpec.mandatory: true`, and the Ezreal test that
currently proves exclusion on Cruel Patron (OGN-208) should gain it as a second
subject.

## The rules call that WAS open — now answered

**UNL-054's "to a single location"** is a **partial no-op**: the choice is legal,
a chosen unit already standing at the destination simply does not move, and the
rest do. Project-owner ruling, 2026-08-08, and explicitly flagged by them as
inference rather than a quoted ruling — they searched the official rules docs,
the RiftJudge Q&A database, riftboundfaq.com and the errata pages and found
nothing addressing it word-for-word, and declined to invent a citation.

The reasoning: 355.4.a reads as a PER-UNIT check on whether a given unit may move
to a given destination, not as a rule about whether the location is a usable
target; and Riftbound's general pattern is that illegality in one sub-part of a
multi-part effect does not cancel the whole effect. So the constraint belongs in
the RESOLVER, not the targeting spec — which is the smaller change of the two.

Recorded in `docs/rules-conformance.md`. Worth confirming in the RiftJudge/rules
Discord before the card is built.

## One rules call still open

**A REPEATABLE optional additional cost: one cost paid N times, or N costs?**
Ezreal - Prodigy's ruling says the discount applies once per qualifying optional
additional cost and "never twice to the same cost" — which does not decide this.

Moot today and that is why it is only recorded: the two repeatable optional costs
in the pool (Kraken Hunter, Commander Ledros — "spend ANY NUMBER of buffs") are
paid with permanents and carry no Energy or Power pip for Ezreal to reduce. It
becomes live the moment a set prints a repeatable optional additional cost with a
pip.

## What this says about the fan-out

The 18 refusals resolve to **7 primitives + 3 larger gaps**, not 18 unrelated
blockers. One focused pass on `effective-might.ts`, `deploy.ts` and
`activated-abilities.ts` alone unblocks 10 of the 18. That concentration is the
argument for having run the wave: the same information from serial work would
have cost six times the wall-clock and surfaced one blocker at a time.
