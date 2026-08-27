import type { EffectDefinition } from "../card-effects.js";
import type { MightModifier } from "../effective-might.js";
import type { ActivatedAbilityDefinition } from "../activated-abilities.js";
import type { UnitPlayDestination, UnitTriggerDefinition } from "../unit-triggers.js";
import type {
  DeathknellDefinition,
  DeathWatchDefinition,
  EventTriggerDefinition,
  GameEvent,
  Listener,
  SelfTriggerDefinition,
} from "../triggers.js";
import type { DecisionDefinition } from "../decisions.js";
import {
  addBuff,
  banishCard,
  burn,
  cardDamageInstancesThisTurn,
  dealDamage,
  dealDamageToEnemyUnitsAtBattlefield,
  completeDeath,
  discardCards,
  discardThenDraw,
  drawCards,
  exhaustGear,
  giveMightThisTurn,
  giveMightThisTurnToOwnUnit,
  grantKeywordThisTurn,
  legionActive,
  ownUnitsEverywhere,
  payEnergyFromPool,
  payPowerFromChanneled,
  readyUnit,
  recordCardDamageInstance,
  recycleUnitFromPlayToDeck,
  returnUnitToHand,
} from "../effect-helpers.js";
import { effectiveKeywords, isMighty } from "../granted-keywords.js";
import { controlsAnyFacedownCard } from "../hidden.js";
import { effectiveMight } from "../effective-might.js";
import { modifiedEnergyCost } from "../cost-modifiers.js";
import { attackerIndexAt, isAttackingAt, isFightingAt } from "../combat-designation.js";
import { placeGoldTokens, placeToken, SHADOW_CLONE_TOKEN, type TokenDestination, type TokenSpec } from "../token.js";
import {
  ARMORY_WARD_POWER,
  clearPaidDeathWard,
  pendingDeathFor,
  releasePendingDeath,
  reviveToBase,
} from "../death-ward.js";
import { killGear } from "../triggers.js";
import { parkDecision, type DecisionOption } from "../decisions.js";
import { mayPlayUnitAt } from "../battlefield-continuous.js";
import { findUnitAnywhere, findUnitOnBattlefield, type AnyUnitLocation } from "../target-lookup.js";
import { playUnitToBase } from "../deploy.js";
import { playUnitFree } from "../free-play.js";
import { playCardIgnoringCost } from "../play-free.js";
import type { GameState } from "../../model/game-state.js";
import type { PlayerState } from "../../model/game-state.js";
import type { CardInstance, GearInstance, UnitInstance } from "../../model/card.js";
import { gainPoints } from "../effect-helpers.js";
import { fileIntoTrash } from "../effect-helpers.js";
import { attachEquipment, detachEquipment, isEquipmentGear, wearerListener } from "../equipment.js";
import {
  revealedFromDeck,
  voidHatchlingAnswer,
  voidHatchlingGate,
  voidHatchlingOptions,
} from "../top-of-deck.js";

/**
 * Card implementations for **Fury** — one file, one owner.
 *
 * This file exists so that work on the card pool can be split up without two
 * people (or two agents) ever editing the same file. The ownership rule is
 * mechanical, not a convention: a defId may only appear here if its
 * CardDefinition has exactly one domain and that domain is Fury. A test in
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
/** Detonate's compensation draw — "its controller draws 2". */
const DETONATE_DRAW = 2;

/** Ruthless Strike, undiscounted and paid — 5 INSTEAD of 3, never both, see the
 *  card's entry. Two constants rather than a base and a bonus, because the card
 *  replaces the number rather than adding to it. */
const RUTHLESS_STRIKE_BASE = 3;
const RUTHLESS_STRIKE_PAID = 5;
/** Consuming Curse's printed damage, before the Bonus Damage its own copies in
 *  the trash add. */
const CONSUMING_CURSE_DAMAGE = 2;
/** ...and the name it counts. Read off the card rather than compared to a defId:
 *  "each card with THIS NAME" is a name check, and the pool now contains reprints
 *  of one card under several ids. */
const CONSUMING_CURSE_NAME = "Consuming Curse";
/** Perfect Execution's `[Assault 3]`. Named because the grant's `value`
 *  parameter defaults to 1, so a missing argument here is a silently weaker card
 *  rather than a type error. */
const PERFECT_EXECUTION_ASSAULT = 3;

/**
 * "If you control fewer runes than an opponent" — Forsaken Baccai's and Oasis
 * Raider's shared condition.
 *
 * One predicate for both because they print the identical sentence, and a
 * duplicated copy is how two cards that are meant to agree stop agreeing. The
 * pool has produced that four times.
 *
 * **Runes CONTROLLED are the ones in the Rune Pool** — `channeled`, the same
 * field Master Yi - Meditative's "if you control 8 or more runes" reads in
 * `effective-might.ts`. The rune DECK is the unrevealed remainder and is not
 * something a player controls in the sense any card means; counting it would
 * make both these cards permanently live in the early game and permanently dead
 * later, which is backwards.
 *
 * STRICTLY fewer — equal is not fewer. That boundary is the whole card, and a
 * `<=` here would be invisible on any board that was never set up level.
 */
function behindOnRunes(state: GameState, playerIndex: 0 | 1): boolean {
  const opponentIndex: 0 | 1 = playerIndex === 0 ? 1 : 0;
  return state.players[playerIndex].channeled.length < state.players[opponentIndex].channeled.length;
}

/** Forsaken Baccai's catch-up pump. */
const FORSAKEN_BACCAI_MIGHT = 1;
/** ...and Oasis Raider's, which is the bigger half of a bigger card. */
const OASIS_RAIDER_MIGHT = 2;
/** Baccai Reaper's "you may pay [Fury]" — ONE pip, of his own domain. */
const BACCAI_REAPER_POWER = 1;
/** ...and the question that offer parks. */
/** Endless Riches (VEN-022) and the size of its opening Burn. Declared up here
 *  with the other card ids because the registry literals below are evaluated at
 *  module load — a `const` beside its own entry is a temporal dead zone, which is
 *  the ReferenceError the Shadow Clone constants were moved for. */
const ENDLESS_RICHES = "VEN-022";
const ENDLESS_RICHES_BURN = 7;

const BACCAI_REAPER_PUMP = "VEN-009-assault";
/** Baccai Reaper's granted `[Assault 2]`. Printed on his frame AND granted by
 *  the clause, and 807.2 makes the two SUM — see the card's entry. */
const BACCAI_REAPER_ASSAULT = 2;
/** Renekton, Rage Fueled's rune CEILING — "4 or fewer", so the test is `>` this
 *  number to bail. Shared reading with Eclipse Dragon's, and kept as two
 *  constants because they are two cards' printed numbers that happen to agree. */
const RENEKTON_MAX_RUNES = 4;
/** ...and his sweep. */
const RENEKTON_DAMAGE = 2;
/** Eclipse Dragon's rune ceiling and his draw. */
const ECLIPSE_DRAGON_MAX_RUNES = 4;
const ECLIPSE_DRAGON_DRAW = 1;
/** Blade Twirler's "the FIRST time I move each turn", read against
 *  `unitMoved.movesThisTurn`, which is the count AFTER the move. */
const BLADE_TWIRLER_NTH_MOVE = 1;
/** ...and the question he parks. */
const BLADE_TWIRLER_BURN = "VEN-002-burn";
/** ...and how much the chosen player burns. */
const BLADE_TWIRLER_BURN_COUNT = 1;

