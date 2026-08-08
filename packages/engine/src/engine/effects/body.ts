import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { DeathknellEffect, DeathWatchDefinition, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { DecisionDefinition } from "../decisions.js";
import {
  addBuff,
  channelRunesExhausted,
  dealDamage,
  dealDamageToAllUnitsAtAllBattlefields,
  dealDamageToEnemyUnitsAtBattlefield,
  drawCards,
  giveMightThisTurn,
  giveMightThisTurnToOwnUnit,
  grantKeywordThisTurn,
  ownUnitsEverywhere,
  payEnergyFromPool,
  payPowerFromChanneled,
  readyPermanent,
  readyUnit,
  recycleCardFromHand,
  spendBuff,
} from "../effect-helpers.js";
import { readyableOthers } from "../unit-triggers.js";
import { playUnitToBattlefield } from "../deploy.js";
import { playUnitFree } from "../free-play.js";
import { holdCardsRecycled } from "../effect-helpers.js";
import { modifiedEnergyCost } from "../cost-modifiers.js";
import {
  offerTopOfDeckBanish,
  revealedFromDeck,
  voidHatchlingAnswer,
  voidHatchlingGate,
  voidHatchlingOptions,
} from "../top-of-deck.js";
import { parkDecision, repeatDecision, type DecisionOption } from "../decisions.js";
import type { GameState, PlayerState } from "../../model/game-state.js";
import type { CardInstance, UnitInstance } from "../../model/card.js";
import type { Keyword } from "../../model/keyword.js";
import { effectiveMight } from "../effective-might.js";
import { effectiveKeywords, isMighty } from "../granted-keywords.js";
import { isFightingAt } from "../combat-designation.js";
import type { GameEvent, Listener } from "../triggers.js";
import { findUnitAnywhere, type AnyUnitLocation } from "../target-lookup.js";
import { attachEquipment, borrowGear, detachEquipment, equipmentAttachedTo, isEquipmentGear } from "../equipment.js";
import { wearerListener } from "../equipment.js";
import { gainPoints } from "../effect-helpers.js";
import { placeGoldTokens } from "../token.js";

/**
 * Card implementations for **Body** — one file, one owner.
 *
 * This file exists so that work on the card pool can be split up without two
 * people (or two agents) ever editing the same file. The ownership rule is
 * mechanical, not a convention: a defId may only appear here if its
 * CardDefinition has exactly one domain and that domain is Body. A test in
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
  "SFD-107": {
    // Strike Down — "Choose an EQUIPPED friendly unit. It deals damage equal to
    // its Might to an enemy unit. Then detach an Equipment from it."
    //
    // Two targets that are NOT interchangeable — slot 0 is the striker and slot
    // 1 is the victim — so the slots take different roles and `asymmetricSlots`
    // is unnecessary: the roles themselves already stop the pair being offered
    // both ways round.
    //
    // **"EQUIPPED" is a condition the targeting spec cannot express**, so it is
    // checked in the resolver. The consequence is honest rather than hidden: an
    // unequipped friendly CAN be named and the spell then does nothing, which is
    // 422's do-as-much-as-you-can rather than an illegal play. Recorded in
    // docs/rules-conformance.md; narrowing the enumeration would need a
    // per-slot predicate the spec has no field for.
    //
    // Damage equal to its CURRENT Might, read through `effectiveMight` in a
    // NON-combat context — this is not a damage step, so [Assault] and [Shield]
    // do not apply, the same reading every other "equal to its Might" effect in
    // the pool takes. It is read BEFORE the detach, because the Equipment being
    // removed is usually what is paying for the damage.
    //
    // "Then DETACH an Equipment from it" is mandatory and takes the first one —
    // WHICH Equipment is a real choice only for a unit wearing several, and the
    // engine cannot pause mid-resolution to ask. Recorded with the same note.
    targeting: { kind: "unitSlots", slots: ["friendly", "enemy"], min: 2, scope: "anywhere" },
    resolve: (state, ctx, event) => {
      const strikerId = event.targetUnitInstanceId;
      const victimId = event.secondTargetUnitInstanceId;
      if (strikerId === undefined || victimId === undefined) return state;
      const striker = findUnitAnywhere(state, strikerId);
      if (striker === undefined) return state;
      const worn = equipmentAttachedTo(state, strikerId);
      // "An EQUIPPED friendly unit" — an unequipped one is not a legal subject,
      // so neither half happens.
      if (worn.length === 0) return state;
      const ctxFor =
        striker.zone === "base"
          ? { isCombat: false as const }
          : { isCombat: false as const, battlefieldId: state.battlefields[striker.zone.battlefieldIndex]!.id };
      const might = effectiveMight(state, striker.unit, striker.ownerIndex, ctxFor);
      const struck = dealDamage(state, ctx.casterIndex, victimId, might);
      return detachEquipment(struck, striker.ownerIndex, worn[0]!.instanceId);
    },
  },
  "OGN-145": {
    // Unyielding Spirit — "Prevent all spell and ability damage this turn."
    //
    // Read at `dealDamage`, which every spell and ability damages through and
    // which COMBAT never touches — combat.ts does its own Might arithmetic. So
    // the card's own distinction between kinds of damage holds without anything
    // having to say which kind is being dealt.
    //
    // Prevention belongs to the unit's CONTROLLER, not to the caster: "prevent
    // all damage this turn" protects the player who cast it, so casting it does
    // not also switch off your own removal against the opponent.
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      players[ctx.casterIndex] = { ...players[ctx.casterIndex], preventsSpellDamageThisTurn: true };
      return { ...state, players };
    },
  },
  "OGN-133": {
    // Flurry of Blades — "Deal 1 to all units at battlefields."
    //
    // ALL units, both players' including the caster's — symmetric, and the base
    // is excluded because "at battlefields" is printed. The existing helper is
    // exactly this sentence.
    targeting: { kind: "none" },
    resolve: (state, ctx) => dealDamageToAllUnitsAtAllBattlefields(state, ctx.casterIndex, 1),
  },
  "OGN-154": {
    // Primal Strength — "Give a unit +7 Might this turn."
    //
    // No owner, no battlefield, no floor: scope "anywhere" and the number as
    // printed. giveMightThisTurn rather than a Buff — this expires in the
    // Expiration Step (317) rather than persisting (710).
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId ? giveMightThisTurn(state, event.targetUnitInstanceId, 7) : state,
  },
  "OGN-144": {
    // Spoils of War — "If an enemy unit has died this turn, this costs 2 Energy
    // less. Draw 2."
    //
    // Only the draw is here; the conditional discount is a COST and lives in
    // cost-modifiers.ts, the same split Find Your Center takes.
    targeting: { kind: "none" },
    resolve: (state, ctx) => drawCards(state, ctx.casterIndex, 2),
  },
  "OGN-156": {
    // Sabotage — "Choose an opponent. They reveal their hand. Choose a non-unit
    // card from it, and recycle that card."
    //
    // "NON-UNIT", which is the whole texture of the card: it takes the removal
    // and the card draw out of a hand and leaves the bodies. A hand of nothing
    // but units makes this a blank, and the decision correctly offers nothing —
    // advanceDecisions drops a question with no answers rather than deadlocking.
    //
    // Recycle, not discard: the card goes to the BOTTOM OF THEIR DECK (416), so
    // they will draw it again eventually. That distinction matters to anything
    // watching the trash, which is why this does not route through discardCards.
    targeting: { kind: "none" },
    resolve: (state, ctx) => parkDecision(state, { kind: "OGN-156-recycle", playerIndex: ctx.casterIndex }),
  },
  "OGN-138": {
    // Catalyst of Aeons — "Channel 2 runes exhausted. If you couldn't channel 2
    // runes this way, draw 1."
    //
    // The consolation is measured off what ACTUALLY happened, not off the rune
    // deck's size beforehand: channelRunesExhausted takes as many as it can
    // (315.4.b), so comparing the channeled pool before and after is the only
    // reading that stays right if that helper's own short-deck behaviour ever
    // changes. "Couldn't channel 2" is fewer than 2, so a deck with exactly one
    // rune left both channels it AND draws.
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const before = state.players[ctx.casterIndex].channeled.length;
      const channelled = channelRunesExhausted(state, ctx.casterIndex, 2);
      const gained = channelled.players[ctx.casterIndex].channeled.length - before;
      return gained < 2 ? drawCards(channelled, ctx.casterIndex, 1) : channelled;
    },
  },
  "OGN-127": {
    // Cannon Barrage — "[Reaction] Deal 2 to all enemy units in combat."
    //
    // card-effects.ts used to carry a paragraph explaining that this was
    // deliberately NOT registered, because the card "can only ever be cast when
    // there's nothing 'in combat' to hit": validate-play-card rejected every
    // PlayCard while a Showdown was open, so implementing it would have meant
    // writing code that could never run. [Action]/[Reaction] timing removed that
    // blocker, so the card is now implementable — and being a [Reaction] it can
    // be cast onto an already-closed chain, which is exactly its point.
    //
    // Hits enemy units at the battlefield where the Showdown is running, and
    // nothing at all outside one. That reading covers both Showdown kinds without
    // branching on `showdownKind`: a Non-Combat Showdown has no opposing units
    // present by definition (that is what makes it non-combat), so "all enemy
    // units in combat" is empty there either way.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      state.showdownBattlefieldId === null
        ? state
        : dealDamageToEnemyUnitsAtBattlefield(state, ctx.casterIndex, state.showdownBattlefieldId, 2),
  },
  "SFD-114": {
    // Marching Orders — "[Action] [Repeat] [3] Choose a friendly unit ANYWHERE
    // and an enemy unit AT A BATTLEFIELD. They deal damage equal to their Mights
    // to each other."
    //
    // Challenge (OGN-128, below) with one word changed, and the word is
    // load-bearing: Challenge scopes BOTH duellists "anywhere", while this card
    // prints the two halves differently. So `slotScopes` rather than a shared
    // `scope` — the enemy must be at a battlefield, and an opposing unit sitting
    // safe in its own base is NOT a legal second target here even though it is
    // for Challenge. Reading the spec-wide scope for both would have offered a
    // target 355.9.b does not allow.
    //
    // Everything else is Challenge's, including the ORDER that matters: both
    // Mights are read before either damage instance lands, so the first duellist
    // to die still deals its full Might on the way out.
    //
    // Repeating it may name a different pair (820.1.d) — and, unlike Challenge,
    // repeating it at all is possible, which makes the read-before-deal snapshot
    // observable twice: the second execution reads the board the first left
    // behind, so a duellist already dead is simply gone (359.3) rather than
    // dealing its Might again from the trash.
    targeting: {
      kind: "unitSlots",
      slots: ["friendly", "enemy"],
      min: 2,
      slotScopes: ["anywhere", "battlefield"],
    },
    resolve: (state, ctx, event) =>
      unitsDuel(state, ctx.casterIndex, event.targetUnitInstanceId!, event.secondTargetUnitInstanceId!),
  },
  "OGN-128": {
    // Challenge — "[Action] Choose a friendly unit and an enemy unit. They deal
    // damage equal to their Mights to each other."
    //
    // Gentlemen's Duel (OGS-008, card-effects.ts) minus its +3 Might: same two
    // ordered slots, same `min: 2` (a duel with one participant isn't a duel, so
    // the card stays uncastable without both), and the same resolution order.
    //
    // That order is the only subtle part, and it is load-bearing. BOTH Mights are
    // read before EITHER damage instance is dealt, so the first duellist to die
    // still deals its full Might on the way out — deal-then-read would let the
    // enemy's death silently reduce the damage coming back at the friendly unit.
    // The two damages are still applied one after the other because dealDamage is
    // the single death choke point (Deathknells, death wards); simultaneity here
    // is about the AMOUNTS, which the snapshot already gives.
    //
    // Scope: the printed text names no battlefield, so either duellist may be
    // standing in its owner's BASE — including the opponent's. Same reading as
    // Final Spark's "deal 8 to a unit"; base is not a safe parking spot.
    //
    // The Might-in-its-zone lookup is now `unitsDuel` at the foot of this file —
    // the fold this comment used to ask for, taken the moment a second Body card
    // (Carnivorous Snapvine) printed the same sentence. Gentlemen's Duel still
    // carries its own copy in card-effects.ts, which this file's owner doesn't own.
    targeting: { kind: "unitSlots", slots: ["friendly", "enemy"], min: 2, scope: "anywhere" },
    resolve: (state, ctx, event) =>
      unitsDuel(state, ctx.casterIndex, event.targetUnitInstanceId!, event.secondTargetUnitInstanceId!),
  },
  "OGN-146": {
    // Wallop — "[Action] As you play this, you may spend a buff as an additional
    // cost. If you do, ignore this spell's cost. Ready a unit."
    //
    // **HALF-IMPLEMENTED, deliberately.** The optional additional cost and the
    // cost-ignoring are a COST, and costs live in card-effects.ts's
    // OPTIONAL_UNIT_COSTS — the entry this card needs is
    // `"OGN-146": { kind: "spendBuffFriendly", ignoresCostWhenPaid: true }`,
    // exactly Call to Glory's (OGN-207). Without it `legal-actions` never
    // enumerates a paid variant and `validate-play-card` refuses one, so the
    // `spendBuff` branch below is currently unreachable: Wallop plays at its
    // printed 2 Energy and readies a unit, and the free-cast mode does not exist.
    // The branch is written anyway so the card is complete the moment that one
    // line lands, rather than needing a second author to notice it is missing.
    //
    // "Ready a unit" — the bare noun, so scope "anywhere" with no owner
    // restriction (355.9.b). Readying an ENEMY unit is a bad play, not an illegal
    // one; same reading Call to Glory's "a unit" and First Mate's "ready another
    // unit" already take, and base is where an exhausted unit usually sits.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, event) => {
      const paid =
        event.additionalCostUnitInstanceId !== undefined
          ? (spendBuff(state, ctx.casterIndex, event.additionalCostUnitInstanceId) ?? state)
          : state;
      return event.targetUnitInstanceId ? readyUnit(paid, event.targetUnitInstanceId) : paid;
    },
  },
  "OGN-153": {
    // Overt Operation — "[Action] For each friendly unit, you may spend its buff
    // to ready it. Then buff all friendly units."
    //
    // Targeting is "none" because nothing here is chosen when the card is
    // announced: "for each friendly unit" is a sweep over the board as it stands
    // at RESOLUTION, and each "you may" is answered then. That is what
    // engine/decisions.ts exists for — the fan-out-onto-the-action approach
    // cannot express one question per unit, and 2^N variants would be a lie
    // about when the choice is made anyway.
    //
    // One question per BUFFED friendly unit. Unbuffed ones are skipped rather
    // than asked-and-declined: rule 705 forbids spending a buff that isn't there,
    // so their "you may" has no payable side and advanceDecisions would drop the
    // one-option question on sight.
    //
    // READY buffed units ARE still asked, even though readying a ready unit does
    // nothing. The spend is not wasted — "then buff all friendly units" hands the
    // buff straight back (708 makes it a no-op only for units that kept theirs),
    // so the answer is at worst neutral and at best fires `unitBuffed` again for
    // Mistfall. Filtering them out would take a legal, occasionally useful answer
    // away; the precedent for pruning (Mistfall's own exhausted-only offer) is
    // about an unpayable COST, which this is not.
    //
    // "THEN buff all friendly units" is queued as its own single-option decision
    // rather than applied here, and the "then" is what forces that: every spend
    // must land before any buff does, or a unit re-buffed early could have that
    // same buff spent by a later answer. Same reason Undercover Agent's "discard
    // 2, then draw 2" queues its draw (see decisions.ts's `draw`).
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const asked = ownUnitsEverywhere(state, ctx.casterIndex)
        .filter((u) => u.buffed)
        .reduce(
          (next, unit) =>
            parkDecision(next, {
              kind: "OGN-153-spend",
              playerIndex: ctx.casterIndex,
              targetInstanceId: unit.instanceId,
            }),
          state,
        );
      return parkDecision(asked, { kind: "OGN-153-buff-all", playerIndex: ctx.casterIndex });
    },
  },
  "SFD-097": {
    // Punch First — "[Action] Give a unit +5 Might this turn."
    //
    // Primal Strength (OGN-154, above) at a different number, and the same three
    // readings apply unchanged: the bare noun "a unit" is scope "anywhere"
    // (355.9.b), so a body sitting in either player's BASE is a legal target;
    // there is no floor because none is printed; and it is `giveMightThisTurn`
    // rather than a Buff, so it expires in the Expiration Step (317) instead of
    // persisting (710).
    //
    // `[Action]` is a timing keyword, parsed from the card and enforced by
    // timing.ts — nothing about it belongs in the resolver.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId ? giveMightThisTurn(state, event.targetUnitInstanceId, 5) : state,
  },
  "SFD-106": {
    // Show of Strength — "[Reaction] Draw 1 for each of your [Mighty] units."
    //
    // Kadregrin the Infernal's sentence exactly (OGN-038, effects/fury.ts), so it
    // takes his reading whole: `isMighty` rather than a hand-written `>= 5`,
    // because rule 711 asks about a unit's CURRENT Might and a 3-Might body under
    // Garen - Commander with a buff IS Mighty. That helper deliberately asks with
    // `isCombat: false`, so `[Assault]` never pushes one over the line.
    //
    // "YOUR units" — base and battlefields both, since nothing here is
    // positional. No "other" is printed and there is no self to exclude anyway.
    //
    // A board with nothing Mighty draws ZERO, which `drawCards` treats as a no-op
    // rather than as a draw from an empty deck — so casting this into a small
    // board is a wasted card, not a Burn Out (431).
    //
    // Being a `[Reaction]` is what makes the count interesting: it can be cast
    // after a pump lands, and the units counted are the ones standing when it
    // RESOLVES, not when it was announced.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      drawCards(state, ctx.casterIndex, ownUnitsEverywhere(state, ctx.casterIndex).filter((u) => isMighty(state, u, ctx.casterIndex)).length),
  },
  "SFD-111": {
    // Here to Help — "[Hidden][Action] You may play a unit from hand to a
    // battlefield you control, reducing its cost by [3 Energy]."
    //
    // Targeting is "none" and both choices are DECISIONS, because neither can be
    // decided when the spell is announced: the card played is chosen from a hand
    // that this spell's own resolution may have changed, and 355.11 makes a
    // target something the effect ACTS on — a card in hand being played is not.
    // Void Rush (SFD-188, effects/signature.ts) prices and plays a card the same
    // way, and this borrows its payment shape wholesale (see `hereToHelpPayment`).
    //
    // TWO questions rather than one option per (unit, battlefield) pair. The
    // second is auto-retired by `advanceDecisions` whenever the caster controls
    // exactly one battlefield, which is the common board — so the pair encoding
    // would have bought nothing and cost a composite option id.
    //
    // `[Hidden]` and `[Action]` are timing keywords, parsed from the card and
    // enforced by hidden.ts and timing.ts; nothing about them belongs here.
    targeting: { kind: "none" },
    resolve: (state, ctx) => parkDecision(state, { kind: "SFD-111-play", playerIndex: ctx.casterIndex }),
  },
};

export const unitTriggers: Record<string, UnitTriggerDefinition> = {
  "SFD-109": {
    // Akshan - Mischievous — "[Weaponmaster] You may pay [Body][Body] as an
    // additional cost to play me. When you play me, if you paid the additional
    // cost, move an enemy gear to your base. You control it until I leave the
    // board. If it's an Equipment, attach it to me."
    //
    // # The handoff said his `[Body][Body]` half already worked. It did not.
    //
    // Nothing was registered for this card at all — measured, not assumed:
    // `implementingModule("SFD-109")` returned undefined and `OPTIONAL_POWER_COSTS`
    // had no entry for him. The additional cost lands with this card, which is
    // also the pool's first optional cost of TWO runes (Clockwork Keeper's,
    // Frostcoat Cub's and Blast Corps Cadet's are all one).
    //
    // # "You control it until I leave the board"
    //
    // `borrowGear`, and the expiry is the whole of what did not exist: control of
    // a gear is `activeGear` membership, so taking it was already expressible and
    // giving it back was not. `returnLapsedGearControl` runs in the CLEANUP rather
    // than off a death, because "leaves the board" is wider than "dies" — a
    // recall, a banish and a bounce to hand all end the loan, and a death-watch
    // would catch only one of the four.
    //
    // # "Move an enemy gear to your BASE"
    //
    // Gear in this engine has no location at all — `activeGear` is a flat
    // per-player list — so "to your base" IS the change of list, and there is
    // nothing further to move. The phrase is the rules describing where gear
    // lives, not a destination this card chooses.
    //
    // # "If it's an Equipment, attach it to ME"
    //
    // Conditional on the printed tag, so a stolen Seal or Vanguard Armory simply
    // arrives unattached. `attachEquipment` is asked from AKSHAN's controller,
    // which is now the gear's too — that is what `borrowGear` just made true, and
    // it is why the attach comes second.
    //
    // The target is chosen whether or not the cost was paid, which is Blast Corps
    // Cadet's recorded consequence of targeting being declared per card rather
    // than per branch: an unpaid Akshan names a gear and does nothing to it.
    targeting: { kind: "gear", owner: "enemy" },
    resolve: (state, ctx, unitId, event) => {
      if (!event.optionalPowerPaid || !event.targetPermanentInstanceId) return state;
      const taken = borrowGear(state, ctx.casterIndex, event.targetPermanentInstanceId, unitId);
      const gear = taken.players[ctx.casterIndex].activeGear.find(
        (g) => g.instanceId === event.targetPermanentInstanceId,
      );
      // Nothing arrived — the gear was killed in response, or was never the
      // opponent's. The usual target-vanished no-op.
      if (!gear || !isEquipmentGear(gear)) return taken;
      return attachEquipment(taken, ctx.casterIndex, gear.instanceId, unitId);
    },
  },
  "SFD-098": {
    // Sea Monkey — "You may pay [1] as an additional cost to play me. When you
    // play me, if you paid the additional cost, buff me."
    //
    // **Pure ENERGY, no rune at all** — the case that made the optional-cost
    // table's `domain` optional. It also makes the pricing distinction visible:
    // a version that let the optional cost's domain override the card's would
    // leave a Sea Monkey's own printed Power pip payable by any rune, because
    // this cost names no domain to override it with.
    //
    // "Buff ME", so the target is the unit itself — `_unitId` is the instance
    // that just entered, which is what every self-referential on-play here uses.
    targeting: { kind: "none" },
    resolve: (state, _ctx, unitId, event) => (event.optionalPowerPaid ? addBuff(state, unitId) : state),
  },
  "OGN-150": {
    // Kraken Hunter — "As you play me, you may spend ANY NUMBER of buffs as an
    // additional cost. Reduce my cost by [1 Body] for each buff you spend."
    //
    // The card is nothing BUT its cost, which is why `targeting` is "none" and
    // this resolver only spends. The discount is priced per variant in the cost
    // pipeline (see `UnitCostSpec.repeatable`).
    //
    // `spendBuff` per unit, and its `undefined` return — the unit was not buffed
    // after all — falls back to the unchanged state rather than throwing: between
    // enumeration and resolution nothing can move here, but the helper's contract
    // is the same one Wildclaw Shaman already leans on.
    targeting: { kind: "none" },
    resolve: (state, ctx, _unitId, event) =>
      (event.additionalCostUnitInstanceIds ?? []).reduce((next, id) => spendBuff(next, ctx.casterIndex, id) ?? next, state),
  },
  "OGN-141": {
    // Kinkou Monk — "When you play me, buff up to two OTHER friendly units."
    //
    // `min: 0` is what makes "up to" real — the empty choice is legal, so a Monk
    // played with nothing else on board still deploys. "OTHER" is free here: he
    // is not yet a legal target of his own trigger, since legal-actions
    // enumerates while he is still in hand.
    targeting: { kind: "unitSlots", slots: ["friendly", "friendly"], min: 0, scope: "anywhere" },
    resolve: (state, _ctx, _unitId, event) =>
      [event.targetUnitInstanceId, event.secondTargetUnitInstanceId]
        .filter((id): id is string => id !== undefined)
        .reduce((next, id) => addBuff(next, id), state),
  },
  "OGN-164": {
    // Sett - Brawler — "When I'm played AND when I conquer, buff me." (His
    // "Spend my buff: give me +4 Might this turn" is in activated-abilities.)
    //
    // Only the played half is here; the conquer half listens to
    // `battlefieldConquered` below. Two clauses, two mechanisms, one card —
    // splitting them is what lets each be the narrowest thing it needs.
    targeting: { kind: "none" },
    resolve: (state, _ctx, unitId) => addBuff(state, unitId),
  },
  "OGN-136": {
    // Pit Rookie — "When you play me, buff another friendly unit."
    //
    // The first card to place a real Buff. Rule 702.3.a: "To Buff a Unit, a
    // player chooses a Unit and then places a buff on it." Worth +1 Might
    // (rule 710) and, unlike a "+1 Might this turn" effect, it stays there —
    // rule 709 removes it only when the unit leaves play.
    //
    // "Another" excludes Pit Rookie itself, which comes for free: legal-actions
    // enumerates targets while this card is still in hand, so its own
    // instanceId is never a candidate. The guard below is for the case where the
    // board offered no legal target at all and the Unit was played with its
    // target omitted (validate-play-card's targetOmissionAllowed).
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, _ctx, _unitId, event) =>
      event.targetUnitInstanceId ? addBuff(state, event.targetUnitInstanceId) : state,
  },
  "OGN-147": {
    // Wildclaw Shaman — "When you play me, you may spend a buff to buff me and
    // ready me. (If I don't have a buff, I get a +1 Might buff.)"
    //
    // Spend first, payoff second, and only if the spend actually happened: the
    // buff is a COST, not a target. spendBuff returns `undefined` rather than an
    // unchanged state precisely so that can't be fudged — rule 705 forbids
    // spending from an unbuffed unit and rule 705.1 restricts it to units you
    // control, and either failure has to cancel the buff-and-ready, not hand it
    // over free. Rule 704.1 is the removal itself.
    //
    // The parenthetical is reminder text for rules 708/710, not a second mode:
    // a Buff is worth +1 Might (710) and adding one to an already-buffed unit
    // does nothing (708, "it is not placed instead"), which addBuff implements.
    // The Shaman has just entered play and so is never already buffed here, but
    // going through addBuff keeps the one-buff-at-a-time rule (707) in one place.
    //
    // "YOU MAY" rides on `additionalCostUnitInstanceId`, the field a Spell's
    // optional cost already used (Meditation) — NOT on the ordinary target
    // field. That distinction is the whole point: legal-actions always emits a
    // decline variant alongside one variant per BUFFED friendly unit, so
    // declining stays available even when every unit you control is buffed.
    // Routing it through the target field instead made "you may" collapse into
    // "you must" in exactly that case.
    //
    // Targeting is "none": this card chooses nothing to act ON. The unit whose
    // buff is spent is a cost, and rule 355.11's "included only as part of a
    // cost" clause says a cost is not a target.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitInstanceId, event) => {
      const donor = event.additionalCostUnitInstanceId;
      if (donor === undefined) return state; // declined — "you may"
      const paid = spendBuff(state, ctx.casterIndex, donor);
      if (paid === undefined) return state; // cost unpayable (rule 705/705.1) — no payoff
      return readyUnit(addBuff(paid, unitInstanceId), unitInstanceId);
    },
  },
  "OGN-149": {
    // Carnivorous Snapvine — "When you play me, choose an enemy unit at a
    // battlefield. We deal damage equal to our Mights to each other."
    //
    // Challenge's duel (above) with the friendly slot pinned to the Snapvine
    // itself, so it shares `unitsDuel` and inherits the ordering that matters:
    // both Mights are read BEFORE either damage lands, so a target killed
    // outright still hits back for its full Might.
    //
    // Scope differs from Challenge and it is printed, not incidental: "an enemy
    // unit AT A BATTLEFIELD", so the default battlefield scope stands and a unit
    // sitting in the opponent's base cannot be picked. The SNAPVINE, though, may
    // be anywhere — playing it to your own base and shooting across the board is
    // a legal (and expensive) line, which is why the duel looks its own location
    // up rather than assuming `event.destination`.
    //
    // Guarded on the target because a Unit is playable with its trigger's target
    // omitted when the board offered none (validate-play-card's
    // targetOmissionAllowed) — a Snapvine played into an empty board deploys and
    // fights nobody.
    targeting: { kind: "unit", owner: "enemy" },
    resolve: (state, ctx, unitInstanceId, event) =>
      event.targetUnitInstanceId
        ? unitsDuel(state, ctx.casterIndex, unitInstanceId, event.targetUnitInstanceId)
        : state,
  },
  "SFD-091": {
    // Buhru Captain — "When you play me, you may draw 1 or buff me."
    //
    // Targeting is "none" and the choice is a DECISION, not a fanned-out action
    // variant, because nothing here is a target: both modes act on the caster or
    // on the Captain himself, and 355.11 only makes a chosen thing a target.
    // Blitzcrank - Impassive (OGN-067, calm.ts) parks from an on-play trigger the
    // same way.
    //
    // Qiyana - Victorious (OGN-155, below) prints the nearly identical "draw 1 or
    // channel 1 rune exhausted" with NO "you may", and is offered exactly two
    // answers. This card prints one, so DECLINING is a third — see the decision.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitInstanceId) =>
      parkDecision(state, { kind: "SFD-091-choose", playerIndex: ctx.casterIndex, cardInstanceId: unitInstanceId }),
  },
  "SFD-101": {
    // Fae Dragon — "When you play me, buff up to four friendly units."
    //
    // **HALF THE CARD** — the other half is her `buffSpent` listener in
    // `eventTriggers` below, added once the event existed. This comment used to
    // say what was needed ("one `holdEventTrigger` in `spendBuff` plus the event
    // kind — both in shared files"), and that was exactly the work.
    //
    // FOUR targets, which no TargetingSpec on this path can carry. `unitSlots` is
    // a fixed 2-tuple, and `unitList` — which would be exactly right — is
    // enumerated for a Unit by legal-actions but dropped on the dispatch hop:
    // `UnitTriggerEvent` has no `targetUnitInstanceIds` field, so the ids reach
    // `dispatchOnPlayUnit` and vanish. Adding it is a change to unit-triggers.ts.
    //
    // So the four choices are a repeated DECISION instead, Overt Operation's
    // mechanism one row down. **The divergence that buys is WHEN they are chosen**:
    // 355 chooses targets as the ability goes on the chain, and these are chosen at
    // resolution. It is small here and named rather than hidden — a Unit's on-play
    // trigger is held and resolved as one chain item, so the only thing an opponent
    // loses is seeing which four units are named while the item is still pending.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      parkDecision(state, { kind: "SFD-101-buff", playerIndex: ctx.casterIndex, count: FAE_DRAGON_BUFFS }),
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
export const deathWatchTriggers: Record<string, DeathWatchDefinition> = {};

/** Yordle Explorer's threshold — the two rainbow pips he reads, as a count.
 *  "Or more", so the comparison is `>=`. */
const YORDLE_EXPLORER_POWER_THRESHOLD = 2;

/** Jax - Unrelenting's optional draw. */
const JAX_UNRELENTING_DRAW_COST = 1;

/**
 * Dazzling Aurora's reveal — "reveal cards from the top of your Main Deck until
 * you reveal a unit and banish it. Play it, ignoring its cost, and recycle the
 * rest."
 *
 * Extracted from her trigger so Void Hatchling can run its look-and-recycle
 * first: this function is both the inline path and the body of the
 * `OGN-160-reveal` continuation, which makes the two identical by construction
 * rather than by two copies agreeing.
 */
function dazzlingAuroraReveal(state: GameState, ownerIndex: 0 | 1): GameState {
  const owner = state.players[ownerIndex];
  const unitIndex = owner.deck.findIndex((c) => c.kind === "Unit");
  // Nothing but spells and gear left: the whole deck is revealed and recycled,
  // which is a real outcome rather than a no-op — the order changes even though
  // nothing is played.
  const revealed = unitIndex === -1 ? owner.deck : owner.deck.slice(0, unitIndex + 1);
  const found = unitIndex === -1 ? undefined : (owner.deck[unitIndex] as UnitInstance);
  const rest = revealed.filter((c) => c.instanceId !== found?.instanceId);

  const players = [...state.players] as [PlayerState, PlayerState];
  players[ownerIndex] = { ...owner, deck: [...owner.deck.slice(revealed.length), ...rest] };
  const recycled = holdCardsRecycled({ ...state, players }, ownerIndex, rest.length);
  // "Play it, ignoring its cost" names no destination, so the controller chooses
  // one — see engine/free-play.ts. It is base-only in the common case and asks
  // nothing then.
  const played = found ? playUnitFree(recycled, ownerIndex, found) : recycled;
  // "As you look at or REVEAL me" — every card turned over on the way here was
  // revealed, so a Nocturne among them gets his offer. After the reveal rather
  // than before it, because nothing here stops to ask: he may be the unit that
  // was just played, in which case his own offer finds him gone from the deck
  // and drops itself.
  return revealedFromDeck(played, ownerIndex, revealed);
}

export const eventTriggers: Record<string, EventTriggerDefinition> = {
  "SFD-116": {
    // Yone - Blademaster — "When I conquer a battlefield that WAS UNCONTROLLED,
    // deal damage equal to my Might to an enemy unit in a base."
    //
    // His `[Weaponmaster]` is the loader's; this is his second clause.
    //
    // **"WAS uncontrolled" is unanswerable after the fact**, which is why the
    // event now carries it: control has already moved to the conqueror by the
    // time any listener runs, so a listener asking the board would find the
    // battlefield controlled and could never tell "taken from nobody" from
    // "taken from the opponent". `updateControl` is the one site that compares
    // the two, and both conquest paths — a won combat and a walk-in — go
    // through it.
    //
    // "When **I** conquer" is positional, like every other "when I" in this
    // pool: the battlefield conquered has to be the one Yone is standing at.
    //
    // "An enemy unit IN A BASE" is the narrowest target phrase the set uses —
    // not "a unit", not "at a battlefield". A base is the one place a unit is
    // safe from combat, which is the point of the card, and it is why an enemy
    // with nothing at home takes nothing.
    //
    // Damage equal to his CURRENT Might, read through `effectiveMight` so an
    // Equipment he just attached with [Weaponmaster] counts. Non-combat context:
    // this is not a combat damage step, so [Assault] and [Shield] do not apply —
    // the same reading every other "equal to its Might" effect here takes.
    on: "battlefieldConquered",
    applies: (_state, listener, event) =>
      event.kind === "battlefieldConquered" &&
      event.wasUncontrolled === true &&
      event.conquerorIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener) => {
      const enemyIndex = listener.ownerIndex === 0 ? 1 : 0;
      const inBase = state.players[enemyIndex].baseUnits;
      // Nothing at home is nothing to hit — 422's do-as-much-as-you-can, and no
      // question is asked because the card names no choice this engine can offer
      // mid-resolution. WHICH enemy is a real choice with several at home; the
      // first is taken, and that is a recorded simplification rather than a
      // reading of the card.
      const target = inBase[0];
      if (target === undefined) return state;
      const might = effectiveMight(state, listener.card as UnitInstance, listener.ownerIndex, { isCombat: false });
      return dealDamage(state, listener.ownerIndex, target.instanceId, might);
    },
  },
  "SFD-100": {
    // Yordle Explorer — "When you play a card with Power cost [rainbow][rainbow]
    // or more, draw 1."
    //
    // "YOU play" is his controller only, so an opponent's expensive card does
    // nothing — the same reading Darius - Trifarian's and Viktor - Innovator's
    // `cardPlayed` entries take, and the field that answers it is `casterIndex`.
    //
    // **The pips are RAINBOW, so the domain is not asked.** `[rainbow][rainbow]`
    // is "two Power of any domains", which is exactly what a printed `powerCost`
    // of 2 means — `powerDomain` says which domain must pay, and the card asks
    // only how many. A 2-Power Fury card and a 2-Power Mind card both feed him.
    //
    // "OR MORE", so it is `>=` and a 3-Power card counts once, not twice: the
    // event fires per CARD played.
    //
    // ANY card, not only units — the sentence says "a card", and Spells and Gear
    // both carry Power costs in this pool. `playedKind` is deliberately not
    // consulted.
    //
    // Reads the PRINTED cost off the event rather than what was actually paid;
    // see `playedPowerCost`'s own doc for why a discount does not change what a
    // card "has".
    on: "cardPlayed",
    applies: (_state, listener, event) =>
      event.kind === "cardPlayed" &&
      event.casterIndex === listener.ownerIndex &&
      event.playedPowerCost >= YORDLE_EXPLORER_POWER_THRESHOLD,
    resolve: (state, listener) => drawCards(state, listener.ownerIndex, 1),
  },
  "SFD-119": {
    // Jax - Unrelenting's second clause — "When you attach an Equipment to me,
    // you may pay [1] to draw 1." (His first is `[Weaponmaster]`, which the
    // keyword already implements for all eleven cards that print it.)
    //
    // "TO ME" is the whole condition: the event names the WEARER, and the
    // listener is Jax himself, so this compares the two instances. An Equipment
    // attached to the unit standing beside him is not his moment.
    //
    // A MOVE counts, because the event does not distinguish one — see its own
    // comment. Jax - Grandmaster At Arms shuffling an Equipment onto this Jax is
    // attaching an Equipment to him.
    //
    // "You MAY pay" is a parked decision rather than an automatic draw: the
    // Energy is a real cost and declining is a real answer, so it goes through
    // the same offer-shaped question every other "you may pay" here uses.
    on: "equipmentAttached",
    applies: (state, listener, event) =>
      event.kind === "equipmentAttached" &&
      event.unitInstanceId === listener.card.instanceId &&
      // Offered only when the [1] is really payable — an offer nobody can take
      // is not made, the rule this file applies throughout.
      payEnergyFromPool(state, listener.ownerIndex, JAX_UNRELENTING_DRAW_COST) !== undefined,
    resolve: (state, listener) => parkDecision(state, { kind: "SFD-119-draw", playerIndex: listener.ownerIndex }),
  },
  "SFD-101": {
    // Fae Dragon's second sentence — "When you spend a buff, play a Gold gear
    // token exhausted."
    //
    // "When YOU spend" is the spender, not the buffed unit's owner — 705.1 makes
    // those the same today, and the event names the spender so they can diverge.
    //
    // Fires once per Buff SPENT, not per spending card: Overt Operation spends
    // several and each one pays. That falls out of `spendBuff` being the funnel
    // rather than out of anything decided here.
    //
    // Her own buffs feed it, which is the card's whole engine: she buffs four
    // units on arrival, and every one of those buffs spent later is a Gold.
    on: "buffSpent",
    applies: (_state, listener, event) => event.kind === "buffSpent" && event.spenderIndex === listener.ownerIndex,
    resolve: (state, listener) => placeGoldTokens(state, listener.ownerIndex, 1),
  },
  "SFD-108": {
    // Warmog's Armor — "When I conquer, buff me."
    // **ART-ONLY ABILITY.** None of this is in the card data — `text.plain` holds
    // the `[Equip]` line and nothing else, which is why this card reported
    // IMPLEMENTED while doing none of it. Transcribed from the card image; see
    // docs/sfd-equipment-abilities.md.
    //
    // "I" is the WEARER. `wearerListener` rewrites this gear's listener as the
    // unit wearing it, so every existing predicate applies unchanged.
    // "Buff ME" is the WEARER, not the gear: a buff is a +1 Might counter and
    // gear has no Might to counter. `addBuff` is idempotent per 143 (a unit that
    // already has a buff does not gain a second), so a repeat conquest is safe.
    on: "battlefieldConquered",
    applies: (state, listener, event) => {
      const wearer = wearerListener(state, listener);
      return (
        event.kind === "battlefieldConquered" &&
        wearer !== undefined &&
        event.conquerorIndex === wearer.ownerIndex &&
        wearer.battlefieldId === event.battlefieldId
      );
    },
    resolve: (state, listener) => {
      const wearer = wearerListener(state, listener);
      return wearer === undefined ? state : addBuff(state, wearer.card.instanceId);
    },
  },
  "SFD-115": {
    // Trinity Force — "When I hold, score 1 point."
    // **ART-ONLY ABILITY.** None of this is in the card data — `text.plain` holds
    // the `[Equip]` line and nothing else, which is why this card reported
    // IMPLEMENTED while doing none of it. Transcribed from the card image; see
    // docs/sfd-equipment-abilities.md.
    //
    // "I" is the WEARER. `wearerListener` rewrites this gear's listener as the
    // unit wearing it, so every existing predicate applies unchanged.
    // Through `gainPoints`, the choke point every point-gain goes through so
    // Tianna Crownguard's "opponents can't gain points" reaches it. It does NOT
    // record a battlefield as scored: this is a point awarded BY the hold, not a
    // second scoring of the battlefield, so 471.1.b's lockout is untouched.
    on: "battlefieldHeld",
    applies: (state, listener, event) => {
      const wearer = wearerListener(state, listener);
      return (
        event.kind === "battlefieldHeld" &&
        wearer !== undefined &&
        event.holderIndex === wearer.ownerIndex &&
        wearer.battlefieldId === event.battlefieldId
      );
    },
    resolve: (state, listener) => {
      const wearer = wearerListener(state, listener);
      return wearer === undefined ? state : gainPoints(state, wearer.ownerIndex, 1);
    },
  },
  "SFD-118": {
    // Boneshiver — "When I conquer, channel 1 rune exhausted."
    // **ART-ONLY ABILITY.** None of this is in the card data — `text.plain` holds
    // the `[Equip]` line and nothing else, which is why this card reported
    // IMPLEMENTED while doing none of it. Transcribed from the card image; see
    // docs/sfd-equipment-abilities.md.
    //
    // "I" is the WEARER. `wearerListener` rewrites this gear's listener as the
    // unit wearing it, so every existing predicate applies unchanged.
    // EXHAUSTED is the printed word and `channelRunesExhausted` is the helper
    // that exists for it — the Channel *Phase* always reveals Ready, so a plain
    // channel would hand over usable Power this turn.
    on: "battlefieldConquered",
    applies: (state, listener, event) => {
      const wearer = wearerListener(state, listener);
      return (
        event.kind === "battlefieldConquered" &&
        wearer !== undefined &&
        event.conquerorIndex === wearer.ownerIndex &&
        wearer.battlefieldId === event.battlefieldId
      );
    },
    resolve: (state, listener) => {
      const wearer = wearerListener(state, listener);
      return wearer === undefined ? state : channelRunesExhausted(state, wearer.ownerIndex, 1);
    },
  },
  "OGN-160": {
    // Dazzling Aurora — "At the end of your turn, reveal cards from the top of
    // your Main Deck until you reveal a unit and banish it. Play it, ignoring its
    // cost, and recycle the rest."
    //
    // The last `endOfTurn` card, and the only one of the six banish-and-play
    // cards whose played card is guaranteed to BE a unit — it reveals until it
    // finds one. That is what makes it implementable today: playing a revealed
    // SPELL free would mean putting a card on the chain from inside a resolution,
    // which nothing here can do.
    //
    // "REVEAL UNTIL" is a search with no cap, so an all-spell deck reveals the
    // whole thing, banishes nothing and recycles everything. The loop is bounded
    // by the deck rather than by a number, which is the printed behaviour and also
    // what keeps it finite.
    //
    // The banish is TRANSIENT — banished and played in one instruction — so the
    // unit goes straight to play rather than through `PlayerState.banished`, the
    // same call Baited Hook and Portal Rescue make.
    //
    // "RECYCLE the rest" is the bottom of the Main Deck (1924), not the trash, and
    // it covers every card revealed on the way including the ones before the unit.
    //
    // The reveal is `dazzlingAuroraReveal`, extracted so Void Hatchling's "look
    // at the top card first, you may recycle it" can run BEFORE it — see
    // `voidHatchlingGate`. This is the site where that matters most of the five:
    // "reveal UNTIL you reveal a unit" makes the top card decide how deep the
    // search goes, so moving it is the whole of the Hatchling's value here.
    on: "endOfTurn",
    applies: (_state, listener, event) => event.kind === "endOfTurn" && event.playerIndex === listener.ownerIndex,
    resolve: (state, listener, event) => {
      if (event.kind !== "endOfTurn") return state;
      return voidHatchlingGate(
        state,
        listener.ownerIndex,
        listener.ownerIndex,
        { kind: "OGN-160-reveal", playerIndex: listener.ownerIndex },
        (s) => dazzlingAuroraReveal(s, listener.ownerIndex),
      );
    },
  },
  "OGN-143": {
    // Pirate's Haven — "When you ready a friendly unit, give it +1 Might this
    // turn."
    //
    // **This includes the Awakening Phase**, which is the difference between a
    // combo trigger and +1 Might to your whole board every turn. Rule 415: "A
    // player Readies all non-spell Game Objects they Control during the Awakening
    // Phase on their turn" — the Awaken is a readying performed by the player, so
    // "when you ready" is satisfied. That is the strong reading and the printed
    // one; whether a card this broad was intended is a design question, and it is
    // recorded Unverified in docs/rules-conformance.md rather than softened here.
    //
    // The 415 guard that keeps it from being broader still lives in `readyUnit`
    // and `runAwaken`, not here: an already-Ready unit is not readied, so it
    // produces no event and gets no Might.
    //
    // "Give IT" — the readied unit, carried on the event. Re-derived from the
    // board it could not be found at all: `unitReadied` is held, and by the time
    // this resolves the unit may have moved, and several other units may have
    // been readied in the same Awaken.
    on: "unitReadied",
    // "A FRIENDLY unit", measured against the HAVEN's controller — the same
    // relative reading Wraith of Echoes and Vanguard Helm take. Asked here rather
    // than in `resolve` because an enemy's ready must not cost both players a
    // PassFocus for an ability that would resolve to nothing; with the Awaken
    // firing one of these per exhausted unit, that is not a rare shape.
    applies: (_state, listener, event) => event.kind === "unitReadied" && event.ownerIndex === listener.ownerIndex,
    resolve: (state, listener, event) =>
      event.kind === "unitReadied" ? giveMightThisTurnToOwnUnit(state, listener.ownerIndex, event.unitInstanceId, 1) : state,
  },
  "OGN-158": {
    // Volibear - Imposing — "[Shield 3][Tank] When an opponent moves to a
    // battlefield other than mine, draw 1. (Bases are not battlefield.)"
    //
    // Fires PER UNIT MOVED, because `unitMoved` is fired per unit inside
    // `execute-move-unit`'s loop: a MoveUnitAction carries an ARRAY of units, and
    // three units walking together are three moves. Recorded as Unverified —
    // "when an opponent moves" could be read per ACTION, and the two differ by a
    // factor of three on the board this card is built to punish.
    //
    // "OTHER THAN MINE" is positional, so **he must be AT a battlefield for it to
    // name anything**: in base he has no "mine" for a destination to differ from,
    // and he draws nothing. The same reading Sett - Kingpin and Lee Sin -
    // Centered take of their own positional text. Also Unverified.
    //
    // The parenthetical is about the DESTINATION: a unit recalled or moved home
    // has not moved "to a battlefield". `unitMoved` only fires for a Standard
    // Move to a battlefield, so that is already true without a check here.
    on: "unitMoved",
    applies: (_state, listener, event) =>
      event.kind === "unitMoved" &&
      event.moverIndex !== listener.ownerIndex &&
      listener.battlefieldId !== undefined &&
      event.to !== listener.battlefieldId,
    resolve: (state, listener, event) => {
      if (event.kind !== "unitMoved") return state;
      if (event.moverIndex === listener.ownerIndex) return state;
      return drawCards(state, listener.ownerIndex, 1);
    },
  },
  "OGN-139": {
    // Cithria of Cloudfield — "When you play another unit, buff me."
    //
    // Three conditions, all printed. **You**: only her controller's plays, so an
    // opponent building a board does not feed her. **Unit**: a Spell or Gear is
    // not a unit, and without the kind check she would grow off Showstopper and
    // Call to Glory — which is a lot, in the deck she is actually played in.
    // **Another**: her own arrival must not buff her, which matters because the
    // cardPlayed event fires for her too.
    //
    // She stacks: 710 makes a second Buff on an already-buffed unit a no-op, so
    // she is +1 Might once and then stops climbing. That is the rules working,
    // not a missing feature — the payoff for a board full of units is Sett -
    // Kingpin's aura counting her as one more buffed body.
    on: "cardPlayed",
    // All three printed conditions read the EVENT and the listener's own
    // identity, none of which the response window can change, so they are safe
    // in both places — and they belong here because `cardPlayed` is held now: a
    // trigger held for a Spell, or for the opponent's play, would cost both
    // players a PassFocus for an ability that resolves to nothing.
    applies: (_state, listener, event) =>
      event.kind === "cardPlayed" &&
      event.casterIndex === listener.ownerIndex &&
      event.playedKind === "Unit" &&
      event.playedInstanceId !== listener.card.instanceId,
    resolve: (state, listener, event) => {
      if (event.kind !== "cardPlayed") return state;
      if (event.casterIndex !== listener.ownerIndex) return state;
      if (event.playedKind !== "Unit") return state;
      if (event.playedInstanceId === listener.card.instanceId) return state; // "another"
      return addBuff(state, listener.card.instanceId);
    },
  },
  "OGN-164": {
    // Sett - Brawler's second half — "and when I conquer, buff me."
    //
    // "When I conquer" is his own conquest, so he must be AT the battlefield
    // taken — the same reading Kai'Sa - Survivor takes, and what separates a
    // unit's conquer trigger from a Legend's "when you conquer".
    on: "battlefieldConquered",
    // Both conditions decide whether this goes ON THE CHAIN, so they belong here
    // and not only in `resolve` — `battlefieldConquered` is a held event now, and
    // a trigger held for a conquest that is not his opens a response window for
    // nothing.
    //
    // The LOCATION check is here and NOT re-checked in `resolve`, deliberately.
    // 383 fixes what triggered at the moment of the event; between then and the
    // resolution there is a real window in which Sett can be moved, killed or
    // bounced, and 809.1.b.3 exists precisely so a permanent that has left still
    // resolves its trigger. Re-asking at resolution would let the opponent cancel
    // a fired trigger by pushing him one battlefield sideways.
    applies: (_state, listener, event) =>
      event.kind === "battlefieldConquered" &&
      event.conquerorIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldConquered") return state;
      // The conqueror check survives here because it reads only the event and the
      // listener's owner, neither of which the response window can change. The
      // location check does not — see `applies`.
      if (event.conquerorIndex !== listener.ownerIndex) return state;
      return addBuff(state, listener.card.instanceId);
    },
  },
  "OGN-152": {
    // Mistfall — "When you buff a friendly unit, you may pay [Body] and exhaust
    // this to ready it."
    //
    // Reachable at all only because addBuff is a single funnel: every card that
    // buffs anything goes through it, so this hears all of them without any of
    // them knowing it exists.
    //
    // "You MAY" is why this parks a question rather than just doing it. Readying
    // a unit is not always wanted (a ready unit can be forced into a Showdown),
    // the Power is real, and exhausting Mistfall spends its own turn — so the
    // decline has to be a genuine option, which it is by being one of the two
    // answers rather than an inference.
    on: "unitBuffed",
    // "A FRIENDLY unit" is measured against Mistfall's controller, not against
    // whoever caused the buff — buffing an ENEMY unit must not trigger this at all.
    //
    // Stated here as well as in `resolve` because the two answer different
    // questions once this trigger is held as a Chain Pending Item: this one decides
    // whether it goes on the chain (and so whether both players are asked to pass),
    // while `resolve`'s copy decides what happens when it gets there, on a board
    // that the response window may have changed.
    applies: (_state, listener, event) => event.kind === "unitBuffed" && event.ownerIndex === listener.ownerIndex,
    resolve: (state, listener, event) => {
      if (event.kind !== "unitBuffed") return state;
      if (event.ownerIndex !== listener.ownerIndex) return state;
      if (listener.card.exhausted) return state; // it exhausts itself to pay
      return parkDecision(state, {
        kind: "OGN-152-ready",
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
        // The unit to ready rides here rather than being re-derived: by the time
        // the question is answered the board may have moved on, and "it" means
        // the unit that was buffed.
        targetInstanceId: event.unitInstanceId,
      });
    },
  },
  "OGN-155": {
    // Qiyana - Victorious — "When I conquer, draw 1 or channel 1 rune exhausted."
    //
    // "When *I* conquer" is Kai'Sa - Survivor's reading (OGN-039, fury.ts): she
    // has to be AT the conquered battlefield, which is what separates it from a
    // "when you conquer" card that fires wherever it sits. Checked against the
    // listener's own location rather than the event alone, since the listener
    // walk reaches her anywhere.
    //
    // Her `[Deflect]` is a separate, still-unimplemented clause — the card stays
    // correctly reported as partial (coverage.ts's UNIMPLEMENTED_KEYWORDS).
    on: "battlefieldConquered",
    // Same shape as Sett - Brawler above, and for the same reasons: both
    // conditions gate whether this reaches the chain, and the location one is
    // deliberately not re-asked in `resolve`. Her question is worth more than his
    // buff, so cancelling it by moving her would be a real exploit.
    applies: (_state, listener, event) =>
      event.kind === "battlefieldConquered" &&
      event.conquerorIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldConquered") return state;
      if (event.conquerorIndex !== listener.ownerIndex) return state;
      return parkDecision(state, { kind: "OGN-155-conquer", playerIndex: listener.ownerIndex });
    },
  },
  "SFD-110": {
    // Fiora - Peerless — "When I attack or defend one on one, double my Might
    // this combat."
    //
    // `isFightingAt` is the "attack OR defend" predicate Ahri - Inquisitive
    // already uses, and it carries the two checks this card would otherwise have
    // to repeat: she must be a UNIT standing at the battlefield the combat opened
    // at, and she must be GAINING her designation now (383.4.f, "for the first
    // time during a combat") — so a reinforcement walking in later does not fire
    // her again.
    //
    // **"One on one" is a defined term**, and the rules define it in two steps in
    // their Special Terms section: "A unit is ALONE when there are no other
    // friendly units at the same location", and "A unit is ONE ON ONE when it and
    // the enemy unit at the same location are both alone." So it is exactly one
    // unit per side at the battlefield — see `oneOnOneAt`.
    //
    // The condition is a requirement BESIDES the trigger, so 383.4 settles it at
    // the moment of the event and it lives in `applies`: a combat she joins with a
    // friend beside her must place no Pending Item at all, rather than one that
    // closes the chain, costs both players a PassFocus and resolves to nothing.
    on: "combatBegan",
    applies: (state, listener, event) => isFightingAt(state, listener, event) && oneOnOneAt(state, listener, event),
    resolve: (state, listener) => {
      // **"THIS COMBAT" is implemented as this TURN, and that is the divergence.**
      // The bonus lands on `mightThisTurn`, so a second combat in the same turn
      // would still find it — and so would anything else that reads her Might,
      // `[Mighty]` included. There is no per-combat scope in this engine and
      // inventing one for a single card would be a subsystem; Fortified Position's
      // "[Shield 2] this combat" (battlefield-abilities.ts) already takes exactly
      // this approximation for exactly this reason. NEEDS a row in
      // docs/rules-conformance.md.
      //
      // "DOUBLE my Might" is +M rather than ×2 on a field, because Might is a sum
      // of printed value, this-turn modifiers, buffs and auras (effective-might.ts)
      // and only the sum can be doubled. Read at RESOLUTION, which is a response
      // window after the trigger fired: a pump cast in that window is part of the
      // Might being doubled, which is what "double my Might" says.
      //
      // `isCombat: false`, the same reading `isMighty` records: the combat-only
      // terms are `[Assault]` and `[Shield]`, which are damage-side adjustments
      // rather than part of the Might this ability is doubling.
      const found = findUnitAnywhere(state, listener.card.instanceId);
      if (!found) return state; // killed in the window — 359.3, the calculation drops out
      return giveMightThisTurn(state, listener.card.instanceId, mightInPlace(state, found));
    },
  },
  "SFD-112": {
    // Kato the Arm — "[Deflect] When I move to a battlefield, give another
    // friendly unit my keywords and +Might equal to my Might this turn."
    //
    // Registered against the board-wide `unitMoved` event rather than
    // unit-triggers.ts's per-card ON_MOVE_TRIGGERS table, which this file does not
    // own. The two reach the same moment: that event is fired once per unit by
    // `execute-move-unit` AFTER the unit has landed, and only for a Standard Move
    // to a battlefield — never for a spell-driven relocation or a Recall (454), so
    // "when I move TO A BATTLEFIELD" needs no extra check.
    //
    // "When **I** move" is the identity check in `applies`: the event fires for
    // every unit either player moves, and without it Kato would hand out his
    // keywords whenever anything on the board took a step.
    on: "unitMoved",
    applies: (_state, listener, event) =>
      event.kind === "unitMoved" && event.unitInstanceId === listener.card.instanceId,
    resolve: (state, listener, event) => {
      if (event.kind !== "unitMoved") return state;
      if (event.unitInstanceId !== listener.card.instanceId) return state;
      // "ANOTHER friendly unit" with no battlefield named, so base counts
      // (355.9.b) and Kato himself does not. Nothing to give it to is 422's
      // do-as-much-as-you-can and asks nothing — the same place Miss Fortune -
      // Captain puts her "is anything exhausted" check, and for the same reason:
      // whether a recipient EXISTS is a question about the board at resolution,
      // not a requirement that decides whether the ability triggered.
      if (otherFriendlyUnits(state, listener.ownerIndex, listener.card.instanceId).length === 0) return state;
      return parkDecision(state, {
        kind: "SFD-112-gift",
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
      });
    },
  },
  "SFD-113": {
    // Lucian - Merciless — "[Weaponmaster] The first time I conquer each turn,
    // ready me." (The keyword is implemented in engine/equipment.ts and fires
    // from the on-play funnel, so only the second sentence is here.)
    //
    // "When *I* conquer" is Sett - Brawler's and Qiyana - Victorious' positional
    // reading above: he must be standing at the battlefield that was taken. Same
    // split too — both that check and the conqueror check gate whether this
    // reaches the chain, and the LOCATION one is deliberately not re-asked in
    // `resolve` (383 fixes what triggered at the moment of the event, and
    // re-asking would let an opponent cancel a fired trigger by pushing him one
    // battlefield sideways).
    //
    // **"THE FIRST TIME EACH TURN" is load-bearing rather than flavour**, because
    // this card is the thing that makes a second conquest possible: a Standard
    // Move exhausts (`execute-move-unit`), so readying him is what lets him walk
    // on and take a second battlefield in the same turn. Without the limit he
    // would ready again there and the loop would only end when the board did.
    //
    // The memory is per UNIT and per TURN, and it is written into
    // `UnitInstance.abilityModesUsedThisTurn` — see `hasConqueredThisTurn`. The
    // alternative, a `conquestsThisTurn` counter beside `movesThisTurn`, is the
    // tidier field and was rejected only because it lives in model/card.ts and
    // turn-manager.ts, which this file's owner does not own.
    on: "battlefieldConquered",
    applies: (_state, listener, event) =>
      event.kind === "battlefieldConquered" &&
      event.conquerorIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId &&
      !hasConqueredThisTurn(listener.card),
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldConquered") return state;
      if (event.conquerorIndex !== listener.ownerIndex) return state;
      // Re-read from the LIVE board rather than from `listener.card`, which is the
      // snapshot taken when the trigger fired for a Lucian that has since left
      // play. Nothing can mark him between the two, so this is belt and braces —
      // but it is the copy that would matter if a second conquest ever landed
      // inside one submit.
      const live = findUnitAnywhere(state, listener.card.instanceId);
      if (!live) return state; // 359.3 — he is gone, and there is nothing to ready
      if (hasConqueredThisTurn(live.unit)) return state;
      return readyUnit(markConquestUsed(state, listener.card.instanceId), listener.card.instanceId);
    },
  },
  "SFD-120": {
    // Sivir - Ambitious — "[Deflect 2] When I conquer after an attack, if you
    // assigned 5 or more excess damage to enemy units, you may deal that much to
    // an enemy unit."
    //
    // The trigger CONDITION is Tryndamere - Barbarian's (OGN-034, effects/fury.ts)
    // word for word; only the payout differs, so it reads the same three facts and
    // `sivirQualifies` mirrors `tryndamereQualifies`:
    //  - "when I conquer" is positional — she must be standing at the battlefield
    //    that was taken;
    //  - "after an attack" is why `lastShowdownExcessDamage` carries a battlefield
    //    and an attacking side, so a conquest by walking into an empty battlefield
    //    (which never wrote it) cannot borrow another fight's number;
    //  - "5 or more excess damage" is a term the rules never define — `excess`
    //    appears in the PDF only under Burn Out — and combat.ts's `excessAssigned`
    //    records why all three candidate readings coincide here.
    //
    // "THAT MUCH" is the same figure the condition tested, so it is re-read from
    // `lastShowdownExcessDamage` when the question is answered rather than copied
    // onto the decision: nothing between the conquest and the answer can write it
    // (only a combat's damage step does, and a combat cannot open mid-chain), and
    // the decision carries the battlefield so a stale record cannot be mistaken
    // for this one.
    on: "battlefieldConquered",
    applies: (state, listener, event) => sivirQualifies(state, listener, event),
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldConquered") return state;
      // The conqueror and the excess record are re-checked because the response
      // window cannot change either. The LOCATION check deliberately is not — same
      // reading as Sett - Brawler and Qiyana - Victorious above: 383 fixes what
      // triggered at the moment of the event, and re-asking would let an opponent
      // cancel a fired trigger by pushing her one battlefield sideways.
      if (event.conquerorIndex !== listener.ownerIndex) return state;
      if (excessFor(state, listener.ownerIndex, event.battlefieldId) < SIVIR_EXCESS_REQUIRED) return state;
      return parkDecision(state, {
        kind: "SFD-120-strike",
        playerIndex: listener.ownerIndex,
        battlefieldId: event.battlefieldId,
      });
    },
  },
};

