import type { EffectDefinition } from "../card-effects.js";
import type { MightModifier } from "../effective-might.js";
import type { ActivatedAbilityDefinition } from "../activated-abilities.js";
import type { UnitPlayDestination, UnitTriggerDefinition } from "../unit-triggers.js";
import type {
  DeathknellDefinition,
  DeathWatchDefinition,
  EventTriggerDefinition,
  SelfTriggerDefinition,
} from "../triggers.js";
import { killGear } from "../triggers.js";
import { isAttackingAt, isDefendingAt, isFightingAt } from "../combat-designation.js";
import type { DecisionDefinition, DecisionOption } from "../decisions.js";
import type { CardInstance } from "../../model/card.js";
import { drawCards, isEmpowered, readyPermanent } from "../effect-helpers.js";
import { controlsAnyFacedownCard, isHiddenCard } from "../hidden.js";
import { hasKeyword } from "../granted-keywords.js";
import { defaultCardRegistry } from "../../cards/card-registry.js";
import {
  BIRD_TOKEN,
  MECH_TOKEN,
  placeGoldTokens,
  placeRecruitToken,
  placeToken,
  type TokenDestination,
  type TokenSpec,
} from "../token.js";
import {
  banishCard,
  channelRunesExhausted,
  empowerPermanent,
  gainPoints,
  dealDamage,
  dealDamageToAllUnitsAtAllBattlefields,
  destroyUnit,
  discardCards,
  exhaustAllFriendlyUnits,
  exhaustGear,
  forceMoveToBase,
  forceMoveToBattlefield,
  giveMightThisTurn,
  giveMightThisTurnToOwnUnit,
  giveMightThisTurnToAllEnemies,
  grantKeywordThisTurn,
  grantTemporary,
  holdCardsRecycled,
  ownUnitsEverywhere,
  payEnergyFromPool,
  payPowerFromChanneled,
  readyRunes,
  readyUnit,
  delayedDeathMark,
  forgetDelayedDeathMark,
  recordModeUsed,
  recycleUnitFromPlayToDeck,
  removeUnitAnywhere,
  returnCardFromTrash,
  returnUnitToHand,
  takeOneFromTopAndRecycleRest,
} from "../effect-helpers.js";
import { playUnitToBase, playUnitToBattlefield } from "../deploy.js";
import { playCardIgnoringCost } from "../play-free.js";
import { parkDecision, repeatDecision } from "../decisions.js";
import { eligibleTargets } from "../target-lookup.js";
import { isOpenBattlefield } from "../unit-triggers.js";
import { mayPlayUnitAt } from "../battlefield-continuous.js";
import {
  offerTopOfDeckBanish,
  revealedFromDeck,
  voidHatchlingAnswer,
  voidHatchlingGate,
  voidHatchlingOptions,
} from "../top-of-deck.js";
import { effectiveMight } from "../effective-might.js";
import { findUnitAnywhere, findUnitOnBattlefield, type AnyUnitLocation } from "../target-lookup.js";
import type { GameState, PlayerState } from "../../model/game-state.js";
import type { UnitInstance } from "../../model/card.js";
import { wearerListener } from "../equipment.js";
import { isMechUnit } from "../equipment.js";

/**
 * Card implementations for **Mind** — one file, one owner.
 *
 * This file exists so that work on the card pool can be split up without two
 * people (or two agents) ever editing the same file. The ownership rule is
 * mechanical, not a convention: a defId may only appear here if its
 * CardDefinition has exactly one domain and that domain is Mind. A test in
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
/** Sprite Call's token: 3 Might, enters ready, and dies at the start of its
 *  controller's next Beginning Phase (rule 816). */
const SPRITE_TOKEN: TokenSpec = { name: "Sprite", might: 3, tag: "Sprite", entersReady: true, keywords: { Temporary: 1 } };

/**
 * Lillia - Fae Fawn's Sprite — the same body as `SPRITE_TOKEN` above WITHOUT its
 * "ready", and the difference is one printed word rather than an oversight.
 *
 * Sprite Call, Sprite Mother, Sprite Burst and Sprite Fountain all print "play a
 * **ready** 3 [Might] Sprite unit token with [Temporary]"; Lillia prints "play a
 * 3 [Might] Sprite unit token with [Temporary] there" and no readiness clause at
 * all. 143.4.a's default therefore stands and hers arrives EXHAUSTED. Sharing the
 * one spec would have handed her a token that can block or move the turn it
 * lands, which is a strictly better card than the one printed — the same drift in
 * the opposite direction from the one token.ts's spec parameter was added to
 * prevent, so this is a second spec rather than a mutated copy of the first.
 */
const SPRITE_TOKEN_EXHAUSTED: TokenSpec = { name: "Sprite", might: 3, tag: "Sprite", keywords: { Temporary: 1 } };

/**
 * Keeper of Masks' two Reflections — "play two Reflection unit tokens here. They
 * become copies of me."
 *
 * `might: 0` is 187.6's printed token ("A 0 [M] Reflection token is a domainless
 * unit token with 0 Might") surviving the copy, because 477.1.b.1.a's list of
 * copyable traits does not include Might. See her entry in `unitTriggers` for the
 * full reading and for why the number is a constant rather than a literal.
 *
 * The keywords are the copied Rules Text; the name is the copied Name. The TAG
 * stays "Reflection" — she prints no tags of her own, so there is nothing for the
 * copy to replace, and the tag is what 187.6 calls the token.
 */
const KEEPER_REFLECTION_MIGHT = 0;
const KEEPER_REFLECTIONS = 2;
const KEEPER_REFLECTION_TOKEN: TokenSpec = {
  name: "Keeper of Masks",
  might: KEEPER_REFLECTION_MIGHT,
  tag: "Reflection",
  keywords: { Temporary: 1, Hidden: 1 },
};

/** Frigid Jewel fires on the SECOND draw of each turn, and pumps by 2. Named
 *  because both are printed numbers that would otherwise sit as bare literals
 *  inside a predicate and a resolver. */
const FRIGID_JEWEL_NTH = 2;
const FRIGID_JEWEL_MIGHT = 2;

const FRIGID_TOUCH_MIGHT = 2;
const BELLOWS_BREATH_DAMAGE = 1;
const ROCKET_BARRAGE_DAMAGE = 4;

/** Eclipse's and Moonlight Affliction's debuffs, as POSITIVE numbers — the sign
 *  is applied at the call site so the (absent) floor argument reads plainly, the
 *  convention `FROSTCOAT_DEBUFF` and `ICEVALE_DEBUFF` already follow below. */
const ECLIPSE_DEBUFF = 4;
const MOONLIGHT_AFFLICTION_DEBUFF = 10;

/** Sprite Burst's "play TWO ready 3 Might Sprite unit tokens" — two separate
 *  game objects, which is what the numeral means (714). */
const SPRITE_BURST_TOKENS = 2;

/** Crescent Strike's two amounts: 4 to the chosen enemy, 1 to each OTHER enemy
 *  at the same battlefield. */
const CRESCENT_STRIKE_FOCUS_DAMAGE = 4;
const CRESCENT_STRIKE_SPLASH_DAMAGE = 1;

/** Fate Weaver's "the top 4 cards", and the "Energy cost [4] or more" the spell
 *  she may pull from among them must meet — inclusive, as printed ("or more"). */
const FATE_WEAVER_LOOK = 4;
const FATE_WEAVER_MIN_SPELL_ENERGY = 4;

/**
 * Sprite Fountain's play effect — "play a ready 3 [Might] Sprite unit token with
 * [Temporary] to your base."
 *
 * Its own function because the card's `[Deathknell]` is literally "Repeat this
 * gear's play effect", so the two must be the SAME instruction rather than two
 * copies of one sentence that can drift — the reason `SPRITE_TOKEN` is shared
 * from the top of this file rather than re-declared, applied to the effect
 * instead of the spec.
 *
 * "TO YOUR BASE" is printed, so nothing is chosen and Sprite Burst's open
 * placement question (see its entry) does not arise here.
 */
function spriteFountainPlayEffect(state: GameState, ownerIndex: 0 | 1): GameState {
  return placeToken(state, ownerIndex, "base", SPRITE_TOKEN);
}

/** Deadly Flourish's damage. Its second sentence is unwritten — see the entry. */
/** Deadly Flourish's own defId, for the delayed-death mark it stamps on its
 *  victim — the key is scoped by CARD as well as by copy, so its mark and
 *  Siphoning Strike's on one victim pay each other nothing. */
const DEADLY_FLOURISH = "UNL-073";
const DEADLY_FLOURISH_DAMAGE = 3;

/**
 * Sprite Queen's token, and the reason it is a function rather than two call
 * sites: her one printed instruction has TWO moments ("when you play me OR at
 * the start of your Beginning Phase"), and those live in two different
 * registries here — `unitTriggers` and `eventTriggers`. `spriteFountainPlayEffect`
 * above is the same shape for the same reason, and both exist because one
 * sentence copied into two entries is one sentence that can drift.
 *
 * "TO YOUR BASE" is printed, so nothing is chosen. That also settles the
 * `[Temporary]` interaction rather than leaving it to luck: a Sprite in base can
 * never hold a battlefield, so the token is a body to move or spend rather than
 * a free point, whichever moment made it.
 */
function spriteQueenToken(state: GameState, ownerIndex: 0 | 1): GameState {
  return placeToken(state, ownerIndex, "base", SPRITE_TOKEN);
}

/** Gutter Palace's two exact counts — "EXACTLY 4 cards in hand and EXACTLY 4
 *  units at battlefields". Both are equalities, not floors: overshooting loses
 *  the win, which is the whole shape of the card. */
const GUTTER_PALACE_HAND = 4;
const GUTTER_PALACE_UNITS = 4;

/** Blue Sentinel's `[Add]` — one rainbow Power (`:rb_rune_rainbow:`). */
const BLUE_SENTINEL_RAINBOW = 1;

/** How many units `playerIndex` has standing AT BATTLEFIELDS — Gutter Palace's
 *  count, which deliberately excludes base. "At battlefields" is printed, so
 *  355.9.a.1's bare-noun widening to the whole Board does not apply and a base
 *  full of units neither helps nor spoils the win. */
function unitsAtBattlefields(state: GameState, playerIndex: 0 | 1): number {
  const ownerId = state.players[playerIndex].id;
  return state.battlefields.reduce((total, bf) => total + (bf.units[ownerId]?.length ?? 0), 0);
}

/** The non-combat MightContext for a unit wherever it is standing — the same
 *  three lines Gentlemen's Duel and Kinkou Monk already write out, needed here
 *  because Convergent Mutation compares two units' Might across zones. */
function mightContextFor(state: GameState, location: AnyUnitLocation) {
  return location.zone === "base"
    ? { isCombat: false }
    : { isCombat: false, battlefieldId: state.battlefields[location.zone.battlefieldIndex]!.id };
}

/** Clairvoyance (VEN-056), Temporal Breach (VEN-066), Bottled Constellation
 *  (VEN-067) — Mind wave 3, the three that needed real mechanism. */
const CLAIRVOYANCE_LOOK = 5;
const CLAIRVOYANCE_DRAW = 2;
const CLAIRVOYANCE_RECYCLE = "VEN-056-recycle";
const CLAIRVOYANCE_ORDER = "VEN-056-order";
const BOTTLED_CONSTELLATION = "VEN-067";
const BOTTLED_CONSTELLATION_KILLS = 3;
const BOTTLED_CONSTELLATION_PICK = "VEN-067-pick";

/** Sky Cruiser (VEN-060), Decree of Insight (VEN-061), Jayce (VEN-068). */
const SKY_CRUISER = "VEN-060";
const SKY_CRUISER_DAMAGE = 4;
const SKY_CRUISER_ENERGY = 1;
const DECREE_OF_INSIGHT_SHRINK = 5;
const JAYCE_INVENTOR = "VEN-068";
const JAYCE_READY = "VEN-068-ready";

/** Mesmerize's shrink, Shock Blast's damage, and the gear Patched Porobot counts. */
const MESMERIZE_SHRINK = 2;
const SHOCK_BLAST_DAMAGE = 4;
const PATCHED_POROBOT_GEAR = 3;

/** Nasus, Guardian of Knowledge (VEN-063), and the per-unit mark that spends his
 *  "once each turn". `abilityModesUsedThisTurn` is the field — a per-unit list
 *  swept by `runEnd`, which is what "each turn" means — and it is the same
 *  mechanism Zilean's double and Deadly Flourish's mark already use. */
const NASUS_GUARDIAN = "VEN-063";
const NASUS_GUARDIAN_CHANNELLED = "VEN-063-channelled";

/** Hextech Formula (VEN-062). */
const HEXTECH_FORMULA = "VEN-062";

/** Swain, Visionary (VEN-065) and his conquest payout. */
const SWAIN_VISIONARY = "VEN-065";
const SWAIN_VISIONARY_POINTS = 1;

