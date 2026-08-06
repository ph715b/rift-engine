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

## Not implemented — the wearer's moments (7)

All of the shape "when I \<moment\>, \<effect\>", where **I** is the unit wearing
the Equipment. They need one shared piece of work: an attached Equipment's
trigger firing on its WEARER's hold/conquer/move/attack, which no dispatch does
today. Doing that once covers all seven.

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

(Eight rows — Eye of the Herald shares the mechanism but fires on a move.)

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

## The single highest-value next step

**The wearer's-moments dispatch.** Eight cards share it, it is one mechanism, and
every one of those cards is currently weaker than printed with nothing able to
report it.