/** Triggers a card fires about ITSELF — being played, discarded or killed. Keyed
 *  by that card's own defId, because at those moments it may not be in play for
 *  a listener walk to reach (see triggers.ts's SelfTriggerDefinition). */
export const selfTriggers: Record<string, SelfTriggerDefinition> = {};

/** Questions this domain's cards stop to ask — see engine/decisions.ts. Keyed by
 *  a `kind` string rather than a defId, since one card can ask more than one
 *  kind of question; the one-file-one-owner rule still applies, and the key is
 *  prefixed with the card's defId so ownership stays readable. */
export const decisions: Record<string, DecisionDefinition> = {
  /**
   * Void Hatchling's look, before Dazzling Aurora's reveal.
   *
   * Registered under the SITE's defId — the question is the Hatchling's and the
   * CONTINUATION is hers, which is what the `<defId>-<what it asks>` convention
   * means for a replacement effect. His own coverage claim is in
   * `top-of-deck.topOfDeckDefIds`, beside Nocturne's and for the same reason.
   */
  "OGN-160-reveal": {
    prompt: () => "Void Hatchling: recycle the top card before Dazzling Aurora reveals?",
    options: (state, d) => voidHatchlingOptions(state, d.playerIndex),
    resolve: (state, d, optionId) =>
      dazzlingAuroraReveal(voidHatchlingAnswer(state, d.playerIndex, optionId), d.playerIndex),
  },

  "SFD-119-draw": {
    // Jax - Unrelenting's "you may pay [1] to draw 1."
    prompt: () => "Jax - Unrelenting: pay [1] to draw 1?",
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      // Re-asked at ANSWER time as well as at fire time: the Energy may have
      // gone while the question waited on the chain, and an option offered then
      // is one the resolver has to honour.
      if (payEnergyFromPool(state, d.playerIndex, JAX_UNRELENTING_DRAW_COST)) {
        options.push({ id: "pay", label: "Pay [1] and draw 1" });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId !== "pay") return state;
      const paid = payEnergyFromPool(state, d.playerIndex, JAX_UNRELENTING_DRAW_COST);
      // A payment that cannot be made does not draw — re-derived rather than
      // trusted, the convention every paid decision in this file follows.
      return paid ? drawCards(paid, d.playerIndex, 1) : state;
    },
  },
  // Qiyana - Victorious's "draw 1 OR channel 1 rune exhausted", raised by her
  // on-conquer trigger above.
  //
  // A genuine either/or with no decline — unlike Mistfall and Miss Fortune
  // below, the card offers no third answer, so neither option is listed as one.
  //
  // BOTH are offered unconditionally, even when the corresponding pile is empty,
  // and that is deliberate on each side. An empty rune deck channels nothing
  // (315.4.b, channelRunesExhausted's own "as many as it can"), and an empty
  // DECK is not a non-choice either — drawing from one is what triggers Burn Out
  // (431), a real and sometimes correct outcome. Suppressing an option here
  // would take a legal decision away from the player, and `advanceDecisions`
  // auto-resolves a one-option question, so pruning would silently pick for them.
  "OGN-155-conquer": {
    prompt: () => "Qiyana - Victorious: draw 1, or channel 1 rune exhausted?",
    options: () => [
      { id: "draw", label: "Draw 1" },
      { id: "channel", label: "Channel 1 rune exhausted" },
    ],
    resolve: (state, d, optionId) =>
      optionId === "draw" ? drawCards(state, d.playerIndex, 1) : channelRunesExhausted(state, d.playerIndex, 1),
  },
  // Sabotage's "choose a non-unit card from it, and recycle that card".
  //
  // Chooser is the caster; the hand and the deck it goes to the bottom of are
  // the opponent's. Filtering to non-units HERE rather than in the resolver is
  // what makes an all-units hand offer nothing at all, which is the card doing
  // as much as it can (422) rather than the player being asked a fake question.
  "OGN-156-recycle": {
    prompt: () => "Sabotage: choose a non-unit card to recycle",
    options: (state, d) => {
      const opponent = state.players[d.playerIndex === 0 ? 1 : 0];
      return opponent.hand
        .filter((c) => c.kind !== "Unit")
        .map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId }));
    },
    resolve: (state, d, optionId) => recycleCardFromHand(state, d.playerIndex === 0 ? 1 : 0, optionId),
  },
  // Miss Fortune - Captain's "you may ready something else that's exhausted",
  // raised by her on-move trigger the first time she moves each turn.
  //
  // Options are rebuilt from live state, so a permanent readied by something
  // else between the trigger and the answer is simply no longer on offer.
  // Declining is always available and listed first, so a mis-click and the AI's
  // tie-break both land on doing nothing.
  "OGN-162-ready": {
    prompt: () => "Miss Fortune - Captain: ready something else that's exhausted?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...readyableOthers(state, d.playerIndex, d.cardInstanceId ?? "").map((c) => ({
        id: c.instanceId,
        label: `Ready ${c.name}`,
        instanceId: c.instanceId,
      })),
    ],
    resolve: (state, d, optionId) => (optionId === "decline" ? state : readyPermanent(state, d.playerIndex, optionId)),
  },
  "OGN-152-ready": {
    prompt: () => "Mistfall: pay 1 Body Power and exhaust it to ready the buffed unit?",
    options: (state, d) => {
      // Declining is always available — "you may". Listed first so that a player
      // (or the AI's tie-breaking) defaults to doing nothing rather than paying.
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      // The offer is only real if BOTH halves of the cost can still be paid and
      // there is still something to ready. 416.3's shape: a cost that cannot be
      // completed is not a cost you may choose to pay.
      const gear = state.players[d.playerIndex].activeGear.find((g) => g.instanceId === d.cardInstanceId);
      const unit = d.targetInstanceId ? findUnitAnywhere(state, d.targetInstanceId) : undefined;
      if (gear && !gear.exhausted && unit?.unit.exhausted && payPowerFromChanneled(state, d.playerIndex, "Body", 1)) {
        options.push({ id: "pay", label: "Pay 1 Body Power and exhaust Mistfall", instanceId: gear.instanceId });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId !== "pay") return state;
      const paid = payPowerFromChanneled(state, d.playerIndex, "Body", 1);
      if (!paid) return state;
      return readyUnit(exhaustGear(paid, d.playerIndex, d.cardInstanceId!), d.targetInstanceId!);
    },
  },
  // Overt Operation's "for each friendly unit, you may spend its buff to ready
  // it" — one of these per buffed friendly unit, raised in board order.
  //
  // The unit rides on `targetInstanceId` rather than being re-derived from the
  // board, for Mistfall's reason above: "its buff" means THIS unit's, and by the
  // time this question reaches the front an earlier answer may have changed what
  // is buffed. Options are still rebuilt live, so a unit that lost its buff (or
  // died) in the meantime is simply no longer offered the spend.
  "OGN-153-spend": {
    prompt: (state, d) => {
      const unit = d.targetInstanceId ? findUnitAnywhere(state, d.targetInstanceId) : undefined;
      return `Overt Operation: spend ${unit?.unit.name ?? "this unit"}'s buff to ready it?`;
    },
    options: (state, d) => {
      // Declining first, so a mis-click and the AI's tie-break both do nothing —
      // the same ordering Mistfall and Miss Fortune - Captain use.
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      const found = d.targetInstanceId ? findUnitAnywhere(state, d.targetInstanceId) : undefined;
      // Ownership is re-checked as well as the buff: 705.1 restricts spending to
      // units you control, and control can move (Hostile Takeover) between the
      // question being raised and answered.
      if (found && found.ownerIndex === d.playerIndex && found.unit.buffed) {
        options.push({ id: "spend", label: `Spend ${found.unit.name}'s buff to ready it`, instanceId: found.unit.instanceId });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId !== "spend") return state;
      const paid = spendBuff(state, d.playerIndex, d.targetInstanceId!);
      if (!paid) return state; // cost unpayable (705/705.1) — no ready
      return readyUnit(paid, d.targetInstanceId!);
    },
  },
  // Overt Operation's "Then buff all friendly units."
  //
  // Never a real question — one option, so `advanceDecisions` executes it the
  // instant it reaches the front and no player is ever shown it. It exists only
  // to sit BEHIND the spend questions in the queue, which is the whole of what
  // "then" asks for. Exactly decisions.ts's `draw` precedent.
  //
  // The roster is re-read here rather than snapshotted when the card resolved,
  // because a unit that died to something on the chain must not be buffed and
  // one that arrived should be.
  "OGN-153-buff-all": {
    prompt: () => "Overt Operation: buff all friendly units",
    options: () => [{ id: "buff", label: "Buff all friendly units" }],
    resolve: (state, d) =>
      ownUnitsEverywhere(state, d.playerIndex).reduce((next, unit) => addBuff(next, unit.instanceId), state),
  },
  // Buhru Captain's "you may draw 1 or buff me", raised by his on-play trigger.
  //
  // THREE answers, where Qiyana - Victorious' near-identical either/or gets two.
  // The difference is the printed "you MAY", so declining is listed — and listed
  // FIRST, the ordering Mistfall and Miss Fortune - Captain use so that a
  // mis-click and a tie in the AI's scoring both land on doing nothing. (The AI
  // does not simply take the head: it scores every answer, see
  // `settleDeferredResolution`.)
  //
  // The DRAW is offered unconditionally, empty deck included, for Qiyana's
  // reason: drawing from an empty Main Deck is what triggers Burn Out (431), a
  // real outcome rather than a non-choice, and suppressing the option would take
  // a legal decision away.
  //
  // The BUFF is not, and the asymmetry is deliberate: the Captain is the thing
  // being buffed, an on-play trigger resolves even though its source has left
  // play (809.1.b), and a buff aimed at a card already in the trash would be an
  // option that visibly does nothing. 359.3 — the check returns null and the
  // calculation drops out.
  "SFD-091-choose": {
    prompt: () => "Buhru Captain: draw 1, or buff me?",
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }, { id: "draw", label: "Draw 1" }];
      const captain = d.cardInstanceId ? findUnitAnywhere(state, d.cardInstanceId) : undefined;
      if (captain) options.push({ id: "buff", label: "Buff me", instanceId: captain.unit.instanceId });
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId === "draw") return drawCards(state, d.playerIndex, 1);
      if (optionId === "buff") return addBuff(state, d.cardInstanceId!);
      return state; // declined — "you may"
    },
  },
  // Kato the Arm's "give ANOTHER friendly unit my keywords and +Might equal to my
  // Might this turn", raised by his on-move trigger.
  //
  // NOT a "you may", so there is no decline: the ability is mandatory and the only
  // choice is which friendly unit receives it. A board with nobody else on it is
  // handled before the question is ever raised (see the trigger).
  //
  // Kato is re-read HERE rather than snapshotted onto the decision, and both his
  // Might and his keyword set with him. That is the closest thing to resolution
  // time this mechanism has — nothing else is legal while a question is pending —
  // and it is what makes "my keywords" mean the ones he has NOW: `effectiveKeywords`
  // folds in his printed `[Deflect]`, anything an aura is granting him and anything
  // granted to him earlier this turn. He is gone if he was killed answering an
  // earlier queued question, in which case 359.3 drops the whole calculation.
  //
  // The keywords are granted THIS TURN (`keywordsThisTurn`) rather than written
  // into the recipient's printed set, which is where the printed "this turn"
  // lands. Read as governing BOTH halves of the gift — the keywords and the Might
  // — since the sentence gives them together; the alternative, permanent keywords
  // plus temporary Might, would make a 4-Energy common the pool's only source of
  // permanent keyword-granting. Flagged as the reading taken rather than a
  // certainty.
  "SFD-112-gift": {
    prompt: (state, d) => {
      const kato = d.cardInstanceId ? findUnitAnywhere(state, d.cardInstanceId) : undefined;
      return `Kato the Arm: give another friendly unit his keywords and +${kato ? mightInPlace(state, kato) : 0} Might this turn`;
    },
    options: (state, d) =>
      otherFriendlyUnits(state, d.playerIndex, d.cardInstanceId ?? "").map((u) => ({
        id: u.instanceId,
        label: u.name,
        instanceId: u.instanceId,
      })),
    resolve: (state, d, optionId) => {
      const kato = d.cardInstanceId ? findUnitAnywhere(state, d.cardInstanceId) : undefined;
      if (!kato) return state; // 359.3 — nothing left to copy from
      const granted = Object.entries(effectiveKeywords(state, kato.unit, kato.ownerIndex)).reduce(
        (next, [keyword, value]) => grantKeywordThisTurn(next, optionId, keyword as Keyword, value ?? 1),
        state,
      );
      return giveMightThisTurn(granted, optionId, mightInPlace(state, kato));
    },
  },
  // Sivir - Ambitious' "you may deal that much to an enemy unit", raised by her
  // on-conquer trigger once the excess threshold is met.
  //
  // "AN ENEMY UNIT" with no "here" printed, so this reaches the opponent's whole
  // board including their base (355.9.b) — the same distinction Twisted Fate -
  // Gambler's two branches draw from each other, one saying "here" and one not.
  //
  // "THAT MUCH" is re-derived from `lastShowdownExcessDamage` rather than carried,
  // so the label and the damage cannot disagree; the decision's battlefield is
  // what stops an older fight's number being read as this one's.
  "SFD-120-strike": {
    prompt: (state, d) =>
      `Sivir - Ambitious: deal ${excessFor(state, d.playerIndex, d.battlefieldId)} to an enemy unit?`,
    options: (state, d) => {
      // "You MAY", so declining is a real answer and is listed first.
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      const amount = excessFor(state, d.playerIndex, d.battlefieldId);
      if (amount <= 0) return options;
      for (const unit of ownUnitsEverywhere(state, d.playerIndex === 0 ? 1 : 0)) {
        options.push({ id: unit.instanceId, label: `Deal ${amount} to ${unit.name}`, instanceId: unit.instanceId });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      const amount = excessFor(state, d.playerIndex, d.battlefieldId);
      return amount > 0 ? dealDamage(state, d.playerIndex, optionId, amount) : state;
    },
  },
  // Fae Dragon's "buff up to four friendly units", raised by her on-play trigger
  // with `count: 4` and re-parked one lower per unit taken — the `discard`
  // handler's shape in decisions.ts, and the reason `PendingDecision.count`
  // exists at all.
  //
  // `repeatDecision` rather than four `parkDecision`s, and the difference is the
  // queue position: a continuation goes to the FRONT, so a question raised behind
  // this one (Mistfall's, which each buff can raise) cannot land between two of
  // her four. Four separate parks would have interleaved them.
  //
  // OPTIONS ARE UNBUFFED FRIENDLIES ONLY. Rule 708 makes a second buff on an
  // already-buffed unit a no-op and `addBuff` implements that by doing nothing at
  // all — not even firing `unitBuffed` — so offering one would be an answer that
  // visibly does nothing, the same asymmetry Buhru Captain's buff option draws.
  // It also gives "up to four units" its distinctness for free: a unit taken in
  // one question is buffed and so is not on offer in the next.
  //
  // SHE IS A CANDIDATE HERSELF. "Four FRIENDLY units" prints no "other" (contrast
  // Kinkou Monk), and unlike his, this choice is made after she has landed — so
  // she is genuinely on the board to be picked rather than excluded by accident of
  // when the enumeration ran.
  //
  // DECLINING ENDS THE SEQUENCE rather than skipping one slot. The four are
  // interchangeable, so "decline this one and take the next" cannot differ from
  // "stop" in any board state; ending is what stops a player who wants two buffs
  // from being asked twice more for nothing.
  "SFD-101-buff": {
    prompt: (_state, d) => `Fae Dragon: buff a friendly unit (up to ${d.count ?? 1} more)`,
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...ownUnitsEverywhere(state, d.playerIndex)
        .filter((u) => !u.buffed)
        .map((u) => ({ id: u.instanceId, label: `Buff ${u.name}`, instanceId: u.instanceId })),
    ],
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      const buffed = addBuff(state, optionId);
      const remaining = (d.count ?? 1) - 1;
      return remaining > 0 ? repeatDecision(buffed, { ...d, count: remaining }) : buffed;
    },
  },
  // Here to Help's "you may play a unit from hand", the first of its two
  // questions.
  //
  // Priced when the OPTIONS are built, so a unit whose reduced cost cannot be
  // paid is never offered — 416.3's "the action must be able to be completed for
  // the cost to be paid", the same shape Void Rush's offer takes.
  //
  // The destination is checked here as well, and it has to be: with no battlefield
  // under the caster's control the whole instruction is unperformable, and offering
  // a unit that then hits a question with no answers would take the payment and
  // leave the card in hand.
  "SFD-111-play": {
    prompt: () => "Here to Help: play a unit from hand for 3 less Energy?",
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      if (controlledBattlefields(state, d.playerIndex).length === 0) return options;
      for (const card of state.players[d.playerIndex].hand) {
        if (card.kind !== "Unit") continue; // "play a UNIT from hand"
        if (hereToHelpPayment(state, d.playerIndex, card) === undefined) continue;
        options.push({ id: card.instanceId, label: hereToHelpLabel(state, d.playerIndex, card), instanceId: card.instanceId });
      }
      return options;
    },
    // The unit is left IN HAND and named on the follow-up question rather than
    // pulled out and carried: `PendingDecision` has no field for a card, and a
    // unit removed from hand while a question is outstanding would be in no zone
    // at all if that question were then dropped.
    resolve: (state, d, optionId) =>
      optionId === "decline"
        ? state
        : parkDecision(state, { kind: "SFD-111-where", playerIndex: d.playerIndex, cardInstanceId: optionId }),
  },
  // Here to Help's "to a battlefield you control", the second question.
  //
  // Never shown on the usual board: `advanceDecisions` executes a one-option
  // question without prompting, and controlling two battlefields at once is
  // already most of a win.
  //
  // **"A battlefield you control" is not "a battlefield you have units at"**, and
  // that is the whole placement clause — it is what lets this reinforce a
  // battlefield the caster holds while barring it as a way to drop a body into an
  // empty or enemy one. It also makes `applyContested` provably unnecessary here
  // rather than merely omitted: `cleanup.applyContested` returns the state
  // unchanged when the arriving player already controls the battlefield, which is
  // the only case this can reach.
  "SFD-111-where": {
    prompt: (state, d) => `Here to Help: where does ${handUnit(state, d.playerIndex, d.cardInstanceId)?.name ?? "it"} enter play?`,
    options: (state, d) =>
      handUnit(state, d.playerIndex, d.cardInstanceId) === undefined
        ? []
        : controlledBattlefields(state, d.playerIndex).map((bf) => ({ id: bf.id, label: bf.name })),
    resolve: (state, d, optionId) => {
      const unit = handUnit(state, d.playerIndex, d.cardInstanceId);
      if (!unit) return state;
      // Re-paid here rather than trusted from the option list, which was built
      // against the state one question ago. An unpayable cost withholds the play
      // instead of handing the unit over free — Void Rush's reading, and the
      // convention `spendBuff` and `payPowerFromChanneled` share.
      const paid = hereToHelpPayment(state, d.playerIndex, unit);
      if (paid === undefined) return state;

      const players = [...paid.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        hand: players[d.playerIndex].hand.filter((c) => c.instanceId !== unit.instanceId),
        // "PLAY a unit" — this IS a card the caster played, so [Legion] and Viktor
        // - Innovator both count it. Same call Void Rush and Ava Achiever make.
        cardsPlayedThisTurn: players[d.playerIndex].cardsPlayedThisTurn + 1,
      };
      // `playUnitToBattlefield` fires everything a play fires — the unit's own
      // on-play trigger, `cardPlayed`, and its self-trigger. With NO targets,
      // because nothing announced it: a unit whose on-play trigger names a target
      // does as much as it can and no more, which is the divergence every free
      // play in this engine already carries (docs/rules-conformance.md,
      // play-free.ts).
      return playUnitToBattlefield({ ...paid, players }, d.playerIndex, unit, optionId);
    },
  },
};

