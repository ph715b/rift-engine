# The 88 dead cards, classified — survey of 2026-08-02

Five parallel read-only agents over the full dead pool (34 Spells, 46 Units, 7 Gear,
1 Legend), each working from the real registry dump (`dead-cards.json`) rather than
from card names. Verdict totals:

| verdict | count | meaning |
|---|---|---|
| **READY** | **29** | every primitive exists; a registry entry + a resolver |
| SMALL-GAP | 37 | one modest new helper/event/targeting option |
| SUBSYSTEM | 22 | a genuinely new engine capability |

## Two bugs found that the survey was not looking for

**Both are FIXED as of 2026-08-02 — and the second one was not the bug it was reported as.
Read the correction below before quoting it.**

**1. LIVE — `combat.assignmentOrder` ignored granted keywords.** `combat.ts:72,74` was the
only keyword read in the file and it read printed `u.keywords`; it never imported
`effectiveKeywords`. `grantKeywordThisTurn` writes to `keywordsThisTurn`. So **Block
(OGN-057) was half inert while reporting as implemented** — its `[Shield 3]` worked
(effective-might reads through `effectiveKeywords`), its `[Tank]` did nothing. The card's
own comment stated the failed assumption: "[Tank] is 'must be assigned combat damage
first' (combat.ts owns that)". Fixed by asking through `hasKeyword`; `assignmentOrder` now
takes `state` + the owner index, both already in scope at its two call sites in
`resolveShowdown`. Two regression tests, each written to fail against the old code first.

**2. NOT a bug — activation Energy+Power does NOT double-spend a rune.** The claim was
that `activationPayment`'s hardcoded `computeAutoPayment(channeled, energy, 0, null)`
could name a rune that `payActivationCost` then recycles paying Power first
(`activated-abilities.ts:718`), so the Energy payment fails and `executeActivateAbility`
throws on an action `legal-actions` offered as legal. **It cannot.** Recycling a READY rune
banks exactly 1 floating Energy (`payPowerFromChanneled`), which covers precisely the 1
Energy that rune could have paid; recycling an Exhausted one removes a rune that could not
have paid Energy anyway. The two errors cancel for every pool and every cost — pre-Power
pricing and post-Power payment are exactly equivalent, so the throw is unreachable, not
merely unreached. `activationPayment` was rewritten anyway to take the whole
`ActivationCost` and apply the Power step first, so the agreement is by construction rather
than by that arithmetic coincidence — the card that would inherit the coincidence is
OGN-242 Baited Hook, the first to combine `energy` with `power`.

---

## Clusters, ranked by cards unblocked

### 1. READY — 29 cards, zero engine risk
Pure registry entries. **A third of the dead pool.**

- **Spells (12):** OGN-069 Last Stand, OGN-104 Retreat, OGN-108 Convergent Mutation,
  OGN-146 Wallop, OGN-153 Overt Operation, OGN-173 Ride The Wind, OGN-179 Acceptable
  Losses, OGN-187 Whirlwind, OGN-201 Invert Timelines, OGN-237 King's Edict,
  OGN-250 Stormbringer, OGN-260 Last Breath
- **Units (17):** OGN-028 Draven, OGN-038 Kadregrin, OGN-056 Adaptatron, OGN-076 Yasuo -
  Remorseful, OGN-091 Pit Crew, OGN-096 Watchful Sentry, OGN-106 Sprite Mother,
  OGN-140 Herald of Scales, OGN-148 Anivia, OGN-149 Carnivorous Snapvine, OGN-159 Warwick,
  OGN-188 Zaunite Bouncer, OGN-190 Kog'Maw, OGN-196 Soulgorger, OGN-226 Spectral Matron,
  OGN-230 Albus Ferros, OGN-239 Machine Evangel