export const cardEffects: Record<string, EffectDefinition> = {
  "VEN-003": {
    // Brittle Steel — "Kill a gear. [Flow] [4 Energy][Fury]."
    //
    // Detonate's spec (SFD-005, below) minus the compensation draw, and killed
    // through the same `killGear` funnel so a dying gear's own trigger still
    // fires — Treasure Trove and Scrapheap both read that moment, and a bare
    // removal from `activeGear` would skip them.
    //
    // **`[Flow]` needs nothing here, and that is worth stating rather than
    // assuming.** 829.1.c.1 makes a Flow cost an ALTERNATIVE cost paid from the
    // trash, and it is plumbed generically: `card-loader` parses the printed
    // `flowCost` off the card, `replaced-costs` offers the play, and
    // `execute-play-card` banishes the spell afterwards. A card effect is reached
    // identically whichever cost paid for it, so this resolver cannot tell — and
    // must not try to.
    //
    // "A gear" with no owner printed is either player's, the same reading
    // Rocket Barrage and Detonate take (355.9.a.1's widening). Killing your own
    // gear is a bad play rather than an illegal one, and the card offers it.
    targeting: { kind: "gear" },
    resolve: (state, _ctx, event) => {
      const id = event.targetPermanentInstanceId;
      if (!id) return state;
      // Walked over both seats because `killGear` needs the OWNER's index, and a
      // bare id does not carry it — Detonate's loop below, and the same "the gear
      // has already left the chain's sight" outcome (359.3.e.12) when neither
      // seat holds it any more.
      for (const ownerIndex of [0, 1] as const) {
        const gear = state.players[ownerIndex].activeGear.find((g) => g.instanceId === id);
        if (gear) return killGear(state, gear, ownerIndex);
      }
      return state;
    },
  },
  "VEN-008": {
    // Ruthless Strike — "[Action] As an additional cost to play this, you may
    // discard 1. Deal 3 to a unit at a battlefield. If you paid the additional
    // cost, deal 5 to it instead."
    //
    // # "Instead" is a REPLACEMENT of the number, not a second shot
    //
    // 5 or 3, never 8 and never two instances. Dealing 3 and then 2 more would be
    // a visibly different card: two instances trip a damage-triggered ability
    // twice, and Consuming Curse's neighbour comment records the same distinction
    // from the other direction (Bonus Damage adds to ONE instance).
    //
    // # The cost is declared on the ACTION, and the discard is performed here
    //
    // `DISCARD_CHOICE_CARDS` in card-effects.ts carries the row; `legal-actions`
    // fans a variant out per card in hand and `validate-play-card` refuses an
    // ineligible one, so by the time this resolver runs the choice is made and
    // paid for. Brazen Buccaneer's entry below records why the discard itself
    // happens in the resolver rather than at announce: it is the one instruction
    // the cost machinery cannot perform, since it does not know which card the
    // effect wants gone.
    //
    // **`event.discardCardInstanceId` is the whole "if you paid" test.** It is
    // set exactly when a discard variant was submitted — there is no separate
    // paid flag to fall out of step with it, which is the failure the Blast Corps
    // Cadet's `optionalPowerPaid` note describes guarding against.
    //
    // The discard runs BEFORE the damage, which is the printed order ("as an
    // additional cost to play this" precedes the effect) and is observable: the
    // discarded card is in the trash when the damage resolves, so a Flame
    // Chompers discarded to this may already have offered its own replay.
    //
    // "A unit AT A BATTLEFIELD" is printed, so `scope: "battlefield"` — 355.9.b's
    // narrowing, not 355.9.a.1's widening. A unit in base is not a legal choice.
    targeting: { kind: "unit", scope: "battlefield" },
    resolve: (state, ctx, event) => {
      const targetId = event.targetUnitInstanceId;
      if (!targetId) return state;
      const paid = event.discardCardInstanceId !== undefined;
      const next = paid
        ? discardCards(state, ctx.casterIndex, 1, [event.discardCardInstanceId!])
        : state;
      return dealDamage(next, ctx.casterIndex, targetId, paid ? RUTHLESS_STRIKE_PAID : RUTHLESS_STRIKE_BASE);
    },
  },
  "VEN-010": {
    // Consuming Curse — "[Action] Deal 2 to a unit at a battlefield. This deals 1
    // Bonus Damage for each card with this name in your trash."
    //
    // **"WITH THIS NAME", not "this card"** — every copy of Consuming Curse in
    // the trash counts, and the card is a self-referential pile-builder: the
    // second copy is a 3, the third a 4. Compared on `name` rather than on
    // `defId` deliberately, because those two answers differ across sets — a
    // reprint under another id is still a card with this name, and Vendetta
    // reprinting ten earlier cards under plain names is the pool this reading has
    // to survive.
    //
    // # The trash is read at RESOLUTION, and this spell is not yet in it
    //
    // A Spell goes to its owner's trash AFTER its effect resolves
    // (`playSpellImmediately` trashes it last), so the copy being cast never
    // counts itself. That is the printed reading — "in your trash" is a zone
    // check, and a spell on the Chain is not in a trash — and it is the
    // difference between a first copy dealing 2 and one dealing 3.
    //
    // # Bonus Damage is not a second instance of damage
    //
    // 714 makes Bonus Damage an ADDITION to an instance rather than a new one, so
    // this is a single `dealDamage` of 2 + N. Dealing them separately would be a
    // visibly different card: two instances trip a damage-triggered ability twice
    // and can be prevented independently.
    //
    // "A unit AT A BATTLEFIELD" is printed, so `scope: "battlefield"` — 355.9.b's
    // narrowing, the half that makes a printed location load-bearing, NOT
    // 355.9.a.1's widening. A unit in either base is not a legal choice.
    targeting: { kind: "unit", scope: "battlefield" },
    resolve: (state, ctx, event) => {
      const targetId = event.targetUnitInstanceId;
      if (!targetId) return state;
      const name = state.players[ctx.casterIndex].trash.filter((c) => c.name === CONSUMING_CURSE_NAME).length;
      return dealDamage(state, ctx.casterIndex, targetId, CONSUMING_CURSE_DAMAGE + name);
    },
  },
  "VEN-012": {
    // Perfect Execution — "Ready a unit and give it [Assault 3] this turn.
    // [Flow] [3 Energy][Fury]."
    //
    // Two instructions on ONE target, joined by "and" — not a modal card and not
    // two targets. Both land on whatever is chosen.
    //
    // **Deliberately NOT `exhaustedOnly`**, and that is the one real decision
    // here. Jayce - Defender of Tomorrow's "Ready a gear" narrows its offer to
    // exhausted gear because a ready one is nothing to ready and the ability does
    // nothing else. This card does something else: the `[Assault 3]` is a second
    // instruction with its own value, and pumping a READY attacker is a normal
    // line — the commonest one, in fact, since a unit you are about to send in is
    // ready. Narrowing the offer would withhold a legal play, which this project
    // does not do.
    //
    // `readyUnit` no-ops on an already-ready unit of its own accord (and refuses
    // an enemy under Mageseeker Warden), so the first instruction simply does
    // what it can and the second is unaffected.
    //
    // "A unit", bare, so `scope: "anywhere"` — 355.9.a.1's widening. Readying a
    // unit in base is a real line: it is what lets it be played into a fight the
    // same turn under a card that cares.
    //
    // The grant is `grantKeywordThisTurn` with an explicit VALUE. `[Assault 3]`
    // is not `[Assault]`, and the default of 1 would have been a silently weaker
    // card that no type error could catch — `mergeGrantedKeyword` takes the
    // higher of what is there, so a unit that already has `[Assault 2]` goes to 3
    // rather than to 5 (the per-keyword summing is for the four VALUED keywords from separate
    // grants; see `keyword-stacking`).
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) => {
      const targetId = event.targetUnitInstanceId;
      if (!targetId) return state;
      return grantKeywordThisTurn(readyUnit(state, targetId), targetId, "Assault", PERFECT_EXECUTION_ASSAULT);
    },
  },
  "UNL-013": {
    // Lotus Trap — "[Hidden][Reaction] Choose a unit. Double all damage that
    // would be dealt to it this turn."
    //
    // A Replacement Effect (369.1's "would"), armed for the TURN on one unit —
    // the shape `deathWardedUnitInstanceIds` and Smite's banish list already
    // have, and it joins them as `damageDoubledUnitInstanceIds`.
    //
    // # 465.2.c.5 works THIS CARD by name, and it is why combat differs
    //
    // "When assigning damage in this way, replacement effects that would apply to
    // the resulting damage are considered to apply to the assignment instead",
    // with the rules' own example quoting this card's text verbatim: the attacker
    // assigns 1, "1 damage that doubles to 2 damage as it is assigned to the
    // unit. When that damage is dealt, it doesn't get doubled again."
    //
    // So the doubling has TWO homes and they are not the same rule:
    // `dealDamage` multiplies what it deals, and `combat.assignmentNeeded` halves
    // what a doubled unit costs to kill while `applyDamage` restores it. They
    // cannot compound, because combat never routes through `dealDamage`.
    //
    // "A unit" — no owner and no location printed, so `scope: "anywhere"`
    // (355.9.a.1's widening). Doubling damage to a FRIENDLY unit is a bad play
    // rather than an illegal one, and the card offers it.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) => {
      const targetId = event.targetUnitInstanceId;
      if (!targetId) return state;
      return state.damageDoubledUnitInstanceIds.includes(targetId)
        ? state
        : { ...state, damageDoubledUnitInstanceIds: [...state.damageDoubledUnitInstanceIds, targetId] };
    },
  },
  "SFD-011": {
    // Angle Shot — "[Reaction] Choose a unit and an Equipment with the same
    // controller. Attach that Equipment to that unit or detach that Equipment
    // from that unit. Draw 1."
    //
    // **MODAL, because "or" between two instructions is a choice**, and the two
    // are not expressible as one: attaching wants an Equipment that is NOT on the
    // unit and detaching wants the one that IS. A single spec would offer every
    // pair to both jobs, and half of them would resolve to nothing.
    //
    // The pairing rule ("the same controller") lives in the TARGETING rather than
    // in these resolvers, for the reason `sameBattlefield` records: by the time a
    // resolver runs the choice is made and paid for, so refusing here would leave
    // the card spent and doing nothing. See `unitAndEquipment`.
    //
    // **The draw is on BOTH modes and is unconditional** — it is a third sentence,
    // not a rider on the attach, and nothing in the text ties it to either. A
    // resolver that dropped it on one mode would be a silently weaker card.
    modes: [
      {
        id: "attach",
        label: "Attach the Equipment to the unit",
        targeting: { kind: "unitAndEquipment", relation: "attachable" },
        resolve: (state, ctx, event) => {
          if (!event.targetPermanentInstanceId || !event.targetUnitInstanceId) return state;
          // Attached by its CONTROLLER's index, not the caster's: the pair share a
          // controller and `attachEquipment` writes into that player's activeGear,
          // so passing the caster would look for an enemy's gear in our own list.
          const owner = findUnitAnywhere(state, event.targetUnitInstanceId);
          if (!owner) return drawCards(state, ctx.casterIndex, 1);
          const attached = attachEquipment(
            state,
            owner.ownerIndex,
            event.targetPermanentInstanceId,
            event.targetUnitInstanceId,
          );
          return drawCards(attached, ctx.casterIndex, 1);
        },
      },
      {
        id: "detach",
        label: "Detach the Equipment from the unit",
        targeting: { kind: "unitAndEquipment", relation: "attachedToIt" },
        resolve: (state, ctx, event) => {
          if (!event.targetPermanentInstanceId || !event.targetUnitInstanceId) return state;
          const owner = findUnitAnywhere(state, event.targetUnitInstanceId);
          if (!owner) return drawCards(state, ctx.casterIndex, 1);
          const detached = detachEquipment(state, owner.ownerIndex, event.targetPermanentInstanceId);
          return drawCards(detached, ctx.casterIndex, 1);
        },
      },
    ],
  },
  "SFD-005": {
    // Detonate — "Kill a gear. Its controller draws 2."
    //
    // **The draw is the VICTIM's**, which is the whole shape of the card: it is
    // removal you pay a price for, not removal plus a draw. Read off the gear's
    // owner rather than from `ctx.casterIndex`, and the two differ on every
    // sensible play of it.
    //
    // Killed through `killGear` so the dying gear's own trigger still fires
    // (Treasure Trove, Scrapheap) — the same funnel Rocket Barrage's gear mode
    // and Disarming Rake use.
    //
    // A gear that has already left the chain's sight is 359.3's "a check on
    // something no longer available": no kill, and NO DRAW either, since the
    // draw is conditioned on the same gear.
    targeting: { kind: "gear" },
    resolve: (state, _ctx, event) => {
      const id = event.targetPermanentInstanceId;
      if (!id) return state;
      for (const ownerIndex of [0, 1] as const) {
        const gear = state.players[ownerIndex].activeGear.find((g) => g.instanceId === id);
        if (gear) return drawCards(killGear(state, gear, ownerIndex), ownerIndex, DETONATE_DRAW);
      }
      return state;
    },
  },
  "SFD-003": {
    // Blood Rush — "[Action] [Repeat] [1] Give a unit [Assault 2] this turn."
    //
    // "A unit" with no battlefield clause and no owner clause: 355.9.a.1 puts a
    // unit in either base on the list, and nothing stops the caster arming an
    // enemy. [Assault N] is only worth anything to an ATTACKER, so pointing it at
    // an enemy is a legal misplay rather than a shape the targeting should
    // forbid.
    //
    // **Repeating this DOES stack: the unit ends on [Assault 4].** 807.2 — "the
    // Assault Value of all granted Assault keywords is summed" — and 820.1.d
    // makes the additional execution a second performance of the instruction, so
    // it is a second grant and therefore an additional source.
    //
    // This carried the opposite claim until 2026-08-08 ("a second [Assault 2] is
    // still [Assault 2]"), citing 817.1.a, which is Vision's "It is present on
    // Permanents" and states no redundancy rule at all. `grantKeywordThisTurn`
    // now merges through keyword-stacking.ts; repeat-keyword.test.ts asserts the
    // 4.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId
        ? grantKeywordThisTurn(state, event.targetUnitInstanceId, "Assault", BLOOD_RUSH_ASSAULT)
        : state,
  },
  "SFD-023": {
    // Piercing Light — "[Repeat] [2][Fury] Deal 2 to a unit at a battlefield,
    // then deal 2 to up to one other unit."
    //
    // Two slots scoped DIFFERENTLY in print, so `slotScopes` rather than one
    // shared scope: the first target is "at a battlefield", the second is "up to
    // one other unit" with no location clause at all, which 355.9.a.1 reads as
    // reaching either base. Zenith Blade is the precedent for the split and for
    // why a spec-wide scope would refuse a target the card allows.
    //
    // `min: 1`, because "UP TO one other" makes the second slot genuinely
    // optional — a board with a single unit on it is a legal cast that deals 2
    // once. That is the difference between this and Challenge's `min: 2`, and it
    // is printed.
    //
    // "OTHER" is enforced by `unitSlots` itself, which rejects a pair naming the
    // same unit twice — so this cannot be pointed at one unit for 4.
    //
    // No owner on either slot: neither half names one, so a caster may shoot
    // their own. Legal and usually a misplay, the standing reading here.
    //
    // **The [Repeat] case worth naming**: 820.1.d lets the second execution
    // DECLINE the optional slot the first one filled, which is why
    // `repeatChoices` wholly replaces the choice fields rather than merging with
    // the first set — under a merge, an omitted second target would silently
    // inherit the first execution's and hit a unit the caster deliberately did
    // not name. See card-effect-resolution.ts's `repeatChoicesOf`.
    targeting: {
      kind: "unitSlots",
      slots: ["any", "any"],
      min: 1,
      slotScopes: ["battlefield", "anywhere"],
    },
    resolve: (state, ctx, event) =>
      [event.targetUnitInstanceId, event.secondTargetUnitInstanceId]
        .filter((id): id is string => id !== undefined)
        .reduce((next, id) => dealDamage(next, ctx.casterIndex, id, PIERCING_LIGHT_DAMAGE), state),
  },
  "OGN-025": {
    // Blind Fury — "[Action] Each opponent reveals the top card of their Main
    // Deck. Choose one and banish it, then play it, ignoring its cost. Then
    // recycle the rest."
    //
    // In a 2-player game there is exactly ONE opponent and therefore exactly one
    // revealed card, so "choose one" chooses itself and "recycle the rest"
    // recycles nothing. Written to the 2-player shape deliberately rather than
    // building a multiplayer choice the mode cannot reach — the same call this
    // engine makes everywhere else it says "each opponent".
    //
    // The banish is TRANSIENT (banished and played in one instruction), so the
    // card goes straight to play; see `playCardIgnoringCost`, which also carries
    // the divergence for a revealed SPELL — it resolves immediately rather than
    // going on a chain this card is in the middle of.
    //
    // **The CASTER plays it, not its owner.** "Choose one and play it" with no
    // owner named, off a card whose whole point is stealing the top of an enemy
    // deck. A unit played this way therefore joins the caster's base.
    //
    // **The one site of the five where the revealer and the deck's OWNER
    // differ**, which is why Void Hatchling's gate takes both. "If YOU would
    // reveal cards from a deck" is about the player doing the revealing — the
    // caster — and the top card looked at is the VICTIM's. So a caster with a
    // Hatchling may bury the opponent's top card before stealing whatever is
    // under it, which is the best line the card has.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      voidHatchlingGate(
        state,
        ctx.casterIndex,
        ctx.opponentIndex,
        { kind: "OGN-025-reveal", playerIndex: ctx.casterIndex },
        (s) => blindFuryReveal(s, ctx.casterIndex),
      ),
  },
  "OGN-014": {
    // Sky Splitter — "This spell's Energy cost is reduced by the highest Might
    // among units you control. Deal 5 to a unit at a battlefield."
    //
    // Only the damage is here; the self-scaling discount is a COST and lives in
    // cost-modifiers.ts, the same split Spoils of War and Find Your Center take.
    // Printed at 8 Energy it is unplayable without a board, and free with an
    // 8-Might unit — which is the card.
    targeting: { kind: "unit" },
    resolve: (state, ctx, event) =>
      event.targetUnitInstanceId ? dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId, 5) : state,
  },
  "OGN-029": {
    // Falling Star — "Deal 3 to a unit. Deal 3 to a unit."
    //
    // TWO instructions, each naming its own target, and the survey's premise that
    // this made the card dead with one unit on the board was wrong. The rules
    // answer both halves:
    //  - **Both choices are mandatory** (355: "valid choices must be made for all
    //    targets"), so `min: 2` and the card is uncastable with an empty board.
    //  - **The same unit may fill both**, from the Repeat/Rocket Barrage example:
    //    "may choose the same target or a different one… they must specify which
    //    is the first target and which is the second."
    // So one unit on the board is a legal cast that deals it 6, which is the
    // card's real ceiling and would have been unreachable under a distinct-targets
    // reading.
    //
    // `scope: "anywhere"` — "a unit" is 355.9.a.1's bare noun. Icathian Rain is the
    // same sentence six times over and takes the same shape.
    targeting: { kind: "unitList", min: 2, max: 2, scope: "anywhere", allowsDuplicates: true },
    resolve: (state, ctx, event) =>
      // One dealDamage per ENTRY, not per distinct unit: two instructions each
      // deal 3, so a unit chosen twice takes two separate 3s. That matters beyond
      // arithmetic — each is its own damage event, so a unit that dies to the
      // first never takes the second, and `dealDamage`'s own lethal check is what
      // makes that true without a check here.
      (event.targetUnitInstanceIds ?? []).reduce((next, id) => dealDamage(next, ctx.casterIndex, id, 3), state),
  },
  "OGN-009": {
    // Hextech Ray — "Deal 3 to a unit at a battlefield."
    // Default battlefield scope, exactly as printed.
    targeting: { kind: "unit" },
    resolve: (state, ctx, event) =>
      event.targetUnitInstanceId ? dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId, 3) : state,
  },
  "OGN-022": {
    // Thermo Beam — "Kill all gear."
    //
    // ALL gear, both players', including the caster's own — the text names no
    // owner and this is a symmetric sweep. Routed through killGear per gear so
    // each fires its own "when I am killed" self-trigger (Treasure Trove pays
    // out, Scrapheap fires) rather than being silently removed.
    //
    // The lists are snapshotted before anything dies: a gear's death trigger can
    // change the board, and iterating a live array would skip entries.
    targeting: { kind: "none" },
    resolve: (state) => {
      const doomed = ([0, 1] as const).flatMap((i) => state.players[i].activeGear.map((g) => ({ gear: g, ownerIndex: i })));
      return doomed.reduce((next, { gear, ownerIndex }) => killGear(next, gear, ownerIndex), state);
    },
  },
  "OGN-004": {
    // Cleave — "[Action] Give a unit [Assault 3] this turn."
    //
    // A NUMBERED keyword grant, which is why grantKeywordThisTurn takes a value:
    // it hardcoded 1, which is right for [Ganking] and wrong here by two. The
    // keyword machinery does the rest — effective-might reads [Assault] for the
    // attacking side, so this is +3 only while attacking, not a flat pump.
    //
    // "A unit", no owner and no battlefield named, so scope "anywhere" and
    // either side is legal.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId ? grantKeywordThisTurn(state, event.targetUnitInstanceId, "Assault", 3) : state,
  },
  "OGN-033": {
    // Shakedown — "Choose an enemy unit. Deal 6 to it unless its controller has
    // you draw 2."
    //
    // A punisher: the caster picks the target, and then the VICTIM'S CONTROLLER
    // picks the poison — eat 6, or hand the caster two cards. So the target is a
    // normal fan-out on the action, and the second half is a decision belonging
    // to the other player.
    //
    // "Its controller" is read when the question is RAISED and travels on the
    // decision, because by the time it is answered the unit may be somewhere
    // else entirely; `targetInstanceId` carries which unit the 6 is for, for the
    // same reason.
    targeting: { kind: "unit", owner: "enemy", scope: "anywhere" },
    resolve: (state, ctx, event) => {
      const targetId = event.targetUnitInstanceId;
      if (!targetId) return state;
      const location = findUnitAnywhere(state, targetId);
      if (!location) return state;
      // The caster is not carried on the decision: `playerIndex` is the victim's
      // controller, and in a 2-player game the other seat is the caster by
      // definition. Storing it too would be a second source of truth that could
      // disagree with the first.
      void ctx;
      return parkDecision(state, {
        kind: "OGN-033-choose",
        playerIndex: location.ownerIndex,
        targetInstanceId: targetId,
      });
    },
  },
  "OGN-008": {
    // Get Excited! — "[Action] Discard 1. Deal its Energy cost as damage to a
    // unit at a battlefield. (Ignore its Power cost.)"
    //
    // The discard is part of the EFFECT, not a cost, and WHICH card is discarded
    // decides the damage — so it is a real choice carried on the action
    // (legal-actions fans out one candidate per card in hand) rather than the
    // front-of-hand default every unchosen discard uses.
    //
    // Energy cost read BEFORE discarding: afterwards the card is in the trash,
    // and "its Energy cost" is the discarded card's. The parenthetical is
    // explicit that its Power cost contributes nothing.
    //
    // A card named at cast time can be gone by resolution (discarded by
    // something else on the chain). Then there is no "it", so nothing is
    // discarded and no damage is dealt — rather than dealing 0 to the target,
    // which would still be an instance of damage and could trigger things.
    targeting: { kind: "unit" },
    resolve: (state, ctx, event) => {
      const chosen = state.players[ctx.casterIndex].hand.find((c) => c.instanceId === event.discardCardInstanceId);
      if (!chosen || !event.targetUnitInstanceId) return state;
      const damage = "energyCost" in chosen ? chosen.energyCost : 0;
      const discarded = discardCards(state, ctx.casterIndex, 1, [chosen.instanceId]);
      return dealDamage(discarded, ctx.casterIndex, event.targetUnitInstanceId, damage);
    },
  },
  "OGN-024": {
    // Void Seeker — "[Action] (Play on your turn or in showdowns.) Deal 4 to a
    // unit at a battlefield. Draw 1."
    //
    // [Action] is not implemented here: printed timing is read off the card by
    // timing.timingTierOf (card-loader sets `isAction` from the printed
    // keyword), so this entry only owns the two instructions.
    //
    // Targeting is the DEFAULT battlefield scope — `{ kind: "unit" }` with no
    // `scope` — because the printed complement names a battlefield. That is this
    // card's own reading, not an inference by analogy: the rules' Instructions
    // section (135.2) uses Void Seeker as its worked example, taking "deal 4" as
    // the game action and "a unit at a battlefield" as its complement. So a unit
    // standing in either player's BASE is not a legal target, unlike Final
    // Spark's bare "Deal 8 to a unit" (OGS-022, which opts into
    // `scope: "anywhere"` precisely because it names no battlefield).
    //
    // Damage first, THEN the draw — rule 359.3.d, "execute the game effect of
    // the spell, from top to bottom of the rules text of the card." The order is
    // observable rather than cosmetic: a lethal 4 kills mid-resolution and can
    // fire the dying unit's [Deathknell] (rule 808), and this pool has a
    // Deathknell that discards and draws, so drawing first would take a
    // different card off the deck than the card says you get.
    //
    // Two "impossible instruction" paths are already handled by the helpers and
    // deliberately not special-cased here, matching rule 359.3.e's handling of
    // illegal and impossible instructions ("instructions that can be partially
    // followed are followed as much as possible"): a target that left play
    // between casting and resolution makes dealDamage a no-op and the draw still
    // happens, and an empty deck makes drawCards a no-op without disturbing the
    // damage (the documented Burn Out gap, rule 431 — see drawCards).
    targeting: { kind: "unit" },
    resolve: (state, ctx, event) => {
      const damaged = dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId!, 4);
      return drawCards(damaged, ctx.casterIndex, 1);
    },
  },
  "SFD-001": {
    // Against the Odds — "[Reaction] Give a friendly unit at a battlefield
    // +2 Might this turn for each ENEMY unit THERE."
    //
    // `owner: "friendly"` with the DEFAULT battlefield scope, both printed: the
    // card names a battlefield, so a unit sitting in base is not a legal target
    // (355.9.b, the Void Seeker/Final Spark split this file already records).
    //
    // "THERE" is the target's OWN battlefield, which is why the count is taken
    // from the location rather than from the board — a second enemy stack at the
    // other battlefield is not part of the odds being fought against. The count
    // is read at RESOLUTION, not when the Reaction is announced: this is a
    // Reaction cast into someone else's window precisely to catch the board as it
    // lands, and 359.3.e executes the instruction when the spell resolves.
    //
    // A lone friendly with no enemy opposite is +0. That is a legal cast rather
    // than an illegal one — the multiplication is the instruction, not a
    // condition on it — so nothing is refused and the caster simply gets nothing.
    // [Reaction] itself is printed timing and lives in timing.ts, not here.
    targeting: { kind: "unit", owner: "friendly" },
    resolve: (state, ctx, event) => {
      const targetId = event.targetUnitInstanceId;
      if (!targetId) return state;
      const at = findUnitOnBattlefield(state, targetId);
      if (!at) return state;
      const enemyId = state.players[ctx.opponentIndex].id;
      const enemies = (state.battlefields[at.battlefieldIndex]!.units[enemyId] ?? []).length;
      return enemies === 0 ? state : giveMightThisTurn(state, targetId, AGAINST_THE_ODDS_PER_ENEMY * enemies);
    },
  },
  "SFD-004": {
    // Bushwhack — "[Hidden] Friendly units enter ready this turn. Play a Gold
    // gear token exhausted."
    //
    // **WHOLE as of 2026-08-05.** Only the first sentence was implemented when
    // this card landed, because there was no gear-token primitive in the engine
    // at all — `token.ts` minted UnitInstances and nothing else. That was the
    // wave's largest single blocker (eleven cards, four agents, two
    // battlefields), and `placeGoldTokens` now closes it, so the
    // coverage.PARTIALLY_IMPLEMENTED entry for this card is deleted rather than
    // reworded — a card is either finished or it is on that list.
    //
    // The enter-ready half reuses `unitsEnterReadyThisTurn`, the flag Confront
    // already sets, rather than `nextUnitsEnterReady`: this is a DURATION ("this
    // turn"), not a charge spent by the next unit, and the two are different
    // fields for exactly that reason (see deploy.unitEntersReady). It is cleared
    // by runEnd with the rest of the turn's transient state.
    //
    // Confront prints "Units you PLAY this turn enter ready" and this prints
    // "FRIENDLY units enter ready this turn"; they are read as the same effect
    // because every way a unit enters play here is a play, and `unitEntersReady`
    // is the one funnel that decides it.
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      players[ctx.casterIndex] = { ...players[ctx.casterIndex], unitsEnterReadyThisTurn: true };
      // "Play a Gold gear token EXHAUSTED" — the second sentence, and it is
      // unconditional: nothing about the enter-ready half gates it.
      return placeGoldTokens({ ...state, players }, ctx.casterIndex, 1);
    },
  },
  "SFD-017": {
    // Sudden Storm — "[Hidden] [Action] Deal 2 to a unit at a battlefield. If
    // it's ATTACKING, deal 4 to it instead."
    //
    // "Instead" replaces the amount, so this is ONE instance of damage of either
    // 2 or 4 rather than 2 followed by 2 more — which matters beyond arithmetic,
    // since each instance is its own damage event that [Shield] and the damage
    // modifiers price separately.
    //
    // "Attacking" is 464.2.c Step 1's Attacker designation, asked through
    // `attackerIndexAt`: the Attacker is the player who applied Contested, and
    // every unit of theirs standing at that battlefield is attacking. The
    // battlefield's `designatedInstanceIds` was the rejected alternative — it is
    // the sharper question (383.4.f's "gains the designation") but it is only
    // written by a Cleanup, so a unit that walked in and started the fight this
    // very action would read as NOT attacking and take 2 where the card says 4.
    // Answering off `contestedByIndex` cannot go stale that way; it survives for
    // as long as the Showdown does (190.3.b).
    //
    // The card is an [Action], so it is castable inside a Showdown — which is the
    // only place the 4 is reachable, and is what makes the clause worth having.
    targeting: { kind: "unit" },
    resolve: (state, ctx, event) => {
      const targetId = event.targetUnitInstanceId;
      if (!targetId) return state;
      const at = findUnitOnBattlefield(state, targetId);
      const attacking =
        at !== undefined && attackerIndexAt(state, state.battlefields[at.battlefieldIndex]!.id) === at.ownerIndex;
      return dealDamage(state, ctx.casterIndex, targetId, attacking ? SUDDEN_STORM_VS_ATTACKER : SUDDEN_STORM_BASE);
    },
  },
  "UNL-015": {
    // Right of Conquest — "Draw 1, then draw 1 for each battlefield you or allies
    // control."
    //
    // ONE `drawCards` call for `1 + N`, not a 1 followed by a loop. The "then" is
    // only sequencing prose here and nothing in the sentence can observe the
    // split: no card in this pool triggers per card drawn, and the count is fixed
    // before the first draw because drawing cannot change who controls a
    // battlefield. Contrast Scrapyard Champion's "discard 2, THEN draw 2", where
    // the "then" IS load-bearing and gets `discardThenDraw` — the difference is
    // that the first half there stops to ask.
    //
    // **"You OR ALLIES" collapses to "you" in a two-player game** and is
    // deliberately not modelled as anything wider. `GameState.players` is a
    // two-tuple and every "ally" clause in this pool is written for the multiplayer
    // formats the rules also define (400-series); reading it as "either player"
    // would make the card count the OPPONENT's battlefields, which is the one
    // reading that is definitely wrong.
    //
    // Control is `controllerId`, not presence: standing at an uncontrolled
    // battlefield is not controlling it — the same distinction Vayne - Hunter's
    // enter-ready clause turns on.
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const controlled = state.battlefields.filter((bf) => bf.controllerId === state.players[ctx.casterIndex].id).length;
      return drawCards(state, ctx.casterIndex, RIGHT_OF_CONQUEST_BASE_DRAW + controlled);
    },
  },
  "UNL-009": {
    // Upstage Comedy — "[Repeat] [2] Ready a unit."
    //
    // **THE `[Repeat]` HALF IS NOT REACHABLE, and not because of anything here.**
    // A card's Repeat price lives in `REPEAT_COSTS` (card-effects.ts), which this
    // file does not own; with no row there, `legal-actions` never enumerates a
    // repeat-paid variant and `validate-play-card` refuses one, so the spell
    // plays at its printed 2 Energy and readies exactly one unit. The row it
    // wants is `"UNL-009": { energy: 2 }` — the plain shape Desert's Call and
    // Feral Strength already use — and `repeat-keyword.test.ts`'s named list of
    // unpriced UNL cards has to drop UNL-009 in the same change.
    //
    // The resolver needs NOTHING for that to start working: 820.1.d's additional
    // execution goes through `card-effect-resolution`, which calls this same
    // `resolve` a second time with `repeatChoices`, so a repeated Upstage Comedy
    // readies a second (or the same, now-ready and therefore no-op) unit without
    // a line here. Written this way deliberately, the same call Wallop's note two
    // registries over records for its missing cost row.
    //
    // "A unit" — the bare noun, so `scope: "anywhere"` and no owner restriction.
    // Readying an ENEMY unit is a bad play, not an illegal one, and base is where
    // an exhausted unit usually sits; identical to Wallop's and First Mate's
    // reading.
    //
    // **Cited 355.9.a.1, not the 355.9.b this file's neighbours reach for.**
    // 355.9.a.1 is the rule that makes a bare noun wide — "'Unit,' 'gear,' and
    // 'rune' refer to objects on the Board unless specified otherwise" — while
    // 355.9.b is "It meets all targeting restrictions", the rule that NARROWS
    // when a card prints "at a battlefield". Both matter and they are different
    // halves; 72 comments in src/ cite the narrowing half for the widening claim.
    //
    // **NOT `exhaustedOnly`.** Nothing on the card says "exhausted", and that
    // flag is a legality restriction rather than a hint: with it, a board of
    // entirely ready units would make this spell UNCASTABLE. 415 already makes
    // readying a ready unit do nothing ("nothing additional happens"), which is
    // the rules' own answer and is what `readyUnit` implements.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) => (event.targetUnitInstanceId ? readyUnit(state, event.targetUnitInstanceId) : state),
  },
  "UNL-010": {
    // Vault Breaker — "[Action] Give a unit [Assault 2] and [Ganking] this turn."
    //
    // Blood Rush's grant and Gem Jammer's, on one card and one target: "a unit"
    // with no owner and no battlefield printed, so `scope: "anywhere"`
    // (355.9.a.1 — see Upstage Comedy above on why that and not 355.9.b).
    // Arming an enemy is a legal misplay rather than a shape the targeting should
    // forbid — the call both of those cards already make.
    //
    // TWO calls to `grantKeywordThisTurn` rather than one merged write, because
    // the two keywords stack differently and that rule lives in
    // keyword-stacking.ts: a second `[Assault 2]` this turn is a second SOURCE
    // and sums to 4 (807.2), while a second `[Ganking]` is redundant (810.2).
    // Both go through the one merge point, so this resolver states no stacking
    // rule of its own.
    //
    // `[Ganking]` is unnumbered so the default value of 1 is right; `[Assault 2]`
    // carries its printed 2.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) => {
      const id = event.targetUnitInstanceId;
      if (!id) return state;
      return grantKeywordThisTurn(grantKeywordThisTurn(state, id, "Assault", VAULT_BREAKER_ASSAULT), id, "Ganking");
    },
  },
  "UNL-014": {
    // Monster Harpoon — "[Action] Deal 2 to a unit at a battlefield. If you
    // control a facedown card, deal 4 to it instead."
    //
    // Sudden Storm's shape exactly, with a different condition: "instead"
    // replaces the AMOUNT, so this is ONE instance of damage of either 2 or 4
    // rather than 2 followed by 2 more. That matters beyond arithmetic — each
    // instance is its own damage event, which `[Shield]` and the damage
    // modifiers price separately.
    //
    // **"IT" is the UNIT, not the facedown card**, even though the facedown card
    // is the nearer noun. Damage is dealt to units (417); a facedown card is in a
    // Facedown Zone, which 107.3.e says is not even a location. And "instead" can
    // only replace the 2 that the first sentence deals.
    //
    // "You control a facedown card" is `controlsAnyFacedownCard`, Mushroom
    // Pouch's condition. The Pouch prints the longer "a facedown card AT A
    // BATTLEFIELD" and this one does not, but 107.3.a/421.1 make every facedown
    // card a card at a battlefield you control, so the two conditions cannot
    // differ and a second predicate would only be a second thing to get wrong.
    // Control of the card follows control of the battlefield (107.3.d), which is
    // exactly what that helper asks.
    //
    // Asked at RESOLUTION, like every other "if" in this file: an opponent taking
    // the battlefield in the response window turns the 4 back into a 2.
    targeting: { kind: "unit" },
    resolve: (state, ctx, event) => {
      const targetId = event.targetUnitInstanceId;
      if (!targetId) return state;
      const amount = controlsAnyFacedownCard(state, ctx.casterIndex) ? MONSTER_HARPOON_ARMED : MONSTER_HARPOON_BASE;
      return dealDamage(state, ctx.casterIndex, targetId, amount);
    },
  },
  "UNL-017": {
    // Square Up — "[Repeat] — Discard 1. Give a unit [Assault 4] this turn."
    //
    // Cleave's sentence with a bigger number (OGN-004, four registries up), so the
    // instruction itself needs nothing new: `grantKeywordThisTurn` carries the
    // printed 4, and 807.1.c makes that "+4 Might while I am an attacker" rather
    // than a flat pump.
    //
    // "A unit" — no owner and no battlefield printed, so `scope: "anywhere"`
    // (355.9.a.1's widening, "'Unit,' 'gear,' and 'rune' refer to objects on the
    // Board unless specified otherwise" — NOT 355.9.b, which is the narrowing that
    // makes a printed "at a battlefield" load-bearing). Arming an enemy is a legal
    // misplay, the call Blood Rush and Vault Breaker already make.
    //
    // **THE `[Repeat]` HALF IS NOT REACHABLE, and unlike Upstage Comedy's it
    // cannot be fixed by adding a row.** `RepeatCostSpec` (card-effects.ts) has
    // `energy`, `power`/`domain` and `rainbowPower` and nothing else, so it cannot
    // express a repeat cost of "Discard 1" — this is the pool's FIRST non-resource
    // Repeat price. With no row, `legal-actions` enumerates no repeat-paid variant
    // and `validate-play-card` refuses one, so the spell plays at its printed 4
    // Energy and grants once. Closing it means widening that spec (a discard
    // choice the payment path can carry, the shape Brazen Buccaneer's optional
    // discard already has in the COST math) — a shared file, deliberately not
    // touched here. `test/unl-fury-wave3.test.ts` pins the wrong answer so that
    // pricing it fails loudly instead of changing quietly.
    //
    // The resolver needs NOTHING when that lands: 820.1.d's additional execution
    // re-enters this same `resolve` with `repeatChoices`, and 807.2 sums the two
    // grants to [Assault 8] on one unit (or arms two units, if the second
    // execution names a different one).
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId
        ? grantKeywordThisTurn(state, event.targetUnitInstanceId, "Assault", SQUARE_UP_ASSAULT)
        : state,
  },
  "UNL-007": {
    // Smite — "[Action] Deal 3 to a unit at a battlefield. If it would die this
    // turn, banish it instead."
    //
    // **WHOLE as of 2026-08-13.** The refusal that stood here was right about
    // everything, including the shape of the wrong answer, so its reasoning is
    // kept and only its conclusion changed.
    //
    // "AT A BATTLEFIELD" is printed, so the default `scope` stands (355.9.b's
    // narrowing, "it meets all targeting restrictions" — NOT 355.9.a.1, which is
    // the widening that a bare "a unit" would take). A unit parked in base is out
    // of reach, the line Incinerate already draws.
    //
    // # The rider is ARMED FOR THE TURN, not applied to this damage
    //
    // "If it WOULD die this turn ... INSTEAD" is a Replacement Effect by 369.1's
    // own identifiers ("as", "would", "instead"), armed for the TURN rather than
    // for this instruction: a unit Smitten for 3 that survives, and then dies to
    // combat an hour later, is still banished. So this adds the target to
    // `GameState.banishOnDeathUnitInstanceIds` — the shape
    // `deathWardedUnitInstanceIds` already has — and `killUnit` consumes it.
    //
    // **The plausible fake the refusal named**: banish the target HERE when this
    // damage happens to be lethal. Wrong in both directions — it misses every
    // later death the card is armed for, and it would banish PAST the replacement
    // chain (Zhonya's, Guardian Angel, a death ward) that 369/370 let apply
    // first. The list is checked inside `killUnit`, below the ward, so the chain
    // is intact; 372 is why below rather than above.
    //
    // # The arming happens BEFORE the damage, and that ordering is the card
    //
    // The 3 may itself be lethal, and "if it would die THIS TURN" covers that
    // death as much as a later one. Arming after `dealDamage` would let the very
    // death this spell causes reach the trash, so the card would banish every
    // unit it did NOT kill and none that it did — the exact inversion of what it
    // prints, and invisible to any test that only checks a survivor.
    //
    // 808.1.d.1 makes a replaced death not a death, so a banished unit fires no
    // `[Deathknell]` and reaches no trash-recursion. That is the observable
    // difference and it is asserted.
    targeting: { kind: "unit" },
    resolve: (state, ctx, event) => {
      const targetId = event.targetUnitInstanceId;
      if (!targetId) return state;
      const armed: GameState = {
        ...state,
        banishOnDeathUnitInstanceIds: state.banishOnDeathUnitInstanceIds.includes(targetId)
          ? state.banishOnDeathUnitInstanceIds
          : [...state.banishOnDeathUnitInstanceIds, targetId],
      };
      return dealDamage(armed, ctx.casterIndex, targetId, SMITE_DAMAGE);
    },
  },
  "UNL-020": {
    // Dancing Grenade — "Deal 2 to a unit. Its controller may play this spell
    // again for [rainbow]. If they do, this deals 1 additional Bonus Damage for
    // each time this spell has dealt damage this turn."
    //
    // **WHOLE as of 2026-08-14**, and the refusal it carried until then is kept
    // below because it was exactly right about its blocker and wrong about the
    // fix — twice, having already been re-triaged once.
    //
    // "A unit" — no owner and no location printed, so `scope: "anywhere"`
    // (355.9.a.1's widening, "'Unit,' 'gear,' and 'rune' refer to objects on the
    // Board unless specified otherwise" — NOT 355.9.b, which is the narrowing
    // that makes a printed "at a battlefield" load-bearing). A unit sitting in
    // either base is a legal choice, the same reading Square Up above takes.
    //
    // # What the refusal said, and why it was wrong
    //
    // It said: "ITS controller may play this spell again" hands the replay to the
    // DAMAGED unit's controller, a replay has to become a PERMISSION the ordinary
    // play path spends, and `timing.mayPlayCardNow` opens with `playerIndex !==
    // actingPlayerIndex(state)` — so a cross-seat grant is not merely unwritten
    // but UNUSABLE. It added that this engine cannot pay mid-resolution.
    //
    // The first half is TRUE of the permission path and the answer is to not take
    // it. A parked decision is answered by whoever it names: `legal-actions`
    // returns the pending decision's answers and nothing else while one is
    // outstanding, so the opponent gets a real window instead of one that never
    // opens. The second half was simply STALE — `payPowerFromChanneled` has paid
    // a Power cost from inside a resolution since Flame Chompers, and
    // "for [rainbow]" is that helper's `null` domain exactly.
    //
    // So the only genuinely new thing this card needed was the tally, and it is
    // the smallest of the three things the refusal named.
    //
    // # The three instructions
    //
    // The DAMAGE is `dealDamage`, escalated by the tally — see the resolver.
    //
    // The REPLAY is two parked decisions (yes/no, then the new target), for the
    // reason Here to Help's pair records: a `PendingDecision` carries one option
    // id, and folding a target into the yes/no would make the option list the
    // cross product of the offer and every unit on the board.
    //
    // The TALLY is `GameState.damageInstancesByCardThisTurn`, keyed by instanceId
    // and cleared at runEnd. It is written by this resolver rather than by
    // `dealDamage`, which takes no source card — see `recordCardDamageInstance`
    // for why threading one through 60 call sites to serve one text is the wrong
    // trade.
    //
    // The plausible fake the refusal named is still worth naming, because it
    // would have passed a shallow test: park a "pay [rainbow] to deal 2 more"
    // question on the CASTER. That is a different card in three ways at once —
    // wrong player, no replay (so no second `cardPlayed`, which Katarina -
    // Reckless and Black Market Broker watch), and a fixed bonus where the printed
    // one escalates. All three are asserted in `test/dancing-grenade.test.ts`.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, event) => {
      const targetId = event.targetUnitInstanceId;
      if (!targetId) return state;
      const found = findUnitAnywhere(state, targetId);
      if (!found) return state; // killed in the response window — 359.3
      // "ITS controller" is read BEFORE the damage, because the damage can kill
      // the unit and a dead unit has no controller to hand the replay to. Same
      // capture-then-act shape Death from Below takes for its Might reading.
      const controller = found.ownerIndex;
      // **The escalation, and it is measured before this execution is counted.**
      // "1 additional Bonus Damage for each time this spell has dealt damage this
      // turn" — on the first play the tally is 0, so it deals its printed 2; the
      // copy the replay plays sees 1 and deals 3; the next sees 2 and deals 4.
      //
      // Added to the AMOUNT rather than routed through a separate bonus channel:
      // 714 sums every instance of Bonus Damage and applies it once, and 715.1
      // applies it to a single-target Deal — so for one target one instance, the
      // sum IS the amount. `dealDamage` still applies `modifiedDamageAmount` on
      // top, which is where Annie - Fiery's own +1 comes in.
      const bonus = cardDamageInstancesThisTurn(state, ctx.sourceCardInstanceId);
      const before = found.unit.damage;
      const damaged = dealDamage(state, ctx.casterIndex, targetId, DANCING_GRENADE_DAMAGE + bonus);
      // Counted only when damage was actually DEALT. Three things can eat it —
      // Unyielding Spirit's per-player prevention, Kayn - Unleashed's "takes no
      // damage", and Counter Strike's one-shot shield — and "each time this spell
      // has DEALT damage" is false for all three. Measured off the board rather
      // than assumed: the unit is gone (lethal) or its damage rose.
      const after = findUnitAnywhere(damaged, targetId);
      const dealt = after === undefined || after.unit.damage > before;
      const tallied = dealt ? recordCardDamageInstance(damaged, ctx.sourceCardInstanceId) : damaged;
      if (ctx.sourceCardInstanceId === undefined) return tallied;
      // "ITS controller MAY play this spell again" — a question for a player who
      // is usually NOT the active one, which is the whole reason this is a parked
      // decision rather than a play permission. `legal-actions` returns only the
      // pending decision's answers while one is outstanding, and it returns them
      // for `decision.playerIndex` whoever that is, so the opponent gets the
      // window the permission path could never give them.
      return parkDecision(tallied, {
        kind: DANCING_GRENADE_REPLAY,
        playerIndex: controller,
        cardInstanceId: ctx.sourceCardInstanceId,
      });
    },
  },
};

