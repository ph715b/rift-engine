import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { DeathknellEffect, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { DecisionDefinition } from "../decisions.js";
import {
  addBuff,
  channelRunesExhausted,
  dealDamage,
  dealDamageToEnemyUnitsAtBattlefield,
  drawCards,
  payPowerFromChanneled,
  readyPermanent,
  readyUnit,
  recycleCardFromHand,
  spendBuff,
} from "../effect-helpers.js";
import { readyableOthers } from "../unit-triggers.js";
import { parkDecision, type DecisionOption } from "../decisions.js";
import type { GameState, PlayerState } from "../../model/game-state.js";
import { effectiveMight } from "../effective-might.js";
import { findUnitAnywhere, type AnyUnitLocation } from "../target-lookup.js";

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
    // The Might-in-its-zone lookup below is duplicated from Gentlemen's Duel
    // rather than shared: the shared home for it would be effect-helpers.ts, and
    // this file's owner doesn't own that one. Worth folding into a single
    // `unitsDuel` helper the next time either card is touched.
    targeting: { kind: "unitSlots", slots: ["friendly", "enemy"], min: 2, scope: "anywhere" },
    resolve: (state, ctx, event) => {
      const friendlyId = event.targetUnitInstanceId!;
      const enemyId = event.secondTargetUnitInstanceId!;

      // A chosen unit can be gone by the time this resolves (killed by something
      // earlier on the chain) — then nobody duels, the same "target vanished"
      // no-op convention every other effect here uses.
      const friendlyLocation = findUnitAnywhere(state, friendlyId);
      const enemyLocation = findUnitAnywhere(state, enemyId);
      if (!friendlyLocation || !enemyLocation) return state;

      // A base unit has no battlefield id; auras keyed on location (Garen -
      // Commander) read that omission as "base".
      const mightCtx = (location: AnyUnitLocation) =>
        location.zone === "base"
          ? { isCombat: false }
          : { isCombat: false, battlefieldId: state.battlefields[location.zone.battlefieldIndex]!.id };
      const friendlyMight = effectiveMight(state, friendlyLocation.unit, friendlyLocation.ownerIndex, mightCtx(friendlyLocation));
      const enemyMight = effectiveMight(state, enemyLocation.unit, enemyLocation.ownerIndex, mightCtx(enemyLocation));

      const afterEnemyDamage = dealDamage(state, ctx.casterIndex, enemyId, friendlyMight);
      return dealDamage(afterEnemyDamage, ctx.casterIndex, friendlyId, enemyMight);
    },
  },
};

export const unitTriggers: Record<string, UnitTriggerDefinition> = {
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
};

/** [Deathknell] effects — rule 808, "When I die, [Effect]". Keyed by the DYING
 *  card's defId. Same one-file-one-owner rule as the registries above. */
export const deathTriggers: Record<string, DeathknellEffect> = {};

/** Listeners for board EVENTS other than a death (see triggers.ts's GameEvent).
 *  Keyed by the LISTENING card's defId. Same one-file-one-owner rule. */
export const eventTriggers: Record<string, EventTriggerDefinition> = {
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
    resolve: (state, listener, event) => {
      if (event.kind !== "unitBuffed") return state;
      // "A FRIENDLY unit" is measured against Mistfall's controller, not against
      // whoever caused the buff — buffing an enemy unit must not offer their
      // gear this trigger.
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
};

/** Exhausts a gear its controller owns — Mistfall pays with itself. */
function exhaustGear(state: GameState, playerIndex: 0 | 1, gearInstanceId: string): GameState {
  const players = [...state.players] as [PlayerState, PlayerState];
  players[playerIndex] = {
    ...players[playerIndex],
    activeGear: players[playerIndex].activeGear.map((g) => (g.instanceId === gearInstanceId ? { ...g, exhausted: true } : g)),
  };
  return { ...state, players };
}
