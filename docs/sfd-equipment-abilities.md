# SFD Equipment — the abilities that exist only on the card art

Transcribed 2026-08-06 by cropping the rules-text box out of all 31 Equipment
card images (`media.image_url`, already in `sfd.json`) and reading them.

## Why this document exists

**None of this is in the card data.** For every Equipment below, `text.plain`,
`text.rich` and `accessibility_text` contain nothing but the `[Equip]` line and
its reminder. The Might badge and the second ability both live in the printed
card's lower box, and the export never captured either.

Two consequences:

- A card here whose ability is unimplemented is **weaker than printed**, and no
  measurement in this repo can see it. `needsImplementation` reads the text, the
  text is a keyword line, so the card reports as needing nothing.
- Re-deriving this list costs 31 image fetches. It is written down once.

**The 31 Might badges were re-verified in the same pass** and all 31 matched
`card-loader`'s `EQUIP_MIGHT_BONUS`, which had been ported from the frozen Java
oracle. That is an independent confirmation of the whole table, not a spot check.

## Implemented — granted keywords (5)

These grant a keyword to the unit wearing them, and are the one shared mechanism
among the 31. `equipment.ts`'s `EQUIP_GRANTED_KEYWORDS`, folded into
`effectiveKeywords`, so the keyword comes and goes with the attachment.

| card | grants |
|---|---|
| SFD-009 Serrated Dirk | `[Assault 2]` |
| SFD-033 Doran's Shield | `[Tank]` |
| SFD-064 Cloth Armor | `[Shield 2]` |
| SFD-102 Hexdrinker | `[Deflect]` |
| SFD-133 Boots of Swiftness | `[Ganking]` |

## Implemented — the wearer's moments (8) — DONE 2026-08-06

All of the shape "when I \<moment\>, \<effect\>", where **I** is the unit wearing
the Equipment. They shared one piece of work and it is now written:
`equipment.wearerListener`, which hands a gear's ability the listener its WEARER
would have had.

**The mechanism is one function, because the walk was already right.**
`listeningPermanents` has always walked every piece of active Gear as a listener.
What a gear listener lacked was a LOCATION — `activeGear` is a flat per-player
list with no battlefield — so a "when I conquer" written against
`listener.battlefieldId` could never match, and `isFightingAt` rejected it
outright for not being a Unit. Rewriting the listener rather than teaching the
walk about attachment leaves Mask of Foresight, a gear listener that is
deliberately NOT a combatant, untouched.

Tests in `equipment-wearer-moments.test.ts`; nine of its seventeen fail with
`wearerListener` stubbed out.

| card | printed |
|---|---|
| SFD-016 Recurve Bow | When I attack or defend, deal 2 to an enemy unit here. |
| SFD-086 World Atlas | When I hold, play two Gold gear tokens exhausted. |
| SFD-108 Warmog's Armor | When I conquer, buff me. |
| SFD-115 Trinity Force | When I hold, score 1 point. |
| SFD-118 Boneshiver | When I conquer, channel 1 rune exhausted. |
| SFD-124 Doran's Ring | When I conquer, discard 1, then draw 1. |
| SFD-134 Cull | When I conquer, play a Gold gear token exhausted. |
| SFD-153 Eye of the Herald | When I move, play a 1 Might Recruit unit token here. |

Two of the eight are worth a note. **Eye of the Herald** is the only one that is
not positional — it matches on the moving unit's id, and its "here" is
`event.to`, the battlefield the wearer ARRIVED at, because by resolution the
listener's own location would be right only by luck. **Recurve Bow** names a
choice ("an enemy unit"), so it parks a decision rather than auto-selecting in
board order the way Yasuo and Teemo do; that inherits only the divergence
`rules-conformance.md` already records for every held trigger — the choice
happens at resolution rather than at finalization (402) — instead of adding
auto-selection as a second one.

## Not implemented — one-offs (8)

Each needs its own wiring, and several need a primitive that does not exist.

| card | printed | needs |
|---|---|---|
| SFD-030 Skyfall of Areion | My hold effects are also conquer effects, and vice versa. | A moment-rewriting layer. No precedent in the engine. |
| SFD-042 Brutalizer | If this was attached to me THIS TURN, I have an additional +2 Might. | A per-attachment turn stamp on the gear. |
| SFD-051 Guardian Angel | If I would die, kill Guardian Angel instead. Heal me, exhaust me, and recall me. | A death replacement sourced from a GEAR — `death-ward.ts` shape. |
| SFD-059 Svellsongur | As this is attached to a unit, copy that unit's text to this Equipment's effect text. | Text copying. Nothing in the engine models it. |
| SFD-073 Experimental Hexplate | I am a Mech. | A granted TAG, not a keyword — `tags` is read for tribal checks and is currently printed-only. |
| SFD-090 The Zero Drive | 3, Banish this: play all units banished with this, ignoring their costs (only if unattached). `[Deathknell]` — Banish me. | Banish-with-source tracking. |
| SFD-172 Sacred Shears | `[Deathknell]` — Draw 1. | A Deathknell on the WEARER sourced from the gear. |
| SFD-190 Forgefire Cape | When I attack or defend, deal 2 to ALL enemy units here. | The wearer's-moments mechanism above, plus its rainbow `[Equip]` cost. |
| SFD-191 Rabadon's Deathcrown | Your spells and abilities deal 3 Bonus Damage while this is attached. | `damage-modifiers.ts` entry conditioned on attachment. |
| SFD-192 Shurelya's Requiem | When you play this, ready your units. **Your units HERE have `[Ganking]`.** | The ready half is written; the positional aura is not. |
| SFD-150 Last Rites | When I conquer or hold, you may play a unit from your trash (still paying costs). | Wearer's-moments, plus its compound `[Equip]` cost. |

## Genuinely vanilla — flavour text only (5)

Nothing to implement beyond the `[Equip]` cost and the Might badge, both of which
are done: **SFD-022 Long Sword, SFD-056 Sterak's Gage, SFD-095 Doran's Blade,
SFD-161 B.F. Sword, SFD-178 Blade of the Ruined King.**

## What this cost the coverage number, and why that is the point

**Fifteen Equipment reported `isCardImplemented = true` while doing none of what
they print.** Not invisible to the instrument — actively misreported by it:
`needsImplementation` reads the card text, the text is a bare `[Equip]` line, the
generated equip ability is registered, so the card reads as finished.

Eight are now written. The other seven were added to `PARTIALLY_IMPLEMENTED`,
each naming the primitive it waits on. **SFD therefore fell from 100/198 to
93/198**, and the drop is the fix rather than a regression: the eight were
already being counted, so implementing them added nothing, and the seven had been
inflating the number all along.

## The next step here

The seven one-offs below, each needing its own primitive — no shared mechanism
left in this group. `SFD-172 Sacred Shears` is the cheapest (a `[Deathknell]` on
the wearer, sourced from the gear) and `SFD-059 Svellsongur` the most expensive
(text copying, which nothing in the engine models).