/** Right of Conquest's unconditional first card, named so the `1 +` in its
 *  resolver is not a bare literal next to a computed count. */
const RIGHT_OF_CONQUEST_BASE_DRAW = 1;

/** Against the Odds' per-enemy step, and Sudden Storm's two amounts — named
 *  because each is a printed number the resolver would otherwise read as a bare
 *  literal beside another bare literal. */
const AGAINST_THE_ODDS_PER_ENEMY = 2;
const BLOOD_RUSH_ASSAULT = 2;
const PIERCING_LIGHT_DAMAGE = 2;
const SUDDEN_STORM_BASE = 2;
const SUDDEN_STORM_VS_ATTACKER = 4;

/** Blast Corps Cadet's paid-for hit. */
const BLAST_CORPS_DAMAGE = 2;

/** Vault Breaker's grant, and Monster Harpoon's two amounts — named for the same
 *  reason Sudden Storm's pair above are: two printed numbers side by side in one
 *  resolver read as bare literals otherwise. */
const VAULT_BREAKER_ASSAULT = 2;
const MONSTER_HARPOON_BASE = 2;
const MONSTER_HARPOON_ARMED = 4;

/** Square Up's grant — printed, and the largest [Assault] in the pool. */
const SQUARE_UP_ASSAULT = 4;

/** Smite's hit. Only the damage half of the card is written — see its entry. */
const SMITE_DAMAGE = 3;

/** Dancing Grenade's opening hit — the only half of that card that is written,
 *  and the base the unwritten escalation would have added to. See its entry. */
const DANCING_GRENADE_DAMAGE = 2;
/** "for :rb_rune_rainbow:" — one Power pip of any domain. `null` is the rainbow
 *  domain everywhere in this engine. */
const DANCING_GRENADE_REPLAY_POWER = 1;
/** The two questions the replay asks, named so the resolver and the registry
 *  cannot spell one of them differently. */
const DANCING_GRENADE_REPLAY = "UNL-020-replay";
const DANCING_GRENADE_TARGET = "UNL-020-target";

/**
 * Dancing Grenade sitting in its OWNER's trash, with that owner's index.
 *
 * The card is in the CASTER's trash — a Spell trashes itself as it is played —
 * while the player answering is the damaged unit's controller, so the two seats
 * are usually different and the owner has to be looked up rather than assumed.
 * Searching both trashes is what makes the answer the OWNER by construction:
 * whichever trash holds it is whose card it is.
 */
function dancingGrenadeInTrash(
  state: GameState,
  cardInstanceId: string | undefined,
): { card: CardInstance; ownerIndex: 0 | 1 } | undefined {
  if (cardInstanceId === undefined) return undefined;
  for (const ownerIndex of [0, 1] as const) {
    const card = state.players[ownerIndex].trash.find((c) => c.instanceId === cardInstanceId);
    if (card) return { card, ownerIndex };
  }
  return undefined;
}

/** Every unit on the board, either player's, base or battlefield — "a unit" with
 *  no owner and no location word (355.9.a.1). */
function allUnitsOnBoard(state: GameState): UnitInstance[] {
  return [
    ...state.players.flatMap((p) => p.baseUnits),
    ...state.battlefields.flatMap((bf) => Object.values(bf.units).flat()),
  ];
}

/**
 * The replay itself — 419.3, "game effects may result in cards being played as
 * part of their resolution", with 419.3.b's "treat all steps of Play as normal,
 * except as noted by the game effect creating this Limited Play Effect". The one
 * step this card notes is the cost, which it replaces with [rainbow].
 *
 * Three things happen in the order a play happens them in: the pip is paid, the
 * card leaves the zone it was in, and then it is played. `playCardIgnoringCost`
 * does the last of those and is explicit that the CALLER pays and the CALLER
 * removes the card — so both are done here.
 *
 * **`spellTrashOwnerIndex` is the one thing this needed from that helper.** It
 * trashes a played Spell into the trash of the player who played it, which is
 * right for every other caller and wrong here: the card is the caster's and a
 * card goes to its OWNER's trash. Without it the Grenade migrates across the
 * table one replay at a time.
 *
 * **`cardsPlayedThisTurn` is bumped for the REPLAYER**, because this is a card
 * they played — [Legion] and Viktor - Innovator both count it, the same call Here
 * to Help and Void Rush make. `playCardIgnoringCost` deliberately leaves that to
 * the caller.
 */
function replayDancingGrenade(
  state: GameState,
  playerIndex: 0 | 1,
  cardInstanceId: string | undefined,
  targetInstanceId: string,
): GameState {
  const found = dancingGrenadeInTrash(state, cardInstanceId);
  if (!found) return state;
  const paid = payPowerFromChanneled(state, playerIndex, null, DANCING_GRENADE_REPLAY_POWER);
  if (paid === undefined) return state; // the pool moved between the offer and the answer
  const players = [...paid.players] as [PlayerState, PlayerState];
  players[found.ownerIndex] = {
    ...players[found.ownerIndex],
    trash: players[found.ownerIndex].trash.filter((c) => c.instanceId !== found.card.instanceId),
  };
  players[playerIndex] = { ...players[playerIndex], cardsPlayedThisTurn: players[playerIndex].cardsPlayedThisTurn + 1 };
  return playCardIgnoringCost(
    { ...paid, players },
    playerIndex,
    found.card,
    undefined,
    { targetUnitInstanceId: targetInstanceId },
    found.ownerIndex,
  );
}

export const unitTriggers: Record<string, UnitTriggerDefinition> = {
  "VEN-023": {
    // Zed, From the Shadows — "[Assault 4] You may discard 1 as an additional cost
    // to play me. When you play me, if you paid the additional cost, play a 0
    // [Might] Shadow Clone unit token."
    //
    // The token is `SHADOW_CLONE_TOKEN`, shared from token.ts because VEN-144
    // Death Mark makes the same one from another file — the drift
    // `SAND_SOLDIER_TOKEN` and `BIRD_TOKEN` both record. Its printed ability
    // ("when I attack, you may banish a unit from your trash…") is registered in
    // `engine/triggers.ts` under the token's runtime defId, the arrangement the
    // Gold token already uses: a token is not a card, so no per-domain file may
    // own it and `effect-registry.test.ts` would refuse it there.
    //
    // **`event.discardCardInstanceId` is the whole "if you paid" test** — it is
    // set exactly when a discard variant was submitted, so there is no separate
    // flag to fall out of step with it. Ruthless Strike's entry records the same
    // reading.
    //
    // The discard is performed HERE, like Brazen Buccaneer's and Ruthless
    // Strike's: it is the one instruction the cost machinery cannot perform,
    // since it does not know which card the effect wants gone.
    //
    // **The caster CHOOSES where the Clone lands, base or a battlefield they
    // control.** The card names no destination, so 185.2.a is the whole rule: a
    // token is played "following all the applicable steps for playing a card plus
    // any restrictions from the effect that created it", and a Unit's inherent
    // restriction is base or a battlefield you control.
    //
    // **This was recorded as "narrower than printed" for a blocker that was real
    // but did not bind.** The note said the choice needs a row in
    // `TOKEN_PLACEMENT_SPELL_DEF_IDS`, and that table is for SPELLS — true, and
    // true that a unit's on-play trigger has no `destinationBattlefieldId` axis
    // to fan out over. But an action-space fan-out is not the only way to ask:
    // the trigger PARKS A QUESTION at resolution, which is how every battlefield
    // ability asks its own, and Vanguard Armory (`SFD-168-place` in order.ts)
    // already asks this exact question with these exact options. VEN-144 Death
    // Mark mints the identical token and always got the choice; the difference
    // was the shape of the card that makes it, not anything the token says.
    //
    // With no controlled battlefield the list is one option long and
    // `advanceDecisions` executes it without ever showing it, so the ordinary
    // case costs the player nothing and no prompt appears.
    targeting: { kind: "none" },
    resolve: (state, ctx, _unitId, event) => {
      if (event.discardCardInstanceId === undefined) return state;
      const paid = discardCards(state, ctx.casterIndex, 1, [event.discardCardInstanceId]);
      return parkDecision(paid, { kind: "VEN-023-place", playerIndex: ctx.casterIndex });
    },
  },
  "VEN-017": {
    // Morgana, Vindictive — "[Ambush] When you play me, deal damage to a unit
    // equal to the damage marked on it."
    //
    // **A finisher, not removal**: the shot is exactly as big as the wound
    // already there, so it doubles marked damage and is worth nothing at all on
    // an untouched unit. Read live off `unit.damage` at resolution rather than
    // captured when the trigger was held — 383 fixes WHAT triggered at the moment
    // of the event, not the numbers the instruction reads, and the response
    // window between the two is exactly when someone else's damage lands.
    //
    // `[Ambush]` is a play-timing keyword handled by the timing layer (it lets
    // her be played as a [Reaction] to a battlefield where you have units); it
    // does not gate this trigger, which is why nothing here reads it.
    //
    // ZERO deals nothing rather than 0, the convention Lucian - Gunslinger's
    // `[Assault]` shot records below: an instance of 0 damage is still an
    // instance, and would trip the damage-triggered abilities in this pool.
    // Unlike his, this case is COMMON — most units on a board are undamaged — so
    // it is the difference between a trigger that fires uselessly and one that
    // fires wrongly.
    //
    // "A unit", bare, so `scope: "anywhere"` (355.9.a.1). A damaged unit sitting
    // in a base is a legal choice and often the right one.
    //
    // **NOT `optionalChoice`.** The text prints no "you may", so with a legal
    // target on the board the shot happens; `unit-triggers` already offers the
    // empty variant when there is nothing to choose, which is the only case where
    // she may arrive without naming anything.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, _unitId, event) => {
      const targetId = event.targetUnitInstanceId;
      if (!targetId) return state;
      const found = findUnitAnywhere(state, targetId);
      // 359.3.e.12 — a check on something no longer available returns null. Killed
      // in the response window is the ordinary way to reach this.
      if (!found || found.unit.damage <= 0) return state;
      return dealDamage(state, ctx.casterIndex, targetId, found.unit.damage);
    },
  },
  "SFD-013": {
    // Blast Corps Cadet — "You may pay [1][Fury] as an additional cost to play
    // me. When you play me, if you paid the additional cost, deal 2 to a unit at
    // a battlefield."
    //
    // The FIRST optional additional cost in the pool with an ENERGY half —
    // Clockwork Keeper's is a rune alone, which is why `OPTIONAL_POWER_COSTS`
    // held only a domain and a count until now.
    //
    // Gated on the cost having been PAID, read off the action, for the reason
    // the Keeper's own comment gives: by the time this runs, nothing about the
    // board records how the Cadet was paid for.
    //
    // **The target is chosen whether or not the cost was paid**, which is a
    // consequence of targeting being declared per card rather than per branch. A
    // Cadet played cheap names a unit and then does nothing to it — harmless,
    // and the alternative is a second targeting spec keyed on a flag the
    // enumerator would have to read.
    targeting: { kind: "unit" },
    resolve: (state, ctx, _unitId, event) =>
      event.optionalPowerPaid && event.targetUnitInstanceId
        ? dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId, BLAST_CORPS_DAMAGE)
        : state,
  },
  "OGN-026": {
    // Brynhir Thundersong — "When you play me, opponents can't play cards this
    // turn."
    //
    // A one-shot lock on the TURN, not a continuous ability: set here and cleared
    // by `runEnd`, so killing her in response does not unlock it. That is the
    // printed reading — "this turn" is a duration, and nothing in the sentence
    // ties it to her staying alive.
    //
    // Read in `timing.mayPlayCardNow` BEFORE the tier switch, so it bars a
    // [Reaction] too. A lock that a Reaction could step around would not be a
    // lock at all, and Reactions are precisely what an opponent reaches for.
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      players[ctx.opponentIndex] = { ...players[ctx.opponentIndex], cannotPlayCardsThisTurn: true };
      return { ...state, players };
    },
  },
  "OGN-031": {
    // Raging Firebrand — "When you play me, the NEXT spell you play this turn
    // costs [5] less."
    //
    // A CHARGE, not a standing discount: it is spent by the first Spell played
    // and does nothing for the second. That is why `nextSpellEnergyDiscount` is a
    // number that is decremented rather than a flag that is read — the same shape
    // `nextUnitsEnterReady` already takes for Sun Disc, and for the same reason.
    //
    // Two Firebrands stack to 10, which is the literal reading of two separate
    // charges and matches how `nextUnitsEnterReady` accumulates.
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const players = [...state.players] as [PlayerState, PlayerState];
      players[ctx.casterIndex] = {
        ...players[ctx.casterIndex],
        nextSpellEnergyDiscount: players[ctx.casterIndex].nextSpellEnergyDiscount + 5,
      };
      return { ...state, players };
    },
  },
  "OGN-016": {
    // Dangerous Duo — "[Legion] — When you play me, give a unit +2 Might this
    // turn."
    //
    // `countingSelf: true`: this fires from dispatchOnPlayUnit, by which point
    // execute-play-card has already counted the Duo itself, so "another card"
    // needs two. See legionActive — the off-by-one here is invisible in play,
    // it just makes the card work on the turn's first play when it shouldn't.
    //
    // "A unit" with no owner and no battlefield named, so scope "anywhere" and
    // either side is legal (355.9.a.1). The target is still CHOSEN when Legion is
    // unmet — enumeration cannot know whether the condition will hold at
    // resolution, and a card that offers no target would be unplayable rather
    // than merely ineffective.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, _unitId, event) =>
      legionActive(state, ctx.casterIndex, true) && event.targetUnitInstanceId
        ? giveMightThisTurn(state, event.targetUnitInstanceId, 2)
        : state,
  },
  "OGN-020": {
    // Scrapyard Champion — "[Legion] — When you play me, discard 2, then draw 2."
    //
    // discardThenDraw, not drawCards(discardCards(...)): the "then" is
    // load-bearing and the discard stops to ask, so the draw has to be queued
    // BEHIND the questions or the cards just drawn join the hand being chosen
    // from. That helper exists for exactly this sentence.
    targeting: { kind: "none" },
    resolve: (state, ctx) => (legionActive(state, ctx.casterIndex, true) ? discardThenDraw(state, ctx.casterIndex, 2, 2) : state),
  },
  "OGN-002": {
    // Brazen Buccaneer — "As you play me, you may discard 1 as an additional
    // cost. If you do, reduce my cost by 2 Energy."
    //
    // The discount lives in the COST math (validate-play-card and
    // legal-actions, via card-effects' DiscardChoiceSpec), because it changes
    // what the payment has to cover and must therefore be known before the card
    // is paid for. All that is left for the card itself is performing the
    // discard it was paid with — the same shape Cruel Patron's kill takes.
    //
    // Nothing happens when the caster declined: the discount was not applied
    // either, so the two stay consistent.
    targeting: { kind: "none" },
    resolve: (state, ctx, _unitId, event) =>
      event.discardCardInstanceId ? discardCards(state, ctx.casterIndex, 1, [event.discardCardInstanceId]) : state,
  },
  "OGN-030": {
    // Jinx - Demolitionist — "When you play me, discard 2."
    // Her [Accelerate] and [Assault 2] are keywords the engine handles (rule 805
    // in engine/timing.ts, Assault in effective-might.ts); only the discard is a
    // trigger. Unchosen, per discardCards' documented convention.
    targeting: { kind: "none" },
    resolve: (state, ctx) => discardCards(state, ctx.casterIndex, 2),
  },
  "OGN-003": {
    // Chemtech Enforcer — "[Assault 2] (+2 Might while I'm an attacker.) When
    // you play me, discard 1."
    //
    // Only the discard lives here. [Assault 2] is a keyword and belongs to the
    // keyword machinery in effective-might.ts, which applies it in the combat
    // context only — writing it again here would double it.
    //
    // "Discard 1" with no other player named is the CASTER's own hand: rule 422
    // (Discard) is a move from a player's hand directly into *their* trash, so
    // ctx.casterIndex is both the discarder and the recipient of the cards.
    //
    // Unchosen, so discardCards takes the front of hand. That is a real
    // simplification and rule 422 is explicit against it — the player performing
    // the discard chooses which cards go to their trash. It stands because an
    // on-play trigger has nowhere to carry the choice: UnitTriggerEvent has no
    // discard slot, and this engine cannot pause mid-resolution to ask (see
    // card-effects.ts's TargetingSpec doc comment). Same constraint, and the
    // same front-of-hand answer, as Traveling Merchant's on-move discard;
    // recorded in docs/rules-conformance.md rather than invented here.
    //
    // An empty hand discards nothing and is not an error — rule 055 discards as
    // many cards as possible and ignores the rest of the instruction, which is
    // discardCards' own no-op-on-empty behaviour, so no guard is needed.
    targeting: { kind: "none" },
    resolve: (state, ctx) => discardCards(state, ctx.casterIndex, 1),
  },
  "OGN-038": {
    // Kadregrin the Infernal — "When you play me, draw 1 for each of your
    // [Mighty] units."
    //
    // `isMighty` rather than a hand-written `>= 5`, and that is not tidiness:
    // rule 710 asks about a unit's CURRENT Might, so a 3-Might body standing
    // under Garen - Commander with a buff is Mighty and a hardcoded comparison
    // against `unit.might` would miss it. That helper is also asked with
    // `isCombat: false` on purpose (see its doc comment) — Mighty is a property
    // of the unit, not of a fight, so `[Assault]` never pushes one over the line.
    //
    // **He counts himself, and that is the printed text.** `dispatchOnPlayUnit`
    // runs after execute-play-card has already put him on the board, so
    // `ownUnitsEverywhere` sees him — and at a printed 9 Might he is always
    // Mighty, which makes this card draw at least 1 rather than sometimes 0.
    // The text says "each of YOUR Mighty units" with no "other", exactly as
    // Sett - Kingpin's aura omits the "other" that Garen and Lee Sin print.
    //
    // "YOUR" units, base and battlefields both — nothing here is positional.
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const mighty = ownUnitsEverywhere(state, ctx.casterIndex).filter((u) => isMighty(state, u, ctx.casterIndex)).length;
      return drawCards(state, ctx.casterIndex, mighty);
    },
  },
  "SFD-007": {
    // Gem Jammer — "[Ganking] When you play me, give a unit [Ganking] this turn."
    //
    // His own printed `[Ganking]` is the keyword machinery's; only the GRANT is
    // here, and writing the printed one again would be a second source of truth
    // for the same fact.
    //
    // "A unit", with no owner and no battlefield named, so `scope: "anywhere"`
    // and either side is legal — 355.9.a.1's bare noun, the same call Cleave makes
    // two registries up. Handing an opponent's unit free mobility is a bad play
    // rather than an illegal one, and the enumeration must offer it or a human
    // could not make it.
    //
    // `grantKeywordThisTurn`'s default value of 1 is right: `[Ganking]` is
    // unnumbered, unlike Cleave's `[Assault 3]`.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, _unitId, event) =>
      event.targetUnitInstanceId ? grantKeywordThisTurn(state, event.targetUnitInstanceId, "Ganking") : state,
  },
  "UNL-003": {
    // Mischievous Marai — "[Hidden] When you play me to a battlefield, deal 2 to
    // an enemy unit HERE."
    //
    // Her `[Hidden]` is the keyword machinery's (engine/hidden.ts); only the
    // trigger is here.
    //
    // # Why this asks a DECISION instead of declaring a target
    //
    // "HERE" is her destination, and a Unit's on-play target is chosen on the
    // PlayCard action — which `legal-actions` fans out over destinations AFTER it
    // has built the target variants. So `{ kind: "unit", owner: "enemy" }` would
    // offer every enemy unit at every battlefield paired with every destination,
    // and most of those pairs name a unit that is not "here". Narrowing it needs
    // a new destination-aware property on `TargetingSpec` enumerated in
    // legal-actions.ts; a resolver-side refusal was rejected for the reason
    // `sameBattlefield` records — by then the card is paid for, and refusing
    // leaves it doing nothing.
    //
    // So the choice is parked, exactly as Janna - Savior's "move up to one enemy
    // unit from HERE" is (SFD-053, effects/calm.ts) and Katarina - Reckless's
    // shot below.
    //
    // **The rules agree with the parked version, and it is the TargetingSpec
    // route that diverges.** 355.5.b: "A unit with a triggered ability that says
    // 'When I'm played, kill a unit' does not require you to choose a target as
    // it's played. The target will be chosen when the ability triggers." Putting
    // an on-play trigger's target on the PlayCard action is this engine's
    // simplification (it cannot pause mid-resolution, so every other unit trigger
    // decides at announce). What is left here is one step of slack — the decision
    // is answered at RESOLUTION rather than when the trigger is finalized on the
    // chain (355.8) — which is the same gap every parked decision in this engine
    // carries.
    //
    // "TO A BATTLEFIELD" is printed, so a Marai played to base does nothing at
    // all — unlike Janna, whose "your units here" is a real instruction wherever
    // she lands. The base case returns early rather than parking a question with
    // no answers.
    //
    // Nothing to shoot is nothing to ask (422 / the same call Rumble's trade and
    // Katarina's shot make), so an empty enemy side parks no Pending Item.
    targeting: { kind: "none" },
    resolve: (state, ctx, _unitId, event) => {
      if (event.destination === "base") return state;
      const { battlefieldId } = event.destination;
      if (enemyUnitsAt(state, ctx.opponentIndex, battlefieldId).length === 0) return state;
      return parkDecision(state, { kind: "UNL-003-shot", playerIndex: ctx.casterIndex, battlefieldId });
    },
  },
  "UNL-012": {
    // Lord Broadmane — "[Ambush] [Assault] When you play me, give your OTHER
    // units HERE [Assault] this turn."
    //
    // **HIS `[Ambush]` IS NOT IMPLEMENTED, and it is not implementable from this
    // file.** "You may play me as a [Reaction] to a battlefield where you have
    // units" is a play PERMISSION — it belongs beside `PLACEMENT_GRANTS` in
    // unit-triggers.ts and the timing tier in card-loader/timing.ts, none of
    // which this file owns. `coverage.UNIMPLEMENTED_KEYWORDS` still carries an
    // `Ambush` row, so the card correctly reports unimplemented despite this
    // registration; the row leaving is what flips him, and nothing here should
    // pretend otherwise.
    //
    // His own printed `[Assault]` is the keyword machinery's. Only the GRANT is
    // written here — writing the printed one again would be a second source of
    // truth for the same fact.
    //
    // "OTHER" excludes him by INSTANCE rather than by defId, so a second Lord
    // Broadmane already standing there IS pumped. He is on the board by the time
    // this resolves — `dispatchOnPlayUnit` fires after execute-play-card has
    // placed him — so without the filter he would pump himself.
    //
    // "HERE" is `event.destination`, and unlike Mischievous Marai above he prints
    // no "to a battlefield": played to BASE he still grants, to his other units
    // in base. `[Assault]` is worth nothing to a unit that is not attacking, so
    // that is a dead grant rather than a wrong one — and a Base is a place like
    // any other, the same reading Janna - Savior's heal takes.
    //
    // Bare `[Assault]`, so `grantKeywordThisTurn`'s default value of 1 (807.2's
    // sum then makes his grant stack with a Blood Rush on the same unit).
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId, event) =>
      ownUnitsAt(state, ctx.casterIndex, event.destination)
        .filter((u) => u.instanceId !== unitId)
        .reduce((next, u) => grantKeywordThisTurn(next, u.instanceId, "Assault", LORD_BROADMANE_ASSAULT), state),
  },
  "UNL-021": {
    // Grim Apothecary — "[Ambush] When you play me, you may return a friendly unit
    // at a battlefield to its owner's hand."
    //
    // **His `[Ambush]` is NOT implemented**, for the reason Lord Broadmane's entry
    // above states at length: a play PERMISSION lives beside `PLACEMENT_GRANTS` in
    // unit-triggers.ts and the timing tier in timing.ts. `UNIMPLEMENTED_KEYWORDS`
    // still carries the `Ambush` row, so registering this clause does NOT make the
    // card report DONE — `isCardImplemented` asks `unimplementedKeywordsOn` before
    // it asks the registry. No PARTIALLY_IMPLEMENTED entry is owed for him.
    //
    // # "You may", as an enumerated variant rather than a resolver branch
    //
    // `optionalChoice` is the flag built for exactly this sentence, and 402.1 is
    // why: "If the first part of a Triggered Ability's effect is 'you may,' or
    // 'they may,' its controller decides whether or not to perform the Triggered
    // Ability" at the Make Relevant Choices step — 402.1.a then removes it from the
    // chain. So declining has to EXIST as a choice the enumerator offers; a
    // resolver that quietly did nothing when handed no target would be a card that
    // is never optional in play, because `legal-actions` pushes the empty variant
    // only when there is nothing to choose. 402.2 ("make all choices required for
    // this ability, such as targets") is the same step for the target itself.
    //
    // Tideturner (OGN-199, effects/chaos.ts) is the precedent and its comment
    // claims to be "the ONLY card in the pool this reaches" — that sweep is stale
    // as of this card, and its citation for the "you may" rule reads 402.2 where
    // 402.1 is the sentence. Reported rather than edited: chaos.ts is not this
    // file's.
    //
    // # The three printed restrictions
    //
    // **FRIENDLY** — `owner: "friendly"`, measured from the caster.
    // **AT A BATTLEFIELD** — the default `scope`, 355.9.b's narrowing ("it meets
    // all targeting restrictions"), so a unit in either base is out of reach. NOT
    // 355.9.a.1, which is the widening a bare "a unit" would take.
    // **TO ITS OWNER'S HAND** — `returnUnitToHand` also strips the Buff (705) and
    // resets damage, because leaving play is leaving play. It files the card by the
    // index whose zone held the unit, and in this engine CONTROL IS list membership
    // — so for a unit taken with Hostile Takeover, "friendly" and "its owner"
    // disagree in the rules and agree here, and the card goes to the taker's hand.
    // That is the control-model divergence already recorded in
    // docs/rules-conformance.md, inherited rather than introduced.
    //
    // **DIVERGENCE, named: he cannot choose HIMSELF.** The rules put this trigger
    // on the chain after he has entered (383.4), so he is a friendly unit at a
    // battlefield by the time the choice is made; this engine decides a unit
    // trigger's target at the Make Relevant Choices step of PLAYING him, when he is
    // still in hand and has no board instance to offer. That is the shape of every
    // on-play targeting spec here, not something this card introduces, and the
    // alternative (a parked decision, which could offer him) trades it for
    // answering a turn LATER than 402 — resolution rather than finalization. The
    // narrower miss was preferred: bouncing himself undoes his own arrival and is
    // the one choice no board state makes worth taking.
    targeting: { kind: "unit", owner: "friendly", optionalChoice: true },
    resolve: (state, _ctx, _unitId, event) =>
      event.targetUnitInstanceId ? returnUnitToHand(state, event.targetUnitInstanceId) : state,
  },
  "UNL-028": {
    // Pyke - Dockside Butcher's LAST sentence — "When you play me, if you paid the
    // additional cost, ready me and give me +2 Might this turn."
    //
    // # The additional cost itself is NOT implemented, and this clause is inert
    //
    // "You may pay [Fury] as an additional cost to play me" is one row in
    // `card-effects.OPTIONAL_POWER_COSTS` — `"UNL-028": { domain: "Fury", count: 1 }`
    // — and that is a shared file this pass does not own. Without the row the
    // enumerator never offers the paid variant, `optionalPowerPaid` is never true,
    // and neither the ready nor the pump can fire in a real game. Written anyway
    // rather than left out, for the reason Nami - Headstrong (UNL-052,
    // effects/calm.ts) records: the flag is a real threaded mechanism (validator,
    // executor and `UnitTriggerEvent` all carry it, for Clockwork Keeper and the
    // three SFD cards), so the day the row lands the card works. Pinned by a test
    // that asserts an ordinary play readies nothing, so adding the row fails loudly
    // rather than silently changing behaviour.
    //
    // **The domain has to come from that table, not from `card.powerDomain`** —
    // Pyke prints ZERO Power, so his `powerDomain` is null and pricing against it
    // would accept a rune of any domain. Clockwork Keeper's exact trap.
    //
    // # "Ready me", not "I enter ready" — and the difference is the whole entry
    //
    // Scorchclaw (UNL-016, `mightModifiers` below) prints "enter ready", which is a
    // REPLACEMENT for how a unit arrives and lives in `deploy.conditionalEntersReady`;
    // an on-play `readyUnit` would be wrong for it in three measurable ways. Pyke
    // prints an INSTRUCTION, so `readyUnit` is exactly right here: he really does
    // arrive exhausted (143.4) and really is readied afterwards, so firing
    // `unitReadied` (Pirate's Haven) and being stoppable by Mageseeker Warden are
    // both correct rather than artefacts.
    //
    // # Printed order: ready first, then the Might
    //
    // Not observable today — nothing here reads Might between the two — but 359.2.b
    // ("execute all rules text on the card, from top to bottom") is the order the
    // sentence prints, and the alternative would need a reason.
    //
    // `[Hidden]` and `[Ganking]` are the engine's and belong nowhere in this file:
    // hidden.ts prices the hide, the move enumerator reads the Ganking, and neither
    // is in `coverage.UNIMPLEMENTED_KEYWORDS`.
    targeting: { kind: "none" },
    resolve: (state, _ctx, unitId, event) =>
      event.optionalPowerPaid ? giveMightThisTurn(readyUnit(state, unitId), unitId, PYKE_BUTCHER_MIGHT) : state,
  },
};

