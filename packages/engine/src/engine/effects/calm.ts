import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type {
  DeathknellEffect,
  DeathWatchDefinition,
  EventTriggerDefinition,
  GameEvent,
  Listener,
  SelfTriggerDefinition,
} from "../triggers.js";
import { isAttackingAt } from "../combat-designation.js";
import type { DecisionDefinition } from "../decisions.js";
import type { GameState, PlayerState } from "../../model/game-state.js";
import type { UnitInstance } from "../../model/card.js";
import type { AnyUnitLocation } from "../target-lookup.js";
import {
  addBuff,
  channelRunesExhausted,
  dealDamage,
  drawCards,
  exhaustGear,
  forceMoveToBattlefield,
  giveMightThisTurn,
  giveMightThisTurnToOwnUnit,
  grantKeywordThisTurn,
  grantTemporary,
  ownUnitsEverywhere,
  readyRunes,
  readyUnit,
  recallUnitToBase,
  returnCardFromTrash,
  returnUnitToHand,
  stunUnits,
  takeOneFromTopAndRecycleRest,
} from "../effect-helpers.js";
import { killGear } from "../triggers.js";
import { counterSpell, gainControlOfSpell } from "../counter-spell.js";
import { playCardIgnoringCost } from "../play-free.js";
import { effectiveMight } from "../effective-might.js";
import { findUnitAnywhere } from "../target-lookup.js";
import { holdCardsRecycled } from "../effect-helpers.js";
import { effectForCard } from "../card-effects.js";
import { spellsOnChain } from "../counter-spell.js";
import { eligibleTargets } from "../target-lookup.js";
import { offerTopOfDeckBanish } from "../top-of-deck.js";
import { parkDecision, type DecisionOption } from "../decisions.js";
import { gainPoints } from "../effect-helpers.js";
import { SAND_SOLDIER_TOKEN, placeToken } from "../token.js";

/**
 * Card implementations for **Calm** — one file, one owner.
 *
 * This file exists so that work on the card pool can be split up without two
 * people (or two agents) ever editing the same file. The ownership rule is
 * mechanical, not a convention: a defId may only appear here if its
 * CardDefinition has exactly one domain and that domain is Calm. A test in
 * test/effect-registry.test.ts enforces it, so a card filed in the wrong place
 * fails the suite rather than being merged and forgotten.
 *
 * Cards with TWO domains (the champion signature spells) belong in
 * effects/signature.ts, and Legends in engine/legend-abilities.ts — every Legend
 * is dual-domain by definition, so splitting those by domain is meaningless.
 *
 * To add a card:
 *   1. Register it under its defId in `cardEffects` (Spell/Gear) or
 *      `unitTriggers` (Unit's on-play ability), matching the shapes in
 *      card-effects.ts / unit-triggers.ts.
 *   2. Cite the rule or the oracle implementation the behaviour comes from —
 *      "mirrors <the Java oracle>" is not a rules citation, see
 *      docs/rules-conformance.md on why this project distinguishes them.
 *   3. Add an engine test. A silently-inert card is indistinguishable from a
 *      working one in play, which is exactly how the current gap went unnoticed.
 *
 * Composition rejects duplicates, so registering a defId that some other file
 * already handles throws at import rather than silently shadowing it.
 */
const FERAL_STRENGTH_MIGHT = 2;

