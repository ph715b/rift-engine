# The survey's seven rules calls, all answered — 2026-08-02

`docs/dead-card-survey.md` listed seven questions under "Rules calls needed before
implementing (do not guess)". **All seven are now answered** — six from the rules
text and the last, Defy's missing numeral, from the printed card image.

Three of the six are answered **because the PDF uses the card in question as its
own worked example** (Fox-Fire, Defy, Baited Hook). That is worth noting on its
own: the survey treated them as ambiguities in the card text when they were
documented behaviours nobody had looked up.

Citations are the PDF's own numbering. The extract is two-column, so a sentence
and its rule number can land far apart — where the exact sub-number is uncertain
the section is given as a range and the sentence quoted verbatim, which is the
honest way to cite it. Never cite a line number from the extract.

---

## 1. OGN-029 Falling Star — "Deal 3 to a unit. Deal 3 to a unit."

**Asked:** `min: 2` (two mandatory instructions) or `min: 0` (this repo's
do-as-much-as-you-can convention)? At 2 the card looked uncastable with no units.

**Answered: `min: 2`, AND the same unit may fill both slots.** The premise of the
question was wrong — two mandatory targets do not make the card dead with one unit
on the board, because duplicates are legal.

- Targeting (355.x): *"In order to put a spell or ability on the chain, valid
  choices must be made for all targets."* So both slots must be filled.
- The Repeat section's Rocket Barrage example: *"they may choose the same mode or
  a different one, and if they choose the same mode, may choose the same target or
  a different one. If they choose 'Kill a gear' twice and choose two different
  gear, they must specify which gear is the first target and which is the
  second."*

So: castable with ONE unit (chosen twice, taking 6), uncastable with zero, and the
two choices are ORDERED. This is what `allowsDuplicateTargets` exists for — the
survey correctly named Falling Star as the reason it would be needed.

**Same answer covers OGN-248 Icathian Rain** ("Deal 2 to a unit" ×6): six ordered
targets, duplicates allowed, uncastable with no units.

## 2. OGN-256 Fox-Fire — "Kill any number of units at a battlefield with total Might 4 or less"

**Asked:** all chosen units at ONE battlefield or across many? Printed or effective
Might?

**Answered: ONE battlefield, and EFFECTIVE Might — the PDF works this exact card.**

> *"A player plays Fox-Fire, a spell that says in part 'Kill any number of units at
> a battlefield with total Might 4 or less.' That player chooses four 1 [M] Recruit
> tokens at a single battlefield. As a Reaction, another player gives two of those
> Recruits +1 [M], so the Recruits' Mights are 1, 1, 2, and 2. Then Fox-Fire
> resolves. The Recruits no longer have total Might 4 or less, so Fox-Fire's
> controller must choose a legal subset of the original targets to affect."*

Three things fall out, all load-bearing:

- **A single battlefield** — "at a single battlefield", "units at the same
  battlefield".
- **Effective Might**, re-evaluated at RESOLUTION. A this-turn +1 changes the
  answer, which is the whole point of the example.
- **Group targeting requirements** are a real rules concept (355.x): the group must
  collectively satisfy the restriction when finalized, and if it no longer does at
  resolution, *"that spell or ability's controller can choose a subset of the
  original targets that fulfills the targeting requirement"* — never a unit that
  was not originally chosen, though a chosen unit that has MOVED is still eligible
  provided the survivors are all at one battlefield.

## 3. "Any number" / "up to" is genuinely `min: 0`

Not one of the seven, but it settles the whole cluster:

> *"If a card specifies that a player chooses 'any number' or 'up to' some number
> of Game Objects to be affected, they may choose any number of available targets,
> including zero. If they choose zero, the spell or ability can be played without
> any targets."*

So "any number" cards are castable with an empty board and do nothing —
distinct from Falling Star's mandatory pair.

## 4. OGN-041 Volibear - Furious — "deal 5 damage split among any number of enemy units here"

**Asked:** nothing, but the survey filed split damage as a missing subsystem with
no design. The rules specify it completely, under **Splitting**:

- *"If a card specifies that an amount of damage may be split among some number of
  Units, then each Unit chosen is Targeted."*
- *"The Targets are chosen when the spell or ability is finalized on the chain."*
- *"A number of Targets can only be chosen up to, and not exceeding, the initial
  amount of damage available when the spell is played."* — so "split 5" allows at
  most 5 units.
- *"Each Target is valid, and contributes to Targeting Effects individually."*

Announce-time targeting, a cap equal to the damage, and each unit individually a
target. That is a spec, not a design problem.