/** Lord Broadmane's grant, and Mischievous Marai's shot. */
const LORD_BROADMANE_ASSAULT = 1;
const MISCHIEVOUS_MARAI_DAMAGE = 2;

/** What Pyke - Dockside Butcher's paid Fury buys, on top of the ready. */
const PYKE_BUTCHER_MIGHT = 2;

/** The units `playerIndex` controls at a freshly-played unit's destination —
 *  "your other units HERE", where "here" may be a Base.
 *
 *  Its own walk rather than a filter over `ownUnitsEverywhere`, because that one
 *  flattens base and every battlefield together and loses exactly the location
 *  this reads. */
function ownUnitsAt(state: GameState, playerIndex: 0 | 1, destination: UnitPlayDestination): readonly UnitInstance[] {
  const owner = state.players[playerIndex];
  if (destination === "base") return owner.baseUnits;
  return state.battlefields.find((bf) => bf.id === destination.battlefieldId)?.units[owner.id] ?? [];
}

/** The enemy units standing at one battlefield — Mischievous Marai's "an enemy
 *  unit here". Rebuilt from live state at every call for the reason
 *  `DecisionDefinition.options` states: a unit that died while the question
 *  waited must not still be on offer. */
function enemyUnitsAt(state: GameState, enemyIndex: 0 | 1, battlefieldId: string): readonly UnitInstance[] {
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  return bf?.units[state.players[enemyIndex].id] ?? [];
}

/** Ferrous Forerunner's payout. A spec rather than a call to
 *  `placeRecruitToken`, because a Mech token is a different card: 3 Might, and
 *  the `Mech` tag is load-bearing (Rumble - Hotheaded's "your Mechs each have
 *  [Assault]" reads it, and the token is the archetype's whole point). No
 *  `entersReady` — 143.4.a's default stands, and the card says nothing else. */
const MECH_TOKEN: TokenSpec = { name: "Mech", might: 3, tag: "Mech" };

/** [Deathknell] effects — rule 808, "When I die, [Effect]". Keyed by the DYING
 *  card's defId. Same one-file-one-owner rule as the registries above. */
export const deathTriggers: Record<string, DeathknellDefinition> = {
  // Ferrous Forerunner — "[Deathknell] — Play two 3 Might Mech unit tokens to
  // your base." (rule 808)
  //
  // "TO YOUR BASE" is printed, so where he died is irrelevant — a Forerunner
  // killed at a battlefield still sends both tokens home, exactly as Machine
  // Evangel's three Recruits do. `ctx.casterIndex` is the dying unit's
  // controller, which is what "your" means for a Deathknell (see
  // resolveHeldDeathknell, which builds the context from `death.ownerIndex`).
  //
  // Two separate placements rather than a count: two tokens are two game objects
  // with two instanceIds, and `placeToken` mints one.
  "SFD-021": { resolve: (state, ctx) => [0, 1].reduce((next) => placeToken(next, ctx.casterIndex, "base", MECH_TOKEN), state) },
};

/** Listeners for board EVENTS other than a death (see triggers.ts's GameEvent).
 *  Keyed by the LISTENING card's defId. Same one-file-one-owner rule. */
/** Listeners for someone ELSE dying ("when a buffed friendly unit dies"), keyed
 *  by the LISTENING card's defId. Distinct from `deathTriggers` above, which is
 *  a [Deathknell] keyed by the DYING card. Same one-file-one-owner rule. */
export const deathWatchTriggers: Record<string, DeathWatchDefinition> = {};

/**
 * Blind Fury's reveal — "Each opponent reveals the top card of their Main Deck.
 * Choose one and banish it, then play it, ignoring its cost."
 *
 * Extracted from its resolver so Void Hatchling can run its look-and-recycle
 * first: this function is both the inline path and the body of the
 * `OGN-025-reveal` continuation, which makes the two identical by construction
 * rather than by two copies agreeing.
 *
 * Takes the CASTER's index and derives the victim, because that is what the
 * decision can carry — a `PendingDecision` names who answers, and in a two-player
 * game the other seat is the opponent by construction.
 */
function blindFuryReveal(state: GameState, casterIndex: 0 | 1): GameState {
  const victimIndex: 0 | 1 = casterIndex === 0 ? 1 : 0;
  const top = state.players[victimIndex].deck[0];
  if (!top) return state;
  const players = [...state.players] as [PlayerState, PlayerState];
  players[victimIndex] = { ...players[victimIndex], deck: players[victimIndex].deck.slice(1) };
  const played = playCardIgnoringCost({ ...state, players }, casterIndex, top);
  // **This reveal was never funnelled, and that was a PRE-EXISTING gap** —
  // found 2026-08-07 while surveying every reveal site for Undertitan.
  // Nocturne's "as you look at or reveal me" and Undertitan's "as I'm
  // revealed from your deck" are both owed here, and neither fired.
  //
  // The deck owner is the VICTIM, not the caster: both clauses are written
  // from the revealed card's own point of view ("your deck"), and the deck
  // being turned over is the opponent's. Raised AFTER the play for the
  // ordering Dazzling Aurora records — nothing here stops to ask, and a
  // Nocturne that was just played finds his own offer moot.
  return revealedFromDeck(played, victimIndex, [top]);
}

