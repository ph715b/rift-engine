import type { EffectDefinition } from "../card-effects.js";
import type { MightModifier } from "../effective-might.js";
import type { ActivatedAbilityDefinition } from "../activated-abilities.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
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
  banishCard,
  recycleTopCard,
  banishUnitFromPlay,
  burn,
  burnCards,
  canSpendXp,
  channelRunesExhausted,
  dealDamage,
  destroyUnit,
  discardCards,
  discardThenDraw,
  drawCards,
  forceMoveToBattlefield,
  forceMoveToDestination,
  gainXp,
  giveMightThisTurn,
  giveMightThisTurnToOwnUnit,
  grantKeywordThisTurn,
  holdCardsRecycled,
  grantTemporary,
  ownUnitsEverywhere,
  payPowerFromChanneled,
  payEnergyFromPool,
  recordModeUsed,
  exhaustGear,
  exhaustOwnUnitAnywhere,
  readyUnit,
  recallUnitToBase,
  returnCardFromTrash,
  returnPermanentToHand,
  returnUnitToHand,
  spendXp,
  stunUnits,
  swapUnitLocations,
  takeOneFromTopAndRecycleRest,
  takeControlOfUnit,
} from "../effect-helpers.js";
import { eligibleTargets, findUnitAnywhere, ownerIndexOf, unitWithinMaxMight, type UnitZone } from "../target-lookup.js";
import { effectiveTagsOf } from "../equipment.js";
import { findUnitOnBattlefield } from "../target-lookup.js";
import { empowerPermanent } from "../effect-helpers.js";
import { SHADOW_CLONE_TOKEN_DEF_ID } from "../constants.js";
import type { PendingDecision } from "../../model/game-state.js";
import { grantReplacedCostPlay } from "../replaced-costs.js";
import { cardModeOf } from "../card-effects.js";
import { effectiveMight } from "../effective-might.js";
import { attackerIndexAt, attackingUnitsAt, isAttackingAt, isDefendingAt, isFightingAt } from "../combat-designation.js";
import { killGear } from "../triggers.js";
import { playUnitToBase, playUnitToBattlefield } from "../deploy.js";
import { applyContested } from "../cleanup.js";
import { playUnitFree } from "../free-play.js";
import { playCardIgnoringCost } from "../play-free.js";
import { RAINBOW } from "../hidden.js";
import { placeGoldTokens, placeToken, type TokenDestination, type TokenSpec, BIRD_TOKEN, SHADOW_CLONE_TOKEN, TENTACLE_TOKEN } from "../token.js";
import { offerTopOfDeckBanish } from "../top-of-deck.js";
import { parkDecision, repeatDecision, type DecisionOption } from "../decisions.js";
import { mayMoveToBaseFrom, mayPlayUnitAt } from "../battlefield-continuous.js";
import { counterSpell, spellsOnChain } from "../counter-spell.js";
import type { GameState, PlayerState } from "../../model/game-state.js";
import type { CardInstance, UnitInstance } from "../../model/card.js";
import { gainPoints } from "../effect-helpers.js";
import { recordBanishedWithGear, unitsBanishedWith, wearerListener } from "../equipment.js";
import { modifiedEnergyCost } from "../cost-modifiers.js";
import { canonicalDefId } from "../../cards/card-loader.js";
import { allPrintedTags, namedTagOf, setNamedTag, unitsWithTag } from "../named-tag.js";

/**
 * Card implementations for **Chaos** — one file, one owner.
 *
 * This file exists so that work on the card pool can be split up without two
 * people (or two agents) ever editing the same file. The ownership rule is
 * mechanical, not a convention: a defId may only appear here if its
 * CardDefinition has exactly one domain and that domain is Chaos. A test in
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
/** Hard Bargain's ransom — "unless its controller pays [2]". */
const HARD_BARGAIN_RANSOM = 2;

/**
 * Conscription's un-upgraded ceiling — "an enemy unit at a battlefield with 3
 * [Might] or less". Named because the upgraded reading ("any enemy unit at a
 * battlefield") is what the unwritten XP additional cost buys, and the two must
 * not be confused when it lands.
 *
 * Declared ABOVE `cardEffects` rather than beside the card's other constants at
 * the foot of the file, and that is load-bearing: it is read by a `targeting`
 * spec, which is evaluated as the object literal is built at module load. A
 * `const` below would still be in its temporal dead zone and the import would
 * throw. Every other numeric constant here is read inside a `resolve`/`options`
 * closure, which runs long afterwards.
 */
const CONSCRIPTION_MAX_MIGHT = 3;

/**
 * The key Maduli the Gatekeeper's destination question is registered under.
 *
 * Up HERE for the same reason `CONSCRIPTION_MAX_MIGHT` is: it is a COMPUTED KEY
 * in the `decisions` literal, evaluated as that object is built at module load,
 * so a `const` declared next to the ability that parks it would still be in its
 * temporal dead zone. Measured — `tsc` names it (TS2448) rather than leaving it
 * to fail at import.
 */
const MADULI_MOVE = "UNL-144-move";

/**
 * Baron Nashor, whose third sentence is the `mightModifiers` entry at the foot of
 * this file.
 *
 * Up HERE for the third time in this file and for the reason `MADULI_MOVE` and
 * `CONSCRIPTION_MAX_MIGHT` both are: it is a COMPUTED KEY in the `mightModifiers`
 * literal AND that entry's `defId`, both evaluated as the object is built at
 * module load, so a `const` declared beside the entry would still be in its
 * temporal dead zone and the import would throw.
 */
const BARON_NASHOR = "UNL-147";

/** Mask Mother's toll and what it buys. */
const MASK_MOTHER_ENERGY = 1;
const MASK_MOTHER_MIGHT = 2;
/** Shadow Order Disciple's Burn and its pump. */
const DISCIPLE_BURN = 1;
const DISCIPLE_MIGHT = 1;
/** Shadowblade Lurker's discount PER copy of his name in the trash. */
const LURKER_DISCOUNT_PER_COPY = 2;
/** Spiderling's bonus per OTHER Spiderling here. */
const SPIDERLING_MIGHT_PER_SIBLING = 1;
/** Shadows of the Past returns up to this many units from trashes. */
const SHADOWS_OF_THE_PAST_MAX = 2;
/** The Might ceiling both Twilight Step and Wind and Ghosts print. */
const TWILIGHT_STEP_MAX_MIGHT = 3;
const WIND_AND_GHOSTS_MAX_MIGHT = 3;
/** Forgotten Relic's Burn. */
const FORGOTTEN_RELIC_BURN = 1;
/** The questions this file's Vendetta cards park. */
const MASK_MOTHER_PUMP = "VEN-094-pump";
const DISCIPLE_BURN_OFFER = "VEN-095-burn";
const SHADOWS_OF_THE_PAST_PICK = "VEN-103-pick";
const FORGOTTEN_RELIC_GIVE = "VEN-108-give";
const PREFECT_BANISH = "VEN-102-banish";
const MINAH_MODE = "VEN-111-mode";
/** Up from the Deep plays this many Tentacles. */
const UP_FROM_THE_DEEP_TENTACLES = 2;

/** Mel, Defiant Soul's "banish an enemy unit at a battlefield with 3 [Might] or
 *  less", and the question that chooses it — written once because the trigger
 *  that parks it and the entry that answers it must agree, and a typo in either
 *  is SILENT: a definition keyed to a kind nobody parks simply never runs. */
const MEL_DEFIANT_MAX_MIGHT = 3;
const MEL_DEFIANT_BANISH = "VEN-110-banish";

/**
 * The units Mel, Defiant Soul may banish — enemy, AT A BATTLEFIELD, 3 Might or
 * less.
 *
 * Its own function because BOTH the trigger's `applies` and the decision's
 * `options` ask it, and those two disagreeing is how a response window opens on
 * an ability with nothing to do (or worse, a question with no answers). Read live
 * at each site rather than captured, since the board moves while a held trigger
 * waits on the chain.
 *
 * `eligibleTargets` with the default `"battlefield"` scope is the printed "at a
 * battlefield" (355.9.b, the NARROWING half), and `unitWithinMaxMight` is the
 * shared EFFECTIVE-Might predicate (143.2) every other "N Might or less" in the
 * pool uses — so a unit pumped in the response window walks out of range.
 */
function melBanishCandidates(state: GameState, ownerIndex: 0 | 1): UnitInstance[] {
  return eligibleTargets(state, ownerIndex, "enemy").filter((u) =>
    unitWithinMaxMight(state, u, MEL_DEFIANT_MAX_MIGHT),
  );
}
/** Decree of Discord's TOTAL Might ceiling across the whole chosen set. */
const DECREE_OF_DISCORD_MAX_TOTAL = 5;
/** Illaoi's bonus per TOKEN unit you control. */
const ILLAOI_MIGHT_PER_TOKEN = 1;
/** Gust Monk's grant, bought by banishing a card from any trash. */
const GUST_MONK_ASSAULT = 2;
/** Kennen, Storm of Shuriken's on-play Burn. */
const KENNEN_SHURIKEN_BURN = 2;
/** Tornado Warrior's and the rest of wave 2's questions. */
const GUST_MONK_BANISH = "VEN-101-banish";
const TORNADO_EMPOWER = "VEN-099-empower";
const KENNEN_SHURIKEN_FLOW = "VEN-113-flow";
const OCEAN_DRAKE_BOUNCE = "VEN-115-bounce";
const ZED_SILENT_SWAP = "VEN-112-swap";
const GUST_MONK_GRANT = "VEN-101-grant";

export const cardEffects: Record<string, EffectDefinition> = {
  "VEN-107": {
    // Decree of Discord — "Return any number of enemy Order ([Order]) units with
    // TOTAL Might 5 or less to their owners' hands."
    //
    // Three narrowings on one spec, and all three are printed: `owner: "enemy"`,
    // `domain: "Order"`, and `maxTotalMight: 5` — a SUM across the chosen set,
    // not a per-unit ceiling, which is what makes this a sweep of small bodies
    // rather than removal for one medium one.
    //
    // "Any number" is `min: 0` with no `max`, so the empty choice is legal and the
    // card is castable into a board it can do nothing to. That is the printed
    // reading and it is what `min: 0` means everywhere else here.
    //
    // The domain filter is enforced in `unitListChoiceError`, the one function the
    // enumerator and the validator BOTH go through — the enumerate/execute split
    // this codebase has shipped six bugs into.
    // **`scope: "anywhere"`, added 2026-08-23 by the sweep that followed
    // Rampage.** "Return any number of enemy Order units with total Might 5 or
    // less to their owners' hands" names no location — the only narrowings
    // printed are the DOMAIN and the total Might — so 355.9.a.1's widening
    // applies and an enemy Order unit in their base is returnable. Omitting the
    // scope silently confined it to battlefields, which for a "return any
    // number" effect is a materially smaller card.
    targeting: {
      kind: "unitList",
      min: 0,
      owner: "enemy",
      domain: "Order",
      maxTotalMight: DECREE_OF_DISCORD_MAX_TOTAL,
      scope: "anywhere",
    },
    resolve: (state, _ctx, event) =>
      (event.targetUnitInstanceIds ?? []).reduce((next, id) => returnUnitToHand(next, id), state),
  },
  "VEN-100": {
    // Up from the Deep — "Play two 1 [Might] Tentacle unit tokens from
    // Bilgewater. [Flow] [3 Energy]."
    //
    // Two tokens at ONE chosen destination, which is `TOKEN_PLACEMENT_SPELL_DEF_IDS`'
    // shape: 185.2.a plays a token "following all the applicable steps for playing
    // a card", and the inherent restriction on playing a Unit is base or a
    // battlefield you control. Recruit the Vanguard's four and Flurry of Feathers'
    // four both land together, and this card prints no per-token split either.
    //
    // `TENTACLE_TOKEN` is shared from token.ts rather than kept local, even though
    // both makers are in this file — Illaoi's second clause COUNTS token units, so
    // a second copy of the spec would be a second place the Might could drift from
    // the thing counting it.
    targeting: { kind: "none" },
    resolve: (state, ctx, event) => {
      const destination: TokenDestination =
        event.destinationBattlefieldId !== undefined ? { battlefieldId: event.destinationBattlefieldId } : "base";
      let next = state;
      for (let i = 0; i < UP_FROM_THE_DEEP_TENTACLES; i += 1) {
        next = placeToken(next, ctx.casterIndex, destination, TENTACLE_TOKEN);
      }
      return next;
    },
  },
  "VEN-103": {
    // Shadows of the Past — "Return UP TO 2 units from TRASHES to their owners'
    // hands."
    //
    // # "Trashes", plural, is the whole card
    //
    // Both players' trashes, and each unit goes to ITS OWNER's hand — so this can
    // hand an opponent their own dead champion back, which is the cost of
    // reaching into two graveyards with one spell. A version that read only the
    // caster's trash would be a strictly better and different card.
    //
    // # A decision rather than a TargetingSpec, and the reason is structural
    //
    // Every `TargetingSpec` kind names things ON THE BOARD; a card in a trash has
    // no `UnitInstance` in play to enumerate against, and `targetUnitInstanceId`
    // is validated by a board walk. Morbid Return and Annie - Stubborn both reach
    // a trash through `trashCardInstanceId`, which carries ONE card — and this
    // needs two, from either side.
    //
    // So it is a repeated question: `count` carries how many returns are still
    // owed, exactly as the generic discard question carries how many cards are.
    // "UP TO" means the decline is always available and ends the sequence.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      parkDecision(state, { kind: SHADOWS_OF_THE_PAST_PICK, playerIndex: ctx.casterIndex, count: SHADOWS_OF_THE_PAST_MAX }),
  },
  "VEN-106": {
    // Wind and Ghosts — "[Action] Choose a unit at a battlefield. If it has 3
    // [Might] or less, BANISH it. Otherwise, return it to its owner's hand."
    //
    // **One target, two outcomes, and the branch is not optional** — so unlike a
    // modal card there is nothing to choose but the unit. That makes it removal
    // against anything small and a tempo play against anything big, which is the
    // card.
    //
    // The Might is read at RESOLUTION and through `effectiveMight`, so an aura or
    // a this-turn pump can lift a unit out of banish range in the response window
    // an `[Action]` opens. Non-combat context: `[Assault]`/`[Shield]` do not count,
    // the reading every Might threshold in this pool takes.
    //
    // **BANISH is not a kill**, so no `[Deathknell]` fires and nothing that
    // watches deaths pays out — which is exactly why the small half is the
    // stronger one. `banishCard` reaches a unit in play through the same funnel.
    //
    // "At a battlefield" is printed, so `scope: "battlefield"` — 355.9.b's
    // narrowing. A unit in base is not a legal choice.
    targeting: { kind: "unit", scope: "battlefield" },
    resolve: (state, _ctx, event) => {
      const targetId = event.targetUnitInstanceId;
      if (!targetId) return state;
      const found = findUnitAnywhere(state, targetId);
      // 359.3.e.12 — a check on something no longer available returns null.
      if (!found) return state;
      return unitWithinMaxMight(state, found.unit, WIND_AND_GHOSTS_MAX_MIGHT)
        ? banishUnitFromPlay(state, targetId)
        : returnUnitToHand(state, targetId);
    },
  },
  "VEN-105": {
    // Twilight Step — "Move a unit with 3 [Might] or less. [Flow] [4 Energy][Chaos]."
    //
    // Charm's shape (OGN-043) with a Might ceiling and no owner: "a unit" is
    // either player's (355.9.a.1), so this both repositions your own and drags an
    // enemy out of a battlefield they were holding.
    //
    // The MOVE needs a destination as well as a target, which rides on
    // `destinationBattlefieldId` — a place rather than a second target, the split
    // `MOVE_TARGET_SPELL_DEF_IDS` records. That table is where this card is
    // registered for the enumerator; the resolver below only performs it.
    //
    // `maxMight` is a spec filter rather than a resolver check, for the reason
    // `attackingOnly` records: by the time a resolver runs the choice is made and
    // paid for, and for a Spell the targeting IS the effect — a board with only
    // big units must make this UNCASTABLE rather than castable-and-inert.
    targeting: { kind: "unit", scope: "anywhere", maxMight: TWILIGHT_STEP_MAX_MIGHT },
    resolve: (state, _ctx, event) => {
      const targetId = event.targetUnitInstanceId;
      if (!targetId) return state;
      return forceMoveToDestination(state, targetId, event);
    },
  },
  "SFD-135": {
    // Factory Recall — "[Action] Return a gear to its owner's hand."
    //
    // "A GEAR", unqualified, so it reaches EITHER side — which is what makes a
    // 1-Energy spell worth a card: it answers an enemy Equipment as readily as it
    // rescues your own from a board wipe.
    //
    // A `gear`-kind target rather than `unitOrGear`: the card names a gear and
    // nothing else, and the narrower spec is what stops a unit being offered and
    // then refused.
    //
    // "To its OWNER's hand" is what `returnPermanentToHand` already does — it
    // locates the permanent on either side rather than assuming the caster owns
    // it, which is exactly the case this card creates.
    targeting: { kind: "gear" },
    resolve: (state, _ctx, event) =>
      event.targetPermanentInstanceId ? returnPermanentToHand(state, event.targetPermanentInstanceId) : state,
  },
  "OGN-203": {
    // Possession — "Choose an enemy unit at a battlefield. Take control of it and
    // recall it."
    //
    // The pool's first change of a UNIT's controller. In this engine control IS
    // which player's list the unit sits in, so taking it and recalling it are one
    // operation — see `takeControlOfUnit`.
    //
    // "AT A BATTLEFIELD" is printed, so the default scope stands and a unit
    // sitting in the opponent's base is safe from it. At 8 Energy and 3 Power
    // that restriction is most of what keeps the card honest.
    targeting: { kind: "unit", owner: "enemy" },
    resolve: (state, ctx, event) =>
      event.targetUnitInstanceId ? takeControlOfUnit(state, event.targetUnitInstanceId, ctx.casterIndex) : state,
  },
  "OGN-173": {
    // Ride The Wind — "[Action] Move a friendly unit and ready it."
    //
    // The destination rides on `destinationBattlefieldId`, which is only
    // enumerated for cards named in card-effects.ts's MOVE_TARGET_SPELL_DEF_IDS
    // (`cardMovesTarget`) — without that entry this resolver would always be
    // handed `undefined` and the card would be castable, inert and reported as
    // done. It is the third card in that set, after Charm and Showstopper.
    //
    // `scope: "anywhere"`, not the default: "a friendly unit" is 355.9.a.1's bare
    // noun, so a unit in base is a legal choice — and it is the main one, since
    // this is how the card deploys. Charm's "an ENEMY unit" is the contrast.
    //
    // MOVE then READY, printed order. It matters: moving into a contested
    // battlefield is what opens the Showdown, and arriving ready is what lets the
    // unit fight in it. Readying first and moving second reaches the same board,
    // but through a state the card does not describe.
    //
    // `forceMoveToBattlefield` rather than a list splice, because the move must
    // apply Contested and stage the Showdown — the same funnel Charm uses. Note
    // this is a MOVE, so it is exactly the kind [Ganking] and the move validator
    // constrain for a player-initiated MoveUnit; a spell moving a unit is not
    // subject to those, which is what makes the card worth casting.
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, ctx, event) => {
      const { targetUnitInstanceId: unitId } = event;
      if (!unitId) return state;
      // "Move a friendly unit AND READY IT" — the ready happens whichever
      // Location it went to, including base (359.3.e names this card's base
      // move by example). Readying after the move, printed order.
      return readyUnit(forceMoveToDestination(state, unitId, event, ctx.casterIndex), unitId);
    },
  },
  "OGN-172": {
    // Rebuke — "[Action] Return a unit at a battlefield to its owner's hand."
    //
    // "AT A BATTLEFIELD" is printed, so the default battlefield scope is right
    // and `scope: "anywhere"` would be wrong: a unit sitting in base is out of
    // reach, which is the whole limit on the card. That distinction is
    // load-bearing here and this codebase has got it wrong before.
    //
    // No owner restriction — "a unit", not "an enemy unit". Bouncing your own is
    // a real line (it resets damage and saves a unit about to die), not an
    // oversight, and 355.9.a.1's bare noun carries no side.
    //
    // returnUnitToHand sends it to its OWNER's hand rather than the caster's,
    // and strips Buffs on the way (709, "if a Unit leaves play, remove all Buffs
    // from it") — both already handled there, which is why this is one call.
    targeting: { kind: "unit" },
    resolve: (state, _ctx, event) => (event.targetUnitInstanceId ? returnUnitToHand(state, event.targetUnitInstanceId) : state),
  },
  "SFD-129": {
    // Temptation — "[Repeat] [2] Move an enemy unit to a location where there's
    // a unit with the same controller."
    //
    // Charm's move with the pool's first RESTRICTED destination. "The same
    // controller" is the MOVED unit's controller, not the caster's — the card
    // lures an enemy unit toward its own friends rather than toward yours, which
    // is what makes it a tempo card instead of a gift. See
    // `moveDestinationAllowed`, which the enumerator and the validator both ask.
    //
    // The moved unit does not count as the unit that is already there: it is not
    // at the destination yet, and counting it would make every destination legal
    // and the restriction meaningless.
    //
    // `scope: "anywhere"` — "an enemy unit" is 355.9.a.1's bare noun, so one
    // sitting in the enemy base is a legal target, and dragging it out is a real
    // line.
    //
    // **DIVERGENCE, pre-existing and shared**: the rules make a BASE a legal
    // destination for a spell's move (198.1 "Locations include the Battlefields and
    // the Bases", and 1442 works the example with Ride The Wind moving a unit "to
    // base"). This engine's `destinationBattlefieldId` carries only a
    // battlefield, so Charm, Showstopper, Ride The Wind, Stormbringer and
    // Dragon's Rage are all already battlefield-only, and this card joins them.
    // Recorded in docs/rules-conformance.md rather than half-fixed here, because
    // closing it changes five existing cards' enumeration.
    targeting: { kind: "unit", owner: "enemy", scope: "anywhere" },
    resolve: (state, ctx, event) => {
      const { targetUnitInstanceId: unitId } = event;
      if (!unitId) return state;
      // Through the shared destination helper like every other move: arriving at
      // a BATTLEFIELD applies Contested and can stage a Showdown the caster is
      // not part of, which for this card is frequently the entire point. A move
      // to BASE contests nothing — there is nothing there to contest — which is
      // why the card's own word is "location" and not "battlefield".
      return forceMoveToDestination(state, unitId, event, ctx.casterIndex);
    },
  },
  "SFD-136": {
    // Hard Bargain — "[Reaction] [Repeat] [2] Counter a spell unless its
    // controller pays [2]."
    //
    // Wind Wall's targeting with Shakedown's second half: the CASTER picks the
    // spell, and then the spell's CONTROLLER picks the poison — pay 2 Energy, or
    // be countered. So the target is an ordinary `chainSpell` fan-out on the
    // action and the ransom is a decision belonging to the other seat.
    //
    // No cost filter — unlike Defy, the card names none, so any spell on the
    // chain is a legal target including the caster's own. Countering your own
    // spell to dodge something worse is a real (if rare) line, and nothing in the
    // text forbids it; the decision then simply belongs to the caster.
    //
    // The controller is read from the CHAIN ENTRY when the question is raised and
    // travels on the decision, the same reasoning Shakedown records: by the time
    // it is answered the chain has moved.
    //
    // **Repeating it is a DOUBLE ransom, not a double counter, and that falls out
    // of the ordering rather than being arranged.** Both executions run back to
    // back inside one resolution (820.1.d) and decisions are answered afterwards,
    // so two ransom questions are queued against the same spell. Answering the
    // first by paying leaves the spell on the chain for the second to ask again —
    // 2 Energy, then 2 more. Answering the first by declining counters it, and
    // the second question then finds nothing to counter and resolves to nothing.
    // That second case is why the decision re-checks the chain at ANSWER time
    // instead of trusting that its target still exists (359.3).
    targeting: { kind: "chainSpell" },
    resolve: (state, _ctx, event) => {
      const spellId = event.targetChainCardInstanceId;
      if (!spellId) return state;
      const target = spellsOnChain(state).find((s) => s.entry.card.instanceId === spellId);
      if (!target) return state; // already countered — 359.3
      return parkDecision(state, {
        kind: "SFD-136-ransom",
        playerIndex: target.entry.playerIndex,
        cardInstanceId: spellId,
      });
    },
  },
  "SFD-122": {
    // Called Shot — "[Action] [Repeat] [Chaos] Look at the top 2 cards of your
    // Main Deck. Draw one and recycle the other."
    //
    // Stacked Deck (OGN-183, below) at 2 instead of 3. "Draw one" and "put 1
    // into your hand" are the same instruction, so it is the same helper —
    // `takeOneFromTopAndRecycleRest` — and a decision for the same forced
    // reason: `legal-actions` enumerates from PUBLIC state and the top of a deck
    // is not public, so fanning the choice onto the action would hand the AI its
    // own deck order.
    //
    // **Repeating this parks a SECOND decision**, and that is correct rather
    // than incidental. Both executions run back to back inside one resolution
    // (820.1.d), each parking its own question; `parkDecision` mints a fresh id
    // per call and appends FIFO, so the two are distinct queue entries answered
    // in order. The second decision's options are rebuilt from LIVE state when
    // it is answered, so it names the top 2 cards as they stand AFTER the first
    // draw-and-recycle — not a stale snapshot taken during resolution. That is
    // the whole reason `DecisionDefinition.options` is a function of state.
    //
    // Its Repeat cost is `[Chaos]` with NO Energy, the only such cost in the
    // set, which is why Marai Spire's Energy discount cannot touch it — see
    // `modifiedRepeatEnergy`'s floor.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      // Nocturne's offer first, for the reason Reinforce's own resolve gives.
      parkDecision(offerTopOfDeckBanish(state, ctx.casterIndex, state.players[ctx.casterIndex].deck.slice(0, 2)), {
        kind: "SFD-122-keep",
        playerIndex: ctx.casterIndex,
      }),
  },
  "OGN-183": {
    // Stacked Deck — "Look at the top 3 cards of your Main Deck. Put 1 into your
    // hand and recycle the rest."
    //
    // A decision rather than a fan-out on the action, and that is forced rather
    // than chosen: legal-actions enumerates from PUBLIC state, and the top of a
    // deck is not public. Fanning it out would put the three card identities
    // into the action list, which the AI reads — handing it knowledge of its own
    // deck order that a human casting the same spell would only learn on
    // resolution.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      // Nocturne's offer first, for the reason Reinforce's own resolve gives.
      parkDecision(offerTopOfDeckBanish(state, ctx.casterIndex, state.players[ctx.casterIndex].deck.slice(0, 3)), {
        kind: "OGN-183-keep",
        playerIndex: ctx.casterIndex,
      }),
  },
  "OGN-180": {
    // Fading Memories — "Give a unit at a battlefield or a gear [Temporary]."
    //
    // The only card in the pool that targets across two kinds of permanent, which
    // is why `unitOrGear` exists as its own targeting kind and why the choice
    // rides on `targetPermanentInstanceId`: handing a gear to anything that reads
    // `targetUnitInstanceId` would be a type error waiting to be a runtime one.
    //
    // "A unit AT A BATTLEFIELD" — base units are out, unlike the many cards that
    // just say "a unit". Gear has no such restriction; it lives in base by
    // definition, and the clause plainly doesn't apply to it.
    //
    // Rule 816 does the rest: the thing dies at the start of ITS CONTROLLER's
    // next Beginning Phase, before scoring. Aimed at an enemy that is delayed
    // removal; aimed at your own it is a sacrifice you have a turn to use.
    targeting: { kind: "unitOrGear" },
    resolve: (state, _ctx, event) =>
      event.targetPermanentInstanceId ? grantTemporary(state, event.targetPermanentInstanceId) : state,
  },
  "OGN-168": {
    // Fight or Flight — "[Hidden][Action] Move a unit from a battlefield to its
    // base." Either player's: the text names no owner, so this is removal as
    // often as it is rescue.
    //
    // recallUnitToBase, not relocateToBaseUnchanged: "move ... to its base" is a
    // Move, so the unit arrives exhausted and move triggers see it. Rule 454's
    // distinction — a Recall is NOT a Move — is why the two helpers exist, and
    // picking the wrong one here would silently make this card better than
    // printed.
    //
    // Scope is battlefield-only ("from a battlefield"), which also means that
    // played from Hidden the only legal targets are the ones standing at that
    // battlefield — enforced by legal-actions, not here.
    targeting: { kind: "unit" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId ? recallUnitToBase(state, event.targetUnitInstanceId) : state,
  },
  "OGN-179": {
    // Acceptable Losses — "[Action] Each player kills one of their gear."
    //
    // Cull the Weak (OGN-209, effects/order.ts) with gear in place of units, and
    // it is the same card structurally: no targeting spec, because the caster
    // does not pick two victims — each player picks their OWN, at resolution,
    // through engine/decisions.ts. Fanning the choice onto the action would also
    // commit it at cast time, and the opponent may respond on the chain in
    // between; "one of their gear" means the gear they still have when this
    // resolves.
    //
    // APNAP by rule 894 ("Turn Order is referenced to organize the sequence of
    // actions, starting with the current Turn Player"), which the FIFO decision
    // queue implements for free: the order the questions are parked in is the
    // order they are answered in.
    targeting: { kind: "none" },
    resolve: (state) => askInTurnOrder(state, "OGN-179-kill", state.activePlayerIndex),
  },
  "OGN-187": {
    // Whirlwind — "Starting with the next player, each player may return a unit
    // to its owner's hand."
    //
    // "Starting with the NEXT player" is an explicit override of rule 894's
    // default, which sequences simultaneous actions "starting with the current
    // Turn Player" — so this is the one card in the pool that runs APNAP
    // backwards, and the non-turn player answers first. That difference is the
    // whole reason the card names an order at all, and it is real in play: the
    // opponent has to commit before you do.
    //
    // Anchored on `activePlayerIndex` rather than the caster because "next" is
    // defined against TURN ORDER (175/179), not against whoever is resolving.
    // The two coincide here anyway — Whirlwind prints neither [Action] nor
    // [Reaction], so only the turn player can ever cast it.
    //
    // "A unit", not "a unit at a battlefield" — 355.9.a.1's bare noun, so a unit
    // sitting in either base is on offer too. Rebuke (above) prints the narrower
    // wording and gets the narrower reach; the difference between them is
    // printed, and this codebase has got that distinction wrong before.
    targeting: { kind: "none" },
    resolve: (state) => askInTurnOrder(state, "OGN-187-return", (1 - state.activePlayerIndex) as 0 | 1),
  },
  "OGN-201": {
    // Invert Timelines — "Each player discards their hand, then draws 4."
    //
    // Not a decision, and that is the point: discarding your WHOLE hand leaves
    // nothing to choose, so this goes straight through `discardCards` with a
    // count equal to the hand — which its own "a hand no bigger than `count` is
    // not a choice" branch takes without a prompt. Each player's discard is one
    // instruction, so `cardsDiscarded` fires once per player (Jinx - Rebel
    // readies once, not once per card).
    //
    // `discardThenDraw`, not `drawCards(discardCards(...))`, because "then" is
    // printed and the discard can queue work behind it: a discarded Flame
    // Chompers parks its own "you may play me" question, and a draw wrapped
    // around the discard would resolve BEFORE that question — handing the player
    // four fresh cards while the engine still owes them an answer about the old
    // hand. The hand size is read from the live state per player for the same
    // reason.
    //
    // Turn order per rule 894, matching every other "each player" card here.
    targeting: { kind: "none" },
    resolve: (state) => {
      const first = state.activePlayerIndex;
      return [first, (1 - first) as 0 | 1].reduce(
        (next, playerIndex) => discardThenDraw(next, playerIndex, next.players[playerIndex].hand.length, 4),
        state,
      );
    },
  },
  "OGN-198": {
    // The Harrowing — "Play a unit from your trash, ignoring its Energy cost.
    // (You must still pay its Power cost.)"
    //
    // Soulgorger's decision (OGN-196, in this file) with the "you may" removed,
    // and it shares its two helpers rather than carrying a second copy of them.
    //
    // MANDATORY, so no decline option. That is not merely a missing button: with
    // no payable unit in the trash the option list is EMPTY, and
    // `advanceDecisions` drops a question nobody can answer instead of
    // deadlocking on it. That is 422's do-as-much-as-you-can, and it is the
    // failure mode worth naming — a mandatory instruction that stranded its own
    // decision would hang the game rather than doing nothing visible. Tested
    // directly in test/cards-harrowing.test.ts.
    //
    // A single payable unit is likewise not a question: one option, so
    // `advanceDecisions` executes it without interrupting anyone. There is no
    // choice to make, which is exactly what "play a unit from your trash" with
    // one unit in the trash means.
    //
    // A DECISION rather than an `ownTrashCard` target for Soulgorger's second
    // reason, which survives the loss of the first: the Power is paid AT
    // RESOLUTION out of the pool as it stands then, and cannot ride on the
    // PlayCardAction's payment — that action paid the Harrowing's own 6+2.
    targeting: { kind: "none" },
    resolve: (state, ctx) => parkDecision(state, { kind: "OGN-198-play", playerIndex: ctx.casterIndex }),
  },
  "SFD-145": {
    // Switcheroo — "[Hidden][Action] Swap the Might of two units at the same
    // battlefield this turn."
    //
    // `sameBattlefield` is Facebreaker's relation between two targets, and the
    // reason it has to live on the SPEC rather than in this resolver: by the time
    // a resolver runs the choice is already made and validated, so refusing here
    // would leave the card paid for and doing nothing.
    //
    // `min: 2` — both halves are one instruction joined by "of two units", so the
    // card is simply uncastable without a pair standing together (355: "valid
    // choices must be made for all targets"). The two slots are genuinely
    // interchangeable (a swap is the same either way round), so the default
    // symmetric pruning is right and `asymmetricSlots` would only double the
    // AI's search for one board.
    //
    // **WHICH Might is swapped is a rules call, and it was the WRONG one until
    // 2026-08-23.** It used to swap printed Might plus the this-turn modifier and
    // deliberately not `effectiveMight`, on the reasoning that baking an aura or
    // a combat-only [Shield] into a delta surviving to end of turn "keeps paying
    // out long after its source stopped applying, which is a worse answer than
    // under-counting it". That entry flagged itself unverified and named the rule
    // that contradicts it; nobody read the rule.
    //
    // **432.1's worked example settles it, and it settles it the other way — it
    // is the exact scenario the old note called the worse error, decided in
    // favour of current Might:**
    //
    //   "A unit with 3 base Might and Shield 2 is in combat as a Defender. Since
    //   Shield applies, its current Might is 5. A player chooses it as the target
    //   for Last Stand… 'Double a friendly unit's Might this turn.' Its current
    //   Might is 5, so it gets +5 Might this turn… After combat, Shield no longer
    //   applies, but the +5 Might from Last Stand does, so the unit's Might is 8."
    //
    // So a spell that references Might reads CURRENT Might (143.2), a temporary
    // source counts while it applies, and the rules explicitly accept the
    // resulting this-turn delta outliving that source. The old reasoning was a
    // design preference asserted against a rule that had already answered.
    //
    // Reported from play: "using Switcheroo on a unit with a bunch of equipment
    // attached swapped the original Might instead of the Might after equipment.
    // I switcheroo'd my unit and an opponent's base 2-Might unit, but it was ten
    // Might because of equipment." Equipment is a plainer part of current Might
    // than Shield is, so it was wrong under the old reading twice over.
    //
    // Non-combat context, the reading every Might threshold in this pool takes —
    // `[Assault]`/`[Shield]` do not count here, which is Wind and Ghosts' note
    // above. The Shield in 432.1's example counts only because that unit is
    // mid-combat; the equipment in the report counts always.
    targeting: { kind: "unitSlots", slots: ["any", "any"], min: 2, sameBattlefield: true },
    resolve: (state, _ctx, event) => {
      const { targetUnitInstanceId: firstId, secondTargetUnitInstanceId: secondId } = event;
      if (!firstId || !secondId) return state;
      const first = findUnitAnywhere(state, firstId);
      const second = findUnitAnywhere(state, secondId);
      // 359.3: a target that has left play makes the check return nothing rather
      // than making the spell fizzle loudly.
      if (!first || !second) return state;
      const delta = swappableMight(state, second) - swappableMight(state, first);
      if (delta === 0) return state; // equal Might: a swap nothing can observe
      // Applied to the first, then the second, reading `delta` once — the second
      // call must not re-derive from a board the first has already changed.
      return giveMightThisTurn(giveMightThisTurn(state, firstId, delta), secondId, -delta);
    },
  },
  "SFD-147": {
    // Downwell — "Return all units and gear to their owners' hands."
    //
    // No targeting at all, and that is 355.10.d rather than convenience: "Kill
    // all units at battlefields doesn't target anything" — an effect that names
    // every object of a kind chooses none of them, so there is nothing to pick
    // and nothing to validate.
    //
    // "ALL units" is BOTH bases as well as every battlefield (355.9.a.1's bare
    // noun, the same reading Whirlwind takes), so `allUnitsInPlay` — the walk
    // Whirlwind's own option list uses — is the right set and a battlefield-only
    // sweep would be wrong. At 8 Energy and 2 Power this is the pool's board
    // wipe, and leaving base units standing would make it a one-sided one.
    //
    // Ids are snapshotted before anything moves, for the reason
    // `dealDamageToAllUnitsAt` above snapshots its own: each return rewrites the
    // zones the walk reads.
    //
    // Units first, then gear, in printed order. It is observable: `killGear` is
    // NOT what happens to a gear here (it is returned, not killed), so no gear's
    // killed self-trigger fires, but a unit leaving play does strip its Buff
    // (709) and reset damage — both already inside `returnUnitToHand`.
    //
    // **Known gap, inherited rather than introduced**: `returnUnitToHand` puts a
    // TOKEN into its owner's hand instead of letting it cease to exist, and
    // nothing in this engine removes it there. Every bounce in the pool shares
    // it (Rebuke, Zaunite Bouncer, Whirlwind); this card just meets it more
    // often. Fixing it is a change to effect-helpers.ts.
    targeting: { kind: "none" },
    resolve: (state) => {
      const unitIds = allUnitsInPlay(state).map((u) => u.instanceId);
      const gearIds = ([0, 1] as const).flatMap((index) => state.players[index].activeGear.map((g) => g.instanceId));
      const bounced = unitIds.reduce((next, id) => returnUnitToHand(next, id), state);
      return gearIds.reduce((next, id) => returnPermanentToHand(next, id), bounced);
    },
  },
  "UNL-124": {
    // Isolate — "Move an enemy unit from a battlefield to its base. Then, if
    // there's an enemy unit alone at that battlefield, draw 1."
    //
    // "FROM A BATTLEFIELD" is printed, so the default battlefield scope stands
    // and a unit sitting in the enemy base is out of reach — the same printed
    // distinction Rebuke and Fight or Flight above turn on.
    //
    // `recallUnitToBase` rather than `relocateToBaseUnchanged` — the helper Fight
    // or Flight and Maddened Marauder already share for this identical sentence,
    // so the three cannot come to disagree. The unit arrives EXHAUSTED and
    // Vilemaw's Lair can forbid the move outright (422 then does as much as it
    // can, which here is nothing).
    //
    // **It fires no `unitMoved`, and that is worth stating rather than assuming.**
    // Fight or Flight's own entry claims "move triggers see it"; measured against
    // `recallUnitToBase`, they do not — the helper rewrites the zones directly.
    // Whether the exhaust belongs here at all is the helper's own filed-Unverified
    // question (454 leaves a Recall's statuses untouched), inherited rather than
    // introduced by this card.
    //
    // **"ALONE" is a defined term, not a mood.** The rules' Special Terms: "A
    // unit is alone when there are no other friendly units at the same
    // location." Friendly is relative to THAT unit, so "an enemy unit alone at
    // that battlefield" asks whether the opponent has exactly one unit left
    // standing there — the caster's own units at the same battlefield are
    // irrelevant to it, which is what makes the payoff a reward for stripping a
    // stack down to one rather than for outnumbering it.
    //
    // The battlefield is read BEFORE the move: "that battlefield" is where the
    // moved unit came FROM, and by the time the count is taken it has left.
    targeting: { kind: "unit", owner: "enemy" },
    resolve: (state, ctx, event) => {
      const unitId = event.targetUnitInstanceId;
      if (!unitId) return state;
      const location = findUnitAnywhere(state, unitId);
      // 359.3 — the target may have left play, or been moved home already, while
      // this sat on the chain. Nothing moves and nothing is drawn.
      if (!location || location.zone === "base") return state;
      const battlefieldId = state.battlefields[location.zone.battlefieldIndex]!.id;

      const moved = recallUnitToBase(state, unitId);
      return unitsAt(moved, ctx.opponentIndex, battlefieldId).length === 1 ? drawCards(moved, ctx.casterIndex, 1) : moved;
    },
  },
  "UNL-125": {
    // Lunar Boon — "[Reaction] Discard 1, then draw 2."
    //
    // Ezreal - Prodigy's on-play clause (SFD-149, below) as a spell, down to the
    // numbers, and it shares his helper rather than carrying a second copy: the
    // "THEN" is load-bearing, and `discardThenDraw` keeps it by parking the draw
    // BEHIND the discard's question. Written the obvious way the two cards drawn
    // would join the hand the player is still choosing a discard from.
    //
    // ONE discard instruction, so `cardsDiscarded` fires once (a Jinx - Rebel
    // across the table readies once, not once per card) — that is
    // `discardCards`' own contract and nothing here fires per card.
    //
    // `[Reaction]` needs nothing here: card-loader reads it off the printed text
    // into `isReaction`, and legal-actions is what widens the window.
    targeting: { kind: "none" },
    resolve: (state, ctx) => discardThenDraw(state, ctx.casterIndex, 1, 2),
  },
  "UNL-128": {
    // Star-Crossed — "[Reaction] Return a friendly unit and an enemy unit to
    // their owners' hands."
    //
    // Two ordered slots with `min: 2`, so 355's "valid choices must be made for
    // all targets" makes the card uncastable unless BOTH halves exist — a board
    // with only enemy units cannot pay for half a Star-Crossed. That is the same
    // reading Gentlemen's Duel and Facebreaker take of the same "a friendly X and
    // an enemy X" sentence.
    //
    // `scope: "anywhere"`: neither noun carries a location word, and **355.9.a.1**
    // is the rule that makes a bare "unit" mean any unit on the Board — "'Unit,'
    // 'gear,' and 'rune' refer to objects on the Board unless specified
    // otherwise". A unit in either base is therefore a legal choice, which for a
    // `[Reaction]` is most of the card: bouncing your own about-to-die attacker is
    // the line, and so is stripping a reinforcement out of the enemy base.
    //
    // "To their OWNERS' hands" — plural, and `returnUnitToHand` already resolves
    // the owner per unit rather than assuming the caster's, so nothing here has to
    // say it twice.
    //
    // The two slots are always DISTINCT under `unitSlots`, and the roles differ,
    // so neither `asymmetricSlots` (the roles are not interchangeable to begin
    // with) nor an explicit "another" check is needed.
    targeting: { kind: "unitSlots", slots: ["friendly", "enemy"], min: 2, scope: "anywhere" },
    resolve: (state, _ctx, event) => {
      const { targetUnitInstanceId: friendlyId, secondTargetUnitInstanceId: enemyId } = event;
      // 359.3 — either target may have left play while this sat on the chain, and
      // the other half still happens (055's do as much as you can).
      const first = friendlyId ? returnUnitToHand(state, friendlyId) : state;
      return enemyId ? returnUnitToHand(first, enemyId) : first;
    },
  },
  "UNL-131": {
    // Abandon — "[Reaction] Counter a spell. Return it to its owner's hand
    // instead of putting it in their trash. [Predict]."
    //
    // # The "instead" is a REDIRECT of 425.1.a.1, and this engine gets there backwards
    //
    // 425.1.a.1: "Cards that are cleared from the chain in this way are placed in
    // the trash." Abandon replaces that destination. But this engine trashes a
    // Spell when it is CAST rather than when it resolves (execute-play-card's
    // chain push; `counterSpell`'s own comment says so in as many words), so by
    // the time any counter resolves the card is ALREADY in the trash. The
    // redirect is therefore written as "take it back out again" — same end state,
    // reached from the other side.
    //
    // That is observable in exactly one way and it is worth naming: a card that
    // was in the trash for the intervening moment could in principle have been
    // seen by a trash-watching effect. Nothing in the four-set pool watches a
    // trash continuously, measured — every trash reader in this engine is asked
    // at its own resolution — so today the two orders are indistinguishable.
    //
    // # "Its OWNER's" is looked up rather than taken from the chain entry
    //
    // `SpellChainEntry.playerIndex` is the CONTROLLER, and Mystic Reversal makes
    // those come apart: a stolen spell's entry names the thief while the card
    // itself is still sitting in the original caster's trash. So the card is found
    // by searching both trashes, which answers "whose card is this" by where it
    // physically is.
    //
    // # Countering something already gone
    //
    // `spellsOnChain` is checked FIRST and nothing at all happens when the target
    // has left — two Abandons aimed at one spell must not put it in hand twice,
    // and the second one has nothing to counter (359.3, and the case
    // `counterSpell` already documents for itself).
    //
    // # `[Predict]` is a second, unconditional instruction
    //
    // It sits after the counter with its own full stop, so it happens whether or
    // not the counter found anything — and it is the caster's own deck. Parked as
    // a question because "you MAY recycle it" is a later part of the effect
    // (383.3.a.3 decides those on resolution) and because the top of a deck is not
    // public: fanning it onto the action would hand the AI its own deck order, the
    // same reason Stacked Deck and Called Shot park theirs.
    targeting: { kind: "chainSpell" },
    resolve: (state, ctx, event) => {
      const spellId = event.targetChainCardInstanceId;
      const target = spellId ? spellsOnChain(state).find((s) => s.entry.card.instanceId === spellId) : undefined;
      let next = state;
      if (spellId && target) {
        const ownerIndex = trashHolderOf(state, spellId);
        const countered = counterSpell(state, spellId);
        next = ownerIndex === undefined ? countered : returnCardFromTrash(countered, ownerIndex, spellId);
      }
      return predict(next, ctx.casterIndex, "UNL-131-predict");
    },
  },
  "UNL-134": {
    // Existential Dread — "[Action] [Repeat] [2] [Stun] an attacking enemy unit.
    // If it's already stunned, return it to its owner's hand instead."
    //
    // Thwonk!'s targeting with an owner clause Thwonk! does not print: "an
    // attacking ENEMY unit", so stunning your own attacker — which Thwonk!'s entry
    // explicitly allows as a legal misplay — is not on offer here. Both filters
    // live in the SPEC rather than in the resolver, because for a Spell the
    // targeting IS the effect: with nobody attacking, this is UNCASTABLE rather
    // than castable and wasted.
    //
    // **"If it's ALREADY stunned" is read at RESOLUTION, not at announcement**, and
    // the difference is reachable: this is an `[Action]`, the chain is LIFO, and a
    // Thwonk! or a first Existential Dread underneath it can land the stun in
    // between. 423.1.a.1 ("A Stunned Unit can not be Stunned again") is what makes
    // the second half worth printing at all — a plain re-stun would do nothing.
    //
    // `stunUnits` rather than a flag write, so `unitsStunned` is held once for the
    // instruction and a Zed - Shadow across the table pays out exactly once.
    //
    // **The `[Repeat] [2]` half is NOT implemented**, and it is invisible rather
    // than broken: `REPEAT_COSTS` in card-effects.ts is the only place a repeat
    // cost can be declared, the enumerator simply offers no repeat variant without
    // an entry, and this file may not add one. `repeat-keyword.test.ts` names
    // UNL-134 in its unpriced list, which is what keeps the gap visible.
    targeting: { kind: "unit", owner: "enemy", attackingOnly: true },
    resolve: (state, ctx, event) => {
      const unitId = event.targetUnitInstanceId;
      if (!unitId) return state;
      const target = findUnitAnywhere(state, unitId);
      if (!target) return state; // 359.3 — it left play while this waited
      return target.unit.stunned ? returnUnitToHand(state, unitId) : stunUnits(state, ctx.casterIndex, [unitId]);
    },
  },
  "UNL-139": {
    // Bone Skewer — "[Hidden] Choose a battlefield. An opponent reveals their
    // hand. You may choose a unit from it. They play that unit to that
    // battlefield, ignoring any and all costs. When they do, [Stun] it."
    //
    // The pool's first card that makes the OPPONENT play one of their own cards,
    // and the only reason it is a playable card rather than a gift is the stun:
    // the unit arrives at a battlefield of the caster's choosing, deals no combat
    // damage this turn, and its controller has paid nothing for a body they did
    // not want yet.
    //
    // # Which choices are targets and which are questions
    //
    // "Choose a battlefield" IS a target — `{ kind: "battlefield" }`, decided at
    // announcement like every other target here. Played from Hidden that reduces
    // to one answer: 811 requires every target of a from-hidden play to be at the
    // battlefield it was hidden at, and `hiddenPlayRejection` already enforces it
    // for `targetBattlefieldId`. Nothing here has to say so.
    //
    // "You may choose a unit from it" is a DECISION, and forced to be: the
    // options are the opponent's HAND, and `legal-actions` enumerates from public
    // state — fanning it out would put their hand into the action list and leak
    // it to the AI before the reveal ever happened. Mindsplitter (OGN-192) makes
    // the identical call for the identical sentence, and the "you MAY" adds a
    // decline it does not have.
    //
    // # The reveal has no state, and that is stated rather than assumed
    //
    // **424.3.a**: "When the zone is instructed to be Revealed without indicating
    // a number of cards, that refers to 'All cards currently in the specified
    // zone.'" There is no `revealedHand` field in this engine and no
    // hidden-information model to lift; the reveal's whole purpose is served by
    // the option list, which shows the hand to the chooser. Its only unmodelled
    // consequence is that the knowledge does not persist past the question — the
    // same limitation Insightful Investigator (UNL-135, below) already records.
    //
    // Nothing is asked when the hand holds no unit: 422's do-as-much-as-you-can,
    // and the same silence Blitzcrank keeps rather than parking a question whose
    // only answer is no.
    targeting: { kind: "battlefield" },
    resolve: (state, ctx, event) => {
      const battlefieldId = event.targetBattlefieldId;
      if (!battlefieldId) return state;
      if (!state.battlefields.some((bf) => bf.id === battlefieldId)) return state;
      if (skewerableUnits(state, ctx.opponentIndex).length === 0) return state;
      return parkDecision(state, { kind: "UNL-139-play", playerIndex: ctx.casterIndex, battlefieldId });
    },
  },
  "UNL-140": {
    // Conscription — "You may spend 5 XP as an additional cost to play this.
    // Choose an enemy unit at a battlefield with 3 [Might] or less. If you paid
    // the additional cost, choose any enemy unit at a battlefield instead. Take
    // control of it, exhaust it, and recall it."
    //
    // # HALF WRITTEN, and the missing half is the OPTIONAL COST — not the effect
    //
    // The "you may spend 5 XP" is an Optional Additional Cost (805) paid as the
    // spell is played, so it must be a fanned-out variant on the PlayCard action
    // exactly as `[Accelerate]`, Clockwork Keeper's rune and Bard - Mercurial's
    // Legend-exhaust already are.
    //
    // **This paragraph used to end "and there is no XP equivalent of either —
    // measured: card-effects.ts and actions/player-action.ts contain no XP cost
    // of any kind". That was true when written and is not now.** `OPTIONAL_XP_COSTS`
    // and `PlayCardAction.optionalXpPaid` both landed for UNL-164 Safety
    // Inspector, and `test/unl-chaos-wave8-refusals.test.ts` drives that card
    // through `legalActions` to prove the mechanism is live rather than merely
    // present. Re-measured 2026-08-13 rather than re-read: a refusal that names a
    // missing mechanism goes stale the day someone builds it, and this one had.
    //
    // # What it is ACTUALLY blocked on, measured through `submit`
    //
    // A row would be necessary and NOT sufficient, and both halves are pinned in
    // that test file:
    //
    //   - NECESSARY. `validate-play-card` refuses `optionalXpPaid` outright on a
    //     card with no row ("Conscription has no optional XP cost to pay"), so
    //     nothing can claim the cost until the table names it.
    //   - NOT SUFFICIENT. What the cost BUYS is a wider CHOICE, and the choice is
    //     filtered once per card rather than once per variant. `legal-actions`
    //     takes `targetingForAnyCard(card)` ONCE, above the optional-cost fan-out,
    //     so every paid variant is a spread of a play whose target was already
    //     capped at 3 Might — and `validate-play-card.targetingRejection` reads
    //     the SAME spec a second time, so even a hand-built action naming a
    //     5-Might enemy is refused with "can only target a unit with 3 Might or
    //     less". Measured with the XP flag absent, so the cap is unambiguously
    //     what refuses.
    //
    // So the fix is two files agreeing on a spec that depends on the VARIANT, not
    // one table row. `[Ambush]` is the nearest precedent (its timing tier depends
    // on the destination, so the question is asked per candidate).
    //
    // Writing it as a MODE was considered and rejected, and re-checked in the same
    // pass: `CardMode` still carries `{ id, label, targeting, resolve }` and
    // nothing else, so there is still no `availableWhile` on it and `legal-actions`
    // still fans every mode out unconditionally. A player with 4 XP would be
    // offered the upgraded mode, take it, and have `spendXp` return undefined at
    // resolution. That is 416.3's offered-then-refused shape, which this file keeps
    // out; a card that eats its own 5 Energy and does nothing is worse than one
    // that under-offers.
    //
    // So what is written is the card WITHOUT its upgrade: the cost is never
    // offered, and the target cap therefore always stands. It UNDER-reaches, never
    // over-reaches, which is the direction to err. Its
    // `coverage.PARTIALLY_IMPLEMENTED` entry exists and its wording needs the same
    // correction this comment just took — it still says "the XP cost mechanism now
    // exists ... but optional costs are fanned out inside the target loop", which
    // is right about the loop and silent about the validator's second reading.
    //
    // # The effect, which is whole
    //
    // "3 Might or less" is the shared `maxMight` predicate (`unitWithinMaxMight`),
    // so it reads EFFECTIVE Might — a 3-Might unit standing under an aura is a 4
    // and out of reach, which is **143.2**'s Might read the way 432.1's worked
    // example reads it (a Shield's +2 is part of "current Might" while it applies).
    //
    // "AT A BATTLEFIELD" is printed twice, so the default battlefield scope stands
    // and a unit in the enemy base is safe. Possession (OGN-203, above) prints the
    // same restriction and takes the same reading.
    //
    // "Take control of it, EXHAUST it, and recall it" — three instructions, and
    // the middle one is what separates this from Possession, whose text stops at
    // two. `takeControlOfUnit` performs the take AND the recall in one step (in
    // this engine control IS which player's list the unit sits in, so it lands in
    // the caster's base), and the exhaust is applied afterwards to the unit as it
    // now stands. Printed order would exhaust before the recall; the two are
    // indistinguishable here because `takeControlOfUnit` preserves the unit
    // otherwise untouched, and doing it in this order is what lets the exhaust be
    // asked of the CASTER's own board rather than of the opponent's.
    targeting: { kind: "unit", owner: "enemy", maxMight: CONSCRIPTION_MAX_MIGHT },
    resolve: (state, ctx, event) => {
      const unitId = event.targetUnitInstanceId;
      if (!unitId) return state;
      // 359.3 — it may have left play while this sat on the chain, in which case
      // `takeControlOfUnit` is a no-op and there is nothing to exhaust.
      const taken = takeControlOfUnit(state, unitId, ctx.casterIndex);
      return exhaustOwnUnitAnywhere(taken, ctx.casterIndex, unitId);
    },
  },
  "UNL-142": {
    // Heedless Resurrection — "[Reaction] As an additional cost to play this,
    // kill a friendly unit. Play a unit from your trash that costs no more
    // Energy and no more Power than the killed unit, ignoring its cost."
    //
    // # WRITTEN AND INERT TODAY, and the missing piece is ONE TABLE ROW
    //
    // "As an additional cost to play this, kill a friendly unit" is exactly the
    // shape `card-effects.OPTIONAL_UNIT_COSTS` already carries for Cruel Patron
    // (OGN-208): `{ kind: "killFriendly", mandatory: true }`. That file is shared
    // and this pass may not add to it, so the enumerator never fans out a variant
    // naming the victim, `additionalCostUnitInstanceId` is never set by a real
    // game, and this resolver returns the state untouched — a 2-Energy 1-Power
    // Reaction that does nothing.
    //
    // Written anyway, for the reason Pyke - Dockside Butcher (UNL-028) and Nami -
    // Headstrong (UNL-052) both record: the field is a fully threaded mechanism
    // (`legal-actions` fans it, `validate-play-card` checks it,
    // `execute-play-card` forwards it onto the chain entry and
    // `card-effect-resolution.choicesOf` hands it back), so the day the row lands
    // the card works. Pinned by a test that asserts the unpaid play does nothing,
    // so adding the row FAILS that test rather than silently changing behaviour
    // nobody was watching.
    //
    // **The validator does not reject the field on an unlisted card** — its check
    // is guarded by `optionalCost !== undefined` — so the effect below really is
    // driven end to end through `submit` in the tests rather than by calling this
    // resolver. What is genuinely unexercised is the ENUMERATION, and the
    // mandatory-ness the row also buys: printed, a Resurrection with no friendly
    // unit is UNPLAYABLE, and today it is merely pointless.
    //
    // # The kill happens at RESOLUTION, not at finalization
    //
    // **204.2.a**: "Additional Costs must be paid to finalize the spell or
    // ability", which on a `[Reaction]` is observable — printed, the victim is
    // already dead while the opponent decides how to answer. This engine pays
    // every `OPTIONAL_UNIT_COSTS` cost inside the effect (Meditation's exhaust,
    // Wildclaw Shaman's buff, Cruel Patron's kill), so the whole family shares
    // that divergence rather than this card inventing one.
    //
    // # Two ceilings, both PRINTED, and the corpse is where they are read from
    //
    // **206**: "Effects that need to determine a card's cost for any purpose
    // always use its printed or copied cost, even if that cost is increased,
    // decreased, or ignored as the card is played." Its third worked example is
    // ATAKHAN, whose "I cost [1] less for each Energy it costs and [Y] less for
    // each Power it costs" is the same sentence about the same killed friendly
    // unit — so "no more Energy and no more Power than the killed unit" is two
    // separate caps read off the victim's printed pips, and no cost modifier of
    // either side's touches them.
    //
    // `PendingDecision` carries a single `count` and two numbers do not fit in it,
    // so they are re-read off the card in the trash when the question is answered.
    // **359.3.e.13** licenses that directly — "a spell or ability that moves
    // something to a different zone as a cost or effect can 'look back' at its
    // characteristics before it changes zones" — and 206 is what makes the look-up
    // safe a response window later, since a printed cost is the one thing that
    // cannot move. (Baited Hook carries ITS cap on the decision instead, because
    // MIGHT is stripped by the death; a printed cost is not.)
    //
    // Two cases leave nothing to read and both fizzle rather than guess: a TOKEN
    // victim ceases to exist on reaching the trash (**186.1**), and a death
    // REPLACED by Zhonya's Hourglass or Sett was never a death at all (808.1.d.1).
    // Both UNDER-offer, which is the direction to err — and the token case is a
    // real divergence rather than a vacuous one, since 206's own example prices a
    // token off the card it copies.
    //
    // # The victim is itself an eligible answer
    //
    // It costs exactly as much as itself, so `<=` admits it, and nothing in the
    // text excludes it — the cost is paid before the instruction executes, so by
    // then it is just a unit in the trash. That makes this a self-contained
    // flicker (re-entering exhausted under **143.4**, and printed, shedding damage
    // and every temporary modification under **124.1**), which is the sharpest
    // thing the card does; stated here rather than left to be discovered.
    //
    // **The 124.1 half does not happen, and the gap is not this card's.**
    // `effect-helpers.completeDeath` files the unchanged instance into the trash —
    // it strips the Buff (705) and nothing else — so a unit that dies damaged
    // comes back damaged, and a this-turn pump rides along. Every "play a unit
    // from your trash" in the pool reaches it (Soulgorger, The Harrowing, Last
    // Rites, Fizz - Trickster); this card only makes it cheap and repeatable.
    // Pinned in test/unl-chaos-wave6.test.ts, which asserts the WRONG answer on
    // purpose so that fixing effect-helpers.ts fails loudly.
    targeting: { kind: "none" },
    resolve: (state, ctx, event) => {
      const victimId = event.additionalCostUnitInstanceId;
      if (victimId === undefined) return state; // the row is not in the table yet
      // **359.3.e.12**, whose worked example is BAITED HOOK doing exactly this:
      // an opponent bounces the named friendly unit while the ability is on the
      // chain, "it can't be killed and its Might is treated as null", and the
      // controller "can't choose any unit from among them". A [Reaction] gives
      // them a real window to do it.
      if (findUnitAnywhere(state, victimId) === undefined) return state;
      // No `killerIndex`, following Cruel Patron: paying a cost with your own unit
      // is not you "killing" it in the sense Solari Shrine asks about.
      return parkDecision(destroyUnit(state, victimId), {
        kind: "UNL-142-resurrect",
        playerIndex: ctx.casterIndex,
        // The corpse, not the spell — `targetInstanceId` is "what the question is
        // ABOUT", and the whole question is bounded by what it cost.
        targetInstanceId: victimId,
      });
    },
  },
};