/**
 * Rule 745's "one on one", spelled out in the PDF's Special Terms in two steps:
 * "A unit is ALONE when there are no other friendly units at the same location",
 * and "A unit is ONE ON ONE when it and the enemy unit at the same location are
 * both alone."
 *
 * So both halves are counts, not a claim about the listener alone: exactly one of
 * the listener's units here AND exactly one of the opponent's. Two enemies facing
 * a lone Fiora is not one on one, which is what stops the card from being "double
 * my Might whenever I am outnumbered".
 *
 * Reads the board at the moment the combat opened, which is when `applies` is
 * asked (383.4) — a reinforcement arriving later cannot un-trigger it.
 */
function oneOnOneAt(state: GameState, listener: Listener, event: GameEvent): boolean {
  if (event.kind !== "combatBegan") return false;
  const bf = state.battlefields.find((b) => b.id === event.battlefieldId);
  if (!bf) return false;
  const enemyIndex: 0 | 1 = listener.ownerIndex === 0 ? 1 : 0;
  return (
    (bf.units[state.players[listener.ownerIndex].id]?.length ?? 0) === 1 &&
    (bf.units[state.players[enemyIndex].id]?.length ?? 0) === 1
  );
}

/** How much excess damage `playerIndex` assigned in the fight at
 *  `battlefieldId`, or 0 if the record is from a different battlefield, from the
 *  other side of a fight, or absent entirely. One reader for Sivir's condition,
 *  her prompt and her damage, so the three cannot disagree about the number. */