export const cardEffects: Record<string, EffectDefinition> = {
  "VEN-061": {
    // Decree of Insight — "[Reaction] Ignore [Deflect] while paying this spell's
    // cost. Give an enemy Body ([Body]) unit -5 [Might] this turn."
    //
    // Two clauses, and the FIRST is a rules mechanism the pool had never used.
    // 764-766: "some Game Effects may instruct players to IGNORE abilities while
    // performing a game action or procedure", and 766's worked example is this
    // exact sentence. It lives in `cost-modifiers.ignoresDeflectWhilePaying`,
    // beside the surcharge it switches off, because the keyword is NOT removed —
    // the unit keeps `[Deflect]` and deflects the next spell normally. Only this
    // one payment skips the surcharge.
    //
    // That split is the whole card: a 1-Energy Decree that stripped [Deflect]
    // would be a permanent answer to the mechanic rather than a way past it once.
    //
    // "An ENEMY BODY unit" — two printed narrowings, both on the OFFER. The
    // domain axis arrived on `unitOrGear` and `unitList` in earlier waves and is
    // read here off the plain `unit` spec for the first time.
    //
    // -5 is enormous for one Energy, which is what the domain restriction is
    // paying for: it answers exactly one colour.
    targeting: { kind: "unit", owner: "enemy", domain: "Body", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId
        ? giveMightThisTurn(state, event.targetUnitInstanceId, -DECREE_OF_INSIGHT_SHRINK)
        : state,
  },
  "VEN-056": {
    // Clairvoyance — "[Reaction] [Predict 5]. Draw 2."
    //
    // # `[Predict 5]` is the pool's first VALUED Predict, and it is two questions
    //
    // "Look at the top 5 cards of your Main Deck. Recycle any of them and put the
    // rest back in any order." Bare `[Predict]` is one card and one yes/no, which
    // `effects/chaos.ts` already builds and whose note says outright that the
    // valued form "is a subset choice plus an ordering, which is not". This is
    // that subset and that ordering:
    //
    //   1. `VEN-056-recycle` — repeatedly offer the looked-at cards, plus Done.
    //      Each answer recycles ONE to the bottom (416.1) and re-asks with the
    //      rest. "ANY of them" includes none and includes all.
    //   2. `VEN-056-order` — repeatedly ask which of the survivors goes on top
    //      next. The last one is forced and `advanceDecisions` retires it without
    //      prompting.
    //
    // The working set rides on `PendingDecision.cardInstanceIds`, which exists for
    // exactly this: the question NARROWS as it is answered, which is neither
    // `count`'s "ask me N times" nor `targetInstanceId`'s "about this one thing".
    //
    // **Parked rather than fanned onto the action**, for both of the reasons bare
    // Predict's entry gives: the top of a deck is not public state, so enumerating
    // it would hand the AI its own deck order; and this is a later part of the
    // effect, decided on resolution (383.3.a.3).
    //
    // # The DRAW happens LAST, and parking it first does not achieve that
    //
    // "Predict 5. Draw 2" is sequential, and a card drawn before the ordering
    // finished could be one of the five being ordered. The obvious move — park
    // the draw first so it sits at the BACK of the queue — is WRONG, and
    // measured: `parkDecision` calls `advanceDecisions`, and a `draw` question
    // has exactly ONE option, so it is executed on the spot rather than queued.
    // The two cards came off the top before the predict had asked anything, and
    // the looked-at window then held two cards that were no longer in the deck.
    //
    // So the draw is parked by the LAST step of the predict chain instead —
    // `finishPredict` — where "the ordering has finished" is a fact rather than a
    // hope about queue order.
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const looked = state.players[ctx.casterIndex].deck.slice(0, CLAIRVOYANCE_LOOK);
      // An empty deck asks nothing at all and just draws (422's do as much as you
      // can) — the same treatment bare `[Predict]` gives.
      if (looked.length === 0) return finishPredict(state, ctx.casterIndex);
      // Nocturne - Horrifying's "as you LOOK AT me" is offered first, the
      // convention `offerTopOfDeckBanish` documents for the six existing look
      // sites.
      return parkDecision(offerTopOfDeckBanish(state, ctx.casterIndex, looked), {
        kind: CLAIRVOYANCE_RECYCLE,
        playerIndex: ctx.casterIndex,
        cardInstanceIds: looked.map((c) => c.instanceId),
      });
    },
  },
  "VEN-066": {
    // Temporal Breach — "[Hidden] Banish a unit, then its owner plays it to the
    // SAME LOCATION, ignoring its cost."
    //
    // A BLINK, and Portal Rescue's entry above is the whole explanation of why it
    // goes through banish-and-play rather than a relocation: leaving play strips
    // the Buff (705), clears damage and this-turn Might, and makes the return a
    // genuine PLAY, so on-play triggers fire again.
    //
    // Two differences from the Rescue, both printed:
    //
    //   - **"A UNIT", not "a friendly unit"** — either side's, so this is removal
    //     that resets an enemy's buffs and damage as readily as it rescues your
    //     own. `scope: "anywhere"`.
    //   - **"to the SAME LOCATION", not "to their base"** — a unit at a
    //     battlefield goes back to that battlefield, and one in base returns to
    //     base. That is what makes it a reset rather than a bounce, and it is why
    //     the destination is read off `findUnitAnywhere` before the removal.
    //
    // **[Hidden] needs nothing here** — 811's facedown play is the timing layer's,
    // and it is what makes this a 0-Energy reaction to a combat trick.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) => {
      if (!event.targetUnitInstanceId) return state;
      const found = findUnitAnywhere(state, event.targetUnitInstanceId);
      if (!found) return state;
      // A fresh copy, exactly as Portal Rescue rebuilds one — the body that comes
      // back is not the body that left.
      const returning = { ...found.unit, damage: 0, mightThisTurn: 0, buffed: false, stunned: false, movesThisTurn: 0 };
      const removed = removeUnitAnywhere(state, event.targetUnitInstanceId);
      // The SAME location. `found.zone` is captured before the removal, because
      // afterwards there is nothing left to ask.
      return found.zone === "base"
        ? playUnitToBase(removed, found.ownerIndex, returning)
        : playUnitToBattlefield(removed, found.ownerIndex, returning, state.battlefields[found.zone.battlefieldIndex]!.id);
    },
  },
  "VEN-049": {
    // Dredge Up — "Draw 1. [Flow] [2 Energy]."
    //
    // The whole card is one call. `[Flow]` needs nothing here at all: 829.1.c.1's
    // alternative cost from the trash is plumbed generically by
    // `replaced-costs.ts`, and a card effect is reached identically whichever
    // price paid for it — the reading Dragon Form's entry records from the Order
    // side.
    //
    // Worth having anyway rather than dismissing as a blank: a 2-Energy cantrip
    // that can be cast a second time out of the trash is two cards, and the
    // engine has to reach the second one.
    targeting: { kind: "none" },
    resolve: (state, ctx) => drawCards(state, ctx.casterIndex, 1),
  },
  "VEN-051": {
    // Iterative Design — "Play a 3 [Might] Mech unit token. [Flow]
    // [2 Energy][Mind]."
    //
    // `MECH_TOKEN` is SHARED from token.ts rather than restated, which is the
    // point of that file: Production Surge and Rumble - Scrapper already mint it,
    // and its `Mech` tag is read by four keyword auras in `granted-keywords.ts`.
    // A third stat line written here is the drift that file exists to prevent.
    //
    // To BASE, which is where a token with no printed destination goes — the
    // convention every unconditional token maker in the pool follows.
    targeting: { kind: "none" },
    resolve: (state, ctx) => placeToken(state, ctx.casterIndex, "base", MECH_TOKEN),
  },
  "VEN-052": {
    // Mesmerize — "[Reaction] Choose one — Return a friendly unit to its owner's
    // hand. Give an enemy unit -2 [Might] this turn."
    //
    // A MODAL card (`modes`), and the two halves have different targeting, which
    // is exactly what modes are for: one takes a friendly unit and the other an
    // enemy one, so a single spec could only express their union and would offer
    // each mode targets it cannot legally use.
    //
    // **[Reaction] needs nothing here** — `timing.timingTierOf` reads `isReaction`
    // off the card, and that is what lets this be cast into a damage step, which
    // is where a 1-Energy bounce is worth its slot.
    //
    // "A FRIENDLY unit" and "an ENEMY unit" are both bare on location, so both
    // are `scope: "anywhere"` (355.9.a.1's widening) with only the owner narrowed.
    modes: [
      {
        id: "bounce",
        label: "Return a friendly unit to its owner's hand",
        targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
        resolve: (state, _ctx, event) =>
          event.targetUnitInstanceId ? returnUnitToHand(state, event.targetUnitInstanceId) : state,
      },
      {
        id: "shrink",
        label: "Give an enemy unit -2 Might this turn",
        targeting: { kind: "unit", owner: "enemy", scope: "anywhere" },
        resolve: (state, _ctx, event) =>
          event.targetUnitInstanceId
            ? giveMightThisTurn(state, event.targetUnitInstanceId, -MESMERIZE_SHRINK)
            : state,
      },
    ],
  },
  "VEN-059": {
    // Shock Blast — "[Action] This costs [2 Energy] less if you control
    // something that's [Empowered]. Deal 4 to a unit at a battlefield."
    //
    // Two halves in two files, the split this pool takes for every conditional
    // price: the DISCOUNT is a `cost-modifiers.ts` entry (it has to be readable by
    // the enumerator, the validator and the float math, none of which resolve an
    // effect), and the damage is here.
    //
    // "SOMETHING that's Empowered" is deliberately not "a unit": Empowered is a
    // status a GEAR can carry too — Hextech Formula in this very wave empowers
    // one — so the discount's predicate walks gear as well. That is the whole
    // reason the two cards are in the same wave.
    //
    // "A unit AT A BATTLEFIELD" — the location is printed, so `scope:
    // "battlefield"` (355.9.b's narrowing), and no owner word, so either side's.
    targeting: { kind: "unit", scope: "battlefield" },
    resolve: (state, ctx, event) =>
      event.targetUnitInstanceId
        ? dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId, SHOCK_BLAST_DAMAGE)
        : state,
  },
  "SFD-076": {
    // Production Surge — "This costs [2] less if you control a Mech. Play a 3
    // Might Mech unit token to your base. Draw 1."
    //
    // The discount half lives in `cost-modifiers.ts`, where every cross-cutting
    // price question lives; this is the effect half. Two modules for one card,
    // which is why only the module that owns a card's TEXT claims it in
    // coverage — see `costModifierDefIds`'s note on exactly this card.
    //
    // "TO YOUR BASE" is printed and is the whole placement rule, so no
    // destination is chosen — the same reading Azir's Sand Soldier takes.
    targeting: { kind: "none" },
    resolve: (state, ctx) => drawCards(placeToken(state, ctx.casterIndex, "base", MECH_TOKEN), ctx.casterIndex, 1),
  },
  "SFD-077": {
    // Rocket Barrage — "[Repeat] [4][Mind] (You may pay the additional cost to
    // repeat this spell's effect, AND MAY MAKE DIFFERENT CHOICES.) Choose one —
    // Deal 4 to a unit in a base. [or] Kill a gear."
    //
    // **The pool's first MODAL card**, and the one 820.1.d works its own example
    // on: *"If Rocket Barrage's controller pays its Repeat cost as they play it,
    // they may choose the same mode or a different one, and if they choose the
    // same mode, may choose the same target or a different one. If they choose
    // 'Kill a gear' twice and choose two different gear, they must specify which
    // gear is the first target and which is the second."*
    //
    // Three things follow from that sentence, and all three are why this card
    // could not be written until now:
    //  - the mode is a CHOICE, so it rides the action (`modeId`) like a target;
    //  - the mode is part of the REPEAT's choice set, not a property of the play
    //    — `RepeatChoices.modeId`, and resolution picks the mode per execution;
    //  - "which gear is the FIRST target" is targeting language, so the gear is a
    //    TARGET chosen at announce rather than a question asked at resolution.
    //    That is what `kind: "gear"` is for; a parked decision could not give the
    //    ordering at announce.
    //
    // Mode 1 is scoped `"base"`, the narrowest scope: "a unit IN A BASE" excludes
    // every unit at a battlefield, which is the opposite of the usual restriction
    // and makes this a reach-into-their-backline card rather than a combat trick.
    // No owner clause, so either base is fair game.
    //
    // Mode 2 kills through `killGear` so the dying gear's own trigger fires
    // (Treasure Trove, Scrapheap) — the same funnel Disarming Rake uses.
    modes: [
      {
        id: "damage",
        label: "Deal 4 to a unit in a base",
        targeting: { kind: "unit", scope: "base" },
        resolve: (state, ctx, event) =>
          event.targetUnitInstanceId
            ? dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId, ROCKET_BARRAGE_DAMAGE)
            : state,
      },
      {
        id: "killGear",
        label: "Kill a gear",
        targeting: { kind: "gear" },
        resolve: (state, _ctx, event) => {
          const id = event.targetPermanentInstanceId;
          if (!id) return state;
          for (const ownerIndex of [0, 1] as const) {
            const gear = state.players[ownerIndex].activeGear.find((g) => g.instanceId === id);
            if (gear) return killGear(state, gear, ownerIndex);
          }
          // Already gone — 359.3's "a check on something no longer available".
          return state;
        },
      },
    ],
  },
  "SFD-080": {
    // Bellows Breath — "[Action] [Repeat] [1][Mind] Deal 1 to up to three units
    // at the same location."
    //
    // "At the same LOCATION", not "at the same battlefield", and rule **198.1**
    // settles that they are different: "Locations include the Battlefields and
    // the Bases." So three units standing in one player's base are a legal
    // group, which `sameBattlefield` would refuse — its own comment records that
    // a base unit "is at no battlefield, so it can never join a group". Hence
    // `sameLocation`, and hence `scope: "anywhere"` to put base units in the
    // pool at all.
    //
    // Each base is its OWN location, so one unit in each base is two locations
    // and not a group — the reason the constraint is keyed by zone rather than
    // by "is it a battlefield".
    //
    // `min: 0` because "UP TO three" — the card is castable with an empty board
    // and deals nothing, which is what the rules say outright for a zero choice.
    // No owner clause, so a group of enemies, a group of your own, or a mix at a
    // contested battlefield are all legal.
    //
    // Distinct units (no `allowsDuplicates`): "three units" is three units, and
    // the 1 damage is dealt once per entry.
    targeting: { kind: "unitList", min: 0, max: 3, scope: "anywhere", sameLocation: true },
    resolve: (state, ctx, event) =>
      (event.targetUnitInstanceIds ?? []).reduce(
        (next, id) => dealDamage(next, ctx.casterIndex, id, BELLOWS_BREATH_DAMAGE),
        state,
      ),
  },
  "SFD-066": {
    // Frigid Touch — "[Reaction] [Repeat] [2] Give a unit -2 Might this turn."
    //
    // Smoke Screen's shape with a smaller number and, importantly, **no floor**:
    // that card prints "to a minimum of 1 Might" and this one does not, so the
    // `floor` argument is deliberately omitted rather than defaulted to 1. A unit
    // can be taken to 0 Might and below by this card, which is how it kills a
    // 2-Might body outright — reading a minimum into text that has none would
    // have quietly removed the card's whole point.
    //
    // "A unit", so 355.9.a.1 reaches base as well; no owner clause, so debuffing
    // your own is legal and pointless, the usual pair.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId ? giveMightThisTurn(state, event.targetUnitInstanceId, -FRIGID_TOUCH_MIGHT) : state,
  },
  "OGN-115": {
    // Promising Future — "Each player looks at the top 5 cards of their Main
    // Deck, banishes one of them, then recycles the rest. Starting with the next
    // player, each player plays those cards, ignoring Energy costs. (They must
    // still pay Power costs.)"
    //
    // Four questions in one spell, and their ORDER is the card: both players
    // choose before either plays, so neither is choosing against a board the
    // other has already changed. FIFO parking is the whole of that, the same way
    // it is the whole of Cull the Weak's APNAP.
    //
    // Two different orderings in one sentence, and they are not the same one.
    // The LOOK is APNAP — active player first, this engine's convention for
    // "each player" — while the PLAY is explicitly "starting with the NEXT
    // player", so the caster plays last. Reading both as APNAP would hand the
    // caster the tempo the card deliberately gives away.
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const caster = ctx.casterIndex;
      const next = (1 - caster) as 0 | 1;
      const first = state.activePlayerIndex;
      const second = (1 - first) as 0 | 1;
      // Both players look, so both looks can wake a Nocturne — and his offer is
      // parked ahead of the banish questions for the FIFO reason Reinforce's
      // resolve records.
      const looked = [first, second].reduce(
        (acc, playerIndex) => offerTopOfDeckBanish(acc, playerIndex, acc.players[playerIndex].deck.slice(0, 5)),
        state,
      );
      return [
        ...[first, second].map((playerIndex) => ({ kind: "OGN-115-banish", playerIndex }) as const),
        ...[next, caster].map((playerIndex) => ({ kind: "OGN-115-play", playerIndex }) as const),
      ].reduce((acc, seed) => parkDecision(acc, seed), looked);
    },
  },
  "OGN-122": {
    // Time Warp — "Take a turn after this one. Banish this."
    //
    // At 10 Energy and 4 Power it is the most expensive card in the pool, and the
    // two sentences are both load-bearing.
    //
    // **"A turn", not "another Action phase"** — so the extra turn Awakens,
    // scores its holds, Channels and Draws like any other. That is why this is a
    // counter on GameState read by `runEnd`'s rotation rather than anything
    // clever: with the rotation suppressed, every other part of the turn loop is
    // already correct.
    //
    // **"BANISH this"** is what stops the card being recurred, and it is the
    // pool's FIRST real write to `PlayerState.banished` — every other banish here
    // is transient (banished and replayed in one instruction, nothing able to
    // observe the middle zone). A Spell is already in its caster's trash by
    // resolution time, so this moves it from there; without it, Spectral Matron
    // or Immortal Phoenix would hand back an unbounded chain of extra turns.
    //
    // The queue is a COUNT: casting it twice in one turn is two extra turns, which
    // is what the sentence says and what `runEnd` spends one at a time.
    targeting: { kind: "none" },
    resolve: (state, ctx) => ({
      ...banishCard(state, ctx.casterIndex, ctx.sourceCardInstanceId ?? ""),
      extraTurns: state.extraTurns + 1,
      extraTurnsForIndex: ctx.casterIndex,
    }),
  },
  "OGN-102": {
    // Portal Rescue — "Banish a friendly unit, then its owner plays it to their
    // base, ignoring its cost."
    //
    // A BLINK: the unit leaves play and comes back fresh. That is the card, and
    // it is why it goes through the banish-and-play path rather than
    // `relocateToBaseUnchanged` — leaving play strips the Buff (705), clears
    // damage and this-turn Might, and makes the return a genuine PLAY, so its
    // on-play trigger fires again and Cithria sees another unit arrive.
    //
    // The banish is TRANSIENT: banished and replayed in one instruction, with no
    // window in which anything could observe the middle zone. It therefore goes
    // straight to play rather than through `PlayerState.banished` — the same call
    // Baited Hook's decision already makes, and recorded in
    // docs/rules-conformance.md.
    //
    // "ITS OWNER plays it", not the caster: `playUnitToBase` is handed the unit's
    // own controller, so rescuing a friendly unit returns it to the right base.
    // Scope "anywhere" because the text names no battlefield; a unit already in
    // base is a legal (if pointless) target, which is 355.9.a.1 rather than an
    // oversight.
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, _ctx, event) => {
      if (!event.targetUnitInstanceId) return state;
      const found = findUnitAnywhere(state, event.targetUnitInstanceId);
      if (!found) return state;
      // A fresh copy: 705 removes Buffs on leaving play, and damage/this-turn
      // Might are properties of the body that left. Rebuilt here rather than in
      // `playUnitToBase`, which is also used for cards that were never in play.
      const returning = { ...found.unit, damage: 0, mightThisTurn: 0, buffed: false, stunned: false, movesThisTurn: 0 };
      const removed = removeUnitAnywhere(state, event.targetUnitInstanceId);
      return playUnitToBase(removed, found.ownerIndex, returning);
    },
  },
  "OGN-123": {
    // Unchecked Power — "Exhaust all friendly units, then deal 12 to ALL units
    // at battlefields."
    //
    // The two clauses have deliberately different reach and the text says so:
    // the exhaust hits "all FRIENDLY units" (base included), the damage hits
    // "ALL units AT BATTLEFIELDS" (both players, base excluded). Reading either
    // as the other would change the card completely.
    //
    // Order matters and is printed: exhaust first, THEN damage. A unit that dies
    // to the 12 was exhausted on its way out, which is invisible here but not to
    // anything watching for exhaustion.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      dealDamageToAllUnitsAtAllBattlefields(exhaustAllFriendlyUnits(state, ctx.casterIndex), ctx.casterIndex, 12),
  },
  "OGN-114": {
    // Progress Day — "Draw 4."
    //
    // Drawing on a short deck takes what is there rather than throwing: the
    // documented Burn Out gap in drawCards, not a decision made here.
    targeting: { kind: "none" },
    resolve: (state, ctx) => drawCards(state, ctx.casterIndex, 4),
  },
  "OGN-083": {
    // Consult the Past — "[Hidden][Reaction] Draw 2."
    // The simplest card in the pool, and the one that shows what Hidden is worth
    // on its own: hidden for 1 Power, played later for 0 instead of 4 Energy.
    targeting: { kind: "none" },
    resolve: (state, ctx) => drawCards(state, ctx.casterIndex, 2),
  },
  "OGN-094": {
    // Sprite Call — "[Hidden][Action] Play a ready 3 Might Sprite unit token
    // with [Temporary]."
    //
    // Three things the Recruit token could not express, which is why token.ts
    // grew a spec: a Might other than 1, entering READY rather than exhausted
    // (143.4.a's default, overridden by the card's own "ready"), and carrying a
    // keyword. [Temporary] then works with no further wiring — rule 816's
    // Beginning-Phase kill already runs before scoring, which is what stops this
    // token holding a battlefield for a free point.
    //
    // Destination is the caster's base by default; played from Hidden, 811 makes
    // it that battlefield instead, which legal-actions supplies as the
    // destination rather than this resolver guessing.
    targeting: { kind: "none" },
    resolve: (state, ctx, event) =>
      placeToken(
        state,
        ctx.casterIndex,
        event.destinationBattlefieldId !== undefined ? { battlefieldId: event.destinationBattlefieldId } : "base",
        SPRITE_TOKEN,
      ),
  },
  "OGN-093": {
    // Smoke Screen — "[Reaction] Give a unit -4 Might this turn, to a minimum
    // of 1 Might."
    //
    // scope: "anywhere", deliberately. The card says "a unit", NOT "a unit at a
    // battlefield", and rule 355.9.a.1 settles what the bare noun means: the
    // targeting section's own list of Public zones names Bases alongside
    // Battlefield Zones, so a unit standing at home is a legal target. No owner
    // restriction is printed either, so `owner` is left unset — shrinking your
    // own unit is a bad play, not an illegal one. Same reading Orb of Regret,
    // Stupefy and Discipline already got; base is not a safe parking spot.
    //
    // The floor is the card's own "to a minimum of 1 Might" clause, and
    // giveMightThisTurn's `floor` argument exists for exactly this wording: it
    // caps the STORED modifier rather than only the displayed Might, so a
    // second Smoke Screen on an already-floored unit takes nothing further off
    // instead of digging a hole a later pump would have to climb out of. Buffs
    // and continuous auras are deliberately not counted towards the floor —
    // they can appear and vanish after this resolves, and the minimum is fixed
    // at resolution time. That simplification lives in the helper, not here.
    //
    // giveMightThisTurn, NOT a Buff. This expires in the Expiration Step ("all
    // 'this turn' effects expire simultaneously", rule 317), which
    // turn-manager.ts's runEnd gets for free by zeroing every unit's
    // mightThisTurn; a Buff (rule 705) is a persistent game object that would
    // survive the turn and only come off when the unit leaves play (rule 705).
    // A negative Buff isn't a thing in the first place.
    //
    // [Reaction] is rule 813 and is NOT implemented here — engine/timing.ts
    // owns when this may be played, including onto an already-open chain. The
    // resolver is identical whenever it runs, so there is nothing
    // timing-shaped for this entry to do.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) => giveMightThisTurn(state, event.targetUnitInstanceId!, -4, 1),
  },
  "OGN-104": {
    // Retreat — "[Reaction] Return a friendly unit to its owner's hand. Its
    // owner channels 1 rune exhausted."
    //
    // scope "anywhere": the text says "a friendly unit", not "at a battlefield",
    // and 355.9.a.1 puts Bases among the public zones a target may be drawn from.
    // Bouncing a unit out of your own base is a real (if narrow) play — it
    // re-arms an on-play trigger — so it is not worth narrowing on a guess.
    //
    // The owner is looked up BEFORE the bounce rather than assumed to be the
    // caster. It always IS the caster today (control and ownership are the same
    // thing in this engine — OGN-203 is the only card that would separate them
    // and it is unimplemented), but "its owner" is what the card says, and the
    // lookup has to happen first either way: after returnUnitToHand the unit is
    // in a hand and findUnitAnywhere no longer sees it.
    //
    // A target that left play while this sat on the chain does NOTHING AT ALL,
    // including the channel. That is not the usual defensive no-op: rule 359.3.e
    // says "if any of the spell's targets are no longer legal ... any
    // instructions related to an illegal target can't be followed", and the
    // second sentence names "ITS owner" — it is an instruction about the target.
    // Contrast the rules' own Void Seeker example ("Deal 4 to a unit at a
    // battlefield. Draw 1."), where the draw survives because it refers to
    // nothing.
    targeting: { kind: "unit", owner: "friendly", scope: "anywhere" },
    resolve: (state, _ctx, event) => {
      const location = findUnitAnywhere(state, event.targetUnitInstanceId!);
      if (!location) return state;
      return channelRunesExhausted(returnUnitToHand(state, location.unit.instanceId), location.ownerIndex, 1);
    },
  },
  "OGN-108": {
    // Convergent Mutation — "[Reaction] Choose a friendly unit. This turn,
    // increase its Might to the Might of another friendly unit."
    //
    // Two friendly targets and the slots are NOT interchangeable: slot 0 is the
    // unit that grows, slot 1 is only measured. See the reachability note below.
    //
    // "INCREASE its Might TO x" is arithmetic, not assignment, and the rules
    // separate those two layers explicitly (rule 477's layer list): "A unit's
    // Might becomes 4 this turn" is set in the assignment layer, whereas
    // "Increase a friendly unit's Might to 5" is worked in the Arithmetic layer
    // as a positive delta. That is why this is a `giveMightThisTurn` and not a
    // new set-to-a-value primitive — and why it stacks with, rather than wipes,
    // an existing modifier.
    //
    // The delta is clamped at 0 by the same rules text: "Players cannot increase
    // a numeric attribute by a negative amount. If an effect would instruct a
    // player to do so, they increase it by 0 instead." So naming a SMALLER donor
    // is legal and does nothing; it never shrinks the chosen unit.
    //
    // EFFECTIVE Might on both sides, not printed — the Arithmetic layer runs on
    // the value the rest of the game sees, so a donor pumped by Discipline
    // donates the pumped number and a chosen unit already under a buff needs
    // less to catch up. Rule 463 ("effects that calculate Might increases and
    // decreases use the actual value") is why a stunned donor still donates its
    // real Might rather than the 0 combat treats it as; `effectiveMight` does not
    // zero stunned units, so this gets that for free.
    //
    // Snapshotted, per the same Arithmetic-layer rule: the delta is computed once
    // at resolution and stored, so the chosen unit does not track the donor
    // afterwards. If the donor is killed a moment later the growth stays.
    //
    // `min: 2` — Gentlemen's Duel's precedent rather than Back to Back's `min: 0`.
    // "Increase its Might to the Might of ANOTHER friendly unit" has no reading
    // with one unit on the board: there is no value to increase to, so the card
    // is uncastable rather than castable-and-inert.
    //
    // `asymmetricSlots` is REQUIRED here and its absence was a real half-dead
    // card. legal-actions collapses a two-slot spec whose roles are equal and
    // enumerates one ordering of each pair, reasoning that (A,B) and (B,A) are
    // the same choice — true for Back to Back and Singularity, which apply the
    // same thing to each unit, and false here, where the ordering IS the
    // decision. Measured before the flag existed: with a 7-Might and a 2-Might
    // friendly, the single offered pairing was the one that increases by 0.
    targeting: { kind: "unitSlots", slots: ["friendly", "friendly"], min: 2, scope: "anywhere", asymmetricSlots: true },
    resolve: (state, _ctx, event) => {
      const chosen = findUnitAnywhere(state, event.targetUnitInstanceId!);
      const donor = findUnitAnywhere(state, event.secondTargetUnitInstanceId!);
      if (!chosen || !donor) return state; // either target gone: 359.3.e again
      const chosenMight = effectiveMight(state, chosen.unit, chosen.ownerIndex, mightContextFor(state, chosen));
      const donorMight = effectiveMight(state, donor.unit, donor.ownerIndex, mightContextFor(state, donor));
      const increase = Math.max(0, donorMight - chosenMight);
      return increase > 0 ? giveMightThisTurn(state, chosen.unit.instanceId, increase) : state;
    },
  },
  "SFD-087": {
    // Premonition — "[Reaction] Draw 3."
    //
    // The plainest effect in the set behind the deepest Power cost in it (2
    // Energy and THREE Mind), which is the card: Consult the Past above draws 2
    // for one Power at Hidden speed, and this draws 3 at Reaction speed for
    // three. Nothing about that pricing is this resolver's business.
    //
    // [Reaction] is rule 813 and belongs entirely to engine/timing.ts — the
    // resolver is identical whenever it runs, so there is nothing timing-shaped
    // for this entry to do, exactly as Smoke Screen's own note records.
    //
    // A deck too short to cover three runs Burn Out (431) inside `drawCards`
    // rather than being clamped here.
    targeting: { kind: "none" },
    resolve: (state, ctx) => drawCards(state, ctx.casterIndex, 3),
  },
  "SFD-070": {
    // Wages of Pain — "[Hidden][Action] Deal 3 to a unit at a battlefield. Play a
    // Gold gear token exhausted."
    //
    // Structurally Void Seeker (OGN-086) with a Gold token where the draw is, and
    // it takes Void Seeker's two readings wholesale rather than re-deriving them:
    //
    //  - **Default battlefield scope.** `{ kind: "unit" }` with no `scope`,
    //    because the printed complement names a battlefield — the rules'
    //    Instructions section (135.2) works this exact phrasing. A unit in either
    //    base is not a legal target, unlike Smoke Screen's bare "a unit" above.
    //    No owner word is printed either, so shooting your own is legal and bad.
    //
    //  - **Two instructions, ignored separately.** A target that left play while
    //    this sat on the chain makes `dealDamage` a no-op and the token STILL
    //    arrives (359.3.e, and 135.2.b's worked Void Seeker example). This is not
    //    Retreat's case: Retreat's second sentence names "ITS owner" and so is an
    //    instruction about the target, while "play a Gold gear token" refers to
    //    nothing that could become illegal.
    //
    // Damage FIRST, then the token — 359.3.d, "top to bottom of the rules text".
    // Observable rather than cosmetic: a lethal 3 kills mid-resolution and can run
    // a [Deathknell] before the gear exists for anything to count.
    //
    // [Hidden] and [Action] are the loader's and engine/timing.ts's; played from
    // facedown, 811 confines the target to that battlefield, which legal-actions
    // enforces rather than this resolver guessing.
    targeting: { kind: "unit" },
    resolve: (state, ctx, event) =>
      placeGoldTokens(dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId!, 3), ctx.casterIndex, 1),
  },
  "UNL-070": {
    // Turn to Dust — "Give a gear [Temporary]. (Kill it at the start of its
    // controller's Beginning Phase, before scoring.)"
    //
    // Fading Memories' (OGN-146) gear half on its own, at half the reach and half
    // the price, so it takes that card's machinery unchanged rather than growing
    // any: `grantTemporary` already dispatches on where the id is found and
    // already writes `GearInstance.keywords`, the field whose own doc comment
    // names Fading Memories as the reason it exists. Nothing here is unit-shaped.
    //
    // **The kill is turn-manager's, not this resolver's.** 816 is "at the start of
    // THIS PERMANENT'S CONTROLLER's Beginning Phase", and `killTemporaryPermanents`
    // already sweeps the active player's `activeGear` through `killGear` so a gear
    // that triggers on its own death (Scrapheap) still fires. So this is delayed
    // removal, not instant: giving an OPPONENT's gear [Temporary] kills it on
    // their next Beginning Phase, and giving your own kills it on yours.
    //
    // "A gear", unqualified — EITHER side's, the same reading Pickpocket's
    // identical bare noun gets one registry down, and the opposite of the pool's
    // "a FRIENDLY gear" cards (Zaun Punk, Jayce - Man of Progress). `kind: "gear"`
    // with no `owner` is exactly that walk.
    //
    // Chosen at ANNOUNCE, as a target, rather than asked at resolution: 355 puts a
    // spell's targets on the Chain with it, and `kind: "gear"` is the spec that
    // says so (Rocket Barrage's second mode, whose own note works 820.1.d's
    // "which gear is the first target"). A gear killed in the response window makes
    // this do nothing, per 359.3.e.
    //
    // Re-granting is harmless (817.1.a, and `grantTemporary` says so), so no guard
    // is needed for a gear that is already Temporary.
    targeting: { kind: "gear" },
    resolve: (state, _ctx, event) =>
      event.targetPermanentInstanceId ? grantTemporary(state, event.targetPermanentInstanceId) : state,
  },
  "UNL-061": {
    // Downstage Dramatics — "[Reaction] [Repeat] [2] Draw 1."
    //
    // The effect is one instruction and it is written whole. The `[Repeat]` is a
    // row in `REPEAT_COSTS` (card-effects.ts), which this file does not own — and
    // the gap is already PINNED rather than invisible: `test/repeat-keyword.test.ts`
    // lists UNL-061 among the six UNL cards "a set under construction has not
    // priced yet", so closing it is literally `"UNL-061": { energy: 2 }` in that
    // table and the test's expected list shrinking by one. Until then the card is
    // castable and draws, and `legal-actions` simply never offers a repeat variant
    // (it asks `repeatCostOf`, which answers undefined).
    //
    // **So this card is registered while half a sentence of its text is inert**,
    // which coverage cannot see — `[Repeat]` left `UNIMPLEMENTED_KEYWORDS` when the
    // mechanism landed, so it no longer greys a card that prints it. Stated here
    // and reported rather than left for a playtest to find.
    //
    // [Reaction] is rule 813 and belongs entirely to engine/timing.ts — the
    // resolver is identical whenever it runs, exactly as Smoke Screen records.
    targeting: { kind: "none" },
    resolve: (state, ctx) => drawCards(state, ctx.casterIndex, 1),
  },
  "UNL-063": {
    // Eclipse — "[Reaction] Give a unit -4 [Might] this turn. [Predict]."
    //
    // Smoke Screen's debuff one Energy cheaper and **without its floor**: OGN-093
    // prints "to a minimum of 1 Might" and this card does not, so the `floor`
    // argument is omitted deliberately. 143.2.b is explicit that none is implied —
    // "If a unit's Might is ever less than 0, it is treated as 0 when referenced by
    // spells and abilities... Although the unit's Might is treated as 0, it is not
    // 0. Effects that calculate Might increases and decreases use the actual value"
    // — so a second debuff on an already-emptied unit still digs, and a later pump
    // has to climb back out. Frigid Touch and Icevale Archer read it the same way.
    //
    // "A unit", with no owner and no battlefield: 355.9.a.1 makes the bare noun
    // "an object on the Board", and 355.10.a.1's Public zones name Bases alongside
    // Battlefield Zones. Hence scope "anywhere".
    //
    // # `[Predict]` — the pool's first, and it is not a keyword
    //
    // model/keyword.ts files it under NON_KEYWORD_BRACKETS as an ACTION WORD, and
    // **436.1 defines the bare form exactly**: "Predicting a card is the act of
    // looking at a single card from the top of the Main Deck and choosing whether
    // or not to Recycle it." That is `voidHatchlingOptions`/`voidHatchlingAnswer`
    // word for word — the Hatchling's replacement step IS a Predict — so they are
    // reused rather than re-spelt. Reuse also gets the recycle held through
    // `holdCardsRecycled` for Karma - Channeler, which a hand-rolled deck splice
    // would have quietly skipped.
    //
    // A parked QUESTION rather than a choice on the action, unlike `[Vision]`'s
    // `visionRecycle` axis: Vision is decided as the unit is played, before
    // anything is seen, while this look happens at RESOLUTION and the whole point
    // is answering it having seen the card. A pre-decided field cannot carry that.
    //
    // Order is 359.3.d, "top to bottom of the rules text": the debuff lands now,
    // the Predict is parked behind it.
    //
    // The look is a LOOK, so Nocturne - Horrifying's "as you look at or reveal me"
    // is owed and offered FIRST — FIFO answers him before this, which is the order
    // the two read in, and these options are rebuilt from live state if he banishes
    // himself off the top in the meantime.
    //
    // 436.4 covers the short deck: "they will Predict as many as possible instead",
    // and 436.4.a adds that this is NOT a Burn Out. An empty deck therefore leaves
    // `voidHatchlingOptions` with its lone "leave the top card", which
    // `advanceDecisions` retires without ever prompting.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, event) => {
      const debuffed = event.targetUnitInstanceId
        ? giveMightThisTurn(state, event.targetUnitInstanceId, -ECLIPSE_DEBUFF)
        : state;
      // Two instructions, ignored separately (359.3.e.6): a target that left play
      // while this sat on the chain kills the debuff and the Predict still happens,
      // which is 135.2's worked Void Seeker split and NOT Retreat's "its owner".
      const top = debuffed.players[ctx.casterIndex].deck[0];
      const looked = top ? offerTopOfDeckBanish(debuffed, ctx.casterIndex, [top]) : debuffed;
      return parkDecision(looked, { kind: "UNL-063-predict", playerIndex: ctx.casterIndex });
    },
  },
  "UNL-066": {
    // Moonlight Affliction — "[Reaction] Give a unit -10 [Might] this turn."
    //
    // Eclipse's sentence at seven Energy and more than twice the number: enough to
    // empty anything in the pool for the turn. Same three readings, and each is
    // the card's own text rather than an inheritance:
    //
    //  - **no floor** — nothing is printed, and 143.2.b (quoted in Eclipse above)
    //    says a Might below 0 is a real value that is merely TREATED as 0;
    //  - **scope "anywhere"** — "a unit", so 355.9.a.1 plus 355.10.a.1's Public
    //    zones reach either base;
    //  - **no owner** — shrinking your own is a bad play, not an illegal one.
    //
    // **It does NOT kill on its own**, and that is worth stating because -10 looks
    // like removal: 143.2.a kills a unit whose NONZERO marked damage equals or
    // exceeds its Might, so an undamaged unit at -6 Might is alive and merely
    // useless. What the card really buys is that any 1 damage afterwards is lethal
    // — and `dealDamage` is where that arithmetic is done, which is why nothing
    // here re-checks it. (This engine has no state-based re-check of 143.2.a when
    // MIGHT falls rather than damage rising; a unit already carrying damage does
    // not die the instant this resolves. Engine-wide and older than this card.)
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId
        ? giveMightThisTurn(state, event.targetUnitInstanceId, -MOONLIGHT_AFFLICTION_DEBUFF)
        : state,
  },
  "UNL-069": {
    // Sprite Burst — "Play two ready 3 [Might] Sprite unit tokens with
    // [Temporary]."
    //
    // Sprite Call (OGN-094) doubled, so it takes that card's token unchanged:
    // `SPRITE_TOKEN` is shared from the top of this file rather than re-declared,
    // which is exactly the drift token.ts grew a spec parameter to prevent.
    //
    // **TWO calls, not a count parameter.** 185.1 makes a token a Game Object in
    // its own right ("'Token' is an intrinsic category of Game Objects, in the
    // same way 'card' is"), so two arrivals are two things for Cithria and for a battlefield's
    // Contested check to see; one call minting a pair would be one object with a
    // count and is not what the numeral means.
    //
    // **Destination is the caster's BASE, and that is a recorded SIMPLIFICATION
    // rather than the printed rule.** 185.2.a says a token "can be played by their
    // owner if their card type is played, FOLLOWING ALL THE APPLICABLE STEPS FOR
    // PLAYING A CARD plus any restrictions or modifications from the effect that
    // created the token", and 184.2 says the effect "may restrict the location" —
    // this one does not. So by the rules these Sprites are played like any unit,
    // i.e. to base OR to a battlefield the caster is reinforcing.
    //
    // Offering that choice means adding this defId to `cardPlacesTokens`
    // (card-effects.ts), a shared file this pass does not own — and the choice it
    // grants is "your base or battlefields you CONTROL" (Recruit the Vanguard's
    // printed clause), which is not the same set as the ordinary reinforce rule,
    // and it lands BOTH tokens at ONE destination. Neither of those is obviously
    // right for this card, so it is flagged for a ruling rather than guessed at.
    // Base is the destination that is always legal, and it is what Sprite Call's
    // non-hidden play already does one registry up.
    //
    // `[Temporary]` needs no wiring: 816's Beginning-Phase kill already runs before
    // scoring, which is what stops two free bodies from holding two battlefields.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      Array.from({ length: SPRITE_BURST_TOKENS }).reduce<GameState>(
        (next) => placeToken(next, ctx.casterIndex, "base", SPRITE_TOKEN),
        state,
      ),
  },
  "UNL-073": {
    // Deadly Flourish — "Deal 3 to an enemy unit. When it dies this turn, play a
    // Gold gear token exhausted."
    //
    // # The first sentence
    //
    // "An ENEMY unit" with no location word: 355.9.a.1 makes the bare noun "an
    // object on the Board" and 355.10.a.1's Public zones name the Bases, so
    // `scope: "anywhere"` — the same reading Eclipse and Moonlight Affliction
    // take two entries up. `owner: "enemy"` is printed and is the difference
    // between this and those two.
    //
    // # The second sentence: a MARK on the victim, read by a TRASH listener
    //
    // "When IT dies this turn" is a delayed triggered ability (390.2, and
    // 359.3.f.3.a for when its information is referenced) that has to outlive
    // the very death it watches for. It works now because of a route that did
    // NOT exist when the first sentence was written alone: `execute-play-card`
    // trashes a Spell at play time, so the Flourish is already sitting in its
    // caster's trash while its victim is still alive, and triggers.ts's
    // `TRASH_LISTENER_DEF_IDS` now names this card — the odd entry in that set,
    // since it is there for WHERE it ends up rather than for saying "from your
    // trash".
    //
    // The two halves are joined by a mark written onto the VICTIM before the
    // damage, so `killUnit`'s snapshot carries it: 808.1.d.3 requires the dying
    // card's details be noted "before the card is moved to the Trash", and
    // `dealDamage` builds `damagedUnit` from the live unit, so a mark placed
    // first rides `DeathContext.unit` into the trigger. Nothing else can carry
    // it — the victim is off the board by the time `completeDeath` fires the
    // event, so no board-keyed lookup could find it.
    //
    // `abilityModesUsedThisTurn` is the field, for the reason Draven's and
    // Pyke's marks two files over already give: it is per-INSTANCE and
    // `turn-manager`'s runEnd clears it for every unit on both sides, so "this
    // turn" expires for free on a victim who survives.
    //
    // **The mark is stamped with the turn, and that is load-bearing rather than
    // decorative.** runEnd's `expireMightThisTurn` sweeps base units and
    // battlefield units and nothing else, so a victim that reached a NON-BOARD
    // zone carries its mark there unswept — `returnUnitToHand` and
    // `completeDeath` both preserve the field. Rule 124 says that object is a
    // new one anyway ("a Game Object that changes zones to or from a Non-Board
    // Zone becomes a new object for the purposes of tracking that object"), and
    // 390.5.a closes the delayed ability's window with it. The stamp is what
    // makes the stale copy fail to match on any later turn.
    targeting: { kind: "unit", owner: "enemy", scope: "anywhere" },
    resolve: (state, ctx, event) => {
      const targetId = event.targetUnitInstanceId;
      if (targetId === undefined) return state;
      // A target that left play in the response window: 359.3.e makes both
      // instructions no-ops, and marking a unit that is not there would be an
      // invention rather than a no-op.
      const victim = findUnitAnywhere(state, targetId);
      if (victim === undefined) return state;
      // Marked BEFORE the damage, because the damage is what usually kills: the
      // whole death funnel runs inside `dealDamage`, and a mark written after it
      // would arrive at an empty board.
      const marked =
        ctx.sourceCardInstanceId === undefined
          ? state
          : recordModeUsed(state, victim.ownerIndex, targetId, deadlyFlourishMark(state, ctx.sourceCardInstanceId));
      return dealDamage(marked, ctx.casterIndex, targetId, DEADLY_FLOURISH_DAMAGE);
    },
  },
  "UNL-072": {
    // Crescent Strike — "[Action] Choose a battlefield and an enemy unit there.
    // Deal 4 to that unit and 1 to each other enemy unit there."
    //
    // The battlefield is derived from the chosen unit rather than chosen
    // separately, and that is a DIVERGENCE with one observable edge — worth being
    // precise about, because the card names two things and the rules count them.
    //
    // 355.10.b's worked example is the case this ISN'T: "'Kill a unit at a
    // battlefield' targets a unit, but not a battlefield, because the units are
    // targets and 'at a battlefield' is a restriction." Here the battlefield is
    // CHOSEN in as many words, and a Battlefield Zone is Public (355.10.a.1), so by
    // the rules this spell has two targets.
    //
    // Every legal (battlefield, unit) pair is still offered — "an enemy unit THERE"
    // makes the battlefield a function of the unit — so enumeration and the ordinary
    // resolution are exact. **What differs is the response window**: if the named
    // unit leaves play, 359.3.e.8 would keep the instruction alive for the target
    // that is still valid ("with only the Targets available and valid being operated
    // on"), so the splash should still hit the battlefield's other enemies. Here it
    // does not, because the battlefield was only ever known through the unit.
    // Expressing it properly needs a battlefield-and-unit TargetingSpec, which is an
    // edit to card-effects.ts and legal-actions.ts — neither of them this file's.
    //
    // "ENEMY" throughout, measured from the caster, and the default battlefield
    // scope because "there" names one — a unit in a base is neither a legal choice
    // nor a splash victim.
    //
    // The splash list is snapshotted BEFORE the 4 is dealt, matching
    // `dealDamageToEnemyUnitsAtBattlefield`'s own reasoning: the focus damage runs
    // the full death funnel, and a `[Deathknell]` firing mid-resolution can move
    // bodies. `dealDamage` no-ops on an id that has since left, so a splash victim
    // killed by the Deathknell is skipped rather than throwing.
    targeting: { kind: "unit", owner: "enemy" },
    resolve: (state, ctx, event) => {
      const targetId = event.targetUnitInstanceId;
      if (!targetId) return state;
      const here = findUnitOnBattlefield(state, targetId);
      if (!here) return state; // gone, or never at a battlefield: 359.3.e.6
      const battlefield = state.battlefields[here.battlefieldIndex]!;
      const casterId = state.players[ctx.casterIndex].id;
      // "each OTHER enemy unit there" — the same side as the chosen unit is not the
      // test; "enemy" is measured from the CASTER, so every unit at this
      // battlefield that is not the caster's and not the focus takes the 1.
      const splashIds = Object.entries(battlefield.units)
        .filter(([ownerId]) => ownerId !== casterId)
        .flatMap(([, units]) => units.map((u) => u.instanceId))
        .filter((id) => id !== targetId);
      return splashIds.reduce(
        (next, id) => dealDamage(next, ctx.casterIndex, id, CRESCENT_STRIKE_SPLASH_DAMAGE),
        dealDamage(state, ctx.casterIndex, targetId, CRESCENT_STRIKE_FOCUS_DAMAGE),
      );
    },
  },
  "UNL-083": {
    // Smoke and Mirrors — "[Hidden] [Action] Choose a unit you control and another
    // unit you control at a different location. If at least one of them has
    // [Temporary], move each to the other's location. Draw 1."
    //
    // # It is a swap, and both halves are ordinary force-moves
    //
    // "Move each to the other's LOCATION" — 198.1's "Locations include the
    // Battlefields and the Bases", so a unit at home and a unit at a battlefield
    // trade places. That is exactly the pair `forceMoveToBattlefield` /
    // `forceMoveToBase` covers, and going through them rather than rewriting the
    // zones is what makes this fire `unitMoved` (446.1/449 make an effect-driven
    // relocation a Move), bump `movesThisTurn`, and apply Contested on arrival.
    //
    // BOTH destinations are read BEFORE either unit moves. Reading the second
    // unit's location after the first had already been placed would send it to
    // where the first one now is, which is not a swap at all — the classic
    // temp-variable bug, and the reason the two locations are captured up front.
    //
    // SEQUENTIAL, not simultaneous, and that is visible in one place: the first
    // arrival can apply Contested and open a Showdown before the second unit has
    // left. This engine has no simultaneous-move primitive; the same divergence
    // Card Sharp's two parked questions record for choices.
    //
    // # "At a DIFFERENT location" is a targeting restriction this spec cannot say
    //
    // **DIVERGENCE, in the permissive direction.** `unitSlots` has
    // `sameBattlefield` (Facebreaker's) and no inverse, so the enumerator and the
    // validator both accept two units standing together. 355 makes that an invalid
    // choice and the spell uncastable with it; here it is castable and the swap
    // simply does nothing, while "Draw 1" still happens. The guard below is
    // therefore a resolver check standing in for a spec flag — the shape
    // `TargetingSpec`'s own comments warn about, taken knowingly because the
    // alternative is an edit to card-effects.ts, legal-actions.ts and
    // validate-play-card.ts, none of which this file owns.
    //
    // **DIVERGENCE, in the restrictive direction, and the rules work THIS CARD by
    // name.** 811.1.d.2 confines a from-Hidden spell's targets to the battlefield
    // it was hidden at "unless the ability explicitly restricts targeting in a way
    // that makes this impossible", and 811.1.d.2.a's example is Smoke and Mirrors:
    // *"the first unit chosen can be chosen at the battlefield Smoke and Mirrors
    // was played from, so it must be. The second unit chosen explicitly restricts
    // targeting in a way that makes this impossible, so it can be chosen from any
    // location."* `legal-actions` applies `atHiddenBattlefield` to BOTH slots, so a
    // from-Hidden play can only ever name two units standing together — which,
    // with the divergence above, is a play that draws and moves nothing. The whole
    // from-Hidden mode of this card is therefore inert until the second slot is
    // exempted. Reported rather than half-written; it is the same shared edit.
    //
    // # The [Temporary] gate
    //
    // "If at least ONE of them has [Temporary]" is a condition on the MOVE
    // instruction, not on the choice — so it is read here at resolution, and read
    // through `hasKeyword` so a Temporary granted by Turn to Dust or by Sprite
    // Queen's token counts exactly like a printed one. The draw is its own
    // instruction (135.2) and happens either way, including when both targets have
    // left play while this sat on the chain (359.3.e).
    //
    // `min: 2`: both choices are mandatory, so the card is uncastable with one
    // unit. NOT `asymmetricSlots` — swapping A with B is swapping B with A, so the
    // enumerator's default pruning of one ordering is correct here and doubling the
    // variants would offer the player a distinction that does not exist. That is
    // the opposite call from Convergent Mutation above, whose slot 0 is the
    // beneficiary and slot 1 only a measurement.
    targeting: { kind: "unitSlots", slots: ["friendly", "friendly"], min: 2, scope: "anywhere" },
    resolve: (state, ctx, event) => {
      const first = event.targetUnitInstanceId ? findUnitAnywhere(state, event.targetUnitInstanceId) : undefined;
      const second = event.secondTargetUnitInstanceId
        ? findUnitAnywhere(state, event.secondTargetUnitInstanceId)
        : undefined;
      const swapped = smokeAndMirrorsSwap(state, first, second);
      return drawCards(swapped, ctx.casterIndex, 1);
    },
  },
};