/**
 * The Might figure Switcheroo trades between two units: CURRENT Might (143.2),
 * which is what a spell referencing Might reads — equipment, auras, buffs and
 * this-turn pumps included.
 *
 * Named rather than inlined because it IS the card's rules call. See SFD-145's
 * entry for 432.1's worked example, which decides it and which the previous
 * version of this comment cited while doing the opposite.
 *
 * Takes the LOCATION rather than the bare unit, because a positional aura is
 * part of current Might and `effectiveMight` needs to know where the unit
 * stands. That is also why this reads at RESOLUTION: an aura arriving in the
 * response window an `[Action]` opens is part of the figure being swapped.
 */
function swappableMight(state: GameState, found: { unit: UnitInstance; zone: UnitZone }): number {
  const battlefieldId = found.zone === "base" ? undefined : state.battlefields[found.zone.battlefieldIndex]?.id;
  return effectiveMight(state, found.unit, ownerIndexOf(state, found.unit), {
    isCombat: false,
    ...(battlefieldId !== undefined ? { battlefieldId } : {}),
  });
}

/**
 * Parks one question of `kind` for each player, starting with `first`.
 *
 * `parkDecision` pushes onto the BACK of a FIFO queue, so the order they are
 * parked in IS the order they are answered in — which is the entire
 * implementation of both "each player, in turn order" (rule 894, Acceptable
 * Losses) and Whirlwind's "starting with the next player". Written once rather
 * than twice because the two differ only in where the sequence starts, and a
 * second hand-rolled copy is how the two would drift.
 */
function askInTurnOrder(state: GameState, kind: string, first: 0 | 1): GameState {
  return [first, (1 - first) as 0 | 1].reduce((next, playerIndex) => parkDecision(next, { kind, playerIndex }), state);
}

/**
 * Which player's trash currently holds `cardInstanceId` — Abandon's "its OWNER's
 * hand".
 *
 * Asked of the BOARD rather than taken from the chain entry, because
 * `SpellChainEntry.playerIndex` is the spell's CONTROLLER and Mystic Reversal
 * makes the two come apart: a stolen spell's entry names the thief while the card
 * is still in the original caster's trash, where `execute-play-card` filed it as
 * the spell was cast.
 *
 * `undefined` when nothing holds it, which is a real case rather than padding —
 * `playCardIgnoringCost` resolves a spell without ever putting it on the chain,
 * and a hand-built state can name a card in neither trash.
 */
function trashHolderOf(state: GameState, cardInstanceId: string): 0 | 1 | undefined {
  for (const playerIndex of [0, 1] as const) {
    if (state.players[playerIndex].trash.some((c) => c.instanceId === cardInstanceId)) return playerIndex;
  }
  return undefined;
}

/**
 * `[Predict]` — "Look at the top card of your Main Deck. You may recycle it."
 *
 * Parked as a question rather than fanned onto the action for two separate
 * reasons, and either one alone would be enough. The top of a deck is not public
 * state, so enumerating the choice would hand the AI its own deck order (Stacked
 * Deck's and Called Shot's reason); and "you MAY recycle it" is a later part of
 * the effect, which **383.3.a.3** decides on resolution rather than at
 * finalization.
 *
 * Nocturne - Horrifying's "as you LOOK AT me" is offered first, because the queue
 * is FIFO and that is the order the two sentences read in — `offerTopOfDeckBanish`
 * documents the convention for the six existing look sites.
 *
 * An empty deck asks nothing at all rather than parking a question whose only
 * answer is "decline" (422's do as much as you can).
 *
 * Takes the decision `kind` as a parameter so a second Chaos card printing
 * `[Predict]` reuses the mechanism and keeps its own prompt — the keyword is one
 * ability printed on five cards, and only its bare form is built (its valued
 * `[Predict 2]` is a subset choice plus an ordering, which is not).
 */
function predict(state: GameState, playerIndex: 0 | 1, kind: string): GameState {
  const top = state.players[playerIndex].deck[0];
  if (!top) return state;
  return parkDecision(offerTopOfDeckBanish(state, playerIndex, [top]), { kind, playerIndex });
}

/**
 * "Recycle the top card" — to the BOTTOM of the Main Deck (416/416.1), never the
 * trash.
 *
 * Held through `holdCardsRecycled` so Karma - Channeler's "when you recycle one
 * or more cards to your Main Deck" sees it, which is the whole reason this is not
 * written as a bare deck rotation.
 *
 * A private copy of the one in effects/calm.ts, and deliberately: the shared home
 * for it would be effect-helpers.ts, and the one-file-one-owner rule these domain
 * files exist for keeps a card implementation out of the shared file. Both copies
 * are four lines around one funnel call, so the thing that could drift — what
 * "recycle" fires — is the funnel and not the copy.
 */
/** Shared out of `effect-helpers.ts` — see its note on why the two private
 *  copies were promoted. */

/** Fizz - Trickster's ceiling — "a spell from your trash with Energy cost no
 *  more than [3]". Only the ENERGY is capped; his text names no Power limit,
 *  which is consistent with him making you pay the Power yourself. */
const FIZZ_MAX_ENERGY = 3;

/**
 * The spells in `playerIndex`'s trash Fizz - Trickster could play RIGHT NOW.
 *
 * ONE walk for the fire-time "is there anything to offer" test and for the
 * option list, so the two cannot disagree.
 *
 * **Payability is part of the filter, and that is the card's own words.** "(You
 * must still pay its Power cost.)" means a spell whose Power cannot be paid is
 * not a legal thing to play — so it is not offered, the rule this file applies
 * to every other paid offer. `payPowerFromChanneled` is asked speculatively and
 * its result thrown away, which is safe: its only side effect is a held trigger,
 * and that goes with the discarded state.
 */
function fizzCandidates(state: GameState, playerIndex: 0 | 1) {
  return state.players[playerIndex].trash.filter(
    (c) =>
      c.kind === "Spell" &&
      c.energyCost <= FIZZ_MAX_ENERGY &&
      (c.powerCost === 0 || payPowerFromChanneled(state, playerIndex, c.powerDomain, c.powerCost) !== undefined),
  );
}


/**
 * Does this from-trash spell have a UNIT target to choose, and is there anyone to
 * point it at?
 *
 * Only the single-unit shape is asked. That is deliberate rather than lazy: a
 * multi-slot or destination-carrying spell needs a choice this one question
 * cannot express, and offering half of it would be worse than the old behaviour
 * — the player would answer, and the rest of the spell would still fizzle
 * silently. Those stay on the do-as-much-as-you-can path (359.3.e.11) and are
 * named in docs/rules-conformance.md.
 */
function fizzSpellNeedsTarget(state: GameState, playerIndex: 0 | 1, card: CardInstance): boolean {
  const effect = cardModeOf(card, undefined);
  const targeting = effect?.targeting;
  if (targeting?.kind !== "unit") return false;
  return eligibleTargets(state, playerIndex, targeting.owner, targeting.scope).length > 0;
}