function excessFor(state: GameState, playerIndex: 0 | 1, battlefieldId: string | undefined): number {
  const excess = state.lastShowdownExcessDamage;
  if (!excess || excess.battlefieldId !== battlefieldId || excess.attackerIndex !== playerIndex) return 0;
  return excess.amount;
}

const SIVIR_EXCESS_REQUIRED = 5;

/** Sivir - Ambitious' three trigger conditions, asked once — the same shape (and
 *  the same reason) as fury.ts's `tryndamereQualifies`, whose card prints this
 *  clause word for word. */
function sivirQualifies(state: GameState, listener: Listener, event: GameEvent): boolean {
  if (event.kind !== "battlefieldConquered") return false;
  if (event.conquerorIndex !== listener.ownerIndex) return false;
  if (listener.battlefieldId !== event.battlefieldId) return false; // "when *I* conquer"
  return excessFor(state, listener.ownerIndex, event.battlefieldId) >= SIVIR_EXCESS_REQUIRED;
}

/** Every unit `playerIndex` controls except one — Kato the Arm's "ANOTHER
 *  friendly unit", which names no battlefield and so includes base (355.9.b). */
function otherFriendlyUnits(state: GameState, playerIndex: 0 | 1, excludeInstanceId: string): UnitInstance[] {
  return ownUnitsEverywhere(state, playerIndex).filter((u) => u.instanceId !== excludeInstanceId);
}