/** Where a unit stands, as the ONE value "a different location" is compared on —
 *  a battlefield id, or the owner's base. 198.1: "Locations include the
 *  Battlefields and the Bases", so two units in one base share a location and are
 *  NOT a legal Smoke and Mirrors pair, while a base unit and a battlefield unit
 *  are. Both units here are the caster's own, so one "base" token is enough; a
 *  card that could name both players' units would need the owner in the key. */
function locationKeyOf(state: GameState, location: AnyUnitLocation): string {
  return location.zone === "base" ? "base" : state.battlefields[location.zone.battlefieldIndex]!.id;
}

/**
 * Smoke and Mirrors' swap, split out so the guard and the two moves read in one
 * place rather than inside a ternary chain.
 *
 * Returns the state UNCHANGED for every case the instruction cannot be performed
 * — a target that left play (359.3.e), two units at the same location, or neither
 * carrying `[Temporary]`. The caller draws regardless, which is the point of
 * separating them.
 */
function smokeAndMirrorsSwap(
  state: GameState,
  first: AnyUnitLocation | undefined,
  second: AnyUnitLocation | undefined,
): GameState {
  if (!first || !second) return state;
  const firstAt = locationKeyOf(state, first);
  const secondAt = locationKeyOf(state, second);
  // **MEASURED REDUNDANT against today's helpers, and labelled rather than left
  // implying it is load-bearing** — the convention `holdMoveEvents` already
  // follows for its own `from === to`. A mutation that deleted this line survived
  // the whole file's suite: `forceMoveToBattlefield` returns early when the unit
  // is already at the destination, and `forceMoveToBase` finds its subject with
  // `findUnitOnBattlefield`, so a base unit "moved" to base is a no-op too.
  // Neither increments `movesThisTurn` on the way out.
  //
  // Kept because it is the printed restriction ("at a DIFFERENT location") said in
  // the one place this file can say it, and because a future move helper without
  // those early-outs would otherwise fire two phantom `unitMoved` events.
  if (firstAt === secondAt) return state;
  const temporary =
    hasKeyword(state, first.unit, first.ownerIndex, "Temporary") ||
    hasKeyword(state, second.unit, second.ownerIndex, "Temporary");
  if (!temporary) return state;
  // Captured above, so the second move still reads the ORIGINAL destination after
  // the first unit has already been placed.
  const moveTo = (next: GameState, instanceId: string, to: string): GameState =>
    to === "base" ? forceMoveToBase(next, instanceId) : forceMoveToBattlefield(next, instanceId, to);
  return moveTo(moveTo(state, first.unit.instanceId, secondAt), second.unit.instanceId, firstAt);
}

/** The gear cards in `playerIndex`'s own trash — Aspiring Engineer's "a gear
 *  from your trash".
 *
 *  Its own function because the TRIGGER asks whether there is anything worth
 *  asking about and the DECISION asks what the answers are, and those two
 *  drifting apart is precisely how a question gets parked that nothing can
 *  answer — `advanceDecisions` would drop it silently and the card would report
 *  implemented. Same reason `evolutionaryCandidates` above is shared. */
function gearsInTrash(state: GameState, playerIndex: 0 | 1) {
  return state.players[playerIndex].trash.filter((c) => c.kind === "Gear");
}

/** The Mechs Bubble Bot could ready — "ANOTHER friendly Mech", exhausted ones
 *  only (see her entry for why the exhaustion filter is unobservable). Shared by
 *  her trigger and her decision for the same reason `gearsInTrash` is.
 *
 *  "Another" excludes her as an OBJECT, by instanceId — two Bubble Bots each
 *  satisfy the other's "another", which a defId comparison gets exactly
 *  backwards. Same reading granted-keywords.ts takes for "other friendly units". */
function readyableMechs(state: GameState, playerIndex: 0 | 1, selfInstanceId: string) {
  return ownUnitsEverywhere(state, playerIndex).filter(
    (u) => u.instanceId !== selfInstanceId && u.exhausted && isMechUnit(state, u),
  );
}

/** Frostcoat Cub's paid-for debuff, as a POSITIVE number — the sign is applied
 *  at the call site so the floor argument beside it reads plainly. */
const FROSTCOAT_DEBUFF = 2;

/** Pickpocket's "a gear with Energy cost no more than [1]" — the printed
 *  ceiling, inclusive ("no more than"). */
const PICKPOCKET_MAX_GEAR_COST = 1;

/**
 * The units Bard - Mercurial could still move to `battlefieldId` - every unit its
 * controller has anywhere ELSE, base included.
 *
 * "YOUR units" says nothing about where they are or what they are, so a Recruit
 * token sitting at home and a Champion at another battlefield are equally
 * eligible. Deliberately NOT filtered to tokens, which is the one difference from
 * Azir - Sovereign's `movableTokensFor`.
 *
 * Units already standing there are excluded, and that is what makes "any number"
 * terminate: every answer that moves one shortens this list.
 */
function movableUnitsFor(state: GameState, playerIndex: 0 | 1, battlefieldId: string): UnitInstance[] {
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  const here = new Set((bf?.units[state.players[playerIndex].id] ?? []).map((u) => u.instanceId));
  return ownUnitsEverywhere(state, playerIndex).filter((u) => !here.has(u.instanceId));
}

/** The top 4 of `playerIndex`'s Main Deck — Fate Weaver's look. Its own function
 *  because BOTH her trigger (is there anything to look at?), her question's
 *  options (which of them may be taken?) and its answer (what is "the rest"?)
 *  have to mean the same four cards; the two drifting apart is how a question
 *  gets parked that nothing can answer, exactly as `gearsInTrash` records.
 *
 *  A deck shorter than four looks at what it has (422/436.4's do-as-much-as-you-can
 *  shape), which is also why the count is read off the slice rather than assumed. */
function fateWeaverLooked(state: GameState, playerIndex: 0 | 1) {
  return state.players[playerIndex].deck.slice(0, FATE_WEAVER_LOOK);
}

/** "A spell with Energy cost [4] or more from among them" — the PRINTED cost,
 *  which is what every other effect asking about a card's cost reads (206: a
 *  card's cost for reference purposes is what it prints, not what a discount made
 *  this play of it), and inclusive, as "or more" says. */
function fateWeaverCandidates(state: GameState, playerIndex: 0 | 1) {
  return fateWeaverLooked(state, playerIndex).filter(
    (c) => c.kind === "Spell" && c.energyCost >= FATE_WEAVER_MIN_SPELL_ENERGY,
  );
}

/** Every unit `playerIndex` has standing at `destination` — Chakram Dancer's
 *  "your other units HERE", where "here" is wherever she landed. Base is a real
 *  answer rather than a degenerate one: `UnitPlayDestination` is base-or-a-
 *  battlefield, and Sprite Mother (OGN-106) already reads "here" that way. */
function ownUnitsAtDestination(state: GameState, playerIndex: 0 | 1, destination: UnitPlayDestination): UnitInstance[] {
  const owner = state.players[playerIndex];
  if (destination === "base") return owner.baseUnits;
  return state.battlefields.find((bf) => bf.id === destination.battlefieldId)?.units[owner.id] ?? [];
}

export const unitTriggers: Record<string, UnitTriggerDefinition> = {
  [JAYCE_INVENTOR]: {
    // Jayce, Brilliant Inventor — "When you play me OR the first time you play a
    // non-token gear each turn, you may ready something besides me that's
    // exhausted."
    //
    // **ONE ability with two moments**, and this engine has no table keyed by
    // both: on-play lives here (keyed by the arriving unit) and the gear half is
    // a `cardPlayed` listener in `eventTriggers` below. Registered twice, parking
    // the SAME question kind — the shape Kennen, Keeper of Balance's entry sets
    // out, and what keeps the two moments from drifting into two different
    // offers.
    //
    // "You MAY" is 402.1, decided at resolution, so it parks a question rather
    // than firing. "SOMETHING besides me that's exhausted" is a unit OR a gear,
    // either side's, minus himself — the filtering lives in the decision's option
    // list, which is rebuilt from live state so a unit readied by something else
    // in the response window is simply no longer offered.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId) =>
      parkDecision(state, { kind: JAYCE_READY, playerIndex: ctx.casterIndex, cardInstanceId: unitId }),
  },
  "VEN-048": {
    // Cloud Drake — "When you play me, draw 1."
    //
    // A 6-Energy 5-Might body with a cantrip stapled on, and the whole card is
    // the one call.
    targeting: { kind: "none" },
    resolve: (state, ctx) => drawCards(state, ctx.casterIndex, 1),
  },
  "VEN-058": {
    // Patched Porobot — "(I enter exhausted.) When you play me, if you control 3
    // or more OTHER gear, draw 1."
    //
    // **"(I enter exhausted.)" is REMINDER TEXT, not a clause** — the
    // parentheses are the tell, and units enter exhausted by default. Nothing is
    // owed for it, which is worth saying because the Hextech Formula in this same
    // wave prints the same sentence WITHOUT parentheses and does owe a
    // `deploy.ts` row: gear enter READY by default, so for a gear it is a real
    // replacement on entry (369.3).
    //
    // **"OTHER gear" is the whole condition and the Porobot is a UNIT**, so
    // "other" costs nothing here: it can never be in `activeGear` to be counted.
    // Written as a plain count for that reason, and said out loud because the
    // next reader will check.
    //
    // Gear TOKENS count. The card says "gear" without qualification, and the Gold
    // tokens are gear (185.1 makes each token its own game object); a card that
    // meant non-token gear says so, as Ornn's Forge and Swain do in this very
    // wave.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      state.players[ctx.casterIndex].activeGear.length >= PATCHED_POROBOT_GEAR
        ? drawCards(state, ctx.casterIndex, 1)
        : state,
  },
  "SFD-079": {
    // Bard - Mercurial - "You may exhaust your legend as an additional cost to
    // play me. When you play me, if you paid the additional cost, move any number
    // of your units to an open battlefield."
    //
    // # The cost
    //
    // `costExhaustsLegend` (card-effects.ts), and it is a BOOLEAN rather than a
    // `UnitCostSpec` because a player has exactly one Legend - there is nothing to
    // choose, which is `OPTIONAL_POWER_COSTS`' shape rather than
    // `OPTIONAL_UNIT_COSTS`'. See that set's own note.
    //
    // # The move, which is the hard half
    //
    // **"An OPEN battlefield" is rule 170.11.c** - "unoccupied AND uncontrolled" -
    // and `isOpenBattlefield` is already that predicate, written for Sai Scout and
    // Sneaky Deckhand's placement grant. Both halves matter: a battlefield can be
    // uncontrolled with units standing on it, and a controlled one can be
    // momentarily empty before the Cleanup lapses it.
    //
    // **Asked rather than fanned out**, and here that is forced rather than
    // chosen. Bard is a UNIT, so `destinationBattlefieldId` on his play action
    // already means "reinforce to this battlefield" - the field a move would have
    // ridden is taken, and it means something else. The choice space is also a
    // subset product (which battlefield x which subset of your units), which is
    // exactly what `unitList`'s own note says the enumerator samples rather than
    // enumerates.
    //
    // So it is two questions: WHERE, then WHICH, the second re-parking itself with
    // a standing "stop" - Azir - Sovereign's "any number of your token units"
    // shape, one file over, and it terminates for the same reason his does. With
    // exactly one open battlefield the first question has one option and
    // `advanceDecisions` retires it unasked.
    //
    // **The destination is captured at the first answer**, not re-derived at the
    // second: the units arriving make it no longer open, so a question that
    // re-asked would offer nothing after the first move.
    //
    // "YOUR units" - every unit the caster controls, base and battlefields alike,
    // and Bard himself among them if he was played to a battlefield. Nothing in
    // the sentence excludes him.
    targeting: { kind: "none" },
    resolve: (state, ctx, _unitId, event) => {
      if (!event.exhaustLegendPaid) return state;
      // No open battlefield is not a question. A trigger that resolves to nothing
      // still closes the chain, so asking would cost both players a PassFocus for
      // an empty list.
      if (state.battlefields.filter(isOpenBattlefield).length === 0) return state;
      return parkDecision(state, { kind: "SFD-079-where", playerIndex: ctx.casterIndex });
    },
  },
  "SFD-084": {
    // Jayce - Man of Progress — "When you play me, you may kill a friendly gear.
    // If you do, you may play a gear with Energy cost no more than [7] from hand
    // this turn, ignoring its Energy cost. (You must still pay its Power cost.)"
    //
    // **The odd one among the pool's free-play cards.** Every other "play a card
    // ignoring its cost" happens as the granting card RESOLVES, so it needs no
    // state; Jayce's is a permission that stays open for the rest of the turn.
    // It therefore lands on `PlayerState.freeGearPlaysThisTurn` and is read by
    // `modifiedEnergyCost`, the one place a card's Energy is priced.
    //
    // "If you do" ties the permission strictly to the kill, so it is granted in
    // the decision's paying branch and nowhere else — declining gives nothing.
    //
    // "a FRIENDLY gear", unlike Pickpocket's unqualified "a gear" one entry
    // below: this one costs you a permanent, which is what makes it a cost
    // rather than removal.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      // No friendly gear is no question — the offer is dropped whole rather than
      // shown as a lone decline, matching every other optional kill here.
      state.players[ctx.casterIndex].activeGear.length === 0
        ? state
        : parkDecision(state, { kind: "SFD-084-kill", playerIndex: ctx.casterIndex }),
  },
  "SFD-074": {
    // Pickpocket — "When you play me, you may kill a gear with Energy cost no
    // more than [1]. If you do, play a Gold gear token exhausted."
    //
    // A parked decision rather than a target on the play action, because "you
    // MAY" with a filtered list of candidates is a question, and the same shape
    // every other optional on-play kill in this pool takes.
    //
    // **"A gear", unqualified — so EITHER side's.** The pool says "a friendly
    // gear" when it means one (Zaun Punk, Legion Quartermaster), and this card
    // does not; killing the opponent's Doran's Ring is the play that makes him
    // worth 3 Energy. Both players' `activeGear` are offered below.
    //
    // "If you do" ties the Gold strictly to the kill: declining gives nothing,
    // which is why the token is minted in the same branch rather than
    // unconditionally.
    targeting: { kind: "none" },
    resolve: (state, ctx) => parkDecision(state, { kind: "SFD-074-kill", playerIndex: ctx.casterIndex }),
  },
  "SFD-067": {
    // Frostcoat Cub — "You may pay [Mind] as an additional cost to play me. When
    // you play me, if you paid the additional cost, give a unit -2 Might this
    // turn."
    //
    // A rune and no Energy, which is Clockwork Keeper's shape exactly.
    //
    // **NO FLOOR, corrected 2026-08-08 after a rules call.** This entry used to
    // pass `giveMightThisTurn` a floor of 1 and justify it as "the card does not
    // print a floor — 707.2 does, since Might cannot fall below 1."
    //
    // **There is no such rule.** Grepped the whole PDF: the only "minimum of 1"
    // anywhere in it is inside a CARD'S PRINTED TEXT in a worked example —
    // Blastcone Fae's "give a unit -2 [M] this turn, to a minimum of 1 [M]" —
    // which proves the opposite of what was claimed, since a card that floors
    // says so and this one does not. That citation was the same defect as the
    // recorded "rule 1678", a number that does not say what it was cited for.
    //
    // What the rules DO say, under the Might property: a unit below 0 "is
    // treated as 0 **when referenced** by spells and abilities... Although the
    // unit's Might is treated as 0, it is not 0. **Effects that calculate Might
    // increases and decreases use the ACTUAL value.**" So the reference is
    // floored and the stored modifier must not be — `effectiveMight`'s own
    // `Math.max(0, m)` is the whole of the floor this card needs.
    //
    // Frigid Touch (SFD-066), in this same file, always read it this way and
    // argued the point at length; the two entries contradicted each other until
    // now. Observable through a later buff: a 1-Might victim at -2 is really -1,
    // so a +3 leaves 2 rather than 4.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, _unitId, event) =>
      event.optionalPowerPaid && event.targetUnitInstanceId
        ? giveMightThisTurn(state, event.targetUnitInstanceId, -FROSTCOAT_DEBUFF)
        : state,
  },
  "OGN-110": {
    // Ekko - Recurrent — "[Accelerate] — Recycle me to ready your runes."
    //
    // Gated on the Accelerate cost having been PAID (805), like Tasty Faefolk.
    //
    // "Recycle ME" is a cost paid with the card itself: he goes from play to the
    // bottom of his owner's Main Deck (416), which is why this is not a death
    // and fires no [Deathknell]. Then every channeled rune readies — the whole
    // pool, which is what makes him a one-shot refuel rather than a body.
    //
    // He readies runes he did not pay for either: the Accelerate cost was
    // already spent by the time this resolves, so the refuel is real.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId, event) => {
      if (!event.acceleratePaid) return state;
      const recycled = recycleUnitFromPlayToDeck(state, ctx.casterIndex, unitId);
      const players = [...recycled.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = {
        ...actor,
        channeled: actor.channeled.map((r) => (r.state === "Exhausted" ? { ...r, state: "Ready" as const } : r)),
      };
      return { ...recycled, players };
    },
  },
  "OGN-097": {
    // Blastcone Fae — "[Hidden] When you play me, give a unit -2 Might this
    // turn, to a minimum of 1 Might."
    //
    // [Hidden] is handled entirely by engine/hidden.ts and the loader; nothing
    // here is aware of it. What DOES follow from it: played from facedown, rule
    // 811 restricts the target to that battlefield, which legal-actions enforces
    // — this resolver takes whatever it is given either way.
    //
    // "A unit", no owner and no battlefield, so scope "anywhere".
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, _ctx, _unitId, event) =>
      event.targetUnitInstanceId ? giveMightThisTurn(state, event.targetUnitInstanceId, -2, 1) : state,
  },
  "OGN-092": {
    // Riptide Rex — "When you play me, deal 6 to an enemy unit at a
    // battlefield."
    //
    // Both restrictions printed: enemy, and at a battlefield. Six is enough to
    // kill almost anything in the pool outright, which is what the
    // battlefield-only clause is balancing.
    targeting: { kind: "unit", owner: "enemy" },
    resolve: (state, ctx, _unitId, event) =>
      event.targetUnitInstanceId ? dealDamage(state, ctx.casterIndex, event.targetUnitInstanceId, 6) : state,
  },
  "OGN-116": {
    // Thousand-Tailed Watcher — "When you play me, give enemy units -3 Might
    // this turn, to a minimum of 1 Might."
    //
    // "Enemy UNITS", not "enemy units here" and not "at a battlefield" — so this
    // reaches the opponent's base as well (355.9.a.1), which is what makes it a
    // board sweep rather than a combat trick.
    //
    // The floor is applied PER UNIT by giveMightThisTurn rather than to the
    // group: a 2-Might unit stops at 1 while a 7-Might one beside it still
    // loses the full 3.
    //
    // giveMightThisTurn, not a Buff — this expires in the Expiration Step
    // (rule 317) when runEnd zeroes every unit's mightThisTurn.
    targeting: { kind: "none" },
    resolve: (state, ctx) => giveMightThisTurnToAllEnemies(state, ctx.casterIndex, -3, 1),
  },
  "OGN-106": {
    // Sprite Mother — "When you play me, play a ready 3 Might Sprite unit token
    // with [Temporary] HERE."
    //
    // The same token Sprite Call makes (SPRITE_TOKEN above), so the spec is
    // shared rather than re-declared: two copies of "3 Might, ready, Temporary"
    // is exactly the drift token.ts's spec parameter was added to prevent.
    //
    // "Here" is wherever SHE landed, which the trigger event already carries as
    // `destination` — Faithful Manufactor's precedent. Played to base, "here" is
    // the base; that is not a special case, it is what `UnitPlayDestination`
    // means. Nothing is chosen, so targeting stays "none".
    //
    // placeToken applies Contested for a battlefield destination (190.3.a), which
    // matters: she can only be played to a battlefield she reinforces or one you
    // control, but a Showdown already staged there is promoted by the token
    // becoming present just as it would be by any other arrival.
    targeting: { kind: "none" },
    resolve: (state, ctx, _unitId, event) => placeToken(state, ctx.casterIndex, event.destination, SPRITE_TOKEN),
  },
  "SFD-061": {
    // Aspiring Engineer — "When you play me, return a gear from your trash to
    // your hand."
    //
    // **Asked as a DECISION rather than as a target, and that is a divergence
    // rather than a preference.** 355.9.a.4 works this exact shape by name — "e.g.
    // 'Recycle a unit from your trash' TARGETS a unit card in your trash" — so the
    // choice belongs to the moment the ability goes on the Chain (355: valid
    // choices must be made for all targets), which is where Annie - Stubborn's
    // identical "a spell from your trash" makes it. The spec that expresses that,
    // `{ kind: "ownTrashCard", cardKind }`, cannot name a GEAR: its `cardKind` is
    // typed "Unit" | "Spell", and widening it is an edit to card-effects.ts, which
    // this pass does not own. So the card is chosen a response window later than
    // the rules place it. Unobservable in this pool — nothing here reaches a
    // trash at reaction speed, and the trash being chosen from is the chooser's
    // own — but it is a divergence and is recorded as one rather than left to be
    // discovered.
    //
    // MANDATORY: no "you may" anywhere in the text, so there is no decline option.
    // A trash with no gear in it asks nothing at all (055's do-as-much-as-you-can),
    // and a trash with exactly one gear is not a question — `advanceDecisions`
    // takes the single option without ever prompting.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      gearsInTrash(state, ctx.casterIndex).length === 0
        ? state
        : parkDecision(state, { kind: "SFD-061-return", playerIndex: ctx.casterIndex }),
  },
  "SFD-062": {
    // Bubble Bot — "When you play me, ready another friendly Mech."
    //
    // A DECISION rather than a target, and here the reason is the TAG.
    // `TargetingSpec`'s unit kind restricts by owner, Might, scope and exhaustion
    // and by nothing else, so the only announce-time spec available is a bare "a
    // friendly unit" — which would enumerate every friendly unit as a legal choice
    // and then quietly do nothing whenever a non-Mech was named. The AI takes the
    // first candidate offered, so that reads as a working card that usually does
    // nothing, which is strictly worse than asking the question one response
    // window late. The lateness is the same 355 divergence Aspiring Engineer
    // records above, and it is slightly more visible here: with an announce-time
    // target, an opponent could kill the named Mech in response and 359.3.e would
    // make this do nothing, whereas a resolution-time chooser simply names another.
    //
    // Only EXHAUSTED Mechs are offered. Rule 415 — "A Unit that is already Ready
    // cannot be Readied again. If a Unit is instructed to be Readied while it is
    // already Ready, nothing additional happens" — makes the two boards identical,
    // `unitReadied` included, since `readyUnit` carries that same guard. What the
    // filter buys is that "no exhausted Mech" and "no Mech at all" ask the same
    // nothing instead of prompting for a choice with no consequence.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId) =>
      readyableMechs(state, ctx.casterIndex, unitId).length === 0
        ? state
        : parkDecision(state, { kind: "SFD-062-ready", playerIndex: ctx.casterIndex, cardInstanceId: unitId }),
  },
  "SFD-072": {
    // Dropboarder — "When you play me, if you control two or more gear, ready me."
    //
    // A unit enters EXHAUSTED (143.4.a), so readying itself IS the card: 4 Energy
    // for a 4-Might body that can move, fight or be spent the turn it lands, but
    // only on a board that has already paid for two gear.
    //
    // "Gear" means gear on the BOARD (355.9.a.1: "'Unit,' 'gear,' and 'rune' refer
    // to objects on the Board unless specified otherwise"), which is `activeGear`
    // — a facedown card at a battlefield is not a gear until it is played, and one
    // in the trash is not one at all.
    //
    // **The "if" is part of the TRIGGER CONDITION, not the effect**, and the rules
    // say so in as many words (383.2.b): "Any additional conditional statement
    // immediately after the Condition must be true in order for the Condition to
    // be fulfilled. Such a conditional statement is part of the Trigger Condition
    // and not the Effect." Their worked example is Sona - Harmonious, whose
    // ability "will still resolve" if she is removed in reaction to it. So the
    // count should be read when the trigger FIRES and not re-asked here.
    // `UnitTriggerDefinition` has no `applies` hook — the event-trigger and
    // on-move families grew one, the on-play family has not — and adding one is an
    // edit to unit-triggers.ts, which this pass does not own. Read at resolution
    // instead, which differs only when a gear enters or leaves play during the
    // response window this trigger's own hold opens. Recorded as a divergence
    // rather than left implicit.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId) =>
      state.players[ctx.casterIndex].activeGear.length >= 2 ? readyUnit(state, unitId) : state,
  },
  "UNL-064": {
    // Fate Weaver — "When you play me, look at the top 4 cards of your Main Deck.
    // You may reveal a spell with Energy cost [4] or more from among them and draw
    // it. Recycle the rest."
    //
    // Stacked Deck's shape with a FILTER and a "you may" on it, which is why the
    // helper it shares (`takeOneFromTopAndRecycleRest`) covers only the accepting
    // branch: declining still has to recycle, and there is no card to keep.
    //
    // **A question, not a target.** 355.10.a says a card in a deck is not a target
    // ("your hand is not a public zone" is the worked case, and a Main Deck is no
    // more Public than a hand), so nothing here belongs on the play action — and it
    // could not ride one anyway, since which four cards they are is not known until
    // this resolves.
    //
    // MANDATORY LOOK, OPTIONAL TAKE, MANDATORY RECYCLE. That is three instructions
    // (135.2), and it is why the question is parked even when no candidate
    // qualifies: "recycle the rest" still has to happen, so a board with nothing
    // takeable parks a one-option question that `advanceDecisions` executes without
    // ever prompting. Skipping the park there would silently drop the recycle.
    //
    // An EMPTY deck is the one case with nothing at all to do — no look, no rest —
    // and 422's do-as-much-as-you-can makes that the whole instruction rather than
    // an error.
    //
    // The look is a LOOK, so Nocturne - Horrifying's "as you look at or reveal me"
    // is owed on all four and is offered FIRST: FIFO answers him before this
    // question, which is the order the two read in, and these options are rebuilt
    // from live state if he banishes himself out of the four.
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const looked = fateWeaverLooked(state, ctx.casterIndex);
      if (looked.length === 0) return state;
      return parkDecision(offerTopOfDeckBanish(state, ctx.casterIndex, looked), {
        kind: "UNL-064-reveal",
        playerIndex: ctx.casterIndex,
      });
    },
  },
  "UNL-084": {
    // Sprite Queen, first moment — "When you play me OR at the start of your
    // Beginning Phase, play a ready 3 [Might] Sprite unit token with [Temporary]
    // to your base."
    //
    // ONE printed instruction with TWO moments, so it is `spriteQueenToken` here
    // and the same function in `eventTriggers` under this defId — two registries,
    // one sentence. Registering in both is legal because the composition throws
    // only on a duplicate WITHIN a registry.
    //
    // The token is `SPRITE_TOKEN` — ready, 3 Might, `[Temporary]` — shared from
    // the top of this file rather than re-declared, which is what stops her
    // Sprite drifting from Sprite Call's and Sprite Mother's.
    //
    // Her printed `[Temporary]` bracket is the TOKEN's, not hers: card-loader's
    // `GRANTED_ONLY_KEYWORDS` already names UNL-084 for exactly that, so a
    // 7-Energy 6-Might body does not quietly kill itself on her controller's next
    // Beginning Phase.
    targeting: { kind: "none" },
    resolve: (state, ctx) => spriteQueenToken(state, ctx.casterIndex),
  },
  "UNL-071": {
    // Chakram Dancer — "[Ambush] [Shield] When you play me, give your other units
    // here [Shield] this turn."
    //
    // **ONE of two clauses, and the other is a KEYWORD this engine does not
    // implement.** `[Ambush]` ("you may play me as a [Reaction] to a battlefield
    // where you have units") is in coverage.ts's `UNIMPLEMENTED_KEYWORDS`, so the
    // card stays flagged as unfinished on its own text whatever is written here —
    // which is the correct report and the reason this half can be landed without
    // over-claiming. Her printed `[Shield]` is the loader's.
    //
    // "HERE" is wherever SHE landed, which the trigger event already carries as
    // `destination` — Sprite Mother's and Faithful Manufactor's precedent. Played
    // to base, "here" is the base; that is not a special case, it is what
    // `UnitPlayDestination` means, and until `[Ambush]` lands it is the ordinary
    // way she arrives.
    //
    // "OTHER" excludes her as an OBJECT, by instanceId — two Chakram Dancers at one
    // battlefield each satisfy the other's "other", which a defId comparison gets
    // exactly backwards. The same reading `readyableMechs` and granted-keywords.ts
    // already take.
    //
    // "YOUR units", so the opponent's bodies at a contested battlefield get
    // nothing — the one word that separates this from a symmetric board effect.
    //
    // `grantKeywordThisTurn` at value 1: 814.1.b.3 says an omitted X is 1, and
    // 814.2 makes an additional source SUM — so a unit that already prints
    // `[Shield 1]` reads 2 while this lasts, which `mergeGrantedKeyword` does
    // rather than this entry. `keywordsThisTurn` is what expires in the Expiration
    // Step (317) when `runEnd` clears it; a write to `keywords` would be permanent.
    targeting: { kind: "none" },
    resolve: (state, ctx, unitId, event) =>
      ownUnitsAtDestination(state, ctx.casterIndex, event.destination)
        .filter((u) => u.instanceId !== unitId)
        .reduce((next, u) => grantKeywordThisTurn(next, u.instanceId, "Shield", 1), state),
  },
  "SFD-081": {
    // Card Sharp — "When you play me, you and each opponent may play a Gold gear
    // token exhausted. For each opponent who did, you play a Gold gear token
    // exhausted."
    //
    // A Group Hug that pays you for being taken up, and the second sentence is
    // what makes the opponent's "may" a real question: accepting hands them a
    // rainbow Power and hands the CASTER one as well, so declining is a genuine
    // play rather than a formality. Party Favors (OGN-071) is the precedent for
    // asking the opponent a question on your own card at all.
    //
    // **Two parked questions, caster first.** "You and each opponent" is this
    // engine's APNAP convention (active player first), and the caster IS the
    // active player here — Card Sharp is a plain Unit with no printed [Action] or
    // [Reaction], so it can only be played on its controller's own turn. Text
    // order and APNAP therefore agree and nothing rests on which one is being
    // followed.
    //
    // Sequential rather than simultaneous, which is the one visible divergence:
    // the queue asks the caster, then the opponent, so the opponent answers
    // knowing what the caster chose. There is one decision queue and no
    // simultaneous-choice primitive; Promising Future records the identical shape
    // two entries up. Here it costs less than it does there — neither answer
    // constrains the other, and the caster's choice tells the opponent nothing
    // they could act on.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      [
        { kind: "SFD-081-mine", playerIndex: ctx.casterIndex } as const,
        { kind: "SFD-081-theirs", playerIndex: (1 - ctx.casterIndex) as 0 | 1 } as const,
      ].reduce((acc, seed) => parkDecision(acc, seed), state),
  },
  "UNL-081": {
    // Keeper of Masks — "[Hidden] [Temporary] When you play me, play two
    // Reflection unit tokens here. They become copies of me."
    //
    // Her two keywords are not this entry's: `[Hidden]` is engine/hidden.ts's and
    // `[Temporary]` is `killTemporaryPermanents`, which reads printed `keywords`
    // on the instance. She really does kill herself — the reminder text says "kill
    // ME" — so unlike Sprite Queen's, this bracket is NOT the token's and she needs
    // no `GRANTED_ONLY_KEYWORDS` row.
    //
    // "HERE" is wherever she landed, which the trigger event already carries as
    // `destination` — Chakram Dancer's and Sprite Mother's precedent. From Hidden
    // that is always the battlefield she was hidden at (811.1.d.1).
    //
    // # What a "copy" is, and the one number that is NOT one
    //
    // **477.1.b.1.a lists the copyable traits exactly: Name, Super Type, Type,
    // Tags, Cost, Domain, Rules Text. MIGHT IS NOT AMONG THEM**, and its absence
    // reads as deliberate rather than as an omission: the sibling layer 477.1.a
    // carries a dedicated sub-rule 477.1.a.1 ("Assignment of Might is dealt with in
    // this layer") and the copy sub-rule has no equivalent. 187.6 then fixes what
    // the body actually is — "A 0 [M] Reflection token is a domainless unit token
    // with 0 Might" — and nothing in the copy raises it. So each Reflection here is
    // a 0-Might body carrying her rules text, NOT a second 1-Might Keeper.
    //
    // Verified against `pdftotext -raw` AND `-layout`, because a 0-Might copy is
    // surprising enough to look like a mis-extraction. Both emit the same
    // seven-item list. Named as a constant so a ruling the other way is one line.
    //
    // What the copied Rules Text is worth on the board is `[Temporary]`: the two
    // Reflections die with her at the start of her controller's next Beginning
    // Phase, before scoring (816). `[Hidden]` is carried for faithfulness and is
    // inert by 811.1.b, which scopes it to "while this card is in your hand or in
    // your Champion Zone" — nothing on the Board can use it.
    //
    // **Their own "when you play me" does NOT re-fire, and that is structural
    // rather than a guard.** The tokens are played and THEN become copies (477.1.b
    // is a layer, not a play), so the trigger moment is over before they have the
    // text. It is also true by construction here: `placeToken` is not a play path,
    // so `dispatchOnPlayUnit` never sees them and there is no recursion to bound.
    //
    // # The token is a SPEC, not a real Layer-1 copy
    //
    // **DIVERGENCE, and it is the mechanism rather than this card's outcome.**
    // `TokenSpec` carries name, Might, tag and keywords, so the four copied traits
    // that are observable in this pool land exactly. The three that do not are
    // Cost (185.3.a.2 appends it; Atakhan's "I cost [1] less for each Energy it
    // costs" is the only card that could read it, and 185.3.a.1's "treated as 0"
    // is what the token keeps), Domain, and Super Type. A general copy — LeBlanc -
    // Deceiver and Mirror Image copy an ARBITRARY unit, not a known one — needs a
    // real copy field on `UnitInstance` and belongs in token.ts/card.ts, neither
    // of which this file owns. Keeper is the one copy in the pool whose subject is
    // known at authoring time, which is why she can be written without it.
    targeting: { kind: "none" },
    resolve: (state, ctx, _unitId, event) =>
      Array.from({ length: KEEPER_REFLECTIONS }).reduce<GameState>(
        (next) => placeToken(next, ctx.casterIndex, event.destination, KEEPER_REFLECTION_TOKEN),
        state,
      ),
  },
};

