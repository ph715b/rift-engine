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
import type { DecisionDefinition } from "../decisions.js";
import {
  dealDamage,
  completeDeath,
  discardCards,
  discardThenDraw,
  drawCards,
  giveMightThisTurn,
  giveMightThisTurnToOwnUnit,
  grantKeywordThisTurn,
  legionActive,
  ownUnitsEverywhere,
  payEnergyFromPool,
  payPowerFromChanneled,
  readyUnit,
  recycleUnitFromPlayToDeck,
  returnUnitToHand,
} from "../effect-helpers.js";
import { effectiveKeywords, isMighty } from "../granted-keywords.js";
import { effectiveMight } from "../effective-might.js";
import { modifiedEnergyCost } from "../cost-modifiers.js";
import { attackerIndexAt, isAttackingAt, isFightingAt } from "../combat-designation.js";
import { placeGoldTokens, placeToken, type TokenSpec } from "../token.js";
import {
  ARMORY_WARD_POWER,
  clearPaidDeathWard,
  pendingDeathFor,
  releasePendingDeath,
  reviveToBase,
} from "../death-ward.js";
import { killGear } from "../triggers.js";
import { parkDecision, type DecisionOption } from "../decisions.js";
import { findUnitAnywhere, findUnitOnBattlefield } from "../target-lookup.js";
import { playUnitToBase } from "../deploy.js";
import { playUnitFree } from "../free-play.js";
import { playCardIgnoringCost } from "../play-free.js";
import type { GameState } from "../../model/game-state.js";
import type { PlayerState } from "../../model/game-state.js";
import type { UnitInstance } from "../../model/card.js";
import { gainPoints } from "../effect-helpers.js";
import { wearerListener } from "../equipment.js";

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

export const cardEffects: Record<string, EffectDefinition> = {
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
    // "A unit" with no battlefield clause and no owner clause: 355.9.b puts a
    // unit in either base on the list, and nothing stops the caster arming an
    // enemy. [Assault N] is only worth anything to an ATTACKER, so pointing it at
    // an enemy is a legal misplay rather than a shape the targeting should
    // forbid.
    //
    // **Repeating this does nothing, and that is the correct outcome** — 817.1.a
    // makes multiple instances of a keyword redundant rather than cumulative, so
    // a second [Assault 2] is still [Assault 2] and NOT [Assault 4].
    // `grantKeywordThisTurn` takes a `Math.max` against what is already there,
    // which is exactly what "redundant" means for a numbered keyword. Paying this
    // card's Repeat cost is therefore a legal way to waste 1 Energy; the engine
    // offers it because the rules do, and repeat-keyword.test.ts asserts the
    // no-op so a future "fix" that makes it stack fails.
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
    // one other unit" with no location clause at all, which 355.9.b reads as
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
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const victimIndex = ctx.opponentIndex;
      const top = state.players[victimIndex].deck[0];
      if (!top) return state;
      const players = [...state.players] as [PlayerState, PlayerState];
      players[victimIndex] = { ...players[victimIndex], deck: players[victimIndex].deck.slice(1) };
      return playCardIgnoringCost({ ...state, players }, ctx.casterIndex, top);
    },
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
    // `scope: "anywhere"` — "a unit" is 355.9.b's bare noun. Icathian Rain is the
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
    // Damage first, THEN the draw — rule 359.3.e.5, "execute the game effect of
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
    // "Attacking" is 465 Step 1's Attacker designation, asked through
    // `attackerIndexAt`: the Attacker is the player who applied Contested, and
    // every unit of theirs standing at that battlefield is attacking. The
    // battlefield's `designatedInstanceIds` was the rejected alternative — it is
    // the sharper question (383.4.f's "gains the designation") but it is only
    // written by a Cleanup, so a unit that walked in and started the fight this
    // very action would read as NOT attacking and take 2 where the card says 4.
    // Answering off `contestedByIndex` cannot go stale that way; it survives for
    // as long as the Showdown does (190.6.a).
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
};

/** Against the Odds' per-enemy step, and Sudden Storm's two amounts — named
 *  because each is a printed number the resolver would otherwise read as a bare
 *  literal beside another bare literal. */
