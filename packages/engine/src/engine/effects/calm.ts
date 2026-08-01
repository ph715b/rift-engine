import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { DeathknellEffect, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { DecisionDefinition } from "../decisions.js";
import type { PlayerState } from "../../model/game-state.js";
import {
  addBuff,
  drawCards,
  exhaustGear,
  forceMoveToBattlefield,
  giveMightThisTurn,
  giveMightThisTurnToOwnUnit,
  readyUnit,
  stunUnits,
} from "../effect-helpers.js";

/**
 * Card implementations for **Calm** — one file, one owner.
 *
 * This file exists so that work on the card pool can be split up without two
 * people (or two agents) ever editing the same file. The ownership rule is
 * mechanical, not a convention: a defId may only appear here if its
 * CardDefinition has exactly one domain and that domain is Calm. A test in
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
  "OGN-043": {
    // Charm — "Move an enemy unit."
    //
    // Names no battlefield, so the unit can be taken from the enemy's base as
    // well as from a battlefield (355.9.b — the bare noun "unit" means objects on
    // the Board, and Bases are Public). Where it goes rides on
    // `destinationBattlefieldId`, the field a token-placing spell already uses.
    //
    // The move itself is `forceMoveToBattlefield`, not the MoveUnit executor, and
    // that is a rules distinction rather than plumbing — see its doc comment:
    // 415.1.b makes the exhaust a cost of the Standard MOVE ACTION, so a charmed
    // unit arrives ready, and 458 contests the destination for the moved unit's
    // controller rather than the caster's.
    targeting: { kind: "unit", owner: "enemy", scope: "anywhere" },
    resolve: (state, _ctx, event) =>
      event.targetUnitInstanceId && event.destinationBattlefieldId
        ? forceMoveToBattlefield(state, event.targetUnitInstanceId, event.destinationBattlefieldId)
        : state,
  },
  "OGN-053": {
    // Stand United — "[Hidden][Action] Buff a friendly unit. Buffs give an
    // additional +1 Might to friendly units this turn."
    //
    // The rules use THIS card as their worked example for rule 811's targeting
    // restriction: played from Hidden, the buff must choose a unit at that
    // battlefield, while the second half "affects all friendly units with buffs,
    // no matter where they are". So the restriction rides on the TARGET (handled
    // by legal-actions) and the board-wide half is written here with no location
    // check at all — which is what makes those two sentences behave differently.
    //
    // The second half is a modifier on what a Buff is WORTH, not a buff and not
    // a flat Might bonus: it scales with how many of your units are buffed, it
    // reaches units buffed later this turn, and it does nothing for an unbuffed
    // one. effectiveMight reads it; runEnd clears it.
    targeting: { kind: "unit", owner: "friendly" },
    resolve: (state, ctx, event) => {
      const buffed = event.targetUnitInstanceId ? addBuff(state, event.targetUnitInstanceId) : state;
      const players = [...buffed.players] as [PlayerState, PlayerState];
      const actor = players[ctx.casterIndex];
      players[ctx.casterIndex] = { ...actor, extraMightPerBuffThisTurn: actor.extraMightPerBuffThisTurn + 1 };
      return { ...buffed, players };
    },
  },
  "OGN-058": {
    // Discipline — "[Reaction] Give a unit +2 Might this turn. Draw 1."
    //
    // scope: "anywhere", deliberately. The card says "a unit", NOT "a unit at a
    // battlefield", and rule 355.9.b settles what the bare noun means: unit
    // refers to objects on the Board unless the text says otherwise, and the
    // targeting section's own list of Public zones names Bases right alongside
    // Battlefield Zones. So a unit standing at home is a legal target — and so
    // is the OPPONENT's, since the text carries no owner restriction either
    // (pumping an enemy unit is a bad play, not an illegal one, and `owner` is
    // left unset rather than guessing "friendly"). Same reading Final Spark and
    // Stupefy already got; base is not a safe parking spot from this card.
    //
    // giveMightThisTurn, NOT addBuff. The two are not interchangeable: this
    // expires in the Expiration Step ("all 'this turn' effects expire
    // simultaneously", rule 317), which turn-manager.ts's runEnd gets for free
    // by zeroing every unit's mightThisTurn, whereas a Buff (rule 710) is a
    // persistent game object that would survive the turn and only come off when
    // the unit leaves play (rule 709).
    //
    // [Reaction] is rule 813 and is NOT implemented here — engine/timing.ts owns
    // when this may be played, including onto an already-closed chain. The
    // resolver is identical whenever it runs, so there is nothing timing-shaped
    // for this entry to do.
    //
    // Printed order: Might first, then the draw. Drawing on an empty deck takes
    // nothing rather than throwing — drawCards' documented Burn Out gap, not a
    // decision made here.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, event) =>
      drawCards(giveMightThisTurn(state, event.targetUnitInstanceId!, 2), ctx.casterIndex, 1),
  },
  "OGN-050": {
    // Rune Prison — "[Action] Stun a unit."
    //
    // scope: "anywhere". "A unit", not "a unit at a battlefield" — rule 355.9.b
    // settles the bare noun as objects on the Board, and the targeting section
    // lists Bases among the Public zones. Same reading Discipline, Final Spark
    // and Stupefy already have. No owner restriction either: stunning your own
    // unit is a bad play, not an illegal one, so `owner` stays unset.
    //
    // [Action] is timing (engine/timing.ts), not something this entry does.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, event) =>
      event.targetUnitInstanceId ? stunUnits(state, ctx.casterIndex, [event.targetUnitInstanceId]) : state,
  },
};

export const unitTriggers: Record<string, UnitTriggerDefinition> = {
  "OGN-051": {
    // Solari Shieldbearer — "When you play me, stun a unit."
    //
    // Same "a unit" reading as Rune Prison above, and for the same reason: the
    // text names no battlefield, so a unit in either base is a legal target.
    targeting: { kind: "unit", scope: "anywhere" },
    resolve: (state, ctx, _unitId, event) =>
      event.targetUnitInstanceId ? stunUnits(state, ctx.casterIndex, [event.targetUnitInstanceId]) : state,
  },
};

/** [Deathknell] effects — rule 808, "When I die, [Effect]". Keyed by the DYING
 *  card's defId. Same one-file-one-owner rule as the registries above. */
export const deathTriggers: Record<string, DeathknellEffect> = {};

/** Listeners for board EVENTS other than a death (see triggers.ts's GameEvent).
 *  Keyed by the LISTENING card's defId. Same one-file-one-owner rule. */
export const eventTriggers: Record<string, EventTriggerDefinition> = {
  "OGN-060": {
    // Mask of Foresight — "When a friendly unit attacks or defends alone, give it
    // +1 Might this turn."
    //
    // An EVENT, not a continuous modifier, and the difference is the whole card:
    // "+1 this turn" is granted once and keeps its value for the rest of the turn
    // even after the unit stops being alone — a reinforcement arriving later does
    // not take it back. Wielder of Water's superficially similar "while I'm
    // attacking or defending alone" IS continuous and lives in effective-might.ts;
    // the two must not be confused.
    //
    // "Attacks OR defends" — either side, so this asks only whether the
    // controller's own presence at that battlefield is exactly one unit. Which
    // side started it does not matter and is deliberately not consulted.
    on: "combatBegan",
    resolve: (state, listener, event) => {
      if (event.kind !== "combatBegan") return state;
      const ownerId = state.players[listener.ownerIndex].id;
      const bf = state.battlefields.find((b) => b.id === event.battlefieldId);
      const mine = bf?.units[ownerId] ?? [];
      return mine.length === 1 ? giveMightThisTurn(state, mine[0]!.instanceId, 1) : state;
    },
  },
  "OGN-059": {
    // Eclipse Herald — "When you stun an enemy unit, ready me and give me
    // +1 Might this turn."
    //
    // The rules use this card as their own worked example for why stunning an
    // already-stunned unit is not a stunning (422), so the guard it needs is not
    // written here at all: `stunUnits` drops those before the event exists.
    //
    // "AN enemy unit", singular — so this pays out once per qualifying unit in
    // the batch rather than once per instruction (which is Leona - Radiant
    // Dawn's "one or more" wording, deliberately different). Readying twice is
    // idempotent; the Might is not, and +2 for two enemies is the literal read.
    //
    // Both halves of "you ... enemy" are measured against the HERALD's
    // controller: `stunnerIndex` must be the listener, and the victim must not
    // be. A Herald does not celebrate its own controller's units being stunned,
    // nor the opponent stunning something.
    on: "unitsStunned",
    resolve: (state, listener, event) => {
      if (event.kind !== "unitsStunned") return state;
      if (event.stunnerIndex !== listener.ownerIndex) return state;
      const enemiesStunned = event.stunned.filter((s) => s.ownerIndex !== listener.ownerIndex).length;
      if (enemiesStunned === 0) return state;
      const readied = readyUnit(state, listener.card.instanceId);
      return giveMightThisTurnToOwnUnit(readied, listener.ownerIndex, listener.card.instanceId, enemiesStunned);
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
  // Solari Shrine's "you may exhaust this to draw 1" — raised by its death-watch
  // in engine/triggers.ts, which has already checked that the kill was yours,
  // the victim was a stunned enemy, and the Shrine is still ready.
  //
  // Two options always, so `advanceDecisions` can never auto-resolve it: a "you
  // may" that the engine answers for you is not a "you may". Declining is a real
  // play — the Shrine's exhaust is worth keeping when a second stunned enemy is
  // about to die this turn.
  "OGN-072-draw": {
    prompt: () => "Solari Shrine: exhaust it to draw 1?",
    // No `instanceId` on either option, deliberately. The board renders an
    // option that carries one as the CARD itself, which is right for "pick one
    // of your units" and wrong here: this is a yes/no, and half a card next to
    // half a button reads as two different kinds of choice. The prompt already
    // names the Shrine.
    options: () => [
      { id: "draw", label: "Exhaust and draw 1" },
      { id: "decline", label: "Decline" },
    ],
    resolve: (state, d, optionId) => {
      if (optionId !== "draw" || !d.cardInstanceId) return state;
      // Exhaust FIRST, then draw: the exhaust is the cost, and exhaustGear
      // no-ops on a Shrine that is somehow already spent — so a state where the
      // cost cannot be paid must not hand over the draw.
      const paid = exhaustGear(state, d.playerIndex, d.cardInstanceId);
      return paid === state ? state : drawCards(paid, d.playerIndex, 1);
    },
  },
};