Notable: OGN-076 Yasuo - Remorseful is a **champion of an imported community decklist**.
Several ride precedents already built (Flame Chompers' trash→`playUnitToBase` path unblocks
Soulgorger and Spectral Matron; Cull the Weak's ask-each-player decision unblocks four
spells; Zenith Blade's `slotScopes` unblocks Last Breath).

### 2. New GameEvents for permanents — ~10 cards across 5 small events
Each event is individually small; together they are the highest leverage after cluster 1.

| event | cards | note |
|---|---|---|
| `unitMoved` (mover, from, to) + per-unit `movesThisTurn` counter | 4 (OGN-158, 177, 205, 189 partial) | `movedThisTurn` is a boolean today; `model/card.ts` already names the counter as the field to add |
| `battlefieldHeld` | 2 (OGN-066, 067) | `scoreHolds` fires **nothing** today |
| `endOfTurn` for permanents | 2 (OGN-073, 160) | `runEnd` fires only the legend hook |
| `unitReadied` | 1 (OGN-143) | must fire only when actually exhausted |
| `cardsRecycled` | 1 (OGN-235) | needs one funnel; ~8 scattered recycle sites, runes excluded |

**Write these against `holdEventTrigger` from the start.** They land in the EventTrigger
registry, which is the converted one — adding them as inline `dispatchEvent` sites would
grow the Chain backlog from 13 to 18 while implementing cards.

### 3. Play a card from a non-hand zone (+ the `banished` zone) — ~8 cards
`PlayerState.banished` is declared and **nothing in `src/` ever writes to it**.
Sub-capabilities in dependency order:
(a) write to `banished`; (b) play a **Unit** from trash/banish ignoring cost — mostly done
via `deploy.playUnitToBase`; (c) play a **Spell** onto the chain from outside hand — the
genuinely new one, nothing outside `execute-play-card`/`execute-pass-focus` can do it;
(d) pay a real cost mid-resolution; (e) play an opponent-owned card.

Cards: OGN-025, 062, 115, 122, 102, 198, 107, 112, 194. (a)+(b) alone finish OGN-102 and
half of OGN-122.

### 4. Multi-target selection beyond two fixed slots — ~7 cards
`unitSlots.slots` is typed as exactly two, and `allowsDuplicateTargets` is absent (the code
names OGN-029 Falling Star as the reason it will be needed). Cards: OGN-029, 248, 256, 258,
264, 244 — **plus the already-recorded split-damage gap (Volibear - Furious)**.

The real decision is *where* selection happens: an N-slot `TargetingSpec` (rules-correct,
announce-time, but ~10^5 enumerated variants for OGN-248's six slots — would swamp
`legal-actions` and the AI) versus repeated resolve-time decisions (works today, diverges
from announce-time targeting). **Decide this once; it governs 7+ cards.**

### 5. Cost-pipeline extensions — ~6 cards, and it converges with `[Deflect]`
X-costs (OGN-268), `modifiedPowerCost` (OGN-150 — the pipeline reduces Energy only),
rune-shaped optional additional cost (OGN-044), activation Energy+Power (OGN-242),
rainbow/any-domain Power pool (OGN-113, 194). All want the **per-variant payment
restructure** that `[Deflect]` (7 cards) and Commander Ledros need. Landing either makes
the other cheaper.

### 6. Chain-item targeting — counter / steal a spell — 3 cards
OGN-064 Wind Wall (minimal driver — build the spine against it), OGN-045 Defy (adds a cost
filter over chain items), OGN-080 Mystic Reversal (control transfer is cheap; retarget-at-
resolution is not). Needs a `TargetingSpec` kind naming a `spellChain` entry, a field to
carry it, and `counterSpell(entryId)` — **no zone move needed, spells trash at cast time**.
Must decide up front how `TriggerChainEntry` items are treated, since the Chain conversion
is actively adding non-spell items.

### 7. Continuous keyword auras — "other friendly units here have [X]" — 3 cards
OGN-015 Captain Farron, OGN-074 Taric, (+ OGN-100 Gemcraft Seer, same idea on the Vision
path). `CONDITIONAL_GRANTS` is self-grants only, and `effectiveKeywords` takes no location.
One source-keyed table + a `battlefieldId` parameter threaded through 3 callers.
**Related to the live bug above** — both are about granted keywords not being read.

### 8. Damage hooks — ~4 cards
Prevention/immunity (OGN-145, 189) and a damage-*application* hook (OGN-221, 254). Blocked
by the same structural fact: `dealDamage` and `combat.applyDamage` are two disjoint damage
sites, so any hook must be honoured at both.

### 9. Restriction / "can't" layer — 3 cards
OGN-018, 026, 070. No restriction/replacement mechanism exists anywhere. Two ride the
existing validator+enumerator pair; OGN-070's "spells and abilities can't ready" needs
source attribution on `readyUnit`/`readyPermanent` (~10 call sites, must exempt Awaken and
combat cleanup).

### 10. Long tail — 1 card each
Trash-resident listeners (OGN-252, 037 — `triggers.ts` already names this gap); buffs as a
count not a boolean (OGN-078, ~10 readers); trigger-multiplier in `dispatchOnUnitDied`
(OGN-236); board-conditional placement (OGN-193 — smallest gap on the list); Vision as a
board-derived property (OGN-100); armed cost charges (OGN-031, 032); extra turns (OGN-122);
combat excess-damage accounting (OGN-034); `[Backline]`-style assigned-last tier (OGN-068 —
the slot is already reserved in `assignmentOrder`); control-vs-ownership (OGN-203 — the only
true model change, lowest leverage per unit of risk).

---

## Rules calls needed before implementing (do not guess)

- **OGN-029 Falling Star** — `min: 2` (two mandatory instructions) or `min: 0` (this repo's
  "do as much as you can" convention)? At 2 the card is uncastable with no units.
- **OGN-244 Divine Judgment** — which runes does "2 runes" mean (channeled only, or
  channeled + rune deck)? Does a unit in play "recycled" go to the main deck bottom?
- **OGN-256 Fox-Fire** — all chosen units at ONE battlefield or across many? Printed or
  effective Might?
- **OGN-143 Pirate's Haven** — does "when you ready a friendly unit" include the Awaken
  step's mass ready (which bypasses `readyUnit` entirely)? This is the difference between a
  combo trigger and +1 Might to your whole board every turn.
- **OGN-227 Symbol of the Solari** — what is "a tie"? The engine has no such concept; both
  sides standing after damage, equal Might pools, and mutual annihilation are all candidates.
- **OGN-236 Karthus** — does "your Deathknell effects" mean units you control at time of
  death, or Deathknells you own? Two Karthuses = 3 triggers or 4?
- **OGN-045 Defy** — the `:rb_rune_rainbow:` numeral is not in the card JSON.

## Suggested order

1. ~~The **live Block/Tank bug**~~ — done 2026-08-02, see the correction above.
2. **Cluster 1** — 29 cards, no engine risk, and it more than triples the pool's working
   card count in one sweep.
3. **Cluster 2's `unitMoved` event** — 4 cards for one event + one integer, written as a
   Pending Item so it does not grow the Chain backlog.
4. Then pick between cluster 4 (multi-target — decide the selection model once, unblocks 7)
   and cluster 5 (cost pipeline — converges with `[Deflect]`, unblocks ~13 combined).