const AGAINST_THE_ODDS_PER_ENEMY = 2;
const BLOOD_RUSH_ASSAULT = 2;
const PIERCING_LIGHT_DAMAGE = 2;
const SUDDEN_STORM_BASE = 2;
const SUDDEN_STORM_VS_ATTACKER = 4;

export const unitTriggers: Record<string, UnitTriggerDefinition> = {
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
    // either side is legal (355.9.b). The target is still CHOSEN when Legion is
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
    // An empty hand discards nothing and is not an error — rule 422 discards as
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
    // rule 711 asks about a unit's CURRENT Might, so a 3-Might body standing
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
    // and either side is legal — 355.9.b's bare noun, the same call Cleave makes
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
};

/** Ferrous Forerunner's payout. A spec rather than a call to
 *  `placeRecruitToken`, because a Mech token is a different card: 3 Might, and
 *  the `Mech` tag is load-bearing (Rumble - Hotheaded's "your Mechs each have
 *  [Assault]" reads it, and the token is the archetype's whole point). No
 *  `entersReady` — 143.4.a's default stands, and the card says nothing else. */
const MECH_TOKEN: TokenSpec = { name: "Mech", might: 3, tag: "Mech" };

/** [Deathknell] effects — rule 808, "When I die, [Effect]". Keyed by the DYING
 *  card's defId. Same one-file-one-owner rule as the registries above. */
export const deathTriggers: Record<string, DeathknellEffect> = {
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
  "SFD-021": (state, ctx) => [0, 1].reduce((next) => placeToken(next, ctx.casterIndex, "base", MECH_TOKEN), state),
};

/** Listeners for board EVENTS other than a death (see triggers.ts's GameEvent).
 *  Keyed by the LISTENING card's defId. Same one-file-one-owner rule. */
/** Listeners for someone ELSE dying ("when a buffed friendly unit dies"), keyed
 *  by the LISTENING card's defId. Distinct from `deathTriggers` above, which is
 *  a [Deathknell] keyed by the DYING card. Same one-file-one-owner rule. */
export const deathWatchTriggers: Record<string, DeathWatchDefinition> = {};

export const eventTriggers: Record<string, EventTriggerDefinition> = {
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
      return enemiesAt(state, wearer.ownerIndex, wearer.battlefieldId).length === 0
        ? state
        : parkDecision(state, {
            kind: "SFD-016-shot",
            playerIndex: wearer.ownerIndex,
            battlefieldId: wearer.battlefieldId,
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
    // `recordConquest`: rule 474's Final Point restriction applies to a point
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
    // "HERE" is `event.battlefieldId`, not wherever he stands at resolution — 383
    // fixes the moment, and the response window a held trigger opens is exactly
    // when an opponent would move him. The TARGET is auto-selected in board
    // order, the same simplification every other attack trigger in this pool
    // makes and for the same structural reason: nothing carries a choice made
    // inside a Cleanup. Recorded Unverified in docs/rules-conformance.md with the
    // rest of that family.
    on: "combatBegan",
    applies: isAttackingAt,
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      if (listener.card.kind !== "Unit") return state;
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
    // (466.5.a, fired by combat.ts at both resolution shapes), and
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
    // standing at. A hold is 471.1.a's SCORING moment rather than mere presence,
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
};

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
  // 355.9.b's bare noun, the same reading Cleave and Gem Jammer take.
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

/** A unit's Might as this cost question asks it — rule 711's CURRENT Might, so an
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

export const decisions: Record<string, DecisionDefinition> = {
  /**
   * Recurve Bow's "deal 2 to an enemy unit here", raised by its WEARER attacking
   * or defending. `battlefieldId` is captured when the question is raised, so it
   * means where the combat happened rather than wherever the wearer has ended up
   * by the time the answer arrives — the same reason Blitzcrank - Impassive's
   * decision carries one.
   */
  "SFD-016-shot": {
    prompt: () => "Recurve Bow: deal 2 to which enemy unit here?",
    options: (state, d) =>
      d.battlefieldId === undefined
        ? []
        : enemiesAt(state, d.playerIndex, d.battlefieldId).map((u) => ({
            id: u.instanceId,
            label: u.name,
            instanceId: u.instanceId,
          })),
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
   * death (809.1.b.1), so no [Deathknell] fires and no death-watch sees it;
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
};

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