## 5. OGN-227 Symbol of the Solari — "if a combat where you are the attacker ends in a tie"

**Asked:** what is "a tie"? The survey said the engine has no such concept and
listed three candidates.

**Answered: a tie IS rule 466.5.d's "No Result", and the engine already has it.**

> *"There is 'No Result' if units were recalled during step 3d of the Combat
> Cleanup, if both Players have units present during this task, or if neither
> player has units present during this task."*

The card's own reminder text confirms the timing — *"Ties are calculated after
combat damage is dealt."* The walkout fix of 2026-08-02 established exactly this
branch in `resolveShowdown` (466.5.a for a sole survivor, 466.5.d for No Result),
so the concept exists and is tested; the card needs to hook it, not invent it.

Note the neighbouring rule, which matters for the card's "recall ALL units
instead": *"If 'No Result' was reached, and both players have units remaining,
stage a Showdown and a Combat at this battlefield."*

## 6. OGN-236 Karthus - Eternal — "Your [Deathknell] effects trigger an additional time"

**Asked:** units you control at time of death, or Deathknells you own? Two
Karthuses = 3 triggers or 4?

**Answered: 3, by the Repeat precedent.** The rules' own model for
"an additional time" is Repeat: *"Multiple instances of Repeat can be paid for
separately. The spell or ability's instructions will be executed an additional time
on resolution for each instance of Repeat that is paid for."* One base execution
plus one per instance. Two Karthuses is 1 + 2 = **3**.

"Your Deathknell effects" is possessive of the EFFECT, and an effect is yours if
you control its source — so it is the dying unit's controller that matters, read at
the moment of death, which is what `DeathContext` already carries.

## 7. OGN-244 Divine Judgment — "Each player chooses 2 units, 2 gear, 2 runes, and 2 cards in their hands. Recycle the rest."

**Asked:** which runes does "2 runes" mean (channeled only, or channeled + rune
deck)? Does a unit "recycled" go to the main deck bottom?

**Answered, both halves:**

- **Recycle is defined per zone-of-origin** (1924-1925): *"Recycling cards is the
  action in which a player takes one or more cards from a specific zone and then
  puts it on the bottom of the CORRESPONDING deck."* So a unit goes to the bottom
  of the Main Deck and a rune to the bottom of the Rune Deck — one verb, two
  destinations, decided by what the card is.
- **"2 runes" is the runes a player CONTROLS**, i.e. the channeled pool. Cards in a
  rune deck are not controlled objects and cannot be chosen; and the instruction
  recycles "the rest", which would be incoherent for a deck that is already a deck.

## 8. OGN-143 Pirate's Haven — "When you ready a friendly unit, give it +1 Might this turn"

**Asked:** does this include the Awaken step's mass ready, which bypasses
`readyUnit` entirely? The survey called this "the difference between a combo
trigger and +1 Might to your whole board every turn".

**Answered: YES, it includes Awaken**, on the rules' own wording:

> *"A player Readies all non-spell Game Objects they Control during the Awakening
> Phase on their turn."*

The Awakening Phase *is* a readying performed by the player, so "when you ready a
friendly unit" is satisfied. This is the strong reading and it is the printed one.

**Consequence for implementation:** the engine's Awaken does not go through
`readyUnit`, so a `unitReadied` event has to be fired from the Awaken path as well
as from the helper — and fired PER UNIT, since the card gives Might to "it". This
is the one answer here that costs real work rather than just settling a question.

## 9. OGN-045 Defy — the rainbow numeral

**Asked:** the `:rb_rune_rainbow:` numeral is not in the card JSON.

**ANSWERED FROM THE CARD IMAGE: one rainbow pip = 1 Power of any domain.** So Defy
counters a spell costing **no more than 4 Energy and no more than 1 Power of any
domain**.

The numeral is absent from the card JSON's rich text and its accessibility text,
and the rules PDF quotes the card the same way, so this could only be settled by
looking at the printed card. Fetched from the image URL in `ogn.json`'s `media`
block.