/**
 * A unit's current Might, evaluated where it actually stands — the lookup Fiora -
 * Peerless, Kato the Arm and `unitsDuel` all need.
 *
 * The location matters because auras are positional (Garen - Commander, Lee Sin -
 * Centered): a base unit has no battlefield id, and those auras read that omission
 * as "base". `isCombat: false` for the reason `isMighty` records — `[Assault]` and
 * `[Shield]` are damage-side adjustments, not part of the Might a card doubles or
 * copies.
 */
function mightInPlace(state: GameState, location: AnyUnitLocation): number {
  return effectiveMight(
    state,
    location.unit,
    location.ownerIndex,
    location.zone === "base"
      ? { isCombat: false }
      : { isCombat: false, battlefieldId: state.battlefields[location.zone.battlefieldIndex]!.id },
  );
}

/**
 * Two units dealing damage equal to their Mights to each other — Challenge's
 * whole text, and Carnivorous Snapvine's second sentence.
 *
 * **Both Mights are read before either damage instance is dealt.** That ordering
 * is the load-bearing part: the first duellist to die still lands its full Might
 * on the way out, where deal-then-read would let its death silently shrink the
 * damage coming back. The two damages are still applied one after the other,
 * because `dealDamage` is the single death choke point (Deathknells, death
 * wards) — simultaneity here is about the AMOUNTS, which the snapshot gives.
 *
 * `firstId` takes damage second, so the caller's slot order survives: Challenge
 * passes (friendly, enemy) and the enemy is hit first, exactly as before.
 *
 * A duellist that is already gone (killed earlier on the chain, or never chosen)
 * cancels the whole exchange rather than half of it — the "target vanished"
 * no-op convention, and it returns the state untouched rather than merely equal.
 */
