import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { DeathknellEffect, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import { addBuff, dealDamage, dealDamageToEnemyUnitsAtBattlefield, readyUnit, spendBuff } from "../effect-helpers.js";
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
export const eventTriggers: Record<string, EventTriggerDefinition> = {};

/** Triggers a card fires about ITSELF — being played, discarded or killed. Keyed
 *  by that card's own defId, because at those moments it may not be in play for
 *  a listener walk to reach (see triggers.ts's SelfTriggerDefinition). */
export const selfTriggers: Record<string, SelfTriggerDefinition> = {};