export const unitTriggers: Record<string, UnitTriggerDefinition> = {
  "VEN-099": {
    // Tornado Warrior — "[Hidden] When you play me FROM FACE DOWN, you may empower
    // something here. DISEMPOWER IT AT END OF TURN."
    //
    // # Two things that are not in the pool yet, and only one of them is new
    //
    // "From face down" is `event.fromHidden`, which the on-play trigger event has
    // carried since Ember Monk — 811's facedown play is already distinguished from
    // an ordinary one, so this needed nothing.
    //
    // The DELAYED disempower is new: `GameState.disempowerAtEndOfTurn` holds the
    // instanceIds, and `runEnd` clears the status and the list together. A delayed
    // effect is the shape Ashe - Focused's `banishedUntilHold` already takes —
    // armed state read by the phase machinery rather than a listener — and it is
    // deliberately NOT a `[Temporary]` grant, which KILLS what it expires on.
    //
    // **The disempower happens even if the thing has changed hands or moved**, and
    // that is the printed reading: the card says "disempower IT", naming the object
    // rather than a place. Nothing in the sentence ties it to staying here.
    //
    // "Something HERE" is positional and covers any Empowerable object at his
    // battlefield — 441 makes Empowered a status of a GAME OBJECT, so a unit or a
    // gear qualifies; a gear is at no battlefield in this pool, so in practice the
    // list is the units standing with him, either player's.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId, event) =>
      event.fromHidden === true
        ? parkDecision(state, { kind: TORNADO_EMPOWER, playerIndex: ctx.casterIndex, cardInstanceId: unitId })
        : state,
  },
  "VEN-101": {
    // Gust Monk — "[Assault 2] You may pay [1 Energy] as an additional cost to
    // play me. When you play me, if you paid the additional cost, banish a card
    // from ANY trash to give a unit [Assault 2] this turn."
    //
    // Sea Monkey's Energy-only optional cost (`OPTIONAL_POWER_COSTS`), read off the
    // action as `optionalPowerPaid` — nothing on the board records how he was paid
    // for by the time this runs.
    //
    // **"Banish a card from ANY trash" is a COST inside the instruction**
    // (355.10.c.1's "[do X] to [do Y]"), so it is a parked question rather than a
    // target: the trash is not a board zone, so no `TargetingSpec` reaches it.
    // Either player's trash, any card kind — the sentence narrows neither.
    targeting: { kind: "none" },
    resolve: (state, ctx, _unitId, event) =>
      event.optionalPowerPaid ? parkDecision(state, { kind: GUST_MONK_BANISH, playerIndex: ctx.casterIndex }) : state,
  },
  "VEN-113": {
    // Kennen, Storm of Shuriken — the ON-PLAY half, "[Burn 2]". His conquer clause
    // is an `eventTriggers` entry.
    //
    // Unconditional, so there is nothing to ask: `burn` is the whole instruction,
    // and 440.4's burn-out handling comes with the helper.
    targeting: { kind: "none" },
    resolve: (state, ctx) => burn(state, ctx.casterIndex, KENNEN_SHURIKEN_BURN),
  },
  "VEN-115": {
    // Ocean Drake — "You may play me to an OPEN battlefield. When you play me, you
    // may return a NON-DRAGON unit to its owner's hand."
    //
    // The placement half is a `PLACEMENT_GRANTS` row in unit-triggers.ts, the third
    // card in the pool with that exact clause; **170.11.b** is what "open" means
    // ("uncontrolled … no player controls them") and `isOpenBattlefield` adds the
    // empty requirement Sneaky Deckhand and Sai Scout have carried since Origins.
    //
    // **"NON-DRAGON" excludes himself**, which is the point: an 8-Energy Dragon
    // that could bounce himself would be a very different card. The filter is by
    // TAG rather than by instance, so he cannot bounce a Dragon of any kind —
    // including an enemy one, which is the half that stings.
    //
    // "A unit", bare, so either player's and anywhere (355.9.a.1). Bouncing your
    // own is a live line: it re-buys an on-play trigger.
    targeting: { kind: "none" },
    resolve: (state, ctx) => parkDecision(state, { kind: OCEAN_DRAKE_BOUNCE, playerIndex: ctx.casterIndex }),
  },
  "VEN-109": {
    // Illaoi, Prophet of the Great Kraken — the "WHEN YOU PLAY ME" half of "when
    // you play me OR WHEN I SCORE, play a 1 [Might] Tentacle unit token from
    // Bilgewater". Her score half is an `eventTriggers` entry, and her "+1 [Might]
    // for each token unit you control" is a `mightModifiers` entry.
    //
    // One printed sentence with two moments, registered in two tables for the
    // reason Kennen, Keeper of Balance's entry records: on-play is keyed by the
    // arriving unit and a score is a listener walk, and this engine has no table
    // keyed by both.
    //
    // TO BASE, which is the same narrowing Zed's Shadow Clone takes and is
    // recorded with it in docs/rules-conformance.md: a UNIT's on-play trigger has
    // no destination axis to fan out over.
    targeting: { kind: "none" },
    resolve: (state, ctx) => placeToken(state, ctx.casterIndex, "base", TENTACLE_TOKEN),
  },
  "SFD-149": {
    // Ezreal - Prodigy, FIRST clause — "When you play me, discard 1, then draw 2."
    //
    // His second ("Optional additional costs you pay cost [1] or [rainbow]
    // less") is a cost modifier and lives in cost-modifiers.ts, which also
    // carries his coverage claim. **Both halves landed in the same change on
    // purpose**: the claim went in first while this was still unwritten, and for
    // a few minutes he reported IMPLEMENTED while doing half his text — which is
    // precisely the over-report `PARTIALLY_IMPLEMENTED` exists to catch and the
    // reason coverage is asked per defId rather than per clause.
    //
    // "Discard 1, THEN draw 2" is ordered, and `discardThenDraw` keeps the order
    // by parking the draw behind the discard — a discard that hits the last card
    // in hand must not be refilled first.
    targeting: { kind: "none" },
    resolve: (state, ctx) => discardThenDraw(state, ctx.casterIndex, 1, 2),
  },
  "SFD-140": {
    // Fizz - Trickster — "When you play me, you may play a spell from your trash
    // with Energy cost no more than [3], ignoring its Energy cost. Recycle that
    // spell after you play it. (You must still pay its Power cost.)"
    //
    // **Ignores the ENERGY only**, which is what separates him from Glasc
    // Mixologist's flat "ignoring its cost": the Power is paid for real, so the
    // offer is filtered by what can actually be afforded.
    //
    // A spell played this way resolves IMMEDIATELY rather than going on the
    // chain — `playCardIgnoringCost`'s own note, and the reason the recycle can
    // follow it in the same resolver.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      fizzCandidates(state, ctx.casterIndex).length === 0
        ? state
        : parkDecision(state, { kind: "SFD-140-play", playerIndex: ctx.casterIndex }),
  },
  "OGN-197": {
    // Teemo - Scout — "[Hidden] When you play me, give me +3 Might this turn."
    //
    // The keyword is the card: hidden for 1 Power, played later for 0 as a
    // 2-Energy 3-Might body that arrives swinging for 3 more. Nothing here
    // touches [Hidden] — engine/hidden.ts owns it.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId) => giveMightThisTurnToOwnUnit(state, ctx.casterIndex, unitId, 3),
  },
  "OGN-199": {
    // Tideturner — "[Hidden] When you play me, you may choose a unit you control
    // at ANOTHER location. Move me to its location and it to my original
    // location."
    //
    // A SWAP, not two moves: both units end up where the other was, so it cannot
    // be expressed as forceMoveToBattlefield twice (the first move would vacate
    // the square the second reads). swapUnitLocations does it in one step.
    //
    // "ANOTHER location" — base counts as a location, so a Tideturner played to
    // base can pull a unit home from a battlefield and take its place there,
    // which is the card's whole trick. The target spec is therefore "anywhere",
    // and the resolver rejects a same-location choice.
    //
    // **"You MAY" — and it is genuinely optional now. FIXED 2026-08-07.**
    //
    // The history is worth keeping because it is one comment that has been wrong
    // in both directions: it first claimed the decline WAS offered ("enumeration
    // offers the no-target variant too"), which was false; the 2026-08-05
    // correction said it was forced, which was true and then stayed on the page
    // for two days after the mechanism to fix it was identified.
    //
    // `legal-actions.ts` pushed the empty variant only when
    // `effectVariants.length === 0`, so the decline appeared exactly when there
    // was nothing to decline: with any friendly unit at another location every
    // enumerated variant named one and the swap was forced. The resolver below
    // always handled an absent target, so the mechanism supported declining and
    // only the enumeration did not offer it.
    //
    // `optionalChoice` is that per-card marker, read by the enumerator AND by
    // `validate-play-card`'s `targetOmissionAllowed` — one flag, two readers, so
    // a decline cannot be offered and then refused. Deliberately NOT folded into
    // the `length === 0` rule, which says something different ("a trigger with
    // nothing to choose does nothing") and must keep applying to every on-play
    // trigger that is mandatory.
    //
    // **402.2** is the rule: "if the first part of a Triggered Ability's effect
    // is 'you may', its controller decides whether or not to perform the
    // Triggered Ability NOW" — at the Make Relevant Choices step, which is why
    // the decline is an enumerated variant rather than a branch in the resolver.
    //
    // **Tideturner is the ONLY card in the pool this reaches** — swept over
    // every Unit whose text says "you may <verb>" and whose on-play trigger
    // targets at announce time; every other optional on-play choice in the pool
    // is a parked decision, which can already be declined.
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere", optionalChoice: true },
    resolve: (state, ctx, unitId, event) =>
      event.targetUnitInstanceId ? swapUnitLocations(state, ctx.casterIndex, unitId, event.targetUnitInstanceId) : state,
  },
  "OGN-192": {
    // Mindsplitter — "When you play me, choose an opponent. They reveal their
    // hand. Choose a card from it, and they discard that card."
    //
    // "Choose an opponent" is not a decision in a 2-player game: there is one,
    // and offering it would be theatre. The real choice is WHICH card, and it
    // belongs to the CASTER even though the cards are the opponent's — which is
    // why the decision's playerIndex is the caster and its options come from the
    // other player's hand.
    //
    // A decision rather than an action fan-out for the same reason Stacked Deck
    // needs one: enumeration is built from public state, and putting the
    // opponent's hand into the action list would leak it to the AI before the
    // reveal ever happened.
    targeting: { kind: "none" },
    resolve: (state, ctx) => parkDecision(state, { kind: "OGN-192-discard", playerIndex: ctx.casterIndex }),
  },
  "OGN-165": {
    // Cemetery Attendant — "When you play me, return a unit from your trash to
    // your hand."
    //
    // The same shape Annie - Stubborn (OGS-010, engine/unit-triggers.ts) already
    // uses; the only difference is cardKind, since she returns a Spell and this
    // returns a Unit.
    //
    // The trash card is a real TARGET, not something the engine may pick for the
    // player: rule 355.9.a.4 makes "a unit from your trash" a target because a
    // trash is a Public zone. So this is an `ownTrashCard` spec that
    // legal-actions.ts fans out one candidate per eligible Unit, and WHICH unit
    // comes back stays the caster's decision.
    //
    // "YOUR trash" — ctx.casterIndex, never the opponent's; returnCardFromTrash
    // only ever looks in the named player's own trash. It also resets the
    // returned unit's damage / this-turn Might / Buff / exhausted, since the card
    // is re-entering hand and may be replayed fresh (rule 709 already took the
    // Buff off when it left play).
    //
    // The `?:` guard is load-bearing, not defensive noise: a Unit is playable
    // with its trigger's target OMITTED when the board offered no legal one
    // (validate-play-card.ts's targetOmissionAllowed). An empty trash, or a trash
    // holding only Spells, is exactly that case — the Attendant still deploys and
    // simply returns nothing, per the "do as much as you can, ignoring impossible
    // instructions" golden rule (~rule 100, see docs/rules-conformance.md).
    targeting: { kind: "ownTrashCard", cardKind: "Unit" },
    resolve: (state, ctx, _unitId, event) =>
      event.trashCardInstanceId ? returnCardFromTrash(state, ctx.casterIndex, event.trashCardInstanceId) : state,
  },
  "OGN-188": {
    // Zaunite Bouncer — "When you play me, return another unit at a battlefield
    // to its owner's hand."
    //
    // "AT A BATTLEFIELD" is printed, so the default battlefield scope is right
    // and `scope: "anywhere"` would be wrong — a unit at home is out of reach,
    // which is the limit on the card.
    //
    // No owner restriction ("another unit", not "an enemy unit"), so bouncing
    // your own is a legitimate line — it resets damage and rescues a unit about
    // to die, exactly as Rebuke's does.
    //
    // "ANOTHER" needs no check here, for the reason First Mate's entry in
    // engine/unit-triggers.ts already records: legal-actions enumerates the
    // candidates while this card is still in HAND, before it exists anywhere on
    // the board, so the Bouncer can never be offered as its own target and
    // validate-play-card would refuse an id that was not enumerated.
    //
    // The `?:` guard is load-bearing rather than defensive: with no unit at any
    // battlefield the Unit is still playable with its trigger's target omitted
    // (validate-play-card's targetOmissionAllowed), and the Bouncer simply
    // deploys and bounces nothing.
    targeting: { kind: "unit" },
    resolve: (state, _ctx, _unitId, event) =>
      event.targetUnitInstanceId ? returnUnitToHand(state, event.targetUnitInstanceId) : state,
  },
  "OGN-196": {
    // Soulgorger — "When you play me, you may play a unit from your trash,
    // ignoring its Energy cost. (You must still pay its Power cost.)"
    //
    // A DECISION rather than an `ownTrashCard` target, unlike Cemetery Attendant
    // above, and the two differences are both printed:
    //   - "You MAY". A fanned-out `ownTrashCard` spec offers the no-target
    //     variant only when the board offered no legal candidate, so with a
    //     stocked trash "you may" would silently become "you must" — the exact
    //     failure card-effects.ts's OPTIONAL_UNIT_COSTS comment records for
    //     Wildclaw Shaman.
    //   - The Power cost is paid AT RESOLUTION, out of the pool as it stands
    //     then. It is not part of the PlayCardAction's payment and cannot be:
    //     the action paid for the Soulgorger.
    // Flame Chompers (OGN-006, effects/fury.ts) is the precedent for both halves
    // — the same "offer it from the trash, pay Power, then playUnitToBase" shape.
    targeting: { kind: "none" },
    resolve: (state, ctx) => parkDecision(state, { kind: "OGN-196-play", playerIndex: ctx.casterIndex }),
  },
  "SFD-132": {
    // Beast Below — "When you play me, return another friendly unit and an enemy
    // unit to their owners' hands."
    //
    // TWO DECISIONS rather than a `unitSlots` spec, and the difference is 422.
    // `unitSlots` with `min: 2` enumerates only complete pairs, so a board with a
    // spare friendly and no enemy (or the reverse) produces no variant at all,
    // `legal-actions` falls through to its "a Unit is playable with its trigger's
    // target omitted" branch, and the Beast returns NOTHING. The rules' golden
    // rule says do as much as you can and ignore the impossible instruction, so
    // the half that CAN happen must still happen. Asking the two halves
    // separately is the only shape that gets that right: a question with no
    // options is dropped by `advanceDecisions` while its sibling still runs.
    //
    // It is also the moment the rules name for a unit's on-play trigger. 355.10's
    // worked example is this card's shape exactly — "a unit with a triggered
    // ability that says 'When I'm played, kill a unit' does not require you to
    // choose a target as it's played; the target will be chosen when the ability
    // triggers" — so a resolution-time question is nearer the printed timing than
    // the announce-time fan-out, not a compromise away from it.
    //
    // "ANOTHER friendly" is enforced by carrying his own instanceId on the
    // question, NOT by the accident that enumeration happens while he is in hand
    // (Zaunite Bouncer's reason): by the time these resolve he is on the board and
    // would otherwise be on his own list.
    //
    // Both halves are MANDATORY — no "you may" — so neither offers a decline.
    // Friendly first, printed order; `parkDecision` is FIFO, so the order they are
    // raised in is the order they are asked in.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId) =>
      parkDecision(parkDecision(state, { kind: "SFD-132-friendly", playerIndex: ctx.casterIndex, cardInstanceId: unitId }), {
        kind: "SFD-132-enemy",
        playerIndex: ctx.casterIndex,
      }),
  },
  "SFD-138": {
    // Windsinger — "[Hidden] When you play me, you may return another unit at a
    // battlefield with 3 Might or less to its owner's hand."
    //
    // A DECISION rather than `{ kind: "unit", maxMight: 3 }`, and the reason is
    // the printed "you MAY". A fanned-out spec offers the no-target variant ONLY
    // when the board offered no legal candidate at all — `legal-actions`' own
    // `card.kind === "Unit" && effectVariants.length === 0` branch — so with any
    // 3-Might unit standing anywhere "you may" would silently become "you must",
    // and a player whose only small unit is their OWN would be forced to bounce
    // it. That is the failure card-effects.ts's OPTIONAL_UNIT_COSTS comment
    // records for Wildclaw Shaman and Soulgorger takes the same way out of.
    //
    // (Tideturner's entry above claims enumeration offers a no-target variant for
    // an optional unit target. Measured against `legal-actions`, it does not —
    // that comment is wrong, and this card is not written on it.)
    //
    // "AT A BATTLEFIELD" is printed, so base units are out of reach; "3 Might or
    // less" is asked through `unitWithinMaxMight`, the same shared predicate the
    // enumerator and the validator use, so this card and a `maxMight` spec can
    // never disagree about what counts (it reads EFFECTIVE Might, which is
    // **143.2**'s statistic as 432.1's worked example reads it).
    //
    // "ANOTHER" rides on his own instanceId, for the reason Beast Below's entry
    // gives: this resolves with him already on the board.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId) =>
      parkDecision(state, { kind: "SFD-138-return", playerIndex: ctx.casterIndex, cardInstanceId: unitId }),
  },
  "UNL-123": {
    // Evershade Stalker — "When you play me, discard 1, then draw 1."
    //
    // Ezreal - Prodigy's clause above at 1-for-1 instead of 1-for-2, and the same
    // helper for the same printed reason: "THEN" is ordered, and `discardThenDraw`
    // keeps the order by parking the draw behind the discard's question. A discard
    // that empties the hand must not be refilled first, or the card just drawn
    // becomes a candidate for the discard that preceded it.
    //
    // ONE discard instruction: `cardsDiscarded` fires once, from `discardCards`,
    // and nothing here fires per card.
    targeting: { kind: "none" },
    resolve: (state, ctx) => discardThenDraw(state, ctx.casterIndex, 1, 1),
  },
  "UNL-121": {
    // Bewitching Spirit — "When you play me, choose a player. They discard 1."
    //
    // **"A PLAYER", not "an opponent", and the difference is printed.** The rules
    // use both forms and mean different things by them — Mindsplitter (OGN-192,
    // above) says "choose an opponent" and so reduces to no choice at all in a
    // two-player game, while this reaches EITHER seat. So it is a real question
    // with two answers even at 1v1, and hard-coding the opponent would be reading
    // Mindsplitter's text onto this card. Making yourself discard is a live line
    // (a card you want in the trash, a Jinx - Rebel of your own to ready), which
    // is the whole reason the wording differs.
    //
    // The CHOOSER is the ability's controller (355.9), so the question belongs to
    // `ctx.casterIndex` however it is answered.
    //
    // A decision rather than an announce-time fan-out: the choice is made when the
    // trigger resolves (355.10's worked example of exactly this shape), and the
    // discard the answer causes stops to ask its own question, which an action
    // field could not carry.
    targeting: { kind: "none" },
    resolve: (state, ctx) => parkDecision(state, { kind: "UNL-121-discard", playerIndex: ctx.casterIndex }),
  },
  "UNL-132": {
    // Angler Beast — "When you play me, return all units with 2 Might or less to
    // their owners' hands."
    //
    // Downwell's sweep (SFD-147, above) with a Might filter, and it shares that
    // card's two decisions. **No targeting at all** — 355.10.d: an effect that
    // names every object of a kind chooses none of them, so there is nothing to
    // pick and nothing to validate. And **"all units" is BOTH bases as well as
    // every battlefield** (355.9.a.1's bare noun), so `allUnitsInPlay` is the right
    // walk; a battlefield-only sweep would leave every reserve standing.
    //
    // "2 Might or less" goes through `unitWithinMaxMight`, the shared predicate a
    // `maxMight` spec uses, so it reads EFFECTIVE Might — a 1-Might unit standing
    // under Garen - Commander is a 2 and a 2-Might unit under him is a 3 and
    // survives. Summing `might + mightThisTurn` here instead would ignore auras,
    // which is the exact bug three inlined copies of that sum once had.
    //
    // Ids are snapshotted before anything moves, for Downwell's reason: each
    // return rewrites the zones the walk reads. They are also snapshotted before
    // the Might is re-read, which matters here in a way it does not for Downwell —
    // bouncing a unit can remove an aura, and a unit that qualified when the
    // instruction began must not stop qualifying part-way through it.
    //
    // He can sweep HIMSELF: "all units" names no exception and he is already on
    // the board when this resolves. At 5 Might that needs an enemy shrink effect
    // to happen, which is why it is left to fall out rather than special-cased.
    targeting: { kind: "none" },
    resolve: (state) => {
      const doomed = allUnitsInPlay(state)
        .filter((u) => unitWithinMaxMight(state, u, ANGLER_BEAST_MAX_MIGHT))
        .map((u) => u.instanceId);
      return doomed.reduce((next, id) => returnUnitToHand(next, id), state);
    },
  },
  "UNL-130": {
    // Walking Roost — "[Deflect] When you play me, choose an opponent. They play
    // a 1 [Might] Bird unit token with [Deflect]."
    //
    // The keyword is the engine's (`deflectSurcharge`); this entry is only the
    // second sentence — a 6-Might body for 5 whose cost is handing the table's
    // other seat a cheap blocker that they, too, must be paid to touch.
    //
    // "CHOOSE AN OPPONENT" reduces to one seat in a two-player game, so it is not
    // offered as a decision — the same call Mindsplitter's entry makes above and
    // for the same reason. Bewitching Spirit is the contrast: "choose a PLAYER"
    // includes yourself and really is a question.
    //
    // "THEY play" — the token is the opponent's, so `placeToken` is called with
    // THEIR index. That is not cosmetic: it decides whose board it stands on,
    // whose `tokensEnterReady` applies to it, and which side `[Deflect]` taxes.
    //
    // **The OPPONENT chooses where it goes**, and this used to send it straight
    // to their base on the reasoning that a choice would be "a second decision the
    // printed text does not ask for". That was the wrong way round: 185.2.a says a
    // token is played "following all the applicable steps for playing a card plus
    // any restrictions or modifications from the effect that created the token",
    // and the inherent restriction on playing a Unit is base or a battlefield they
    // control. Walking Roost restricts nothing, so the ordinary choice is what the
    // text asks for — forcing base was the addition.
    //
    // Settled by the project owner on 2026-08-09, alongside the same correction to
    // Desert's Call and Flurry of Feathers, so every token-playing card in the
    // pool now behaves alike.
    //
    // Parked on the OPPONENT's index — "they play" makes it their choice on your
    // card, which `parkDecision` takes an arbitrary `playerIndex` for. 143.4.a's
    // exhausted entry is unchanged and `createToken` already does it.
    //
    // The spec is local rather than added to token.ts: it has one owner, unlike
    // the Recruit/Sand Soldier/Mech specs, which were hoisted there only once two
    // files minted them. The `Bird` tag is carried because it is printed; nothing
    // in the four-set pool reads it, measured, so it is flavour today and the
    // thing that would silently miss a Bird tomorrow if it were dropped.
    targeting: { kind: "none" },
    resolve: (state, ctx) => parkDecision(state, { kind: "UNL-130-where", playerIndex: ctx.opponentIndex }),
  },
  "UNL-135": {
    // Insightful Investigator — "When you play me, choose an opponent. They reveal
    // their hand. You may pay 2 XP to choose a card from their hand. If you do,
    // they discard that card and draw 1."
    //
    // # The rules work this card BY NAME, twice, and both passages say resolution
    //
    // **204.3.b**: "As the ability resolves, its controller may pay 2 XP as a
    // cost, and chooses a card from that player's hand as the effect."
    // **383.3.b**: "The 'pay 2 XP' is a cost within instructions, but because it
    // does not appear in the first part of the effect, it is not taken as the base
    // cost of the triggered ability. Paying 2 XP is performed on resolution."
    //
    // So a parked decision is not a compromise here — it is the printed timing.
    // The XP is NOT paid to put the trigger on the chain, and the trigger is
    // finalized whether or not the controller can afford it.
    //
    // # What is asked, and what is not
    //
    // "Choose an opponent" reduces to one seat (Mindsplitter's call). "They reveal
    // their hand" has no state of its own in this engine — there is no
    // `revealedHand` field and no hidden-information model to lift — and the
    // reveal's whole purpose is served by the option list, which shows the
    // opponent's hand to the chooser. Its only unmodelled consequence is that the
    // knowledge does not persist past the question.
    //
    // The DECISION is Mindsplitter's, plus a price and a draw. The price is
    // charged at ANSWER time and only on a real choice, so declining costs
    // nothing; `canSpendXp` gates the options so a card is never offered and then
    // refused for XP the player does not have (416.3).
    //
    // "They discard that card AND DRAW 1" — the draw is the victim's, and it is
    // what makes this a tempo card rather than a hand-size one. Routed through
    // `discardCards` so the discarded card still fires its own on-discard trigger
    // and still sets `discardedThisTurn`, exactly as Mindsplitter's does.
    targeting: { kind: "none" },
    resolve: (state, ctx) => parkDecision(state, { kind: "UNL-135-take", playerIndex: ctx.casterIndex }),
  },
  // # Two Chaos units REFUSED in wave 8b, 2026-08-13, and both re-measured first
  //
  // Named here rather than left silent, because a refusal nothing records is
  // indistinguishable from a card nobody looked at. Every claim below was driven
  // through `submit` in `test/unl-chaos-wave8-refusals.test.ts` rather than read
  // off a neighbouring comment — which is how one third of the previous wave's
  // reasoning about these two turned out to be wrong.
  //
  // **UNL-122 Crescent Guardian** — "If you've played a spell this turn, you may
  // pay [Chaos] as an additional cost to play me. If you do, I enter ready."
  //
  // Wave 7 named three blockers. **The third is FALSE and is retracted here:** it
  // said "I enter ready" needs a `deploy.conditionalEntersReady` case to see
  // `optionalPowerPaid`. It does not. The flag rides the PlayCardAction into
  // `dispatchOnPlayUnit`, and UNL-028 Pyke - Dockside Butcher already readies
  // himself from a plain on-play trigger that reads it — measured through
  // `legalActions` + `submit`, with the unpaid variant as the paired control
  // (paid: ready, unpaid: exhausted). So this half is four lines in THIS file.
  //
  // The DIVERGENCE that route carries is recorded rather than hidden, because it
  // is real and it is Pyke's too: "I enter ready" is a REPLACEMENT, so a unit
  // readied by its own on-play trigger has entered exhausted and been readied —
  // it sits exhausted through the response window, it fires `unitReadied`, and
  // Mageseeker Warden can stop it. `deploy.unitEntersReady` is the correct home;
  // the trigger is the approximation the pool already ships.
  //
  // The other two blockers HOLD, and both are about the CONDITION rather than the
  // payout:
  //
  //   - **Nothing in this engine records that a player has played a spell.** A
  //     census of `PlayerState` finds eight spell-named fields and not one of
  //     them counts plays; the only candidate, `maxSpellEnergySpentThisTurn`, is
  //     a MAXIMUM over single spells, and a 0-Energy spell leaves it at 0 —
  //     measured by playing SFD-122 Called Shot, which is the pool's only
  //     0-Energy Spell (1 of 192) but not the only route there, since 811 makes a
  //     `[Hidden]` play cost nothing and a discount can reach 0 from above.
  //     `SpellChainEntry.energySpent` and `spellCast.energySpent` (both new on
  //     2026-08-12) do not help either: they are per-ITEM, live only while the
  //     item exists, and answer "what did THIS spell cost".
  //     That is one required `PlayerState` field, one increment in
  //     `execute-play-card`'s Spell branch, one reset in `runEnd` and one in
  //     `player-setup`. All shared.
  //   - **`OPTIONAL_POWER_COSTS` has no condition field.** Its record is
  //     `{ domain?, count?, energy? }` and `legal-actions` offers the paid variant
  //     whenever the runes are payable. A bare row would therefore make the cost
  //     offerable on a turn the card forbids it — STRONGER than printed, which is
  //     the direction this file works hardest to avoid, and the reason the
  //     Pyke/Nami precedent (write the trigger, let the integrator add the row)
  //     does NOT apply to this card. Enforcing the condition in the trigger
  //     instead is worse still: the rune would be spent for nothing, which is
  //     416.3's offered-then-refused shape wearing a different hat.
  //
  // **UNL-146 Syndra - Transcendent WAS refused here and is written now
  // (2026-08-14).** Her refusal was re-measured twice and both corrections held:
  //
  //   - the two-instance case really was NOT the problem — `legal-actions`
  //     already crosses a granted instance with a printed one;
  //   - the real blocker really was the DOMAIN. "Your spells have [Repeat]
  //     [2][Chaos]" hands a Chaos pip to spells of every domain, and none of
  //     `RunePayment`'s three buckets could say that: `powerRunes` is checked
  //     against the CARD's domain (demanding Fury of a Fury spell) and
  //     `rainbowRunes` against none (accepting any rune, stronger than printed).
  //
  // `RunePayment.foreignPowerRunes` is the fourth bucket, and her grant lives in
  // `engine/repeat-grants.ts` as a STANDING source rather than on
  // `nextSpellRepeatGrants` — that counter is spent by the next spell played, so
  // riding it would have given her one repeatable spell per arming instead of
  // every spell she stands in a showdown for. That was the third blocker, and it
  // was right too.
  //
  // **Her arrival is what makes `RepeatCostSpec.domain` live.** The refusal's
  // parting note — "worth fixing whoever takes this, independently of Syndra: it
  // is a field that looks like it works" — was the useful part: it was dead data,
  // correct only because all fourteen printed Repeats are in their own card's
  // domain, which `repeat-cost-table.test.ts` asserts card by card and is exactly
  // why nobody noticed.
};

/** Angler Beast's net — "all units with 2 [Might] or less". */
const ANGLER_BEAST_MAX_MIGHT = 2;

/** Walking Roost's gift to the other seat — "a 1 [Might] Bird unit token with
 *  [Deflect]". Local rather than in token.ts: one owner, unlike the three specs
 *  hoisted there once two files each minted them. */

/** Insightful Investigator's price — "you may pay 2 XP". */
const INVESTIGATOR_XP = 2;

/** [Deathknell] effects — rule 808, "When I die, [Effect]". Keyed by the DYING
 *  card's defId. Same one-file-one-owner rule as the registries above. */
export const deathTriggers: Record<string, DeathknellDefinition> = {
  "SFD-148": {
    resolve: (state, ctx, death) => {
    // Draven - Audacious, SECOND clause — "When I die IN COMBAT, choose an
    // opponent. They score 1 point."
    //
    // A drawback, and it is the price his first clause is written against, so
    // shipping one without the other would have made him strictly stronger
    // than printed.
    //
    // `diedInCombat` is the whole test. A removal spell at a battlefield must
    // NOT pay out, which is exactly what a `battlefieldId !== undefined` check
    // would have done.
    //
    // "Choose an opponent" reduces to the one opponent in a 2-player game, so
    // no question is asked. Named rather than silently dropped: it is the line
    // that changes for multiplayer, not a simplification of a real choice.
    if (death.diedInCombat !== true) return state;
    // `ctx.opponentIndex` is the dying unit's controller's opponent, which is
    // who "an opponent" means — the effect context is built for the dead
    // Draven's side, not the killer's.
    const opponentIndex = ctx.opponentIndex;
    const players = [...state.players] as [PlayerState, PlayerState];
    // Through `gainPoints`, the single choke point every point-gain goes through
    // so Tianna Crownguard's "opponents can't gain points" reaches it.
      return gainPoints(state, opponentIndex, 1);
    },
  },
  // Undercover Agent — "[Deathknell] Discard 2, then draw 2." (rule 808)
  //
  // Order matters and the card spells it out with "then": the two discards leave
  // hand before the two draws arrive, so a card just drawn can never be one of
  // the cards discarded. Doing it in one step would let that happen.
  //
  // A Deathknell has no action to carry the choice on, so the discard stops and
  // asks — which is exactly why "then" needs `discardThenDraw` rather than
  // wrapping drawCards around it: the draw has to queue behind the questions, or
  // the cards it adds join the pool being discarded from.
  "OGN-178": { resolve: (state, ctx) => discardThenDraw(state, ctx.casterIndex, 2, 2) },

  // Kog'Maw - Caustic — "[Deathknell] Deal 4 to all units at my battlefield."
  //
  // The card triggers.ts's DeathContext doc comment names as the reason
  // `battlefieldId` is captured before the corpse reaches the trash (383.3 / 377.3.a.1):
  // by the time this runs, asking the board where Kog'Maw is would find him in a
  // trash and "my battlefield" would have no answer.
  //
  // He is NOT among the 4 damage's targets, and that falls out of `killUnit`'s
  // ordering rather than needing a filter: the unit is removed from the board and
  // trashed before triggers fire, precisely so "all units at my battlefield"
  // cannot include the corpse.
  //
  // "ALL units", so his own side takes it too — the card names no owner, and this
  // is a symmetric blast that is often worse for the player who cast him.
  // Undefined `battlefieldId` means he died in base, where there is no
  // battlefield and so nothing to hit.
  //
  // `ctx.casterIndex` is his controller, which is who is dealing this damage —
  // so Annie - Fiery's +1 applies to it and a damage-modifier read from the
  // victim's side would be wrong.
  "OGN-190": {
    resolve: (state, ctx, death) =>
      death.battlefieldId === undefined ? state : dealDamageToAllUnitsAt(state, ctx.casterIndex, death.battlefieldId, 4),
  },
};

/**
 * Deals `amount` to every unit at ONE battlefield, both owners' — the shape
 * "all units at my battlefield" needs, and the one variant effect-helpers does
 * not carry (it has enemy-units-at-one-battlefield and all-units-at-ALL-
 * battlefields, neither of which is this).
 *
 * The id list is snapshotted before any damage lands, for the same reason
 * `dealDamageToEnemyUnitsAtBattlefield` does it: a unit killed by an earlier
 * iteration must not shorten the loop, and `dealDamage` already no-ops on an id
 * that has since left play.
 */
function dealDamageToAllUnitsAt(state: GameState, casterIndex: 0 | 1, battlefieldId: string, amount: number): GameState {
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  if (!bf) return state;
  const targetIds = Object.values(bf.units).flatMap((units) => units.map((u) => u.instanceId));
  return targetIds.reduce((next, id) => dealDamage(next, casterIndex, id, amount), state);
}

/** Listeners for board EVENTS other than a death (see triggers.ts's GameEvent).
 *  Keyed by the LISTENING card's defId. Same one-file-one-owner rule. */
/** Listeners for someone ELSE dying ("when a buffed friendly unit dies"), keyed
 *  by the LISTENING card's defId. Distinct from `deathTriggers` above, which is
 *  a [Deathknell] keyed by the DYING card. Same one-file-one-owner rule. */
export const deathWatchTriggers: Record<string, DeathWatchDefinition> = {
  "UNL-129": {
    // Vicious Snapjaws — "When another friendly unit dies, gain 1 XP."
    //
    // Viktor - Leader's shape (OGN-246, effects/order.ts) with the payout swapped
    // and one of his two exclusions dropped: this card says nothing about tokens,
    // so a Recruit dying pays out.
    //
    // "FRIENDLY" is relative to the LISTENER, not to the dying unit's own view of
    // the world — which is the whole reason a death-watch is handed both. An
    // opponent losing a unit is not the Snapjaws' moment.
    //
    // "ANOTHER" is his own instanceId, and it is load-bearing rather than a
    // formality: he is a legal victim of every board wipe in the pool, and
    // without it he would pay out on his own death. The board he is on when he
    // dies still has him in `death.unit`, so the comparison is available.
    //
    // Both conditions are facts about the DEATH — captured before the corpse
    // reached the trash (383.3 / 377.3.a.1) — so both settle at fire time, and the
    // response window a held trigger opens cannot change either. That is the
    // split `DeathWatchDefinition.applies` exists to make.
    //
    // No cap and no once-a-turn: three units dying to one sweep pays three times,
    // because `killUnit` fires one death per unit and the card names no limit.
    applies: (_state, listener, death) =>
      death.ownerIndex === listener.ownerIndex && death.unit.instanceId !== listener.card.instanceId,
    // Through `gainXp`, the single choke point every XP gain goes through — see
    // its note for why it exists even with nothing yet able to forbid the gain.
    resolve: (state, listener) => gainXp(state, listener.ownerIndex, 1),
  },
  "UNL-145": {
    // Pyke - Returned — "[Hidden][Backline] ONCE EACH TURN, when an enemy unit
    // dies while I'm at a battlefield, play a Gold gear token exhausted."
    //
    // # The two trigger conditions, and which seat each is measured from
    //
    // "An ENEMY unit" is relative to the LISTENER, not to the dying unit's own
    // view of the world — the reason a death-watch is handed both. It is the
    // mirror of Vicious Snapjaws above, and the `!==` is the whole difference
    // between the two cards. Nothing excludes tokens, so an enemy Recruit dying
    // mints a Gold; **383.3.e**'s own worked example uses exactly that case.
    //
    // "WHILE I'M AT A BATTLEFIELD" is `listener.battlefieldId`, which is undefined
    // for a unit in base (and for Gear, and for the Legend). So a Pyke sitting at
    // home watches an enemy die and mints nothing — which is the clause's whole
    // job, since `[Hidden]` puts him at a battlefield by construction and this is
    // what stops him from paying out after he has been sent back.
    //
    // Both are facts settled at FIRE time (383), captured before the corpse
    // reached the trash, so the response window a held trigger opens cannot
    // change either. That is the split `applies` exists to make.
    //
    // # "ONCE EACH TURN" is checked TWICE, and 383.3.e.1 is why
    //
    // The rule says two things in one sentence: *"Such a Triggered Ability will
    // only be **performed** the specified number of times each turn. If its
    // trigger condition would be fulfilled and it **has already been performed**
    // that many times, **it does not trigger**."*
    //
    // The second half is a gate on TRIGGERING, so it belongs in `applies` — a Pyke
    // that has already minted places no Pending Item at all, rather than one that
    // closes the chain, costs both players a PassFocus and resolves to nothing.
    //
    // The first half is a cap on PERFORMANCES, so it is re-asked in `resolve`.
    // The two differ only for SIMULTANEOUS deaths: two enemies dying to one
    // sweep both fulfil the condition while nothing has yet been performed, so
    // both trigger — and the resolve-side guard is what keeps the second from
    // minting a second Gold. Taking only the `applies` guard would have paid twice
    // for a "once each turn", which is the direction this file will not err in.
    // Wraith of Echoes (OGN-118, triggers.ts) splits its own per-turn allowance
    // the same way and for the same reason.
    //
    // # The mark is per-UNIT, not per-player
    //
    // `abilityModesUsedThisTurn` on the UnitInstance, cleared by `turn-manager`'s
    // runEnd for every unit on both sides — so two Pykes keep two separate
    // allowances, which a `PlayerState` flag could not express. Draven -
    // Audacious's entry below records this field being borrowed for a
    // trigger-reached allowance and says in as many words that "if a second
    // per-unit once-a-turn card lands, that field is the right answer". This is
    // that card, and it takes that answer.
    //
    // Read off the LIVE unit rather than off the listener snapshot, which was
    // taken when the death fired: a second death resolving off the same board must
    // see the first one's mark. `recordModeUsed` writes it wherever he now stands.
    //
    // A Pyke who is GONE by the time this resolves still mints — `resolvePendingTrigger`
    // falls back to the captured card (359.3) — and there is then nowhere to write
    // the memory and nothing that could spend it, since a unit off the board is not
    // a listener and cannot trigger again this turn. Same shape as
    // `scoreFirstCombatWin`'s.
    //
    // # The token
    //
    // `placeGoldTokens` — the shared maker, so the Gold arrives with the printed
    // ability `activated-abilities.ts` registers under `GOLD_TOKEN_DEF_ID` and
    // Renata Glasc - Industrialist's "tokens enter ready" replacement (375) still
    // reaches it. "EXHAUSTED" is the generating effect's 184.1 modification, which
    // is that helper's only mode and is what every card that mints one prints.
    applies: (state, listener, death) => {
      if (death.ownerIndex === listener.ownerIndex) return false;
      if (listener.battlefieldId === undefined) return false;
      return !pykeHasMinted(state, listener.card.instanceId);
    },
    resolve: (state, listener) => {
      if (pykeHasMinted(state, listener.card.instanceId)) return state;
      const minted = placeGoldTokens(state, listener.ownerIndex, PYKE_GOLD_TOKENS);
      return findUnitAnywhere(minted, listener.card.instanceId)
        ? recordModeUsed(minted, listener.ownerIndex, listener.card.instanceId, PYKE_GOLD_MINTED)
        : minted;
    },
  },
};

/** Pyke - Returned's once-a-turn mark, and how many Gold he mints when he does. */
const PYKE_GOLD_MINTED = "UNL-145-gold-minted";
const PYKE_GOLD_TOKENS = 1;

/** Has this Pyke already spent his "once each turn" (383.3.e.1)? Asked of the
 *  LIVE unit; a Pyke who has left the board has no mark and cannot trigger
 *  again anyway. */
function pykeHasMinted(state: GameState, instanceId: string): boolean {
  return findUnitAnywhere(state, instanceId)?.unit.abilityModesUsedThisTurn.includes(PYKE_GOLD_MINTED) ?? false;
}

/** Spirit Wheel's optional draw. */
const SPIRIT_WHEEL_DRAW_COST = 1;

