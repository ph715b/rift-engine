import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { DeathknellEffect, DeathWatchEffect, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { DecisionDefinition } from "../decisions.js";
import { addBuff, dealDamage, forceMoveToBattlefield, giveMightThisTurn, readyUnit, stunUnits } from "../effect-helpers.js";
import { effectiveMight } from "../effective-might.js";
import { findUnitAnywhere, findUnitOnBattlefield } from "../target-lookup.js";

/**
 * Card implementations for the **dual-domain** cards — one file, one owner.
 *
 * These are the champion signature cards: 15 Spells plus Tibbers (the pool's only
 * dual-domain Unit), each printed in two domains — Icathian Rain (Fury+Mind),
 * Super Mega Death Rocket! (Fury+Chaos), Zenith Blade (Calm+Order), and so on.
 *
 * They get their own file because per-domain ownership is genuinely ambiguous for
 * them: a Fury+Chaos card belongs equally to fury.ts and chaos.ts, so filing it
 * by "first domain" would be arbitrary and two owners could each reasonably
 * believe it was theirs. One explicit owner removes the question.
 *
 * The ownership rule is enforced by test/effect-registry.test.ts: a defId may
 * only appear here if its CardDefinition has exactly two domains. Single-domain
 * cards belong in the matching effects/<domain>.ts; Legends belong in
 * engine/legend-abilities.ts (all 16 are dual-domain, so splitting them by domain
 * would put every one of them here).
 *
 * See effects/fury.ts's header for what adding a card owes: registration, a rule
 * or oracle citation, and an engine test.
 */
export const cardEffects: Record<string, EffectDefinition> = {
  "OGN-270": {
    // Showstopper (Body + Order) — "Buff a friendly unit in your base, then move
    // it to a battlefield."
    //
    // `scope: "base"` is the narrowest targeting in the pool and it is
    // load-bearing, not decoration: under the usual battlefield scope the card
    // would offer a unit already at a battlefield and "then move it" would be a
    // sideways shuffle rather than the deploy the card is for. It is also what
    // makes the spell honestly uncastable with an empty base.
    //
    // Buff FIRST, then move — printed order, and it matters rather than being
    // pedantry: Sett - Kingpin counts buffed friendly units AT HIS BATTLEFIELD,
    // so a unit that arrives already buffed is worth a point of his Might the
    // moment it lands. Doing it the other way round would still buff the right
    // unit, but through an intermediate state the card never describes.
    targeting: { kind: "unit", owner: "friendly", scope: "base" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId && event.destinationBattlefieldId
        ? forceMoveToBattlefield(addBuff(state, event.targetUnitInstanceId), event.targetUnitInstanceId, event.destinationBattlefieldId)
        : state,
  },
  "OGN-266": {
    // Siphon Power (Mind + Order) — "Choose a battlefield. Give friendly units
    // there +1 Might this turn and enemy units there -1 Might this turn, to a
    // minimum of 1 Might."
    //
    // "THERE" on both halves, so this is strictly positional — nothing in base
    // moves. The floor is printed on the debuff half only, and applied per unit
    // by giveMightThisTurn.
    //
    // Both halves resolve off the SAME battlefield snapshot taken before either
    // is applied. Nothing here kills, so the lists cannot shrink, but reading
    // them once is what keeps that true if a modifier ever does.
    targeting: { kind: "battlefield" },
    resolve: (state, ctx, event) => {
      const bf = state.battlefields.find((b) => b.id === event.targetBattlefieldId);
      if (!bf) return state;
      const casterId = state.players[ctx.casterIndex].id;
      const friendly = (bf.units[casterId] ?? []).map((u) => u.instanceId);
      const enemy = Object.entries(bf.units)
        .filter(([ownerId]) => ownerId !== casterId)
        .flatMap(([, units]) => units.map((u) => u.instanceId));

      const pumped = friendly.reduce((next, id) => giveMightThisTurn(next, id, 1), state);
      return enemy.reduce((next, id) => giveMightThisTurn(next, id, -1, 1), pumped);
    },
  },
  "OGN-262": {
    // Zenith Blade (Calm + Order) — "[Action] Stun an enemy unit at a
    // battlefield. You may move a friendly unit to that enemy unit's
    // battlefield."
    //
    // `min: 1`: the stun is mandatory, the move is "you may". That is exactly
    // what a two-slot spec with a minimum of one expresses — enumeration offers
    // both the stun-only variant and every stun+move pair, so declining is a
    // real choice rather than a target the player leaves blank.
    //
    // `slotScopes` because the two halves are scoped differently in print: the
    // enemy is "at a battlefield", the friendly is not, and the friendly you
    // most want to send is the one standing in base. Reading one scope for both
    // would either forbid that or make the enemy targetable in their own base.
    //
    // The destination is NOT chosen — it is "that enemy unit's battlefield",
    // read off the board at resolution. A unit that has left the battlefield in
    // between (killed on the chain, moved) leaves nothing to move to, and the
    // stun still happens: the move is the optional half.
    //
    // forceMoveToBattlefield, not the MoveUnit executor: 415.1.b puts the
    // exhaust on the Standard Move ACTION, so a unit sent by a spell arrives
    // ready, and 458 contests the destination for the MOVED unit's controller.
    // Here that is the caster's own unit walking into the enemy's battlefield,
    // which is the whole point of the card.
    targeting: {
      kind: "unitSlots",
      slots: ["enemy", "friendly"],
      min: 1,
      slotScopes: ["battlefield", "anywhere"],
    },
    resolve: (state, ctx, event) => {
      const enemyId = event.targetUnitInstanceId;
      if (!enemyId) return state;
      // Where the enemy is must be read BEFORE the stun, not because stunning
      // moves anything (it does not) but because Eclipse Herald and Leona fire
      // inside stunUnits and either could kill or relocate it.
      const enemyBattlefield = findUnitOnBattlefield(state, enemyId);
      const stunned = stunUnits(state, ctx.casterIndex, [enemyId]);

      const friendlyId = event.secondTargetUnitInstanceId;
      if (!friendlyId || !enemyBattlefield) return stunned;
      return forceMoveToBattlefield(stunned, friendlyId, state.battlefields[enemyBattlefield.battlefieldIndex]!.id);
    },
  },
  "OGN-260": {
    // Last Breath (Calm + Chaos) — "[Action] Ready a friendly unit. It deals
    // damage equal to its Might to an enemy unit at a battlefield."
    //
    // `slotScopes`, the second card in the pool to need them (Zenith Blade above
    // is the first) and for the same printed reason: the enemy is "at a
    // battlefield" and the friendly is not. The unit you most want to ready is
    // usually the exhausted one sitting at home, and a single scope would either
    // forbid that or make the enemy reachable in their own base.
    //
    // `min: 2` — BOTH halves are mandatory and both are targets, so 355.8 settles
    // castability outright: "in order to put a spell or ability on the chain,
    // valid choices must be made for all targets." This is not a "do as much as
    // you can" card the way Back to Back's "two friendly units" is; there is no
    // "up to" anywhere in the text, so with no enemy at a battlefield the spell
    // simply cannot be played, ready or no ready.
    //
    // Ready FIRST, then damage — printed order. Nothing in this pool makes
    // readying change a Might, so the two orders agree today; doing it in the
    // card's order is what keeps that true when something does (and it is the
    // order a player watching the board expects).
    //
    // Might is read through effectiveMight at resolution, like Gentlemen's Duel's
    // exchange: buffs, this-turn modifiers and continuous auras all count, and
    // the damage lands from the CASTER (`ctx.casterIndex`) because the unit
    // dealing it is theirs — which is what feeds Annie - Fiery's damage bonus.
    targeting: {
      kind: "unitSlots",
      slots: ["friendly", "enemy"],
      min: 2,
      slotScopes: ["anywhere", "battlefield"],
    },
    resolve: (state, ctx, event) => {
      const friendlyId = event.targetUnitInstanceId;
      if (!friendlyId) return state;
      const readied = readyUnit(state, friendlyId);

      const enemyId = event.secondTargetUnitInstanceId;
      if (!enemyId) return readied;
      // Located AFTER the ready rather than before, so the Might read is the one
      // the board holds at the moment the damage is dealt.
      const location = findUnitAnywhere(readied, friendlyId);
      if (!location) return readied; // it left play while this sat on the chain
      const might = effectiveMight(
        readied,
        location.unit,
        location.ownerIndex,
        location.zone === "base"
          ? { isCombat: false }
          : { isCombat: false, battlefieldId: readied.battlefields[location.zone.battlefieldIndex]!.id },
      );
      return dealDamage(readied, ctx.casterIndex, enemyId, might);
    },
  },
  "OGN-250": {
    // Stormbringer (Fury + Body) — "Choose a friendly unit in your base. Deal
    // damage equal to its Might to all enemy units at a battlefield, then move
    // your unit there."
    //
    // Showstopper's exact shape: a `unit` target scoped to BASE plus a
    // battlefield riding on `destinationBattlefieldId`, which is only enumerated
    // for cards named in card-effects.ts's MOVE_TARGET_SPELL_DEF_IDS. Registering
    // this without that entry would be worse than leaving the card dead — it
    // would be castable, the destination would always arrive undefined, and
    // coverage would report a card that does nothing as done.
    //
    // `scope: "base"` is printed ("in your base") and load-bearing for the same
    // reason as Showstopper's: "then move your unit there" is a deploy, and a
    // unit already at a battlefield would make it a sideways shuffle.
    //
    // **Damage FIRST, then move, and the order is the card.** The unit is in
    // BASE while it fires, so it is not at the battlefield it is bombarding —
    // which means it takes nothing back, and it is not counted among "all enemy
    // units at a battlefield" by anything reading that battlefield's occupants.
    // Moving first would walk it into a fight it then damages from inside.
    //
    // Might is read ONCE, before the damage, and read EFFECTIVE (auras and
    // this-turn pumps count, `isCombat: false` because this is not a Showdown —
    // the same reading Gentlemen's Duel and Last Breath already take). Reading it
    // per target would let the first kill's Deathknell change what the rest take.
    targeting: { kind: "unit", owner: "friendly", scope: "base" },
    resolve: (state, ctx, event) => {
      const { targetUnitInstanceId: unitId, destinationBattlefieldId: destination } = event;
      if (!unitId || !destination) return state;
      const location = findUnitAnywhere(state, unitId);
      if (!location) return state;

      const might = effectiveMight(state, location.unit, ctx.casterIndex, { isCombat: false });
      const bf = state.battlefields.find((b) => b.id === destination);
      if (!bf) return state;
      const casterId = state.players[ctx.casterIndex].id;
      const enemyIds = Object.entries(bf.units)
        .filter(([ownerId]) => ownerId !== casterId)
        .flatMap(([, units]) => units.map((u) => u.instanceId));

      const bombarded = enemyIds.reduce((next, id) => dealDamage(next, ctx.casterIndex, id, might), state);
      // "THEN move your unit there" — unconditional, so the unit deploys even if
      // the damage killed nothing and even if it killed everything. Through
      // forceMoveToBattlefield, which is what applies Contested and stages the
      // Showdown; a raw list splice would deploy it into a fight that never opens.
      return forceMoveToBattlefield(bombarded, unitId, destination);
    },
  },
};

export const unitTriggers: Record<string, UnitTriggerDefinition> = {};

/** [Deathknell] effects — rule 808, "When I die, [Effect]". Keyed by the DYING
 *  card's defId. Same one-file-one-owner rule as the registries above. */
export const deathTriggers: Record<string, DeathknellEffect> = {};

/** Listeners for board EVENTS other than a death (see triggers.ts's GameEvent).
 *  Keyed by the LISTENING card's defId. Same one-file-one-owner rule. */
/** Listeners for someone ELSE dying ("when a buffed friendly unit dies"), keyed
 *  by the LISTENING card's defId. Distinct from `deathTriggers` above, which is
 *  a [Deathknell] keyed by the DYING card. Same one-file-one-owner rule. */
export const deathWatchTriggers: Record<string, DeathWatchEffect> = {};

export const eventTriggers: Record<string, EventTriggerDefinition> = {};

/** Triggers a card fires about ITSELF — being played, discarded or killed. Keyed
 *  by that card's own defId, because at those moments it may not be in play for
 *  a listener walk to reach (see triggers.ts's SelfTriggerDefinition). */
export const selfTriggers: Record<string, SelfTriggerDefinition> = {};

/** Questions this domain's cards stop to ask — see engine/decisions.ts. Keyed by
 *  a `kind` string rather than a defId, since one card can ask more than one
 *  kind of question; the one-file-one-owner rule still applies, and the key is
 *  prefixed with the card's defId so ownership stays readable. */
export const decisions: Record<string, DecisionDefinition> = {};