export const eventTriggers: Record<string, EventTriggerDefinition> = {
  "VEN-005": {
    // Forsaken Baccai — "If you control fewer runes than an opponent at the start
    // of your Beginning Phase, give me +1 [Might] this turn."
    //
    // The first of Vendetta's "behind on runes" pair (Oasis Raider, VEN-006, is
    // the other and is the same shape with a bigger payload). A CATCH-UP card:
    // it is live exactly while you are losing the resource race, and dead the
    // turn you draw level.
    //
    // # What "control fewer runes" counts
    //
    // `channeled.length` — the runes in the player's Rune Pool, which is what a
    // player controls. Not `runeDeck`, which is the unrevealed remainder and is
    // controlled by nobody in the sense any card means. Master Yi - Meditative's
    // "if you control 8 or more runes" already reads exactly this field in
    // `effective-might.ts`, and two cards asking the same question must not read
    // two different ones.
    //
    // STRICTLY fewer. Equal is not fewer, and this is the boundary the whole card
    // turns on — a mutation to `<=` is the plausible wrong version and passes any
    // test that only ever sets up a lopsided board.
    //
    // # Why this is an event trigger and not a Might modifier
    //
    // "GIVE me +1 Might THIS TURN" is a one-shot grant with a duration (432.1.a's
    // fixed amount), not a continuous aura: it is computed once when the phase
    // starts and does not follow the rune counts for the rest of the turn. A card
    // that read the runes continuously would be `effective-might.ts`'s business
    // and would turn itself off mid-turn when the opponent's runes were spent.
    //
    // `beginningPhase` is the one event kind this engine still resolves INLINE
    // (see trigger-census.test.ts) — deliberately, because holding it would
    // resolve Beginning-Phase abilities after `scoreHolds`. Nothing here depends
    // on that; it is stated so the absence of an `applies` is not read as an
    // oversight. An inline dispatch never consults `applies` at all, which is why
    // every condition below sits in `resolve`.
    on: "beginningPhase",
    resolve: (state, listener, event) => {
      if (event.kind !== "beginningPhase" || event.playerIndex !== listener.ownerIndex) return state;
      if (!behindOnRunes(state, listener.ownerIndex)) return state;
      return giveMightThisTurn(state, listener.card.instanceId, FORSAKEN_BACCAI_MIGHT);
    },
  },
  "VEN-006": {
    // Oasis Raider — "[Ganking] If you control fewer runes than an opponent at
    // the start of your Beginning Phase, give me +2 [Might] and [Ganking] this
    // turn."
    //
    // Forsaken Baccai's condition (VEN-005, above) with two payloads, and the
    // second of them is printed on a card that ALREADY HAS IT: his frame carries
    // `[Ganking]`, and the clause grants `[Ganking]` again.
    //
    // **That redundancy is the card, not a data error, and it must still be
    // granted.** `mergeGrantedKeyword` takes the higher value, so granting it to
    // a unit that has it is a no-op today — and the grant is what keeps the card
    // right the day something strips the printed keyword or the day a granted
    // `[Ganking]` is read by a card that distinguishes them. Dropping it because
    // "he already has it" would be reading the board instead of the card.
    //
    // Both payloads are one instruction with one condition, so they cannot come
    // apart: there is no board on which he gets the Might and not the keyword.
    on: "beginningPhase",
    resolve: (state, listener, event) => {
      if (event.kind !== "beginningPhase" || event.playerIndex !== listener.ownerIndex) return state;
      if (!behindOnRunes(state, listener.ownerIndex)) return state;
      const pumped = giveMightThisTurn(state, listener.card.instanceId, OASIS_RAIDER_MIGHT);
      return grantKeywordThisTurn(pumped, listener.card.instanceId, "Ganking");
    },
  },
  "VEN-009": {
    // Baccai Reaper — "[Assault 2] When I attack, you may pay [Fury] to give me
    // [Assault 2] this turn."
    //
    // Draven - Vanquisher's pump (SFD-020, below) with a keyword payload instead
    // of a Might one, and it takes that card's shape exactly: `combatBegan` +
    // `isAttackingAt`, the payment asked SPECULATIVELY in `applies` so an
    // unaffordable board places no Pending Item, and re-asked in `resolve`
    // because the window a hold opens is precisely when that Fury could be spent
    // on something else.
    //
    // **"Attack", not "attack or defend"** — `isAttackingAt`, where Draven's
    // clause says "attack or defend" and takes `isFightingAt`. The two predicates
    // exist as separate names so a card that deliberately ignores the designation
    // says so, and copying Draven wholesale would have quietly widened this one.
    //
    // # The grant STACKS with his printed [Assault 2], and 807.2 is why
    //
    // He prints `[Assault 2]` and the clause gives `[Assault 2]` — the same
    // keyword, from a separate source, with a value. **807.2 makes Assault
    // SUM**, which is the rule a playtest found this engine getting wrong two
    // sets ago, so a paid Reaper attacks at +4 rather than +2.
    //
    // That is `grantKeywordThisTurn`'s job and not this resolver's: it routes
    // through `mergeGrantedKeyword`, which is the single place the printed value
    // and a this-turn grant are combined. Adding the numbers here would be a
    // second implementation of 807.2 that could disagree with the first.
    //
    // "You MAY pay" is a cost, so this parks a question rather than firing —
    // 416.3 means it is not even asked when the Fury cannot be paid, and 402.1
    // puts the decision at the moment the ability resolves.
    on: "combatBegan",
    applies: (state, listener, event) =>
      isAttackingAt(state, listener, event) &&
      payPowerFromChanneled(state, listener.ownerIndex, "Fury", BACCAI_REAPER_POWER) !== undefined,
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      if (payPowerFromChanneled(state, listener.ownerIndex, "Fury", BACCAI_REAPER_POWER) === undefined) return state;
      return parkDecision(state, {
        kind: BACCAI_REAPER_PUMP,
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
      });
    },
  },
  "VEN-019": {
    // Renekton, Rage Fueled — "[Accelerate] When I attack, if you control 4 or
    // fewer runes, deal 2 to all enemy units here."
    //
    // A sweep with a rune CEILING, where Forsaken Baccai's pair have a rune
    // COMPARISON — both are Vendetta's "you are behind, so you hit harder" axis
    // and they are not the same test: this one is absolute, and a player with 4
    // runes fires it whether or not the opponent has 2.
    //
    // `[Accelerate]` is a cost keyword handled at play time (805) and does not
    // gate this trigger, which is why nothing here reads it.
    //
    // **"HERE" is re-checked at resolution against where he is standing**, and
    // the combat's battlefield is only what it is compared to. 359.3.f.2 checks a
    // referent on EXECUTION, with the rules' own worked example being exactly
    // this window — an opponent moving the attacker so that "'here' is no longer
    // the battlefield where combat is ongoing and the attack trigger mistargets".
    // A Renekton moved away or killed sweeps nothing, and the Pending Item still
    // cost both players a PassFocus. Lucian - Gunslinger's entry below is the
    // convention.
    //
    // The rune count is likewise re-read rather than captured: it is a condition
    // on the INSTRUCTION, and a rune spent during the response window is a rune
    // he no longer controls.
    //
    // `dealDamageToEnemyUnitsAtBattlefield` is the shared sweep, so "enemy" means
    // what it means everywhere else — measured from the ability's controller, not
    // from whoever is attacking.
    on: "combatBegan",
    applies: isAttackingAt,
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      if (state.players[listener.ownerIndex].channeled.length > RENEKTON_MAX_RUNES) return state;
      const here = findUnitOnBattlefield(state, listener.card.instanceId);
      if (!here || state.battlefields[here.battlefieldIndex]!.id !== event.battlefieldId) return state;
      return dealDamageToEnemyUnitsAtBattlefield(state, listener.ownerIndex, event.battlefieldId, RENEKTON_DAMAGE);
    },
  },
  "VEN-020": {
    // Twilight Reveler — "When I attack, ready ANOTHER friendly unit."
    //
    // **"Another" is the whole card**: he must not ready himself, and he is
    // exhausted at exactly the moment this fires, since attacking is what
    // exhausted him. A version without the self-exclusion would be a unit that
    // untaps itself every combat, which is a different and much better card.
    //
    // The exclusion is by instanceId rather than by defId — two copies of him on
    // the board may ready EACH OTHER, which is what "another" says.
    //
    // "FRIENDLY unit", anywhere: no location is printed, so 355.9.a.1's widening
    // applies and a unit sitting in base is a legal choice. It is often the right
    // one, since readying a base unit is what lets it be sent in.
    //
    // The target is auto-selected in `listeningPermanents` board order — base,
    // then battlefields, then gear — which is the simplification every
    // auto-targeting attack trigger in this pool makes, and for the same
    // structural reason: nothing carries a choice made inside a Cleanup. Recorded
    // Unverified in docs/rules-conformance.md with the rest of that family.
    //
    // Only an EXHAUSTED unit is a candidate. `readyUnit` no-ops on a ready one,
    // so picking one would spend the trigger on nothing — and unlike Perfect
    // Execution above there is no second instruction to make it worth doing.
    on: "combatBegan",
    applies: isAttackingAt,
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      const candidate = ownUnitsEverywhere(state, listener.ownerIndex).find(
        (u) => u.instanceId !== listener.card.instanceId && u.exhausted,
      );
      return candidate ? readyUnit(state, candidate.instanceId) : state;
    },
  },
  "VEN-016": {
    // Eclipse Dragon — "[Accelerate] When I move, if you control 4 or fewer
    // runes, draw 1."
    //
    // The board-wide `unitMoved` EVENT rather than unit-triggers.ts's per-card
    // `ON_MOVE_TRIGGERS` table, which is module-private and not this file's to
    // edit — the route Jhin - Murderous Artist (UNL-022, below) takes, and the
    // reason `applies` is what keeps this off every other unit's move.
    //
    // **"When I MOVE" reaches all three emitters**: `execute-move-unit`,
    // `execute-recall-unit` (a unit walking home is a Move, 446.1) and
    // `effect-helpers`' force-moves (449 — "spells, abilities, or other effects
    // may cause a Move to occur"). So an enemy Blast Cone shoving him pays HIM,
    // which is right: the card says "when I move", not "when you move me". A
    // Recall is still not a Move (456) and pays nothing.
    //
    // **`to` is NOT always a battlefield**, and this card is deliberately one of
    // the ones that does not care — it prints no destination, so a walk home
    // counts. Mister Root and Corina Veraza were both caught paying out for a
    // walk home when the event widened; they print "move to a battlefield" and
    // this does not.
    //
    // The rune ceiling is Renekton's (VEN-019, above) and is read at RESOLUTION,
    // not when the trigger was held: a rune spent in the response window is a
    // rune no longer controlled, and the condition is on the instruction.
    on: "unitMoved",
    applies: (_state, listener, event) =>
      event.kind === "unitMoved" && event.unitInstanceId === listener.card.instanceId,
    resolve: (state, listener, event) => {
      if (event.kind !== "unitMoved" || event.unitInstanceId !== listener.card.instanceId) return state;
      if (state.players[listener.ownerIndex].channeled.length > ECLIPSE_DRAGON_MAX_RUNES) return state;
      return drawCards(state, listener.ownerIndex, ECLIPSE_DRAGON_DRAW);
    },
  },
  "VEN-002": {
    // Blade Twirler — "The FIRST TIME I move each turn, choose a player. They
    // [Burn 1]."
    //
    // # "The first time ... each turn" is read off the event, not counted here
    //
    // `unitMoved.movesThisTurn` is the mover's count AFTER this move, which makes
    // the condition exactly `=== 1`. Yasuo - Windrider's "the third time I move
    // in a turn" reads the same field, and its comment says why the field exists
    // rather than the listener re-deriving it: by resolution the count has moved
    // on, and every listener would see the same final number.
    //
    // So there is no per-card counter and nothing to clear at end of turn — the
    // one shape of this card that could rot.
    //
    // # "Choose a PLAYER", which is a real question at 1v1
    //
    // Bewitching Spirit (UNL-121, effects/chaos.ts) draws this exact distinction:
    // "a player" reaches EITHER seat, where "an opponent" reduces to no choice in
    // a two-player game. Burning your own top card is a live line — it is how you
    // fill a trash for Consuming Curse or a `[Flow]` cost — so the offer is real
    // and hard-coding the opponent would be reading a different card's text.
    //
    // No decline: the sentence carries no "you may". The OPPONENT leads, the
    // convention every such offer in this pool follows so a mis-click and the
    // AI's tie-break land on the ordinary answer.
    //
    // # And the move itself is the same event every other mover reads
    //
    // All three emitters, a walk home included (449/446.1); a Recall is not a
    // Move (456) and never fires it. See Eclipse Dragon above.
    on: "unitMoved",
    applies: (_state, listener, event) =>
      event.kind === "unitMoved" &&
      event.unitInstanceId === listener.card.instanceId &&
      event.movesThisTurn === BLADE_TWIRLER_NTH_MOVE,
    resolve: (state, listener, event) => {
      if (event.kind !== "unitMoved" || event.unitInstanceId !== listener.card.instanceId) return state;
      // Re-checked at resolution as well as in `applies`, for the reason Jhin's
      // entry records: the inline `dispatchEvent` path does not consult `applies`
      // at all, so a condition asserted only there is asserted only on one of the
      // two routes into this resolver.
      if (event.movesThisTurn !== BLADE_TWIRLER_NTH_MOVE) return state;
      return parkDecision(state, { kind: BLADE_TWIRLER_BURN, playerIndex: listener.ownerIndex });
    },
  },
  "SFD-024": {
    // Rell - Magnetic — "[Tank] When I attack, you may play an Equipment with
    // Energy cost no more than [2] from hand, ignoring its cost. If you do, then
    // do this: Attach it to me."
    //
    // The moment is `combatBegan` with `isAttackingAt`, the shared adapter every
    // "when I attack" card in this pool uses — so Rell and Yasuo cannot come to
    // different answers about who is attacking. The designation is fixed when the
    // combat opens (383), so it is asked in `applies` and never re-asked: moving
    // her away during the response window must not cancel a trigger that has
    // already fired.
    //
    // A parked DECISION rather than auto-selection, unlike the on-attack damage
    // cards beside it: "you MAY" with a filtered list is a question, and which
    // Equipment you commit is a real choice. With no eligible Equipment the offer
    // is dropped whole rather than shown as a lone Decline — the same call every
    // other optional offer here makes, and the one that keeps `advanceDecisions`
    // from auto-resolving a question with a single option.
    on: "combatBegan",
    applies: isAttackingAt,
    resolve: (state, listener) => {
      if (listener.card.kind !== "Unit") return state;
      if (rellEquipCandidates(state, listener.ownerIndex).length === 0) return state;
      // Rell's own instance rides the decision, because "attach it to ME" means
      // the body that attacked — not whichever Rell is on the board when the
      // answer arrives.
      return parkDecision(state, {
        kind: "SFD-024-equip",
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
      });
    },
  },
  "SFD-016": {
    // Recurve Bow — "When I attack or defend, deal 2 to an enemy unit here."
    // **ART-ONLY ABILITY.** None of this is in the card data — `text.plain` holds
    // the `[Equip]` line and nothing else, which is why this card reported
    // IMPLEMENTED while doing none of it. Transcribed from the card image; see
    // docs/sfd-equipment-abilities.md.
    //
    // "I" is the WEARER. `wearerListener` rewrites this gear's listener as the
    // unit wearing it, so every existing predicate applies unchanged.
    // `isFightingAt` is Ahri - Inquisitive's predicate and requires
    // `listener.card.kind === "Unit"` — precisely why a raw Gear listener could
    // never satisfy it, and why the rewrite is the whole mechanism.
    on: "combatBegan",
    applies: (state, listener, event) => {
      const wearer = wearerListener(state, listener);
      return wearer !== undefined && isFightingAt(state, wearer, event);
    },
    //
    // **"HERE" is the battlefield the COMBAT is at, and it is re-checked against
    // where the wearer is standing when the question is answered** — see the
    // `SFD-016-shot` entry below, which is the one and only place that check
    // lives. It is not repeated here: `parkDecision` builds the options
    // immediately, so a wearer who has already left makes the question moot at
    // this instant too, and a second copy of the test would be unfalsifiable
    // (measured — mutating it out failed nothing).
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      const wearer = wearerListener(state, listener);
      if (wearer?.battlefieldId === undefined) return state;
      // "AN enemy unit" is a CHOICE, so this parks a decision rather than
      // auto-selecting in board order the way Yasuo and Teemo do. That inherits
      // only the divergence rules-conformance already records for every held
      // trigger — the choice happens at resolution rather than at finalization
      // (402) — instead of adding auto-selection as a second one. A lone
      // candidate auto-resolves without prompting.
      //
      // The WEARER rides along so the question can re-ask "here" when it is
      // answered: the id is the unit that fought, fixed now, so a Bow re-attached
      // to somebody else in the meantime does not change whose location is read.
      return enemiesAt(state, wearer.ownerIndex, event.battlefieldId).length === 0
        ? state
        : parkDecision(state, {
            kind: "SFD-016-shot",
            playerIndex: wearer.ownerIndex,
            cardInstanceId: wearer.card.instanceId,
            battlefieldId: event.battlefieldId,
          });
    },
  },
  "OGN-034": {
    // Tryndamere - Barbarian — "When I conquer AFTER AN ATTACK, if you assigned
    // 5 or more EXCESS damage to enemy units, you score 1 point."
    //
    // Three separate conditions, and each one is a different kind of check:
    //  - **"When I conquer"** is positional, like Vayne's and Qiyana's — he has
    //    to be standing at the battlefield that was taken.
    //  - **"AFTER AN ATTACK"** is what `lastShowdownExcessDamage` carries a
    //    battlefield and an attacking side for. A conquest by walking into an
    //    empty battlefield never wrote it, and a conquest at a different
    //    battlefield does not match it, so neither can borrow another fight's
    //    number.
    //  - **"5 or more excess damage"** is a term the rules never define — see
    //    `combat.excessAssigned`, where all three candidate readings coincide.
    //
    // The point is a plain `points + 1`, deliberately NOT routed through
    // `recordConquest`: rule 471.1.b's Final Point restriction applies to a point
    // gained by CONQUERING, and this is a separate payout that happens to be
    // triggered by one. Same call, and the same reasoning, as Yasuo - Windrider.
    on: "battlefieldConquered",
    // Asked in `applies` as well as in `resolve`, because the event is HELD: the
    // response window this opens must not be usable to move him off the
    // battlefield and cancel a trigger that already fired.
    applies: (state, listener, event) => tryndamereQualifies(state, listener, event),
    resolve: (state, listener, event) => {
      if (!tryndamereQualifies(state, listener, event)) return state;
      // Through `gainPoints`, the single choke point every point-gain goes
      // through so Tianna Crownguard's "opponents can't gain points" reaches it.
      return gainPoints(state, listener.ownerIndex, 1);
    },
  },
  "OGN-035": {
    // Vayne - Hunter — "[Assault 3] If an opponent controls a battlefield, I
    // enter ready. When I conquer, you may pay [1 Energy] to return me to my
    // owner's hand."
    //
    // Her enter-ready clause is a board condition and lives in deploy.ts with the
    // other overrides; only the conquer half is here.
    //
    // "When I CONQUER" is positional — she has to be AT the battlefield taken,
    // the same reading Adaptatron and Kai'Sa - Evolutionary take. Asked in
    // `applies` so the window this hold opens cannot be used to move her off it
    // and cancel a trigger that already fired.
    //
    // The card is a tempo loop: take a battlefield, buy her back, replay her for
    // her [Assault 3] body again. Nothing is asked when the Energy cannot be
    // paid — 416.3.
    on: "battlefieldConquered",
    applies: (state, listener, event) =>
      event.kind === "battlefieldConquered" &&
      event.conquerorIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId &&
      payEnergyFromPool(state, listener.ownerIndex, 1) !== undefined,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldConquered") return state;
      if (payEnergyFromPool(state, listener.ownerIndex, 1) === undefined) return state;
      return parkDecision(state, {
        kind: "OGN-035-return",
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
      });
    },
  },
  "OGN-037": {
    // Immortal Phoenix — "[Assault 2] When you kill a unit with a spell, you may
    // pay [1 Energy][1 Fury] to play me from your trash."
    //
    // The pool's first TRASH listener: `allListeningPermanents` now walks a small
    // named set of trash cards alongside the board, because a card that says
    // "from your trash" is watching from somewhere no permanent walk reaches.
    //
    // "WITH A SPELL" is `unitKilledBySpell`, the one event about HOW a death
    // happened. Combat damage and activated abilities never fire it, which is the
    // distinction the card draws and the reason it could not just watch a death.
    //
    // "You MAY pay" — a real cost, so it parks a question rather than firing, and
    // it is not asked at all when the cost cannot be met (416.3: a cost that
    // cannot be completed is not one you may choose to pay). That is also what
    // stops the question appearing every time a spell kills anything.
    on: "unitKilledBySpell",
    applies: (state, listener, event) =>
      event.kind === "unitKilledBySpell" &&
      event.killerIndex === listener.ownerIndex &&
      listener.zone === "trash" &&
      canPayPhoenix(state, listener.ownerIndex),
    resolve: (state, listener, event) => {
      if (event.kind !== "unitKilledBySpell") return state;
      // Re-asked here as well as in `applies`, and deliberately: the response
      // window this hold opens is exactly when the runes could be spent on
      // something else, and paying is a cost rather than a trigger condition.
      if (!canPayPhoenix(state, listener.ownerIndex)) return state;
      return parkDecision(state, {
        kind: "OGN-037-return",
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
      });
    },
  },
  "OGN-027": {
    // Darius - Trifarian — "When you play your SECOND card in a turn, give me
    // +2 Might this turn and ready me."
    //
    // Exactly the second, not the second-or-later: `cardsPlayedThisTurn === 2`
    // rather than `>= 2`, so a third and fourth card pay nothing. The counter is
    // incremented before this event fires (see legionActive's note), so the
    // second card is 2 here and not 1.
    //
    // "YOU play" — his own controller; the opponent's second card is not his.
    on: "cardPlayed",
    // **The count is asked HERE and deliberately NOT re-asked in `resolve`.**
    //
    // "Your SECOND card in a turn" is a fact about the moment the card was
    // played, and `cardsPlayedThisTurn` keeps moving afterwards. Now that
    // `cardPlayed` is held as a Chain Pending Item, holding opens a real response
    // window before this resolves — and anything either player casts into that
    // window makes the counter 3, so a `resolve` that re-checked `!== 2` would
    // refuse a trigger that had genuinely fired. 383 fixes what triggered at the
    // moment of the event; this is exactly the condition that proves it.
    applies: (state, listener, event) =>
      event.kind === "cardPlayed" &&
      // **185: "Tokens are not cards."** This sentence says CARD, so a token
      // played by its owner is not one — 185.1.a makes that nature permanent, and
      // 350.2 keeps "can still be Played" and "is a card" apart. Added 2026-08-10
      // with the token `cardPlayed` event; before it, nothing fired for a token at
      // all and this listener was accidentally correct.
      //
      // Doubly so for this card: `cardsPlayedThisTurn` counts CARDS and a token
      // never increments it, so without this gate his `=== 2` would be asked on
      // a token play whose count had not moved — firing him on the wrong card.
      !event.isToken &&
      event.casterIndex === listener.ownerIndex &&
      state.players[listener.ownerIndex].cardsPlayedThisTurn === 2,
    resolve: (state, listener, event) => {
      if (event.kind !== "cardPlayed") return state;
      if (event.casterIndex !== listener.ownerIndex) return state;
      const pumped = giveMightThisTurnToOwnUnit(state, listener.ownerIndex, listener.card.instanceId, 2);
      return readyUnit(pumped, listener.card.instanceId);
    },
  },
  "OGN-039": {
    // Kai'Sa - Survivor — "[Accelerate] ... When I conquer, draw 1."
    //
    // "When *I* conquer" — she has to be AT the conquered battlefield, which is
    // what separates her from a "when you conquer" card like Garen's Legend.
    // Checked against the listener's own location rather than the event alone,
    // since the listener walk reaches her wherever she stands.
    //
    // The [Accelerate] on her frame is a cost keyword handled at play time
    // (805); it does not gate this trigger, which is why nothing here reads it.
    on: "battlefieldConquered",
    // `battlefieldConquered` is held as a Chain Pending Item (383), so both
    // conditions have to be asked BEFORE the trigger goes on the chain — holding
    // one for a conquest elsewhere, or for the opponent's, would cost both
    // players a PassFocus for an ability that resolves to nothing.
    //
    // The location check is not repeated in `resolve`: 383 fixes what triggered
    // at the moment of the event, and the window the hold opens is exactly when
    // she could be moved off it.
    applies: (_state, listener, event) =>
      event.kind === "battlefieldConquered" &&
      event.conquerorIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldConquered") return state;
      if (event.conquerorIndex !== listener.ownerIndex) return state;
      return drawCards(state, listener.ownerIndex, 1);
    },
  },
  "SFD-028": {
    // Lucian - Gunslinger — "[Assault] When I attack, deal damage equal to MY
    // [Assault] to an enemy unit HERE."
    //
    // Registered as a `combatBegan` listener here rather than added to
    // unit-triggers.ts's ATTACK_TRIGGERS table, which is the same family: that
    // table is a shared file, and `isAttackingAt` — the one filter every card in
    // it needs — is exported precisely so a per-domain file can take the same
    // shape without editing it. `attackEventTriggers` registers those eight under
    // their own defIds, so there is no collision to have.
    //
    // **The damage READS the keyword rather than hardcoding its printed 1.** That
    // is the card: "damage equal to my [Assault]" is a number that moves, and
    // `effectiveKeywords` is what sees it move — Cleave's `[Assault 3]` grant, or
    // a battlefield's, raises the shot to 3. A literal `1` would have been right
    // on an empty board and quietly wrong on every board where the card is doing
    // its job.
    //
    // Zero Assault deals NOTHING rather than 0: an instance of 0 damage is still
    // an instance of damage, and would fire the damage-triggered abilities in
    // this pool. Unreachable today (his 1 is printed) and cheap to be right about.
    //
    // **"HERE" is RE-CHECKED against where he is standing at resolution**, and the
    // battlefield the combat is at is only the value it is compared to. That is a
    // different question from whether he triggered, and a different rule settles
    // it: 383 fixes the trigger at the moment of the event, but "here" is a
    // REFERENT read from the ability's source (359.3.f.1) and a referent is
    // checked on EXECUTION of the instruction (359.3.f.2) — whose worked example
    // is precisely this window, an opponent playing Fight or Flight on Yasuo -
    // Remorseful's attack trigger so that "'here' is no longer the battlefield
    // where combat is ongoing and the attack trigger mistargets". So a Lucian
    // moved away (or killed) shoots nothing; the Pending Item was still placed and
    // still cost both players a PassFocus. Sinister Poro (UNL-137,
    // effects/chaos.ts) is the convention, and Recurve Bow above matches it.
    //
    // The TARGET is auto-selected in board order, the same simplification every
    // other attack trigger in this pool makes and for the same structural reason:
    // nothing carries a choice made inside a Cleanup. Recorded Unverified in
    // docs/rules-conformance.md with the rest of that family.
    on: "combatBegan",
    applies: isAttackingAt,
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      if (listener.card.kind !== "Unit") return state;
      const here = findUnitOnBattlefield(state, listener.card.instanceId);
      if (!here || state.battlefields[here.battlefieldIndex]!.id !== event.battlefieldId) return state;
      const assault = effectiveKeywords(state, listener.card, listener.ownerIndex).Assault ?? 0;
      if (assault <= 0) return state;
      const targetId = firstEnemyAt(state, listener.ownerIndex, event.battlefieldId, listener.card.instanceId);
      return targetId ? dealDamage(state, listener.ownerIndex, targetId, assault) : state;
    },
  },
  "SFD-020": {
    // Draven - Vanquisher, SECOND clause only — "When I attack or defend, you may
    // pay [1 Fury]. If you do, give me +2 Might this turn."
    //
    // **WHOLE as of 2026-08-05.** The first clause — "When I win a combat, play
    // a Gold gear token exhausted" — was blocked on THREE things, and each was
    // closed separately: gear tokens (`placeGoldTokens`), a combat-WON event
    // (466.3.a, fired by combat.ts at both resolution shapes), and
    // `EventTriggerDefinition.on` accepting a list, since this registry is keyed
    // by defId and he already had a `combatBegan` trigger.
    //
    // A conquest is still NOT a substitute for the win, which is why the event
    // exists: a walk-in conquers without a combat, and a combat can be won at a
    // battlefield its winner already controlled.
    //
    // "Attack OR DEFEND" is `isFightingAt` — Ahri - Inquisitive's predicate, which
    // exists so the cards that deliberately ignore the designation say so in a
    // name rather than by an `||` at the call site.
    //
    // "You MAY pay" is a real cost, so this parks a question instead of firing,
    // and it is not asked at all when the Fury cannot be paid (416.3: a cost that
    // cannot be completed is not one you may choose to pay). Asked in `applies`
    // so an unaffordable board places no Pending Item — a held trigger that
    // resolves to nothing still costs both players a PassFocus, and this one would
    // otherwise fire at every single combat he is in.
    on: ["combatBegan", "combatWon"],
    applies: (state, listener, event) =>
      event.kind === "combatWon"
        ? // "I win a combat" — my controller won, and I am standing where it
          // happened. Surviving needs no separate check: a unit that died is
          // not a listener, because the walk only finds permanents in play.
          // Unconditional, unlike the pump below — the token costs nothing.
          event.winnerIndex === listener.ownerIndex && listener.battlefieldId === event.battlefieldId
        : isFightingAt(state, listener, event) &&
          payPowerFromChanneled(state, listener.ownerIndex, "Fury", 1) !== undefined,
    resolve: (state, listener, event) => {
      if (event.kind === "combatWon") return placeGoldTokens(state, listener.ownerIndex, 1);
      if (event.kind !== "combatBegan") return state;
      // Re-asked here as well as in `applies`, for the reason Immortal Phoenix
      // records: the window the hold opens is exactly when that Fury could be
      // spent on something else, and paying is a cost rather than a condition.
      if (payPowerFromChanneled(state, listener.ownerIndex, "Fury", 1) === undefined) return state;
      return parkDecision(state, {
        kind: "SFD-020-pump",
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
      });
    },
  },
  "SFD-027": {
    // Dunebreaker, the "When I hold, draw 2" half — "When I hold, draw 2."
    //
    // **WHOLE as of 2026-08-05.** His other clause — "if you have two or fewer
    // cards in your hand, I enter ready" — is a conditional enter-ready and lives
    // with Leona - Zealot's and Vayne - Hunter's in `deploy.unitEntersReady`,
    // which is where every board-conditional arrival belongs; it landed there and
    // this card's coverage.PARTIALLY_IMPLEMENTED entry is gone with it. This
    // comment used to claim the clause was unwritten, which stopped being true
    // without anything failing — the reason the claim is dated.
    //
    // "When **I** hold" is positional, the same reading Ahri - Alluring and
    // Blitzcrank - Impassive take: the battlefield scored has to be the one he is
    // standing at. A hold is 469.2's SCORING moment rather than mere presence,
    // so a battlefield already conquered this turn fires nothing (471.1.b).
    //
    // Both conditions settle in `applies` because the event is held, and the
    // window it opens is precisely when he could be moved or killed — 383 fixes
    // what triggered at the moment of the event.
    on: "battlefieldHeld",
    applies: (_state, listener, event) =>
      event.kind === "battlefieldHeld" && event.holderIndex === listener.ownerIndex && listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => (event.kind === "battlefieldHeld" ? drawCards(state, listener.ownerIndex, 2) : state),
  },
  "SFD-026": {
    // Rumble - Hotheaded, SECOND clause only — "When I conquer, you may recycle
    // another friendly unit to play a Mech from your trash. Reduce its Energy
    // cost by the Might of the unit you recycled."
    //
    // **His FIRST clause is NOT implemented.** "Your Mechs each have [Assault]"
    // is a keyword AURA, and every aura in this engine lives in one table in
    // granted-keywords.ts — a shared file this one may not edit. Nothing here
    // grants [Assault] to anything and no test asserts that it does. Recorded for
    // coverage.PARTIALLY_IMPLEMENTED, the same way Dunebreaker's missing
    // enter-ready clause is one entry up.
    //
    // "When I CONQUER" is positional — the reading Kai'Sa - Survivor and Vayne -
    // Hunter take, and he has to be standing at the battlefield taken. Settled in
    // `applies` because the event is held (383) and the window a hold opens is
    // exactly when he could be moved off it.
    //
    // "Recycle another friendly unit TO play a Mech" is a COST INSIDE an
    // instruction, and the rules name this exact shape: 355.10.c.1's "costs
    // within instructions, identified by phrases like '[do X] to [do Y]'. The
    // cost within that instruction is '[do X]'" — so the recycled unit is not a
    // target and is chosen as part of paying. The Mech *is* a target (355.10.a.1
    // lists a Trash among the Public zones), but this is a TRIGGERED ability, so 355.5.b
    // puts both choices at the moment the trigger is finalized rather than when
    // anything was played — which is why this is a decision and not a
    // TargetingSpec.
    //
    // ONE question over PAIRS rather than two chained ones, and that is the
    // card's own shape: the price depends on both halves at once, so "recycle
    // Pantheon (3 Might) to play Mega-Mech for 4 Energy" is the choice actually
    // being made. Splitting it would ask for the fodder before the player could
    // see what it buys, and would need the Might to survive between two
    // questions — PendingDecision has no field for a number that is not a repeat
    // count, and borrowing `count` for it would be a second meaning on one field.
    //
    // Nothing is asked when no pair can be paid for — 416.3, and the same reason
    // Draven's pump and Immortal Phoenix's return are gated in `applies`: a held
    // trigger that resolves to nothing still costs both players a PassFocus, and
    // this one would otherwise fire at every conquest he is standing at.
    on: "battlefieldConquered",
    applies: (state, listener, event) =>
      event.kind === "battlefieldConquered" &&
      event.conquerorIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId &&
      rumbleTrades(state, listener.ownerIndex, listener.card.instanceId).length > 0,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldConquered") return state;
      // Re-asked here as well as in `applies`, for the reason Immortal Phoenix
      // records: the response window the hold opens is exactly when the runes
      // could be spent elsewhere or the last Mech pulled out of the trash, and
      // paying is a cost rather than a trigger condition.
      if (rumbleTrades(state, listener.ownerIndex, listener.card.instanceId).length === 0) return state;
      return parkDecision(state, {
        kind: "SFD-026-scrap",
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
      });
    },
  },
  "UNL-027": {
    // Inviolus Vox — "When I conquer, give a friendly unit +8 Might this turn."
    //
    // "When **I** conquer" is Kai'Sa - Survivor's (OGN-039, two entries up)
    // reading exactly: he has to be standing AT the battlefield taken, which is
    // what separates a unit's conquer trigger from a Legend's "when YOU conquer".
    // Both conditions settle in `applies` because `battlefieldConquered` is a
    // Chain Pending Item — holding one for somebody else's conquest costs both
    // players a PassFocus for an ability that resolves to nothing — and the
    // location is deliberately NOT re-asked in `resolve`, since the window the
    // hold opens is precisely when an opponent would push him sideways (383 fixes
    // what triggered at the moment of the event).
    //
    // A parked DECISION rather than an auto-selected target: "a friendly unit"
    // with +8 on the line is a real choice, and unlike the attack triggers in this
    // file there IS a mechanism to carry it — the conquest is a held event, so the
    // question outlives the moment. Ribbon Dancer's `SFD-038-might` is the same
    // shape and the pattern this follows.
    on: "battlefieldConquered",
    applies: (state, listener, event) =>
      event.kind === "battlefieldConquered" &&
      event.conquerorIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId &&
      // No "you may", so the Might has to land somewhere — but with nothing of
      // his controller's left on the board there is nothing to land on, and a
      // Pending Item that can only resolve to nothing is not worth a response
      // window. He is normally his own candidate, so this is the dead-Vox case.
      ownUnitsEverywhere(state, listener.ownerIndex).length > 0,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldConquered") return state;
      if (event.conquerorIndex !== listener.ownerIndex) return state;
      return parkDecision(state, { kind: "UNL-027-might", playerIndex: listener.ownerIndex });
    },
  },
  "UNL-011": {
    // Fresh Beans — "When you play a unit during a showdown, you may exhaust this
    // to draw 1."
    //
    // Three separate conditions, and all three are properties of the MOMENT the
    // unit was played, so all three live in `applies`: `cardPlayed` is held, and
    // the response window it opens can end the Showdown, exhaust the gear or hand
    // the initiative to the opponent before this resolves. Darius - Trifarian's
    // "your SECOND card in a turn" is the precedent — a condition about the moment
    // is asked once, at the moment.
    //
    // "During a SHOWDOWN" is `state.turnState`, the same question `mayPlayCardNow`
    // asks for the Action tier. It is the whole reason this card is not simply
    // "when you play a unit": the only units that can be played inside a Showdown
    // are `[Reaction]` ones and cards played from facedown (811), so the trigger
    // is narrow by construction.
    //
    // "YOU play" — its own controller's unit. An opponent reinforcing the fight is
    // not what pays for the coffee.
    //
    // The exhaust is a COST, so an already-exhausted Fresh Beans is not asked at
    // all (416.3: a cost that cannot be completed is not one you may choose to
    // pay) — and the payload is Solari Shrine's (`OGN-072-draw`) verbatim.
    on: "cardPlayed",
    applies: (state, listener, event) =>
      event.kind === "cardPlayed" &&
      event.casterIndex === listener.ownerIndex &&
      event.playedKind === "Unit" &&
      state.turnState === "Showdown" &&
      listener.card.kind === "Gear" &&
      !listener.card.exhausted,
    resolve: (state, listener, event) => {
      if (event.kind !== "cardPlayed") return state;
      // Re-asked because paying is a cost rather than a trigger condition — the
      // same split Draven - Vanquisher and Immortal Phoenix record. Something in
      // the response window may have spent the gear's exhaust on an unrelated
      // ability, and a question that cannot be paid for must not be shown.
      if (listener.card.kind !== "Gear" || listener.card.exhausted) return state;
      return parkDecision(state, {
        kind: "UNL-011-draw",
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
      });
    },
  },
  "UNL-023": {
    // Katarina - Reckless — BOTH clauses: "When you hide a card, ready me. When
    // you play a card from face down, deal 2 to an enemy unit."
    //
    // **Her first clause landed 2026-08-13**, when `cardHidden` arrived. Wave 7
    // refused it on "no event exists — `execute-hide-card` fires only
    // `runesRecycled`", and that was the whole of the blocker: `executeHideCard`
    // is still the only place a card becomes facedown (421.1 defines Hiding as
    // exactly that act), so one `holdEventTrigger` there covers every hide there
    // can be. The `coverage.PARTIALLY_IMPLEMENTED` row for this defId is now owed
    // a RETIREMENT.
    //
    // # 811.1.c.2 opens no chain; this trigger still does
    //
    // "Hiding a card does not open a chain" (811.1.c.2) is about the HIDE, not
    // about what the hide sets off — a Triggered Ability goes on the Chain under
    // 383.3 whatever moment produced it, and `runesRecycled` has always been held
    // from this very same action handler for the same reason.
    //
    // # No `exhausted` gate, deliberately
    //
    // The neighbouring entries all narrow `applies` down to "a Pending Item that
    // can only resolve to nothing is not worth a response window", and a READY
    // Katarina looks like that case. It is not. 415.1.c makes readying an
    // already-ready unit a legal no-op ("nothing additional happens") rather than
    // an impossible instruction, so the trigger has genuinely fired; and the
    // window the hold opens is real time in which she can become exhausted (any
    // `[Reaction]` or exhaust-cost ability her controller uses), after which the
    // trigger must still ready her. Gating on her state at FIRE time would
    // silently swallow that, which is the stronger claim to be wrong about.
    // Rejected in favour of paying the occasional empty response window.
    //
    // # The second clause: "FROM FACE DOWN"
    //
    // Black Market Broker's condition exactly (SFD-121, effects/chaos.ts), and
    // written against the same carried fact — `cardPlayed.fromHidden`, which
    // `executePlayCard` sets from `action.fromHiddenBattlefieldId`. The rules
    // gloss the two spellings as one thing: "Playing a card from facedown (or
    // 'from Hidden')" (811.1.c.3).
    //
    // **The two clauses are two different moments and cannot be folded.** A hide
    // is not a play (811.1.c.1), and a facedown card is played on a LATER turn
    // (811.1.b), so nothing fires both. A single `on` list with a branch is what
    // this registry wants for a two-clause card — see `EventTriggerDefinition.on`,
    // which is a list precisely because the registry is keyed by defId and two
    // definitions would leave `resolvePendingTrigger` unable to say which half a
    // chain entry meant.
    //
    // "YOU play" — her own controller's facedown card. Her own arrival counts if
    // she was herself played from facedown, since the event fires after the card
    // has resolved into play and the listener walk therefore already finds her.
    //
    // "An ENEMY unit" with no battlefield named, so a unit sitting in the
    // opponent's BASE is a legal choice — 355.9.a.1's bare noun, the same reading
    // Gem Jammer's grant and Dangerous Duo's pump take. Contrast Mischievous Marai
    // (UNL-003), which prints "an enemy unit HERE" and means something narrower.
    on: ["cardHidden", "cardPlayed"],
    applies: (state, listener, event) => {
      // "When YOU hide a card" — her own controller's hide. `cardHidden.ownerIndex`
      // is the hider, which for this action is also the card's owner: 811.1.b lets
      // you hide only from your OWN hand or Champion Zone, so the two cannot come
      // apart the way `cardsRecycled`'s owner and actor can.
      if (event.kind === "cardHidden") return event.ownerIndex === listener.ownerIndex;
      return (
        event.kind === "cardPlayed" &&
        event.fromHidden === true &&
        event.casterIndex === listener.ownerIndex &&
        // Nothing to shoot is nothing to ask. Unlike a cost this is not 416.3 — it
        // is the same "a Pending Item that can only resolve to nothing is not worth
        // a response window" call Rumble's trade and Rell's equip both make.
        ownUnitsEverywhere(state, listener.ownerIndex === 0 ? 1 : 0).length > 0
      );
    },
    resolve: (state, listener, event) => {
      if (event.kind === "cardHidden") {
        if (event.ownerIndex !== listener.ownerIndex) return state;
        // "Ready ME" — her own body, found wherever she stands. `readyUnit` is
        // the whole instruction: it enforces 415.1.c's no-op on an already-ready
        // unit and raises `unitReadied` for anything watching, which an inline
        // `exhausted: false` here would have skipped.
        return readyUnit(state, listener.card.instanceId);
      }
      if (event.kind !== "cardPlayed") return state;
      if (event.fromHidden !== true) return state;
      if (event.casterIndex !== listener.ownerIndex) return state;
      return parkDecision(state, { kind: "UNL-023-shot", playerIndex: listener.ownerIndex });
    },
  },
  "UNL-018": {
    // Yeti Brawler — "When I conquer, if you assigned 3 or more excess damage,
    // play two Gold gear tokens exhausted."
    //
    // Tryndamere - Barbarian's condition (OGN-034, above) with a smaller
    // threshold and a different payout, so it reads the same three facts through
    // the same record and `yetiQualifies` mirrors `tryndamereQualifies`.
    //
    // **He prints no "after an attack" and still gets one**, which is worth
    // stating rather than leaving to look like an omission: "you assigned excess
    // damage" can only be true of a combat, and `lastShowdownExcessDamage` carries
    // the battlefield and the attacking side — so matching both is what stops a
    // walk-in conquest (which never wrote the record) or a conquest at the other
    // battlefield from borrowing a fight's number. Requiring the match is the
    // card's own sentence, not Tryndamere's extra clause smuggled in.
    //
    // "3 or more excess damage" is a term the rules never define — `pdftotext
    // -raw` finds no "excess damage" in the PDF at all — and combat.ts's
    // `excessAssigned` records why all three candidate readings coincide here.
    //
    // Both TOKENS, not one: "play TWO Gold gear tokens" is a count, and
    // `placeGoldTokens` mints one game object per iteration. They arrive
    // EXHAUSTED, which that helper already does unconditionally (the printed
    // "[Reaction][>] Kill this, exhaust: [Add] rainbow" is the Gold token's own
    // text and lives with the token, not here).
    on: "battlefieldConquered",
    // Asked in `applies` as well as in `resolve`, exactly as Tryndamere and Sivir -
    // Ambitious are: the event is HELD, so the response window it opens must not be
    // usable to move him off the battlefield and cancel a trigger that already
    // fired. Re-asking in `resolve` is safe for the excess figure specifically —
    // only a combat's damage step writes it and a combat cannot open mid-chain.
    applies: (state, listener, event) => yetiQualifies(state, listener, event),
    resolve: (state, listener, event) =>
      yetiQualifies(state, listener, event) ? placeGoldTokens(state, listener.ownerIndex, YETI_BRAWLER_TOKENS) : state,
  },
  "UNL-019": {
    // Blighted Battleaxe — "[Equip] [1][Fury]" plus the ART-ONLY band: "At the end
    // of your turn, if I didn't conquer this turn, unattach this and deal 4 to me."
    //
    // **None of the band is in the card data.** `text.plain` holds the `[Equip]`
    // line and nothing else, which is exactly why this card reported
    // `isCardImplemented = true` while doing none of it — the generated equip
    // ability registers the defId. Transcribed from the card image; see
    // docs/unl-equipment-abilities.md. The `[Equip]` cost and the +4 Might badge
    // are already handled (card-loader's EQUIP_MIGHT_BONUS); only the band is here.
    //
    // # "I"/"me" is the WEARER, "this" is the axe
    //
    // The sentence uses BOTH words, and they cannot be the same referent: a gear is
    // not a unit, so nothing can deal 4 to it (417 deals damage to units), while
    // "unattach this" can only mean the Equipment. Recurve Bow (SFD-016, above) is
    // the precedent and the mechanism — `wearerListener` rewrites this gear's
    // listener as the unit wearing it, so "when I conquer"-shaped questions can be
    // asked of a gear at all. An unattached Battleaxe has no "me" and does nothing.
    //
    // # "if I didn't conquer this turn" is POSITIONAL, and that is a divergence
    //
    // The engine records conquests per PLAYER (`conqueredBattlefieldsThisTurn`),
    // not per unit, so "did this unit conquer" is answered the way every "when I
    // conquer" trigger in this file answers it — is the wearer standing at a
    // battlefield its controller conquered this turn. Two cases differ from the
    // printed card and both are recorded for docs/rules-conformance.md: a wearer
    // that walked in AFTER the conquest reads as having conquered (the axe stays
    // put, which is the generous direction), and one that conquered and then moved
    // away reads as not having (the axe fires). Nothing on a `UnitInstance` marks
    // participation in a conquest, and adding one is a shared-file change.
    //
    // # Why the condition is captured at the MOMENT
    //
    // `endOfTurn` is held and `runEnd` clears `conqueredBattlefieldsThisTurn` with
    // the rest of the turn immediately after firing it, so this trigger resolves in
    // the NEXT player's Action phase against a board that no longer remembers.
    // Asked in `applies` — which `holdEventTrigger` runs before any of those resets
    // — the question is asked of the turn it is about. Re-asking in `resolve` would
    // read "didn't conquer" for every wearer, every turn. Targon's Peak's delayed
    // ability captures for exactly this reason.
    //
    // The WEARER is `capture`d for the same reason: by resolution the axe may have
    // been re-attached to somebody else, and the 4 belongs to the unit that was
    // wearing it when the turn ended.
    //
    // # Unattach FIRST, then deal 4 — printed order, and observable
    //
    // The badge is +4 and the damage is 4, so the order decides whether a small
    // wearer survives: detaching first drops its Might by 4 before the damage is
    // measured for lethality, and a 4-Might wearer therefore dies.
    //
    // Printed order, and the rules state it for the two cases they spell out —
    // 359.2.b for a Permanent ("execute all rules text on the card, from top to
    // bottom") and 359.3.d for a Spell. **Neither is literally a triggered
    // ability**, which the PDF never gives its own top-to-bottom sentence; the
    // order is taken from the print because there is nothing to take it from
    // instead, not because a rule was found saying so.
    on: "endOfTurn",
    applies: (state, listener, event) => {
      if (event.kind !== "endOfTurn") return false;
      // "YOUR turn" — the axe's controller's. `endOfTurn` fires once per turn for
      // whoever's is ending, and the event carries them because by resolution
      // `activePlayerIndex` has rotated.
      if (event.playerIndex !== listener.ownerIndex) return false;
      const wearer = wearerListener(state, listener);
      return wearer !== undefined && !wearerConqueredThisTurn(state, wearer);
    },
    capture: (state, listener) => wearerListener(state, listener)?.card.instanceId,
    resolve: (state, listener, event, captured) => {
      if (event.kind !== "endOfTurn") return state;
      // No wearer at fire time means the trigger should never have been placed;
      // a non-string capture is that case and is not re-derived here, because the
      // board at resolution is the wrong turn to ask.
      if (typeof captured !== "string") return state;
      const detached = detachEquipment(state, listener.ownerIndex, listener.card.instanceId);
      return dealDamage(detached, listener.ownerIndex, captured, BLIGHTED_BATTLEAXE_DAMAGE);
    },
  },
  "UNL-022": {
    // Jhin - Murderous Artist — "[Deflect] [Ganking] When I move, [Add] [1
    // Energy][rainbow]."
    //
    // Both keywords are the engine's and neither belongs here: `[Deflect]` is
    // priced by counter-spell.ts and `[Ganking]` is read by the move enumerator,
    // and both are absent from `coverage.UNIMPLEMENTED_KEYWORDS`. Only the [Add] is
    // this file's.
    //
    // Registered against the board-wide `unitMoved` EVENT rather than
    // unit-triggers.ts's per-card `ON_MOVE_TRIGGERS` table, which is module-private
    // and not this file's to edit — the same route Hwei - Brooding Painter
    // (UNL-080, effects/mind.ts) and Kato the Arm (SFD-112, effects/body.ts) take.
    //
    // **"When I move" reaches all three emitters now**, which it did not when those
    // two were written: `execute-move-unit`, `execute-recall-unit` (a unit walking
    // home is a Move, 446.1) and `effect-helpers`' force-moves (449, "spells,
    // abilities, or other effects may cause a Move to occur"). So [Ganking]'s
    // sideways step, the walk home and a Blast Cone shove all pay him. A Recall is
    // still NOT a Move (456) and is the one relocation that pays nothing — but note
    // that `execute-recall-unit`'s walk home fires this deliberately; the two are
    // different actions sharing a file.
    //
    // # What Adding is, and the one thing this gets wrong
    //
    // 429.1: "Adding is the action of putting resources into a player's Rune Pool."
    // The printed pips are one Energy and one RAINBOW rune, so they land in
    // `floatingEnergy` and `floatingRainbowPower` — the latter is its own pool
    // because rainbow matches every domain while `floatingPower` is keyed by one,
    // the split the Gold token and Malzahar's ritual already rest on. Both persist
    // until spent and are swept by `runEnd`.
    //
    // **DIVERGENCE, reported rather than worked around: this is HELD on the chain
    // like every other triggered ability, and 429.2 says it should not be.** "429.2.
    // Triggered and activated abilities that Add resources resolve as soon as they
    // are finalized", and 337.2 repeats it for the Chain Item. His reminder text
    // prints the consequence — "abilities that add resources can't be reacted to" —
    // and here they can: the hold opens a response window before the resources
    // arrive. Making it right needs `holdEventTrigger`/the Cleanup to know that a
    // definition resolves on finalization, which is a shared-file change to
    // triggers.ts. Pinned in test/unl-fury-wave4.test.ts by asserting the wrong
    // answer — that the resources are NOT there until the chain settles.
    //
    // `applies` is what keeps this off every other unit's move: every listener in
    // play is asked, so without it Jhin would pay out for the whole board.
    on: "unitMoved",
    applies: (_state, listener, event) =>
      event.kind === "unitMoved" && event.unitInstanceId === listener.card.instanceId,
    resolve: (state, listener, event) => {
      if (event.kind !== "unitMoved") return state;
      // Re-checked at resolution, not merely in `applies`: a response window sits
      // between the two, and the inline `dispatchEvent` path does not consult
      // `applies` at all.
      if (event.unitInstanceId !== listener.card.instanceId) return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      // The ability's CONTROLLER is paid — Jhin's, which is `listener.ownerIndex`.
      // `moverIndex` is the same player for a move he made himself and would be the
      // wrong seat the moment an opponent's spell shoves him, which 449 now makes a
      // real Move that fires this.
      const actor = players[listener.ownerIndex];
      players[listener.ownerIndex] = {
        ...actor,
        floatingEnergy: actor.floatingEnergy + JHIN_ADD_ENERGY,
        floatingRainbowPower: actor.floatingRainbowPower + JHIN_ADD_RAINBOW,
      };
      return { ...state, players };
    },
  },
  "UNL-029": {
    // Red Brambleback's THIRD clause — "When I conquer, [Buff] a friendly unit."
    //
    // # Two of the card's three clauses are elsewhere, and one is REFUSED
    //
    // `[Accelerate]` (805) is the engine's: `hasAccelerate` prices the optional
    // additional cost, `legal-actions` fans the paid variant out, and
    // `deploy.unitEntersReady` reads the flag. Nothing about it belongs here.
    //
    // **"Your conquer effects for conquering here trigger an additional time" is
    // NOT implemented.** It is a continuous effect on how OTHER cards' triggers
    // resolve, which is Karthus - Eternal's shape — triggers.ts counts him off the
    // board and carries a `times` on the chain entry, and `resolveHeldDeathknell`
    // runs the definition that many times. `holdEventTrigger` has no such
    // multiplier: it pushes exactly one entry per (listener, key), and the doubling
    // would also have to reach `holdBattlefieldTrigger`, since a battlefield's own
    // "when you conquer here" is a conquer effect for conquering here too. Both are
    // shared files this pass does not own. Blue Sentinel (UNL-087, effects/mind.ts)
    // refused the identical sentence about HOLDING for the identical reason, and
    // this card owes the same `PARTIALLY_IMPLEMENTED` row. Registration is per
    // defId, so the clause below alone makes him report DONE — pinned in
    // test/unl-fury-wave5.test.ts by asserting his own buff lands exactly ONCE.
    //
    // # "When I conquer" is positional
    //
    // Inviolus Vox's reading (UNL-027, just above) exactly: he must be standing AT
    // the battlefield taken, which is what separates a unit's conquer trigger from
    // a Legend's "when YOU conquer". Both conditions settle in `applies` because
    // `battlefieldConquered` is a Chain Pending Item (383) — holding one for
    // somebody else's conquest costs both players a PassFocus for nothing — and the
    // location is deliberately NOT re-asked in `resolve`, since the window the hold
    // opens is precisely when an opponent would push him sideways.
    //
    // # The buff is a parked DECISION
    //
    // "A friendly unit" with a real choice behind it and no "you may": Vox's and
    // Ivern's question, and the same mechanism. The conquest is a held event, so
    // the question outlives the moment. Already-buffed units stay ON offer —
    // 702.3.a makes a second buff a no-op rather than an illegal choice, which is
    // what `addBuff` implements and what Ivern's and Spirit's Refuge's options
    // both record.
    on: "battlefieldConquered",
    applies: (state, listener, event) =>
      event.kind === "battlefieldConquered" &&
      event.conquerorIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId &&
      // No "you may", so the buff has to land somewhere — but with nothing of his
      // controller's left on the board there is nothing to land on, and a Pending
      // Item that can only resolve to nothing is not worth a response window. He is
      // normally his own candidate, so this is the dead-Brambleback case.
      ownUnitsEverywhere(state, listener.ownerIndex).length > 0,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldConquered") return state;
      if (event.conquerorIndex !== listener.ownerIndex) return state;
      return parkDecision(state, { kind: "UNL-029-buff", playerIndex: listener.ownerIndex });
    },
  },
  "UNL-005": {
    // Revna the Lorekeeper — "[Ganking] When you play a spell, if you spent [4]
    // or more, ready me."
    //
    // **Written 2026-08-13 off `SpellChainEntry.energySpent`.** Wave 7 refused her
    // and the refusal was exactly right about both wrong answers available at the
    // time, which is why they are restated rather than left to be re-derived:
    //
    //  - `spellCast.totalCost` is the PRINTED Energy PLUS Power (see the event's
    //    own comment — it is what Lux's "costs 5 or more" reads). A 2-Energy /
    //    2-Power spell reads 4 there while spending 2 Energy, and a discounted
    //    5-Energy spell reads 5 while spending 1. Neither figure is "you spent".
    //  - `maxSpellEnergySpentThisTurn` is a turn MAXIMUM, so a [1] spell cast after
    //    a [4] one would satisfy it having spent nothing like [4].
    //
    // Both fire on turns the card does not describe, which is the direction a
    // partial must never take. `energySpent` is recorded per chain entry at play
    // time (`executePlayCard`) and forwarded onto the event by `executePassFocus`,
    // so it is this spell's own price after every discount.
    //
    // # Energy ONLY, and undefined reads as none
    //
    // The pip is `:rb_energy_4:`, so Power paid alongside is not part of the
    // threshold — the same distinction `totalCost` exists to blur for Lux and this
    // card exists not to. `energySpent` is optional because a spell can reach the
    // chain by a path that never priced it (`playCardIgnoringCost`); a missing
    // figure is read as 0 rather than as a fabricated match, which is both the
    // weaker-than-printed direction and the true one — a spell played for free
    // spent no Energy.
    //
    // # The moment is the chain POP, and that is an inherited divergence
    //
    // `spellCast` fires when the spell resolves and is popped, not when it is
    // played onto the Chain; the event's own comment records this and
    // docs/rules-conformance.md carries it for every card on this event. Nothing
    // here makes it better or worse — Revna simply joins the family. Worth knowing
    // for one observable consequence: a COUNTERED spell never pops, so it never
    // readies her, even though it was played.
    //
    // # No `exhausted` gate, for Katarina's reason
    //
    // 415.1.c makes a ready Revna's resolution a no-op rather than an
    // impossibility, and the response window between the fire and the resolution
    // is exactly where she can become exhausted. Asked in `resolve` as well as
    // `applies` only for the caster and the threshold, both of which are facts
    // about the moment and cannot move (the chain entry is already popped by the
    // time this is held).
    //
    // `[Ganking]` is a printed keyword read by `validate-move-unit` through
    // `hasKeyword`; it needs nothing here.
    on: "spellCast",
    applies: (_state, listener, event) =>
      event.kind === "spellCast" &&
      event.casterIndex === listener.ownerIndex &&
      (event.energySpent ?? 0) >= REVNA_ENERGY_REQUIRED,
    resolve: (state, listener, event) => {
      if (event.kind !== "spellCast") return state;
      if (event.casterIndex !== listener.ownerIndex) return state;
      if ((event.energySpent ?? 0) < REVNA_ENERGY_REQUIRED) return state;
      return readyUnit(state, listener.card.instanceId);
    },
  },
  "UNL-181": {
    // Jhin - Virtuoso — "When you play a spell, if you spent [4] or more, you may
    // banish it. Then, if there are four spells banished with me, put each in its
    // trash, channel 4 runes, and draw 1."
    //
    // **Refused in waves 5, 7 and 8 on two blockers, and both are closed here.**
    // Registered BESIDE Revna deliberately: they read the same clause off the same
    // event, and the reasoning her entry above records about `energySpent` versus
    // `totalCost` versus `maxSpellEnergySpentThisTurn` is his too, in full. He does
    // not restate it.
    //
    //   1. "`spellCast` carries no card identity" — true, because every listener
    //      before him read only a PRICE. The event carries `spellInstanceId` now.
    //   2. "there is no 'banished with me' zone" — true, and the refusal was
    //      precise about why a count off `PlayerState.banished` would be wrong:
    //      Arcane Shift, Void Rush and Time Warp all write that list and would
    //      poison it. `LegendInstance.banishedInstanceIds` is the attachment, the
    //      same field `GearInstance` already carries for The Zero Drive.
    //
    // **He is a Legend and that needed nothing.** Wave 7's note added "Jhin is
    // additionally a Legend (legend-abilities.ts)" as if that were a third
    // blocker; `listeningPermanents` has ended with `owner.legend` since before he
    // was refused, which is how Lux - Illuminated hears this very event.
    //
    // "You MAY banish it" is a parked decision, because it is a real choice with
    // no right answer: banishing pushes toward the payout and gives up a card in
    // the trash that recursion could still use.
    on: "spellCast",
    applies: (_state, listener, event) =>
      event.kind === "spellCast" &&
      event.casterIndex === listener.ownerIndex &&
      (event.energySpent ?? 0) >= JHIN_ENERGY_REQUIRED,
    resolve: (state, listener, event) => {
      if (event.kind !== "spellCast") return state;
      if (event.casterIndex !== listener.ownerIndex) return state;
      if ((event.energySpent ?? 0) < JHIN_ENERGY_REQUIRED) return state;
      // Re-derived at RESOLUTION, not captured: the spell sat in the trash through
      // the response window and anything could have moved it. A spell no longer
      // there is 359.3.e.12's "check on something no longer available" and the
      // question is simply not asked.
      if (!state.players[listener.ownerIndex].trash.some((c) => c.instanceId === event.spellInstanceId)) return state;
      return parkDecision(state, {
        kind: "UNL-181-banish",
        playerIndex: listener.ownerIndex,
        cardInstanceId: event.spellInstanceId,
      });
    },
  },
};