export const cardEffects: Record<string, EffectDefinition> = {
  "SFD-031": {
    // Desert's Call — "[Repeat] [2] Play a 2 Might Sand Soldier unit token."
    //
    // **Rule 820.1.d's own worked example**, quoted in full: "Desert's Call is a
    // spell with [Repeat] [2] and 'Play a 2 [Might] Sand Soldier unit token.' If
    // its controller pays its Repeat cost as they play it, the card's instruction
    // to play a Sand Soldier is executed twice, as though the card says 'Play a 2
    // [Might] Sand Soldier unit token. Play a 2 [Might] Sand Soldier unit
    // token.'" So two tokens, from one play, and this resolver needs to know
    // nothing about that — card-effect-resolution.ts calls it twice.
    //
    // Placement follows Sprite Call exactly: base by default, and the
    // destination the caster named when there is one. Both executions read the
    // SAME `destinationBattlefieldId`, which is right — 820.1.d lets the second
    // execution make different CHOICES, and this card's instruction makes none;
    // where a played unit lands is 813's question, answered once for the play.
    targeting: { kind: "none" },
    resolve: (state, ctx, event) =>
      placeToken(
        state,
        ctx.casterIndex,
        event.destinationBattlefieldId !== undefined ? { battlefieldId: event.destinationBattlefieldId } : "base",
        SAND_SOLDIER_TOKEN,
      ),
  },
  "SFD-034": {
    // Feral Strength — "[Reaction] [Repeat] [2] Give a unit +2 Might this turn."
    //
    // "A unit", not "a unit at a battlefield", so 355.9.b puts a unit in either
    // base on the target list — the same reading Smoke Screen and En Garde take,
    // and no owner clause, so an enemy is a legal (if odd) target.
    //
    // Repeating this STACKS: +2 Might twice is +4, because `mightThisTurn`
    // accumulates. That is the opposite of what repeating Blood Rush does, and
    // the difference is 817.1.a — a KEYWORD's duplicate instances are redundant,
    // a numeric Might modifier is not a keyword and simply adds.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId ? giveMightThisTurn(state, event.targetUnitInstanceId, FERAL_STRENGTH_MIGHT) : state,
  },
  "OGN-062": {
    // Reinforce — "Look at the top 5 cards of your Main Deck. You may banish a
    // unit from among them, then play it, reducing its cost by [5 Energy].
    // Recycle the remaining cards."
    //
    // Baited Hook's shape (a decision over the top five, banish-and-play, recycle
    // the rest) with one difference that is the whole card: the unit is played at
    // a REDUCED cost rather than a free one.
    //
    // **DIVERGENCE, and it is the honest one to record**: the reduction is applied
    // as a THRESHOLD rather than as a payment. Only units whose Energy cost is
    // 5 or less are offered, and those are played for nothing; a 6-Energy unit is
    // not offered at all, where the rules would let it be played for 1.
    //
    // Paying a real cost inside a resolution is the thing this engine cannot do:
    // `DecisionOption.payment` is a declared field with zero producers and zero
    // consumers, and every decision-time payment in the pool is Power through
    // `payPowerFromChanneled`, which needs no choice. Reinforce is the first card
    // that would need Energy chosen mid-resolution. Recorded in
    // docs/rules-conformance.md; the threshold reading is strictly narrower than
    // the card, never wider, which is the safe direction.
    //
    // The POWER half of an expensive unit's cost is likewise waived rather than
    // paid — "reducing its cost by 5 Energy" says nothing about Power, so a unit
    // with a Power pip is genuinely being under-charged. Both halves of the
    // divergence point the same way and are recorded together.
    targeting: { kind: "none" },
    // Nocturne's offer FIRST, then the look question: the queue is FIFO, so "as
    // you look at me" is answered before "which of these do you banish", which
    // is the order the two texts read in.
    resolve: (state, ctx) =>
      parkDecision(offerTopOfDeckBanish(state, ctx.casterIndex, state.players[ctx.casterIndex].deck.slice(0, 5)), {
        kind: "OGN-062-banish",
        playerIndex: ctx.casterIndex,
      }),
  },
  "OGN-064": {
    // Wind Wall — "[Reaction] Counter a spell."
    //
    // The clean driver for the whole counter spine: no filter, no condition, and
    // the only reason it works at all is `[Reaction]` timing, which lets it be
    // cast onto an already-closed chain. It resolves BEFORE its target because
    // the chain is LIFO (343) — the counter goes on top and pops first.
    //
    // Uncastable with an empty chain rather than castable-and-inert. For a Spell
    // the targeting IS the effect, so "no legal target" really does mean "cannot
    // cast" — the rule card-effects.ts's own spec comment states, applied here.
    targeting: { kind: "chainSpell" },
    resolve: (state, _ctx, event) =>
      event.targetChainCardInstanceId ? counterSpell(state, event.targetChainCardInstanceId) : state,
  },
  "OGN-045": {
    // Defy — "[Reaction] Counter a spell that costs no more than [4] and no more
    // than [rainbow]."
    //
    // Wind Wall with a printed-cost filter, and the numeral took the CARD IMAGE
    // to settle: the rainbow pip is absent from the JSON's rich text and from its
    // accessibility text, and the rules PDF quotes the card the same way. Energy
    // prints as a NUMBERED glyph and Power as COUNTED PIPS — Defy's own cost
    // proves the convention, printing a "1" Energy circle above exactly one Calm
    // pip — so one unnumbered rainbow pip is **1 Power of any domain**. Written up
    // in docs/rules-calls-resolved.md, including the wrong first answer.
    //
    // "Of any domain" is a COUNT of pips, not a domain match, which is why the
    // filter is a number rather than a domain — a 1-Power Fury spell and a 1-Power
    // Calm spell are equally legal targets.
    targeting: { kind: "chainSpell", maxPrintedEnergy: 4, maxPrintedPower: 1 },
    resolve: (state, _ctx, event) =>
      event.targetChainCardInstanceId ? counterSpell(state, event.targetChainCardInstanceId) : state,
  },
  "OGN-080": {
    // Mystic Reversal — "[Reaction] Gain control of a spell. You may make new
    // choices for it."
    //
    // The FIRST sentence is implemented and the second is not, which is the
    // larger half rather than the easier one: taking control moves who "you" is
    // for the whole resolution, so a spell that draws now draws for the thief,
    // its on-spell-cast listeners fire for the thief's Legend, and the thief gets
    // priority for the fresh round of passes on it (345).
    //
    // "You may make new choices for it" is the second sentence, and it is a
    // question asked WHILE a resolution is suspended: the targets were fixed when
    // the spell was announced, so re-making them means offering the NEW
    // controller the original spec's candidate list mid-chain. That is what
    // `OGN-080-retarget` does, rebuilt from the stolen spell's own
    // `TargetingSpec` so a re-choice can never be something the spell could not
    // have chosen in the first place.
    //
    // **Scoped, and the scope is stated rather than implied:** only a spec of
    // kind `unit` is re-offered. The other kinds either name no choice at all
    // (`none`), or carry choices with their own group constraints (`unitList`'s
    // `maxTotalMight`, `unitSlots`' second-at-destination, `chainSpell`'s cost
    // filter) that are enforced at announce time by machinery this question
    // cannot reach. Offering those without the constraints would let a stolen
    // Fox-Fire kill a set it was never allowed to choose, which is worse than not
    // offering them. Recorded Unverified in docs/rules-conformance.md.
    targeting: { kind: "chainSpell" },
    resolve: (state, ctx, event) => {
      if (!event.targetChainCardInstanceId) return state;
      const stolen = gainControlOfSpell(state, event.targetChainCardInstanceId, ctx.casterIndex);
      // Asked only when there is a choice to re-make: a spell with no `unit`
      // target, or one whose only legal target is the one it already names, is
      // not a question.
      return retargetCandidates(stolen, ctx.casterIndex, event.targetChainCardInstanceId).length > 0
        ? parkDecision(stolen, {
            kind: "OGN-080-retarget",
            playerIndex: ctx.casterIndex,
            cardInstanceId: event.targetChainCardInstanceId,
          })
        : stolen;
    },
  },
  "OGN-043": {
    // Charm — "Move an enemy unit."
    //
    // Names no battlefield, so the unit can be taken from the enemy's base as
    // well as from a battlefield (355.9.b — the bare noun "unit" means objects on
    // the Board, and Bases are Public). Where it goes rides on
    // `destinationBattlefieldId`, the field a token-placing spell already uses.
    //
    // The move itself is `forceMoveToBattlefield`, not the MoveUnit executor, and
    // that is a rules distinction rather than plumbing — see its doc comment:
    // 415.1.b makes the exhaust a cost of the Standard MOVE ACTION, so a charmed
    // unit arrives ready, and 458 contests the destination for the moved unit's
    // controller rather than the caster's.
    targeting: { kind: "unit", owner: "enemy", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId && event.destinationBattlefieldId
        ? forceMoveToBattlefield(state, event.targetUnitInstanceId, event.destinationBattlefieldId)
        : state,
  },
  "OGN-053": {
    // Stand United — "[Hidden][Action] Buff a friendly unit. Buffs give an
    // additional +1 Might to friendly units this turn."
    //
    // The rules use THIS card as their worked example for rule 811's targeting
    // restriction: played from Hidden, the buff must choose a unit at that
    // battlefield, while the second half "affects all friendly units with buffs,
    // no matter where they are". So the restriction rides on the TARGET (handled
    // by legal-actions) and the board-wide half is written here with no location
    // check at all — which is what makes those two sentences behave differently.
    //
    // The second half is a modifier on what a Buff is WORTH, not a buff and not
    // a flat Might bonus: it scales with how many of your units are buffed, it
    // reaches units buffed later this turn, and it does nothing for an unbuffed
    // one. effectiveMight reads it; runEnd clears it.
    targeting: { kind: "unit", owner: "friendly" },
    resolve: (state, ctx, event) => {
      const buffed = event.targetUnitInstanceId ? addBuff(state, event.targetUnitInstanceId) : state;
      const players = [...buffed.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = { ...actor, extraMightPerBuffThisTurn: actor.extraMightPerBuffThisTurn + 1 };
      return { ...buffed, players };
    },
  },
  "OGN-058": {
    // Discipline — "[Reaction] Give a unit +2 Might this turn. Draw 1."
    //
    // scope: "anywhere", deliberately. The card says "a unit", NOT "a unit at a
    // battlefield", and rule 355.9.b settles what the bare noun means: unit
    // refers to objects on the Board unless the text says otherwise, and the
    // targeting section's own list of Public zones names Bases right alongside
    // Battlefield Zones. So a unit standing at home is a legal target — and so
    // is the OPPONENT's, since the text carries no owner restriction either
    // (pumping an enemy unit is a bad play, not an illegal one, and `owner` is
    // left unset rather than guessing "friendly"). Same reading Final Spark and
    // Stupefy already got; base is not a safe parking spot from this card.
    //
    // giveMightThisTurn, NOT addBuff. The two are not interchangeable: this
    // expires in the Expiration Step ("all 'this turn' effects expire
    // simultaneously", rule 317), which turn-manager.ts's runEnd gets for free
    // by zeroing every unit's mightThisTurn, whereas a Buff (rule 710) is a
    // persistent game object that would survive the turn and only come off when
    // the unit leaves play (rule 709).
    //
    // [Reaction] is rule 813 and is NOT implemented here — engine/timing.ts owns
    // when this may be played, including onto an already-closed chain. The
    // resolver is identical whenever it runs, so there is nothing timing-shaped
    // for this entry to do.
    //
    // Printed order: Might first, then the draw. Drawing on an empty deck takes
    // nothing rather than throwing — drawCards' documented Burn Out gap, not a
    // decision made here.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, event) =>
      drawCards(giveMightThisTurn(state, event.targetUnitInstanceId!, 2), ctx.casterIndex, 1),
  },
  "OGN-071": {
    // Party Favors — "Each other player chooses Cards or Runes. For each player
    // that chooses Cards, you and that player each draw 1. For each player that
    // chooses Runes, you and that player each channel 1 rune exhausted."
    //
    // Written for multiplayer and collapsed honestly to two players: "each other
    // player" is exactly one opponent, so this is one question with one answer,
    // and both halves pay out to the caster AND the chooser. The card is a
    // Group Hug — the opponent picks which resource you BOTH get, so the choice
    // is real and genuinely theirs.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      parkDecision(state, {
        kind: "OGN-071-choose",
        // Answered by the OPPONENT, which is the whole point — this is the
        // second card in the pool (after Cull the Weak) to ask the non-caster
        // something on the caster's turn.
        playerIndex: ctx.casterIndex === 0 ? 1 : 0,
      }),
  },
  "OGN-057": {
    // Block — "[Hidden][Action] Give a unit [Shield 3] and [Tank] this turn."
    //
    // Two grants, one numbered and one not, which is exactly the pair
    // grantKeywordThisTurn's `value` argument exists for: [Shield 3] is +3 while
    // DEFENDING (effective-might reads it only for the defending side), and
    // [Tank] is "must be assigned combat damage first" (combat.ts owns that).
    // Both are handled by the keyword machinery, so this entry is only the
    // granting.
    //
    // Hidden and played in a Showdown, this is the card's whole point: a
    // defender that suddenly absorbs the damage AND takes it first.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) => {
      const id = event.targetUnitInstanceId;
      if (!id) return state;
      return grantKeywordThisTurn(grantKeywordThisTurn(state, id, "Shield", 3), id, "Tank");
    },
  },
  "OGN-047": {
    // Find Your Center — "If an opponent's score is within 3 points of the
    // Victory Score, this costs 2 Energy less. Draw 1 and channel 1 rune
    // exhausted."
    //
    // Only the second sentence is here. The conditional discount is a COST and
    // therefore has to be known before the card is paid for, so it lives in
    // cost-modifiers.ts with the other cross-cutting reductions — the same split
    // Brazen Buccaneer's discount already takes.
    //
    // Exhausted, not Ready: the rune can pay Power this turn but no Energy until
    // the next Awaken, which is what makes "channel 1 exhausted" weaker than a
    // free rune.
    targeting: { kind: "none" },
    resolve: (state, ctx) => channelRunesExhausted(drawCards(state, ctx.casterIndex, 1), ctx.casterIndex, 1),
  },
  "OGN-050": {
    // Rune Prison — "[Action] Stun a unit."
    //
    // scope: "anywhere". "A unit", not "a unit at a battlefield" — rule 355.9.b
    // settles the bare noun as objects on the Board, and the targeting section
    // lists Bases among the Public zones. Same reading Discipline, Final Spark
    // and Stupefy already have. No owner restriction either: stunning your own
    // unit is a bad play, not an illegal one, so `owner` stays unset.
    //
    // [Action] is timing (engine/timing.ts), not something this entry does.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, event) =>
      event.targetUnitInstanceId ? stunUnits(state, ctx.casterIndex, [event.targetUnitInstanceId]) : state,
  },
  "OGN-069": {
    // Last Stand — "[Action] Double a friendly unit's Might this turn. Give it
    // [Temporary]."
    //
    // **EFFECTIVE Might, not printed**, and the card's own second sentence is
    // why: it hands you a unit that will die at your next Beginning Phase
    // (816), so the payoff has to be the unit's Might as it actually stands
    // when this resolves — buffs, this-turn pumps and continuous auras all
    // included. Reading `unit.might` would make Last Stand on a buffed,
    // aura-boosted attacker worth less than the board says it is worth. Same
    // reading, through the same `effectiveMight` choke point, that Gentlemen's
    // Duel takes for "damage equal to their Mights" and Stupefy takes for its
    // minimum-1 floor.
    //
    // `isCombat: false`, so `[Assault]`/`[Shield]` do not count. Those are
    // "while I'm attacking/defending" bonuses (817), i.e. properties of a fight
    // rather than of the unit, and this spell can be cast outside one — the same
    // reason rule 711's `isMighty` is asked with isCombat false.
    //
    // Doubling is a SNAPSHOT: `+M this turn` on a unit currently at M. A later
    // buff therefore lands on top rather than being doubled too, which is what
    // "double ... this turn" means at resolution (317's this-turn effects are
    // fixed amounts, not live multipliers). Recomputing on read would need a
    // multiplier layer in effective-might that no other card wants.
    //
    // "A friendly unit" with no battlefield named, so scope "anywhere"
    // (355.9.b) — sacrificing a unit at home for one big turn is the play.
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, _ctx, event) => {
      const id = event.targetUnitInstanceId;
      if (!id) return state;
      const location = findUnitAnywhere(state, id);
      if (!location) return state; // target left play between casting and resolution
      const doubled = giveMightThisTurn(state, id, effectiveMight(state, location.unit, location.ownerIndex, mightContext(state, location)));
      // Printed order: the Might first, then [Temporary]. Observable rather than
      // cosmetic — a 0-Might unit doubles to nothing and still becomes Temporary.
      return grantTemporary(doubled, id);
    },
  },
  "SFD-043": {
    // Emperor's Divide — "[Hidden][Action] Move any number of friendly units at
    // a battlefield to their base."
    //
    // "ANY NUMBER" is `min: 0`, which the unitList spec's own note settles: a
    // minimum of zero is what makes "up to" real, and it also makes the card
    // castable with nothing chosen — the same shape Fox-Fire has, and the same
    // reason (355 requires valid choices for all targets at announce, and zero
    // choices is a valid answer to "any number").
    //
    // "AT A BATTLEFIELD" is doing two jobs at once and both are load-bearing.
    // It is the default `scope`, so a unit sitting in base is not a legal choice
    // — this spell cannot move a unit that is already home. And it is `A`
    // battlefield, singular, so `sameBattlefield` groups the whole set at one
    // place; a divide that emptied two battlefields at once would be a different
    // (much better) card.
    //
    // `recallUnitToBase`, NOT `relocateToBaseUnchanged`, and the two are not
    // interchangeable: the card says MOVE, so the unit arrives exhausted and
    // Vilemaw's Lair's "units can't move from here to base" stops it. That is
    // rule 454's distinction — a Recall is not a Move — and Fight or Flight's
    // identical "move a unit from a battlefield to its base" already makes the
    // same call. Picking the other helper would silently make this better than
    // printed.
    //
    // [Hidden] and [Action] are timing (engine/timing.ts). Played from Hidden,
    // rule 811 restricts the choices to that battlefield's units, which
    // legal-actions enforces rather than this resolver.
    targeting: { kind: "unitList", min: 0, owner: "friendly", sameBattlefield: true },
    resolve: (state, _ctx, event) =>
      // Per chosen id, in the order chosen. A unit that has left play in the
      // meantime is skipped by the helper rather than throwing (422).
      (event.targetUnitInstanceIds ?? []).reduce((next, id) => recallUnitToBase(next, id), state),
  },
};

