import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { DeathknellEffect, DeathWatchEffect, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { DecisionDefinition } from "../decisions.js";
import {
  dealDamage,
  discardCards,
  discardThenDraw,
  drawCards,
  giveMightThisTurn,
  giveMightThisTurnToOwnUnit,
  grantKeywordThisTurn,
  legionActive,
  ownUnitsEverywhere,
  payPowerFromChanneled,
  readyUnit,
} from "../effect-helpers.js";
import { isMighty } from "../granted-keywords.js";
import { killGear } from "../triggers.js";
import { parkDecision, type DecisionOption } from "../decisions.js";
import { findUnitAnywhere } from "../target-lookup.js";
import { playUnitToBase } from "../deploy.js";
import type { PlayerState } from "../../model/game-state.js";

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
export const cardEffects: Record<string, EffectDefinition> = {
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
};

export const unitTriggers: Record<string, UnitTriggerDefinition> = {
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
};

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
export const decisions: Record<string, DecisionDefinition> = {
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
      return playUnitToBase({ ...paid, players }, d.playerIndex, card);
    },
  },
};