**The convention the image reveals, which is the reusable part:** Energy is printed
as a NUMBERED glyph (Defy's text shows a black ④), while Power is printed as
COUNTED PIPS — one pip per Power. Defy's own cost proves it: the JSON says
`{energy: 1, power: 1}` and the frame shows a "1" Energy circle above exactly one
Calm pip. So the single unnumbered rainbow pip in its text is 1, and a "2 rainbow
Power" filter would print two pips.

**I originally answered this wrongly and the correction is worth keeping.** I cited
*"If X is omitted, it is presumed to be 1"* — but all five instances of that rule
are about KEYWORD values (Predict X, the Assault/Deflect/Shield Values, Hunt X),
not cost pips. A reviewing agent caught the leap. The rule does settle a different
card correctly: `[Deflect]` with no number is Deflect 1, which is what Pouty Poro
carries.

**And the cost filter reads the target's PRINTED cost — the PDF works Defy by
name:**

> *"Effects that need to determine a card's cost for any purpose always use its
> printed or copied cost, even if that cost is increased, decreased, or ignored as
> the card is played."*
>
> *"Example: Defy is a spell which reads 'Counter a spell that costs no more than
> [4] and no more than [A].' Rocket Barrage is a spell that costs [4][C] and has a
> Repeat cost of [4][C]. Rocket Barrage is a legal target for Defy even if Rocket
> Barrage's Repeat cost is paid, because Defy only checks the printed or copied
> cost of its target."*

That also settles it for Wallop and Call to Glory, whose `ignoresCostWhenPaid`
zeroes a cost as the card is played: an effect asking what they cost still gets the
printed number. Worth knowing before anything else reads a cost.

One more constraint from the same section, which the counter-a-spell subsystem must
honour: *"A spell that says 'Counter a spell' cannot target itself"* — but an
ability of a permanent CAN target that permanent, *"because abilities and their
sources are separate objects"*.

---

## What is still genuinely open

Nothing from the original seven — Defy's numeral was the last, and the card image
settled it (one pip = 1).

Judgement calls rather than lookups:

- **Pirate's Haven's power level.** The rules answer is unambiguous (rule 415: *"A
  player Readies all non-spell Game Objects they Control during the Awakening
  Phase"*, and the Awaken task itself says *"readies all Game Objects they control
  that are able to be readied. See rule 415"*). Whether a card that pumps your whole
  board every Awaken is intended is a design question. Implement as printed, record
  Unverified. **415 also supplies the guard:** *"A Unit that is already Ready cannot
  be Readied again. If a Unit is instructed to be Readied while it is already Ready,
  nothing additional happens"* — so the event fires only for units that were
  actually exhausted, the same shape as `addBuff`'s 708 guard.

## Found by the re-survey, not in the original seven

Questions the rules do NOT answer, surfaced by re-reading the remaining 66. Each
would change the card materially, so none should be guessed:

- **OGN-034 Tryndamere — "excess damage" is not a defined term anywhere in the
  rules.** `excess` appears only under Burn Out. At least three readings give
  different numbers on the same board: only `distribute`'s overkill dump onto the
  last target; attacker pool minus total lethal need; or per-unit
  `assigned − remainingMight` summed.
- **OGN-189 Kayn — "I don't take damage" versus combat's lethal-first assignment.**
  Does Kayn still absorb a full lethal allocation (shielding the units behind him),
  or does the pool flow past him? 465.2's assignment rules and damage prevention are
  not reconciled in the PDF. These are materially different cards.
- **OGN-236 Karthus — two copies: 3 triggers or 4?** The rules have no general
  clause for "an additional time". `[Repeat]` is explicitly additive per instance,
  which is a strong analogy but not the same keyword.
- **OGN-018 Noxus Saboteur — "your opponents' [Hidden] cards can't be revealed
  here."** The `[Hidden]` section never uses "reveal"; the only nearby line is
  *"If a facedown card would change zones or if the game ends, its owner reveals it
  to all players."* Reading it as "cannot be played from Hidden here" is a same-day
  change; reading it as all zone changes freezes the card in place; reading it as a
  `Revealed` status means the card is inert by design in this pool.
- **OGN-235 Karma — "when YOU recycle"**: the player performing the action, or the
  player whose deck receives the cards? Rule 1928 makes these come apart, and the
  engine has a site that recycles the OPPONENT's trash at the caster's instruction.
- **OGN-244 Divine Judgment — "2 runes"**: the channeled pool only, or channeled +
  rune deck? Reading (b) makes the card self-referential.
- **OGN-177 Stealthy Pursuer — a held trigger arrives AFTER the Showdown stages**
  (`runCleanup` does `stageShowdowns` before `finalizePendingTriggers`). Does he
  join the fight as an extra attacker, or must "moved WITH it" be simultaneous —
  which would mean this cannot be a held trigger at all?
- **OGN-158 Volibear - Imposing**: `MoveUnitAction.unitInstanceIds` is an array —
  does one action moving 3 units draw 1 or 3? And with Volibear in base, is every
  enemy move "other than mine", or none?
- **Does a spell-driven `forceMoveToBattlefield` count as a move?** It deliberately
  fires no move triggers today. Affects OGN-205's counter and OGN-158's event.