export const eventTriggers: Record<string, EventTriggerDefinition> = {
  "VEN-110": {
    // Mel, Defiant Soul — "[Empower] — Discard a spell. When I become
    // [Empowered], banish an enemy unit at a battlefield with 3 [Might] or less."
    //
    // # Her COST is generated, and this is the half that is not
    //
    // "Discard a spell" is read by `parseEmpowerCost` into `{ discard: 1,
    // discardKind: "Spell" }` and becomes the generated `[Empower]` ability like
    // every other. **That means she reported IMPLEMENTED the moment the cost
    // parsed, with this clause doing nothing** — the half-written-card shape, and
    // the reason this entry was written in the same change rather than the next
    // one.
    //
    // # The moment
    //
    // `becameEmpowered` is a new event fired from `empowerPermanent`, the single
    // WRITER of the status — so she triggers however she was empowered, not only
    // off her own ability. Sanction, Ambessa's hook, or a future card all reach
    // her, which is what "when I become Empowered" says.
    //
    // "**I**" is by instance, so a second Mel on the board does not fire this one.
    //
    // # It is MANDATORY, and the target is chosen at RESOLUTION
    //
    // No "you may" is printed, so there is no decline. The choice of victim is a
    // question rather than an action axis because a trigger has no action to fan
    // targets onto — the same reason every other targeted trigger in this file
    // parks one.
    //
    // `applies` refuses when there is no legal victim, which is what keeps a
    // response window from opening on an ability that will resolve to nothing —
    // the exact reason `applies` exists. Re-checked in the decision's own
    // `options` too, because the board can change while the trigger waits.
    on: "becameEmpowered",
    applies: (state, listener, event) =>
      event.kind === "becameEmpowered" &&
      event.permanentInstanceId === listener.card.instanceId &&
      melBanishCandidates(state, listener.ownerIndex).length > 0,
    resolve: (state, listener) =>
      parkDecision(state, { kind: MEL_DEFIANT_BANISH, playerIndex: listener.ownerIndex }),
  },
  "VEN-109": {
    // Illaoi, Prophet of the Great Kraken — the "WHEN I SCORE" half. Her on-play
    // half is a `unitTriggers` entry and her Might clause a `mightModifiers` one.
    //
    // **"When I SCORE" is BOTH scoring methods**, which is why this listens to two
    // events: 469 makes Scoring the umbrella and 470 says "a player may only
    // Score, from either method, once per Battlefield per turn" — so a Conquer and
    // a Hold are two ways of doing the one thing the card names. A version keyed to
    // conquest alone would silently pay nothing on a turn spent holding.
    //
    // Positional, like every "when I" in this pool: she has to be standing at the
    // battlefield that scored. Settled in `applies` because both events are held
    // (383) and the window a hold opens is exactly when she could be moved off it.
    on: ["battlefieldConquered", "battlefieldHeld"],
    applies: (_state, listener, event) =>
      event.kind === "battlefieldConquered"
        ? event.conquerorIndex === listener.ownerIndex && listener.battlefieldId === event.battlefieldId
        : event.kind === "battlefieldHeld" &&
          event.holderIndex === listener.ownerIndex &&
          listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldConquered" && event.kind !== "battlefieldHeld") return state;
      return placeToken(state, listener.ownerIndex, "base", TENTACLE_TOKEN);
    },
  },
  "VEN-112": {
    // Zed, Without a Sound — the "WHEN I CONQUER" half, "play a 0 [Might] Shadow
    // Clone unit token TO YOUR BASE". His `[Action][>]` swap is an
    // `activatedAbilities` entry.
    //
    // **"To your base" is PRINTED here**, unlike VEN-023 Zed's token — so this one
    // is not the recorded destination narrowing, it is the card. Worth stating
    // because the two Zeds make the same token by two different routes and only
    // one of them is a simplification.
    //
    // The Clone's own printed ability lives in `engine/triggers.ts` under the
    // token's runtime defId; nothing here needs to know about it.
    on: "battlefieldConquered",
    applies: (_state, listener, event) =>
      event.kind === "battlefieldConquered" &&
      event.conquerorIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) =>
      event.kind === "battlefieldConquered" ? placeToken(state, listener.ownerIndex, "base", SHADOW_CLONE_TOKEN) : state,
  },
  "VEN-113": {
    // Kennen, Storm of Shuriken — the "WHEN I CONQUER" half, "give a spell in your
    // trash [Flow] equal to its cost this turn". His on-play `[Burn 2]` is a
    // `unitTriggers` entry.
    //
    // # Granting [Flow] is granting a REPLACED COST, and the seam exists
    //
    // 829.1.c.1 makes a Flow cost an alternative cost paid from the trash, and
    // `PlayerState.replacedCostPlays` already carries exactly that as a per-INSTANCE
    // permission — Death from Below's grant is the precedent. So this needs no new
    // mechanism: it records a grant whose price is the spell's OWN printed cost,
    // which is what "equal to its cost" says.
    //
    // **Per instance, not per defId**, which the grant type's own note insists on:
    // a second copy of the same spell in the same trash is a different object and
    // was granted nothing.
    //
    // "THIS TURN" is what `runEnd` clearing `replacedCostPlays` provides, so the
    // duration needs nothing here either.
    on: "battlefieldConquered",
    applies: (state, listener, event) =>
      event.kind === "battlefieldConquered" &&
      event.conquerorIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId &&
      state.players[listener.ownerIndex].trash.some((c) => c.kind === "Spell"),
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldConquered") return state;
      if (!state.players[listener.ownerIndex].trash.some((c) => c.kind === "Spell")) return state;
      return parkDecision(state, { kind: KENNEN_SHURIKEN_FLOW, playerIndex: listener.ownerIndex });
    },
  },
  "VEN-095": {
    // Shadow Order Disciple — "When I move, you may [Burn 1] to give me +1
    // [Might] this turn."
    //
    // The board-wide `unitMoved` EVENT rather than unit-triggers.ts's per-card
    // `ON_MOVE_TRIGGERS`, which is module-private and not this file's to edit —
    // the route Jhin - Murderous Artist and Eclipse Dragon both take.
    //
    // **The Burn is a COST inside an instruction** (355.10.c.1's "[do X] to [do
    // Y]"), so declining to burn and declining the pump are one answer — which is
    // why the question carries a single decline rather than two.
    //
    // Unlike a Power or Energy cost this one is ALWAYS payable in the sense 416.3
    // cares about: rule 440.4 burns as many as possible and 431 recycles an empty
    // deck, so there is no board on which "Burn 1" cannot be completed. The offer
    // is therefore always made, and the only reason not to take it is that milling
    // yourself is a real price.
    on: "unitMoved",
    applies: (_state, listener, event) =>
      event.kind === "unitMoved" && event.unitInstanceId === listener.card.instanceId,
    resolve: (state, listener, event) => {
      if (event.kind !== "unitMoved" || event.unitInstanceId !== listener.card.instanceId) return state;
      return parkDecision(state, {
        kind: DISCIPLE_BURN_OFFER,
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
      });
    },
  },
  "VEN-111": {
    // Minah Swiftfoot — "When I move TO A BATTLEFIELD, choose one — Each player
    // discards 1. / Each player draws 1."
    //
    // **"To a battlefield" is printed and is load-bearing**, because `unitMoved.to`
    // is NOT always a battlefield: 455/456 make a walk home a Move, and the
    // event's own note records Mister Root and Corina Veraza both being caught
    // paying out for one. So the destination is tested rather than assumed.
    //
    // "EACH player", not "an opponent" — both seats discard, both seats draw. That
    // symmetry is the card: it is a knob you turn when the symmetry favours you,
    // and `discardCards`/`drawCards` are called once per seat so each player's own
    // `cardsDiscarded`/`cardDrawn` events fire for them.
    //
    // A modal decision rather than two triggers: 402.1 puts a triggered ability's
    // choices at the moment it resolves, and "choose one" is exactly such a
    // choice.
    on: "unitMoved",
    applies: (_state, listener, event) =>
      event.kind === "unitMoved" &&
      event.unitInstanceId === listener.card.instanceId &&
      event.to !== "base",
    resolve: (state, listener, event) => {
      if (event.kind !== "unitMoved" || event.unitInstanceId !== listener.card.instanceId) return state;
      // Re-checked at resolution: the inline `dispatchEvent` path never consults
      // `applies`, so a condition asserted only there holds on one route in.
      if (event.to === "base") return state;
      return parkDecision(state, { kind: MINAH_MODE, playerIndex: listener.ownerIndex });
    },
  },
  "VEN-102": {
    // Ravenbloom Prefect — "When an OPPONENT plays a GEAR, you may banish ME to
    // banish IT."
    //
    // # Not a counter, and the difference is observable
    //
    // The gear is banished AFTER it has been played and resolved — this engine's
    // `cardPlayed` fires once the card is in play, which the event's own note
    // states. So a gear with a "when you play this" trigger gets that trigger, and
    // only then leaves. A counter (`counterSpell`) would stop it resolving at all,
    // and nothing in this card's text does that.
    //
    // # Banishing HIMSELF is the cost
    //
    // 355.10.c.1's "[do X] to [do Y]" again, so one question with one decline. He
    // is banished rather than killed — 427.2.a, "Banish is not a subset of Kill" —
    // so his own death triggers do not fire and nothing prices off him dying.
    //
    // "An OPPONENT plays" is measured from HIS controller, and `playedKind` is what
    // separates a gear from anything else. A TOKEN gear (the Gold token) is
    // deliberately NOT excluded: 185 makes a token not a card, and this clause says
    // "plays a GEAR", which a Gold token is.
    on: "cardPlayed",
    applies: (_state, listener, event) =>
      event.kind === "cardPlayed" && event.casterIndex !== listener.ownerIndex && event.playedKind === "Gear",
    resolve: (state, listener, event) => {
      if (event.kind !== "cardPlayed") return state;
      if (event.casterIndex === listener.ownerIndex || event.playedKind !== "Gear") return state;
      return parkDecision(state, {
        kind: PREFECT_BANISH,
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
        // WHICH gear — the one just played, on `targetInstanceId` since
        // `cardInstanceId` already carries the Prefect himself. Captured because by
        // the time this is answered the chain has moved on and "the gear that was
        // played" is not re-derivable from the board.
        targetInstanceId: event.playedInstanceId,
      });
    },
  },
  "VEN-108": {
    // Forgotten Relic — "When you play this OR at the start of your Beginning
    // Phase, [Burn 1]. When you burn a unit this way, do this: Give a friendly
    // unit +[Might] equal to the burned card's Might this turn."
    //
    // # The only card in the pool that reads WHAT it burned
    //
    // `burnCards` returns the cards it took for exactly this: the identity cannot
    // be peeked beforehand, because a Burn Out mid-instruction (440.4) changes
    // which cards the rest of the burn takes. Reading the trash afterwards would
    // pick up whatever else the turn had put there.
    //
    // "When you burn A UNIT this way" — a Spell or Gear burned pays nothing, and
    // the amount is the burned card's PRINTED Might, which is the only Might a
    // card in a trash has.
    //
    // # TWO moments, and they are registered in TWO tables
    //
    // This entry is the "at the start of your Beginning Phase" half only. The
    // "when you play this" half is a `selfTriggers` entry below — the route all
    // nine other gears in the pool with that clause take.
    //
    // **A first draft registered both on ONE definition as `["cardPlayed",
    // "beginningPhase"]`, and the trigger census refused it.** `beginningPhase`
    // is the one kind this engine resolves INLINE, and the census asserts that an
    // inline trigger's `on` is exactly `["beginningPhase"]` — a definition
    // straddling the line would be half-held and half-inline, which is a shape
    // nothing else in the pool has and which the structural claim exists to catch.
    // Splitting is both cleaner and what every precedent already does.
    on: "beginningPhase",
    resolve: (state, listener, event) => {
      if (event.kind !== "beginningPhase" || event.playerIndex !== listener.ownerIndex) return state;
      return forgottenRelicBurn(state, listener.ownerIndex);
    },
  },
  "SFD-142": {
    // Jae Medarda — "When you choose me with a spell, draw 1."
    //
    // **"With a SPELL" is the whole reason `unitChosen` carries `bySpell`.** He
    // is the first card in the pool to narrow the moment to one of the two
    // choosing paths: Irelia - Fervent and Spirit Wheel both read a bare "when
    // you choose", and before him the event had no way to tell an ability's
    // choice from a spell's. Reading the wider sentence would have him draw off
    // Jax - Grandmaster At Arms pointing at him, which he does not say.
    //
    // "When YOU choose" is his own side, the same reading Irelia - Fervent's
    // entry takes — an opponent paying to choose him is a different sentence,
    // and one this card does not print.
    //
    // Not capped: one event per choice (see `holdUnitsChosen`), so a spell that
    // names him twice draws twice. The card says nothing about once per turn.
    on: "unitChosen",
    applies: (_state, listener, event) =>
      event.kind === "unitChosen" &&
      event.bySpell &&
      event.unitInstanceId === listener.card.instanceId &&
      event.chooserIndex === listener.ownerIndex,
    resolve: (state, listener) => drawCards(state, listener.ownerIndex, 1),
  },
  "SFD-144": {
    // Spirit Wheel — "When you choose a friendly unit, you may pay [1] and
    // exhaust this to draw 1."
    //
    // A GEAR watching a moment that happens to a UNIT, which the listener walk
    // already reaches: `allListeningPermanents` includes `activeGear`.
    //
    // Three conditions and all three are printed. **"YOU choose"** is its
    // controller doing the choosing. **"a FRIENDLY unit"** is friendly to that
    // same controller — so choosing an enemy unit with a removal spell is not
    // its moment, which is what makes it a build-around rather than a Cantrip on
    // every spell. **"exhaust this"** means a Wheel already exhausted cannot pay,
    // so it is once a turn by construction rather than by a counter.
    //
    // Both halves of the cost are checked at fire time, because an offer nobody
    // can take is not made — the rule this file applies throughout — and both
    // are re-derived at answer time in the decision below.
    //
    // Unlike Jae Medarda above it reads a bare "when you choose", so it takes
    // BOTH paths and does not consult `bySpell`.
    on: "unitChosen",
    applies: (state, listener, event) => {
      if (event.kind !== "unitChosen") return false;
      if (event.chooserIndex !== listener.ownerIndex) return false;
      const gear = state.players[listener.ownerIndex].activeGear.find((g) => g.instanceId === listener.card.instanceId);
      if (gear === undefined || gear.exhausted) return false;
      const chosen = findUnitAnywhere(state, event.unitInstanceId);
      if (chosen === undefined || chosen.ownerIndex !== listener.ownerIndex) return false;
      return payEnergyFromPool(state, listener.ownerIndex, SPIRIT_WHEEL_DRAW_COST) !== undefined;
    },
    resolve: (state, listener) =>
      parkDecision(state, {
        kind: "SFD-144-draw",
        playerIndex: listener.ownerIndex,
        // The Wheel that fired is the one that must exhaust. Carried on the
        // decision rather than re-found at answer time, because a second Wheel
        // could be in play and paying with the wrong one is a different game.
        cardInstanceId: listener.card.instanceId,
      }),
  },
  "SFD-150": {
    // Last Rites — "When I conquer or hold, you may play a unit from your trash
    // (still paying costs)."
    // **ART-ONLY ABILITY.** None of this is in the card data — `text.plain` holds
    // the compound `[Equip]` line and nothing else. Transcribed from the card
    // image; see docs/sfd-equipment-abilities.md.
    //
    // "I" is the WEARER, so `wearerListener` as with the eight beside it. The
    // OR is what needs `on` to be a list: this is a two-moment ability on one
    // defId, the shape that widening `on` was added for.
    //
    // **The permission, and why it is not a play here.** 419.3.b makes this a
    // Limited Play Effect performed during resolution with every step of Play
    // normal — which includes paying. This engine cannot pay mid-resolution:
    // a play needs a RunePayment and `AnswerDecisionAction` carries only an
    // `optionId`. So the trigger opens a window that `legal-actions` offers and
    // `execute-play-card` spends, at the printed price. The divergence is that
    // the window outlives the trigger, and it is recorded in
    // docs/rules-conformance.md rather than left to be discovered.
    //
    // **"You MAY" needs nothing here.** The permission is an option the player
    // takes or ignores by acting; there is no question to park, and parking one
    // with a single option would auto-resolve anyway.
    //
    // Granted unconditionally on the moment rather than gated on the trash
    // holding a unit: the trash can gain one later in the same turn, and a
    // permission checked at grant time would wrongly have expired.
    on: ["battlefieldConquered", "battlefieldHeld"],
    applies: (state, listener, event) => {
      const wearer = wearerListener(state, listener);
      if (wearer === undefined) return false;
      if (event.kind === "battlefieldConquered") {
        return event.conquerorIndex === wearer.ownerIndex && wearer.battlefieldId === event.battlefieldId;
      }
      return (
        event.kind === "battlefieldHeld" &&
        event.holderIndex === wearer.ownerIndex &&
        wearer.battlefieldId === event.battlefieldId
      );
    },
    resolve: (state, listener) => {
      const wearer = wearerListener(state, listener);
      if (wearer === undefined) return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      const owner = players[wearer.ownerIndex]!;
      players[wearer.ownerIndex] = { ...owner, trashUnitPlaysThisTurn: owner.trashUnitPlaysThisTurn + 1 };
      return { ...state, players };
    },
  },
  "SFD-124": {
    // Doran's Ring — "When I conquer, discard 1, then draw 1."
    // **ART-ONLY ABILITY.** None of this is in the card data — `text.plain` holds
    // the `[Equip]` line and nothing else, which is why this card reported
    // IMPLEMENTED while doing none of it. Transcribed from the card image; see
    // docs/sfd-equipment-abilities.md.
    //
    // "I" is the WEARER. `wearerListener` rewrites this gear's listener as the
    // unit wearing it, so every existing predicate applies unchanged.
    // `discardThenDraw`, NOT `drawCards(discardCards(...))`: the "then" is
    // load-bearing and the discard stops to ask, so the draw has to be queued
    // BEHIND the question or the card just drawn joins the hand being chosen
    // from. Scrapyard Champion's comment records the same trap.
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
      return wearer === undefined ? state : discardThenDraw(state, wearer.ownerIndex, 1, 1);
    },
  },
  "SFD-134": {
    // Cull — "When I conquer, play a Gold gear token exhausted."
    // **ART-ONLY ABILITY.** None of this is in the card data — `text.plain` holds
    // the `[Equip]` line and nothing else, which is why this card reported
    // IMPLEMENTED while doing none of it. Transcribed from the card image; see
    // docs/sfd-equipment-abilities.md.
    //
    // "I" is the WEARER. `wearerListener` rewrites this gear's listener as the
    // unit wearing it, so every existing predicate applies unchanged.
    // Plundering Poro's sentence exactly, on a piece of gear instead of a body.
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
      return wearer === undefined ? state : placeGoldTokens(state, wearer.ownerIndex, 1);
    },
  },
  "OGN-177": {
    // Stealthy Pursuer — "When a friendly unit moves FROM MY LOCATION, I may be
    // moved with it."
    //
    // Three conditions, and the first two are what make him a follower rather
    // than a second [Ganking] unit: the mover must be FRIENDLY, and it must have
    // left where he is standing. He does not follow an enemy, and he does not
    // teleport to a fight two battlefields away.
    //
    // **DIVERGENCE, and it is the unguessed rules call this card was blocked
    // on.** "Moved WITH it" reads as simultaneous, and this cannot be: the event
    // is a Chain Pending Item (383), so his move happens when the trigger
    // resolves — which `runCleanup` reaches AFTER `stageShowdowns`. He therefore
    // arrives at a battlefield whose Showdown is already staged, joining the
    // fight as an extra body rather than as part of the attack that opened it.
    // The alternative reading — that "with it" forbids being a held trigger at
    // all — would make him the only unit trigger in the pool resolved inline.
    // Recorded Unverified in docs/rules-conformance.md.
    //
    // He is deliberately NOT excluded from following a move he made himself:
    // nothing in this pool can move him and another friendly unit in one action
    // except a group MoveUnit, where the event fires per unit, and "a friendly
    // unit" includes his companions. `applies` does exclude the mover BEING him,
    // which is the one case that would let him chase his own move.
    on: "unitMoved",
    applies: (state, listener, event) => pursuerFollows(state, listener, event),
    resolve: (state, listener, event) => {
      if (!pursuerFollows(state, listener, event) || event.kind !== "unitMoved") return state;
      // "I MAY be moved" — a real choice, and one only its controller makes.
      return parkDecision(state, {
        kind: "OGN-177-follow",
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
        battlefieldId: event.to,
      });
    },
  },
  "OGN-205": {
    // Yasuo - Windrider — "[Ganking] The third time I move in a turn, you score
    // 1 point."
    //
    // Reads `event.movesThisTurn`, the mover's count AFTER the move, rather than
    // looking the unit up again: `unitMoved` is a Chain Pending Item, so between
    // firing and resolving he can be moved again, bounced or killed, and "the
    // third time" is a fact about the move that happened.
    //
    // EXACTLY the third, not the third-or-later — a fourth and fifth move score
    // nothing, the same reading Darius - Trifarian's "your SECOND card" takes.
    //
    // **A plain `points + 1`, deliberately NOT routed through `recordConquest`.**
    // The Final Point restriction (rule 474) applies only to a point gained
    // "through a Conquer"; the rules are explicit that points from other sources
    // are not beholden to it. Sending this through the conquest path would make
    // the winning point silently withheld unless every battlefield had been
    // scored that turn.
    on: "unitMoved",
    applies: (_state, listener, event) =>
      event.kind === "unitMoved" &&
      event.unitInstanceId === listener.card.instanceId &&
      event.movesThisTurn === 3,
    resolve: (state, listener, event) => {
      if (event.kind !== "unitMoved") return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      // Through `gainPoints`, the single choke point every point-gain goes through
      // so Tianna Crownguard's "opponents can't gain points" reaches it.
      return gainPoints({ ...state, players }, listener.ownerIndex, 1);
      return { ...state, players };
    },
  },
  "OGN-167": {
    // Ember Monk — "When you play a card from [Hidden], give me +2 Might this
    // turn."
    //
    // Note what he does NOT do: he has [Hidden] himself, but this triggers on
    // playing ANY card from facedown, his own arrival included if he was hidden.
    // The event carries `fromHidden` rather than existing as its own kind, so
    // nothing else that watches plays goes blind to hidden ones.
    //
    // "YOU play" — his own controller's hidden card, not the opponent's.
    on: "cardPlayed",
    // Both conditions are properties of the event, so they cannot drift between
    // firing and resolving — but they gate whether this reaches the chain at all,
    // which is what `applies` is for now that `cardPlayed` is held.
    applies: (_state, listener, event) =>
      event.kind === "cardPlayed" && event.fromHidden === true && event.casterIndex === listener.ownerIndex,
    resolve: (state, listener, event) => {
      if (event.kind !== "cardPlayed") return state;
      if (!event.fromHidden) return state;
      if (event.casterIndex !== listener.ownerIndex) return state;
      return giveMightThisTurnToOwnUnit(state, listener.ownerIndex, listener.card.instanceId, 2);
    },
  },
  "OGN-202": {
    // Jinx - Rebel — "When you discard one or more cards, ready me and give me
    // +1 Might this turn."
    //
    // "ONE OR MORE" pays out once per discard instruction, not once per card,
    // which is exactly why `cardsDiscarded` carries a count rather than firing
    // per card — a "discard 2" readies her once.
    //
    // "YOU discard" is her own controller: Mindsplitter making the OPPONENT
    // discard must not ready their Jinx.
    on: "cardsDiscarded",
    // "YOU discard" reads only the event and the listener's owner, so it is a
    // fire-time condition and settles whether a Pending Item is placed at all.
    // Not re-asked below: 383 fixes triggering at the moment of the event.
    applies: (_state, listener, event) => event.kind === "cardsDiscarded" && event.discarderIndex === listener.ownerIndex,
    resolve: (state, listener, event) => {
      if (event.kind !== "cardsDiscarded") return state;
      const readied = readyUnit(state, listener.card.instanceId);
      return giveMightThisTurnToOwnUnit(readied, listener.ownerIndex, listener.card.instanceId, 1);
    },
  },
  "SFD-121": {
    // Black Market Broker — "When you play a card from face down, play a Gold
    // gear token exhausted."
    //
    // "FROM FACE DOWN" is a play out of a Facedown Zone, which the rules
    // themselves gloss as the same thing as Hidden: "Playing a card from
    // facedown (or 'from Hidden') does open a chain" (811's discussion of the
    // keyword). So this is Ember Monk's (OGN-167, above) condition exactly, and
    // it is written against the same carried fact — `cardPlayed.fromHidden`,
    // which `executePlayCard` sets from `action.fromHiddenBattlefieldId`.
    //
    // That fact being on the EVENT is what makes this card implementable rather
    // than an approximation. Without it the only honest reading available would
    // be "when you play a card", which is strictly stronger than printed and
    // would pay out on every card the Broker's controller casts.
    //
    // "YOU play" — his own controller's facedown card, not the opponent's, the
    // same restriction Ember Monk carries. His own arrival counts if he was
    // himself played from facedown (Ember Monk's entry records the same), since
    // the event is fired after the card has resolved into play and the listener
    // walk therefore already finds him.
    //
    // Both conditions are properties of the event, so `applies` settles them at
    // fire time (383) and `resolve` cannot disagree with a board that has moved
    // on during the response window this hold opens.
    on: "cardPlayed",
    applies: (_state, listener, event) =>
      event.kind === "cardPlayed" && event.fromHidden === true && event.casterIndex === listener.ownerIndex,
    resolve: (state, listener, event) =>
      event.kind === "cardPlayed" && event.fromHidden === true && event.casterIndex === listener.ownerIndex
        ? placeGoldTokens(state, listener.ownerIndex, 1)
        : state,
  },
  "SFD-123": {
    // Corrupt Enforcer, FIRST clause only — "When I move to a battlefield,
    // discard 1."
    //
    // **WHOLE as of 2026-08-05.** The second clause — "When I win a combat,
    // draw 1" — needed a combat-WON event, which did not exist: `GameEvent`
    // carried only `combatBegan` and `battlefieldConquered`, and neither is
    // that. A conquest also fires on a walk-in, so paying out on one would
    // draw for a combat that never happened. `combatWon` now exists (466.5.a),
    // fired by combat.ts at both resolution shapes.
    //
    // It ALSO needed `EventTriggerDefinition.on` to accept a list: this
    // registry is keyed by defId, so before that a card could hold exactly one
    // event trigger and this clause had nowhere to live. Two blockers wearing
    // one symptom, and the wave report named only the first.
    //
    // Both clauses branch on `event.kind`, which is what makes one definition
    // able to serve two moments without the chain having to say which fired.
    //
    // The `unitMoved` EVENT rather than the per-card `ON_MOVE_TRIGGERS` table,
    // which lives in unit-triggers.ts and is not this file's to edit — Yasuo -
    // Windrider above is the precedent, and the event carries everything a "when
    // I move" card can ask.
    //
    // "TO A BATTLEFIELD" needs no destination check: a `MoveUnitAction` carries a
    // `destinationBattlefieldId`, so every Standard Move in this engine ends at
    // one. The event also never fires for a Recall (454, a Recall is not a Move)
    // or for a spell-driven relocation.
    //
    // **This comment used to add "which is the line the card wants" of BOTH
    // exclusions, and that was half wrong.** The Recall half is right — 454. The
    // spell-driven half is a DIVERGENCE, not a reading: 446.1 makes "a Permanent
    // changing its position from any space on the Board to another space on the
    // Board" a Move, and 449 says outright that "Spells, Abilities, or other
    // effects may cause a Move to occur". The engine misses those only because
    // `unitMoved` has a single emitter, `execute-move-unit.ts`.
    //
    // Left as behaviour (the fix is a held event from `effect-helpers`' two force
    // -move helpers, carrying who CAUSED the move) but no longer as a claim that
    // it is correct. Recorded in docs/rules-conformance.md and pinned by
    // "gains nothing when an EFFECT moves him" in test/unl-chaos-wave2.test.ts.
    // Corrected 2026-08-09 — a confident note that a gap is intentional is worse
    // than no note, because it stops the next reader looking.
    //
    // The discard goes through `discardCards`, so with more than one card in hand
    // it stops and ASKS rather than taking the front of hand, and it fires
    // `cardsDiscarded` once for the instruction — a Jinx - Rebel across the table
    // readies once, not never.
    on: ["unitMoved", "combatWon"],
    applies: (_state, listener, event) =>
      event.kind === "unitMoved"
        ? event.unitInstanceId === listener.card.instanceId
        : // "I win a combat" — my controller won, and I am standing where it
          // happened. A unit that died in the exchange is not a listener at all,
          // since the walk only finds permanents still in play, so surviving
          // needs no separate check.
          event.kind === "combatWon" &&
          event.winnerIndex === listener.ownerIndex &&
          listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) =>
      event.kind === "unitMoved"
        ? discardCards(state, listener.ownerIndex, 1)
        : event.kind === "combatWon"
          ? drawCards(state, listener.ownerIndex, 1)
          : state,
  },
  "SFD-125": {
    // Fae Porter — "When I move to a battlefield, you may pay [Chaos] to move a
    // unit you control to the same battlefield."
    //
    // "The SAME battlefield" is `event.to`, captured on the question rather than
    // re-read from where the Porter is standing when it resolves: `unitMoved` is
    // held (383), and the window it opens is exactly when he could be bounced or
    // moved on. The destination the card means is the one he arrived at.
    //
    // "You may PAY" is a cost inside an instruction (355.10.d.1's "[do X] to [do
    // Y]"), so the Chaos rune is not a target and the moved unit is. Affordability
    // is asked in `applies` as well as at resolution, following Draven -
    // Vanquisher: 416.3 makes a cost that cannot be completed one you may not
    // choose to pay, and a held trigger that resolves to nothing still costs both
    // players a PassFocus.
    //
    // "A unit YOU CONTROL" carries no location (355.9.a.1's bare noun), so a unit
    // sitting in base is a legal choice — and it is the main one, since this is
    // how the Porter reinforces. Units already at the destination are excluded:
    // there is no move for them to make.
    //
    // `forceMoveToBattlefield`, so the arrival applies Contested and can promote a
    // Showdown. It fires no on-move trigger and does not exhaust, which that
    // helper's own note records as this engine's reading of an effect-driven move
    // (415.1.b puts the exhaust on the Standard Move ACTION, not on moving).
    on: "unitMoved",
    applies: (state, listener, event) =>
      event.kind === "unitMoved" &&
      event.unitInstanceId === listener.card.instanceId &&
      payPowerFromChanneled(state, listener.ownerIndex, "Chaos", 1) !== undefined &&
      ownUnitsElsewhere(state, listener.ownerIndex, event.to).length > 0,
    resolve: (state, listener, event) => {
      if (event.kind !== "unitMoved") return state;
      return parkDecision(state, {
        kind: "SFD-125-move",
        playerIndex: listener.ownerIndex,
        battlefieldId: event.to,
      });
    },
  },
  "SFD-126": {
    // Loyal Pup — "When you defend at a battlefield, you may move me there."
    //
    // "YOU defend", not "I defend": the subject is the PLAYER, so this fires for a
    // Pup standing somewhere else entirely — which is the whole card. That also
    // means `isDefendingAt` is the wrong predicate (it requires the listener to be
    // one of the units designated in that combat), and `pupJoins` below is written
    // instead.
    //
    // 465 makes the Defender "the player who did not apply the Contested status",
    // which in a two-player game is simply the non-attacker. **This engine
    // additionally requires that player to have a unit at the battlefield**,
    // mirroring `cleanup.beginCombatAt`'s own guard on the battlefields' "when you
    // defend here" (Fortified Position, Reaver's Row) — the same printed wording,
    // so the two must agree. Recorded as this file's reading rather than derived:
    // 465 gives the PLAYER the designation regardless of presence.
    //
    // **Measured: that requirement is unreachable through the opening of a
    // combat.** `stageShowdowns` only reaches `beginCombatAt` when
    // `unitsOfBothPlayers` holds, so a one-sided contest stages a NON-Combat
    // Showdown and fires no `combatBegan` at all. The check therefore only bites
    // on `designateArrivals` — a reinforcement walking into a fight whose other
    // side has since been wiped — which is exactly where it should. Kept rather
    // than deleted for that path, and named here so nobody reads it as load-
    // bearing at the opening.
    //
    // Held (383), so the Pup arrives at a fight whose designations are already
    // handed out; 465 Step 1's second sentence covers him — he gains the Defender
    // designation at the Cleanup following his arrival, which is exactly what
    // `designateArrivals` does. He therefore reinforces the fight rather than
    // joining the opening of it, the same divergence Stealthy Pursuer records.
    on: "combatBegan",
    applies: (state, listener, event) => pupJoins(state, listener, event),
    resolve: (state, listener, event) => {
      if (!pupJoins(state, listener, event) || event.kind !== "combatBegan") return state;
      // "You MAY move me" — a real choice, and only his controller's.
      return parkDecision(state, {
        kind: "SFD-126-join",
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
        battlefieldId: event.battlefieldId,
      });
    },
  },
  "SFD-128": {
    // Overzealous Fan — "When I defend, you may kill me to move an attacking unit
    // to its base."
    //
    // "When I DEFEND" is the unit's own designation, so this one IS
    // `isDefendingAt` — 465's Attacker is `contestedByIndex` and everyone else
    // standing there is defending, and 383.4.f's "for the first time during a
    // combat" is already enforced by the event's `designated` list.
    //
    // The timing is what makes the card work: `combatBegan` items resolve on the
    // Combat Chain (465 Step 1 Task 4), which is BEFORE the Combat Damage Step —
    // so an attacker sent home is an attacker whose Might never joins the pool.
    //
    // "KILL ME TO move" is a cost (355.10.d.1), so it is paid first and the move
    // only happens if it was paid — and killing him is not targeting anything,
    // which is why only the attacking unit rides on the question. `destroyUnit`
    // with NO killerIndex, matching every other cost-kill in the pool (Cruel
    // Patron, Commander Ledros): nobody "killed" him in the sense a
    // `killerIndex`-reading card asks about.
    //
    // "MOVE an attacking unit to its base" is `recallUnitToBase`, the same helper
    // Fight or Flight's identically-worded "move a unit from a battlefield to its
    // base" uses — a Move, so the unit arrives exhausted, rather than 454's Recall
    // which would leave it ready.
    on: "combatBegan",
    applies: (state, listener, event) =>
      isDefendingAt(state, listener, event) &&
      event.kind === "combatBegan" &&
      attackingUnitsAt(state, event.battlefieldId).length > 0,
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      return parkDecision(state, {
        kind: "SFD-128-sacrifice",
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
        battlefieldId: event.battlefieldId,
      });
    },
  },
  "SFD-130": {
    // Treasure Hunter — "When I move, play a Gold gear token exhausted."
    //
    // BARE "when I move" — no origin and no destination, which is exactly the
    // contrast Harpoon Squad's entry below already names ("what the printed
    // 'from a battlefield' buys over Treasure Hunter's bare 'when I move'"). So
    // walking out of base pays, and so does redeploying between battlefields;
    // neither `event.from` nor `event.to` is read at all.
    //
    // A Recall is still nothing (454 — a Recall is not a Move), and neither is a
    // spell-driven relocation, because `unitMoved` fires for neither. That is the
    // event's line rather than this card's, and it is the printed one.
    //
    // `placeGoldTokens(..., 1)` rather than `placeGearToken(..., GOLD_TOKEN,
    // true)`: same result, but the exhausted-ness is then stated in one place for
    // every SFD card that makes Gold, and a gear token that quietly entered ready
    // would be a free rainbow Power on the turn it was made.
    //
    // The token goes to `listener.ownerIndex`, the Hunter's controller — "play a
    // Gold gear token" with no player named is the ability's controller (355.9),
    // and `event.moverIndex` would say the same thing here only because the
    // condition below already requires the mover to BE him.
    on: "unitMoved",
    applies: (_state, listener, event) => event.kind === "unitMoved" && event.unitInstanceId === listener.card.instanceId,
    resolve: (state, listener, event) =>
      event.kind === "unitMoved" && event.unitInstanceId === listener.card.instanceId
        ? placeGoldTokens(state, listener.ownerIndex, 1)
        : state,
  },
  "SFD-137": {
    // Harpoon Squad — "When I move FROM a battlefield, give me +2 Might this
    // turn."
    //
    // The one card in this file whose move trigger reads the ORIGIN, which is the
    // reason `unitMoved` carries `from` at all: by the time any move DISPATCHER
    // runs the unit has already been removed from where it was. `"base"` is what
    // the event carries for a unit leaving home, and it matches no battlefield —
    // so walking out of base pays nothing and only battlefield-to-battlefield
    // redeployment does, which is what the printed "from a battlefield" buys over
    // Treasure Hunter's bare "when I move".
    //
    // Read from the EVENT rather than re-derived, for Yasuo - Windrider's reason:
    // the trigger is held, and between firing and resolving he can be moved again.
    on: "unitMoved",
    applies: (_state, listener, event) =>
      event.kind === "unitMoved" && event.unitInstanceId === listener.card.instanceId && event.from !== "base",
    resolve: (state, listener, event) =>
      event.kind === "unitMoved" ? giveMightThisTurnToOwnUnit(state, listener.ownerIndex, listener.card.instanceId, HARPOON_PUMP) : state,
  },
  "SFD-148": {
    // Draven - Audacious, FIRST clause only — "The first time I win a combat
    // each turn, you score 1 point."
    //
    // His SECOND clause — "When I die in combat, choose an opponent. They score
    // 1 point" — lives in `deathTriggers` below, and needed the `diedInCombat`
    // flag on `DeathContext` that combat.ts's `processDefeated` now sets. That
    // flag exists because `battlefieldId !== undefined` is NOT the same question
    // (a spell kills units standing at battlefields too), and the Showdown state
    // is no substitute either — `execute-pass-focus` nulls
    // `showdownBattlefieldId` the instant `closeShowdown` returns, long before a
    // held death trigger resolves.
    //
    // His printed `[Deflect]` is the card frame's and needs nothing here.
    //
    // `combatWon` (466.5.a) rather than `battlefieldConquered`, for the reason
    // Corrupt Enforcer's entry above gives at length: a conquest also fires on a
    // walk-in that never fought, and a combat can be won at a battlefield its
    // winner already controlled, which conquers nothing.
    //
    // "**I** win a combat" is positional — my controller won and I am standing
    // where it happened — and it is settled at fire time (383). A unit that died
    // in the exchange is not a listener at all, since the walk only finds
    // permanents still in play, so surviving needs no separate check.
    //
    // **The `winnerIndex` half of that is REDUNDANT, and measured to be** —
    // deleting it leaves every test in test/sfd-chaos.test.ts green, because
    // 466.5.a defines the winner as "the only player that has units remaining",
    // so a listener alive at that battlefield is on the winning side by
    // construction. Kept because it is what the card says and because it is the
    // shape Corrupt Enforcer's identical clause above already uses; recorded here
    // so nobody reads the passing suite as evidence that it bites.
    //
    // "The FIRST TIME each turn" is deliberately NOT in `applies`. The allowance
    // is a RESOURCE, not a trigger condition: a second win still triggers and
    // resolves to nothing, which is the same reading (and the same wording) as
    // The Dreaming Tree's entry in battlefield-abilities.ts and Wraith of
    // Echoes' in triggers.ts.
    //
    // A plain `points + 1`, deliberately not routed through `recordConquest` —
    // rule 474's Final Point restriction covers only a point gained "through a
    // Conquer", and Yasuo - Windrider's entry above records the same call.
    on: "combatWon",
    applies: (_state, listener, event) =>
      event.kind === "combatWon" &&
      event.winnerIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) =>
      event.kind === "combatWon" ? scoreFirstCombatWin(state, listener.ownerIndex, listener.card.instanceId) : state,
  },
  "UNL-137": {
    // Sinister Poro — "When I attack, you may pay [1] to move an enemy unit here
    // to its base."
    //
    // Draven - Vanquisher's shape (SFD-020, effects/fury.ts) with Energy in place
    // of a rune and a target instead of a pump. "When **I** attack" is
    // `isAttackingAt` — the shared designation predicate, so a card that TRIGGERS
    // on attacking and a card that TARGETS attackers cannot come to disagree
    // about who is doing it.
    //
    // "You MAY pay" is a cost within the instruction (355.10.d.1's "[do X] to [do
    // Y]"), so it parks a question rather than firing, and it is not asked at all
    // when the Energy cannot be paid — 416.3 makes a cost that cannot be
    // completed one you may not choose to pay, and a held trigger that resolves
    // to nothing still costs both players a PassFocus. Asked in `applies` for that
    // reason and re-asked at answer time because the window this opens is exactly
    // when that Energy could be spent elsewhere.
    //
    // The timing is the card. `combatBegan` items resolve on the Combat Chain
    // (465 Step 1 Task 4), BEFORE the Combat Damage Step — so a defender sent home
    // is a defender whose Might never joins the pool. Overzealous Fan (SFD-128,
    // above) is the same trick from the other side of the table.
    //
    // `recallUnitToBase`, the helper Fight or Flight's and Overzealous Fan's
    // identically-worded "move a unit ... to its base" already share: the unit
    // arrives EXHAUSTED, which mid-combat means it cannot walk back in. It fires
    // no `unitMoved` — see Isolate's entry above, where that claim was measured
    // rather than copied.
    //
    // **"HERE" is captured, and additionally re-checked against where he is
    // STANDING when the question is answered.** The rules work this exact case:
    // Yasuo - Remorseful's attack trigger, answered after an opponent's Fight or
    // Flight has sent him home, "mistargets" because "here" is no longer the
    // battlefield where combat is ongoing. So a Poro who has left cannot still
    // reach into the fight, and the question is dropped as moot rather than
    // answered. The alternative — reading `event.battlefieldId` alone — was
    // rejected on that worked example.
    //
    // This entry used to record Ahri - Inquisitive and Recurve Bow as holding the
    // looser reading. They no longer do, and neither does anyone else: as of
    // 2026-08-08 the whole "when I attack/defend ... here" family re-checks,
    // through `isStillHere` or its own inline copy of the same lookup. Yasuo -
    // Remorseful, the card the worked example is ABOUT, was the last one to shoot
    // from wherever he ended up.
    on: "combatBegan",
    applies: (state, listener, event) =>
      isAttackingAt(state, listener, event) &&
      event.kind === "combatBegan" &&
      payEnergyFromPool(state, listener.ownerIndex, SINISTER_PORO_COST) !== undefined &&
      enemyUnitsAt(state, listener.ownerIndex, event.battlefieldId).length > 0,
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      return parkDecision(state, {
        kind: "UNL-137-move",
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
        battlefieldId: event.battlefieldId,
      });
    },
  },
  /**
   * Blast Cone, SECOND clause — "When you move an enemy unit, you may exhaust
   * this to [Stun] it."
   *
   * **Refused in wave 3 and written now that the event can answer it.** The
   * blocker was never this clause: it was that `unitMoved` had two emitters, both
   * player actions, and a Standard Move only ever moves your OWN units. So "you
   * move an ENEMY unit" was reachable only through an effect, and effects emitted
   * nothing at all.
   *
   * Even once they did, `moverIndex` could not answer it — that field is the MOVED
   * UNIT's controller, which for this sentence is the opponent. `causedByIndex`
   * is the field that says who did the moving, and this is the card it exists for.
   *
   * Three conditions, and each is a separate way to get it wrong:
   *   YOU moved it — `causedByIndex === listener.ownerIndex`.
   *   It is an ENEMY unit — `moverIndex !== listener.ownerIndex`, since that
   *   field is the moved unit's own controller.
   *   This gear is READY, because exhausting it is the cost (203.3: an
   *   impossible cost cannot be paid, so the offer is not made).
   */
  "UNL-133": {
    on: "unitMoved",
    applies: (state, listener, event) => {
      if (event.kind !== "unitMoved") return false;
      if (event.causedByIndex !== listener.ownerIndex) return false;
      if (event.moverIndex === listener.ownerIndex) return false;
      const gear = state.players[listener.ownerIndex].activeGear.find((g) => g.instanceId === listener.card.instanceId);
      return gear !== undefined && !gear.exhausted;
    },
    resolve: (state, listener, event) => {
      if (event.kind !== "unitMoved") return state;
      // The unit is captured on the decision: by the time the player answers it
      // may have moved again, and "it" is the unit this trigger fired for
      // (359.3.f.3 — information referenced from the trigger condition is checked
      // when the condition is fulfilled).
      return parkDecision(state, {
        kind: "UNL-133-stun",
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
        targetInstanceId: event.unitInstanceId,
      });
    },
  },
  "UNL-127": {
    // Mister Root — "[Accelerate] When I move to a battlefield, gain 2 XP."
    //
    // `[Accelerate]` is the cost engine's (805's optional additional cost, read
    // off the printed text by card-loader into the play action); this entry is the
    // second sentence alone. The pairing is the card: 2 Energy for a 1-Might body
    // that can be bought in READY and walk somewhere the same turn, which is the
    // only way this trigger fires on the turn he lands.
    //
    // "I MOVE" — his own instanceId, not a friendly unit's, which is what
    // separates him from Stealthy Pursuer's "a friendly unit moves from my
    // location" further up this registry.
    //
    // **"TO A BATTLEFIELD" needs no guard, and the absent guard is the honest
    // shape.** `unitMoved` has exactly one emitter — `executeMoveUnit` — and
    // `MoveUnitAction.destinationBattlefieldId` is a required battlefield id, so
    // `event.to` is never "base". A `to !== "base"` check would look like a
    // condition and be unreachable, which this codebase has already deleted once
    // after a mutation run proved it could not fail (see `huntMomentIsMine`).
    // Two neighbours in effects/calm.ts still carry that check; they are not wrong,
    // just untestable.
    //
    // # The divergence he inherits, stated rather than assumed
    //
    // **446.1**: "A Permanent changing its position from any space on the Board to
    // another space on the Board is a Move", and **449**: "Spells, Abilities, or
    // other effects may cause a Move to occur." So a Root relocated by Charm, by a
    // Fae Porter or by his own side's Ride The Wind HAS moved, and should gain 2
    // XP. He does not: `forceMoveToBattlefield` rewrites the zones and holds no
    // `unitMoved` at all, so nothing in this engine can see an effect-driven move.
    // That is engine-wide and predates this card (every "when I move" listener in
    // the four files shares it); closing it is a change to effect-helpers.ts.
    // Under-fires rather than over-fires, which is the direction to err.
    on: "unitMoved",
    // **"TO A BATTLEFIELD" is a real restriction and was not being checked.**
    // This matched any `unitMoved` naming him, which was harmless only while the
    // engine emitted no event for a unit walking home. It does now — 455 defines
    // a Recall as a relocation to base WITHOUT being a Move, so a player sending
    // their own unit home is a Move — and he immediately began paying 2 XP for
    // going home, which his text does not offer.
    //
    // `to === "base"` is the whole test: `unitMoved.to` names a battlefield id for
    // every other destination.
    applies: (_state, listener, event) =>
      event.kind === "unitMoved" && event.unitInstanceId === listener.card.instanceId && event.to !== "base",
    resolve: (state, listener) => gainXp(state, listener.ownerIndex, MISTER_ROOT_XP),
  },
  "UNL-141": {
    // Evelynn - Entrancing — "[Hidden][Backline] When you play me FROM FACE DOWN
    // ON YOUR TURN, you may move an enemy unit at a different location to my
    // battlefield."
    //
    // # Why this is a `cardPlayed` listener and not a `unitTriggers` entry
    //
    // Her condition is a property of HOW she was played, and `UnitTriggerEvent`
    // carries no `fromHidden` — measured: it has `acceleratePaid`,
    // `optionalPowerPaid` and `exhaustLegendPaid`, one field per cost that a
    // trigger has needed, and nothing for the hidden origin. `cardPlayed` DOES
    // carry it (`execute-play-card` sets it from `action.fromHiddenBattlefieldId`),
    // and the event is held AFTER she has resolved into play, so the listener walk
    // already finds her — the same fact Ember Monk's and Black Market Broker's
    // entries above record for their own arrivals. Katarina - Reckless (UNL-023)
    // reads the same field from the same event for the same sentence.
    //
    // An on-play trigger written the ordinary way would have fired for a Evelynn
    // played out of hand for her printed 2 Energy, which is exactly the play the
    // condition exists to exclude.
    //
    // # "ON YOUR TURN" is the second half of the condition and it is not redundant
    //
    // `[Hidden]` (811) is what makes a card playable as a Reaction on the
    // OPPONENT'S turn, which is the normal way a hidden card is used. This clause
    // pays out only when she is unhidden on her controller's own turn — so the
    // ambush line and the tempo line are deliberately different cards. Read from
    // `state.activePlayerIndex` at FIRE time (383 fixes triggering at the moment
    // of the event); a held trigger resolving after the turn rotates would read
    // the wrong player, which is the turn-boundary trap `endOfTurn`'s own note
    // records.
    //
    // # "MY battlefield"
    //
    // Undefined when she was played to a base, and then there is no destination
    // and nothing happens (422). She cannot be, in practice — a from-hidden play
    // comes off a battlefield's facedown zone — but the field is optional and a
    // resolver that assumed otherwise would be a claim rather than a check.
    //
    // "An enemy unit at a DIFFERENT LOCATION" is 198.1's Locations, so the enemy
    // BASE counts and dragging a reinforcement out of it is the main line; only
    // the enemy units already standing beside her are excluded. That is a wider
    // reach than a bare "an enemy unit at a battlefield" would give, and it is
    // printed.
    on: "cardPlayed",
    applies: (state, listener, event) =>
      event.kind === "cardPlayed" &&
      event.fromHidden === true &&
      event.playedInstanceId === listener.card.instanceId &&
      event.casterIndex === listener.ownerIndex &&
      state.activePlayerIndex === listener.ownerIndex &&
      listener.battlefieldId !== undefined &&
      // An offer nobody can take is not made — the rule this file applies
      // throughout, and here it is also what keeps a Showdown's PassFocus round
      // from being spent on a question with one answer.
      enemyUnitsElsewhere(state, listener.ownerIndex, listener.battlefieldId).length > 0,
    resolve: (state, listener) =>
      listener.battlefieldId === undefined
        ? state
        : parkDecision(state, {
            kind: "UNL-141-move",
            playerIndex: listener.ownerIndex,
            // Both are carried: WHO is asking (so a second Evelynn cannot answer
            // this one's question) and WHERE she landed. "My battlefield" is
            // re-checked against the first at answer time — see the decision.
            cardInstanceId: listener.card.instanceId,
            battlefieldId: listener.battlefieldId,
          }),
  },
  "UNL-143": {
    // Kha'Zix - Mutating Horror — "[Ambush] When I attack or defend, if an enemy
    // unit is ALONE here, give me +2 [Might] this turn and gain 2 XP."
    //
    // `isFightingAt` — the shared predicate for a card that does not care which
    // side started the fight, so this cannot come to disagree with the cards that
    // DO (Sinister Poro attacks, Overzealous Fan defends). His `[Ambush]` is a
    // keyword this engine does not implement and needs nothing here; it keeps him
    // greyed in coverage, which is honest.
    //
    // # "ALONE" is a defined term, and it is measured on the ENEMY's side
    //
    // **740.2.a**: "A unit is alone when there are no other friendly units at the
    // same location." Friendly is relative to THAT unit (740.1.a, "two Game
    // Objects are friendly if they share a controller"), so "an enemy unit is
    // alone here" asks whether the opponent has exactly ONE unit standing at this
    // battlefield. How many units KHA'ZIX's side has there is irrelevant — piling
    // in beside him does not switch the payout off, and it is what makes this a
    // reward for having stripped the other stack down rather than for outnumbering
    // it. Isolate (UNL-124, above) reads the identical word the identical way.
    //
    // Zero enemy units is NOT alone: "an enemy unit IS alone" needs an enemy unit
    // to be the subject. A one-sided contest therefore pays nothing, which also
    // means this can never fire at a battlefield with no fight — `isFightingAt`
    // already requires a Contested one.
    //
    // # The condition is settled at FIRE time
    //
    // 383 fixes THAT an ability triggered at the moment of the event, and the
    // response window a held trigger opens is exactly when the opponent would
    // reinforce to un-trigger it. That is the split `applies` exists to make, and
    // it is the same reading Corrupt Enforcer's and Draven - Audacious's combat
    // clauses take above.
    //
    // The PAYOUT is not re-conditioned either: he can be dead or bounced by the
    // time this resolves, in which case `giveMightThisTurnToOwnUnit` finds nothing
    // and the XP still lands (422 — do as much as you can). The Might and the XP
    // are one instruction joined by "and", not two guarded ones.
    on: "combatBegan",
    applies: (state, listener, event) =>
      isFightingAt(state, listener, event) &&
      event.kind === "combatBegan" &&
      enemyUnitsAt(state, listener.ownerIndex, event.battlefieldId).length === 1,
    resolve: (state, listener) =>
      gainXp(
        giveMightThisTurnToOwnUnit(state, listener.ownerIndex, listener.card.instanceId, KHAZIX_PUMP),
        listener.ownerIndex,
        KHAZIX_XP,
      ),
  },
  "UNL-149": {
    // Diana - No Longer Human — "[Ambush] When you play a spell, give me +2
    // [Might] this turn."
    //
    // `[Ambush]` needs nothing here: 822.1.c makes it a passive that widens the
    // legal play DESTINATIONS, and `timing.ambushReactionAt` already grants the
    // `[Reaction]` half. Only this sentence is hers.
    //
    // "When YOU play" is her controller's own spell (`casterIndex ===
    // ownerIndex`) — an opponent's Spell is a different sentence, and without
    // that check she would grow on the response window she is meant to survive.
    //
    // `playedKind === "Spell"` is the other half of the narrowing: `cardPlayed`
    // is fired for every card kind, so a Gear or a Unit would otherwise pump her
    // too. Both conditions are FACTS ABOUT THE EVENT, so they are the only two
    // asked, and they are asked in `applies` — 383.2.a.1 fixes the Trigger
    // Condition at the moment the condition is fulfilled, and Sona - Harmonious's
    // worked example under it is explicit that a listener removed in reaction
    // "will still resolve".
    //
    // No cap. She prints no "first time each turn", so a turn with three Spells
    // is +6, and each one is its own held item.
    //
    // `giveMightThisTurnToOwnUnit` rather than the bare `giveMightThisTurn`:
    // "give ME" is her own body, and the owned-unit form no-ops if she has left
    // the board between the hold and the pop rather than reaching for a Diana the
    // opponent has taken control of.
    on: "cardPlayed",
    applies: (_state, listener, event) =>
      event.kind === "cardPlayed" && event.casterIndex === listener.ownerIndex && event.playedKind === "Spell",
    resolve: (state, listener) =>
      giveMightThisTurnToOwnUnit(state, listener.ownerIndex, listener.card.instanceId, DIANA_SPELL_MIGHT),
  },
  "UNL-150": {
    // Vex - Apathetic — "[Deflect] When an opponent plays a unit while I'm at a
    // battlefield, [Stun] it. They can't move it this turn."
    //
    // **HALF the sentence, deliberately.** The `[Stun]` is here; "they can't move
    // it this turn" is NOT implemented — there is no per-unit movement lock in
    // this engine, and the one gate that would have to carry it is
    // `validate-move-unit.ts`, whose own doc comment already names "Vex -
    // Apathetic's movement lock" as one of the named-card exceptions it omits.
    // That is a shared file this pass may not edit, so the card is weaker than
    // printed rather than wrong in a second direction, and
    // test/unl-chaos-wave5.test.ts pins the gap by asserting the stunned unit can
    // still be moved — closing it must FLIP that test rather than silently
    // changing behaviour nobody was watching.
    //
    // Her `[Deflect]` is the loader's printed keyword and the surcharge machinery
    // reads it; nothing about it belongs here.
    //
    // # The three conditions, and why all three sit in `applies`
    //
    // "an OPPONENT plays" — `casterIndex !== ownerIndex`, so her controller
    // reinforcing does not stun their own arrival. "a UNIT" — `playedKind`, so a
    // Spell or Gear is not her moment. "while I'M AT A BATTLEFIELD" — 383.2.a.1
    // makes a conditional immediately after the Condition part of the TRIGGER
    // CONDITION rather than of the effect, and the rulebook's worked example for
    // it (Sona - Harmonious, "if I'm at a battlefield") says the ability is placed
    // on the chain only if the condition holds when it is fulfilled, and "if she
    // is removed in reaction to the triggered ability, it will still resolve". So
    // a Vex recalled during the response window this hold opens still stuns.
    //
    // **Any battlefield, not hers.** The card says "while I'm at a battlefield",
    // not "here" — 355.9.b's narrowing is what a printed "here" would have bought
    // and she does not print one. So she stunlocks the whole board while she
    // stands anywhere but base, which is what a 4-Energy 0-Power body with
    // `[Deflect]` is priced for.
    //
    // `listener.ownerIndex` is the STUNNER, so a "when you stun" watcher on her
    // side pays out; `stunUnits` fires ONE `unitsStunned` per call, which is what
    // keeps the per-instruction accounting honest for a single victim.
    on: "cardPlayed",
    applies: (_state, listener, event) =>
      event.kind === "cardPlayed" &&
      event.casterIndex !== listener.ownerIndex &&
      event.playedKind === "Unit" &&
      listener.battlefieldId !== undefined,
    resolve: (state, listener, event) => {
      if (event.kind !== "cardPlayed") return state;
      const stunned = stunUnits(state, listener.ownerIndex, [event.playedInstanceId]);
      // **"They can't move it this turn"** — her second clause, and the half that
      // was refused for waves because nothing could forbid ONE unit from moving.
      // `movementLockedUnitInstanceIds` is that lock, swept by `runEnd` like every
      // other this-turn effect.
      //
      // Distinct from the Stun beside it, and deliberately not folded into it: a
      // Stun is about combat damage (423) and expires on its own terms, while this
      // is about the MOVE action. A unit readied by something else is still
      // locked, which is exactly the case that made `exhausted` an insufficient
      // stand-in.
      //
      // The id is appended rather than assigned: two Vexes stunning two arrivals
      // in one turn must lock both, and a `Set`-free append keeps the field's
      // shape identical to its neighbours.
      return {
        ...stunned,
        movementLockedUnitInstanceIds: [...stunned.movementLockedUnitInstanceIds, event.playedInstanceId],
      };
    },
  },
};