/** Ruined Rex's damage, and the reason his Deathknell asks rather than picks. */
const RUINED_REX_DAMAGE = 4;

/** Spectral Centaur's pump per friendly death — "+2 Might this turn", uncapped. */
const SPECTRAL_CENTAUR_MIGHT = 2;

/** Icevale Archer's optional Energy price, and her debuff as a POSITIVE number —
 *  the sign is applied at the call site so the (absent) floor reads plainly. */
const ICEVALE_ENERGY_COST = 1;
const ICEVALE_DEBUFF = 1;

/** Diana - Lunari's optional Energy price — "you may pay [1]. If you do, ...". */
const DIANA_LUNARI_ENERGY = 1;

/** Hwei - Brooding Painter's two magnitudes: "Gear — Ready up to 2 runes" and
 *  "Unit — Give me +3 [Might] this turn". The Spell branch is a bare "Draw 1". */
const HWEI_RUNES = 2;
const HWEI_MIGHT = 3;

/** Every unit the OTHER player has in play, base included — Ruined Rex's "an
 *  enemy unit", which prints no location and so reaches base (355.9.a.1). Shared
 *  between his trigger, which asks whether there is anything worth asking about,
 *  and his decision, which asks what the answers are; the two drifting apart is
 *  how a question gets parked that nothing can answer, exactly as `gearsInTrash`
 *  above records. */
function enemyUnitsOf(state: GameState, ownerIndex: 0 | 1): UnitInstance[] {
  return ownUnitsEverywhere(state, (1 - ownerIndex) as 0 | 1);
}

/** [Deathknell] effects — rule 808, "When I die, [Effect]". Keyed by the DYING
 *  card's defId. Same one-file-one-owner rule as the registries above. */
export const deathTriggers: Record<string, DeathknellDefinition> = {
  // Watchful Sentry — "[Deathknell] — Draw 1." (rule 808, "When I die, [Effect]".)
  //
  // The DYING unit's controller draws, not whoever killed it: dispatchOnUnitDied
  // builds this ctx from `death.ownerIndex`, which is the whole reason a
  // Deathknell is keyed by the dying card rather than walked as a listener.
  // Killing a Sentry therefore pays its owner, which is what makes a 2-Energy
  // 1-Might body worth playing at all.
  //
  // Nothing here is conditional on HOW it died: 808 is every death, and the
  // funnel dispatchOnUnitDied sits behind (damage, destroy, combat) is what
  // makes that true rather than three separate sites remembering to fire.
  "OGN-096": { resolve: (state, ctx) => drawCards(state, ctx.casterIndex, 1) },

  // Ruined Rex — "[Deathknell] — Deal 4 to an enemy unit. (When I die, get the
  // effect.)"
  //
  // "AN ENEMY UNIT", with no location clause at all, so scope is everywhere:
  // 355.9.a.1's list of Public zones names Bases alongside Battlefield Zones, and
  // the pool says "at a battlefield" (Riptide Rex, one registry up) or "in a
  // base" (Yone - Blademaster) when it means one. 4 is enough to reach a unit
  // that has been parked at home all game, which is the card.
  //
  // "Enemy" is measured from the DYING Rex's controller, which is what
  // `resolveHeldDeathknell` builds the context from (`death.ownerIndex`) — so a
  // Rex killed by his own player's board wipe still shoots the opponent.
  //
  // A parked DECISION rather than the auto-selection Yasuo, Ahri and Teemo use:
  // those three have no queue-shaped moment to ask in, and this one does —
  // Undercover Agent's Deathknell already stops to ask two discards, which is the
  // proof a Deathknell can. Recurve Bow's entry (effects/fury.ts) records the same
  // preference for the same reason: auto-selection would be a SECOND divergence on
  // top of the one every held trigger already carries (the choice is made at
  // resolution rather than as the ability goes on the Chain, 355). A lone enemy is
  // taken by `advanceDecisions` without ever prompting.
  //
  // MANDATORY — no "you may" is printed, so the decision offers no decline. An
  // empty enemy board asks nothing at all (055's do-as-much-as-you-can) rather
  // than parking a question with no options, which `advanceDecisions` would drop
  // silently.
  "UNL-067": {
    resolve: (state, ctx) =>
      enemyUnitsOf(state, ctx.casterIndex).length === 0
        ? state
        : parkDecision(state, { kind: "UNL-067-shot", playerIndex: ctx.casterIndex }),
  },
};

/**
 * Deadly Flourish's delayed trigger, written onto the unit it damaged.
 *
 * One function rather than two literals, because the writer (the spell's
 * resolver) and the reader (its death-watch, firing from the caster's trash) are
 * 900 lines apart and a key that drifts is a card that pays nothing while
 * reporting done.
 *
 * # What each part of the key is for
 *
 * The **spell instance** scopes it to ONE Flourish. Two Flourishes on one victim
 * are two delayed abilities and pay two Gold tokens, which is what 390.2 makes
 * them: each is its own trigger, not a re-arming of the other.
 *
 * The **turn** is the "this turn" in the printed text, and it has to be in the
 * key rather than checked separately because nothing sweeps it off a victim that
 * has left the board — see the card's own entry for the measurement.
 * `activePlayerIndex` rides along because `turnNumber` counts ROUNDS, not turns
 * (`turn-manager`'s runEnd bumps it only when play returns to the first player),
 * so the number alone would let a mark survive from one player's turn into the
 * other's.
 *
 * **Not exhaustive, and knowingly so:** an extra turn (Time Warp) repeats both
 * halves of the key, so a victim that reached a non-board zone on the first of
 * two consecutive turns and came back could still match. That needs a zone-change
 * hook — rule 124's "becomes a new object" — which lives in effect-helpers.ts and
 * is not this file's. Recorded in docs/rules-conformance.md rather than left in a
 * comment.
 */
function deadlyFlourishMark(state: GameState, spellInstanceId: string): string {
  return delayedDeathMark(state, DEADLY_FLOURISH, spellInstanceId);
}

/**
 * Takes Deadly Flourish's mark back off the card it paid for, wherever that card
 * has come to rest.
 *
 * The trash, in practice: `completeDeath` has already filed the victim there by
 * the time a death-watch resolves, and it preserves `abilityModesUsedThisTurn`
 * along with everything else on the instance.
 *
 * **Rule 124 is why this is here at all.** A card played back out of the trash on
 * the same turn — Last Rites grants exactly that — is "a new object for the
 * purposes of tracking that object", so the Flourish that already paid must not
 * pay again when the new object dies. Without this the mark would still be on the
 * instance and would still match its own turn's key.
 *
 * Only THIS spell's mark is removed, so a second Flourish on the same victim
 * keeps its own.
 */
function forgetDeadlyFlourishMark(state: GameState, ownerIndex: 0 | 1, unitInstanceId: string, mark: string): GameState {
  return forgetDelayedDeathMark(state, ownerIndex, unitInstanceId, mark);
}

/** Listeners for board EVENTS other than a death (see triggers.ts's GameEvent).
 *  Keyed by the LISTENING card's defId. Same one-file-one-owner rule. */
/** Listeners for someone ELSE dying ("when a buffed friendly unit dies"), keyed
 *  by the LISTENING card's defId. Distinct from `deathTriggers` above, which is
 *  a [Deathknell] keyed by the DYING card. Same one-file-one-owner rule. */
export const deathWatchTriggers: Record<string, DeathWatchDefinition> = {
  [NASUS_GUARDIAN]: {
    // Nasus, Guardian of Knowledge — "Once each turn, when an enemy unit HERE
    // dies, channel 1 rune exhausted."
    //
    // # Three narrowings, and each is asked where it can still be answered
    //
    // "ENEMY" and "HERE" are facts about the DEATH, so they live in `applies`:
    // 808.1.d.3 snapshots the dying unit before it reaches the trash, and the
    // battlefield it died at is on the `DeathContext`. Asking either at
    // resolution would be asking about a board the unit has already left — and
    // `applies` is also where they belong for the reason that field's own note
    // gives, that a listener whose printed condition is unmet must place NO
    // Pending Item rather than one that costs both players a PassFocus and then
    // resolves to nothing.
    //
    // "ONCE EACH TURN" is different: it is a fact about NASUS, and it is SPENT
    // rather than merely read. It is checked here too, because a second death in
    // the same turn must not place a second Pending Item.
    //
    // **The mark is written in `resolve`, not in `applies`.** `applies` is asked
    // by the trigger walk and its answer must not depend on how many times it has
    // been asked; spending the turn there would make one listener's question
    // change the next one's answer. 383's window is also real — the trigger is
    // HELD, and only its resolution is the moment the ability happens.
    applies: (state, listener, death) =>
      death.ownerIndex !== listener.ownerIndex &&
      death.battlefieldId !== undefined &&
      listener.battlefieldId === death.battlefieldId &&
      !nasusHasChannelled(state, listener.card.instanceId),
    resolve: (state, listener) => {
      // Re-asked at resolution, because two enemy units dying at once hold two
      // Pending Items and the first to resolve is the one that spends the turn.
      if (nasusHasChannelled(state, listener.card.instanceId)) return state;
      return channelRunesExhausted(markNasusChannelled(state, listener.card.instanceId), listener.ownerIndex, 1);
    },
  },
  "UNL-073": {
    // Deadly Flourish's second sentence — "When it dies this turn, play a Gold
    // gear token exhausted." The first is in `cardEffects`, which is where the
    // whole card is explained; this end only reads the mark that one wrote.
    //
    // **The listener is a SPELL in a trash**, which is why `TRASH_LISTENER_DEF_IDS`
    // had to name it: `allListeningPermanents` walks the board plus that named
    // set, and the Flourish is in its caster's trash from the moment it was
    // played. Nothing on the board could stand in for it — the victim itself is
    // gone by the time `completeDeath` fires the event.
    //
    // The mark is read off `death.unit`, the snapshot 808.1.d.3 requires be taken
    // "before the card is moved to the Trash", so this is a fact about the death
    // and settles whether the ability TRIGGERED at all — the same place every
    // other death-watch in this file and in triggers.ts puts its printed
    // conditions. `state` is the board as the unit died, so the turn half of the
    // key is asked against the turn the death happened on, which is exactly the
    // printed "this turn".
    applies: (state, listener, death) =>
      death.unit.abilityModesUsedThisTurn.includes(deadlyFlourishMark(state, listener.card.instanceId)),
    // The Gold goes to the FLOURISH's controller — "play a Gold gear token" with
    // no owner word is the ability's controller playing it, and a trash listener's
    // `ownerIndex` is whose trash it is. Exhausted, as printed, which
    // `placeGoldTokens` already does for every Gold in the pool.
    resolve: (state, listener, death) =>
      placeGoldTokens(
        forgetDeadlyFlourishMark(
          state,
          death.ownerIndex,
          death.unit.instanceId,
          deadlyFlourishMark(state, listener.card.instanceId),
        ),
        listener.ownerIndex,
        1,
      ),
  },
  "UNL-068": {
    // Spectral Centaur — "When ANOTHER friendly unit dies, give me +2 Might this
    // turn."
    //
    // Wraith of Echoes' shape (triggers.ts's DEATH_WATCH) with the per-turn flag
    // taken off: nothing here says "the first time each turn", so a combat that
    // kills three friendly units feeds him three times, +6 for the turn. That is
    // the card — a 6-Energy 5-Might body that grows out of its own side's losses.
    //
    // "FRIENDLY" is relative to the LISTENER, which is why a death-watch is handed
    // both: the Centaur cares about his own controller's units, not the dying
    // unit's view of the world.
    //
    // **"ANOTHER" is by INSTANCE, not by card.** Trusty Ramhound's reading, and
    // the same reason: two Centaurs each satisfy the other's "another", which a
    // defId comparison gets exactly backwards. Unreachable today for a different
    // reason — `completeDeath` files the corpse before `holdUnitDied` walks the
    // listeners, so a dying Centaur is not among them and could not pump himself
    // anyway — but the exclusion states the card's word at the place it applies
    // rather than resting on that ordering, which is not this file's to hold still.
    //
    // Both conditions are facts about the DEATH (808.1.d.3 captured them before
    // the card reached the trash), so both settle whether the ability TRIGGERED
    // and neither is re-asked at resolution.
    applies: (_state, listener, death) =>
      death.ownerIndex === listener.ownerIndex && death.unit.instanceId !== listener.card.instanceId,
    // `giveMightThisTurnToOwnUnit` rather than `giveMightThisTurn`, and the guard
    // is the point: "give ME" is an instruction about a body, and a Centaur who
    // left play inside the response window this hold opens is no longer one
    // (359.3.e). The helper answers "is this still my unit in play" in one call.
    //
    // giveMightThisTurn, NOT a Buff — "this turn" expires in the Expiration Step
    // (317), which runEnd gets for free by zeroing every unit's mightThisTurn.
    resolve: (state, listener) =>
      giveMightThisTurnToOwnUnit(state, listener.ownerIndex, listener.card.instanceId, SPECTRAL_CENTAUR_MIGHT),
  },
};

/**
 * Teemo - Strategist's reveal — "reveal the top 5 cards of your Main Deck. Deal
 * damage equal to the number of `[Hidden]` cards among them to an enemy unit
 * here, then recycle them."
 *
 * Extracted from his trigger so Void Hatchling can run its look-and-recycle
 * first: this function is both the inline path and the body of the
 * `OGN-121-reveal` continuation, which makes the two identical by construction
 * rather than by two copies agreeing.
 */
function teemoStrategistReveal(state: GameState, ownerIndex: 0 | 1, battlefieldId: string): GameState {
  const owner = state.players[ownerIndex];
  // "Reveal the top 5" — revealing moves nothing (425: "Cards remain in the
  // zone they are being Revealed from"), so these are still the top of the
  // deck while the damage is dealt, and only the recycle below moves them.
  const revealed = owner.deck.slice(0, 5);
  if (revealed.length === 0) return state; // nothing revealed, nothing to recycle
  const registry = defaultCardRegistry();
  const hiddenCount = revealed.filter((c) => isHiddenCard(registry.tryGet(c.defId))).length;
  // "As you look at or REVEAL me" — this is the reveal half of Nocturne's
  // trigger, and the only two sites where it fires are this and Grasping
  // Roots' reveal-until-a-unit. Offered AFTER the reveal rather than before
  // it, because unlike the four look sites nothing here stops to ask: the
  // count and the recycle are both done by the time a player could answer.
  // His decision names the card instance for exactly that reason.

  // "An enemy unit HERE" — the first at this battlefield in board order,
  // auto-selected rather than asked. Same simplification, and the same
  // structural reason, as Yasuo - Remorseful, Crackshot Corsair and Leona -
  // Determined; filed Unverified in docs/rules-conformance.md.
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  const enemy = Object.entries(bf?.units ?? {})
    .filter(([id]) => id !== owner.id)
    .flatMap(([, units]) => units)[0];

  const damaged =
    enemy !== undefined && hiddenCount > 0 ? dealDamage(state, ownerIndex, enemy.instanceId, hiddenCount) : state;

  // Recycled by instance id off the POST-damage deck rather than by
  // re-slicing the top 5, because the deal runs the full death funnel and
  // that funnel can reach a deck: `[Deathknell]` draws exist (Watchful
  // Sentry, in this file). **Stated as unexercised rather than claimed:** no
  // card in this pool is known to draw from TEEMO'S controller's deck off an
  // enemy unit's death — a Deathknell pays its own owner — so the difference
  // between this and a re-slice is unreachable today. It is written this way
  // because a re-slice would silently recycle a card that was never revealed
  // the day such a card lands, and filtering costs nothing.
  const after = damaged.players[ownerIndex];
  const revealedIds = new Set(revealed.map((c) => c.instanceId));
  const survivors = after.deck.filter((c) => revealedIds.has(c.instanceId));
  if (survivors.length === 0) return damaged;
  const players = [...damaged.players] as [PlayerState, PlayerState];
  players[ownerIndex] = {
    ...after,
    deck: [...after.deck.filter((c) => !revealedIds.has(c.instanceId)), ...survivors],
  };
  const shuffled = holdCardsRecycled({ ...damaged, players }, ownerIndex, survivors.length);
  return revealedFromDeck(shuffled, ownerIndex, revealed);
}

/**
 * Plundering Poro — "When I conquer, play a Gold gear token exhausted."
 *
 * "When I conquer" is the POSITIONAL reading, identical to Kai'Sa - Evolutionary's:
 * the Poro has to be standing AT the battlefield taken. That is what separates a
 * unit's own conquest ("when I") from a Legend's or Super Mega Death Rocket's
 * "when YOU conquer", which the same `battlefieldConquered` event serves and which
 * each card asks for itself.
 *
 * Nothing is chosen and nothing is conditional, so the whole card is one call: the
 * token is the Poro's payout for having been the body that took the battlefield,
 * and 2 Energy for a 2-Might unit is priced against it.
 *
 * **ONE definition, registered under TWO defIds** — SFD-069 and UNL-222, the
 * Unleashed Overnumbered reprint. Same name, same 2/2 line, same sentence, and
 * `unl.json` gives it its own collector number, so coverage (which is per defId)
 * needs both keys or the reprint reports unimplemented while working. Written once
 * because two identical literals is exactly the drift `MECH_TOKEN` and
 * `SPRITE_TOKEN` were shared from one place to prevent; a future erratum to one
 * printing is the only thing that would split them, and that is a change to make
 * then rather than to pre-empt now.
 */
const plunderingPoroConquer: EventTriggerDefinition = {
  on: "battlefieldConquered",
  applies: (_state, listener, event) =>
    event.kind === "battlefieldConquered" &&
    event.conquerorIndex === listener.ownerIndex &&
    listener.battlefieldId === event.battlefieldId,
  resolve: (state, listener, event) => {
    if (event.kind !== "battlefieldConquered") return state;
    // The conqueror is a fact about the EVENT, so re-asking it is free and cannot
    // come to a different answer across the response window. The POSITION
    // deliberately is not re-asked: 383 fixes what triggered at the moment of the
    // event, and an opponent moving the Poro off the battlefield in response must
    // not cancel a trigger that has already fired.
    if (event.conquerorIndex !== listener.ownerIndex) return state;
    return placeGoldTokens(state, listener.ownerIndex, 1);
  },
};

/** Every unit of EITHER side standing at `battlefieldId` — Icevale Archer's "a
 *  unit here", which prints no owner word. Shared between her trigger (does the
 *  question have any answers?) and her decision (what are they?), for the reason
 *  `gearsInTrash` records: the two drifting apart parks a question nothing can
 *  answer, and `advanceDecisions` drops that silently. */
function unitsAtBattlefield(state: GameState, battlefieldId: string): UnitInstance[] {
  const bf = state.battlefields.find((b) => b.id === battlefieldId);
  if (!bf) return [];
  return state.players.flatMap((p) => bf.units[p.id] ?? []);
}

/**
 * Diana - Lunari's second half — "reveal the top card of your Main Deck. If it's
 * a spell, draw it."
 *
 * Extracted for the reason `teemoStrategistReveal` above is: this is a REVEAL
 * from a deck, so Void Hatchling's replacement ("if you would reveal cards from a
 * deck, look at the top card first") has to be able to run in front of it, and
 * `voidHatchlingGate` needs a body it can either call now or call from a
 * continuation. Two copies of this would be two things able to disagree.
 *
 * The reveal moves nothing (425: "Cards remain in the zone they are being
 * Revealed from"), so the card is still the top of the deck when the draw takes
 * it — which is why "draw it" is `drawCards(..., 1)` rather than a lookup: the
 * card being drawn IS the card that was revealed.
 *
 * `revealedFromDeck` is the funnel rather than a bare read, so Nocturne -
 * Horrifying's "as you look at or reveal me" and Undertitan's "as I'm revealed
 * from your deck" both get their moment. Neither is a Spell, so neither can be
 * the card DRAWN here — but both can be the card REVEALED, and skipping the
 * funnel would silently owe them nothing.
 *
 * An empty deck reveals nothing and draws nothing (422's do-as-much-as-you-can),
 * which is a real state after a Predict recycled the only card.
 */
function dianaLunariReveal(state: GameState, ownerIndex: 0 | 1): GameState {
  const top = state.players[ownerIndex].deck[0];
  if (!top) return state;
  const revealed = revealedFromDeck(state, ownerIndex, [top]);
  // "If it's a SPELL" — the kind of the card that was turned over, asked of the
  // instance rather than of its definition, because that is what is being
  // revealed and `CardInstance.kind` is the same answer either way.
  return top.kind === "Spell" ? drawCards(revealed, ownerIndex, 1) : revealed;
}

/**
 * Zilean - Time Mage's once-each-turn allowance, marked on HIM rather than on
 * his controller.
 *
 * 371.1 caps the REPLACEMENT EFFECT ("these Replacement Effects may only be
 * applied to the specified number of events each turn"), and a replacement
 * effect belongs to the object printing it — so two Zileans at two battlefields
 * control two of them and get one application each. A per-player flag would let
 * one spend the other's.
 *
 * `abilityModesUsedThisTurn` is the per-unit, expires-with-the-turn marker
 * effects/chaos.ts already uses for Draven - Audacious's "the first time I win a
 * combat each turn", and its note there predicted this exact reuse. `runEnd`'s
 * `expireMightThisTurn` clears it for every unit in base and at every
 * battlefield; `activated-abilities` is the only other reader and keys off
 * printed mode ids, which Zilean has none of — and the marker is prefixed with
 * his defId anyway.
 */
/** Has this Nasus already channelled this turn? Asked of the LIVE unit, never of
 *  the listener snapshot the chain carries — for the reason `zileanSpent` above
 *  records: two enemy units dying in one window place two Pending Items (383
 *  fixes the set at the moment of the event), and the second must see what the
 *  first spent. */
function nasusHasChannelled(state: GameState, nasusInstanceId: string): boolean {
  return (
    findUnitAnywhere(state, nasusInstanceId)?.unit.abilityModesUsedThisTurn.includes(NASUS_GUARDIAN_CHANNELLED) ===
    true
  );
}

/** Writes the once-a-turn mark onto the live Nasus, wherever he stands. Both
 *  zones, exactly as `rememberZileanDoubled` walks both and for the same reason:
 *  the ability requires him at a battlefield when it TRIGGERS, and a chain item
 *  can send him home before it resolves. */
function markNasusChannelled(state: GameState, nasusInstanceId: string): GameState {
  const mark = (u: UnitInstance): UnitInstance =>
    u.instanceId === nasusInstanceId
      ? { ...u, abilityModesUsedThisTurn: [...u.abilityModesUsedThisTurn, NASUS_GUARDIAN_CHANNELLED] }
      : u;
  const players = state.players.map((p) => ({ ...p, baseUnits: p.baseUnits.map(mark) })) as [PlayerState, PlayerState];
  const battlefields = state.battlefields.map((bf) => {
    const units: typeof bf.units = {};
    for (const [playerId, list] of Object.entries(bf.units)) units[playerId] = list.map(mark);
    return { ...bf, units };
  });
  return { ...state, players, battlefields };
}

/**
 * Everything Jayce may ready — every EXHAUSTED unit or gear in play on either
 * side, minus Jayce himself.
 *
 * Shared between his option list and his resolver so the offer and the check
 * cannot drift, the same reason `unitsAtBattlefield` above is shared between
 * Icevale Archer's trigger and her decision.
 */
function readyableForJayce(
  state: GameState,
  jayceInstanceId: string | undefined,
): { instanceId: string; name: string; ownerIndex: 0 | 1 }[] {
  return ([0, 1] as const).flatMap((ownerIndex) => {
    const owner = state.players[ownerIndex];
    const units = [...owner.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[owner.id] ?? [])];
    return [...units, ...owner.activeGear]
      .filter((c) => c.exhausted && c.instanceId !== jayceInstanceId)
      // The OWNER is carried out of the walk because `readyPermanent` needs it —
      // it is the argument that lets the Mageseeker Warden's ready-lock be asked
      // about the right side.
      .map((c) => ({ instanceId: c.instanceId, name: c.name, ownerIndex }));
  });
}

/**
 * The looked-at cards a Predict question is still working through, in DECK
 * order.
 *
 * Read off the live deck by the ids on `cardInstanceIds` rather than carried as
 * cards, for the reason that field's own note gives: a question that carried
 * copies could hand back something the board has since changed.
 */
function lookedAtCards(state: GameState, d: { playerIndex: 0 | 1; cardInstanceIds?: string[] }): CardInstance[] {
  const ids = new Set(d.cardInstanceIds ?? []);
  return state.players[d.playerIndex].deck.filter((c) => ids.has(c.instanceId));
}