/** The `MightContext` for a unit `findUnitAnywhere` just located — the
 *  base-vs-battlefield branch three callers in this repo already write out by
 *  hand (Stupefy, En Garde, Gentlemen's Duel). Positional auras
 *  (Garen - Commander) resolve "base" from the omitted field. */
function mightContext(state: GameState, location: AnyUnitLocation): { isCombat: false; battlefieldId?: string } {
  return location.zone === "base"
    ? { isCombat: false }
    : { isCombat: false, battlefieldId: state.battlefields[location.zone.battlefieldIndex]!.id };
}

export const unitTriggers: Record<string, UnitTriggerDefinition> = {
  "OGN-044": {
    // Clockwork Keeper — "You may pay [1 Calm] as an additional cost to play me.
    // When you play me, if you paid the additional cost, draw 1."
    //
    // The pool's first OPTIONAL POWER additional cost, and it is the whole card:
    // a 2-Energy body, or a 2-Energy body and a card. The cost itself lives in
    // the cost pipeline (`OPTIONAL_POWER_COSTS`, enumerated as a second variant
    // and re-derived by the validator); all that is here is the payoff.
    //
    // Gated on the cost having been PAID, not on the card merely having the
    // option — the same reading Tasty Faefolk's `acceleratePaid` takes, and read
    // from the action for the same reason: by the time this runs, nothing about
    // the board records how the Keeper was paid for.
    targeting: { kind: "none" },
    resolve: (state, ctx, _unitId, event) => (event.optionalPowerPaid ? drawCards(state, ctx.casterIndex, 1) : state),
  },
  "OGN-075": {
    // Tasty Faefolk — "[Accelerate] — Channel 2 runes exhausted and draw 1."
    //
    // Gated on the ACCELERATE COST HAVING BEEN PAID, not on the card merely
    // having the keyword: 805 makes Accelerate a "you may pay" additional cost,
    // so a Faefolk played the cheap way enters exhausted and does nothing. The
    // flag rides on the action (`acceleratePaid`) because the choice is made
    // when the card is paid for, long before this resolver runs.
    targeting: { kind: "none" },
    resolve: (state, ctx, _unitId, event) =>
      event.acceleratePaid ? drawCards(channelRunesExhausted(state, ctx.casterIndex, 2), ctx.casterIndex, 1) : state,
  },
  "OGN-082": {
    // Whiteflame Protector — "When you play me, give a unit +8 Might this turn."
    //
    // Eight is enormous and the card names no owner and no battlefield, so scope
    // "anywhere" and either side is targetable. giveMightThisTurn, not a Buff:
    // it expires in the Expiration Step (317).
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, _unitId, event) =>
      event.targetUnitInstanceId ? giveMightThisTurn(state, event.targetUnitInstanceId, 8) : state,
  },
  "OGN-061": {
    // Poro Herder — "When you play me, if you control a Poro, buff me and
    // draw 1."
    //
    // "A PORO" is a tag, not a name: four cards carry it (Pouty Poro, Stalwart
    // Poro, Mystic Poro, Daring Poro), and the Herder himself is Freljord rather
    // than Poro — so he does not satisfy his own condition, which is the point
    // of the card.
    //
    // Checked across base and battlefields, since "control" is not positional.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId) => {
      const hasPoro = ownUnitsEverywhere(state, ctx.casterIndex).some((u) => (u.tags ?? []).includes("Poro"));
      return hasPoro ? drawCards(addBuff(state, unitId), ctx.casterIndex, 1) : state;
    },
  },
  "OGN-067": {
    // Blitzcrank - Impassive — "[Tank] When you play me to a battlefield, you may
    // move an enemy unit to here. When I hold, return me to my owner's hand."
    //
    // This clause is the middle one; `[Tank]` is the keyword engine's and the
    // hold is a `battlefieldHeld` listener below.
    //
    // **"To a battlefield"** — played to base, nothing happens at all. That is
    // why this reads `event.destination` rather than looking Blitzcrank up: it is
    // the one fact about the play that the board does not record.
    //
    // **"You MAY"**, so it parks a question rather than taking a target. A target
    // on the action would have made the grab compulsory whenever any enemy unit
    // existed, and the card is frequently better declined — dragging a body onto
    // your own battlefield is how you lose the hold this card's third clause is
    // built around.
    //
    // Nothing is asked when there is no enemy unit anywhere: 422's do-as-much-as-
    // you-can, and the same shape Adaptatron's gear check uses.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId, event) => {
      if (event.destination === "base") return state;
      const enemyIndex: 0 | 1 = ctx.casterIndex === 0 ? 1 : 0;
      if (ownUnitsEverywhere(state, enemyIndex).length === 0) return state;
      return parkDecision(state, {
        kind: "OGN-067-grab",
        playerIndex: ctx.casterIndex,
        // Blitzcrank's own battlefield, carried as the destination "here" means.
        // Taken from the play rather than re-derived at answer time, which is the
        // same reason the decision carries it at all — a question answered later
        // must not be able to drag a unit somewhere Blitzcrank never was.
        battlefieldId: event.destination.battlefieldId,
        cardInstanceId: unitId,
      });
    },
  },
  "OGN-051": {
    // Solari Shieldbearer — "When you play me, stun a unit."
    //
    // Same "a unit" reading as Rune Prison above, and for the same reason: the
    // text names no battlefield, so a unit in either base is a legal target.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, _unitId, event) =>
      event.targetUnitInstanceId ? stunUnits(state, ctx.casterIndex, [event.targetUnitInstanceId]) : state,
  },
  "SFD-032": {
    // Disarming Rake — "When you play me, you may kill a gear."
    //
    // Adaptatron's question without its "if you do" payoff, and it takes the
    // same two readings for the same reasons. "A GEAR" names no owner, so your
    // own is on offer too — this pool's gear includes Treasure Trove and
    // Scrapheap, which pay out when they die, so killing your own is a real play
    // rather than a mis-click waiting to happen. And it is routed through
    // `killGear` so those self-triggers actually fire.
    //
    // "You MAY", so it parks a question rather than taking a target: a target on
    // the action would make the kill compulsory whenever any gear existed.
    //
    // Nothing is asked with no gear anywhere — 422's do-as-much-as-you-can, and
    // a question with no answers must not be parked.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      state.players[0].activeGear.length + state.players[1].activeGear.length === 0
        ? state
        : parkDecision(state, { kind: "SFD-032-kill", playerIndex: ctx.casterIndex }),
  },
  "SFD-039": {
    // Royal Entourage — "When you play me, ready or exhaust a legend."
    //
    // The first card in the pool that touches a LEGEND's ready state from
    // outside the legend's own ability, and both halves are worth something:
    // readying your own buys a second use of its once-per-turn ability this
    // turn, and exhausting the opponent's denies theirs.
    //
    // "A LEGEND" carries no owner, so either seat's is a legal choice, and the
    // rules settle it with this card's own wording: 355.9.a's bare-noun list says
    // "'Legend' refers to a legend in the Legend Zone", and 355.10.b's worked
    // example is literally *"Ready a legend" targets a legend, because the Legend
    // Zone is Public* — with Legend Zones (plural) named among the Public zones.
    // No owner restriction anywhere, so exhausting theirs is as legal as readying
    // yours.
    //
    // **A DECISION rather than an announce-time target, and that is a divergence
    // worth naming.** Because it targets, 355 would have the legend chosen when
    // the Entourage is announced. There is no `legend` kind in TargetingSpec and
    // adding one is a card-effects.ts change; the same shape Adaptatron's "kill a
    // gear" and Blitzcrank's "move an enemy unit" already take, for the reason
    // decisions.ts records. Observable only through a Reaction cast in the window
    // between the play and the trigger resolving.
    //
    // MANDATORY: there is no "you may". Every board offers exactly two answers
    // (each legend is either ready or exhausted, so each contributes the one
    // change that would do something), which is also what stops
    // `advanceDecisions` answering it on the player's behalf.
    targeting: { kind: "none" },
    resolve: (state, ctx) => parkDecision(state, { kind: "SFD-039-legend", playerIndex: ctx.casterIndex }),
  },
  "SFD-053": {
    // Janna - Savior — "[Reaction] When you play me, heal your units here, then
    // move up to one enemy unit from here to its base."
    //
    // "HERE" is where she landed, so this reads `event.destination` rather than
    // looking her up — the same field, and the same reason, as Blitzcrank -
    // Impassive's "to here". Her [Reaction] timing (813, and the printed
    // permission to play her to a battlefield you control) is engine/timing.ts's;
    // nothing about it changes what this resolver does.
    //
    // Played to BASE she still heals — "your units here" is a real instruction
    // wherever she is, and 355.9.b makes a Base a place like any other — but the
    // second half asks nothing, because no enemy unit can be standing in your
    // base for her to move out of it.
    //
    // "HEAL", not "heal all units": only the caster's, and only at her location.
    // `healAllUnits` is the wrong helper twice over (it clears both players,
    // everywhere), so the clearing is written out here.
    //
    // "UP TO ONE", so declining is a real answer and leads the list. Moving an
    // enemy home un-contests the battlefield she just arrived at, which is
    // usually the point of casting her mid-showdown — but not always, since it
    // also hands that unit back ready to defend elsewhere.
    targeting: { kind: "none" },
    resolve: (state, ctx, _unitId, event) => {
      const battlefieldId = event.destination === "base" ? undefined : event.destination.battlefieldId;
      const healed = healOwnUnitsAt(state, ctx.casterIndex, battlefieldId);
      if (battlefieldId === undefined) return healed;
      const enemyIndex: 0 | 1 = ctx.casterIndex === 0 ? 1 : 0;
      const bf = healed.battlefields.find((b) => b.id === battlefieldId);
      // 422 again: with no enemy unit here there is nothing to move, so nothing
      // is asked.
      if ((bf?.units[healed.players[enemyIndex].id] ?? []).length === 0) return healed;
      return parkDecision(healed, { kind: "SFD-053-move", playerIndex: ctx.casterIndex, battlefieldId });
    },
  },
  "SFD-058": {
    // Ornn - Blacksmith's FIRST moment — "When you play me or when I hold, look
    // at the top 4 cards of your Main Deck. You may reveal a gear from among them
    // and draw it. Then recycle the rest."
    //
    // One ability with two triggers, so the body lives in `ornnLook` below and
    // the on-hold half registers separately in `eventTriggers`. Splitting the
    // text between the two entries instead would have let them drift.
    targeting: { kind: "none" },
    resolve: (state, ctx) => ornnLook(state, ctx.casterIndex),
  },
};