/** Diana - No Longer Human's per-spell pump — "give me +2 [Might] this turn". */
const DIANA_SPELL_MIGHT = 2;

/** Kha'Zix - Mutating Horror's payout — "+2 [Might] this turn and gain 2 XP". */
const KHAZIX_PUMP = 2;
const KHAZIX_XP = 2;

/**
 * The enemy units NOT at `battlefieldId` — Evelynn - Entrancing's "an enemy unit
 * at a DIFFERENT LOCATION", which by 198.1 includes the enemy base.
 *
 * The mirror of `ownUnitsElsewhere` above (Fae Porter's own list) and written
 * beside it for the same reason: this list is also the OPTIONS the player is
 * shown, so a unit that has nowhere to move must not appear in it.
 */
function enemyUnitsElsewhere(state: GameState, playerIndex: 0 | 1, battlefieldId: string): UnitInstance[] {
  return ownUnitsElsewhere(state, playerIndex === 0 ? 1 : 0, battlefieldId);
}

/** Sinister Poro's price — the printed `[1]` Energy, paid to move one enemy unit
 *  home. */
const SINISTER_PORO_COST = 1;

/** Mister Root's payout — "gain 2 XP" on arriving at a battlefield. */
const MISTER_ROOT_XP = 2;

/**
 * Draven - Audacious's once-a-turn allowance, spent as it pays out.
 *
 * **The memory is written into `abilityModesUsedThisTurn`, a field named for
 * something else, and that is a choice with a rejected alternative rather than
 * an accident.** What "the first time I win a combat each turn" needs is a
 * PER-UNIT marker that expires with the turn: per-unit because two Dravens each
 * get their own point and a per-player flag would let one spend the other's, and
 * expiring because a new turn re-arms it. `abilityModesUsedThisTurn` is exactly
 * that and nothing else — turn-manager's `expireMightThisTurn` clears it for
 * every unit in base and at every battlefield, alongside `movesThisTurn` and
 * `keywordsThisTurn`, and `activated-abilities` is its only other reader, for
 * units that print an activated ability. Draven prints none, and the marker
 * below is prefixed with his defId so it could not collide with a mode id
 * anyway.
 *
 * The alternative — and what the pool's other two "first time each turn" cards
 * did — is a dedicated field: Wraith of Echoes has
 * `firstFriendlyDeathUsedThisTurn` on the PLAYER, The Dreaming Tree has
 * `spellChoiceDrawnBattlefieldIds`. Neither shape fits a per-unit allowance, and
 * adding a third field is a change to model/card.ts and turn-manager.ts, which
 * this file does not own. If a second per-unit once-a-turn card lands, that
 * field is the right answer and this is the entry to move onto it.
 */
const DRAVEN_WIN_SCORED = "SFD-148-win-scored";

/**
 * Scores the point unless this unit has already scored one this turn.
 *
 * The already-scored question is asked of the LIVE unit rather than of the
 * listener snapshot the chain carries: the snapshot was taken when the combat
 * was won, and a second win resolving off the same board must see the first
 * one's mark.
 */
function scoreFirstCombatWin(state: GameState, ownerIndex: 0 | 1, unitInstanceId: string): GameState {
  const live = findUnitAnywhere(state, unitInstanceId);
  if (live?.unit.abilityModesUsedThisTurn.includes(DRAVEN_WIN_SCORED)) return state;

  // Through `gainPoints`, the single choke point every point-gain goes through
  // so Tianna Crownguard's "opponents can't gain points" reaches it.
  //
  // The MARK is applied either way, below: "the first time I win a combat each
  // turn" is spent by winning, not by scoring, so a Tianna who blocks the point
  // does not also hand him a second attempt.
  const scored = gainPoints(state, ownerIndex, 1);

  // He can be GONE by the time this resolves — `resolvePendingTrigger` falls
  // back to the captured card rather than bailing (359.3, and its own note), so
  // the point is still his controller's. There is then nowhere to write the
  // memory and nothing that could spend it: a unit that has left play is not a
  // listener, so it cannot win a second combat this turn.
  return live ? rememberCombatWinScored(scored, unitInstanceId) : scored;
}

/** Writes the once-a-turn mark onto the live unit, wherever it stands. Both
 *  zones, because "I win a combat" only ever fires for a unit at a battlefield
 *  but a chain item can bounce it home before this resolves. */
function rememberCombatWinScored(state: GameState, unitInstanceId: string): GameState {
  const mark = (u: UnitInstance): UnitInstance =>
    u.instanceId === unitInstanceId
      ? { ...u, abilityModesUsedThisTurn: [...u.abilityModesUsedThisTurn, DRAVEN_WIN_SCORED] }
      : u;
  const players = state.players.map((p) => ({ ...p, baseUnits: p.baseUnits.map(mark) })) as [PlayerState, PlayerState];
  const battlefields = state.battlefields.map((bf) => {
    const units: typeof bf.units = {};
    for (const [playerId, list] of Object.entries(bf.units)) units[playerId] = list.map(mark);
    return { ...bf, units };
  });
  return { ...state, players, battlefields };
}

/** Harpoon Squad's redeployment bonus. */
const HARPOON_PUMP = 2;

/**
 * Loyal Pup's three conditions, asked once so `applies` and `resolve` cannot
 * disagree — the same shape (and the same reason) as `pursuerFollows` below.
 *
 * Deliberately NOT `isDefendingAt`: that predicate requires the listener to be
 * among the units designated in this combat, and the whole point of the Pup is
 * that he is somewhere else when the fight opens.
 */
function pupJoins(state: GameState, listener: Listener, event: GameEvent): boolean {
  if (event.kind !== "combatBegan") return false;
  const attackerIndex = attackerIndexAt(state, event.battlefieldId);
  if (attackerIndex === null || attackerIndex === listener.ownerIndex) return false; // "YOU defend"
  // Already standing in the fight: "move me THERE" has nothing to do.
  if (listener.battlefieldId === event.battlefieldId) return false;
  // The presence requirement — see the card's entry for why this engine adds it.
  const bf = state.battlefields.find((b) => b.id === event.battlefieldId);
  return (bf?.units[state.players[listener.ownerIndex].id]?.length ?? 0) > 0;
}

/**
 * The units `playerIndex` controls that are NOT already at `battlefieldId` —
 * Fae Porter's "a unit you control", which names no location (355.9.a.1) and so
 * reaches base as well as every other battlefield.
 *
 * Filtered rather than left to `forceMoveToBattlefield`'s own already-there
 * no-op, because this list is also the OPTIONS a player is shown: offering a
 * move that cannot happen and charging a Chaos rune for it is 416.3's
 * offered-then-refused shape.
 */
function ownUnitsElsewhere(state: GameState, playerIndex: 0 | 1, battlefieldId: string): UnitInstance[] {
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  const here = new Set((bf?.units[state.players[playerIndex].id] ?? []).map((u) => u.instanceId));
  return ownUnitsEverywhere(state, playerIndex).filter((u) => !here.has(u.instanceId));
}

/** Triggers a card fires about ITSELF — being played, discarded or killed. Keyed
 *  by that card's own defId, because at those moments it may not be in play for
 *  a listener walk to reach (see triggers.ts's SelfTriggerDefinition). */
export const selfTriggers: Record<string, SelfTriggerDefinition> = {
  "VEN-108": {
    // Forgotten Relic — the "WHEN YOU PLAY THIS" half. Its Beginning-Phase half is
    // an `eventTriggers` entry above, and that entry records why the two cannot
    // share one definition.
    //
    // A self trigger rather than a `cardPlayed` listener, which is the route all
    // nine other gears in the pool printing "when you play this" take: the moment
    // is about THIS card, so keying it by its own defId needs no filter and cannot
    // fire for anybody else's play.
    on: ["played"],
    resolve: (state, event) => forgottenRelicBurn(state, event.ownerIndex),
  },
  "VEN-094": {
    // Mask Mother — "When you DISCARD me, you may pay [1 Energy] to give a
    // friendly unit +2 [Might] this turn."
    //
    // Flame Chompers' moment (OGN-006, effects/fury.ts) with a different payload,
    // and keyed by her own defId for the same reason: at the instant this fires
    // she is not in play for any listener walk to find — she is on her way from
    // hand to trash.
    //
    // **The pump is on somebody ELSE**, so unlike Flame Chompers this is a card
    // that pays out from the graveyard without coming back. Her being in the trash
    // is not a condition of anything; the offer is about the discard, not about
    // where she landed.
    //
    // "You MAY pay" is a cost, asked through the very helper that will spend it so
    // affordability and payment cannot disagree — and 416.3 means it is not asked
    // at all when the Energy cannot be paid.
    on: ["discarded"],
    resolve: (state, event) =>
      payEnergyFromPool(state, event.ownerIndex, MASK_MOTHER_ENERGY) === undefined
        ? state
        : parkDecision(state, { kind: MASK_MOTHER_PUMP, playerIndex: event.ownerIndex }),
  },
  "OGN-186": {
    // Treasure Trove — "When this leaves the board, draw 1 and channel 1 rune
    // exhausted."
    //
    // Keyed on being KILLED, which is the only way it leaves the board in this
    // pool — its own "[Chaos], Exhaust: Kill this" (activated-abilities.ts) and
    // `[Temporary]` expiry both route through killGear, which fires this. The
    // payout lives HERE rather than in that ability so it cannot be paid twice
    // if the Trove ever dies some other way.
    on: ["killed"],
    resolve: (state, event) => channelRunesExhausted(drawCards(state, event.ownerIndex, 1), event.ownerIndex, 1),
  },
  // Scrapheap — "When this is played, discarded, or killed, draw 1."
  //
  // The only card in the pool that watches its OWN three-way fate, and the
  // reason self-triggers are keyed by defId rather than found by walking the
  // board: on the discarded branch this Gear is in hand at the moment it fires
  // (and in the trash immediately after), so no listener walk over permanents in
  // play would ever reach it.
  //
  // Not "when this ENTERS play" — a discarded Scrapheap was never in play at
  // all, and the printed text still pays. All three branches read the same, and
  // the draw goes to the card's owner in every one of them.
  "OGN-182": {
    on: ["played", "discarded", "killed"],
    resolve: (state, event) => drawCards(state, event.ownerIndex, 1),
  },
  "UNL-133": {
    // Blast Cone, FIRST clause — "When you play this, you may move an enemy unit."
    //
    // # Its SECOND clause is NOT implemented, and it cannot fire at all today
    //
    // "When you move an enemy unit, you may exhaust this to [Stun] it." A Standard
    // Move only ever moves your OWN units (`executeMoveUnit` removes from
    // `action.playerIndex`), so "YOU move an ENEMY unit" can only ever be an
    // effect-driven move — Charm's, Temptation's, this very gear's first clause.
    // And `unitMoved` has exactly one emitter, `executeMoveUnit`:
    // `forceMoveToBattlefield` and `forceMoveToBase` rewrite the zones and hold no
    // event at all. So there is no moment for the second clause to listen to, and
    // an `on: "unitMoved"` listener for it would register, typecheck, report the
    // card DONE and never once fire.
    //
    // It needs `forceMoveToBattlefield`/`forceMoveToBase` in effect-helpers.ts to
    // hold a move event carrying WHO caused the move (today's `unitMoved.moverIndex`
    // is the moved unit's controller, which is the wrong index for "you move an
    // enemy unit"). That is a shared-file change and is deliberately not made here.
    // See the divergence note on UNL-127 Mister Root, which is the same gap seen
    // from the under-firing side.
    //
    // # The clause that IS here
    //
    // A `selfTriggers` entry rather than a `cardEffects` one: a Gear's "when you
    // play this" is the moment `holdSelfTrigger` exists for (Scrapheap's, above),
    // and a Gear has no on-play resolution hook in `cardEffects` at all.
    //
    // **A parked decision rather than a target on the action.** A move needs both a
    // unit and a DESTINATION, and a destination is only fanned out for cards named
    // in card-effects.ts's `MOVE_TARGET_SPELL_DEF_IDS` — a shared table this file
    // may not add to. So the pair is asked at resolution, one option per (unit,
    // destination), the way Blitzcrank - Impassive already asks his half of the
    // same sentence.
    //
    // **That IS a divergence and it is worth naming.** 355 makes targets chosen as
    // the ability is put on the chain, and 383.3.a puts the "you may" of a first
    // clause at FINALIZATION rather than at resolution — so printed, an opponent
    // could respond to the pairing. Here they cannot. It is narrower than printed
    // (the choice is later, never wider), and it is the same trade every parked
    // "you may move" in these files already makes.
    on: ["played"],
    resolve: (state, event) => {
      const enemyIndex: 0 | 1 = event.ownerIndex === 0 ? 1 : 0;
      // Nothing to move: 422's do-as-much-as-you-can, and the same silence
      // Blitzcrank keeps rather than parking a question whose only answer is no.
      if (ownUnitsEverywhere(state, enemyIndex).length === 0) return state;
      // **The gear's own instanceId is deliberately NOT carried.** 383 separates
      // an ability from its source once it has triggered, and nothing in the
      // first clause refers back to the Cone — so a question that recorded it
      // would be a field the handler never reads, which in this file reads as a
      // check that exists. (The SECOND clause is the one that would need it, and
      // that clause is refused; see the card's entry.)
      return parkDecision(state, { kind: "UNL-133-move", playerIndex: event.ownerIndex });
    },
  },
  "UNL-148": {
    // Cursed Sarcophagus, FIRST clause — "When you play this, banish all units
    // from your trash." Its `[Exhaust]` half is in `activatedAbilities` below.
    //
    // A `selfTriggers` entry rather than a `cardEffects` one, for the reason
    // Blast Cone's entry above and Sprite Fountain's (UNL-078, effects/mind.ts)
    // both record and one of them MEASURED: `executePlayCard`'s gear branch pushes
    // nothing onto the chain, so `resolveCardEffect` is never reached for a Gear
    // and an effect registered there is silently dead.
    //
    // # "Banished WITH this" is a link, and the link already exists
    //
    // `GearInstance.banishedInstanceIds` is The Zero Drive's field (SFD-090), and
    // `equipment.recordBanishedWithGear` is its single writer. Compared by
    // INSTANCE, so two Sarcophagi keep two pits and neither can crack the other's
    // — which is exactly what "with THIS" means and what a per-player list of
    // banished units could not express.
    //
    // The trigger is HELD (383), so by the time it resolves the gear is already in
    // `activeGear`, which is where that writer looks first.
    //
    // # UNITS only, and only from the OWNER's trash
    //
    // "all units from YOUR trash" — a Spell or Gear in the same trash stays put,
    // and the opponent's trash is untouched. `event.ownerIndex` is the gear's
    // controller at that moment, the same reading a Deathknell takes from
    // `death.ownerIndex`.
    //
    // # Banishing is not killing
    //
    // `banishCard` moves the INSTANCE between zones and fires nothing: these cards
    // are already in the trash, so nothing dies here and no death-watch may see
    // one. That is also what preserves the identity the pit is recorded against.
    on: ["played"],
    resolve: (state, event) => {
      const owner = event.ownerIndex;
      // Snapshotted before the fold, because each `banishCard` rewrites the trash
      // the next iteration would read.
      const units = state.players[owner].trash.filter((c) => c.kind === "Unit");
      return units.reduce(
        (next, unit) =>
          recordBanishedWithGear(banishCard(next, owner, unit.instanceId), owner, event.card.instanceId, unit.instanceId),
        state,
      );
    },
  },
};

/** Questions this domain's cards stop to ask — see engine/decisions.ts. Keyed by
 *  a `kind` string rather than a defId, since one card can ask more than one
 *  kind of question; the one-file-one-owner rule still applies, and the key is
 *  prefixed with the card's defId so ownership stays readable. */
/** Nocturne - Horrifying's alternative price — "play me for [rainbow]". */
const NOCTURNE_POWER = 1;

/** The List gives -2 Might this turn. Named so the decision below does not read
 *  as a bare literal beside a tag string. */
const THE_LIST_PENALTY = 2;

/**
 * Forgotten Relic's whole instruction — "[Burn 1]. When you burn a UNIT this way,
 * do this: give a friendly unit +[Might] equal to the burned card's Might this
 * turn."
 *
 * Shared by the card's two moments (its play, and each Beginning Phase) so they
 * cannot come to different answers — the reason `keeperOfLawConditionMet` and
 * `opponentControlsStunnedUnit` are shared between their own two halves.
 *
 * The burned card's identity comes from `burnCards`' report: it cannot be peeked
 * beforehand, because a Burn Out mid-instruction (440.4) changes which cards the
 * rest of the burn takes, and reading the trash afterwards would pick up whatever
 * else the turn had put there.
 *
 * "When you burn A UNIT this way" — a Spell or Gear burned raises no question at
 * all, which is what makes the absence of one observable. The amount is the
 * burned card's PRINTED Might, the only Might a card in a trash has.
 */
function forgottenRelicBurn(state: GameState, ownerIndex: 0 | 1): GameState {
  const { state: burned, burned: taken } = burnCards(state, ownerIndex, FORGOTTEN_RELIC_BURN);
  const unit = taken.find((c) => c.kind === "Unit");
  if (!unit) return burned;
  return parkDecision(burned, {
    kind: FORGOTTEN_RELIC_GIVE,
    playerIndex: ownerIndex,
    // The AMOUNT, carried rather than re-derived: by the time this is answered the
    // burned card is one of many in a trash and nothing distinguishes it.
    count: unit.might,
  });
}

/** Everything at Tornado Warrior's battlefield that can carry the Empowered
 *  status — both players' units standing with him. Re-derived at answer time, so
 *  a Warrior killed in the response window finds his own question moot (no
 *  options beyond the decline), which is 359.3.e.12's answer. */
function tornadoTargets(state: GameState, d: PendingDecision): UnitInstance[] {
  if (d.cardInstanceId === undefined) return [];
  const here = findUnitOnBattlefield(state, d.cardInstanceId);
  if (!here) return [];
  const battlefield = state.battlefields[here.battlefieldIndex]!;
  return Object.values(battlefield.units).flat();
}

/** Which seat holds this gear, or undefined if nobody does — the lookup
 *  `banishCard` needs, since it takes an owning seat and a bare instanceId does
 *  not carry one. */
function gearOwnerOf(state: GameState, gearInstanceId: string): 0 | 1 | undefined {
  for (const index of [0, 1] as const) {
    if (state.players[index].activeGear.some((g) => g.instanceId === gearInstanceId)) return index;
  }
  return undefined;
}

/** Every unit sitting in EITHER trash — Shadows of the Past's "units from
 *  TRASHES", plural, which is the whole card: each returned unit goes to its own
 *  owner's hand, so this can hand an opponent their champion back. */
function unitsInAnyTrash(state: GameState): { instanceId: string; name: string; ownerIndex: 0 | 1 }[] {
  return ([0, 1] as const).flatMap((index) =>
    state.players[index].trash
      .filter((c) => c.kind === "Unit")
      .map((c) => ({ instanceId: c.instanceId, name: c.name, ownerIndex: index })),
  );
}

