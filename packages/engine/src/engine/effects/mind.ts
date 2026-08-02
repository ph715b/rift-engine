import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { DeathknellEffect, DeathWatchEffect, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { DecisionDefinition } from "../decisions.js";
import { drawCards } from "../effect-helpers.js";
import { controlsAnyFacedownCard } from "../hidden.js";
import { placeRecruitToken, placeToken, type TokenSpec } from "../token.js";
import {
  channelRunesExhausted,
  dealDamage,
  dealDamageToAllUnitsAtAllBattlefields,
  exhaustAllFriendlyUnits,
  giveMightThisTurn,
  giveMightThisTurnToAllEnemies,
  readyUnit,
  recycleUnitFromPlayToDeck,
  returnUnitToHand,
} from "../effect-helpers.js";
import { effectiveMight } from "../effective-might.js";
import { findUnitAnywhere, type AnyUnitLocation } from "../target-lookup.js";
import type { GameState, PlayerState } from "../../model/game-state.js";

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

/** The non-combat MightContext for a unit wherever it is standing — the same
 *  three lines Gentlemen's Duel and Kinkou Monk already write out, needed here
 *  because Convergent Mutation compares two units' Might across zones. */
function mightContextFor(state: GameState, location: AnyUnitLocation) {
  return location.zone === "base"
    ? { isCombat: false }
    : { isCombat: false, battlefieldId: state.battlefields[location.zone.battlefieldIndex]!.id };
}

export const cardEffects: Record<string, EffectDefinition> = {
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
    // battlefield", and rule 355.9.b settles what the bare noun means: the
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
    // mightThisTurn; a Buff (rule 710) is a persistent game object that would
    // survive the turn and only come off when the unit leaves play (rule 709).
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
    // and 355.9.b puts Bases among the public zones a target may be drawn from.
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
    // **HALF-REACHABLE — measured, not suspected.** legal-actions.ts collapses a
    // two-slot spec whose roles are equal (`symmetric = slots[0] === slots[1]`)
    // and enumerates only one ordering of each pair, on the reasoning that
    // (A,B) and (B,A) are "the SAME choice". True for Back to Back and
    // Singularity, which apply the same thing to each unit; FALSE here, where
    // the ordering IS the decision. So a real player or the AI is offered
    // exactly one of "grow A to B" / "grow B to A", and with a 5-Might A and a
    // 2-Might B it is the one that increases by 0. The resolver below is correct
    // and fires through submit for either ordering; only the enumeration is
    // short. Fixing it needs an `asymmetricSlots` opt-out in legal-actions.ts,
    // which is not this file — see cards-ready-mind.test.ts, which pins the
    // current behaviour so the gap stays visible instead of looking like a
    // working card.
    targeting: { kind: "unitSlots", slots: ["friendly", "friendly"], min: 2, scope: "anywhere" },
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
};

export const unitTriggers: Record<string, UnitTriggerDefinition> = {
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
    // reaches the opponent's base as well (355.9.b), which is what makes it a
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
    // placeToken applies Contested for a battlefield destination (190.4), which
    // matters: she can only be played to a battlefield she reinforces or one you
    // control, but a Showdown already staged there is promoted by the token
    // becoming present just as it would be by any other arrival.
    targeting: { kind: "none" },
    resolve: (state, ctx, _unitId, event) => placeToken(state, ctx.casterIndex, event.destination, SPRITE_TOKEN),
  },
};

/** [Deathknell] effects — rule 808, "When I die, [Effect]". Keyed by the DYING
 *  card's defId. Same one-file-one-owner rule as the registries above. */
export const deathTriggers: Record<string, DeathknellEffect> = {
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
  "OGN-096": (state, ctx) => drawCards(state, ctx.casterIndex, 1),
};

/** Listeners for board EVENTS other than a death (see triggers.ts's GameEvent).
 *  Keyed by the LISTENING card's defId. Same one-file-one-owner rule. */
/** Listeners for someone ELSE dying ("when a buffed friendly unit dies"), keyed
 *  by the LISTENING card's defId. Distinct from `deathTriggers` above, which is
 *  a [Deathknell] keyed by the DYING card. Same one-file-one-owner rule. */
export const deathWatchTriggers: Record<string, DeathWatchEffect> = {};

export const eventTriggers: Record<string, EventTriggerDefinition> = {
  "OGN-119": {
    // Ahri - Inquisitive — "When I attack or defend, give an enemy unit here
    // -2 Might this turn, to a minimum of 1 Might."
    //
    // "Attacks OR DEFENDS" is why this listens to `combatBegan` rather than
    // riding the on-attack table: that one fires only for the unit that moved
    // in. The same distinction Mask of Foresight already draws — which side
    // started the fight is deliberately not consulted.
    //
    // She must be AT the battlefield in question, and the target is auto-selected
    // from the enemies there (same precedent as the other combat triggers, filed
    // Unverified). The floor is her own printed clause.
    on: "combatBegan",
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      if (listener.battlefieldId !== event.battlefieldId) return state;
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
    // EFFECT, so "do as much as you can" applies (422) — a 2-card trash recycles
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
    resolve: (state, listener, event) => {
      // Narrowing the union is not ceremony: `dispatchEvent` already filters by
      // `on`, but the compiler cannot see that, and the check documents which
      // event this listener is reading fields off.
      if (event.kind !== "cardPlayed") return state;
      if (event.casterIndex !== listener.ownerIndex) return state; // not YOUR card
      if (state.activePlayerIndex === listener.ownerIndex) return state; // not an opponent's turn
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
    resolve: (state, listener, event) => {
      if (event.kind !== "cardPlayed") return state;
      if (event.casterIndex !== listener.ownerIndex) return state; // not YOUR gear
      if (event.playedKind !== "Gear") return state;
      return readyUnit(state, listener.card.instanceId);
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
export const decisions: Record<string, DecisionDefinition> = {};
