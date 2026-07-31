import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { DeathknellEffect, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { DecisionDefinition } from "../decisions.js";
import { dealDamage, discardCards, drawCards, payPowerFromChanneled } from "../effect-helpers.js";
import { parkDecision, type DecisionOption } from "../decisions.js";
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
};

/** [Deathknell] effects — rule 808, "When I die, [Effect]". Keyed by the DYING
 *  card's defId. Same one-file-one-owner rule as the registries above. */
export const deathTriggers: Record<string, DeathknellEffect> = {};

/** Listeners for board EVENTS other than a death (see triggers.ts's GameEvent).
 *  Keyed by the LISTENING card's defId. Same one-file-one-owner rule. */
export const eventTriggers: Record<string, EventTriggerDefinition> = {};

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