export const decisions: Record<string, DecisionDefinition> = {
  [MEL_DEFIANT_BANISH]: {
    // Mel, Defiant Soul's banish. MANDATORY — no "you may" is printed — so there
    // is no decline option and the only choice is WHICH.
    //
    // `options` is rebuilt from LIVE state rather than from a snapshot taken when
    // the trigger fired, which is the whole reason `DecisionDefinition.options` is
    // a function of state: a victim killed or pumped out of range while this
    // waited on the chain is no longer a legal answer.
    //
    // An EMPTY list is reachable even though `applies` refused an empty board —
    // the two are separated by a response window — and `advanceDecisions` pops a
    // zero-option decision without resolving anything, which is the right outcome:
    // 359.3, an instruction with nothing to act on does nothing.
    prompt: () => "Mel, Defiant Soul: banish an enemy unit with 3 [Might] or less",
    options: (state, d) =>
      melBanishCandidates(state, d.playerIndex).map((u) => ({ id: u.instanceId, label: u.name, instanceId: u.instanceId })),
    // Re-derived rather than trusted: the answer names an id, and only a CURRENT
    // candidate may be acted on.
    //
    // **MEASURED-REDUNDANT, and kept.** A mutant that banishes whatever id it is
    // handed SURVIVES, because `validate-answer-decision` already refuses an
    // `optionId` that is not in `optionsFor(state, decision)` right now — and the
    // auto-resolve path in `advanceDecisions` passes an id it took from that same
    // list. So both routes in are already safe, and this is the contract stated
    // at the site that depends on it rather than a live second gate.
    resolve: (state, d, optionId) =>
      melBanishCandidates(state, d.playerIndex).some((u) => u.instanceId === optionId)
        ? banishUnitFromPlay(state, optionId)
        : state,
  },

  /**
   * Tornado Warrior's "you may empower something HERE. Disempower it at end of
   * turn."
   *
   * The empower and the delayed disempower are ONE answer: the second half is not
   * optional, so arming it is part of taking the offer rather than a second
   * question. `GameState.disempowerAtEndOfTurn` holds the id and `runEnd` strips
   * the status — see the field for why this is not a `[Temporary]` grant.
   *
   * "SOMETHING here" is any Empowerable object at his battlefield (441 makes the
   * status a property of a game object), which in this pool is the units standing
   * with him — either player's, since no owner is printed. Empowering an ENEMY
   * unit for a turn is a bad play rather than an illegal one, and the card offers
   * it.
   *
   * Already-Empowered things are still offered: `empowerPermanent` no-ops on them
   * (441.1.b), so choosing one wastes the answer rather than being illegal — and
   * the DISEMPOWER would still be armed against it, which is a real (if perverse)
   * use of the card.
   */
  [TORNADO_EMPOWER]: {
    prompt: () => "Tornado Warrior: empower something here until end of turn?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...tornadoTargets(state, d).map((u) => ({ id: u.instanceId, label: `Empower ${u.name}`, instanceId: u.instanceId })),
    ],
    resolve: (state, _d, optionId) => {
      if (optionId === "decline") return state;
      const empowered = empowerPermanent(state, optionId);
      return { ...empowered, disempowerAtEndOfTurn: [...empowered.disempowerAtEndOfTurn, optionId] };
    },
  },
  /**
   * Gust Monk's "banish a card from ANY trash to give a unit [Assault 2] this
   * turn" — the COST half (355.10.c.1), so this question carries the decline and
   * the grant half below does not.
   *
   * "Any trash" is both players', and any card kind: the sentence narrows
   * neither. With every trash empty the offer is a bare Decline that
   * `advanceDecisions` executes silently, which is the right amount of theatre for
   * a question with one answer.
   */
  [GUST_MONK_BANISH]: {
    prompt: () => "Gust Monk: banish a card from any trash to give a unit [Assault 2] this turn?",
    options: (state) => [
      { id: "decline", label: "Decline" },
      ...([0, 1] as const).flatMap((index) =>
        state.players[index].trash.map((c) => ({ id: c.instanceId, label: `Banish ${c.name}`, instanceId: c.instanceId })),
      ),
    ],
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      const owner = ([0, 1] as const).find((index) => state.players[index].trash.some((c) => c.instanceId === optionId));
      if (owner === undefined) return state;
      return parkDecision(banishCard(state, owner, optionId), { kind: GUST_MONK_GRANT, playerIndex: d.playerIndex });
    },
  },
  /**
   * ...and the PAYOFF — "give a unit [Assault 2] this turn", asked only once the
   * banish is paid, which is why this half has no decline.
   *
   * "A unit", bare, so either player's and anywhere (355.9.a.1). Granting an enemy
   * `[Assault]` is a bad play rather than an illegal one.
   */
  [GUST_MONK_GRANT]: {
    prompt: () => "Gust Monk: give a unit [Assault 2] this turn.",
    options: (state) =>
      [...ownUnitsEverywhere(state, 0), ...ownUnitsEverywhere(state, 1)].map((u) => ({
        id: u.instanceId,
        label: `[Assault 2] to ${u.name}`,
        instanceId: u.instanceId,
      })),
    resolve: (state, _d, optionId) => grantKeywordThisTurn(state, optionId, "Assault", GUST_MONK_ASSAULT),
  },
  /**
   * Ocean Drake's "you may return a NON-DRAGON unit to its owner's hand".
   *
   * The Dragon filter is by TAG, so he cannot bounce himself OR any other Dragon —
   * including an enemy one, which is the half that stings. `effectiveTagsOf` is
   * the reader, so a tag granted by an Equipment counts exactly as a printed one.
   */
  [OCEAN_DRAKE_BOUNCE]: {
    prompt: () => "Ocean Drake: return a non-Dragon unit to its owner's hand?",
    options: (state) => [
      { id: "decline", label: "Decline" },
      ...[...ownUnitsEverywhere(state, 0), ...ownUnitsEverywhere(state, 1)]
        .filter((u) => !effectiveTagsOf(state, u).includes("Dragon"))
        .map((u) => ({ id: u.instanceId, label: `Return ${u.name}`, instanceId: u.instanceId })),
    ],
    resolve: (state, _d, optionId) => (optionId === "decline" ? state : returnUnitToHand(state, optionId)),
  },
  /**
   * Kennen, Storm of Shuriken's "give a spell in your trash [Flow] equal to its
   * cost this turn".
   *
   * The grant is a `replacedCostPlays` entry priced at the spell's OWN printed
   * cost, which is what "equal to its cost" says — and per INSTANCE, which the
   * grant type insists on: a second copy of the same spell in the same trash is a
   * different object and was granted nothing.
   *
   * No decline: the text carries no "you may". With no spell in the trash the
   * trigger is never placed at all — see his `eventTriggers` entry.
   */
  [KENNEN_SHURIKEN_FLOW]: {
    prompt: () => "Kennen, Storm of Shuriken: give a spell in your trash [Flow] equal to its cost this turn.",
    options: (state, d) =>
      state.players[d.playerIndex].trash
        .filter((c) => c.kind === "Spell")
        .map((c) => ({ id: c.instanceId, label: `${c.name} gains [Flow]`, instanceId: c.instanceId })),
    resolve: (state, d, optionId) => {
      const spell = state.players[d.playerIndex].trash.find((c) => c.instanceId === optionId);
      if (!spell || spell.kind !== "Spell") return state;
      return grantReplacedCostPlay(state, d.playerIndex, {
        instanceId: spell.instanceId,
        energyCost: spell.energyCost,
        powerCost: spell.powerCost,
        powerDomain: spell.powerDomain,
      });
    },
  },
  /**
   * Mask Mother's "you may pay [1 Energy] to give a friendly unit +2 [Might] this
   * turn", raised by her own discard.
   *
   * The payment is TAKEN here and asked through the helper that takes it, so
   * affordability and payment cannot disagree — and the offer is rebuilt from
   * live state, so Energy spent in the response window leaves a bare Decline that
   * `advanceDecisions` executes without prompting (416.3).
   *
   * "A FRIENDLY unit" is her controller's, anywhere (355.9.a.1 — no location is
   * printed).
   */
  [MASK_MOTHER_PUMP]: {
    prompt: () => "Mask Mother: pay 1 Energy to give a friendly unit +2 Might this turn?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...(payEnergyFromPool(state, d.playerIndex, MASK_MOTHER_ENERGY) === undefined
        ? []
        : ownUnitsEverywhere(state, d.playerIndex).map((u) => ({
            id: u.instanceId,
            label: `+2 Might to ${u.name}`,
            instanceId: u.instanceId,
          }))),
    ],
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      const paid = payEnergyFromPool(state, d.playerIndex, MASK_MOTHER_ENERGY);
      if (paid === undefined) return state;
      return giveMightThisTurn(paid, optionId, MASK_MOTHER_MIGHT);
    },
  },
  /**
   * Shadow Order Disciple's "you may [Burn 1] to give me +1 [Might] this turn".
   *
   * One question over both halves: the Burn is a cost WITHIN the instruction
   * (355.10.c.1), so declining to burn and declining the pump are one answer.
   *
   * Unlike a Power or Energy cost this one is always completable — 440.4 burns as
   * many as possible and 431 recycles an empty deck — so the offer is always
   * made, and milling yourself is the real price rather than a gate.
   */
  [DISCIPLE_BURN_OFFER]: {
    prompt: () => "Shadow Order Disciple: Burn 1 to give me +1 Might this turn?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...(d.cardInstanceId !== undefined && findUnitAnywhere(state, d.cardInstanceId) !== undefined
        ? [{ id: "burn", label: "Burn 1 for +1 Might" }]
        : []),
    ],
    resolve: (state, d, optionId) => {
      if (optionId === "decline" || d.cardInstanceId === undefined) return state;
      return giveMightThisTurn(burn(state, d.playerIndex, DISCIPLE_BURN), d.cardInstanceId, DISCIPLE_MIGHT);
    },
  },
  /**
   * Shadows of the Past's "return UP TO 2 units from trashes to their owners'
   * hands" — re-parked while returns are still owed, exactly as the generic
   * discard question is, so "up to 2" is a sequence of one-unit choices and
   * declining ends it.
   *
   * Each unit goes to ITS OWNER's hand, not the caster's: `returnCardFromTrash`
   * takes the owning seat, which the option carries.
   */
  [SHADOWS_OF_THE_PAST_PICK]: {
    prompt: (_state, d) => `Shadows of the Past: return a unit from a trash to its owner's hand (${d.count ?? 1} left)`,
    options: (state) => [
      { id: "decline", label: "Decline" },
      ...unitsInAnyTrash(state).map((u) => ({ id: u.instanceId, label: u.name, instanceId: u.instanceId })),
    ],
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      const owner = unitsInAnyTrash(state).find((u) => u.instanceId === optionId);
      if (!owner) return state;
      const returned = returnCardFromTrash(state, owner.ownerIndex, optionId);
      const remaining = (d.count ?? 1) - 1;
      return remaining > 0 ? repeatDecision(returned, { ...d, count: remaining }) : returned;
    },
  },
  /**
   * Forgotten Relic's "give a friendly unit +[Might] equal to the burned card's
   * Might this turn", raised only when the burn actually took a UNIT.
   *
   * The AMOUNT rides on `count` rather than being re-derived: by the time this is
   * answered the burned card is one of many in a trash and nothing distinguishes
   * it. A 0-Might unit burned still asks — the instruction is not conditional on
   * the amount — and grants nothing, which is the honest reading.
   */
  [FORGOTTEN_RELIC_GIVE]: {
    prompt: (_state, d) => `Forgotten Relic: give a friendly unit +${d.count ?? 0} Might this turn.`,
    options: (state, d) =>
      ownUnitsEverywhere(state, d.playerIndex).map((u) => ({
        id: u.instanceId,
        label: `+${d.count ?? 0} Might to ${u.name}`,
        instanceId: u.instanceId,
      })),
    resolve: (state, d, optionId) => giveMightThisTurn(state, optionId, d.count ?? 0),
  },
  /**
   * Ravenbloom Prefect's "you may banish ME to banish IT".
   *
   * `cardInstanceId` is the Prefect and `targetInstanceId` is the gear that was
   * just played. Both are re-checked at answer time: he may have died in the
   * response window, and the gear may already be gone.
   *
   * **Both banishes, and neither is a kill** (427.2.a). His own death triggers do
   * not fire and the gear's "when I am killed" self-trigger does not either —
   * which is exactly what separates this from `killGear`.
   */
  [PREFECT_BANISH]: {
    prompt: () => "Ravenbloom Prefect: banish me to banish that gear?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...(d.cardInstanceId !== undefined &&
      findUnitAnywhere(state, d.cardInstanceId) !== undefined &&
      d.targetInstanceId !== undefined &&
      gearOwnerOf(state, d.targetInstanceId) !== undefined
        ? [{ id: "banish", label: "Banish us both" }]
        : []),
    ],
    resolve: (state, d, optionId) => {
      if (optionId === "decline" || d.cardInstanceId === undefined || d.targetInstanceId === undefined) return state;
      const gearOwner = gearOwnerOf(state, d.targetInstanceId);
      if (gearOwner === undefined) return state;
      // HIM first, then the gear: the cost is paid before what it buys, and a
      // reader of the board between the two sees a Prefect who has already gone.
      return banishCard(banishUnitFromPlay(state, d.cardInstanceId), gearOwner, d.targetInstanceId);
    },
  },
  /**
   * Minah Swiftfoot's "choose one — each player discards 1 / each player draws 1".
   *
   * No decline: "choose one" is not "you may". Both seats are acted on in TURN
   * ORDER-agnostic sequence, each through the shared helper so their own
   * `cardsDiscarded`/`cardDrawn` events fire for them.
   */
  [MINAH_MODE]: {
    prompt: () => "Minah Swiftfoot: choose one.",
    options: () => [
      { id: "discard", label: "Each player discards 1" },
      { id: "draw", label: "Each player draws 1" },
    ],
    resolve: (state, _d, optionId) => {
      const act = (next: GameState, index: 0 | 1) =>
        optionId === "discard" ? discardCards(next, index, 1) : drawCards(next, index, 1);
      return act(act(state, 0), 1);
    },
  },
  "UNL-138-name": {
    // The List's "as you play this, name a tag."
    prompt: () => "The List: name a tag",
    // **The FULL pool of 111 tags, not the ones on the board.** Naming is a read
    // on what your opponent will play; restricting it to what is already visible
    // would turn a guess into a tautology and make the card strictly weaker than
    // printed. The project owner's call, and the paper game's behaviour.
    //
    // Affordable precisely because it is a decision rather than an action
    // fan-out: this list is built once, when the question is answered.
    options: () => allPrintedTags().map((tag) => ({ id: tag, label: tag })),
    // No decline: "name a tag" is not "you may".
    resolve: (state, d, optionId) => setNamedTag(state, d.playerIndex, d.cardInstanceId ?? "", optionId),
  },
  "UNL-138-weaken": {
    // "[Exhaust]: Give a unit with the named tag -2 [Might] this turn."
    prompt: () => "The List: give a unit with the named tag -2 Might this turn",
    // Rebuilt from live state like every option list, so a unit that left the
    // board between the activation and the answer is simply no longer offered.
    // Either side's — the card says "a unit".
    options: (state, d) => {
      const tag = namedTagOf(state, d.playerIndex, d.cardInstanceId ?? "");
      if (tag === undefined) return [];
      return unitsWithTag(state, tag).map(({ unit }) => ({
        id: unit.instanceId,
        label: `${unit.name} (-2 Might)`,
        instanceId: unit.instanceId,
      }));
    },
    resolve: (state, _d, optionId) => giveMightThisTurn(state, optionId, -THE_LIST_PENALTY),
  },
  "SFD-140-play": {
    // Fizz - Trickster's "you may play a spell from your trash, ignoring its
    // Energy cost. Recycle that spell after you play it."
    prompt: () => "Fizz - Trickster: play a spell from your trash for its Power cost only?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...fizzCandidates(state, d.playerIndex).map((c) => ({
        id: c.instanceId,
        label: `Play ${c.name}`,
        instanceId: c.instanceId,
      })),
    ],
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      // Re-derived at ANSWER time against the same walk — and that re-derivation
      // covers the PAYMENT too, since payability is part of the filter: the
      // runes may have been spent while this waited on the chain.
      const chosen = fizzCandidates(state, d.playerIndex).find((c) => c.instanceId === optionId);
      if (chosen === undefined || chosen.kind !== "Spell") return state;
      // Power FIRST, so an unpayable cost hands over nothing — the rule every
      // paid effect in this file follows. Re-derived rather than trusted.
      const paid =
        chosen.powerCost === 0 ? state : payPowerFromChanneled(state, d.playerIndex, chosen.powerDomain, chosen.powerCost);
      if (paid === undefined) return state;
      // **A spell that needs a target gets a SECOND question — added 2026-08-11.**
      //
      // Reported from playtesting as "spells played with fizz dont seem to do
      // anything", and that was exactly right: `playCardIgnoringCost` resolved
      // the spell with no choices at all, so Hextech Ray left the trash, dealt 3
      // to nobody, and was recycled. The card did its whole job and the spell did
      // none of its own.
      //
      // Asking is legitimate here in a way it is not for every free play: Fizz
      // ASKS which spell, so the chooser is already answering questions and a
      // second one costs them nothing. 355.8 puts a spell's targets at
      // finalization, and this is as close to that moment as a from-trash play
      // gets.
      //
      // Parked rather than resolved inline so the target is re-derived when it is
      // ANSWERED — the board can move while the question waits, which is the same
      // reason the spell choice above is re-derived.
      if (fizzSpellNeedsTarget(paid, d.playerIndex, chosen)) {
        return parkDecision(paid, {
          kind: "SFD-140-target",
          playerIndex: d.playerIndex,
          cardInstanceId: chosen.instanceId,
        });
      }
      // Out of the trash before it is played, or the card is in two zones at
      // once — the same ordering Glasc Mixologist's decision takes.
      const players = [...paid.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        trash: players[d.playerIndex].trash.filter((c) => c.instanceId !== chosen.instanceId),
      };
      const played = playCardIgnoringCost({ ...paid, players }, d.playerIndex, chosen);
      // "RECYCLE that spell after you play it" — bottom of the deck (416), not
      // the trash it came from, which is what stops him looping one spell every
      // turn. A resolved Spell has been put back in the trash by
      // `playSpellImmediately`, so it is taken from there by identity rather than
      // by the front-of-trash convention `recycleFromTrash` uses for a COUNT.
      const after = [...played.players] as [PlayerState, PlayerState];
      const owner = after[d.playerIndex];
      if (!owner.trash.some((c) => c.instanceId === chosen.instanceId)) return played;
      after[d.playerIndex] = {
        ...owner,
        trash: owner.trash.filter((c) => c.instanceId !== chosen.instanceId),
        deck: [...owner.deck, chosen],
      };
      // Karma - Channeler watches every recycle in this engine, including the
      // ones written inline like this one.
      return holdCardsRecycled({ ...played, players: after }, d.playerIndex, 1);
    },
  },
  "SFD-140-target": {
    // **The second half of Fizz - Trickster, added 2026-08-11 from a playtest
    // report: "spells played with fizz dont seem to do anything".**
    //
    // The first question picks the spell; this one points it. Before this
    // existed, `playCardIgnoringCost` resolved the chosen spell with NO choices,
    // so every targeted spell Fizz played left the trash, hit nothing, and was
    // recycled. The card worked perfectly and the spell did nothing, which is
    // precisely how the report reads.
    //
    // **No decline.** The first question already carried one, and 355.8 makes a
    // target chosen at finalization rather than optional — a spell you have
    // committed to playing does not get to un-choose. If the board empties while
    // this waits, `options` returns nothing and the question is moot, which is
    // the engine's existing answer for a target that vanished (359.3.e.12).
    prompt: (state, d) => {
      const card = state.players[d.playerIndex].trash.find((c) => c.instanceId === d.cardInstanceId);
      return `Fizz - Trickster: choose a target for ${card?.name ?? "the spell"}`;
    },
    options: (state, d) => {
      const card = state.players[d.playerIndex].trash.find((c) => c.instanceId === d.cardInstanceId);
      if (card === undefined) return [];
      const targeting = cardModeOf(card, undefined)?.targeting;
      if (targeting?.kind !== "unit") return [];
      // Re-derived at ANSWER time, like every other decision in this file: the
      // board can move while the question waits on the chain.
      return eligibleTargets(state, d.playerIndex, targeting.owner, targeting.scope).map((u) => ({
        id: u.instanceId,
        label: u.name,
        instanceId: u.instanceId,
      }));
    },
    resolve: (state, d, optionId) => {
      const card = state.players[d.playerIndex].trash.find((c) => c.instanceId === d.cardInstanceId);
      if (card === undefined) return state;
      // Out of the trash before it is played, or the card is in two zones at once
      // — the same ordering the spell-choosing question above takes.
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        trash: players[d.playerIndex].trash.filter((c) => c.instanceId !== card.instanceId),
      };
      const played = playCardIgnoringCost({ ...state, players }, d.playerIndex, card, undefined, {
        targetUnitInstanceId: optionId,
      });
      // "RECYCLE that spell after you play it" — the same tail the first question
      // runs, and for the same reason: a resolved Spell has been put back in the
      // trash by `playSpellImmediately`, so it is taken from there by identity.
      const after = [...played.players] as [PlayerState, PlayerState];
      const owner = after[d.playerIndex];
      if (!owner.trash.some((c) => c.instanceId === card.instanceId)) return played;
      after[d.playerIndex] = {
        ...owner,
        trash: owner.trash.filter((c) => c.instanceId !== card.instanceId),
        deck: [...owner.deck, card],
      };
      return holdCardsRecycled({ ...played, players: after }, d.playerIndex, 1);
    },
  },
  "SFD-144-draw": {
    // Spirit Wheel's "you may pay [1] and exhaust this to draw 1."
    prompt: () => "Spirit Wheel: pay [1] and exhaust it to draw 1?",
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      // Both halves re-asked at ANSWER time, the convention every paid decision
      // here follows: the question waits on the chain, and in that time the
      // Energy can be spent elsewhere and the Wheel can be exhausted by
      // something else or leave play entirely.
      const gear = d.cardInstanceId
        ? state.players[d.playerIndex].activeGear.find((g) => g.instanceId === d.cardInstanceId)
        : undefined;
      if (gear && !gear.exhausted && payEnergyFromPool(state, d.playerIndex, SPIRIT_WHEEL_DRAW_COST)) {
        options.push({ id: "pay", label: "Pay [1], exhaust Spirit Wheel, draw 1" });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId !== "pay" || d.cardInstanceId === undefined) return state;
      const paid = payEnergyFromPool(state, d.playerIndex, SPIRIT_WHEEL_DRAW_COST);
      // A payment that cannot be made draws nothing AND exhausts nothing — the
      // cost is one act, so neither half happens without the other.
      if (!paid) return state;
      return drawCards(exhaustGear(paid, d.playerIndex, d.cardInstanceId), d.playerIndex, 1);
    },
  },
  /** Stealthy Pursuer's "I may be moved with it" — see his trigger above for the
   *  timing divergence this question inherits. */
  "OGN-177-follow": {
    prompt: () => "Stealthy Pursuer: follow the unit that just left?",
    options: (state, d) => {
      // Moot if he has since died or already been moved away — a question about
      // a board that no longer exists is dropped rather than answered.
      const location = d.cardInstanceId ? findUnitAnywhere(state, d.cardInstanceId) : undefined;
      if (!location || location.zone === "base") return [];
      if (state.battlefields[location.zone.battlefieldIndex]!.id === d.battlefieldId) return [];
      return [
        { id: "stay", label: "Stay" },
        { id: "follow", label: "Follow it" },
      ];
    },
    resolve: (state, d, optionId) =>
      optionId === "follow" && d.cardInstanceId && d.battlefieldId
        ? // Through the real move funnel, so arriving contests the battlefield
          // and stages a Showdown exactly as a walk-in would. It fires no
          // on-move trigger, which `forceMoveToBattlefield`'s own note already
          // records as this engine's reading of a spell-driven move.
          forceMoveToBattlefield(state, d.cardInstanceId, d.battlefieldId)
        : state,
  },
  // Stacked Deck's "put 1 into your hand and recycle the rest".
  //
  // The options are the top 3 read from LIVE state when the question reaches the
  // front of the queue, not captured when it was raised — a question queued
  // behind another must not offer a card the earlier answer has since drawn.
  /**
   * Nocturne - Horrifying's "as you look at or reveal me from the top of your
   * deck, you may banish me. If you do, you may play me for [rainbow]."
   *
   * Two nested "you may"s, offered as THREE options rather than two questions:
   * banishing without playing is a real (if rare) line — it thins the deck and
   * denies a mill — and asking the second question separately would need a way
   * to remember that the first was answered yes.
   *
   * `cardInstanceId` names the copy that was seen. Not "the top card": half the
   * effects that look at a top-5 recycle it before this can be answered, so by
   * the time the offer resolves he may be at the BOTTOM of the deck — see
   * engine/top-of-deck.ts.
   *
   * **Unverified:** when the looking effect goes on to ask its own question about
   * the same cards (Reinforce, Stacked Deck, Baited Hook, Promising Future),
   * banishing him here means that question re-slices a top-N that has moved up
   * by one, so it sees a card the player never looked at. The rules would keep
   * the looked-at set fixed. Recorded in docs/rules-conformance.md.
   */
  "OGN-194-banish": {
    prompt: () => "Nocturne - Horrifying: banish him from the top of your deck?",
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      // Moot if he has left the deck since the offer was raised — no options is
      // how a question that no longer applies is dropped.
      if (!state.players[d.playerIndex].deck.some((c) => c.instanceId === d.cardInstanceId)) return [];
      options.push({ id: "banish", label: "Banish him" });
      if (payPowerFromChanneled(state, d.playerIndex, RAINBOW, NOCTURNE_POWER) !== undefined) {
        options.push({ id: "play", label: "Banish him and play him for 1 rainbow Power" });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline" || !d.cardInstanceId) return state;
      const actor = state.players[d.playerIndex];
      const card = actor.deck.find((c) => c.instanceId === d.cardInstanceId);
      if (!card) return state;

      // Out of the deck either way — the banish is what both live options share,
      // and it is what the play is conditional on ("IF YOU DO, you may play me").
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...actor,
        deck: actor.deck.filter((c) => c.instanceId !== card.instanceId),
        banished: [...actor.banished, card],
      };
      const banished: GameState = { ...state, players };
      if (optionId !== "play") return banished;

      // Pay first, and stop at the banish if the Power has gone since the offer.
      const paid = payPowerFromChanneled(banished, d.playerIndex, RAINBOW, NOCTURNE_POWER);
      if (paid === undefined) return banished;
      const after = [...paid.players] as [PlayerState, PlayerState];
      after[d.playerIndex] = {
        ...after[d.playerIndex],
        banished: after[d.playerIndex].banished.filter((c) => c.instanceId !== card.instanceId),
        // "PLAY me" — a card you played, so [Legion] and the play-watchers see it.
        cardsPlayedThisTurn: after[d.playerIndex].cardsPlayedThisTurn + 1,
      };
      // "Play me FOR [rainbow]" — the rainbow Power is the whole price, so his
      // 4 Energy and his Chaos pip are both waived.
      return playCardIgnoringCost({ ...paid, players: after }, d.playerIndex, card);
    },
  },
  "OGN-183-keep": {
    prompt: () => "Stacked Deck: put one into your hand, recycle the rest",
    options: (state, d) =>
      state.players[d.playerIndex].deck.slice(0, 3).map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId })),
    resolve: (state, d, optionId) => takeOneFromTopAndRecycleRest(state, d.playerIndex, 3, optionId),
  },
  // Hard Bargain's "unless its controller pays [2]" — answered by the SPELL'S
  // controller, whose seat is `d.playerIndex`.
  //
  // Every branch re-asks whether the spell is still on the chain, because a
  // repeated Hard Bargain queues two of these against the same target and the
  // first may already have countered it. 359.3: a check on something no longer
  // available returns null and the instruction is ignored.
  "SFD-136-ransom": {
    prompt: (state, d) => {
      const spell = spellsOnChain(state).find((s) => s.entry.card.instanceId === d.cardInstanceId);
      return spell ? `Hard Bargain: pay [2] or ${spell.entry.card.name} is countered` : "Hard Bargain: nothing left to counter";
    },
    options: (state, d) => {
      const spell = spellsOnChain(state).find((s) => s.entry.card.instanceId === d.cardInstanceId);
      // Already countered by the first execution's ransom. ONE option, which
      // `advanceDecisions` auto-resolves, so nobody is prompted for a question
      // that no longer has a subject.
      if (!spell) return [{ id: "gone", label: "Nothing to counter" }];
      // Declining first, so a mis-click and the AI's tie-break both land on the
      // option that costs nothing — the convention Flame Chompers records. Here
      // that means being countered, which is the card working as printed.
      const options: DecisionOption[] = [{ id: "decline", label: `Let ${spell.entry.card.name} be countered` }];
      // Offered only when the 2 Energy is really payable — floating first, then
      // Ready runes, which is what `payEnergyFromPool` does. A controller who
      // cannot pay is simply countered.
      if (payEnergyFromPool(state, d.playerIndex, HARD_BARGAIN_RANSOM)) {
        options.push({ id: "pay", label: `Pay [${HARD_BARGAIN_RANSOM}] to save it` });
      }
      return options;
    },
    // The "is it still there?" guard lives in `options` above, NOT here. A
    // duplicate scan in this function was written first and then deleted for
    // failing its own mutation test: removing it changed no observable
    // behaviour, because `options` never offers "pay" for a spell that is gone
    // and `counterSpell` on a missing id is a no-op. Deleting the `options`
    // guard, by contrast, throws. One of the two was load-bearing and it is that
    // one — so this branches on the option and trusts the offer, which is the
    // same contract every other decision here works under.
    resolve: (state, d, optionId) => {
      if (!d.cardInstanceId || optionId === "gone") return state;
      if (optionId === "pay") {
        // Re-derived rather than trusted: the Energy may have gone between the
        // offer and the answer, and a payment that cannot be made does not save
        // the spell.
        const paid = payEnergyFromPool(state, d.playerIndex, HARD_BARGAIN_RANSOM);
        return paid ?? counterSpell(state, d.cardInstanceId);
      }
      return counterSpell(state, d.cardInstanceId);
    },
  },
  "SFD-122-keep": {
    // Called Shot's half of Stacked Deck's question, at 2 rather than 3.
    //
    // `options` reads LIVE state rather than a snapshot, which is what makes a
    // repeated Called Shot correct: the second execution's question is asked of
    // the deck the first one left behind.
    prompt: () => "Called Shot: draw one, recycle the other",
    options: (state, d) =>
      state.players[d.playerIndex].deck.slice(0, 2).map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId })),
    resolve: (state, d, optionId) => takeOneFromTopAndRecycleRest(state, d.playerIndex, 2, optionId),
  },

  // Mindsplitter's "choose a card from it, and they discard that card".
  //
  // The chooser is the caster (`d.playerIndex`); the cards are the opponent's,
  // and so is the discard. Routed through discardCards so the discarded card
  // still fires its own on-discard trigger (Flame Chompers, Scrapheap) and still
  // sets `discardedThisTurn` for Raging Soul and Jinx - Rebel — a hand-rolled
  // move would silently skip all three.
  "OGN-192-discard": {
    prompt: () => "Mindsplitter: choose a card for your opponent to discard",
    options: (state, d) => {
      const opponent = state.players[d.playerIndex === 0 ? 1 : 0];
      return opponent.hand.map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId }));
    },
    resolve: (state, d, optionId) => {
      const opponentIndex: 0 | 1 = d.playerIndex === 0 ? 1 : 0;
      return discardCards(state, opponentIndex, 1, [optionId]);
    },
  },

  // Acceptable Losses' half of the work: one player picking which of their OWN
  // gear dies. Asked of both players, so it is written from the answering
  // player's point of view rather than the caster's — the same shape as
  // Cull the Weak's "OGN-209-kill".
  //
  // No decline option: the text carries no "you may", so a player with gear must
  // kill one. A player with NO gear produces no options at all and
  // advanceDecisions drops the question as moot (422's "do as much as you can");
  // a player with exactly one is not being offered a choice, and it dies without
  // a prompt.
  "OGN-179-kill": {
    prompt: () => "Acceptable Losses: kill one of your gear",
    options: (state, d) =>
      state.players[d.playerIndex].activeGear.map((g) => ({ id: g.instanceId, label: g.name, instanceId: g.instanceId })),
    // killGear, not a hand-rolled removal: it is the funnel that trashes a gear
    // and fires its own killed self-trigger, so a Treasure Trove taken by this
    // still pays out and a Scrapheap still draws.
    resolve: (state, d, optionId) => {
      const gear = state.players[d.playerIndex].activeGear.find((g) => g.instanceId === optionId);
      return gear ? killGear(state, gear, d.playerIndex) : state;
    },
  },

  // Whirlwind's half: one player choosing a unit — ANY unit, either owner's,
  // base or battlefield (355.9.a.1's bare noun) — to send to its owner's hand.
  //
  // The decline leads, and is what makes "MAY" mean may: with no unit in play at
  // all it is the only option, so the question is executed rather than asked and
  // nobody is interrupted to be told there is nothing to do. Leading also means a
  // mis-click and the AI's tie-break both land on doing nothing, the same
  // convention Flame Chompers' offer uses.
  //
  // `returnUnitToHand` sends it to its OWNER's hand rather than the answering
  // player's, and strips Buffs on the way (709) — both already handled there.
  "OGN-187-return": {
    prompt: () => "Whirlwind: you may return a unit to its owner's hand",
    options: (state): DecisionOption[] => [
      { id: "decline", label: "Decline" },
      ...allUnitsInPlay(state).map((u) => ({ id: u.instanceId, label: u.name, instanceId: u.instanceId })),
    ],
    resolve: (state, _d, optionId) => (optionId === "decline" ? state : returnUnitToHand(state, optionId)),
  },

  // Soulgorger's "you may play a unit from your trash, ignoring its Energy cost."
  //
  // The decline comes FIRST so that a mis-click and the AI's tie-break both land
  // on doing nothing, the same convention Whirlwind's offer above uses — and it
  // is the whole difference between this entry and The Harrowing's below, which
  // prints the same instruction without "you may".
  "OGN-196-play": {
    prompt: () => "Soulgorger: you may play a unit from your trash, paying only its Power cost",
    options: (state, d) => [{ id: "decline", label: "Decline" }, ...playableTrashUnits(state, d.playerIndex)],
    resolve: (state, d, optionId) => (optionId === "decline" ? state : playUnitFromTrash(state, d.playerIndex, optionId)),
  },

  // The Harrowing's "Play a unit from your trash, ignoring its Energy cost."
  //
  // No decline: the instruction is mandatory, so the only options are the units
  // that can actually be played. With none the list is EMPTY and
  // `advanceDecisions` drops the question (422 — do as much as you can, then
  // nothing); with exactly one it executes it without asking, because one option
  // is not a choice. Both branches are asserted in test/cards-harrowing.test.ts,
  // since a mandatory question with no answer is the one shape that could hang
  // the game rather than fizzle.
  "OGN-198-play": {
    prompt: () => "The Harrowing: play a unit from your trash, paying only its Power cost",
    options: (state, d) => playableTrashUnits(state, d.playerIndex),
    resolve: (state, d, optionId) => playUnitFromTrash(state, d.playerIndex, optionId),
  },

  // Fae Porter's "you may pay [Chaos] to move a unit you control to the same
  // battlefield." One question over both halves, not two: the payment is a cost
  // WITHIN the instruction (355.10.d.1), so declining to move and declining to
  // pay are the same answer and asking them separately would need a way to
  // remember that the first was said yes to.
  //
  // Priced when the OPTIONS are built and again when one is taken, the same split
  // `playableTrashUnits` makes: the question can sit behind others, and the Chaos
  // rune it was offered against may have been spent in between.
  "SFD-125-move": {
    prompt: () => "Fae Porter: pay 1 Chaos Power to move a unit you control to his battlefield?",
    options: (state, d) => {
      const decline: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      if (!d.battlefieldId) return [];
      if (payPowerFromChanneled(state, d.playerIndex, "Chaos", 1) === undefined) return decline;
      return [
        ...decline,
        ...ownUnitsElsewhere(state, d.playerIndex, d.battlefieldId).map((u) => ({
          id: u.instanceId,
          label: `Pay 1 Chaos Power: move ${u.name} here`,
          instanceId: u.instanceId,
        })),
      ];
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline" || !d.battlefieldId) return state;
      const paid = payPowerFromChanneled(state, d.playerIndex, "Chaos", 1);
      if (paid === undefined) return state;
      return forceMoveToBattlefield(paid, optionId, d.battlefieldId);
    },
  },

  // Loyal Pup's "you may move me there". The decline leads, so a mis-click and
  // the AI's tie-break both land on doing nothing — the convention Whirlwind's
  // and Soulgorger's offers already use.
  "SFD-126-join": {
    prompt: () => "Loyal Pup: move him to the battlefield you are defending?",
    options: (state, d) => {
      // Moot if he has since died, or has already been moved into the fight — a
      // question about a board that no longer exists is dropped, not answered.
      const location = d.cardInstanceId ? findUnitAnywhere(state, d.cardInstanceId) : undefined;
      if (!location || !d.battlefieldId) return [];
      if (location.zone !== "base" && state.battlefields[location.zone.battlefieldIndex]!.id === d.battlefieldId) return [];
      return [
        { id: "stay", label: "Stay" },
        { id: "join", label: "Move him to the fight" },
      ];
    },
    resolve: (state, d, optionId) =>
      optionId === "join" && d.cardInstanceId && d.battlefieldId
        ? forceMoveToBattlefield(state, d.cardInstanceId, d.battlefieldId)
        : state,
  },

  // Overzealous Fan's "you may kill me to move an attacking unit to its base."
  //
  // The attackers are re-read from LIVE state when the question reaches the front
  // of the queue rather than captured when it was raised, so a unit that has
  // since left the fight is not offered — and the battlefield is captured,
  // because by then the Fan may no longer be standing at it.
  "SFD-128-sacrifice": {
    prompt: () => "Overzealous Fan: kill him to send an attacking unit home?",
    options: (state, d) => {
      // The COST first: with the Fan already gone there is nothing to pay with,
      // so the question is moot rather than declinable.
      if (!d.cardInstanceId || !findUnitAnywhere(state, d.cardInstanceId) || !d.battlefieldId) return [];
      return [
        { id: "decline", label: "Decline" },
        ...attackingUnitsAt(state, d.battlefieldId).map((u) => ({
          id: u.instanceId,
          label: `Kill him: send ${u.name} to its base`,
          instanceId: u.instanceId,
        })),
      ];
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline" || !d.cardInstanceId) return state;
      if (!findUnitAnywhere(state, d.cardInstanceId)) return state; // the cost can no longer be paid
      // Cost, then effect. `destroyUnit` runs the full death funnel, so his own
      // death still reaches a death-watch and a Deathknell on the board.
      return recallUnitToBase(destroyUnit(state, d.cardInstanceId), optionId);
    },
  },

  // Beast Below's two halves. Both MANDATORY — the card carries no "you may" —
  // so neither offers a decline: with candidates the player must pick one, with
  // exactly one candidate it happens without a prompt, and with none the option
  // list is EMPTY and `advanceDecisions` drops that half while the other still
  // runs. That last case is the whole reason these are decisions; see the card's
  // entry.
  "SFD-132-friendly": {
    prompt: () => "Beast Below: return another friendly unit to its owner's hand",
    options: (state, d) =>
      ownUnitsEverywhere(state, d.playerIndex)
        .filter((u) => u.instanceId !== d.cardInstanceId) // "ANOTHER"
        .map((u) => ({ id: u.instanceId, label: u.name, instanceId: u.instanceId })),
    resolve: (state, _d, optionId) => returnUnitToHand(state, optionId),
  },
  "SFD-132-enemy": {
    prompt: () => "Beast Below: return an enemy unit to its owner's hand",
    options: (state, d) =>
      ownUnitsEverywhere(state, d.playerIndex === 0 ? 1 : 0).map((u) => ({
        id: u.instanceId,
        label: u.name,
        instanceId: u.instanceId,
      })),
    resolve: (state, _d, optionId) => returnUnitToHand(state, optionId),
  },

  // Windsinger's "you may return another unit at a battlefield with 3 Might or
  // less to its owner's hand." The decline leads, and is what makes "may" mean
  // may — with nothing small enough on the board it is the only option, so the
  // question is executed rather than shown and nobody is interrupted to be told
  // there is nothing to do.
  //
  // No owner restriction: "another unit", not "an enemy unit". Bouncing your own
  // resets its damage and rescues it from a fight, exactly as Rebuke's does.
  "SFD-138-return": {
    prompt: () => "Windsinger: you may return a unit at a battlefield with 3 Might or less to its owner's hand",
    options: (state, d): DecisionOption[] => [
      { id: "decline", label: "Decline" },
      ...unitsAtBattlefields(state)
        .filter(({ unit }) => unit.instanceId !== d.cardInstanceId) // "ANOTHER"
        // The shared predicate the enumerator and the validator use for a
        // `maxMight` spec, so "3 Might or less" cannot come to mean two things.
        .filter(({ unit }) => unitWithinMaxMight(state, unit, WINDSINGER_MAX_MIGHT))
        .map(({ unit }) => ({ id: unit.instanceId, label: unit.name, instanceId: unit.instanceId })),
    ],
    resolve: (state, _d, optionId) => (optionId === "decline" ? state : returnUnitToHand(state, optionId)),
  },

  // Bewitching Spirit's "choose a player. They discard 1."
  //
  // TWO options at 1v1, not one: "a player" reaches either seat, unlike
  // Mindsplitter's "an opponent" — see the card's entry. So this is one of the
  // few questions in this file that genuinely prompts in a two-player game
  // rather than being executed by `advanceDecisions` as a formality.
  //
  // No decline: the text carries no "you may", so a player must be chosen. The
  // OPPONENT leads, which is the convention the decline-first offers here use for
  // the same reason — a mis-click and the AI's tie-break should land on the
  // ordinary answer, and for a card whose whole job is to strip a hand that is
  // the enemy's.
  //
  // The discard itself is `discardCards`, so with more than one card in hand it
  // stops and asks the CHOSEN player which card goes, and it fires
  // `cardsDiscarded` once for the instruction — a Jinx - Rebel on that side
  // readies once.
  "UNL-121-discard": {
    prompt: () => "Bewitching Spirit: choose a player. They discard 1.",
    // Typed `(0 | 1)[]` rather than inferred: a bare array literal widens to
    // `number[]`, and `players` is a two-tuple, so the lookup below cannot be
    // proven in-bounds and fails the typecheck. vitest transpiles without
    // checking types, so this only appears at step 3 of the loop.
    options: (state, d) => {
      const order: (0 | 1)[] = d.playerIndex === 0 ? [1, 0] : [0, 1];
      return order.map((index) => ({
        id: String(index),
        label: `${state.players[index].name} discards 1`,
      }));
    },
    resolve: (state, _d, optionId) => discardCards(state, optionId === "1" ? 1 : 0, 1),
  },

  // Sinister Poro's "you may pay [1] to move an enemy unit here to its base."
  // One question over both halves, not two: the payment is a cost WITHIN the
  // instruction (355.10.d.1), so declining to pay and declining to move are the
  // same answer — Fae Porter's entry above records the same reasoning.
  //
  // "HERE" is re-checked rather than trusted: with the Poro no longer standing at
  // the battlefield the trigger fired at, the question is MOOT (no options) and
  // `advanceDecisions` drops it, which is the "mistargets" outcome the rules work
  // through for Yasuo - Remorseful's attack trigger. The enemies are likewise
  // re-read from LIVE state, so a unit that has since left the fight is not
  // offered.
  //
  // Priced when the options are built AND again when one is taken, the same split
  // Fae Porter makes: the question can sit behind others, and the Energy it was
  // offered against may have been spent in between.
  "UNL-137-move": {
    prompt: () => "Sinister Poro: pay 1 Energy to send an enemy unit here to its base?",
    options: (state, d) => {
      if (!d.cardInstanceId || !d.battlefieldId) return [];
      const poro = findUnitAnywhere(state, d.cardInstanceId);
      if (!poro || poro.zone === "base") return []; // dead, or sent home himself
      if (state.battlefields[poro.zone.battlefieldIndex]!.id !== d.battlefieldId) return []; // "here" has moved
      const decline: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      if (payEnergyFromPool(state, d.playerIndex, SINISTER_PORO_COST) === undefined) return decline;
      return [
        ...decline,
        ...enemyUnitsAt(state, d.playerIndex, d.battlefieldId).map((u) => ({
          id: u.instanceId,
          label: `Pay 1 Energy: send ${u.name} to its base`,
          instanceId: u.instanceId,
        })),
      ];
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      // Cost, then effect. An Energy that has been spent since the options were
      // built makes this fizzle rather than move a unit for free.
      const paid = payEnergyFromPool(state, d.playerIndex, SINISTER_PORO_COST);
      if (paid === undefined) return state;
      return recallUnitToBase(paid, optionId);
    },
  },

  // Abandon's `[Predict]` — "Look at the top card of your Main Deck. You may
  // recycle it."
  //
  // The decline leads, so a mis-click and the AI's tie-break both land on leaving
  // the deck alone, which is the answer that changes nothing.
  //
  // The card is named in the label: the player has LOOKED at it, so hiding it
  // behind "the top card" would be a worse question than the card asks. The
  // option's `instanceId` lets the board show the face.
  //
  // `options` reads LIVE state rather than a snapshot, which is what makes it
  // correct behind a Nocturne - Horrifying banish queued in front of it: if he
  // took the card being looked at, this asks about whatever is on top now.
  /**
   * Walking Roost — WHERE the opponent puts the Bird you gave them.
   *
   * Parked on THEIR index, because "they play a 1 Might Bird unit token" makes it
   * their play and so their choice. 185.2.a gives a played token the ordinary
   * steps for playing a card, and the inherent restriction on playing a Unit is
   * "base or a battlefield they control" — so those are the options, and no more.
   *
   * `mayPlayUnitAt` is asked per battlefield rather than once, because Rockfall
   * Path prints "units can't be played here" and a token unit being played is a
   * unit being played. Base is always legal and always offered, so this decision
   * can never be empty.
   */
  "UNL-130-where": {
    prompt: () => "Walking Roost: where does your Bird go?",
    options: (state, d) => [
      { id: "base", label: "Your base" },
      ...state.battlefields
        .filter((bf) => bf.controllerId === state.players[d.playerIndex].id && mayPlayUnitAt(state, bf.id))
        .map((bf) => ({ id: bf.id, label: bf.name })),
    ],
    resolve: (state, d, optionId) =>
      placeToken(state, d.playerIndex, optionId === "base" ? "base" : { battlefieldId: optionId }, BIRD_TOKEN),
  },
  "UNL-131-predict": {
    prompt: () => "Abandon: recycle the top card of your Main Deck?",
    options: (state, d): DecisionOption[] => {
      const top = state.players[d.playerIndex].deck[0];
      if (!top) return []; // the deck emptied while this waited — 422
      return [
        { id: "keep", label: `Keep ${top.name} on top`, instanceId: top.instanceId },
        { id: "recycle", label: `Recycle ${top.name}`, instanceId: top.instanceId },
      ];
    },
    resolve: (state, d, optionId) => (optionId === "recycle" ? recycleTopCard(state, d.playerIndex) : state),
  },

  // Blast Cone's "you may move an enemy unit", raised by its on-play self-trigger.
  //
  // ONE question over both choices — which unit AND where — because a move is one
  // instruction and answering half of it is not an answer. That is why the option
  // id is a pair (`<unitInstanceId>:<destination>`), the same encoding
  // `battlefield-abilities.ts` and two other decision handlers here already use
  // for a two-part answer.
  //
  // "AN ENEMY UNIT" carries no location word, so 355.9.a.1's board-wide reading
  // applies and a unit sitting in the opponent's base is a legal choice — pulling
  // a reinforcement onto a battlefield you already hold is the line, and it is the
  // same reading Blitzcrank - Impassive's grab takes of the identical phrase.
  //
  // **BASE is a destination**, not just battlefields: 355.4.a makes any Location
  // the unit is allowed to be present at a valid Move Destination, 198.1/107.1.b
  // make each Base a Location, and 359.3.e works the case by name for Ride the
  // Wind. Vilemaw's Lair can forbid it, and `mayMoveToBaseFrom` is asked HERE so
  // the option is never offered and then silently refused — the same door
  // `forceMoveToBase` itself goes through, and the same one `legal-actions` asks
  // before offering a Recall.
  //
  // The unit's CURRENT location is excluded on both axes (355.4.a's "other than
  // the Unit's current Location"): a base unit is not offered "to base", and a
  // unit at bf1 is not offered bf1. Offering a move that cannot happen is the
  // offered-then-refused shape this file keeps out.
  //
  // Not an exhaust and not a Standard Move, so `[Ganking]` is irrelevant to it —
  // 415.1.b/144.2 put the exhaust and the battlefield-to-battlefield restriction
  // on the Standard Move ACTION, and Charm's entry makes the same call.
  /**
   * Blast Cone's "you may exhaust this to [Stun] it".
   *
   * A question rather than automatic: "you may" is a real choice, and exhausting
   * the Cone costs its next use. Both options always exist here, because `applies`
   * already refused the case where the gear cannot pay.
   */
  "UNL-133-stun": {
    prompt: (state, d) => {
      const unit = d.targetInstanceId === undefined ? undefined : findUnitAnywhere(state, d.targetInstanceId);
      return `Blast Cone: exhaust it to stun ${unit?.unit.name ?? "that unit"}?`;
    },
    options: () => [
      { id: "decline", label: "Leave it" },
      { id: "stun", label: "Exhaust Blast Cone and stun it" },
    ],
    resolve: (state, d, optionId) => {
      if (optionId !== "stun" || d.targetInstanceId === undefined) return state;
      // Exhaust FIRST — it is the cost, and a cost that cannot be paid must not
      // buy the effect. The gear is re-read here rather than trusted from
      // `applies`, because the response window this question opens could have
      // exhausted or removed it.
      const gear = state.players[d.playerIndex].activeGear.find((g) => g.instanceId === d.cardInstanceId);
      if (!gear || gear.exhausted) return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        activeGear: players[d.playerIndex].activeGear.map((g) =>
          g.instanceId === d.cardInstanceId ? { ...g, exhausted: true } : g,
        ),
      };
      // Still on the board? A unit that died in the window cannot be stunned,
      // and 359.3.e.6 skips an impossible instruction rather than failing.
      if (!findUnitAnywhere({ ...state, players }, d.targetInstanceId)) return { ...state, players };
      return stunUnits({ ...state, players }, d.playerIndex, [d.targetInstanceId]);
    },
  },
  "UNL-133-move": {
    prompt: () => "Blast Cone: move an enemy unit?",
    options: (state, d): DecisionOption[] => [
      { id: "decline", label: "Decline" },
      ...ownUnitsEverywhere(state, d.playerIndex === 0 ? 1 : 0).flatMap((unit) => {
        const at = findUnitAnywhere(state, unit.instanceId);
        if (!at) return [];
        const fromId = at.zone === "base" ? undefined : state.battlefields[at.zone.battlefieldIndex]!.id;
        const options: DecisionOption[] = state.battlefields
          .filter((bf) => bf.id !== fromId)
          .map((bf) => ({ id: `${unit.instanceId}:${bf.id}`, label: `Move ${unit.name} to ${bf.name}`, instanceId: unit.instanceId }));
        if (fromId !== undefined && mayMoveToBaseFrom(state, fromId)) {
          options.push({ id: `${unit.instanceId}:base`, label: `Move ${unit.name} to its base`, instanceId: unit.instanceId });
        }
        return options;
      }),
    ],
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      const [unitId, destination] = optionId.split(":");
      if (!unitId || !destination) return state;
      // Through the shared destination helper like every other move in this file,
      // so an arrival at a battlefield applies Contested and can stage a Showdown
      // — which for a gear that then wants to stun the arrival is the point.
      // **`d.playerIndex` is the MOVER** — the Blast Cone controller pushing an
      // enemy unit around, not the unit's own controller. That distinction is the
      // whole reason this card's second clause ("when YOU move an enemy unit")
      // could not be written before `causedByIndex` existed.
      return forceMoveToDestination(
        state,
        unitId,
        destination === "base" ? { destinationIsBase: true } : { destinationBattlefieldId: destination },
        d.playerIndex,
      );
    },
  },

  // Insightful Investigator's "you may pay 2 XP to choose a card from their hand.
  // If you do, they discard that card and draw 1."
  //
  // Mindsplitter's question with a price on it. The chooser is the CASTER
  // (`d.playerIndex`) while the cards, the discard and the draw are all the
  // opponent's, which is why the options read one player's hand and the resolver
  // acts on the other.
  //
  // **The XP is charged here, at resolution, and the rules say so twice by name**
  // — 204.3.b ("As the ability resolves, its controller may pay 2 XP as a cost")
  // and 383.3.b ("Paying 2 XP is performed on resolution"). Both passages quote
  // this very card.
  //
  // The decline leads and is ALWAYS present: 2 XP is real money early, and a hand
  // worth nothing is a hand not worth 2 XP. With too little XP the decline is the
  // ONLY option, so `advanceDecisions` executes it without interrupting anybody —
  // which is also what stops the offer from being made and then refused (416.3).
  //
  // Priced when the options are built AND again when one is taken, the same split
  // Fae Porter and Sinister Poro make: the question can sit behind others, and XP
  // banked when it was raised can have been spent by a card ahead of it.
  "UNL-135-take": {
    prompt: () => "Insightful Investigator: pay 2 XP to take a card from the revealed hand?",
    options: (state, d): DecisionOption[] => {
      const decline: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      if (!canSpendXp(state, d.playerIndex, INVESTIGATOR_XP)) return decline;
      const opponent = state.players[d.playerIndex === 0 ? 1 : 0];
      return [
        ...decline,
        ...opponent.hand.map((c) => ({
          id: c.instanceId,
          label: `Pay 2 XP: they discard ${c.name} and draw 1`,
          instanceId: c.instanceId,
        })),
      ];
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      const paid = spendXp(state, d.playerIndex, INVESTIGATOR_XP);
      if (paid === undefined) return state; // spent since the options were built
      const opponentIndex: 0 | 1 = d.playerIndex === 0 ? 1 : 0;
      // `discardCards` with the card NAMED, so the chosen card goes rather than
      // the front of hand — and so the discard still fires its own on-discard
      // trigger and still sets `discardedThisTurn`, which a hand-rolled move
      // would skip. Discard THEN draw, printed order: the drawn card must not be
      // one this instruction could have taken.
      return drawCards(discardCards(paid, opponentIndex, 1, [optionId]), opponentIndex, 1);
    },
  },

  // Bone Skewer's "you may choose a unit from it. They play that unit to that
  // battlefield, ignoring any and all costs. When they do, [Stun] it."
  //
  // Mindsplitter's question pointed at the other half of the hand: the CHOOSER is
  // the caster (`d.playerIndex`), the cards are the opponent's, and so is the
  // play. The decline leads, so a mis-click and the AI's tie-break both land on
  // the answer that changes nothing — the convention every optional offer here
  // uses.
  //
  // # "IGNORING ANY AND ALL COSTS" is wider than "ignoring its Energy cost"
  //
  // The Harrowing and Soulgorger both waive only the Energy and make the player
  // pay the Power (their own reminder text says so). This card waives everything,
  // so nothing is paid and nothing is checked for payability — which is what makes
  // it castable against a hand of 8-Energy bombs, and what makes the stun matter.
  //
  // # It is still a PLAY, and it is THEIRS
  //
  // Through `playUnitToBattlefield`, the shared deploy funnel, so the unit's own
  // on-play trigger fires, its `cardPlayed` event is held, and it enters exhausted
  // unless something says otherwise (143.4.a). `cardsPlayedThisTurn` is bumped on
  // the OPPONENT because they are the one playing it — that is what `[Legion]`
  // counts, and crediting the caster would be a different card.
  //
  // `applyContested` for the reason `free-play.ts` gives at its own deploy: a unit
  // appearing at a battlefield is a unit becoming present (190.3.a), so it
  // contests exactly as a walk-in does. Here that is frequently the whole point —
  // the caster picks a battlefield they hold and drops an unwilling attacker onto
  // it, stunned, so it cannot even deal combat damage in the Showdown it opened.
  //
  // The presence rule a paid or free play goes through (`mayPlaceWithoutPresence`)
  // is deliberately NOT asked: the card names the destination outright, and a
  // player with no units there is exactly the case it exists to create.
  "UNL-139-play": {
    prompt: () => "Bone Skewer: choose a unit from the revealed hand for them to play, stunned?",
    options: (state, d): DecisionOption[] => {
      if (!d.battlefieldId || !state.battlefields.some((bf) => bf.id === d.battlefieldId)) return [];
      return [
        { id: "decline", label: "Decline" },
        // Re-read from LIVE state: the question can sit behind others, and a card
        // discarded in between is not in the hand this instruction reveals.
        ...skewerableUnits(state, d.playerIndex === 0 ? 1 : 0).map((c) => ({
          id: c.instanceId,
          label: `They play ${c.name} here, stunned`,
          instanceId: c.instanceId,
        })),
      ];
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline" || !d.battlefieldId) return state;
      if (!state.battlefields.some((bf) => bf.id === d.battlefieldId)) return state;
      const opponentIndex: 0 | 1 = d.playerIndex === 0 ? 1 : 0;
      const card = state.players[opponentIndex].hand.find((c) => c.instanceId === optionId);
      if (!card || card.kind !== "Unit") return state;

      // Out of hand BEFORE it is played, or the card is in two zones at once —
      // the same ordering Fizz - Trickster's and Glasc Mixologist's decisions take.
      const players = [...state.players] as [PlayerState, PlayerState];
      players[opponentIndex] = {
        ...players[opponentIndex],
        hand: players[opponentIndex].hand.filter((c) => c.instanceId !== optionId),
        cardsPlayedThisTurn: players[opponentIndex].cardsPlayedThisTurn + 1,
      };
      const deployed = playUnitToBattlefield({ ...state, players }, opponentIndex, card, d.battlefieldId);
      const contested = applyContested(deployed, d.battlefieldId, opponentIndex);
      // "WHEN THEY DO, [Stun] it" — the stunner is the Skewer's controller, so a
      // Zed - Shadow on the caster's side pays out and one across the table does
      // not. `stunUnits` rather than a flag write, so `unitsStunned` is held once
      // for the instruction.
      return stunUnits(contested, d.playerIndex, [card.instanceId]);
    },
  },

  // Evelynn - Entrancing's "you may move an enemy unit at a different location to
  // my battlefield."
  //
  // "MY BATTLEFIELD" is captured when the question is raised AND re-checked
  // against where she is standing when it is answered — the rules work this exact
  // case for Yasuo - Remorseful's attack trigger, whose "here" mistargets once an
  // opponent has sent him home in the response window. An Evelynn who has been
  // bounced, killed or moved cannot still drag a unit to a battlefield she has
  // left, so the question is dropped as moot rather than answered. That is the
  // same door Sinister Poro's question goes through, one entry up.
  //
  // `forceMoveToBattlefield`, so the arrival applies Contested and can stage a
  // Showdown — which for a 2-Might [Backline] body arriving with an unwilling
  // enemy in tow is the point. It fires no on-move trigger and does not exhaust
  // the moved unit, which that helper's own note records as this engine's reading
  // of an effect-driven move (and which the UNL-127 divergence note above names as
  // the gap it inherits).
  "UNL-141-move": {
    prompt: () => "Evelynn - Entrancing: move an enemy unit to her battlefield?",
    options: (state, d): DecisionOption[] => {
      if (!d.cardInstanceId || !d.battlefieldId) return [];
      const evelynn = findUnitAnywhere(state, d.cardInstanceId);
      if (!evelynn || evelynn.zone === "base") return []; // dead, or sent home
      if (state.battlefields[evelynn.zone.battlefieldIndex]!.id !== d.battlefieldId) return []; // she has left
      return [
        { id: "decline", label: "Decline" },
        ...enemyUnitsElsewhere(state, d.playerIndex, d.battlefieldId).map((u) => ({
          id: u.instanceId,
          label: `Move ${u.name} to her battlefield`,
          instanceId: u.instanceId,
        })),
      ];
    },
    resolve: (state, d, optionId) =>
      optionId === "decline" || !d.battlefieldId ? state : forceMoveToBattlefield(state, optionId, d.battlefieldId),
  },

  // Maduli the Gatekeeper's destination — see his activated ability above for why
  // this is a decision rather than a `{ kind: "battlefield" }` targeting spec.
  //
  // `options` reads LIVE state through the same `maduliDestinations` that gated
  // the activation, so a board the answer arrives on is judged fresh: nothing can
  // change it today (an activated ability resolves inline, with no chain item and
  // no response window — counter-spell.ts records that divergence), and asking the
  // live board is what keeps that from mattering the day abilities go on the
  // chain. A Maduli who has left play offers nothing and the question is dropped.
  //
  // `causedByIndex` is his own controller: he is moving HIMSELF, so mover and
  // cause coincide — but naming it is what lets a "when you move a unit" listener
  // see this at all, which is the gap `unitMoved.causedByIndex` was added to close
  // (Blast Cone's second clause, UNL-133 in this file).
  [MADULI_MOVE]: {
    prompt: () => "Maduli the Gatekeeper: move him to which enemy battlefield?",
    options: (state, d): DecisionOption[] =>
      !d.cardInstanceId
        ? []
        : maduliDestinations(state, d.playerIndex, d.cardInstanceId).map((bf) => ({
            id: bf.id,
            label: `Move Maduli to ${bf.name}`,
          })),
    resolve: (state, d, optionId) =>
      !d.cardInstanceId ? state : forceMoveToBattlefield(state, d.cardInstanceId, optionId, d.playerIndex),
  },

  // Scryer's Bloom's `[Predict 2]` — 436.1.a's "recycle any of them and put the
  // rest back on top in any order."
  //
  // ONE question over both axes, because it is one instruction and answering half
  // of it is not an answer. With two cards on top that is five options and they
  // enumerate exhaustively: keep the order, swap it, recycle either one alone, or
  // recycle both. With one card it is the bare `[Predict]` question (436.3.a's X
  // presumed 1 is the same shape), and with none the list is EMPTY and
  // `advanceDecisions` drops the question — 436.4's "Predict as many as possible".
  //
  // The cards are NAMED in the labels: the player has looked at them, so hiding
  // them behind "the top card" would be a worse question than the card asks. The
  // options carry `instanceId` so the board can show the faces.
  //
  // `options` reads LIVE state rather than a snapshot, which is what makes it
  // correct behind a Nocturne - Horrifying banish queued in front of it: if he took
  // one of the two, this asks about whatever is on top now.
  //
  // **DIVERGENCE, one line of 416.5.** "If 2 or more cards are Recycled to the Main
  // Deck simultaneously, they are placed on the bottom of that deck in a RANDOM
  // order." The recycle-both option puts them at the bottom in deck order, because
  // this engine is deterministic by construction (the AI clones and re-scores
  // states, and `holdCardsRecycled` has no RNG to reach for). Two cards at the
  // bottom of a deck that is reshuffled by nothing makes this observable only by a
  // player who counts to the bottom of their own deck; it is recorded rather than
  // hidden, and it is the same simplification `recycleFromTrash`'s front-of-trash
  // convention already takes.
  "UNL-136-predict": {
    prompt: () => "Scryer's Bloom: recycle any of the top two, then put the rest back in any order",
    options: (state, d): DecisionOption[] => {
      const [first, second] = state.players[d.playerIndex].deck.slice(0, PREDICT_TWO);
      if (!first) return []; // the deck emptied while this waited — 436.4
      if (!second) {
        return [
          { id: "keep", label: `Keep ${first.name} on top`, instanceId: first.instanceId },
          { id: `recycle:${first.instanceId}`, label: `Recycle ${first.name}`, instanceId: first.instanceId },
        ];
      }
      return [
        { id: "keep", label: `Keep ${first.name} on top, ${second.name} under it`, instanceId: first.instanceId },
        { id: "swap", label: `Put ${second.name} on top, ${first.name} under it`, instanceId: second.instanceId },
        { id: `recycle:${first.instanceId}`, label: `Recycle ${first.name}`, instanceId: first.instanceId },
        { id: `recycle:${second.instanceId}`, label: `Recycle ${second.name}`, instanceId: second.instanceId },
        { id: "recycleBoth", label: `Recycle both ${first.name} and ${second.name}` },
      ];
    },
    resolve: (state, d, optionId) => {
      const top = state.players[d.playerIndex].deck.slice(0, PREDICT_TWO);
      if (top.length === 0 || optionId === "keep") return state;
      if (optionId === "swap") return reorderTopOfDeck(state, d.playerIndex, [...top].reverse());
      if (optionId === "recycleBoth") return recycleFromTop(state, d.playerIndex, top.map((c) => c.instanceId));
      const recycled = optionId.startsWith("recycle:") ? optionId.slice("recycle:".length) : undefined;
      // An option naming a card that is no longer on top does nothing rather than
      // recycling whatever has taken its place (359.3).
      if (recycled === undefined || !top.some((c) => c.instanceId === recycled)) return state;
      return recycleFromTop(state, d.playerIndex, [recycled]);
    },
  },

  // Heedless Resurrection's payoff — "play a unit from your trash that costs no
  // more Energy and no more Power than the killed unit, ignoring its cost".
  //
  // No decline: the instruction carries no "you may", so the only options are the
  // units that actually fit under both ceilings. The Harrowing's entry above takes
  // the same reading and pins both of the branches that follow from it.
  //
  // The ceilings are re-derived from `d.targetInstanceId` — the corpse in the
  // trash — rather than carried on the decision, because two numbers do not fit in
  // `PendingDecision.count` and a printed cost cannot change. See the card's entry
  // for the two cases where there is no corpse to read.
  "UNL-142-resurrect": {
    prompt: () => "Heedless Resurrection: play a unit from your trash that cost no more than the one you killed",
    options: (state, d) => heedlessOptions(state, d.playerIndex, d.targetInstanceId),
    resolve: (state, d, optionId) => playTrashUnitIgnoringCost(state, d.playerIndex, optionId),
  },

  // Cursed Sarcophagus' crack — "Play a unit banished with this. (You must pay
  // its costs.)"
  //
  // Priced when the OPTIONS are built and AGAIN when one is taken, the split
  // `playableTrashUnits` makes and for the same reason: this question can sit
  // behind others, and the runes it was offered against may be gone by the time it
  // is answered. Re-paying is what makes that fizzle rather than hand over a free
  // unit.
  //
  // The gear rides on `cardInstanceId` rather than being re-found, because two
  // Sarcophagi keep two pits and cracking the wrong one is a different game — the
  // same reason Spirit Wheel carries the Wheel that fired.
  "UNL-148-play": {
    prompt: () => "Cursed Sarcophagus: play a unit banished with it, paying its costs",
    options: (state, d) => sarcophagusOptions(state, d.playerIndex, d.cardInstanceId),
    resolve: (state, d, optionId) => playBanishedUnit(state, d.playerIndex, optionId),
  },
};

