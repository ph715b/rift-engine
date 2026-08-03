import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { DeathknellEffect, DeathWatchEffect, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { DecisionDefinition } from "../decisions.js";
import type { GameState, PlayerState } from "../../model/game-state.js";
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
  returnUnitToHand,
  stunUnits,
} from "../effect-helpers.js";
import { killGear } from "../triggers.js";
import { counterSpell, gainControlOfSpell } from "../counter-spell.js";
import { playCardIgnoringCost } from "../play-free.js";
import { effectiveMight } from "../effective-might.js";
import { findUnitAnywhere } from "../target-lookup.js";
import { parkDecision, type DecisionOption } from "../decisions.js";

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
export const cardEffects: Record<string, EffectDefinition> = {
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
    resolve: (state, ctx) => parkDecision(state, { kind: "OGN-062-banish", playerIndex: ctx.casterIndex }),
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
    // "You may make new choices for it" needs a question asked WHILE a resolution
    // is suspended — the targets were fixed when the spell was announced, and
    // re-making them means offering the new controller the original spec's
    // candidate list mid-chain. Recorded in docs/rules-conformance.md rather than
    // guessed at; the card is registered because its main clause works, and
    // coverage carries a PARTIALLY_IMPLEMENTED entry saying what is missing.
    targeting: { kind: "chainSpell" },
    resolve: (state, ctx, event) =>
      event.targetChainCardInstanceId ? gainControlOfSpell(state, event.targetChainCardInstanceId, ctx.casterIndex) : state,
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
};

/** [Deathknell] effects — rule 808, "When I die, [Effect]". Keyed by the DYING
 *  card's defId. Same one-file-one-owner rule as the registries above. */
export const deathTriggers: Record<string, DeathknellEffect> = {};

/** Listeners for board EVENTS other than a death (see triggers.ts's GameEvent).
 *  Keyed by the LISTENING card's defId. Same one-file-one-owner rule. */
/** Listeners for someone ELSE dying ("when a buffed friendly unit dies"), keyed
 *  by the LISTENING card's defId. Distinct from `deathTriggers` above, which is
 *  a [Deathknell] keyed by the DYING card. Same one-file-one-owner rule. */
export const deathWatchTriggers: Record<string, DeathWatchEffect> = {};

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
      players[listener.ownerIndex] = { ...players[listener.ownerIndex], points: players[listener.ownerIndex].points + 1 };
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
    // +1 Might this turn."
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
    on: "combatBegan",
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      const ownerId = state.players[listener.ownerIndex].id;
      const bf = state.battlefields.find((b) => b.id === event.battlefieldId);
      const mine = bf?.units[ownerId] ?? [];
      return mine.length === 1 ? giveMightThisTurn(state, mine[0]!.instanceId, 1) : state;
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
    resolve: (state, listener, event) => {
      if (event.kind !== "unitsStunned") return state;
      if (event.stunnerIndex !== listener.ownerIndex) return state;
      const enemiesStunned = event.stunned.filter((s) => s.ownerIndex !== listener.ownerIndex).length;
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
    // That is why this is a `combatBegan` listener and not an entry in
    // unit-triggers.ts's ON_ATTACK_TRIGGERS table, where the pool's four other
    // "when I attack" cards live. Those fire inside the move/play executor, one
    // per unit that just landed — earlier than the rules' moment, and blind to a
    // unit that was already standing there when a friend walked in and started
    // the fight. 465 gives that unit the Attacker designation too, so Yasuo
    // holding a battlefield that his own reinforcement contests really does
    // attack. Reading it off `combatBegan` gets both cases; the older table gets
    // neither right. (Not a claim that those four are wrong enough to move —
    // that is a separate change to a file this pass does not own.)
    //
    // Which side is attacking is `contestedByIndex`, which IS 465's definition of
    // the Attacker verbatim and is still set here: `clearContested` runs only
    // when the Showdown closes.
    on: "combatBegan",
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      if (listener.card.kind !== "Unit") return state;
      if (listener.battlefieldId !== event.battlefieldId) return state;
      const bf = state.battlefields.find((b) => b.id === event.battlefieldId);
      if (!bf || bf.contestedByIndex !== listener.ownerIndex) return state; // he is DEFENDING
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
};

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
      const recycled: GameState = { ...state, players };
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
};