/**
 * Hands the survivors of a Predict to the ordering question — or straight past it
 * when there is nothing left to order.
 *
 * A single survivor is skipped rather than parked as a one-option question:
 * `advanceDecisions` would retire it silently anyway, and not parking it keeps
 * the queue honest about what was actually asked.
 */
function orderPredicted(
  state: GameState,
  d: { playerIndex: 0 | 1 },
  remaining: readonly string[],
): GameState {
  if (remaining.length < 2) return finishPredict(state, d.playerIndex);
  return repeatDecision(state, {
    kind: CLAIRVOYANCE_ORDER,
    playerIndex: d.playerIndex,
    cardInstanceIds: [...remaining],
    count: 0,
  });
}

/**
 * The last step of Clairvoyance — "Draw 2", after the predict has finished.
 *
 * Parked from HERE rather than up front, because `parkDecision` runs
 * `advanceDecisions` and a `draw` question has exactly one option: parking it
 * early executes it early. See the card's own entry for what that produced.
 */
function finishPredict(state: GameState, playerIndex: 0 | 1): GameState {
  return parkDecision(state, { kind: "draw", playerIndex, count: CLAIRVOYANCE_DRAW });
}

/**
 * Everything Bottled Constellation may kill to pay — every friendly unit and gear
 * EXCEPT itself.
 *
 * Shared between the trigger's affordability check (is there anything to ask
 * about?), the option list and the resolver's re-check, so all three agree about
 * what "3 other friendly units and/or gear" means. Those three disagreeing is how
 * a question gets asked that cannot be answered.
 */
function constellationFodder(
  state: GameState,
  playerIndex: 0 | 1,
  selfInstanceId: string | undefined,
): { instanceId: string; name: string }[] {
  const owner = state.players[playerIndex];
  const units = [...owner.baseUnits, ...state.battlefields.flatMap((bf) => bf.units[owner.id] ?? [])];
  return [...units, ...owner.activeGear]
    .filter((c) => c.instanceId !== selfInstanceId)
    .map((c) => ({ instanceId: c.instanceId, name: c.name }));
}

/**
 * The looked-at cards a Predict question is still working through, in DECK
 * order.
 */
const ZILEAN_DOUBLE_APPLIED = "UNL-086-doubled";

/** Has this Zilean already applied his replacement this turn? Asked of the LIVE
 *  unit, never of the listener snapshot the chain carries: two tokens played
 *  into one window place two Pending Items (383 fixes the set at the moment of
 *  the event), and the second must see what the first spent. */
function zileanSpent(state: GameState, zileanInstanceId: string): boolean {
  return findUnitAnywhere(state, zileanInstanceId)?.unit.abilityModesUsedThisTurn.includes(ZILEAN_DOUBLE_APPLIED) === true;
}

/** Writes the once-a-turn mark onto the live Zilean, wherever he stands. Both
 *  zones, for the reason chaos.ts's `rememberCombatWinScored` walks both: the
 *  ability requires him at a battlefield when it TRIGGERS, and a chain item can
 *  send him home before the answer arrives. */
function rememberZileanDoubled(state: GameState, zileanInstanceId: string): GameState {
  const mark = (u: UnitInstance): UnitInstance =>
    u.instanceId === zileanInstanceId
      ? { ...u, abilityModesUsedThisTurn: [...u.abilityModesUsedThisTurn, ZILEAN_DOUBLE_APPLIED] }
      : u;
  const players = state.players.map((p) => ({ ...p, baseUnits: p.baseUnits.map(mark) })) as [PlayerState, PlayerState];
  const battlefields = state.battlefields.map((bf) => {
    const units: typeof bf.units = {};
    for (const [playerId, list] of Object.entries(bf.units)) units[playerId] = list.map(mark);
    return { ...bf, units };
  });
  return { ...state, players, battlefields };
}

/**
 * The `TokenSpec` that would mint an identical token — "an additional COPY of
 * it".
 *
 * Read off the board rather than from a table of specs, and that is the whole
 * reason Zilean can be written at all: `placeToken` takes a spec and the token
 * that was just played is the only description of itself that survives the play.
 * A registry of "which spec did which card use" would have to be updated by every
 * future token-making card, and would be silently wrong the day one is missed.
 *
 * PRINTED values only. `keywords` is the token's own set, not `keywordsThisTurn`,
 * and `might` is the base figure rather than `effectiveMight` — 143.2 makes
 * current Might a derived value, and a copy of a pumped Sprite is still a 3
 * [Might] Sprite. `entersReady` mirrors `exhausted` so Sprite Call's "play a
 * READY token" copies as ready and Lillia - Fae Fawn's exhausted one does not.
 */
function tokenSpecOf(unit: UnitInstance): TokenSpec {
  return {
    name: unit.name,
    might: unit.might,
    // `createToken` writes exactly one tag, and derives the runtime defId from
    // it — so this is what makes the copy the same KIND of token, not just the
    // same stat line. `Mech` and `Sprite` are both read by aura tables.
    tag: unit.tags[0] ?? unit.name,
    entersReady: !unit.exhausted,
    keywords: unit.keywords,
  };
}

/** Where a unit is standing, as a `placeToken` destination. */
function destinationOf(state: GameState, zone: AnyUnitLocation["zone"]): TokenDestination | undefined {
  if (zone === "base") return "base";
  const bf = state.battlefields[zone.battlefieldIndex];
  return bf ? { battlefieldId: bf.id } : undefined;
}