/** Janna - Savior's "heal your units HERE" — `playerIndex`'s units at
 *  `battlefieldId`, or in their base when she was played there.
 *
 *  Written out rather than reaching for `healAllUnits`, which is global on both
 *  axes this card is narrow on: it clears BOTH players and EVERY zone, and would
 *  quietly heal the enemy units Janna was cast to finish off. */
function healOwnUnitsAt(state: GameState, playerIndex: 0 | 1, battlefieldId: string | undefined): GameState {
  const heal = (u: UnitInstance): UnitInstance => (u.damage === 0 ? u : { ...u, damage: 0 });
  const ownerId = state.players[playerIndex].id;
  if (battlefieldId === undefined) {
    const players = [...state.players] as [PlayerState, PlayerState];
    players[playerIndex] = { ...players[playerIndex], baseUnits: players[playerIndex].baseUnits.map(heal) };
    return { ...state, players };
  }
  return {
    ...state,
    battlefields: state.battlefields.map((bf) =>
      bf.id === battlefieldId ? { ...bf, units: { ...bf.units, [ownerId]: (bf.units[ownerId] ?? []).map(heal) } } : bf,
    ),
  };
}

/**
 * Ornn - Blacksmith's ability, shared by his on-play and his on-hold trigger.
 *
 * Nocturne's offer is parked FIRST, and the queue being FIFO is what makes that
 * the right order: "as you LOOK AT me from the top of your deck" is answered
 * before "which gear do you take", which is the order the two texts read in.
 * Reinforce makes the same call for the same reason.
 *
 * An empty deck asks nothing at all rather than parking a question whose only
 * answer is "decline" — 422.
 */
function ornnLook(state: GameState, playerIndex: 0 | 1): GameState {
  const looked = state.players[playerIndex].deck.slice(0, 4);
  if (looked.length === 0) return state;
  return parkDecision(offerTopOfDeckBanish(state, playerIndex, looked), { kind: "SFD-058-gear", playerIndex });
}

/** "Recycle the top card" — the bottom of the Main Deck (416/1924), never the
 *  trash. Held through `holdCardsRecycled` so Karma - Channeler sees it, which
 *  is the whole reason this is not written as a bare deck rotation. */
function recycleTopCard(state: GameState, playerIndex: 0 | 1): GameState {
  const players = [...state.players] as [PlayerState, PlayerState];
  const owner = players[playerIndex];
  const top = owner.deck[0];
  if (!top) return state;
  players[playerIndex] = { ...owner, deck: [...owner.deck.slice(1), top] };
  return holdCardsRecycled({ ...state, players }, playerIndex, 1);
}

/** The cards Guardian of the Passage could take back — "a unit OR GEAR from
 *  your trash", so a Spell in there is not on offer. */
function trashUnitsAndGear(state: GameState, playerIndex: 0 | 1) {
  return state.players[playerIndex].trash.filter((c) => c.kind === "Unit" || c.kind === "Gear");
}

/**
 * "Are there no other friendly units HERE?" — the Poro's own reminder text, and
 * the rules' Special Terms definition it restates: "A unit is alone when there
 * are no other friendly units at the same location."
 *
 * LOCATION, not battlefield, so a death in base asks about the base. That is the
 * same bare-noun reading (355.9.b) that Discipline and Rune Prison take of "a
 * unit", applied to "here": a Base is a place on the Board like any other, and a
 * Poro that dies at home surrounded by its friends did not die alone.
 *
 * "OTHER friendly" needs no self-exclusion written out: `completeDeath` puts the
 * corpse in the trash BEFORE the [Deathknell] is held, so the dying unit is
 * already gone from whatever this counts.
 */
function noOtherFriendlyUnitsAt(state: GameState, ownerIndex: 0 | 1, battlefieldId: string | undefined): boolean {
  if (battlefieldId === undefined) return state.players[ownerIndex].baseUnits.length === 0;
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  return (bf?.units[state.players[ownerIndex].id] ?? []).length === 0;
}

/** [Deathknell] effects — rule 808, "When I die, [Effect]". Keyed by the DYING
 *  card's defId. Same one-file-one-owner rule as the registries above. */
export const deathTriggers: Record<string, DeathknellEffect> = {
  // Lonely Poro — "[Deathknell] — If I died alone, draw 1. (When I die, get the
  // effect. I'm alone if there are no other friendly units here.)" (rule 808)
  //
  // `ctx.casterIndex` is the DYING unit's controller — what "friendly" and "draw"
  // both mean for a Deathknell — and not whoever killed it. `death.battlefieldId`
  // is "here", captured when the Poro died and therefore still right even though
  // the corpse has since moved to the trash.
  //
  // **DIVERGENCE, and it is a real one rather than a theoretical one.** "I DIED
  // alone" is past tense: the rules note a dying unit's "location, attributes,
  // and other relevant information" as the [Deathknell] is added to the chain as
  // a Pending Item (Cleanup step 3a, and again under Kill Instruction), and
  // information a trigger condition references "is checked when the trigger
  // condition is fulfilled". This asks the question at RESOLUTION instead, which
  // is a chain-pop later.
  //
  // The two answers differ whenever a friendly unit leaves that location in
  // between, and the reachable case is a MUTUAL WIPE: combat.ts's
  // `processDefeated` kills the losing side's units one at a time, so a Poro that
  // died beside an ally reads as alone by the time its Deathknell pops and draws
  // a card the rules would not give it. Measured, not assumed — see the mutual-
  // death case in test/sfd-calm.test.ts.
  //
  // It is written this way because closing it needs a primitive that does not
  // exist: `DeathknellEffect` is a bare resolver with no `applies`/`capture` pair
  // (unlike `EventTriggerDefinition` and `DeathWatchDefinition`, both of which
  // have one), and `DeathContext` carries no room to note the answer. Giving it
  // one is a triggers.ts change. Deliberately NOT worked around by reading the
  // other deaths still sitting on the chain: that answer is placement-order
  // dependent — a Poro killed FIRST has its Deathknell at the bottom of the LIFO
  // chain and would see none of them — so it would be right by accident half the
  // time, which is worse than a divergence that is stated.
  "SFD-036": (state, ctx, death) =>
    noOtherFriendlyUnitsAt(state, ctx.casterIndex, death.battlefieldId) ? drawCards(state, ctx.casterIndex, 1) : state,
};

/** Listeners for board EVENTS other than a death (see triggers.ts's GameEvent).
 *  Keyed by the LISTENING card's defId. Same one-file-one-owner rule. */
/** Listeners for someone ELSE dying ("when a buffed friendly unit dies"), keyed
 *  by the LISTENING card's defId. Distinct from `deathTriggers` above, which is
 *  a [Deathknell] keyed by the DYING card. Same one-file-one-owner rule. */
export const deathWatchTriggers: Record<string, DeathWatchDefinition> = {};

/**
 * The friendly unit that is "attacking or defending ALONE" at this combat, or
 * `undefined` if the listener's controller has anything other than exactly one
 * unit there — Mask of Foresight's whole trigger condition, and the unit its
 * "give IT +1 Might" refers to.
 *
 * One function serving as both the `applies` predicate and the `capture`, so the
 * ability cannot trigger for one unit and then buff another. Splitting them into
 * a count check and a separate lookup is exactly the drift this shape prevents.
 */
function aloneAt(state: GameState, listener: Listener, event: GameEvent): string | undefined {
  if (event.kind !== "combatBegan") return undefined;
  const bf = state.battlefields.find((b) => b.id === event.battlefieldId);
  const mine = bf?.units[state.players[listener.ownerIndex].id] ?? [];
  if (mine.length !== 1) return undefined;
  // And the one unit must be gaining its designation NOW. A reinforcement
  // arriving mid-combat designates only itself (465 Step 1), and by then its
  // controller has two units there — so this is already false. The check matters
  // for the mirror case: an ARRIVAL that makes its controller's presence exactly
  // one, which happens when everything else there has died.
  return event.designated.includes(mine[0]!.instanceId) ? mine[0]!.instanceId : undefined;
}

/**
 * How many ENEMY units `ownerIndex` themselves just stunned — Eclipse Herald's
 * whole condition, and the number his "+1 Might" is multiplied by.
 *
 * One function for the predicate and the payout, so the ability cannot trigger
 * for a count it then fails to use. Reads only the event and the listener's
 * owner, which is what makes it safe to ask at fire time: neither can be changed
 * by the response window the hold opens.
 */
function enemiesStunnedFor(ownerIndex: 0 | 1, event: GameEvent): number {
  if (event.kind !== "unitsStunned" || event.stunnerIndex !== ownerIndex) return 0;
  return event.stunned.filter((s) => s.ownerIndex !== ownerIndex).length;
}