/** Yeti Brawler's payout and its threshold, and the Battleaxe's self-inflicted 4
 *  — printed numbers, named beside Tryndamere's so no resolver here reads a bare
 *  literal. */
const YETI_BRAWLER_EXCESS_REQUIRED = 3;
const YETI_BRAWLER_TOKENS = 2;
const BLIGHTED_BATTLEAXE_DAMAGE = 4;

/** Revna the Lorekeeper's printed threshold — ENERGY spent on the one spell, and
 *  never Power alongside it. Named because a bare `4` next to an `energySpent`
 *  reads equally well as the printed-plus-Power figure this card deliberately
 *  does not use. */
const REVNA_ENERGY_REQUIRED = 4;

/** Jhin - Virtuoso's printed figures. The threshold is the same 4 Revna reads and
 *  means the same thing (ENERGY spent on this one spell); the other three are the
 *  payout, and all four are named because his card is four bare 4s in a row. */
const JHIN_ENERGY_REQUIRED = 4;
const JHIN_SPELLS_REQUIRED = 4;
const JHIN_RUNES_CHANNELED = 4;
const JHIN_CARDS_DRAWN = 1;

/** Local, matching this file's own idiom — it spreads `state.players` inline in
 *  a dozen resolvers, and `updatePlayer` is module-private in every engine file
 *  that has one. */
function updatePlayer(state: GameState, index: 0 | 1, update: (p: PlayerState) => PlayerState): GameState {
  const players = [...state.players] as [PlayerState, PlayerState];
  players[index] = update(players[index]);
  return { ...state, players };
}

/**
 * Jhin's "banish it, and then cash in if that made four" — the whole of what his
 * decision does when the answer is yes.
 *
 * One function rather than lines in the decision's `resolve` because the two
 * halves are one printed sentence joined by "Then": the count is taken AFTER the
 * banish, so a version that checked first would need three banished spells to
 * fire and would be silently one short forever.
 *
 * "Put each in ITS trash" — the owner's, which for a spell banished out of its
 * caster's own trash is the same player. Written as a filter over that player's
 * banish zone rather than a per-card owner lookup for that reason, and noted here
 * because a card banished with him that he did not banish could not arise: the
 * only writer of this list is the line above.
 */
function jhinBanishWithLegend(state: GameState, playerIndex: 0 | 1, spellInstanceId: string): GameState {
  const banished = banishCard(state, playerIndex, spellInstanceId);
  const legend = banished.players[playerIndex].legend;
  const withSpell = [...(legend.banishedInstanceIds ?? []), spellInstanceId];
  const attached = updatePlayer(banished, playerIndex, (p) => ({
    ...p,
    legend: { ...p.legend, banishedInstanceIds: withSpell },
  }));
  if (withSpell.length < JHIN_SPELLS_REQUIRED) return attached;

  // The payout. `withSpell` is emptied in the same write that returns the cards,
  // so a fifth spell starts a fresh set of four rather than firing every time.
  const cashed = updatePlayer(attached, playerIndex, (p) => ({
    ...p,
    // From BANISH, so under Endless Riches the four spells simply stay banished
    // — the funnel is handed the already-emptied banish list so the cards are
    // not counted twice on the way back into it.
    ...fileIntoTrash(
      attached,
      playerIndex,
      { trash: p.trash, banished: p.banished.filter((c) => !withSpell.includes(c.instanceId)) },
      p.banished.filter((c) => withSpell.includes(c.instanceId)),
      "elsewhere",
    ),
    legend: { ...p.legend, banishedInstanceIds: [] },
  }));
  return drawCards(channelRunesReady(cashed, playerIndex, JHIN_RUNES_CHANNELED), playerIndex, JHIN_CARDS_DRAWN);
}

/**
 * "Channel 4 runes" — READY, like Obelisk of Power's and unlike Startipped
 * Peak's "channel 1 rune exhausted".
 *
 * Its own three lines for the reason `battlefield-abilities`' copy records: the
 * one shared helper (`channelRunesExhausted`) bakes the exhaust in for the card
 * that asks for it, and a parameter would be a flag on a function whose whole
 * name is the answer. Same "as many as possible if fewer remain" behaviour as
 * `runChannel` (315.3.b.1).
 */
function channelRunesReady(state: GameState, playerIndex: 0 | 1, count: number): GameState {
  return updatePlayer(state, playerIndex, (p) => {
    if (count <= 0 || p.runeDeck.length === 0) return p;
    const taken = p.runeDeck.slice(0, count).map((r) => ({ ...r, state: "Ready" as const }));
    return { ...p, runeDeck: p.runeDeck.slice(taken.length), channeled: [...p.channeled, ...taken] };
  });
}

/** Jhin - Murderous Artist's two printed pips — one Energy and one RAINBOW rune,
 *  named separately because they are two different pools and a single `1` beside
 *  another `1` reads as a doubled amount. */
const JHIN_ADD_ENERGY = 1;
const JHIN_ADD_RAINBOW = 1;

/** Yeti Brawler's three conditions, asked once so `applies` and `resolve` cannot
 *  disagree — the split that has produced a held trigger firing on a board that
 *  no longer qualifies before. `tryndamereQualifies` below is the same shape for
 *  the card that prints this clause with a 5. */
function yetiQualifies(state: GameState, listener: Listener, event: GameEvent): boolean {
  if (event.kind !== "battlefieldConquered") return false;
  if (event.conquerorIndex !== listener.ownerIndex) return false;
  if (listener.battlefieldId !== event.battlefieldId) return false; // "when *I* conquer"
  const excess = state.lastShowdownExcessDamage;
  return (
    excess !== null &&
    excess.battlefieldId === event.battlefieldId &&
    excess.attackerIndex === listener.ownerIndex &&
    excess.amount >= YETI_BRAWLER_EXCESS_REQUIRED
  );
}

/**
 * Did Blighted Battleaxe's wearer conquer this turn?
 *
 * **Asked of the UNIT since 2026-08-26, and it used to be asked of the BOARD.**
 * The old answer was "am I standing where my controller conquered", which the
 * comment beside it defended as right for the unambiguous case — a wearer in base
 * "therefore never conquered". 383.4.c.2.a says the opposite: a unit conquers by
 * being "present at a Battlefield when a player gains control of it", which is a
 * fact about a moment, not about where it stands at the end of the turn.
 *
 * Reported from playtesting: the axe killed a wearer that conquered a battlefield
 * and was then pulled home, which is ordinary play rather than the narrow corner
 * the divergence was filed as.
 *
 * `wearer.card` is the LIVE unit off the board (`wearerListener` builds it from
 * `wearerOf`), so the flag `recordConquest` stamped at the moment is current here.
 * A wearer that walked in AFTER the conquest is therefore also answered correctly
 * now — the other half of the same divergence, and it was wrong in the generous
 * direction.
 */
function wearerConqueredThisTurn(state: GameState, wearer: Listener): boolean {
  void state;
  return wearer.card.kind === "Unit" && wearer.card.conqueredThisTurn === true;
}

/** The tag Rumble - Hotheaded's trash-play reads. A constant rather than a bare
 *  string because Ferrous Forerunner's token mints the same tag above, and the
 *  two have to agree for the archetype to work at all. */
const MECH_TAG = "Mech";

/** One "recycle X to play Y" bargain Rumble - Hotheaded is offering, priced.
 *
 *  Rebuilt from live state wherever it is needed rather than stored on the
 *  decision — the discipline `DecisionDefinition.options` states, applied to the
 *  answering side too, so an answer can never name a pair the board has stopped
 *  supporting. */
