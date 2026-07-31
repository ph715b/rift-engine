import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { DeathknellEffect, EventTriggerDefinition, SelfTriggerDefinition } from "../triggers.js";
import type { DecisionDefinition } from "../decisions.js";
import type { PlayerState } from "../../model/game-state.js";
import { addBuff } from "../effect-helpers.js";
import { drawCards, giveMightThisTurn } from "../effect-helpers.js";

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
};

export const unitTriggers: Record<string, UnitTriggerDefinition> = {};

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

/** Questions this domain's cards stop to ask — see engine/decisions.ts. Keyed by
 *  a `kind` string rather than a defId, since one card can ask more than one
 *  kind of question; the one-file-one-owner rule still applies, and the key is
 *  prefixed with the card's defId so ownership stays readable. */
export const decisions: Record<string, DecisionDefinition> = {};