export const eventTriggers: Record<string, EventTriggerDefinition> = {
  "OGN-066": {
    // Ahri - Alluring — "When I hold, you score 1 point."
    //
    // "When **I** hold" is the positional reading Adaptatron and Sett - Brawler
    // take of their own "when I conquer": the battlefield being held has to be the
    // one Ahri is standing at, not merely one her controller held somewhere. The
    // event carries a battlefield for exactly that reason.
    //
    // She therefore DOUBLES a hold: `scoreHolds` has already awarded the ordinary
    // point for the battlefield by the time this fires, and this is a second one.
    // That is the card — a 5-Energy 4-Might Champion-adjacent body whose whole
    // text is "the battlefield I am standing on is worth two".
    //
    // **A plain `points + 1`, deliberately NOT routed through `recordConquest`**,
    // for the reason Yasuo - Windrider's entry sets out: rule 474's Final Point
    // restriction applies only to a point gained "through a Conquer", and sending
    // this down that path would silently withhold a winning point unless every
    // battlefield had been scored that turn.
    on: "battlefieldHeld",
    // Both conditions are fixed at fire time. The location one especially: this
    // trigger is held, and the window it opens is precisely when an opponent
    // could move or kill Ahri — re-asking at resolution would let them cancel a
    // point that has already been earned.
    applies: (_state, listener, event) =>
      event.kind === "battlefieldHeld" && event.holderIndex === listener.ownerIndex && listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldHeld") return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      // Through `gainPoints`, the single choke point every point-gain goes through
      // so Tianna Crownguard's "opponents can't gain points" reaches it.
      return gainPoints({ ...state, players }, listener.ownerIndex, 1);
      return { ...state, players };
    },
  },
  "OGN-067": {
    // Blitzcrank - Impassive's third clause — "When I hold, return me to my
    // owner's hand."
    //
    // A drawback, and a printed one: he is a 5-Might [Tank] who cannot keep a
    // battlefield he has taken. The point still SCORES — `scoreHolds` has already
    // awarded it by the time this fires — so the card is a body that trades
    // itself for a point and comes back to be replayed.
    //
    // "When **I** hold" is the same positional reading Ahri - Alluring takes
    // above: the battlefield held has to be the one he is standing at.
    //
    // `returnUnitToHand` rather than a recall: "to my owner's HAND" is leaving
    // play (709 strips the buff, damage and this-turn Might reset), which is what
    // makes replaying him a fresh on-play trigger rather than a repositioning.
    on: "battlefieldHeld",
    applies: (_state, listener, event) =>
      event.kind === "battlefieldHeld" && event.holderIndex === listener.ownerIndex && listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => (event.kind === "battlefieldHeld" ? returnUnitToHand(state, listener.card.instanceId) : state),
  },
  "OGN-073": {
    // Sona - Harmonious — "At the end of your turn, if I'm at a battlefield,
    // ready up to 4 friendly runes."
    //
    // The first permanent in the pool to watch the End Phase; Annie - Dark
    // Child's "ready up to 2 runes" is the same moment on a Legend, and both now
    // ready through the one `readyRunes` in effect-helpers.ts rather than two
    // copies of "up to".
    //
    // **"Your turn" is read from the EVENT, never from `state.activePlayerIndex`.**
    // `endOfTurn` is held as a Chain Pending Item (383) and `submit`'s Pass runs
    // End and the next Start-of-Turn as one action, so by the time this resolves
    // the turn has rotated and the active player is the opponent. Asking the
    // board would make Sona fire on exactly the turns she should not.
    //
    // "Up to 4" is not offered as a choice, for the reason `readyRunes` gives:
    // readying is strictly beneficial, so maxing it is the faithful reading
    // rather than a shortcut. "FRIENDLY runes" is her controller's pool, which is
    // the only pool the helper can reach.
    on: "endOfTurn",
    // Both conditions are settled at fire time and deliberately NOT re-asked in
    // `resolve`. "If I'm at a battlefield" is a fire-time condition in the same
    // family as Adaptatron's location check: the window this hold opens is
    // precisely when an opponent could move or kill Sona, and re-asking would let
    // them cancel an ability that has already triggered. 383 fixes triggering at
    // the moment of the event.
    applies: (_state, listener, event) =>
      event.kind === "endOfTurn" && event.playerIndex === listener.ownerIndex && listener.battlefieldId !== undefined,
    resolve: (state, listener, event) => (event.kind === "endOfTurn" ? readyRunes(state, listener.ownerIndex, 4) : state),
  },
  "OGN-060": {
    // Mask of Foresight — "When a friendly unit attacks or defends alone, give it
    // +1 Might this turn." See `aloneAt` above for the unit it means.
    //
    // An EVENT, not a continuous modifier, and the difference is the whole card:
    // "+1 this turn" is granted once and keeps its value for the rest of the turn
    // even after the unit stops being alone — a reinforcement arriving later does
    // not take it back. Wielder of Water's superficially similar "while I'm
    // attacking or defending alone" IS continuous and lives in effective-might.ts;
    // the two must not be confused.
    //
    // "Attacks OR defends" — either side, so this asks only whether the
    // controller's own presence at that battlefield is exactly one unit. Which
    // side started it does not matter and is deliberately not consulted.
    //
    // The one card in the pool that needs `capture`, and it needs it for a reason
    // that only appears once the trigger is held. "ALONE" is a fire-time
    // condition (383), so it belongs in `applies` — but the ability is then about
    // THAT unit, and by the time it resolves the response window may have brought
    // a second unit in or killed the one it fired for. Re-deriving "my only unit
    // here" at resolution buffs a reinforcement the card never triggered for; the
    // instance id is noted instead, which is 809.1.b.3's "note its attributes"
    // applied to the one attribute this ability is about.
    //
    // A Gear listener, so it has no `battlefieldId` of its own — hence reading
    // the event's, not the listener's.
    on: "combatBegan",
    applies: (state, listener, event) => aloneAt(state, listener, event) !== undefined,
    capture: aloneAt,
    resolve: (state, listener, event, captured) => {
      if (event.kind !== "combatBegan" || typeof captured !== "string") return state;
      // No presence re-check: it left play, or it did not, and `giveMightThisTurn`
      // already answers for a unit it cannot find (422's do as much as you can).
      return giveMightThisTurn(state, captured, 1);
    },
  },
  "OGN-059": {
    // Eclipse Herald — "When you stun an enemy unit, ready me and give me
    // +1 Might this turn."
    //
    // The rules use this card as their own worked example for why stunning an
    // already-stunned unit is not a stunning (422), so the guard it needs is not
    // written here at all: `stunUnits` drops those before the event exists.
    //
    // "AN enemy unit", singular — so this pays out once per qualifying unit in
    // the batch rather than once per instruction (which is Leona - Radiant
    // Dawn's "one or more" wording, deliberately different). Readying twice is
    // idempotent; the Might is not, and +2 for two enemies is the literal read.
    //
    // Both halves of "you ... enemy" are measured against the HERALD's
    // controller: `stunnerIndex` must be the listener, and the victim must not
    // be. A Herald does not celebrate its own controller's units being stunned,
    // nor the opponent stunning something.
    on: "unitsStunned",
    // Both halves of "you ... enemy" are fire-time conditions, so they decide
    // whether a Pending Item exists rather than being re-asked at resolution —
    // and they can be, because each reads only the EVENT and the listener's
    // owner, neither of which the response window can change.
    applies: (_state, listener, event) => enemiesStunnedFor(listener.ownerIndex, event) > 0,
    resolve: (state, listener, event) => {
      if (event.kind !== "unitsStunned") return state;
      const enemiesStunned = enemiesStunnedFor(listener.ownerIndex, event);
      if (enemiesStunned === 0) return state;
      const readied = readyUnit(state, listener.card.instanceId);
      return giveMightThisTurnToOwnUnit(readied, listener.ownerIndex, listener.card.instanceId, enemiesStunned);
    },
  },
  "OGN-056": {
    // Adaptatron — "When I conquer, you may kill a gear. If you do, buff me."
    //
    // "When *I* conquer" is Kai'Sa - Survivor's and Sett - Brawler's reading:
    // the Adaptatron has to be AT the battlefield taken, which is what separates
    // a unit's conquer trigger from a Legend's "when you conquer". Checked
    // against the listener's own location rather than the event alone, since the
    // listener walk reaches it wherever it stands.
    //
    // "A gear", with no owner printed — so YOUR gear is a legal choice too, and
    // that is the card rather than an oversight: this pool's gear includes
    // Treasure Trove and Scrapheap, which pay out when they die. Routed through
    // `killGear` so those self-triggers fire, exactly as Thermo Beam does.
    on: "battlefieldConquered",
    // `battlefieldConquered` is held as a Chain Pending Item (383), so the two
    // conditions that decide whether this TRIGGERED are asked here, before it
    // reaches the chain.
    //
    // The gear check below is deliberately NOT one of them. "When I conquer" is
    // the trigger; whether there is a gear to kill is a question about the board
    // at RESOLUTION, and 383 fixes triggering at the moment of the event. A
    // trigger that fires and then resolves to nothing is the rules working — it
    // is not the same as never having triggered, which is the distinction holding
    // makes observable for the first time.
    //
    // The location check is here and not repeated in `resolve` for the reason
    // Sett - Brawler's entry sets out: the window this hold opens is exactly when
    // the Adaptatron could be moved off the battlefield it took.
    applies: (_state, listener, event) =>
      event.kind === "battlefieldConquered" &&
      event.conquerorIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldConquered") return state;
      if (event.conquerorIndex !== listener.ownerIndex) return state;
      // "You MAY" — but a question with no answers must not be parked (422's do
      // as much as you can). With no gear anywhere the buff is unreachable, so
      // nothing is asked and nothing happens.
      if (state.players[0].activeGear.length + state.players[1].activeGear.length === 0) return state;
      return parkDecision(state, {
        kind: "OGN-056-kill",
        playerIndex: listener.ownerIndex,
        // "Buff ME" — carried rather than re-derived, because by the time the
        // answer comes in the Adaptatron may have left the battlefield it
        // conquered, or play entirely.
        cardInstanceId: listener.card.instanceId,
      });
    },
  },
  "OGN-076": {
    // Yasuo - Remorseful — "When I attack, deal damage equal to my Might to an
    // enemy unit here."
    //
    // **An Attack Trigger fires when the unit GAINS THE ATTACKER DESIGNATION**,
    // which rule 383.4's Attack Triggers section states outright ("trigger when a
    // Unit or Player gains the Attacker designation for the first time during a
    // combat"), and rule 465's Combat Step 1 is where that happens: "The Attacker
    // is the player whose unit(s) applied the Contested status... Units at the
    // Contested Battlefield controlled by the Attacker or Defender gain the
    // Attacker or Defender designation now." So the moment is the COMBAT
    // SHOWDOWN OPENING, not the move that contested the battlefield.
    //
    // He was the first card written this way, and the rest of the "when I attack"
    // family has now joined him: unit-triggers.ts's ATTACK_TRIGGERS register
    // against this same event through one shared adapter, so all eight of them
    // and Yasuo answer "am I attacking?" with the same `isAttackingAt`. They used
    // to be dispatched inside the move/play executor, one per unit that just
    // landed — earlier than the rules' moment, and blind to a unit that was
    // already standing there when a friend walked in and started the fight. 465
    // gives that unit the Attacker designation too, so Yasuo holding a
    // battlefield that his own reinforcement contests really does attack.
    on: "combatBegan",
    // The designation is fixed when the combat opens (383), so it is asked here
    // and NOT re-asked below — moving him away during the response window must
    // not cancel an ability that has already triggered.
    applies: isAttackingAt,
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      if (listener.card.kind !== "Unit") return state;
      const bf = state.battlefields.find((b) => b.id === event.battlefieldId);
      if (!bf) return state;
      // "An enemy unit HERE" — the first one at this battlefield, in board order.
      // Auto-selected rather than asked, the same simplification (and the same
      // structural reason: no action to hang the choice on) that Crackshot
      // Corsair and Leona - Determined already make for their on-attack targets.
      const ownerId = state.players[listener.ownerIndex].id;
      const enemyId = Object.entries(bf.units)
        .filter(([id]) => id !== ownerId)
        .flatMap(([, units]) => units.map((u) => u.instanceId))[0];
      if (enemyId === undefined) return state;
      // "MY Might" read through effectiveMight with `isCombat: false`, so buffs,
      // this-turn pumps and continuous auras count but `[Assault]`/`[Shield]` do
      // not. This is a damage instruction rather than combat damage — combat.ts
      // owns that separately, and counting Assault here would pay it twice in the
      // same fight. Same call Gentlemen's Duel makes for "damage equal to their
      // Mights".
      const might = effectiveMight(state, listener.card, listener.ownerIndex, {
        isCombat: false,
        battlefieldId: event.battlefieldId,
      });
      return dealDamage(state, listener.ownerIndex, enemyId, might);
    },
  },
  "SFD-035": {
    // Guardian of the Passage — "When I hold, you may return a unit or gear from
    // your trash to your hand."
    //
    // "When **I** hold" is the positional reading Ahri - Alluring and Blitzcrank
    // - Impassive already take: the battlefield held has to be the one the
    // Guardian is standing at, not merely one his controller held somewhere.
    //
    // Both conditions are settled at fire time and deliberately not re-asked in
    // `resolve` — the window this hold opens is exactly when an opponent could
    // move or kill him, and 383 fixes triggering at the moment of the event.
    //
    // Whether the trash has anything to take back is NOT one of them: that is a
    // question about the board at RESOLUTION, so it belongs below. A trigger that
    // fires and then finds nothing is the rules working.
    on: "battlefieldHeld",
    applies: (_state, listener, event) =>
      event.kind === "battlefieldHeld" &&
      event.holderIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldHeld") return state;
      // "You MAY" — but a question with no answers must not be parked (422).
      if (trashUnitsAndGear(state, listener.ownerIndex).length === 0) return state;
      return parkDecision(state, { kind: "SFD-035-return", playerIndex: listener.ownerIndex });
    },
  },
  "SFD-038": {
    // Ribbon Dancer — "When I move to a battlefield, give another friendly unit
    // +1 Might this turn."
    //
    // A `unitMoved` listener watching for ITSELF, which is Yasuo - Windrider's
    // shape and not the per-card `ON_MOVE_TRIGGERS` table's. Both are placed by
    // the same line of `executeMoveUnit`, so the two mechanisms fire at exactly
    // the same moment; this one is reachable from a per-domain file, which the
    // table is not.
    //
    // "TO A BATTLEFIELD" is written out even though a Standard Move in this
    // engine always has a battlefield as its destination (`MoveUnitAction`
    // carries `destinationBattlefieldId`, and moving home is a Recall rather
    // than a Move — 454). It is the card's own condition, and a check that is
    // currently always true is cheaper to keep than to rediscover.
    //
    // "ANOTHER friendly unit" carries no location word, so 355.9.b's bare-noun
    // reading applies and a unit at home is a legal choice — pumping a defender
    // in base is exactly what this is for when the Dancer walks in alone.
    //
    // giveMightThisTurn, not a Buff: it expires in the Expiration Step (317).
    on: "unitMoved",
    applies: (_state, listener, event) =>
      event.kind === "unitMoved" && event.unitInstanceId === listener.card.instanceId && event.to !== "base",
    resolve: (state, listener, event) => {
      if (event.kind !== "unitMoved") return state;
      // MANDATORY — no "you may" — so there is no decline option. With no other
      // friendly unit anywhere there is nobody to give it to and nothing is
      // asked (422); "ANOTHER" is what makes that case reachable at all.
      if (ribbonDancerCandidates(state, listener.ownerIndex, listener.card.instanceId).length === 0) return state;
      return parkDecision(state, {
        kind: "SFD-038-might",
        playerIndex: listener.ownerIndex,
        // "ANOTHER" — the Dancer herself, carried so the answer-time candidate
        // list can exclude her even if she has moved again since.
        cardInstanceId: listener.card.instanceId,
      });
    },
  },
  "SFD-041": {
    // Apprentice Smith — "When I move, reveal the top card of your Main Deck. If
    // it's a gear, draw it. Otherwise, recycle it."
    //
    // Same self-watching `unitMoved` shape as Ribbon Dancer above, minus her
    // destination condition: "when I move" full stop.
    //
    // Nothing is revealed from an empty deck, so nothing happens — deliberately
    // NOT a Burn Out. `drawCards` runs 431 because a card was drawn and could
    // not be; this card only draws once it has already seen a gear on top, so
    // an empty deck never reaches the draw at all.
    //
    // "RECYCLE it" is the bottom of the Main Deck (1924), which is what makes
    // the Smith a repeatable filter rather than self-mill: the same card comes
    // back around eventually.
    on: "unitMoved",
    applies: (_state, listener, event) => event.kind === "unitMoved" && event.unitInstanceId === listener.card.instanceId,
    resolve: (state, listener, event) => {
      if (event.kind !== "unitMoved") return state;
      const top = state.players[listener.ownerIndex].deck[0];
      if (!top) return state;
      // "If it's a GEAR, DRAW it" — the card revealed is the top one, so the
      // ordinary draw takes exactly it.
      const after = top.kind === "Gear" ? drawCards(state, listener.ownerIndex, 1) : recycleTopCard(state, listener.ownerIndex);
      // "As you look at or REVEAL me" (Nocturne), raised AFTER rather than
      // before because this reveal consumes the card immediately and nothing
      // here stops to ask — the same ordering Dazzling Aurora uses, and his
      // decision banishes the card from wherever it has since ended up.
      return offerTopOfDeckBanish(after, listener.ownerIndex, [top]);
    },
  },
  "SFD-047": {
    // Simian Ancestor — "When you buff me, ready me."
    //
    // A 5-Energy 5-Might body that can attack and then be untapped by any of the
    // pool's buffs, which is why it reads on the BUFF rather than on the pump: a
    // Buff is a persistent game object (710) and this fires as one is PLACED.
    //
    // Fires only for a buff that was really placed. 708 makes a second Buff on an
    // already-buffed unit a no-op, and `addBuff` already drops the event in that
    // case — so a second Stand United does not ready him again. That is the rule
    // rather than an optimisation here, and it is the reason this card is not a
    // free untap engine.
    //
    // **"When YOU buff me" is read as "when I am buffed", and that is the
    // event's shape rather than a choice made here**: `unitBuffed` carries whose
    // UNIT it is and deliberately no causer (see its own note). The two come
    // apart only if an opponent could buff your unit, which no card in this pool
    // does — the day one does, the event needs the field, not this entry.
    //
    // `readyUnit` no-ops on an already-ready Ancestor, which is 415 and is what
    // keeps the `unitReadied` event honest.
    on: "unitBuffed",
    applies: (_state, listener, event) =>
      event.kind === "unitBuffed" &&
      event.unitInstanceId === listener.card.instanceId &&
      event.ownerIndex === listener.ownerIndex,
    resolve: (state, listener) => readyUnit(state, listener.card.instanceId),
  },
  "SFD-048": {
    // Stellacorn Herder — "When I move, draw 1."
    //
    // The plainest member of the self-watching `unitMoved` family; see Ribbon
    // Dancer above for why these are event listeners rather than entries in
    // unit-triggers.ts's per-card move table.
    on: "unitMoved",
    applies: (_state, listener, event) => event.kind === "unitMoved" && event.unitInstanceId === listener.card.instanceId,
    resolve: (state, listener) => drawCards(state, listener.ownerIndex, 1),
  },
  "SFD-057": {
    // Irelia - Fervent — "[Deflect] When you choose or ready me, give me
    // +1 Might this turn."
    //
    // **WHOLE as of 2026-08-06.** The comment here used to say the choose half
    // "cannot be [written] from this file", and named exactly what it needed: a
    // `unitChosen` GameEvent fired from BOTH choosing paths. That is now in
    // triggers.ts, raised by `holdUnitsChosen` from `execute-play-card` (Spells)
    // and `execute-activate-ability` (abilities).
    //
    // It is a second event rather than a widening of
    // `battlefield-abilities.unitChosenBySpell`, for the three reasons that
    // comment listed: the old one is keyed to a BATTLEFIELD so it cannot reach a
    // unit listener, it never saw an ability choosing her, and it drops a unit
    // standing in base. The Dreaming Tree wants all three restrictions; she
    // wants none of them.
    //
    // "When YOU choose me" is her CONTROLLER choosing, not an opponent — which
    // is the sentence `[Deflect]` exists alongside rather than in tension with:
    // an opponent may still pay the rainbow to choose her, and she simply does
    // not grow from it.
    //
    // The ready half is not a consolation prize — `unitReadied` includes the
    // Awakening Phase's mass ready (415, and the event's own note), so a
    // returning Irelia is a 5-Might attacker on the turn after she is spent.
    //
    // Fires only for a ready that actually happened: `readyUnit` refuses an
    // already-ready unit (415), so the event never exists for a no-op.
    on: ["unitReadied", "unitChosen"],
    applies: (_state, listener, event) =>
      event.kind === "unitReadied"
        ? event.unitInstanceId === listener.card.instanceId && event.ownerIndex === listener.ownerIndex
        : event.kind === "unitChosen" &&
          event.unitInstanceId === listener.card.instanceId &&
          // "YOU choose", so her own side only.
          event.chooserIndex === listener.ownerIndex,
    // Both moments pay the same +1, so one resolver serves both — and it is
    // deliberately NOT capped: choosing her twice with one spell is two choices
    // (two `unitChosen` events), and the card says nothing about once per turn.
    resolve: (state, listener) => giveMightThisTurnToOwnUnit(state, listener.ownerIndex, listener.card.instanceId, 1),
  },
  "SFD-058": {
    // Ornn - Blacksmith's SECOND moment — "when I hold". See his on-play entry
    // in `unitTriggers` for the ability itself; both call `ornnLook`.
    //
    // "When **I** hold" is positional, like Ahri - Alluring's and the Guardian's
    // above: the battlefield held has to be the one Ornn is standing at. Settled
    // at fire time so the window this opens cannot be used to move him off it.
    on: "battlefieldHeld",
    applies: (_state, listener, event) =>
      event.kind === "battlefieldHeld" &&
      event.holderIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => (event.kind === "battlefieldHeld" ? ornnLook(state, listener.ownerIndex) : state),
  },
};