function unitsDuel(state: GameState, casterIndex: 0 | 1, firstId: string, secondId: string): GameState {
  const first = findUnitAnywhere(state, firstId);
  const second = findUnitAnywhere(state, secondId);
  if (!first || !second) return state;

  // `mightInPlace` above — the where-it-stands lookup this used to spell out
  // inline, folded the moment Fiora - Peerless and Kato the Arm wanted the same
  // question asked. A base unit has no battlefield id; auras keyed on location
  // (Garen - Commander) read that omission as "base".
  const firstMight = mightInPlace(state, first);
  const secondMight = mightInPlace(state, second);

  const afterSecondDamage = dealDamage(state, casterIndex, secondId, firstMight);
  return dealDamage(afterSecondDamage, casterIndex, firstId, secondMight);
}

/** Fae Dragon's "up to FOUR friendly units", as the count her repeated question
 *  starts from. */
const FAE_DRAGON_BUFFS = 4;

/**
 * Lucian - Merciless' "the FIRST TIME I conquer each turn", as a mark on the unit.
 *
 * **`abilityModesUsedThisTurn` is being read for something other than an
 * activated ability's modes, and that is deliberate.** It is the only per-unit,
 * per-turn, string-keyed memory in the model, it is cleared by `runEnd` alongside
 * `mightThisTurn` and `movesThisTurn`, and it is per UNIT rather than per player —
 * which two Lucians need, since each gets his own first conquest. The one other
 * reader (`activated-abilities`' hasUsedMode/rememberMode) only ever asks about a
 * mode id of the SAME unit's own ability, and Lucian has no activated ability, so
 * the two cannot collide; the mark is prefixed with his defId regardless.
 *
 * Rejected: a `conquestsThisTurn: number` beside `movesThisTurn`, which is what
 * Miss Fortune - Captain's "first time I move each turn" got and is the shape this
 * should eventually take. It needs model/card.ts, turn-manager.ts and every unit
 * fixture, none of which this file owns.
 */
