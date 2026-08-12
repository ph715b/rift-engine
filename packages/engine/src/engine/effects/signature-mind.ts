import type { MightModifier } from "../effective-might.js";
import type { ActivatedAbilityDefinition } from "../activated-abilities.js";
import type { DecisionDefinition } from "../decisions.js";
import type { DeathWatchDefinition, DeathknellDefinition, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { EffectDefinition } from "../card-effects.js";
import type { UnitInstance } from "../../model/card.js";
import type { PlayerState } from "../../model/game-state.js";
import { defaultCardRegistry } from "../../cards/card-registry.js";
import {
  banishCard,
  borrowUnitInPlace,
  dealDamage,
  giveMightThisTurn,
  readyUnit,
  removeUnitAnywhere,
} from "../effect-helpers.js";
import { playUnitFree } from "../free-play.js";
import { isHiddenCard } from "../hidden.js";
import { findUnitAnywhere } from "../target-lookup.js";

/**
 * Dual-domain (champion signature) cards whose FIRST domain in canonical order —
 * Fury, Calm, Mind, Body, Chaos, Order — is **Mind**.
 *
 * So a `Mind+X` card lives here whatever X is, and a card pairing an EARLIER
 * domain with Mind lives in that domain's file instead. The rule is mechanical on
 * purpose: `mergeRegistries` throws when two files claim one defId, and avoiding
 * that needs every card to have exactly one derivable home rather than a judgment
 * call. Shared helpers are in `signature-shared.ts`.
 */

export const cardEffects: Record<string, EffectDefinition> = {
  "OGN-264": {
    // Guerilla Warfare (Mind + Chaos) — "Return up to two cards with [Hidden]
    // from your trash to your hand. You can hide cards ignoring costs this turn."
    //
    // The second sentence is a this-turn WAIVER, not a charge: it says "cards",
    // plural, so it is not spent by the first Hide. Read through
    // `hidden.hideCostFor`, which the enumerator, the validator and the executor
    // all price through — three sites that must agree about what a Hide costs.
    //
    // "UP TO two" is 0-2, so the spell is castable with an empty trash and does
    // only its second half. The return is taken from the front of the matching
    // cards rather than offered as a choice: every `[Hidden]` card in the trash is
    // interchangeable for the purpose ("return up to two", no restriction on
    // which), and this engine's convention is to ask only where the choice is
    // real. Recorded Unverified — a player might prefer a specific one.
    targeting: { kind: "none" },
    resolve: (state, ctx) => {
      const actor = state.players[ctx.casterIndex];
      // `isHiddenCard` takes a DEFINITION (the keyword is printed, not per
      // instance), so the trash card is resolved through the registry first.
      const returning = actor.trash.filter((c) => isHiddenCard(defaultCardRegistry().get(c.defId))).slice(0, 2);
      const ids = new Set(returning.map((c) => c.instanceId));
      const players = [...state.players] as [PlayerState, PlayerState];
      players[ctx.casterIndex] = {
        ...actor,
        trash: actor.trash.filter((c) => !ids.has(c.instanceId)),
        hand: [...actor.hand, ...returning],
        hideIgnoresCostThisTurn: true,
      };
      return { ...state, players };
    },
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
  "SFD-200": {
    // Arcane Shift (Mind + Chaos) — "[Action] Banish a friendly unit, then its
    // owner plays it, ignoring its cost. Deal 3 to an enemy unit at a battlefield.
    // Banish this."
    //
    // Last Breath's slot shape, and for the same printed reason: the enemy is "at a
    // battlefield" and the friendly is not, so the two halves are scoped
    // differently. `min: 2` because neither half says "up to" — 355.8 again.
    //
    // **A BLINK, and it differs from Portal Rescue's by one printed word.** Portal
    // Rescue reads "plays it TO THEIR BASE" and so calls `playUnitToBase`; this one
    // says only "plays it", which is the ordinary permission — so it goes through
    // `playUnitFree`, which offers the destinations a paid play would have offered.
    // Reading the two the same way would silently delete the card's best line
    // (blinking a unit onto a battlefield you already hold).
    //
    // The banish is TRANSIENT — banished and replayed in one instruction, nothing
    // can observe the middle zone — so the unit goes straight to play rather than
    // through `PlayerState.banished`. "BANISH THIS" is the other kind: the spell
    // genuinely stays there, which is why `banishCard` is called for it and not for
    // the unit. Time Warp is the only other real writer of that zone.
    //
    // A fresh copy, exactly as Portal Rescue rebuilds one: 705 strips the Buff on
    // leaving play, and damage / this-turn Might / stun are properties of the body
    // that left.
    //
    // **Known ordering wrinkle, inherited rather than introduced:** when the blinked
    // unit has more than one legal destination, `playUnitFree` PARKS the question,
    // so the damage below lands before the unit actually arrives. The card's printed
    // order is play-then-damage. Nothing in this pool can observe the difference
    // (the damage target is an enemy, chosen at announce time), but it is a real
    // deferral and not a claim that the order is preserved.
    targeting: {
      kind: "unitSlots",
      slots: ["friendly", "enemy"],
      min: 2,
      slotScopes: ["anywhere", "battlefield"],
    },
    resolve: (state, ctx, event) => {
      const friendlyId = event.targetUnitInstanceId;
      const found = friendlyId ? findUnitAnywhere(state, friendlyId) : undefined;
      let next = state;
      if (friendlyId && found) {
        const returning: UnitInstance = {
          ...found.unit,
          damage: 0,
          mightThisTurn: 0,
          buffed: false,
          stunned: false,
          movesThisTurn: 0,
        };
        // "ITS OWNER plays it", not the caster — `found.ownerIndex`, the same
        // reading Portal Rescue takes. Friendly-only targeting makes the two the
        // same player today; naming it is what keeps that an observation.
        next = playUnitFree(removeUnitAnywhere(state, friendlyId), found.ownerIndex, returning);
      }

      const enemyId = event.secondTargetUnitInstanceId;
      if (enemyId) next = dealDamage(next, ctx.casterIndex, enemyId, 3);
      // "Banish this" — the spell is already in the caster's trash by now (the
      // ordinary cast path trashes at announce), and `banishCard` looks there.
      return ctx.sourceCardInstanceId ? banishCard(next, ctx.casterIndex, ctx.sourceCardInstanceId) : next;
    },
  },
  "SFD-202": {
    // Hostile Takeover (Mind + Order) — "[Hidden] Take control of an enemy unit
    // at a battlefield. Ready it. (Start a combat if other enemies are there.
    // Otherwise, conquer.) Lose control of that unit and recall it at end of
    // turn. (Send it to base. This isn't a move.)"
    //
    // # What was actually missing
    //
    // `takeControlOfUnit` existed and is the wrong half of the card: it recalls to
    // the taker's BASE, which is what makes Possession's permanent theft safe, and
    // this card's whole parenthetical is about the unit staying where it stands.
    // `borrowUnitInPlace` is that half — it leaves the unit at the battlefield and
    // applies Contested for its new controller (190.3.a's "or otherwise becomes
    // present"), which is what "start a combat if other enemies are there,
    // otherwise conquer" describes. Both outcomes fall out of Contested rather
    // than being branched on here: the Cleanup opens a Combat Showdown when both
    // players have units present and a Non-Combat one when they do not, and 348.2.a
    // is what turns the second into a conquest.
    //
    // The REVERSAL genuinely did not exist, exactly as the handoff said. In this
    // engine control IS which player's list a unit sits in — the row
    // docs/rules-conformance.md carries — so a stolen unit is indistinguishable
    // from an owned one and nothing could ever give it back. One optional field on
    // the unit (`returnControlAtEndOfTurnToIndex`) is the whole of the memory that
    // model lacked, and `runEnd` discharges it.
    //
    // # The ready, and the order
    //
    // "Ready it" AFTER the theft, printed order, and it matters: `readyUnit` is
    // gated by `mayReadyPermanent`, which refuses to ready an ENEMY unit under
    // Mageseeker Warden. By the time this runs the unit is ours, so the Warden
    // does not bite — which is right, since it is our unit being readied.
    //
    // A ready is also what makes the borrowed body worth having: it arrives on our
    // side able to fight, where a unit that had already attacked this turn would
    // otherwise stand exhausted.
    //
    // `scope` left at its default, so "an enemy unit AT A BATTLEFIELD" is enforced
    // by the targeting and a unit sheltering in the opponent's base is out of
    // reach — the same reading Possession takes of the same phrase.
    targeting: { kind: "unit", owner: "enemy" },
    resolve: (state, ctx, event) => {
      if (!event.targetUnitInstanceId) return state;
      const borrowed = borrowUnitInPlace(state, event.targetUnitInstanceId, ctx.casterIndex);
      return readyUnit(borrowed, event.targetUnitInstanceId);
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