/** The units Ribbon Dancer's "give ANOTHER friendly unit" may name — hers,
 *  anywhere (355.9.b), minus herself. One function for the fire-time "is there
 *  anybody to give it to" check and for the option list, so the two cannot
 *  disagree about what "another" means. */
function ribbonDancerCandidates(state: GameState, ownerIndex: 0 | 1, selfInstanceId: string): UnitInstance[] {
  return ownUnitsEverywhere(state, ownerIndex).filter((u) => u.instanceId !== selfInstanceId);
}

/** Triggers a card fires about ITSELF — being played, discarded or killed. Keyed
 *  by that card's own defId, because at those moments it may not be in play for
 *  a listener walk to reach (see triggers.ts's SelfTriggerDefinition). */
export const selfTriggers: Record<string, SelfTriggerDefinition> = {
  "OGN-063": {
    // Spirit's Refuge — "When you play this, buff a friendly unit."
    //
    // A SELF-trigger, like Forge of the Future (OGN-212): a Gear entering play is
    // not something the listener walk reaches for its own arrival. Gear has no
    // targeting of its own on the PlayCard action (no Gear is registered in
    // cardEffects, and the executor's Gear branch only moves it to activeGear),
    // so WHICH unit is buffed is asked as a decision — the same shape, and for
    // the same reason, as Vanguard Helm's "buff another friendly unit".
    //
    // The card's SECOND sentence — "Friendly buffed units have [Deflect] if they
    // didn't already" — is deliberately NOT written here. `[Deflect]` has no
    // implementation anywhere in the engine, so granting it would be a no-op
    // dressed up as an implementation; coverage.ts keeps the card honestly
    // reported as partial until the keyword lands.
    on: ["played"],
    resolve: (state, event) =>
      // "Do as much as you can" (422): with no friendly unit anywhere there is
      // nothing to buff, and a question with no answers must not be parked.
      ownUnitsEverywhere(state, event.ownerIndex).length === 0
        ? state
        : parkDecision(state, { kind: "OGN-063-buff", playerIndex: event.ownerIndex }),
  },
};

