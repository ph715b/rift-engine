import type { MightModifier } from "../effective-might.js";
import type { ActivatedAbilityDefinition } from "../activated-abilities.js";
import type { DecisionDefinition } from "../decisions.js";
import type { DeathWatchDefinition, DeathknellDefinition, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { EffectDefinition } from "../card-effects.js";
import { counterSpell, spellsOnChain } from "../counter-spell.js";
import {
  addBuff,
  dealDamageToEnemyUnitsAtBattlefield,
  forceMoveToBattlefield,
  giveMightThisTurnToOwnUnit,
  ownUnitsEverywhere,
  readyUnit,
} from "../effect-helpers.js";

/**
 * Dual-domain (champion signature) cards whose FIRST domain in canonical order —
 * Fury, Calm, Mind, Body, Chaos, Order — is **Body**.
 *
 * So a `Body+X` card lives here whatever X is, and a card pairing an EARLIER
 * domain with Body lives in that domain's file instead. The rule is mechanical on
 * purpose: `mergeRegistries` throws when two files claim one defId, and avoiding
 * that needs every card to have exactly one derivable home rather than a judgment
 * call. Shared helpers are in `signature-shared.ts`.
 */

export const cardEffects: Record<string, EffectDefinition> = {
  "OGN-268": {
    // Bullet Time (Body + Chaos) — "Pay any amount of [rainbow] to deal that much
    // damage to all enemy units at a battlefield."
    //
    // The pool's only X cost. X rides on the action as `xAmount` rather than
    // being counted off `payment.rainbowRunes.length`, because that bucket ALSO
    // holds a [Deflect] surcharge — a Bullet Time aimed at a battlefield holding
    // a Deflect unit would otherwise read its own X as the tax plus the payment.
    // (The two cannot actually collide today: this targets a BATTLEFIELD, and
    // Deflect taxes choosing a UNIT. Carrying X explicitly is what keeps that an
    // observation rather than a dependency.)
    //
    // "ALL ENEMY units at a battlefield" — the caster's own units there are
    // untouched, which is what makes it castable into a fight you are losing.
    targeting: { kind: "battlefield" },
    resolve: (state, ctx, event) => {
      const amount = event.xAmount ?? 0;
      if (amount <= 0 || !event.targetBattlefieldId) return state;
      return dealDamageToEnemyUnitsAtBattlefield(state, ctx.casterIndex, event.targetBattlefieldId, amount);
    },
  },
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
  "SFD-204": {
    // On the Hunt (Body + Chaos) — "Ready your units."
    //
    // "YOUR units", no location named, so base and every battlefield —
    // `ownUnitsEverywhere` is exactly that walk. Gear and the Legend are NOT
    // readied: the card says units, and `readyPermanent` exists precisely for the
    // card (Miss Fortune - Captain) that names no type.
    //
    // The id list is snapshotted BEFORE the first ready rather than re-walked per
    // step. Nothing here can remove a unit today — but `readyUnit` holds a
    // `unitReadied` event, and Pirate's Haven answers it, so the list this
    // instruction applies to is the one that existed when it began.
    //
    // One event PER UNIT, not one for the instruction, and that is the primitive's
    // contract rather than a choice made here: `unitReadied` is per-unit at all
    // thirteen call sites and the Awaken already fires one per exhausted unit, which
    // is what Pirate's Haven's "give IT +1 [M]" is written against. (Contrast
    // `unitsStunned`, which is batched because Leona reads "one or more".)
    //
    // Rule 415's already-Ready guard lives inside `readyUnit`, so a board that was
    // already awake produces no events and no Might.
    targeting: { kind: "none" },
    resolve: (state, ctx) =>
      ownUnitsEverywhere(state, ctx.casterIndex)
        .map((u) => u.instanceId)
        .reduce((next, id) => readyUnit(next, id), state),
  },
  "SFD-206": {
    // Riposte (Body + Order) — "[Reaction] Choose a friendly unit AND a spell.
    // Counter that spell and give that unit +[Might] equal to that spell's
    // Energy cost this turn."
    //
    // # Both targets are announced, which is the whole of the card's shape
    //
    // It names TWO targets in one sentence, so it gets the `chainSpellAndUnit`
    // spec rather than a `chainSpell` plus a question asked at resolution. The
    // difference is not cosmetic: 355.8 makes a card with no legal target
    // **uncastable**, so printed Riposte cannot be played with no friendly unit
    // on the board, and choosing the unit later would make it castable in a state
    // the rules forbid — wider than printed. `riposte.test.ts` asserts the card is
    // NOT offered on an empty board, which is the assertion that would go red if
    // anyone re-approximated this.
    //
    // The response window is announced with it for the same reason: an opponent
    // seeing Riposte go on the chain knows which unit it will grow, and can
    // respond to that, exactly as in paper.
    //
    // # The rest
    //
    // **The Energy cost is read BEFORE the counter**, because `counterSpell` takes
    // the entry off the chain and the amount would be unrecoverable after. PRINTED
    // Energy, not what was paid — the same reading `matchesCostFilter` already
    // applies for Defy's cost filter, so a Repeat-boosted spell still gives its
    // printed number.
    //
    // **"A friendly unit" is a bare noun**, so `scope: "anywhere"` — 355.9.a.1's
    // reading reaches base, the same reading Blitzcrank - Impassive already uses.
    //
    // A vanished target is a no-op on both halves: two counters can name the same
    // spell and the second finds nothing, which `counterSpell`'s own comment calls
    // out as a real case rather than defensive padding. No spell means no cost to
    // read, so there is nothing to give either — and `giveMightThisTurnToOwnUnit`
    // re-checks ownership, so a unit that changed hands between announce and
    // resolution is not buffed by its new owner's opponent.
    targeting: { kind: "chainSpellAndUnit", owner: "friendly", scope: "anywhere" },
    resolve: (state, ctx, event) => {
      if (!event.targetChainCardInstanceId || !event.targetUnitInstanceId) return state;
      const target = spellsOnChain(state).find((e) => e.entry.card.instanceId === event.targetChainCardInstanceId);
      if (!target) return state;
      const amount = target.entry.card.energyCost;
      const countered = counterSpell(state, event.targetChainCardInstanceId);
      return giveMightThisTurnToOwnUnit(countered, ctx.casterIndex, event.targetUnitInstanceId, amount);
    },
  },
};

/** Empty, and deliberately declared: `effects/index.ts` reads every registry
 *  off every module, so a missing export is `undefined` at merge time rather
 *  than an empty table. Declaring them keeps adding a card here to one line.
 */
export const unitTriggers: Record<string, UnitTriggerDefinition> = {};
export const deathTriggers: Record<string, DeathknellDefinition> = {};
export const deathWatchTriggers: Record<string, DeathWatchDefinition> = {};
export const eventTriggers: Record<string, EventTriggerDefinition> = {};
export const selfTriggers: Record<string, SelfTriggerDefinition> = {};
export const decisions: Record<string, DecisionDefinition> = {};
export const activatedAbilities: Record<string, ActivatedAbilityDefinition> = {};
export const mightModifiers: Record<string, MightModifier> = {};