export const eventTriggers: Record<string, EventTriggerDefinition> = {
  [BOTTLED_CONSTELLATION]: {
    // Bottled Constellation — "At the start of your Main Phase, you may kill 3
    // OTHER friendly units and/or gear to score 1 point."
    //
    // **The only card in 907 that names the MAIN Phase**, where 26 name the
    // Beginning Phase — so it needed a moment the engine did not have.
    // `mainPhaseStarted` is fired by `runDraw` as it hands over (316.1), which is
    // after the draw and after holds have scored; firing it as `beginningPhase`
    // would offer the choice about a board three steps too early.
    //
    // # "Kill 3 ... TO score" is a COST, not an effect
    //
    // 355.10.c.1's "[do X] to [do Y]": the kills are the price of the point, so
    // they are all-or-nothing. That is why the question ACCUMULATES three picks
    // before anything dies — a repeated decision that killed as it went would
    // leave a player two units down with no point when they backed out, and there
    // is no rule that lets them.
    //
    // "YOU MAY" is 402.1, decided at resolution, so this parks rather than fires,
    // and 416.3 means a board with fewer than three other friendly permanents is
    // never asked at all.
    //
    // "OTHER" excludes the Constellation itself, which is a gear and would
    // otherwise be one of its own three.
    on: "mainPhaseStarted",
    applies: (state, listener, event) =>
      event.kind === "mainPhaseStarted" &&
      event.playerIndex === listener.ownerIndex &&
      constellationFodder(state, listener.ownerIndex, listener.card.instanceId).length >= BOTTLED_CONSTELLATION_KILLS,
    resolve: (state, listener) =>
      parkDecision(state, {
        kind: BOTTLED_CONSTELLATION_PICK,
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
        cardInstanceIds: [],
      }),
  },
  [JAYCE_INVENTOR]: {
    // Jayce's second moment — "the FIRST TIME you play a non-token gear each
    // turn". The on-play half is in `unitTriggers` above and parks the same
    // question kind.
    //
    // # Three conditions, and each is asked of the event
    //
    // **"non-token"**: `event.isToken` is required on `cardPlayed` precisely so a
    // Gold token cannot pass for a gear card (185: tokens are not cards).
    //
    // **"the FIRST time each turn"**: `gearPlayedThisTurn` is bumped inside
    // `executePlayCardInner`, which runs BEFORE this event is held — so the first
    // gear of the turn arrives here with the counter already at 1. Asked as `=== 1`
    // rather than `=== 0` for that reason, and it is the kind of off-by-one that
    // would silently make him fire on the second gear instead of the first.
    //
    // **"you play"**: his controller's play, not the opponent's.
    on: "cardPlayed",
    applies: (state, listener, event) =>
      event.kind === "cardPlayed" &&
      event.casterIndex === listener.ownerIndex &&
      event.playedKind === "Gear" &&
      event.isToken !== true &&
      state.players[listener.ownerIndex].gearPlayedThisTurn === 1,
    resolve: (state, listener) =>
      parkDecision(state, {
        kind: JAYCE_READY,
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
      }),
  },
  [SWAIN_VISIONARY]: {
    // Swain, Visionary — "[Vision] When I conquer, if you've played a non-token
    // unit, a non-token gear, and a spell this turn, you score 1 point."
    //
    // **[Vision] needs nothing here.** `unitTriggerHasVisionChoice` reads the
    // printed keyword — and the auras that GRANT it — so the predict is fanned
    // onto the PlayCard action by `legal-actions` before this card is on the
    // board at all. That is the whole reason Vision stopped being a set of two
    // hardcoded defIds.
    //
    // "When I conquer" is the POSITIONAL reading, the same one Plundering Poro's
    // entry sets out: Swain has to be standing AT the battlefield taken, which is
    // what separates a unit's own conquest from a Legend's "when YOU conquer".
    //
    // # The three facts, and why only one needed a new field
    //
    // `spellsPlayedThisTurn` already existed. `gearPlayedThisTurn` already
    // answers "non-token gear" WITHOUT a qualifier of its own, because it is
    // bumped in `execute-play-card` and a gear token is minted by `placeToken`,
    // which never goes through it. Only the unit half needed
    // `nonTokenUnitsPlayedThisTurn` — `cardsPlayedThisTurn` counts every kind and
    // cannot tell a unit from the gear beside it.
    //
    // Read at RESOLUTION rather than in `applies`, deliberately: the conquest is
    // what TRIGGERS the ability (383 fixes that at the moment of the event) while
    // the three plays are its printed CONDITION, which 402.1 checks as the
    // ability resolves. Nothing today can un-play a spell in the response window,
    // so the two readings agree — this is the one the rules describe, and it is
    // the one that stays right when something can.
    on: "battlefieldConquered",
    applies: (_state, listener, event) =>
      event.kind === "battlefieldConquered" &&
      event.conquerorIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldConquered") return state;
      const actor = state.players[listener.ownerIndex];
      const all =
        actor.nonTokenUnitsPlayedThisTurn > 0 && actor.gearPlayedThisTurn > 0 && actor.spellsPlayedThisTurn > 0;
      return all ? gainPoints(state, listener.ownerIndex, SWAIN_VISIONARY_POINTS) : state;
    },
  },
  "VEN-057": {
    // Covert Informant — "[Empowered][>] When I move, draw 1."
    //
    // A DEPENDENT trigger (828): 828.1.c makes the ability active only "as long
    // as" the source holds the Empowered status, so an un-Empowered Informant
    // walks for nothing. Asked on the LISTENER's own instance, because 441.1.a
    // makes Empowered a property of the game object — two Informants can
    // disagree, and only the moved one's own status matters.
    //
    // "When **I** move" is the SELF reading, so the event's `unitInstanceId` is
    // compared to the listener's own card rather than merely checking that its
    // controller moved something. `unitMoved` fires per unit inside
    // `execute-move-unit`'s loop, so an Informant walking alongside two others is
    // one draw, not three — which is what the card says and is the same
    // per-unit-not-per-action reading Yasuo - Windrider's counter takes.
    //
    // No location test: his text names no battlefield, unlike the "to a
    // battlefield other than mine" cards above. `unitMoved` only fires for a
    // Standard Move to a battlefield anyway, so a recall is already excluded
    // without a check here.
    on: "unitMoved",
    applies: (state, listener, event) =>
      event.kind === "unitMoved" &&
      event.unitInstanceId === listener.card.instanceId &&
      isEmpowered(state, listener.card.instanceId),
    resolve: (state, listener) => drawCards(state, listener.ownerIndex, 1),
  },
  "UNL-074": {
    // Frigid Jewel — "When you draw your SECOND card each turn, give a friendly
    // unit +2 [Might] this turn."
    //
    // # The ordinal is the card, and it is carried on the EVENT
    //
    // `cardDrawn.nthThisTurn` says which draw this was. A listener re-reading
    // `PlayerState.cardsDrawnThisTurn` instead would be wrong in a way that only
    // shows on a multi-card draw: the trigger is HELD (383), so by the time it
    // resolves the count has moved on and every held instance would see the same
    // final number — three draws would fire three times, or none.
    //
    // # Why a GEAR can listen at all
    //
    // `allListeningPermanents` walks `activeGear`, which is how OGN-143 Pirate's
    // Haven works. Nothing here is new; the Jewel needs no attachment and no
    // wearer.
    //
    // # "EACH turn", not "the first time this game"
    //
    // The ordinal restarts at `runEnd`, so she fires once per turn for as long as
    // she is in play. Both halves are asserted: the second draw of a turn pumps,
    // the third does not, and the second draw of the NEXT turn pumps again.
    on: "cardDrawn",
    // "WHEN YOU draw" — her controller's draws only. Asked here rather than in
    // `resolve` so an opponent's draw never costs both players a PassFocus for a
    // question that would resolve to nothing.
    applies: (_state, listener, event) =>
      event.kind === "cardDrawn" && event.ownerIndex === listener.ownerIndex && event.nthThisTurn === FRIGID_JEWEL_NTH,
    resolve: (state, listener) => parkDecision(state, { kind: "UNL-074-pump", playerIndex: listener.ownerIndex }),
  },
  "UNL-084": {
    // Sprite Queen, second moment — "…OR at the start of your Beginning Phase,
    // play a ready 3 [Might] Sprite unit token with [Temporary] to your base."
    //
    // The same instruction as her on-play trigger one registry up, called through
    // the same `spriteQueenToken` so the two moments cannot drift apart.
    //
    // # The ORDER inside the Beginning Phase is what makes her work at all
    //
    // `runBeginning` runs `killTemporaryPermanents` FIRST (816: "at the start of
    // this permanent's controller's Beginning Phase, BEFORE SCORING, kill this"),
    // then dispatches `beginningPhase`, then scores holds. So last turn's Sprite
    // dies before this one is made, and the new one exists during `scoreHolds`.
    // Neither matters for the point: the token goes to BASE, which holds nothing.
    // Stated because the reverse order would make her a Sprite-per-turn engine
    // whose bodies never overlap, and that is not observable from this entry.
    //
    // "YOUR Beginning Phase" — the event carries whose it is, and she reads only
    // her own controller's, exactly as Mushroom Pouch does below. Firing on both
    // players' would double her rate.
    //
    // Resolved INLINE, like every other `beginningPhase` listener: the event is
    // not in `HeldEventKind`, and `runBeginning`'s own comment gives the reason —
    // holding it would put it after `scoreHolds`, in the wrong phase.
    on: "beginningPhase",
    resolve: (state, listener, event) => {
      if (event.kind !== "beginningPhase" || event.playerIndex !== listener.ownerIndex) return state;
      return spriteQueenToken(state, listener.ownerIndex);
    },
  },
  "UNL-085": {
    // Sumpworks Map — "[Reaction] [Temporary] When an opponent scores, draw 1."
    //
    // A gear that pays you for the turn you are losing, and its two keywords need
    // nothing here: `[Reaction]` is engine/timing.ts's, and `[Temporary]` is
    // `killTemporaryPermanents`, which sweeps `activeGear` through `killGear` —
    // so a Map played on your turn watches the opponent's whole turn and dies at
    // the start of your next Beginning Phase, before you score off it.
    //
    // # "Scores" is TWO events here, and that is 469 rather than a convenience
    //
    // 468: "Scoring is the act of a Player gaining a point through the process of
    // seizing or maintaining control over Battlefields." 469: "A player Scores in
    // one of two ways: 469.1 Conquer … 469.2 Hold". This engine raises one event
    // per way — `battlefieldConquered` and `battlefieldHeld` — so the card is a
    // two-moment listener rather than needing a third event that would mean the
    // union of these.
    //
    // **DIVERGENCE, in the over-firing direction, and only for Conquer.**
    // `battlefieldHeld` is raised by `scoreHolds` only for a battlefield that is
    // actually being scored (it filters `scoredBattlefieldsThisTurn` and
    // `mayScoreAt` first), so the Hold half is exact. `battlefieldConquered` is
    // deliberately NOT: `recordConquest` fires it before the withheld-point
    // branch, so it also fires when the battlefield was already scored this turn
    // (470) or when Forgotten Monument blocks the scoring. Neither is a Score by
    // 469.1's own wording — "a Battlefield they did not yet Score this turn" — and
    // the two cannot be told apart from a listener, because `recordConquest`
    // records the scoring BEFORE it holds the event. Telling them apart needs a
    // flag on the event (triggers.ts) or a scoring-specific event, neither of
    // which is this file's to add. So a re-taken battlefield draws a card it
    // should not; it costs the opponent a battlefield either way.
    //
    // A point WITHHELD is still a Score and still draws — 471.1 says the player
    // "Gains UP TO one Point", so Tianna Crownguard blocking the point and
    // 471.1.b.1's final-point draw are both Scores that happened.
    //
    // "An OPPONENT" is measured against the gear's controller, not the turn
    // player: your own conquests and holds must give the Map nothing, which is
    // the negative control its test asserts.
    on: ["battlefieldHeld", "battlefieldConquered"],
    applies: (_state, listener, event) =>
      (event.kind === "battlefieldHeld" && event.holderIndex !== listener.ownerIndex) ||
      (event.kind === "battlefieldConquered" && event.conquerorIndex !== listener.ownerIndex),
    resolve: (state, listener, event) => {
      // Re-checked at resolution, the convention every listener in this file
      // follows — and MEASURED to be redundant for this card rather than assumed
      // useful: both of these event kinds are in `HeldEventKind`, so the inline
      // path (which does not consult `applies`) can never raise them, and the
      // question is about the EVENT, which cannot change on the chain. A mutation
      // that deleted only this line survived the whole suite. It is kept as the
      // guard for a future inline emitter, and labelled rather than left implying
      // it is load-bearing.
      const scorer = event.kind === "battlefieldHeld" ? event.holderIndex : event.kind === "battlefieldConquered" ? event.conquerorIndex : undefined;
      if (scorer === undefined || scorer === listener.ownerIndex) return state;
      return drawCards(state, listener.ownerIndex, 1);
    },
  },
  "UNL-086": {
    // Zilean - Time Mage — "Once each turn, if you would play a token unit while
    // I'm at a battlefield, you may play that token and an additional copy of it
    // instead."
    //
    // # DIVERGENCE: a REPLACEMENT effect implemented as a TRIGGER
    //
    // 371 makes this a Replacement Effect, and the rules use THIS CARD as their
    // worked example under 371.2.b. This engine has no replacement layer for
    // playing a token: `placeToken` mints and files the unit in one step, and
    // 370.1.c requires the replacement to be applied "before any qualifying event
    // has actually occurred". Building that is token.ts's and it is not this
    // file's to write.
    //
    // What is written instead is a listener on the `cardPlayed` event
    // `placeToken` already holds — so the first token really is played, and the
    // copy arrives when the Pending Item resolves. Two things come apart from the
    // printed card, both recorded in docs/rules-conformance.md:
    //
    //  - **The two tokens are not simultaneous.** Under the replacement both
    //    arrive together; here the opponent has a response window in between, and
    //    `applyContested` runs twice at a battlefield rather than once. Nothing in
    //    this pool can tell those apart today, since a token arriving is a token
    //    arriving either way.
    //  - **A token killed inside that window loses its copy.** The spec is read
    //    off the live token at resolution (see `tokenSpecOf`), so a Sprite removed
    //    in response takes the copy with it, where the replacement would already
    //    have played both. WEAKER than printed, which is the safe direction.
    //
    // # "You may", and why declining does not spend the turn's use
    //
    // 371.2.b: "If they do not, it has not been applied this turn", with Zilean
    // named in the example — "they can choose not to apply the replacement effect
    // to that event. If they do, they can choose to apply it to a later event of a
    // token being played." So the mark is written by the DECISION's accept branch
    // (`UNL-086-copy` below) and nowhere else. Making the trigger mandatory would
    // have been the easy shape and is the one the rules explicitly rule out.
    //
    // # The four conditions
    //
    // `isToken` + `playedKind === "Unit"` is "a token unit" — 185 keeps a token
    // from being a card while 185.2.a makes it played, and a Gold GEAR token is
    // the other half this must not catch. UNL-058 Lillia (effects/calm.ts) is the
    // pool's other positive reader of that pair.
    //
    // `casterIndex === listener.ownerIndex` is "if YOU would play".
    //
    // `listener.battlefieldId !== undefined` is "while I'm at a battlefield" —
    // the listener walk sets it only for a unit at one (never for base, gear or a
    // Legend), which is the same test Blue Sentinel's "when I hold" makes below.
    //
    // The spent check is here as well as in `resolve` so a Zilean who has already
    // doubled this turn places NO Pending Item — an `applies` that passed would
    // cost both players a PassFocus for an ability that resolves to nothing.
    on: "cardPlayed",
    applies: (state, listener, event) =>
      event.kind === "cardPlayed" &&
      event.isToken &&
      event.playedKind === "Unit" &&
      event.casterIndex === listener.ownerIndex &&
      listener.battlefieldId !== undefined &&
      !zileanSpent(state, listener.card.instanceId),
    resolve: (state, listener, event) => {
      // The event-shape re-checks are the convention every listener in this file
      // follows, and MEASURED to be redundant for this card rather than assumed
      // useful — the same labelling Sumpworks Map's re-check carries above.
      // `cardPlayed` is a `HeldEventKind`, so `dispatchEvent`'s inline path (which
      // does not consult `applies`) can never raise it, and nothing about the
      // event can change while it waits on the chain. Mutations deleting these
      // two lines survived the whole file. Kept as the guard for a future inline
      // emitter, and labelled rather than left implying they are load-bearing.
      if (event.kind !== "cardPlayed" || !event.isToken || event.playedKind !== "Unit") return state;
      if (event.casterIndex !== listener.ownerIndex) return state;
      // THIS one is load-bearing, and the mutation run proves it: two tokens
      // played into one window (Sprite Burst) hold two items before either
      // resolves, so `applies` was asked of both while the mark was still
      // unwritten. This is the line that makes "once each turn" hold for a pair.
      if (zileanSpent(state, listener.card.instanceId)) return state;
      // The token itself may be gone — see the divergence note above. Belt and
      // braces: the decision's `options` already answers a vanished token with
      // NO options, which `advanceDecisions` drops without asking, so deleting
      // this line changes nothing measurable today. It is here so no moot
      // question is ever RAISED, and it is reported as unexercised.
      if (findUnitAnywhere(state, event.playedInstanceId) === undefined) return state;
      return parkDecision(state, {
        kind: "UNL-086-copy",
        playerIndex: listener.ownerIndex,
        // WHO is asking, so the mark lands on the Zilean that triggered rather
        // than on whichever one the answer happens to find.
        cardInstanceId: listener.card.instanceId,
        targetInstanceId: event.playedInstanceId,
      });
    },
  },
  "UNL-087": {
    // Blue Sentinel, THIRD clause — "When I hold, [Add] :rb_rune_rainbow: at the
    // start of your next Main Phase."
    //
    // **ONE of three clauses. `[Shield 2]` is the loader's; the SECOND clause is
    // REFUSED** — "Your hold effects for holding here trigger an additional time"
    // is a continuous effect on how OTHER cards' triggers resolve, which is
    // Karthus - Eternal's shape (triggers.ts counts him off the board and carries
    // a `times` on the chain entry). `holdEventTrigger` has no such multiplier —
    // it pushes exactly one entry per (listener, key) — and the doubling would
    // also have to reach `holdBattlefieldTrigger`, since a battlefield's own "when
    // you hold here" is a hold effect for holding here too. Both are shared files.
    // Named here and reported rather than half-written, and the card therefore
    // owes a `PARTIALLY_IMPLEMENTED` row.
    //
    // # The delayed trigger, and why this is an ordinary hold listener
    //
    // The printed ability is DELAYED (359.3.f.3.a — the rules work Iascylla's
    // "when I hold, at the start of your next Main Phase…" by name in that very
    // sub-rule). This engine has no delayed-trigger queue and no start-of-Main-
    // Phase moment at all: `Phase` is Awaken/Beginning/Channel/Draw/Action, and
    // 316's Main Phase IS the Action phase here.
    //
    // What makes the plain listener land at the printed MOMENT rather than
    // approximate it: a `battlefieldHeld` trigger is HELD (383), and `submit`'s
    // Pass runs the whole start of turn — Awaken, Beginning, Channel, Draw — in
    // one action, with the single Cleanup that finalizes pending triggers at the
    // END of it. By then `phase` is already "Action". So this resolves as the
    // first thing in the controller's Main Phase, before they can take a
    // Discretionary Action, which is exactly what the card says. Its test asserts
    // the phase at the moment the Power arrives, so a change that moves the chain
    // flush earlier fails loudly instead of silently making the Power vanish.
    //
    // **DIVERGENCE, and it is the printed reminder text:** "(Abilities that add
    // resources can't be reacted to.)" — 429.2/429.2.a, "Triggered and activated
    // abilities that Add resources resolve as soon as they are finalized … Priority
    // and Focus will not pass". Here it is an ordinary Pending Item, so the
    // opponent gets one response window before the Power lands. Nothing in this
    // pool can counter a triggered ability, so what is lost is a window rather
    // than the Power.
    //
    // A second divergence worth naming because it is unobservable rather than
    // absent: 316.3 empties every Rune Pool at the START of the Main Phase, and
    // this engine empties pools only in `runEnd`. A true delayed trigger would
    // add AFTER that emptying; this one adds after the Main Phase has begun, so
    // the two agree — but they agree by way of a gap, not by construction.
    //
    // `floatingRainbowPower`, not `floatingPower`: the pip is
    // `:rb_rune_rainbow:`, which is domainless Power and has its own pool (the
    // Gold token's `[Add]` and Malzahar - Fanatic use the same field).
    //
    // "When I HOLD" is about the battlefield this unit stands at — Ahri -
    // Alluring's reading, and `listener.battlefieldId` against the event's is what
    // separates it from a Legend's "when YOU hold". Holding two battlefields
    // raises two events and only the Sentinel's own pays.
    on: "battlefieldHeld",
    applies: (_state, listener, event) =>
      event.kind === "battlefieldHeld" &&
      event.holderIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldHeld") return state;
      if (event.holderIndex !== listener.ownerIndex || listener.battlefieldId !== event.battlefieldId) return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      const owner = players[listener.ownerIndex];
      players[listener.ownerIndex] = {
        ...owner,
        floatingRainbowPower: owner.floatingRainbowPower + BLUE_SENTINEL_RAINBOW,
      };
      return { ...state, players };
    },
  },
  "UNL-088": {
    // Gutter Palace, first clause — "At the start of your Beginning Phase, if you
    // have exactly 4 cards in hand and exactly 4 units at battlefields, you win
    // the game." (Its "Discard 1, [Exhaust]:" ability is in `activatedAbilities`
    // below, and its `[Deflect]` is the keyword machinery's.)
    //
    // **A DECLARED win, not points** — `GameState.declaredWinnerIndex`, the field
    // The Grand Plaza's identical "you win the game" already writes, and
    // `win-condition.winner` checks it before the score. Expressing it as "enough
    // points" would be beatable by a tie and would satisfy every "an opponent is
    // within 3 points" clause on the board.
    //
    // The win is realised by `withCleanupAndWinnerCheck`, which runs after the
    // action that contained the Beginning Phase — so a Pass that starts this
    // player's turn returns `GameOver` rather than the game continuing until
    // someone notices.
    //
    // BOTH counts are EQUALITIES. "Exactly" is printed twice, so a fifth card in
    // hand or a fifth unit at a battlefield loses the win, and that asymmetry is
    // the card: it has to be assembled and then held at exactly that size through
    // an opponent's turn.
    //
    // "Units AT BATTLEFIELDS" excludes base, and that is printed rather than
    // inferred — 355.9.a.1's bare-noun widening is what would have reached base,
    // and the card does not use a bare noun here. `unitsAtBattlefields` counts
    // every battlefield, not just controlled ones: a unit standing at a contested
    // battlefield is still a unit at a battlefield.
    //
    // Read at the START of the Beginning Phase, which `runBeginning` dispatches
    // AFTER `killTemporaryPermanents` — so a `[Temporary]` body that expires this
    // turn is already gone and does not count towards the four. That is 816's
    // "before scoring" ordering doing its job, and it is the one place this
    // condition could have been counted against a board that no longer exists.
    on: "beginningPhase",
    resolve: (state, listener, event) => {
      if (event.kind !== "beginningPhase" || event.playerIndex !== listener.ownerIndex) return state;
      const owner = state.players[listener.ownerIndex];
      if (owner.hand.length !== GUTTER_PALACE_HAND) return state;
      if (unitsAtBattlefields(state, listener.ownerIndex) !== GUTTER_PALACE_UNITS) return state;
      return { ...state, declaredWinnerIndex: listener.ownerIndex };
    },
  },
  "UNL-079": {
    // Diana - Lunari — "When a showdown begins here, you may pay [1]. If you do,
    // [Predict], then reveal the top card of your Main Deck. If it's a spell,
    // draw it."
    //
    // # The trigger moment is NARROWER than the card's, and this is the divergence
    //
    // "A SHOWDOWN begins" is rule 344, and 316.8.b.1.a makes a Non-Combat Showdown
    // — one player walking into an empty battlefield — a Showdown that begins just
    // as much as a Combat one does. This engine fires an event for only one of
    // them: `cleanup.stageShowdowns` ends `return isCombat ? beginCombatAt(staged,
    // contested.id) : staged`, so a Non-Combat Showdown hands out no designations
    // and raises no `combatBegan`. There is no `showdownBegan` event to listen to,
    // and adding one is an edit to cleanup.ts and triggers.ts, neither this file's.
    //
    // So this fires on COMBAT showdowns only, and Diana walking alone into an
    // empty battlefield gets nothing. Stated rather than left to be found: she is
    // the ONLY card in the whole pool (OGN/OGS/SFD/UNL) whose text says "when a
    // showdown begins", measured by scanning the card JSON, which is also why the
    // event was never needed before.
    //
    // # Why `isFightingAt` and not a bare battlefield match
    //
    // `combatBegan` fires a SECOND time when a reinforcement walks into an ongoing
    // combat (`cleanup.designateArrivals`), carrying only the arrivals in
    // `designated`. A listener that asked only "is this my battlefield" would fire
    // again for every body either player added to the fight, which is not a
    // showdown beginning by any reading. `isCombatantAt` (inside `isFightingAt`)
    // enforces 383.4.f's "for the first time during a combat" against
    // `event.designated`, so Diana fires exactly once per combat she is present at
    // the opening of.
    //
    // The residual overtrigger is Diana herself REINFORCING an ongoing combat: she
    // gains a designation then, so this fires, and no showdown began. Named rather
    // than papered over — telling the two apart needs the event to say which it
    // was, which is the same missing mechanism as the Non-Combat case.
    //
    // "YOU may pay" is her controller, which `listener.ownerIndex` is; the side
    // she is on is not consulted at all, since her text says "a showdown", not
    // "when I attack".
    //
    // # The shape below
    //
    // ONE question for the payment, then the Predict behind it, then the reveal —
    // three parked steps rather than one, because 359.3.d runs the instructions
    // top to bottom and the Predict genuinely changes what the reveal turns over.
    // The pay/decline question is dropped whole when the Energy is not there, so
    // `advanceDecisions` never shows a lone Decline (Icevale Archer's convention,
    // one registry up).
    on: "showdownBegan",
    applies: (state, listener, event) =>
      event.kind === "showdownBegan" && listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => {
      if (event.kind !== "showdownBegan") return state;
      // Priced at RESOLUTION, not in `applies` — Solari Shrine's split, and the
      // one that matters here: the response window this hold opens can gain or
      // spend the Energy, and 383 fixes only what TRIGGERED.
      if (payEnergyFromPool(state, listener.ownerIndex, DIANA_LUNARI_ENERGY) === undefined) return state;
      return parkDecision(state, { kind: "UNL-079-pay", playerIndex: listener.ownerIndex });
    },
  },
  "UNL-080": {
    // Hwei - Brooding Painter — "When I move, draw 1, then discard 1. Then, do the
    // following based on the discarded card's type: Spell — Draw 1. Gear — Ready
    // up to 2 runes. Unit — Give me +3 [Might] this turn."
    //
    // Registered against the board-wide `unitMoved` EVENT rather than
    // unit-triggers.ts's per-card `ON_MOVE_TRIGGERS` table, which is
    // module-private and not this file's to edit — Kato the Arm (SFD-112,
    // effects/body.ts) and Corrupt Enforcer (SFD-123, effects/chaos.ts) took the
    // same route and it is the same moment: fired once per unit by
    // `execute-move-unit` AFTER the unit has landed.
    //
    // **"When I move" with no destination printed still cannot mean a Recall** —
    // 456 says a Recall is not a Move — and `unitMoved` has a single emitter, the
    // Standard Move. It therefore also misses a spell-driven relocation, which 449
    // ("Spells, Abilities, or other effects may cause a Move to occur") makes a
    // real Move; that is an engine-wide divergence recorded against Corrupt
    // Enforcer rather than a property of this card.
    //
    // # The order is the card, and it is three separate moments
    //
    // DRAW first, then discard, then branch. The drawn card is a legal discard —
    // that is the whole point of the sequence, and it is why this cannot be
    // `discardThenDraw` (which exists to protect the OPPOSITE guarantee for
    // Traveling Merchant). The branch then has to know WHICH card went, which no
    // event on the board records, so the discard is asked as this card's own
    // question rather than through the generic `discard` decision.
    on: "unitMoved",
    applies: (_state, listener, event) =>
      event.kind === "unitMoved" && event.unitInstanceId === listener.card.instanceId,
    resolve: (state, listener, event) => {
      if (event.kind !== "unitMoved") return state;
      if (event.unitInstanceId !== listener.card.instanceId) return state;
      const drawn = drawCards(state, listener.ownerIndex, 1);
      // An empty hand after the draw (empty deck, nothing held) asks nothing at
      // all — 422's do-as-much-as-you-can, and the question's own options come
      // back empty so `advanceDecisions` drops it rather than prompting. Parked
      // unconditionally so that path is the decision's and not two places'.
      //
      // Hwei rides along on `cardInstanceId`: the Unit branch is "give ME +3", an
      // instruction about a body, and by the time the answer arrives nothing on
      // the board says which mover raised the question.
      return parkDecision(drawn, {
        kind: "UNL-080-discard",
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
      });
    },
  },
  "UNL-082": {
    // Lillia - Fae Fawn — "[Accelerate] When I move from a location, play a 3
    // [Might] Sprite unit token with [Temporary] THERE."
    //
    // `[Accelerate]` needs nothing here: 805 makes it an Optional Additional Cost
    // that legal-actions prices and `deploy.ts` honours ("if you do, I enter
    // ready"), and unlike Ekko - Recurrent and Tasty Faefolk her printed ability
    // is not gated on having paid it. The loader already keeps her `[Accelerate]`
    // while stripping the `[Temporary]` her TOKEN carries and she does not
    // (`GRANTED_ONLY_KEYWORDS`, card-loader.ts).
    //
    // The `unitMoved` EVENT, not `ON_MOVE_TRIGGERS` — see Hwei above for why, and
    // it is this card that NEEDS the event rather than merely being able to use
    // it: `UnitMoveTriggerEvent` carries only the DESTINATION, and "there" is the
    // ORIGIN. `unitMoved.from` is the only place in this engine that answers it.
    //
    // **The rules work this exact card, by name, for exactly that.** 359.3.f.3:
    // "Some information used by triggered abilities is referenced from the trigger
    // condition of the ability. This information is checked when the trigger
    // condition is fulfilled." Its example is verbatim: *"Lillia, Fae Fawn reads
    // 'when I move from a location, play a 3 [M] Sprite token with Temporary
    // there.' If Lillia moves to a battlefield, her triggered ability will be
    // placed on the chain and it will note the location she moved from when it
    // does so. If she moves to a non-board zone in reaction to the triggered
    // ability on the chain, it will not affect where the Sprite token will be
    // played."* So the origin is taken off the EVENT — noted when the trigger was
    // placed — and Lillia's own survival is never asked about. That is the exact
    // opposite of Ahri - Inquisitive's and Ezreal - Dashing's "here", which
    // 359.3.f.1/f.2 make a referent read from the SOURCE at execution; the two
    // sub-rules are neighbours and the card decides which applies.
    //
    // "A LOCATION" is 198.1 — "Locations include the Battlefields and the Bases" —
    // so leaving BASE is a location and mints a Sprite at home. `event.from` is
    // already `"base"` or a battlefield id, which is `TokenDestination` exactly.
    //
    // The token enters EXHAUSTED: see `SPRITE_TOKEN_EXHAUSTED` for the printed
    // word that separates hers from every other Sprite in the pool.
    on: "unitMoved",
    applies: (_state, listener, event) =>
      event.kind === "unitMoved" && event.unitInstanceId === listener.card.instanceId,
    resolve: (state, listener, event) => {
      if (event.kind !== "unitMoved") return state;
      if (event.unitInstanceId !== listener.card.instanceId) return state;
      return placeToken(
        state,
        listener.ownerIndex,
        event.from === "base" ? "base" : { battlefieldId: event.from },
        SPRITE_TOKEN_EXHAUSTED,
      );
    },
  },
  "SFD-075": {
    // Prize of Progress — "When you use an activated ability of a GEAR, give me
    // +1 [Might] this turn."
    //
    // The first card to watch an ACTIVATION, which is why `abilityActivated`
    // exists. The moment is the USE, not the effect: an ability whose effect
    // ends up doing nothing was still used, and the event is raised before the
    // resolver for exactly that reason.
    //
    // "of a GEAR" is the whole condition, and it is answered by `sourceKind` off
    // the RESOLVED source — a unit's ability and a legend's are not a gear's. A
    // check against the action would have had only an instance id and no idea
    // what it named.
    //
    // "When YOU use" is his controller — an opponent exhausting their own gear
    // does not feed him.
    //
    // Not capped: every gear activation pays, which in a deck of Gold tokens and
    // Seals is the card. Nothing here says once per turn.
    on: "abilityActivated",
    applies: (_state, listener, event) =>
      event.kind === "abilityActivated" &&
      event.sourceKind === "Gear" &&
      event.activatorIndex === listener.ownerIndex,
    resolve: (state, listener) => giveMightThisTurnToOwnUnit(state, listener.ownerIndex, listener.card.instanceId, 1),
  },
  "SFD-089": {
    // Rumble - Scrapper's SECOND sentence — "When I hold, play a 3 [Might] Mech
    // unit token to your base."
    //
    // His FIRST ("your Mechs have +1 Might, including me") is a continuous Might
    // aura and lives in effective-might.ts, which also carries his coverage
    // claim. Two halves, two modules, one change — see that claim's comment for
    // why landing them apart would have reported him finished at the halfway
    // point.
    //
    // "When **I** hold" is positional, like Ornn - Blacksmith's and Ahri -
    // Alluring's: the battlefield held has to be the one he is standing at.
    // Settled at fire time, so the response window this opens cannot be used to
    // move him off it and still collect.
    //
    // The token goes to BASE, not to the battlefield he just held — the card
    // says "to your base" and that is a real difference, since a token that
    // arrived at the battlefield would be a body in a fight already decided.
    //
    // It is a Mech, so his own aura pumps it to 4 the instant it lands — which
    // is the interaction the card is built out of and needs nothing here:
    // `MECH_TOKEN` carries the tag and `effectiveMight` reads it fresh.
    on: "battlefieldHeld",
    applies: (_state, listener, event) =>
      event.kind === "battlefieldHeld" &&
      event.holderIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener) => placeToken(state, listener.ownerIndex, "base", MECH_TOKEN),
  },
  "SFD-086": {
    // World Atlas — "When I hold, play two Gold gear tokens exhausted."
    // **ART-ONLY ABILITY.** None of this is in the card data — `text.plain` holds
    // the `[Equip]` line and nothing else, which is why this card reported
    // IMPLEMENTED while doing none of it. Transcribed from the card image; see
    // docs/sfd-equipment-abilities.md.
    //
    // "I" is the WEARER. `wearerListener` rewrites this gear's listener as the
    // unit wearing it, so every existing predicate applies unchanged.
    // Positional, like every "when I hold": the wearer has to be standing at the
    // battlefield that was held, which `listener.battlefieldId` on the rewritten
    // listener now genuinely answers.
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
      // TWO tokens through one call — `placeGoldTokens` mints them as separate
      // game objects, which is what "two tokens" means.
      return wearer === undefined ? state : placeGoldTokens(state, wearer.ownerIndex, 2);
    },
  },
  "OGN-112": {
    // Kai'Sa - Evolutionary — "[Ganking] When I conquer, you may play a spell
    // from your trash with Energy cost less than your points without paying its
    // Energy cost. Then recycle it."
    //
    // "When I CONQUER" is the positional reading Adaptatron and Sett - Brawler
    // take: she has to be AT the battlefield taken, which is what separates a
    // unit's conquer trigger from a Legend's "when you conquer".
    //
    // **"Less than your points" is read at RESOLUTION, not at fire time**, and
    // that is deliberate rather than an oversight: `scoreHolds` and
    // `recordConquest` award the point BEFORE this trigger is held, so the
    // conquest that fired her has already raised the threshold she reads. That is
    // the card working — a first conquest makes 0-cost spells available, a fourth
    // makes most of the pool available.
    //
    // "You MAY", so it parks a question rather than firing. Nothing is asked when
    // no spell in the trash qualifies — 055's do-as-much-as-you-can, and the same
    // shape Adaptatron's gear check uses.
    on: "battlefieldConquered",
    applies: (_state, listener, event) =>
      event.kind === "battlefieldConquered" &&
      event.conquerorIndex === listener.ownerIndex &&
      listener.battlefieldId === event.battlefieldId,
    resolve: (state, listener, event) => {
      if (event.kind !== "battlefieldConquered") return state;
      if (evolutionaryCandidates(state, listener.ownerIndex).length === 0) return state;
      return parkDecision(state, { kind: "OGN-112-play", playerIndex: listener.ownerIndex });
    },
  },
  "OGN-121": {
    // Teemo - Strategist — "[Hidden] When I defend, choose an enemy unit here and
    // reveal the top 5 cards of your Main Deck. Deal 1 to that unit for each card
    // with [Hidden] revealed this way, then recycle the revealed cards."
    //
    // `[Hidden]` is entirely engine/hidden.ts and the loader; only the defend
    // trigger is written here, and the card is genuinely whole once it lands.
    //
    // **The rules PDF works this exact card twice, and both uses changed what is
    // below rather than confirming it.**
    //
    // *135.2.b (Instructions)* splits the trigger into FOUR instructions by name:
    // "choose an enemy unit here", "reveal the top 5 cards of your Main Deck",
    // "deal 1 to that unit for each card with [Hidden] revealed this way", and
    // "recycle the revealed cards". Separate instructions are ignored separately
    // (359.3.e: "Instructions that can't be followed... are ignored"), so with no
    // enemy unit here the choose and the deal drop out while the reveal and the
    // recycle still happen. That is the Void Seeker precedent the same section
    // works ("Deal 4 to a unit at a battlefield. Draw 1." — the draw survives an
    // illegal target), NOT Retreat's, whose second sentence names "ITS owner" and
    // so is an instruction about the target. Near-unreachable in play, since
    // defending means enemy units are standing here; it costs one branch.
    //
    // *715.4 (Bonus Damage)* is why zero `[Hidden]` cards skips `dealDamage`
    // rather than calling it with 0: "If no damage was Dealt, then Bonus Damage
    // will not apply" — worked on Teemo himself carrying Rabadon's Deathcrown,
    // "no deal action is performed for the Bonus Damage to apply to." This
    // engine's Bonus Damage is Annie - Fiery, and damage-modifiers.ts adds her +1
    // to any amount, so `dealDamage(..., 0)` beside her would deal 1 for
    // revealing nothing. The guard is the rule, not defensive coding.
    //
    // `[Hidden]` on a revealed card is asked of the DEFINITION through
    // `isHiddenCard`, never of the printed text: Noxus Saboteur, Ava Achiever,
    // Ember Monk and Guerilla Warfare all MENTION "[Hidden]" without carrying it,
    // and card-loader.ts's HIDDEN_KEYWORD_FALSE_POSITIVE_DEF_IDS is where that is
    // already settled. A text scan would count them and still look like a working
    // card.
    //
    // "Recycle" is 416/425 — the bottom of the corresponding deck, in revealed
    // order. A deck shorter than 5 reveals what it has: this is an EFFECT, so
    // 055's do-as-much-as-you-can applies rather than `recycleFromTrash`'s
    // all-or-nothing cost rule, the same distinction Dr. Mundo - Expert draws
    // below.
    on: "combatBegan",
    // "When I defend" is a fact about the board at the moment of the event, so it
    // is asked here: holding the trigger for a Teemo who is ATTACKING would open
    // a response window for an ability that resolves to nothing. The predicate is
    // combat-designation.ts's, shared with Yasuo's mirror-image "when I attack"
    // so the two sides cannot come to different answers about the same combat.
    applies: isDefendingAt,
    resolve: (state, listener, event) => {
      // Narrowing the union is not ceremony: the dispatcher filters by `on`, but
      // the compiler cannot see it, and `applies` cannot hand back the narrowed
      // event.
      //
      // `isDefendingAt` is deliberately NOT re-asked here. It was, while this
      // resolved inline and the two were the same instant; now they are separated
      // by a response window, and re-asking would let the opponent cancel a
      // trigger that has already fired by moving Teemo off the battlefield he was
      // defending. 383 fixes triggering at the moment of the event.
      if (event.kind !== "combatBegan") return state;
      // The reveal is `teemoStrategistReveal`, extracted so Void Hatchling's
      // "look at the top card first, you may recycle it" can run BEFORE it — see
      // `voidHatchlingGate`. The battlefield rides the decision because "an enemy
      // unit HERE" is about where this combat is, and by the time an answer
      // arrives the board can no longer be asked which one that was.
      return voidHatchlingGate(
        state,
        listener.ownerIndex,
        listener.ownerIndex,
        { kind: "OGN-121-reveal", playerIndex: listener.ownerIndex, battlefieldId: event.battlefieldId },
        (s) => teemoStrategistReveal(s, listener.ownerIndex, event.battlefieldId),
      );
    },
  },
  "OGN-119": {
    // Ahri - Inquisitive — "When I attack or defend, give an enemy unit here
    // -2 Might this turn, to a minimum of 1 Might."
    //
    // "Attacks OR DEFENDS" — which side started the fight is deliberately not
    // consulted, which is the whole of `isFightingAt`. The same indifference Mask
    // of Foresight shows, and the opposite of Yasuo and Teemo, who each name one
    // side. All four now ask combat-designation.ts rather than re-deriving it.
    //
    // Being AT the battlefield is a fire-time condition and lives in `applies`:
    // she triggered because she was in the combat, and an opponent moving her out
    // during the response window does not un-trigger it (383). The TARGET is a
    // resolution-time board read and stays below — auto-selected from the enemies
    // there, same precedent as the other combat triggers, filed Unverified. The
    // floor is her own printed clause.
    //
    // **"HERE" is RE-CHECKED against where she is standing at resolution**, which
    // is a different question from whether she triggered and is settled by a
    // different rule. 359.3.f.1 names "here" as a referent read from the ability's
    // SOURCE, and 359.3.f.2 says a referent is checked on EXECUTION of the
    // instruction — with the rules' own worked example being this exact case:
    // Fight or Flight sends Yasuo - Remorseful home in reaction to his attack
    // trigger, and "when the attack trigger resolves, 'here' is no longer the
    // battlefield where combat is ongoing and the attack trigger mistargets".
    // 359.3.f.2.a then drops every instruction related to that referent.
    //
    // Sinister Poro (UNL-137, effects/chaos.ts) is the shape this matches, down to
    // a source that DIED being moot as well — a unit off the board has no location
    // for "here" to read. Ezreal - Dashing below already treats "MY Might" that
    // way for the same reason.
    on: "combatBegan",
    applies: isFightingAt,
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      const here = findUnitOnBattlefield(state, listener.card.instanceId);
      if (!here || state.battlefields[here.battlefieldIndex]!.id !== event.battlefieldId) return state;
      const bf = state.battlefields.find((b) => b.id === event.battlefieldId);
      const ownerId = state.players[listener.ownerIndex].id;
      const enemy = Object.entries(bf?.units ?? {})
        .filter(([id]) => id !== ownerId)
        .flatMap(([, units]) => units)[0];
      return enemy ? giveMightThisTurn(state, enemy.instanceId, -2, 1) : state;
    },
  },
  "OGN-109": {
    // Dr. Mundo - Expert — "At the start of your Beginning Phase, recycle 3 from
    // your trash." (His Might clause is a continuous modifier in
    // effective-might.ts.)
    //
    // The two clauses fight each other on purpose: he is bigger the fuller your
    // trash is, and every turn he empties it. That is the card, so this must NOT
    // be skipped when the trash is short.
    //
    // Which is why it does not use `recycleFromTrash`: that helper is a COST and
    // returns undefined unless it can move all 3 (416.3). Here recycling is an
    // EFFECT, so "do as much as you can" applies (055) — a 2-card trash recycles
    // both. Same distinction Salvage's "up to one gear" makes.
    on: "beginningPhase",
    resolve: (state, listener, event) => {
      if (event.kind !== "beginningPhase") return state;
      if (event.playerIndex !== listener.ownerIndex) return state;
      const owner = state.players[listener.ownerIndex];
      const recycled = owner.trash.slice(0, 3);
      if (recycled.length === 0) return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      players[listener.ownerIndex] = {
        ...owner,
        trash: owner.trash.slice(recycled.length),
        deck: [...owner.deck, ...recycled], // bottom, per 416
      };
      return { ...state, players };
    },
  },
  "OGN-101": {
    // Mushroom Pouch — "At the start of your Beginning Phase, if you control a
    // facedown card at a battlefield, draw 1."
    //
    // Only implementable now that [Hidden] exists: before facedown cards there
    // was nothing for the condition to be true OF. `controlsAnyFacedownCard`
    // asks it exactly — a facedown card of YOURS at a battlefield YOU control,
    // which is the same pairing rule 811 ties the card's survival to.
    //
    // "YOUR Beginning Phase": the event carries whose it is, and a gear only
    // reads its own controller's. Firing on both players' would double the draw
    // rate of a card that is meant to reward holding a hidden card for a turn.
    on: "beginningPhase",
    resolve: (state, listener, event) => {
      if (event.kind !== "beginningPhase" || event.playerIndex !== listener.ownerIndex) return state;
      if (!controlsAnyFacedownCard(state, listener.ownerIndex)) return state;
      return drawCards(state, listener.ownerIndex, 1);
    },
  },
  "OGN-117": {
    // Viktor - Innovator — "When you play a card on an opponent's turn, play a
    // 1 Might Recruit unit token in your base."
    //
    // "On an opponent's turn" is the whole card, and it only became reachable
    // with reaction-speed timing: before [Action]/[Reaction] existed you could
    // never play anything on someone else's turn, so this would have been a
    // trigger that could not fire.
    //
    // The condition is the ACTIVE player vs the listener's controller — not vs
    // the caster. Those differ: the event fires for both players' cards, and
    // Viktor must ignore the opponent's own plays on their own turn.
    on: "cardPlayed",
    // "On an opponent's turn" is read at FIRE time and not re-asked in `resolve`.
    // `cardPlayed` is a Chain Pending Item now, so the trigger can outlive the
    // turn it fired in — a chain that is still resolving as the turn passes would
    // otherwise make Viktor refuse a trigger that had genuinely fired on the
    // opponent's turn. 383 fixes what triggered at the moment of the event.
    applies: (state, listener, event) =>
      event.kind === "cardPlayed" &&
      // **185: "Tokens are not cards."** This sentence says CARD, so a token
      // played by its owner is not one — 185.1.a makes that nature permanent, and
      // 350.2 keeps "can still be Played" and "is a card" apart. Added 2026-08-10
      // with the token `cardPlayed` event; before it, nothing fired for a token at
      // all and this listener was accidentally correct.
      //
      // **Not merely a rules point here — Viktor LOOPED.** He plays a Recruit
      // token, the token held `cardPlayed`, and that re-fired him: two tests in
      // `event-triggers.test.ts` failed with "the chain never reopened" the first
      // time the event was emitted. The gate is what makes his own token stop.
      !event.isToken &&
      event.casterIndex === listener.ownerIndex &&
      state.activePlayerIndex !== listener.ownerIndex,
    resolve: (state, listener, event) => {
      // Narrowing the union is not ceremony: the dispatcher already filters by
      // `on`, but the compiler cannot see that, and the check documents which
      // event this listener is reading fields off.
      if (event.kind !== "cardPlayed") return state;
      if (event.casterIndex !== listener.ownerIndex) return state; // not YOUR card
      // "in your base" is stated, so the destination is fixed rather than chosen.
      return placeRecruitToken(state, listener.ownerIndex, "base");
    },
  },
  "OGN-091": {
    // Pit Crew — "When you play a gear, ready me."
    //
    // Rides the existing `cardPlayed` event, whose `playedKind` is a REQUIRED
    // field precisely so a listener can ask what was played without a producer
    // being able to omit the answer. No new event, no new field.
    //
    // "YOU play" is the caster against the listener's controller — the opponent
    // equipping their own board must not ready mine. Deliberately NOT the check
    // Viktor - Innovator makes above (his is caster vs the ACTIVE player, which
    // is a different question and would fire this only on the opponent's turn).
    //
    // `readyUnit` rather than `readyPermanent`: "ready me" is a unit readying
    // itself, and Pit Crew can be standing in base or at a battlefield, both of
    // which readyUnit reaches. Already-ready is a harmless no-op, so there is no
    // exhaustion guard — a trigger that fired and changed nothing and a trigger
    // that did not fire are the same board here.
    on: "cardPlayed",
    // Both conditions are properties of the EVENT, so they cannot drift across
    // the response window this hold opens — but they still belong here, because
    // `cardPlayed` is a Chain Pending Item and a trigger held for a Spell or for
    // the opponent's gear would cost both players a PassFocus for nothing.
    applies: (_state, listener, event) =>
      event.kind === "cardPlayed" && event.casterIndex === listener.ownerIndex && event.playedKind === "Gear",
    resolve: (state, listener, event) => {
      if (event.kind !== "cardPlayed") return state;
      if (event.casterIndex !== listener.ownerIndex) return state; // not YOUR gear
      if (event.playedKind !== "Gear") return state;
      return readyUnit(state, listener.card.instanceId);
    },
  },
  // Plundering Poro, both printings — see `plunderingPoroConquer` above for the
  // card, and for why the two defIds share ONE definition object rather than two
  // identical literals.
  "SFD-069": plunderingPoroConquer,
  "UNL-222": plunderingPoroConquer,
  "UNL-065": {
    // Icevale Archer — "When I attack, you may pay [1] to give a unit here -1
    // Might this turn."
    //
    // "When I ATTACK" only, so `isAttackingAt` and not Ahri - Inquisitive's
    // side-blind `isFightingAt`: an Archer standing at a battlefield the opponent
    // walks into gets nothing. The designation is fixed when the combat opens
    // (383), so it is asked in `applies` and never re-asked below — moving her
    // away inside the response window must not cancel a trigger that has fired.
    //
    // **"A unit here" carries no owner word, so BOTH sides are offered.** The pool
    // says "an ENEMY unit here" when it means one (Ahri - Inquisitive, Recurve
    // Bow, Ezreal - Dashing, all in this engine's combat-trigger family), and this
    // card does not. Shrinking your own is a bad play, not an illegal one — the
    // usual pair, and the same reading Smoke Screen and Frigid Touch already got.
    //
    // **No floor, and that is the rules text rather than an omission.** The card
    // prints no minimum, and the Might property (143.2.b) is explicit that none is
    // implied, quoted verbatim: "If a unit's Might is ever less than 0, it is
    // treated as 0 when referenced by spells and abilities, and when summing Might
    // to be assigned as damage in the Combat Damage Step. ... Although the unit's
    // Might is treated as 0, it is not 0. Effects that calculate Might increases
    // and decreases use the actual value of the unit's Might." So -1 on a 1-Might
    // body takes it to 0, and a floor of 1 would quietly remove this card's ability
    // to finish anything off. Frigid Touch (SFD-066, above) reads it the same way
    // and says so at length.
    //
    // **This contradicts Frostcoat Cub (SFD-067) in this same file**, which floors
    // its debuff at 1 and cites a rule for a minimum the text above does not state.
    // Flagged rather than changed: altering an implemented card's behaviour is not
    // this change's scope, and the two readings need one owner's call, not two
    // files quietly disagreeing.
    //
    // ONE question, not two: whether to pay and which unit are the same decision,
    // because paying without naming a unit buys nothing — Ava Achiever's shape.
    // The cost is checked at RESOLUTION rather than in `applies`, which is Solari
    // Shrine's split and the one that matters here: the response window this hold
    // opens can gain or spend the Energy, and 383 fixes only what TRIGGERED.
    on: "combatBegan",
    applies: isAttackingAt,
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      // Nothing to shrink, or nothing to pay with, is no question at all — the
      // offer is dropped whole rather than shown as a lone Decline, which is what
      // every other optional offer in this file does and what keeps
      // `advanceDecisions` from auto-resolving a one-option question.
      if (unitsAtBattlefield(state, event.battlefieldId).length === 0) return state;
      if (payEnergyFromPool(state, listener.ownerIndex, ICEVALE_ENERGY_COST) === undefined) return state;
      // "HERE" is the battlefield this combat opened at, captured now: by the time
      // an answer arrives nothing on the board says which fight raised the
      // question. SHE rides along with it, because "here" is read from HER at
      // execution rather than from the event — see the decision's own note.
      return parkDecision(state, {
        kind: "UNL-065-chill",
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
        battlefieldId: event.battlefieldId,
      });
    },
  },
  "SFD-063": {
    // Chemtech Cask — "When you play a spell on an opponent's turn, you may
    // exhaust me to play a Gold gear token exhausted."
    //
    // Viktor - Innovator's trigger condition narrowed to SPELLS, and it is only
    // reachable at all because of reaction-speed timing: with no [Action] or
    // [Reaction] in the pool you could never play anything on someone else's turn,
    // so this would be a trigger that cannot fire. "On an opponent's turn" is the
    // ACTIVE player against the CASK's controller — not against the caster, which
    // is a different question and would fire this on the opponent's own plays.
    //
    // "You may EXHAUST ME TO play..." is a cost, not a rider, so it stops to ask:
    // Solari Shrine (OGN-072) is the shape, down to the split between the two
    // checks. The trigger CONDITIONS are facts about the event and settle whether
    // it fired; the Cask being ready is a fact about the BOARD when it resolves,
    // and the response window this hold opens can spend it. So the exhaustion is
    // asked at resolution and an already-spent Cask asks nothing rather than
    // offering a cost it cannot pay.
    //
    // One Cask, one token, per spell — a second Cask on the board is a second
    // listener with its own exhaust to pay, which is what "exhaust ME" means.
    on: "cardPlayed",
    // Held (383), so all three are asked before a Pending Item is placed: a
    // trigger held for the opponent's spell, or for your own Unit, would close the
    // chain and cost both players a PassFocus for a question with no answer.
    applies: (state, listener, event) =>
      event.kind === "cardPlayed" &&
      event.casterIndex === listener.ownerIndex &&
      event.playedKind === "Spell" &&
      state.activePlayerIndex !== listener.ownerIndex,
    resolve: (state, listener, event) => {
      if (event.kind !== "cardPlayed") return state;
      // Both re-checks are of the EVENT, which the response window cannot alter —
      // and `activePlayerIndex` deliberately is NOT re-asked, for the reason
      // Viktor's entry records: `cardPlayed` is a Chain Pending Item, so a chain
      // still resolving as the turn passes would otherwise make the Cask refuse a
      // trigger that genuinely fired on the opponent's turn.
      if (event.casterIndex !== listener.ownerIndex || event.playedKind !== "Spell") return state;
      // A Gear in play, so the narrowing is a formality — but `Listener.card` is a
      // CardInstance now that trash listeners share the type, and a Spell has no
      // `exhausted`. Same two lines Solari Shrine writes.
      if (listener.card.kind === "Spell" || listener.card.exhausted) return state;
      return parkDecision(state, {
        kind: "SFD-063-gold",
        playerIndex: listener.ownerIndex,
        cardInstanceId: listener.card.instanceId,
      });
    },
  },
  "SFD-082": {
    // Ezreal - Dashing — "When I attack or defend, deal damage equal to my Might
    // to an enemy unit here. I don't deal combat damage. [Mind]: [Action] — Move
    // me to your base."
    //
    // **ONE of THREE clauses. Deliberately, and it is the clause that makes him
    // stronger rather than weaker, so it is worth being loud about:**
    //
    //  - "I don't deal combat damage" is a COMBAT-ASSIGNMENT fact and belongs
    //    beside `combatAssignmentDefIds` in engine/combat.ts. Without it this
    //    Ezreal deals his trigger damage AND his Might in the damage step, i.e.
    //    he is played better than he is printed. That is the drawback the trigger
    //    is priced against.
    //  - ":rb_rune_mind:: [Action] — Move me to your base" is an activated
    //    ability with a Power cost, which engine/activated-abilities.ts already
    //    expresses (`ActivationCost.power`, Treasure Trove's shape) — it needs a
    //    registry entry there, not a new subsystem.
    //
    // Neither file is this one's to edit. The clause below is whole on its own
    // terms and is written rather than withheld, the same call Wallop (OGN-146,
    // effects/body.ts) records for its unreachable half.
    //
    // "When I attack OR DEFEND" is `isFightingAt` — Ahri - Inquisitive's
    // indifference to which side started the fight, not Yasuo - Remorseful's
    // attacker-only reading. The designation is fixed when the combat opens
    // (383), so it is asked here and NOT re-asked below: moving him away during
    // the response window must not cancel an ability that has already triggered.
    on: "combatBegan",
    applies: isFightingAt,
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      const bf = state.battlefields.find((b) => b.id === event.battlefieldId);
      if (!bf) return state;
      // **"MY Might" is read LIVE at resolution, not off `listener.card`**, and
      // the rules work this exact sentence to say so. 359.3.e.14's own example is
      // Strike Down — "It deals damage equal to its Might to an enemy unit" —
      // where the answer is "null" once the unit's information is no longer
      // available, "and the instructions related to it are ignored"; the very
      // next clause is that information about a permanent whose zone and status
      // HAVE NOT changed "is accessible". A fire-time snapshot gets both ends
      // wrong: it pays out for an Ezreal who has left the board, and it misses a
      // pump landed in the response window this hold opens.
      //
      // **This is a divergence from Yasuo - Remorseful (OGN-076, effects/calm.ts),
      // which reads `listener.card` for the same sentence.** Reported rather than
      // fixed — that file belongs to another owner.
      const self = findUnitAnywhere(state, listener.card.instanceId);
      if (!self) return state; // off the board: null Might, so the deal is ignored
      // And the SAME argument reaches "here", which the paragraph above stops one
      // sentence short of: it is a referent too (359.3.f.1), checked on execution
      // (359.3.f.2), and the rules' worked example for it is Fight or Flight
      // sending Yasuo home in reaction to this very sentence — "'here' is no
      // longer the battlefield where combat is ongoing and the attack trigger
      // mistargets". His own `[Action]` to move himself to base is the likeliest
      // way this happens, and it makes the shot moot rather than free. Sinister
      // Poro (UNL-137, effects/chaos.ts) is the convention; Ahri above matches it.
      if (self.zone === "base" || state.battlefields[self.zone.battlefieldIndex]!.id !== event.battlefieldId) return state;
      // `isCombat: false` for the reason Yasuo's entry records: `[Assault]` and
      // `[Shield]` are terms of the COMBAT damage step, and counting them in a
      // damage INSTRUCTION would pay them twice in one fight. Buffs, this-turn
      // pumps and continuous auras all count, and the context is built from where
      // he is standing NOW rather than from the event, so an aura at a
      // battlefield he was moved to is the one that applies.
      const might = effectiveMight(state, self.unit, self.ownerIndex, mightContextFor(state, self));
      // "An enemy unit HERE" — the first at the battlefield the combat opened at,
      // in board order, auto-selected rather than asked. Same simplification and
      // the same structural reason (no action to hang the choice on) as Yasuo,
      // Ahri, Teemo and Crackshot Corsair; filed Unverified in
      // docs/rules-conformance.md.
      const ownerId = state.players[listener.ownerIndex].id;
      const enemyId = Object.entries(bf.units)
        .filter(([id]) => id !== ownerId)
        .flatMap(([, units]) => units.map((u) => u.instanceId))[0];
      if (enemyId === undefined) return state;
      // 715.4 — "If no damage was Dealt, then Bonus Damage will not apply." A
      // 0-Might Ezreal (Smoke Screen has a floor, Thousand-Tailed Watcher does
      // not reach him, but a future -Might card will) must skip `dealDamage`
      // rather than call it with 0, or Annie - Fiery's +1 in damage-modifiers.ts
      // would turn "no damage" into 1. Teemo - Strategist's guard, and the rule
      // is the same one.
      if (might <= 0) return state;
      return dealDamage(state, listener.ownerIndex, enemyId, might);
    },
  },
};