const LUCIAN_CONQUERED_MARK = "SFD-113-conquered";

function hasConqueredThisTurn(card: CardInstance): boolean {
  return card.kind === "Unit" && card.abilityModesUsedThisTurn.includes(LUCIAN_CONQUERED_MARK);
}

/** Writes Lucian's once-per-turn mark onto whichever zone he is standing in.
 *  Hand-rolled rather than `updateUnitAnywhere`, which effect-helpers.ts keeps
 *  private — exporting it is a change to a file this one does not own. */
function markConquestUsed(state: GameState, unitInstanceId: string): GameState {
  const mark = (u: UnitInstance): UnitInstance =>
    u.instanceId === unitInstanceId
      ? { ...u, abilityModesUsedThisTurn: [...u.abilityModesUsedThisTurn, LUCIAN_CONQUERED_MARK] }
      : u;
  return {
    ...state,
    players: state.players.map((p) => ({ ...p, baseUnits: p.baseUnits.map(mark) })) as [PlayerState, PlayerState],
    battlefields: state.battlefields.map((bf) => ({
      ...bf,
      units: Object.fromEntries(Object.entries(bf.units).map(([id, units]) => [id, units.map(mark)])),
    })),
  };
}

/** Here to Help's "reducing its cost by [3 Energy]". */
const HERE_TO_HELP_DISCOUNT = 3;