/**
 * The units in `playerIndex`'s HAND — Bone Skewer's "you may choose a unit from
 * it", asked of the opponent's revealed hand.
 *
 * ONE walk for the fire-time "is there anything to offer" test and for the option
 * list, so the two cannot disagree — the same shape (and the same reason) as
 * `fizzCandidates` above.
 *
 * No cost filter, unlike `playableTrashUnits`: "ignoring any and all costs" means
 * there is nothing to be unable to afford.
 */
function skewerableUnits(state: GameState, playerIndex: 0 | 1): UnitInstance[] {
  return state.players[playerIndex].hand.filter((c): c is UnitInstance => c.kind === "Unit");
}

/**
 * Rewrites the top `ordered.length` cards of a deck as `ordered` — 436.1.a's "put
 * the rest back on top of their Main Deck in any order".
 *
 * Not a recycle and deliberately not routed through `holdCardsRecycled`: nothing
 * has left the deck, so Karma - Channeler has nothing to see. Conflating the two
 * would pay her out for a player merely re-ordering their own top two.
 */
function reorderTopOfDeck(state: GameState, playerIndex: 0 | 1, ordered: readonly CardInstance[]): GameState {
  const owner = state.players[playerIndex];
  const players = [...state.players] as [PlayerState, PlayerState];
  players[playerIndex] = { ...owner, deck: [...ordered, ...owner.deck.slice(ordered.length)] };
  return { ...state, players };
}

/**
 * Recycles named cards off the TOP of a deck to its bottom (416.1) — the recycle
 * half of `[Predict 2]`.
 *
 * `holdCardsRecycled` is called ONCE with the total, not once per card: "when you
 * recycle one or more cards" is per INSTRUCTION, so recycling both tops readies a
 * Karma - Channeler once rather than twice. That is the same batch-event rule
 * `discardCards` follows, and getting it wrong is the double-pay this codebase has
 * already paid for.
 *
 * A private copy of `recycleTopCard`'s shape rather than a generalisation of it,
 * for the reason that function's own note gives: the shared home would be
 * effect-helpers.ts, which the one-file-one-owner rule keeps card implementations
 * out of.
 */
function recycleFromTop(state: GameState, playerIndex: 0 | 1, instanceIds: readonly string[]): GameState {
  const owner = state.players[playerIndex];
  const going = owner.deck.filter((c) => instanceIds.includes(c.instanceId));
  if (going.length === 0) return state;
  const players = [...state.players] as [PlayerState, PlayerState];
  players[playerIndex] = {
    ...owner,
    deck: [...owner.deck.filter((c) => !instanceIds.includes(c.instanceId)), ...going],
  };
  return holdCardsRecycled({ ...state, players }, playerIndex, going.length);
}

/** Windsinger's cap — "a unit at a battlefield with 3 [Might] or less". */
const WINDSINGER_MAX_MIGHT = 3;

/**
 * The units `playerIndex` controls at one battlefield — and, asked of the other
 * seat, the "enemy unit here" both Sinister Poro and Isolate count.
 *
 * Written against the battlefield's own map rather than filtering
 * `ownUnitsEverywhere`, because both callers need the answer for a NAMED
 * battlefield and neither cares about base.
 */
function unitsAt(state: GameState, playerIndex: 0 | 1, battlefieldId: string): UnitInstance[] {
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  return [...(bf?.units[state.players[playerIndex].id] ?? [])];
}

/** The units the OTHER player controls at one battlefield — Sinister Poro's "an
 *  enemy unit here", with "enemy" measured against the Poro's controller. */
function enemyUnitsAt(state: GameState, playerIndex: 0 | 1, battlefieldId: string): UnitInstance[] {
  return unitsAt(state, playerIndex === 0 ? 1 : 0, battlefieldId);
}

/**
 * Every unit standing at a battlefield, either owner's, with the owner index the
 * caller needs to price it.
 *
 * Battlefield order then player order, so an option list built from it is stable
 * and a test about WHICH unit was offered means something — the same reason
 * `allUnitsInPlay` fixes its own walk.
 */
function unitsAtBattlefields(state: GameState): { unit: UnitInstance; ownerIndex: 0 | 1 }[] {
  const out: { unit: UnitInstance; ownerIndex: 0 | 1 }[] = [];
  for (const bf of state.battlefields) {
    for (const ownerIndex of [0, 1] as const) {
      for (const unit of bf.units[state.players[ownerIndex].id] ?? []) out.push({ unit, ownerIndex });
    }
  }
  return out;
}

/**
 * The units in a player's trash they could play right now for their Power cost
 * alone — Soulgorger's offer and The Harrowing's, which print the same
 * instruction and differ only in whether declining is allowed.
 *
 * Priced when the OPTIONS are built, so a unit whose Power cost cannot be paid
 * is never offered rather than offered and then refused — 416.3's "the action
 * must be able to be completed for the cost to be paid", and the same shape
 * Flame Chompers' offer uses.
 *
 * **Named limitation, inherited by both cards:** affordability is asked through
 * `payPowerFromChanneled`, which takes a single domain and reads only the
 * channeled pool. So a card with a split Power pip (`powerDomainAlt`, e.g.
 * Tibbers) is judged against its primary domain only, and floating Power does
 * not count. Both UNDER-offer — the option is withheld, never granted free — and
 * both come from that helper rather than being introduced here. Widening it is a
 * change to effect-helpers.ts, not to this file.
 */
function playableTrashUnits(state: GameState, playerIndex: 0 | 1): DecisionOption[] {
  const options: DecisionOption[] = [];
  for (const card of state.players[playerIndex].trash) {
    if (card.kind !== "Unit") continue;
    if (payUnitPowerCost(state, playerIndex, card) === undefined) continue;
    options.push({ id: card.instanceId, label: playLabel(card), instanceId: card.instanceId });
  }
  return options;
}

/**
 * Takes the named unit out of the trash, pays its Power, and plays it to base.
 *
 * Out of the trash, then into play through the shared deploy funnel — so it
 * enters exhausted (143.4.a) unless something says otherwise, and both events a
 * real play fires go off. "Play a unit" means play it.
 *
 * The printed Energy is not paid and not discounted: the card's text replaces
 * that half of the cost outright, exactly as rule 811 does for a card played
 * from Hidden. `cardsPlayedThisTurn` is bumped because this IS a card being
 * played, which is what [Legion] counts.
 *
 * The cost is re-paid here rather than trusted from the option list, because the
 * options were built from an earlier state — anything that drained the pool
 * between the question and the answer makes this fizzle rather than play a unit
 * for free.
 */
function playUnitFromTrash(state: GameState, playerIndex: 0 | 1, optionId: string): GameState {
  const card = state.players[playerIndex].trash.find((c) => c.instanceId === optionId);
  if (!card || card.kind !== "Unit") return state;
  const paid = payUnitPowerCost(state, playerIndex, card);
  if (!paid) return state;

  const players = [...paid.players] as [PlayerState, PlayerState];
  players[playerIndex] = {
    ...players[playerIndex],
    trash: players[playerIndex].trash.filter((c) => c.instanceId !== optionId),
    cardsPlayedThisTurn: players[playerIndex].cardsPlayedThisTurn + 1,
  };
  return playUnitFree({ ...paid, players }, playerIndex, card);
}

/**
 * The units in `playerIndex`'s trash that fit under BOTH of Heedless
 * Resurrection's ceilings — "no more Energy AND no more Power than the killed
 * unit".
 *
 * The ceilings come off the corpse itself, still in the trash: printed pips, so
 * no cost modifier and no this-turn effect can move them, which is what makes
 * re-reading them a turn's worth of decisions later sound. With no corpse to read
 * there is no ceiling and nothing is offered — see the card's entry for the two
 * ways that happens.
 *
 * No affordability filter, unlike `playableTrashUnits`: "ignoring its cost" means
 * there is nothing to be unable to afford.
 */
function heedlessOptions(state: GameState, playerIndex: 0 | 1, corpseInstanceId: string | undefined): DecisionOption[] {
  if (corpseInstanceId === undefined) return [];
  const trash = state.players[playerIndex].trash;
  const corpse = trash.find((c) => c.instanceId === corpseInstanceId);
  if (corpse === undefined || corpse.kind !== "Unit") return [];
  return trash
    .filter((c): c is UnitInstance => c.kind === "Unit")
    .filter((c) => c.energyCost <= corpse.energyCost && c.powerCost <= corpse.powerCost)
    .map((c) => ({ id: c.instanceId, label: `Play ${c.name}`, instanceId: c.instanceId }));
}

/**
 * Takes a named unit out of the trash and plays it for nothing at all.
 *
 * `playUnitFromTrash`'s sibling with the payment removed, rather than a parameter
 * on it: that one exists because Soulgorger and The Harrowing print "ignoring its
 * ENERGY cost. (You must still pay its Power cost.)", and this one because
 * Heedless Resurrection prints "ignoring its cost" flat. Folding them together
 * would make the difference between the two sentences a boolean.
 *
 * `cardsPlayedThisTurn` is bumped for the reason its twin gives: this IS a card
 * being played, which is what `[Legion]` counts.
 */
function playTrashUnitIgnoringCost(state: GameState, playerIndex: 0 | 1, optionId: string): GameState {
  const card = state.players[playerIndex].trash.find((c) => c.instanceId === optionId);
  if (!card || card.kind !== "Unit") return state;
  const players = [...state.players] as [PlayerState, PlayerState];
  players[playerIndex] = {
    ...players[playerIndex],
    trash: players[playerIndex].trash.filter((c) => c.instanceId !== optionId),
    cardsPlayedThisTurn: players[playerIndex].cardsPlayedThisTurn + 1,
  };
  return playUnitFree({ ...state, players }, playerIndex, card);
}

/**
 * A gear by instance id, wherever it currently is.
 *
 * `activeGear` AND `banished`, matching `recordBanishedWithGear`'s own walk: a
 * Sarcophagus can be banished (Time Warp, Pickpocket) while its pit still holds
 * units, and the list travels with the instance rather than being keyed off a
 * board position.
 */
function gearAnywhere(state: GameState, playerIndex: 0 | 1, gearInstanceId: string | undefined) {
  if (gearInstanceId === undefined) return undefined;
  const owner = state.players[playerIndex];
  const found =
    owner.activeGear.find((g) => g.instanceId === gearInstanceId) ??
    owner.banished.find((c) => c.instanceId === gearInstanceId);
  return found !== undefined && found.kind === "Gear" ? found : undefined;
}

/**
 * The units banished with one Cursed Sarcophagus that its controller can pay for
 * right now.
 *
 * Priced when the options are built, so a unit nobody can afford is never offered
 * rather than offered and then refused — **419.2.a** ("as long as a player has the
 * resources to pay the costs associated with the card ... they may Play cards"),
 * and the rule this file applies throughout.
 *
 * A recorded id that names nothing in the banished zone is SKIPPED rather than
 * treated as an error: the list is never pruned when a unit is played out of it
 * (nothing in the text says the pit empties), so a played unit's id stays on the
 * gear forever and simply stops resolving. The Zero Drive's resolver skips for the
 * same reason.
 */
function sarcophagusOptions(state: GameState, playerIndex: 0 | 1, gearInstanceId: string | undefined): DecisionOption[] {
  const gear = gearAnywhere(state, playerIndex, gearInstanceId);
  if (gear === undefined) return [];
  const options: DecisionOption[] = [];
  for (const unitId of unitsBanishedWith(gear)) {
    const card = state.players[playerIndex].banished.find((c) => c.instanceId === unitId);
    if (card === undefined || card.kind !== "Unit") continue;
    if (sarcophagusPayment(state, playerIndex, card) === undefined) continue;
    options.push({ id: card.instanceId, label: sarcophagusLabel(state, playerIndex, card), instanceId: card.instanceId });
  }
  return options;
}

/**
 * Pays a banished unit's FULL printed cost, or `undefined` when it cannot be paid.
 *
 * A local twin of `signature-shared.voidRushPayment` rather than a call to it:
 * that one bakes in Void Rush's own 2-Energy discount, and a shared version would
 * need the discount as a parameter for the benefit of two callers in two files.
 * The reasoning is entirely borrowed, including the order.
 *
 * **POWER FIRST, then Energy.** `payPowerFromChanneled` recycles the rune and
 * banks 1 floating Energy for one that was still Ready, which is the same "a Ready
 * rune spent on Power still counts toward the Energy cost" arithmetic
 * `computeAutoPayment` does. Paying Energy first would exhaust that rune and lose
 * the credit, refusing plays the ordinary cost pipeline allows.
 *
 * `playedFromHand: false`, which is not cosmetic — it is what lets Void Drone's
 * and Drag Under's own "costs [2] less when played from anywhere but your hand"
 * apply to a Sarcophagus play.
 */
function sarcophagusPayment(state: GameState, playerIndex: 0 | 1, card: UnitInstance): GameState | undefined {
  let paid: GameState | undefined = state;
  if (card.powerCost > 0) {
    paid =
      payPowerFromChanneled(state, playerIndex, card.powerDomain, card.powerCost) ??
      (card.powerDomainAlt !== undefined
        ? payPowerFromChanneled(state, playerIndex, card.powerDomainAlt, card.powerCost)
        : undefined);
  }
  if (!paid) return undefined;
  return payEnergyFromPool(paid, playerIndex, sarcophagusEnergy(state, playerIndex, card));
}