/** Triggers a card fires about ITSELF — being played, discarded or killed. Keyed
 *  by that card's own defId, because at those moments it may not be in play for
 *  a listener walk to reach (see triggers.ts's SelfTriggerDefinition). */
export const selfTriggers: Record<string, SelfTriggerDefinition> = {
  "UNL-078": {
    // Sprite Fountain — "[Temporary] When you play this, play a ready 3 [Might]
    // Sprite unit token with [Temporary] to your base. [Deathknell][>] Repeat
    // this gear's play effect."
    //
    // # BOTH clauses, in ONE entry, and that is the point
    //
    // A gear's "when you play this" is a SELF trigger and not a `cardEffects`
    // entry — `executePlayCard`'s gear branch pushes nothing onto the chain, so
    // `resolveCardEffect` is never reached for a Gear and a registered effect
    // there is silently dead. **Measured, after writing it that way first:** the
    // Fountain landed in `activeGear` and no token appeared. Forge of the Future
    // (OGN-212, effects/order.ts) and Poro Snax (SFD-046, effects/calm.ts) are the
    // two precedents and both say so.
    //
    // A `[Deathknell]` on a GEAR is the same registry for a different reason:
    // `deathTriggers` is the Deathknell family for UNITS, keyed off a
    // `DeathContext` that `killUnit` builds and `killGear` does not. A dying gear
    // goes through `holdSelfTrigger(state, "killed", gear, ownerIndex)`, the
    // funnel Scrapheap (UNL-135, effects/chaos.ts) already uses.
    //
    // So both moments land here — and "REPEAT THIS GEAR'S PLAY EFFECT" then falls
    // out for free, because `on` is a list and `resolve` is the same call either
    // way. Two entries would have been two copies of one sentence, which is what
    // `spriteFountainPlayEffect` exists to prevent; one entry makes the
    // Deathknell repeat the play effect BY CONSTRUCTION rather than by two
    // literals agreeing.
    //
    // It is the EFFECT that repeats and not the PLAY: on death the gear is in a
    // trash, nothing is being played, and `cardPlayed` must not fire — which is
    // exactly what calling the extracted body rather than replaying the card
    // gets.
    //
    // `event.ownerIndex` is the gear's controller at that moment, so a Fountain
    // killed by the opponent's Rocket Barrage still pays ITS OWN side — the same
    // reading a unit's Deathknell gets from `death.ownerIndex`.
    //
    // **The printed `[Temporary]` on the GEAR is inert, and that is an engine
    // defect rather than a reading.** `createCardInstance` builds every
    // `GearInstance` with a hardcoded `keywords: {}` — its own comment says "Gear
    // in this pool prints no keywords of its own, so this starts empty for every
    // one of them", which Unleashed falsifies: the loader parses `{Temporary: 1,
    // Deathknell: 1}` onto this card's DEFINITION and the instance drops both.
    // `turn-manager.killTemporaryPermanents` tests `"Temporary" in g.keywords`, so
    // this Fountain never dies on its own and the `[Deathknell]` below is
    // reachable only through something ELSE killing it (Turn to Dust's grant,
    // Rocket Barrage's second mode, Pickpocket, Jayce). Measured, not inferred,
    // and pinned in test/unl-mind-wave3.test.ts; the fix is one line in
    // model/card.ts, which this pass does not own.
    on: ["played", "killed"],
    resolve: (state, event) => spriteFountainPlayEffect(state, event.ownerIndex),
  },
};

/** Questions this domain's cards stop to ask — see engine/decisions.ts. Keyed by
 *  a `kind` string rather than a defId, since one card can ask more than one
 *  kind of question; the one-file-one-owner rule still applies, and the key is
 *  prefixed with the card's defId so ownership stays readable. */
/** The spells in `playerIndex`'s trash that Kai'Sa - Evolutionary could play —
 *  "a spell ... with Energy cost less than your points". Read from the PRINTED
 *  cost, which is what every other effect asking about a card's cost uses, and
 *  strictly less than, as printed. */
function evolutionaryCandidates(state: GameState, playerIndex: 0 | 1) {
  const actor = state.players[playerIndex];
  return actor.trash.filter((c) => c.kind === "Spell" && c.energyCost < actor.points);
}