interface RumbleTrade {
  /** Opaque, and matched by EQUALITY rather than parsed: an instanceId is an
   *  engine-minted string in play and an arbitrary one in tests, so splitting a
   *  composite id back apart would be a decode step that can silently fail. */
  id: string;
  label: string;
  fodderInstanceId: string;
  mech: UnitInstance;
  /** What the Mech still costs in Energy: every cross-cutting modifier, then
   *  Rumble's own discount, floored at 0. */
  energy: number;
}

/** Every pair Rumble could name right now, priced and filtered to the ones that
 *  can actually be paid for (416.3 — an action that cannot be completed is not
 *  one you may choose to take).
 *
 *  `rumbleInstanceId` is HIS body, excluded because the card says "ANOTHER
 *  friendly unit". A Rumble who died in the response window matches nothing here,
 *  which leaves every friendly unit eligible — correct, since he is no longer one
 *  of them. */
function rumbleTrades(state: GameState, playerIndex: 0 | 1, rumbleInstanceId: string | undefined): RumbleTrade[] {
  // "A MECH from your trash" — a Unit card carrying the tag. The `kind` check is
  // not a restriction the card prints: it is what "play it" can mean from here,
  // since a Gear or a Spell in the trash goes into play by a different funnel.
  const mechs = state.players[playerIndex].trash.filter(
    (card): card is UnitInstance => card.kind === "Unit" && card.tags.includes(MECH_TAG),
  );
  if (mechs.length === 0) return [];

  const trades: RumbleTrade[] = [];
  // The clause names no battlefield, so a unit sitting in base is fodder too —
  // 355.9.a.1's bare noun, the same reading Cleave and Gem Jammer take.
  for (const fodder of ownUnitsEverywhere(state, playerIndex).filter((u) => u.instanceId !== rumbleInstanceId)) {
    const might = currentMight(state, playerIndex, fodder);
    for (const mech of mechs) {
      // The general modifiers come off the printed cost first and Rumble's
      // discount off what is left. Both are floored at 0 and neither has a
      // minimum of its own, so the order is unobservable for every card in this
      // pool — it is written this way round because a card-specific discount
      // applying to an already-modified cost is what modifiedEnergyCost's own
      // ordering note establishes for the cross-cutting ones.
      const energy = Math.max(0, modifiedEnergyCost(state, playerIndex, "Unit", mech.energyCost, mech.defId) - might);
      if (payForMech(state, playerIndex, energy, mech) === undefined) continue;
      trades.push({
        id: `${fodder.instanceId}+${mech.instanceId}`,
        label: `Recycle ${fodder.name} (${might} Might) to play ${mech.name} for ${energy} Energy`,
        fodderInstanceId: fodder.instanceId,
        mech,
        energy,
      });
    }
  }
  return trades;
}

/** A unit's Might as this cost question asks it — rule 710's CURRENT Might, so an
 *  aura or a this-turn pump counts and a printed number would be wrong the moment
 *  the card is doing its job. `isCombat: false` for the reason `isMighty`'s doc
 *  gives: Might is a property of the unit, not of a fight, so [Assault] never
 *  raises the discount. The battlefield is passed because the positional auras
 *  (Garen - Commander, Lee Sin - Centered) cannot be read without it. */
function currentMight(state: GameState, playerIndex: 0 | 1, unit: UnitInstance): number {
  const at = findUnitAnywhere(state, unit.instanceId);
  const battlefieldId = at && at.zone !== "base" ? state.battlefields[at.zone.battlefieldIndex]?.id : undefined;
  return effectiveMight(state, unit, playerIndex, {
    isCombat: false,
    ...(battlefieldId !== undefined ? { battlefieldId } : {}),
  });
}

/** Pays what the Mech still costs, or `undefined` when it cannot be paid — the
 *  contract `payPowerFromChanneled` and `spendBuff` share, so an unaffordable
 *  pair is never offered rather than being half-paid for.
 *
 *  Power FIRST and Energy second, which is Immortal Phoenix's order and its
 *  reason: recycling a Ready rune for Power banks the Energy it could have paid,
 *  so pricing the Energy against the pre-Power pool would let one rune be spent
 *  twice.
 *
 *  **`powerDomainAlt` is not honoured** — the hybrid-pip second domain, which
 *  `payPowerFromChanneled` has no parameter for. No Mech in this pool prints one;
 *  a card that did would be offered less often than it should be, never more. */
function payForMech(state: GameState, playerIndex: 0 | 1, energy: number, mech: UnitInstance): GameState | undefined {
  const withPower = payPowerFromChanneled(state, playerIndex, mech.powerDomain, mech.powerCost);
  return withPower === undefined ? undefined : payEnergyFromPool(withPower, playerIndex, energy);
}

/** The enemy units at one battlefield in board order, minus the trigger's own
 *  unit — Lucian - Gunslinger's "an enemy unit here".
 *
 *  A local copy of unit-triggers.ts's private `enemiesAt` rather than an import,
 *  because that one is not exported and this file may not edit it. The ORDER is
 *  the same (board order, both players' lists walked as stored), which is what
 *  makes an auto-selecting trigger's test meaningful rather than incidental. */
/** The enemy units at one battlefield, in the same board order `firstEnemyAt`
 *  walks — the pool Recurve Bow's question offers. */
function enemiesAt(state: GameState, ownerIndex: 0 | 1, battlefieldId: string): UnitInstance[] {
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  if (!bf) return [];
  const ownId = state.players[ownerIndex].id;
  return Object.entries(bf.units)
    .filter(([id]) => id !== ownId)
    .flatMap(([, units]) => units);
}

function firstEnemyAt(state: GameState, ownerIndex: 0 | 1, battlefieldId: string, selfInstanceId: string): string | undefined {
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  if (!bf) return undefined;
  const ownId = state.players[ownerIndex].id;
  return Object.entries(bf.units)
    .filter(([id]) => id !== ownId)
    .flatMap(([, units]) => units.map((u) => u.instanceId))
    .find((id) => id !== selfInstanceId);
}

/** Triggers a card fires about ITSELF — being played, discarded or killed. Keyed
 *  by that card's own defId, because at those moments it may not be in play for
 *  a listener walk to reach (see triggers.ts's SelfTriggerDefinition). */
export const selfTriggers: Record<string, SelfTriggerDefinition> = {
  [ENDLESS_RICHES]: {
    // Endless Riches — "When you play this, banish your hand and trash, then
    // [Burn 7]." The FIRST of the card's four clauses and the only one that is
    // card work; the other three are continuous and are read from
    // `board-restrictions.controlsEndlessRiches` by the draw phase, the trash
    // permission and the trash funnel.
    //
    // # The order is the card, and "then" is what makes it an engine
    //
    // Banish first, THEN burn: the hand and the old trash go away, and the seven
    // cards the Burn puts in the trash are what is left to play with. Reversed,
    // the burn would be banished by the very clause it is fuel for — this Gear's
    // own "if a card would go to your trash from anywhere other than your Main
    // Deck, banish it instead" does not touch a Burn (440 takes from the deck)
    // but DOES touch a trash that is being emptied around it.
    //
    // **A `played` SELF trigger, not a `unitTriggers` entry**, because this is a
    // Gear: `unitTriggers` is keyed by an arriving UNIT. It is the route all ten
    // other gears printing "when you play this" already take, and the one the
    // trigger census refused to let VEN-108 Forgotten Relic mix with an event.
    //
    // Both zones are emptied through `banishCard`, one card at a time and by
    // instanceId, rather than by moving the arrays: that is the single writer of
    // the banish zone, it drops tokens (186.1) and it is a no-op on a card that
    // has already left — which matters because the two lists are read once and
    // walked while the state changes underneath them.
    //
    // The Gear itself is in `activeGear` by the time this fires, not in hand, so
    // it does not banish itself.
    on: ["played"],
    resolve: (state, event) => {
      const owner = state.players[event.ownerIndex];
      const emptied = [...owner.hand, ...owner.trash].reduce(
        (next, card) => banishCard(next, event.ownerIndex, card.instanceId),
        state,
      );
      return burn(emptied, event.ownerIndex, ENDLESS_RICHES_BURN);
    },
  },
  "OGN-006": {
    // Flame Chompers — "When you discard me, you may pay [Fury] to play me."
    //
    // Keyed by its own defId because at the moment it fires the card is not in
    // play for any listener walk to find — it is on its way from hand to trash.
    //
    // The offer is made from the TRASH, which is where `discardCards` has just
    // put it. That is not a detail to route around: it is what makes the answer
    // checkable later ("is it still there?"), and what a second copy discarded in
    // the same breath would each be asked about separately.
    on: ["discarded"],
    resolve: (state, event) =>
      parkDecision(state, {
        kind: "OGN-006-play",
        playerIndex: event.ownerIndex,
        cardInstanceId: event.card.instanceId,
      }),
  },};

/** Questions this domain's cards stop to ask — see engine/decisions.ts. Keyed by
 *  a `kind` string rather than a defId, since one card can ask more than one
 *  kind of question; the one-file-one-owner rule still applies, and the key is
 *  prefixed with the card's defId so ownership stays readable. */
/** Can this player still afford Immortal Phoenix's `[1 Energy][1 Fury]`? Asked
 *  through the very helpers that will pay it, so affordability and payment cannot
 *  disagree — the same discipline `canPayActivationCost` follows. */
function canPayPhoenix(state: GameState, playerIndex: 0 | 1): boolean {
  const withPower = payPowerFromChanneled(state, playerIndex, "Fury", 1);
  return withPower !== undefined && payEnergyFromPool(withPower, playerIndex, 1) !== undefined;
}

/**
 * The Equipment in hand Rell - Magnetic may play — "an Equipment with Energy
 * cost no more than [2] from HAND".
 *
 * One walk, asked by the trigger (to decide whether there is a question at all)
 * and by the decision (to build and to resolve its options), so "is there an
 * offer" and "what may be chosen" cannot disagree.
 *
 * The ceiling is on the PRINTED Energy cost, not a modified one: the play
 * ignores the cost entirely, so there is no modified price to compare against,
 * and a discount that made an expensive Equipment eligible would be reading the
 * card backwards.
 */
const RELL_MAX_EQUIP_ENERGY = 2;

function rellEquipCandidates(state: GameState, playerIndex: 0 | 1): GearInstance[] {
  return state.players[playerIndex].hand.filter(
    (c): c is GearInstance => c.kind === "Gear" && isEquipmentGear(c) && c.energyCost <= RELL_MAX_EQUIP_ENERGY,
  );
}

export const decisions: Record<string, DecisionDefinition> = {
  /**
   * Zed, From the Shadows — where does the Shadow Clone go?
   *
   * The destinations are the ones a token may be PLAYED to: base, or a
   * battlefield its controller CONTROLS. Asked through the same `mayPlayUnitAt`
   * gate Vanguard Armory uses, which is deliberately stricter than the Unit
   * direct-deploy check — that one accepts mere presence, while Rockfall Path
   * bars a destination for both players.
   *
   * **Rebuilt from live state on every read**, the discipline every decision in
   * this file keeps: a battlefield lost between the trigger being held and the
   * question being answered must not still be on offer.
   *
   * One option means no prompt — see the trigger's own note.
   */
  "VEN-023-place": {
    prompt: () => "Zed, From the Shadows: where does the Shadow Clone go?",
    options: (state, d) => [
      { id: "base", label: "Your base" },
      ...state.battlefields
        .filter((bf) => bf.controllerId === state.players[d.playerIndex].id && mayPlayUnitAt(state, bf.id))
        .map((bf) => ({ id: bf.id, label: bf.name })),
    ],
    resolve: (state, d, optionId) => {
      const destination: TokenDestination = optionId === "base" ? "base" : { battlefieldId: optionId };
      return placeToken(state, d.playerIndex, destination, SHADOW_CLONE_TOKEN);
    },
  },
  /**
   * Baccai Reaper's "you may pay [Fury] to give me [Assault 2] this turn".
   *
   * Draven - Vanquisher's pump question with a keyword payload, and it keeps that
   * question's two disciplines:
   *
   * **The payment is asked here as well as in the trigger's `applies`**, and it
   * is TAKEN here. `payPowerFromChanneled` returns the paid state or `undefined`,
   * so there is no way to grant the keyword without having spent the pip — the
   * pattern that makes "you may pay" a cost rather than a condition.
   *
   * **The offer is rebuilt from live state**, so a Reaper who died in the
   * response window, or a Fury spent elsewhere, leaves a bare Decline that
   * `advanceDecisions` executes without prompting. 416.3: a cost that cannot be
   * completed is not one you may choose to pay.
   *
   * `grantKeywordThisTurn` is what applies 807.2's summing against his printed
   * `[Assault 2]`; this resolver deliberately does no arithmetic of its own.
   */
  [BACCAI_REAPER_PUMP]: {
    prompt: () => "Baccai Reaper: pay 1 Fury to give me [Assault 2] this turn?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...(d.cardInstanceId !== undefined &&
      findUnitAnywhere(state, d.cardInstanceId) !== undefined &&
      payPowerFromChanneled(state, d.playerIndex, "Fury", BACCAI_REAPER_POWER) !== undefined
        ? [{ id: "pay", label: "Pay 1 Fury: [Assault 2] this turn" }]
        : []),
    ],
    resolve: (state, d, optionId) => {
      if (optionId === "decline" || d.cardInstanceId === undefined) return state;
      const paid = payPowerFromChanneled(state, d.playerIndex, "Fury", BACCAI_REAPER_POWER);
      if (paid === undefined) return state;
      return grantKeywordThisTurn(paid, d.cardInstanceId, "Assault", BACCAI_REAPER_ASSAULT);
    },
  },
  /**
   * Blade Twirler's "choose a player. They [Burn 1]."
   *
   * Bewitching Spirit's shape (UNL-121, effects/chaos.ts), which is the pool's
   * only other "choose a player" — TWO options at 1v1, because "a player" reaches
   * either seat where "an opponent" would not. Burning your own top card is a
   * real line, so both answers are offered.
   *
   * No decline: the text prints no "you may". The OPPONENT leads, matching
   * Bewitching Spirit and every decline-first offer in this file, so a mis-click
   * and the AI's tie-break land on the ordinary answer.
   *
   * The burn itself is `burn` (rule 440), which handles 440.4's "burn what you
   * have, Burn Out, then burn the rest" — irrelevant at 1 card and correct for
   * free, since the helper is shared with the cards that burn 7.
   */
  [BLADE_TWIRLER_BURN]: {
    prompt: () => "Blade Twirler: choose a player. They Burn 1.",
    // Typed `(0 | 1)[]` rather than inferred, for the reason Bewitching Spirit's
    // entry records: a bare array literal widens to `number[]`, `players` is a
    // two-tuple, and the lookup below then fails the typecheck — which vitest
    // does not run, so it only appears at step 3 of the loop.
    options: (state, d) => {
      const order: (0 | 1)[] = d.playerIndex === 0 ? [1, 0] : [0, 1];
      return order.map((index) => ({ id: String(index), label: `${state.players[index].name} Burns 1` }));
    },
    resolve: (state, _d, optionId) => burn(state, optionId === "1" ? 1 : 0, BLADE_TWIRLER_BURN_COUNT),
  },
  /**
   * Dancing Grenade's "ITS controller may play this spell again for [rainbow]" —
   * the question, asked of the DAMAGED unit's controller.
   *
   * # Why this is a decision and not a play permission
   *
   * The refusal this card carried until 2026-08-14 was exactly right about its
   * blocker and wrong about the fix. It said: a replay has to become a PERMISSION
   * the ordinary play path spends, and `timing.mayPlayCardNow` opens with
   * `playerIndex !== actingPlayerIndex(state)`, so a cross-seat grant is not
   * merely unwritten but UNUSABLE. Every word of that is true — and the answer is
   * to not use the permission path at all. A parked decision is answered by
   * whoever it names, active player or not (`legal-actions` returns the pending
   * decision's answers and nothing else while one is outstanding), so the
   * opponent gets a real window rather than one that never opens.
   *
   * # And the payment is not a new mechanism either
   *
   * The second half of the refusal — "this engine cannot pay mid-resolution" —
   * was stale. `payPowerFromChanneled` pays a Power cost from inside a
   * resolution, spending floating Power first and recycling a rune for the rest,
   * and it is asked SPECULATIVELY when the options are built so an unpayable
   * offer is never made (416.3, the convention Flame Chompers and Here to Help
   * both keep). "For [rainbow]" is one Power pip of any domain, which is exactly
   * that helper's `null` domain. Nothing here needed building.
   *
   * Declining leads, as every 'you may' in this engine does. With the pip
   * unpayable the list is a bare decline and `advanceDecisions` executes it
   * without prompting, which is the right amount of theatre for a question with
   * one answer.
   */
  [DANCING_GRENADE_REPLAY]: {
    prompt: () => "Dancing Grenade: play it again for 1 Power of any domain?",
    // **Gated on the PIP alone, and deliberately not on the card's zone.**
    //
    // A replayed copy parks its own next offer from INSIDE `playSpellImmediately`,
    // which trashes the card AFTER the effect resolves — so at the moment the
    // second question is raised the Grenade is in no zone at all. Gating on trash
    // membership made `advanceDecisions` see a bare decline and auto-answer it,
    // while `legal-actions` (asked a moment later, with the card safely in the
    // trash) would have offered the replay. Two evaluations of one option list
    // disagreeing is worse than either answer.
    //
    // Payability is the condition that is actually stable across the window, and
    // it is the one 416.3 cares about. `replayDancingGrenade` re-derives the card
    // and answers `state` unchanged if it has genuinely gone — 359.3's "a check on
    // something no longer available returns null" — without taking the payment.
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...(payPowerFromChanneled(state, d.playerIndex, null, DANCING_GRENADE_REPLAY_POWER) !== undefined
        ? [{ id: "replay", label: "Play Dancing Grenade again (1 Power of any domain)" }]
        : []),
    ],
    resolve: (state, d, optionId) =>
      optionId === "decline"
        ? state
        : parkDecision(state, {
            kind: DANCING_GRENADE_TARGET,
            playerIndex: d.playerIndex,
            ...(d.cardInstanceId !== undefined ? { cardInstanceId: d.cardInstanceId } : {}),
          }),
  },
  /**
   * ...and "Deal 2 to a unit" for the replayed copy, asked of the player who took
   * the offer.
   *
   * A SECOND question rather than a target chosen alongside the yes/no, and Here
   * to Help's two-step is the precedent: `PendingDecision` carries one option id,
   * and folding a target into the first answer would make the option list the
   * cross product of `{decline, replay}` and every unit on the board.
   *
   * The pip is re-paid HERE rather than trusted from the first answer, which was
   * built against the state one question ago — the convention `payPowerFromChanneled`
   * and `spendBuff` share. An unpayable cost withholds the replay; it never hands
   * it over free.
   *
   * "A unit" with no owner and no location word, so the option list is every unit
   * on the board including the answerer's own (355.9.a.1's widening). A player
   * who takes this offer to point the Grenade back at the caster's board is
   * playing the card as printed.
   */
  [DANCING_GRENADE_TARGET]: {
    prompt: () => "Dancing Grenade: deal 2 to which unit?",
    options: (state, d) =>
      // The pip, again, and again not the zone — see the question above.
      payPowerFromChanneled(state, d.playerIndex, null, DANCING_GRENADE_REPLAY_POWER) === undefined
        ? []
        : allUnitsOnBoard(state).map((u) => ({ id: u.instanceId, label: `Deal to ${u.name}`, instanceId: u.instanceId })),
    resolve: (state, d, optionId) => replayDancingGrenade(state, d.playerIndex, d.cardInstanceId, optionId),
  },
  "UNL-181-banish": {
    // Jhin - Virtuoso's "you MAY banish it".
    prompt: () => "Jhin - Virtuoso: banish that spell with me?",
    // Declining first, so a mis-click and the AI's tie-break both land on doing
    // nothing — the convention every "you may" here follows. The banish option is
    // only offered while the spell is still in the trash, rebuilt from live state
    // like every option list, so a spell recurred out of it during the response
    // window leaves a bare decline rather than an offer that cannot be honoured.
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...state.players[d.playerIndex].trash
        .filter((c) => c.instanceId === d.cardInstanceId)
        .map((c) => ({ id: c.instanceId, label: `Banish ${c.name} with Jhin`, instanceId: c.instanceId })),
    ],
    resolve: (state, d, optionId) =>
      optionId === "decline" ? state : jhinBanishWithLegend(state, d.playerIndex, optionId),
  },
  /**
   * Void Hatchling's look, before Blind Fury's reveal.
   *
   * The one continuation whose deck is not the answerer's: the caster answers and
   * the OPPONENT's top card is what may be recycled, so both indices are derived
   * from `d.playerIndex` here rather than carried. Two players, so the other seat
   * is the opponent by construction.
   */
  "OGN-025-reveal": {
    prompt: () => "Void Hatchling: recycle the top card of the enemy deck before Blind Fury reveals it?",
    options: (state, d) => voidHatchlingOptions(state, d.playerIndex === 0 ? 1 : 0),
    resolve: (state, d, optionId) =>
      blindFuryReveal(voidHatchlingAnswer(state, d.playerIndex === 0 ? 1 : 0, optionId), d.playerIndex),
  },

  /**
   * Rell - Magnetic's "you may play an Equipment ... ignoring its cost. If you
   * do, then do this: Attach it to me."
   *
   * **The CALLER removes the card from its zone** — `playCardIgnoringCost` says
   * so in its own contract and does neither the payment nor the zone move. So the
   * hand is rebuilt here before the play.
   *
   * "If you do, THEN do this" ties the attach strictly to the play, so both
   * happen in the paying branch and declining gives neither.
   */
  "SFD-024-equip": {
    prompt: () => "Rell - Magnetic: play an Equipment from hand for free and attach it?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...rellEquipCandidates(state, d.playerIndex).map((g) => ({ id: g.instanceId, label: g.name, instanceId: g.instanceId })),
    ],
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      const chosen = rellEquipCandidates(state, d.playerIndex).find((g) => g.instanceId === optionId);
      if (!chosen) return state;

      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        hand: players[d.playerIndex].hand.filter((c) => c.instanceId !== chosen.instanceId),
      };
      const played = playCardIgnoringCost({ ...state, players }, d.playerIndex, chosen);

      // "Attach it to ME." Rell may have died in the response window between the
      // trigger and this answer, in which case the Equipment is simply played and
      // stays unattached — 055's do-as-much-as-you-can, and `attachEquipment` is
      // a no-op on a missing wearer anyway.
      return d.cardInstanceId === undefined
        ? played
        : attachEquipment(played, d.playerIndex, chosen.instanceId, d.cardInstanceId);
    },
  },
  /**
   * Recurve Bow's "deal 2 to an enemy unit here", raised by its WEARER attacking
   * or defending. `battlefieldId` is captured when the question is raised, because
   * by the time an answer arrives nothing on the board says which fight asked —
   * the same reason Blitzcrank - Impassive's decision carries one.
   *
   * **But "here" is then re-checked against the WEARER's live location**, so the
   * captured id says which fight, and is not a licence to shoot into it from
   * elsewhere. A wearer moved away — or killed — makes the question MOOT, no
   * options, and `advanceDecisions` drops it. "Here" is a referent read from the
   * ability's source (359.3.f.1) and a referent is checked on EXECUTION of the
   * instruction (359.3.f.2), whose own worked example is Fight or Flight sending
   * Yasuo - Remorseful home in reaction to his attack trigger: "'here' is no
   * longer the battlefield where combat is ongoing and the attack trigger
   * mistargets". Sinister Poro (UNL-137, effects/chaos.ts) checks its own "here"
   * in exactly this place, and that is the convention.
   *
   * **The check is HERE and not in `resolve` above, and that is measured rather
   * than stylistic.** `parkDecision` builds the options immediately, so this runs
   * at the moment the trigger resolves as well as at any later answer — a copy in
   * `resolve` changed no outcome and no test could make it fail. And a LATER
   * answer turns out not to be reachable today anyway: a pending question blocks
   * the chain, so no other item can resolve and move the wearer while this one
   * waits (pinned in test/equipment-wearer-moments.test.ts, which asserts the
   * Bow's trigger is still ON the chain while another card's question is open).
   */
  "SFD-016-shot": {
    prompt: () => "Recurve Bow: deal 2 to which enemy unit here?",
    options: (state, d) => {
      if (d.battlefieldId === undefined || d.cardInstanceId === undefined) return [];
      const here = findUnitOnBattlefield(state, d.cardInstanceId);
      if (!here || state.battlefields[here.battlefieldIndex]!.id !== d.battlefieldId) return [];
      return enemiesAt(state, d.playerIndex, d.battlefieldId).map((u) => ({
        id: u.instanceId,
        label: u.name,
        instanceId: u.instanceId,
      }));
    },
    resolve: (state, d, optionId) => dealDamage(state, d.playerIndex, optionId, 2),
  },
  // Immortal Phoenix's "you may pay [1 Energy][1 Fury] to play me from your
  // trash", raised by his spell-kill trigger.
  //
  // Declining leads, as everywhere a "you may" is asked. Power is paid FIRST and
  // Energy second, the same order `payActivationCost` uses and for the same
  // reason: recycling a Ready rune for Power banks the Energy it could have paid,
  // so pricing Energy against the pre-Power pool would let one rune be spent
  // twice.
  /**
   * Unlicensed Armory's armed ward — "the next time it would die this turn, you
   * MAY PAY [Fury] to heal it, exhaust it, and recall it instead."
   *
   * Raised by `offerPaidDeathWard`, which has already checked the Fury can be
   * paid. The two branches differ exactly as Sett's do: saving REPLACES the
   * death (808.1.d.1), so no [Deathknell] fires and no death-watch sees it;
   * declining resumes the ordinary death at `completeDeath` rather than
   * re-entering killUnit, which would offer the same save forever.
   *
   * The ward is spent EITHER WAY — "the NEXT time it would die" names one death,
   * and declining is still that death happening.
   */
  "OGN-023-save": {
    prompt: (state, d) => {
      const held = pendingDeathFor(state, d.targetInstanceId);
      return `Unlicensed Armory: pay 1 Fury to save ${held?.unit.name ?? "your unit"} instead of letting it die?`;
    },
    options: (state, d) =>
      pendingDeathFor(state, d.targetInstanceId)
        ? [
            { id: "die", label: "Let it die" },
            { id: "save", label: "Pay 1 Fury: heal, exhaust and recall it" },
          ]
        : [],
    resolve: (state, d, optionId) => {
      const held = pendingDeathFor(state, d.targetInstanceId);
      if (!held) return state;
      const released = clearPaidDeathWard(releasePendingDeath(state, held.unit.instanceId), held.unit.instanceId);
      if (optionId !== "save") return completeDeath(released, held);

      // Pay first and fall back to the ordinary death if the Fury has gone since
      // the offer — a half-paid replacement would hand over the save for free.
      const paid = payPowerFromChanneled(released, d.playerIndex, ARMORY_WARD_POWER.domain, ARMORY_WARD_POWER.count);
      if (paid === undefined) return completeDeath(released, held);
      // Unlike Sett's save this does NOT spend the unit's buff: his text prices
      // the save partly in the buff, the Armory's does not mention one.
      return reviveToBase(paid, held.unit, held.ownerIndex);
    },
  },
  "OGN-037-return": {
    prompt: () => "Immortal Phoenix: pay 1 Energy and 1 Fury to play him from your trash?",
    options: () => [
      { id: "decline", label: "Decline" },
      { id: "pay", label: "Pay and return him" },
    ],
    resolve: (state, d, optionId) => {
      if (optionId !== "pay" || !d.cardInstanceId) return state;
      const withPower = payPowerFromChanneled(state, d.playerIndex, "Fury", 1);
      if (!withPower) return state;
      const paid = payEnergyFromPool(withPower, d.playerIndex, 1);
      if (!paid) return state;

      const actor = paid.players[d.playerIndex];
      const phoenix = actor.trash.find((c) => c.instanceId === d.cardInstanceId);
      if (!phoenix) return paid;
      // Out of the trash before playing, so `playCardIgnoringCost` puts him in
      // exactly one zone.
      const players = [...paid.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = { ...actor, trash: actor.trash.filter((c) => c.instanceId !== d.cardInstanceId) };
      return playCardIgnoringCost({ ...paid, players }, d.playerIndex, phoenix);
    },
  },
  // Draven - Vanquisher's "when I attack or defend, you may pay [1 Fury]. If you
  // do, give me +2 Might this turn" — raised by his combat listener, which has
  // already checked the Fury can be paid.
  //
  // Declining leads, as everywhere a "you may" is asked, so a mis-click and the
  // AI's tie-break both land on doing nothing.
  //
  // `giveMightThisTurnToOwnUnit` rather than `giveMightThisTurn`: the pump names
  // HIM ("give ME"), and the owner-scoped helper refuses an id that is not this
  // player's — which is what stops a stale `cardInstanceId` from buffing whatever
  // now answers to it. A Draven killed during the response window is paid for and
  // pumps nothing; that is 359.3's "the check returns null and calculations based
  // on it are ignored", and the cost is still spent because paying is the choice.
  "SFD-020-pump": {
    prompt: () => "Draven - Vanquisher: pay 1 Fury Power to give him +2 Might this turn?",
    options: () => [
      { id: "decline", label: "Decline" },
      { id: "pay", label: "Pay 1 Fury Power: +2 Might this turn" },
    ],
    resolve: (state, d, optionId) => {
      if (optionId !== "pay" || !d.cardInstanceId) return state;
      const paid = payPowerFromChanneled(state, d.playerIndex, "Fury", 1);
      if (!paid) return state;
      return giveMightThisTurnToOwnUnit(paid, d.playerIndex, d.cardInstanceId, DRAVEN_PUMP);
    },
  },
  // Rumble - Hotheaded's "you may recycle another friendly unit to play a Mech
  // from your trash. Reduce its Energy cost by the Might of the unit you
  // recycled" — raised by his conquer trigger, which has already established that
  // at least one pair can be paid for.
  //
  // The options are PAIRS, one per (fodder, Mech) that is affordable right now,
  // each labelled with what it actually costs. See the trigger for why the
  // question is not split in two.
  "SFD-026-scrap": {
    prompt: () => "Rumble - Hotheaded: recycle a friendly unit to play a Mech from your trash?",
    options: (state, d) => [
      // "You MAY", so declining leads and is offered even when nothing else is —
      // a mis-click and the AI's tie-break both land on doing nothing.
      { id: "decline", label: "Decline" },
      ...rumbleTrades(state, d.playerIndex, d.cardInstanceId).map((trade) => ({
        id: trade.id,
        label: trade.label,
        instanceId: trade.mech.instanceId,
      })),
    ],
    resolve: (state, d, optionId) => {
      // Declining, and "the board moved while the question waited", are the same
      // answer here: neither names a pair that is still on offer.
      const trade = rumbleTrades(state, d.playerIndex, d.cardInstanceId).find((t) => t.id === optionId);
      if (!trade) return state;

      // Both costs are paid before anything is played, and the whole trade is
      // abandoned if either fails — returning the ORIGINAL state discards the
      // recycle along with it. A recycle that had already happened when the runes
      // turned out to be gone would be the worst of both halves, and the failure
      // is reachable: `rumbleTrades` prices against a state that a queued
      // question ahead of this one may have changed.
      const recycled = recycleUnitFromPlayToDeck(state, d.playerIndex, trade.fodderInstanceId);
      if (recycled === state) return state;
      const paid = payForMech(recycled, d.playerIndex, trade.energy, trade.mech);
      if (paid === undefined) return state;

      // Out of the trash before it is played, so it exists in exactly one zone —
      // and `cardsPlayedThisTurn` moves, because this is a PLAY: [Legion] reads
      // that counter and Darius - Trifarian triggers off it. Flame Chompers'
      // answer does both for the same reason.
      //
      // `playUnitFree` decides WHERE, asking only when there is more than one
      // answer — 355.2.a's "By default, Valid locations include the controller's
      // Base or a Battlefield the controller controls", which right after a
      // conquest is at least two places.
      const players = [...paid.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        trash: players[d.playerIndex].trash.filter((c) => c.instanceId !== trade.mech.instanceId),
        cardsPlayedThisTurn: players[d.playerIndex].cardsPlayedThisTurn + 1,
      };
      return playUnitFree({ ...paid, players }, d.playerIndex, trade.mech);
    },
  },
  // Vayne - Hunter's "when I conquer, you may pay [1 Energy] to return me to my
  // owner's hand" — a way to re-use her on-play tempo, at the price of the body.
  "OGN-035-return": {
    prompt: () => "Vayne - Hunter: pay 1 Energy to return her to your hand?",
    options: () => [
      { id: "decline", label: "Decline" },
      { id: "pay", label: "Pay 1 Energy and return her" },
    ],
    resolve: (state, d, optionId) => {
      if (optionId !== "pay" || !d.cardInstanceId) return state;
      const paid = payEnergyFromPool(state, d.playerIndex, 1);
      if (!paid) return state;
      return returnUnitToHand(paid, d.cardInstanceId);
    },
  },
  // Shakedown's "unless its controller has you draw 2" — answered by the
  // VICTIM'S controller, whose seat is `d.playerIndex`.
  //
  // Both options are always offered: an empty deck makes "let them draw" a way
  // to take nothing at all, which is a legitimate play rather than a case to
  // filter out. Six damage is dealt through dealDamage, so it goes through
  // effectiveMight, damage modifiers and the kill funnel like any other damage.
  "OGN-033-choose": {
    prompt: (state, d) => {
      const unit = d.targetInstanceId ? findUnitAnywhere(state, d.targetInstanceId)?.unit : undefined;
      return `Shakedown: take 6 on ${unit?.name ?? "your unit"}, or let your opponent draw 2?`;
    },
    options: () => [
      { id: "damage", label: "Take 6" },
      { id: "draw", label: "They draw 2 instead" },
    ],
    resolve: (state, d, optionId) => {
      const caster: 0 | 1 = d.playerIndex === 0 ? 1 : 0;
      if (optionId === "draw") return drawCards(state, caster, 2);
      return d.targetInstanceId ? dealDamage(state, caster, d.targetInstanceId, 6) : state;
    },
  },
  "OGN-006-play": {
    prompt: () => "Flame Chompers: pay 1 Fury Power to play it from your trash?",
    options: (state, d) => {
      // "You may" — declining is always on offer, and first, so that doing
      // nothing is what a mis-click and the AI's tie-break both land on.
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      const inTrash = state.players[d.playerIndex].trash.find((c) => c.instanceId === d.cardInstanceId);
      if (inTrash && payPowerFromChanneled(state, d.playerIndex, "Fury", 1)) {
        options.push({ id: "play", label: "Pay 1 Fury Power and play it", instanceId: inTrash.instanceId });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId !== "play") return state;
      const paid = payPowerFromChanneled(state, d.playerIndex, "Fury", 1);
      if (!paid) return state;

      const card = paid.players[d.playerIndex].trash.find((c) => c.instanceId === d.cardInstanceId);
      if (!card || card.kind !== "Unit") return state;

      // Out of the trash, then into play through the shared deploy funnel — so
      // it enters exhausted (143.4.a) unless something says otherwise, and both
      // events a real play fires go off. "Play me" means play me.
      //
      // The printed 3 Energy is not paid and not discounted: the card's own text
      // replaces its cost with the Fury Power already taken above.
      const players = [...paid.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        trash: players[d.playerIndex].trash.filter((c) => c.instanceId !== d.cardInstanceId),
        cardsPlayedThisTurn: players[d.playerIndex].cardsPlayedThisTurn + 1,
      };
      return playUnitFree({ ...paid, players }, d.playerIndex, card);
    },
  },
  // Inviolus Vox's "give a friendly unit +8 Might this turn", raised by his
  // conquer trigger, which has already established that his controller has at
  // least one unit to give it to.
  //
  // **NO decline option.** The card carries no "you may", so once it has triggered
  // the Might has to land somewhere; with exactly one candidate `advanceDecisions`
  // executes it without a prompt, which is right — there is no choice to make.
  // Ribbon Dancer's question takes the same shape for the same reason.
  //
  // "A FRIENDLY unit" with no battlefield named, so base counts and Vox himself is
  // eligible — the text says no "other", unlike Ribbon Dancer's "ANOTHER friendly
  // unit". Candidates are rebuilt from live state, so a unit killed in the response
  // window is simply not offered.
  "UNL-027-might": {
    prompt: () => "Inviolus Vox: give a friendly unit +8 Might this turn",
    options: (state, d) =>
      ownUnitsEverywhere(state, d.playerIndex).map((u) => ({ id: u.instanceId, label: u.name, instanceId: u.instanceId })),
    resolve: (state, d, optionId) => giveMightThisTurnToOwnUnit(state, d.playerIndex, optionId, INVIOLUS_VOX_MIGHT),
  },
  // Fresh Beans' "you may exhaust this to draw 1", raised by its cardPlayed
  // listener, which has already established that a unit of its controller's was
  // played inside a Showdown and that the gear was still ready.
  //
  // Two options ALWAYS, so `advanceDecisions` can never auto-resolve it — a "you
  // may" the engine answers for you is not a "you may". Declining is a real play:
  // the exhaust is worth keeping when a second unit is about to land this Showdown.
  //
  // Neither option carries an `instanceId`, deliberately, for the reason Solari
  // Shrine's own note gives: the board renders such an option as the CARD, which
  // is right for "pick one of your units" and wrong for a yes/no.
  "UNL-011-draw": {
    prompt: () => "Fresh Beans: exhaust it to draw 1?",
    options: () => [
      { id: "draw", label: "Exhaust and draw 1" },
      { id: "decline", label: "Decline" },
    ],
    resolve: (state, d, optionId) => {
      if (optionId !== "draw" || !d.cardInstanceId) return state;
      // Exhaust FIRST, then draw: the exhaust is the cost, and `exhaustGear`
      // no-ops on a Fresh Beans that has left play or been spent since the offer —
      // so a state where the cost cannot be paid must not hand over the draw.
      const paid = exhaustGear(state, d.playerIndex, d.cardInstanceId);
      return paid === state ? state : drawCards(paid, d.playerIndex, 1);
    },
  },
  // Katarina - Reckless's "deal 2 to an enemy unit", raised by her facedown-play
  // listener, which has already established that an enemy unit exists.
  //
  // No decline, for the same reason as Vox: no "you may" is printed. EVERY enemy
  // unit is offered, base included — the clause names no battlefield.
  //
  // Rebuilt from live state, so a unit that died while the question waited is not
  // on offer; `dealDamage` also answers safely for an id it cannot find, which is
  // 359.3's "the check returns null and calculations based on it are ignored".
  "UNL-023-shot": {
    prompt: () => "Katarina - Reckless: deal 2 to which enemy unit?",
    options: (state, d) =>
      ownUnitsEverywhere(state, d.playerIndex === 0 ? 1 : 0).map((u) => ({
        id: u.instanceId,
        label: u.name,
        instanceId: u.instanceId,
      })),
    resolve: (state, d, optionId) => dealDamage(state, d.playerIndex, optionId, KATARINA_RECKLESS_DAMAGE),
  },
  // Mischievous Marai's "deal 2 to an enemy unit HERE", raised by her on-play
  // trigger, which has already established that an enemy unit stands there.
  //
  // No decline: no "you may" is printed. Scoped to `d.battlefieldId` — the
  // battlefield she was played to — which is the whole difference from
  // Katarina's shot above, whose clause names no battlefield and therefore
  // offers every enemy unit including the ones in base.
  //
  // Rebuilt from live state, so a unit that died or walked away while the
  // question waited is not on offer; `dealDamage` also answers safely for an id
  // it cannot find (359.3).
  "UNL-003-shot": {
    prompt: () => "Mischievous Marai: deal 2 to which enemy unit here?",
    options: (state, d) =>
      d.battlefieldId === undefined
        ? []
        : enemyUnitsAt(state, d.playerIndex === 0 ? 1 : 0, d.battlefieldId).map((u) => ({
            id: u.instanceId,
            label: u.name,
            instanceId: u.instanceId,
          })),
    resolve: (state, d, optionId) => dealDamage(state, d.playerIndex, optionId, MISCHIEVOUS_MARAI_DAMAGE),
  },
  // Red Brambleback's "[Buff] a friendly unit", raised by his conquer trigger,
  // which has already established that his controller has a unit to buff.
  //
  // NO decline: the card carries no "you may", so once it has triggered the buff
  // has to land. With exactly one candidate `advanceDecisions` executes it without
  // a prompt, which is right — there is no choice to make.
  //
  // "A friendly unit" names no battlefield, so 355.9.a.1's bare noun puts base and
  // battlefields both on offer, and the Brambleback himself is eligible (the text
  // says no "other"). Already-buffed units stay on offer too: 702.3.a makes a
  // second buff a no-op rather than an illegal choice, which is the reading Ivern
  // and Spirit's Refuge both take. Candidates are rebuilt from live state, so a
  // unit killed in the response window is simply not offered.
  "UNL-029-buff": {
    prompt: () => "Red Brambleback: buff a friendly unit",
    options: (state, d) =>
      ownUnitsEverywhere(state, d.playerIndex).map((u) => ({ id: u.instanceId, label: u.name, instanceId: u.instanceId })),
    resolve: (state, _d, optionId) => addBuff(state, optionId),
  },
};

