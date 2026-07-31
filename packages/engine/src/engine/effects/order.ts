import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import type { DeathknellEffect, EventTriggerDefinition } from "../triggers.js";
import { channelRunesExhausted, destroyUnit, drawCards, giveMightThisTurnToAllFriendlies } from "../effect-helpers.js";
import { findUnitAnywhere } from "../target-lookup.js";

/**
 * Card implementations for **Order** — one file, one owner.
 *
 * This file exists so that work on the card pool can be split up without two
 * people (or two agents) ever editing the same file. The ownership rule is
 * mechanical, not a convention: a defId may only appear here if its
 * CardDefinition has exactly one domain and that domain is Order. A test in
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
  "OGN-213": {
    // Hidden Blade — "[Hidden][Action] Kill a unit at a battlefield. Its
    // controller draws 2."
    //
    // The draw goes to the VICTIM's controller, not the caster — that's the
    // card's whole balance, and reading "its" as the caster would turn a
    // drawback into a bonus. The owner has to be read BEFORE the kill, since
    // afterwards the unit is in a trash and no longer at a battlefield.
    //
    // destroyUnit, not dealDamage: "kill" is a Kill Instruction, so Might and
    // marked damage are irrelevant and it goes through the same funnel that
    // fires [Deathknell] (808) and honours a death ward (809.1.b.1).
    targeting: { kind: "unit" },
    resolve: (state, _ctx, event) => {
      if (!event.targetUnitInstanceId) return state;
      const location = findUnitAnywhere(state, event.targetUnitInstanceId);
      if (!location) return state;
      const victimIndex = location.ownerIndex;
      return drawCards(destroyUnit(state, event.targetUnitInstanceId), victimIndex, 2);
    },
  },
  "OGN-233": {
    // Grand Strategem — "[Action] Give friendly units +5 Might this turn."
    //
    // Same shape as Decisive Strike (OGS-024, card-effects.ts), just bigger, so
    // it shares that card's helper rather than re-deriving "who is friendly":
    // every unit the CASTER controls, in base and at every battlefield. Note
    // the text says "friendly units", not "friendly units here" — a unit
    // sitting at home is pumped too, which matters when this is cast during a
    // showdown at one battlefield.
    //
    // targeting: none. The units are programmatically selected from their
    // characteristics rather than chosen, which rule 355.11 makes the
    // difference between targeting and merely affecting ("Kill all units at
    // battlefields doesn't target anything"). So there is no choice for
    // legal-actions.ts to fan out and nothing an enemy "can't be chosen"
    // effect could dodge.
    //
    // giveMightThisTurnToAllFriendlies, NOT buffing: this expires in the
    // Expiration Step (rule 317) via turn-manager.ts's runEnd zeroing every
    // unit's mightThisTurn, whereas a Buff (rule 710) persists, caps at one per
    // unit and is only worth +1.
    //
    // [Action] is the default play timing (own turn or a showdown) and is
    // enforced by engine/timing.ts, not here.
    targeting: { kind: "none" },
    resolve: (state, ctx) => giveMightThisTurnToAllFriendlies(state, ctx.casterIndex, 5),
  },
};

export const unitTriggers: Record<string, UnitTriggerDefinition> = {
  "OGN-208": {
    // Cruel Patron — "As an additional cost to play me, kill a friendly unit."
    //
    // The card has no other text: the kill IS the whole entry, and it is a COST,
    // not an effect. That distinction is why it rides on
    // `additionalCostUnitInstanceId` (rule 355.11 — a cost is not a target) and
    // why `targeting` is "none". Enumeration offers no decline variant for it,
    // so a Cruel Patron with nothing of yours to kill is never playable.
    //
    // It is paid here, on play, rather than at resolution — a Unit's trigger
    // fires the moment it enters play, which is when a cost is due.
    //
    // destroyUnit, not a bespoke removal: paying a cost with a unit is still a
    // death, so [Deathknell] fires (808) and a death ward can replace it
    // (809.1.b.1). Being a cost does not make it a quieter kill.
    targeting: { kind: "none" },
    resolve: (state, _ctx, _unitId, event) =>
      event.additionalCostUnitInstanceId ? destroyUnit(state, event.additionalCostUnitInstanceId) : state,
  },
};

/** [Deathknell] effects — rule 808, "When I die, [Effect]". Keyed by the DYING
 *  card's defId. Same one-file-one-owner rule as the registries above. */
export const deathTriggers: Record<string, DeathknellEffect> = {
  // Soaring Scout — "[Deathknell] Channel 1 rune exhausted." (rule 808)
  //
  // Exhausted, not Ready: the rune can still be recycled to pay a Power cost
  // this turn but cannot pay Energy until the next Awaken readies it, which is
  // what makes it weaker than a free rune. Same helper Stormclaw Ursine's
  // on-play trigger uses, so the two cannot drift.
  "OGN-216": (state, ctx) => channelRunesExhausted(state, ctx.casterIndex, 1),
};

/** Listeners for board EVENTS other than a death (see triggers.ts's GameEvent).
 *  Keyed by the LISTENING card's defId. Same one-file-one-owner rule. */
export const eventTriggers: Record<string, EventTriggerDefinition> = {};