export const decisions: Record<string, DecisionDefinition> = {
  [CLAIRVOYANCE_RECYCLE]: {
    // `[Predict 5]`, first half — "recycle ANY of them".
    //
    // Repeated rather than multi-select: each answer recycles one card to the
    // bottom of the deck (416.1, through `holdCardsRecycled` so Karma - Channeler
    // sees it) and re-asks with the rest. "Any" therefore covers none (Done
    // straight away) and all (five answers).
    //
    // Done is offered FIRST so `answerDecisions`' default pick is the harmless
    // one — and the tests answer with a non-default pick precisely because of
    // that, which is the lesson Chaos wave 2's four survivors left.
    prompt: (state, d) => `Predict: recycle any of the top ${d.cardInstanceIds?.length ?? 0}?`,
    options: (state, d) => [
      { id: "done", label: "Keep the rest" },
      ...lookedAtCards(state, d).map((c) => ({ id: c.instanceId, label: `Recycle ${c.name}`, instanceId: c.instanceId })),
    ],
    resolve: (state, d, optionId) => {
      const remaining = (d.cardInstanceIds ?? []).filter((id) => id !== optionId);
      if (optionId === "done") return orderPredicted(state, d, d.cardInstanceIds ?? []);
      const looked = lookedAtCards(state, d);
      const chosen = looked.find((c) => c.instanceId === optionId);
      if (!chosen) return orderPredicted(state, d, remaining);
      // To the BOTTOM (416.1), and through the funnel so "when you recycle" sees
      // it. The card is taken out of the looked-at window rather than off the top
      // of the deck, because the window is what this question is about.
      const players = [...state.players] as [PlayerState, PlayerState];
      const owner = players[d.playerIndex];
      players[d.playerIndex] = {
        ...owner,
        deck: [...owner.deck.filter((c) => c.instanceId !== optionId), chosen],
      };
      const recycled = holdCardsRecycled({ ...state, players }, d.playerIndex, 1);
      return remaining.length === 0
        ? orderPredicted(recycled, d, [])
        : repeatDecision(recycled, { ...d, cardInstanceIds: remaining });
    },
  },
  [CLAIRVOYANCE_ORDER]: {
    // `[Predict 5]`, second half — "put the rest back in ANY ORDER".
    //
    // Each answer names the card that goes on TOP next; it is moved to the front
    // of the deck and the question re-asks with the rest. A single survivor is
    // one option, which `advanceDecisions` retires without prompting — so an
    // ordering of one costs the player no click, and an ordering of none is never
    // parked at all.
    //
    // **Placed from the BOTTOM of the window upward.** Each answer is moved to
    // the front, so the LAST card answered ends up on top; asking "which goes on
    // top next" and prepending would reverse the player's intent. The prompt says
    // which end it is placing.
    prompt: (state, d) => `Predict: which card goes back next, under the ${(d.count ?? 0)} already placed?`,
    options: (state, d) =>
      lookedAtCards(state, d).map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId })),
    resolve: (state, d, optionId) => {
      const remaining = (d.cardInstanceIds ?? []).filter((id) => id !== optionId);
      const players = [...state.players] as [PlayerState, PlayerState];
      const owner = players[d.playerIndex];
      const chosen = owner.deck.find((c) => c.instanceId === optionId);
      if (!chosen) return state;
      players[d.playerIndex] = { ...owner, deck: [chosen, ...owner.deck.filter((c) => c.instanceId !== optionId)] };
      const moved = { ...state, players } as GameState;
      return remaining.length === 0
        ? finishPredict(moved, d.playerIndex)
        : repeatDecision(moved, { ...d, cardInstanceIds: remaining, count: (d.count ?? 0) + 1 });
    },
  },
  [BOTTLED_CONSTELLATION_PICK]: {
    // Bottled Constellation's cost — "kill 3 other friendly units and/or gear".
    //
    // **Accumulates, then pays.** Three picks are collected on
    // `cardInstanceIds` and NOTHING dies until the third is in: 355.10.c.1 makes
    // the kills the cost of the point, and a cost is all-or-nothing. Killing as
    // the picks came in would let a player back out two permanents down with
    // nothing to show, which no rule provides for.
    //
    // Decline is offered only on the FIRST pick — once a player has started
    // paying they have not yet paid anything, so backing out is free, and the
    // Decline stays available throughout for exactly that reason.
    //
    // The offer is rebuilt from live state and excludes what has already been
    // picked, so the same unit cannot pay twice.
    prompt: (state, d) =>
      `Bottled Constellation: kill ${BOTTLED_CONSTELLATION_KILLS - (d.cardInstanceIds?.length ?? 0)} more to score 1?`,
    options: (state, d) => {
      const picked = d.cardInstanceIds ?? [];
      return [
        { id: "decline", label: "Decline" },
        ...constellationFodder(state, d.playerIndex, d.cardInstanceId)
          .filter((c) => !picked.includes(c.instanceId))
          .map((c) => ({ id: c.instanceId, label: `Kill ${c.name}`, instanceId: c.instanceId })),
      ];
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      const picked = [...(d.cardInstanceIds ?? []), optionId];
      if (picked.length < BOTTLED_CONSTELLATION_KILLS) {
        return repeatDecision(state, { ...d, cardInstanceIds: picked });
      }
      // The cost is paid now, all at once. Re-checked against live state: the
      // picks were made across a queue, and 359.3.e's vanished-referent
      // convention means anything that has left play simply is not there to kill
      // — in which case the cost cannot be completed and nothing happens.
      const live = constellationFodder(state, d.playerIndex, d.cardInstanceId);
      if (!picked.every((id) => live.some((c) => c.instanceId === id))) return state;
      // Units through `destroyUnit`, gear through `killGear` — the split every
      // "kill a friendly permanent" cost in this engine makes, and the same two
      // calls `activated-abilities` pays its own kill cost with.
      const killed = picked.reduce((next, id) => {
        const gear = next.players[d.playerIndex].activeGear.find((g) => g.instanceId === id);
        return gear ? killGear(next, gear, d.playerIndex) : destroyUnit(next, id);
      }, state);
      return gainPoints(killed, d.playerIndex, 1);
    },
  },
  [JAYCE_READY]: {
    // Jayce's "you may ready SOMETHING BESIDES ME that's exhausted" — one
    // question kind for BOTH of his moments, parked from two registrations.
    //
    // A second kind would be a second option list to keep in step, and the
    // printed ability is one sentence with two triggers rather than two
    // abilities.
    //
    // "SOMETHING" is a unit OR a gear, and no owner word means either side's
    // (355.9.a.1) — readying an enemy permanent is a bad play rather than an
    // illegal one, and the card offers it.
    //
    // "BESIDES ME" drops him by instanceId. He is usually exhausted himself at
    // this moment (a unit enters exhausted), so without it he would be his own
    // most obvious target and the printed word would be free text.
    //
    // "THAT'S EXHAUSTED" filters the offer rather than being checked on
    // resolution: readying a ready permanent is a no-op, and offering it would
    // put a choice in front of the player that does nothing.
    //
    // Rebuilt from live state, like every option list here, so a permanent readied
    // in the response window is simply not offered by the time the answer comes.
    // A board with nothing to ready leaves a bare Decline, which
    // `advanceDecisions` retires without prompting.
    prompt: () => "Jayce: ready something exhausted?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...readyableForJayce(state, d.cardInstanceId).map((p) => ({
        id: p.instanceId,
        label: `Ready ${p.name}`,
        instanceId: p.instanceId,
      })),
    ],
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      // Re-checked against the live list rather than trusted: the question was
      // parked a chain-pop ago, and 359.3.e's vanished-referent convention is the
      // one every resolver here follows.
      const chosen = readyableForJayce(state, d.cardInstanceId).find((p) => p.instanceId === optionId);
      if (!chosen) return state;
      return readyPermanent(state, chosen.ownerIndex, optionId);
    },
  },
  /**
   * Frigid Jewel's "give a FRIENDLY unit +2 [Might] this turn", asked on the
   * second draw of each of her controller's turns.
   *
   * **FRIENDLY, unlike Rengar - Pridestalker's otherwise identical question**,
   * which says "a unit" and offers both sides. Hers prints the word, so the
   * option list is `eligibleTargets(..., "friendly", ...)` — and that is a real
   * difference rather than a nicety: on a board where the only unit is the
   * opponent's, "give a unit +2" has exactly one answer and it is not the one you
   * want.
   *
   * `"anywhere"`, because she names no location — 355.9.a.1's bare noun is the
   * whole board, base included.
   *
   * No decline: the card prints none, so with one friendly unit on the board
   * `advanceDecisions` auto-resolves it without a prompt.
   */
  "UNL-074-pump": {
    prompt: () => "Frigid Jewel: give a friendly unit +2 Might this turn",
    options: (state, d) =>
      eligibleTargets(state, d.playerIndex, "friendly", "anywhere").map((u) => ({
        id: u.instanceId,
        label: u.name,
        instanceId: u.instanceId,
      })),
    resolve: (state, _d, optionId) => giveMightThisTurn(state, optionId, FRIGID_JEWEL_MIGHT),
  },
  /**
   * Void Hatchling's look, before Teemo - Strategist's reveal.
   *
   * Registered under the SITE's defId, like the other four continuations: the
   * question is the Hatchling's and the body is Teemo's. `battlefieldId` was
   * captured when the trigger fired, because "an enemy unit HERE" is about the
   * combat that caused it and nothing on the board says which that was by the
   * time an answer arrives.
   */
  "OGN-121-reveal": {
    prompt: () => "Void Hatchling: recycle the top card before Teemo - Strategist reveals?",
    options: (state, d) => voidHatchlingOptions(state, d.playerIndex),
    resolve: (state, d, optionId) =>
      d.battlefieldId === undefined
        ? state
        : teemoStrategistReveal(voidHatchlingAnswer(state, d.playerIndex, optionId), d.playerIndex, d.battlefieldId),
  },

  /**
   * Zilean - Time Mage's "you may … instead" — see his `eventTriggers` entry for
   * the whole card and its divergences.
   *
   * The mark is written HERE, on accept only, because 371.2.b says a declined
   * replacement "has not been applied this turn". That is why this is a decision
   * with a real decline rather than a mandatory doubling.
   */
  "UNL-086-copy": {
    prompt: () => "Zilean - Time Mage: play an additional copy of that token?",
    options: (state, d) => {
      const played = d.targetInstanceId === undefined ? undefined : findUnitAnywhere(state, d.targetInstanceId);
      // NO options means the question has become moot and `advanceDecisions`
      // drops it — which also leaves the turn's use unspent, correctly: a
      // replacement that was never applied to anything was never applied.
      if (played === undefined || !played.unit.isToken) return [];
      return [
        { id: "copy", label: `Play an additional ${played.unit.name}`, instanceId: played.unit.instanceId },
        { id: "decline", label: "Decline" },
      ];
    },
    resolve: (state, d, optionId) => {
      if (optionId !== "copy" || d.targetInstanceId === undefined) return state;
      const played = findUnitAnywhere(state, d.targetInstanceId);
      const destination = played ? destinationOf(state, played.zone) : undefined;
      if (played === undefined || destination === undefined) return state;
      // MARKED BEFORE the copy is placed, and that ordering is what makes this
      // terminate: the copy holds its own `cardPlayed`, which reaches this same
      // Zilean, and only the mark stops him doubling his own copy forever.
      const marked = d.cardInstanceId === undefined ? state : rememberZileanDoubled(state, d.cardInstanceId);
      return placeToken(marked, d.playerIndex, destination, tokenSpecOf(played.unit));
    },
  },

  /**
   * Bard - Mercurial's destination - "to an OPEN battlefield" (170.11.c:
   * unoccupied and uncontrolled).
   *
   * Asked before the units for a reason that is not merely order: the first unit
   * to arrive OCCUPIES the battlefield and so makes it no longer open, and a
   * question that re-derived the destination each time would offer nothing after
   * the first move. Captured on `battlefieldId` and carried forward.
   *
   * No decline here - declining is what the second question's standing "stop"
   * is, and "any number" includes zero. One open battlefield is therefore one
   * option, which `advanceDecisions` resolves without ever showing it.
   */
  "SFD-079-where": {
    prompt: () => "Bard - Mercurial: which open battlefield?",
    options: (state) => state.battlefields.filter(isOpenBattlefield).map((bf) => ({ id: bf.id, label: bf.name })),
    resolve: (state, d, optionId) =>
      repeatDecision(state, { kind: "SFD-079-move", playerIndex: d.playerIndex, battlefieldId: optionId }),
  },
  /**
   * Bard - Mercurial's "move ANY NUMBER of your units" - asked once per unit,
   * with a standing "stop".
   *
   * Azir - Sovereign's shape (effects/order.ts) and it terminates the same way:
   * every answer that continues also removes a candidate, because the unit is now
   * there. "Stop" is always present, which is what lets `advanceDecisions` retire
   * the question once the last unit has arrived.
   *
   * `forceMoveToBattlefield`, not the Move ACTION: 414.3.a makes the exhaust part
   * of a Standard Move's cost rather than of moving, and this is a Game Effect
   * moving them (316.7.c) - so they arrive as they were. It applies Contested for
   * their controller (458), which on an OPEN battlefield means the caster simply
   * takes it.
   */
  "SFD-079-move": {
    prompt: () => "Bard - Mercurial: move a unit to that battlefield?",
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "stop", label: "Move no more units" }];
      if (d.battlefieldId === undefined) return options;
      for (const unit of movableUnitsFor(state, d.playerIndex, d.battlefieldId)) {
        options.push({ id: unit.instanceId, label: `Move ${unit.name}`, instanceId: unit.instanceId });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId === "stop" || d.battlefieldId === undefined) return state;
      const moved = forceMoveToBattlefield(state, optionId, d.battlefieldId);
      // Onto the FRONT: a continuation of the question being answered, not a new
      // one, so it cannot be interleaved with another trigger's question.
      return repeatDecision(moved, { kind: "SFD-079-move", playerIndex: d.playerIndex, battlefieldId: d.battlefieldId });
    },
  },
  "SFD-084-kill": {
    // Jayce - Man of Progress's "you may kill a friendly gear. If you do, ..."
    prompt: () => "Jayce - Man of Progress: kill a friendly gear to play one free this turn?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...state.players[d.playerIndex].activeGear.map((g) => ({
        id: g.instanceId,
        label: `Kill ${g.name}`,
        instanceId: g.instanceId,
      })),
    ],
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      const gear = state.players[d.playerIndex].activeGear.find((g) => g.instanceId === optionId);
      // Re-derived at answer time: the gear may have gone while the question
      // waited on the chain, and "if you do" then grants nothing.
      if (gear === undefined) return state;
      const killed = killGear(state, gear, d.playerIndex);
      // A COUNT, not a flag — two Jayces in a turn grant two windows. Same
      // reasoning as `nextUnitsEnterReady`, which this field sits beside.
      const players = [...killed.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        freeGearPlaysThisTurn: players[d.playerIndex].freeGearPlaysThisTurn + 1,
      };
      return { ...killed, players };
    },
  },
  "SFD-074-kill": {
    // Pickpocket's "you may kill a gear with Energy cost no more than [1]. If you
    // do, play a Gold gear token exhausted."
    prompt: () => "Pickpocket: kill a gear costing [1] or less?",
    options: (state) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      // BOTH sides — see the trigger above for why "a gear" is unqualified. The
      // owner index is encoded in the option id, because `killGear` needs to be
      // told whose list to remove it from and an instance id alone does not say.
      for (const ownerIndex of [0, 1] as const) {
        for (const gear of state.players[ownerIndex].activeGear) {
          if (gear.energyCost > PICKPOCKET_MAX_GEAR_COST) continue;
          options.push({
            id: `${ownerIndex}:${gear.instanceId}`,
            label: `Kill ${gear.name}`,
            instanceId: gear.instanceId,
          });
        }
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      const [ownerRaw, instanceId] = optionId.split(":");
      const ownerIndex = ownerRaw === "1" ? 1 : 0;
      const gear = state.players[ownerIndex].activeGear.find((g) => g.instanceId === instanceId);
      // Re-derived at answer time, the convention every decision here follows:
      // the gear may have been killed by something else while this waited, and
      // "if you do" then means no Gold.
      if (gear === undefined || gear.energyCost > PICKPOCKET_MAX_GEAR_COST) return state;
      // The Gold goes to the PLAYER WHO ASKED, not to the gear's owner — "play a
      // Gold gear token" is Pickpocket's controller playing it. Exhausted, as
      // printed, which `placeGoldTokens` already does for every Gold in the pool.
      return placeGoldTokens(killGear(state, gear, ownerIndex), d.playerIndex, 1);
    },
  },
  /**
   * Promising Future's first half — one player banishing one of their own top 5.
   *
   * Asked of BOTH players (the caster has no say over the opponent's pick), and
   * "looks at" is exactly the moment Nocturne - Horrifying's own text watches
   * for, which is why this goes through `lookAtTopOfDeck` rather than slicing
   * the deck itself.
   */
  "OGN-115-banish": {
    prompt: () => "Promising Future: banish one of the top 5 of your deck (the rest are recycled)",
    options: (state, d) =>
      state.players[d.playerIndex].deck.slice(0, 5).map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId })),
    resolve: (state, d, optionId) => {
      const looked = state.players[d.playerIndex].deck.slice(0, 5);
      const chosen = looked.find((c) => c.instanceId === optionId);
      if (!chosen) return state;
      // Off the top FIRST, recycling the other four to the bottom in the order
      // they were looked at (416) — so the banish and the recycle are reckoned
      // against the same five, and a deck shorter than five simply looks at what
      // it has (422).
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        deck: [
          ...players[d.playerIndex].deck.slice(looked.length),
          ...looked.filter((c) => c.instanceId !== chosen.instanceId),
        ],
        // Only the second real writer of the banished zone (Time Warp's "banish
        // this" is the other), and the first whose banish is OBSERVABLE for more
        // than an instant: every other banish here is transient — banished and
        // played in one instruction — while these sit banished until the second
        // half of the card plays them, the opponent's waiting there while the
        // caster is still choosing.
        banished: [...players[d.playerIndex].banished, chosen],
      };
      // "then RECYCLES the rest" — the four that were not banished.
      return holdCardsRecycled({ ...state, players }, d.playerIndex, looked.length - 1);
    },
  },
  /**
   * Promising Future's second half — one player playing what they banished,
   * "ignoring Energy costs. (They must still pay Power costs.)"
   *
   * A decision with exactly ONE option, which `advanceDecisions` resolves without
   * ever prompting. That is not a question dressed up as one: the step is
   * mandatory, and the queue is the only thing in this engine that can say
   * "after both players have finished choosing". Parked for the next player and
   * the caster behind the two banish questions, which is the whole of "starting
   * with the next player".
   *
   * **Unverified, and it is the card's one real gap:** a Spell played this way
   * resolves immediately with no targets, per `play-free`'s recorded divergence,
   * so a targeted Spell banished here does as much as it can and no more.
   */
  "OGN-115-play": {
    prompt: () => "Promising Future: play the card you banished, ignoring its Energy cost",
    options: () => [{ id: "play", label: "Play it" }],
    resolve: (state, d) => {
      const actor = state.players[d.playerIndex];
      // The LAST banished card is the one this player just banished. Safe
      // because a pending decision is the ONLY thing a player may act on
      // (legal-actions returns answers and nothing else while one is queued), so
      // no other card — not even Time Warp, the zone's other writer — can reach
      // the zone between the question above and this one.
      const card = actor.banished[actor.banished.length - 1];
      if (!card) return state;
      // "They must still pay Power costs" — and a player who cannot is a player
      // who does not play it (422). The card stays banished rather than being
      // played free, which is the difference between this and every other
      // ignoring-its-cost card in the pool.
      // A Legend is never in a Main Deck, so it can never be one of the five —
      // but `CardInstance` includes it and only the other three kinds print a
      // Power cost, so the narrowing is the compiler asking a real question.
      const powerCost = card.kind === "Legend" ? 0 : card.powerCost;
      const paid =
        powerCost > 0 && card.kind !== "Legend"
          ? payPowerFromChanneled(state, d.playerIndex, card.powerDomain, powerCost)
          : state;
      if (paid === undefined) return state;

      const players = [...paid.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        banished: players[d.playerIndex].banished.filter((c) => c.instanceId !== card.instanceId),
        cardsPlayedThisTurn: players[d.playerIndex].cardsPlayedThisTurn + 1,
      };
      return playCardIgnoringCost({ ...paid, players }, d.playerIndex, card);
    },
  },
  /**
   * Ava Achiever's "when I attack, you may pay [Mind] to play a card with
   * [Hidden] from your hand, ignoring its cost. If it's a unit, play it here."
   *
   * ONE question, not two: which card and whether to pay are the same decision,
   * because paying without naming a card buys nothing. Every option carries its
   * own price, so a pool that cannot afford the [Mind] offers only "decline" and
   * `advanceDecisions` retires the question without a prompt.
   *
   * `[Hidden]` is asked of the DEFINITION, never of the printed text — Ava
   * herself is one of the four cards that MENTION the keyword without carrying
   * it, so a text scan would let her play herself out of hand.
   */
  "OGN-107-play": {
    prompt: () => "Ava Achiever: pay 1 Mind to play a [Hidden] card from your hand, ignoring its cost?",
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      // Payability is asked once, of the pool, rather than per card: the price is
      // the same [Mind] whichever card is named.
      if (payPowerFromChanneled(state, d.playerIndex, "Mind", 1) === undefined) return options;
      const registry = defaultCardRegistry();
      for (const card of state.players[d.playerIndex].hand) {
        if (!isHiddenCard(registry.tryGet(card.defId))) continue;
        options.push({ id: card.instanceId, label: `Pay 1 Mind: play ${card.name}`, instanceId: card.instanceId });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      const chosen = state.players[d.playerIndex].hand.find((c) => c.instanceId === optionId);
      if (!chosen) return state;
      // Pay first, and do nothing if the Mind has gone since the offer — a
      // half-paid free play is the card without its price.
      const paid = payPowerFromChanneled(state, d.playerIndex, "Mind", 1);
      if (paid === undefined) return state;

      // Out of hand BEFORE playing, so the card is never in two zones at once.
      const players = [...paid.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        hand: players[d.playerIndex].hand.filter((c) => c.instanceId !== chosen.instanceId),
        // "PLAY a card" — this one IS a card you played, unlike the free plays
        // that a card's own text performs on itself, so [Legion] and Viktor -
        // Innovator both see it.
        cardsPlayedThisTurn: players[d.playerIndex].cardsPlayedThisTurn + 1,
      };
      // "If it's a unit, play it HERE" — the battlefield she attacked, captured
      // when the question was raised. A Gear or a Spell ignores it, neither
      // being a thing that stands anywhere.
      return playCardIgnoringCost({ ...paid, players }, d.playerIndex, chosen, d.battlefieldId);
    },
  },
  // Kai'Sa - Evolutionary's "you may play a spell from your trash ... then
  // recycle it", raised by her conquer trigger.
  //
  // Declining leads, as everywhere else a "you may" is asked. "THEN RECYCLE IT"
  // is the card's own answer to the loop it would otherwise be: the spell goes to
  // the BOTTOM OF THE DECK rather than back to the trash, so a second conquest
  // cannot replay the same one.
  "OGN-112-play": {
    prompt: () => "Kai'Sa - Evolutionary: play a spell from your trash for free?",
    options: (state, d) => [
      { id: "decline", label: "Decline" },
      ...evolutionaryCandidates(state, d.playerIndex).map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId })),
    ],
    resolve: (state, d, optionId) => {
      if (optionId === "decline") return state;
      const chosen = evolutionaryCandidates(state, d.playerIndex).find((c) => c.instanceId === optionId);
      if (!chosen) return state;
      // Out of the trash BEFORE playing, so the spell is not in two zones at once
      // and `playCardIgnoringCost`'s own trash step lands it exactly once.
      const players = [...state.players] as [PlayerState, PlayerState];
      players[d.playerIndex] = {
        ...players[d.playerIndex],
        trash: players[d.playerIndex].trash.filter((c) => c.instanceId !== chosen.instanceId),
      };
      const played = playCardIgnoringCost({ ...state, players }, d.playerIndex, chosen);
      // "Then RECYCLE it" — bottom of the Main Deck (416.1), taken back out of the
      // trash that `playCardIgnoringCost` just put it in.
      const after = [...played.players] as [PlayerState, PlayerState];
      after[d.playerIndex] = {
        ...after[d.playerIndex],
        trash: after[d.playerIndex].trash.filter((c) => c.instanceId !== chosen.instanceId),
        deck: [...after[d.playerIndex].deck, chosen],
      };
      return { ...played, players: after };
    },
  },
  /**
   * Aspiring Engineer's "return a gear from your trash to your hand".
   *
   * No decline option: the instruction carries no "you may", so with a gear in
   * the trash one comes back. Only GEAR is offered — the card names a kind, and
   * offering the rest of the trash would be a different, much better card.
   *
   * The one-gear case never reaches a human: `advanceDecisions` executes a
   * single-option question instead of prompting with it, which is also what makes
   * this shape usable for a mandatory instruction at all.
   */
  "SFD-061-return": {
    prompt: () => "Aspiring Engineer: return a gear from your trash to your hand",
    options: (state, d) =>
      gearsInTrash(state, d.playerIndex).map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId })),
    resolve: (state, d, optionId) => returnCardFromTrash(state, d.playerIndex, optionId),
  },
  /**
   * Bubble Bot's "ready another friendly Mech".
   *
   * `cardInstanceId` is BUBBLE BOT herself, captured when the question was
   * raised, and it is what "another" is measured against. Captured rather than
   * re-derived because by the time the answer arrives she may have been killed in
   * the response window — 809.1.b makes the ability independent of its source, so
   * the Mech is still readied, and an exclusion that could not name her would
   * quietly become an exclusion of nobody.
   *
   * The options are rebuilt from live state (as every decision's are), so a Mech
   * that was readied or killed while this waited is simply not on the list.
   */
  "SFD-062-ready": {
    prompt: () => "Bubble Bot: ready another friendly Mech",
    options: (state, d) =>
      readyableMechs(state, d.playerIndex, d.cardInstanceId ?? "").map((u) => ({
        id: u.instanceId,
        label: u.name,
        instanceId: u.instanceId,
      })),
    resolve: (state, _d, optionId) => readyUnit(state, optionId),
  },
  /**
   * Chemtech Cask's "you may exhaust me to play a Gold gear token exhausted",
   * raised by its cardPlayed trigger — which has already established that the
   * spell was YOURS, that it was a spell, that it was played on the opponent's
   * turn, and that the Cask was still ready when the ability resolved.
   *
   * Two options always, so `advanceDecisions` can never answer it for you: a "you
   * may" the engine resolves is not a "you may". Declining is a real play — the
   * Cask's exhaust is worth keeping for a bigger spell later in the same window,
   * since the trigger fires on EVERY spell you play on their turn.
   *
   * No `instanceId` on either option, deliberately, for the reason Solari Shrine's
   * question records: the board renders an option carrying one as the CARD, which
   * is right for "pick one of your units" and wrong for a yes/no.
   */
  "SFD-063-gold": {
    prompt: () => "Chemtech Cask: exhaust it to play a Gold gear token exhausted?",
    options: () => [
      { id: "gold", label: "Exhaust and play a Gold token" },
      { id: "decline", label: "Decline" },
    ],
    resolve: (state, d, optionId) => {
      if (optionId !== "gold" || !d.cardInstanceId) return state;
      // Exhaust FIRST, then make the token: the exhaust is the COST, and
      // `exhaustGear` no-ops on a Cask that has left play or been spent since the
      // offer — so a state where the price cannot be paid must not hand over the
      // Gold. Identity against the input state is how that no-op is detected,
      // exactly as Solari Shrine's draw detects it.
      const paid = exhaustGear(state, d.playerIndex, d.cardInstanceId);
      return paid === state ? state : placeGoldTokens(paid, d.playerIndex, 1);
    },
  },
  /**
   * Card Sharp's own half — "YOU ... may play a Gold gear token exhausted".
   *
   * Free, and there is no board on which taking it is wrong, but it is printed
   * "may" and so it is asked. Two options for the same reason Solari Shrine's
   * question has two: `advanceDecisions` executes a single-option question without
   * prompting, which would quietly rewrite the word.
   *
   * Deliberately NOT merged with the opponent's question below even though the two
   * are worded identically: they are answered by different players, and one
   * decision has one `playerIndex`.
   */
  "SFD-081-mine": {
    prompt: () => "Card Sharp: play a Gold gear token exhausted?",
    options: () => [
      { id: "gold", label: "Play a Gold token" },
      { id: "decline", label: "Decline" },
    ],
    resolve: (state, d, optionId) => (optionId === "gold" ? placeGoldTokens(state, d.playerIndex, 1) : state),
  },
  /**
   * Card Sharp's opponent-facing half — "each opponent may play a Gold gear token
   * exhausted. For each opponent who did, you play a Gold gear token exhausted."
   *
   * `d.playerIndex` is the OPPONENT (the chooser); the caster is the other seat,
   * derived rather than carried, which is Party Favors' precedent and is exact
   * while this engine is two-player (`GameState.players` is a 2-tuple).
   *
   * **The caster's bonus token is paid HERE, inside the opponent's answer, rather
   * than by a third queued step.** "For each opponent who did" needs to know what
   * the opponent chose, and nothing on the board records a choice — counting Gold
   * tokens afterwards would be reading a total that the caster's own half, or a
   * Chemtech Cask, could also have moved. With exactly one opponent, folding the
   * bonus into their answer produces the same tokens in the same order as a
   * separate step would (their token, then the caster's). It is the one place this
   * entry would need rewriting if the engine ever seated three players, and it is
   * written down rather than left to be discovered.
   *
   * The prompt states the consequence, because it IS the decision: a Gold for you
   * costs a Gold to the player who just played the card.
   */
  "SFD-081-theirs": {
    prompt: () => "Card Sharp: play a Gold gear token exhausted? (if you do, the caster plays one too)",
    options: () => [
      { id: "gold", label: "Play a Gold token (the caster gets one)" },
      { id: "decline", label: "Decline" },
    ],
    resolve: (state, d, optionId) => {
      if (optionId !== "gold") return state;
      const caster = (1 - d.playerIndex) as 0 | 1;
      return placeGoldTokens(placeGoldTokens(state, d.playerIndex, 1), caster, 1);
    },
  },
  /**
   * Ruined Rex's `[Deathknell]` — "Deal 4 to an enemy unit."
   *
   * `d.playerIndex` is the DEAD Rex's controller, so the enemies are the other
   * seat's — rebuilt from live state like every decision here, because the board
   * can move between the death and the answer (a simultaneous combat kills more
   * than one unit, and the funnel runs them one at a time).
   *
   * NO decline: the instruction carries no "you may". A single enemy is therefore
   * a one-option question, which `advanceDecisions` executes without prompting —
   * the same property that makes this shape usable for a mandatory instruction at
   * all (Aspiring Engineer's note above).
   *
   * The damage is dealt BY the Rex's controller, so a damage modifier on that side
   * (Annie - Fiery's +1) applies. A Deathknell resolving for a player whose unit
   * has already left the board is 809.1.b working as printed: the ability is
   * independent of the card that made it.
   */
  "UNL-067-shot": {
    prompt: () => "Ruined Rex: deal 4 to an enemy unit",
    options: (state, d) =>
      enemyUnitsOf(state, d.playerIndex).map((u) => ({ id: u.instanceId, label: u.name, instanceId: u.instanceId })),
    resolve: (state, d, optionId) => dealDamage(state, d.playerIndex, optionId, RUINED_REX_DAMAGE),
  },
  /**
   * Icevale Archer's "you may pay [1] to give a unit here -1 Might this turn".
   *
   * ONE question over both halves — whether to pay and which unit — because
   * paying without naming a unit buys nothing. Ava Achiever's shape, down to
   * pricing the pool ONCE rather than per option: the price is the same [1]
   * whichever unit is named.
   *
   * A pool that can no longer afford it offers only "decline", and
   * `advanceDecisions` retires that without prompting. Re-asked at ANSWER time as
   * well as at fire time for the reason Jax - Unrelenting's identical question
   * records: the Energy may have gone while this waited on the chain, and an
   * option offered then is one the resolver has to honour.
   *
   * BOTH sides' units are listed — see the trigger for why "a unit here" is
   * unqualified. `battlefieldId` was captured when the question was raised,
   * because "here" is about the combat that caused it and by the time an answer
   * arrives nothing on the board says which that was.
   */
  // "HERE" is re-checked against where the ARCHER is standing when this is
  // answered — a referent read from the ability's source (359.3.f.1), checked on
  // execution of the instruction (359.3.f.2), and the rules' worked example is
  // Fight or Flight sending Yasuo - Remorseful home in reaction to his attack
  // trigger so that "here" is no longer the battlefield the combat is at and the
  // trigger mistargets. An Archer who has left makes the whole question moot —
  // no options at all, so `advanceDecisions` drops it rather than showing a lone
  // Decline. Sinister Poro (UNL-137, effects/chaos.ts) checks its own "here" in
  // exactly this place, and that is the convention.
  "UNL-065-chill": {
    prompt: () => "Icevale Archer: pay [1] to give a unit here -1 Might this turn?",
    options: (state, d) => {
      if (d.battlefieldId === undefined || d.cardInstanceId === undefined) return [];
      const here = findUnitOnBattlefield(state, d.cardInstanceId);
      if (!here || state.battlefields[here.battlefieldIndex]!.id !== d.battlefieldId) return [];
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      if (payEnergyFromPool(state, d.playerIndex, ICEVALE_ENERGY_COST) === undefined) return options;
      for (const unit of unitsAtBattlefield(state, d.battlefieldId)) {
        options.push({ id: unit.instanceId, label: `Pay [1]: ${unit.name} gets -1 Might`, instanceId: unit.instanceId });
      }
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId === "decline" || d.battlefieldId === undefined) return state;
      // The named unit has to still be HERE: "a unit here" is where the question
      // was asked, and one that walked away in the meantime is not it (359.3.e).
      if (!unitsAtBattlefield(state, d.battlefieldId).some((u) => u.instanceId === optionId)) return state;
      // Pay first, and do nothing if the Energy has gone since the offer — a
      // half-paid effect is the card without its price. Same order, and the same
      // reason, as Ava Achiever's answer.
      const paid = payEnergyFromPool(state, d.playerIndex, ICEVALE_ENERGY_COST);
      if (paid === undefined) return state;
      // No `floor` argument, deliberately: the card prints no minimum, and the
      // rules say a Might below 0 is a real value that is merely TREATED as 0. See
      // the trigger's note.
      return giveMightThisTurn(paid, optionId, -ICEVALE_DEBUFF);
    },
  },
  /**
   * Eclipse's `[Predict]` — 436.1's "look at a single card from the top of the
   * Main Deck and choose whether or not to Recycle it".
   *
   * The options and the answer are the Void Hatchling's, unchanged, because her
   * "look at the top card first, you may recycle it" IS a Predict: one definition
   * of "recycle the top card, and hold it for Karma - Channeler" rather than two
   * that can disagree. Rebuilt from live state like every question here, so a
   * Nocturne who banished himself off the top in the FIFO slot ahead of this one
   * simply changes what the option describes.
   *
   * Two options whenever there is a card, so `advanceDecisions` can never answer a
   * "you may" for the player; an empty deck leaves one, which it retires unshown —
   * and that is 436.4's "Predict as many as possible", not a dropped instruction.
   */
  "UNL-063-predict": {
    prompt: () => "Eclipse: [Predict] — recycle the top card of your deck?",
    options: (state, d) => voidHatchlingOptions(state, d.playerIndex),
    resolve: (state, d, optionId) => voidHatchlingAnswer(state, d.playerIndex, optionId),
  },
  /**
   * Fate Weaver's "you may reveal a spell with Energy cost [4] or more from among
   * them and draw it. Recycle the rest."
   *
   * `decline` leads, as every "you may" here does, and it is NOT a no-op: the
   * recycle is a separate mandatory instruction, so declining still sends all four
   * to the bottom. That is the branch a `return state` would have silently eaten.
   *
   * Both branches recycle "THE REST" — the looked-at cards that did not go to hand
   * — through `holdCardsRecycled`, so Karma - Channeler counts them; and both read
   * the top four from LIVE state rather than from anything captured, which is the
   * convention every decision in this file follows.
   *
   * The take goes through `revealedFromDeck` first: the card is genuinely REVEALED
   * (425 keeps it in the deck while that happens), and that funnel is where "as I'm
   * revealed from your deck" lives. It contributes nothing today and is called
   * anyway — both of its clauses (Nocturne - Horrifying, Undertitan) are on UNITS,
   * and this choice is restricted to Spells, so it cannot double-offer the banish
   * the look above already made. The day a set prints a Spell with that clause, a
   * version that had skipped the funnel would be silently wrong.
   */
  /**
   * Diana - Lunari's "you may pay [1]".
   *
   * Its own question rather than a rider on the Predict, because the two are
   * different instructions with a conditional between them: "If you do" gates
   * everything after it, so declining must buy nothing at all.
   *
   * Two options whenever the Energy is there, so `advanceDecisions` can never
   * answer a "you may" for the player — Chemtech Cask's note. The trigger already
   * dropped the question whole when it is not, so this never shows a lone Decline.
   *
   * Re-priced at ANSWER time as well as at fire time, the convention every paid
   * decision in this file follows: the pool may have been spent while this waited
   * on the queue, and an option offered then is one the resolver has to honour.
   */
  "UNL-079-pay": {
    prompt: () => "Diana - Lunari: pay [1] to [Predict] and reveal the top card of your deck?",
    options: (state, d) => {
      const options: DecisionOption[] = [{ id: "decline", label: "Decline" }];
      if (payEnergyFromPool(state, d.playerIndex, DIANA_LUNARI_ENERGY) === undefined) return options;
      options.unshift({ id: "pay", label: "Pay [1]: [Predict], then reveal the top card" });
      return options;
    },
    resolve: (state, d, optionId) => {
      if (optionId !== "pay") return state;
      // Pay first, and do nothing if the Energy has gone since the offer — a
      // half-paid effect is the card without its price. Ava Achiever's order.
      const paid = payEnergyFromPool(state, d.playerIndex, DIANA_LUNARI_ENERGY);
      if (paid === undefined) return state;
      // The `[Predict]` LOOK is a look, so Nocturne - Horrifying's "as you look at
      // or reveal me" is owed on the top card and is offered FIRST — FIFO answers
      // him before the Predict, which is the order the two read in. Eclipse
      // (UNL-063) does the identical thing one registry up.
      const top = paid.players[d.playerIndex].deck[0];
      const looked = top ? offerTopOfDeckBanish(paid, d.playerIndex, [top]) : paid;
      return parkDecision(looked, { kind: "UNL-079-predict", playerIndex: d.playerIndex });
    },
  },
  /**
   * Diana - Lunari's `[Predict]` — 436.1's "look at a single card from the top of
   * the Main Deck and choose whether or not to Recycle it".
   *
   * The options and the answer are Void Hatchling's, unchanged, for the reason
   * Eclipse's entry records at length: her replacement step IS a Predict, so one
   * definition rather than two that can disagree, and the recycle is held through
   * `holdCardsRecycled` for Karma - Channeler.
   *
   * The REVEAL is queued behind the answer rather than run inside it, because the
   * reveal is itself a reveal-from-deck and Void Hatchling replaces those too
   * ("if you would reveal cards from a deck, look at the top card first"). So the
   * Predict's answer hands off to `voidHatchlingGate`, exactly as Teemo -
   * Strategist's trigger does — and with no Hatchling in play the gate runs the
   * reveal inline and nothing extra is asked.
   *
   * An empty deck leaves `voidHatchlingOptions` with its lone "leave the top
   * card", which `advanceDecisions` retires unshown — 436.4's "Predict as many as
   * possible", explicitly not a Burn Out (436.4.a).
   */
  "UNL-079-predict": {
    prompt: () => "Diana - Lunari: [Predict] — recycle the top card of your deck?",
    options: (state, d) => voidHatchlingOptions(state, d.playerIndex),
    resolve: (state, d, optionId) => {
      const answered = voidHatchlingAnswer(state, d.playerIndex, optionId);
      return voidHatchlingGate(
        answered,
        d.playerIndex,
        d.playerIndex,
        { kind: "UNL-079-reveal", playerIndex: d.playerIndex },
        (s) => dianaLunariReveal(s, d.playerIndex),
      );
    },
  },
  /**
   * Void Hatchling's look, before Diana - Lunari's reveal — the sixth
   * continuation registered under a SITE's defId, and identical in shape to
   * `OGN-121-reveal` above.
   *
   * Nothing is captured: the reveal reads the top of the deck from live state,
   * which is what it means for the Hatchling to have replaced the step.
   */
  "UNL-079-reveal": {
    prompt: () => "Void Hatchling: recycle the top card before Diana - Lunari reveals?",
    options: (state, d) => voidHatchlingOptions(state, d.playerIndex),
    resolve: (state, d, optionId) => dianaLunariReveal(voidHatchlingAnswer(state, d.playerIndex, optionId), d.playerIndex),
  },
  /**
   * Hwei - Brooding Painter's "discard 1. Then, do the following based on the
   * discarded card's type."
   *
   * **Its own question rather than the generic `discard` decision, and that is
   * forced.** That handler is shared and reports nothing back; the branch here is
   * about WHICH card went, and nothing on the board records it — the card is in
   * the trash beside everything else discarded this turn, and reading "the last
   * card in the trash" would be answered by anything else that reached the trash
   * in between.
   *
   * MANDATORY: no "you may" is printed, so there is no decline. A hand with
   * exactly one card is therefore not a question and `advanceDecisions` executes
   * it unshown, which is what makes this shape usable for a mandatory instruction
   * at all (Aspiring Engineer's note above). An EMPTY hand offers nothing and the
   * question is dropped — 422's do-as-much-as-you-can — which also drops the
   * branch, since a branch on "the discarded card's type" has no subject.
   *
   * `discardCards` with the card NAMED does the move, fires the discarded card's
   * own self-trigger (Scrapheap) and raises `cardsDiscarded` ONCE for the
   * instruction, which is what Jinx - Rebel across the table reads.
   */
  "UNL-080-discard": {
    prompt: () => "Hwei - Brooding Painter: discard 1",
    options: (state, d) =>
      state.players[d.playerIndex].hand.map((c) => ({ id: c.instanceId, label: c.name, instanceId: c.instanceId })),
    resolve: (state, d, optionId) => {
      const chosen = state.players[d.playerIndex].hand.find((c) => c.instanceId === optionId);
      // Gone while this waited: no card discarded, so no type, so no branch.
      if (!chosen) return state;
      const discarded = discardCards(state, d.playerIndex, 1, [chosen.instanceId]);
      switch (chosen.kind) {
        case "Spell":
          return drawCards(discarded, d.playerIndex, 1);
        case "Gear":
          // "Ready UP TO 2 runes" — `readyRunes` maxes it out rather than asking
          // which, the convention Annie - Dark Child and Sona - Harmonious already
          // set and that helper's own doc argues: readying is strictly beneficial,
          // so taking all of it IS the faithful reading of "up to N".
          return readyRunes(discarded, d.playerIndex, HWEI_RUNES);
        case "Unit":
          // "Give ME +3" is an instruction about a body, and
          // `giveMightThisTurnToOwnUnit` is the one call that answers "is this
          // still my unit in play" — a Hwei killed in the window this question
          // waited in gets nothing (359.3.e), while the discard above still
          // happened. `cardInstanceId` is Hwei, captured when the question was
          // raised, because by then nothing on the board says which mover asked.
          return d.cardInstanceId === undefined
            ? discarded
            : giveMightThisTurnToOwnUnit(discarded, d.playerIndex, d.cardInstanceId, HWEI_MIGHT);
        default:
          // A Legend is never in a hand, so this is the compiler's question rather
          // than the game's — and the card names three types, so a fourth doing
          // nothing is what the text says.
          return discarded;
      }
    },
  },
  "UNL-064-reveal": {
    prompt: () => "Fate Weaver: reveal a spell costing [4] or more and draw it? (the rest are recycled)",
    options: (state, d) => [
      { id: "decline", label: "Recycle all four" },
      ...fateWeaverCandidates(state, d.playerIndex).map((c) => ({
        id: c.instanceId,
        label: `Draw ${c.name}`,
        instanceId: c.instanceId,
      })),
    ],
    resolve: (state, d, optionId) => {
      const looked = fateWeaverLooked(state, d.playerIndex);
      if (looked.length === 0) return state;
      const chosen = fateWeaverCandidates(state, d.playerIndex).find((c) => c.instanceId === optionId);
      if (!chosen) {
        // Declined, or the named card has moved while this waited: recycle the
        // whole look. 416 puts them on the BOTTOM, in the order they were looked
        // at, which is what keeps a second look reckoned against a real deck.
        const players = [...state.players] as [PlayerState, PlayerState];
        const owner = players[d.playerIndex];
        players[d.playerIndex] = { ...owner, deck: [...owner.deck.slice(looked.length), ...looked] };
        return holdCardsRecycled({ ...state, players }, d.playerIndex, looked.length);
      }
      // Revealed while still in the deck (425), then drawn, then the rest go to the
      // bottom — which is exactly `takeOneFromTopAndRecycleRest`, and it recycles
      // `looked.length - 1` because the kept card is not one of "the rest".
      return takeOneFromTopAndRecycleRest(
        revealedFromDeck(state, d.playerIndex, [chosen]),
        d.playerIndex,
        FATE_WEAVER_LOOK,
        chosen.instanceId,
      );
    },
  },
  /**
   * Gutter Palace's Bird needs a LOCATION, and the card names none.
   *
   * 355.2: "For Units, choose a valid Location where that Unit will enter upon
   * being Played", with 355.2.a's default being the controller's Base or a
   * Battlefield they Control. `legal-actions` cannot fan that out for a
   * target-less activation, so it is asked — the same question Ultrasoft Poro
   * (UNL-160) raises for its own Birds, and deliberately the same option list so
   * two cards making the identical token do not offer different destinations.
   *
   * `mayPlayUnitAt` is asked per battlefield rather than once: Rockfall Path bars
   * arrivals at itself and nowhere else.
   *
   * Base is always on offer, so this question always has at least one answer and
   * `advanceDecisions` takes it unprompted on a board with no controlled
   * battlefield.
   */
  "UNL-088-place": {
    prompt: () => "Gutter Palace: where does the Bird go?",
    options: (state, d) => [
      { id: "base", label: "Your base" },
      ...state.battlefields
        .filter((bf) => bf.controllerId === state.players[d.playerIndex].id && mayPlayUnitAt(state, bf.id))
        .map((bf) => ({ id: bf.id, label: bf.name })),
    ],
    resolve: (state, d, optionId) => {
      const destination: TokenDestination = optionId === "base" ? "base" : { battlefieldId: optionId };
      return placeToken(state, d.playerIndex, destination, BIRD_TOKEN);
    },
  },
};

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
  [SKY_CRUISER]: {
    // Sky Cruiser — "Discard a gear, [1 Energy], [Exhaust]: Deal 4 to a unit at a
    // battlefield."
    //
    // A THREE-part cost, and the first part is the new one: `discardKind` narrows
    // the discard to gear. That narrowing decides whether the ability is OFFERED
    // at all (416.3 — a cost that cannot be completed is not one you may choose
    // to pay), which is why it lives in `discardableForCost` and is asked by the
    // affordability check, the enumerator, the validator and the payment rather
    // than being a check in this resolver.
    //
    // A hand of five spells therefore cannot activate this, and the ability
    // simply does not appear — the same treatment `exhaustableFriendlyUnits`
    // gives a board of exhausted units.
    //
    // "A unit AT A BATTLEFIELD" — printed location, so `scope: "battlefield"`
    // (355.9.b), and no owner word, so either side's.
    kind: "Unit",
    targeting: { kind: "unit", scope: "battlefield" },
    cost: { discard: 1, discardKind: "Gear", energy: SKY_CRUISER_ENERGY, exhaust: true },
    resolve: (state, ctx, action) =>
      action.targetUnitInstanceId
        ? dealDamage(state, ctx.casterIndex, action.targetUnitInstanceId, SKY_CRUISER_DAMAGE)
        : state,
  },
  [HEXTECH_FORMULA]: {
    // Hextech Formula — "This enters exhausted. [Exhaust]: Empower ANOTHER gear."
    //
    // Two clauses in two files again: the enter-exhausted half is a `deploy.ts`
    // table entry, this is the ability, and `coverage.ts` merges them.
    //
    // **"ANOTHER gear" is a real narrowing here, unlike Patched Porobot's**, and
    // the difference is worth stating because the two cards sit in one wave: the
    // Porobot is a UNIT counting gear, so "other" excludes nothing it could ever
    // have counted, while this IS a gear and would otherwise be its own best
    // target. Filtered on the OFFER rather than checked in the resolver, so the
    // enumerator never proposes a self-empower the resolver would then refuse.
    //
    // No owner word, so either side's gear is a legal target (355.9.a.1).
    // Empowering an ENEMY gear is a bad play rather than an illegal one, and the
    // card offers it — the reading every bare noun in this pool takes.
    //
    // `empowerPermanent` is the single writer of the status and no-ops on a gear
    // that is already Empowered (441.1.a's binary state), so "it becomes
    // Empowered if it's not already" is that helper's guard rather than a branch
    // here.
    kind: "Gear",
    targeting: { kind: "gear", excludesSelf: true },
    cost: { exhaust: true },
    resolve: (state, _ctx, action) =>
      action.targetPermanentInstanceId ? empowerPermanent(state, action.targetPermanentInstanceId) : state,
  },
  "UNL-088": {
    // Gutter Palace, second clause — "Discard 1, [Exhaust]: Play a 1 [Might] Bird
    // unit token with [Deflect]." (Its win condition is in `eventTriggers`.)
    //
    // Both halves of the price are declared. The discard is `ActivationCost`'s
    // own field — Unlicensed Armory's, the only other card in the pool that pays
    // one — so WHICH card goes rides on the action as `costDiscardCardInstanceId`
    // and is fanned out by `legal-actions`, rather than being taken off the front
    // of hand at resolution. That matters more here than it looks: the win
    // condition above wants EXACTLY 4 cards in hand, so the ability is also this
    // card's way of getting down to four, and the player has to be able to say
    // which card they are throwing.
    //
    // `exhaust` is what makes it once per turn, and `canPayActivationCost`
    // refuses an already-exhausted gear.
    //
    // The token is `BIRD_TOKEN` from token.ts — 1 Might, `[Deflect]`, shared by
    // the six printed cards across four domains that make it. A local copy that
    // lost the `[Deflect]` would be invisible until someone taxed it.
    //
    // No `entersReady`: 143.4.a's default stands and this card overrides nothing.
    //
    // The DESTINATION is a question (355.2) rather than an automatic base — see
    // `UNL-088-place` above, and Ultrasoft Poro's identical shape.
    kind: "Gear",
    cost: { discard: 1, exhaust: true },
    targeting: { kind: "none" },
    resolve: (state, ctx) => parkDecision(state, { kind: "UNL-088-place", playerIndex: ctx.casterIndex }),
  },
};


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
/** Gustwalker's threshold and bonus — "[Level 3][>] I have +1 [Might] and
 *  [Ganking]." */
const GUSTWALKER = "UNL-075";
const GUSTWALKER_LEVEL = 3;
const GUSTWALKER_MIGHT = 1;

/** `[Level N]` as a CONTINUOUS condition — 824.1.b.1 makes it "functionally short
 *  for 'While you have [N] or more XP, this card gains [Text]'", and 824.1.d turns
 *  the ability off again the moment XP drops below N, so it is read fresh on every
 *  evaluation rather than latched.
 *
 *  A private copy, like effects/body.ts's and effects/calm.ts's: the predicate is
 *  one comparison against `PlayerState.xp`, and the only place it could be shared
 *  from is a file this pass does not own. */
const atLevel = (state: GameState, ownerIndex: 0 | 1, threshold: number): boolean =>
  state.players[ownerIndex].xp >= threshold;

export const mightModifiers: Record<string, MightModifier> = {
  [GUSTWALKER]: {
    // Gustwalker — "[Hunt 2] [Level 3][>] I have +1 [Might] and [Ganking]."
    //
    // **THE MIGHT HALF ONLY.** The `[Ganking]` half needs a conditional keyword
    // GRANT, and `granted-keywords.ts`'s `CONDITIONAL_GRANTS` is module-private
    // with no per-domain seam — the twin of the gap `mightModifiers` itself was
    // added to close. Sivir - Mercenary (SFD-143) prints the identical
    // "I have +2 [Might] and [Ganking]" shape and needed BOTH: a
    // `CONDITIONAL_GRANTS` row AND a `GRANTED_ONLY_KEYWORDS` row in card-loader.ts
    // to stop the parser reading the bracket as a flat printed keyword.
    //
    // **Gustwalker has neither, so he currently carries `[Ganking]`
    // UNCONDITIONALLY** — measured off `createCardInstance`, whose keywords come
    // out `{Hunt: 2, Level: 3, Ganking: 1}` at 0 XP, and `validate-move-unit`
    // asks `hasKeyword(..., "Ganking")`, so he can move battlefield-to-
    // battlefield from the moment he lands. That is Sivir's bug verbatim, one
    // card later. Both files are shared and neither is this pass's, so it is
    // reported rather than half-fixed here — and this entry deliberately does
    // NOT compensate by withholding the Might, which would leave the card wrong
    // in two directions instead of one.
    //
    // `[Hunt 2]` needs nothing: it is keyword-keyed in triggers.ts
    // (`HUNT_TRIGGER_KEY`) and serves all twelve Hunt cards from one entry.
    //
    // The XP read is the OWNER's, not the asking player's — "while YOU have 3+
    // XP" is the controller's counter, and `effectiveMight` is called by both
    // sides. `unit.defId` is what makes this a SELF bonus rather than an aura:
    // every modifier is asked about every unit on every evaluation.
    defId: GUSTWALKER,
    bonus: (state, unit, ownerIndex) =>
      unit.defId === GUSTWALKER && atLevel(state, ownerIndex, GUSTWALKER_LEVEL) ? GUSTWALKER_MIGHT : 0,
  },
};