/** What a banished unit costs in Energy after every cross-cutting modifier — read
 *  off the state the question was asked in, so the label and the payment quote one
 *  number. */
function sarcophagusEnergy(state: GameState, playerIndex: 0 | 1, card: UnitInstance): number {
  return modifiedEnergyCost(state, playerIndex, "Unit", card.energyCost, card.defId, false);
}

/** What one option says it costs, so the price a player is agreeing to is visible
 *  rather than implied — `voidRushLabel`'s job, and `playLabel`'s. */
function sarcophagusLabel(state: GameState, playerIndex: 0 | 1, card: UnitInstance): string {
  const energy = sarcophagusEnergy(state, playerIndex, card);
  const power = card.powerCost > 0 ? `, ${card.powerCost} ${card.powerDomain ?? "any"} Power` : "";
  return `Play ${card.name} (pay ${energy} Energy${power})`;
}

/**
 * Takes a named unit out of the banished zone, pays for it, and plays it.
 *
 * The cost is re-paid here rather than trusted from the option list, for the
 * reason `playUnitFromTrash` records: the options were built from an earlier
 * state, and anything that drained the pool in between must make this fizzle
 * rather than hand over a free unit.
 *
 * Through `playUnitFree`, so the destination is a real choice (359.2.c — a unit
 * "enters the Board exhausted at the Location that was CHOSEN", and 419.3.b keeps
 * every step of Play normal for a play made during a resolution). Base-only boards
 * are not asked, since one destination is not a choice.
 */
function playBanishedUnit(state: GameState, playerIndex: 0 | 1, optionId: string): GameState {
  const card = state.players[playerIndex].banished.find((c) => c.instanceId === optionId);
  if (!card || card.kind !== "Unit") return state;
  const paid = sarcophagusPayment(state, playerIndex, card);
  if (!paid) return state;

  const players = [...paid.players] as [PlayerState, PlayerState];
  players[playerIndex] = {
    ...players[playerIndex],
    banished: players[playerIndex].banished.filter((c) => c.instanceId !== optionId),
    cardsPlayedThisTurn: players[playerIndex].cardsPlayedThisTurn + 1,
  };
  return playUnitFree({ ...paid, players }, playerIndex, card);
}

/** Every unit in play, both players, base and battlefields — Whirlwind's "a
 *  unit" with no owner and no location named. Player order, then each player's
 *  own base-before-battlefields walk, so the option list is stable and the tests
 *  about WHICH unit was chosen mean something. */
function allUnitsInPlay(state: GameState): UnitInstance[] {
  return ([0, 1] as const).flatMap((playerIndex) => ownUnitsEverywhere(state, playerIndex));
}

/**
 * Pays a trashed unit's Power cost, or `undefined` when it cannot be paid — the
 * same contract `payPowerFromChanneled` and `spendBuff` use, so an unpayable cost
 * withholds the payoff instead of handing it over free.
 *
 * A zero Power cost is payable and costs nothing; it is short-circuited rather
 * than passed through as `count: 0` because `powerDomain` is null exactly when
 * the cost is 0, and null means RAINBOW to that helper — asking it to take zero
 * rainbow runes works, but only by accident of the arithmetic.
 */
function payUnitPowerCost(state: GameState, playerIndex: 0 | 1, card: UnitInstance): GameState | undefined {
  if (card.powerCost <= 0) return state;
  return payPowerFromChanneled(state, playerIndex, card.powerDomain, card.powerCost);
}

function playLabel(card: UnitInstance): string {
  return card.powerCost <= 0
    ? `Play ${card.name} (free)`
    : `Play ${card.name} (pay ${card.powerCost} ${card.powerDomain ?? "any"} Power)`;
}

/** Stealthy Pursuer's three conditions, asked once so `applies` and `resolve`
 *  cannot disagree — a held trigger that re-derives them separately is how a
 *  response window turns into a trigger firing on a board that no longer
 *  qualifies. */
function pursuerFollows(state: GameState, listener: Listener, event: GameEvent): boolean {
  if (event.kind !== "unitMoved") return false;
  if (event.moverIndex !== listener.ownerIndex) return false; // "a FRIENDLY unit"
  if (event.unitInstanceId === listener.card.instanceId) return false; // not his own move
  // "FROM MY LOCATION" — where he is standing NOW, which is where he was when
  // the mover left, since nothing resolves in between.
  return listener.battlefieldId === event.from && event.to !== event.from;
}

/** Megatusk's price — "Spend 3 XP:". */
const MEGATUSK_XP = 3;

/**
 * "Your units HERE" — every unit `playerIndex` controls at the LOCATION the
 * source is standing at, the source included.
 *
 * A Location, not a battlefield: **198.1** makes the Bases Locations alongside the
 * Battlefields, and Megatusk prints no "while I'm at a battlefield" restriction
 * (contrast Caitlyn - Patrolling, who does). So a Megatusk sitting at home grants
 * to his base, which is legal and useless — `[Ganking]` only ever widens a
 * battlefield-to-battlefield move. Reading it that way rather than silently
 * requiring a battlefield keeps the ability's availability the card's, not this
 * file's.
 *
 * Empty when the source is not on the board at all, which `resolveActivation`
 * makes unreachable through the real path and a direct caller could still reach.
 */
function ownUnitsAtLocationOf(state: GameState, playerIndex: 0 | 1, sourceInstanceId: string): UnitInstance[] {
  const at = findUnitAnywhere(state, sourceInstanceId);
  if (!at) return [];
  if (at.zone === "base") return [...state.players[playerIndex].baseUnits];
  return unitsAt(state, playerIndex, state.battlefields[at.zone.battlefieldIndex]!.id);
}

/**
 * Activated abilities contributed by this domain file.
 *
 * **Empty on purpose, and it is the seam that matters, not the contents.**
 * `ACTIVATED_ABILITIES` was module-private in `activated-abilities.ts`, so a
 * domain file could not register an activated ability AT ALL — the wave-1 agents
 * refused UNL-026 and UNL-093 on exactly that, and every future card with a
 * printed "[cost]: do something" would have hit the same wall or been written
 * into the shared file that the fan-out rule keeps agents out of.
 *
 * Merged lazily by `activated-abilities.ts`, through the same `mergeRegistries`
 * that throws on a duplicate defId — so a card registered both here and in the
 * built-in table is a named error at import, not a silent last-write-wins.
 */
export const activatedAbilities: Record<string, ActivatedAbilityDefinition> = {
  "VEN-112": {
    // Zed, Without a Sound — "[Action][>] [1 Energy][Chaos]: Move me and a Shadow
    // Clone you control to each other's locations." His conquer clause is an
    // `eventTriggers` entry.
    //
    // `swapUnitLocations` is the shared helper Azir - Emperor's swap already uses,
    // so "whose location is which" is decided in one place — and it handles the
    // base-and-battlefield mix, which matters here because his own Clones are
    // played TO HIS BASE and the swap is how they reach a fight.
    //
    // **The target is a Shadow Clone YOU control**, matched on the token's runtime
    // defId rather than by tag: `SHADOW_CLONE_TOKEN_DEF_ID` is what `createToken`
    // stamps, and it is exported from the leaf constants module precisely so a
    // reader here and the ability table cannot drift.
    //
    // **`narrowing` is what makes that a TARGETING restriction rather than a
    // resolver check, as of 2026-08-22.** It used to be only the latter, so the
    // ability offered every friendly unit and an ordinary one spent the cost and
    // swapped nothing — recorded in docs/rules-conformance.md as wider than
    // printed. 355.9.b ("it meets all targeting restrictions") and 355.8's
    // declaration at finalization together say an ineligible unit must never be
    // OFFERED, which is the same reasoning Tideturner's own note gives.
    //
    // The recorded blocker was "closing it means a token-identity axis on
    // `TargetingSpec`". `NAMED_UNIT_NARROWINGS` is the escape hatch that already
    // existed for a condition too card-specific to be an axis.
    //
    // **`[Action]` needs nothing** — `validate-activate-ability` applies no
    // turnState, chain or priority check to ANY activation, a standing
    // permissiveness that file's own doc records. Stated because the keyword being
    // free is a fact about the engine rather than about this card.
    kind: "Unit",
    cost: { energy: 1, power: { domain: "Chaos", count: 1 } },
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere", narrowing: "VEN-112-clone" },
    resolve: (state, ctx, event, sourceInstanceId) => {
      const targetId = event.targetUnitInstanceId;
      if (targetId === undefined) return state;
      // Kept as defence in depth now that the offer and the validator both apply
      // the narrowing. It is no longer where the card's restriction LIVES — that
      // is `VEN-112-clone` — and a mutation run will report it redundant, which
      // is the honest description: it costs nothing and it is the last thing
      // standing between a swap and a hand-built action if either shared walk
      // ever stops asking.
      const target = findUnitAnywhere(state, targetId);
      if (!target || target.unit.defId !== SHADOW_CLONE_TOKEN_DEF_ID) return state;
      return swapUnitLocations(state, ctx.casterIndex, sourceInstanceId, targetId);
    },
  },
  "UNL-126": {
    // Megatusk — "[Ganking] Spend 3 XP: Give your units here [Ganking] this turn."
    //
    // The pool's first ability whose whole price is XP, and the first entry in
    // this registry at all.
    //
    // # The cost is NOT expressed as an `ActivationCost`, and that is deliberate
    //
    // `ActivationCost` has no XP field — coverage.ts already records that as the
    // reason UNL-158 Shepherd's Heirloom reports unimplemented ("its `[Equip] —
    // Spend 1 XP` cost is the one `ActivationCost` cannot price"). Adding one is a
    // change to the shared activated-abilities.ts, which the fan-out rule keeps
    // this file out of. So the price is split the only way that cannot be
    // offered-and-then-refused:
    //
    //   `availableWhile` asks whether 3 XP is there. It is consulted by
    //   `canPayActivationCost`, which BOTH the enumerator and the validator go
    //   through — so a Megatusk with 2 XP is never offered the ability at all,
    //   rather than offered it and refused.
    //
    //   `resolve` then SPENDS it, through `spendXp`, which returns undefined
    //   rather than underpaying. The `undefined` branch is unreachable via the
    //   real path (nothing resolves between the validator's check and this) and is
    //   still written, because the alternative is granting the keyword free.
    //
    // **204.1.b** makes "the resource or instruction written before the ':'" the
    // ability's BASE cost, which is paid at finalization rather than at
    // resolution. This engine resolves an activated ability INLINE — there is no
    // chain item for one, which counter-spell.ts already records as its own
    // divergence — so finalization and resolution are the same instant and the
    // split above is unobservable. It becomes observable the day abilities go on
    // the chain, and at that point this wants a real `ActivationCost.xp`.
    //
    // # `cost: {}`, not the default
    //
    // The default is `{ exhaust: true }` and Megatusk prints NO exhaust symbol —
    // his cost is the XP and nothing else. So the ability repeats while the XP
    // lasts, which is the same shape Vi - Destructive's Recycle has and is bounded
    // by the price: three activations cost 9 XP. Taking the default would have
    // made him a once-per-turn grant nobody printed.
    //
    // # "Your units HERE"
    //
    // Every unit he controls at his own Location, himself included ("your units"
    // names no exception) — see `ownUnitsAtLocationOf` for why base counts.
    //
    // `grantKeywordThisTurn` lands it in `keywordsThisTurn`, which `runEnd`
    // sweeps, and `hasKeyword` is what `legal-actions` and `validate-move-unit`
    // both ask before offering a battlefield-to-battlefield move — so the grant is
    // live in the same turn it is bought. **810.2** makes a second `[Ganking]`
    // redundant rather than cumulative, which `mergeGrantedKeyword` already
    // enforces, so re-activating on a unit that has it wastes the XP honestly.
    //
    // NOT `banksResource`: this changes the board's legal moves, which is
    // something an evaluator can price, unlike Lux - Crownguard's stored Energy.
    kind: "Unit",
    cost: {},
    targeting: { kind: "none" },
    availableWhile: (state, playerIndex) => canSpendXp(state, playerIndex, MEGATUSK_XP),
    resolve: (state, ctx, _event, sourceInstanceId) => {
      const paid = spendXp(state, ctx.casterIndex, MEGATUSK_XP);
      if (paid === undefined) return state;
      return ownUnitsAtLocationOf(paid, ctx.casterIndex, sourceInstanceId).reduce(
        (next, unit) => grantKeywordThisTurn(next, unit.instanceId, "Ganking"),
        paid,
      );
    },
  },
  "UNL-136": {
    // Scryer's Bloom — "This enters exhausted. Kill this, [1], [Exhaust]:
    // [Predict 2], then draw 1. Gain 1 XP."
    //
    // # THREE costs, all printed, and the shape already exists
    //
    // `{ killSelf, energy, exhaust }` is Emergency Snax's cost with the rune
    // dropped, and `exhaust` on top of `killSelf` is kept for the reason that
    // card's entry and the Gold token's both give: it is what the card prints,
    // and it is what stops a Bloom that has been readied being used twice in one
    // chain. `killSelf` routes through `killGear`, so being spent as a cost is
    // still being killed.
    //
    // # "This enters exhausted" is NOT implemented, and it makes the card
    //   STRONGER than printed
    //
    // The mechanism exists and is a one-line table: `GEAR_ENTERING_EXHAUSTED` in
    // `engine/deploy.ts`, which today holds only Iron Ballista (OGN-017) and is
    // read by `execute-play-card` as a Gear enters `activeGear`. This file may not
    // edit deploy.ts, so the Bloom enters READY and can be cracked the turn it
    // lands — one Energy for the gear plus one for the ability, all in one turn,
    // where printed it costs a turn of patience.
    //
    // That is the WRONG direction to err, so it is pinned rather than left to be
    // discovered: `unl-chaos-wave3.test.ts` asserts the wrong answer ("enters
    // ready") on purpose, and adding the row must FLIP that test rather than
    // silently change behaviour. Needs a `coverage.PARTIALLY_IMPLEMENTED` entry
    // until then.
    //
    // # `[Predict 2]` — 436.1.a, and it is a subset choice, not two Predicts
    //
    // **436.1.a**: "When more than one card is Predicted, the Predicting player
    // looks at that many cards and Recycles any number of them before putting the
    // rest back on top of their Main Deck IN ANY ORDER." So it is one question
    // with two axes (which to recycle, and how to order what is left), not the
    // bare `[Predict]` this file already has twice over — see `predictTwo` below
    // for the enumeration and for the one place 416.5 is diverged from.
    //
    // # Ordering of the three payouts
    //
    // "[Predict 2], THEN draw 1" is ordered and the Predict stops to ask, so the
    // draw is queued BEHIND the question as a one-option `draw` decision — the
    // same machinery, and the same reason, as `discardThenDraw`'s. Drawing inline
    // would hand the player the card they are still deciding whether to recycle.
    //
    // "Gain 1 XP" is a third sentence with no ordering word, applied INLINE — so
    // in practice the XP lands before the queued questions are answered. Nothing
    // in the pool can observe the interleaving (no card reads XP during a decision
    // it did not itself raise), and there is no generic "gain XP" decision to
    // queue it behind; named here rather than left as an accident.
    kind: "Gear",
    cost: { killSelf: true, energy: 1, exhaust: true },
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const predicted = predictTwo(state, ctx.casterIndex);
      const drawn = parkDecision(predicted, { kind: "draw", playerIndex: ctx.casterIndex, count: 1 });
      return gainXp(drawn, ctx.casterIndex, SCRYERS_BLOOM_XP);
    },
  },
  "UNL-144": {
    // Maduli the Gatekeeper — "I can't be readied. [Chaos]: Move me to an
    // occupied enemy battlefield if my Might is greater than the total Might of
    // enemy units there."
    //
    // # HALF WRITTEN, and the missing half is the DRAWBACK — the worse direction
    //
    // "I can't be readied" is a continuous restriction on a game action, and it
    // has TWO readers, neither of which this file may edit:
    //
    //   `turn-manager.runAwaken` readies the active player's whole board with an
    //   inline `map`, not through any helper — so a per-unit exemption has to be
    //   read there. **315.1.b.1** is explicit that this is where it belongs: "The
    //   Turn Player readies all Game Objects they control **that are able to be
    //   readied**." That file's own comment already names the gap ("minus
    //   UnitAbilities.cannotBeReadied (no card grants that yet)"); Maduli is the
    //   card that grants it.
    //
    //   `effect-helpers.readyUnit` is the other door, the one every spell and
    //   ability comes through. Its existing lock (`mayReadyPermanent`) is
    //   PER-PLAYER — Mageseeker Warden's "spells and abilities can't ready enemy
    //   units and gear" — so it cannot express a restriction that belongs to one
    //   unit, and widening it is a change to a shared file.
    //
    // So he readies every Awaken, which makes him STRONGER than printed: a 7-cost
    // 6-Might body whose whole price is that he stays exhausted once he has moved
    // or fought. That is the direction this file works hardest not to err in, so
    // it is PINNED — `unl-chaos-wave4.test.ts` asserts the wrong answer ("he
    // readies in Awaken") on purpose, and implementing the restriction must FLIP
    // that test rather than silently change behaviour nobody was watching. Needs a
    // `coverage.PARTIALLY_IMPLEMENTED` entry until then; this file may not add
    // one, and he has no unimplemented keyword to grey him, so without that entry
    // he reports finished.
    //
    // **BOTH doors are pinned as of 2026-08-13, and only one of them was.** The
    // wave-4 pin drives `runAwaken` directly; nothing exercised `readyUnit`, so
    // the second half of this refusal was a reading rather than a measurement.
    // `unl-chaos-wave8-refusals.test.ts` now plays Upstage Comedy (UNL-009,
    // "Ready a unit", `scope: "anywhere"`) at him through `submit` and asserts
    // the wrong answer there too, beside a control that readies an ordinary body
    // with the same spell. Closing this clause has to flip TWO tests, which is
    // the point — a fix that only taught `runAwaken` about him would have left a
    // 2-Energy spell undoing the whole drawback and passed the wave-4 pin.
    //
    // # The ability, which is whole
    //
    // `cost: { power: { domain: "Chaos", count: 1 } }` and NO exhaust — the card
    // prints one Chaos pip and no `:rb_exhaust:`, and the default is
    // `{ exhaust: true }`, so taking it would have invented a limit. Repeatable
    // while the runes last, which is the same shape Vi - Destructive's Recycle
    // has and is bounded by the price rather than by a tap.
    //
    // # "an OCCUPIED ENEMY battlefield"
    //
    // Read as "the opponent has units standing there", which is the reading
    // `unit-triggers.isOccupiedByEnemy` already gives the IDENTICAL phrase on
    // Deadbloom Predator (OGN-161) and Dauntless Vanguard (SFD-093). **170.11.a**
    // defines "occupied" as "they have a Unit present" and says nothing about
    // whose; taking it as "a battlefield the enemy CONTROLS, occupied by anyone"
    // would let him walk onto an enemy-controlled battlefield holding only his own
    // allies, where "the total Might of enemy units there" is zero and the
    // condition is vacuous. The clause that follows is what settles it: it only
    // means anything if enemies are the ones standing there.
    //
    // Duplicated here rather than imported because that predicate is module-
    // private to unit-triggers.ts and this file may not export it from there. The
    // two answer for different call sites (a PLAY destination and a MOVE
    // destination) and are three lines each; the drift risk is named rather than
    // pretended away.
    //
    // # The Might comparison
    //
    // STRICTLY greater ("greater than"), read through `effectiveMight` on both
    // sides so buffs, this-turn pumps, Equipment badges and positional auras all
    // count — **143.2**'s statistic as 432.1's worked example reads it. **"2236"
    // was the citation three neighbouring entries in this file carried, and it is
    // a LINE NUMBER**: `-raw` resolves no such rule, and 143.2/432.1 are what the
    // sentences actually needed. `isCombat: false` on both, matching every
    // other non-damage Might reference in this file: `[Assault]` and `[Shield]`
    // are damage-side adjustments and are not the Might a card compares.
    //
    // **His own Might is read WHERE HE STANDS, not where he is going.** Auras are
    // positional, so the two can differ. **359.3.f.2** puts the check "on
    // execution of the instruction" and the instruction executes before he has
    // moved, so the board he is measured on is the one he is leaving.
    //
    // # The destination is a DECISION, not a targeting spec
    //
    // `TargetingSpec` has a `battlefield` kind, and it is unusable here: measured
    // in `legal-actions.activateAbilityCandidates`, an ability whose targeting is
    // not `unit`/`unitOrGear` is pushed as a SINGLE variant with nothing chosen —
    // only the PlayCard path fans battlefields out. So a `{ kind: "battlefield" }`
    // ability would be offered, paid for, and arrive at `resolve` with no
    // destination. A parked decision is the mechanism this engine already has for
    // a choice with no action field (free-play placement's is the same shape), and
    // it also lets the OPTIONS carry the two conditions — so an illegal
    // battlefield is never on the menu rather than refused after the rune is gone.
    //
    // No "Decline" option: the "if" is a CONDITION, not a "you may". Once the rune
    // is paid the move happens, and `advanceDecisions` retires a one-destination
    // question without prompting.
    //
    // `availableWhile` asks the same question the options do, through the same
    // function — so a Maduli with nowhere legal to go is never offered the ability
    // at all rather than offered it and refunded nothing (416.3).
    kind: "Unit",
    cost: { power: { domain: "Chaos", count: 1 } },
    targeting: { kind: "none" },
    availableWhile: (state, playerIndex, sourceInstanceId) =>
      maduliDestinations(state, playerIndex, sourceInstanceId).length > 0,
    resolve: (state, ctx, _event, sourceInstanceId) =>
      parkDecision(state, { kind: MADULI_MOVE, playerIndex: ctx.casterIndex, cardInstanceId: sourceInstanceId }),
  },
  "UNL-148": {
    // Cursed Sarcophagus, SECOND clause — "[Exhaust]: Play a unit banished with
    // this. (You must pay its costs.)" Its on-play banish is the `selfTriggers`
    // entry above.
    //
    // # "You must pay its costs" — paid HERE, at resolution
    //
    // 419.1.a makes hand and Chosen Champion the only zones a player may play
    // from by default, so a play out of the banished zone needs a permission
    // somewhere. This engine has exactly one such permission (`mayPlayFromTrash`,
    // Last Rites' counter) and it is wired through timing.ts, legal-actions.ts and
    // validate-play-card.ts — three shared files. So the play is performed inside
    // the resolution instead, which is what the pool's other pay-at-resolution
    // cards already do: Soulgorger and The Harrowing pay Power in
    // `playUnitFromTrash` below, and Void Rush (effects/signature-shared.ts) pays
    // BOTH halves in `voidRushPayment`, whose shape `sarcophagusPayment` mirrors.
    //
    // Named limitations, all inherited from `payPowerFromChanneled` and all
    // UNDER-offering — the unit is withheld, never handed over unpaid:
    //  - a split Power pip is tried as all-primary then all-alt, never mixed;
    //  - a rune-DECK payment is chosen by the engine, not by the player.
    // Energy goes through `modifiedEnergyCost` with `playedFromHand: false`, so
    // every cross-cutting discount (and Void Drone's from-elsewhere one) applies
    // to a Sarcophagus play exactly as it would to a play from hand.
    //
    // # No `availableWhile`, and that is the printed card
    //
    // **419.3.c**: "If there are no eligible cards to Play when instructed to Play
    // in this manner, then nothing happens." So a Sarcophagus over an empty pit
    // may still be exhausted for nothing, and The Zero Drive — the only other
    // play-what-I-banished card in the pool — takes the same reading with a
    // costlier price. Gating availability on a non-empty pit would be this engine
    // inventing a restriction the card does not print.
    //
    // # Mandatory, so no decline
    //
    // "Play a unit banished with this" carries no "you may". The options list is
    // therefore the affordable units alone: with none the question is dropped
    // (419.3.c again, and 359.3.e.11's "instructions that can be partially
    // followed are followed as much as possible") and with exactly one it is
    // executed without asking, the same two branches The Harrowing's entry pins.
    //
    // # The pit is not emptied by cracking it
    //
    // "Play A unit", singular, and nothing says the rest go anywhere — so a
    // Sarcophagus readied on a later turn plays another. That is what makes the
    // banish worth 4 Energy and 1 Power, and it is why `banishedInstanceIds` is
    // read rather than consumed: only the unit actually played leaves the zone.
    kind: "Gear",
    targeting: { kind: "none" },
    resolve: (state, ctx, _event, sourceInstanceId) =>
      parkDecision(state, { kind: "UNL-148-play", playerIndex: ctx.casterIndex, cardInstanceId: sourceInstanceId }),
  },
  "UNL-138": {
    // The List — "As you play this, name a tag. [Exhaust]: Give a unit with the
    // named tag -2 [Might] this turn."
    //
    // **Refused in waves 7 and 8, and wave 8's refusal was right about all three
    // of its measurements.** The ability half needed nothing new, exactly as it
    // said — this is Maduli's shape, a target-less ability parking a decision
    // whose options are the units that qualify. What had no home was the NAME:
    //
    //   1. "A GearInstance has no field to write it to" — TRUE, and it is
    //      `GearInstance.namedTag` now. A tag is a string chosen from 111, so it
    //      is data rather than a flag, and it lives on the instance that was told
    //      it: two Lists name two tags.
    //   2. "A Gear has no on-play resolution step at all... playing The List
    //      through `submit` leaves `spellChain` empty" — TRUE, and it is why the
    //      naming hangs off `execute-play-card`'s gear-placement site, the one
    //      place a Gear enters `activeGear`, beside `[Quick-Draw]`.
    //   3. "A mode per tag is not a route... 111 distinct tags" — TRUE, and it
    //      rules out the fan-out on the ACTION as well, for the same arithmetic.
    //      The name is a parked DECISION, which costs one action to answer.
    //
    // The one thing the refusal treated as fatal and is instead a recorded
    // divergence: 355 puts "as you play this" at ANNOUNCE and this asks
    // immediately after. A Gear does not use the chain, so nothing can respond in
    // between — see `named-tag.ts`.
    //
    // "A unit with the named tag" names no side and no location, so 355.9.a.1
    // widens it to every unit on the Board, both players. -2 Might THIS TURN is
    // `mightThisTurn`, which `runEnd` clears; 143.2.b then floors what reads it at
    // 0, so this does not kill a 1-Might unit and must not be written as if it
    // could.
    kind: "Gear",
    cost: { exhaust: true },
    targeting: { kind: "none" },
    // Not offered while the gear has no tag, and not offered when no unit carries
    // it — 416.3's shape, and the reason it is asked here rather than inside
    // `resolve`: an ability that exhausted to do nothing would have spent the
    // whole card for the turn.
    availableWhile: (state, playerIndex, sourceInstanceId) => {
      const tag = namedTagOf(state, playerIndex, sourceInstanceId);
      return tag !== undefined && unitsWithTag(state, tag).length > 0;
    },
    resolve: (state, ctx, _event, sourceInstanceId) =>
      parkDecision(state, { kind: "UNL-138-weaken", playerIndex: ctx.casterIndex, cardInstanceId: sourceInstanceId }),
  },
};

/**
 * The battlefields Maduli may move himself to — "an occupied enemy battlefield
 * ... if my Might is greater than the total Might of enemy units there".
 *
 * ONE function, asked by `availableWhile` and by the decision's `options`, for
 * the reason `mayPlaceWithoutPresence` records about its own two callers: an
 * enumerator and a resolver that each carried their own copy of this predicate
 * is exactly the drift that gets an ability offered and then refused.
 *
 * His CURRENT battlefield is excluded — 355.4.a's "a valid Location for a Move
 * Effect is one other than the Unit's current Location". It could not qualify
 * anyway (he is standing on it, so it is contested and he is measured against
 * the enemies he is already fighting), but offering a move that cannot happen
 * for one Chaos rune is the shape this file keeps out.
 */
function maduliDestinations(state: GameState, playerIndex: 0 | 1, sourceInstanceId: string) {
  const at = findUnitAnywhere(state, sourceInstanceId);
  if (!at) return [];
  const mine = effectiveMight(
    state,
    at.unit,
    at.ownerIndex,
    at.zone === "base"
      ? { isCombat: false }
      : { isCombat: false, battlefieldId: state.battlefields[at.zone.battlefieldIndex]!.id },
  );
  const here = at.zone === "base" ? undefined : state.battlefields[at.zone.battlefieldIndex]!.id;
  const enemyIndex = (playerIndex === 0 ? 1 : 0) as 0 | 1;
  return state.battlefields.filter((bf) => {
    if (bf.id === here) return false;
    const enemies = enemyUnitsAt(state, playerIndex, bf.id);
    if (enemies.length === 0) return false; // "OCCUPIED enemy battlefield" — 170.11.a
    const total = enemies.reduce(
      (sum, u) => sum + effectiveMight(state, u, enemyIndex, { isCombat: false, battlefieldId: bf.id }),
      0,
    );
    return mine > total;
  });
}

/** Scryer's Bloom's third sentence — "Gain 1 XP." */
const SCRYERS_BLOOM_XP = 1;

/** How many cards `[Predict 2]` looks at. */
const PREDICT_TWO = 2;

/**
 * `[Predict 2]` — "look at the top two cards of your Main Deck. Recycle any of
 * them and put the rest back in any order" (**436.1.a**).
 *
 * A separate function from `predict` above rather than a parameterised version of
 * it, because the two are different SHAPES of question and not one question with a
 * number. Bare `[Predict]` is a yes/no about one card; this is a subset choice
 * plus an ordering, which is exactly why `model/keyword.ts` recorded the valued
 * form as unbuilt while the bare one was done.
 *
 * Nocturne - Horrifying's "as you LOOK AT me" is offered FIRST — 436.1 makes
 * Predicting "the act of LOOKING at a single card from the top of the Main Deck",
 * so these two cards have genuinely been looked at. The queue is FIFO, so his
 * offer is answered before this one, which is the order the two sentences read in.
 *
 * An empty deck asks nothing at all (**436.4**: "they will Predict as many as
 * possible instead", and 436.4.a exempts it from Burn Out); a one-card deck asks a
 * real two-option question, which is what "as many as possible" means here.
 */
function predictTwo(state: GameState, playerIndex: 0 | 1): GameState {
  const looked = state.players[playerIndex].deck.slice(0, PREDICT_TWO);
  if (looked.length === 0) return state;
  return parkDecision(offerTopOfDeckBanish(state, playerIndex, looked), { kind: "UNL-136-predict", playerIndex });
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
export const mightModifiers: Record<string, MightModifier> = {
  "VEN-109": {
    // Illaoi, Prophet of the Great Kraken — "I have +1 [Might] for each TOKEN unit
    // you control." The third clause; her two token-making moments are a
    // `unitTriggers` and an `eventTriggers` entry.
    //
    // **"Token unit", not "Tentacle"** — every token counts, including a Recruit,
    // a Sand Soldier or a Shadow Clone. `isToken` is the instance flag 185 makes
    // the distinction on, and reading the TAG instead would be a narrower and
    // different card.
    //
    // UNPOSITIONED: no "here" is printed, so tokens in base and at every
    // battlefield all count. Continuous, so a token dying takes the Might with it.
    //
    // She is never a token herself, so no self-exclusion is needed — but the
    // filter is by `isToken` rather than by instance for exactly that reason, and
    // a future token copy of her would correctly count itself.
    defId: "VEN-109",
    bonus: (state, unit, ownerIndex) =>
      unit.defId !== "VEN-109" ? 0 : ownUnitsEverywhere(state, ownerIndex).filter((u) => u.isToken === true).length * ILLAOI_MIGHT_PER_TOKEN,
  },
  "VEN-097": {
    // Spiderling — "[Hidden] I have +1 [Might] for each OTHER unit you control
    // HERE with my name. Your deck can have any number of cards named Spiderling."
    //
    // A continuous, positional, self-referential aura: three Spiderlings at one
    // battlefield are each a 3, and one alone is a 1. `defId` rather than `name`
    // is the comparison — this pool has no second printing of him, and a defId
    // comparison is what every other "with my name" board count here uses.
    //
    // **"OTHER" is by instanceId**, so he never counts himself; **"HERE" is
    // positional**, so a Spiderling in base gets nothing however many siblings
    // stand at a battlefield.
    //
    // # The deck-building clause is NOT implemented, and it is not a gap here
    //
    // "Your deck can have any number of cards named Spiderling" is a
    // DECKBUILDING rule (103.1.b), enforced when a deck is assembled rather than
    // during a game. This engine's `deck-generator` and its preset decks are the
    // only deck sources and neither enforces a copy limit at all, so there is
    // nothing for the clause to relax. Recorded in docs/rules-conformance.md
    // rather than left implicit.
    defId: "VEN-097",
    bonus: (state, unit, ownerIndex, ctx) => {
      if (unit.defId !== "VEN-097" || ctx.battlefieldId === undefined) return 0;
      const ownerId = state.players[ownerIndex].id;
      const here = state.battlefields.find((bf) => bf.id === ctx.battlefieldId)?.units[ownerId] ?? [];
      const siblings = here.filter((u) => u.defId === "VEN-097" && u.instanceId !== unit.instanceId).length;
      return siblings * SPIDERLING_MIGHT_PER_SIBLING;
    },
  },
  [BARON_NASHOR]: {
    // Baron Nashor, THIRD sentence — "Other friendly units have +2 [Might]."
    //
    // # ONE of his three sentences, and the other two are refusals, not omissions
    //
    // His first ("As you play me, add the Baron Pit battlefield token to the board
    // if it's not there already. If you do, I enter there") adds a THIRD
    // BATTLEFIELD mid-game. **172** makes the number of battlefields on the board
    // a property of the Mode of Play, and this engine builds exactly two at setup
    // (`decks/battlefield-setup.battlefieldPair`, ids `bf-0`/`bf-1`, "stable for a
    // game's lifetime") with no writer anywhere that appends one. **187.9** gives
    // the token its own text — "Units can move here from anywhere" — which is a
    // move permission `validate-move-unit.ts` already names as one of the
    // named-card exceptions it does not implement, and **369.3** makes "I enter
    // there" a replacement effect on his entry location, which lives in
    // `deploy.ts`. Three shared files and a new scoring location; refused rather
    // than approximated.
    //
    // His second ("I can't be chosen by enemy spells and abilities") is one row in
    // `target-lookup.UNCHOOSEABLE_BY_ENEMIES` — the table Ruin Runner and Master
    // Yi - Unstoppable already sit in — and that file is shared too.
    //
    // Both unwritten halves make him WEAKER than printed (no free battlefield, no
    // protection), which is the direction to err. He has no unimplemented keyword
    // to grey him and this entry claims his defId, so he needs a
    // `coverage.PARTIALLY_IMPLEMENTED` row or he reports finished; this file may
    // not add one.
    //
    // # The aura itself
    //
    // NO "here", so it is board-wide and not positional — the contrast is Garen -
    // Commander and Darius - Executioner ("other friendly units have +1 Might
    // HERE"), whose shared loop in `effective-might.continuousAuraBonus` compares
    // locations. **141.1.a.1** is what makes a unit in base reachable by a bare
    // "units": "Units are at one of several Locations while on the Board: a
    // Battlefield or their Base." So a Baron standing in base buffs a unit at a
    // battlefield and vice versa, and `ctx.battlefieldId` is deliberately unread.
    //
    // "FRIENDLY" is measured from the BUFFED unit's controller (`ownerIndex`), and
    // that is the same seat Baron's controller sits in — control IS which player's
    // list a unit is in here, so an opponent who steals him starts buffing their
    // own board and stops buffing the one he left. Nothing extra is needed for
    // that; it falls out of searching `ownerIndex`'s own zones.
    //
    // "OTHER" excludes the Baron being evaluated — by INSTANCE, not by defId. He
    // is not a Champion (`isChampion: false`), so a deck may run three, and two
    // Barons in play each buff the other: the count below is of Barons that are
    // not this unit, so a lone Baron gets 0 and each of a pair gets +2 while every
    // other friendly unit gets +4. A `unit.defId !== BARON_NASHOR` guard — the
    // shape Garen's loop uses, where one copy at a time is the practical case —
    // would have silently zeroed the pair.
    //
    // `canonicalDefId`, not a bare comparison: Baron Nashor is printed twice
    // (UNL-147 and UNL-238 "(Ultimate)"), `mergeRegistries` aliases the second to
    // this entry, and `card-loader`'s own note says the sites a merge cannot reach
    // are exactly the ones comparing a defId to a literal. Without it an Ultimate
    // Baron on the board would contribute nothing and would itself be buffed by a
    // plain one, which is two wrong answers from one omission.
    //
    // No `ctx` filter. This is a flat continuous increase to the statistic
    // **143.2** calls current Might, so it applies in every context the engine
    // asks about — outgoing damage, remaining damage and the `[Mighty]` check
    // alike. Galio's entry in `effects/order.ts` is the contrast: that one is a
    // penalty that exists ONLY in the outgoing context, and says so.
    defId: BARON_NASHOR,
    bonus: (state, unit, ownerIndex) => BARON_NASHOR_AURA * otherBaronsControlledBy(state, ownerIndex, unit.instanceId),
  },
};

/** Baron Nashor's aura — "Other friendly units have +2 [Might]." */
const BARON_NASHOR_AURA = 2;

/**
 * How many Barons `ownerIndex` controls that are NOT `exceptInstanceId` — the
 * "OTHER" in "other friendly units", counted so a second copy stacks.
 *
 * Both zones, because his sentence names no location (141.1.a.1).
 *
 * **ONE predicate walked over two zones, not two copies of it**, and that is a
 * mutation-testing result rather than tidiness. Written as two independent loops,
 * the FIRST mutation of the `canonicalDefId` half survived the whole suite: every
 * test that could see the alias put its Ultimate Baron at a battlefield, so the
 * base loop's copy was never the one being read. Sharing the predicate makes a
 * single test kill both, which is the only reason this file can claim the check
 * is exercised.
 */
function otherBaronsControlledBy(state: GameState, ownerIndex: 0 | 1, exceptInstanceId: string): number {
  const ownerId = state.players[ownerIndex].id;
  let count = 0;
  const tally = (units: readonly UnitInstance[]): void => {
    for (const u of units) {
      if (u.instanceId !== exceptInstanceId && canonicalDefId(u.defId) === BARON_NASHOR) count++;
    }
  };
  tally(state.players[ownerIndex].baseUnits);
  for (const bf of state.battlefields) tally(bf.units[ownerId] ?? []);
  return count;
}
