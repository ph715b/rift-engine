import type { EffectDefinition } from "../card-effects.js";
import type { UnitTriggerDefinition } from "../unit-triggers.js";
import { dealDamageToEnemyUnitsAtBattlefield } from "../effect-helpers.js";

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
};

export const unitTriggers: Record<string, UnitTriggerDefinition> = {};