/** The battlefields `playerIndex` CONTROLS — Here to Help's destination clause,
 *  which is about control (`controllerId`) and not about presence. */
function controlledBattlefields(state: GameState, playerIndex: 0 | 1) {
  return state.battlefields.filter((bf) => bf.controllerId === state.players[playerIndex].id);
}

/** The unit Here to Help's second question is about, still sitting in hand. Re-read
 *  live, so a card discarded or played between the two questions simply is not
 *  there and the offer becomes moot (359.3). */
function handUnit(state: GameState, playerIndex: 0 | 1, cardInstanceId: string | undefined): UnitInstance | undefined {
  if (cardInstanceId === undefined) return undefined;
  const card = state.players[playerIndex].hand.find((c) => c.instanceId === cardInstanceId);
  return card?.kind === "Unit" ? card : undefined;
}

/**
 * Pays a unit's cost with Here to Help's [3 Energy] taken off, or `undefined` when
 * the pool cannot cover it.
 *
 * `voidRushPayment` (effects/signature.ts) at a different number, and it inherits
 * that function's reasoning whole rather than restating it:
 *  - **POWER FIRST, then Energy**, because `payPowerFromChanneled` banks 1
 *    floating Energy for a Ready rune it spends, which is the same credit
 *    `computeAutoPayment` gives. Paying Energy first burns the rune and loses it,
 *    refusing plays the ordinary cost pipeline allows.
 *  - The discount comes off AFTER the cross-cutting modifiers (`modifiedEnergyCost`),
 *    and is floored at 0.
 *  - A split pip (`powerDomainAlt`) is tried all-primary then all-alt; a MIXED
 *    payment is not attempted, because the helper takes one domain. That
 *    UNDER-offers — the unit is withheld, never handed over unpaid.
 *
 * Not folded into a shared helper with Void Rush's copy: that file has a different
 * owner, and the two differ in more than the number (this one is units-only, from
 * hand, and never sees a Legend).
 */
function hereToHelpPayment(state: GameState, playerIndex: 0 | 1, unit: UnitInstance): GameState | undefined {
  let paid: GameState | undefined = state;
  if (unit.powerCost > 0) {
    paid =
      payPowerFromChanneled(state, playerIndex, unit.powerDomain, unit.powerCost) ??
      (unit.powerDomainAlt !== undefined
        ? payPowerFromChanneled(state, playerIndex, unit.powerDomainAlt, unit.powerCost)
        : undefined);
  }
  if (!paid) return undefined;
  return payEnergyFromPool(paid, playerIndex, hereToHelpEnergy(state, playerIndex, unit));
}

function hereToHelpEnergy(state: GameState, playerIndex: 0 | 1, unit: UnitInstance): number {
  return Math.max(0, modifiedEnergyCost(state, playerIndex, "Unit", unit.energyCost, unit.defId) - HERE_TO_HELP_DISCOUNT);
}

/** What one offered unit says it costs, so a caster choosing between two prices
 *  can see both — Void Rush's label, and for its reason. */
function hereToHelpLabel(state: GameState, playerIndex: 0 | 1, unit: UnitInstance): string {
  const power = unit.powerCost > 0 ? `, ${unit.powerCost} ${unit.powerDomain ?? "any"} Power` : "";
  return `Play ${unit.name} (pay ${hereToHelpEnergy(state, playerIndex, unit)} Energy${power})`;
}

/** Exhausts a gear its controller owns — Mistfall pays with itself. */
function exhaustGear(state: GameState, playerIndex: 0 | 1, gearInstanceId: string): GameState {
  const players = [...state.players] as [PlayerState, PlayerState];
  players[playerIndex] = {
    ...players[playerIndex],
    activeGear: players[playerIndex].activeGear.map((g) => (g.instanceId === gearInstanceId ? { ...g, exhausted: true } : g)),
  };
  return { ...state, players };
}