/** Questions this domain's cards stop to ask — see engine/decisions.ts. Keyed by
 *  a `kind` string rather than a defId, since one card can ask more than one
 *  kind of question; the one-file-one-owner rule still applies, and the key is
 *  prefixed with the card's defId so ownership stays readable. */
/** The units among the top five that Reinforce could play — those whose printed
 *  Energy cost the card's 5-Energy reduction covers entirely. See the card's own
 *  note for why this is a threshold rather than a discount. */
function reinforceCandidates(state: GameState, playerIndex: 0 | 1) {
  return state.players[playerIndex].deck
    .slice(0, 5)
    .filter((c) => c.kind === "Unit" && c.energyCost <= 5);
}

export const decisions: Record<string, DecisionDefinition> = {
  /**
   * Mystic Reversal's "you may make new choices for it" — see her effect above
   * for what is and is not re-offered.
   *
   * The candidates are rebuilt from the STOLEN spell's own spec against LIVE
   * state, not from whatever was legal when it was announced: the board has
   * moved on (that is why the Reversal was cast), and a re-choice has to be one
   * the spell could make now.
   */
  "OGN-080-retarget": {
    prompt: (state, d) => {
      const stolen = d.cardInstanceId ? spellOnChain(state, d.cardInstanceId) : undefined;
      return `Mystic Reversal: make new choices for ${stolen?.entry.card.name ?? "the stolen spell"}?`;
    },
    options: (state, d) => {
      if (!d.cardInstanceId) return [];
      const candidates = retargetCandidates(state, d.playerIndex, d.cardInstanceId);
      if (candidates.length === 0) return [];
      // "You MAY" — keeping the original choice leads, as everywhere else.
      return [
        { id: "keep", label: "Keep its original choices" },
        ...candidates.map((u) => ({ id: u.instanceId, label: `Re-aim at ${u.name}`, instanceId: u.instanceId })),
      ];
    },
    resolve: (state, d, optionId) => {
      if (optionId === "keep" || !d.cardInstanceId) return state;
      const stolen = spellOnChain(state, d.cardInstanceId);
      if (!stolen) return state;
      const spellChain = [...state.spellChain];
      spellChain[stolen.index] = { ...stolen.entry, targetUnitInstanceId: optionId };
      return { ...state, spellChain };
    },
  },
  // Reinforce's "you may banish a unit from among them, then play it".
  //
  // Declining leads, as everywhere else. The recycle happens either way — "recycle
  // the remaining cards" is a separate instruction from the banish-and-play, the
  // same structure Baited Hook has.
  "OGN-062-banish": {
    prompt: () => "Reinforce: banish a unit from the top 5 and play it?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...reinforceCandidates(state, d.playerIndex).map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId })),
    ],
    resolve: (state, d, optionId) => {
      const top5 = state.players[d.playerIndex].deck.slice(0, 5);
      const chosen = optionId === "decline" ? undefined : reinforceCandidates(state, d.playerIndex).find((c) => c.instanceId === optionId);

      // Recycle FIRST, so the deck arithmetic is done against the five that were
      // actually looked at — whatever was banished-and-played is simply not among
      // them. Baited Hook's decision makes the same call.
      const rest = top5.filter((c) => c.instanceId !== chosen?.instanceId);
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        deck: [...players[d.playerIndex].deck.slice(top5.length), ...rest],
      };
      // Karma - Channeler watches every recycle in this engine, including the
      // ones written inline like this one — `rest` is what actually moved.
      const recycled = holdCardsRecycled({ ...state, players }, d.playerIndex, rest.length);
      return chosen ? playCardIgnoringCost(recycled, d.playerIndex, chosen) : recycled;
    },
  },
  // Blitzcrank - Impassive's "you may move an enemy unit to here", raised by his
  // on-play trigger, which has already established that he was played TO a
  // battlefield and that some enemy unit exists.
  //
  // "AN ENEMY UNIT" carries no location word, so 355.9.b's bare-noun reading
  // applies and a unit sitting in the opponent's base is a legal grab — which is
  // the interesting half of the card, since dragging a defender out of a
  // battlefield they were holding is something Charm already does.
  //
  // Declining is always available and listed FIRST, so a mis-click and the AI's
  // tie-break both land on doing nothing. That default is the right way round
  // here: the grab contests Blitzcrank's own battlefield and can cost the hold
  // his third clause is built around.
  "OGN-067-grab": {
    prompt: () => "Blitzcrank - Impassive: move an enemy unit to his battlefield?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...ownUnitsEverywhere(state, d.playerIndex === 0 ? 1 : 0).map((u) => ({
        id: u.instanceId,
        label: `Move ${u.name} here`,
        instanceId: u.instanceId,
      })),
    ],
    resolve: (state, d, optionId) =>
      optionId === "decline" || !d.battlefieldId ? state : forceMoveToBattlefield(state, optionId, d.battlefieldId),
  },
  // Spirit's Refuge's "buff a friendly unit", raised by its on-play self-trigger.
  //
  // "A friendly unit" carries no location word, so base and battlefield are both
  // eligible — 355.9.b's bare-noun reading, the same one Vanguard Helm's
  // equivalent question takes. Already-buffed units stay on offer: 708 makes a
  // second buff a no-op rather than an illegal choice, and filtering them would
  // quietly rewrite the card as "an UNBUFFED friendly unit".
  "OGN-063-buff": {
    prompt: () => "Spirit's Refuge: buff a friendly unit",
    options: (state, d) =>
      ownUnitsEverywhere(state, d.playerIndex).map((u) => ({ id: u.instanceId, label: u.name, instanceId: u.instanceId })),
    resolve: (state, _d, optionId) => addBuff(state, optionId),
  },
  // Party Favors' "Cards or Runes", answered by the OPPONENT.
  //
  // Both options always offered, even when a pool is empty: choosing Runes with
  // an empty rune deck is a legal way to give the caster nothing, and filtering
  // it out would quietly turn a Group Hug into a card the opponent cannot use
  // defensively. drawCards and channelRunesExhausted both take what they can.
  //
  // `d.playerIndex` is the CHOOSER (the opponent); the caster is the other seat,
  // and both are paid.
  "OGN-071-choose": {
    prompt: () => "Party Favors: choose Cards or Runes — you and the caster each get it",
    options: () => [
      { id: "cards", label: "Cards (you both draw 1)" },
      { id: "runes", label: "Runes (you both channel 1 exhausted)" },
    ],
    resolve: (state, d, optionId) => {
      const chooser = d.playerIndex;
      const caster: 0 | 1 = chooser === 0 ? 1 : 0;
      const both = [caster, chooser] as const;
      return optionId === "cards"
        ? both.reduce((next, i) => drawCards(next, i, 1), state)
        : both.reduce((next, i) => channelRunesExhausted(next, i, 1), state);
    },
  },

  // Solari Shrine's "you may exhaust this to draw 1" — raised by its death-watch
  // in engine/triggers.ts, which has already checked that the kill was yours,
  // the victim was a stunned enemy, and the Shrine is still ready.
  //
  // Two options always, so `advanceDecisions` can never auto-resolve it: a "you
  // may" that the engine answers for you is not a "you may". Declining is a real
  // play — the Shrine's exhaust is worth keeping when a second stunned enemy is
  // about to die this turn.
  "OGN-072-draw": {
    prompt: () => "Solari Shrine: exhaust it to draw 1?",
    // No `instanceId` on either option, deliberately. The board renders an
    // option that carries one as the CARD itself, which is right for "pick one
    // of your units" and wrong here: this is a yes/no, and half a card next to
    // half a button reads as two different kinds of choice. The prompt already
    // names the Shrine.
    options: () => [
      { id: "draw", label: "Exhaust and draw 1" },
      { id: "decline", label: "Decline" },
    ],
    resolve: (state, d, optionId) => {
      if (optionId !== "draw" || !d.cardInstanceId) return state;
      // Exhaust FIRST, then draw: the exhaust is the cost, and exhaustGear
      // no-ops on a Shrine that is somehow already spent — so a state where the
      // cost cannot be paid must not hand over the draw.
      const paid = exhaustGear(state, d.playerIndex, d.cardInstanceId);
      return paid === state ? state : drawCards(paid, d.playerIndex, 1);
    },
  },

  // Adaptatron's "you may kill a gear. If you do, buff me." — raised by its
  // on-conquer trigger, which has already checked that the conquest was its
  // controller's and that it was standing at the battlefield taken.
  //
  // BOTH players' gear is offered, because the card names no owner. Killing your
  // own is a real play in this pool (Treasure Trove and Scrapheap pay out when
  // they die), so filtering to the opponent's would quietly rewrite the card.
  "OGN-056-kill": {
    prompt: () => "Adaptatron: kill a gear to buff me?",
    options: (state) => {
      // Decline first, so a mis-click and the AI's tie-break both land on doing
      // nothing — the same ordering Flame Chompers' "you may" uses. Two options
      // minimum whenever there is any gear, which is what stops `advanceDecisions`
      // answering a "you may" on the player's behalf.
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      for (const index of [0, 1] as const) {
        for (const gear of state.players[index].activeGear) {
          options.push({ id: gear.instanceId, label: gear.name, instanceId: gear.instanceId });
        }
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      const ownerIndex = ([0, 1] as const).find((i) => state.players[i].activeGear.some((g) => g.instanceId === optionId));
      if (ownerIndex === undefined) return state;
      const gear = state.players[ownerIndex].activeGear.find((g) => g.instanceId === optionId)!;
      const killed = killGear(state, gear, ownerIndex);
      // "IF YOU DO" — the buff is conditional on the kill actually happening, so
      // it hangs off killGear having moved the board rather than off the answer.
      if (killed === state) return state;
      // `addBuff` no-ops if the Adaptatron has left play in the meantime, which
      // is the usual "target vanished" convention rather than a special case.
      return d.cardInstanceId ? addBuff(killed, d.cardInstanceId) : killed;
    },
  },

  // Disarming Rake's "you may kill a gear", raised by its on-play trigger, which
  // has already established that some gear exists.
  //
  // BOTH players' gear, because the card names no owner — the same reading, and
  // the same `killGear` funnel (so a dying gear's own trigger fires), that
  // Adaptatron's question above takes. Decline leads, so a mis-click and the
  // AI's tie-break both land on doing nothing.
  "SFD-032-kill": {
    prompt: () => "Disarming Rake: kill a gear?",
    options: (state) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      for (const index of [0, 1] as const) {
        for (const gear of state.players[index].activeGear) {
          options.push({ id: gear.instanceId, label: gear.name, instanceId: gear.instanceId });
        }
      }
      return options;
    },
    resolve: (state, _d, optionId) => {
      if (optionId === "decline") return state;
      const ownerIndex = ([0, 1] as const).find((i) => state.players[i].activeGear.some((g) => g.instanceId === optionId));
      if (ownerIndex === undefined) return state; // it died while the question waited
      const gear = state.players[ownerIndex].activeGear.find((g) => g.instanceId === optionId)!;
      return killGear(state, gear, ownerIndex);
    },
  },

  // Royal Entourage's "ready or exhaust a legend".
  //
  // ONE option per legend rather than four, because a legend is either ready or
  // exhausted and only one of the two verbs would do anything to it. That is
  // also what guarantees two options on every board, which is what stops
  // `advanceDecisions` answering a real choice on the player's behalf.
  //
  // The direction is encoded in the option id rather than re-derived when the
  // answer arrives: a legend readied by something else while this question waited
  // must not turn "ready theirs" into "exhaust theirs".
  //
  // No `instanceId` on the options, deliberately — the board renders an option
  // carrying one as the CARD itself, and a Legend sits in its own zone rather
  // than among the permanents the board lays out. Same call the Solari Shrine's
  // yes/no makes; the labels name the legends.
  "SFD-039-legend": {
    prompt: () => "Royal Entourage: ready or exhaust a legend",
    options: (state) =>
      ([0, 1] as const).map((i) =>
        state.players[i].legend.exhausted
          ? { id: `${i}-ready`, label: `Ready ${state.players[i].legend.name}` }
          : { id: `${i}-exhaust`, label: `Exhaust ${state.players[i].legend.name}` },
      ),
    resolve: (state, _d, optionId) => {
      const index = Number(optionId.slice(0, 1));
      if (index !== 0 && index !== 1) return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      players[index] = {
        ...players[index],
        legend: { ...players[index].legend, exhausted: optionId.endsWith("exhaust") },
      };
      return { ...state, players };
    },
  },

  // Guardian of the Passage's "you may return a unit or gear from your trash to
  // your hand", raised by his on-hold trigger.
  //
  // A SPELL in the trash is not on offer — the card lists two kinds and stops
  // there, which is the whole restriction (recurring a counterspell every turn
  // would be a different card).
  //
  // Decline leads. Rebuilt from live state rather than stored on the decision,
  // so a card that left the trash while this waited is simply not listed.
  "SFD-035-return": {
    prompt: () => "Guardian of the Passage: return a unit or gear from your trash to your hand?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...trashUnitsAndGear(state, d.playerIndex).map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId })),
    ],
    resolve: (state, d, optionId) => (optionId === "decline" ? state : returnCardFromTrash(state, d.playerIndex, optionId)),
  },

  // Ribbon Dancer's "give ANOTHER friendly unit +1 Might this turn", raised by
  // her own move trigger, which has already established that another friendly
  // unit exists.
  //
  // NO decline option: the card carries no "you may", so once it has triggered
  // the Might has to land somewhere. With exactly one candidate that makes this a
  // single option and `advanceDecisions` executes it without a prompt, which is
  // right — there is no choice to make.
  "SFD-038-might": {
    prompt: () => "Ribbon Dancer: give another friendly unit +1 Might this turn",
    options: (state, d) =>
      ribbonDancerCandidates(state, d.playerIndex, d.cardInstanceId ?? "").map((u) => ({
        id: u.instanceId,
        label: u.name,
        instanceId: u.instanceId,
      })),
    resolve: (state, d, optionId) => giveMightThisTurnToOwnUnit(state, d.playerIndex, optionId, 1),
  },

  // Janna - Savior's "move up to one enemy unit from here to its base", raised by
  // her on-play trigger, which has already established that she landed at a
  // battlefield and that an enemy unit is standing there.
  //
  // "FROM HERE" is `d.battlefieldId`, captured when the question was raised: it
  // means where she landed, not wherever she is by the time the answer arrives.
  // Candidates are re-read from that battlefield against live state, so a unit
  // that has since left is not on offer.
  //
  // `recallUnitToBase`, the same helper Emperor's Divide uses above: "move ... to
  // its base" is a Move (454), so the unit arrives exhausted and Vilemaw's Lair
  // can refuse it.
  "SFD-053-move": {
    prompt: () => "Janna - Savior: move an enemy unit here to its base?",
    options: (state, d) => {
      const enemyId = state.players[d.playerIndex === 0 ? 1 : 0].id;
      const bf = state.battlefields.find((b) => b.id === d.battlefieldId);
      return [
        { id: "decline", label: "Decline" },
        ...(bf?.units[enemyId] ?? []).map((u) => ({ id: u.instanceId, label: `Move ${u.name} home`, instanceId: u.instanceId })),
      ];
    },
    resolve: (state, _d, optionId) => (optionId === "decline" ? state : recallUnitToBase(state, optionId)),
  },

  // Ornn - Blacksmith's "you may reveal a gear from among them and draw it. Then
  // recycle the rest."
  //
  // Only GEAR among the top 4 is offered — the card names the kind, so a unit on
  // top is never a choice however much you want it.
  //
  // "THEN RECYCLE THE REST" happens either way, which is why the decline branch
  // is not a no-op: it is a separate instruction from the reveal-and-draw, the
  // same structure Reinforce and Baited Hook have. With no gear among the four
  // this is a single option and `advanceDecisions` executes it unprompted, which
  // is correct — the recycle is mandatory and there was nothing to decide.
  //
  // Re-slices the top 4 at ANSWER time rather than trusting a stored list, so a
  // deck that has moved on cannot smuggle a card from deeper in it into hand:
  // `takeOneFromTopAndRecycleRest` refuses an id that is no longer up there.
  "SFD-058-gear": {
    prompt: () => "Ornn - Blacksmith: reveal a gear from the top 4 and draw it?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...state.players[d.playerIndex].deck
        .slice(0, 4)
        .filter((c) => c.kind === "Gear")
        .map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId })),
    ],
    resolve: (state, d, optionId) => {
      if (optionId !== "decline") return takeOneFromTopAndRecycleRest(state, d.playerIndex, 4, optionId);
      const looked = state.players[d.playerIndex].deck.slice(0, 4);
      if (looked.length === 0) return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        deck: [...players[d.playerIndex].deck.slice(looked.length), ...looked],
      };
      // Karma - Channeler watches every recycle in this engine, including the
      // ones written inline like this one.
      return holdCardsRecycled({ ...state, players }, d.playerIndex, looked.length);
    },
  },
};

