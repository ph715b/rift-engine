# Unleashed Equipment — the abilities that exist only on the card art

Transcribed 2026-08-08 by pulling each card's `media.image_url` and reading the
image. **None of this is in `unl.json`** — not `text.plain`, not `text.rich`, not
`accessibility_text`, and not `attributes.might`. The same gap SFD had, recorded
the same way (`docs/sfd-equipment-abilities.md`).

**Do not copy the verification loop into this file.** It is in `CLAUDE.md`.

## Why this file exists rather than a comment

`needsImplementation` reads the card TEXT, and for four of these five the entire
stored text is the `[Equip]` line. The generated equip ability then registers the
defId, so the card reports `isCardImplemented = true` while doing none of what it
prints. That is the over-report `coverage.ts` calls the worse direction, and it
is what made three of these five look finished.

## The five, verbatim

An Equipment's card art carries two things the data does not: a **Might badge**
in the bottom-right (a shield glyph and a number), and a **granted-ability band**
below the rules box, which is where a keyword or a triggered ability is printed.

| card | badge | the band | state |
|---|---|---|---|
| **UNL-019** Blighted Battleaxe | **+4** | "At the end of your turn, if I didn't conquer this turn, unattach this and deal 4 to me." | **both done** (2026-08-09) |
| **UNL-039** Soul Sword | **+1** | `[LEVEL 3]` "I have an additional +1 :might:. (While you have 3+ XP, get the effect.)" | **both done** (2026-08-09) — and it is a `[Level]` card |
| **UNL-096** Hunter's Machete | **+2** | `[HUNT]` "(When I conquer or hold, gain 1 XP.)" | **both done** — the Hunt is an `EQUIP_GRANTED_KEYWORDS` entry |
| **UNL-158** Shepherd's Heirloom | **+2** | (flavour text only) | **both done** — its `[Equip] — Spend 1 XP` cost landed in wave 2 |
| **UNL-188** Hextech Gauntlets | **+3** | "When I conquer, if you assigned 3 or more excess damage, draw 1." | **both done** — band in wave 7, and the printed Might-reduced `[Equip]` cost on 2026-08-14 |

Badges are in `card-loader.EQUIP_MIGHT_BONUS`. The Machete's keyword is in
`equipment.EQUIP_GRANTED_KEYWORDS`.

**The unwritten list reached ZERO on 2026-08-14** and none of these five carries a
`coverage.PARTIALLY_IMPLEMENTED` row any more. The state column above was measured
against `isCardImplemented`, not carried forward — it had been stale on four of the
five rows, each since the wave that wrote them, because a doc table is not something
any gate can see. `equipment-wearer-moments.test.ts` is what watches this now: it
asserts the INVARIANT (anything carrying an art-only note reports unfinished) rather
than a list of names, so it cannot go vacuous as the list empties.

The Gauntlets' printed rider — "this ability's Energy cost is reduced by the Might of
the unit you choose" — is not a band at all and was invisible to this table for that
reason. It lives in `activated-abilities.activationCostFor`.

## What this cost, and the lesson that is not about Equipment

**`[Hunt]` shipped believing there were 12 cards printing it. There are 13.**
Hunter's Machete is the thirteenth, and the keyword-trigger key was derived from
`card.keywords` — the PRINTED keywords — with a comment justifying it as "nothing
grants `[Hunt]`, measured over all four sets". The measurement was real and the
claim was false: it measured the card TEXT, and the grant is in the picture.

The fix moved the derivation to `triggerCandidates`, which has state, so it reads
`effectiveKeywords` and therefore sees printed, granted, aura-given,
battlefield-given and equipment-given Hunt alike.

**So "measured over the pool" is not the end of the argument if the pool's data
is incomplete.** Three separate classes of fact in this game live only in the
art — the Might badge, the granted-ability band, and the split Power pip — and
each has now produced at least one wrong belief in this engine.

## Two more art-only reads worth making

Neither is done, and both are the same shape as the above:

- **Unleashed's remaining ~22 short-text cards.** 27 UNL cards store under 60
  characters of rules text. The five Equipment are explained; the rest have not
  been looked at, and a Unit's text box is usually complete, so this is expected
  to be mostly a non-finding — but "expected" is what was said about `[Hunt]`.
- **The `[Level]` bands.** Soul Sword proves a `[Level N]` clause can be printed
  in an art band. Step 6 scopes `[Level]` from the 16 cards whose TEXT prints it;
  if other Equipment carry one, that number is a floor rather than a count.