/** Inviolus Vox's pump and Katarina - Reckless's shot — printed numbers, named
 *  beside Draven's so no resolver in this file reads a bare literal. */
const INVIOLUS_VOX_MIGHT = 8;
const KATARINA_RECKLESS_DAMAGE = 2;

/** Tryndamere - Barbarian's three conditions, asked once so `applies` and
 *  `resolve` cannot disagree — the split that has produced a held trigger firing
 *  on a board that no longer qualifies before. */
function tryndamereQualifies(state: GameState, listener: Listener, event: GameEvent): boolean {
  if (event.kind !== "battlefieldConquered") return false;
  if (event.conquerorIndex !== listener.ownerIndex) return false;
  if (listener.battlefieldId !== event.battlefieldId) return false;
  const excess = state.lastShowdownExcessDamage;
  return (
    excess !== null &&
    excess.battlefieldId === event.battlefieldId &&
    excess.attackerIndex === listener.ownerIndex &&
    excess.amount >= TRYNDAMERE_EXCESS_REQUIRED
  );
}

const TRYNDAMERE_EXCESS_REQUIRED = 5;

/** What Draven - Vanquisher's paid Fury buys. */
const DRAVEN_PUMP = 2;

/**
 * Activated abilities contributed by this domain file.
 *
 * **The seam matters more than the contents, and it stood EMPTY until wave 5.**
 * `ACTIVATED_ABILITIES` was module-private in `activated-abilities.ts`, so a
 * domain file could not register an activated ability AT ALL — the wave-1 agents
 * refused UNL-026 and UNL-093 on exactly that, and every future card with a
 * printed "[cost]: do something" would have hit the same wall or been written
 * into the shared file that the fan-out rule keeps agents out of. Vi - Hotheaded
 * is the first card this file registers through it.
 *
 * Merged lazily by `activated-abilities.ts`, through the same `mergeRegistries`
 * that throws on a duplicate defId — so a card registered both here and in the
 * built-in table is a named error at import, not a silent last-write-wins.
 */
export const activatedAbilities: Record<string, ActivatedAbilityDefinition> = {
  "UNL-030": {
    // Vi - Hotheaded — "[Deflect] [2][Fury]: Double my Might this turn."
    //
    // `[Deflect]` is counter-spell.ts's surcharge and belongs nowhere in this file;
    // it is absent from `coverage.UNIMPLEMENTED_KEYWORDS`. The ability is the only
    // clause here.
    //
    // # No exhaust, so it REPEATS while the runes last
    //
    // The printed cost is `:rb_energy_2::rb_rune_fury:` with no `:rb_exhaust:`, and
    // the registry's default is `{ exhaust: true }` — taking the default would have
    // invented a once-per-turn limit the card does not print. Maduli (UNL-141,
    // effects/chaos.ts) and Vi - Destructive are the same shape: bounded by the
    // price, not by a tap. Doubling twice in a turn is therefore legal and is
    // 2×, then 2× again on the already-doubled figure — see the snapshot note.
    //
    // # EFFECTIVE Might, not printed, and it is a SNAPSHOT
    //
    // **432 is Doubling's own rule and it settles both halves.** 432.1: "Doubling
    // is the act of increasing a numeric attribute by an amount equal to that
    // attribute's CURRENT value" — so buffs, this-turn pumps, Equipment badges and
    // positional auras are all part of what is doubled (143.2's statistic), which
    // is Last Stand's reading (OGN-069, effects/calm.ts) and the same
    // `effectiveMight` choke point. And 432.1.a: it "creates an effect that
    // modulates that attribute by that SPECIFIC AMOUNT for the duration specified"
    // — a fixed `+M this turn`, not a live multiplier. So a buff arriving later
    // lands on top rather than being doubled too, and a second activation doubles
    // the already-doubled figure. (The "317" this claim used to be filed under is
    // the Ending Phase and says nothing of the kind.)
    //
    // # DIVERGENCE: `isCombat: false` drops `[Assault]`/`[Shield]`
    //
    // 807.1.c makes `[Assault]` short for "While I am an attacker, I have +X [M]"
    // and 814.1.c makes `[Shield]` "While I am a defender, I have +X [M]" — they
    // are MIGHT, not damage-side adjustments, and 432.1's worked example is this
    // exact instruction: "A unit with 3 base Might and Shield 2 is in combat as a
    // Defender. Since Shield applies, its current Might is 5 ... it gets +5 Might
    // this turn." This engine models both keywords as combat-role terms that only
    // apply under `ctx.isCombat`, so a Vi activated while defending with a granted
    // `[Shield]` doubles 3 rather than 5.
    //
    // Kept rather than fixed for ONE card: Last Stand is the pool's other doubler
    // and reads it the same way, and two answers to one question is the worse
    // failure. Faithful would be `{ isCombat: true, isAttackingSide, combatRole:
    // "remaining" }` derived from `attackerIndexAt`, which is the shape that gives
    // an attacker its Assault and a defender its Shield. Reported for
    // docs/rules-conformance.md and PINNED in test/unl-fury-wave5.test.ts, which
    // asserts the wrong figure on a defending, Shielded Vi — so closing it (for
    // both cards) fails loudly.
    //
    // `effectiveMight` already clamps at 0 (**143.2.b**: a Might below 0 is treated
    // as 0 when referenced), so a debuffed Vi doubles to nothing rather than to a
    // negative pump. 477.3.c agrees from the other side — "players cannot increase
    // a numeric attribute by a negative amount ... they increase it by 0 instead" —
    // and works Last Stand as its example. Nothing here has to floor it again.
    //
    // # Where she is read from
    //
    // "My Might" carries no location word, so she is found through
    // `findUnitAnywhere` and the ability is offered in base as well as at a
    // battlefield — `activateAbilityCandidates` walks both zones. The battlefield
    // is passed into the `MightContext` when she is at one, because positional
    // auras (Garen - Commander) are part of the figure being doubled.
    //
    // No `availableWhile`: the card prints no restriction on activating, and a Vi
    // at 0 Might who pays for nothing is the player's business — what a cost has to
    // be is payable, not worthwhile.
    kind: "Unit",
    cost: { energy: 2, power: { domain: "Fury", count: 1 } },
    targeting: { kind: "none" },
    resolve: (state, _ctx, _event, sourceInstanceId) => {
      const location = findUnitAnywhere(state, sourceInstanceId);
      // She can be killed between the ability being finalized and resolving, and
      // there is then nothing to double: **359.3.e.12** — a check on "a card or
      // permanent whose location, zone, or status has changed such that that
      // information is no longer available ... returns 'null' and all calculations
      // based on it are ignored", with "a unit that is no longer on the board is
      // treated as having null Might" as its own first example.
      if (!location) return state;
      return giveMightThisTurn(
        state,
        sourceInstanceId,
        effectiveMight(state, location.unit, location.ownerIndex, unitMightContext(state, location)),
      );
    },
  },
};

/** The `MightContext` for a unit `findUnitAnywhere` just located — the
 *  base-vs-battlefield branch that calm.ts and mind.ts each write out for the same
 *  reason. Positional auras (Garen - Commander) resolve "base" from the omitted
 *  field. Duplicated rather than imported because those copies are module-private
 *  to files this one does not own. */
function unitMightContext(state: GameState, location: AnyUnitLocation): { isCombat: false; battlefieldId?: string } {
  return location.zone === "base"
    ? { isCombat: false }
    : { isCombat: false, battlefieldId: state.battlefields[location.zone.battlefieldIndex]!.id };
}


/**
 * Continuous Might modifiers contributed by this domain file.
 *
 * The seam `effective-might.ts` had no equivalent of until 2026-08-09: every
 * conditional or scaling Might card had to be hand-added to that shared file,
 * which the fan-out rule keeps parallel agents out of — so three cards were
 * refused across two waves rather than written.
 *
 * Keyed by defId. A SELF bonus tests `unit.defId`; an AURA tests the board for
 * its source and ignores it. `bonus` is called for every unit on every
 * evaluation, so it must be pure and cheap.
 *
 * A `[Level N]` bonus belongs HERE and not in an on-play trigger: 824.1.d turns
 * the ability off again the moment XP drops below N, so a one-shot pump is wrong
 * in both directions.
 */
/** Scorchclaw — "[Hunt 2][Level 3][>] I have +1 Might and enter ready." */
const SCORCHCLAW = "UNL-016";
const SCORCHCLAW_LEVEL = 3;
const SCORCHCLAW_MIGHT = 1;

/** Prepared Neophyte — "If you've spent [4] or more to play a spell this turn, I
 *  have +4 [Might]." His whole printed text. */
const PREPARED_NEOPHYTE = "UNL-004";
const NEOPHYTE_SPELL_ENERGY = 4;
const NEOPHYTE_MIGHT = 4;

export const mightModifiers: Record<string, MightModifier> = {
  // Scorchclaw's `[Level 3]` Might half, and ONLY that half.
  //
  // **His "and enter ready" is NOT implemented and is not implementable from this
  // file.** "I enter ready" is a REPLACEMENT for how a unit arrives, and every one
  // in this engine lives in `deploy.conditionalEntersReady` — a shared file. Its
  // own comment rejects the workaround explicitly, and three agents reached that
  // conclusion independently before it was written down: an on-play `readyUnit`
  // would leave him EXHAUSTED through the whole held-trigger response window, would
  // fire `unitReadied` (paying out Pirate's Haven for a readying the rules say
  // never happened), and would be blockable by Mageseeker Warden. So half of this
  // card is written, deliberately, and `test/unl-fury-wave3.test.ts` pins the
  // missing half by asserting he still enters exhausted at 3 XP.
  //
  // His `[Hunt 2]` is the keyword machinery's (triggers.ts's HUNT_TRIGGER_KEY) and
  // is already live; nothing about it belongs here.
  //
  // The Might half is CONTINUOUS, not latched: 824.1.b.1 makes `[Level 3][>]`
  // functionally "While you have 3 or more XP, this card gains [Text]", and
  // 824.1.d makes it Inactive again "as soon as the controlling player has less
  // than [N] XP" — so spending the XP takes the +1 straight back off. Read from the
  // OWNER's counter, since `effectiveMight` is called by both sides.
  //
  // `unit.defId` is tested because every registered modifier is asked about every
  // unit on every evaluation; without it this would buff the whole board.
  [SCORCHCLAW]: {
    defId: SCORCHCLAW,
    bonus: (state, unit, ownerIndex) =>
      unit.defId === SCORCHCLAW && state.players[ownerIndex].xp >= SCORCHCLAW_LEVEL ? SCORCHCLAW_MIGHT : 0,
  },
  // Prepared Neophyte — "If you've spent [4] or more to play a spell this turn,
  // I have +4 [Might]."
  //
  // **Refused across two waves for a counter that did not exist**, and the
  // refusals were exact: `PlayerState` carried `powerSpentThisTurn` and nothing
  // about Energy spent on a spell. `maxSpellEnergySpentThisTurn` is that counter,
  // and it answers UNL-089 Jhin's identical sentence too — which is why it is a
  // field rather than something derived here.
  //
  // CONTINUOUS, like every entry in this table and for the same reason: the
  // condition is a fact about the turn, so it turns on the moment a big spell is
  // paid for and off again when the turn ends. A one-shot pump would be wrong in
  // both directions.
  //
  // A MAXIMUM over single spells, not a total — see the field's own note. Two
  // 2-Energy spells do not make a 4.
  [PREPARED_NEOPHYTE]: {
    defId: PREPARED_NEOPHYTE,
    bonus: (state, unit, ownerIndex) =>
      unit.defId === PREPARED_NEOPHYTE &&
      state.players[ownerIndex].maxSpellEnergySpentThisTurn >= NEOPHYTE_SPELL_ENERGY
        ? NEOPHYTE_MIGHT
        : 0,
  },
};