/** The chain entry a stolen spell is sitting in, if it is still there — a
 *  Reversal answered after its target resolved has nothing to re-aim.
 *
 *  Through `spellsOnChain` rather than a raw find, because the chain also holds
 *  TRIGGER entries, which have no card at all. */
function spellOnChain(state: GameState, cardInstanceId: string) {
  return spellsOnChain(state).find(({ entry }) => entry.card.instanceId === cardInstanceId);
}

/**
 * The units a stolen spell could be re-aimed at — its OWN spec's candidate list,
 * minus the one it already names.
 *
 * Excluding the current target is what makes "is there a choice to make" a real
 * question: re-choosing the same unit is not a new choice, and offering it would
 * put a prompt in front of a player with nothing to decide.
 *
 * Returns nothing for every spec kind but `unit`, deliberately — see the card's
 * own note.
 */
function retargetCandidates(state: GameState, playerIndex: 0 | 1, cardInstanceId: string) {
  const stolen = spellOnChain(state, cardInstanceId);
  if (!stolen) return [];
  const spec = effectForCard(stolen.entry.card)?.targeting;
  if (!spec || spec.kind !== "unit") return [];
  // Asked from the NEW controller's seat: "friendly" and "enemy" are relative to
  // whoever controls the spell now, which is the whole point of stealing it.
  return eligibleTargets(state, playerIndex, spec.owner, spec.scope).filter(
    (u) => u.instanceId !== stolen.entry.targetUnitInstanceId,
  );
}
